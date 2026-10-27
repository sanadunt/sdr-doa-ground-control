#!/usr/bin/env python3
"""Kontrol's RDF Node commands: envelope, field rules and command states.

``tools/fixtures/rdf-node/commands.json`` was written by
``tools/fixtures/rdf-node/make_fixtures.py --set commands``: every
``config.get`` and ``config.patch`` envelope in it was built by
``rdf_node_commands`` and handed to the RDF Node edge's own
``CommandManager.submit`` (commit 8691ad0) on the topic the console publishes
to, with the edge's root helper writing a scratch ``settings.json``; the ACKs
and settings report are what the edge answered. These tests rebuild each
envelope from the same inputs and require the same bytes, so a change to the
builder fails here until the edge has judged the new envelope again (the
console never imports edge code). They also check that every case the console
refuses itself is one the edge refused for the same reason, and drive the
command tracker with the edge's real ACKs.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from typing import Any, Dict

TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import rdf_node_commands as cmds  # noqa: E402
from config_command_tracker import (  # noqa: E402
    FINAL_ACK_STATUSES,
    FINAL_ACK_WAIT_MS,
    MAX_TRACKED_COMMANDS,
    NO_ACK_GRACE_MS,
    SETTINGS_REPORT_WAIT_MS,
    ConfigCommandTracker,
)
from rdf_node_mqtt_v2 import ACK_FINAL_STATUSES, RdfNodeV2Telemetry  # noqa: E402

FIXTURES = TOOLS_DIR / "fixtures" / "rdf-node"
COMMANDS = json.loads((FIXTURES / "commands.json").read_text(encoding="utf-8"))
CASES = {case["name"]: case for case in COMMANDS["cases"]}
NODE = COMMANDS["node_id"]
STATE = json.loads(COMMANDS["session"]["state"])
SESSION = {"sid": STATE["sid"], "boot": STATE["boot"]}


def rebuild(case: Dict[str, Any]) -> bytes:
    """The envelope ``rdf_node_commands`` builds from the case's inputs."""
    sent = json.loads(case["console"]["payload"])
    changes = cmds.validate_patch_changes(case["changes"]) if case["op"] == cmds.OP_CONFIG_PATCH else None
    command = cmds.build_command(
        case["op"], command_id=sent["id"], sid=sent["sid"], boot=sent["boot"], base_rev=sent["base_rev"],
        issued_ms=sent["issued_ms"], changes=changes,
    )
    cmds.validate_command(command, now_ms=sent["issued_ms"])
    return cmds.encode_command(command)


class EdgeJudgedEnvelopeTests(unittest.TestCase):
    def test_fixture_comes_from_the_installed_edge_release(self) -> None:
        self.assertEqual(COMMANDS["edge_commit"], "8691ad0")
        self.assertEqual(NODE, "uav-01")
        self.assertGreaterEqual(len(CASES), 15)

    def test_every_envelope_the_console_sends_is_the_one_the_edge_judged(self) -> None:
        accepted = [case for case in COMMANDS["cases"] if case["console"]["accepted"]]
        self.assertEqual({case["op"] for case in accepted}, {cmds.OP_CONFIG_GET, cmds.OP_CONFIG_PATCH})
        for case in accepted:
            with self.subTest(case=case["name"]):
                self.assertEqual(rebuild(case), case["console"]["payload"].encode("utf-8"))
                self.assertEqual(case["console"]["topic"], cmds.command_topic(NODE, case["op"]))
                self.assertEqual((case["console"]["qos"], case["console"]["retain"]), (1, False))
                sent = json.loads(case["console"]["payload"])
                self.assertEqual(sent["expires_ms"] - sent["issued_ms"], cmds.COMMAND_TTL_MS)
                self.assertEqual((sent["sid"], sent["boot"]), (SESSION["sid"], SESSION["boot"]))

    def test_the_edge_accepted_what_the_console_accepts(self) -> None:
        expected = {
            "config-get": ("APPLIED", None),
            "config-get-tls-off": ("REJECTED", "TLS_REQUIRED_FOR_SETTINGS_REPORT"),
            "retune": ("APPLIED", None),
            "gain": ("APPLIED", None),
            "vfo-only": ("APPLIED", None),
            "bandwidth-squelch": ("PERSISTED_UNVERIFIED", None),
            # The console's own base_rev check would refuse it; the edge does too.
            "stale-base-rev": ("REJECTED", "CONFIG_REVISION_CONFLICT"),
        }
        for name, (status, error) in expected.items():
            with self.subTest(case=name):
                case = CASES[name]
                self.assertIs(case["console"]["accepted"], True)
                final = json.loads(case["edge"]["acks"][-1]["payload"])
                self.assertEqual((final["status"], final["result"].get("error")), (status, error))
                for ack in case["edge"]["acks"]:
                    self.assertEqual((ack["qos"], ack["retain"], ack["expiry_s"]), (1, False, 30))
                    self.assertEqual(json.loads(ack["payload"])["id"], json.loads(case["console"]["payload"])["id"])
        retune = json.loads(CASES["retune"]["edge"]["acks"][-1]["payload"])
        self.assertEqual(retune["result"]["proof"], {
            "center_frequency_hz": "FRESH_DAQ_RF_CENTER", "vfo0_frequency_hz": "FRESH_DOA_FREQUENCY",
        })
        # A patch is ACCEPTED first; APPLYING and VERIFYING stay in the edge's journal.
        self.assertEqual(
            [json.loads(ack["payload"])["status"] for ack in CASES["retune"]["edge"]["acks"]], ["ACCEPTED", "APPLIED"],
        )
        report = json.loads(CASES["config-get"]["edge"]["settings_reported"])
        self.assertEqual(report["id"], json.loads(CASES["config-get"]["console"]["payload"])["id"])
        self.assertIsNone(CASES["config-get-tls-off"]["edge"]["settings_reported"])

    def test_cases_the_console_refuses_are_refused_by_the_edge_for_the_same_rule(self) -> None:
        # The console's code, then what the edge's helper or submit() answered.
        expected = {
            "center-without-vfo0": ("CENTER_CHANGE_REQUIRES_VFO0_TARGET", "FAILED", "CENTER_CHANGE_REQUIRES_VFO0_TARGET"),
            "center-not-vfo0": ("MVP_CENTER_MUST_EQUAL_VFO0", "FAILED", "MVP_CENTER_MUST_EQUAL_VFO0"),
            "gain-not-in-table": ("GAIN_NOT_IN_APPROVED_TABLE", "FAILED", "GAIN_NOT_IN_APPROVED_TABLE"),
            "frequency-too-high": ("VALUE_OUT_OF_RANGE", "FAILED", "INTEGER_OUT_OF_RANGE"),
            "frequency-fraction": ("VALUE_OUT_OF_RANGE", "FAILED", "INTEGER_OUT_OF_RANGE"),
            "bandwidth-too-wide": ("VALUE_OUT_OF_RANGE", "FAILED", "INTEGER_OUT_OF_RANGE"),
            "squelch-too-high": ("VALUE_OUT_OF_RANGE", "FAILED", "NUMBER_OUT_OF_RANGE"),
            "old-field-name": ("FIELD_NOT_ALLOWED", "REJECTED", "INVALID_PATCH"),
        }
        refused = {case["name"] for case in COMMANDS["cases"] if not case["console"]["accepted"]}
        self.assertEqual(refused, set(expected))
        for name, (code, status, error) in expected.items():
            with self.subTest(case=name):
                case = CASES[name]
                with self.assertRaises(cmds.CommandRefused) as raised:
                    cmds.validate_patch_changes(case["changes"])
                self.assertEqual(raised.exception.code, code)
                self.assertEqual(case["console"]["code"], code)
                final = json.loads(case["edge"]["acks"][-1]["payload"])
                self.assertEqual((final["status"], final["result"].get("error")), (status, error))


class EnvelopeTests(unittest.TestCase):
    def command(self, op: str = cmds.OP_CONFIG_PATCH, **overrides: Any) -> Dict[str, Any]:
        command = cmds.build_command(
            op, command_id="gc-" + "0" * 24, sid=SESSION["sid"], boot=SESSION["boot"], base_rev=7,
            issued_ms=1_790_000_000_000, changes={"gain_db": 20.7} if op == cmds.OP_CONFIG_PATCH else None,
        )
        command.update(overrides)
        return command

    def test_envelope_fields_order_and_lifetime(self) -> None:
        patch_command = self.command()
        self.assertEqual(list(patch_command), ["v", "id", "sid", "boot", "issued_ms", "expires_ms", "base_rev", "op", "changes"])
        self.assertEqual(patch_command["expires_ms"] - patch_command["issued_ms"], 15_000)
        get_command = self.command(cmds.OP_CONFIG_GET)
        self.assertNotIn("changes", get_command)
        self.assertEqual(cmds.validate_command(get_command, now_ms=1_790_000_000_000), get_command)
        self.assertEqual(
            cmds.encode_command(get_command),
            b'{"v":2,"id":"gc-000000000000000000000000","sid":"' + SESSION["sid"].encode() + b'","boot":"'
            + SESSION["boot"].encode() + b'","issued_ms":1790000000000,"expires_ms":1790000015000,"base_rev":7,"op":"config.get"}',
        )
        self.assertEqual(cmds.command_topic("uav-01", cmds.OP_CONFIG_PATCH), "sdr/v2/uav-01/cmd/config/patch")
        self.assertEqual(cmds.command_topic("uav-01", cmds.OP_CONFIG_GET), "sdr/v2/uav-01/cmd/config/get")
        for bad in ("", "a/b", "+", "#", ".."):
            with self.assertRaises(ValueError):
                cmds.command_topic(bad, cmds.OP_CONFIG_GET)
        with self.assertRaises(ValueError):
            cmds.command_topic("uav-01", "stream.set")
        self.assertRegex(cmds.new_command_id(), r"^gc-[0-9a-f]{24}$")

    def test_envelope_checks_follow_the_edge(self) -> None:
        now = 1_790_000_000_000
        bad = [
            self.command(v=1),
            self.command(v=True),
            self.command(id="bad id"),
            self.command(id="x" * 81),
            self.command(sid="7A8B9C0D"),
            self.command(sid=None),
            self.command(boot=""),
            self.command(boot=None),
            self.command(op="stream.set"),
            self.command(expires_ms=now + 30_001),
            self.command(expires_ms=now),
            self.command(issued_ms=now + 0.5),
            self.command(base_rev=-1),
            self.command(base_rev="7"),
            self.command(base_rev=None),
            self.command(extra=1),
            self.command(changes={"gain_db": 20.0}),
            self.command(changes={"vfo0_frequency_hz": 434000000.0}),
            {key: value for key, value in self.command().items() if key != "changes"},
            dict(self.command(cmds.OP_CONFIG_GET), changes={}),
        ]
        for command in bad:
            with self.subTest(command=command), self.assertRaises(cmds.CommandRefused):
                cmds.validate_command(command, now_ms=now)
        # A config.get may name a node without a revision yet; a patch may not.
        cmds.validate_command(self.command(cmds.OP_CONFIG_GET, base_rev=None), now_ms=now)
        # The deadline is checked against the clock that is given.
        with self.assertRaises(cmds.CommandRefused):
            cmds.validate_command(self.command(), now_ms=now + 15_000)
        with self.assertRaises(cmds.CommandRefused):
            cmds.validate_command(self.command(), now_ms=now - 1_001)
        cmds.validate_command(self.command(), now_ms=now - 1_000)

    def test_field_rules_and_normalization(self) -> None:
        self.assertEqual(
            cmds.validate_patch_changes({"vfo0_squelch_db": -70, "gain_db": 20.7004, "center_frequency_hz": 434e6,
                                         "vfo0_frequency_hz": 434000000}),
            {"center_frequency_hz": 434000000, "gain_db": 20.7, "vfo0_frequency_hz": 434000000, "vfo0_squelch_db": -70},
        )
        self.assertEqual(cmds.validate_patch_changes({"vfo0_frequency_hz": 24_000_000}), {"vfo0_frequency_hz": 24_000_000})
        self.assertEqual(cmds.validate_patch_changes({"vfo0_frequency_hz": 1_766_000_000}), {"vfo0_frequency_hz": 1_766_000_000})
        self.assertEqual(cmds.validate_patch_changes({"gain_db": 0}), {"gain_db": 0.0})
        self.assertEqual(cmds.validate_patch_changes({"vfo0_squelch_db": -200}), {"vfo0_squelch_db": -200})
        cases = [
            (None, "INVALID_REQUEST"),
            ([], "INVALID_REQUEST"),
            ({}, "EMPTY_CHANGES"),
            ({"vfo_frequency_hz": 434_000_000}, "FIELD_NOT_ALLOWED"),
            ({"gain_db": 20.7, "en_remote_control": True}, "FIELD_NOT_ALLOWED"),
            ({"vfo0_frequency_hz": 23_999_999}, "VALUE_OUT_OF_RANGE"),
            ({"vfo0_frequency_hz": 1_766_000_001}, "VALUE_OUT_OF_RANGE"),
            ({"vfo0_frequency_hz": 434_000_000.5}, "VALUE_OUT_OF_RANGE"),
            ({"vfo0_frequency_hz": "434000000"}, "VALUE_OUT_OF_RANGE"),
            ({"vfo0_frequency_hz": True}, "VALUE_OUT_OF_RANGE"),
            ({"vfo0_bandwidth_hz": 99}, "VALUE_OUT_OF_RANGE"),
            ({"vfo0_bandwidth_hz": 2_400_001}, "VALUE_OUT_OF_RANGE"),
            ({"vfo0_squelch_db": 50.5}, "VALUE_OUT_OF_RANGE"),
            ({"vfo0_squelch_db": float("nan")}, "VALUE_OUT_OF_RANGE"),
            ({"vfo0_squelch_db": float("inf")}, "VALUE_OUT_OF_RANGE"),
            ({"vfo0_squelch_db": None}, "VALUE_OUT_OF_RANGE"),
            ({"gain_db": 100.5}, "VALUE_OUT_OF_RANGE"),
            ({"gain_db": 20.0}, "GAIN_NOT_IN_APPROVED_TABLE"),
            ({"gain_db": 20.702}, "GAIN_NOT_IN_APPROVED_TABLE"),
            ({"center_frequency_hz": 434_000_000}, "CENTER_CHANGE_REQUIRES_VFO0_TARGET"),
            ({"center_frequency_hz": 434_000_000, "vfo0_frequency_hz": 434_010_000}, "MVP_CENTER_MUST_EQUAL_VFO0"),
        ]
        for changes, code in cases:
            with self.subTest(changes=changes):
                with self.assertRaises(cmds.CommandRefused) as raised:
                    cmds.validate_patch_changes(changes)
                self.assertEqual(raised.exception.code, code)
        with self.assertRaises(cmds.CommandRefused) as raised:
            cmds.validate_patch_changes({"secret": 1, "gain_db": 20.7})
        self.assertEqual(raised.exception.extra["fields"], ["secret"])
        self.assertEqual(cmds.ranges_view(), {
            "center_frequency_hz": [24_000_000, 1_766_000_000],
            "gain_db": [-10, 100],
            "vfo0_frequency_hz": [24_000_000, 1_766_000_000],
            "vfo0_bandwidth_hz": [100, 2_400_000],
            "vfo0_squelch_db": [-200, 50],
        })
        self.assertEqual(len(cmds.GAIN_TABLE_DB), 29)


class FakeObservingMonitor:
    """Feeds the edge's ACKs through the real store, as the MQTT monitor does."""

    def __init__(self) -> None:
        self.store = RdfNodeV2Telemetry(NODE)
        self.store.on_accepted = self.accepted
        self.records: Dict[str, Dict[str, Any]] = {}
        self.clock = STATE["t"]
        self.store.ingest(f"sdr/v2/{NODE}/state", COMMANDS["session"]["state"].encode(), qos=1, retained=True,
                          received_at_ms=self.clock)

    def published(self, command_id: str) -> None:
        self.records[command_id] = {"puback": None, "progress": None, "final": None, "reported_at_ms": None}

    def accepted(self, suffix: str, record: Dict[str, Any]) -> None:
        entry = self.records.get(record["id"])
        if entry is None:
            return
        if suffix == "settings/reported":
            entry["reported_at_ms"] = entry["reported_at_ms"] or record["received_at_ms"]
        elif record["status"] in FINAL_ACK_STATUSES:
            entry["final"] = entry["final"] or record
        elif entry["final"] is None:
            entry["progress"] = record

    def deliver(self, suffix: str, payload: str) -> None:
        self.store.ingest(f"sdr/v2/{NODE}/{suffix}", payload.encode("utf-8"), qos=1, retained=False,
                          received_at_ms=self.clock)

    def rdf_node_command_observation(self, command_id: str) -> Dict[str, Any]:
        return dict(self.records.get(command_id) or {"puback": None, "progress": None, "final": None, "reported_at_ms": None})


class TrackerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.monitor = FakeObservingMonitor()
        self.clock = [STATE["t"]]
        self.tracker = ConfigCommandTracker(clock_ms=lambda: self.clock[0])

    def send(self, name: str) -> Dict[str, Any]:
        case = CASES[name]
        command = json.loads(case["console"]["payload"])
        self.monitor.published(command["id"])
        self.tracker.record(command, self.monitor, topic=case["console"]["topic"], published_at_ms=command["issued_ms"])
        self.clock[0] = command["issued_ms"]
        return command

    def status(self, command_id: str) -> Dict[str, Any]:
        result = self.tracker.status(command_id, self.monitor)
        assert result is not None
        return result

    def test_edge_acks_of_a_patch_drive_the_states(self) -> None:
        command = self.send("retune")
        first = self.status(command["id"])
        self.assertEqual((first["state"], first["final"], first["op"]), ("published", False, "config.patch"))
        self.assertEqual(first["topic"], "sdr/v2/uav-01/cmd/config/patch")
        self.assertEqual((first["base_rev"], first["changes"]), (command["base_rev"], command["changes"]))
        self.monitor.records[command["id"]]["puback"] = {"reason": 0, "received_at_ms": 1}
        self.assertEqual(self.status(command["id"])["state"], "delivered")
        accepted, applied = CASES["retune"]["edge"]["acks"]
        self.monitor.deliver("ack/config", accepted["payload"])
        progress = self.status(command["id"])
        self.assertEqual((progress["state"], progress["ack"]["status"], progress["ack"]["final"]),
                         ("acknowledged", "ACCEPTED", False))
        # While the edge verifies, the command stays in flight past its own expiry.
        self.clock[0] = command["expires_ms"] + NO_ACK_GRACE_MS + 1
        self.assertEqual(self.tracker.in_flight(self.monitor), command["id"])
        self.monitor.deliver("ack/config", applied["payload"])
        done = self.status(command["id"])
        self.assertEqual((done["state"], done["final"]), ("acked", True))
        self.assertEqual(done["ack"], {
            "status": "APPLIED", "final": True, "error": None, "reason": None, "revision": 2,
            "proof": {"center_frequency_hz": "FRESH_DAQ_RF_CENTER", "vfo0_frequency_hz": "FRESH_DOA_FREQUENCY"},
            "persisted": True, "t": json.loads(applied["payload"])["t"], "received_at_ms": self.monitor.clock,
        })
        self.assertIsNone(self.tracker.in_flight(self.monitor))

    def test_every_final_status_is_final_and_keeps_its_error_and_reason(self) -> None:
        self.assertEqual(FINAL_ACK_STATUSES, ACK_FINAL_STATUSES)
        command = self.send("gain")
        accepted = json.loads(CASES["gain"]["edge"]["acks"][0]["payload"])
        statuses = {
            "APPLIED": {"revision": 3, "proof": {"gain_db": "FRESH_DAQ_GAIN"}, "persisted": True},
            "PERSISTED_UNVERIFIED": {"revision": 3, "persisted": True, "proof": {}, "reason": "NATIVE_RUNTIME_EVIDENCE_INCOMPLETE"},
            "OUTCOME_UNKNOWN": {"error": "OSERROR"},
            "REJECTED": {"error": "CONFIG_REVISION_CONFLICT"},
            "CONFLICT": {"error": "COMMAND_ID_CONFLICT"},
            "EXPIRED": {"error": "EXPIRED_OR_INVALID_DEADLINE"},
            "FAILED": {"error": "GAIN_NOT_IN_APPROVED_TABLE"},
            "CANCELLED": {"reason": "OPERATOR_CANCELLED"},
        }
        self.assertEqual(set(statuses), FINAL_ACK_STATUSES)
        for index, (status, result) in enumerate(sorted(statuses.items())):
            with self.subTest(status=status):
                command_id = f"gc-{index:024x}"
                copy = dict(command, id=command_id)
                self.monitor.published(command_id)
                self.tracker.record(copy, self.monitor, published_at_ms=copy["issued_ms"])
                self.monitor.deliver("ack/config", json.dumps(dict(accepted, id=command_id)))
                self.monitor.deliver("ack/config", json.dumps(dict(accepted, id=command_id, status=status, rev=3, result=result)))
                done = self.status(command_id)
                self.assertEqual((done["state"], done["final"], done["ack"]["status"]), ("acked", True, status))
                self.assertEqual(done["ack"]["error"], result.get("error"))
                self.assertEqual(done["ack"]["reason"], result.get("reason"))
                # A late progress ACK never hides the final answer.
                self.monitor.deliver("ack/config", json.dumps(dict(accepted, id=command_id)))
                self.assertEqual(self.status(command_id)["ack"]["status"], status)

    def test_no_ack_and_no_final_ack(self) -> None:
        command = self.send("gain")
        self.clock[0] = command["expires_ms"] + NO_ACK_GRACE_MS
        self.assertEqual(self.status(command["id"])["state"], "published")
        self.clock[0] += 1
        silent = self.status(command["id"])
        self.assertEqual((silent["state"], silent["final"]), ("no_ack", True))
        self.assertIsNone(self.tracker.in_flight(self.monitor))
        # A late progress ACK does not reopen it; a late final ACK still counts.
        accepted, applied = CASES["gain"]["edge"]["acks"]
        self.monitor.deliver("ack/config", accepted["payload"])
        self.assertEqual(self.status(command["id"])["state"], "no_ack")
        self.monitor.deliver("ack/config", applied["payload"])
        self.assertEqual(self.status(command["id"])["state"], "acked")

        command = self.send("bandwidth-squelch")
        accepted, _final = CASES["bandwidth-squelch"]["edge"]["acks"]
        self.monitor.deliver("ack/config", accepted["payload"])
        self.clock[0] = command["issued_ms"] + FINAL_ACK_WAIT_MS
        self.assertEqual(self.status(command["id"])["state"], "acknowledged")
        self.clock[0] += 1
        lost = self.status(command["id"])
        self.assertEqual((lost["state"], lost["final"], lost["ack"]["status"]), ("no_final_ack", True, "ACCEPTED"))

    def test_config_get_waits_for_its_settings_report(self) -> None:
        command = self.send("config-get")
        self.monitor.store.expect_settings_report(command["id"], self.monitor.clock)
        [applied] = CASES["config-get"]["edge"]["acks"]
        self.monitor.deliver("ack/config", applied["payload"])
        waiting = self.status(command["id"])
        self.assertEqual((waiting["state"], waiting["final"], waiting["ack"]["status"]), ("acknowledged", False, "APPLIED"))
        self.assertEqual(self.tracker.in_flight(self.monitor, "config.get"), command["id"])
        self.assertIsNone(self.tracker.in_flight(self.monitor))
        self.monitor.deliver("settings/reported", CASES["config-get"]["edge"]["settings_reported"])
        reported = self.status(command["id"])
        self.assertEqual((reported["state"], reported["final"]), ("reported", True))
        self.assertEqual(reported["settings_reported_at_ms"], self.monitor.clock)
        self.assertEqual(self.tracker.latest(self.monitor, op="config.get")["command_id"], command["id"])
        self.assertIsNone(self.tracker.latest(self.monitor))

        refused = self.send("config-get-tls-off")
        [rejected] = CASES["config-get-tls-off"]["edge"]["acks"]
        self.monitor.deliver("ack/config", rejected["payload"])
        done = self.status(refused["id"])
        self.assertEqual((done["state"], done["ack"]["error"]), ("acked", "TLS_REQUIRED_FOR_SETTINGS_REPORT"))

        silent_copy = dict(command, id="gc-" + "e" * 24)
        self.monitor.published(silent_copy["id"])
        self.tracker.record(silent_copy, self.monitor, published_at_ms=silent_copy["issued_ms"])
        self.monitor.deliver("ack/config", json.dumps(dict(json.loads(applied["payload"]), id=silent_copy["id"])))
        self.clock[0] = silent_copy["issued_ms"] + SETTINGS_REPORT_WAIT_MS + 1
        self.assertEqual(self.status(silent_copy["id"])["state"], "no_report")

    def test_publish_failures_and_failed_pubacks(self) -> None:
        command = json.loads(CASES["gain"]["console"]["payload"])
        self.tracker.record(command, self.monitor, publish_failed=True)
        self.assertEqual(self.status(command["id"])["state"], "publish_failed")
        other = dict(command, id="gc-" + "f" * 24)
        self.monitor.published(other["id"])
        self.tracker.record(other, self.monitor, published_at_ms=other["issued_ms"])
        self.monitor.records[other["id"]]["puback"] = {"reason": 135, "received_at_ms": 1}
        failed = self.status(other["id"])
        self.assertEqual((failed["state"], failed["puback_reason"]), ("publish_failed", 135))

    def test_tracker_is_bounded(self) -> None:
        tracker = ConfigCommandTracker(clock_ms=lambda: self.clock[0], max_entries=3)
        command = json.loads(CASES["gain"]["console"]["payload"])
        for index in range(5):
            tracker.record(dict(command, id=f"gc-{index:024x}"), self.monitor, published_at_ms=1, publish_failed=True)
        self.assertEqual(tracker.ids(), [f"gc-{index:024x}" for index in (2, 3, 4)])
        self.assertIsNone(tracker.status("gc-" + "0" * 24, self.monitor))

    def test_config_gets_never_push_out_a_pending_patch(self) -> None:
        # A patch the edge ACCEPTED may wait FINAL_ACK_WAIT_MS (90 s) for its
        # final ACK. config.get commands share the bounded list and may come
        # once a second, each final at once (TLS_REQUIRED_FOR_SETTINGS_REPORT
        # on a plaintext link): they must never evict the pending patch.
        patch_command = self.send("gain")
        accepted, applied = CASES["gain"]["edge"]["acks"]
        self.monitor.deliver("ack/config", accepted["payload"])
        get_command = json.loads(CASES["config-get-tls-off"]["console"]["payload"])
        [rejected] = CASES["config-get-tls-off"]["edge"]["acks"]
        gets = []
        for index in range(MAX_TRACKED_COMMANDS + 8):
            self.clock[0] += 1_100
            command_id = f"gc-{0xb0000 + index:024x}"
            self.monitor.published(command_id)
            self.tracker.record(dict(get_command, id=command_id), self.monitor, published_at_ms=self.clock[0])
            self.monitor.deliver("ack/config", json.dumps(dict(json.loads(rejected["payload"]), id=command_id)))
            self.assertTrue(self.status(command_id)["final"])
            gets.append(command_id)
            self.assertEqual(self.tracker.in_flight(self.monitor), patch_command["id"], index)
        self.assertLess(self.clock[0], patch_command["issued_ms"] + FINAL_ACK_WAIT_MS)
        self.assertEqual(len(self.tracker.ids()), MAX_TRACKED_COMMANDS)
        self.assertIn(patch_command["id"], self.tracker.ids())
        self.assertEqual(self.tracker.ids()[1:], gets[-(MAX_TRACKED_COMMANDS - 1):])
        self.assertEqual(self.status(patch_command["id"])["state"], "acknowledged")
        # Once it is final it ages out like any other.
        self.monitor.deliver("ack/config", applied["payload"])
        self.assertEqual(self.status(patch_command["id"])["state"], "acked")
        self.clock[0] += 1_100
        self.monitor.published("gc-" + "a" * 24)
        self.tracker.record(dict(get_command, id="gc-" + "a" * 24), self.monitor, published_at_ms=self.clock[0])
        self.assertNotIn(patch_command["id"], self.tracker.ids())
        self.assertIsNone(self.tracker.in_flight(self.monitor))

    def test_ack_from_another_session_is_never_counted(self) -> None:
        command = self.send("retune")
        accepted, applied = CASES["retune"]["edge"]["acks"]
        foreign = json.loads(applied["payload"])
        foreign["sid"] = "0badc0de" if foreign["sid"] != "0badc0de" else "1badc0de"
        self.monitor.deliver("ack/config", json.dumps(foreign))
        self.assertEqual(self.status(command["id"])["state"], "published")
        self.monitor.deliver("ack/config", accepted["payload"])
        self.assertEqual(self.status(command["id"])["state"], "acknowledged")


if __name__ == "__main__":
    unittest.main()
