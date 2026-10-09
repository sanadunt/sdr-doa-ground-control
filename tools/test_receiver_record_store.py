import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS_DIR))

from receiver_record_store import ReceiverRecordStore


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

    def test_nearby_peak_frequencies_group_before_pagination(self):
        scan = self.store.create_scan("receiver", {}, True)
        peak_frequencies = [
            410_001_000,
            410_100_000,
            410_201_000,
            410_301_000,
            410_401_000,
            410_502_000,
        ]
        candidates = [
            {
                "id": index,
                "startHz": peak_frequency - 10_000,
                "endHz": peak_frequency + 10_000,
                "centerHz": peak_frequency,
                "peakFrequencyHz": peak_frequency,
                "meanPeakFrequencyHz": peak_frequency + (500 if index == 2 else 0),
                "minPeakFrequencyHz": peak_frequency,
                "maxPeakFrequencyHz": peak_frequency,
                "bandwidthHz": 20_000,
                "peakDb": peak_db,
                "noiseFloorDb": -90,
                "snrDb": peak_db + 90,
                "firstSeen": 1,
                "lastSeen": 2,
                "hits": 2,
            }
            for index, (peak_frequency, peak_db) in enumerate(
                zip(peak_frequencies, (-40, -30, -25, -45, -35, -20)),
                start=1,
            )
        ]
        self.store.upsert_candidates(scan["id"], candidates)

        raw = self.store.get_candidates(scan["id"], limit=10)
        first_page = self.store.get_candidates(scan["id"], offset=0, limit=1, group_adjacent=True)
        second_page = self.store.get_candidates(scan["id"], offset=1, limit=1, group_adjacent=True)
        third_page = self.store.get_candidates(scan["id"], offset=2, limit=1, group_adjacent=True)

        self.assertEqual(raw["total"], 6)
        self.assertEqual(first_page["total"], 3)
        first_band = first_page["items"][0]
        self.assertEqual(first_band["id"], 1)
        self.assertEqual(first_band["peakRangeStartHz"], 410_001_000)
        self.assertEqual(first_band["peakRangeEndHz"], 410_100_000)
        self.assertEqual(first_band["peakRangeCenterHz"], 410_050_500)
        self.assertEqual(first_band["startHz"], 410_090_000)
        self.assertEqual(first_band["endHz"], 410_110_000)
        self.assertEqual(first_band["centerHz"], 410_100_000)
        self.assertEqual(first_band["bandwidthHz"], 20_000)
        self.assertEqual(first_band["peakFrequencyHz"], 410_100_000)
        self.assertEqual(first_band["meanPeakFrequencyHz"], 410_100_500)
        self.assertEqual(first_band["peakDb"], -30)
        self.assertEqual(second_page["items"][0]["peakRangeStartHz"], 410_201_000)
        self.assertEqual(second_page["items"][0]["peakRangeEndHz"], 410_401_000)
        self.assertEqual(second_page["items"][0]["peakRangeCenterHz"], 410_301_000)
        self.assertEqual(third_page["items"][0]["id"], 6)

    def test_legacy_candidates_backfill_peak_frequency_for_grouping(self):
        with tempfile.TemporaryDirectory() as legacy_dir:
            scan_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            candidates = [
                {
                    "id": 1, "startHz": 409_991_000, "endHz": 410_011_000, "centerHz": 410_001_000,
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
            with sqlite3.connect(Path(legacy_dir) / "receiver.sqlite3") as db:
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
        updated = self.store.save_markers({"name": "Field", "markers": [{"frequency_hz": 1_040_000, "power_db": -25}]})
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


if __name__ == "__main__":
    unittest.main()
