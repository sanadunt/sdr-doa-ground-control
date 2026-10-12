#!/usr/bin/env python3
"""Local-only hardening tests for the LAN edge agent."""

from __future__ import annotations

import hashlib
import io
import json
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

import sdr_doa_lan_agent as agent
import sdr_doa_mqtt as contract
from sdr_doa_mqtt_stdlib import IncomingMessage

WORK_DIR = Path(tempfile.mkdtemp(prefix="sdr-doa-agent-hardening-"))


def runtime(*, control_enabled: bool = False, settings: Optional[Dict[str, Any]] = None) -> agent.AgentRuntime:
    settings_path = WORK_DIR / f"settings-{time.monotonic_ns()}.json"
    if settings is not None:
        settings_path.write_text(json.dumps(settings), encoding="utf-8")
    return agent.AgentRuntime(
        base_url="http://fixture:8081",
        mqtt_host="127.0.0.1",
        mqtt_port=18884,
        publish_enabled=control_enabled,
        config_enabled=control_enabled,
        settings_path=str(settings_path) if control_enabled else None,
        state_dir=str(WORK_DIR / f"state-{time.monotonic_ns()}"),
        clock_source="local",
        log_stream=io.StringIO(),
    )


def make_command(
    command_id: str = "cmd-1",
    gain_db: float = 24.0,
    *,
    base_config_rev: int = 0,
    issued_offset_ms: int = 0,
    ttl_ms: int = 10_000,
) -> bytes:
    issued = int(time.time() * 1000) + issued_offset_ms
    return contract.compact_json(
        contract.build_config_patch(
            command_id=command_id,
            base_config_rev=base_config_rev,
            changes={"gain_db": gain_db},
            issued_ts_ms=issued,
            expires_ts_ms=issued + ttl_ms,
        )
    ).encode("utf-8")


def deliver(current: agent.AgentRuntime, payload: bytes, *, qos: int = 1, retain: bool = False) -> None:
    current._on_message(
        IncomingMessage(
            topic=contract.TOPICS["config_patch"],
            payload=payload,
            qos=qos,
            retain=retain,
            duplicate=False,
        )
    )


def acks(current: agent.AgentRuntime) -> List[Dict[str, Any]]:
    for ack in current.pending_acks:
        contract.validate_payload("ack_config", ack)
    return list(current.pending_acks)


def test_incoming_validation_rechecks_allowlist_and_range() -> None:
    current = runtime()
    accepted = current._validate_incoming_patch(make_command())
    assert accepted["changes"]["gain_db"] == 24

    for changes in (
        {"gain_db": 999},
        {"secret_token": "not-allowed"},
        {"gain_db": "NaN"},
    ):
        payload = {
            "v": 1,
            "id": "bad",
            "type": "config_patch",
            "base_config_rev": 0,
            "issued_ts_ms": 1_000,
            "expires_ts_ms": 11_000,
            "changes": changes,
        }
        try:
            current._validate_incoming_patch(json.dumps(payload).encode("utf-8"))
        except (ValueError, contract.ContractError):
            pass
        else:
            raise AssertionError(f"invalid incoming patch accepted: {changes}")


def test_command_queue_is_bounded() -> None:
    current = runtime(control_enabled=True)
    for index in range(agent.MAX_PENDING_COMMANDS + 10):
        deliver(current, make_command(f"cmd-{index}"))
    assert len(current.pending_commands) == agent.MAX_PENDING_COMMANDS
    assert current.last_error == "CONFIG_COMMAND_QUEUE_FULL"
    assert {ack["error"]["code"] for ack in acks(current)} == {"COMMAND_QUEUE_FULL"}


def test_duplicate_command_reacks_without_reapply() -> None:
    current = runtime(control_enabled=True)
    payload = make_command("cmd-1")
    journaled = contract.build_config_ack(
        command_id="cmd-1",
        status="applied",
        ts_ms=int(time.time() * 1000),
        config_rev=1,
        readback_ok=True,
        changed_fields=["gain_db"],
    )
    current.command_journal["cmd-1"] = journaled
    current.command_fingerprints["cmd-1"] = hashlib.sha256(payload).hexdigest()
    deliver(current, payload)
    assert current.pending_commands == []
    assert current.last_error == "COMMAND_DUPLICATE"
    assert acks(current) == [journaled]


def test_rejected_commands_are_acked_with_contract_codes() -> None:
    current = runtime(control_enabled=True)
    deliver(current, make_command("cmd-qos0"), qos=0)
    deliver(current, make_command("cmd-retained"), retain=True)
    deliver(current, make_command("cmd-future", issued_offset_ms=60_000))
    deliver(current, make_command("cmd-expired", issued_offset_ms=-20_000))
    disallowed = json.loads(make_command("cmd-field"))
    disallowed["changes"] = {"secret": 1}
    deliver(current, json.dumps(disallowed).encode("utf-8"))
    malformed = json.loads(make_command("cmd-malformed"))
    del malformed["type"]
    deliver(current, json.dumps(malformed).encode("utf-8"))
    deliver(current, b"{not json")

    received = {ack["id"]: ack for ack in acks(current)}
    assert current.pending_commands == []
    expected = {
        "cmd-qos0": ("rejected", "WRONG_COMMAND_QOS"),
        "cmd-retained": ("rejected", "RETAINED_COMMAND"),
        "cmd-future": ("rejected", "COMMAND_FUTURE_DATED"),
        "cmd-expired": ("expired", "COMMAND_EXPIRED"),
        "cmd-field": ("rejected", "FIELD_NOT_ALLOWED"),
        "cmd-malformed": ("rejected", "INVALID_COMMAND"),
    }
    assert {key: (ack["status"], ack["error"]["code"]) for key, ack in received.items()} == expected
    assert all("changed_fields" not in ack for ack in received.values())

    # A refusal is not journaled, so a corrected resend with the same id is accepted.
    deliver(current, make_command("cmd-qos0"))
    assert len(current.pending_commands) == 1


def test_replayed_id_with_different_payload_is_rejected() -> None:
    current = runtime(control_enabled=True)
    deliver(current, make_command("cmd-1", gain_db=24.0))
    deliver(current, make_command("cmd-1", gain_db=30.0))
    assert len(current.pending_commands) == 1
    assert [(ack["id"], ack["error"]["code"]) for ack in acks(current)] == [("cmd-1", "COMMAND_REPLAY_CONFLICT")]


def test_applied_and_conflict_acks_from_the_apply_path() -> None:
    current = runtime(control_enabled=True, settings={"center_freq": 415.0, "uniform_gain": 10.0})
    deliver(current, make_command("cmd-ok", gain_db=24.0))
    deliver(current, make_command("cmd-conflict", gain_db=30.0, base_config_rev=5))
    current._process_commands(int(time.time() * 1000))
    received = {ack["id"]: ack for ack in acks(current)}
    assert received["cmd-ok"]["status"] == "applied"
    assert received["cmd-ok"]["changed_fields"] == ["gain_db"]
    assert received["cmd-conflict"]["status"] == "conflict"
    assert received["cmd-conflict"]["error"]["code"] == "CONFIG_REVISION_CONFLICT"
    assert "changed_fields" not in received["cmd-conflict"], "nothing changed on a conflict"
    assert current.config_rev == 1


def test_identical_retry_after_apply_gets_the_journaled_ack() -> None:
    current = runtime(control_enabled=True, settings={"center_freq": 415.0, "uniform_gain": 10.0})
    payload = make_command("cmd-ok", gain_db=24.0)
    deliver(current, payload)
    current._process_commands(int(time.time() * 1000))
    first = acks(current)
    assert [ack["status"] for ack in first] == ["applied"]
    current.pending_acks.clear()
    deliver(current, payload)
    assert current.pending_commands == []
    assert acks(current) == first
    assert current.config_rev == 1


if __name__ == "__main__":
    tests = [value for name, value in globals().items() if name.startswith("test_")]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"{len(tests)} hardening tests passed")
