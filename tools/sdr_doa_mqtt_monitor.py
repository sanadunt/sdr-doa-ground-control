#!/usr/bin/env python3
"""MQTT monitor for the Ground Console.

It subscribes to a configured topic root and, on its own, never publishes. Its
one publish path is ``publish_config_patch``: an explicit, admin-confirmed
config patch that the console server hands it (QoS 1, never retained, only
while connected). It never writes a Raspberry resource directly; the edge
agent decides whether to apply the patch and answers on ``ack/config``.
"""

from __future__ import annotations

import math
import secrets
import threading
import time
from typing import Any, Dict, Mapping, Optional

import paho.mqtt.client as mqtt
from paho.mqtt.packettypes import PacketTypes
from paho.mqtt.properties import Properties

import sdr_doa_mqtt as contract

if __package__:
    from .config_command_tracker import FINAL_ACK_STATUSES, MonitorPublishError
    from .rdf_node_mqtt_v2 import RDF_NODE_V2_SUFFIXES, RdfNodeV2Telemetry
else:
    from config_command_tracker import FINAL_ACK_STATUSES, MonitorPublishError
    from rdf_node_mqtt_v2 import RDF_NODE_V2_SUFFIXES, RdfNodeV2Telemetry


KNOWN_SUFFIXES = {
    "/telemetry/doa": "doa",
    "/telemetry/nav": "nav",
    "/telemetry/health": "health",
    "/state": "state",
    "/config/reported": "config_reported",
    "/cmd/config/patch": "config_patch",
    "/ack/config": "ack_config",
    "/availability": "availability",
}

MAX_TRACKED_TOPICS = 128
OTHER_TOPICS_KEY = "__other__"
DECODED_KINDS = frozenset({
    "doa", "nav", "health", "state", "config_reported", "config_patch", "ack_config",
    "availability",
})
# Only these v1 kinds are published retained, so only here can a zero-length
# publish be a retained clear. Elsewhere it is a malformed message.
RETAINED_KINDS = frozenset({"state", "config_reported", "availability"})
EMPTY_PAYLOAD_ERROR = "empty payload"
VALIDITY_FLAG_FIELDS = ("valid", "doa_valid", "settings_valid")
# Brokers must accept client ids of 1-23 alphanumeric characters. The random
# suffix keeps two consoles on one broker from taking over each other's session.
CLIENT_ID_PREFIX = "groundconsole"
RECONNECT_MIN_DELAY_S = 1
RECONNECT_MAX_DELAY_S = 10
CONFIG_PATCH_SUFFIX = "/cmd/config/patch"
# Bounded memory for the config-patch path: ACKs by command id, the commands
# this client published, and PUBACKs that arrived before their mid was known.
MAX_CONFIG_ACKS = 64
MAX_CONFIG_PUBLISHES = 32
MAX_EARLY_PUBACKS = 16
CONFIG_FIELDS = tuple(contract.CONFIG_RANGES)
# RDF Node v2 reports the first VFO under its own key names. Only these VFO
# values are reported anywhere; v1 config_reported has no VFO fields.
V2_EFFECTIVE_KEYS = {
    "center_frequency_hz": "center_frequency_hz",
    "gain_db": "gain_db",
    "vfo_frequency_hz": "vfo0_frequency_hz",
    "vfo_bandwidth_hz": "vfo0_bandwidth_hz",
    "vfo_squelch_db": "vfo0_squelch_db",
}
V1_REPORTED_FIELDS = ("center_frequency_hz", "gain_db")


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


def _finite_number(value: Any) -> Optional[float]:
    if type(value) is int:
        return value
    if type(value) is float and math.isfinite(value):
        return value
    return None


class MqttMonitor:
    """One MQTT client for v1 metrics and RDF Node v2 telemetry.

    It subscribes only; ``publish_config_patch`` is the single publish path,
    used for an explicit, admin-confirmed config patch.
    """

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
        self.client_id = CLIENT_ID_PREFIX + secrets.token_hex(5)
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
        self._last_error: Optional[str] = None
        self._rdf_last_error: Optional[str] = None
        self._pending_subacks: Dict[int, tuple[str, ...]] = {}
        self._subscriptions_ready = False
        self._received = 0
        self._valid = 0
        self._invalid = 0
        self._cleared = 0
        self._total_bytes = 0
        self._last_received_at_ms: Optional[int] = None
        self._last_latency_ms: Optional[int] = None
        self._last_topic: Optional[str] = None
        self._last_by_kind: Dict[str, Dict[str, Any]] = {}
        self._topic_counts: Dict[str, int] = {}
        self._kind_counts: Dict[str, int] = {}
        # Config-patch observations. Kept apart from _last_by_kind so the
        # Message Monitor snapshot keeps its exact shape.
        self._message_seq = 0
        self._v1_reported: Optional[Dict[str, Any]] = None
        self._v1_state: Optional[Dict[str, Any]] = None
        self._v1_last_ack: Optional[Dict[str, Any]] = None
        self._config_acks: Dict[str, Dict[str, Any]] = {}
        self._config_publishes: Dict[str, Dict[str, Any]] = {}
        self._publish_mids: Dict[int, str] = {}
        self._early_pubacks: Dict[int, Dict[str, Any]] = {}

    def start(self) -> None:
        with self._lifecycle_lock:
            with self._lock:
                if self._started:
                    return
                self._started = True
                self._stopping = False
                self._connection = "connecting"
                self._last_error = None
                self._rdf_last_error = None
                self._pending_subacks.clear()
                self._subscriptions_ready = False
                # A new client numbers its packets from scratch.
                self._publish_mids.clear()
                self._early_pubacks.clear()
            client: Any = None
            try:
                client = mqtt.Client(
                    callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
                    client_id=self.client_id,
                    protocol=mqtt.MQTTv5,
                    transport=self.transport,
                )
                client.on_connect = self._on_connect
                client.on_connect_fail = self._on_connect_fail
                client.on_disconnect = self._on_disconnect
                client.on_subscribe = self._on_subscribe
                client.on_message = self._on_message
                client.on_publish = self._on_publish
                client.reconnect_delay_set(
                    min_delay=RECONNECT_MIN_DELAY_S,
                    max_delay=RECONNECT_MAX_DELAY_S,
                )
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
                self._last_error = None
                self._rdf_last_error = None
                self._pending_subacks.clear()
                self._subscriptions_ready = False
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
        self._last_error = detail or code
        self._rdf_last_error = code
        self._subscriptions_ready = False
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
            self._last_error = None
            self._rdf_last_error = None
            self._pending_subacks.clear()
            self._subscriptions_ready = False
            try:
                # v1 keeps Retain As Published off, so its retain flag marks a
                # broker replay; v2 validation needs the publisher's flag.
                v1_options = self._mqtt.SubscribeOptions(
                    qos=1,
                    noLocal=False,
                    retainAsPublished=False,
                    retainHandling=0,
                )
                v2_options = self._mqtt.SubscribeOptions(
                    qos=1,
                    noLocal=False,
                    retainAsPublished=True,
                    retainHandling=0,
                )
                v1_filter, *v2_filters = self._filters
                subscriptions = [
                    (v1_filter, v1_options),
                    *((topic, v2_options) for topic in v2_filters),
                ]
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
                self._last_error = "DISCONNECTED"
                self._rdf_last_error = "DISCONNECTED"
                self._pending_subacks.clear()
                self._subscriptions_ready = False

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
            if any(_subscription_failed(code) for code in codes):
                self._set_error_locked("SUBSCRIPTION_DENIED")
                return
            if not self._pending_subacks:
                self._connection = "connected"
                self._last_error = None
                self._rdf_last_error = None
                self._subscriptions_ready = True

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
            retained = bool(getattr(message, "retain", False))
            decoded: Optional[Dict[str, Any]] = None
            error: Optional[str] = None
            valid = True
            # A zero-length publish is how a publisher removes a retained
            # value; the broker forwards it to live subscribers. It means "no
            # current value", not a malformed message. The v1 filter hides the
            # publisher's retain flag, so the contract's retain policy decides.
            cleared = not payload_bytes and kind in RETAINED_KINDS
            if cleared:
                valid = False
            elif not payload_bytes:
                valid = False
                error = EMPTY_PAYLOAD_ERROR
            elif kind in DECODED_KINDS:
                try:
                    decoded = contract.decode_payload(kind, payload_bytes)
                except (contract.ContractError, ValueError, TypeError) as exc:
                    valid = False
                    error = str(exc)
            elif len(payload_bytes) > 16 * 1024:
                valid = False
                error = "payload exceeds monitor limit"

            source_ts = decoded.get("ts_ms") if decoded else None
            if type(source_ts) is not int:
                source_ts = None
            # A retained replay's receive-minus-source time is its age, not
            # transport latency. The availability will carries the session's
            # connect time, so its receive time is no latency measure either.
            latency_ms: Optional[int] = None
            if source_ts is not None and not retained and kind != "availability":
                latency_ms = received_at_ms - source_ts

            self._received += 1
            if cleared:
                self._cleared += 1
            elif valid:
                self._valid += 1
            else:
                self._invalid += 1
            self._total_bytes += len(payload_bytes)
            self._last_received_at_ms = received_at_ms
            if not retained and not cleared and kind != "availability":
                self._last_latency_ms = latency_ms
            self._last_topic = topic
            self._kind_counts[kind] = self._kind_counts.get(kind, 0) + 1
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
                "retained": retained,
                "valid": valid,
                "latency_ms": latency_ms,
                "source_ts_ms": source_ts,
            }
            if cleared:
                entry["cleared"] = True
            if decoded is not None:
                entry["payload"] = decoded
                source = decoded.get("source")
                if isinstance(source, str) and source:
                    entry["source"] = source[:contract.MAX_SOURCE_CHARS]
                flags = {
                    field: decoded[field]
                    for field in VALIDITY_FLAG_FIELDS
                    if isinstance(decoded.get(field), bool)
                }
                if flags:
                    entry["validity_flags"] = flags
            if error:
                entry["error"] = error
            self._last_by_kind[kind] = entry
            self._observe_config_locked(kind, decoded, payload_bytes, cleared, retained, received_at_ms)

    def _observe_config_locked(
        self,
        kind: str,
        decoded: Optional[Dict[str, Any]],
        payload_bytes: bytes,
        cleared: bool,
        retained: bool,
        received_at_ms: int,
    ) -> None:
        """Keep what the config-patch path needs: revisions, ACKs, echoes."""
        self._message_seq += 1
        observed = {
            "payload": decoded,
            "received_at_ms": received_at_ms,
            "retained": retained,
            "seq": self._message_seq,
        }
        if kind == "config_reported":
            if cleared:
                self._v1_reported = None
            elif decoded is not None:
                self._v1_reported = observed
        elif kind == "state":
            if cleared:
                self._v1_state = None
            elif decoded is not None:
                self._v1_state = observed
        elif kind == "ack_config" and decoded is not None:
            if not retained:
                # A broker replay of a retained ACK has no place in time
                # relative to config_reported, so it never moves the base.
                self._v1_last_ack = observed
            command_id = decoded.get("id")
            if isinstance(command_id, str):
                error = decoded.get("error") if isinstance(decoded.get("error"), Mapping) else {}
                changed = decoded.get("changed_fields")
                ack = {
                    "status": decoded.get("status"),
                    "config_rev": decoded.get("config_rev"),
                    "readback_ok": decoded.get("readback_ok"),
                    "error_code": error.get("code"),
                    "current_config_rev": error.get("current_config_rev"),
                    "changed_fields": list(changed) if isinstance(changed, list) else [],
                    "received_at_ms": received_at_ms,
                    "retained": retained,
                }
                previous = self._config_acks.pop(command_id, None)
                if previous is not None and previous.get("status") in FINAL_ACK_STATUSES and ack["status"] not in FINAL_ACK_STATUSES:
                    # A late progress ACK must not hide the final answer.
                    ack = previous
                self._config_acks[command_id] = ack
                while len(self._config_acks) > MAX_CONFIG_ACKS:
                    self._config_acks.pop(next(iter(self._config_acks)))
        elif kind == "config_patch" and decoded is not None:
            record = self._config_publishes.get(str(decoded.get("id")))
            if record is not None and record["echoed_at_ms"] is None and record["raw"] == payload_bytes:
                record["echoed_at_ms"] = received_at_ms

    def _on_publish(
        self,
        client: Any,
        _userdata: Any,
        mid: Any,
        reason_code: Any = None,
        _properties: Any = None,
    ) -> None:
        """Record a PUBACK. paho calls this with its own message lock held,
        which is why ``publish_config_patch`` never publishes under ``_lock``."""
        if type(mid) is not int:
            return
        with self._lock:
            if client is not self._client or not self._started or self._stopping:
                return
            puback = {"received_at_ms": _now_ms(), "reason": _reason_value(reason_code)}
            command_id = self._publish_mids.pop(mid, None)
            record = self._config_publishes.get(command_id) if command_id is not None else None
            if record is not None:
                record["puback"] = puback
                return
            self._early_pubacks.pop(mid, None)
            self._early_pubacks[mid] = puback
            while len(self._early_pubacks) > MAX_EARLY_PUBACKS:
                self._early_pubacks.pop(next(iter(self._early_pubacks)))

    def _publish_ready_locked(self) -> bool:
        return (
            self._started
            and not self._stopping
            and self._client is not None
            and self._connection == "connected"
            and self._subscriptions_ready
        )

    def publish_config_patch(self, command: Mapping[str, Any]) -> Dict[str, Any]:
        """Publish one validated config patch at QoS 1, never retained.

        It publishes only while connected with every subscription
        acknowledged, so paho does not hold a command back for a later
        reconnect. The broker drops it after its TTL (MessageExpiryInterval),
        and the edge agent rejects it after ``expires_ts_ms``.
        """
        payload = contract.validate_config_patch(command)
        command_id = str(payload["id"])
        raw = contract.compact_json(payload).encode("utf-8")
        topic = self.root + CONFIG_PATCH_SUFFIX
        ttl_ms = int(payload["expires_ts_ms"]) - int(payload["issued_ts_ms"])
        with self._lock:
            if not self._publish_ready_locked():
                raise MonitorPublishError("MQTT_NOT_CONNECTED", "MQTT monitor is not connected")
            if command_id in self._config_publishes:
                raise MonitorPublishError("MQTT_PUBLISH_FAILED", "command id was already published")
            client = self._client
            mqtt_module = self._mqtt
        success = int(getattr(mqtt_module, "MQTT_ERR_SUCCESS", 0))
        no_connection = int(getattr(mqtt_module, "MQTT_ERR_NO_CONN", 4))
        # Never under _lock: paho holds its message lock while it calls
        # on_publish, and publish() takes that same lock.
        publish_started_ms = _now_ms()
        try:
            properties = Properties(getattr(PacketTypes, "PUBLISH", 3))
            properties.MessageExpiryInterval = max(1, math.ceil(ttl_ms / 1000))
            info = client.publish(
                topic,
                raw,
                qos=contract.COMMAND_QOS,
                retain=False,
                properties=properties,
            )
        except Exception as exc:
            raise MonitorPublishError("MQTT_PUBLISH_FAILED", f"MQTT publish failed: {type(exc).__name__}") from exc
        published_at_ms = _now_ms()
        rc = success if info is None else int(getattr(info, "rc", success))
        mid = getattr(info, "mid", None) if info is not None else None
        if type(mid) is not int:
            mid = None
        if rc != success:
            if rc == no_connection and self._drop_unsent(client, mid):
                raise MonitorPublishError("MQTT_NOT_CONNECTED", "MQTT connection closed before the publish")
            if rc != no_connection:
                raise MonitorPublishError("MQTT_PUBLISH_FAILED", f"MQTT publish returned rc={rc}")
            # paho kept the command for its next connection and it could not
            # be withdrawn; track it so its ACK is still seen. Its TTL bounds
            # how late it can be applied.
        with self._lock:
            record: Dict[str, Any] = {
                "mid": mid,
                "published_at_ms": published_at_ms,
                "puback": None,
                "echoed_at_ms": None,
                "raw": raw,
            }
            if mid is not None:
                early = self._early_pubacks.pop(mid, None)
                # paho reuses mids, so only a PUBACK that arrived during this
                # publish call can belong to it.
                if early is not None and early["received_at_ms"] >= publish_started_ms:
                    record["puback"] = early
                else:
                    self._publish_mids[mid] = command_id
            self._config_publishes[command_id] = record
            while len(self._config_publishes) > MAX_CONFIG_PUBLISHES:
                oldest_id = next(iter(self._config_publishes))
                oldest = self._config_publishes.pop(oldest_id)
                if oldest.get("mid") is not None and self._publish_mids.get(oldest["mid"]) == oldest_id:
                    self._publish_mids.pop(oldest["mid"], None)
        return {"mid": mid, "rc": rc, "published_at_ms": published_at_ms, "topic": topic}

    @staticmethod
    def _drop_unsent(client: Any, mid: Optional[int]) -> bool:
        """Withdraw a QoS 1 message paho queued while disconnected.

        With MQTT_ERR_NO_CONN nothing reached the socket, but paho keeps the
        message and would send it after the next reconnect. Returns True when
        it was removed. Uses paho 2.x internals; any mismatch is a no-op.
        """
        messages = getattr(client, "_out_messages", None)
        mutex = getattr(client, "_out_message_mutex", None)
        if mid is None or messages is None or mutex is None:
            return False
        try:
            with mutex:
                return messages.pop(mid, None) is not None
        except Exception:
            return False

    def config_command_observation(self, command_id: str) -> Dict[str, Any]:
        """PUBACK, broker echo and ACK seen for one published command id."""
        with self._lock:
            record = self._config_publishes.get(command_id)
            ack = self._config_acks.get(command_id)
            return {
                "published": record is not None,
                "puback": dict(record["puback"]) if record is not None and record["puback"] else None,
                "echoed_at_ms": record["echoed_at_ms"] if record is not None else None,
                "ack": dict(ack) if ack is not None else None,
            }

    def _connection_label_locked(self) -> str:
        if self._publish_ready_locked():
            return "connected"
        if self._connection == "connected":
            return "connecting"
        return self._connection

    def _base_revision_locked(self) -> tuple[Optional[int], Optional[str]]:
        """The v1 revision a new patch must be based on (RDF v2 rev never is)."""
        reported = self._v1_reported
        if reported is not None:
            revision: Optional[int] = reported["payload"].get("config_rev")
            source = "config_reported"
            ack = self._v1_last_ack
            if ack is not None and ack["seq"] > reported["seq"]:
                ack_payload = ack["payload"]
                status = ack_payload.get("status")
                ack_revision: Any = None
                if status == "applied":
                    ack_revision = ack_payload.get("config_rev")
                elif status == "conflict" and isinstance(ack_payload.get("error"), Mapping):
                    ack_revision = ack_payload["error"].get("current_config_rev")
                if type(ack_revision) is int and ack_revision >= 0:
                    revision, source = ack_revision, "ack"
            if type(revision) is int:
                return revision, source
        state = self._v1_state
        if state is not None and type(state["payload"].get("config_rev")) is int:
            return state["payload"]["config_rev"], "state"
        return None, None

    def reported_config(self) -> Dict[str, Any]:
        """Reported settings and the base revision for the Kontrol panel."""
        with self._lock:
            now = _now_ms()
            revision, revision_source = self._base_revision_locked()
            values: Dict[str, Any] = {field: None for field in CONFIG_FIELDS}
            sources: Dict[str, Optional[str]] = {field: None for field in CONFIG_FIELDS}
            v1 = self._v1_reported
            if v1 is not None:
                for field in V1_REPORTED_FIELDS:
                    value = _finite_number(v1["payload"].get(field))
                    if value is not None:
                        values[field], sources[field] = value, "v1_config_reported"
            v2_entry = self._rdf_node.config_reported_entry()
            v2_payload = v2_entry.get("payload") if v2_entry.get("status") == "CONTEXT" else None
            effective = v2_payload.get("effective") if isinstance(v2_payload, dict) else None
            if not isinstance(effective, dict):
                effective = None
            if effective is not None:
                for field, key in V2_EFFECTIVE_KEYS.items():
                    value = _finite_number(effective.get(key))
                    if value is not None and values[field] is None:
                        values[field], sources[field] = value, "v2_effective"
            reported: Optional[Dict[str, Any]] = None
            if v1 is not None:
                received = int(v1["received_at_ms"])
                reported = {
                    "config_rev": v1["payload"].get("config_rev"),
                    "received_at_ms": received,
                    "age_ms": max(0, now - received),
                    "retained": bool(v1["retained"]),
                    "synthetic": v1["payload"].get("source") == "synthetic",
                    "source": "v1+v2" if effective is not None else "v1",
                }
            elif effective is not None:
                received_v2 = v2_entry.get("received_at_ms")
                reported = {
                    "config_rev": None,
                    "received_at_ms": received_v2 if type(received_v2) is int else None,
                    "age_ms": max(0, now - received_v2) if type(received_v2) is int else None,
                    "retained": v2_entry.get("retained") is True,
                    "synthetic": False,
                    "source": "v2",
                }
            return {
                "available": True,
                "connection": self._connection_label_locked(),
                "now_ms": now,
                "base_config_rev": revision,
                "base_config_rev_source": revision_source,
                "reported": reported,
                "values": values,
                "value_sources": sources,
            }

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            now = _now_ms()
            last_by_kind = {
                kind: {**entry, "age_ms": max(0, now - int(entry["received_at_ms"]))}
                for kind, entry in self._last_by_kind.items()
            }
            return {
                "enabled": True,
                "read_only": True,
                "publish_enabled": False,
                "host": self.host,
                "port": self.port,
                "transport": self.transport,
                "ws_path": self.ws_path,
                "root": self.root,
                "now_ms": now,
                "connection": self._connection,
                "last_error": self._last_error,
                "received": self._received,
                "valid": self._valid,
                "invalid": self._invalid,
                "cleared": self._cleared,
                "total_bytes": self._total_bytes,
                "last_received_at_ms": self._last_received_at_ms,
                "last_age_ms": (
                    None
                    if self._last_received_at_ms is None
                    else max(0, now - self._last_received_at_ms)
                ),
                "last_latency_ms": self._last_latency_ms,
                "last_topic": self._last_topic,
                "last_by_kind": last_by_kind,
                "kind_counts": dict(self._kind_counts),
                "topic_counts": dict(self._topic_counts),
            }

    def rdf_node_snapshot(self) -> Dict[str, Any]:
        with self._lock:
            if not self._started:
                connection = "disabled"
            elif self._connection == "connected" and self._subscriptions_ready:
                connection = "ready"
            elif self._connection == "disconnected":
                connection = "disconnected"
            elif self._connection == "error":
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
