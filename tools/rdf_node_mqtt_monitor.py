"""Read-only MQTTv5/TLS subscriber for RDF Node v2 telemetry."""
from __future__ import annotations

import ipaddress
import ssl
import threading
import time
from typing import Any

from tools.rdf_node_mqtt_v2 import RDF_NODE_V2_SUFFIXES, RdfNodeV2Telemetry


def _now_ms() -> int:
    return int(time.time() * 1000)


def _reason_failed(reason: Any) -> bool:
    failure = getattr(reason, "is_failure", None)
    if failure is not None:
        return bool(failure)
    value = getattr(reason, "value", reason)
    try:
        return int(value) >= 128
    except (TypeError, ValueError):
        return True


class RdfNodeMqttMonitor:
    """Own a loopback MQTT client and serialized validated telemetry store."""

    def __init__(self, host: str, port: int, node_id: str, username: str,
                 password: str, ca_file: str | None = None) -> None:
        try:
            address = ipaddress.ip_address(host)
        except (TypeError, ValueError):
            raise ValueError("host must be a loopback IP literal") from None
        if not address.is_loopback:
            raise ValueError("host must be a loopback IP literal")
        if type(port) is not int or not 1 <= port <= 65535:
            raise ValueError("invalid port")
        if not isinstance(username, str) or not isinstance(password, str):
            raise ValueError("invalid credentials")
        if ca_file is not None and not isinstance(ca_file, str):
            raise ValueError("invalid CA file")

        self.host = str(address)
        self.port = port
        self.node_id = node_id
        self.username = username
        self.password = password
        self.ca_file = ca_file
        self._store = RdfNodeV2Telemetry(node_id)
        self._lock = threading.RLock()
        self._client: Any = None
        self._mqtt: Any = None
        self._connection = "disabled"
        self._last_error: str | None = None
        self._enabled = False
        self._stopping = False
        self._pending_subacks: dict[int, str] = {}
        self._successful_filters: set[str] = set()
        self._filters = tuple(f"sdr/v2/{node_id}/{suffix}" for suffix in RDF_NODE_V2_SUFFIXES)


    def start(self) -> None:
        with self._lock:
            if self._enabled:
                return
            self._enabled = True
            self._stopping = False
            self._connection = "connecting"
            self._last_error = None
            self._pending_subacks.clear()
            self._successful_filters.clear()
            try:
                import paho.mqtt.client as mqtt
                from paho.mqtt.packettypes import PacketTypes
                from paho.mqtt.properties import Properties
            except ModuleNotFoundError as exc:
                if exc.name == "paho" or (exc.name and exc.name.startswith("paho.")):
                    self._set_error_locked("DEPENDENCY_UNAVAILABLE")
                    return
                self._set_error_locked("CLIENT_ERROR")
                return
            except Exception:
                self._set_error_locked("CLIENT_ERROR")
                return

            self._mqtt = mqtt
            try:
                client = mqtt.Client(
                    callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
                    client_id=f"ground-console-rdf-v2-{self.node_id}",
                    protocol=mqtt.MQTTv5,
                )
                self._client = client
                client.on_connect = self._on_connect
                client.on_connect_fail = self._on_connect_fail
                client.on_disconnect = self._on_disconnect
                client.on_subscribe = self._on_subscribe
                client.on_message = self._on_message
                client.username_pw_set(self.username, self.password)
            except Exception:
                self._set_error_locked("CLIENT_ERROR")
                self._client = None
                return
            try:
                client.tls_set(ca_certs=self.ca_file, cert_reqs=ssl.CERT_REQUIRED)
                client.tls_insecure_set(False)
            except Exception:
                self._set_error_locked("TLS_ERROR")
                self._client = None
                return

            try:
                connect_properties = Properties(PacketTypes.CONNECT)
                connect_properties.SessionExpiryInterval = 0
                client.connect_async(
                    self.host, self.port, keepalive=60, clean_start=True,
                    properties=connect_properties,
                )
            except Exception:
                self._set_error_locked("CONNECTION_ERROR")
                return
            try:
                client.loop_start()
            except Exception:
                self._set_error_locked("CONNECTION_ERROR")
                try:
                    client.disconnect()
                except Exception:
                    pass


    def stop(self) -> None:
        with self._lock:
            client = self._client
            self._stopping = True
            self._enabled = False
            self._connection = "disabled"
            self._last_error = None
            self._pending_subacks.clear()
            self._successful_filters.clear()
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


    def snapshot(self) -> dict[str, object]:
        with self._lock:
            result = self._store.snapshot(_now_ms())
            result.update({
                "enabled": self._enabled,
                "connection": self._connection,
                "node_id": self.node_id,
                "last_error": self._last_error,
            })
            return result


    def _set_error_locked(self, code: str) -> None:
        self._connection = "error"
        self._last_error = code


    def _on_connect(self, _client: Any, _userdata: Any, _flags: Any,
                    reason_code: Any, _properties: Any = None) -> None:
        with self._lock:
            if self._stopping or not self._enabled:
                return
            if _reason_failed(reason_code):
                self._set_error_locked("CONNECT_REFUSED")
                return
            self._connection = "connecting"
            self._last_error = None
            self._pending_subacks.clear()
            self._successful_filters.clear()
            try:
                options = self._mqtt.SubscribeOptions(
                    qos=1, noLocal=False, retainAsPublished=True, retainHandling=0,
                )
                for topic in self._filters:
                    rc, mid = self._client.subscribe(topic, qos=1, options=options)
                    if rc != getattr(self._mqtt, "MQTT_ERR_SUCCESS", 0):
                        self._set_error_locked("SUBSCRIBE_ERROR")
                        self._pending_subacks.clear()
                        return
                    self._pending_subacks[int(mid)] = topic
            except Exception:
                self._set_error_locked("SUBSCRIBE_ERROR")
                self._pending_subacks.clear()


    def _on_connect_fail(self, _client: Any, _userdata: Any = None) -> None:
        with self._lock:
            if self._enabled and not self._stopping:
                self._set_error_locked("CONNECTION_ERROR")


    def _on_disconnect(self, _client: Any, _userdata: Any, *args: Any) -> None:
        with self._lock:
            if self._enabled and not self._stopping:
                self._connection = "disconnected"
                self._last_error = "DISCONNECTED"
                self._pending_subacks.clear()
                self._successful_filters.clear()


    def _on_subscribe(self, _client: Any, _userdata: Any, mid: int,
                      reason_codes: Any, _properties: Any = None) -> None:
        with self._lock:
            if not self._enabled or self._stopping or self._connection == "error":
                return
            topic = self._pending_subacks.pop(mid, None)
            if topic is None:
                return
            try:
                codes = list(reason_codes)
            except (TypeError, ValueError):
                self._set_error_locked("SUBACK_INVALID")
                self._pending_subacks.clear()
                return
            if len(codes) != 1 or any(_reason_failed(code) for code in codes):
                self._set_error_locked("SUBSCRIPTION_DENIED")
                self._pending_subacks.clear()
                self._successful_filters.clear()
                return
            self._successful_filters.add(topic)
            if not self._pending_subacks and self._successful_filters == set(self._filters):
                self._connection = "ready"
                self._last_error = None


    def _on_message(self, _client: Any, _userdata: Any, message: Any) -> None:
        with self._lock:
            topic = getattr(message, "topic", None)
            if topic not in self._filters:
                return
            properties = getattr(message, "properties", None)
            expiry = getattr(properties, "MessageExpiryInterval", None) if properties else None
            if type(expiry) is not int or expiry < 0:
                expiry = None
            payload = getattr(message, "payload", None)
            if not isinstance(payload, bytes):
                return
            qos = getattr(message, "qos", None)
            retained = getattr(message, "retain", None)
            if type(qos) is not int or qos not in (0, 1, 2) or type(retained) is not bool:
                return
            try:
                self._store.ingest(
                    topic, payload, qos=qos, retained=retained, received_at_ms=_now_ms(),
                    message_expiry_s=expiry,
                )
            except Exception:
                # Parser failures are contained; the store normally records protocol
                # errors itself, and exception details must never enter the snapshot.
                return




