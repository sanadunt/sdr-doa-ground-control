#!/usr/bin/env python3
"""Display-only MQTT monitor for the Ground Console.

The monitor subscribes to a bounded topic root and never publishes, sends
commands, or writes a Raspberry resource.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Dict, Optional

import paho.mqtt.client as mqtt

import sdr_doa_mqtt as contract


KNOWN_SUFFIXES = {
    "/telemetry/doa": "doa",
    "/telemetry/nav": "nav",
    "/telemetry/health": "health",
    "/state": "state",
    "/config/reported": "config_reported",
    "/cmd/config/patch": "config_patch",
    "/ack/config": "ack_config",
}

MAX_TRACKED_TOPICS = 128
OTHER_TOPICS_KEY = "__other__"


def _now_ms() -> int:
    return int(time.time() * 1000)


def _reason_value(reason_code: Any) -> int:
    value = getattr(reason_code, "value", reason_code)
    try:
        return int(value)
    except (TypeError, ValueError):
        return 1


def _kind_for_topic(topic: str) -> Optional[str]:
    for suffix, kind in KNOWN_SUFFIXES.items():
        if topic.endswith(suffix):
            return kind
    return contract.kind_for_topic(topic)


class MqttMonitor:
    """Thread-safe, subscribe-only MQTT metrics collector."""

    def __init__(
        self,
        host: str,
        port: int,
        root: str = contract.TOPIC_ROOT,
        *,
        transport: str = "tcp",
        ws_path: str = "/mqtt",
    ) -> None:
        self.host = host
        self.port = int(port)
        self.root = root.rstrip("/")
        self._lock = threading.RLock()
        self._client = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2,
            client_id="ground-console-monitor",
            transport=transport,
        )
        if transport == "websockets":
            self._client.ws_set_options(path=ws_path)
        self._client.on_connect = self._on_connect
        self._client.on_disconnect = self._on_disconnect
        self._client.on_message = self._on_message
        self._started = False
        self._connection = "disabled"
        self._last_error: Optional[str] = None
        self._received = 0
        self._valid = 0
        self._invalid = 0
        self._total_bytes = 0
        self._last_received_at_ms: Optional[int] = None
        self._last_latency_ms: Optional[int] = None
        self._last_topic: Optional[str] = None
        self._last_by_kind: Dict[str, Dict[str, Any]] = {}
        self._topic_counts: Dict[str, int] = {}

    def start(self) -> None:
        if self._started:
            return
        self._started = True
        with self._lock:
            self._connection = "connecting"
        try:
            self._client.connect_async(self.host, self.port, keepalive=15)
            self._client.loop_start()
        except Exception as exc:  # pragma: no cover - broker-dependent
            with self._lock:
                self._connection = "error"
                self._last_error = str(exc)

    def stop(self) -> None:
        if not self._started:
            return
        try:
            self._client.disconnect()
        finally:
            self._client.loop_stop()
            self._started = False
            with self._lock:
                self._connection = "stopped"

    def _on_connect(
        self,
        client: mqtt.Client,
        userdata: Any,
        flags: Any,
        reason_code: Any,
        properties: Any,
    ) -> None:
        if _reason_value(reason_code) != 0:
            with self._lock:
                self._connection = "error"
                self._last_error = f"MQTT connect refused: {reason_code}"
            return
        try:
            client.subscribe(self.root + "/#", qos=1)
            with self._lock:
                self._connection = "connected"
                self._last_error = None
        except Exception as exc:  # pragma: no cover - broker-dependent
            with self._lock:
                self._connection = "error"
                self._last_error = str(exc)

    def _on_disconnect(self, client: mqtt.Client, userdata: Any, *args: Any) -> None:
        with self._lock:
            if self._started:
                self._connection = "disconnected"

    def _on_message(self, client: mqtt.Client, userdata: Any, message: mqtt.MQTTMessage) -> None:
        received_at_ms = _now_ms()
        payload_bytes = bytes(message.payload)
        topic = str(message.topic)
        kind = _kind_for_topic(topic) or "unknown"
        decoded: Optional[Dict[str, Any]] = None
        error: Optional[str] = None
        valid = True
        if kind in {"doa", "nav", "health", "state", "config_reported", "config_patch"}:
            try:
                decoded = contract.decode_payload(kind, payload_bytes)
            except (contract.ContractError, ValueError, TypeError) as exc:
                valid = False
                error = str(exc)
        elif len(payload_bytes) > 16 * 1024:
            valid = False
            error = "payload exceeds monitor limit"

        source_ts = decoded.get("ts_ms") if decoded else None
        latency_ms: Optional[int] = None
        if isinstance(source_ts, int):
            latency_ms = received_at_ms - source_ts

        with self._lock:
            self._received += 1
            self._valid += 1 if valid else 0
            self._invalid += 0 if valid else 1
            self._total_bytes += len(payload_bytes)
            self._last_received_at_ms = received_at_ms
            self._last_latency_ms = latency_ms
            self._last_topic = topic
            if topic in self._topic_counts:
                self._topic_counts[topic] += 1
            elif len(self._topic_counts) < MAX_TRACKED_TOPICS - 1:
                self._topic_counts[topic] = 1
            else:
                # Reserve one slot for the aggregate bucket so the map never
                # exceeds MAX_TRACKED_TOPICS even with unique topic names.
                self._topic_counts[OTHER_TOPICS_KEY] = self._topic_counts.get(OTHER_TOPICS_KEY, 0) + 1
            entry: Dict[str, Any] = {
                "topic": topic,
                "kind": kind,
                "received_at_ms": received_at_ms,
                "bytes": len(payload_bytes),
                "qos": int(message.qos),
                "retained": bool(message.retain),
                "valid": valid,
                "latency_ms": latency_ms,
            }
            if decoded is not None:
                entry["payload"] = decoded
            if error:
                entry["error"] = error
            self._last_by_kind[kind] = entry

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            now = _now_ms()
            return {
                "enabled": True,
                "read_only": True,
                "publish_enabled": False,
                "host": self.host,
                "port": self.port,
                "root": self.root,
                "connection": self._connection,
                "last_error": self._last_error,
                "received": self._received,
                "valid": self._valid,
                "invalid": self._invalid,
                "total_bytes": self._total_bytes,
                "last_received_at_ms": self._last_received_at_ms,
                "last_age_ms": (
                    None
                    if self._last_received_at_ms is None
                    else max(0, now - self._last_received_at_ms)
                ),
                "last_latency_ms": self._last_latency_ms,
                "last_topic": self._last_topic,
                "last_by_kind": dict(self._last_by_kind),
                "topic_counts": dict(self._topic_counts),
            }


__all__ = ["MqttMonitor"]
