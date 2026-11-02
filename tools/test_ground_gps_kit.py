#!/usr/bin/env python3
"""Tests for packaging/ground-gps: ground-gps-publisher, its unit, the
installer and the uninstaller.

The publisher is loaded as a module: NMEA parsing with the live u-blox 7
sample of 2026-11-02, the fix states on a fake monotonic clock, the payload
and its 512-byte bound, and the MQTT 3.1.1 packets against a loopback fake
broker (CONNECT, retained PUBLISH, a dropped connection, the last STOPPED and
DISCONNECT). The receiver is a pseudo-terminal, so the test also sees that
nothing is ever written back to it. The installer and uninstaller run with sh
against fake systemctl and id in a --root tree; nothing touches a real
device, broker or systemd unit.
"""

from __future__ import annotations

import datetime
import json
import os
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from typing import Dict, List, Optional, Tuple

ROOT = Path(__file__).resolve().parent.parent
KIT = ROOT / "packaging/ground-gps"
PUBLISHER = KIT / "ground-gps-publisher"
INSTALL = KIT / "install.sh"
UNINSTALL = KIT / "uninstall.sh"
SCRIPTS = (INSTALL, UNINSTALL)
SH = shutil.which("dash") or shutil.which("sh") or "/bin/sh"

GGA = "$GPGGA,045344.00,0655.79403,S,10742.69343,E,1,04,1.90,697.6,M,2.2,M,,*75"
RMC = "$GPRMC,045344.00,A,0655.79403,S,10742.69343,E,0.559,,021126,,,A*64"
GSA = "$GPGSA,A,3,26,32,27,23,,,,,,,,,3.96,1.90,3.48*08"
SAMPLE = (GGA, RMC, GSA)
BY_ID = "usb-u-blox_AG_-_www.u-blox.com_u-blox_7_-_GPS_GNSS_Receiver-if00"
PAYLOAD_KEYS = {"v", "t", "state", "device", "fix", "sat", "lat", "lon", "alt", "hdop", "sog", "cog", "gnss_t", "error"}


def load_publisher():
    """The script as a module, without writing a __pycache__ into packaging/ (it would ship)."""
    module = types.ModuleType("ground_gps_publisher")
    module.__file__ = str(PUBLISHER)
    sys.modules[module.__name__] = module
    exec(compile(PUBLISHER.read_text(encoding="utf-8"), str(PUBLISHER), "exec"), module.__dict__)
    return module


gp = load_publisher()
# The publisher's log lines go to a list instead of the test output.
LOGS: List[str] = []
gp.log = LOGS.append


def sentence(body: str) -> str:
    """$BODY*CS with a correct checksum."""
    total = 0
    for char in body:
        total ^= ord(char)
    return f"${body}*{total:02X}"


def lines(*items: str) -> bytes:
    return "".join(item + "\r\n" for item in items).encode("ascii")


def config(**values: str) -> Dict[str, object]:
    return gp.validate_config(dict(gp.DEFAULTS, **values))


class Clock:
    def __init__(self, start: float = 100.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now


# ---------------------------------------------------------------------------


class NmeaTests(unittest.TestCase):
    def test_the_live_sample(self):
        self.assertEqual(gp.parse_sentence(GGA), ("GGA", {
            "quality": 1, "lat": -6.9299005, "lon": 107.7115572, "sat": 4, "hdop": 1.9, "alt": 697.6}))
        kind, rmc = gp.parse_sentence(RMC)
        self.assertEqual(kind, "RMC")
        self.assertTrue(rmc["valid"])
        self.assertEqual(rmc["sog"], round(0.559 * 0.514444, 3))
        self.assertIsNone(rmc["cog"], "no track in the sample")
        expected = datetime.datetime(2026, 11, 2, 4, 53, 44, tzinfo=datetime.timezone.utc)
        self.assertEqual(rmc["gnss_t"], int(expected.timestamp() * 1000))
        self.assertEqual(gp.parse_sentence(GSA), ("GSA", {"mode": 3}))
        # The sample's own checksums are what sentence() computes.
        for line in SAMPLE:
            self.assertEqual(sentence(line[1:line.index("*")]), line)

    def test_a_wrong_or_missing_checksum_refuses_the_sentence(self):
        self.assertIsNone(gp.parse_sentence(GGA.replace("697.6", "697.7")))
        self.assertIsNone(gp.parse_sentence(GGA[:-3]))
        self.assertIsNone(gp.parse_sentence(GGA[:-1]))
        self.assertIsNone(gp.parse_sentence(GGA.replace("*75", "*ZZ")))
        self.assertIsNone(gp.parse_sentence(GGA[1:]), "no leading $")
        self.assertIsNotNone(gp.parse_sentence(GGA.replace("*75", "*75\r\n")))
        self.assertIsNotNone(gp.parse_sentence(sentence("GPGSA,A,3,26,32,27,23,,,,,,,,,3.96,1.90,3.48").lower()
                                               .replace("$gpgsa,a", "$GPGSA,A")), "a lower-case checksum")

    def test_hemispheres(self):
        north = gp.parse_sentence(sentence("GPGGA,045344.00,0655.79403,N,10742.69343,W,1,04,1.90,697.6,M,2.2,M,,"))
        self.assertEqual((north[1]["lat"], north[1]["lon"]), (6.9299005, -107.7115572))
        bad = gp.parse_sentence(sentence("GPGGA,045344.00,0655.79403,X,10742.69343,E,1,04,1.90,697.6,M,2.2,M,,"))
        self.assertEqual((bad[1]["lat"], bad[1]["lon"]), (None, None), "a position needs both coordinates")
        minutes = gp.parse_sentence(sentence("GPGGA,045344.00,0675.00000,S,10742.69343,E,1,04,1.90,697.6,M,2.2,M,,"))
        self.assertIsNone(minutes[1]["lat"])
        self.assertEqual(gp.nmea_coordinate("18000.0000", "W", "E", "W", 180), -180.0)
        self.assertIsNone(gp.nmea_coordinate("18000.0001", "E", "E", "W", 180))
        self.assertIsNone(gp.nmea_coordinate("9100.0000", "N", "N", "S", 90))

    def test_empty_fields_of_a_receiver_without_a_fix(self):
        kind, gga = gp.parse_sentence(sentence("GPGGA,045400.00,,,,,0,00,99.99,,,,,,"))
        self.assertEqual(gga, {"quality": 0, "lat": None, "lon": None, "sat": 0, "hdop": 99.99, "alt": None})
        kind, rmc = gp.parse_sentence(sentence("GPRMC,045400.00,V,,,,,,,021126,,,N"))
        self.assertEqual(rmc, {"valid": False, "sog": None, "cog": None, "gnss_t": rmc["gnss_t"]})
        kind, gsa = gp.parse_sentence(sentence("GPGSA,A,1,,,,,,,,,,,,,99.99,99.99,99.99"))
        self.assertEqual(gsa, {"mode": 1})

    def test_other_talkers_track_and_bad_fields(self):
        kind, rmc = gp.parse_sentence(sentence("GNRMC,120000.00,A,0655.79403,S,10742.69343,E,10.0,370.5,010126,,,D"))
        self.assertEqual(kind, "RMC")
        self.assertEqual(rmc["cog"], 10.5)
        self.assertEqual(rmc["sog"], round(10.0 * 0.514444, 3))
        # An NMEA 2.3 mode N is not valid whatever the status.
        kind, rmc = gp.parse_sentence(sentence("GPRMC,120000.00,A,0655.79403,S,10742.69343,E,0.0,,010126,,,N"))
        self.assertFalse(rmc["valid"])
        # A field that does not read is left out, not the sentence.
        kind, gga = gp.parse_sentence(sentence("GPGGA,045344.00,0655.79403,S,10742.69343,E,1,xx,abc,nan,M,2.2,M,,"))
        self.assertEqual((gga["sat"], gga["hdop"], gga["alt"], gga["lat"]), (None, None, None, -6.9299005))
        kind, rmc = gp.parse_sentence(sentence("GPRMC,250000.00,A,0655.79403,S,10742.69343,E,0.0,,320126,,,A"))
        self.assertIsNone(rmc["gnss_t"])
        for ignored in (sentence("GPGSV,1,1,00"), sentence("GPTXT,01,01,02,ANTSTATUS=OK"), sentence("PUBX,00"),
                        sentence("GPGGA,1,2")):
            self.assertIsNone(gp.parse_sentence(ignored), ignored)


class TrackerTests(unittest.TestCase):
    def tracker(self) -> "gp.GpsTracker":
        tracker = gp.GpsTracker()
        tracker.reset(0.0)
        return tracker

    def test_states_on_a_fake_clock(self):
        tracker = self.tracker()
        self.assertEqual(tracker.status(1.0), {"state": "NO_DATA"}, "nothing heard yet")
        tracker.feed(lines(sentence("GPGGA,045400.00,,,,,0,00,99.99,,,,,,"), sentence("GPRMC,045400.00,V,,,,,,,021126,,,N")), 1.0)
        self.assertEqual(tracker.status(1.5), {"state": "NO_FIX", "sat": 0, "hdop": 99.99})
        tracker.feed(lines(*SAMPLE), 2.0)
        status = tracker.status(2.5)
        self.assertEqual(status["state"], "FIX")
        self.assertEqual(status["fix"], 3)
        self.assertEqual((status["lat"], status["lon"], status["alt"], status["sat"]), (-6.9299005, 107.7115572, 697.6, 4))
        # Silence for more than 5 s: NO_DATA.
        self.assertEqual(tracker.status(7.0)["state"], "FIX")
        self.assertEqual(tracker.status(7.1), {"state": "NO_DATA"})

    def test_fix_needs_a_recent_rmc_a_and_gga_quality(self):
        tracker = self.tracker()
        tracker.feed(lines(RMC, sentence("GPGGA,045344.00,0655.79403,S,10742.69343,E,0,04,1.90,697.6,M,2.2,M,,")), 1.0)
        self.assertEqual(tracker.status(1.0)["state"], "NO_FIX")
        tracker.feed(lines(GGA), 2.0)
        self.assertEqual(tracker.status(2.0)["state"], "FIX")
        self.assertEqual(tracker.status(2.0)["fix"], 2, "no GSA: 2")
        tracker.feed(lines(sentence("GPGSA,A,2,26,32,27,,,,,,,,,,3.96,1.90,3.48")), 2.0)
        self.assertEqual(tracker.status(2.0)["fix"], 2)
        # Only GGA keeps coming (RMC stopped 5 s ago): no fix.
        tracker.feed(lines(GGA), 6.5)
        self.assertEqual(tracker.status(6.5)["state"], "NO_FIX")
        tracker.feed(lines(sentence("GPRMC,045350.00,V,0655.79403,S,10742.69343,E,0.0,,021126,,,A")), 6.6)
        self.assertEqual(tracker.status(6.6)["state"], "NO_FIX")

    def test_bytes_split_across_reads_and_noise(self):
        tracker = self.tracker()
        data = lines(*SAMPLE)
        self.assertEqual(tracker.feed(data[:17], 1.0), 0)
        self.assertEqual(tracker.feed(data[17:], 1.0), 3)
        self.assertEqual(tracker.status(1.0)["state"], "FIX")
        self.assertEqual(tracker.feed(lines(GGA.replace("697.6", "697.7"), "garbage", "") + b"\xff\xfe\n", 1.1), 0)
        self.assertEqual(tracker.bad_lines, 1)
        tracker.feed(b"$" + b"A" * 10000, 1.2)
        self.assertLessEqual(len(tracker.buffer), gp.BUFFER_MAX, "a line without an end is dropped")
        self.assertEqual(tracker.feed(b"\n" + lines(GGA), 1.3), 1)


class PayloadTests(unittest.TestCase):
    def test_shape_of_each_state(self):
        tracker = gp.GpsTracker()
        tracker.reset(0.0)
        tracker.feed(lines(*SAMPLE), 1.0)
        payload = gp.build_payload(1_793_595_224_512, "FIX", BY_ID, tracker.status(1.0))
        self.assertEqual(set(payload), PAYLOAD_KEYS)
        self.assertEqual(payload, {
            "v": 1, "t": 1_793_595_224_512, "state": "FIX", "device": BY_ID, "fix": 3, "sat": 4,
            "lat": -6.9299005, "lon": 107.7115572, "alt": 697.6, "hdop": 1.9, "sog": 0.288, "cog": None,
            "gnss_t": 1_793_595_224_000, "error": None})
        data = gp.encode_payload(payload)
        self.assertNotIn(b" ", data, "compact JSON")
        self.assertEqual(json.loads(data), payload)
        no_fix = gp.build_payload(5, "NO_FIX", BY_ID, {"state": "NO_FIX", "sat": 2, "hdop": 9.9})
        self.assertEqual((no_fix["lat"], no_fix["lon"], no_fix["alt"], no_fix["fix"], no_fix["sat"]), (None, None, None, 0, 2))
        for state in ("NO_DEVICE", "NO_DATA", "ERROR", "STOPPED"):
            payload = gp.build_payload(5, state, BY_ID, {"lat": 1.0, "sat": 4}, "x" if state == "ERROR" else None)
            self.assertEqual(set(payload), PAYLOAD_KEYS)
            for key in ("sat", "lat", "lon", "alt", "hdop", "sog", "cog", "gnss_t"):
                self.assertIsNone(payload[key], (state, key))
            self.assertEqual(payload["fix"], 0)
        self.assertEqual(gp.device_label("/dev/serial/by-id/" + BY_ID), BY_ID)
        self.assertEqual(gp.device_label("/dev/ttyACM0"), "/dev/ttyACM0")

    def test_the_512_byte_bound(self):
        payload = gp.build_payload(10 ** 13, "FIX", "d" * 500, {
            "fix": 3, "sat": 99, "lat": -89.1234567, "lon": -179.1234567, "alt": -12345.678, "hdop": 99.99,
            "sog": 1234.567, "cog": 359.99, "gnss_t": 10 ** 13}, "e" * 500)
        data = gp.encode_payload(payload)
        self.assertLessEqual(len(data), gp.PAYLOAD_MAX_BYTES)
        decoded = json.loads(data)
        self.assertEqual(decoded["lat"], -89.1234567)
        self.assertTrue(decoded["device"].startswith("d"))
        # An escaped error text gives way too.
        payload = gp.build_payload(1, "ERROR", "/dev/" + "x" * 300, None, '"' * 400)
        self.assertLessEqual(len(gp.encode_payload(payload)), gp.PAYLOAD_MAX_BYTES)


class ConfigTests(unittest.TestCase):
    def test_defaults_and_values(self):
        self.assertEqual(gp.validate_config(dict(gp.DEFAULTS)), {
            "device": "/dev/serial/by-id/" + BY_ID, "host": "127.0.0.1", "port": 1883, "node": "uav-01",
            "interval": 2.0, "baud": None})
        values = gp.read_config_text("# c\n\nDEVICE='/dev/ttyACM0'\nBAUD=9600\nNODE_ID=uav-02\nBROKER_HOST=::1\n")
        result = gp.validate_config(values)
        self.assertEqual((result["device"], result["baud"], result["node"], result["host"]),
                         ("/dev/ttyACM0", 9600, "uav-02", "::1"))
        self.assertEqual(gp.topic_for("uav-02"), "sdr/v2/uav-02/ground/gps")
        example = (KIT / "ground-gps.conf.example").read_text(encoding="utf-8")
        self.assertEqual(gp.validate_config(gp.read_config_text(example)), gp.validate_config(dict(gp.DEFAULTS)),
                         "the example shows the defaults")

    def test_refusals(self):
        with self.assertRaisesRegex(gp.ConfigError, "unknown setting DEVCE"):
            gp.read_config_text("DEVCE=/dev/ttyACM0\n")
        with self.assertRaisesRegex(gp.ConfigError, "NAME=VALUE"):
            gp.read_config_text("just text\n")
        for name, value, fragment in (("BROKER_HOST", "broker.local", "IP address"), ("BROKER_PORT", "0", "1..65535"),
                                      ("NODE_ID", "uav/01", "NODE_ID"), ("NODE_ID", "#", "NODE_ID"),
                                      ("INTERVAL", "0.5", "1..60"), ("BAUD", "1234", "BAUD"), ("DEVICE", "ttyACM0", "absolute")):
            with self.assertRaisesRegex(gp.ConfigError, fragment):
                config(**{name: value})

    def test_check_config_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "ground-gps.conf"
            path.write_text("NODE_ID=uav-07\n", encoding="utf-8")
            result = subprocess.run([sys.executable, "-I", str(PUBLISHER), "check-config", "--config", str(path)],
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("TOPIC=sdr/v2/uav-07/ground/gps\n", result.stdout)
            path.write_text("NODE_ID=uav-07\nPORT=1\n", encoding="utf-8")
            result = subprocess.run([sys.executable, "-I", str(PUBLISHER), "check-config", "--config", str(path)],
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 78)
            self.assertIn("unknown setting PORT", result.stderr)
            result = subprocess.run([sys.executable, "-I", str(PUBLISHER), "check-config", "--config", str(path) + ".x"],
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 78)


# ---------------------------------------------------------------------------


class Pty:
    """A pseudo-terminal: the publisher reads the slave, the test writes the master."""

    def __init__(self) -> None:
        self.master, slave = os.openpty()
        self.path = os.ttyname(slave)
        # Keep the slave open so the pty lives while the publisher reopens it.
        self.slave = slave
        os.set_blocking(self.master, False)

    def write(self, data: bytes) -> None:
        os.write(self.master, data)

    def echoed(self) -> bytes:
        try:
            return os.read(self.master, 4096)
        except (BlockingIOError, OSError):
            return b""

    def close(self) -> None:
        for fd in (self.master, self.slave):
            try:
                os.close(fd)
            except OSError:
                pass


class DeviceStateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = Clock()
        self.out: List[Dict[str, object]] = []
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def publisher(self, device: str) -> "gp.Publisher":
        publisher = gp.Publisher(config(DEVICE=device), wall_ms=lambda: int(self.clock.now * 1000),
                                 monotonic=self.clock, emit=lambda data: self.out.append(json.loads(data)))
        self.addCleanup(publisher.finish)
        return publisher

    def test_no_device_then_retry(self):
        missing = os.path.join(self.tmp.name, "ttyACM9")
        publisher = self.publisher(missing)
        publisher.step(0)
        self.assertEqual(self.out[-1]["state"], "NO_DEVICE")
        self.assertEqual(self.out[-1]["device"], missing)
        self.assertIsNone(self.out[-1]["error"])
        self.clock.now += 1.0
        publisher.step(0)
        self.assertEqual(len(self.out), 1, "nothing changed, the interval has not passed")
        self.clock.now += 1.1
        publisher.step(0)
        self.assertEqual(len(self.out), 2, "every INTERVAL")

    @unittest.skipIf(os.geteuid() == 0, "root opens any file")
    def test_unreadable_device_is_an_error(self):
        path = Path(self.tmp.name) / "ttyACM0"
        path.write_bytes(b"")
        path.chmod(0)
        publisher = self.publisher(str(path))
        publisher.step(0)
        self.assertEqual(self.out[-1]["state"], "ERROR")
        self.assertIn("permission denied", self.out[-1]["error"])

    def test_pty_fix_no_data_and_unplug_and_nothing_written_back(self):
        pty = Pty()
        self.addCleanup(pty.close)
        publisher = self.publisher(pty.path)
        publisher.step(0)
        self.assertEqual(self.out[-1]["state"], "NO_DATA")
        pty.write(lines(*SAMPLE))
        time.sleep(0.05)
        self.clock.now += 0.1
        publisher.step(0)
        self.assertEqual(self.out[-1]["state"], "FIX", self.out)
        self.assertEqual(self.out[-1]["fix"], 3)
        self.assertEqual(self.out[-1]["lat"], -6.9299005)
        self.assertEqual(pty.echoed(), b"", "the receiver never gets a byte back")
        # Silence: NO_DATA after 5 s, published at once (a state change).
        self.clock.now += 5.2
        publisher.step(0)
        self.assertEqual(self.out[-1]["state"], "NO_DATA")
        count = len(self.out)
        self.clock.now += 0.1
        publisher.step(0)
        self.assertEqual(len(self.out), count)
        # Unplugged: the read fails or ends.
        pty.close()
        self.clock.now += 0.1
        publisher.step(0)
        self.assertEqual(self.out[-1]["state"], "NO_DEVICE")

    def test_open_is_read_only_and_clears_echo(self):
        import termios
        pty = Pty()
        self.addCleanup(pty.close)
        attrs = termios.tcgetattr(pty.slave)
        attrs[3] |= termios.ECHO
        termios.tcsetattr(pty.slave, termios.TCSANOW, attrs)
        speed = attrs[4]
        fd = gp.open_device(pty.path, None)
        try:
            flags = __import__("fcntl").fcntl(fd, __import__("fcntl").F_GETFL)
            self.assertEqual(flags & os.O_ACCMODE, os.O_RDONLY)
            self.assertTrue(flags & os.O_NONBLOCK)
            after = termios.tcgetattr(fd)
            self.assertFalse(after[3] & termios.ECHO)
            self.assertEqual(after[4], speed, "the speed stays without BAUD")
            with self.assertRaises(OSError):
                os.write(fd, b"x")
        finally:
            os.close(fd)


# ---------------------------------------------------------------------------


class FakeBroker:
    """A loopback MQTT broker that records every packet of every connection."""

    def __init__(self, connack_code: int = 0) -> None:
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(8)
        self.port = self.server.getsockname()[1]
        self.connack_code = connack_code
        self.connections: List[List[Tuple[int, bytes]]] = []
        self.sockets: List[socket.socket] = []
        self.lock = threading.RLock()
        self.changed = threading.Condition(self.lock)
        self.closed = False
        threading.Thread(target=self.accept, daemon=True).start()

    def accept(self) -> None:
        while not self.closed:
            try:
                conn, _ = self.server.accept()
            except OSError:
                return
            with self.lock:
                packets: List[Tuple[int, bytes]] = []
                self.connections.append(packets)
                self.sockets.append(conn)
            threading.Thread(target=self.serve, args=(conn, packets), daemon=True).start()

    @staticmethod
    def read_packet(conn: socket.socket) -> Optional[Tuple[int, bytes]]:
        def exact(count: int) -> bytes:
            data = b""
            while len(data) < count:
                chunk = conn.recv(count - len(data))
                if not chunk:
                    raise EOFError
                data += chunk
            return data

        try:
            first = exact(1)[0]
            length, multiplier = 0, 1
            while True:
                byte = exact(1)[0]
                length += (byte & 0x7F) * multiplier
                multiplier *= 128
                if not byte & 0x80:
                    break
            return first, exact(length)
        except (EOFError, OSError):
            return None

    def serve(self, conn: socket.socket, packets: List[Tuple[int, bytes]]) -> None:
        while True:
            packet = self.read_packet(conn)
            if packet is None:
                return
            with self.changed:
                packets.append(packet)
                self.changed.notify_all()
            try:
                if packet[0] == 0x10:
                    conn.sendall(bytes([0x20, 0x02, 0x00, self.connack_code]))
                elif packet[0] == 0xC0:
                    conn.sendall(b"\xd0\x00")
            except OSError:
                return

    def wait(self, predicate, timeout: float = 10.0) -> bool:
        deadline = time.monotonic() + timeout
        with self.changed:
            while not predicate():
                left = deadline - time.monotonic()
                if left <= 0:
                    return False
                self.changed.wait(min(left, 0.1))
            return True

    def drop(self, index: int) -> None:
        with self.lock:
            conn = self.sockets[index]
        try:
            conn.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        conn.close()

    def publishes(self, index: int) -> List[Dict[str, object]]:
        with self.lock:
            packets = list(self.connections[index]) if index < len(self.connections) else []
        result = []
        for first, body in packets:
            if first >> 4 == 3:
                length = int.from_bytes(body[:2], "big")
                result.append({"retain": bool(first & 1), "qos": (first >> 1) & 3,
                               "topic": body[2:2 + length].decode(), "payload": json.loads(body[2 + length:])})
        return result

    def close(self) -> None:
        self.closed = True
        self.server.close()
        with self.lock:
            for conn in self.sockets:
                try:
                    conn.close()
                except OSError:
                    pass


class MqttPacketTests(unittest.TestCase):
    def test_remaining_length(self):
        for value, encoded in ((0, b"\x00"), (127, b"\x7f"), (128, b"\x80\x01"), (16383, b"\xff\x7f"),
                               (16384, b"\x80\x80\x01"), (2097152, b"\x80\x80\x80\x01"),
                               (268435455, b"\xff\xff\xff\x7f")):
            self.assertEqual(gp.encode_remaining_length(value), encoded, value)
        with self.assertRaises(ValueError):
            gp.encode_remaining_length(268435456)

    def test_connect_and_publish_bytes(self):
        self.assertEqual(gp.connect_packet("ground-gps-gs", 30),
                         b"\x10\x19\x00\x04MQTT\x04\x02\x00\x1e\x00\x0dground-gps-gs")
        self.assertEqual(gp.publish_packet("a/b", b"{}"), b"\x31\x07\x00\x03a/b{}")
        self.assertEqual(gp.publish_packet("a/b", b"{}", retain=False)[0], 0x30)
        self.assertEqual(gp.PINGREQ, b"\xc0\x00")
        self.assertEqual(gp.DISCONNECT, b"\xe0\x00")
        self.assertEqual(gp.client_id_for("groundstation.local"), "ground-gps-groundstatio")
        self.assertEqual(gp.client_id_for("gs_1"), "ground-gps-gs-1")
        self.assertLessEqual(len(gp.client_id_for("x" * 80)), 23)

    def test_client_against_the_fake_broker(self):
        broker = FakeBroker()
        self.addCleanup(broker.close)
        client = gp.MqttClient("127.0.0.1", broker.port, "ground-gps-test")
        client.connect()
        client.publish("sdr/v2/uav-01/ground/gps", b'{"v":1}')
        client.send(gp.PINGREQ)
        client.ping_sent_at = time.monotonic()
        self.assertTrue(broker.wait(lambda: len(broker.connections[0]) >= 3))
        connect = broker.connections[0][0]
        self.assertEqual(connect, (0x10, b"\x00\x04MQTT\x04\x02\x00\x1e\x00\x0fground-gps-test"))
        self.assertEqual(broker.publishes(0), [{"retain": True, "qos": 0, "topic": "sdr/v2/uav-01/ground/gps",
                                                "payload": {"v": 1}}])
        time.sleep(0.1)
        client.on_readable()
        self.assertIsNone(client.ping_sent_at, "PINGRESP read")
        client.disconnect()
        self.assertTrue(broker.wait(lambda: broker.connections[0][-1] == (0xE0, b"")))

    def test_refused_connack(self):
        broker = FakeBroker(connack_code=5)
        self.addCleanup(broker.close)
        client = gp.MqttClient("127.0.0.1", broker.port, "ground-gps-test")
        with self.assertRaisesRegex(gp.MqttError, "not authorized"):
            client.connect()
        self.assertFalse(client.connected)

    def test_keepalive_ping(self):
        clock = Clock(0.0)
        broker = FakeBroker()
        self.addCleanup(broker.close)
        client = gp.MqttClient("127.0.0.1", broker.port, "ground-gps-test", keepalive=10, monotonic=clock)
        client.connect()
        clock.now = 4.0
        client.tick()
        self.assertIsNone(client.ping_sent_at)
        clock.now = 5.0
        client.tick()
        self.assertEqual(client.ping_sent_at, 5.0)
        self.assertTrue(broker.wait(lambda: broker.connections[0][-1] == (0xC0, b"")))
        clock.now = 16.0
        with self.assertRaisesRegex(gp.MqttError, "PINGRESP"):
            client.tick()
        self.assertFalse(client.connected)


class PublisherBrokerTests(unittest.TestCase):
    def test_fix_retained_reconnect_and_stopped(self):
        broker = FakeBroker()
        self.addCleanup(broker.close)
        pty = Pty()
        self.addCleanup(pty.close)
        mqtt = gp.MqttClient("127.0.0.1", broker.port, "ground-gps-test")
        publisher = gp.Publisher(config(DEVICE=pty.path, BROKER_PORT=str(broker.port), INTERVAL="1"), mqtt=mqtt,
                                 backoff_first=0.05, backoff_max=0.2)
        stop = threading.Event()
        thread = threading.Thread(target=publisher.run, args=(stop.is_set,), daemon=True)
        thread.start()
        self.addCleanup(stop.set)
        # Bytes written before the open would be echoed by the tty's own default.
        deadline = time.monotonic() + 10
        while publisher.fd is None and time.monotonic() < deadline:
            time.sleep(0.01)
        time.sleep(0.05)
        self.assertEqual(pty.echoed(), b"")

        def feeding(predicate, timeout=10.0) -> bool:
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                pty.write(lines(*SAMPLE))
                if broker.wait(predicate, 0.2):
                    return True
            return False

        def fix_on(index: int) -> bool:
            return any(item["payload"]["state"] == "FIX" for item in broker.publishes(index))

        self.assertTrue(feeding(lambda: len(broker.connections) >= 1 and fix_on(0)), broker.publishes(0))
        first = broker.publishes(0)
        for item in first:
            self.assertEqual(item["topic"], "sdr/v2/uav-01/ground/gps")
            self.assertTrue(item["retain"])
            self.assertEqual(item["qos"], 0)
            self.assertLessEqual(len(json.dumps(item["payload"], separators=(",", ":"))), 512)
        fix = next(item["payload"] for item in first if item["payload"]["state"] == "FIX")
        self.assertEqual((fix["lat"], fix["lon"], fix["fix"], fix["sat"]), (-6.9299005, 107.7115572, 3, 4))
        self.assertEqual(broker.connections[0][0][1][:10], b"\x00\x04MQTT\x04\x02\x00\x1e")

        # The broker drops the connection: the publisher connects again and
        # publishes the current status at once.
        broker.drop(0)
        self.assertTrue(feeding(lambda: len(broker.connections) >= 2 and fix_on(1)))
        self.assertEqual(broker.connections[1][0][0], 0x10)

        stop.set()
        thread.join(10)
        self.assertFalse(thread.is_alive())
        self.assertTrue(broker.wait(lambda: broker.connections[-1][-1] == (0xE0, b"")))
        last = broker.publishes(len(broker.connections) - 1)[-1]
        self.assertEqual(last["payload"]["state"], "STOPPED")
        self.assertTrue(last["retain"])
        self.assertEqual(pty.echoed(), b"", "nothing was written to the receiver")

    def test_no_broker_backs_off_and_keeps_reading(self):
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
        probe.close()
        clock = Clock(0.0)
        pty = Pty()
        self.addCleanup(pty.close)
        mqtt = gp.MqttClient("127.0.0.1", port, "ground-gps-test", monotonic=clock)
        publisher = gp.Publisher(config(DEVICE=pty.path, BROKER_PORT=str(port)), mqtt=mqtt, monotonic=clock,
                                 backoff_first=1.0, backoff_max=4.0)
        self.addCleanup(publisher.finish)
        attempts = []
        for _ in range(12):
            failures = publisher.connect_failures
            publisher.step(0)
            if publisher.connect_failures > failures:
                attempts.append(clock.now)
            clock.now += 0.5
        self.assertEqual(attempts, [0.0, 1.0, 3.0], "1, 2, then 4 s apart")
        pty.write(lines(*SAMPLE))
        time.sleep(0.05)
        publisher.step(0)
        self.assertEqual(publisher.tracker.status(clock.now)["state"], "FIX", "the device is read meanwhile")


# ---------------------------------------------------------------------------

REAL_TOOLS = (
    "sh", "dash", "bash", "cat", "sed", "awk", "grep", "tr", "tail", "head", "mv", "rm", "mkdir", "chmod",
    "cp", "ls", "dirname", "basename", "rmdir", "mktemp", "readlink", "env", "touch",
)
FAKE = r'''
import json
import os
import sys

NAME = os.path.basename(sys.argv[0])
ARGS = sys.argv[1:]
with open(os.environ["FAKE_CALLS"], "a", encoding="utf-8") as handle:
    handle.write(json.dumps([NAME] + ARGS) + "\n")
if NAME == "id" and ARGS == ["-u"]:
    print(os.environ["FAKE_UID"])
sys.exit(0)
'''


class InstallerHarness:
    def __init__(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="test-ground-gps-")
        self.base = Path(self._tmp.name)
        self.fakebin = self.base / "fakebin"
        self.realbin = self.base / "realbin"
        self.calls = self.base / "calls.jsonl"
        for directory in (self.fakebin, self.realbin):
            directory.mkdir()
        dispatcher = self.base / "fake.py"
        dispatcher.write_text(f"#!{sys.executable} -IS\n{FAKE}", encoding="utf-8")
        dispatcher.chmod(0o755)
        for name in ("systemctl", "id"):
            (self.fakebin / name).symlink_to(dispatcher)
        for name in REAL_TOOLS:
            found = shutil.which(name)
            if found:
                (self.realbin / name).symlink_to(found)
        (self.realbin / "python3").symlink_to(os.path.realpath(sys.executable))
        self.uid = os.geteuid()

    def cleanup(self) -> None:
        self._tmp.cleanup()

    def run(self, script: Path, *args: str, **extra: str) -> subprocess.CompletedProcess:
        environment = {
            "PATH": f"{self.fakebin}:{self.realbin}",
            "HOME": str(self.base),
            "TMPDIR": str(self.base),
            "LC_ALL": "C",
            "FAKE_CALLS": str(self.calls),
            "FAKE_UID": str(self.uid),
            "GROUND_GPS_ROOT_UID": str(os.geteuid()),
        }
        environment.update(extra)
        return subprocess.run([SH, str(script), *args], capture_output=True, text=True, env=environment,
                              cwd=str(self.base), timeout=60)

    def actions(self) -> List[List[str]]:
        if not self.calls.exists():
            return []
        calls = [json.loads(line) for line in self.calls.read_text(encoding="utf-8").splitlines()]
        return [call for call in calls if call[0] == "systemctl"]


class InstallerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.h = InstallerHarness()
        self.addCleanup(self.h.cleanup)
        self.root = self.h.base / "root"
        self.root.mkdir()
        self.root.chmod(0o755)

    def install(self, *args: str, **extra: str) -> subprocess.CompletedProcess:
        return self.h.run(INSTALL, "--root", str(self.root), *args, **extra)

    def files(self) -> set:
        return {str(path.relative_to(self.root)) for path in self.root.rglob("*") if path.is_file()}

    def read(self, name: str) -> str:
        return (self.root / name).read_text(encoding="utf-8")

    def test_install_writes_only_its_own_files(self):
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.files(), {
            "usr/local/bin/ground-gps-publisher",
            "usr/local/share/ground-gps/README.md",
            "usr/local/share/ground-gps/uninstall.sh",
            "usr/local/share/ground-gps/ground-gps.conf.example",
            "usr/local/share/ground-gps/install-info",
            "etc/ground-gps/ground-gps.conf",
            "etc/systemd/system/ground-gps.service",
        })
        for name in ("usr/local/bin/ground-gps-publisher", "usr/local/share/ground-gps/uninstall.sh"):
            self.assertEqual(stat.S_IMODE((self.root / name).stat().st_mode), 0o755, name)
        for name in ("etc/ground-gps/ground-gps.conf", "etc/systemd/system/ground-gps.service",
                     "usr/local/share/ground-gps/install-info"):
            self.assertEqual(stat.S_IMODE((self.root / name).stat().st_mode), 0o644, name)
        self.assertEqual(self.read("etc/ground-gps/ground-gps.conf"), (KIT / "ground-gps.conf.example").read_text())
        service = self.read("etc/systemd/system/ground-gps.service")
        python = str(self.h.realbin / "python3")
        self.assertIn(f"ExecStart={python} -I /usr/local/bin/ground-gps-publisher run --config "
                      "/etc/ground-gps/ground-gps.conf\n", service)
        for line in ("DynamicUser=yes", "SupplementaryGroups=dialout", "DevicePolicy=closed", "DeviceAllow=char-ttyACM r",
                     "Restart=always", "RestartPreventExitStatus=78", "NoNewPrivileges=yes", "CapabilityBoundingSet=",
                     "WantedBy=multi-user.target", "Documentation=file:///usr/local/share/ground-gps/README.md"):
            self.assertIn(line + "\n", service)
        self.assertNotIn("User=root", service)
        self.assertEqual([line for line in service.splitlines() if line.startswith("DeviceAllow=")],
                         ["DeviceAllow=char-ttyACM r"], "no ttyUSB: the LoRa bridge's port stays out of reach")
        self.assertNotRegex(service, r"@[A-Z_]+@")
        self.assertIn("packaging/ground-gps", service)
        info = self.read("usr/local/share/ground-gps/install-info")
        for line in ("PREFIX=/usr/local\n", "CONFIG_DIR=/etc/ground-gps\n", "UNIT_DIR=/etc/systemd/system\n"):
            self.assertIn(line, info)
        for line in ("skipped (--root): systemctl daemon-reload", "skipped (--root): systemctl enable ground-gps.service",
                     "skipped (--root): systemctl restart ground-gps.service", "Publishes: sdr/v2/uav-01/ground/gps on 127.0.0.1:1883"):
            self.assertIn(line, result.stdout)
        self.assertEqual(self.h.actions(), [])

    def test_installer_touches_no_other_service_udev_firewall_or_lora_port(self):
        text = INSTALL.read_text(encoding="utf-8") + UNINSTALL.read_text(encoding="utf-8")
        for forbidden in ("ufw", "iptables", "nft ", "firewall-cmd", "/etc/udev", "udevadm", "ttyUSB0", "mosquitto",
                          "rdf-lora", "usermod", "useradd"):
            self.assertNotIn(forbidden, text)
        publisher = PUBLISHER.read_text(encoding="utf-8")
        self.assertNotIn("O_RDWR", publisher)
        self.assertNotIn("O_WRONLY", publisher)
        self.assertNotIn("os.write(", publisher)

    def test_rerun_keeps_the_config_and_a_bad_one_stops(self):
        self.assertEqual(self.install().returncode, 0)
        config_path = self.root / "etc/ground-gps/ground-gps.conf"
        config_path.write_text("NODE_ID=uav-02\n", encoding="utf-8")
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Keeping /etc/ground-gps/ground-gps.conf", result.stdout)
        self.assertIn("Publishes: sdr/v2/uav-02/ground/gps", result.stdout)
        self.assertEqual(config_path.read_text(encoding="utf-8"), "NODE_ID=uav-02\n")
        config_path.write_text("NODE_ID=uav-02\nNODE=x\n", encoding="utf-8")
        result = self.install()
        self.assertEqual(result.returncode, 1)
        self.assertIn("unknown setting NODE", result.stderr)

    def test_refuses_to_replace_a_foreign_file(self):
        foreign = self.root / "etc/systemd/system/ground-gps.service"
        foreign.parent.mkdir(parents=True)
        foreign.write_text("[Service]\nExecStart=/opt/other\n", encoding="utf-8")
        result = self.install()
        self.assertEqual(result.returncode, 1)
        self.assertIn("was not written by this installer", result.stderr)
        self.assertEqual(foreign.read_text(encoding="utf-8"), "[Service]\nExecStart=/opt/other\n")
        self.assertFalse((self.root / "usr/local/bin/ground-gps-publisher").exists())

    def test_refuses_a_prefix_others_can_change(self):
        opt = self.root / "opt"
        opt.mkdir(mode=0o755)
        opt.chmod(0o775)
        result = self.install("--prefix", "/opt/gps")
        self.assertEqual(result.returncode, 1)
        self.assertIn(f"{opt} is not owned by root or is writable by another user", result.stderr)
        self.assertFalse((opt / "gps").exists(), "refused before anything was written")
        opt.chmod(0o755)
        result = self.install("--prefix", "/opt/gps")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("ExecStart=", self.read("etc/systemd/system/ground-gps.service"))
        self.assertIn("/opt/gps/bin/ground-gps-publisher run", self.read("etc/systemd/system/ground-gps.service"))
        if os.geteuid() != 0:
            result = self.install("--prefix", "/opt/gps", GROUND_GPS_ROOT_UID="0")
            self.assertEqual(result.returncode, 1)
            self.assertIn("is not owned by root or is writable by another user", result.stderr)

    def test_dry_run_changes_nothing_and_shows_refusals(self):
        result = self.install("--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.files(), set())
        self.assertIn("would run: systemctl enable ground-gps.service", result.stdout)
        self.assertIn("--- /etc/systemd/system/ground-gps.service", result.stdout)
        self.assertIn("Dry run: nothing was changed.", result.stdout)
        foreign = self.root / "usr/local/bin/ground-gps-publisher"
        foreign.parent.mkdir(parents=True)
        foreign.write_text("#!/bin/sh\n", encoding="utf-8")
        result = self.install("--dry-run")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn(f"the install would stop here: {foreign} exists and was not written by this installer",
                      result.stderr)
        self.assertIn("The install would stop: see the warnings.", result.stdout)
        self.assertEqual(self.files(), {"usr/local/bin/ground-gps-publisher"})
        self.assertEqual(self.h.actions(), [])

    def test_bad_options_and_root_check(self):
        for args, fragment in ((["--prefix", "usr"], "absolute path"), (["--prefix", "/"], "must not be /"),
                               (["--prefix", "/opt/a'b"], "may hold only"), (["--bogus"], "unknown option")):
            result = self.install(*args)
            self.assertEqual(result.returncode, 1, args)
            self.assertIn(fragment, result.stderr)
        self.h.uid = 1000
        result = self.h.run(INSTALL)
        self.assertEqual(result.returncode, 1)
        self.assertIn("run as root", result.stderr)

    def test_uninstall_removes_only_its_files(self):
        self.assertEqual(self.install().returncode, 0)
        foreign = self.root / "usr/local/bin/ground-gps-publisher"
        foreign.write_text("#!/bin/sh\necho mine\n", encoding="utf-8")
        script = self.root / "usr/local/share/ground-gps/uninstall.sh"
        result = self.h.run(script, "--root", str(self.root))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("kept /usr/local/bin/ground-gps-publisher: not written by the ground-gps installer", result.stdout)
        self.assertEqual(self.files(), {"etc/ground-gps/ground-gps.conf", "usr/local/bin/ground-gps-publisher"})
        foreign.unlink()
        self.assertEqual(self.install().returncode, 0)
        result = self.h.run(script, "--root", str(self.root), "--purge")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.files(), set())
        self.assertEqual(self.h.actions(), [])

    def test_uninstall_dry_run(self):
        self.assertEqual(self.install().returncode, 0)
        before = self.files()
        script = self.root / "usr/local/share/ground-gps/uninstall.sh"
        result = self.h.run(script, "--root", str(self.root), "--dry-run", "--purge")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("would run: systemctl disable --now ground-gps.service", result.stdout)
        self.assertIn("would remove /etc/systemd/system/ground-gps.service", result.stdout)
        self.assertIn("would remove /etc/ground-gps/ground-gps.conf", result.stdout)
        self.assertEqual(self.files(), before)


class ScriptLintTests(unittest.TestCase):
    def test_shell_syntax_and_modes(self):
        shells = [shell for shell in ("sh", "bash", "dash") if shutil.which(shell)]
        self.assertTrue(shells)
        for script in SCRIPTS:
            for shell in shells:
                result = subprocess.run([shell, "-n", str(script)], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, f"{shell} -n {script.name}: {result.stderr}")
            self.assertTrue(os.access(script, os.X_OK), f"{script.name} is not executable")
            self.assertTrue(script.read_text(encoding="utf-8").startswith("#!/bin/sh\n"), script.name)
        self.assertTrue(os.access(PUBLISHER, os.X_OK))
        self.assertTrue(PUBLISHER.read_text(encoding="utf-8").startswith("#!/usr/bin/env python3\n"))

    def test_publisher_uses_the_standard_library_only(self):
        source = f"exec(compile(open({str(PUBLISHER)!r}).read(), 'p', 'exec'), {{'__name__': 'p'}})"
        result = subprocess.run([sys.executable, "-I", "-S", "-B", "-c", source],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_shellcheck(self):
        shellcheck = os.environ.get("SHELLCHECK") or shutil.which("shellcheck")
        if not shellcheck:
            self.skipTest("shellcheck is not installed")
        result = subprocess.run([shellcheck, "-s", "sh", *map(str, SCRIPTS)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
