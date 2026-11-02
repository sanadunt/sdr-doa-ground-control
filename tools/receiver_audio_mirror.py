#!/usr/bin/env python3
"""Receiver audio mirror: the groundstation Receiver's audio for LAN viewers, in memory.

Phase 5 of issue #15, the owner's decision of 2026-11-02
(docs/RECEIVER_MIRROR.md section 10a). The groundstation page taps the audio
its Receiver plays (the mix of every VFO that is not muted), turns it into
16 kHz 16-bit PCM and posts it in chunks of about 200 ms; LAN viewers that
pressed Dengar read one long GET that the server writes every new chunk to.
A new read path of the LAN view, not a write.

* ``POST /api/mirror/receiver/audio?source=<id>`` comes from the console's own
  page only (the same-origin loopback rule), while the LAN view is open, from
  the page that publishes the mirror now (``source`` is its ``source.id``,
  posted within ``SOURCE_LOST_MS``). At most ``MAX_AUDIO_BODY_BYTES``, at most
  ``MAX_CHUNKS_PER_S`` in any second. The body is one chunk (``parse_chunk``).
* ``GET /api/mirror/receiver/audio`` answers on both listeners with a stream of
  chunks in the same format, starting at the newest one, a keepalive chunk
  (no samples) every ``KEEPALIVE_MS`` without audio. At most
  ``MAX_LISTENERS`` at once and one per client address (a new one replaces
  the old one). The stream ends when the LAN view closes, the source is lost
  or the client goes.

Audio flows only while somebody listens: the answer to the mirror's POST
carries ``audio_listeners``, and the page asks its Receiver for audio only
while that is above 0. Nothing is written to disk. Standard library only;
``frontend/src/lib/receiverMirrorAudio.ts`` holds the browser's copy of the
format and the limits.
"""

from __future__ import annotations

import re
import struct
import threading
import time
from collections import deque
from typing import Callable, Deque, Dict, NamedTuple, Optional

AUDIO_ROUTE = "/api/mirror/receiver/audio"

# One chunk: a 20-byte header, then mono 16-bit little-endian samples.
MAGIC = b"SDRA"
FORMAT_VERSION = 1
HEADER = struct.Struct("<4sBBHIII")
HEADER_BYTES = HEADER.size
SAMPLE_RATE = 16_000
# 50..500 ms of samples; a keepalive in the stream carries none.
MIN_SAMPLE_BYTES = 1_600
MAX_SAMPLE_BYTES = 16_000
# Bit 0 of flags: samples were lost before this chunk (a dropped chunk, an RX
# restart, another source). Every other bit is 0.
FLAG_GAP = 0x01
KNOWN_FLAGS = FLAG_GAP
MAX_SEQ = 2 ** 32 - 1

MAX_AUDIO_BODY_BYTES = 16 * 1024
MAX_CHUNKS_PER_S = 10
RATE_WINDOW_S = 1.0
# The server keeps the last KEEP_MS of audio; a listener whose writes fall that
# far behind loses its oldest chunks (the next one is marked as a gap).
KEEP_MS = 2_000
MAX_QUEUED_CHUNKS = 10
# A new listener starts with the newest chunk when it is at most this old.
START_CHUNK_MAX_AGE_MS = 500
MAX_LISTENERS = 4
KEEPALIVE_MS = 1_000
WRITE_TIMEOUT_S = 5.0
# The source is lost after this long without a mirror POST (receiver_mirror.SOURCE_LOST_MS).
SOURCE_LOST_MS = 10_000

SOURCE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,64}$")

# Error codes; the first two are receiver_mirror's own (tools/test_receiver_audio_mirror.py compares them).
MIRROR_LAN_CLOSED = "MIRROR_LAN_CLOSED"
MIRROR_NO_SOURCE = "MIRROR_NO_SOURCE"
MIRROR_AUDIO_BUSY = "MIRROR_AUDIO_BUSY"
LAN_CLOSED_MESSAGE = "the LAN view is closed; nothing is mirrored"
AUDIO_BUSY_RETRY_AFTER_S = 5


class AudioRejected(ValueError):
    """A refused audio POST or stream: MIRROR_LAN_CLOSED, MIRROR_NO_SOURCE or MIRROR_AUDIO_BUSY."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class Chunk(NamedTuple):
    seq: int
    flags: int
    samples: bytes


def parse_chunk(raw: bytes) -> Chunk:
    """One posted chunk, checked strictly; ValueError names the first bad field."""
    if len(raw) < HEADER_BYTES:
        raise ValueError("the chunk is shorter than its header")
    magic, version, flags, reserved, seq, sample_rate, length = HEADER.unpack_from(raw)
    if magic != MAGIC:
        raise ValueError("magic must be SDRA")
    if version != FORMAT_VERSION:
        raise ValueError(f"version must be {FORMAT_VERSION}")
    if flags & ~KNOWN_FLAGS:
        raise ValueError("flags has unknown bits")
    if reserved:
        raise ValueError("reserved must be 0")
    if sample_rate != SAMPLE_RATE:
        raise ValueError(f"sample_rate must be {SAMPLE_RATE}")
    if length % 2 or not MIN_SAMPLE_BYTES <= length <= MAX_SAMPLE_BYTES:
        raise ValueError(f"length must be even, {MIN_SAMPLE_BYTES}..{MAX_SAMPLE_BYTES}")
    if len(raw) != HEADER_BYTES + length:
        raise ValueError("length does not match the body")
    return Chunk(seq, flags, bytes(raw[HEADER_BYTES:]))


def encode_chunk(seq: int, flags: int, samples: bytes) -> bytes:
    """A chunk as the stream carries it; no samples is a keepalive."""
    return HEADER.pack(MAGIC, FORMAT_VERSION, flags, 0, seq & MAX_SEQ, SAMPLE_RATE, len(samples)) + samples


def chunk_ms(sample_bytes: int) -> int:
    return int(round(sample_bytes / 2 * 1000 / SAMPLE_RATE))


class Listener:
    """One open stream; its handler thread reads it with ReceiverAudioMirror.next_chunk()."""

    def __init__(self, client: str) -> None:
        self.client = client
        self.queue: Deque[bytes] = deque()
        self.gap = False
        self.ended = False


class ReceiverAudioMirror:
    """The latest audio chunks and the open streams; memory only.

    The mirror (receiver_mirror.ReceiverMirror) owns one, opens and closes it
    with itself and tells it which page publishes (``note_source``), so a
    chunk is taken only from that page and a stream ends when it is lost.
    ``close()`` ends every stream at once.
    """

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._cond = threading.Condition(threading.Lock())
        self._taken: Deque[float] = deque()
        self._open = False
        self._source_id: Optional[str] = None
        self._source_seen_at: Optional[float] = None
        # The kept chunks (encoded, with the time each arrived), newest last.
        self._chunks: Deque[tuple] = deque()
        self._chunk_ms = 0
        self._listeners: Dict[str, Listener] = {}
        self.received = 0

    # The mirror's side.

    def open(self) -> None:
        with self._cond:
            self._open = True

    def close(self) -> None:
        """Forget everything and end every stream (the LAN view closed, moved or was disabled)."""
        with self._cond:
            self._open = False
            self._source_id = None
            self._source_seen_at = None
            self._chunks.clear()
            for listener in self._listeners.values():
                listener.ended = True
            self._listeners.clear()
            self._cond.notify_all()

    def note_source(self, source_id: str, now: float) -> None:
        """The mirror took a POST of ``source_id`` at ``now``; another page drops the previous page's audio."""
        with self._cond:
            if self._source_id is not None and self._source_id != source_id:
                self._chunks.clear()
                for listener in self._listeners.values():
                    listener.queue.clear()
                    listener.gap = True
            self._source_id = source_id
            self._source_seen_at = now

    def listener_count(self) -> int:
        with self._cond:
            return len(self._listeners)

    # The publishing page's side.

    def admit(self) -> bool:
        """At most MAX_CHUNKS_PER_S chunks taken in any RATE_WINDOW_S (a refused one does not count)."""
        with self._cond:
            now = self._clock()
            while self._taken and now - self._taken[0] >= RATE_WINDOW_S:
                self._taken.popleft()
            if len(self._taken) >= MAX_CHUNKS_PER_S:
                return False
            self._taken.append(now)
            return True

    def _source_fresh(self, now: float) -> bool:
        return self._source_seen_at is not None and now - self._source_seen_at <= SOURCE_LOST_MS / 1000

    def publish(self, source_id: str, chunk: Chunk) -> int:
        """Keep ``chunk`` and hand it to every stream; the number of listeners.

        Refused while closed (MIRROR_LAN_CLOSED) and from a page that is not
        the mirror's source now or was lost (MIRROR_NO_SOURCE).
        """
        with self._cond:
            if not self._open:
                raise AudioRejected(MIRROR_LAN_CLOSED, LAN_CLOSED_MESSAGE)
            now = self._clock()
            if source_id != self._source_id or not self._source_fresh(now):
                raise AudioRejected(MIRROR_NO_SOURCE, "audio is taken from the page that publishes the Receiver mirror now")
            encoded = encode_chunk(chunk.seq, chunk.flags, chunk.samples)
            self._chunks.append((now, encoded))
            self._chunk_ms = chunk_ms(len(chunk.samples))
            while self._chunks and now - self._chunks[0][0] > KEEP_MS / 1000:
                self._chunks.popleft()
            self.received += 1
            for listener in self._listeners.values():
                if len(listener.queue) >= MAX_QUEUED_CHUNKS:
                    listener.queue.popleft()
                    listener.gap = True
                listener.queue.append(encoded)
            self._cond.notify_all()
            return len(self._listeners)

    # The streams' side.

    def attach(self, client: str) -> Listener:
        """A new stream for ``client``; one of the same client ends.

        Refused while closed (MIRROR_LAN_CLOSED), without a source posting now
        (MIRROR_NO_SOURCE) and with MAX_LISTENERS other clients listening
        (MIRROR_AUDIO_BUSY).
        """
        with self._cond:
            if not self._open:
                raise AudioRejected(MIRROR_LAN_CLOSED, LAN_CLOSED_MESSAGE)
            now = self._clock()
            if not self._source_fresh(now):
                raise AudioRejected(MIRROR_NO_SOURCE, "no groundstation page publishes the Receiver now")
            previous = self._listeners.pop(client, None)
            if previous is not None:
                previous.ended = True
            elif len(self._listeners) >= MAX_LISTENERS:
                raise AudioRejected(MIRROR_AUDIO_BUSY, f"at most {MAX_LISTENERS} listeners at once")
            listener = Listener(client)
            if self._chunks and now - self._chunks[-1][0] <= START_CHUNK_MAX_AGE_MS / 1000:
                listener.queue.append(self._chunks[-1][1])
            self._listeners[client] = listener
            self._cond.notify_all()
            return listener

    def detach(self, listener: Listener) -> None:
        with self._cond:
            listener.ended = True
            if self._listeners.get(listener.client) is listener:
                del self._listeners[listener.client]

    def next_chunk(self, listener: Listener, timeout_s: float = KEEPALIVE_MS / 1000) -> Optional[bytes]:
        """The next chunk to write: audio, a keepalive after ``timeout_s`` without any, or None when the stream is over."""
        with self._cond:
            deadline = self._clock() + timeout_s
            while True:
                if listener.ended or not self._open or not self._source_fresh(self._clock()):
                    return None
                if listener.queue:
                    encoded = listener.queue.popleft()
                    if listener.gap:
                        listener.gap = False
                        encoded = encoded[:5] + bytes([encoded[5] | FLAG_GAP]) + encoded[6:]
                    return encoded
                remaining = deadline - self._clock()
                if remaining <= 0:
                    return encode_chunk(0, 0, b"")
                self._cond.wait(min(remaining, 0.5))

    def view(self) -> Dict[str, Optional[int]]:
        """The ``audio`` block of GET /api/mirror/receiver."""
        with self._cond:
            now = self._clock()
            age = None if not self._chunks else max(0, int(round((now - self._chunks[-1][0]) * 1000)))
            return {
                "listeners": len(self._listeners),
                "max_listeners": MAX_LISTENERS,
                "age_ms": age,
                "sample_rate": SAMPLE_RATE,
                "chunk_ms": self._chunk_ms or None,
            }
