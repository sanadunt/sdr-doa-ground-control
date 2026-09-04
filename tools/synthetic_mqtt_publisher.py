#!/usr/bin/env python3
"""Publish synthetic SDR-DoA MQTT telemetry to a staging broker.

This tool is intentionally for local/staging tests. It publishes only to the
explicit broker host/port supplied by the operator and does not read or write
Raspberry resources. By default, state and reported configuration are sent
once at startup, while DoA/navigation/health are periodic.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from threading import Event
from typing import Any, Dict, List, Tuple

import paho.mqtt.client as mqtt

import sdr_doa_mqtt as contract


Message = Tuple[str, Dict[str, Any], int, bool]


def _reason_value(reason_code: Any) -> int:
    value = getattr(reason_code, "value", reason_code)
    try:
        return int(value)
    except (TypeError, ValueError):
        return 1


def _build_payloads(ts_ms: int, seq: int) -> Dict[str, Dict[str, Any]]:
    """Build one staged payload set; health models the current degraded node."""
    return {
        "doa": contract.build_doa(
            seq=seq,
            ts_ms=ts_ms,
            relative_doa_deg=137.4,
            confidence=0.923,
            power_db=-54.2,
            frequency_hz=433_920_000,
            processing_ms=12,
            snr_db=14.5,
            config_rev=8,
            valid=False,
        ),
        "nav": contract.build_nav(
            seq=seq,
            ts_ms=ts_ms,
            lat=-6.9147,
            lon=107.6098,
            heading_deg=121.5,
            speed_mps=12.2,
            source="synthetic",
        ),
        "health": contract.build_health(
            ts_ms=ts_ms,
            state="DEGRADED",
            daq_ok=False,
            dropped_frames=0,
            gps_status="Disabled",
            doa_valid=False,
            doa_age_ms=None,
            frame_sync=True,
            sample_delay_sync=False,
            iq_sync=False,
        ),
        "state": contract.build_state(
            ts_ms=ts_ms,
            config_rev=8,
            running=True,
            frequency_hz=415_788_200,
            gain_db=15.7,
            array="UCA",
            method="MUSIC",
            active_vfos=1,
        ),
        "config_reported": contract.build_config_reported(
            ts_ms=ts_ms,
            config_rev=8,
            center_frequency_hz=415_788_200,
            gain_db=15.7,
            array="UCA",
            method="MUSIC",
            active_vfos=1,
        ),
    }


def publish(
    host: str,
    port: int,
    duration_s: float,
    doa_rate_hz: float,
    nav_rate_hz: float,
    health_rate_hz: float,
    repeat_state: bool = False,
) -> Dict[str, Any]:
    connected = Event()
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="stage4-repro-publisher")

    def on_connect(_client: mqtt.Client, _userdata: Any, _flags: Any, reason_code: Any, _properties: Any) -> None:
        if _reason_value(reason_code) == 0:
            connected.set()

    client.on_connect = on_connect
    client.connect(host, port, keepalive=15)
    client.loop_start()
    try:
        if not connected.wait(5):
            raise RuntimeError("synthetic publisher did not connect")
        if duration_s <= 0:
            raise ValueError("duration_s must be positive")
        if min(doa_rate_hz, nav_rate_hz, health_rate_hz) <= 0:
            raise ValueError("telemetry rates must be positive")

        started = time.monotonic()
        deadline = started + duration_s
        next_doa = started
        next_nav = started
        next_health = started
        next_state = started
        seq = 1000
        counts: Counter[str] = Counter()
        bytes_by_kind: Counter[str] = Counter()
        publish_results: List[int] = []
        state_sent = False

        def send(kind: str, payload: Dict[str, Any], qos: int, retain: bool) -> None:
            encoded = contract.compact_json(payload).encode("utf-8")
            info = client.publish(contract.TOPICS[kind], encoded, qos=qos, retain=retain)
            info.wait_for_publish(timeout=5)
            publish_results.append(int(info.rc))
            counts[kind] += 1
            bytes_by_kind[kind] += len(encoded)

        while time.monotonic() < deadline:
            now = time.monotonic()
            timestamp_ms = int(time.time() * 1000)
            payloads = _build_payloads(timestamp_ms, seq)
            did_work = False

            if not state_sent or (repeat_state and now >= next_state):
                send("state", payloads["state"], contract.STATE_QOS, True)
                send("config_reported", payloads["config_reported"], contract.STATE_QOS, True)
                state_sent = True
                next_state = now + 1.0
                did_work = True
            if now >= next_doa:
                send("doa", payloads["doa"], contract.TELEMETRY_QOS, False)
                next_doa += 1.0 / doa_rate_hz
                did_work = True
            if now >= next_nav:
                send("nav", payloads["nav"], contract.TELEMETRY_QOS, False)
                next_nav += 1.0 / nav_rate_hz
                did_work = True
            if now >= next_health:
                send("health", payloads["health"], contract.TELEMETRY_QOS, False)
                next_health += 1.0 / health_rate_hz
                did_work = True

            if did_work:
                seq += 1
            else:
                next_due = min(next_doa, next_nav, next_health, next_state if repeat_state else deadline)
                time.sleep(min(0.01, max(0.001, next_due - time.monotonic())))

        elapsed_s = max(time.monotonic() - started, 1e-9)
        total_bytes = sum(bytes_by_kind.values())
        return {
            "broker": {"host": host, "port": port},
            "duration_s": round(elapsed_s, 6),
            "rates_hz": {"doa": doa_rate_hz, "nav": nav_rate_hz, "health": health_rate_hz},
            "state_mode": "periodic_1hz" if repeat_state else "startup_once",
            "messages": sum(counts.values()),
            "counts_by_kind": dict(counts),
            "bytes_by_kind": dict(bytes_by_kind),
            "payload_bytes": total_bytes,
            "payload_bits": total_bytes * 8,
            "payload_rate_bits_s": round(total_bytes * 8 / elapsed_s, 3),
            "publish_rcs": sorted(set(publish_results)),
            "transport": "synthetic_only",
        }
    finally:
        client.loop_stop()
        client.disconnect()


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Publish synthetic SDR-DoA MQTT telemetry")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18884)
    parser.add_argument("--duration", type=float, default=5.0)
    parser.add_argument("--doa-rate", type=float, default=2.0)
    parser.add_argument("--nav-rate", type=float, default=1.0)
    parser.add_argument("--health-rate", type=float, default=1.0)
    parser.add_argument(
        "--repeat-state",
        action="store_true",
        help="also send state and reported config at 1 Hz for a stress comparison",
    )
    args = parser.parse_args(argv)
    if not (1 <= args.port <= 65535):
        parser.error("port must be between 1 and 65535")
    if args.duration <= 0 or args.duration > 3600:
        parser.error("duration must be between 0 and 3600 seconds")
    if min(args.doa_rate, args.nav_rate, args.health_rate) <= 0:
        parser.error("telemetry rates must be positive")
    try:
        print(
            json.dumps(
                publish(
                    args.host,
                    args.port,
                    args.duration,
                    args.doa_rate,
                    args.nav_rate,
                    args.health_rate,
                    args.repeat_state,
                ),
                sort_keys=True,
            )
        )
        return 0
    except (OSError, RuntimeError, ValueError) as exc:
        print(json.dumps({"error": str(exc), "transport": "synthetic_only"}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
