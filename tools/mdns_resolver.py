#!/usr/bin/env python3
"""One-shot mDNS (RFC 6762) IPv4 lookups for Data Out names that end in .local.

The console image (python slim, Docker host network) has no nss-mdns, so the
system resolver in the container cannot answer ``doasdr.local`` while the
host answers it through avahi. The collector asks this resolver only for a
``.local`` name and only after the system resolver failed for it.

One lookup is one A question with the QU bit, sent to 224.0.0.251:5353 from
an ephemeral port. A query from a port other than 5353 is a one-shot legacy
query (RFC 6762 sections 5.1 and 6.7): the responder answers by unicast to
that port and repeats the query ID. The wait is at most ``QUERY_TIMEOUT_S``
and never longer than the caller's remaining budget.

Answers are parsed strictly and with bounds checks: the response must come
from the port the query went to, carry the query ID, be a response with
opcode and rcode 0, and name compression may only point backwards (so a
pointer loop cannot run). Only A records of class IN in the answer section
count, for exactly the asked name, with a TTL above 0 and an address that is
not loopback, unspecified, multicast or reserved. A positive answer is kept
for its TTL clamped to ``MIN_TTL_S`` .. ``MAX_TTL_S``; a lookup without an
answer is remembered for ``NEGATIVE_TTL_S``, so a node that is off does not
cost a query per read.

Standard library only. No thread, and no socket is kept open between lookups.
"""

from __future__ import annotations

import ipaddress
import re
import secrets
import socket
import struct
import threading
import time
from collections import OrderedDict
from typing import Callable, List, Optional, Tuple

MDNS_ADDRESS: Tuple[str, int] = ("224.0.0.251", 5353)
QUERY_TIMEOUT_S = 1.0
MIN_TTL_S = 5.0
MAX_TTL_S = 60.0
NEGATIVE_TTL_S = 5.0
# RFC 6762 section 17: an mDNS message is at most 9000 bytes.
MAX_PACKET_BYTES = 9000
# Datagrams read for one lookup before giving up; bounds the work a flood can cause.
MAX_DATAGRAMS = 32
MAX_POINTER_JUMPS = 16
MAX_NAME_WIRE_BYTES = 255
MAX_CACHE_ENTRIES = 64
TYPE_A = 1
CLASS_IN = 1
QU_BIT = 0x8000
CLASS_MASK = 0x7FFF
_HEADER = struct.Struct("!HHHHHH")
_RECORD = struct.Struct("!HHIH")
_LABEL_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")


class MdnsPacketError(ValueError):
    """A datagram that is not a well-formed DNS message."""


def normalize_local_name(host: object) -> Optional[str]:
    """Return ``host`` lowercased without a trailing dot when it is a valid .local name."""
    if not isinstance(host, str):
        return None
    name = host.strip().lower()
    if name.endswith("."):
        name = name[:-1]
    labels = name.split(".")
    if len(labels) < 2 or labels[-1] != "local" or len(name) > 253:
        return None
    if not all(_LABEL_RE.fullmatch(label) for label in labels):
        return None
    return name


def encode_name(name: str) -> bytes:
    """Wire form of a normalized name (no compression)."""
    encoded = bytearray()
    for label in name.split("."):
        raw = label.encode("ascii")
        if not 1 <= len(raw) <= 63:
            raise ValueError("label length out of range")
        encoded.append(len(raw))
        encoded.extend(raw)
    encoded.append(0)
    if len(encoded) > MAX_NAME_WIRE_BYTES:
        raise ValueError("name too long")
    return bytes(encoded)


def build_query(name: str, query_id: int) -> bytes:
    """One A question for ``name`` with the QU (unicast response) bit set."""
    if not 0 <= query_id <= 0xFFFF:
        raise ValueError("query id out of range")
    header = _HEADER.pack(query_id, 0, 1, 0, 0, 0)
    return header + encode_name(name) + struct.pack("!HH", TYPE_A, QU_BIT | CLASS_IN)


def read_name(packet: bytes, offset: int) -> Tuple[List[bytes], int]:
    """Read a possibly compressed name; return its labels and the offset after it.

    Every compression pointer has to point before the previous one (the first
    one before itself), so the walk always ends; the jump count and the
    255-byte name limit bound it further.
    """
    labels: List[bytes] = []
    position = offset
    after: Optional[int] = None
    limit = offset
    jumps = 0
    wire_length = 1
    while True:
        if position >= len(packet):
            raise MdnsPacketError("name runs past the end of the packet")
        length = packet[position]
        kind = length & 0xC0
        if kind == 0xC0:
            if position + 1 >= len(packet):
                raise MdnsPacketError("truncated compression pointer")
            target = ((length & 0x3F) << 8) | packet[position + 1]
            if after is None:
                after = position + 2
                limit = position
            jumps += 1
            if jumps > MAX_POINTER_JUMPS:
                raise MdnsPacketError("too many compression pointers")
            if target >= limit:
                raise MdnsPacketError("compression pointer does not point backwards")
            limit = target
            position = target
            continue
        if kind:
            raise MdnsPacketError("unsupported label type")
        if length == 0:
            return labels, (after if after is not None else position + 1)
        start = position + 1
        stop = start + length
        if stop > len(packet):
            raise MdnsPacketError("label runs past the end of the packet")
        wire_length += length + 1
        if wire_length > MAX_NAME_WIRE_BYTES:
            raise MdnsPacketError("name longer than 255 bytes")
        labels.append(packet[start:stop])
        position = stop


def _usable_address(raw: bytes) -> Optional[str]:
    address = ipaddress.IPv4Address(raw)
    # A Raspberry on the LAN never answers with these; a hostile responder
    # might, to point the console at itself or at a group address.
    if address.is_unspecified or address.is_loopback or address.is_multicast or address.is_reserved:
        return None
    return str(address)


def parse_response(packet: bytes, name: str, query_id: int) -> Optional[Tuple[str, int]]:
    """Return ``(address, ttl)`` of the first A answer for ``name``, or None.

    Raises MdnsPacketError for a message that is cut short or malformed.
    Questions are skipped; only the answer section counts.
    """
    if len(packet) > MAX_PACKET_BYTES:
        raise MdnsPacketError("packet larger than 9000 bytes")
    if len(packet) < _HEADER.size:
        raise MdnsPacketError("packet shorter than a DNS header")
    packet_id, flags, questions, answers, _authority, _additional = _HEADER.unpack_from(packet, 0)
    if packet_id != query_id:
        return None
    # QR set (a response), opcode 0, rcode 0 (RFC 6762 section 18).
    if not flags & 0x8000 or flags & 0x7800 or flags & 0x000F:
        return None
    wanted = name.encode("ascii").split(b".")
    offset = _HEADER.size
    for _ in range(questions):
        _labels, offset = read_name(packet, offset)
        offset += 4
        if offset > len(packet):
            raise MdnsPacketError("question runs past the end of the packet")
    for _ in range(answers):
        labels, offset = read_name(packet, offset)
        if offset + _RECORD.size > len(packet):
            raise MdnsPacketError("record header runs past the end of the packet")
        rtype, rclass, ttl, rdlength = _RECORD.unpack_from(packet, offset)
        offset += _RECORD.size
        if offset + rdlength > len(packet):
            raise MdnsPacketError("record data runs past the end of the packet")
        rdata = packet[offset:offset + rdlength]
        offset += rdlength
        if rtype != TYPE_A or rclass & CLASS_MASK != CLASS_IN or rdlength != 4:
            continue
        if [label.lower() for label in labels] != wanted:
            continue
        # RFC 2181: a TTL with the top bit set counts as 0; 0 is a goodbye.
        if ttl & 0x80000000 or ttl == 0:
            continue
        address = _usable_address(rdata)
        if address is not None:
            return address, ttl
    return None


class MdnsResolver:
    """A small cache in front of one-shot mDNS A lookups.

    ``destination`` is the mDNS group; tests point it at a loopback responder.
    Responses are accepted only from the port the query was sent to (5353
    for the group).
    """

    def __init__(
        self,
        destination: Tuple[str, int] = MDNS_ADDRESS,
        *,
        timeout_s: float = QUERY_TIMEOUT_S,
        min_ttl_s: float = MIN_TTL_S,
        max_ttl_s: float = MAX_TTL_S,
        negative_ttl_s: float = NEGATIVE_TTL_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not 0 < timeout_s <= 5:
            raise ValueError("timeout_s must be within (0, 5]")
        if not 0 < min_ttl_s <= max_ttl_s:
            raise ValueError("TTL bounds must satisfy 0 < min <= max")
        self.destination = (str(destination[0]), int(destination[1]))
        self.timeout_s = float(timeout_s)
        self.min_ttl_s = float(min_ttl_s)
        self.max_ttl_s = float(max_ttl_s)
        self.negative_ttl_s = float(negative_ttl_s)
        self.clock = clock
        self._lock = threading.Lock()
        self._query_lock = threading.Lock()
        # name -> (address or None for a failed lookup, expires at)
        self._cache: "OrderedDict[str, Tuple[Optional[str], float]]" = OrderedDict()

    def _cached_entry(self, name: str) -> Optional[Tuple[Optional[str], float]]:
        with self._lock:
            entry = self._cache.get(name)
            if entry is None:
                return None
            if entry[1] <= self.clock():
                del self._cache[name]
                return None
            return entry

    def cached(self, host: str) -> Optional[str]:
        """The address still cached for ``host``, without a query."""
        name = normalize_local_name(host)
        if name is None:
            return None
        entry = self._cached_entry(name)
        return entry[0] if entry is not None else None

    def _store(self, name: str, address: Optional[str], ttl_s: float) -> None:
        with self._lock:
            now = self.clock()
            self._cache.pop(name, None)
            if len(self._cache) >= MAX_CACHE_ENTRIES:
                for key in [key for key, (_, expires) in self._cache.items() if expires <= now]:
                    del self._cache[key]
                while len(self._cache) >= MAX_CACHE_ENTRIES:
                    self._cache.popitem(last=False)
            self._cache[name] = (address, now + ttl_s)

    def resolve(self, host: str, timeout_s: Optional[float] = None) -> Optional[str]:
        """Return an IPv4 address for a .local ``host``, or None.

        ``timeout_s`` is the caller's remaining budget; the lookup waits at
        most the smaller of it and the resolver's own timeout.
        """
        name = normalize_local_name(host)
        if name is None:
            return None
        entry = self._cached_entry(name)
        if entry is not None:
            return entry[0]
        budget = self.timeout_s if timeout_s is None else min(self.timeout_s, float(timeout_s))
        if not budget > 0:
            return None
        deadline = self.clock() + budget
        # One lookup at a time: readers that wait here find its answer cached.
        if not self._query_lock.acquire(timeout=budget):
            return None
        try:
            entry = self._cached_entry(name)
            if entry is not None:
                return entry[0]
            answer = self._query(name, deadline)
            if answer is None:
                self._store(name, None, self.negative_ttl_s)
                return None
            address, ttl = answer
            self._store(name, address, min(self.max_ttl_s, max(self.min_ttl_s, float(ttl))))
            return address
        finally:
            self._query_lock.release()

    def _query(self, name: str, deadline: float) -> Optional[Tuple[str, int]]:
        query_id = secrets.randbelow(0xFFFF) + 1
        query = build_query(name, query_id)
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        except OSError:
            return None
        try:
            # RFC 6762 section 11: mDNS packets go out with IP TTL 255.
            try:
                sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 255)
            except OSError:
                pass
            sock.bind(("0.0.0.0", 0))
            sock.sendto(query, self.destination)
            for _ in range(MAX_DATAGRAMS):
                remaining = deadline - self.clock()
                if remaining <= 0:
                    return None
                sock.settimeout(remaining)
                try:
                    packet, source = sock.recvfrom(MAX_PACKET_BYTES + 1)
                except socket.timeout:
                    return None
                if source[1] != self.destination[1]:
                    continue
                try:
                    answer = parse_response(packet, name, query_id)
                except MdnsPacketError:
                    continue
                if answer is not None:
                    return answer
            return None
        except OSError:
            return None
        finally:
            sock.close()
