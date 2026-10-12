import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

TOOLS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS_DIR))

import receiver_record_store
from receiver_record_store import ReceiverConflictError, ReceiverRecordStore


class ReceiverRecordStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = ReceiverRecordStore(self.temp.name)

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def test_settings_candidate_upsert_and_sql_pagination(self):
        self.assertEqual(self.store.get_settings(), {"auto_spectrum_recording": False})
        self.assertEqual(self.store.update_settings({"auto_spectrum_recording": True}), {"auto_spectrum_recording": True})
        scan = self.store.create_scan("receiver", {"start_hz": 100, "end_hz": 500}, False)
        candidates = [
            {"id": 1, "meanPeakFrequencyHz": 120, "minPeakFrequencyHz": 110, "maxPeakFrequencyHz": 130, "maxPeakDb": -50, "hits": 2},
            {"id": 2, "meanPeakFrequencyHz": 300, "minPeakFrequencyHz": 280, "maxPeakFrequencyHz": 320, "maxPeakDb": -20, "hits": 5},
        ]
        self.assertEqual(self.store.upsert_candidates(scan["id"], candidates), 2)
        candidates[0]["hits"] = 3
        self.store.upsert_candidates(scan["id"], [candidates[0]])
        result = self.store.get_candidates(scan["id"], offset=0, limit=1, sort="peak", minimum_peak_db=-40)
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["items"][0]["id"], 2)
        self.assertEqual(self.store.get_candidates(scan["id"], sort="hits")["items"][0]["hits"], 5)

    def test_candidate_history_paginates_beyond_one_thousand_rows(self):
        scan = self.store.create_scan("receiver", {}, True)
        candidates = [
            {"id": index, "meanPeakFrequencyHz": float(index), "peakDb": -80.0}
            for index in range(1, 1_106)
        ]
        self.assertEqual(self.store.upsert_candidates(scan["id"], candidates), 1_105)

        page = self.store.get_candidates(scan["id"], offset=1_000, limit=250)
        self.assertEqual(page["total"], 1_105)
        self.assertEqual(len(page["items"]), 105)
        self.assertEqual(page["items"][-1]["id"], 1_105)

    def test_peak_groups_merge_overlapping_bands_only(self):
        scan = self.store.create_scan("receiver", {}, True)

        def band(index, low, high, peak, peak_db):
            return {
                "id": index, "startHz": low, "endHz": high, "centerHz": (low + high) / 2,
                "peakFrequencyHz": peak, "meanPeakFrequencyHz": peak + (500 if index == 2 else 0),
                "minPeakFrequencyHz": peak, "maxPeakFrequencyHz": peak, "bandwidthHz": high - low,
                "peakDb": peak_db, "noiseFloorDb": -90, "snrDb": peak_db + 90,
                "firstSeen": 1, "lastSeen": 2, "hits": 2,
            }

        self.store.upsert_candidates(scan["id"], [
            band(1, 410_000_000, 410_030_000, 410_010_000, -40),
            band(2, 410_020_000, 410_050_000, 410_040_000, -30),
            # 10 kHz gap: a separate signal even though its peak is only 30 kHz away.
            band(3, 410_060_000, 410_080_000, 410_070_000, -25),
            band(4, 410_080_000, 410_090_000, 410_085_000, -45),
            band(5, 410_500_000, 410_520_000, 410_510_000, -20),
        ])

        first_page = self.store.get_candidates(scan["id"], offset=0, limit=1, group_adjacent=True)
        rows = self.store.get_candidates(scan["id"], limit=10, group_adjacent=True)["items"]

        self.assertEqual(first_page["total"], 3)
        self.assertEqual(len(first_page["items"]), 1)
        self.assertEqual([row["id"] for row in rows], [1, 3, 5])
        first_band = rows[0]
        self.assertEqual(first_band["peakRangeStartHz"], 410_010_000)
        self.assertEqual(first_band["peakRangeEndHz"], 410_040_000)
        self.assertEqual(first_band["peakRangeCenterHz"], 410_025_000)
        self.assertEqual(first_band["peakFrequencyHz"], 410_040_000)
        self.assertEqual(first_band["meanPeakFrequencyHz"], 410_040_500)
        self.assertEqual(first_band["peakDb"], -30)
        # Touching bands (high == next low) stay together.
        self.assertEqual((rows[1]["peakRangeStartHz"], rows[1]["peakRangeEndHz"]), (410_070_000, 410_085_000))
        self.assertEqual(rows[2]["peakRangeStartHz"], 410_510_000)

    def test_dense_noise_candidates_do_not_chain_distinct_carriers(self):
        scan = self.store.create_scan("receiver", {}, True)
        candidates = []
        frequency, index = 121_000_000, 1
        while frequency <= 128_000_000:
            peak_db = -20 if frequency in (121_000_000, 125_000_000, 128_000_000) else -45
            candidates.append({
                "id": index, "startHz": frequency - 2_500, "endHz": frequency + 2_500,
                "peakFrequencyHz": frequency, "meanPeakFrequencyHz": frequency, "peakDb": peak_db, "snrDb": 10,
            })
            frequency += 20_000
            index += 1
        self.store.upsert_candidates(scan["id"], candidates)
        page = self.store.get_candidates(scan["id"], limit=250, minimum_peak_db=-30, group_adjacent=True)
        self.assertEqual([row["peakFrequencyHz"] for row in page["items"]], [121_000_000, 125_000_000, 128_000_000])
        everything = self.store.get_candidates(scan["id"], limit=1, group_adjacent=True)
        self.assertEqual(everything["total"], len(candidates))

    def test_legacy_candidates_backfill_peak_frequency_for_grouping(self):
        with tempfile.TemporaryDirectory() as legacy_dir:
            scan_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            candidates = [
                {
                    "id": 1, "startHz": 409_991_000, "endHz": 410_095_000, "centerHz": 410_001_000,
                    "peakFrequencyHz": 410_001_000, "meanPeakFrequencyHz": 410_001_000,
                    "minPeakFrequencyHz": 410_001_000, "maxPeakFrequencyHz": 410_001_000,
                    "bandwidthHz": 20_000, "peakDb": -40, "snrDb": 50, "hits": 1,
                },
                {
                    "id": 2, "startHz": 410_090_000, "endHz": 410_110_000, "centerHz": 410_100_000,
                    "peakFrequencyHz": 410_100_000, "meanPeakFrequencyHz": 410_100_000,
                    "minPeakFrequencyHz": 410_100_000, "maxPeakFrequencyHz": 410_100_000,
                    "bandwidthHz": 20_000, "peakDb": -30, "snrDb": 60, "hits": 1,
                },
            ]
            with closing(sqlite3.connect(Path(legacy_dir) / "receiver.sqlite3")) as db, db:
                db.executescript("""
                    CREATE TABLE scans (
                        id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
                        metadata TEXT NOT NULL DEFAULT '{}'
                    );
                    CREATE TABLE candidates (
                        scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
                        candidate_id TEXT NOT NULL, payload TEXT NOT NULL,
                        frequency REAL NOT NULL DEFAULT 0, low_hz REAL NOT NULL DEFAULT 0,
                        high_hz REAL NOT NULL DEFAULT 0, peak REAL NOT NULL DEFAULT 0,
                        snr REAL NOT NULL DEFAULT 0, hits INTEGER NOT NULL DEFAULT 0,
                        last_seen REAL NOT NULL DEFAULT 0, PRIMARY KEY(scan_id,candidate_id)
                    );
                """)
                db.execute("INSERT INTO scans(id,started_at,metadata) VALUES(?,?,?)", (scan_id, "2026-01-01", "{}"))
                db.executemany(
                    "INSERT INTO candidates(scan_id,candidate_id,payload,frequency,low_hz,high_hz,peak,snr,hits,last_seen) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?)",
                    [
                        (
                            scan_id, str(candidate["id"]), json.dumps(candidate),
                            candidate["meanPeakFrequencyHz"], candidate["startHz"], candidate["endHz"],
                            candidate["peakDb"], candidate["snrDb"], candidate["hits"], 1,
                        )
                        for candidate in candidates
                    ],
                )

            legacy_store = ReceiverRecordStore(legacy_dir)
            try:
                page = legacy_store.get_candidates(scan_id, group_adjacent=True)
            finally:
                legacy_store.close()

        self.assertEqual(page["total"], 1)
        self.assertEqual(page["items"][0]["peakRangeStartHz"], 410_001_000)
        self.assertEqual(page["items"][0]["peakRangeEndHz"], 410_100_000)
        self.assertEqual(page["items"][0]["peakRangeCenterHz"], 410_050_500)

    def test_archive_trace_round_trip_and_scan_record_deletion(self):
        scan = self.store.create_scan("receiver", {"start_hz": 10, "end_hz": 20}, True)
        trace = bytes((i % 256 for i in range(2048)))
        self.assertIsNotNone(self.store.add_trace(scan["id"], 7, trace))
        self.assertEqual(self.store.get_trace(scan["id"], 7), trace)
        self.assertEqual(self.store.list_traces(scan["id"], order="desc")["items"][0]["sweep"], 7)
        self.store.finish_scan(scan["id"], "complete")
        record = self.store.list_records()["items"][0]
        self.assertEqual(record["type"], "scan")
        self.assertEqual(record["id"], scan["id"])
        self.assertEqual(record["trace_count"], 1)
        self.assertTrue(self.store.delete_record(record["id"]))
        self.assertEqual(self.store.list_records()["total"], 0)
        with self.assertRaises(KeyError):
            self.store.scan_info(scan["id"])

    def test_record_types_have_independent_counts_and_pagination(self):
        for source in ("receiver-a", "receiver-b"):
            scan = self.store.create_scan(source, {}, True)
            self.store.finish_scan(scan["id"], "complete")
        for _ in range(2):
            session = self.store.create_audio_session()
            self.store.finish_audio_session(session["id"])

        first_scan_page = self.store.list_records(offset=0, limit=1, record_type="scan")
        second_scan_page = self.store.list_records(offset=1, limit=1, record_type="scan")
        self.assertEqual(first_scan_page["total"], 2)
        self.assertEqual(second_scan_page["total"], 2)
        self.assertEqual(len(first_scan_page["items"]), 1)
        self.assertEqual(len(second_scan_page["items"]), 1)
        self.assertNotEqual(first_scan_page["items"][0]["id"], second_scan_page["items"][0]["id"])
        self.assertEqual(first_scan_page["items"][0]["type"], "scan")

        audio_page = self.store.list_records(offset=0, limit=1, record_type="audio-session")
        next_audio_page = self.store.list_records(offset=1, limit=1, record_type="audio-session")
        self.assertEqual(audio_page["total"], 2)
        self.assertEqual(next_audio_page["total"], 2)
        self.assertEqual(audio_page["items"][0]["type"], "audio-session")
        self.assertNotEqual(audio_page["items"][0]["id"], next_audio_page["items"][0]["id"])
        self.assertEqual(self.store.list_records(limit=10)["total"], 4)
        with self.assertRaises(ValueError):
            self.store.list_records(record_type="unknown")

    def test_new_scan_prunes_unarchived_rows_but_preserves_archives(self):
        temporary = self.store.create_scan("live", {}, False)
        self.store.upsert_candidates(temporary["id"], [{"id": 1, "startHz": 10, "endHz": 20}])
        archived = self.store.create_scan("archive", {}, True)
        replacement = self.store.create_scan("live", {}, False)
        with self.assertRaises(KeyError):
            self.store.scan_info(temporary["id"])
        self.assertEqual(self.store.scan_info(archived["id"])["id"], archived["id"])
        self.assertEqual(self.store.scan_info(replacement["id"])["id"], replacement["id"])

    def test_marker_set_named_upsert_and_candidate_proximity_filter(self):
        scan = self.store.create_scan("receiver", {}, True)
        self.store.upsert_candidates(scan["id"], [
            {"id": 1, "meanPeakFrequencyHz": 1_000_000, "minPeakFrequencyHz": 990_000, "maxPeakFrequencyHz": 1_010_000},
            {"id": 2, "meanPeakFrequencyHz": 2_000_000, "minPeakFrequencyHz": 1_990_000, "maxPeakFrequencyHz": 2_010_000},
        ])
        marker = self.store.save_markers({"name": "Field", "markers": [{"frequency_hz": 1_040_000, "power_db": -30, "label": "A"}]})
        with self.assertRaises(ReceiverConflictError):
            self.store.save_markers({"name": "Field", "markers": []})
        self.assertEqual(len(self.store.get_markers()[0]["markers"]), 1)
        updated = self.store.save_markers({"name": "Field", "overwrite": True, "markers": [{"frequency_hz": 1_040_000, "power_db": -25}]})
        self.assertEqual(marker["id"], updated["id"])
        self.assertEqual(self.store.get_markers(), [updated])
        marked = self.store.get_candidates(scan["id"], marked_only=True, marker_set_id=marker["id"])
        self.assertEqual([item["id"] for item in marked["items"]], [1])
        active_unsaved = self.store.get_candidates(scan["id"], marked_only=True, marker_frequencies=[1_040_000])
        self.assertEqual([item["id"] for item in active_unsaved["items"]], [1])
        self.assertEqual(self.store.get_candidates(scan["id"], marked_only=True)["total"], 0)
        self.assertEqual(self.store.get_candidates(scan["id"], limit=250)["limit"], 250)
        with self.assertRaises(ValueError):
            self.store.get_candidates(scan["id"], minimum_peak_db=float("nan"))
        self.assertTrue(self.store.delete_markers(marker["id"]))
        self.assertEqual(self.store.get_markers(), [])

    def test_manual_markers_allow_unmeasured_power_and_reject_invalid_frequencies(self):
        manual = self.store.save_markers({
            "name": "Manual",
            "markers": [{"frequency_hz": 915_000_000, "power_db": None, "label": "field note"}],
        })
        self.assertIsNone(manual["markers"][0]["power_db"])
        self.assertEqual(self.store.get_markers(), [manual])

        for frequency in (0, -1, float("nan"), float("inf"), True, 10**400):
            with self.subTest(frequency=frequency):
                with self.assertRaises(ValueError):
                    self.store.save_markers({"name": "Invalid frequency", "markers": [
                        {"frequency_hz": frequency, "power_db": None},
                    ]})

        for power in (float("nan"), float("inf"), True, 10**400):
            with self.subTest(power=power):
                with self.assertRaises(ValueError):
                    self.store.save_markers({"name": "Invalid power", "markers": [
                        {"frequency_hz": 1, "power_db": power},
                    ]})

    def test_audio_segments_finalize_independently_and_cleanup_with_session(self):
        session = self.store.create_audio_session()
        segment_one = self.store.create_audio_segment(session["id"], {
            "vfo_index": 0, "frequency_hz": 144_000_000, "mode": "NFM", "bandwidth_hz": 12_500,
            "codec": "audio/webm;codecs=opus", "started_at": "2025-01-01T00:00:00Z",
        })
        segment_two = self.store.create_audio_segment(session["id"], {
            "vfo_index": 1, "frequency_hz": 145_000_000, "mode": "WFM", "bandwidth_hz": 150_000,
            "codec": "audio/webm;codecs=opus", "started_at": "2025-01-01T00:00:03Z",
        })
        self.store.append_segment_audio(segment_one["id"], b"first webm stream")
        self.store.append_segment_audio(segment_two["id"], b"second webm stream")
        with self.assertRaises(ValueError):
            self.store.finish_audio_session(session["id"])
        self.store.finish_segment(segment_one["id"], {"ended_at": "2025-01-01T00:00:02Z", "duration_seconds": 2})
        self.store.finish_segment(segment_two["id"], {"ended_at": "2025-01-01T00:00:05Z", "duration_seconds": 2})
        self.store.finish_audio_session(session["id"])
        path_one, _ = self.store.get_segment_audio(segment_one["id"])
        path_two, _ = self.store.get_segment_audio(segment_two["id"])
        self.assertNotEqual(path_one, path_two)
        self.assertEqual(path_one.read_bytes(), b"first webm stream")
        self.assertEqual(path_two.read_bytes(), b"second webm stream")
        record = self.store.list_records()["items"][0]
        self.assertEqual(record["type"], "audio-session")
        self.assertEqual([segment["bytes"] for segment in record["segments"]], [len(b"first webm stream"), len(b"second webm stream")])
        self.assertTrue(self.store.delete_record(session["id"]))
        self.assertFalse(path_one.exists())
        self.assertFalse(path_two.exists())
        self.assertEqual(self.store.list_records()["total"], 0)
        for segment in (segment_one, segment_two):
            with self.assertRaises(KeyError):
                self.store.get_segment_audio(segment["id"])

    def test_completed_audio_segment_is_immutable_after_failed_finalize_retry(self):
        session = self.store.create_audio_session()
        segment = self.store.create_audio_segment(session["id"], {
            "vfo_index": 0,
            "frequency_hz": 144_000_000,
            "mode": "NFM",
            "bandwidth_hz": 12_500,
            "codec": "audio/webm;codecs=opus",
            "started_at": "2026-09-29T00:00:00Z",
        })
        audio = b"completed WebM stream"
        self.store.append_segment_audio(segment["id"], audio)
        completed = self.store.finish_segment(segment["id"], {
            "ended_at": "2026-09-29T00:00:02Z",
            "duration_seconds": 2,
            "status": "complete",
        })
        retry = self.store.finish_segment(segment["id"], {
            "ended_at": "2026-09-29T00:00:03Z",
            "duration_seconds": 3,
            "status": "failed",
            "error": "first response was lost",
        })
        self.assertEqual(completed["status"], "complete")
        self.assertEqual(retry, completed)
        self.store.finish_audio_session(session["id"])
        path, mime_type = self.store.get_segment_audio(segment["id"])
        self.assertEqual(mime_type, "audio/webm")
        self.assertEqual(path.read_bytes(), audio)
        record = self.store.list_records()["items"][0]
        finalized = record["segments"][0]
        self.assertEqual(finalized["status"], "complete")
        self.assertEqual(finalized["ended_at"], "2026-09-29T00:00:02Z")
        self.assertEqual(finalized["duration_seconds"], 2)

    def test_invalid_ids_and_payload_bounds_are_rejected(self):
        with self.assertRaises(ValueError):
            self.store.get_candidates("../not-a-uuid")
        scan = self.store.create_scan("receiver", {}, True)
        with self.assertRaises(ValueError):
            self.store.add_trace(scan["id"], 0, b"short")
        session = self.store.create_audio_session()
        segment = self.store.create_audio_segment(session["id"], {
            "vfo_index": 0, "frequency_hz": 1, "mode": "NFM", "bandwidth_hz": 1,
            "codec": "webm", "started_at": "2026-09-29T00:00:00Z",
        })
        with self.assertRaises(ValueError):
            self.store.append_segment_audio(segment["id"], b"x" * (1024 * 1024 + 1))
        with self.assertRaises(ValueError):
            self.store.get_candidates(scan["id"], limit=0)

    def test_failed_audio_segment_is_visible_and_not_playable(self):
        session = self.store.create_audio_session()
        segment = self.store.create_audio_segment(session["id"], {
            "vfo_index": 0, "frequency_hz": 144_000_000, "mode": "NFM", "bandwidth_hz": 12_500,
            "codec": "audio/webm;codecs=opus", "started_at": "2026-09-29T00:00:00Z",
        })
        self.store.finish_segment(segment["id"], {
            "ended_at": "2026-09-29T00:00:00Z", "duration_seconds": 0, "status": "failed", "error": "MediaRecorder start failed",
        })
        self.store.finish_audio_session(session["id"])
        record = self.store.list_records()["items"][0]
        self.assertEqual(record["segments"][0]["status"], "failed")
        self.assertEqual(record["segments"][0]["error"], "MediaRecorder start failed")
        with self.assertRaises(KeyError):
            self.store.get_segment_audio(segment["id"])


AUDIO_METADATA = {
    "vfo_index": 0, "frequency_hz": 144_000_000, "mode": "nfm", "bandwidth_hz": 12_500,
    "codec": "audio/webm;codecs=opus", "started_at": "2026-09-29T00:00:00Z",
}


def _ebml(element_id, payload, unknown_size=False):
    identifier = element_id.to_bytes((element_id.bit_length() + 7) // 8, "big")
    size = b"\x01\xff\xff\xff\xff\xff\xff\xff" if unknown_size else (0x10000000 | len(payload)).to_bytes(4, "big")
    return identifier + size + payload


def synthetic_webm(clusters):
    """A MediaRecorder-shaped WebM: unknown-size Segment and Clusters, no Duration or Cues."""
    header = _ebml(0x1A45DFA3, _ebml(0x4282, b"webm"))
    info = _ebml(0x1549A966, _ebml(0x2AD7B1, (1_000_000).to_bytes(3, "big")) + _ebml(0x4D80, b"Chrome") + _ebml(0x5741, b"Chrome"))
    tracks = _ebml(0x1654AE6B, _ebml(0xAE, _ebml(0xD7, b"\x01") + _ebml(0x86, b"A_OPUS")))
    body = b""
    for cluster_timecode, relatives in clusters:
        blocks = _ebml(0xE7, cluster_timecode.to_bytes(4, "big"))
        for relative in relatives:
            blocks += _ebml(0xA3, b"\x81" + relative.to_bytes(2, "big", signed=True) + b"\x80" + b"\x1f\x43\xb6\x75opus")
        body += _ebml(0x1F43B675, blocks, unknown_size=True)
    return header + _ebml(0x18538067, info + tracks + body, unknown_size=True)


def webm_duration_seconds(data):
    layout = receiver_record_store._webm_info_layout(data)
    if layout["duration_pos"] is None:
        return None
    import struct
    raw = data[layout["duration_pos"]:layout["duration_pos"] + layout["duration_length"]]
    value = struct.unpack(">d" if len(raw) == 8 else ">f", raw)[0]
    return value * layout["timecode_scale"] / 1e9


class ReceiverRecoveryAndAudioTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temp.name)
        self.store = ReceiverRecordStore(self.data_dir)

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def _age(self, table, ident, seconds):
        stamp = (datetime.now(timezone.utc) - timedelta(seconds=seconds)).isoformat()
        with closing(sqlite3.connect(self.data_dir / "receiver.sqlite3")) as db, db:
            db.execute(f"UPDATE {table} SET last_activity=?,started_at=? WHERE id=?", (stamp, stamp, ident))

    def _age_file(self, path, seconds):
        stamp = time.time() - seconds
        os.utime(path, (stamp, stamp))

    def test_abandoned_recording_is_recovered_as_interrupted_and_playable(self):
        session = self.store.create_audio_session()
        segment = self.store.create_audio_segment(session["id"], dict(AUDIO_METADATA, started_at=(datetime.now(timezone.utc) - timedelta(seconds=600)).isoformat()))
        audio = synthetic_webm([(0, [0, 20, 40]), (1000, [0, 980])])
        self.store.append_segment_audio(segment["id"], audio)
        listed = self.store.list_records(record_type="audio-session")["items"][0]
        self.assertIsNone(listed["completed_at"])
        self.assertEqual(listed["segments"][0]["status"], "recording")
        self.assertIsNone(listed["segments"][0]["ended_at"])

        # Still active: nothing is recovered.
        self.assertEqual(self.store.recover_interrupted_recordings()["audio_sessions"], 0)
        self._age("audio_sessions", session["id"], 600)
        self._age_file(self.data_dir / "tmp" / f"{segment['id']}.part", 590)
        recovered = self.store.recover_interrupted_recordings()
        self.assertEqual(recovered, {"audio_sessions": 1, "audio_segments": 1, "scans": 0})

        record = self.store.list_records(record_type="audio-session")["items"][0]
        self.assertIsNotNone(record["completed_at"])
        saved = record["segments"][0]
        self.assertEqual(saved["status"], "interrupted")
        self.assertIn("interrupted", saved["error"])
        self.assertAlmostEqual(saved["duration_seconds"], 1.98 + 0.02, places=3)
        path, _ = self.store.get_segment_audio(segment["id"])
        self.assertEqual(saved["bytes"], path.stat().st_size)
        self.assertAlmostEqual(webm_duration_seconds(path.read_bytes()), 2.0, places=3)
        self.assertFalse((self.data_dir / "tmp" / f"{segment['id']}.part").exists())

    def test_store_restart_recovers_stale_sessions_and_scans(self):
        session = self.store.create_audio_session()
        empty = self.store.create_audio_segment(session["id"], AUDIO_METADATA)
        scan = self.store.create_scan("simulated", {"startHz": 1, "endHz": 2}, True)
        self.store.add_trace(scan["id"], 1, bytes(2048))
        live_scan = self.store.create_scan("simulated", {"startHz": 1, "endHz": 2}, True)
        self._age("audio_sessions", session["id"], 900)
        self._age_file(self.data_dir / "tmp" / f"{empty['id']}.part", 900)
        self._age("scans", scan["id"], 900)
        self.store.close()

        restarted = ReceiverRecordStore(self.data_dir)
        records = restarted.list_records(limit=10)
        scans = [item for item in records["items"] if item["type"] == "scan"]
        self.assertEqual([item["id"] for item in scans], [scan["id"]])
        self.assertEqual(scans[0]["status"], "interrupted")
        self.assertEqual(scans[0]["trace_count"], 1)
        audio = next(item for item in records["items"] if item["type"] == "audio-session")
        self.assertEqual(audio["segments"][0]["status"], "failed")
        self.assertEqual(audio["segments"][0]["bytes"], 0)
        self.assertFalse((self.data_dir / "tmp" / f"{empty['id']}.part").exists())
        self.assertEqual(restarted.scan_info(live_scan["id"])["status"], "running")
        # A late finish from a browser that was only slow still wins.
        restarted.finish_scan(scan["id"], "stopped", trace_upload_failures=2)
        finished = restarted.list_records(record_type="scan")["items"][0]
        self.assertEqual(finished["status"], "stopped")
        self.assertEqual(finished["trace_upload_failures"], 2)
        restarted.close()

    def test_unfinished_scan_without_record_can_be_deleted(self):
        scan = self.store.create_scan("simulated", {}, True)
        self.assertTrue(self.store.delete_record(scan["id"]))
        with self.assertRaises(KeyError):
            self.store.scan_info(scan["id"])

    def test_page_unload_finalizes_open_segments_in_one_request(self):
        session = self.store.create_audio_session()
        segment = self.store.create_audio_segment(session["id"], AUDIO_METADATA)
        self.store.append_segment_audio(segment["id"], synthetic_webm([(0, [0, 20])]))
        with self.assertRaises(ValueError):
            self.store.finish_audio_session(session["id"])
        self.store.finish_audio_session(session["id"], finalize_open_segments=True)
        record = self.store.list_records(record_type="audio-session")["items"][0]
        self.assertIsNotNone(record["completed_at"])
        self.assertEqual(record["segments"][0]["status"], "interrupted")
        self.store.get_segment_audio(segment["id"])

    def test_failed_upload_keeps_saved_audio_as_partial_segment(self):
        session = self.store.create_audio_session()
        segment = self.store.create_audio_segment(session["id"], AUDIO_METADATA)
        audio = synthetic_webm([(0, [0, 20, 40])])
        self.store.append_segment_audio(segment["id"], audio)
        result = self.store.finish_segment(segment["id"], {
            "ended_at": "2026-09-29T00:00:05Z", "duration_seconds": 5, "status": "failed", "error": "chunk 6 upload failed",
        })
        self.assertEqual(result["status"], "partial")
        self.store.finish_audio_session(session["id"])
        saved = self.store.list_records()["items"][0]["segments"][0]
        self.assertEqual(saved["status"], "partial")
        self.assertEqual(saved["error"], "chunk 6 upload failed")
        path, _ = self.store.get_segment_audio(segment["id"])
        self.assertEqual(saved["bytes"], path.stat().st_size)
        self.assertGreater(saved["bytes"], len(audio))
        self.assertAlmostEqual(webm_duration_seconds(path.read_bytes()), 0.06, places=3)

    def test_completed_webm_gets_duration_and_keeps_its_stream(self):
        session = self.store.create_audio_session()
        segment = self.store.create_audio_segment(session["id"], AUDIO_METADATA)
        audio = synthetic_webm([(0, [0, 20]), (5000, [0, 1000, 2500])])
        half = len(audio) // 2
        self.store.append_segment_audio(segment["id"], audio[:half])
        self.store.append_segment_audio(segment["id"], audio[half:])
        result = self.store.finish_segment(segment["id"], {"ended_at": "2026-09-29T00:00:09Z", "duration_seconds": 9})
        self.assertAlmostEqual(result["duration_seconds"], 7.52, places=3)
        path, _ = self.store.get_segment_audio(segment["id"])
        rewritten = path.read_bytes()
        self.assertAlmostEqual(webm_duration_seconds(rewritten), 7.52, places=3)
        layout = receiver_record_store._webm_info_layout(audio)
        self.assertEqual(rewritten[-(len(audio) - layout["info_end"]):], audio[layout["info_end"]:])
        self.assertEqual(len(rewritten), len(audio) + 11)

    def test_unparseable_audio_is_kept_unchanged(self):
        session = self.store.create_audio_session()
        segment = self.store.create_audio_segment(session["id"], AUDIO_METADATA)
        self.store.append_segment_audio(segment["id"], b"not a webm file")
        result = self.store.finish_segment(segment["id"], {"ended_at": "2026-09-29T00:00:02Z", "duration_seconds": 2})
        self.assertEqual(result["duration_seconds"], 2)
        path, _ = self.store.get_segment_audio(segment["id"])
        self.assertEqual(path.read_bytes(), b"not a webm file")

    def test_append_reports_limits_for_client_rollover(self):
        session = self.store.create_audio_session()
        segment = self.store.create_audio_segment(session["id"], AUDIO_METADATA)
        result = self.store.append_segment_audio(segment["id"], b"abc")
        self.assertEqual(result["segment_bytes"], 3)
        self.assertEqual(result["max_segment_bytes"], receiver_record_store.MAX_AUDIO_SEGMENT_BYTES)
        self.assertEqual(result["max_session_bytes"], receiver_record_store.MAX_AUDIO_SESSION_BYTES)

    def test_delete_keeps_rows_when_file_removal_fails(self):
        session = self.store.create_audio_session()
        segment = self.store.create_audio_segment(session["id"], AUDIO_METADATA)
        self.store.append_segment_audio(segment["id"], b"audio")
        self.store.finish_segment(segment["id"], {"ended_at": "2026-09-29T00:00:01Z", "duration_seconds": 1})
        self.store.finish_audio_session(session["id"])
        original_unlink = Path.unlink

        def failing_unlink(path, *args, **kwargs):
            if path.suffix == ".webm":
                raise PermissionError(13, "file is in use")
            return original_unlink(path, *args, **kwargs)

        with mock.patch.object(Path, "unlink", failing_unlink):
            with self.assertRaisesRegex(OSError, "record was kept"):
                self.store.delete_audio_segment(segment["id"])
            with self.assertRaisesRegex(OSError, "record was kept"):
                self.store.delete_record(session["id"])
        self.assertEqual(len(self.store.list_records()["items"][0]["segments"]), 1)
        self.store.get_segment_audio(segment["id"])
        self.assertTrue(self.store.delete_record(session["id"]))
        self.assertEqual(list((self.data_dir / "audio").iterdir()), [])

    def test_active_session_cannot_be_deleted(self):
        session = self.store.create_audio_session()
        with self.assertRaisesRegex(ValueError, "stop the VFO audio recording"):
            self.store.delete_record(session["id"])

    def test_restart_removes_audio_files_without_rows(self):
        orphan_webm = self.data_dir / "audio" / "11111111-1111-4111-8111-111111111111.webm"
        orphan_part = self.data_dir / "tmp" / "22222222-2222-4222-8222-222222222222.part"
        unrelated = self.data_dir / "audio" / "notes.txt"
        for path in (orphan_webm, orphan_part, unrelated):
            path.write_bytes(b"x")
        session = self.store.create_audio_session()
        live = self.store.create_audio_segment(session["id"], AUDIO_METADATA)
        self.store.close()
        ReceiverRecordStore(self.data_dir).close()
        self.assertFalse(orphan_webm.exists())
        self.assertFalse(orphan_part.exists())
        self.assertTrue(unrelated.exists())
        self.assertTrue((self.data_dir / "tmp" / f"{live['id']}.part").exists())

    def test_minimum_peak_filter_accepts_the_fft_scale(self):
        scan = self.store.create_scan("receiver", {}, True)
        self.store.upsert_candidates(scan["id"], [
            {"id": 1, "startHz": 1, "endHz": 2, "peakDb": -35},
            {"id": 2, "startHz": 10, "endHz": 20, "peakDb": 17},
        ])
        self.assertEqual([row["id"] for row in self.store.get_candidates(scan["id"], minimum_peak_db=10)["items"]], [2])
        for invalid in (61, -161, True, "nan"):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    self.store.get_candidates(scan["id"], minimum_peak_db=invalid)

    def test_renaming_marker_set_to_taken_name_is_a_conflict(self):
        first = self.store.save_markers({"name": "Alpha", "markers": []})
        second = self.store.save_markers({"name": "Beta", "markers": []})
        with self.assertRaises(ReceiverConflictError):
            self.store.save_markers({"id": second["id"], "name": "Alpha", "markers": []})
        self.assertEqual(self.store.save_markers({"id": first["id"], "name": "Alpha", "markers": []})["id"], first["id"])


class ReceiverAudioFilterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = ReceiverRecordStore(self.temp.name)
        session = self.store.create_audio_session()
        self.segments = {}
        for name, started, ended in (
            ("evening", "2026-09-29T14:55:00Z", "2026-09-29T16:30:00Z"),  # 21:55-23:30 WIB
            ("night", "2026-09-29T17:30:00Z", "2026-09-29T17:40:00Z"),    # 00:30-00:40 WIB next day
            ("morning", "2026-09-30T01:00:00Z", "2026-09-30T01:05:00Z"),  # 08:00-08:05 WIB
        ):
            segment = self.store.create_audio_segment(session["id"], dict(AUDIO_METADATA, started_at=started))
            self.store.append_segment_audio(segment["id"], b"audio")
            self.store.finish_segment(segment["id"], {"ended_at": ended, "duration_seconds": 60})
            self.segments[segment["id"]] = name
        self.store.finish_audio_session(session["id"])

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def names(self, **filters):
        page = self.store.list_audio_records(filters=filters)
        return sorted(self.segments[segment["id"]] for item in page["items"] for segment in item["segments"])

    def test_time_of_day_matches_segments_that_overlap_the_window(self):
        self.assertEqual(self.names(time_zone="Asia/Jakarta", time_from="22:00", time_to="23:00"), ["evening"])

    def test_time_window_wraps_past_midnight(self):
        self.assertEqual(self.names(time_zone="Asia/Jakarta", time_from="23:00", time_to="01:00"), ["evening", "night"])
        self.assertEqual(self.names(time_zone="Asia/Jakarta", time_from="23:45", time_to="00:10"), [])

    def test_date_bounds_use_overlap(self):
        self.assertEqual(
            self.names(started_after="2026-09-29T16:00:00Z", started_before="2026-09-29T17:00:00Z"),
            ["evening"],
        )

    def test_facet_dates_cover_every_recorded_day(self):
        facets = self.store.audio_record_facets("Asia/Jakarta")
        self.assertEqual(facets["available_dates"], ["2026-09-29", "2026-09-30"])
        self.assertFalse(facets["time_zone_fallback"])

    def test_legacy_and_unknown_zones_fall_back_instead_of_failing(self):
        legacy = self.store.audio_record_facets("Asia/Calcutta")
        self.assertFalse(legacy["time_zone_fallback"])
        self.assertEqual(self.names(time_zone="Asia/Saigon", time_from="21:00", time_to="23:59"), ["evening"])
        unknown = self.store.audio_record_facets("Mars/Olympus_Mons", utc_offset_minutes="420")
        self.assertTrue(unknown["time_zone_fallback"])
        self.assertEqual(unknown["available_dates"], ["2026-09-29", "2026-09-30"])
        with self.assertRaises(ValueError):
            self.store.audio_record_facets("Mars/Olympus_Mons")
        with self.assertRaises(ValueError):
            self.store.audio_record_facets("../etc/passwd", utc_offset_minutes=0)
        with self.assertRaises(ValueError):
            self.store.audio_record_facets("Asia/Jakarta", utc_offset_minutes=5000)

    def test_missing_tz_database_uses_browser_offset(self):
        with mock.patch.object(receiver_record_store, "ZoneInfo", side_effect=receiver_record_store.ZoneInfoNotFoundError("no tzdata")), \
                mock.patch.object(receiver_record_store, "_TZ_DATABASE_AVAILABLE", False):
            facets = self.store.audio_record_facets("Asia/Jakarta", utc_offset_minutes=420)
            self.assertTrue(facets["time_zone_fallback"])
            self.assertEqual(facets["available_dates"], ["2026-09-29", "2026-09-30"])
            self.assertFalse(self.store.audio_record_facets("UTC")["time_zone_fallback"])
            self.assertTrue(self.store.audio_record_facets("Asia/Jakarta")["time_zone_fallback"])
            self.assertEqual(
                self.names(time_zone="Asia/Jakarta", utc_offset_minutes="420", time_from="22:00", time_to="23:00"),
                ["evening"],
            )


class ReceiverHttpTests(unittest.TestCase):
    """Receiver API status codes and messages through a loopback console."""

    def setUp(self):
        import http.client
        import threading
        import ground_console

        self.http = http.client
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.site = root / "site"
        (self.site / "assets").mkdir(parents=True)
        (self.site / "index.html").write_text("<!doctype html>console", encoding="utf-8")
        self.server = ground_console.GroundConsoleServer(
            ("127.0.0.1", 0), "http://doasdr.local:8081",
            config_path=str(root / "console.json"), branding_path=str(root / "branding.json"),
            frontend_dir=self.site, receiver_data_dir=root / "receiver-data",
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()
        self.temp.cleanup()

    def request(self, method, path, body=None):
        connection = self.http.HTTPConnection("127.0.0.1", self.port, timeout=10)
        headers = {"Origin": f"http://127.0.0.1:{self.port}"}
        if body is not None:
            body = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        payload = response.read()
        connection.close()
        return response.status, dict(response.getheaders()), payload

    def test_missing_receiver_build_explains_how_to_build_it(self):
        status, headers, body = self.request("GET", "/receiver/")
        self.assertEqual(status, 404)
        self.assertTrue(headers["Content-Type"].startswith("text/html"))
        self.assertIn(b"tools/build_browsdr_receiver.py", body)
        self.assertIn(b"npm run build", body)

    def test_not_found_messages_are_not_python_reprs(self):
        status, _, body = self.request("GET", "/api/receiver/scans/00000000-0000-4000-8000-000000000000")
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body), {"error": "scan not found"})

    def test_marker_name_conflicts_return_409(self):
        status, _, _ = self.request("POST", "/api/receiver/marker-sets", {"name": "Field", "markers": []})
        self.assertEqual(status, 201)
        status, _, body = self.request("POST", "/api/receiver/marker-sets", {"name": "Field", "markers": []})
        self.assertEqual(status, 409)
        self.assertIn("already exists", json.loads(body)["error"])
        _, _, other = self.request("POST", "/api/receiver/marker-sets", {"name": "Other", "markers": []})
        other_id = json.loads(other)["id"]
        status, _, _ = self.request("POST", "/api/receiver/marker-sets", {"id": other_id, "name": "Field", "markers": []})
        self.assertEqual(status, 409)
        status, _, _ = self.request("POST", "/api/receiver/marker-sets", {"name": "Field", "overwrite": True, "markers": []})
        self.assertEqual(status, 201)

    def test_storage_errors_are_reported_not_dropped(self):
        with mock.patch.object(self.server.receiver_store, "get_settings", side_effect=sqlite3.OperationalError("database is locked")):
            status, _, body = self.request("GET", "/api/receiver/settings")
        self.assertEqual(status, 500)
        self.assertEqual(json.loads(body), {"error": "Receiver storage error: database is locked"})

    def test_unload_request_finishes_session_with_open_segments(self):
        _, _, created = self.request("POST", "/api/receiver/audio-sessions", {})
        session_id = json.loads(created)["id"]
        _, _, segment = self.request("POST", f"/api/receiver/audio-sessions/{session_id}/segments", AUDIO_METADATA)
        segment_id = json.loads(segment)["id"]
        connection = self.http.HTTPConnection("127.0.0.1", self.port, timeout=10)
        connection.request("POST", f"/api/receiver/audio-segments/{segment_id}/chunk", body=synthetic_webm([(0, [0, 20])]),
                           headers={"Origin": f"http://127.0.0.1:{self.port}", "Content-Type": "application/octet-stream"})
        self.assertEqual(connection.getresponse().status, 200)
        connection.close()
        status, _, _ = self.request("POST", f"/api/receiver/audio-sessions/{session_id}/finish", {})
        self.assertEqual(status, 400)
        status, _, _ = self.request("POST", f"/api/receiver/audio-sessions/{session_id}/finish", {"finalize_open_segments": True})
        self.assertEqual(status, 200)
        _, _, records = self.request("GET", "/api/receiver/records?type=audio-session")
        saved = json.loads(records)["items"][0]
        self.assertIsNotNone(saved["completed_at"])
        self.assertEqual(saved["segments"][0]["status"], "interrupted")
        status, headers, _ = self.request("GET", f"/api/receiver/audio-segments/{segment_id}/audio")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "audio/webm")

    def test_receiver_page_csp_has_no_remote_font_hosts(self):
        receiver = self.site / "receiver"
        receiver.mkdir()
        (receiver / "index.html").write_text("<!doctype html>receiver", encoding="utf-8")
        status, headers, _ = self.request("GET", "/receiver/")
        self.assertEqual(status, 200)
        self.assertNotIn("fonts.googleapis.com", headers["Content-Security-Policy"])
        self.assertNotIn("fonts.gstatic.com", headers["Content-Security-Policy"])


if __name__ == "__main__":
    unittest.main()
