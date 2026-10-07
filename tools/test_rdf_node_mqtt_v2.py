"""Black-box contract tests for RDF Node MQTT v2 telemetry."""
from __future__ import annotations

import json
import struct
import unittest

try:
    from tools.rdf_node_mqtt_v2 import RDF_NODE_V2_SUFFIXES, RdfNodeV2Telemetry
except ModuleNotFoundError as exc:
    if exc.name != "tools.rdf_node_mqtt_v2":
        raise
    RDF_NODE_V2_SUFFIXES = None
    RdfNodeV2Telemetry = None

NODE = "uav-01"
NOW = 1_790_668_800_000
SID = "7a8b9c0d"
BOOT = "10aa2345-6789-4abc-9def-1234567890ab"
INSTANCE = "8a5bb269-73fd-4cbb-9c6b-a3327f679221"


def obj(suffix: str, **fields: object) -> dict[str, object]:
    common: dict[str, object] = {"v": 2, "sid": SID}
    if suffix not in ("capabilities", "telemetry/diagnostic/doa"):
        common["t"] = NOW
    specific: dict[str, dict[str, object]] = {
        "telemetry/doa": {"q": 1, "f": 433920000, "a": 137.4, "c": 8.27, "p": -54.2, "rev": 7, "ok": 1},
        "telemetry/diagnostic/doa": {"q": 19, "source": "doa.xml", "source_timestamp_ms": NOW, "observed_timestamp_ms": NOW, "raw_doa_deg": 200.0, "frequency_mhz": 137.0, "trust": "UNVERIFIED", "validation_reasons": ["DIAGNOSTIC_UNVERIFIED", "EMPTY_CSV"]},
        "telemetry/health": {"q": 1, "run": 1, "daq": 1, "drop": 12, "age": 280, "temp": 61.4, "clk": 1, "rev": 7},
        "telemetry/health/detail": {"usb": 2, "sync": [True, True, True], "cpu": 22.1, "mem": 41.7, "disk_free": 83.2, "throt": False, "uv": False, "tx": 12.34, "rx": 8.21, "adrop": 0, "parse": 0},
        "state": {"boot": BOOT, "instance": INSTANCE, "run": "RUNNING", "daq": True, "cfg": 7, "profile": "balanced", "clock": "SYNCED"},
        "capabilities": {"boot": BOOT, "instance": INSTANCE, "version": "1.0.0", "mode": "read_only", "codecs": ["q16", "u8"], "angle": "theta_mirror", "native_axis": 1, "count": 360, "profiles": ["control", "balanced", "graph_u8"], "scope": "SDR_STACK", "helper_available": True, "maintenance": False, "remote_commands": False, "config_patch": False, "processing": False, "restart": False, "reboot": False},
        "config/reported": {"rev": 7, "proof": "source_correlated", "digest": "a" * 64, "effective": {"center_frequency_hz": 433920000, "gain_db": 20.7, "vfo0_frequency_hz": 433920000, "vfo0_bandwidth_hz": 125000, "vfo0_squelch_db": -20.0, "ant_arrangement": "native", "doa_method": "native", "active_vfos": 1, "output_vfo": 0, "en_doa": True}},
        "availability": {"online": True},
        "ack/config": {"id": "g01-00001234", "status": "APPLIED", "rev": 8, "result": {"revision": 8}},
        "ack/operation": {"id": "g01-00001235", "status": "APPLYING", "result": {"operation": "restart"}},
    }
    common.update(specific[suffix])
    common.update(fields)
    return common


def payload(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":"), allow_nan=True).encode()


def topic(suffix: str) -> str:
    return f"sdr/v2/{NODE}/{suffix}"


def put(store: RdfNodeV2Telemetry, suffix: str, value: object | bytes, *, at: int = NOW, retained: bool = False, qos: int = 0, expiry: int | None = None) -> None:
    raw = value if isinstance(value, bytes) else payload(value)
    store.ingest(topic(suffix), raw, qos=qos, retained=retained, received_at_ms=at, message_expiry_s=expiry)


def observation(snapshot: dict[str, object], suffix: str) -> dict[str, object]:
    return snapshot["topics"][suffix]  # type: ignore[index,return-value]


def angular_frame(*, encoding: int = 1, flags: int = 31, sid: int = 0x7A8B9C0D, q: int = 1, timestamp: int = NOW, revision: int = 7, count: int = 360, scale: float = .01, offset: float = 0.0, samples: bytes | None = None) -> bytes:
    if samples is None:
        samples = struct.pack("<360h", *([1250] * 360)) if encoding == 1 else bytes([25] * 360)
    header = struct.pack("<4sBBHIIQIIBBHffHh", b"RDF2", 2, encoding, flags, sid, q, timestamp, 433920000, revision, 0, 1, count, scale, offset, 13740, 827)
    return header + samples


def chunks(frame: bytes, sizes: tuple[int, ...], *, q: int | None = None, sid: int | None = None) -> list[bytes]:
    frame_sid = struct.unpack_from("<I", frame, 8)[0] if sid is None else sid
    frame_q = struct.unpack_from("<I", frame, 12)[0] if q is None else q
    result, pos = [], 0
    for index, size in enumerate(sizes):
        body = frame[pos:pos + size]
        result.append(struct.pack("<IIBBH", frame_sid, frame_q, index, len(sizes), len(frame)) + body)
        pos += len(body)
    return result


class MissingProductionModuleTests(unittest.TestCase):
    def test_production_module_is_available(self) -> None:
        self.assertIsNotNone(RdfNodeV2Telemetry, "RdfNodeV2Telemetry implementation module is missing")


@unittest.skipIf(RdfNodeV2Telemetry is None, "behavior tests run once production module exists")
class RdfNodeV2TelemetryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.store = RdfNodeV2Telemetry(NODE)

    def test_topic_allowlist_includes_exact_twelve_edge_to_ground_suffixes(self) -> None:
        expected = ("telemetry/doa", "telemetry/diagnostic/doa", "telemetry/diagnostic/angular", "telemetry/health", "telemetry/health/detail", "telemetry/angular", "state", "capabilities", "config/reported", "availability", "ack/config", "ack/operation")
        self.assertEqual(RDF_NODE_V2_SUFFIXES, expected)
        policy = {
            "telemetry/doa": (0, False),
            "telemetry/diagnostic/doa": (0, False),
            "telemetry/health": (0, False),
            "telemetry/health/detail": (0, False),
            "state": (1, True),
            "capabilities": (1, True),
            "config/reported": (1, True),
            "availability": (1, True),
            "ack/config": (1, False),
            "ack/operation": (1, False),
        }
        for suffix in expected:
            if suffix in ("telemetry/angular", "telemetry/diagnostic/angular"):
                continue
            with self.subTest(suffix=suffix):
                store = RdfNodeV2Telemetry(NODE)
                qos, retained = policy[suffix]
                if suffix == "telemetry/doa":
                    put(store, "telemetry/health", obj("telemetry/health"))
                put(store, suffix, obj(suffix), qos=qos, retained=retained)
                entry = observation(store.snapshot(NOW), suffix)
                expected_status = "CONTEXT" if retained else "FRESH"
                self.assertEqual(entry["status"], expected_status)
                self.assertEqual(entry["payload"], obj(suffix))
                if suffix == "capabilities":
                    self.assertNotIn("t", entry["payload"])
                self.assertEqual(entry["qos"], qos)
                self.assertEqual(entry["retained"], retained)
                self.assertIsNone(entry["error"])
                self.assertEqual(len(store.snapshot(NOW)["topics"]), 12)

    def test_json_rejects_malformed_nonfinite_and_out_of_range(self) -> None:
        bad_values = [
            ("telemetry/health", b"{"),
            ("telemetry/health", b"[]"),
            ("telemetry/health", b'{"v":2,"sid":"bad"}'),
            ("telemetry/health", payload(obj("telemetry/health", temp=float("nan")))),
            ("telemetry/doa", payload(obj("telemetry/doa", a=181))),
            ("telemetry/health", payload(obj("telemetry/health", daq=3))),
            ("telemetry/health/detail", payload(obj("telemetry/health/detail", cpu=101))),
            ("telemetry/health", payload(obj("telemetry/health")).replace(b'"temp":61.4', b'"temp":1e999')),
            ("telemetry/doa", payload(obj("telemetry/doa")).replace(b'"f":433920000', b'"f":' + b"9" * 500)),
            ("telemetry/health/detail", payload({**obj("telemetry/health/detail"), "sync": None})),
            ("telemetry/health/detail", payload({key: value for key, value in obj("telemetry/health/detail").items() if key != "sync"})),
            ("ack/config", payload(obj("ack/config", id=""))),
        ]
        for suffix, raw in bad_values:
            with self.subTest(suffix=suffix, raw=raw[:40]):
                store = RdfNodeV2Telemetry(NODE)
                put(store, suffix, raw)
                entry = observation(store.snapshot(NOW), suffix)
                self.assertEqual(entry["status"], "INVALID")
                self.assertIsNotNone(entry["error"])
                self.assertIsNone(entry["payload"])

    def test_invalid_schema_retains_safe_candidate_without_promoting_payload(self) -> None:
        store = RdfNodeV2Telemetry(NODE)
        put(
            store,
            "telemetry/doa",
            obj("telemetry/doa", a="bad-angle", password="hidden", unknown={"api_key": "hidden"}),
        )

        entry = observation(store.snapshot(NOW), "telemetry/doa")

        self.assertEqual(entry["status"], "INVALID")
        self.assertEqual(entry["error"], "INVALID_FIELD")
        self.assertIsNone(entry["payload"])
        self.assertEqual(entry["candidate_payload"], {
            "v": 2, "sid": SID, "q": 1, "t": NOW, "f": 433920000,
            "a": "bad-angle", "c": 8.27, "p": -54.2, "rev": 7, "ok": 1,
        })
        self.assertEqual(entry["received_at_ms"], NOW)

    def test_broker_policy_invalidity_keeps_safe_candidate_visible(self) -> None:
        store = RdfNodeV2Telemetry(NODE)
        put(store, "telemetry/health", obj("telemetry/health"), qos=1)

        entry = observation(store.snapshot(NOW), "telemetry/health")

        self.assertEqual(entry["status"], "INVALID")
        self.assertEqual(entry["error"], "BROKER_POLICY")
        self.assertIsNone(entry["payload"])
        self.assertEqual(entry["candidate_payload"]["run"], 1)
        self.assertEqual(entry["candidate_payload"]["t"], NOW)

    def test_invalid_ack_candidate_redacts_nested_credential_fields(self) -> None:
        store = RdfNodeV2Telemetry(NODE)
        put(
            store,
            "ack/operation",
            obj(
                "ack/operation",
                status=17,
                result={
                    "operation": "restart",
                    "status": "APPLYING",
                    "challenge": "hidden",
                    "token": "hidden",
                    "password": "hidden",
                    "unlisted": "hidden",
                },
            ),
            qos=1,
        )

        entry = observation(store.snapshot(NOW), "ack/operation")

        self.assertEqual(entry["status"], "INVALID")
        self.assertIsNone(entry["payload"])
        self.assertEqual(entry["candidate_payload"]["result"], {
            "operation": "restart",
            "status": "APPLYING",
        })

    def test_invalid_ack_candidate_preserves_documented_proof_fields(self) -> None:
        store = RdfNodeV2Telemetry(NODE)
        put(
            store,
            "ack/config",
            obj(
                "ack/config",
                status=17,
                result={
                    "revision": 8,
                    "proof": {
                        "center_frequency_hz": "FRESH_DAQ_RF_CENTER",
                        "vfo0_frequency_hz": "FRESH_DOA_FREQUENCY",
                        "challenge": "single-use-challenge-42",
                        "password": "hidden-password",
                        "unlisted": "hidden",
                    },
                },
            ),
            qos=1,
        )

        entry = observation(store.snapshot(NOW), "ack/config")

        self.assertEqual(entry["status"], "INVALID")
        self.assertIsNone(entry["payload"])
        self.assertEqual(entry["candidate_payload"]["result"]["proof"], {
            "center_frequency_hz": "FRESH_DAQ_RF_CENTER",
            "vfo0_frequency_hz": "FRESH_DOA_FREQUENCY",
        })
        self.assertNotIn("single-use-challenge-42", repr(entry))
        self.assertNotIn("hidden-password", repr(entry))

    def test_valid_ack_payload_preserves_documented_proof_fields(self) -> None:
        store = RdfNodeV2Telemetry(NODE)
        put(
            store,
            "ack/config",
            obj(
                "ack/config",
                result={
                    "revision": 8,
                    "proof": {
                        "center_frequency_hz": "FRESH_DAQ_RF_CENTER",
                        "vfo0_frequency_hz": "FRESH_DOA_FREQUENCY",
                    },
                    "persisted": True,
                },
            ),
            qos=1,
        )

        entry = observation(store.snapshot(NOW), "ack/config")

        self.assertEqual(entry["status"], "FRESH")
        self.assertEqual(entry["payload"]["result"]["proof"], {
            "center_frequency_hz": "FRESH_DAQ_RF_CENTER",
            "vfo0_frequency_hz": "FRESH_DOA_FREQUENCY",
        })

    def test_invalid_ack_candidate_omits_unstructured_result_values(self) -> None:
        for result in ("single-use-challenge-42", ["single-use-challenge-42"]):
            with self.subTest(result_type=type(result).__name__):
                store = RdfNodeV2Telemetry(NODE)
                put(store, "ack/operation", obj("ack/operation", result=result), qos=1)

                entry = observation(store.snapshot(NOW), "ack/operation")

                self.assertEqual(entry["status"], "INVALID")
                self.assertNotIn("single-use-challenge-42", repr(entry))
    def test_json_size_boundary_is_exact(self) -> None:
        for length, expected in ((16384, "FRESH"), (16385, "INVALID")):
            store = RdfNodeV2Telemetry(NODE)
            base = payload(obj("telemetry/health"))
            raw = base + b" " * (length - len(base))
            self.assertEqual(len(raw), length)
            put(store, "telemetry/health", raw)
            self.assertEqual(observation(store.snapshot(NOW), "telemetry/health")["status"], expected)

    def test_availability_last_will_without_timestamp_is_context(self) -> None:
        offline = {"v": 2, "sid": SID, "online": False, "reason": "CONNECTION_LOST"}
        put(self.store, "availability", offline, qos=1, retained=True)
        entry = observation(self.store.snapshot(NOW), "availability")
        self.assertEqual(entry["status"], "CONTEXT")
        self.assertEqual(entry["payload"], offline)

        store = RdfNodeV2Telemetry(NODE)
        online_without_timestamp = {"v": 2, "sid": SID, "online": True}
        put(store, "availability", online_without_timestamp, qos=1, retained=True)
        entry = observation(store.snapshot(NOW), "availability")
        self.assertEqual(entry["status"], "INVALID")
        self.assertIsNone(entry["payload"])

    def test_documented_health_detail_and_ack_expiry_boundaries(self) -> None:
        store = RdfNodeV2Telemetry(NODE)
        put(store, "telemetry/health/detail", obj("telemetry/health/detail"), expiry=15)
        self.assertEqual(observation(store.snapshot(NOW + 15000), "telemetry/health/detail")["status"], "FRESH")
        self.assertEqual(observation(store.snapshot(NOW + 15001), "telemetry/health/detail")["status"], "STALE")
        for suffix in ("ack/config", "ack/operation"):
            store = RdfNodeV2Telemetry(NODE)
            put(store, suffix, obj(suffix), qos=1, expiry=30)
            self.assertEqual(observation(store.snapshot(NOW + 30000), suffix)["status"], "FRESH")
            self.assertEqual(observation(store.snapshot(NOW + 30001), suffix)["status"], "STALE")

    def test_topic_node_and_suffix_are_exact(self) -> None:
        for node in ("", "two/segments", "..", "bad+node", "bad#node"):
            with self.subTest(node=node), self.assertRaises(ValueError):
                RdfNodeV2Telemetry(node)
        for path in (f"sdr/v2/{NODE}/telemetry/health/extra", f"sdr/v2/other/telemetry/health", f"sdr/demo/v2/{NODE}/telemetry/health"):
            with self.subTest(path=path):
                with self.assertRaises(ValueError):
                    self.store.ingest(path, payload(obj("telemetry/health")), qos=0, retained=False, received_at_ms=NOW)

    def test_retained_policy_and_health_age_boundary(self) -> None:
        put(self.store, "telemetry/health", obj("telemetry/health"), retained=True)
        self.assertNotEqual(observation(self.store.snapshot(NOW), "telemetry/health")["status"], "FRESH")
        store = RdfNodeV2Telemetry(NODE)
        put(store, "telemetry/health", obj("telemetry/health"))
        self.assertEqual(observation(store.snapshot(NOW + 8000), "telemetry/health")["status"], "FRESH")
        self.assertEqual(observation(store.snapshot(NOW + 8001), "telemetry/health")["status"], "STALE")
        for suffix in ("state", "capabilities", "config/reported", "availability"):
            store = RdfNodeV2Telemetry(NODE)
            put(store, suffix, obj(suffix), retained=True, qos=1)
            self.assertEqual(observation(store.snapshot(NOW), suffix)["status"], "CONTEXT")

    def test_doa_requires_health_increasing_sequence_matching_revision_and_age(self) -> None:
        for delta, status in ((5000, "FRESH"), (5001, "STALE")):
            store = RdfNodeV2Telemetry(NODE)
            put(store, "telemetry/health", obj("telemetry/health"))
            put(store, "telemetry/doa", obj("telemetry/doa"), at=NOW + delta)
            self.assertEqual(observation(store.snapshot(NOW + delta), "telemetry/doa")["status"], status)
        store = RdfNodeV2Telemetry(NODE)
        put(store, "telemetry/health", obj("telemetry/health", daq=0))
        put(store, "telemetry/doa", obj("telemetry/doa"))
        self.assertEqual(observation(store.snapshot(NOW), "telemetry/doa")["status"], "INCONSISTENT")
        store = RdfNodeV2Telemetry(NODE)
        put(store, "telemetry/health", obj("telemetry/health"))
        put(store, "telemetry/doa", obj("telemetry/doa", rev=8))
        self.assertEqual(observation(store.snapshot(NOW), "telemetry/doa")["status"], "INCONSISTENT")

    def test_health_and_doa_sequences_must_increase(self) -> None:
        for suffix in ("telemetry/health", "telemetry/doa"):
            for sequences in ((4, 4), (5, 4)):
                store = RdfNodeV2Telemetry(NODE)
                if suffix == "telemetry/doa":
                    put(store, "telemetry/health", obj("telemetry/health"))
                put(store, suffix, obj(suffix, q=sequences[0]))
                put(store, suffix, obj(suffix, q=sequences[1]))
                with self.subTest(suffix=suffix, sequences=sequences):
                    self.assertNotEqual(observation(store.snapshot(NOW), suffix)["status"], "FRESH")
                if sequences == (5, 4):
                    put(store, suffix, obj(suffix, q=5))
                    with self.subTest(suffix=suffix, sequences=(5, 4, 5)):
                        self.assertNotEqual(observation(store.snapshot(NOW), suffix)["status"], "FRESH")

    def test_identity_and_revision_transitions_invalidate_cached_telemetry(self) -> None:
        changed_ids = (
            ("sid", "01020304"),
            ("boot", "20aa2345-6789-4abc-9def-1234567890ab"),
            ("instance", "9a5bb269-73fd-4cbb-9c6b-a3327f679221"),
        )
        for field, new_value in changed_ids:
            store = RdfNodeV2Telemetry(NODE)
            put(store, "state", obj("state"), qos=1, retained=True)
            put(store, "telemetry/health", obj("telemetry/health"))
            put(store, "telemetry/doa", obj("telemetry/doa"))
            put(store, "state", obj("state", **{field: new_value}), qos=1, retained=True)
            snap = store.snapshot(NOW)
            with self.subTest(field=field):
                self.assertNotEqual(observation(snap, "telemetry/doa")["status"], "FRESH")
        store = RdfNodeV2Telemetry(NODE)
        put(store, "telemetry/health", obj("telemetry/health"))
        put(store, "telemetry/doa", obj("telemetry/doa"))
        put(store, "config/reported", obj("config/reported", rev=8), qos=1, retained=True)
        self.assertNotEqual(observation(store.snapshot(NOW), "telemetry/doa")["status"], "FRESH")

    def test_same_session_identity_hydration_preserves_sequence_highwater(self) -> None:
        store = RdfNodeV2Telemetry(NODE)
        put(store, "telemetry/health", obj("telemetry/health", q=5))
        identity = obj("state")
        put(store, "state", identity, qos=1, retained=True)
        put(store, "telemetry/health", obj("telemetry/health", q=5))
        self.assertNotEqual(observation(store.snapshot(NOW), "telemetry/health")["status"], "FRESH")

    def test_dependent_telemetry_tracks_health_freshness_and_daq(self) -> None:
        store = RdfNodeV2Telemetry(NODE)
        put(store, "telemetry/health", obj("telemetry/health", q=1, t=NOW), at=NOW)
        dependent_time = NOW + 7000
        put(store, "telemetry/doa", obj("telemetry/doa", q=1, t=dependent_time), at=dependent_time)
        frame = angular_frame(q=1, timestamp=dependent_time)
        for chunk in chunks(frame, (384, 384)):
            put(store, "telemetry/angular", chunk, at=dependent_time)
        snapshot = store.snapshot(dependent_time)
        self.assertEqual(observation(snapshot, "telemetry/doa")["status"], "FRESH")
        self.assertEqual(observation(snapshot, "telemetry/angular")["status"], "FRESH")
        snapshot = store.snapshot(NOW + 9000)
        self.assertNotEqual(observation(snapshot, "telemetry/doa")["status"], "FRESH")
        self.assertNotEqual(observation(snapshot, "telemetry/angular")["status"], "FRESH")

        store = RdfNodeV2Telemetry(NODE)
        put(store, "telemetry/health", obj("telemetry/health", q=1, daq=1))
        put(store, "telemetry/doa", obj("telemetry/doa", q=1))
        frame = angular_frame(q=1)
        for chunk in chunks(frame, (384, 384)):
            put(store, "telemetry/angular", chunk)
        snapshot = store.snapshot(NOW)
        self.assertEqual(observation(snapshot, "telemetry/doa")["status"], "FRESH")
        self.assertEqual(observation(snapshot, "telemetry/angular")["status"], "FRESH")
        put(store, "telemetry/health", obj("telemetry/health", q=2, daq=0))
        snapshot = store.snapshot(NOW)
        self.assertNotEqual(observation(snapshot, "telemetry/doa")["status"], "FRESH")
        self.assertNotEqual(observation(snapshot, "telemetry/angular")["status"], "FRESH")

    def test_revision_transition_preserves_sequence_highwater(self) -> None:
        store = RdfNodeV2Telemetry(NODE)
        put(store, "telemetry/health", obj("telemetry/health", q=5, rev=7))
        put(store, "telemetry/doa", obj("telemetry/doa", q=5, rev=7))
        angular5 = angular_frame(q=5, revision=7)
        for chunk in chunks(angular5, (384, 384)):
            put(store, "telemetry/angular", chunk)
        self.assertEqual(observation(store.snapshot(NOW), "telemetry/health")["status"], "FRESH")
        self.assertEqual(observation(store.snapshot(NOW), "telemetry/doa")["status"], "FRESH")
        self.assertEqual(observation(store.snapshot(NOW), "telemetry/angular")["status"], "FRESH")

        put(store, "config/reported", obj("config/reported", rev=8), qos=1, retained=True)
        put(store, "telemetry/health", obj("telemetry/health", q=5, rev=8))
        self.assertNotEqual(observation(store.snapshot(NOW), "telemetry/health")["status"], "FRESH")
        put(store, "telemetry/health", obj("telemetry/health", q=6, rev=8))
        self.assertEqual(observation(store.snapshot(NOW), "telemetry/health")["status"], "FRESH")

        put(store, "telemetry/doa", obj("telemetry/doa", q=5, rev=8))
        self.assertNotEqual(observation(store.snapshot(NOW), "telemetry/doa")["status"], "FRESH")
        put(store, "telemetry/doa", obj("telemetry/doa", q=6, rev=8))
        self.assertEqual(observation(store.snapshot(NOW), "telemetry/doa")["status"], "FRESH")

        angular5_new_revision = angular_frame(q=5, revision=8)
        for chunk in chunks(angular5_new_revision, (384, 384)):
            put(store, "telemetry/angular", chunk)
        self.assertNotEqual(observation(store.snapshot(NOW), "telemetry/angular")["status"], "FRESH")
        angular6_new_revision = angular_frame(q=6, revision=8)
        for chunk in chunks(angular6_new_revision, (384, 384)):
            put(store, "telemetry/angular", chunk)
        self.assertEqual(observation(store.snapshot(NOW), "telemetry/angular")["status"], "FRESH")

    def test_health_revision_must_match_known_config_and_state_revision(self) -> None:
        for source, fields in (("state", {"cfg": 8}), ("config/reported", {"rev": 8})):
            store = RdfNodeV2Telemetry(NODE)
            put(store, source, obj(source, **fields), qos=1, retained=True)
            put(store, "telemetry/health", obj("telemetry/health", rev=7))
            mismatched = observation(store.snapshot(NOW), "telemetry/health")
            with self.subTest(source=source):
                self.assertEqual(mismatched["status"], "INCONSISTENT")
                self.assertEqual(mismatched["error"], "REVISION_MISMATCH")
            put(store, "telemetry/health", obj("telemetry/health", q=2, rev=8))
            self.assertEqual(observation(store.snapshot(NOW), "telemetry/health")["status"], "FRESH")

    def test_config_revision_report_invalidates_previously_cached_health(self) -> None:
        store = RdfNodeV2Telemetry(NODE)
        put(store, "telemetry/health", obj("telemetry/health", rev=7))
        self.assertEqual(observation(store.snapshot(NOW), "telemetry/health")["status"], "FRESH")

        put(store, "config/reported", obj("config/reported", rev=8), qos=1, retained=True)
        self.assertNotEqual(observation(store.snapshot(NOW), "telemetry/health")["status"], "FRESH")
        put(store, "telemetry/health", obj("telemetry/health", q=2, rev=8))
        self.assertEqual(observation(store.snapshot(NOW), "telemetry/health")["status"], "FRESH")

    def test_unknown_config_report_revision_does_not_override_known_state_revision(self) -> None:
        store = RdfNodeV2Telemetry(NODE)
        put(store, "state", obj("state", cfg=7), qos=1, retained=True)
        put(store, "config/reported", obj("config/reported", rev=None), qos=1, retained=True)
        put(store, "telemetry/health", obj("telemetry/health", rev=7))
        self.assertEqual(observation(store.snapshot(NOW), "telemetry/health")["status"], "FRESH")


    def test_ack_payload_redacts_challenge_and_unknown_credential_fields(self) -> None:
        store = RdfNodeV2Telemetry(NODE)
        raw = obj(
            "ack/operation",
            result={
                "operation": "restart",
                "status": "APPLYING",
                "challenge": "single-use-challenge-42",
                "broker_credential": "fixture-password-value",
            },
            error={"error": "REBOOT_BLOCKED"},
        )
        put(store, "ack/operation", raw, qos=1)
        entry = observation(store.snapshot(NOW), "ack/operation")
        self.assertNotEqual(entry["status"], "INVALID")
        normalized = entry["payload"]
        self.assertEqual(normalized["result"]["operation"], "restart")
        self.assertEqual(normalized["result"]["status"], "APPLYING")
        self.assertEqual(normalized["error"]["error"], "REBOOT_BLOCKED")
        self.assertNotIn("challenge", normalized["result"])
        self.assertNotIn("broker_credential", normalized["result"])
        rendered = repr(normalized)
        self.assertNotIn("single-use-challenge-42", rendered)
        self.assertNotIn("fixture-password-value", rendered)

    def test_ack_result_and_error_reject_unstructured_values(self) -> None:
        for suffix in ("ack/config", "ack/operation"):
            for field in ("result", "error"):
                for value in ("single-use-challenge-42", ["single-use-challenge-42"]):
                    store = RdfNodeV2Telemetry(NODE)
                    put(store, suffix, obj(suffix, **{field: value}), qos=1)
                    entry = observation(store.snapshot(NOW), suffix)
                    with self.subTest(suffix=suffix, field=field, value_type=type(value).__name__):
                        self.assertEqual(entry["status"], "INVALID")
                        self.assertIsNone(entry["payload"])
                        self.assertNotIn("single-use-challenge-42", repr(entry))

    def test_ack_rejects_unsafe_numbers_and_challenge_like_error_codes(self) -> None:
        cases = (
            ("ack/config", "result", {"valid_seconds": 10 ** 400}),
            ("ack/operation", "error", {"error": "single-use-challenge-42"}),
            ("ack/operation", "result", {"code": "single-use-challenge-42"}),
        )
        for suffix, field, value in cases:
            store = RdfNodeV2Telemetry(NODE)
            put(store, suffix, obj(suffix, **{field: value}), qos=1)
            entry = observation(store.snapshot(NOW), suffix)
            with self.subTest(suffix=suffix, field=field):
                self.assertEqual(entry["status"], "INVALID")
                self.assertIsNone(entry["payload"])
                self.assertNotIn("single-use-challenge-42", repr(entry))


    def test_config_report_does_not_expose_unknown_effective_key(self) -> None:
        store = RdfNodeV2Telemetry(NODE)
        report = obj("config/reported")
        report["effective"]["private_token"] = "fixture-private-token-value"
        put(store, "config/reported", report, qos=1, retained=True)
        entry = observation(store.snapshot(NOW), "config/reported")
        if entry["status"] == "INVALID":
            self.assertIsNone(entry["payload"])
        else:
            self.assertEqual(entry["status"], "CONTEXT")
            normalized = entry["payload"]
            self.assertNotIn("private_token", normalized["effective"])
            self.assertNotIn("fixture-private-token-value", repr(normalized))

    def test_state_config_revision_change_without_report_invalidates_cached_data(self) -> None:
        store = RdfNodeV2Telemetry(NODE)
        put(store, "state", obj("state", cfg=7), qos=1, retained=True)
        put(store, "telemetry/health", obj("telemetry/health", rev=7))
        put(store, "telemetry/doa", obj("telemetry/doa", rev=7))
        frame = angular_frame(q=1, revision=7)
        for chunk in chunks(frame, (384, 384)):
            put(store, "telemetry/angular", chunk)
        initial = store.snapshot(NOW)
        for suffix in ("telemetry/health", "telemetry/doa", "telemetry/angular"):
            self.assertEqual(observation(initial, suffix)["status"], "FRESH")
        put(store, "state", obj("state", cfg=8), qos=1, retained=True)
        snapshot = store.snapshot(NOW)
        for suffix in ("telemetry/health", "telemetry/doa", "telemetry/angular"):
            with self.subTest(suffix=suffix):
                self.assertNotEqual(observation(snapshot, suffix)["status"], "FRESH")

    def test_snapshots_do_not_share_nested_payload_mutations(self) -> None:
        store = RdfNodeV2Telemetry(NODE)
        put(store, "ack/operation", obj("ack/operation", result={"operation": "restart", "status": "APPLYING"}), qos=1)
        first = observation(store.snapshot(NOW), "ack/operation")
        first["payload"]["result"]["operation"] = "mutated"
        first["payload"]["result"]["challenge"] = "injected-secret"
        later = observation(store.snapshot(NOW), "ack/operation")["payload"]
        self.assertEqual(later["result"]["operation"], "restart")
        self.assertNotIn("challenge", later["result"])
        self.assertNotIn("injected-secret", repr(later))

    def test_config_report_rejects_wrong_effective_field_types(self) -> None:
        wrong_types = (
            ("center_frequency_hz", True),
            ("gain_db", "20.7"),
            ("en_doa", 1),
        )
        for field, value in wrong_types:
            store = RdfNodeV2Telemetry(NODE)
            report = obj("config/reported")
            report["effective"][field] = value
            put(store, "config/reported", report, qos=1, retained=True)
            entry = observation(store.snapshot(NOW), "config/reported")
            with self.subTest(field=field):
                self.assertEqual(entry["status"], "INVALID")
                self.assertIsNone(entry["payload"])

    def test_config_report_rejects_javascript_unsafe_integer_values(self) -> None:
        for field, value in (("gain_db", 10 ** 400), ("center_frequency_hz", 1 << 53)):
            store = RdfNodeV2Telemetry(NODE)
            report = obj("config/reported")
            report["effective"][field] = value
            put(store, "config/reported", report, qos=1, retained=True)
            entry = observation(store.snapshot(NOW), "config/reported")
            with self.subTest(field=field):
                self.assertEqual(entry["status"], "INVALID")
                self.assertIsNone(entry["payload"])


    def test_latest_only_state_and_health_detail_is_not_gate(self) -> None:
        for cpu in range(1, 20):
            put(self.store, "telemetry/health/detail", obj("telemetry/health/detail", cpu=cpu))
        entry = observation(self.store.snapshot(NOW), "telemetry/health/detail")
        self.assertEqual(entry["payload"]["cpu"], 19)
        self.assertNotIn("history", self.store.snapshot(NOW))
        put(self.store, "telemetry/health/detail", obj("telemetry/health/detail"))
        put(self.store, "telemetry/doa", obj("telemetry/doa"))
        self.assertNotEqual(observation(self.store.snapshot(NOW), "telemetry/doa")["status"], "FRESH")

    def test_health_detail_is_cleared_when_session_changes(self) -> None:
        store = RdfNodeV2Telemetry(NODE)
        put(store, "state", obj("state"), qos=1, retained=True)
        put(store, "telemetry/health/detail", obj("telemetry/health/detail"))
        self.assertEqual(observation(store.snapshot(NOW), "telemetry/health/detail")["status"], "FRESH")

        put(store, "state", obj("state", sid="01020304"), qos=1, retained=True)
        detail = observation(store.snapshot(NOW), "telemetry/health/detail")
        self.assertEqual(detail["status"], "UNAVAILABLE")
        self.assertIsNone(detail["payload"])


    def test_angular_u8_single_chunk_420_boundary_and_decode(self) -> None:
        put(self.store, "telemetry/health", obj("telemetry/health"))
        frame = angular_frame(encoding=2, scale=.5, offset=-10, samples=bytes(range(256)) + bytes(range(104)))
        self.assertEqual(len(frame) + 12, 420)
        chunk = chunks(frame, (len(frame),))[0]
        put(self.store, "telemetry/angular", chunk)
        entry = observation(self.store.snapshot(NOW), "telemetry/angular")
        self.assertEqual(entry["status"], "FRESH")
        decoded = entry["payload"]
        self.assertEqual(len(decoded["values"]), 360)
        self.assertEqual(decoded["values"][:3], [-10.0, -9.5, -9.0])
        store = RdfNodeV2Telemetry(NODE)
        put(store, "telemetry/angular", chunk + b"x")
        self.assertEqual(observation(store.snapshot(NOW), "telemetry/angular")["status"], "INVALID")

    def test_angular_q16_reordered_chunks_duplicates_and_flags(self) -> None:
        put(self.store, "telemetry/health", obj("telemetry/health"))
        frame = angular_frame()
        pair = chunks(frame, (384, 384))
        put(self.store, "telemetry/angular", pair[1])
        self.assertNotEqual(observation(self.store.snapshot(NOW), "telemetry/angular")["status"], "FRESH")
        put(self.store, "telemetry/angular", pair[0])
        entry = observation(self.store.snapshot(NOW), "telemetry/angular")
        self.assertEqual(entry["status"], "FRESH")
        self.assertEqual(len(entry["payload"]["values"]), 360)
        self.assertEqual(entry["payload"]["values"][0], 12.5)
        store = RdfNodeV2Telemetry(NODE)
        put(store, "telemetry/health", obj("telemetry/health"))
        put(store, "telemetry/angular", pair[0]); put(store, "telemetry/angular", pair[0]); put(store, "telemetry/angular", pair[1])
        self.assertNotEqual(observation(store.snapshot(NOW), "telemetry/angular")["status"], "FRESH")
        for flags in (0, 30, 32):
            store = RdfNodeV2Telemetry(NODE)
            for chunk in chunks(angular_frame(flags=flags), (384, 384)):
                put(store, "telemetry/angular", chunk)
            self.assertEqual(observation(store.snapshot(NOW), "telemetry/angular")["status"], "INVALID")

    def test_angular_rejects_corrupt_invalid_q16_and_bad_u8_headers(self) -> None:
        frame = angular_frame(samples=struct.pack("<h", -32768) + struct.pack("<359h", *([1] * 359)))
        store = RdfNodeV2Telemetry(NODE)
        for chunk in chunks(frame, (384, 384)):
            put(store, "telemetry/angular", chunk)
        self.assertEqual(observation(store.snapshot(NOW), "telemetry/angular")["status"], "INVALID")
        for altered in (b"BAD!" + angular_frame()[4:], angular_frame(count=359), angular_frame(encoding=3)):
            store = RdfNodeV2Telemetry(NODE)
            for chunk in chunks(altered, (384, 384)):
                put(store, "telemetry/angular", chunk)
            self.assertEqual(observation(store.snapshot(NOW), "telemetry/angular")["status"], "INVALID")

    def test_angular_two_pending_limit_and_three_second_expiry(self) -> None:
        store = RdfNodeV2Telemetry(NODE)
        put(store, "telemetry/health", obj("telemetry/health"))
        frames = [chunks(angular_frame(q=q), (384, 384)) for q in (1, 2, 3)]
        for frame in frames:
            put(store, "telemetry/angular", frame[0])
        put(store, "telemetry/angular", frames[0][1], at=NOW + 1)
        self.assertNotEqual(observation(store.snapshot(NOW + 1), "telemetry/angular")["status"], "FRESH")
        store = RdfNodeV2Telemetry(NODE)
        pair = chunks(angular_frame(), (384, 384))
        put(store, "telemetry/angular", pair[0])
        self.assertNotEqual(observation(store.snapshot(NOW + 3000), "telemetry/angular")["status"], "FRESH")
        put(store, "telemetry/angular", pair[1], at=NOW + 3001)
        self.assertNotEqual(observation(store.snapshot(NOW + 3001), "telemetry/angular")["status"], "FRESH")

    def test_angular_age_health_session_and_revision_gates(self) -> None:
        for delta, status in ((10000, "FRESH"), (10001, "STALE")):
            store = RdfNodeV2Telemetry(NODE)
            put(store, "telemetry/health", obj("telemetry/health", q=delta + 1, t=NOW + delta), at=NOW + delta)
            frame = angular_frame(timestamp=NOW)
            for chunk in chunks(frame, (384, 384)):
                put(store, "telemetry/angular", chunk, at=NOW + delta)
            self.assertEqual(observation(store.snapshot(NOW + delta), "telemetry/angular")["status"], status)
        for changes in ({"sid": 1}, {"revision": 8}):
            store = RdfNodeV2Telemetry(NODE)
            put(store, "telemetry/health", obj("telemetry/health"))
            frame = angular_frame(sid=1 if "sid" in changes else 0x7A8B9C0D, revision=changes.get("revision", 7))
            for chunk in chunks(frame, (384, 384)):
                put(store, "telemetry/angular", chunk)
            self.assertNotEqual(observation(store.snapshot(NOW), "telemetry/angular")["status"], "FRESH")

    def test_angular_requires_known_non_null_matching_revision(self) -> None:
        for health_revision, frame_revision in ((None, 0xffffffff), (7, 0xffffffff), (None, 7)):
            store = RdfNodeV2Telemetry(NODE)
            put(store, "telemetry/health", obj("telemetry/health", rev=health_revision))
            for chunk in chunks(angular_frame(revision=frame_revision), (384, 384)):
                put(store, "telemetry/angular", chunk)
            entry = observation(store.snapshot(NOW), "telemetry/angular")
            with self.subTest(health_revision=health_revision, frame_revision=frame_revision):
                self.assertEqual(entry["status"], "INCONSISTENT")
                self.assertEqual(entry["error"], "REVISION_MISMATCH")
    def test_angular_rejects_javascript_unsafe_timestamps(self) -> None:
        store = RdfNodeV2Telemetry(NODE)
        put(store, "telemetry/health", obj("telemetry/health"))
        frame = angular_frame(timestamp=1 << 53)
        for chunk in chunks(frame, (384, 384)):
            put(store, "telemetry/angular", chunk)
        entry = observation(store.snapshot(NOW), "telemetry/angular")
        self.assertEqual(entry["status"], "INVALID")
        self.assertIsNone(entry["payload"])



    def test_diagnostic_doa_validates_selected_fields_and_broker_policy(self) -> None:
        invalid_fields = (
            ("v", 3), ("sid", "bad"), ("q", -1), ("q", 1 << 32),
            ("source", "doa.csv"), ("source_timestamp_ms", 0),
            ("source_timestamp_ms", 1 << 53), ("observed_timestamp_ms", True),
            ("observed_timestamp_ms", 1 << 53), ("raw_doa_deg", True),
            ("raw_doa_deg", float("nan")), ("raw_doa_deg", 1 << 53),
            ("frequency_mhz", False), ("frequency_mhz", float("inf")),
            ("trust", "VERIFIED"), ("validation_reasons", []),
            ("validation_reasons", ["lowercase"]), ("validation_reasons", ["R" * 65]),
            ("validation_reasons", ["VALID"] * 33),
        )
        for field, value in invalid_fields:
            with self.subTest(field=field, value=str(value)[:20]):
                store = RdfNodeV2Telemetry(NODE)
                put(store, "telemetry/diagnostic/doa", obj("telemetry/diagnostic/doa", **{field: value}))
                entry = observation(store.snapshot(NOW), "telemetry/diagnostic/doa")
                self.assertEqual(entry["status"], "INVALID")
                self.assertIsNone(entry["payload"])

        for qos, retained in ((1, False), (0, True)):
            with self.subTest(qos=qos, retained=retained):
                store = RdfNodeV2Telemetry(NODE)
                put(store, "telemetry/diagnostic/doa", obj("telemetry/diagnostic/doa"),
                    qos=qos, retained=retained)
                self.assertEqual(
                    observation(store.snapshot(NOW), "telemetry/diagnostic/doa")["status"],
                    "INVALID",
                )

        store = RdfNodeV2Telemetry(NODE)
        put(store, "telemetry/diagnostic/doa", b" " * 16385)
        oversized = observation(store.snapshot(NOW), "telemetry/diagnostic/doa")
        self.assertEqual(oversized["status"], "INVALID")
        self.assertEqual(oversized["error"], "PAYLOAD_TOO_LARGE")

    def test_diagnostic_doa_freshness_uses_receive_and_source_age_boundaries(self) -> None:
        for delta, expected_status in ((3000, "FRESH"), (3001, "STALE")):
            store = RdfNodeV2Telemetry(NODE)
            put(store, "telemetry/diagnostic/doa",
                obj("telemetry/diagnostic/doa", source_timestamp_ms=NOW),
                at=NOW)
            self.assertEqual(
                observation(store.snapshot(NOW + delta), "telemetry/diagnostic/doa")["status"],
                expected_status,
            )

        for delta, expected_status in ((5000, "FRESH"), (5001, "STALE")):
            store = RdfNodeV2Telemetry(NODE)
            put(store, "telemetry/diagnostic/doa",
                obj("telemetry/diagnostic/doa", source_timestamp_ms=NOW),
                at=NOW + delta)
            self.assertEqual(
                observation(store.snapshot(NOW + delta), "telemetry/diagnostic/doa")["status"],
                expected_status,
            )

        for received_at_ms, source_timestamp_ms in ((NOW, NOW + 1), (NOW + 1, NOW)):
            store = RdfNodeV2Telemetry(NODE)
            put(store, "telemetry/diagnostic/doa",
                obj("telemetry/diagnostic/doa", source_timestamp_ms=source_timestamp_ms),
                at=received_at_ms)
            self.assertEqual(
                observation(store.snapshot(NOW), "telemetry/diagnostic/doa")["status"],
                "STALE",
            )

    def test_diagnostic_doa_does_not_seed_live_session_or_sequence(self) -> None:
        put(self.store, "telemetry/diagnostic/doa",
            obj("telemetry/diagnostic/doa", sid="01020304", q=0xffffffff))
        put(self.store, "telemetry/health", obj("telemetry/health", q=1))
        put(self.store, "telemetry/doa", obj("telemetry/doa", q=1))

        self.assertEqual(
            observation(self.store.snapshot(NOW), "telemetry/doa")["status"],
            "FRESH",
        )

    def test_diagnostic_angular_accepts_flag_subsets_and_derives_missing_evidence(self) -> None:
        store = RdfNodeV2Telemetry(NODE)
        frame = angular_frame(flags=3, q=44)
        for chunk in chunks(frame, (384, 384)):
            put(store, "telemetry/diagnostic/angular", chunk)
        entry = observation(store.snapshot(NOW), "telemetry/diagnostic/angular")
        self.assertEqual(entry["status"], "FRESH")
        candidate = entry["payload"]
        self.assertEqual(candidate["trust"], "UNVERIFIED")
        self.assertEqual(candidate["source_timestamp_ms"], NOW)
        self.assertEqual(candidate["flags"], 3)
        self.assertEqual(len(candidate["values"]), 360)
        self.assertEqual(candidate["validation_reasons"], [
            "DIAGNOSTIC_UNVERIFIED",
            "DAQ_UNVERIFIED",
            "ANGLE_CONVENTION_UNVERIFIED",
            "CONFIG_ATTRIBUTION_UNVERIFIED",
        ])

        complete = RdfNodeV2Telemetry(NODE)
        for chunk in chunks(angular_frame(flags=31, q=45), (384, 384)):
            put(complete, "telemetry/diagnostic/angular", chunk)
        self.assertEqual(
            observation(complete.snapshot(NOW), "telemetry/diagnostic/angular")["payload"]["validation_reasons"],
            ["DIAGNOSTIC_UNVERIFIED"],
        )

        missing_clock = RdfNodeV2Telemetry(NODE)
        for chunk in chunks(angular_frame(flags=1, q=46), (384, 384)):
            put(missing_clock, "telemetry/diagnostic/angular", chunk)
        stale = observation(missing_clock.snapshot(NOW), "telemetry/diagnostic/angular")
        self.assertEqual(stale["status"], "STALE")
        self.assertIn("CLOCK_FRESHNESS_UNVERIFIED", stale["payload"]["validation_reasons"])

        for delta, expected_status in ((3000, "FRESH"), (3001, "STALE")):
            store = RdfNodeV2Telemetry(NODE)
            frame = angular_frame(flags=31, q=50 + delta, timestamp=NOW)
            for chunk in chunks(frame, (384, 384)):
                put(store, "telemetry/diagnostic/angular", chunk, at=NOW)
            self.assertEqual(
                observation(store.snapshot(NOW + delta), "telemetry/diagnostic/angular")["status"],
                expected_status,
            )

        for delta, expected_status in ((10000, "FRESH"), (10001, "STALE")):
            store = RdfNodeV2Telemetry(NODE)
            frame = angular_frame(flags=31, q=60 + delta, timestamp=NOW - delta)
            for chunk in chunks(frame, (384, 384)):
                put(store, "telemetry/diagnostic/angular", chunk, at=NOW)
            self.assertEqual(
                observation(store.snapshot(NOW), "telemetry/diagnostic/angular")["status"],
                expected_status,
            )

        future = RdfNodeV2Telemetry(NODE)
        for chunk in chunks(angular_frame(flags=31, q=99, timestamp=NOW + 1), (384, 384)):
            put(future, "telemetry/diagnostic/angular", chunk)
        self.assertEqual(
            observation(future.snapshot(NOW), "telemetry/diagnostic/angular")["status"],
            "STALE",
        )

    def test_diagnostic_angular_rejects_reserved_flags_and_header_mismatch(self) -> None:
        invalid_chunks = (
            chunks(angular_frame(flags=32, q=70), (384, 384)),
            chunks(angular_frame(q=71), (384, 384), q=72),
            chunks(angular_frame(q=73), (384, 384), sid=0x01020304),
            chunks(angular_frame(samples=struct.pack("<h", -32768) + struct.pack("<359h", *([1] * 359))),
                   (384, 384)),
        )
        for pair in invalid_chunks:
            with self.subTest(first_chunk=pair[0][:16]):
                store = RdfNodeV2Telemetry(NODE)
                for chunk in pair:
                    put(store, "telemetry/diagnostic/angular", chunk)
                entry = observation(store.snapshot(NOW), "telemetry/diagnostic/angular")
                self.assertEqual(entry["status"], "INVALID")
                self.assertIsNone(entry["payload"])

        duplicate = RdfNodeV2Telemetry(NODE)
        pair = chunks(angular_frame(q=74), (384, 384))
        put(duplicate, "telemetry/diagnostic/angular", pair[0])
        put(duplicate, "telemetry/diagnostic/angular", pair[0])
        self.assertEqual(
            observation(duplicate.snapshot(NOW), "telemetry/diagnostic/angular")["status"],
            "INVALID",
        )

        oversized = RdfNodeV2Telemetry(NODE)
        put(oversized, "telemetry/diagnostic/angular", chunks(angular_frame(q=75), (384, 384))[0] + b"x" * 25)
        self.assertEqual(
            observation(oversized.snapshot(NOW), "telemetry/diagnostic/angular")["status"],
            "INVALID",
        )

    def test_diagnostic_angular_assembly_obeys_global_bound_and_deadline(self) -> None:
        store = RdfNodeV2Telemetry(NODE)
        live = chunks(angular_frame(q=80), (384, 384))
        diag_2 = chunks(angular_frame(q=81), (384, 384))
        diag_3 = chunks(angular_frame(q=82), (384, 384))
        put(store, "telemetry/angular", live[0], at=NOW)
        put(store, "telemetry/diagnostic/angular", diag_2[0], at=NOW + 1)
        put(store, "telemetry/diagnostic/angular", diag_3[0], at=NOW + 2)
        for chunk in diag_2[1:]:
            put(store, "telemetry/diagnostic/angular", chunk, at=NOW + 3)
        self.assertNotEqual(
            observation(store.snapshot(NOW + 3), "telemetry/angular")["status"],
            "FRESH",
        )
        self.assertEqual(
            observation(store.snapshot(NOW + 3), "telemetry/diagnostic/angular")["payload"]["q"],
            81,
        )

        expired = RdfNodeV2Telemetry(NODE)
        pair = chunks(angular_frame(q=83), (384, 384))
        put(expired, "telemetry/diagnostic/angular", pair[0], at=NOW)
        put(expired, "telemetry/diagnostic/angular", pair[1], at=NOW + 3001)
        self.assertNotEqual(
            observation(expired.snapshot(NOW + 3001), "telemetry/diagnostic/angular")["status"],
            "FRESH",
        )

    def test_diagnostic_and_live_angular_assemblies_do_not_collide(self) -> None:
        store = RdfNodeV2Telemetry(NODE)
        put(store, "telemetry/health", obj("telemetry/health", q=45))
        frame = angular_frame(q=45)
        pair = chunks(frame, (384, 384))
        put(store, "telemetry/angular", pair[0])
        put(store, "telemetry/diagnostic/angular", pair[1])
        self.assertNotEqual(observation(store.snapshot(NOW), "telemetry/angular")["status"], "FRESH")
        self.assertNotEqual(
            observation(store.snapshot(NOW), "telemetry/diagnostic/angular")["status"],
            "FRESH",
        )

        put(store, "telemetry/diagnostic/angular", pair[0])
        self.assertEqual(
            observation(store.snapshot(NOW), "telemetry/diagnostic/angular")["status"],
            "FRESH",
        )
        self.assertNotEqual(observation(store.snapshot(NOW), "telemetry/angular")["status"], "FRESH")
        put(store, "telemetry/angular", pair[1])
        self.assertEqual(observation(store.snapshot(NOW), "telemetry/angular")["status"], "FRESH")


if __name__ == "__main__":
    unittest.main()
