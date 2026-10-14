#!/usr/bin/env python3
"""Unit tests for the LAN-stage edge-agent policy."""

from __future__ import annotations

import contextlib
import io
import json
import signal
import ssl
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))

import sdr_doa_collector as collector
import sdr_doa_lan_agent as agent
import sdr_doa_mqtt as contract
from sdr_doa_mqtt_stdlib import IncomingMessage, is_loopback_host

FIXTURE_ROOT = Path(__file__).resolve().parent / "fixtures"
FIXTURE_TIMESTAMP = "1000000"


def fixture_bodies(name: str, timestamp_ms: Optional[int] = None, settings: Optional[Dict[str, Any]] = None) -> Dict[str, bytes]:
    root = FIXTURE_ROOT / name
    bodies = {
        collector.PATH_STATUS: (root / "status.json").read_bytes(),
        collector.PATH_SETTINGS: (root / "settings.json").read_bytes(),
        collector.PATH_CSV: (root / "DOA_value.html").read_bytes(),
        collector.PATH_XML: (root / "doa.xml").read_bytes(),
    }
    if timestamp_ms is not None:
        bodies = {
            path: body.replace(FIXTURE_TIMESTAMP.encode(), str(timestamp_ms).encode())
            for path, body in bodies.items()
        }
    if settings:
        document = json.loads(bodies[collector.PATH_SETTINGS])
        document.update(settings)
        bodies[collector.PATH_SETTINGS] = json.dumps(document).encode()
    return bodies


def fixture_fetcher(name: str, timestamp_ms: Optional[int] = None, settings: Optional[Dict[str, Any]] = None, requests: Optional[List[str]] = None):
    bodies = fixture_bodies(name, timestamp_ms, settings)

    def fetcher(base_url, path, timeout, max_body):
        if requests is not None:
            requests.append(path)
        return collector.FetchedResource(
            path=path,
            url=base_url + path,
            ok=True,
            http_status=200,
            content_type="application/octet-stream",
            body=bodies[path],
            retrieved_at_ms=collector.now_ms(),
        )

    return fetcher


def fresh_fetcher(name: str = "valid", **kwargs: Any):
    """Serve a fixture whose node timestamps are 200 ms old on every read."""
    requests = kwargs.pop("requests", None)
    settings = kwargs.pop("settings", None)

    def fetcher(base_url, path, timeout, max_body):
        return fixture_fetcher(name, collector.now_ms() - 200, settings, requests)(base_url, path, timeout, max_body)

    return fetcher


def collect_fixture(name: str, clock_source: str = "local", timestamp_ms: Optional[int] = None, **kwargs: Any):
    return collector.collect(
        "http://fixture:8081",
        authority=kwargs.pop("authority", "none"),
        clock_source=clock_source,
        status_max_age_ms=10_000,
        doa_max_age_ms=5_000,
        fetcher=fixture_fetcher(name, timestamp_ms, kwargs.pop("settings", None)),
        **kwargs,
    )


class FakeBroker:
    """Records what the agent sends through a stand-in MQTT client."""

    def __init__(self) -> None:
        self.published: List[Tuple[str, bytes, int, bool]] = []
        self.closes: List[bool] = []
        self.clients: List["FakeClient"] = []
        self.connect_error: Optional[BaseException] = None
        self.publish_error: Optional[BaseException] = None

    def factory(self, host: str, port: int, **kwargs: Any) -> "FakeClient":
        if not is_loopback_host(host) and (kwargs.get("tls_context") is None or kwargs.get("username") is None):
            raise ValueError("non-loopback MQTT requires TLS and broker authentication")
        client = FakeClient(self, host, port, kwargs)
        self.clients.append(client)
        return client

    def payloads(self, kind: str) -> List[Dict[str, Any]]:
        topic = contract.TOPICS[kind]
        return [json.loads(payload) for item_topic, payload, _qos, _retain in self.published if item_topic == topic and payload]

    def messages(self, kind: str) -> List[Tuple[str, bytes, int, bool]]:
        return [item for item in self.published if item[0] == contract.TOPICS[kind]]


class FakeClient:
    def __init__(self, broker: FakeBroker, host: str, port: int, options: Dict[str, Any]) -> None:
        self.broker = broker
        self.host = host
        self.port = port
        self.options = options
        self.subscriptions: List[str] = []

    def connect(self) -> None:
        if self.broker.connect_error is not None:
            raise self.broker.connect_error

    def subscribe(self, topic: str, qos: int = 1) -> None:
        self.subscriptions.append(topic)

    def publish(self, topic: str, payload: bytes, qos: int = 0, retain: bool = False) -> None:
        if self.broker.publish_error is not None:
            raise self.broker.publish_error
        self.broker.published.append((topic, payload, qos, retain))

    def poll(self, timeout: float = 0.0) -> None:
        return None

    def close(self, graceful: bool = True) -> None:
        self.broker.closes.append(graceful)


@contextlib.contextmanager
def preserved_signal_handlers():
    """main() installs SIGINT/SIGTERM handlers; restore the test runner's."""
    saved = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}
    try:
        yield
    finally:
        for sig, handler in saved.items():
            signal.signal(sig, handler)


def make_runtime(broker: Optional[FakeBroker] = None, **kwargs: Any) -> agent.AgentRuntime:
    options: Dict[str, Any] = {
        "base_url": "http://fixture:8081",
        "mqtt_host": "127.0.0.1",
        "mqtt_port": 18884,
        "publish_enabled": broker is not None,
        "config_enabled": False,
        "settings_path": None,
        "state_dir": "unused-state-dir",
        "clock_source": "local",
        "health_interval_s": 0.02,
        "doa_rate_hz": 0.0,
        "state_interval_s": 30.0,
        "poll_interval_s": 0.005,
        "fetcher": fresh_fetcher(),
        "log_stream": io.StringIO(),
    }
    if broker is not None:
        options["client_factory"] = broker.factory
    options.update(kwargs)
    return agent.AgentRuntime(**options)


def test_unhealthy_live_policy_emits_health_state_config_only() -> None:
    snapshot = collect_fixture("unhealthy", timestamp_ms=collector.now_ms() - 200)
    messages = agent.build_messages(snapshot, now_ms=1_000_000)
    assert snapshot["publication_gate"]["state"] == "BLOCKED"
    assert set(messages) == {"health", "state", "config_reported"}
    assert messages["health"]["daq_ok"] is False
    assert messages["health"]["state"] == "DEGRADED"
    assert messages["health"]["reasons"] == ["DAQ_HEALTH_GATE_FAILED"]
    assert "doa" not in messages


def test_stale_status_is_reported_as_stale_not_degraded() -> None:
    # The fixture timestamps are from 1970, so the local clock sees them as stale.
    snapshot = collect_fixture("unhealthy")
    health = agent.build_messages(snapshot, now_ms=1_000_000)["health"]
    assert health["state"] == "STALE"
    assert health["reasons"] == ["STATUS_STALE", "DAQ_HEALTH_GATE_FAILED"]


def test_fresh_healthy_node_reports_online_without_doa_readiness() -> None:
    snapshot = collect_fixture("valid", timestamp_ms=collector.now_ms() - 200)
    health = agent.build_messages(snapshot, now_ms=1_000_000)["health"]
    assert snapshot["publication_gate"]["state"] == "BLOCKED"
    assert health["state"] == "ONLINE"
    assert health["reasons"] == []
    assert health["doa_valid"] is False


def test_frozen_node_is_stale_with_unverified_clock() -> None:
    tracker = collector.NodeProgressTracker()
    clock = [1_000.0]
    states = []
    for advance_s, timestamp in ((0.0, 5_000_000), (1.0, 5_001_000), (2.0, 5_001_000), (11.0, 5_001_000)):
        clock[0] += advance_s
        snapshot = collect_fixture(
            "valid",
            clock_source="remote_unverified",
            timestamp_ms=timestamp,
            progress_tracker=tracker,
            monotonic_clock=lambda: clock[0],
        )
        health = agent.build_messages(snapshot)["health"]
        states.append((health["state"], health["reasons"]))
    assert states[0] == ("DEGRADED", ["STATUS_FRESHNESS_UNVERIFIED"])
    assert states[1] == ("ONLINE", [])
    # Unchanged counters below the stall threshold do not prove freshness.
    assert states[2] == ("DEGRADED", ["STATUS_FRESHNESS_UNVERIFIED"])
    assert states[3] == ("STALE", ["NODE_CLOCK_STALLED"])


def test_valid_fixture_still_requires_authority_and_angle_gate() -> None:
    snapshot = collect_fixture("valid")
    messages = agent.build_messages(snapshot, now_ms=1_000_000)
    assert snapshot["publication_gate"]["state"] == "BLOCKED"
    assert "doa" not in messages
    assert messages["state"]["running"] is True


def test_adjacent_frame_pair_is_never_offered_as_valid_doa() -> None:
    """AUD-18: CSV/XML from different frames were not angle-checked, so DoA is not valid."""
    original = collector.normalize_doa_candidate

    def units_ready(*args: Any, **kwargs: Any) -> Dict[str, Any]:
        # The unit contract is never ready upstream; force it so only the frame pair decides.
        result = original(*args, **kwargs)
        result["units_valid"] = True
        return result

    def snapshot_with_xml_offset(offset_ms: int) -> Dict[str, Any]:
        timestamp = collector.now_ms() - 400
        bodies = fixture_bodies("valid", timestamp)
        bodies[collector.PATH_XML] = bodies[collector.PATH_XML].replace(
            f"<TIME>{timestamp}</TIME>".encode(), f"<TIME>{timestamp + offset_ms}</TIME>".encode(),
        )

        def fetcher(base_url: str, path: str, timeout: float, max_body: int) -> collector.FetchedResource:
            return collector.FetchedResource(
                path=path, url=base_url + path, ok=True, http_status=200,
                content_type="application/octet-stream", body=bodies[path], retrieved_at_ms=collector.now_ms(),
            )

        return collector.collect(
            "http://fixture:8081", authority="csv", clock_source="local", canonical_angle_ready=True,
            retry_delay_seconds=0, fetcher=fetcher,
        )

    collector.normalize_doa_candidate = units_ready
    try:
        same = snapshot_with_xml_offset(0)
        adjacent = snapshot_with_xml_offset(250)
    finally:
        collector.normalize_doa_candidate = original
    assert same["publication_gate"]["state"] == "READY", same["publication_gate"]
    assert agent.build_messages(same)["health"]["doa_valid"] is True
    assert adjacent["native_consistency"]["frame_relation"] == "ADJACENT_FRAMES"
    assert adjacent["publication_gate"]["state"] == "BLOCKED"
    assert adjacent["publication_gate"]["reasons"] == ["NATIVE_ANGLE_UNCHECKED"]
    messages = agent.build_messages(adjacent)
    assert messages["health"]["doa_valid"] is False
    assert "doa" not in messages
    assert messages["health"]["state"] == "ONLINE"


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


def test_output_vfo_all_is_published_in_state_and_config() -> None:
    snapshot = collect_fixture("valid", settings={"output_vfo": -1, "active_vfos": 3})
    messages, errors = agent.build_messages_with_errors(snapshot, now_ms=1_000_000)
    assert errors == []
    assert messages["state"]["output_vfo"] == contract.OUTPUT_VFO_ALL
    assert messages["config_reported"]["output_vfo"] == contract.OUTPUT_VFO_ALL
    assert messages["health"]["settings_valid"] is True
    for kind in ("health", "state", "config_reported"):
        contract.decode_payload(kind, contract.compact_json(messages[kind]))


def test_unrepresentable_setting_still_publishes_health() -> None:
    snapshot = collect_fixture("valid", settings={"output_vfo": -7})
    messages, errors = agent.build_messages_with_errors(snapshot, now_ms=1_000_000)
    assert set(messages) == {"health"}
    assert errors and errors[0].startswith("STATE_PAYLOAD_INVALID")
    assert messages["health"]["settings_available"] is True
    assert messages["health"]["settings_valid"] is False
    assert "SETTINGS_PAYLOAD_INVALID" in messages["health"]["reasons"]


def test_payload_error_keeps_mqtt_session_and_health_flowing() -> None:
    broker = FakeBroker()
    log = io.StringIO()
    runtime = make_runtime(broker, fetcher=fresh_fetcher(settings={"output_vfo": -7}), log_stream=log)
    result = runtime.run(max_iterations=3)
    assert result["iterations"] == 3
    assert runtime.connections == 1
    assert False not in broker.closes, "a payload error must not drop the MQTT session"
    assert len(broker.payloads("health")) == 3
    assert broker.payloads("state") == []
    assert "STATE_PAYLOAD_INVALID" in (result["last_error"] or "")
    assert "STATE_PAYLOAD_INVALID" in log.getvalue()


def hanging_fetcher(release: threading.Event, requests: List[str]):
    """A Data Out that accepts the request and never answers."""

    def fetcher(base_url, path, timeout, max_body):
        requests.append(path)
        release.wait(30)
        raise AssertionError("released hanging fetch")

    return fetcher


def test_stalled_data_out_is_bounded_and_reports_unavailable() -> None:
    release = threading.Event()
    requests: List[str] = []
    try:
        runtime = make_runtime(collect_budget_s=0.3, fetcher=hanging_fetcher(release, requests))
        started = time.monotonic()
        result = runtime.collect_once()
        elapsed = time.monotonic() - started
        health = runtime.queue.peek("health")
        assert elapsed < 1.5, elapsed
        assert health["state"] == "UNAVAILABLE"
        assert health["reasons"] == ["STATUS_UNAVAILABLE_OR_INVALID", "COLLECTION_DEADLINE_EXCEEDED"]
        assert result["health_state"] == "UNAVAILABLE"

        broker = FakeBroker()
        runtime = make_runtime(broker, collect_budget_s=0.3, health_interval_s=0.5, fetcher=hanging_fetcher(release, requests))
        result = runtime.run(duration_s=1.4)
        unavailable = [item for item in broker.payloads("health") if item["state"] == "UNAVAILABLE"]
        assert len(unavailable) >= 2, broker.payloads("health")
        assert False not in broker.closes
    finally:
        release.set()


def test_collection_follows_publish_schedule_and_skips_unused_doa_views() -> None:
    requests: List[str] = []
    runtime = make_runtime(health_interval_s=0.2, doa_rate_hz=20.0, poll_interval_s=0.005, fetcher=fresh_fetcher(requests=requests))
    assert runtime.collect_interval_s == 0.2
    result = runtime.run(duration_s=1.0)
    # The old loop collected on every 5 ms poll (about 200 times here).
    assert 3 <= result["iterations"] <= 7, result["iterations"]
    assert set(requests) == {collector.PATH_STATUS, collector.PATH_SETTINGS}
    assert len(requests) == 2 * result["iterations"]
    assert result["doa_views_read"] is False


def test_doa_views_are_read_when_an_authority_is_selected() -> None:
    requests: List[str] = []
    runtime = make_runtime(authority="csv", health_interval_s=1.0, doa_rate_hz=4.0, fetcher=fresh_fetcher(requests=requests))
    assert runtime.collect_interval_s == 0.25
    runtime.collect_once()
    assert {collector.PATH_CSV, collector.PATH_XML} <= set(requests)


def test_once_reports_what_was_published_and_disconnects_cleanly() -> None:
    broker = FakeBroker()
    result = make_runtime(broker).run_once()
    assert result["published_kinds"] == ["config_reported", "health", "state"]
    assert result["queued_kinds"] == []
    assert result["last_error"] is None
    assert broker.closes == [True]
    availability = broker.payloads("availability")
    assert [item["online"] for item in availability] == [True, False]
    assert availability[-1]["reason"] == "SHUTDOWN"

    broker = FakeBroker()
    broker.connect_error = ConnectionRefusedError("connection refused")
    result = make_runtime(broker).run_once()
    assert result["published_kinds"] == []
    assert result["connected"] is False
    assert result["queued_kinds"] == ["config_reported", "health", "state"]
    assert result["last_error"].startswith("MQTT_CONNECT_FAILED")


def test_main_exits_non_zero_when_nothing_was_published() -> None:
    stdout, stderr = io.StringIO(), io.StringIO()
    with preserved_signal_handlers(), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        code = agent.main(
            [
                "--once",
                "--publish",
                "--mqtt-port",
                "24130",
                "--base-url",
                "http://127.0.0.1:24131",
                "--collect-budget",
                "1",
            ]
        )
    result = json.loads(stdout.getvalue())
    assert code == 1
    assert result["published_kinds"] == []
    assert result["health_state"] == "UNAVAILABLE"
    assert "MQTT_CONNECT_FAILED" in result["last_error"]


def test_non_loopback_broker_requires_tls_and_credentials() -> None:
    try:
        agent.AgentRuntime(
            base_url="http://fixture:8081",
            mqtt_host="192.168.100.173",
            mqtt_port=18885,
            publish_enabled=True,
            config_enabled=False,
            settings_path=None,
            state_dir="unused-state-dir",
            clock_source="local",
        )
    except ValueError as exc:
        assert "TLS" in str(exc)
    else:
        raise AssertionError("non-loopback broker without TLS was accepted")

    with preserved_signal_handlers(), contextlib.redirect_stderr(io.StringIO()):
        try:
            agent.main(["--publish", "--mqtt-host", "192.168.100.173", "--mqtt-port", "18885", "--once"])
        except SystemExit as exc:
            assert "invalid agent configuration" in str(exc.code)
        else:
            raise AssertionError("main accepted a non-loopback broker without TLS")

    context = ssl.create_default_context()
    runtime = agent.AgentRuntime(
        base_url="http://fixture:8081",
        mqtt_host="192.168.100.173",
        mqtt_port=18885,
        publish_enabled=True,
        config_enabled=False,
        settings_path=None,
        state_dir="unused-state-dir",
        clock_source="local",
        mqtt_username="sdr-doa-agent",
        mqtt_password="from-environment",
        mqtt_tls_context=context,
    )
    client = runtime._new_client()
    assert client.username == "sdr-doa-agent"
    assert client.password == "from-environment"
    assert client.tls_context is context


def test_main_reads_mqtt_password_from_environment() -> None:
    captured: Dict[str, Any] = {}

    class Stop(Exception):
        pass

    class SpyRuntime:
        def __init__(self, **kwargs: Any) -> None:
            captured.update(kwargs)
            raise Stop()

    original_runtime = agent.AgentRuntime
    original_env = agent.os.environ.get(agent.MQTT_PASSWORD_ENV)
    agent.AgentRuntime = SpyRuntime  # type: ignore[misc]
    agent.os.environ[agent.MQTT_PASSWORD_ENV] = "env-secret"
    try:
        try:
            agent.main(["--publish", "--mqtt-username", "sdr-doa-agent", "--mqtt-tls"])
        except Stop:
            pass
    finally:
        agent.AgentRuntime = original_runtime  # type: ignore[misc]
        if original_env is None:
            agent.os.environ.pop(agent.MQTT_PASSWORD_ENV, None)
        else:
            agent.os.environ[agent.MQTT_PASSWORD_ENV] = original_env
    assert captured["mqtt_username"] == "sdr-doa-agent"
    assert captured["mqtt_password"] == "env-secret"
    assert isinstance(captured["mqtt_tls_context"], ssl.SSLContext)


def test_availability_will_online_and_shutdown_markers() -> None:
    broker = FakeBroker()
    runtime = make_runtime(broker)
    runtime.run(max_iterations=1)
    will = broker.clients[-1].options["will"]
    assert will.topic == contract.TOPICS["availability"]
    assert will.retain is True and will.qos == 1
    will_payload = contract.decode_payload("availability", will.payload)
    assert will_payload["online"] is False and will_payload["reason"] == "CONNECTION_LOST"
    messages = broker.messages("availability")
    assert all(retain is True and qos == 1 for _topic, _payload, qos, retain in messages)
    assert [json.loads(payload)["online"] for _topic, payload, _qos, _retain in messages] == [True, False]

    broker = FakeBroker()
    runtime = make_runtime(broker)
    runtime.run(max_iterations=1)
    runtime._connect_if_due(time.monotonic())
    runtime._disconnect(ConnectionResetError("broker went away"))
    # A lost session closes without DISCONNECT, so the broker sends the will.
    assert broker.closes[-1] is False


def test_telemetry_drop_count_reports_health_superseded_while_disconnected() -> None:
    broker = FakeBroker()
    broker.connect_error = ConnectionRefusedError("connection refused")
    runtime = make_runtime(broker)
    runtime.run(max_iterations=3)
    assert broker.payloads("health") == []
    broker.connect_error = None
    runtime.next_connect_at = 0.0
    time.sleep(0.05)  # let the next collection build a new health sample
    runtime.run(max_iterations=1)
    health = broker.payloads("health")
    assert len(health) == 1
    assert health[0]["telemetry_drop_count"] >= 2, health


def test_publish_without_config_control_rejects_patches_with_remote_control_disabled() -> None:
    """D15: with --publish alone the agent listens and answers instead of staying silent."""
    broker = FakeBroker()
    runtime = make_runtime(broker)
    assert runtime.publish_enabled is True and runtime.config_enabled is False
    runtime._connect_if_due(time.monotonic())
    client = broker.clients[-1]
    assert client.subscriptions == [contract.TOPICS["config_patch"]]

    issued = int(time.time() * 1000)
    payload = contract.compact_json(
        contract.build_config_patch(
            command_id="gc-0123456789abcdef01234567",
            base_config_rev=0,
            changes={"center_frequency_hz": 433_920_000},
            issued_ts_ms=issued,
            expires_ts_ms=issued + 60_000,
        )
    ).encode("utf-8")
    # Delivered through the callback the agent gave its MQTT client.
    client.options["on_message"](
        IncomingMessage(
            topic=contract.TOPICS["config_patch"],
            payload=payload,
            qos=1,
            retain=False,
            duplicate=False,
        )
    )
    assert runtime.pending_commands == [], "a disabled agent must not queue the command"
    runtime._process_commands(int(time.time() * 1000))
    runtime._flush_or_disconnect()

    acks = broker.payloads("ack_config")
    assert len(acks) == 1, acks
    ack = acks[0]
    contract.validate_payload("ack_config", ack)
    assert ack["id"] == "gc-0123456789abcdef01234567"
    assert ack["status"] == "rejected"
    assert ack["error"]["code"] == "REMOTE_CONTROL_DISABLED"
    assert ack["readback_ok"] is False
    assert "changed_fields" not in ack
    [(_topic, _raw, qos, retain)] = broker.messages("ack_config")
    assert (qos, retain) == (1, False), "an ACK is QoS 1 and never retained"
    runtime.close()


def test_reconnect_resends_state_and_config_immediately() -> None:
    broker = FakeBroker()
    runtime = make_runtime(broker, state_interval_s=30.0)
    runtime.run(max_iterations=1)
    runtime.run(max_iterations=1)
    assert runtime.connections == 2
    assert len(broker.payloads("state")) == 2
    assert len(broker.payloads("config_reported")) == 2
    assert all(retain for _topic, _payload, _qos, retain in broker.messages("state"))


if __name__ == "__main__":
    tests = [value for name, value in globals().items() if name.startswith("test_")]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"{len(tests)} LAN-agent tests passed")
