#!/usr/bin/env python3
"""MQTT monitor for the Ground Console.

It subscribes to the RDF Node topics under ``sdr/v2/<node>/`` (the edge
contract, ``docs/MQTT_KONTRAK.md``) and, on its own, never publishes. Its one
publish path is ``publish_rdf_node_command``: a Kontrol command
(``config.patch`` after the admin's review and confirmation, or the read-only
``config.get``) that the console server builds and hands it, published to
``sdr/v2/<node>/cmd/config/...`` at QoS 1, never retained and only while
connected with every subscription acknowledged. It never writes a Raspberry
resource directly; the RDF Node edge decides whether to apply the command and
answers on ``ack/config``.
"""

from __future__ import annotations

import math
import secrets
import threading
import time
from collections import OrderedDict
from typing import Any, Dict, Iterable, Mapping, Optional

import paho.mqtt.client as mqtt
from paho.mqtt.packettypes import PacketTypes
from paho.mqtt.properties import Properties

if __package__:
    from . import rdf_node_commands as commands
    from .config_command_tracker import FINAL_ACK_STATUSES, MonitorPublishError
    from .rdf_node_mqtt_v2 import RDF_NODE_V2_SUFFIXES, RdfNodeV2Telemetry
else:
    import rdf_node_commands as commands
    from config_command_tracker import FINAL_ACK_STATUSES, MonitorPublishError
    from rdf_node_mqtt_v2 import RDF_NODE_V2_SUFFIXES, RdfNodeV2Telemetry


# Brokers must accept client ids of 1-23 alphanumeric characters. The random
# suffix keeps two consoles on one broker from taking over each other's session.
CLIENT_ID_PREFIX = "groundconsole"
RECONNECT_MIN_DELAY_S = 1
RECONNECT_MAX_DELAY_S = 10
# Bounded memory for the Kontrol command path: the commands this client
# published (with their PUBACK, ACKs and settings report), and PUBACKs that
# arrived before their mid was known.
MAX_COMMAND_RECORDS = 32
MAX_EARLY_PUBACKS = 16


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


class MqttMonitor:
    """The console's one MQTT client, for the RDF Node topics (docs/MQTT_KONTRAK.md).

    It subscribes only; ``publish_rdf_node_command`` is the single publish
    path, used for Kontrol's ``config.get`` and admin-confirmed ``config.patch``.
    """

    def __init__(
        self,
        host: str,
        port: int,
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
        self.transport = transport
        self.ws_path = ws_path
        self.username = username
        self.password = password
        self.client_id = CLIENT_ID_PREFIX + secrets.token_hex(5)
        self._rdf_node = RdfNodeV2Telemetry(node_id)
        self._rdf_node.on_accepted = self._on_rdf_node_accepted
        self._filters = tuple(f"{self._rdf_node.prefix}{suffix}" for suffix in RDF_NODE_V2_SUFFIXES)
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
        # Kontrol commands this client published, or took over from the
        # monitor it replaced, by id: PUBACK, the edge's progress and final
        # ACK, and a config.get's settings report.
        self._commands: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
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
                # Retain As Published: the contract's validation needs the
                # publisher's retain flag, not the broker's replay mark.
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
            if not topic.startswith(self._rdf_node.prefix):
                return
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

    def _on_rdf_node_accepted(self, suffix: str, record: Dict[str, Any]) -> None:
        """Keep the ACKs and the settings report of the commands this client sent or adopted.

        The store calls this, under ``_lock``, for every ACK and settings
        report it accepted for the current node session.
        """
        command_id = record.get("id")
        command = self._commands.get(command_id) if isinstance(command_id, str) else None
        if command is None:
            return
        if suffix == commands.SETTINGS_SUFFIX:
            if command["reported_at_ms"] is None:
                command["reported_at_ms"] = record.get("received_at_ms")
            return
        ack = {key: record.get(key) for key in ("status", "t", "rev", "result", "received_at_ms")}
        if record.get("status") in FINAL_ACK_STATUSES:
            # The first final ACK is the answer; a later one never replaces it.
            if command["final"] is None:
                command["final"] = ack
        elif command["final"] is None:
            command["progress"] = ack

    def _on_publish(
        self,
        client: Any,
        _userdata: Any,
        mid: Any,
        reason_code: Any = None,
        _properties: Any = None,
    ) -> None:
        """Record a PUBACK. paho calls this with its own message lock held,
        which is why ``publish_rdf_node_command`` never publishes under ``_lock``."""
        if type(mid) is not int:
            return
        with self._lock:
            if client is not self._client or not self._started or self._stopping:
                return
            puback = {"received_at_ms": _now_ms(), "reason": _reason_value(reason_code)}
            command_id = self._publish_mids.pop(mid, None)
            record = self._commands.get(command_id) if command_id is not None else None
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

    @property
    def node_id(self) -> str:
        return self._rdf_node.node_id

    def publish_rdf_node_command(self, command: Mapping[str, Any]) -> Dict[str, Any]:
        """Publish one checked RDF Node command at QoS 1, never retained.

        The topic follows the command's ``op`` (``cmd/config/get`` or
        ``cmd/config/patch`` under ``sdr/v2/<node>/``). It publishes only
        while connected with every subscription acknowledged, so paho does
        not hold a command back for a later reconnect. The broker drops it
        after its lifetime (MessageExpiryInterval), and the edge refuses it
        after ``expires_ms``. For a ``config.get`` the store is told first to
        accept the ``settings/reported`` with this id.
        """
        try:
            command = commands.validate_command(command)
        except commands.CommandRefused as exc:
            raise MonitorPublishError("MQTT_PUBLISH_FAILED", f"command refused: {exc.message}") from exc
        command_id = str(command["id"])
        raw = commands.encode_command(command)
        topic = commands.command_topic(self._rdf_node.node_id, command["op"])
        ttl_ms = int(command["expires_ms"]) - int(command["issued_ms"])
        with self._lock:
            if not self._publish_ready_locked():
                raise MonitorPublishError("MQTT_NOT_CONNECTED", "MQTT monitor is not connected")
            if command_id in self._commands:
                raise MonitorPublishError("MQTT_PUBLISH_FAILED", "command id was already published")
            client = self._client
            mqtt_module = self._mqtt
            if command["op"] == commands.OP_CONFIG_GET:
                self._rdf_node.expect_settings_report(command_id, _now_ms(), sid=str(command["sid"]))
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
                qos=commands.COMMAND_QOS,
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
            # be withdrawn; track it so its ACK is still seen. Its lifetime
            # bounds how late the edge can act on it.
        with self._lock:
            record: Dict[str, Any] = {
                "op": command["op"],
                "adopted": False,
                "mid": mid,
                "published_at_ms": published_at_ms,
                "puback": None,
                "progress": None,
                "final": None,
                "reported_at_ms": None,
            }
            if mid is not None:
                early = self._early_pubacks.pop(mid, None)
                # paho reuses mids, so only a PUBACK that arrived during this
                # publish call can belong to it.
                if early is not None and early["received_at_ms"] >= publish_started_ms:
                    record["puback"] = early
                else:
                    self._publish_mids[mid] = command_id
            self._keep_command_locked(command_id, record)
        return {"mid": mid, "rc": rc, "published_at_ms": published_at_ms, "topic": topic}

    def _keep_command_locked(self, command_id: str, record: Dict[str, Any]) -> None:
        self._commands[command_id] = record
        while len(self._commands) > MAX_COMMAND_RECORDS:
            oldest_id, oldest = self._commands.popitem(last=False)
            if oldest.get("mid") is not None and self._publish_mids.get(oldest["mid"]) == oldest_id:
                self._publish_mids.pop(oldest["mid"], None)

    def adopt_rdf_node_commands(self, pending: Iterable[Mapping[str, Any]]) -> int:
        """Follow commands a replaced monitor published and that are not final yet.

        Each item names ``command_id``, ``op`` and the ``sid`` the command
        carried. The edge answers on ``ack/config`` whichever client is
        connected, so after a reconnect only this monitor can still see the
        ACK, and the ``settings/reported`` of a ``config.get``. Nothing is
        published; the PUBACK stays with the client that sent the command.
        What the store already accepted for an id is taken at once. Returns
        how many commands this monitor now follows.
        """
        adopted = 0
        with self._lock:
            now = _now_ms()
            for item in list(pending)[:MAX_COMMAND_RECORDS]:
                if not isinstance(item, Mapping):
                    continue
                command_id = item.get("command_id")
                op = item.get("op")
                sid = item.get("sid")
                if not isinstance(command_id, str) or not commands.COMMAND_ID_RE.fullmatch(command_id):
                    continue
                if op not in (commands.OP_CONFIG_GET, commands.OP_CONFIG_PATCH):
                    continue
                if command_id in self._commands:
                    continue
                self._keep_command_locked(command_id, {
                    "op": op,
                    "adopted": True,
                    "mid": None,
                    "published_at_ms": None,
                    "puback": None,
                    "progress": None,
                    "final": None,
                    "reported_at_ms": None,
                })
                adopted += 1
                ack = self._rdf_node.ack(command_id)
                if ack is not None:
                    self._on_rdf_node_accepted(str(ack.get("topic") or "ack/config"), ack)
                report = self._rdf_node.settings_report()
                if report is not None and report.get("id") == command_id:
                    self._on_rdf_node_accepted(commands.SETTINGS_SUFFIX, report)
                waiting = ack is None or not ack.get("final") or ack.get("status") == "APPLIED"
                if op == commands.OP_CONFIG_GET and waiting and self._commands[command_id]["reported_at_ms"] is None:
                    try:
                        self._rdf_node.expect_settings_report(
                            command_id, now, sid=sid if isinstance(sid, str) else None,
                        )
                    except ValueError:
                        self._rdf_node.expect_settings_report(command_id, now)
        return adopted

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

    def rdf_node_command_observation(self, command_id: str) -> Dict[str, Any]:
        """PUBACK, ACKs and settings report seen for one command id this client
        published or adopted (``adopt_rdf_node_commands``); nothing for any other id."""
        with self._lock:
            record = self._commands.get(command_id)
            if record is None:
                return {
                    "published": False, "adopted": False,
                    "puback": None, "progress": None, "final": None, "reported_at_ms": None,
                }
            return {
                "published": not record["adopted"],
                "adopted": record["adopted"],
                "puback": dict(record["puback"]) if record["puback"] else None,
                "progress": dict(record["progress"]) if record["progress"] else None,
                "final": dict(record["final"]) if record["final"] else None,
                "reported_at_ms": record["reported_at_ms"],
            }

    def _connection_label_locked(self) -> str:
        if self._publish_ready_locked():
            return "connected"
        if self._connection == "connected":
            return "connecting"
        return self._connection

    def rdf_node_control_view(self) -> Dict[str, Any]:
        """What Kontrol needs: connection, node session and the latest settings report.

        The report keeps the node's exact ``settings_json`` text; the console
        server passes on only its safe fields.
        """
        with self._lock:
            now = _now_ms()
            return {
                "available": True,
                "connection": self._connection_label_locked(),
                "node_id": self._rdf_node.node_id,
                "now_ms": now,
                "session": self._rdf_node.session_view(now),
                "settings": self._rdf_node.settings_report(),
            }

    def snapshot(self) -> Dict[str, Any]:
        """The one MQTT status (``GET /api/mqtt``): broker, connection and message counts.

        The counts are those of every subscribed RDF Node topic; per-topic
        statuses are in ``rdf_node_snapshot``.
        """
        with self._lock:
            now = _now_ms()
            counters = self._rdf_node.counters()
            last = counters["last_received_at_ms"]
            return {
                "enabled": True,
                "read_only": True,
                "publish_enabled": False,
                "host": self.host,
                "port": self.port,
                "transport": self.transport,
                "ws_path": self.ws_path,
                "node_id": self._rdf_node.node_id,
                "root": self._rdf_node.prefix.rstrip("/"),
                "now_ms": now,
                "connection": self._connection,
                "last_error": self._last_error,
                **counters,
                "last_age_ms": None if last is None else max(0, now - last),
            }

    def rdf_node_session(self) -> Dict[str, Any]:
        """The RDF Node session (``state.sid``, ``boot``, ``cfg``) and health freshness."""
        with self._lock:
            return self._rdf_node.session_view(_now_ms())

    def expect_rdf_node_settings_report(self, command_id: str) -> None:
        """Accept the settings/reported answer to a config.get the console sent."""
        with self._lock:
            self._rdf_node.expect_settings_report(command_id, _now_ms())

    def rdf_node_settings_report(self) -> Optional[Dict[str, Any]]:
        """The latest accepted settings/reported, with its exact settings.json text.

        ``safe_settings`` is empty unless ``matches_state_cfg`` (its ``rev`` is ``state.cfg``).
        """
        with self._lock:
            return self._rdf_node.settings_report()

    def rdf_node_ack(self, command_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            return self._rdf_node.ack(command_id)

    def _rdf_connection_locked(self) -> str:
        if not self._started:
            return "disabled"
        if self._connection == "connected" and self._subscriptions_ready:
            return "ready"
        if self._connection in ("disconnected", "error"):
            return self._connection
        return "connecting"

    def rdf_node_snapshot(self) -> Dict[str, Any]:
        with self._lock:
            result = self._rdf_node.snapshot(_now_ms())
            result.update({
                "enabled": self._started,
                "connection": self._rdf_connection_locked(),
                "node_id": self._rdf_node.node_id,
                "last_error": self._rdf_last_error,
            })
            return result

    def rdf_node_view(self) -> Optional[Dict[str, Any]]:
        """The RDF Node view the Dashboard's telemetry source reads (issue #8).

        The accepted values of the node (``RdfNodeV2Telemetry.node_view``,
        with the LIVE Angular frame's 360 values) at one time, or None while
        the monitor is stopped.
        """
        with self._lock:
            if not self._started:
                return None
            now = _now_ms()
            return {
                "now_ms": now,
                "connection": self._rdf_connection_locked(),
                "node_id": self._rdf_node.node_id,
                "node": self._rdf_node.node_view(now),
            }


__all__ = ["MqttMonitor"]
