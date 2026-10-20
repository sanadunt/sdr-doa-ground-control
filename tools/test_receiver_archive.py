"""Receiver Records archive: migration, queries, retention, delete, ZIP export and HTTP routes."""
from __future__ import annotations

import http.client
import io
import json
import os
import re
import socket
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
import zipfile
import zlib
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from unittest import mock

TOOLS_DIR = Path(__file__).resolve().parent
ROOT = TOOLS_DIR.parent
sys.path.insert(0, str(TOOLS_DIR))

import ground_console  # noqa: E402
import receiver_archive as ra  # noqa: E402
import receiver_record_store  # noqa: E402
from receiver_archive import ArchiveError, ArchiveFilter  # noqa: E402
from receiver_record_store import ReceiverRecordStore  # noqa: E402

UTC = timezone.utc
# Fixed dates in the past: the .part files carry real mtimes, so a past test
# clock never makes a live recording look stale to recovery.
BASE = datetime(2025, 3, 10, 12, 0, tzinfo=UTC)
OVERLAY_APP = ROOT / "tools" / "browsdr_receiver_overlay" / "src" / "client" / "app"


class Clock:
    def __init__(self, now: datetime) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now

    def set(self, value: datetime) -> None:
        self.now = value


def ms(value: datetime) -> int:
    return ra.ms_from_datetime(value)


def trace_bytes(sweep: int, tagged: bool = True) -> bytes:
    body = bytes((sweep * 7 + index) % 256 for index in range(1, 2048))
    return (b"\x01" if tagged else b"\x80") + body


def candidate(index: int, **extra: Any) -> Dict[str, Any]:
    frequency = 100_000_000 + index * 25_000
    return {
        "id": index,
        "startHz": frequency - 5_000,
        "endHz": frequency + 5_000,
        "centerHz": frequency,
        "peakFrequencyHz": frequency,
        "meanPeakFrequencyHz": frequency + 0.5,
        "minPeakFrequencyHz": frequency - 1,
        "maxPeakFrequencyHz": frequency + 1,
        "bandwidthHz": 10_000,
        "peakDb": -60 + index,
        "noiseFloorDb": -95.25,
        "snrDb": 35 + index,
        "firstSeen": 1_700_000_000_000,
        "lastSeen": 1_700_000_005_000,
        "hits": index,
        **extra,
    }


class StoreCase(unittest.TestCase):
    """A store with a test clock and helpers that write records at given times."""

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temp.name)
        self.clock = Clock(BASE)
        self.store = ReceiverRecordStore(self.data_dir, clock=self.clock)

    def tearDown(self) -> None:
        self.store.close()
        self.temp.cleanup()

    def db(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.data_dir / "receiver.sqlite3")
        connection.row_factory = sqlite3.Row
        return connection

    def sql(self, statement: str, params: Any = ()) -> List[sqlite3.Row]:
        with closing(self.db()) as db, db:
            return db.execute(statement, params).fetchall()

    def session(self, at: Optional[datetime] = None) -> str:
        if at is not None:
            self.clock.set(at)
        return self.store.create_audio_session()["id"]

    def finish_session(self, session_id: str, at: Optional[datetime] = None) -> None:
        if at is not None:
            self.clock.set(at)
        self.store.finish_audio_session(session_id)

    def segment(self, session_id: str, start: datetime, end: Optional[datetime] = None, *, vfo: int = 0,
                frequency: float = 144_000_000.0, mode: str = "NFM", bandwidth: float = 12_500,
                audio: bytes = b"webm audio", status: str = "complete") -> str:
        self.clock.set(start)
        ident = self.store.create_audio_segment(session_id, {
            "vfo_index": vfo, "frequency_hz": frequency, "mode": mode, "bandwidth_hz": bandwidth,
            "codec": "audio/webm;codecs=opus", "started_at": start.isoformat(),
        })["id"]
        if audio:
            self.store.append_segment_audio(ident, audio)
        if end is not None:
            self.clock.set(end)
            self.store.finish_segment(ident, {
                "ended_at": end.isoformat(), "duration_seconds": (end - start).total_seconds(), "status": status,
            })
        return ident

    def recording(self, start: datetime, end: datetime, **kwargs: Any) -> Tuple[str, str]:
        """A finished session holding one finished segment."""
        session_id = self.session(start)
        segment_id = self.segment(session_id, start, end, **kwargs)
        self.finish_session(session_id, end)
        return session_id, segment_id

    def scan(self, start: datetime, end: Optional[datetime] = None, *, source: str = "native",
             start_hz: Optional[float] = 100e6, end_hz: Optional[float] = 200e6, traces: int = 0, candidates: int = 0,
             archive: bool = True, status: str = "complete", trace_format: Optional[int] = 1) -> str:
        self.clock.set(start)
        config: Dict[str, Any] = {"fftSize": 4096}
        if start_hz is not None:
            config["startHz"] = start_hz
        if end_hz is not None:
            config["endHz"] = end_hz
        if trace_format is not None:
            config["traceFormat"] = trace_format
        ident = self.store.create_scan(source, config, archive)["id"]
        for sweep in range(traces):
            self.store.add_trace(ident, sweep, trace_bytes(sweep))
        if candidates:
            self.store.upsert_candidates(ident, [candidate(index) for index in range(1, candidates + 1)])
        if end is not None:
            self.clock.set(end)
            self.store.finish_scan(ident, status)
        return ident

    def keys(self, archive_filter: ArchiveFilter = ArchiveFilter(), **kwargs: Any) -> List[Tuple[str, str]]:
        page = self.store.archive_items(archive_filter, limit=200, **kwargs)
        return [(item["kind"], item["id"]) for item in page["items"]]

    def ids(self, archive_filter: ArchiveFilter = ArchiveFilter(), **kwargs: Any) -> set:
        return {ident for _, ident in self.keys(archive_filter, **kwargs)}


OLD_SCHEMA = """
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE scans (
        id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
        metadata TEXT NOT NULL DEFAULT '{}', last_activity TEXT
    );
    CREATE TABLE candidates (
        scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
        candidate_id TEXT NOT NULL, payload TEXT NOT NULL,
        frequency REAL NOT NULL DEFAULT 0, peak_hz REAL NOT NULL DEFAULT 0, low_hz REAL NOT NULL DEFAULT 0,
        high_hz REAL NOT NULL DEFAULT 0, peak REAL NOT NULL DEFAULT 0,
        snr REAL NOT NULL DEFAULT 0, hits INTEGER NOT NULL DEFAULT 0,
        last_seen REAL NOT NULL DEFAULT 0,
        PRIMARY KEY(scan_id, candidate_id)
    );
    CREATE TABLE frames (
        id INTEGER PRIMARY KEY, scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
        sweep INTEGER NOT NULL DEFAULT 0, captured_at TEXT NOT NULL, payload BLOB NOT NULL
    );
    CREATE TABLE records (
        id TEXT PRIMARY KEY, scan_id TEXT NOT NULL UNIQUE REFERENCES scans(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL, metadata TEXT NOT NULL
    );
    CREATE TABLE audio_sessions (
        id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
        temp_name TEXT NOT NULL, file_name TEXT, byte_count INTEGER NOT NULL DEFAULT 0,
        metadata TEXT NOT NULL DEFAULT '{}', last_activity TEXT
    );
    CREATE TABLE audio_segments (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES audio_sessions(id) ON DELETE CASCADE,
        started_at TEXT NOT NULL, finished_at TEXT, byte_count INTEGER NOT NULL DEFAULT 0,
        temp_name TEXT NOT NULL DEFAULT '', file_name TEXT, metadata TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE markers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL, payload TEXT NOT NULL
    );
    INSERT INTO settings(key,value) VALUES('auto_spectrum_recording','false');
"""
SESSION_A = "aaaaaaaa-0000-4000-8000-000000000001"
SESSION_B = "aaaaaaaa-0000-4000-8000-000000000002"
SEG_DURATION = "bbbbbbbb-0000-4000-8000-000000000001"
SEG_NO_TIME = "bbbbbbbb-0000-4000-8000-000000000002"
SEG_EARLY_END = "bbbbbbbb-0000-4000-8000-000000000003"
SEG_RECORDING = "bbbbbbbb-0000-4000-8000-000000000004"
SCAN_INTERRUPTED = "cccccccc-0000-4000-8000-000000000001"
SCAN_UNARCHIVED = "cccccccc-0000-4000-8000-000000000002"
SCAN_RECORD_ONLY = "cccccccc-0000-4000-8000-000000000003"


class MigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temp.name)
        self.db_path = self.data_dir / "receiver.sqlite3"
        self.clock = Clock(BASE)
        with closing(sqlite3.connect(self.db_path)) as db, db:
            db.executescript(OLD_SCHEMA)
            db.execute("PRAGMA user_version=0")
            db.execute(
                "INSERT INTO audio_sessions(id,started_at,finished_at,temp_name,last_activity) VALUES(?,?,?,?,?)",
                (SESSION_A, "2025-03-01T10:00:00+00:00", "2025-03-01T11:00:00+00:00", "", "2025-03-01T11:00:00+00:00"),
            )
            # The open session was active "now", so start-up recovery leaves it open.
            db.execute(
                "INSERT INTO audio_sessions(id,started_at,temp_name,last_activity) VALUES(?,?,?,?)",
                (SESSION_B, BASE.isoformat(), "", BASE.isoformat()),
            )
            segments = [
                (SEG_DURATION, SESSION_A, "2025-03-01T10:00:00+00:00", "2025-03-01T10:05:00+00:00", 10,
                 {"vfo_index": 99, "frequency_hz": 144_500_000, "mode": "N/F M", "bandwidth_hz": 12_500,
                  "codec": "audio/webm", "started_at": "2025-03-01T10:00:01Z", "duration_seconds": 300,
                  "status": "complete"}),
                (SEG_NO_TIME, SESSION_A, "garbage", "also garbage", 10,
                 {"vfo_index": 1, "frequency_hz": 145_000_000, "mode": "WFM", "bandwidth_hz": 150_000,
                  "codec": "audio/webm"}),
                (SEG_EARLY_END, SESSION_A, "2025-03-01T10:00:00+00:00", "2025-03-01T09:00:00+00:00", 10,
                 {"vfo_index": 2, "frequency_hz": 146_000_000, "mode": " AM ", "bandwidth_hz": 10_000,
                  "codec": "audio/webm", "status": "partial", "error": "chunk 3 upload failed"}),
                (SEG_RECORDING, SESSION_B, BASE.isoformat(), None, 0,
                 {"vfo_index": 0, "frequency_hz": 147_000_000, "mode": "usb", "bandwidth_hz": 3_000,
                  "codec": "audio/webm"}),
            ]
            for ident, session_id, started, finished, size, metadata in segments:
                db.execute(
                    "INSERT INTO audio_segments(id,session_id,started_at,finished_at,byte_count,temp_name,file_name,metadata) "
                    "VALUES(?,?,?,?,?,?,?,?)",
                    (ident, session_id, started, finished, size, f"{ident}.part",
                     f"{ident}.webm" if finished else None, json.dumps(metadata)),
                )
            scans = [
                (SCAN_INTERRUPTED, "2025-03-01T00:00:00+00:00", "2025-03-04T00:00:00+00:00", "2025-03-01T01:00:00+00:00",
                 {"source": "mystery", "config": {"startHz": 1e8, "endHz": 2e8, "fftSize": 4096}, "archive": True,
                  "status": "interrupted"}),
                (SCAN_UNARCHIVED, "2025-03-02T00:00:00+00:00", "2025-03-02T00:10:00+00:00", "2025-03-02T00:10:00+00:00",
                 {"source": "manual", "config": {"start_hz": 3e8, "end_hz": 4e8, "fftSize": 3}, "archive": False,
                  "status": "stopped"}),
                (SCAN_RECORD_ONLY, "2025-03-03T00:00:00+00:00", "2025-03-03T00:20:00+00:00", None,
                 {"source": "simulated", "config": {"startHz": "x", "fftSize": True}}),
            ]
            for ident, started, finished, activity, metadata in scans:
                db.execute(
                    "INSERT INTO scans(id,started_at,finished_at,metadata,last_activity) VALUES(?,?,?,?,?)",
                    (ident, started, finished, json.dumps(metadata), activity),
                )
            db.execute("INSERT INTO records(id,scan_id,created_at,metadata) VALUES(?,?,?,?)",
                       (SCAN_INTERRUPTED, SCAN_INTERRUPTED, "2025-03-04T00:00:00+00:00", "{}"))
            db.execute("INSERT INTO records(id,scan_id,created_at,metadata) VALUES(?,?,?,?)",
                       (SCAN_RECORD_ONLY, SCAN_RECORD_ONLY, "2025-03-03T00:20:00+00:00", "{}"))
            self.frame_payloads = [zlib.compress(trace_bytes(sweep)) for sweep in range(3)]
            for sweep, payload in enumerate(self.frame_payloads):
                db.execute("INSERT INTO frames(scan_id,sweep,captured_at,payload) VALUES(?,?,?,?)",
                           (SCAN_INTERRUPTED, sweep, "2025-03-01T00:30:00+00:00", payload))
            self.candidate_payloads = [json.dumps(candidate(index)) for index in (1, 2)]
            for index, payload in zip((1, 2), self.candidate_payloads):
                db.execute("INSERT INTO candidates(scan_id,candidate_id,payload) VALUES(?,?,?)",
                           (SCAN_INTERRUPTED, str(index), payload))
        for ident in (SEG_DURATION, SEG_NO_TIME, SEG_EARLY_END):
            (self.data_dir / "audio").mkdir(exist_ok=True)
            (self.data_dir / "audio" / f"{ident}.webm").write_bytes(b"x" * 10)
        (self.data_dir / "tmp").mkdir(exist_ok=True)
        (self.data_dir / "tmp" / f"{SEG_RECORDING}.part").write_bytes(b"")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def open(self) -> ReceiverRecordStore:
        return ReceiverRecordStore(self.data_dir, clock=self.clock)

    def rows(self, table: str) -> Dict[str, sqlite3.Row]:
        with closing(sqlite3.connect(self.db_path)) as db:
            db.row_factory = sqlite3.Row
            return {row["id"]: row for row in db.execute(f"SELECT * FROM {table}")}

    def test_migration_adds_columns_backfills_and_normalises(self) -> None:
        self.open().close()
        with closing(sqlite3.connect(self.db_path)) as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 1)
            indexes = {row[1] for table in ("audio_segments", "scans") for row in db.execute(f"PRAGMA index_list({table})")}
            settings = dict(db.execute("SELECT key,value FROM settings"))
        self.assertTrue({"audio_segments_start_ms", "audio_segments_end_ms", "scans_start_ms", "scans_end_ms"} <= indexes)
        self.assertEqual((settings["retention_days"], settings["retention_last_run"]), ("null", "null"))

        segments = self.rows("audio_segments")
        start = ms(datetime(2025, 3, 1, 10, 0, tzinfo=UTC))
        duration = segments[SEG_DURATION]
        # The relative length decides the end, not the browser's ended_at.
        self.assertEqual((duration["start_ms"], duration["end_ms"]), (start, start + 300_000))
        self.assertIsNone(duration["vfo_index"])
        self.assertIsNone(duration["mode"])
        self.assertEqual(duration["frequency_hz"], 144_500_000)
        self.assertEqual((duration["status"], duration["duration_s"]), ("complete", 300))
        self.assertEqual(duration["search_text"], "audio vfo 144.500000 bbbbbbbb")
        no_time = segments[SEG_NO_TIME]
        self.assertEqual((no_time["start_ms"], no_time["end_ms"]), (ms(BASE), ms(BASE)))
        self.assertEqual((no_time["vfo_index"], no_time["mode"], no_time["status"]), (1, "wfm", "complete"))
        early = segments[SEG_EARLY_END]
        self.assertEqual((early["start_ms"], early["end_ms"], early["duration_s"]), (start, start, 0))
        self.assertEqual((early["mode"], early["status"]), ("am", "partial"))
        recording = segments[SEG_RECORDING]
        self.assertEqual((recording["end_ms"], recording["status"], recording["duration_s"]), (None, "recording", None))

        scans = self.rows("scans")
        interrupted = scans[SCAN_INTERRUPTED]
        self.assertEqual(interrupted["start_ms"], ms(datetime(2025, 3, 1, tzinfo=UTC)))
        self.assertEqual(interrupted["end_ms"], ms(datetime(2025, 3, 1, 1, tzinfo=UTC)))
        self.assertEqual((interrupted["status"], interrupted["archived"], interrupted["source"]), ("interrupted", 1, ""))
        self.assertEqual((interrupted["start_hz"], interrupted["end_hz"], interrupted["fft_size"]), (1e8, 2e8, 4096))
        self.assertEqual((interrupted["trace_count"], interrupted["candidate_count"]), (3, 2))
        self.assertEqual(
            interrupted["byte_count"],
            sum(len(payload) for payload in self.frame_payloads) + sum(len(payload) for payload in self.candidate_payloads),
        )
        self.assertEqual(interrupted["search_text"], "scan pindai 100.000-200.000 cccccccc")
        unarchived = scans[SCAN_UNARCHIVED]
        self.assertEqual((unarchived["archived"], unarchived["status"], unarchived["source"]), (0, "stopped", "manual"))
        self.assertEqual((unarchived["start_hz"], unarchived["end_hz"], unarchived["fft_size"]), (3e8, 4e8, 3))
        record_only = scans[SCAN_RECORD_ONLY]
        self.assertEqual((record_only["archived"], record_only["status"]), (1, "complete"))
        self.assertEqual((record_only["start_hz"], record_only["fft_size"]), (None, None))
        self.assertEqual(record_only["end_ms"], ms(datetime(2025, 3, 3, 0, 20, tzinfo=UTC)))

    def test_second_open_is_a_no_op_and_late_old_rows_are_backfilled(self) -> None:
        self.open().close()
        before = {key: dict(row) for key, row in self.rows("audio_segments").items()}
        self.clock.set(BASE + timedelta(days=1))
        store = self.open()
        store.close()
        self.assertEqual({key: dict(row) for key, row in self.rows("audio_segments").items()}, before)
        late = "bbbbbbbb-0000-4000-8000-000000000009"
        with closing(sqlite3.connect(self.db_path)) as db, db:
            # As an older console writes it: only the columns it knows.
            db.execute(
                "INSERT INTO audio_segments(id,session_id,started_at,finished_at,byte_count,temp_name,file_name,metadata) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (late, SESSION_A, "2025-03-05T00:00:00+00:00", "2025-03-05T00:00:30+00:00", 0, "", None,
                 json.dumps({"vfo_index": 3, "frequency_hz": 1e6, "mode": "lsb", "bandwidth_hz": 2700,
                             "duration_seconds": 30, "status": "failed"})),
            )
            db.execute("UPDATE scans SET status='deleting' WHERE id=?", (SCAN_INTERRUPTED,))
        self.open().close()
        row = self.rows("audio_segments")[late]
        start = ms(datetime(2025, 3, 5, tzinfo=UTC))
        self.assertEqual((row["start_ms"], row["end_ms"], row["vfo_index"], row["status"]), (start, start + 30_000, 3, "failed"))
        with closing(sqlite3.connect(self.db_path)) as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 1)
            # A scan left 'deleting' by a crash is finished off, frames and candidates included.
            self.assertIsNone(db.execute("SELECT 1 FROM scans WHERE id=?", (SCAN_INTERRUPTED,)).fetchone())
            self.assertEqual(db.execute("SELECT count(*) FROM frames").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM candidates").fetchone()[0], 0)

    def test_failed_migration_rolls_back_and_retries(self) -> None:
        original = receiver_record_store._SCAN_ARCHIVE_COLUMNS
        broken = original + (("broken", "NOT A TYPE ("),)
        with mock.patch.object(receiver_record_store, "_SCAN_ARCHIVE_COLUMNS", broken):
            with self.assertRaises(sqlite3.Error):
                self.open()
        with closing(sqlite3.connect(self.db_path)) as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 0)
            columns = {row[1] for row in db.execute("PRAGMA table_info(audio_segments)")}
        self.assertNotIn("start_ms", columns)
        self.open().close()
        with closing(sqlite3.connect(self.db_path)) as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 1)


class StoreWriteTests(StoreCase):
    def test_segment_columns_follow_the_server_clock(self) -> None:
        session_id = self.session(BASE)
        segment_id = self.segment(session_id, BASE)
        row = self.sql("SELECT * FROM audio_segments WHERE id=?", (segment_id,))[0]
        self.assertEqual((row["start_ms"], row["end_ms"], row["status"]), (ms(BASE), None, "recording"))
        self.assertEqual((row["vfo_index"], row["mode"], row["frequency_hz"], row["bandwidth_hz"]), (0, "nfm", 144e6, 12_500))
        self.clock.set(BASE + timedelta(seconds=5))
        browser_end = (BASE - timedelta(minutes=10)).isoformat()
        first = self.store.finish_segment(segment_id, {"ended_at": browser_end, "duration_seconds": 2})
        retry = self.store.finish_segment(segment_id, {"ended_at": BASE.isoformat(), "duration_seconds": 9, "status": "failed"})
        self.assertEqual(retry, first)
        row = self.sql("SELECT * FROM audio_segments WHERE id=?", (segment_id,))[0]
        # finished_at keeps the browser's ended_at; end_ms is the server clock.
        self.assertEqual(row["finished_at"], browser_end)
        self.assertEqual((row["end_ms"], row["status"], row["duration_s"]), (ms(BASE) + 5000, "complete", 2))

    def test_segment_end_is_never_before_its_start(self) -> None:
        session_id = self.session(BASE)
        segment_id = self.segment(session_id, BASE)
        self.clock.set(BASE - timedelta(hours=1))
        self.store.finish_segment(segment_id, {"ended_at": BASE.isoformat(), "duration_seconds": 1})
        row = self.sql("SELECT start_ms,end_ms FROM audio_segments WHERE id=?", (segment_id,))[0]
        self.assertEqual(row["end_ms"], row["start_ms"])

    def test_unclosed_segment_ends_at_its_part_file_mtime(self) -> None:
        session_id = self.session(BASE)
        segment_id = self.segment(session_id, BASE)
        part = self.data_dir / "tmp" / f"{segment_id}.part"
        modified = (ms(BASE) + 3_250) / 1000
        os.utime(part, (modified, modified))
        self.clock.set(BASE + timedelta(hours=2))
        self.store.finish_audio_session(session_id, finalize_open_segments=True)
        row = self.sql("SELECT end_ms,status,duration_s FROM audio_segments WHERE id=?", (segment_id,))[0]
        self.assertEqual((row["end_ms"], row["status"]), (ms(BASE) + 3_250, "interrupted"))
        self.assertGreaterEqual(row["duration_s"], 0)

    def test_scan_columns_and_exact_counts(self) -> None:
        scan_id = self.scan(BASE, source="manual", traces=4, candidates=3)
        row = self.sql("SELECT * FROM scans WHERE id=?", (scan_id,))[0]
        self.assertEqual((row["start_ms"], row["end_ms"], row["status"], row["archived"]), (ms(BASE), None, "running", 1))
        self.assertEqual((row["source"], row["start_hz"], row["end_hz"], row["fft_size"]), ("manual", 100e6, 200e6, 4096))
        # Running scans are counted at finish.
        self.assertEqual(row["trace_count"], 0)
        self.clock.set(BASE + timedelta(minutes=3))
        self.store.finish_scan(scan_id, "stopped", trace_upload_failures=2)
        row = self.sql("SELECT * FROM scans WHERE id=?", (scan_id,))[0]
        exact = self.sql(
            "SELECT (SELECT coalesce(sum(length(payload)),0) FROM frames WHERE scan_id=?)"
            "+(SELECT coalesce(sum(length(payload)),0) FROM candidates WHERE scan_id=?)", (scan_id, scan_id),
        )[0][0]
        self.assertEqual((row["end_ms"], row["status"]), (ms(BASE) + 180_000, "stopped"))
        self.assertEqual((row["trace_count"], row["candidate_count"], row["byte_count"]), (4, 3, exact))
        # A late upload after finish recounts.
        self.store.add_trace(scan_id, 9, trace_bytes(9))
        self.store.upsert_candidates(scan_id, [candidate(7)])
        row = self.sql("SELECT trace_count,candidate_count,byte_count FROM scans WHERE id=?", (scan_id,))[0]
        self.assertEqual((row["trace_count"], row["candidate_count"]), (5, 4))
        self.assertGreater(row["byte_count"], exact)

    def test_new_scan_removes_the_previous_unarchived_one_through_the_batched_delete(self) -> None:
        self.store.update_settings({"auto_spectrum_recording": True})
        first = self.scan(BASE, archive=False, traces=5)
        archived = self.scan(BASE + timedelta(seconds=1), archive=True)
        with mock.patch.object(ra, "SCAN_DELETE_BATCH_ROWS", 2):
            replacement = self.scan(BASE + timedelta(seconds=2), archive=False)
        ids = {row["id"] for row in self.sql("SELECT id FROM scans")}
        self.assertEqual(ids, {archived, replacement})
        self.assertEqual(self.sql("SELECT count(*) FROM frames WHERE scan_id=?", (first,))[0][0], 0)

    def test_recovery_follows_the_store_clock(self) -> None:
        now = datetime.now(UTC)
        self.clock.set(now)
        session_id = self.session()
        segment_id = self.segment(session_id, now)
        self.clock.set(now - timedelta(days=1))
        self.assertEqual(self.store.recover_interrupted_recordings()["audio_sessions"], 0)
        self.clock.set(now + timedelta(days=1))
        recovered = self.store.recover_interrupted_recordings()
        self.assertEqual(recovered["audio_sessions"], 1)
        row = self.sql("SELECT status FROM audio_segments WHERE id=?", (segment_id,))[0]
        self.assertEqual(row["status"], "interrupted")

    def test_recovered_scan_ends_at_its_last_activity(self) -> None:
        scan_id = self.scan(BASE, traces=1)
        self.clock.set(BASE + timedelta(days=3))
        self.assertEqual(self.store.recover_interrupted_recordings()["scans"], 1)
        row = self.sql("SELECT status,end_ms FROM scans WHERE id=?", (scan_id,))[0]
        self.assertEqual(row["status"], "interrupted")
        self.assertLess(row["end_ms"], ms(BASE) + 60_000)


class ArchiveItemsTests(StoreCase):
    def setUp(self) -> None:
        super().setUp()
        day = datetime(2025, 3, 1, tzinfo=UTC)
        self.day = day
        _, self.night = self.recording(day + timedelta(hours=23, minutes=50), day + timedelta(days=1, minutes=10),
                                       vfo=1, frequency=145e6, mode="WFM", bandwidth=150_000, audio=b"a" * 300)
        _, self.morning = self.recording(day + timedelta(hours=8), day + timedelta(hours=8, minutes=5),
                                         frequency=144e6, mode="NFM", audio=b"a" * 100)
        _, self.failed = self.recording(day + timedelta(hours=9), day + timedelta(hours=9, minutes=1),
                                        audio=b"", status="failed", mode="am", frequency=146e6)
        self.scan_done = self.scan(day + timedelta(hours=12), day + timedelta(hours=12, minutes=30),
                                   start_hz=400e6, end_hz=450e6, traces=2, candidates=1, source="simulated")
        self.unarchived = self.scan(day + timedelta(hours=13), day + timedelta(hours=13, minutes=1), archive=False)
        # Open items last, at the latest clock, so recovery never sees them as stale.
        self.now = day + timedelta(days=2, hours=1)
        self.open_session = self.session(day + timedelta(days=2))
        self.recording_id = self.segment(self.open_session, day + timedelta(days=2), frequency=430e6, mode="usb")
        self.running = self.scan(day + timedelta(days=2), start_hz=420e6, end_hz=440e6)
        self.clock.set(self.now)

    def window(self, start: datetime, end: datetime) -> ArchiveFilter:
        return ArchiveFilter(from_ms=ms(start), to_ms=ms(end))

    def test_overlap_counts_an_item_on_every_day_and_open_items_end_now(self) -> None:
        first_day = self.window(self.day, self.day + timedelta(days=1))
        second_day = self.window(self.day + timedelta(days=1), self.day + timedelta(days=2))
        third_day = self.window(self.day + timedelta(days=2), self.day + timedelta(days=3))
        self.assertIn(self.night, self.ids(first_day))
        self.assertIn(self.night, self.ids(second_day))
        self.assertEqual(self.ids(second_day), {self.night})
        self.assertEqual(self.ids(third_day), {self.recording_id, self.running})
        future = self.window(self.now + timedelta(hours=1), self.now + timedelta(hours=2))
        self.assertEqual(self.ids(future), set())

    def test_daily_windows_including_one_past_midnight(self) -> None:
        def at(days: int, hour: int, minute: int = 0) -> int:
            return ms(self.day + timedelta(days=days, hours=hour, minutes=minute))

        morning = ArchiveFilter(windows=((at(0, 7), at(0, 8, 30)), (at(1, 7), at(1, 8, 30))))
        self.assertEqual(self.ids(morning), {self.morning})
        late = ArchiveFilter(windows=((at(0, 23, 55), at(1, 0, 5)), (at(1, 23, 55), at(2, 0, 5))))
        self.assertEqual(self.ids(late), {self.night, self.recording_id, self.running})
        with self.assertRaises(ArchiveError):
            ra.parse_filter_query({"windows": [f"{at(0, 9)}-{at(0, 10)},{at(0, 8)}-{at(0, 9)}"]})
        with self.assertRaises(ArchiveError):
            ra.parse_filter_query({"windows": [f"{at(0, 8)}-{at(0, 10)},{at(0, 9)}-{at(0, 11)}"]})
        with self.assertRaises(ArchiveError):
            ra.parse_filter_query({"windows": [f"{at(0, 8)}-{at(0, 9)}"], "from_ms": ["1"], "to_ms": ["2"]})
        parsed = ra.parse_filter_query({"windows": [f"{at(0, 7)}-{at(0, 8, 30)},{at(1, 7)}-{at(1, 8, 30)}"]})
        self.assertEqual(parsed.windows, morning.windows)

    def test_type_status_and_unlisted_scans(self) -> None:
        everything = self.ids()
        self.assertNotIn(self.unarchived, everything)
        self.assertEqual(self.ids(ArchiveFilter(kind="scan")), {self.scan_done, self.running})
        self.assertEqual(self.ids(ArchiveFilter(kind="audio")), {self.night, self.morning, self.failed, self.recording_id})
        self.assertEqual(self.ids(ArchiveFilter(status="running")), {self.running})
        self.assertEqual(self.ids(ArchiveFilter(status="recording")), {self.recording_id})
        self.assertEqual(self.ids(ArchiveFilter(status="failed")), {self.failed})
        with closing(self.db()) as db, db:
            db.execute("UPDATE scans SET status='deleting' WHERE id=?", (self.scan_done,))
        self.assertNotIn(self.scan_done, self.ids())

    def test_frequency_filter_matches_points_and_ranges_and_never_null(self) -> None:
        self.assertEqual(self.ids(ArchiveFilter(min_frequency_hz=144.5e6, max_frequency_hz=145.5e6)), {self.night})
        # A scan range overlapping the filter matches; 425 MHz is inside 400-450 and 420-440.
        self.assertEqual(self.ids(ArchiveFilter(min_frequency_hz=425e6, max_frequency_hz=426e6)), {self.scan_done, self.running})
        self.assertEqual(self.ids(ArchiveFilter(min_frequency_hz=445e6)), {self.scan_done})
        self.assertEqual(self.ids(ArchiveFilter(max_frequency_hz=144e6)), {self.morning})
        with closing(self.db()) as db, db:
            db.execute("UPDATE audio_segments SET frequency_hz=NULL WHERE id=?", (self.morning,))
            db.execute("UPDATE scans SET start_hz=NULL WHERE id=?", (self.scan_done,))
        self.assertEqual(self.ids(ArchiveFilter(max_frequency_hz=1e12)) & {self.morning, self.scan_done}, set())

    def test_vfo_mode_and_bandwidth_exclude_scans(self) -> None:
        self.assertEqual(self.ids(ArchiveFilter(vfo_index=1)), {self.night})
        self.assertEqual(self.ids(ArchiveFilter(mode="nfm")), {self.morning})
        self.assertEqual(self.ids(ArchiveFilter(bandwidth_hz=150_000)), {self.night})
        self.assertEqual(self.ids(ArchiveFilter(kind="scan", vfo_index=0)), set())
        self.assertNotIn(self.running, self.ids(ArchiveFilter(vfo_index=0)))

    def test_search_escapes_like_wildcards_and_finds_an_id(self) -> None:
        session_id = self.session(self.now)
        literal = self.segment(session_id, self.now, self.now + timedelta(seconds=1), mode="n_fm")
        other = self.segment(session_id, self.now, self.now + timedelta(seconds=1), mode="nxfm")
        self.assertEqual(self.ids(ArchiveFilter(q="n_fm")), {literal})
        self.assertNotIn(other, self.ids(ArchiveFilter(q="n_fm")))
        self.assertEqual(self.ids(ArchiveFilter(q="%")), set())
        self.assertEqual(self.ids(ArchiveFilter(q=self.scan_done[:8])), {self.scan_done})
        self.assertEqual(self.ids(ArchiveFilter(q="pindai simulated")), {self.scan_done})
        self.assertEqual(self.ids(ArchiveFilter(q="vfo2 wfm 145.000")), {self.night})
        self.assertEqual(ra.parse_filter_query({"q": ["  VFO2 WFM  "]}).q, "vfo2 wfm")

    def test_every_sort_key_both_ways_with_a_stable_tie_order(self) -> None:
        page = self.store.archive_items(ArchiveFilter(), limit=200)["items"]
        now_ms = ms(self.now)
        values = {
            "start": lambda item: item["start_ms"],
            "end": lambda item: item["end_ms"] if item["end_ms"] is not None else now_ms,
            "duration": lambda item: item["duration_s"],
            "frequency": lambda item: item["frequency_hz"] if item["kind"] == "audio" else item["start_hz"],
            "size": lambda item: item["bytes"],
            "type": lambda item: item["kind"],
            "status": lambda item: item["status"],
        }
        for sort, value in values.items():
            for order in ("asc", "desc"):
                with self.subTest(sort=sort, order=order):
                    def key(item: Dict[str, Any]) -> Tuple[Any, ...]:
                        primary = value(item)
                        # SQLite puts NULL first in ascending order.
                        rank = (0, 0) if primary is None else (1, primary)
                        return rank
                    ordered = sorted(page, key=lambda item: (item["kind"], item["id"]))
                    ordered = sorted(ordered, key=key, reverse=(order == "desc"))
                    if order == "desc":
                        # The tie order stays kind, id ascending.
                        groups: Dict[Any, List[Dict[str, Any]]] = {}
                        for item in ordered:
                            groups.setdefault(key(item), []).append(item)
                        ordered = [item for rank in sorted(groups, reverse=True)
                                   for item in sorted(groups[rank], key=lambda entry: (entry["kind"], entry["id"]))]
                    expected = [(item["kind"], item["id"]) for item in ordered]
                    self.assertEqual(self.keys(sort=sort, order=order), expected)

    def test_paging_totals_and_estimates(self) -> None:
        result = self.store.archive_items(ArchiveFilter(), limit=2, offset=0)
        self.assertEqual((result["total"], len(result["items"])), (6, 2))
        totals = result["totals"]
        self.assertEqual((totals["audio"], totals["scan"]), (4, 2))
        audio_bytes = sum(row[0] for row in self.sql("SELECT byte_count FROM audio_segments"))
        scan_bytes = sum(row[0] for row in self.sql("SELECT byte_count FROM scans WHERE archived=1"))
        self.assertEqual(totals["bytes"], audio_bytes + scan_bytes)
        page = self.store.archive_items(ArchiveFilter(), limit=200)["items"]
        self.assertEqual(totals["estimated_bytes"], sum(item["estimated_bytes"] for item in page))
        scan = next(item for item in page if item["id"] == self.scan_done)
        self.assertEqual(scan["estimated_bytes"], 2 * 16384 + 1 * 1024 + 8192)
        morning = next(item for item in page if item["id"] == self.morning)
        self.assertEqual(morning["estimated_bytes"], morning["bytes"] + 1024)
        beyond = self.store.archive_items(ArchiveFilter(), offset=50)
        self.assertEqual((beyond["items"], beyond["total"]), ([], 6))

    def test_item_flags(self) -> None:
        page = {item["id"]: item for item in self.store.archive_items(ArchiveFilter(), limit=200)["items"]}
        recording = page[self.recording_id]
        self.assertEqual((recording["status"], recording["deletable"], recording["downloadable"]), ("recording", False, False))
        self.assertIsNone(recording["end"])
        failed = page[self.failed]
        self.assertEqual((failed["status"], failed["playable"], failed["downloadable"], failed["deletable"]),
                         ("failed", False, False, True))
        running = page[self.running]
        self.assertEqual(
            (running["status"], running["deletable"], running["downloadable"], running["previewable"]),
            ("running", False, False, False),
        )
        done = page[self.scan_done]
        self.assertEqual((done["previewable"], done["downloadable"], done["playable"]), (True, True, False))
        self.assertEqual((done["source"], done["trace_count"], done["candidate_count"]), ("simulated", 2, 1))
        morning = page[self.morning]
        self.assertTrue(morning["playable"] and morning["downloadable"] and morning["previewable"])
        self.assertTrue(morning["start"].endswith("Z"))
        self.assertRegex(morning["start"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")
        self.assertEqual((morning["vfo_index"], morning["mode"], morning["codec"]), (0, "nfm", "audio/webm;codecs=opus"))


class ParameterValidationTests(unittest.TestCase):
    def assert_invalid(self, query: Dict[str, List[str]], parse: Any = ra.parse_filter_query) -> None:
        with self.assertRaises(ArchiveError) as caught:
            parse(query)
        self.assertEqual((caught.exception.status, caught.exception.code), (400, ra.ARCHIVE_INVALID_REQUEST))

    def test_filter_queries_are_refused_with_the_field_named(self) -> None:
        for query in (
            {"from_ms": ["1"]},
            {"to_ms": ["1"]},
            {"from_ms": ["0"], "to_ms": [str(ra.MAX_ITEMS_SPAN_MS + 1)]},
            {"from_ms": ["5"], "to_ms": ["5"]},
            {"from_ms": ["0"], "to_ms": [str(ra.MAX_MS + 1)]},
            {"from_ms": ["0"], "to_ms": ["99999999999999999999"]},
            {"from_ms": ["-1"], "to_ms": ["5"]},
            {"type": ["other"]},
            {"status": ["done"]},
            {"q": ["x" * 65]},
            {"min_frequency_hz": ["5"], "max_frequency_hz": ["4"]},
            {"min_frequency_hz": ["nan"]},
            {"max_frequency_hz": ["inf"]},
            {"max_frequency_hz": ["1e999"]},
            {"max_frequency_hz": ["1_000"]},
            {"min_frequency_hz": ["-1"]},
            {"bandwidth_hz": ["2e9"]},
            {"vfo_index": ["64"]},
            {"vfo_index": ["-1"]},
            {"mode": ["N/F M"]},
            {"mode": ["x" * 17]},
            {"windows": [",".join(f"{index * 10}-{index * 10 + 5}" for index in range(63))]},
            {"windows": ["5-4"]},
            {"windows": ["0-90000001"]},
            {"windows": ["x" * 2049]},
        ):
            with self.subTest(query=query):
                self.assert_invalid(query)
        message = None
        try:
            ra.parse_filter_query({"vfo_index": ["64"]})
        except ArchiveError as exc:
            message = exc.message
        self.assertIn("vfo_index", message or "")

    def test_paging_is_bounded(self) -> None:
        for query in ({"limit": ["0"]}, {"limit": ["201"]}, {"offset": ["-1"]}, {"offset": ["1000000001"]},
                      {"sort": ["name"]}, {"order": ["up"]}):
            with self.subTest(query=query):
                self.assert_invalid(query, ra.parse_paging_query)
        self.assertEqual(ra.parse_paging_query({}), ("start", "desc", 0, 50))
        self.assertEqual(ra.parse_paging_query({"limit": ["200"], "offset": ["1000000000"], "sort": ["size"], "order": ["asc"]}),
                         ("size", "asc", 1_000_000_000, 200))

    def test_json_filters_and_selections(self) -> None:
        for value in (
            {"weird": 1},
            {"from_ms": 1.5, "to_ms": 2},
            {"from_ms": True, "to_ms": 2},
            {"windows": [[1, 2, 3]]},
            {"windows": [[1, 2]] * 63},
            {"min_frequency_hz": "1"},
            {"vfo_index": 1.0},
            {"mode": 5},
        ):
            with self.subTest(value=value):
                with self.assertRaises(ArchiveError):
                    ra.parse_filter_json(value)
        parsed = ra.parse_filter_json({"from_ms": 1, "to_ms": 2, "type": "audio", "vfo_index": 2, "min_frequency_hz": 1,
                                       "q": None})
        self.assertEqual((parsed.from_ms, parsed.to_ms, parsed.kind, parsed.vfo_index, parsed.q), (1, 2, "audio", 2, None))
        ident = "dddddddd-0000-4000-8000-000000000001"
        selection = ra.parse_selection({"items": [{"kind": "audio", "id": ident.upper()}, {"kind": "audio", "id": ident}]}, 5)
        self.assertEqual(selection.items, (("audio", ident),))
        for payload in (
            {},
            {"items": [], "filter": {}},
            {"items": []},
            {"items": [{"kind": "file", "id": ident}]},
            {"items": [{"kind": "audio", "id": "../../etc/passwd"}]},
            {"items": [{"kind": "audio", "id": ident}], "expected_count": 1},
            {"filter": {}},
            {"filter": {}, "expected_count": -1},
            {"filter": {}, "expected_count": True},
            {"filter": {}, "expected_count": 1, "path": "/etc"},
            {"filter": {"path": "/etc"}, "expected_count": 1},
            {"items": [{"kind": "audio", "id": ident}], "utc_offset_minutes": 5000},
        ):
            with self.subTest(payload=payload):
                with self.assertRaises(ArchiveError):
                    ra.parse_selection(payload, 5)
        many = [{"kind": "scan", "id": f"dddddddd-0000-4000-8000-{index:012d}"} for index in range(6)]
        with self.assertRaises(ArchiveError) as caught:
            ra.parse_selection({"items": many}, 5)
        self.assertEqual((caught.exception.status, caught.exception.code), (413, ra.ARCHIVE_TOO_MANY_ITEMS))
        self.assertEqual((caught.exception.extra["count"], caught.exception.extra["limit"]), (6, 5))

    def test_retention_values(self) -> None:
        for value in (0, 2, 365, "x", True, 7.0, [], {}):
            with self.subTest(value=value):
                with self.assertRaises(ArchiveError) as caught:
                    ra.parse_retention_days(value)
                self.assertEqual(caught.exception.code, ra.RETENTION_INVALID)
        self.assertIsNone(ra.parse_retention_days(None))
        self.assertEqual([ra.parse_retention_days(days) for days in ra.RETENTION_DAY_OPTIONS], [1, 3, 7, 14, 30, 60, 90])
        for text in (None, "0", "2", "7.0", "x", "1000"):
            with self.assertRaises(ArchiveError):
                ra.parse_retention_query(text)

    def test_archive_error_is_not_a_value_error(self) -> None:
        self.assertFalse(issubclass(ArchiveError, ValueError))
        error = ArchiveError(409, ra.ARCHIVE_SELECTION_CHANGED, count=3)
        self.assertEqual(error.body(), {"count": 3, "ok": False, "code": ra.ARCHIVE_SELECTION_CHANGED,
                                        "error": ra.ARCHIVE_ERROR_MESSAGES[ra.ARCHIVE_SELECTION_CHANGED]})
        self.assertEqual(set(ra.ARCHIVE_ERROR_MESSAGES), set(ra.ARCHIVE_ERROR_CODES))


class CalendarTimelineFacetTests(StoreCase):
    def test_calendar_bounds_are_validated(self) -> None:
        hour = 3_600_000
        for text in (None, "", "5", "10,5", f"0,{hour - 1}", f"0,{50 * hour + 1}",
                     ",".join(str(index * 24 * hour) for index in range(44)), "x" * 1025, "0,abc"):
            with self.subTest(text=text):
                with self.assertRaises(ArchiveError):
                    ra.parse_calendar_bounds(text)
        self.assertEqual(ra.parse_calendar_bounds(f"0,{hour},{51 * hour}"), [0, hour, 51 * hour])

    def test_calendar_counts_days_of_any_length(self) -> None:
        start = datetime(2025, 3, 1, tzinfo=UTC)
        hour = 3_600_000
        steps = [24 * hour, 23 * hour, 25 * hour, 48 * hour, 24 * hour]
        bounds = [ms(start)]
        for step in steps:
            bounds.append(bounds[-1] + step)
        # Day 0: 24 h, day 1: 23 h, day 2: 25 h, day 3: 48 h (a skipped local day), day 4: 24 h.
        self.recording(start + timedelta(hours=2), start + timedelta(hours=3))
        crossing_at = datetime(1970, 1, 1, tzinfo=UTC) + timedelta(milliseconds=bounds[2] - 30 * 60_000)
        self.recording(crossing_at, crossing_at + timedelta(hours=1))
        late = datetime(1970, 1, 1, tzinfo=UTC) + timedelta(milliseconds=bounds[3] + 40 * hour)
        self.scan(late, late + timedelta(minutes=5))
        result = self.store.archive_calendar(bounds, "all")
        self.assertEqual(result["days"], [
            {"audio": 1, "scan": 0}, {"audio": 1, "scan": 0}, {"audio": 1, "scan": 0},
            {"audio": 0, "scan": 1}, {"audio": 0, "scan": 0},
        ])
        self.assertEqual(result["first_ms"], ms(start + timedelta(hours=2)))
        self.assertEqual(result["last_ms"], ms(late + timedelta(minutes=5)))
        self.assertFalse(result["truncated"])
        audio_only = self.store.archive_calendar(bounds, "audio")
        self.assertEqual([day["scan"] for day in audio_only["days"]], [0] * 5)
        with mock.patch.object(ra, "CALENDAR_ROW_CAP", 1):
            self.assertTrue(self.store.archive_calendar(bounds, "all")["truncated"])

    def test_timeline_clips_merges_and_truncates(self) -> None:
        day = datetime(2025, 3, 2, tzinfo=UTC)
        session_id = self.session(day - timedelta(hours=1))
        self.segment(session_id, day - timedelta(minutes=30), day + timedelta(minutes=10))
        self.segment(session_id, day + timedelta(minutes=10, seconds=30), day + timedelta(minutes=20))
        self.segment(session_id, day + timedelta(hours=1), day + timedelta(hours=1, minutes=5))
        self.finish_session(session_id, day + timedelta(hours=2))
        self.scan(day + timedelta(hours=5), day + timedelta(hours=6))
        open_session = self.session(day + timedelta(hours=22))
        self.segment(open_session, day + timedelta(hours=22))
        self.scan(day + timedelta(hours=23))
        now = day + timedelta(hours=23, minutes=30)
        self.clock.set(now)
        result = self.store.archive_timeline(ms(day), ms(day + timedelta(days=1)), ArchiveFilter())
        start = ms(day)
        self.assertEqual(result["audio"], [
            [start, start + 20 * 60_000],
            [start + 3_600_000, start + 3_900_000],
            [start + 22 * 3_600_000, ms(now)],
        ])
        self.assertEqual(result["scan"], [[start + 5 * 3_600_000, start + 6 * 3_600_000], [start + 23 * 3_600_000, ms(now)]])
        self.assertEqual(result["counts"], {"audio": 4, "scan": 2})
        self.assertFalse(result["truncated"])
        audio_only = self.store.archive_timeline(ms(day), ms(day + timedelta(days=1)), ArchiveFilter(vfo_index=0))
        self.assertEqual(audio_only["scan"], [])
        with mock.patch.object(ra, "TIMELINE_MAX_INTERVALS", 2):
            cut = self.store.archive_timeline(ms(day), ms(day + timedelta(days=1)), ArchiveFilter(kind="audio"))
        self.assertEqual((len(cut["audio"]), cut["truncated"]), (2, True))
        with mock.patch.object(ra, "TIMELINE_ROW_CAP", 2):
            capped = self.store.archive_timeline(ms(day), ms(day + timedelta(days=1)), ArchiveFilter())
        self.assertTrue(capped["truncated"])
        self.assertEqual(capped["counts"], {"audio": 4, "scan": 2})
        with self.assertRaises(ArchiveError):
            ra.parse_timeline_query({"from_ms": ["0"], "to_ms": [str(ra.MAX_TIMELINE_SPAN_MS + 1)]})
        with self.assertRaises(ArchiveError):
            ra.parse_timeline_query({"from_ms": ["0"]})

    def test_facets_are_normalised_and_bounded(self) -> None:
        self.recording(BASE, BASE + timedelta(seconds=5), vfo=2, mode="NFM", bandwidth=12_500, frequency=144e6)
        self.recording(BASE, BASE + timedelta(seconds=5), vfo=0, mode="Wfm", bandwidth=150_000, frequency=145e6)
        self.recording(BASE, BASE + timedelta(seconds=5), vfo=0, mode="weird mode!", bandwidth=150_000, frequency=1e6)
        self.scan(BASE, BASE + timedelta(seconds=5), source="simulated", start_hz=50e6, end_hz=900e6)
        self.scan(BASE, BASE + timedelta(seconds=5), source="hacked", start_hz=60e6, end_hz=70e6)
        self.clock.set(BASE + timedelta(minutes=1))
        facets = self.store.archive_facets()
        self.assertEqual(facets["vfo_indices"], [0, 2])
        self.assertEqual(facets["modes"], ["nfm", "wfm"])
        self.assertEqual(facets["bandwidths_hz"], [12_500, 150_000])
        self.assertEqual(facets["sources"], ["simulated"])
        self.assertEqual(facets["statuses"], ["complete"])
        self.assertEqual((facets["min_frequency_hz"], facets["max_frequency_hz"]), (1e6, 900e6))
        self.assertEqual((facets["totals"]["audio"], facets["totals"]["scan"]), (3, 2))
        self.assertEqual(facets["first_ms"], ms(BASE))
        self.assertEqual(facets["last_ms"], ms(BASE + timedelta(seconds=5)))
        self.assertIsInstance(facets["free_bytes"], int)
        with mock.patch.object(ra, "FACET_LIMIT", 1):
            self.assertEqual(self.store.archive_facets()["vfo_indices"], [0])
        with mock.patch.object(receiver_record_store.shutil, "disk_usage", side_effect=OSError("no disk")):
            self.assertIsNone(self.store.archive_facets()["free_bytes"])


class SelectionAndDeleteTests(StoreCase):
    def test_explicit_ids_unknown_and_not_downloadable(self) -> None:
        _, done = self.recording(BASE, BASE + timedelta(seconds=2))
        _, failed = self.recording(BASE, BASE + timedelta(seconds=2), audio=b"", status="failed")
        unknown = "dddddddd-0000-4000-8000-000000000009"
        unarchived = self.scan(BASE, BASE + timedelta(seconds=2), archive=False)
        selection = ra.parse_selection({"items": [
            {"kind": "audio", "id": done}, {"kind": "audio", "id": failed}, {"kind": "audio", "id": unknown},
            {"kind": "scan", "id": unarchived}, {"kind": "audio", "id": done},
        ]}, 10)
        rows, missing, total = self.store.resolve_selection(selection, 10, downloadable_only=True)
        self.assertEqual([row["id"] for row in rows], [done])
        self.assertEqual(missing, [
            {"kind": "audio", "id": failed, "reason": "not_downloadable"},
            {"kind": "audio", "id": unknown, "reason": "not_found"},
            {"kind": "scan", "id": unarchived, "reason": "not_found"},
        ])
        self.assertEqual(total, 2)

    def test_filter_selection_checks_the_count_and_the_cap(self) -> None:
        for second in range(3):
            self.recording(BASE + timedelta(seconds=second), BASE + timedelta(seconds=second + 1))
        selection = ra.parse_selection({"filter": {"type": "audio"}, "expected_count": 2}, 10)
        with self.assertRaises(ArchiveError) as caught:
            self.store.resolve_selection(selection, 10)
        self.assertEqual((caught.exception.status, caught.exception.code, caught.exception.extra), (409, ra.ARCHIVE_SELECTION_CHANGED, {"count": 3}))
        selection = ra.parse_selection({"filter": {"type": "audio"}, "expected_count": 3}, 10)
        with self.assertRaises(ArchiveError) as caught:
            self.store.resolve_selection(selection, 2, downloadable_only=True)
        self.assertEqual((caught.exception.status, caught.exception.extra), (413, {"count": 3, "limit": 2}))
        rows, missing, total = self.store.resolve_selection(selection, 3, downloadable_only=True)
        self.assertEqual((len(rows), missing, total), (3, [], 3))

    def test_estimate_constants_match_the_receiver(self) -> None:
        self.assertEqual(
            (ra.ESTIMATE_AUDIO_EXTRA_BYTES, ra.ESTIMATE_SCAN_TRACE_BYTES, ra.ESTIMATE_SCAN_CANDIDATE_BYTES, ra.ESTIMATE_SCAN_EXTRA_BYTES),
            (1024, 16384, 1024, 8192),
        )
        self.assertEqual((ra.EXPORT_MAX_ITEMS, ra.EXPORT_MAX_BYTES, ra.DELETE_MAX_ITEMS), (1000, 4 * 1024 ** 3, 2000))
        client = OVERLAY_APP / "records-archive-format.ts"
        if not client.exists():
            self.skipTest("records-archive-format.ts is not in this checkout")
        text = client.read_text(encoding="utf-8")
        numbers = {int(value.replace("_", "")) for value in re.findall(r"\b(\d[\d_]*)\b", text)}
        for value in (1024, 16384, 8192):
            self.assertIn(value, numbers)

    def test_delete_removes_files_before_rows_and_skips_active_items(self) -> None:
        session_id, done = self.recording(BASE, BASE + timedelta(seconds=2))
        open_session = self.session(BASE + timedelta(seconds=10))
        finished_in_open = self.segment(open_session, BASE + timedelta(seconds=10), BASE + timedelta(seconds=11))
        recording = self.segment(open_session, BASE + timedelta(seconds=12))
        running = self.scan(BASE + timedelta(seconds=12))
        marker = self.store.save_markers({"name": "Keep", "markers": [{"frequency_hz": 1e6, "power_db": None}]})
        self.store.update_settings({"auto_spectrum_recording": True})
        file_path = self.data_dir / "audio" / f"{done}.webm"
        seen = []
        original_unlink = Path.unlink

        def unlink(path: Path, *args: Any, **kwargs: Any) -> None:
            if path.name.endswith(".webm"):
                seen.append(bool(self.sql("SELECT 1 FROM audio_segments WHERE id=?", (path.name[:-5],))))
            return original_unlink(path, *args, **kwargs)

        unknown = "dddddddd-0000-4000-8000-000000000009"
        with mock.patch.object(Path, "unlink", unlink):
            result = self.store.archive_delete([
                ("audio", done), ("audio", finished_in_open), ("audio", recording), ("audio", unknown), ("scan", running),
            ])
        self.assertEqual(seen, [True, True])
        self.assertFalse(file_path.exists())
        self.assertEqual(result["deleted"], {"audio": 2, "scan": 0})
        self.assertEqual(result["sessions"], 1)
        self.assertEqual(result["skipped_count"], 3)
        self.assertEqual(
            sorted((item["kind"], item["id"], item["code"]) for item in result["skipped"]),
            sorted([("audio", recording, ra.ARCHIVE_ITEM_ACTIVE), ("audio", unknown, ra.ARCHIVE_NOT_FOUND),
                    ("scan", running, ra.ARCHIVE_ITEM_ACTIVE)]),
        )
        self.assertTrue(all(item["error"] == ra.ARCHIVE_ERROR_MESSAGES[item["code"]] for item in result["skipped"]))
        sessions = {row["id"] for row in self.sql("SELECT id FROM audio_sessions")}
        self.assertEqual(sessions, {open_session})
        self.assertNotIn(session_id, sessions)
        self.assertEqual(self.store.get_markers()[0]["id"], marker["id"])
        self.assertTrue(self.store.get_settings()["auto_spectrum_recording"])

    def test_legacy_session_file_goes_with_its_emptied_session(self) -> None:
        session_id, segment_id = self.recording(BASE, BASE + timedelta(seconds=2))
        legacy = self.data_dir / "audio" / f"{session_id}.webm"
        legacy.write_bytes(b"legacy")
        with closing(self.db()) as db, db:
            db.execute("UPDATE audio_sessions SET file_name=? WHERE id=?", (legacy.name, session_id))
        result = self.store.archive_delete([("audio", segment_id)])
        self.assertEqual(result["sessions"], 1)
        self.assertFalse(legacy.exists())

    def test_scan_delete_runs_in_batches_and_reports_its_id(self) -> None:
        scan_id = self.scan(BASE, BASE + timedelta(minutes=1), traces=10, candidates=4)
        statements: List[str] = []
        original_connect = self.store._connect

        def connect() -> Any:
            manager = original_connect()

            class Wrapper:
                def __enter__(self_inner) -> sqlite3.Connection:
                    db = manager.__enter__()
                    db.set_trace_callback(statements.append)
                    return db

                def __exit__(self_inner, *exc: Any) -> Any:
                    return manager.__exit__(*exc)

            return Wrapper()

        with mock.patch.object(ra, "SCAN_DELETE_BATCH_ROWS", 3), mock.patch.object(self.store, "_connect", connect):
            result = self.store.archive_delete([("scan", scan_id)])
        frame_deletes = [statement for statement in statements if statement.startswith("DELETE FROM frames")]
        candidate_deletes = [statement for statement in statements if statement.startswith("DELETE FROM candidates")]
        self.assertEqual((len(frame_deletes), len(candidate_deletes)), (4, 2))
        self.assertEqual(result["deleted"], {"audio": 0, "scan": 1})
        self.assertEqual(result["deleted_scan_ids"], [scan_id])
        self.assertGreater(result["bytes"], 0)
        self.assertEqual(self.sql("SELECT count(*) FROM frames")[0][0], 0)
        self.assertEqual(self.sql("SELECT count(*) FROM scans")[0][0], 0)

    def test_unlink_failure_keeps_the_row(self) -> None:
        _, segment_id = self.recording(BASE, BASE + timedelta(seconds=2))
        original_unlink = Path.unlink

        def failing(path: Path, *args: Any, **kwargs: Any) -> None:
            if path.suffix == ".webm":
                raise PermissionError(13, "in use")
            return original_unlink(path, *args, **kwargs)

        with mock.patch.object(Path, "unlink", failing):
            result = self.store.archive_delete([("audio", segment_id)])
        self.assertEqual(result["deleted"], {"audio": 0, "scan": 0})
        self.assertEqual(result["skipped"][0]["code"], ra.ARCHIVE_STORAGE_ERROR)
        self.assertNotIn("/", result["skipped"][0]["error"])
        self.assertEqual(len(self.sql("SELECT 1 FROM audio_segments WHERE id=?", (segment_id,))), 1)

    def test_live_chunk_upload_proceeds_between_scan_delete_batches(self) -> None:
        self.store.update_settings({"auto_spectrum_recording": True})
        scan_id = self.scan(BASE, BASE + timedelta(minutes=1), traces=30)
        session_id = self.session(BASE + timedelta(minutes=2))
        live = self.segment(session_id, BASE + timedelta(minutes=2))
        observations: List[Tuple[bool, int]] = []
        deleting = threading.current_thread()
        depth = threading.local()
        inner = threading.RLock()

        class ObservedLock:
            def __enter__(self_inner) -> None:
                inner.acquire()
                depth.value = getattr(depth, "value", 0) + 1

            def __exit__(self_inner, *exc: Any) -> None:
                depth.value -= 1
                inner.release()
                if depth.value == 0 and threading.current_thread() is deleting and not observations:
                    remaining = self.sql("SELECT count(*) FROM frames WHERE scan_id=?", (scan_id,))[0][0]
                    if 0 < remaining < 30:
                        done = threading.Event()

                        def upload() -> None:
                            self.store.append_segment_audio(live, b"live chunk")
                            done.set()

                        worker = threading.Thread(target=upload)
                        worker.start()
                        worker.join(5)
                        observations.append((done.is_set(), remaining))

            def acquire(self_inner, *args: Any, **kwargs: Any) -> bool:
                return inner.acquire(*args, **kwargs)

            def release(self_inner) -> None:
                inner.release()

        with mock.patch.object(ra, "SCAN_DELETE_BATCH_ROWS", 5), mock.patch.object(self.store, "_lock", ObservedLock()):
            result = self.store.archive_delete([("scan", scan_id)])
        self.assertEqual(result["deleted"]["scan"], 1)
        self.assertEqual(len(observations), 1)
        self.assertTrue(observations[0][0], "the chunk upload waited for the whole scan delete")
        size = self.sql("SELECT byte_count FROM audio_segments WHERE id=?", (live,))[0][0]
        self.assertEqual(size, len(b"webm audio") + len(b"live chunk"))

    def test_scan_delete_pauses_outside_the_lock_between_batches(self) -> None:
        # Python locks are not fair: without a pause the deleting thread takes the
        # lock straight back and a waiting chunk upload starves for the whole delete.
        self.store.update_settings({"auto_spectrum_recording": True})
        scan_id = self.scan(BASE, BASE + timedelta(minutes=1), traces=10)
        pauses: List[Tuple[float, bool]] = []

        def pause(seconds: float) -> None:
            pauses.append((seconds, self.store._lock._is_owned()))

        with mock.patch.object(ra, "SCAN_DELETE_BATCH_ROWS", 3), mock.patch.object(receiver_record_store.time, "sleep", pause):
            result = self.store.archive_delete([("scan", scan_id)])
        self.assertEqual(result["deleted"]["scan"], 1)
        # Frames 3+3+3+1: a pause after each full batch, none after the last one.
        self.assertEqual(pauses, [(ra.SCAN_DELETE_PAUSE_S, False)] * 3)


class RetentionTests(StoreCase):
    def set_retention(self, days: Optional[int]) -> None:
        self.store.save_settings({"retention_days": days, "confirm": True} if days is not None else {"retention_days": None})

    def populate(self) -> Dict[str, str]:
        old = BASE - timedelta(days=10)
        items = {}
        items["old_session"], items["old_audio"] = self.recording(old, old + timedelta(minutes=1), audio=b"a" * 50)
        items["old_failed_session"], items["old_failed"] = self.recording(old, old + timedelta(minutes=1), audio=b"",
                                                                          status="failed")
        items["new_session"], items["new_audio"] = self.recording(BASE - timedelta(hours=2), BASE - timedelta(hours=1))
        # A session still recording keeps its finished old segment.
        items["open_session"] = self.session(old)
        items["open_old_segment"] = self.segment(items["open_session"], old, old + timedelta(minutes=2))
        items["old_scan"] = self.scan(old, old + timedelta(minutes=3), traces=2, candidates=2)
        items["empty_old_session"] = self.session(old)
        self.finish_session(items["empty_old_session"], old + timedelta(seconds=1))
        items["empty_new_session"] = self.session(BASE - timedelta(hours=1))
        self.finish_session(items["empty_new_session"], BASE - timedelta(minutes=30))
        self.clock.set(BASE)
        items["live_segment"] = self.segment(items["open_session"], BASE)
        items["running_scan"] = self.scan(BASE)
        # Created last: a new scan replaces the previous unarchived one.
        items["unarchived"] = self.scan(old + timedelta(minutes=5), old + timedelta(minutes=6), archive=False)
        self.clock.set(BASE)
        items["marker"] = self.store.save_markers({"name": "Keep", "markers": []})["id"]
        return items

    def test_settings_need_confirm_for_a_new_value(self) -> None:
        with self.assertRaises(ArchiveError) as caught:
            self.store.save_settings({"retention_days": 7})
        self.assertEqual(caught.exception.code, ra.RETENTION_CONFIRM_REQUIRED)
        for payload in ({"retention_days": True, "confirm": True}, {"retention_days": 5, "confirm": True}):
            with self.assertRaises(ArchiveError) as caught:
                self.store.save_settings(payload)
            self.assertEqual(caught.exception.code, ra.RETENTION_INVALID)
        for payload in ({"confirm": True}, {"retention_days": 7, "confirm": False}, {"retention_days": 7, "confirm": 1}):
            with self.assertRaises(ValueError):
                self.store.save_settings(payload)
        settings, changed = self.store.save_settings({"retention_days": 7, "confirm": True})
        self.assertEqual((settings["retention_days"], changed), (7, True))
        self.assertEqual(self.store.save_settings({"retention_days": 7}), (settings, False))
        settings, changed = self.store.save_settings({"retention_days": None})
        self.assertEqual((settings["retention_days"], changed), (None, False))
        self.assertIsNone(self.store.apply_retention())

    def test_preview_matches_the_pass_and_only_old_finished_items_go(self) -> None:
        items = self.populate()
        self.set_retention(1)
        preview = self.store.retention_preview(1)
        self.assertEqual(preview["cutoff_ms"], ms(BASE) - 86_400_000)
        self.assertEqual((preview["audio"], preview["scans"], preview["sessions"]), (2, 1, 3))
        with self.assertRaises(ArchiveError):
            self.store.retention_preview(2)
        result = self.store.apply_retention()
        self.assertEqual(
            {key: result[key] for key in ("audio", "sessions", "scans", "bytes", "failed", "more")},
            {"audio": preview["audio"], "sessions": preview["sessions"], "scans": preview["scans"],
             "bytes": preview["bytes"], "failed": 0, "more": False},
        )
        segments = {row[0] for row in self.sql("SELECT id FROM audio_segments")}
        self.assertEqual(segments, {items["new_audio"], items["open_old_segment"], items["live_segment"]})
        sessions = {row[0] for row in self.sql("SELECT id FROM audio_sessions")}
        self.assertEqual(sessions, {items["new_session"], items["open_session"], items["empty_new_session"]})
        scans = {row[0] for row in self.sql("SELECT id FROM scans")}
        self.assertEqual(scans, {items["unarchived"], items["running_scan"]})
        self.assertEqual([marker["id"] for marker in self.store.get_markers()], [items["marker"]])
        self.assertFalse((self.data_dir / "audio" / f"{items['old_audio']}.webm").exists())
        settings = self.store.get_settings()
        self.assertEqual(settings["retention_last_run_ms"], ms(BASE))
        self.assertEqual(settings["retention_last_removed"]["audio"], 2)
        self.assertEqual(self.store.retention_preview(1)["audio"], 0)

        # Once the session ends, its old segment goes with the next pass.
        self.clock.set(BASE + timedelta(seconds=10))
        self.store.finish_segment(items["live_segment"], {"ended_at": BASE.isoformat(), "duration_seconds": 10})
        self.store.finish_audio_session(items["open_session"])
        again = self.store.apply_retention()
        self.assertEqual((again["audio"], again["sessions"]), (1, 0))
        self.assertEqual({row[0] for row in self.sql("SELECT id FROM audio_segments")}, {items["new_audio"], items["live_segment"]})

    def test_pass_order_is_audio_then_sessions_then_scans_oldest_first(self) -> None:
        old = BASE - timedelta(days=5)
        _, second = self.recording(old + timedelta(hours=2), old + timedelta(hours=3))
        _, first = self.recording(old, old + timedelta(hours=1))
        late_scan = self.scan(old + timedelta(hours=4), old + timedelta(hours=5))
        early_scan = self.scan(old, old + timedelta(minutes=30))
        self.clock.set(BASE)
        self.set_retention(1)
        calls: List[Tuple[str, Any]] = []
        original_segments, original_scan = self.store._delete_segment_batch, self.store._delete_scan

        def segments(ids: Any, cutoff_ms: Any = None) -> Any:
            calls.append(("audio", list(ids)))
            return original_segments(ids, cutoff_ms=cutoff_ms)

        def scan(scan_id: str, check: Any = None) -> Any:
            calls.append(("scan", scan_id))
            return original_scan(scan_id, check)

        with mock.patch.object(self.store, "_delete_segment_batch", segments), mock.patch.object(self.store, "_delete_scan", scan):
            self.store.apply_retention()
        self.assertEqual(calls, [("audio", [first, second]), ("scan", early_scan), ("scan", late_scan)])

    def test_setting_and_last_run_survive_a_restart_and_init_removes_nothing(self) -> None:
        self.recording(BASE - timedelta(days=10), BASE - timedelta(days=10) + timedelta(minutes=1))
        self.clock.set(BASE)
        self.set_retention(1)
        self.store.close()
        restarted = ReceiverRecordStore(self.data_dir, clock=self.clock)
        try:
            self.assertEqual(restarted.get_settings()["retention_days"], 1)
            self.assertEqual(len(self.sql("SELECT 1 FROM audio_segments")), 1)
            restarted.apply_retention()
        finally:
            restarted.close()
        again = ReceiverRecordStore(self.data_dir, clock=self.clock)
        try:
            self.assertEqual(again.get_settings()["retention_last_removed"]["audio"], 1)
            self.assertEqual(again.get_settings()["retention_last_run_ms"], ms(BASE))
        finally:
            again.close()

    def test_a_failing_item_is_counted_and_the_pass_goes_on(self) -> None:
        old = BASE - timedelta(days=5)
        _, stuck = self.recording(old, old + timedelta(minutes=1))
        _, other = self.recording(old + timedelta(minutes=5), old + timedelta(minutes=6))
        self.clock.set(BASE)
        self.set_retention(1)
        original_unlink = Path.unlink

        def failing(path: Path, *args: Any, **kwargs: Any) -> None:
            if path.name == f"{stuck}.webm":
                raise PermissionError(13, "in use")
            return original_unlink(path, *args, **kwargs)

        with mock.patch.object(Path, "unlink", failing):
            result = self.store.apply_retention()
        self.assertEqual((result["audio"], result["failed"]), (1, 1))
        self.assertEqual({row[0] for row in self.sql("SELECT id FROM audio_segments")}, {stuck})
        self.assertNotIn(other, {row[0] for row in self.sql("SELECT id FROM audio_segments")})
        self.assertEqual(self.store.apply_retention()["audio"], 1)

    def test_item_bound_and_time_budget_leave_more(self) -> None:
        old = BASE - timedelta(days=5)
        for minute in range(4):
            self.recording(old + timedelta(minutes=minute), old + timedelta(minutes=minute, seconds=30))
        self.clock.set(BASE)
        self.set_retention(1)
        with mock.patch.object(ra, "RETENTION_MAX_ITEMS_PER_PASS", 2), mock.patch.object(ra, "RETENTION_CANDIDATE_BATCH", 1):
            result = self.store.apply_retention()
        self.assertEqual((result["audio"], result["more"]), (2, True))
        ticks = iter([0.0] + [100.0] * 50)
        self.store.monotonic = lambda: next(ticks)
        result = self.store.apply_retention(budget_s=5)
        self.assertEqual((result["audio"], result["more"]), (0, True))
        self.store.monotonic = time.monotonic
        result = self.store.apply_retention(budget_s=5)
        self.assertEqual((result["audio"], result["more"]), (2, False))

    def test_concurrent_passes_run_one_at_a_time(self) -> None:
        self.recording(BASE - timedelta(days=5), BASE - timedelta(days=5) + timedelta(minutes=1))
        self.clock.set(BASE)
        self.set_retention(1)
        entered, release = threading.Event(), threading.Event()
        original = self.store._retention_days

        def slow() -> Optional[int]:
            entered.set()
            release.wait(5)
            return original()

        results: List[Any] = []
        with mock.patch.object(self.store, "_retention_days", slow):
            worker = threading.Thread(target=lambda: results.append(self.store.apply_retention()))
            worker.start()
            self.assertTrue(entered.wait(5))
            self.assertTrue(self.store.get_settings()["retention_running"])
            self.assertIsNone(self.store.apply_retention())
            release.set()
            worker.join(5)
        self.assertEqual(results[0]["audio"], 1)
        self.assertFalse(self.store.get_settings()["retention_running"])

    def test_pass_is_logged(self) -> None:
        lines: List[str] = []
        self.store.log = lines.append
        self.recording(BASE - timedelta(days=5), BASE - timedelta(days=5) + timedelta(minutes=1), audio=b"a" * 2048)
        self.clock.set(BASE)
        self.set_retention(3)
        self.store.apply_retention()
        self.assertEqual(lines, ["[ground-console] receiver retention 3 d: removed 1 audio, 0 scans (0.0 MiB), 0 failed"])
        self.store.apply_retention()
        self.assertEqual(len(lines), 1)


class SchedulerTests(unittest.TestCase):
    def test_scheduler_runs_wakes_and_stops(self) -> None:
        calls: List[float] = []
        scheduler = ra.RetentionScheduler(lambda: calls.append(time.monotonic()), interval_s=0.05, start_delay_s=0.05)
        scheduler.start()
        deadline = time.monotonic() + 2
        while len(calls) < 2 and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertGreaterEqual(len(calls), 2)
        started = time.monotonic()
        scheduler.stop()
        self.assertLess(time.monotonic() - started, 1)
        self.assertFalse(scheduler.is_alive())

        woken: List[int] = []
        slow = ra.RetentionScheduler(lambda: woken.append(1), interval_s=3600, start_delay_s=3600)
        slow.start()
        slow.wake()
        deadline = time.monotonic() + 2
        while not woken and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(woken, [1])
        slow.stop()
        self.assertFalse(slow.is_alive())

    def test_a_pass_with_more_continues_at_once_and_a_failure_does_not_end_the_timer(self) -> None:
        results = iter([{"audio": 1, "scans": 0, "sessions": 0, "more": True}, RuntimeError("boom"), None])
        calls: List[int] = []
        lines: List[str] = []

        def apply() -> Any:
            calls.append(1)
            value = next(results, None)
            if isinstance(value, Exception):
                raise value
            return value

        scheduler = ra.RetentionScheduler(apply, interval_s=0.05, start_delay_s=0.0, log=lines.append)
        scheduler.start()
        deadline = time.monotonic() + 2
        while len(calls) < 3 and time.monotonic() < deadline:
            time.sleep(0.01)
        scheduler.stop()
        self.assertGreaterEqual(len(calls), 3)
        self.assertEqual(lines, ["[ground-console] receiver retention pass failed: RuntimeError"])

    def server(self, root: Path, port: int = 0, **kwargs: Any) -> Any:
        return ground_console.GroundConsoleServer(
            ("127.0.0.1", port), "http://doasdr.local:8081",
            config_path=str(root / "console.json"), branding_path=str(root / "branding.json"),
            receiver_data_dir=root / "receiver", **kwargs,
        )

    def test_server_owns_the_scheduler(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            calls: List[int] = []
            with mock.patch.object(ReceiverRecordStore, "apply_retention", lambda store, *a, **k: calls.append(1)):
                server = self.server(Path(temp), retention_interval_s=0.05, retention_start_delay_s=0.05)
                deadline = time.monotonic() + 2
                while not calls and time.monotonic() < deadline:
                    time.sleep(0.01)
                scheduler = server._retention_scheduler
                closed: List[bool] = []
                original_close = server.receiver_store.close

                def close() -> None:
                    closed.append(scheduler.is_alive())
                    original_close()

                server.receiver_store.close = close  # type: ignore[assignment]
                server.server_close()
            self.assertTrue(calls)
            self.assertEqual(closed, [False])

    def test_failed_bind_leaves_no_thread(self) -> None:
        with tempfile.TemporaryDirectory() as temp, closing(socket.socket()) as busy:
            busy.bind(("127.0.0.1", 0))
            busy.listen(1)
            before = {thread for thread in threading.enumerate() if thread.name == "receiver-retention"}
            with self.assertRaises(OSError):
                self.server(Path(temp), port=busy.getsockname()[1])
            after = {thread for thread in threading.enumerate() if thread.name == "receiver-retention"}
            self.assertEqual(after, before)


def zip_store_case() -> Any:
    return StoreCase


class Unseekable:
    """A response body: write and flush only, tell() raises."""

    def __init__(self) -> None:
        self.buffer = io.BytesIO()

    def write(self, data: bytes) -> int:
        return self.buffer.write(data)

    def flush(self) -> None:
        pass

    def tell(self) -> int:
        raise io.UnsupportedOperation("unseekable")


class ZipExportTests(StoreCase):
    def export(self, entries: List[Tuple[str, str]], missing: Any = (), zone: Any = UTC) -> zipfile.ZipFile:
        sink = Unseekable()
        writer = ra.ChunkedWriter(sink, chunked=False)
        ra.write_archive_zip(self.store, entries, writer, zone, time_zone_name="UTC", console_version="test",
                             created_ms=ms(BASE), missing=missing)
        writer.finish()
        self.raw = sink.buffer.getvalue()
        return zipfile.ZipFile(io.BytesIO(self.raw))

    def assert_safe_names(self, names: List[str]) -> None:
        for name in names:
            self.assertFalse(name.startswith("/") or name.startswith("."), name)
            self.assertNotIn("..", name)
            self.assertNotIn("\\", name)
            self.assertLessEqual(len(name), 120, name)
            for part in name.split("/"):
                self.assertTrue(part, name)
                self.assertRegex(part, r"^[A-Za-z0-9._+-]+$")

    def test_layout_names_audio_and_manifest(self) -> None:
        # An even second: ZIP times have a 2 s resolution.
        start = datetime(2025, 3, 9, 23, 30, 6, tzinfo=UTC)
        session_id = self.session(start)
        audio = bytes(range(256)) * 40
        first = self.segment(session_id, start, start + timedelta(seconds=4), vfo=1, mode="n/f m", frequency=144_512_345.5,
                             audio=audio)
        second = self.segment(session_id, start, start + timedelta(seconds=4), vfo=1, mode="n/f m", frequency=144_512_345.5,
                              audio=b"other")
        # Same start second and id8: the second name gets -2.
        twin = first[:8] + second[8:]
        with closing(self.db()) as db, db:
            db.execute("UPDATE audio_segments SET id=?,file_name=? WHERE id=?", (twin, f"{twin}.webm", second))
        os.replace(self.data_dir / "audio" / f"{second}.webm", self.data_dir / "audio" / f"{twin}.webm")
        self.finish_session(session_id, start + timedelta(seconds=5))
        archive = self.export([("audio", first), ("audio", twin)])
        names = archive.namelist()
        stem = f"audio/2025-03-09/20250309-233006+0000_vfo2_144.512346MHz_n-f-m_{first[:8]}"
        self.assertEqual(names, [stem + ".webm", stem + ".json", stem + "-2.webm", stem + "-2.json", "manifest.json"])
        self.assert_safe_names(names)
        info = archive.getinfo(stem + ".webm")
        self.assertEqual(info.compress_type, zipfile.ZIP_STORED)
        self.assertEqual(info.date_time, (2025, 3, 9, 23, 30, 6))
        self.assertEqual(archive.read(stem + ".webm"), audio)
        details = json.loads(archive.read(stem + ".json"))
        self.assertEqual(details["format"], "sdr-doa-receiver-audio")
        self.assertEqual((details["vfo"], details["vfo_index"], details["frequency_reference"]), (2, 1, "displayed"))
        self.assertEqual((details["mode"], details["bytes"], details["file"]), ("n/f m", len(audio), stem.split("/")[-1] + ".webm"))
        self.assertEqual(details["start"], "2025-03-09T23:30:06.000Z")
        manifest = json.loads(archive.read("manifest.json"))
        self.assertEqual(manifest["format"], "sdr-doa-receiver-archive")
        self.assertEqual((manifest["console_version"], manifest["time_zone"]), ("test", "UTC"))
        self.assertEqual([item["id"] for item in manifest["items"]], [first, twin])
        self.assertIsNone(archive.testzip())

    def test_local_zone_names_and_clamped_dates(self) -> None:
        zone = timezone(timedelta(hours=7))
        _, segment_id = self.recording(BASE, BASE + timedelta(seconds=1))
        names = self.export([("audio", segment_id)], zone=zone).namelist()
        self.assertTrue(names[0].startswith("audio/2025-03-10/20250310-190000+0700_vfo1_"), names[0])
        for year, expected in ((1975, (1980, 1, 1, 0, 0, 0)), (2200, (2107, 12, 31, 23, 59, 58))):
            with closing(self.db()) as db, db:
                db.execute("UPDATE audio_segments SET start_ms=? WHERE id=?",
                           (ms(datetime(year, 6, 1, tzinfo=UTC)), segment_id))
            archive = self.export([("audio", segment_id)])
            self.assertEqual(archive.infolist()[0].date_time, expected)

    def test_scan_files(self) -> None:
        scan_id = self.scan(BASE, start_hz=100e6, end_hz=102.048e6, traces=3, source="native")
        self.store.upsert_candidates(scan_id, [
            candidate(1),
            candidate(2, noiseFloorDb="=HYPERLINK(1)", bandwidthHz=None, firstSeen="7", hits=True),
            {"id": 3, "startHz": 1.25, "lastSeen": 7},
        ])
        with closing(self.db()) as db, db:
            db.execute("INSERT INTO frames(scan_id,sweep,captured_at,payload) VALUES(?,?,?,?)",
                       (scan_id, 99, BASE.isoformat(), b"not zlib"))
            db.execute("INSERT INTO frames(scan_id,sweep,captured_at,payload) VALUES(?,?,?,?)",
                       (scan_id, 100, BASE.isoformat(), zlib.compress(b"short")))
        self.clock.set(BASE + timedelta(minutes=2))
        self.store.finish_scan(scan_id, "complete")
        archive = self.export([("scan", scan_id)])
        folder = f"scans/2025-03-10/20250310-120000+0000_100.000-102.048MHz_{scan_id[:8]}/"
        self.assertEqual(archive.namelist(), [
            folder + "candidates.csv", folder + "candidates.json", folder + "traces.csv", folder + "scan.json", "manifest.json",
        ])
        self.assert_safe_names(archive.namelist())
        csv_text = archive.read(folder + "candidates.csv").decode("ascii")
        lines = csv_text.split("\r\n")
        session_source = (OVERLAY_APP / "sweep-session.ts").read_text(encoding="utf-8")
        header_block = re.search(r"exportSweepCandidatesCsv[\s\S]*?const header = \[([\s\S]*?)\];", session_source).group(1)
        self.assertEqual(lines[0].split(","), re.findall(r"'([a-z_]+)'", header_block))
        self.assertNotIn("\n", csv_text.replace("\r\n", ""))
        rows = [line.split(",") for line in lines[1:] if line]
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0][0], "1.25")
        self.assertEqual(rows[0][12], "7")
        self.assertEqual(rows[0][1:12], [""] * 11)
        second = rows[2]
        # A text, null, missing or boolean value is an empty cell, so no cell can carry a formula.
        self.assertEqual((second[7], second[9], second[11], second[13]), ("", "", "", ""))
        self.assertNotIn("HYPERLINK", csv_text)
        self.assertEqual(rows[1][0], str(100_000_000 + 25_000 - 5_000))
        self.assertEqual(rows[1][4], repr(100_025_000.5))
        payloads = json.loads(archive.read(folder + "candidates.json"))
        self.assertEqual(len(payloads), 3)
        self.assertEqual(payloads[2]["noiseFloorDb"], "=HYPERLINK(1)")

        traces = archive.read(folder + "traces.csv").decode("ascii").split("\r\n")
        header = traces[0].split(",")
        self.assertEqual(len(header), 2050)
        self.assertEqual(header[:2], ["sweep", "captured_at"])
        self.assertEqual(header[2], str(round(100e6 + 0.5 * 1000)))
        self.assertEqual(header[-1], str(round(100e6 + 2047.5 * 1000)))
        rows = [line.split(",") for line in traces[1:] if line]
        self.assertEqual(len(rows), 3)
        expected = ra.decode_trace(trace_bytes(1), 1)
        self.assertEqual(rows[1][2:], [f"{value:.1f}" for value in expected])
        self.assertEqual(rows[1][2], rows[1][3])
        self.assertEqual(rows[1][0], "1")
        details = json.loads(archive.read(folder + "scan.json"))
        self.assertEqual((details["trace_count"], details["traces_written"], details["traces_skipped"]), (5, 3, 2))
        self.assertEqual((details["frequency_reference"], details["source"], details["candidate_count"]), ("device", "native", 3))
        self.assertEqual(details["files"], ["candidates.csv", "candidates.json", "traces.csv", "scan.json"])
        self.assertIsNone(archive.testzip())

    def test_legacy_and_unknown_trace_formats(self) -> None:
        legacy = self.scan(BASE, BASE + timedelta(minutes=1), trace_format=None)
        self.store.add_trace(legacy, 0, trace_bytes(0, tagged=False))
        unknown = self.scan(BASE + timedelta(seconds=1), BASE + timedelta(minutes=1), trace_format=2, traces=1)
        no_range = self.scan(BASE + timedelta(seconds=2), BASE + timedelta(minutes=1), start_hz=None, traces=1)
        archive = self.export([("scan", legacy), ("scan", unknown), ("scan", no_range)])
        legacy_rows = [name for name in archive.namelist() if legacy[:8] in name and name.endswith("traces.csv")]
        values = archive.read(legacy_rows[0]).decode("ascii").split("\r\n")[1].split(",")[2:]
        self.assertEqual(values, [f"{value:.1f}" for value in ra.decode_trace(trace_bytes(0, tagged=False), None)])
        self.assertEqual(values[0], f"{-160 + 128 * 160 / 255:.1f}")
        manifest = json.loads(archive.read("manifest.json"))
        omitted = {item["id"]: item.get("omitted") for item in manifest["items"]}
        self.assertEqual(omitted[unknown], [{"file": "traces.csv", "reason": "unsupported_trace_format"}])
        self.assertEqual(omitted[no_range], [{"file": "traces.csv", "reason": "unknown_range"}])
        self.assertIsNone(omitted[legacy])
        self.assertFalse(any(unknown[:8] in name and name.endswith("traces.csv") for name in archive.namelist()))

    def test_decode_constants_match_the_receiver(self) -> None:
        source = (OVERLAY_APP / "sweep-waterfall.ts").read_text(encoding="utf-8")

        def constant(name: str) -> int:
            return int(re.search(rf"export const {name} = (-?\d+);", source).group(1))

        self.assertEqual(constant("SWEEP_WATERFALL_MIN_DB"), ra.TRACE_MIN_DB)
        self.assertEqual(constant("SWEEP_WATERFALL_MAX_DB"), ra.TRACE_MAX_DB)
        self.assertEqual(constant("LEGACY_SWEEP_LEVEL_MAX_DB"), ra.LEGACY_TRACE_MAX_DB)
        self.assertEqual(constant("ARCHIVED_TRACE_FORMAT_TAG"), ra.TRACE_FORMAT_TAG)
        self.assertEqual(constant("SWEEP_WATERFALL_BINS") if "SWEEP_WATERFALL_BINS = 2048" in source else 2048, ra.TRACE_BYTES)
        with self.assertRaises(ValueError):
            ra.decode_trace(bytes(2048), 2)

    def test_missing_and_truncated_items(self) -> None:
        _, gone_file = self.recording(BASE, BASE + timedelta(seconds=1))
        (self.data_dir / "audio" / f"{gone_file}.webm").unlink()
        _, deleted = self.recording(BASE, BASE + timedelta(seconds=1))
        self.store.archive_delete([("audio", deleted)])
        scan_id = self.scan(BASE, BASE + timedelta(minutes=1), traces=4)
        original = self.store.iter_scan_frames

        def vanishing(ident: str, batch: int = 100) -> Any:
            for index, frame in enumerate(original(ident, batch)):
                if index == 2:
                    raise ra.ArchiveItemGone(ident)
                yield frame

        with mock.patch.object(self.store, "iter_scan_frames", vanishing):
            archive = self.export([("audio", gone_file), ("audio", deleted), ("scan", scan_id)],
                                  missing=[{"kind": "audio", "id": "x", "reason": "not_found"}])
        self.assertEqual(archive.namelist()[-1], "manifest.json")
        manifest = json.loads(archive.read("manifest.json"))
        self.assertEqual(manifest["missing"], [
            {"kind": "audio", "id": "x", "reason": "not_found"},
            {"kind": "audio", "id": gone_file, "reason": "file_missing"},
            {"kind": "audio", "id": deleted, "reason": "deleted"},
        ])
        self.assertEqual(manifest["items"][0]["truncated"], True)
        traces = [name for name in archive.namelist() if name.endswith("traces.csv")][0]
        self.assertEqual(len([line for line in archive.read(traces).decode().split("\r\n")[1:] if line]), 2)
        self.assertIsNone(archive.testzip())

    def test_zip64_is_forced_for_a_large_entry_and_reads_back(self) -> None:
        scan_id = self.scan(BASE, BASE + timedelta(minutes=1), traces=2)
        forced: Dict[str, bool] = {}
        original = ra._ArchiveZip.open

        def spy(archive: Any, name: str, date_time: Any, **kwargs: Any) -> Any:
            forced[name.rsplit("/", 1)[-1]] = kwargs.get("force_zip64", False)
            return original(archive, name, date_time, **kwargs)

        with mock.patch.object(ra, "ZIP64_ENTRY_THRESHOLD_BYTES", 10), mock.patch.object(ra._ArchiveZip, "open", spy):
            archive = self.export([("scan", scan_id)])
        self.assertTrue(forced["traces.csv"])
        self.assertIsNone(archive.testzip())
        self.assertIn(b"\x01\x00", self.raw)

    def test_names_never_escape_their_folder(self) -> None:
        for value in ("../../etc/passwd", "..", ".hidden", "a\\b", "x" * 80, "é/ü", ""):
            part = ra.name_part(value)
            self.assertNotIn("..", part)
            self.assertFalse(part.startswith("."))
            self.assertRegex(part, r"^[A-Za-z0-9._+-]{1,32}$")
        names = ra._Names()
        self.assertEqual(names.claim("audio/", "a", (".webm",)), "a")
        self.assertEqual(names.claim("audio/", "a", (".webm",)), "a-2")
        self.assertEqual(names.claim("audio/", "a", (".webm",)), "a-3")
        long_stem = names.claim("scans/2025-01-01/", "x" * 200, ("/",), reserve=16)
        self.assertLessEqual(len("scans/2025-01-01/" + long_stem + "/candidates.json"), 120)


class ChunkedWriterTests(unittest.TestCase):
    def test_framing_buffering_finish_and_abort(self) -> None:
        sink = io.BytesIO()
        writer = ra.ChunkedWriter(sink)
        writer.write(b"a" * 70_000)
        self.assertEqual(sink.getvalue(), b"10000\r\n" + b"a" * 65_536 + b"\r\n")
        writer.finish()
        self.assertTrue(sink.getvalue().endswith(b"%X\r\n" % (70_000 - 65_536) + b"a" * (70_000 - 65_536) + b"\r\n0\r\n\r\n"))
        with self.assertRaises(io.UnsupportedOperation):
            writer.tell()

        aborted = io.BytesIO()
        writer = ra.ChunkedWriter(aborted)
        writer.write(b"b" * 10)
        writer.abort()
        self.assertEqual(writer.write(b"more"), 4)
        self.assertEqual(aborted.getvalue(), b"")
        with self.assertRaises(ValueError):
            writer.finish()

        raw = io.BytesIO()
        writer = ra.ChunkedWriter(raw, chunked=False)
        writer.write(b"c" * 70_000)
        writer.finish()
        self.assertEqual(raw.getvalue(), b"c" * 70_000)

    def test_a_failed_socket_write_stops_every_later_byte(self) -> None:
        class Broken:
            def __init__(self) -> None:
                self.writes = 0

            def write(self, data: bytes) -> int:
                self.writes += 1
                raise socket.timeout("timed out")

        sink = Broken()
        writer = ra.ChunkedWriter(sink)
        with self.assertRaises(socket.timeout):
            writer.write(b"x" * 70_000)
        writer.write(b"y" * 70_000)
        self.assertEqual(sink.writes, 1)
        self.assertTrue(writer.aborted)


class ScanPreviewTests(StoreCase):
    def test_preview_reduces_and_bounds(self) -> None:
        scan_id = self.scan(BASE, start_hz=1e8, end_hz=2e8)
        with closing(self.db()) as db, db:
            db.execute("INSERT INTO frames(scan_id,sweep,captured_at,payload) VALUES(?,?,?,?)",
                       (scan_id, 0, BASE.isoformat(), b"damaged"))
        for sweep in range(1, 600):
            self.store.add_trace(scan_id, sweep, trace_bytes(sweep))
        self.store.upsert_candidates(scan_id, [candidate(index) for index in range(1, 13)])
        self.clock.set(BASE + timedelta(minutes=1))
        self.store.finish_scan(scan_id, "complete")
        preview = self.store.archive_scan_preview(scan_id)
        self.assertEqual((preview["bins"], len(preview["max_db"]), len(preview["mean_db"])), (512, 512, 512))
        self.assertEqual(preview["trace_count"], 600)
        self.assertEqual(preview["traces_used"] + preview["traces_skipped"], 256)
        self.assertEqual(preview["traces_skipped"], 1)
        self.assertTrue(all(high >= low for high, low in zip(preview["max_db"], preview["mean_db"])))
        self.assertEqual(len(preview["candidates"]), 10)
        peaks = [item["peak_db"] for item in preview["candidates"]]
        self.assertEqual(peaks, sorted(peaks, reverse=True))
        self.assertEqual(preview["candidates"][0]["frequency_hz"], candidate(12)["peakFrequencyHz"])
        self.assertEqual(preview["trace_format"], 1)

    def test_preview_of_unsupported_and_unlisted_scans(self) -> None:
        unknown = self.scan(BASE, BASE + timedelta(minutes=1), trace_format=2, traces=2)
        preview = self.store.archive_scan_preview(unknown)
        self.assertEqual((preview["max_db"], preview["mean_db"], preview["trace_count"]), ([], [], 2))
        running = self.scan(BASE + timedelta(minutes=2))
        unarchived = self.scan(BASE + timedelta(minutes=3), BASE + timedelta(minutes=4), archive=False)
        deleting = self.scan(BASE + timedelta(minutes=5), BASE + timedelta(minutes=6))
        with closing(self.db()) as db, db:
            db.execute("UPDATE scans SET status='deleting' WHERE id=?", (deleting,))
        for scan_id in (running, unarchived, deleting, "dddddddd-0000-4000-8000-000000000001"):
            with self.assertRaises(ArchiveError) as caught:
                self.store.archive_scan_preview(scan_id)
            self.assertEqual((caught.exception.status, caught.exception.code), (404, ra.ARCHIVE_NOT_FOUND))


class HttpResult:
    def __init__(self, status: int, headers: Dict[str, str], body: bytes, version: int = 11) -> None:
        self.status, self.headers, self.body, self.version = status, headers, body, version

    def json(self) -> Any:
        return json.loads(self.body)


def decode_chunked(body: bytes) -> Tuple[bytes, bool]:
    """(payload, whether the final 0-chunk arrived)."""
    payload, position = b"", 0
    while True:
        end = body.find(b"\r\n", position)
        if end < 0:
            return payload, False
        size = int(body[position:end], 16)
        if size == 0:
            return payload, body[end + 2:end + 4] == b"\r\n"
        payload += body[end + 2:end + 2 + size]
        position = end + 2 + size + 2


class ArchiveHttpTests(StoreCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.server = ground_console.GroundConsoleServer(
            ("127.0.0.1", 0), "http://doasdr.local:8081",
            config_path=str(root / "console.json"), branding_path=str(root / "branding.json"),
            receiver_data_dir=root / "receiver",
        )
        self.store = self.server.receiver_store
        self.clock = Clock(BASE)
        self.store.clock = self.clock
        self.data_dir = self.store.data_dir
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]
        self.origin = f"http://127.0.0.1:{self.port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()
        self.temp.cleanup()

    def request(self, method: str, path: str, body: Any = None, headers: Optional[Dict[str, str]] = None,
                origin: bool = True) -> HttpResult:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        request_headers: Dict[str, str] = {}
        if origin and method in ("POST", "DELETE"):
            request_headers["Origin"] = self.origin
        if body is not None:
            body = json.dumps(body).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        request_headers.update(headers or {})
        connection.request(method, path, body=body, headers=request_headers)
        response = connection.getresponse()
        payload = response.read()
        result = HttpResult(response.status, dict(response.getheaders()), payload, response.version)
        connection.close()
        return result

    def raw(self, data: bytes) -> bytes:
        with closing(socket.create_connection(("127.0.0.1", self.port), timeout=10)) as conn:
            conn.sendall(data)
            chunks = []
            while True:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                chunks.append(chunk)
        return b"".join(chunks)

    def assert_archive_error(self, result: HttpResult, status: int, code: str) -> Dict[str, Any]:
        self.assertEqual(result.status, status, result.body[:300])
        body = result.json()
        self.assertEqual((body["ok"], body["code"]), (False, code))
        self.assertIn(body["code"], ra.ARCHIVE_ERROR_CODES)
        self.assertIsInstance(body["error"], str)
        self.assertNotIn(str(self.data_dir), body["error"])
        return body

    def test_every_receiver_get_follows_the_read_rule(self) -> None:
        _, segment_id = self.recording(BASE, BASE + timedelta(seconds=1))
        paths = ["/api/receiver/settings", "/api/receiver/records", "/api/receiver/archive/items",
                 f"/api/receiver/audio-segments/{segment_id}/audio", "/api/receiver/x"]
        refused = [
            {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"},
            {"Host": f"evil.example:{self.port}"}, {"Host": f"127.0.0.1:{self.port ^ 1}"},
            {"Host": f"user@127.0.0.1:{self.port}"}, {"Host": "127.0.0.1"},
        ]
        for path in paths:
            for headers in refused:
                with self.subTest(path=path, headers=headers):
                    result = self.request("GET", path, headers=headers)
                    body = self.assert_archive_error(result, 403, "ORIGIN_REJECTED")
                    self.assertEqual(body["error"], ra.READ_REJECTED_MESSAGE)
            for headers in ({}, {"Sec-Fetch-Site": "none"}, {"Sec-Fetch-Site": "same-origin"},
                            {"Host": f"localhost:{self.port}"}):
                with self.subTest(path=path, headers=headers):
                    status = self.request("GET", path, headers=headers).status
                    self.assertEqual(status, 404 if path.endswith("/x") else 200)
        answer = self.raw(b"GET /api/receiver/settings HTTP/1.0\r\n\r\n")
        self.assertTrue(answer.startswith(b"HTTP/1.0 403"), answer[:40])
        self.assertIn(b'"ORIGIN_REJECTED"', answer)
        twice = self.raw(f"GET /api/receiver/settings HTTP/1.0\r\nHost: 127.0.0.1:{self.port}\r\nHost: evil.example\r\n\r\n".encode())
        self.assertTrue(twice.startswith(b"HTTP/1.0 403"))

    def test_mutation_gate_keeps_its_text_and_adds_the_code(self) -> None:
        for method, path in (("POST", "/api/receiver/archive/delete"), ("POST", "/api/receiver/archive/exports"),
                             ("DELETE", "/api/receiver/records/dddddddd-0000-4000-8000-000000000001")):
            result = self.request(method, path, {"items": []}, origin=False)
            body = self.assert_archive_error(result, 403, "ORIGIN_REJECTED")
            self.assertEqual(body["error"], "Receiver mutation requires a same-origin loopback request")

    def test_archive_read_routes(self) -> None:
        _, segment_id = self.recording(BASE, BASE + timedelta(seconds=3))
        scan_id = self.scan(BASE + timedelta(minutes=1), BASE + timedelta(minutes=2), traces=2, candidates=1)
        self.clock.set(BASE + timedelta(minutes=5))
        facets = self.request("GET", "/api/receiver/archive/facets").json()
        self.assertEqual(facets["totals"]["audio"], 1)
        day = ms(datetime(2025, 3, 10, tzinfo=UTC))
        bounds = ",".join(str(day + index * 86_400_000) for index in range(3))
        calendar = self.request("GET", f"/api/receiver/archive/calendar?bounds={bounds}").json()
        self.assertEqual(calendar["days"], [{"audio": 1, "scan": 1}, {"audio": 0, "scan": 0}])
        timeline = self.request("GET", f"/api/receiver/archive/timeline?from_ms={day}&to_ms={day + 86_400_000}&type=scan"
                                       f"&from_ms=1").json()
        self.assertEqual(timeline["counts"], {"audio": 0, "scan": 1})
        items = self.request("GET", f"/api/receiver/archive/items?from_ms={day}&to_ms={day + 86_400_000}&sort=size&order=asc"
                                    "&limit=1&unknown=1").json()
        self.assertEqual((items["total"], len(items["items"]), items["limit"]), (2, 1, 1))
        preview = self.request("GET", f"/api/receiver/archive/scans/{scan_id}/preview").json()
        self.assertEqual(len(preview["max_db"]), 512)
        retention = self.request("GET", "/api/receiver/archive/retention-preview?days=7").json()
        self.assertEqual(set(retention), {"days", "cutoff_ms", "audio", "sessions", "scans", "bytes"})
        self.assert_archive_error(self.request("GET", "/api/receiver/archive/retention-preview?days=2"), 400, "RETENTION_INVALID")
        self.assert_archive_error(self.request("GET", "/api/receiver/archive/items?limit=0"), 400, "ARCHIVE_INVALID_REQUEST")
        self.assert_archive_error(self.request("GET", "/api/receiver/archive/items?from_ms=0&to_ms=99999999999999999999"),
                                  400, "ARCHIVE_INVALID_REQUEST")
        self.assert_archive_error(self.request("GET", "/api/receiver/archive/calendar?bounds=1"), 400, "ARCHIVE_INVALID_REQUEST")
        self.assert_archive_error(self.request("GET", f"/api/receiver/archive/scans/{segment_id}/preview"), 404, "ARCHIVE_NOT_FOUND")
        self.assert_archive_error(self.request("GET", "/api/receiver/archive/nothing"), 404, "ARCHIVE_NOT_FOUND")
        with mock.patch.object(self.store, "archive_facets", side_effect=sqlite3.OperationalError("disk I/O error at /secret/path")):
            body = self.assert_archive_error(self.request("GET", "/api/receiver/archive/facets"), 500, "ARCHIVE_STORAGE_ERROR")
        self.assertNotIn("secret", body["error"])

    def test_traversal_attempts_are_refused(self) -> None:
        for path in (
            "/api/receiver/archive/audio/../../../etc/passwd/download",
            "/api/receiver/archive/audio/..%2F..%2Fetc%2Fpasswd/download",
            "/api/receiver/archive/scans/%2e%2e/download",
            "/api/receiver/archive/exports/..%2F..%2F..%2F..%2F..%2F..%2F..%2F..",
            "/api/receiver/archive/exports/" + "A" * 31 + ".",
        ):
            with self.subTest(path=path):
                result = self.request("GET", path)
                self.assertIn(result.status, (400, 404))
                self.assertEqual(result.json()["ok"], False)
                self.assertNotIn(b"root:", result.body)

    def test_audio_download(self) -> None:
        audio = bytes(range(256)) * 300
        _, segment_id = self.recording(BASE, BASE + timedelta(seconds=3), vfo=1, mode="WFM", frequency=98_100_000, audio=audio)
        result = self.request("GET", f"/api/receiver/archive/audio/{segment_id}/download?time_zone=Asia%2FJakarta")
        self.assertEqual(result.status, 200)
        self.assertEqual(result.body, audio)
        self.assertEqual(result.headers["Content-Type"], "audio/webm")
        self.assertEqual(result.headers["Content-Length"], str(len(audio)))
        self.assertEqual(result.headers["Cache-Control"], "no-store")
        self.assertEqual(result.headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(
            result.headers["Content-Disposition"],
            f'attachment; filename="20250310-190000+0700_vfo2_98.100000MHz_wfm_{segment_id[:8]}.webm"',
        )
        self.assertNotIn("Accept-Ranges", result.headers)
        # Range is not supported here: a resumed browser download starts over.
        ranged = self.request("GET", f"/api/receiver/archive/audio/{segment_id}/download", headers={"Range": "bytes=10-19"})
        self.assertEqual((ranged.status, ranged.body), (200, audio))
        offset_only = self.request("GET", f"/api/receiver/archive/audio/{segment_id}/download?utc_offset_minutes=-300")
        self.assertIn('filename="20250310-070000-0500_vfo2_', offset_only.headers["Content-Disposition"])
        self.assert_archive_error(self.request("GET", f"/api/receiver/archive/audio/{segment_id}/download?utc_offset_minutes=5000"),
                                  400, "ARCHIVE_INVALID_REQUEST")
        _, failed = self.recording(BASE, BASE + timedelta(seconds=1), audio=b"", status="failed")
        self.assert_archive_error(self.request("GET", f"/api/receiver/archive/audio/{failed}/download"), 404, "ARCHIVE_FILE_MISSING")
        self.assert_archive_error(self.request("GET", "/api/receiver/archive/audio/dddddddd-0000-4000-8000-000000000001/download"),
                                  404, "ARCHIVE_NOT_FOUND")
        self.assert_archive_error(self.request("GET", f"/api/receiver/archive/audio/{segment_id}/download?time_zone=..%2Fx"),
                                  400, "ARCHIVE_INVALID_REQUEST")
        (self.data_dir / "audio" / f"{segment_id}.webm").unlink()
        self.assert_archive_error(self.request("GET", f"/api/receiver/archive/audio/{segment_id}/download"), 404, "ARCHIVE_FILE_MISSING")

    def test_scan_download_chunked_and_http10(self) -> None:
        scan_id = self.scan(BASE, BASE + timedelta(minutes=1), traces=3, candidates=2)
        result = self.request("GET", f"/api/receiver/archive/scans/{scan_id}/download")
        self.assertEqual(result.status, 200)
        self.assertEqual(result.version, 11)
        self.assertEqual(result.headers["Transfer-Encoding"], "chunked")
        self.assertEqual(result.headers["Connection"], "close")
        self.assertEqual(result.headers["Content-Type"], "application/zip")
        self.assertEqual(result.headers["Content-Disposition"],
                         f'attachment; filename="scan_20250310-120000+0000_100.000-200.000MHz_{scan_id[:8]}.zip"')
        archive = zipfile.ZipFile(io.BytesIO(result.body))
        self.assertIsNone(archive.testzip())
        self.assertEqual(archive.namelist()[-1], "manifest.json")

        answer = self.raw(f"GET /api/receiver/archive/scans/{scan_id}/download HTTP/1.0\r\nHost: 127.0.0.1:{self.port}\r\n\r\n".encode())
        head, _, body = answer.partition(b"\r\n\r\n")
        self.assertTrue(head.startswith(b"HTTP/1.0 200"))
        self.assertNotIn(b"Transfer-Encoding", head)
        self.assertIsNone(zipfile.ZipFile(io.BytesIO(body)).testzip())

        raw11 = self.raw(f"GET /api/receiver/archive/scans/{scan_id}/download HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n\r\n".encode())
        head, _, body = raw11.partition(b"\r\n\r\n")
        self.assertTrue(head.startswith(b"HTTP/1.1 200"))
        payload, complete = decode_chunked(body)
        self.assertTrue(complete)
        self.assertIsNone(zipfile.ZipFile(io.BytesIO(payload)).testzip())

        # The class stays HTTP/1.0 for every other answer.
        after = self.request("GET", "/api/receiver/settings")
        self.assertEqual((after.status, after.version), (200, 10))
        self.assertEqual(ground_console.ConsoleHandler.protocol_version, "HTTP/1.0")

        running = self.scan(BASE + timedelta(minutes=2))
        self.assert_archive_error(self.request("GET", f"/api/receiver/archive/scans/{running}/download"), 404, "ARCHIVE_NOT_FOUND")

    def test_a_stream_error_after_the_headers_ends_the_body_without_a_final_chunk(self) -> None:
        scan_id = self.scan(BASE, BASE + timedelta(minutes=1), traces=3, candidates=200)
        printed: List[str] = []

        def broken(ident: str, batch: int = 100) -> Any:
            raise OSError("read failed at /secret")
            yield  # pragma: no cover

        with mock.patch.object(self.store, "iter_scan_frames", broken), \
                mock.patch.object(ground_console, "print", lambda *args, **kwargs: printed.append(" ".join(map(str, args))), create=True):
            answer = self.raw(f"GET /api/receiver/archive/scans/{scan_id}/download HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n\r\n".encode())
        head, _, body = answer.partition(b"\r\n\r\n")
        self.assertTrue(head.startswith(b"HTTP/1.1 200"))
        _, complete = decode_chunked(body)
        self.assertFalse(complete)
        self.assertNotIn(b'"error"', body)
        self.assertNotIn(b"HTTP/1.", body)
        self.assertIn("[ground-console] receiver download aborted: OSError", printed)
        self.assertTrue(self.server.archive_export_slots.acquire(blocking=False))
        self.assertTrue(self.server.archive_export_slots.acquire(blocking=False))
        self.server.archive_export_slots.release()
        self.server.archive_export_slots.release()

    def test_a_write_timeout_frees_the_slot_and_logs_once(self) -> None:
        scan_id = self.scan(BASE, BASE + timedelta(minutes=1), traces=2)
        printed: List[str] = []
        with mock.patch.object(ra.ChunkedWriter, "write", side_effect=socket.timeout("timed out")), \
                mock.patch.object(ground_console, "print", lambda *args, **kwargs: printed.append(" ".join(map(str, args))), create=True):
            answer = self.raw(f"GET /api/receiver/archive/scans/{scan_id}/download HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n\r\n".encode())
        self.assertTrue(answer.startswith(b"HTTP/1.1 200"))
        aborted = [line for line in printed if "download aborted" in line]
        self.assertEqual(len(aborted), 1)
        self.assertIn(aborted[0], ("[ground-console] receiver download aborted: timeout",
                                   "[ground-console] receiver download aborted: TimeoutError"))
        self.assertTrue(self.server.archive_export_slots.acquire(blocking=False))
        self.assertTrue(self.server.archive_export_slots.acquire(blocking=False))
        self.server.archive_export_slots.release()
        self.server.archive_export_slots.release()

    def test_export_flow(self) -> None:
        _, audio_id = self.recording(BASE, BASE + timedelta(seconds=3), audio=b"z" * 5000)
        scan_id = self.scan(BASE + timedelta(minutes=1), BASE + timedelta(minutes=2), traces=2)
        _, failed = self.recording(BASE, BASE + timedelta(seconds=1), audio=b"", status="failed")
        body = {"items": [{"kind": "audio", "id": audio_id}, {"kind": "scan", "id": scan_id}, {"kind": "audio", "id": failed}],
                "time_zone": "UTC"}
        self.assert_archive_error(self.request("POST", "/api/receiver/archive/exports", body, origin=False), 403, "ORIGIN_REJECTED")
        created = self.request("POST", "/api/receiver/archive/exports", body)
        self.assertEqual(created.status, 201, created.body)
        prepared = created.json()
        self.assertRegex(prepared["export_id"], r"^[A-Za-z0-9_-]{32}$")
        self.assertEqual(prepared["url"], f"/api/receiver/archive/exports/{prepared['export_id']}")
        self.assertEqual((prepared["count"], prepared["missing"], prepared["expires_in_s"]), ({"audio": 1, "scan": 1}, 1, 120))
        self.assertEqual(prepared["estimated_bytes"], 5000 + 1024 + 2 * 16384 + 8192)
        self.assertRegex(prepared["filename"], r"^receiver-records_\d{8}-\d{6}\+0000\.zip$")
        download = self.request("GET", prepared["url"])
        self.assertEqual(download.status, 200)
        self.assertEqual(download.headers["Content-Disposition"], f'attachment; filename="{prepared["filename"]}"')
        archive = zipfile.ZipFile(io.BytesIO(download.body))
        manifest = json.loads(archive.read("manifest.json"))
        self.assertEqual(manifest["missing"], [{"kind": "audio", "id": failed, "reason": "not_downloadable"}])
        self.assertEqual(len(manifest["items"]), 2)
        self.assert_archive_error(self.request("GET", prepared["url"]), 404, "ARCHIVE_NOT_FOUND")

        expired = self.request("POST", "/api/receiver/archive/exports", body).json()
        self.server.archive_exports.clock = lambda: time.monotonic() + 121
        self.assert_archive_error(self.request("GET", expired["url"]), 404, "ARCHIVE_NOT_FOUND")
        self.server.archive_exports.clock = time.monotonic

        waiting = self.request("POST", "/api/receiver/archive/exports", body).json()
        slots = self.server.archive_export_slots
        self.assertTrue(slots.acquire(blocking=False) and slots.acquire(blocking=False))
        try:
            self.assert_archive_error(self.request("POST", "/api/receiver/archive/exports", body), 503, "ARCHIVE_EXPORT_BUSY")
            self.assert_archive_error(self.request("GET", waiting["url"]), 503, "ARCHIVE_EXPORT_BUSY")
            self.assert_archive_error(self.request("GET", f"/api/receiver/archive/scans/{scan_id}/download"), 503, "ARCHIVE_EXPORT_BUSY")
        finally:
            slots.release()
            slots.release()
        self.assertEqual(self.request("GET", waiting["url"]).status, 200)

    def test_export_refusals(self) -> None:
        _, audio_id = self.recording(BASE, BASE + timedelta(seconds=3), audio=b"z" * 5000)
        unknown = {"items": [{"kind": "audio", "id": "dddddddd-0000-4000-8000-000000000001"}]}
        self.assert_archive_error(self.request("POST", "/api/receiver/archive/exports", unknown), 404, "ARCHIVE_NOT_FOUND")
        with mock.patch.object(ra, "EXPORT_MAX_BYTES", 100):
            body = self.assert_archive_error(
                self.request("POST", "/api/receiver/archive/exports", {"items": [{"kind": "audio", "id": audio_id}]}),
                413, "ARCHIVE_EXPORT_TOO_LARGE",
            )
        self.assertEqual((body["estimated_bytes"], body["limit_bytes"]), (6024, 100))
        many = [{"kind": "audio", "id": f"dddddddd-0000-4000-8000-{index:012d}"} for index in range(1001)]
        body = self.assert_archive_error(self.request("POST", "/api/receiver/archive/exports", {"items": many}), 413, "ARCHIVE_TOO_MANY_ITEMS")
        self.assertEqual((body["count"], body["limit"]), (1001, 1000))
        changed = {"filter": {"type": "audio"}, "expected_count": 5}
        body = self.assert_archive_error(self.request("POST", "/api/receiver/archive/exports", changed), 409, "ARCHIVE_SELECTION_CHANGED")
        self.assertEqual(body["count"], 1)
        self.assert_archive_error(self.request("POST", "/api/receiver/archive/exports", {"filter": {"type": "audio"}, "expected_count": 1,
                                                                                        "extra": 1}),
                                  400, "ARCHIVE_INVALID_REQUEST")
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        connection.request("POST", "/api/receiver/archive/exports", body=b"{" + b" " * (256 * 1024),
                           headers={"Origin": self.origin, "Content-Type": "application/json"})
        response = connection.getresponse()
        self.assertEqual((response.status, json.loads(response.read())["code"]), (400, "ARCHIVE_INVALID_REQUEST"))
        connection.close()
        by_filter = self.request("POST", "/api/receiver/archive/exports", {"filter": {"type": "audio"}, "expected_count": 1,
                                                                            "time_zone": "Asia/Jakarta", "utc_offset_minutes": 420})
        self.assertEqual(by_filter.status, 201)
        self.assertTrue(by_filter.json()["filename"].endswith("+0700.zip"))

    def test_delete_route(self) -> None:
        _, audio_id = self.recording(BASE, BASE + timedelta(seconds=3))
        scan_id = self.scan(BASE + timedelta(minutes=1), BASE + timedelta(minutes=2), traces=1)
        body = self.assert_archive_error(
            self.request("POST", "/api/receiver/archive/delete", {"filter": {}, "expected_count": 7}), 409, "ARCHIVE_SELECTION_CHANGED",
        )
        self.assertEqual(body["count"], 2)
        many = [{"kind": "scan", "id": f"dddddddd-0000-4000-8000-{index:012d}"} for index in range(2001)]
        body = self.assert_archive_error(self.request("POST", "/api/receiver/archive/delete", {"items": many}), 413, "ARCHIVE_TOO_MANY_ITEMS")
        self.assertEqual(body["limit"], 2000)
        result = self.request("POST", "/api/receiver/archive/delete", {"filter": {}, "expected_count": 2})
        self.assertEqual(result.status, 200)
        self.assertEqual(result.json()["deleted"], {"audio": 1, "scan": 1})
        self.assertEqual(result.json()["deleted_scan_ids"], [scan_id])
        again = self.request("POST", "/api/receiver/archive/delete", {"items": [{"kind": "audio", "id": audio_id}]}).json()
        self.assertEqual((again["skipped_count"], again["skipped"][0]["code"]), (1, "ARCHIVE_NOT_FOUND"))

    def test_settings_routes(self) -> None:
        settings = self.request("GET", "/api/receiver/settings").json()
        self.assertEqual(set(settings), {"auto_spectrum_recording", "retention_days", "retention_options", "retention_last_run_ms",
                                         "retention_last_removed", "retention_running"})
        self.assertEqual(self.request("POST", "/api/receiver/settings", {"auto_spectrum_recording": True}).json()["auto_spectrum_recording"], True)
        self.assert_archive_error(self.request("POST", "/api/receiver/settings", {"retention_days": 7}), 400, "RETENTION_CONFIRM_REQUIRED")
        self.assert_archive_error(self.request("POST", "/api/receiver/settings", {"retention_days": True, "confirm": True}),
                                  400, "RETENTION_INVALID")
        refused = self.request("POST", "/api/receiver/settings", {"confirm": True})
        self.assertEqual((refused.status, set(refused.json())), (400, {"error"}))
        self.assertEqual(self.request("POST", "/api/receiver/settings", {"other": 1}).status, 400)
        old = BASE - timedelta(days=10)
        self.recording(old, old + timedelta(minutes=1))
        self.clock.set(BASE)
        saved = self.request("POST", "/api/receiver/settings", {"retention_days": 7, "confirm": True})
        self.assertEqual(saved.status, 200)
        result = saved.json()
        self.assertEqual(result["retention_days"], 7)
        self.assertEqual(result["retention_result"]["audio"], 1)
        self.assertEqual(result["retention_result"]["sessions"], 1)
        self.assertNotIn("retention_result", self.request("POST", "/api/receiver/settings", {"retention_days": 7}).json())
        off = self.request("POST", "/api/receiver/settings", {"retention_days": None}).json()
        self.assertEqual((off["retention_days"], "retention_result" in off), (None, False))

    def test_settings_post_while_a_pass_runs(self) -> None:
        self.store._retention_mutex.acquire()
        woken: List[int] = []
        try:
            with mock.patch.object(self.server, "wake_retention", lambda: woken.append(1)):
                result = self.request("POST", "/api/receiver/settings", {"retention_days": 30, "confirm": True}).json()
        finally:
            self.store._retention_mutex.release()
        self.assertEqual((result["retention_days"], result["retention_running"], "retention_result" in result), (30, True, False))
        self.assertEqual(woken, [1])

    def test_playback_route_keeps_ranges(self) -> None:
        audio = b"0123456789" * 100
        _, segment_id = self.recording(BASE, BASE + timedelta(seconds=1), audio=audio)
        result = self.request("GET", f"/api/receiver/audio-segments/{segment_id}/audio", headers={"Range": "bytes=10-19"})
        self.assertEqual((result.status, result.body), (206, audio[10:20]))


if __name__ == "__main__":
    unittest.main()
