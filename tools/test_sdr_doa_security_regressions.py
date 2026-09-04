#!/usr/bin/env python3
"""Local-only regression tests for LAN deployment safety gates."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import sdr_doa_collector as collector
import sdr_doa_lan_agent as agent
import sdr_doa_mqtt as contract
from sdr_doa_mqtt_stdlib import IncomingMessage, MqttProtocolError, Mqtt311Client


def expect_error(fn, label: str) -> None:
    try:
        fn()
    except (ValueError, TypeError, contract.ContractError, MqttProtocolError):
        return
    raise AssertionError(f"{label}: expected rejection")


def test_base_url_allowlist() -> None:
    for base_url, label in (
        ("http://example.com:8081", "arbitrary host"),
        ("http://user:pass@doasdr.local:8081", "userinfo"),
        ("https://doasdr.local:8081", "https scheme"),
        ("http://doasdr.local:9999", "port"),
    ):
        result = collector.fetch_resource(base_url, "/status.json")
        assert result.ok is False, label
        assert "pass" not in (result.error or "").lower(), label
    try:
        collector.fetch_resource("http://doasdr.local:8081", "/not-allowlisted")
    except ValueError:
        pass
    else:
        raise AssertionError("path allowlist did not reject")
    print("PASS base URL/path allowlist")


def test_command_time_and_types() -> None:
    command = contract.build_config_patch(
        command_id="security-test",
        base_config_rev=0,
        changes={"gain_db": 24},
        issued_ts_ms=1_000,
        expires_ts_ms=11_000,
    )
    expect_error(lambda: contract.validate_config_patch(command, now_ms=12_000), "expired command")
    expect_error(lambda: contract.validate_config_patch(command, now_ms=-40_000), "future command")
    bad = dict(command)
    bad["base_config_rev"] = "0"
    expect_error(lambda: contract.decode_payload("config_patch", json.dumps(bad)), "string revision")
    bad = dict(command)
    bad["changes"] = {"gain_db": True}
    expect_error(lambda: contract.decode_payload("config_patch", json.dumps(bad)), "boolean numeric")
    print("PASS command time/type gates")


def test_incoming_message_metadata() -> None:
    current = agent.AgentRuntime(
        base_url="http://fixture:8081",
        mqtt_host="127.0.0.1",
        mqtt_port=18884,
        publish_enabled=True,
        config_enabled=True,
        settings_path="/tmp/not-used-settings.json",
        state_dir="/tmp/sdr-doa-security-test",
        clock_source="local",
    )
    payload = contract.compact_json(
        contract.build_config_patch(
            command_id="metadata-test",
            base_config_rev=0,
            changes={"gain_db": 24},
            issued_ts_ms=1_000,
            expires_ts_ms=11_000,
        )
    ).encode()
    current._on_message(IncomingMessage(contract.TOPICS["config_patch"], payload, qos=0, retain=False, duplicate=False))
    assert current.pending_commands == []
    current._on_message(IncomingMessage(contract.TOPICS["config_patch"], payload, qos=1, retain=True, duplicate=False))
    assert current.pending_commands == []
    print("PASS command QoS/retain gates")


def test_ack_is_redacted() -> None:
    ack = contract.build_config_ack(
        command_id="redaction",
        status="failed",
        ts_ms=1_000,
        config_rev=0,
        readback_ok=False,
        error={"code": "APPLY_ERROR", "detail": "secret-token=do-not-leak"},
        changed_fields=["gain_db"],
    )
    encoded = contract.compact_json(ack)
    assert "secret-token" not in encoded
    assert "do-not-leak" not in encoded
    assert ack["error"] == {"code": "APPLY_ERROR"}
    print("PASS ACK redaction")


def test_doa_zero_rate_disabled() -> None:
    runtime = agent.AgentRuntime(
        base_url="http://fixture:8081",
        mqtt_host="127.0.0.1",
        mqtt_port=18884,
        publish_enabled=False,
        config_enabled=False,
        settings_path=None,
        state_dir="/tmp/sdr-doa-security-test-rate",
        clock_source="local",
        doa_rate_hz=0,
    )
    assert runtime.doa_enabled is False
    assert runtime.doa_interval_s == float("inf")
    print("PASS doa-rate zero disables DoA")


def test_mqtt_non_loopback_requires_secure() -> None:
    expect_error(
        lambda: Mqtt311Client("192.168.100.173", 1883, "security-test", require_secure=True),
        "non-loopback insecure MQTT",
    )
    expect_error(
        lambda: Mqtt311Client("192.168.100.173", 1883, "security-test", username="u", require_secure=True),
        "non-loopback without TLS",
    )
    print("PASS non-loopback secure MQTT gate")


def main() -> int:
    tests = [
        test_base_url_allowlist,
        test_command_time_and_types,
        test_incoming_message_metadata,
        test_ack_is_redacted,
        test_doa_zero_rate_disabled,
        test_mqtt_non_loopback_requires_secure,
    ]
    for test in tests:
        test()
    print(f"{len(tests)} security regression tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
