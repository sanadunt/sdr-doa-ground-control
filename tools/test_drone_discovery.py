#!/usr/bin/env python3
"""Finding the drone's remote: subnets, the bridge/link probe, the choice and the rescan."""

from __future__ import annotations

import json
import socket
import struct
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from drone_discovery import (  # noqa: E402
    _remaining_length,
    DroneService,
    choose,
    drone_settings,
    is_drone_host,
    link_is_bridge,
    probe_bridge_link,
    scan,
    subnet_hosts,
)

LINK = {"fc_online": True, "fc_last_seen_s": 0.1, "frames_per_s": 40, "camera_online": True, "uptime_s": 10, "version": "0.1.0"}


class SubnetTests(unittest.TestCase):
    def test_slash_24_of_each_interface_without_itself(self):
        hosts = subnet_hosts(["192.168.1.117", "192.168.100.100"])
        self.assertEqual(len(hosts), 2 * 253)
        self.assertNotIn("192.168.1.117", hosts)
        self.assertNotIn("192.168.1.0", hosts)
        self.assertNotIn("192.168.1.255", hosts)
        self.assertIn("192.168.1.162", hosts)
        self.assertIn("192.168.100.1", hosts)

    def test_same_network_once_and_bad_addresses_skipped(self):
        hosts = subnet_hosts(["10.0.0.5", "10.0.0.9", "nonsense"])
        self.assertEqual(len(hosts), 252)


class ChoiceTests(unittest.TestCase):
    def test_online_fc_first_then_lowest_address(self):
        candidates = [
            {"host": "192.168.1.9", "fc_online": False},
            {"host": "192.168.1.200", "fc_online": True},
            {"host": "192.168.1.30", "fc_online": True},
        ]
        self.assertEqual(choose(candidates), "192.168.1.30")
        self.assertIsNone(choose([]))

    def test_link_must_be_the_bridges(self):
        self.assertEqual(link_is_bridge(LINK), {"fc_online": True, "version": "0.1.0"})
        self.assertIsNone(link_is_bridge({"fc_online": "yes", "version": "0.1.0"}))
        self.assertIsNone(link_is_bridge({"fc_online": True}))
        self.assertIsNone(link_is_bridge(["fc_online"]))


class ScanTests(unittest.TestCase):
    def test_probe_refuses_broker_without_link(self):
        opened = {"192.168.1.117", "192.168.1.162"}
        links = {"192.168.1.162": {"fc_online": True, "version": "0.1.0"}}
        result = scan(
            ["192.168.1.%d" % n for n in range(1, 255)],
            connect=lambda host: host in opened,
            probe=lambda host: links.get(host),
        )
        self.assertEqual(result["host"], "192.168.1.162")
        self.assertEqual(result["candidates"], [{"fc_online": True, "version": "0.1.0", "host": "192.168.1.162"}])

    def test_last_host_is_tried_first_and_wins_alone(self):
        asked = []

        def connect(host):
            asked.append(host)
            return True

        result = scan(["10.0.0.1", "10.0.0.2"], connect=connect, probe=lambda host: {"fc_online": False, "version": "1"},
                      last_host="10.0.0.77")
        self.assertEqual(result["host"], "10.0.0.77")
        self.assertEqual(asked, ["10.0.0.77"])

    def test_last_host_that_moved_falls_back_to_the_scan(self):
        result = scan(["10.0.0.1", "10.0.0.2"], connect=lambda host: host == "10.0.0.2",
                      probe=lambda host: {"fc_online": True, "version": "1"}, last_host="10.0.0.77")
        self.assertEqual(result["host"], "10.0.0.2")

    def test_nothing_found(self):
        self.assertEqual(scan(["10.0.0.1"], connect=lambda host: False, probe=lambda host: None),
                         {"host": None, "candidates": []})


class FakeBroker:
    """A loopback MQTT 3.1.1 broker that answers one SUBSCRIBE with a retained message."""

    def __init__(self, retained=None, refuse=False):
        self.retained = retained
        self.refuse = refuse
        self.server = socket.socket()
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(4)
        self.port = self.server.getsockname()[1]
        self.received = []
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def serve(self):
        try:
            conn, _ = self.server.accept()
        except OSError:
            return
        with conn:
            conn.settimeout(3)
            try:
                connect = conn.recv(256)
                self.received.append(connect[0] >> 4)
                conn.sendall(bytes([0x20, 2, 0, 5 if self.refuse else 0]))
                if self.refuse:
                    return
                subscribe = conn.recv(256)
                self.received.append(subscribe[0] >> 4)
                conn.sendall(bytes([0x90, 3, 0, 1, 0]))
                if self.retained is not None:
                    topic, payload = self.retained
                    body = struct.pack("!H", len(topic)) + topic.encode() + payload
                    conn.sendall(bytes([0x31]) + _remaining_length(len(body)) + body)
                conn.recv(256)
            except OSError:
                pass

    def close(self):
        self.server.close()


class ProbeTests(unittest.TestCase):
    def test_reads_the_retained_bridge_link(self):
        broker = FakeBroker(("bridge/link", json.dumps(LINK).encode()))
        try:
            self.assertEqual(probe_bridge_link("127.0.0.1", broker.port, timeout_s=2), {"fc_online": True, "version": "0.1.0"})
            # CONNECT then SUBSCRIBE; never a PUBLISH.
            self.assertEqual(broker.received, [1, 8])
        finally:
            broker.close()

    def test_broker_without_bridge_link_is_refused(self):
        broker = FakeBroker(None)
        try:
            self.assertIsNone(probe_bridge_link("127.0.0.1", broker.port, timeout_s=0.5))
        finally:
            broker.close()

    def test_other_payload_or_refused_connect(self):
        broker = FakeBroker(("bridge/link", b'{"online": 1}'))
        try:
            self.assertIsNone(probe_bridge_link("127.0.0.1", broker.port, timeout_s=1))
        finally:
            broker.close()
        broker = FakeBroker(refuse=True)
        try:
            self.assertIsNone(probe_bridge_link("127.0.0.1", broker.port, timeout_s=1))
        finally:
            broker.close()

    def test_nothing_listening(self):
        server = socket.socket()
        server.bind(("127.0.0.1", 0))
        port = server.getsockname()[1]
        server.close()
        self.assertIsNone(probe_bridge_link("127.0.0.1", port, timeout_s=0.5))


class FakeLink:
    def __init__(self, host, port):
        self.host = host
        self.port = port
        self.started = False
        self.stopped = False
        self.down_ms = 0

    def start(self):
        self.started = True

    def stop(self):
        self.stopped = True

    def disconnected_for_ms(self, now_ms=None):
        return self.down_ms

    def heading_at(self, t_ms):
        return {"deg": 10.0, "offset_ms": 0, "source": "attitude"}

    def view(self, now_ms=None):
        return {"state": "LIVE", "host": self.host, "port": self.port, "connection": "connected"}


class ServiceTests(unittest.TestCase):
    def make(self, settings, results):
        self.now = [0]
        self.links = []
        self.searches = []
        self.found = []

        def factory(host, port):
            link = FakeLink(host, port)
            self.links.append(link)
            return link

        def search(last_host):
            self.searches.append(last_host)
            return results.pop(0) if results else {"host": None, "candidates": []}

        return DroneService(settings, link_factory=factory, search=search, on_found=self.found.append,
                            clock=lambda: self.now[0])

    def test_fixed_host_starts_the_link_without_a_search(self):
        service = self.make({"host": "192.168.1.162"}, [])
        service.start()
        self.assertEqual([link.host for link in self.links], ["192.168.1.162"])
        self.assertTrue(self.links[0].started)
        self.assertEqual(service.view()["discovery"]["mode"], "fixed")
        self.assertEqual(self.searches, [])
        service.stop()
        self.assertTrue(self.links[0].stopped)

    def test_disabled(self):
        service = self.make({"enabled": False}, [])
        service.start()
        view = service.view()
        self.assertEqual(view["state"], "DISABLED")
        self.assertEqual(view["connection"], "disabled")
        self.assertEqual(self.links, [])

    def test_auto_finds_and_saves_the_host(self):
        service = self.make({"host": "auto"}, [{"host": "192.168.1.162", "candidates": [{"host": "192.168.1.162", "fc_online": True}]}])
        self.assertEqual(service.view()["connection"], "searching")
        service.step()
        self.assertEqual(self.links[0].host, "192.168.1.162")
        self.assertEqual(self.found, ["192.168.1.162"])
        view = service.view()
        self.assertEqual(view["discovery"]["candidates"], [{"host": "192.168.1.162", "fc_online": True}])
        self.assertEqual(view["host"], "192.168.1.162")
        self.assertEqual(service.heading_at(0)["deg"], 10.0)

    def test_rescan_after_fifteen_seconds_disconnected(self):
        service = self.make({"host": "auto", "last_host": "192.168.1.162"}, [
            {"host": "192.168.1.162", "candidates": []},
            {"host": "10.139.8.61", "candidates": []},
        ])
        service.step()
        self.assertEqual(self.searches, ["192.168.1.162"])
        self.assertEqual(self.found, [])  # the saved host again: nothing new to save
        link = self.links[0]
        link.down_ms = 15_000
        self.now[0] = 20_000
        service.step()
        self.assertEqual(len(self.searches), 1)
        link.down_ms = 15_001
        service.step()
        self.assertEqual(self.searches, ["192.168.1.162", "192.168.1.162"])
        self.assertEqual(self.links[1].host, "10.139.8.61")
        self.assertTrue(link.stopped)
        self.assertEqual(self.found, ["10.139.8.61"])

    def test_failed_search_waits_before_the_next(self):
        service = self.make({"host": "auto"}, [])
        service.step()
        self.now[0] = 14_999
        service.step()
        self.assertEqual(len(self.searches), 1)
        self.now[0] = 15_000
        service.step()
        self.assertEqual(len(self.searches), 2)


class SettingsTests(unittest.TestCase):
    def test_defaults_and_bad_values(self):
        self.assertEqual(drone_settings(None), {
            "enabled": True, "host": "auto", "port": 1883, "array_heading_offset_deg": 0.0,
            "video_enabled": True, "last_host": None,
        })
        settings = drone_settings({"host": "remote.local", "port": 0, "array_heading_offset_deg": 400, "last_host": "x"})
        self.assertEqual((settings["host"], settings["port"], settings["array_heading_offset_deg"], settings["last_host"]),
                         ("auto", 1883, 0.0, None))

    def test_host_literals(self):
        self.assertTrue(is_drone_host("192.168.1.162"))
        self.assertTrue(is_drone_host("fe80::1"))
        self.assertFalse(is_drone_host("0.0.0.0"))
        self.assertFalse(is_drone_host("224.0.0.1"))
        self.assertFalse(is_drone_host("remote.local"))
        self.assertFalse(is_drone_host(""))


if __name__ == "__main__":
    unittest.main()
