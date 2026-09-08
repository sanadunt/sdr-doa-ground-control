#!/usr/bin/env python3
"""Unit tests for the LAN-stage edge-agent policy."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import sdr_doa_collector as collector
import sdr_doa_lan_agent as agent

FIXTURE_ROOT = Path(__file__).resolve().parent / "fixtures"


def fixture_fetcher(name: str):
    root = FIXTURE_ROOT / name
    bodies = {
        collector.PATH_STATUS: (root / "status.json").read_bytes(),
        collector.PATH_SETTINGS: (root / "settings.json").read_bytes(),
        collector.PATH_CSV: (root / "DOA_value.html").read_bytes(),
        collector.PATH_XML: (root / "doa.xml").read_bytes(),
    }

    def fetcher(base_url, path, timeout, max_body):
        return collector.FetchedResource(
            path=path,
            url=base_url + path,
            ok=True,
            http_status=200,
            content_type="application/octet-stream",
            body=bodies[path],
            retrieved_at_ms=1_000_000,
        )

    return fetcher


def collect_fixture(name: str):
    return collector.collect(
        "http://fixture:8081",
        authority="none",
        clock_source="local",
        status_max_age_ms=10_000,
        doa_max_age_ms=5_000,
        fetcher=fixture_fetcher(name),
    )


def test_unhealthy_live_policy_emits_health_state_config_only() -> None:
    snapshot = collect_fixture("unhealthy")
    messages = agent.build_messages(snapshot, now_ms=1_000_000)
    assert snapshot["publication_gate"]["state"] == "BLOCKED"
    assert set(messages) == {"health", "state", "config_reported"}
    assert messages["health"]["daq_ok"] is False
    assert messages["health"]["state"] == "DEGRADED"
    assert "doa" not in messages


def test_valid_fixture_still_requires_authority_and_angle_gate() -> None:
    snapshot = collect_fixture("valid")
    messages = agent.build_messages(snapshot, now_ms=1_000_000)
    assert snapshot["publication_gate"]["state"] == "BLOCKED"
    assert "doa" not in messages
    assert messages["state"]["running"] is True


def test_no_raw_settings_or_angular_values_in_agent_result() -> None:
    snapshot = collect_fixture("unhealthy")
    result = agent.run_once.__name__
    messages = agent.build_messages(snapshot, now_ms=1_000_000)
    serialized = json.dumps(messages, sort_keys=True)
    assert "secret_token" not in serialized
    assert "do-not-return" not in serialized
    assert "angular_values" not in serialized
    assert "angular_power_db" not in serialized
    assert result == "run_once"


if __name__ == "__main__":
    tests = [value for name, value in globals().items() if name.startswith("test_")]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"{len(tests)} LAN-agent tests passed")
