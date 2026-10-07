#!/usr/bin/env python3
"""Display-only MQTT monitor for the Ground Console.

It subscribes to a configured topic root and never publishes, sends commands,
or writes a Raspberry resource.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Dict, Optional

import paho.mqtt.client as mqtt
from paho.mqtt.packettypes import PacketTypes
from paho.mqtt.properties import Properties

import sdr_doa_mqtt as contract

if __package__:
    from .rdf_node_mqtt_v2 import RDF_NODE_V2_SUFFIXES, RdfNodeV2Telemetry
else:
    from rdf_node_mqtt_v2 import RDF_NODE_V2_SUFFIXES, RdfNodeV2Telemetry


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


def _subscription_failed(reason_code: Any) -> bool:
    failure = getattr(reason_code, "is_failure", None)
    return bool(failure) if failure is not None else _reason_value(reason_code) >= 128


def _kind_for_topic(topic: str) -> Optional[str]:
    for suffix, kind in KNOWN_SUFFIXES.items():
        if topic.endswith(suffix):
            return kind
    return contract.kind_for_topic(topic)


class MqttMonitor:
    """One read-only MQTT client for v1 metrics and RDF Node v2 telemetry."""

    def __init__(
        self,
        host: str,
        port: int,
        root: str = contract.TOPIC_ROOT,
        *,
        transport: str = "tcp",
        ws_path: str = "/mqtt",
        username: str = "",
        password: str = "",
        node_id: str = "uav-01",
    ) -> None:
        if password and not username:
            raise ValueError("MQTT username is required when a password is set")
        self.host = host
        self.port = int(port)
        self.root = root.rstrip("/")
        self.transport = transport
        self.ws_path = ws_path
        self.username = username
        self.password = password
        self._rdf_node = RdfNodeV2Telemetry(node_id)
        self._filters = (
            self.root + "/#",
            *(f"{self._rdf_node.prefix}{suffix}" for suffix in RDF_NODE_V2_SUFFIXES),
        )
        self._lock = threading.RLock()
        self._lifecycle_lock = threading.Lock()
        self._client: Any = None
        self._mqtt: Any = None
        self._started = False
        self._stopping = False
        self._connection = "disabled"
        self._rdf_connection = "disabled"
        self._last_error: Optional[str] = None
        self._rdf_last_error: Optional[str] = None
        self._pending_subacks: Dict[int, tuple[str, ...]] = {}
        self._rdf_subscriptions_ready = False
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
        with self._lifecycle_lock:
            with self._lock:
                if self._started:
                    return
                self._started = True
                self._stopping = False
                self._connection = "connecting"
                self._rdf_connection = "connecting"
                self._last_error = None
                self._rdf_last_error = None
                self._pending_subacks.clear()
                self._rdf_subscriptions_ready = False
            client: Any = None
            try:
                client = mqtt.Client(
                    callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
                    client_id="ground-console-monitor",
                    protocol=mqtt.MQTTv5,
                    transport=self.transport,
                )
                client.on_connect = self._on_connect
                client.on_connect_fail = self._on_connect_fail
                client.on_disconnect = self._on_disconnect
                client.on_subscribe = self._on_subscribe
                client.on_message = self._on_message
                if self.username:
                    client.username_pw_set(self.username, self.password or None)
                if self.transport == "websockets":
                    client.ws_set_options(path=self.ws_path)
                self._mqtt = mqtt
                with self._lock:
                    self._client = client
                connect_properties = Properties(PacketTypes.CONNECT)
                connect_properties.SessionExpiryInterval = 0
                client.connect_async(
                    self.host,
                    self.port,
                    keepalive=15,
                    clean_start=True,
                    properties=connect_properties,
                )
                client.loop_start()
            except Exception as exc:
                with self._lock:
                    self._set_error_locked("CONNECTION_ERROR", str(exc))
                if client is not None:
                    try:
                        client.disconnect()
                    except Exception:
                        pass

    def stop(self) -> None:
        with self._lifecycle_lock:
            with self._lock:
                client = self._client
                self._stopping = True
                self._started = False
                self._connection = "stopped"
                self._rdf_connection = "stopped"
                self._last_error = None
                self._rdf_last_error = None
                self._pending_subacks.clear()
                self._rdf_subscriptions_ready = False
                self._client = None
            if client is None:
                return
            try:
                client.disconnect()
            except Exception:
                pass
            try:
                client.loop_stop()
            except Exception:
                pass

    def _set_error_locked(self, code: str, detail: Optional[str] = None) -> None:
        self._connection = "error"
        self._rdf_connection = "error"
        self._last_error = detail or code
        self._rdf_last_error = code
        self._rdf_subscriptions_ready = False
        self._pending_subacks.clear()

    def _on_connect(
        self,
        client: Any,
        _userdata: Any,
        _flags: Any,
        reason_code: Any,
        _properties: Any = None,
    ) -> None:
        with self._lock:
            if client is not self._client or self._stopping or not self._started:
                return
            if _reason_value(reason_code) != 0:
                self._set_error_locked("CONNECT_REFUSED", f"MQTT connect refused: {reason_code}")
                return
            self._connection = "connecting"
            self._rdf_connection = "connecting"
            self._last_error = None
            self._rdf_last_error = None
            self._pending_subacks.clear()
            self._rdf_subscriptions_ready = False
            try:
                options = self._mqtt.SubscribeOptions(
                    qos=1,
                    noLocal=False,
                    retainAsPublished=True,
                    retainHandling=0,
                )
                subscriptions = [(topic, options) for topic in self._filters]
                rc, mid = client.subscribe(subscriptions)
                if rc != getattr(self._mqtt, "MQTT_ERR_SUCCESS", 0):
                    self._set_error_locked("SUBSCRIBE_ERROR")
                    return
                self._pending_subacks[int(mid)] = self._filters
            except Exception:
                self._set_error_locked("SUBSCRIBE_ERROR")

    def _on_connect_fail(self, client: Any, _userdata: Any = None) -> None:
        with self._lock:
            if client is self._client and self._started and not self._stopping:
                self._set_error_locked("CONNECTION_ERROR")

    def _on_disconnect(self, client: Any, _userdata: Any, *args: Any) -> None:
        with self._lock:
            if client is self._client and self._started and not self._stopping:
                self._connection = "disconnected"
                self._rdf_connection = "disconnected"
                self._last_error = "DISCONNECTED"
                self._rdf_last_error = "DISCONNECTED"
                self._pending_subacks.clear()
                self._rdf_subscriptions_ready = False

    def _on_subscribe(
        self,
        client: Any,
        _userdata: Any,
        mid: int,
        reason_codes: Any,
        _properties: Any = None,
    ) -> None:
        with self._lock:
            if client is not self._client or not self._started or self._stopping:
                return
            filters = self._pending_subacks.pop(mid, None)
            if filters is None:
                return
            try:
                codes = list(reason_codes)
            except (TypeError, ValueError):
                self._set_error_locked("SUBACK_INVALID")
                return
            if len(codes) != len(filters):
                self._set_error_locked("SUBACK_INVALID")
                return
            # The v1 wildcard is first; all remaining filters are exact v2 topics.
            v1_failed = _subscription_failed(codes[0])
            rdf_failed = any(_subscription_failed(code) for code in codes[1:])
            if not self._pending_subacks:
                self._connection = "error" if v1_failed else "connected"
                self._last_error = "SUBSCRIPTION_DENIED" if v1_failed else None
                self._rdf_connection = "error" if rdf_failed else "connected"
                self._rdf_last_error = "SUBSCRIPTION_DENIED" if rdf_failed else None
                self._rdf_subscriptions_ready = not rdf_failed

    def _on_message(self, client: Any, _userdata: Any, message: Any) -> None:
        topic = str(getattr(message, "topic", ""))
        payload = getattr(message, "payload", None)
        if not isinstance(payload, bytes):
            return
        received_at_ms = _now_ms()
        with self._lock:
            if client is not self._client or not self._started or self._stopping:
                return
            if topic.startswith(self._rdf_node.prefix):
                suffix = topic[len(self._rdf_node.prefix):]
                if suffix not in RDF_NODE_V2_SUFFIXES:
                    return
                qos = getattr(message, "qos", None)
                retained = getattr(message, "retain", None)
                if type(qos) is not int or qos not in (0, 1) or type(retained) is not bool:
                    return
                properties = getattr(message, "properties", None)
                expiry = getattr(properties, "MessageExpiryInterval", None) if properties else None
                if type(expiry) is not int or expiry < 0:
                    expiry = None
                try:
                    self._rdf_node.ingest(
                        topic,
                        payload,
                        qos=qos,
                        retained=retained,
                        received_at_ms=received_at_ms,
                        message_expiry_s=expiry,
                    )
                except Exception:
                    return
                return

            payload_bytes = payload
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

    def rdf_node_snapshot(self) -> Dict[str, Any]:
        with self._lock:
            if not self._started:
                connection = "disabled"
            elif self._rdf_connection == "connected" and self._rdf_subscriptions_ready:
                connection = "ready"
            elif self._rdf_connection == "disconnected":
                connection = "disconnected"
            elif self._rdf_connection == "error":
                connection = "error"
            else:
                connection = "connecting"
            result = self._rdf_node.snapshot(_now_ms())
            result.update({
                "enabled": self._started,
                "connection": connection,
                "node_id": self._rdf_node.node_id,
                "last_error": self._rdf_last_error,
            })
            return result


__all__ = ["MqttMonitor"]
