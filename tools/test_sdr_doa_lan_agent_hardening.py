#!/usr/bin/env python3
"""Local-only hardening tests for the LAN edge agent."""

from __future__ import annotations

import hashlib
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import sdr_doa_lan_agent as agent
import sdr_doa_mqtt as contract
from sdr_doa_mqtt_stdlib import IncomingMessage


def runtime(*, control_enabled: bool = False) -> agent.AgentRuntime:
    return agent.AgentRuntime(
        base_url="http://fixture:8081",
        mqtt_host="127.0.0.1",
        mqtt_port=18884,
        publish_enabled=control_enabled,
        config_enabled=control_enabled,
        settings_path=(
            "/tmp/sdr-doa-agent-hardening-settings.json" if control_enabled else None
        ),
        state_dir="/tmp/sdr-doa-agent-hardening-test",
        clock_source="local",
    )


def make_command(command_id: str = "cmd-1", gain_db: float = 24.0) -> bytes:
    issued = int(time.time() * 1000)
    return contract.compact_json(
        contract.build_config_patch(
            command_id=command_id,
            base_config_rev=0,
            changes={"gain_db": gain_db},
            issued_ts_ms=issued,
            expires_ts_ms=issued + 10_000,
        )
    ).encode("utf-8")


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
        current._on_message(
            IncomingMessage(
                topic=contract.TOPICS["config_patch"],
                payload=make_command(f"cmd-{index}"),
                qos=1,
                retain=False,
                duplicate=False,
            )
        )
    assert len(current.pending_commands) == agent.MAX_PENDING_COMMANDS
    assert current.last_error == "CONFIG_COMMAND_QUEUE_FULL"


def test_duplicate_command_is_rejected_without_reapply() -> None:
    current = runtime(control_enabled=True)
    payload = make_command("cmd-1")
    fingerprint = hashlib.sha256(payload).hexdigest()
    current.command_journal["cmd-1"] = {
        "v": 1,
        "ts_ms": int(time.time() * 1000),
        "id": "cmd-1",
        "status": "rejected",
        "config_rev": 0,
        "readback_ok": False,
        "error": {"code": "CONTROL_DISABLED"},
        "fingerprint": fingerprint,
    }
    current._on_message(
        IncomingMessage(
            topic=contract.TOPICS["config_patch"],
            payload=payload,
            qos=1,
            retain=False,
            duplicate=True,
        )
    )
    assert current.pending_commands == []
    assert current.last_error == "COMMAND_DUPLICATE"


if __name__ == "__main__":
    tests = [value for name, value in globals().items() if name.startswith("test_")]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"{len(tests)} hardening tests passed")
