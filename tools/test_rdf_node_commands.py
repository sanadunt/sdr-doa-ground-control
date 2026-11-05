#!/usr/bin/env python3
"""Kontrol's RDF Node commands: envelope, field rules and command states.

``tools/fixtures/rdf-node/commands.<commit>.json`` were written by
``tools/fixtures/rdf-node/make_fixtures.py --set commands``: every
``config.get`` and ``config.patch`` envelope in them was built by
``rdf_node_commands`` and handed to the RDF Node edge's own
``CommandManager.submit`` on the topic the console publishes to, with the
edge's root helper writing a scratch ``settings.json``; the ACKs and settings
report are what the edge answered. ``8691ad0`` is the release installed on the
Raspberry, which answers ``config.get`` only over TLS; ``35984d8`` also answers
it over a plaintext link to the primary broker; ``d6946cf`` (1.10.1) retunes a
running engine live (``method`` ``LIVE``) and names its errors (``message``);
``f8f9e52`` (1.10.2) also says when its final ACK leaves (``final_within_ms``).
The console sends the same bytes to all four. These tests rebuild each
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
    FINAL_WITHIN_MARGIN_MS,
    FINAL_WITHIN_MAX_WAIT_MS,
    MAX_TRACKED_COMMANDS,
    NO_ACK_GRACE_MS,
    SETTINGS_REPORT_WAIT_MS,
    RESTART_FINAL_ACK_WAIT_MS,
    ConfigCommandTracker,
    final_ack_deadline,
    public_ack,
)
from rdf_node_mqtt_v2 import ACK_FINAL_STATUSES, RdfNodeV2Telemetry  # noqa: E402

FIXTURES = TOOLS_DIR / "fixtures" / "rdf-node"
EDGE_SETS = {
    commit: json.loads((FIXTURES / f"commands.{commit}.json").read_text(encoding="utf-8"))
    for commit in ("8691ad0", "35984d8", "d6946cf", "f8f9e52")
}
# The installed edge release; the tracker tests below drive its ACKs.
COMMANDS = EDGE_SETS["8691ad0"]
# config.get over a plaintext link to the primary broker, by edge commit.
PLAINTEXT_CONFIG_GET = {
    "8691ad0": ("REJECTED", "TLS_REQUIRED_FOR_SETTINGS_REPORT"),
    "35984d8": ("APPLIED", None),
    "d6946cf": ("APPLIED", None),
    "f8f9e52": ("APPLIED", None),
}
# Bandwidth and squelch: only written before 1.7.0, retuned live since.
BANDWIDTH_SQUELCH = {
    "8691ad0": ("PERSISTED_UNVERIFIED", None),
    "35984d8": ("PERSISTED_UNVERIFIED", None),
    "d6946cf": ("APPLIED", None),
    "f8f9e52": ("APPLIED", None),
}
# An edge that retunes live answers through VERIFYING {method: LIVE} with the
# DAQ's health after the retune as proof.
LIVE_RETUNE = {"d6946cf", "f8f9e52"}
CASES = {case["name"]: case for case in COMMANDS["cases"]}
NODE = COMMANDS["node_id"]
STATE = json.loads(COMMANDS["session"]["state"])
SESSION = {"sid": STATE["sid"], "boot": STATE["boot"]}


def rebuild(case: Dict[str, Any]) -> bytes:
    """The envelope ``rdf_node_commands`` builds from the case's inputs.

    The edge judged these envelopes when the console sent 15 s commands; the lifetime is taken from the
    case, so the bytes stay the ones the edge judged (control.py takes any lifetime up to 30 s).
    """
    sent = json.loads(case["console"]["payload"])
    changes = cmds.validate_patch_changes(case["changes"]) if case["op"] == cmds.OP_CONFIG_PATCH else None
    command = cmds.build_command(
        case["op"], command_id=sent["id"], sid=sent["sid"], boot=sent["boot"], base_rev=sent["base_rev"],
        issued_ms=sent["issued_ms"], changes=changes, ttl_ms=sent["expires_ms"] - sent["issued_ms"],
    )
    cmds.validate_command(command, now_ms=sent["issued_ms"])
    return cmds.encode_command(command)


class EdgeJudgedEnvelopeTests(unittest.TestCase):
    def test_fixtures_come_from_the_installed_release_and_the_newer_edge(self) -> None:
        for commit, fixture in EDGE_SETS.items():
            with self.subTest(edge=commit):
                self.assertEqual(fixture["edge_commit"], commit)
                self.assertEqual(fixture["node_id"], "uav-01")
                self.assertEqual([case["name"] for case in fixture["cases"]], [case["name"] for case in COMMANDS["cases"]])
        self.assertEqual(NODE, "uav-01")
        self.assertGreaterEqual(len(CASES), 15)

    def test_every_envelope_the_console_sends_is_the_one_the_edge_judged(self) -> None:
        for commit, fixture in EDGE_SETS.items():
            state = json.loads(fixture["session"]["state"])
            accepted = [case for case in fixture["cases"] if case["console"]["accepted"]]
            self.assertEqual({case["op"] for case in accepted}, {cmds.OP_CONFIG_GET, cmds.OP_CONFIG_PATCH})
            for case in accepted:
                with self.subTest(edge=commit, case=case["name"]):
                    self.assertEqual(rebuild(case), case["console"]["payload"].encode("utf-8"))
                    self.assertEqual(case["console"]["topic"], cmds.command_topic(NODE, case["op"]))
                    self.assertEqual((case["console"]["qos"], case["console"]["retain"]), (1, False))
                    sent = json.loads(case["console"]["payload"])
                    self.assertLessEqual(sent["expires_ms"] - sent["issued_ms"], cmds.MAX_COMMAND_TTL_MS)
                    self.assertEqual((sent["sid"], sent["boot"]), (state["sid"], state["boot"]))

    def test_the_edge_accepted_what_the_console_accepts(self) -> None:
        for commit, fixture in EDGE_SETS.items():
            cases = {case["name"]: case for case in fixture["cases"]}
            expected = {
                "config-get": ("APPLIED", None),
                "config-get-tls-off": PLAINTEXT_CONFIG_GET[commit],
                "retune": ("APPLIED", None),
                "gain": ("APPLIED", None),
                "vfo-only": ("APPLIED", None),
                "bandwidth-squelch": BANDWIDTH_SQUELCH[commit],
                # The console's own base_rev check would refuse it; the edge does too.
                "stale-base-rev": ("REJECTED", "CONFIG_REVISION_CONFLICT"),
            }
            for name, (status, error) in expected.items():
                with self.subTest(edge=commit, case=name):
                    case = cases[name]
                    self.assertIs(case["console"]["accepted"], True)
                    final = json.loads(case["edge"]["acks"][-1]["payload"])
                    self.assertEqual((final["status"], final["result"].get("error")), (status, error))
                    for ack in case["edge"]["acks"]:
                        self.assertEqual((ack["qos"], ack["retain"], ack["expiry_s"]), (1, False, 30))
                        self.assertEqual(json.loads(ack["payload"])["id"], json.loads(case["console"]["payload"])["id"])
            with self.subTest(edge=commit, case="retune proof"):
                retune = json.loads(cases["retune"]["edge"]["acks"][-1]["payload"])
                statuses = [json.loads(ack["payload"])["status"] for ack in cases["retune"]["edge"]["acks"]]
                if commit in LIVE_RETUNE:
                    self.assertEqual(retune["result"]["method"], "LIVE")
                    self.assertEqual(retune["result"]["proof"], {
                        "daq": "FRESH_HEALTHY_AFTER_RETUNE", "settings": "KEPT_BY_ENGINE",
                        "vfo0_frequency_hz": "FRESH_DOA_FREQUENCY",
                    })
                    self.assertEqual(statuses, ["ACCEPTED", "VERIFYING", "APPLIED"])
                else:
                    self.assertEqual(retune["result"]["proof"], {
                        "center_frequency_hz": "FRESH_DAQ_RF_CENTER", "vfo0_frequency_hz": "FRESH_DOA_FREQUENCY",
                    })
                    # A patch is ACCEPTED first; APPLYING and VERIFYING stay in the edge's journal.
                    self.assertEqual(statuses, ["ACCEPTED", "APPLIED"])
            for name in ("config-get", "config-get-tls-off"):
                with self.subTest(edge=commit, case=name + " report"):
                    raw_report = cases[name]["edge"]["settings_reported"]
                    if PLAINTEXT_CONFIG_GET[commit][0] != "APPLIED" and name == "config-get-tls-off":
                        self.assertIsNone(raw_report)
                        continue
                    report = json.loads(raw_report)
                    self.assertEqual(report["id"], json.loads(cases[name]["console"]["payload"])["id"])
                    self.assertEqual(set(report), {"v", "sid", "boot", "id", "rev", "t", "settings_json"})

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
        for commit, fixture in EDGE_SETS.items():
            cases = {case["name"]: case for case in fixture["cases"]}
            refused = {case["name"] for case in fixture["cases"] if not case["console"]["accepted"]}
            self.assertEqual(refused, set(expected))
            for name, (code, status, error) in expected.items():
                with self.subTest(edge=commit, case=name):
                    case = cases[name]
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
        self.assertEqual(patch_command["expires_ms"] - patch_command["issued_ms"], 30_000)
        # The console takes the whole lifetime the edge accepts (control.py: 0 < expires - issued <= 30 s).
        self.assertEqual(cmds.COMMAND_TTL_MS, cmds.MAX_COMMAND_TTL_MS)
        get_command = self.command(cmds.OP_CONFIG_GET)
        self.assertNotIn("changes", get_command)
        self.assertEqual(cmds.validate_command(get_command, now_ms=1_790_000_000_000), get_command)
        self.assertEqual(
            cmds.encode_command(get_command),
            b'{"v":2,"id":"gc-000000000000000000000000","sid":"' + SESSION["sid"].encode() + b'","boot":"'
            + SESSION["boot"].encode() + b'","issued_ms":1790000000000,"expires_ms":1790000030000,"base_rev":7,"op":"config.get"}',
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
            cmds.validate_command(self.command(), now_ms=now + cmds.COMMAND_TTL_MS)
        with self.assertRaises(cmds.CommandRefused):
            cmds.validate_command(self.command(), now_ms=now - 1_001)
        cmds.validate_command(self.command(), now_ms=now - 1_000)

    def test_operation_envelopes_follow_the_edge(self) -> None:
        # control.py OPS and COMMAND_FIELDS (edge 1.10.2): each op's topic and its own fields only.
        now = 1_790_000_000_000
        topics = {
            "processing.set": "cmd/processing/set", "service.restart": "cmd/service/restart",
            "system.reboot.prepare": "cmd/system/reboot/prepare", "system.reboot.execute": "cmd/system/reboot/execute",
            "system.shutdown.prepare": "cmd/system/shutdown/prepare",
            "system.shutdown.execute": "cmd/system/shutdown/execute",
        }
        self.assertEqual(tuple(topics), cmds.OPERATION_OPS)
        for op, suffix in topics.items():
            self.assertEqual(cmds.command_topic("uav-01", op), f"sdr/v2/uav-01/{suffix}")
        challenge = "g29oKmX_l6mcMunnJBk8MqBy5Ewq501A"
        good = {
            "processing.set": {"desired": "STOPPED"},
            "service.restart": {},
            "system.reboot.prepare": {},
            "system.reboot.execute": {"prepare_id": "gc-" + "1" * 24, "challenge": challenge},
            "system.shutdown.prepare": {},
            "system.shutdown.execute": {"prepare_id": "gc-" + "1" * 24, "challenge": challenge},
        }
        for op, fields in good.items():
            command = cmds.build_command(op, command_id="gc-" + "0" * 24, sid=SESSION["sid"], boot=SESSION["boot"],
                                         base_rev=7, issued_ms=now, **fields)
            self.assertEqual(list(command), list(cmds.ENVELOPE_FIELDS) + list(fields), op)
            self.assertEqual(cmds.validate_command(command, now_ms=now), command)
            # The edge compares base_rev with its own revision; null names a node without one.
            cmds.validate_command(dict(command, base_rev=None), now_ms=now)
            with self.assertRaises(cmds.CommandRefused):
                cmds.validate_command(dict(command, changes={}), now_ms=now)
        base = dict(cmds.build_command("processing.set", command_id="gc-" + "0" * 24, sid=SESSION["sid"],
                                       boot=SESSION["boot"], base_rev=7, issued_ms=now, desired="RUNNING"))
        for desired in ("running", "PAUSED", None, 1):
            with self.assertRaises(cmds.CommandRefused) as refused:
                cmds.validate_command(dict(base, desired=desired), now_ms=now)
            self.assertEqual(refused.exception.code, "INVALID_DESIRED_STATE")
        execute = cmds.build_command("system.reboot.execute", command_id="gc-" + "0" * 24, sid=SESSION["sid"],
                                     boot=SESSION["boot"], base_rev=7, issued_ms=now, prepare_id="gc-1", challenge=challenge)
        for bad in ({"prepare_id": "bad id"}, {"prepare_id": None}, {"challenge": "short"}, {"challenge": None},
                    {"challenge": "has space " + challenge}):
            with self.subTest(bad=bad), self.assertRaises(cmds.CommandRefused):
                cmds.validate_command(dict(execute, **bad), now_ms=now)
        with self.assertRaises(cmds.CommandRefused):
            cmds.validate_command({k: v for k, v in execute.items() if k != "challenge"}, now_ms=now)
        self.assertEqual(cmds.PREPARE_FOR_EXECUTE["system.shutdown.execute"], "system.shutdown.prepare")
        self.assertEqual(cmds.MUTATION_OPS, frozenset(cmds.OPERATION_OPS) | {"config.patch"})
        # The prepare fixture of the edge's own agent: its challenge has the shape the console checks.
        prepared = json.loads((FIXTURES / "ack-operation.reboot-prepare-applied.json").read_text(encoding="utf-8"))
        self.assertRegex(prepared["result"]["challenge"], cmds.CHALLENGE_RE)
        self.assertEqual(prepared["result"]["valid_seconds"], cmds.CHALLENGE_VALID_S)

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
            "ant_spacing_m": [0.05, 1],
        })
        self.assertEqual(len(cmds.GAIN_TABLE_DB), 29)

    def test_uca_spacing_follows_the_edge_rules(self) -> None:
        # Edge 1.8.0 (helper.validate_changes): ant_spacing_m 0.05..1.0 m, rounded to 4 decimals,
        # sent last (source.FIELD_MAP order).
        self.assertEqual(cmds.PATCH_FIELDS[5], "ant_spacing_m")
        self.assertEqual(cmds.LEGACY_PATCH_FIELDS, cmds.PATCH_FIELDS[:5])
        self.assertEqual(cmds.validate_patch_changes({"ant_spacing_m": 0.12804}), {"ant_spacing_m": 0.128})
        self.assertEqual(cmds.validate_patch_changes({"ant_spacing_m": 1}), {"ant_spacing_m": 1.0})
        self.assertEqual(
            list(cmds.validate_patch_changes({"ant_spacing_m": 0.3, "gain_db": 25.4, "center_frequency_hz": 150_000_000,
                                              "vfo0_frequency_hz": 150_000_000})),
            ["center_frequency_hz", "gain_db", "vfo0_frequency_hz", "ant_spacing_m"],
        )
        for value in (0.0499, 1.0001, float("nan"), "0.3", True, None):
            with self.subTest(value=value):
                with self.assertRaises(cmds.CommandRefused) as raised:
                    cmds.validate_patch_changes({"ant_spacing_m": value})
                self.assertEqual(raised.exception.code, "VALUE_OUT_OF_RANGE")
                self.assertIn(" m from 0.05 to 1", raised.exception.message)
        command = cmds.build_command(
            cmds.OP_CONFIG_PATCH, command_id="gc-" + "a" * 24, sid="0123abcd", boot="boot-1", base_rev=4,
            issued_ms=1_000, changes={"ant_spacing_m": 0.128},
        )
        self.assertEqual(cmds.validate_command(command)["changes"], {"ant_spacing_m": 0.128})
        # An unrounded spacing is not the normalized form the console publishes.
        command["changes"] = {"ant_spacing_m": 0.12804}
        with self.assertRaises(cmds.CommandRefused):
            cmds.validate_command(command)

    def test_squelch_mode_and_whole_db_follow_the_edge_rules(self) -> None:
        # Edge 1.9.0: vfo0_squelch_mode is one of the four exact strings, sent last (source.FIELD_MAP
        # order); anything else is SQUELCH_MODE_INVALID (helper.validate_changes, control.py).
        self.assertEqual(cmds.PATCH_FIELDS[-1], "vfo0_squelch_mode")
        self.assertEqual(cmds.SQUELCH_MODES, ("Manual", "Auto", "Auto Channel", "Default"))
        self.assertEqual(cmds.choices_view(), {"vfo0_squelch_mode": ["Manual", "Auto", "Auto Channel", "Default"]})
        self.assertNotIn("vfo0_squelch_mode", cmds.ranges_view())
        for mode in cmds.SQUELCH_MODES:
            self.assertEqual(cmds.validate_patch_changes({"vfo0_squelch_mode": mode}), {"vfo0_squelch_mode": mode})
        for bad in ("auto", "AUTO", "Auto channel", "Auto  Channel", " Manual", "", None, 1, True, ["Auto"]):
            with self.subTest(mode=bad):
                with self.assertRaises(cmds.CommandRefused) as raised:
                    cmds.validate_patch_changes({"vfo0_squelch_mode": bad})
                self.assertEqual(raised.exception.code, "SQUELCH_MODE_INVALID")
                self.assertEqual(raised.exception.extra["choices"], list(cmds.SQUELCH_MODES))
        self.assertEqual(
            list(cmds.validate_patch_changes({"vfo0_squelch_mode": "Manual", "vfo0_squelch_db": -80, "gain_db": 15.7,
                                              "ant_spacing_m": 0.128})),
            ["gain_db", "vfo0_squelch_db", "ant_spacing_m", "vfo0_squelch_mode"],
        )
        # The edge writes the squelch in whole dB and rounds a fraction with Python's round(), never refusing it.
        for value, whole in ((-40.7, -41), (-40.2, -40), (-40.5, -40), (-41.5, -42), (-80, -80), (-80.0, -80),
                             (49.6, 50), (-199.6, -200)):
            with self.subTest(squelch=value):
                normalized = cmds.validate_patch_changes({"vfo0_squelch_db": value})
                self.assertEqual(normalized, {"vfo0_squelch_db": whole})
                self.assertIs(type(normalized["vfo0_squelch_db"]), int)
        # The range is checked before rounding, as finite(val, -200, 50) does on the edge.
        for value in (50.4, -200.4):
            with self.assertRaises(cmds.CommandRefused):
                cmds.validate_patch_changes({"vfo0_squelch_db": value})
        before = ["ant_spacing_m", "center_frequency_hz", "gain_db", "vfo0_bandwidth_hz", "vfo0_frequency_hz",
                  "vfo0_squelch_db"]
        command = cmds.build_command(
            cmds.OP_CONFIG_PATCH, command_id="gc-" + "a" * 24, sid="0123abcd", boot="boot-1", base_rev=4,
            issued_ms=1_000, changes={"vfo0_squelch_db": -80, "vfo0_squelch_mode": "Manual"},
        )
        self.assertEqual(cmds.validate_command(command)["changes"], {"vfo0_squelch_db": -80, "vfo0_squelch_mode": "Manual"})
        self.assertEqual(cmds.encode_command(command).count(b'"vfo0_squelch_mode":"Manual"'), 1)
        # With the squelch mode (edge 1.9.0) a fraction or a float is not the normalized form.
        for changes in ({"vfo0_squelch_db": -40.7, "vfo0_squelch_mode": "Manual"},
                        {"vfo0_squelch_db": -80.0, "vfo0_squelch_mode": "Manual"}):
            command["changes"] = changes
            with self.assertRaises(cmds.CommandRefused):
                cmds.validate_command(command)
        # An older edge keeps the squelch as sent: there it goes out unrounded, as before.
        self.assertEqual(cmds.validate_patch_changes({"vfo0_squelch_db": -40.7}, whole_db=False), {"vfo0_squelch_db": -40.7})
        command["changes"] = {"vfo0_squelch_db": -40.7}
        self.assertEqual(cmds.validate_command(command)["changes"], {"vfo0_squelch_db": -40.7})
        self.assertFalse(cmds.node_writes_whole_db(None))
        self.assertFalse(cmds.node_writes_whole_db(before))
        self.assertTrue(cmds.node_writes_whole_db(sorted(cmds.PATCH_FIELDS)))
        command["changes"] = {"vfo0_squelch_mode": "auto"}
        with self.assertRaises(cmds.CommandRefused) as raised:
            cmds.validate_command(command)
        self.assertEqual(raised.exception.code, "SQUELCH_MODE_INVALID")
        # Edge 1.8.0 lists no squelch mode: a console never sends it there.
        self.assertNotIn("vfo0_squelch_mode", cmds.node_patch_fields(before))
        self.assertNotIn("vfo0_squelch_mode", cmds.node_patch_fields(None))

    def test_the_fields_a_node_takes(self) -> None:
        legacy = cmds.LEGACY_PATCH_FIELDS
        self.assertEqual(cmds.node_patch_fields(None), legacy)
        self.assertEqual(cmds.node_patch_fields([]), legacy)
        self.assertEqual(cmds.node_patch_fields("ant_spacing_m"), legacy)
        # The edge publishes sorted(FIELD_MAP); the console keeps the edge's field order.
        edge = sorted(cmds.PATCH_FIELDS)
        self.assertEqual(cmds.node_patch_fields(edge), cmds.PATCH_FIELDS)
        self.assertEqual(cmds.node_patch_fields(["gain_db", "future_field", 7]), ("gain_db",))


class FakeObservingMonitor:
    """Feeds the edge's ACKs through the real store, as the MQTT monitor does."""

    def __init__(self, fixture: Dict[str, Any] = COMMANDS) -> None:
        self.store = RdfNodeV2Telemetry(NODE)
        self.store.on_accepted = self.accepted
        self.records: Dict[str, Dict[str, Any]] = {}
        self.clock = json.loads(fixture["session"]["state"])["t"]
        self.store.ingest(f"sdr/v2/{NODE}/state", fixture["session"]["state"].encode(), qos=1, retained=True,
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
    def test_the_1_7_stages_carry_their_method_and_reason(self) -> None:
        # The ACKs edge 1.7.0 sent for 105.9 -> 103.1 MHz over LoRa on 2 November.
        stages = [
            ("VERIFYING", {"method": "LIVE", "persisted": True}, ("LIVE", None, None)),
            ("APPLYING", {"method": "RESTART", "reason": "LIVE_FAILED:ENGINE_OVERRODE:gain_db",
                          "changes": {"center_frequency_hz": 103_100_000}},
             ("RESTART", "LIVE_FAILED:ENGINE_OVERRODE:gain_db", None)),
            ("APPLIED", {"method": "RESTART", "reason": "LIVE_FAILED:ENGINE_OVERRODE:gain_db", "persisted": True,
                         "revision": 298, "proof": {"daq": "FRESH_HEALTHY_AFTER_RESTART", "settings": "INTACT_AFTER_START"}},
             ("RESTART", "LIVE_FAILED:ENGINE_OVERRODE:gain_db", None)),
            ("PERSISTED_UNVERIFIED", {"method": "LIVE", "persisted": True, "revision": 9,
                                      "reason": "NATIVE_RUNTIME_EVIDENCE_INCOMPLETE",
                                      "live_failure": "DAQ_NOT_HEALTHY_AFTER_RETUNE"},
             ("LIVE", "NATIVE_RUNTIME_EVIDENCE_INCOMPLETE", "DAQ_NOT_HEALTHY_AFTER_RETUNE")),
        ]
        for status, result, (method, reason, live_failure) in stages:
            with self.subTest(status=status):
                shown = public_ack({"status": status, "t": 1, "rev": 298, "result": result, "received_at_ms": 2})
                self.assertEqual((shown["method"], shown["reason"], shown["live_failure"]), (method, reason, live_failure))
        applied = public_ack({"status": "APPLIED", "t": 1, "rev": 298, "result": stages[2][1], "received_at_ms": 2})
        self.assertEqual(applied["proof"], {"daq": "FRESH_HEALTHY_AFTER_RESTART", "settings": "INTACT_AFTER_START"})
        # The changes of an APPLYING ACK and anything unexpected stay out.
        self.assertNotIn("changes", public_ack({"status": "APPLYING", "result": stages[1][1]}))
        self.assertIsNone(public_ack({"status": "APPLIED", "result": {"method": "X" * 17}})["method"])

    def test_the_edges_text_and_every_overridden_field_reach_kontrol(self) -> None:
        # Three fields: 83 characters, past the 64 of a plain code.
        reason = "LIVE_FAILED:ENGINE_OVERRODE:center_frequency_hz,gain_db,vfo0_frequency_hz"
        shown = public_ack({"status": "APPLYING", "result": {
            "method": "RESTART", "reason": reason, "live_failure": reason[len("LIVE_FAILED:"):], "final_within_ms": 221_000.4,
        }})
        self.assertEqual((shown["reason"], shown["live_failure"], shown["final_within_ms"]),
                         (reason, reason[len("LIVE_FAILED:"):], 221_001))
        self.assertIsNone(public_ack({"status": "APPLIED", "result": {"reason": "X" * 161}})["reason"])
        unknown = public_ack({"status": "OUTCOME_UNKNOWN", "result": {
            "error": "HELPER_CONNECTION_LOST", "message": "Helper root\u0000 tidak menjawab ",
            "detail": "NotADirectoryError: [Errno 20] Not a directory: 'var'", "ignored": ["x", "bad key", 3],
        }})
        self.assertEqual((unknown["error"], unknown["message"], unknown["detail"], unknown["ignored"]),
                         ("HELPER_CONNECTION_LOST", "Helper root tidak menjawab",
                          "NotADirectoryError: [Errno 20] Not a directory: 'var'", ["x"]))
        overrode = public_ack({"status": "PERSISTED_UNVERIFIED", "result": {
            "error": "ENGINE_OVERRODE_AT_START", "fields": ["gain_db", "vfo0_squelch_db", "Not A Field"]}})
        self.assertEqual(overrode["fields"], ["gain_db", "vfo0_squelch_db"])
        empty = public_ack({"status": "APPLIED", "result": {"message": " ", "fields": "gain_db"}})
        self.assertEqual((empty["message"], empty["detail"], empty["fields"], empty["ignored"], empty["final_within_ms"]),
                         (None, None, None, None, None))

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
            "persisted": True, "method": None, "live_failure": None, "band_spacing_m": None, "squelch_mode": None,
            "message": None, "detail": None, "fields": None, "ignored": None, "final_within_ms": None,
            "desired": None, "delay_seconds": None, "valid_seconds": None,
            "t": json.loads(applied["payload"])["t"], "received_at_ms": self.monitor.clock,
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

    def test_a_1_7_restart_gets_its_longer_wait(self) -> None:
        # Once the edge names a live retune or a restart, the start of the SDR
        # engine may take its start timeout (180 s by default) before the final ACK.
        command = self.send("bandwidth-squelch")
        accepted, _final = CASES["bandwidth-squelch"]["edge"]["acks"]
        self.monitor.deliver("ack/config", accepted["payload"])
        stage = dict(json.loads(accepted["payload"]), status="APPLYING",
                     result={"method": "RESTART", "reason": "GAIN_CHANGE", "changes": {}})
        self.monitor.deliver("ack/config", json.dumps(stage))
        self.clock[0] = command["issued_ms"] + FINAL_ACK_WAIT_MS + 1
        waiting = self.status(command["id"])
        self.assertEqual((waiting["state"], waiting["ack"]["method"]), ("acknowledged", "RESTART"))
        self.clock[0] = command["issued_ms"] + RESTART_FINAL_ACK_WAIT_MS
        self.assertEqual(self.status(command["id"])["state"], "acknowledged")
        self.clock[0] += 1
        self.assertEqual(self.status(command["id"])["state"], "no_final_ack")

    def test_a_restart_method_once_seen_keeps_the_longer_wait(self) -> None:
        # A later progress ACK without a method (or a resent ACCEPTED) never
        # shortens the wait a RESTART stage gave.
        command = self.send("bandwidth-squelch")
        accepted, _final = CASES["bandwidth-squelch"]["edge"]["acks"]
        base = json.loads(accepted["payload"])
        self.monitor.deliver("ack/config", json.dumps(dict(base, status="APPLYING", result={"method": "RESTART"})))
        self.assertEqual(self.status(command["id"])["state"], "acknowledged")
        self.monitor.deliver("ack/config", json.dumps(dict(base, status="VERIFYING", t=base["t"] + 1, result={})))
        self.clock[0] = command["issued_ms"] + FINAL_ACK_WAIT_MS + 1
        waiting = self.status(command["id"])
        self.assertEqual((waiting["state"], waiting["ack"]["status"], waiting["ack"]["method"]),
                         ("acknowledged", "VERIFYING", None))
        self.assertEqual(waiting["final_ack_deadline_ms"], command["issued_ms"] + RESTART_FINAL_ACK_WAIT_MS)
        self.clock[0] = command["issued_ms"] + RESTART_FINAL_ACK_WAIT_MS + 1
        self.assertEqual(self.status(command["id"])["state"], "no_final_ack")

    def test_a_live_retune_falling_back_to_a_restart_reaches_kontrol(self) -> None:
        # VERIFYING {LIVE}, then APPLYING and VERIFYING {RESTART} (control._patch_with_restart):
        # the APPLYING ACK's reason and bound reach Kontrol, a resent ACCEPTED does not.
        command = self.send("retune")
        accepted = json.loads(CASES["retune"]["edge"]["acks"][0]["payload"])
        reason = "LIVE_FAILED:ENGINE_OVERRODE:center_frequency_hz"
        self.monitor.deliver("ack/config", json.dumps(accepted))
        self.monitor.deliver("ack/config", json.dumps(dict(accepted, status="VERIFYING", t=accepted["t"] + 5_000,
                                                           result={"method": "LIVE", "persisted": True})))
        self.assertEqual(self.status(command["id"])["ack"]["method"], "LIVE")
        self.monitor.clock = received = command["issued_ms"] + 27_000
        self.monitor.deliver("ack/config", json.dumps(dict(accepted, status="APPLYING", t=accepted["t"] + 27_000, result={
            "method": "RESTART", "reason": reason, "changes": {}, "final_within_ms": 230_000})))
        self.monitor.deliver("ack/config", json.dumps(accepted))
        restarting = self.status(command["id"])
        self.assertEqual((restarting["ack"]["status"], restarting["ack"]["method"], restarting["ack"]["reason"]),
                         ("APPLYING", "RESTART", reason))
        self.assertEqual(restarting["final_ack_deadline_ms"], received + 230_000 + FINAL_WITHIN_MARGIN_MS)
        self.monitor.deliver("ack/config", json.dumps(dict(accepted, status="VERIFYING", t=accepted["t"] + 60_000,
                                                           result={"method": "RESTART", "reason": reason})))
        verifying = self.status(command["id"])
        self.assertEqual((verifying["state"], verifying["ack"]["status"], verifying["ack"]["reason"]),
                         ("acknowledged", "VERIFYING", reason))
        self.assertEqual(verifying["final_ack_deadline_ms"], received + 230_000 + FINAL_WITHIN_MARGIN_MS)

    def test_final_within_ms_extends_the_wait(self) -> None:
        # Contract 1.10: the edge bounds its own final ACK (helper and start timeouts).
        command = self.send("bandwidth-squelch")
        accepted, _final = CASES["bandwidth-squelch"]["edge"]["acks"]
        base = json.loads(accepted["payload"])
        received = self.monitor.clock
        self.monitor.deliver("ack/config", json.dumps(dict(base, status="APPLYING",
                                                           result={"method": "RESTART", "final_within_ms": 400_000})))
        deadline = received + 400_000 + FINAL_WITHIN_MARGIN_MS
        waiting = self.status(command["id"])
        self.assertEqual((waiting["ack"]["final_within_ms"], waiting["final_ack_deadline_ms"]), (400_000, deadline))
        self.assertIs(waiting["late_answer_possible"], False)
        self.clock[0] = command["issued_ms"] + RESTART_FINAL_ACK_WAIT_MS + 1
        self.assertEqual(self.status(command["id"])["state"], "acknowledged")
        # A later, shorter bound never shortens the wait already given.
        self.monitor.deliver("ack/config", json.dumps(dict(base, status="VERIFYING", t=base["t"] + 1,
                                                           result={"method": "RESTART", "final_within_ms": 10_000})))
        self.assertEqual(self.status(command["id"])["final_ack_deadline_ms"], deadline)
        self.clock[0] = deadline
        self.assertEqual(self.status(command["id"])["state"], "acknowledged")
        self.clock[0] = deadline + 1
        lost = self.status(command["id"])
        self.assertEqual((lost["state"], lost["final"], lost["late_answer_possible"]), ("no_final_ack", True, True))
        # The late final ACK still replaces the timeout, and nothing is late any more.
        self.monitor.deliver("ack/config", _final["payload"])
        done = self.status(command["id"])
        self.assertEqual((done["state"], done["late_answer_possible"], done["final_ack_deadline_ms"]), ("acked", False, None))

    def test_final_within_ms_is_capped_and_never_shortens_the_default(self) -> None:
        self.assertEqual(final_ack_deadline({"result": {"final_within_ms": 5_000_000}, "received_at_ms": 1_000}),
                         1_000 + FINAL_WITHIN_MAX_WAIT_MS)
        self.assertEqual(final_ack_deadline({"result": {"final_within_ms": 12.2}, "received_at_ms": 0}),
                         13 + FINAL_WITHIN_MARGIN_MS)
        for within in (None, -1, True, "60000", float("nan")):
            with self.subTest(within=within):
                self.assertIsNone(final_ack_deadline({"result": {"final_within_ms": within}, "received_at_ms": 0}))
        self.assertIsNone(final_ack_deadline({"result": {"final_within_ms": 1}}))
        command = self.send("gain")
        accepted = json.loads(CASES["gain"]["edge"]["acks"][0]["payload"])
        self.monitor.deliver("ack/config", json.dumps(dict(accepted, result={"final_within_ms": 1_000})))
        self.assertEqual(self.status(command["id"])["final_ack_deadline_ms"], command["issued_ms"] + FINAL_ACK_WAIT_MS)

    def test_a_timed_out_command_is_handed_over_for_its_late_answer(self) -> None:
        command = self.send("gain")
        accepted = CASES["gain"]["edge"]["acks"][0]
        self.monitor.deliver("ack/config", accepted["payload"])
        self.clock[0] = command["issued_ms"] + FINAL_ACK_WAIT_MS + 1
        self.assertEqual(self.status(command["id"])["state"], "no_final_ack")
        taken = []

        class Replacement:
            def adopt_rdf_node_commands(self, pending):
                taken.extend(pending)
                return len(pending)

        self.assertEqual(self.tracker.hand_over(self.monitor, Replacement()), 1)
        self.assertEqual(taken, [{"command_id": command["id"], "op": "config.patch", "sid": command["sid"]}])
        self.assertIs(self.status(command["id"])["late_answer_possible"], True)
        # Long after, nothing late is waited for.
        taken.clear()
        self.clock[0] = command["issued_ms"] + FINAL_WITHIN_MAX_WAIT_MS
        self.assertIs(self.status(command["id"])["late_answer_possible"], True)
        self.clock[0] += 1
        late = self.status(command["id"])
        self.assertEqual((late["state"], late["final"], late["late_answer_possible"]), ("no_final_ack", True, False))
        self.assertEqual(self.tracker.hand_over(self.monitor, Replacement()), 0)

    def test_late_answers_are_waited_for_until_the_edges_own_bound(self) -> None:
        class Replacement:
            def adopt_rdf_node_commands(self, pending):
                return len(pending)

        # A bound that runs out before issued + FINAL_WITHIN_MAX_WAIT_MS leaves the usual late window.
        command = self.send("bandwidth-squelch")
        accepted, _final = CASES["bandwidth-squelch"]["edge"]["acks"]
        base = json.loads(accepted["payload"])
        self.monitor.deliver("ack/config", json.dumps(dict(base, status="APPLYING",
                                                           result={"method": "RESTART", "final_within_ms": 300_000})))
        self.clock[0] = self.monitor.clock + 300_000 + FINAL_WITHIN_MARGIN_MS + 1
        lost = self.status(command["id"])
        self.assertEqual((lost["state"], lost["late_answer_possible"]), ("no_final_ack", True))
        self.clock[0] = command["issued_ms"] + FINAL_WITHIN_MAX_WAIT_MS + 1
        self.assertIs(self.status(command["id"])["late_answer_possible"], False)
        self.assertEqual(self.tracker.hand_over(self.monitor, Replacement()), 0)

        # A bound received late in the command ends after issued + FINAL_WITHIN_MAX_WAIT_MS: the
        # command is followed until then, and no edge answer comes after it.
        command = self.send("gain")
        accepted = json.loads(CASES["gain"]["edge"]["acks"][0]["payload"])
        self.monitor.clock += 300_000
        self.monitor.deliver("ack/config", json.dumps(dict(accepted, status="APPLYING",
                                                           result={"method": "RESTART", "final_within_ms": 870_000})))
        deadline = self.monitor.clock + FINAL_WITHIN_MAX_WAIT_MS
        self.assertGreater(deadline, command["issued_ms"] + FINAL_WITHIN_MAX_WAIT_MS)
        self.clock[0] = deadline
        waiting = self.status(command["id"])
        self.assertEqual((waiting["state"], waiting["final_ack_deadline_ms"]), ("acknowledged", deadline))
        self.assertEqual(self.tracker.hand_over(self.monitor, Replacement()), 1)
        self.clock[0] = deadline + 1
        lost = self.status(command["id"])
        self.assertEqual((lost["state"], lost["late_answer_possible"]), ("no_final_ack", False))
        self.assertEqual(self.tracker.hand_over(self.monitor, Replacement()), 0)

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

    def test_config_get_over_a_plaintext_primary_link_by_edge_commit(self) -> None:
        # 8691ad0 (installed) refuses it, so Kontrol keeps the Data Out values;
        # 35984d8 answers with settings/reported, which Kontrol then uses.
        for commit, fixture in EDGE_SETS.items():
            with self.subTest(edge=commit):
                monitor = FakeObservingMonitor(fixture)
                tracker = ConfigCommandTracker(clock_ms=lambda: monitor.clock)
                case = {item["name"]: item for item in fixture["cases"]}["config-get-tls-off"]
                command = json.loads(case["console"]["payload"])
                monitor.published(command["id"])
                tracker.record(command, monitor, topic=case["console"]["topic"], published_at_ms=command["issued_ms"])
                monitor.store.expect_settings_report(command["id"], monitor.clock)
                for ack in case["edge"]["acks"]:
                    monitor.deliver("ack/config", ack["payload"])
                if case["edge"]["settings_reported"] is not None:
                    monitor.deliver("settings/reported", case["edge"]["settings_reported"])
                done = tracker.status(command["id"], monitor)
                report = monitor.store.settings_report()
                if PLAINTEXT_CONFIG_GET[commit][0] == "APPLIED":
                    self.assertEqual((done["state"], done["final"], done["ack"]["status"]), ("reported", True, "APPLIED"))
                    self.assertEqual(report["id"], command["id"])
                    self.assertIs(report["matches_state_cfg"], True)
                    self.assertTrue(report["safe_settings"])
                else:
                    self.assertEqual((done["state"], done["ack"]["error"]), ("acked", "TLS_REQUIRED_FOR_SETTINGS_REPORT"))
                    self.assertIsNone(report)

    def test_the_1_10_edges_answers_reach_kontrol(self) -> None:
        # Edge d6946cf: a live retune of bandwidth and squelch, its stage, and the edge's own sentence.
        fixture = EDGE_SETS["d6946cf"]
        monitor = FakeObservingMonitor(fixture)
        tracker = ConfigCommandTracker(clock_ms=lambda: monitor.clock)
        cases = {item["name"]: item for item in fixture["cases"]}
        shown = {}
        for name in ("bandwidth-squelch", "stale-base-rev", "gain-not-in-table"):
            command = json.loads(cases[name]["console"]["payload"])
            monitor.published(command["id"])
            tracker.record(command, monitor, topic=cases[name]["console"]["topic"], published_at_ms=command["issued_ms"])
            stages = []
            for ack in cases[name]["edge"]["acks"]:
                monitor.deliver("ack/config", ack["payload"])
                stages.append(tracker.status(command["id"], monitor)["ack"])
            shown[name] = stages
        live = shown["bandwidth-squelch"]
        self.assertEqual([(ack["status"], ack["method"]) for ack in live],
                         [("ACCEPTED", None), ("VERIFYING", "LIVE"), ("APPLIED", "LIVE")])
        self.assertEqual((live[-1]["squelch_mode"], live[-1]["proof"]),
                         ("Manual", {"daq": "FRESH_HEALTHY_AFTER_RETUNE", "settings": "KEPT_BY_ENGINE"}))
        for name, error in (("stale-base-rev", "CONFIG_REVISION_CONFLICT"), ("gain-not-in-table", "GAIN_NOT_IN_APPROVED_TABLE")):
            with self.subTest(case=name):
                final = shown[name][-1]
                self.assertEqual(final["error"], error)
                self.assertEqual(final["message"], json.loads(cases[name]["edge"]["acks"][-1]["payload"])["result"]["message"])
                self.assertTrue(final["message"])

    def test_the_1_10_2_edge_says_when_its_final_ack_leaves(self) -> None:
        # Edge f8f9e52: ACCEPTED and VERIFYING carry final_within_ms, the final ACK does not.
        fixture = EDGE_SETS["f8f9e52"]
        monitor = FakeObservingMonitor(fixture)
        tracker = ConfigCommandTracker(clock_ms=lambda: monitor.clock)
        case = {item["name"]: item for item in fixture["cases"]}["bandwidth-squelch"]
        command = json.loads(case["console"]["payload"])
        monitor.published(command["id"])
        tracker.record(command, monitor, topic=case["console"]["topic"], published_at_ms=command["issued_ms"])
        shown = []
        for ack in case["edge"]["acks"]:
            monitor.deliver("ack/config", ack["payload"])
            shown.append(tracker.status(command["id"], monitor)["ack"])
        sent = [json.loads(ack["payload"])["result"].get("final_within_ms") for ack in case["edge"]["acks"]]
        self.assertEqual([(ack["status"], ack["final_within_ms"]) for ack in shown],
                         list(zip(("ACCEPTED", "VERIFYING", "APPLIED"), sent)))
        self.assertTrue(all(isinstance(value, int) and value > 0 for value in sent[:2]))
        self.assertIsNone(sent[2])

    def operation(self, op: str, **fields: Any) -> Dict[str, Any]:
        command = cmds.build_command(op, command_id=cmds.new_command_id(), sid=STATE["sid"], boot=STATE["boot"],
                                     base_rev=STATE["cfg"], issued_ms=self.clock[0], **fields)
        self.monitor.published(command["id"])
        self.tracker.record(command, self.monitor, topic=cmds.command_topic(NODE, op), published_at_ms=self.clock[0])
        return command

    def operation_ack(self, command: Dict[str, Any], status: str, result: Dict[str, Any], t_offset: int = 0) -> None:
        self.monitor.deliver("ack/operation", json.dumps({
            "v": 2, "sid": STATE["sid"], "id": command["id"], "status": status, "t": STATE["t"] + t_offset,
            "rev": STATE["cfg"], "result": result,
        }))

    def test_a_lifecycle_operation_waits_for_the_engine_start(self) -> None:
        # processing.set and service.restart wait for the engine (start_timeout_seconds, 180 s by default):
        # also from an edge that names no final_within_ms.
        command = self.operation("service.restart")
        self.operation_ack(command, "ACCEPTED", {})
        self.clock[0] = command["issued_ms"] + FINAL_ACK_WAIT_MS + 1
        self.assertEqual(self.status(command["id"])["state"], "acknowledged")
        self.assertEqual(self.tracker.mutation_in_flight(self.monitor), command["id"])
        self.clock[0] = command["issued_ms"] + RESTART_FINAL_ACK_WAIT_MS + 1
        self.assertEqual(self.status(command["id"])["state"], "no_final_ack")
        self.assertIsNone(self.tracker.mutation_in_flight(self.monitor))
        # A started processing.set ends with the edge's proof.
        command = self.operation("processing.set", desired="RUNNING")
        self.operation_ack(command, "ACCEPTED", {"final_within_ms": 190_250}, 1)
        self.operation_ack(command, "APPLIED", {"proof": "NEW_FRESH_DAQ_AND_UNIT_ACTIVE", "scope": "SDR_STACK",
                                                "desired": "RUNNING"}, 2)
        done = self.status(command["id"])
        self.assertEqual((done["state"], done["desired"], done["ack"]["desired"], done["ack"]["proof"]),
                         ("acked", "RUNNING", "RUNNING", "NEW_FRESH_DAQ_AND_UNIT_ACTIVE"))

    def test_a_scheduled_reboot_is_the_end_and_the_challenge_never_stays(self) -> None:
        prepare = self.operation("system.reboot.prepare")
        challenge = "g29oKmX_l6mcMunnJBk8MqBy5Ewq501A"
        self.operation_ack(prepare, "APPLIED", {"challenge": challenge, "valid_seconds": 30, "prepare_id": prepare["id"]})
        shown = self.status(prepare["id"])
        self.assertEqual((shown["state"], shown["ack"]["valid_seconds"]), ("acked", 30))
        self.assertIsNone(shown["prepare_valid_until_ms"])
        execute = self.operation("system.reboot.execute", prepare_id=prepare["id"], challenge=challenge)
        self.operation_ack(execute, "ACCEPTED", {"final_within_ms": 10_250}, 1)
        self.assertEqual(self.tracker.mutation_in_flight(self.monitor), execute["id"])
        self.operation_ack(execute, "REBOOT_SCHEDULED", {"scheduled": True, "delay_seconds": 5, "action": "reboot"}, 2)
        scheduled = self.status(execute["id"])
        self.assertEqual((scheduled["state"], scheduled["final"], scheduled["prepare_id"]),
                         ("acked", True, prepare["id"]))
        self.assertIsNone(self.tracker.mutation_in_flight(self.monitor))
        # The edge closes the command after the boot without another ACK: nothing times out.
        self.clock[0] += FINAL_WITHIN_MAX_WAIT_MS
        self.assertEqual(self.status(execute["id"])["state"], "acked")
        self.assertNotIn(challenge, json.dumps([self.status(prepare["id"]), self.status(execute["id"])]))
        self.assertNotIn(challenge, json.dumps(self.tracker._entries, default=str))

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
