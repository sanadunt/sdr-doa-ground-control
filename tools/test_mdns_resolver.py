#!/usr/bin/env python3
"""One-shot mDNS lookups for .local Data Out hosts (issue #12).

Packet building and strict parsing (name compression, loops, truncation,
foreign or hostile answers), the cache, a loopback UDP responder standing in
for the mDNS group, and the collector path with the resolver patched in: the
connect goes to the mDNS address while the URL and Host header keep the name.
The send on every multicast interface runs against a fake socket and fake
interface ioctls. No multicast leaves the machine; every real socket is on
127.0.0.1.
"""

from __future__ import annotations

import errno
import ipaddress
import os
import random
import socket
import struct
import sys
import threading
import time
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import mdns_resolver as mdns  # noqa: E402
import sdr_doa_collector as collector  # noqa: E402

NAME = "doasdr.local"
QUERY_ID = 0x4242


def encoded(name: str) -> bytes:
    return mdns.encode_name(name)


def header(query_id: int = QUERY_ID, flags: int = 0x8400, questions: int = 0, answers: int = 1) -> bytes:
    return struct.pack("!HHHHHH", query_id, flags, questions, answers, 0, 0)


def a_record(name_wire: bytes, address: str = "192.168.100.100", ttl: int = 120, rtype: int = 1, rclass: int = 0x8001, rdata: Optional[bytes] = None) -> bytes:
    data = socket.inet_aton(address) if rdata is None else rdata
    return name_wire + struct.pack("!HHIH", rtype, rclass, ttl, len(data)) + data


def response(name: str = NAME, address: str = "192.168.100.100", ttl: int = 120, query_id: int = QUERY_ID, with_question: bool = True) -> bytes:
    """A legacy unicast answer: the question repeated, the answer name compressed onto it."""
    if not with_question:
        return header(query_id) + a_record(encoded(name), address, ttl)
    question = encoded(name) + struct.pack("!HH", 1, 1)
    pointer = struct.pack("!H", 0xC000 | 12)
    return header(query_id, questions=1) + question + a_record(pointer, address, ttl)


class PacketTests(unittest.TestCase):
    def test_query_is_one_a_question_with_the_qu_bit(self) -> None:
        query = mdns.build_query(NAME, 0x1234)
        self.assertEqual(struct.unpack("!HHHHHH", query[:12]), (0x1234, 0, 1, 0, 0, 0))
        self.assertEqual(query[12:-4], b"\x06doasdr\x05local\x00")
        self.assertEqual(struct.unpack("!HH", query[-4:]), (1, 0x8001))
        with self.assertRaises(ValueError):
            mdns.build_query(NAME, 0x10000)

    def test_only_valid_local_names_are_looked_up(self) -> None:
        self.assertEqual(mdns.normalize_local_name(" DoaSDR.Local. "), NAME)
        self.assertEqual(mdns.normalize_local_name("rdf-1.lab.local"), "rdf-1.lab.local")
        for name in ("local", "doasdr.lan", "doasdr", "*.local", "-x.local", "a_b.local", "a..local", "192.168.1.1", "", None, 7,
                     "a" * 64 + ".local", "ü.local"):
            self.assertIsNone(mdns.normalize_local_name(name), name)

    def test_parses_a_legacy_answer_with_compression(self) -> None:
        self.assertEqual(mdns.parse_response(response(), NAME, QUERY_ID), ("192.168.100.100", 120))
        self.assertEqual(mdns.parse_response(response(with_question=False), NAME, QUERY_ID), ("192.168.100.100", 120))
        # Names compare case-insensitively; the cache-flush bit is allowed.
        upper = header() + a_record(encoded("DOASDR.LOCAL"), rclass=0x8001)
        self.assertEqual(mdns.parse_response(upper, NAME, QUERY_ID), ("192.168.100.100", 120))
        plain = header() + a_record(encoded(NAME), rclass=1)
        self.assertEqual(mdns.parse_response(plain, NAME, QUERY_ID), ("192.168.100.100", 120))

    def test_skips_records_that_are_not_an_a_answer_for_the_name(self) -> None:
        cases = {
            "another name": a_record(encoded("other.local")),
            "a longer name": a_record(encoded("doasdr.local.local")),
            "AAAA": a_record(encoded(NAME), rtype=28, rdata=b"\x00" * 16),
            "class CH": a_record(encoded(NAME), rclass=3),
            "rdlength 5": a_record(encoded(NAME), rdata=b"\xc0\xa8\x01\x01\x01"),
            "goodbye TTL 0": a_record(encoded(NAME), ttl=0),
            "TTL top bit": a_record(encoded(NAME), ttl=0x80000001),
        }
        for label, record in cases.items():
            with self.subTest(label):
                self.assertIsNone(mdns.parse_response(header() + record, NAME, QUERY_ID))
        # A skipped record does not hide a good one after it.
        packet = header(answers=2) + cases["AAAA"] + a_record(encoded(NAME), "10.0.0.7", 30)
        self.assertEqual(mdns.parse_response(packet, NAME, QUERY_ID), ("10.0.0.7", 30))

    def test_refuses_addresses_a_node_never_has(self) -> None:
        for address in ("127.0.0.1", "0.0.0.0", "224.0.0.251", "239.1.2.3", "255.255.255.255", "240.0.0.1"):
            with self.subTest(address):
                self.assertIsNone(mdns.parse_response(response(address=address), NAME, QUERY_ID))
        self.assertEqual(mdns.parse_response(response(address="169.254.7.8"), NAME, QUERY_ID)[0], "169.254.7.8")

    def test_ignores_other_ids_queries_and_error_codes(self) -> None:
        self.assertIsNone(mdns.parse_response(response(query_id=QUERY_ID + 1), NAME, QUERY_ID))
        question = encoded(NAME) + struct.pack("!HH", 1, 1)
        for flags in (0x0000, 0x0400, 0x8403, 0x8800, 0x8401):
            with self.subTest(flags=hex(flags)):
                self.assertIsNone(mdns.parse_response(header(flags=flags, questions=1) + question + a_record(encoded(NAME)), NAME, QUERY_ID))

    def test_malformed_packets_raise_a_packet_error(self) -> None:
        good = response()
        question = encoded(NAME) + struct.pack("!HH", 1, 1)
        cases = {
            "short header": good[:11],
            "question cut": good[:20],
            "record header cut": good[:len(good) - 6],
            "rdata cut": good[:len(good) - 1],
            "label past the end": header() + b"\x3fabc",
            "pointer cut": header() + b"\xc0",
            "pointer forward": header() + struct.pack("!H", 0xC000 | 40) + b"\x00" * 40,
            "pointer to itself": header() + struct.pack("!H", 0xC000 | 12),
            "pointer loop": header(questions=1) + b"\x01a" + struct.pack("!H", 0xC000 | 12) + struct.pack("!HH", 1, 1),
            "reserved label type": header() + b"\x40abc\x00",
            "name over 255 bytes": header() + b"\x3f" + b"a" * 63 + b"\x3f" + b"b" * 63 + b"\x3f" + b"c" * 63 + b"\x3f" + b"d" * 63 + b"\x00",
            "too many questions": header(questions=60000, answers=0) + question,
            "over 9000 bytes": good + b"\x00" * 9000,
        }
        for label, packet in cases.items():
            with self.subTest(label):
                with self.assertRaises(mdns.MdnsPacketError):
                    mdns.parse_response(packet, NAME, QUERY_ID)

    def test_a_long_pointer_chain_is_cut_off(self) -> None:
        # Each name points to the one before it: valid, but more jumps than allowed.
        body = bytearray(b"\x05local\x00")
        offsets = [12]
        for _ in range(mdns.MAX_POINTER_JUMPS + 2):
            offsets.append(12 + len(body))
            body += struct.pack("!H", 0xC000 | offsets[-2])
        packet = header(answers=0) + bytes(body)
        self.assertEqual(mdns.read_name(packet, offsets[2]), ([b"local"], offsets[2] + 2))
        with self.assertRaises(mdns.MdnsPacketError):
            mdns.read_name(packet, offsets[-1])

    def test_random_and_mutated_packets_never_escape_the_parser(self) -> None:
        rng = random.Random(1206)
        good = response()
        started = time.monotonic()
        for _ in range(4000):
            if rng.random() < 0.5:
                packet = bytes(rng.getrandbits(8) for _ in range(rng.randint(0, 120)))
            else:
                mutated = bytearray(good)
                for _ in range(rng.randint(1, 6)):
                    mutated[rng.randrange(len(mutated))] = rng.getrandbits(8)
                packet = bytes(mutated)
            try:
                result = mdns.parse_response(packet, NAME, struct.unpack("!H", packet[:2])[0] if len(packet) >= 2 else 0)
            except mdns.MdnsPacketError:
                continue
            if result is not None:
                address, ttl = result
                self.assertEqual(len(socket.inet_aton(address)), 4)
                self.assertTrue(0 < ttl < 0x80000000)
        self.assertLess(time.monotonic() - started, 10)


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class CacheTests(unittest.TestCase):
    def resolver(self, answers: List[Optional[Tuple[str, int]]]) -> Tuple[mdns.MdnsResolver, List[str], FakeClock]:
        clock = FakeClock()
        resolver = mdns.MdnsResolver(clock=clock)
        calls: List[str] = []

        def query(name: str, deadline: float) -> Optional[Tuple[str, int]]:
            calls.append(name)
            return answers.pop(0)

        resolver._query = query  # type: ignore[assignment]
        return resolver, calls, clock

    def test_a_positive_answer_lives_for_its_ttl_within_the_cap(self) -> None:
        resolver, calls, clock = self.resolver([("192.168.100.100", 120), ("192.168.100.101", 2)])
        self.assertIsNone(resolver.cached(NAME))
        self.assertEqual(resolver.resolve("DoaSDR.local."), "192.168.100.100")
        self.assertEqual(resolver.cached(NAME), "192.168.100.100")
        clock.now += 59.9
        self.assertEqual(resolver.resolve(NAME), "192.168.100.100")
        self.assertEqual(calls, [NAME])
        clock.now += 0.2  # past the 60 s cap, although the record said 120 s
        self.assertIsNone(resolver.cached(NAME))
        self.assertEqual(resolver.resolve(NAME), "192.168.100.101")
        clock.now += 4.9  # a 2 s TTL is kept for the 5 s minimum
        self.assertEqual(resolver.cached(NAME), "192.168.100.101")
        clock.now += 0.2
        self.assertIsNone(resolver.cached(NAME))
        self.assertEqual(len(calls), 2)

    def test_a_failed_lookup_is_remembered_briefly(self) -> None:
        resolver, calls, clock = self.resolver([None, ("10.0.0.9", 10)])
        self.assertIsNone(resolver.resolve(NAME))
        self.assertIsNone(resolver.resolve(NAME))
        self.assertEqual(len(calls), 1)
        self.assertIsNone(resolver.cached(NAME), "a failure is not an address")
        clock.now += mdns.NEGATIVE_TTL_S + 0.1
        self.assertEqual(resolver.resolve(NAME), "10.0.0.9")
        self.assertEqual(len(calls), 2)

    def test_other_names_and_spent_budgets_send_nothing(self) -> None:
        resolver, calls, _clock = self.resolver([])
        for name in ("doasdr.lan", "192.168.1.1", "*.local"):
            self.assertIsNone(resolver.resolve(name))
        self.assertIsNone(resolver.resolve(NAME, timeout_s=0))
        self.assertIsNone(resolver.resolve(NAME, timeout_s=-1))
        self.assertEqual(calls, [])

    def test_the_cache_stays_bounded(self) -> None:
        answers: List[Optional[Tuple[str, int]]] = [("10.0.%d.%d" % divmod(index, 250), 60) for index in range(mdns.MAX_CACHE_ENTRIES + 10)]
        resolver, calls, _clock = self.resolver(answers)
        for index in range(mdns.MAX_CACHE_ENTRIES + 10):
            resolver.resolve(f"node{index}.local")
        self.assertLessEqual(len(resolver._cache), mdns.MAX_CACHE_ENTRIES)
        self.assertIsNone(resolver.cached("node0.local"), "the oldest entry made room")
        self.assertIsNotNone(resolver.cached(f"node{mdns.MAX_CACHE_ENTRIES + 9}.local"))

    def test_bad_settings_are_refused(self) -> None:
        for options in ({"timeout_s": 0}, {"timeout_s": 6}, {"min_ttl_s": 10, "max_ttl_s": 5}, {"min_ttl_s": 0}):
            with self.assertRaises(ValueError):
                mdns.MdnsResolver(**options)


class LoopbackResponder:
    """A UDP socket on 127.0.0.1 that answers queries the way the test says."""

    def __init__(self, reply: Callable[[bytes], List[Tuple[bytes, bool]]]) -> None:
        self.reply = reply
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.settimeout(0.1)
        self.port = self.sock.getsockname()[1]
        self.queries: List[bytes] = []
        self._stop = threading.Event()
        self.thread = threading.Thread(target=self._serve, daemon=True)

    def __enter__(self) -> "LoopbackResponder":
        self.thread.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self._stop.set()
        self.thread.join(2)
        self.sock.close()

    def _serve(self) -> None:
        while not self._stop.is_set():
            try:
                packet, source = self.sock.recvfrom(9000)
            except socket.timeout:
                continue
            except OSError:
                return
            self.queries.append(packet)
            for data, from_other_port in self.reply(packet):
                if from_other_port:
                    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as other:
                        other.sendto(data, source)
                else:
                    self.sock.sendto(data, source)


def answer_to(query: bytes, address: str = "192.168.100.100", ttl: int = 10) -> bytes:
    query_id = struct.unpack("!H", query[:2])[0]
    return response(NAME, address, ttl, query_id)


class LoopbackResolverTests(unittest.TestCase):
    def test_resolves_through_a_responder_and_sends_one_qu_question(self) -> None:
        with LoopbackResponder(lambda query: [(answer_to(query), False)]) as responder:
            resolver = mdns.MdnsResolver(("127.0.0.1", responder.port), timeout_s=1.0)
            self.assertEqual(resolver.resolve(NAME), "192.168.100.100")
            self.assertEqual(resolver.resolve(NAME), "192.168.100.100")
        self.assertEqual(len(responder.queries), 1)
        query = responder.queries[0]
        query_id, flags, questions, answers, authority, additional = struct.unpack("!HHHHHH", query[:12])
        self.assertNotEqual(query_id, 0)
        self.assertEqual((flags, questions, answers, authority, additional), (0, 1, 0, 0, 0))
        self.assertEqual(query[12:], encoded(NAME) + struct.pack("!HH", 1, 0x8001))

    def test_skips_noise_and_answers_from_another_port(self) -> None:
        def noisy(query: bytes) -> List[Tuple[bytes, bool]]:
            query_id = struct.unpack("!H", query[:2])[0]
            return [
                (answer_to(query, "10.6.6.6"), True),  # right ID, wrong source port
                (b"\x00" * 5, False),  # cut short
                (header(query_id) + b"\xc0\x0c", False),  # pointer loop
                (response(NAME, "10.6.6.7", 10, query_id ^ 0xFFFF), False),  # wrong ID
                (response("other.local", "10.6.6.8", 10, query_id, with_question=False), False),
                (answer_to(query, "192.168.100.100"), False),
            ]

        with LoopbackResponder(noisy) as responder:
            resolver = mdns.MdnsResolver(("127.0.0.1", responder.port), timeout_s=1.0)
            self.assertEqual(resolver.resolve(NAME), "192.168.100.100")

    def test_a_silent_group_costs_at_most_the_timeout_and_is_remembered(self) -> None:
        with LoopbackResponder(lambda query: []) as responder:
            resolver = mdns.MdnsResolver(("127.0.0.1", responder.port), timeout_s=1.0)
            started = time.monotonic()
            self.assertIsNone(resolver.resolve(NAME, timeout_s=0.3))
            self.assertLess(time.monotonic() - started, 0.8)
            started = time.monotonic()
            self.assertIsNone(resolver.resolve(NAME))
            self.assertLess(time.monotonic() - started, 0.1, "the failure is cached")
        self.assertEqual(len(responder.queries), 1)

    def test_a_flood_of_bad_datagrams_ends_the_lookup(self) -> None:
        with LoopbackResponder(lambda query: [(b"\xff" * 40, False)] * (mdns.MAX_DATAGRAMS + 5)) as responder:
            resolver = mdns.MdnsResolver(("127.0.0.1", responder.port), timeout_s=2.0)
            started = time.monotonic()
            self.assertIsNone(resolver.resolve(NAME))
            self.assertLess(time.monotonic() - started, 2.5)

    def test_parallel_lookups_share_one_query(self) -> None:
        def slow(query: bytes) -> List[Tuple[bytes, bool]]:
            time.sleep(0.2)
            return [(answer_to(query), False)]

        with LoopbackResponder(slow) as responder:
            resolver = mdns.MdnsResolver(("127.0.0.1", responder.port), timeout_s=1.0)
            results: List[Optional[str]] = []
            threads = [threading.Thread(target=lambda: results.append(resolver.resolve(NAME))) for _ in range(4)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(3)
        self.assertEqual(results, ["192.168.100.100"] * 4)
        self.assertEqual(len(responder.queries), 1)


class FakeNetwork:
    """What the query socket sees: which interfaces exist, route and answer.

    ``answering`` are the interface addresses whose link the node is on, and
    ``default_route`` the interface a plain sendto leaves through (None: no
    route for 224.0.0.251, so ENETUNREACH). ``gone`` interfaces refuse
    IP_MULTICAST_IF, ``down`` ones refuse the send.
    """

    def __init__(self, answering: Tuple[str, ...] = (), default_route: Optional[str] = None,
                 gone: Tuple[str, ...] = (), down: Tuple[str, ...] = ()) -> None:
        self.answering = set(answering)
        self.default_route = default_route
        self.gone = set(gone)
        self.down = set(down)
        self.sent: List[Tuple[Optional[str], Tuple[str, int]]] = []
        self.interfaces_set: List[Optional[str]] = []

    def socket(self, *args: Any, **kwargs: Any) -> "FakeQuerySocket":
        return FakeQuerySocket(self)


class FakeQuerySocket:
    def __init__(self, network: FakeNetwork) -> None:
        self.network = network
        self.interface: Optional[str] = None
        self.inbox: List[Tuple[bytes, Tuple[str, int]]] = []

    def setsockopt(self, level: int, option: int, value: Any) -> None:
        if option != socket.IP_MULTICAST_IF:
            return
        address = socket.inet_ntoa(value)
        if address in self.network.gone:
            raise OSError(errno.EADDRNOTAVAIL, "Cannot assign requested address")
        self.interface = None if address == "0.0.0.0" else address
        self.network.interfaces_set.append(self.interface)

    def bind(self, address: Tuple[str, int]) -> None:
        return None

    def settimeout(self, value: float) -> None:
        return None

    def sendto(self, data: bytes, destination: Tuple[str, int]) -> int:
        out = self.interface or self.network.default_route
        if out is None or out in self.network.down:
            raise OSError(errno.ENETUNREACH, "Network is unreachable")
        self.network.sent.append((self.interface, destination))
        if out in self.network.answering:
            self.inbox.append((answer_to(data), ("192.168.100.100", 5353)))
        return len(data)

    def recvfrom(self, size: int) -> Tuple[bytes, Tuple[str, int]]:
        if not self.inbox:
            raise socket.timeout("timed out")
        return self.inbox.pop(0)

    def close(self) -> None:
        return None


class InterfaceSendTests(unittest.TestCase):
    """A query to the mDNS group goes out on every multicast interface, as avahi's does."""

    def resolve(self, network: FakeNetwork, interfaces: List[str]) -> Optional[str]:
        resolver = mdns.MdnsResolver(timeout_s=0.5, interfaces=lambda: list(interfaces))
        with mock.patch.object(mdns.socket, "socket", network.socket):
            return resolver.resolve(NAME)

    def test_without_a_route_for_the_group_each_lan_still_gets_the_query(self) -> None:
        # Static 192.168.100.x, no gateway: a plain sendto fails with ENETUNREACH.
        network = FakeNetwork(answering=("192.168.100.5",), default_route=None, down=("10.20.0.2",))
        self.assertEqual(self.resolve(network, ["10.20.0.2", "172.17.0.1", "192.168.100.5"]), "192.168.100.100")
        self.assertEqual(network.interfaces_set, ["10.20.0.2", "172.17.0.1", "192.168.100.5"])
        self.assertEqual(network.sent, [("172.17.0.1", mdns.MDNS_ADDRESS), ("192.168.100.5", mdns.MDNS_ADDRESS)])

    def test_the_node_off_the_default_route_link_is_reached(self) -> None:
        # The default route is the uplink; the node is on the LAN interface.
        network = FakeNetwork(answering=("192.168.100.5",), default_route="10.64.0.9")
        self.assertEqual(self.resolve(network, ["10.64.0.9", "192.168.100.5"]), "192.168.100.100")
        self.assertEqual([interface for interface, _ in network.sent], ["10.64.0.9", "192.168.100.5"])

    def test_the_routing_table_is_the_fallback(self) -> None:
        for interfaces in ([], ["10.20.0.2"]):
            with self.subTest(interfaces=interfaces):
                network = FakeNetwork(answering=("192.168.100.5",), default_route="192.168.100.5", gone=("10.20.0.2",))
                self.assertEqual(self.resolve(network, interfaces), "192.168.100.100")
                self.assertEqual(network.sent, [(None, mdns.MDNS_ADDRESS)])
                if interfaces:
                    self.assertEqual(network.interfaces_set, [None], "the interface choice is reset first")

    def test_enetunreach_everywhere_is_a_quick_failure(self) -> None:
        network = FakeNetwork(default_route=None, down=("10.20.0.2",))
        started = time.monotonic()
        self.assertIsNone(self.resolve(network, ["10.20.0.2"]))
        self.assertLess(time.monotonic() - started, 0.3, "nothing left, so no wait for an answer")
        self.assertEqual(network.sent, [])

    def test_a_unicast_destination_never_reads_the_interfaces(self) -> None:
        def interfaces() -> List[str]:
            raise AssertionError("not for a unicast destination")

        with LoopbackResponder(lambda query: [(answer_to(query), False)]) as responder:
            resolver = mdns.MdnsResolver(("127.0.0.1", responder.port), timeout_s=1.0, interfaces=interfaces)
            self.assertEqual(resolver.resolve(NAME), "192.168.100.100")


UP, LOOPBACK, RUNNING, MULTICAST = 0x1, 0x8, 0x40, 0x1000


class FakeIoctl:
    """SIOCGIFFLAGS and SIOCGIFADDR answers for named interfaces."""

    def __init__(self, interfaces: Dict[str, Tuple[int, Optional[str]]], broken: Tuple[str, ...] = ()) -> None:
        self.interfaces = interfaces
        self.broken = set(broken)

    def ioctl(self, fd: int, request: int, arg: bytes) -> bytes:
        name = arg[:16].rstrip(b"\0").decode("ascii")
        if name in self.broken or name not in self.interfaces:
            raise OSError(errno.ENODEV, "No such device")
        flags, address = self.interfaces[name]
        if request == 0x8913:
            return arg[:16] + struct.pack("H", flags) + b"\0" * 22
        if request == 0x8915:
            if address is None:
                raise OSError(errno.EADDRNOTAVAIL, "Cannot assign requested address")
            return arg[:16] + struct.pack("H", socket.AF_INET) + b"\0\0" + socket.inet_aton(address) + b"\0" * 16
        raise OSError(errno.EINVAL, "Invalid argument")


class InterfaceListTests(unittest.TestCase):
    def addresses(self, interfaces: Dict[str, Tuple[int, Optional[str]]], broken: Tuple[str, ...] = (), platform: str = "linux") -> List[str]:
        index = [(position + 1, name) for position, name in enumerate(list(interfaces) + list(broken))]
        with mock.patch.object(mdns, "fcntl", FakeIoctl(interfaces, broken)), \
                mock.patch.object(mdns, "sys", types.SimpleNamespace(platform=platform)), \
                mock.patch.object(mdns.socket, "if_nameindex", lambda: index):
            return mdns.multicast_interface_addresses()

    def test_up_running_multicast_links_with_an_ipv4_address(self) -> None:
        interfaces = {
            "lo": (UP | RUNNING | LOOPBACK, "127.0.0.1"),
            "eth0": (UP | RUNNING | MULTICAST, "192.168.100.5"),
            "wlan0": (UP | MULTICAST, "10.1.1.2"),  # no carrier
            "tun0": (UP | RUNNING, "10.8.0.2"),  # no multicast
            "br0": (UP | RUNNING | MULTICAST, None),  # no IPv4 address
            "eth1": (UP | RUNNING | MULTICAST, "10.20.0.2"),
            "eth2": (RUNNING | MULTICAST, "10.30.0.2"),  # down
            "veth9": (UP | RUNNING | MULTICAST, "192.168.100.5"),  # same address again
        }
        self.assertEqual(self.addresses(interfaces, broken=("gone0",)), ["192.168.100.5", "10.20.0.2"])

    def test_the_list_is_bounded_and_linux_only(self) -> None:
        many = {f"veth{index}": (UP | RUNNING | MULTICAST, f"10.0.{index}.1") for index in range(mdns.MAX_INTERFACES + 8)}
        listed = self.addresses(many)
        self.assertEqual(len(listed), mdns.MAX_INTERFACES)
        self.assertEqual(listed[0], "10.0.0.1")
        self.assertEqual(self.addresses(many, platform="win32"), [])
        with mock.patch.object(mdns, "fcntl", None):
            self.assertEqual(mdns.multicast_interface_addresses(), [])

    def test_this_host_lists_only_usable_addresses(self) -> None:
        for address in mdns.multicast_interface_addresses():
            parsed = ipaddress.IPv4Address(address)
            self.assertFalse(parsed.is_loopback or parsed.is_unspecified, address)


class StubResolver:
    """Stands in for MdnsResolver in the collector path."""

    def __init__(self, address: Optional[str]) -> None:
        self.address = address
        self.resolve_calls: List[Tuple[str, float]] = []
        self.cache: Dict[str, str] = {}

    def cached(self, host: str) -> Optional[str]:
        return self.cache.get(host)

    def resolve(self, host: str, timeout_s: Optional[float] = None) -> Optional[str]:
        self.resolve_calls.append((host, float(timeout_s or 0)))
        if self.address is not None:
            self.cache[host] = self.address
        return self.address


class DataOutStub(BaseHTTPRequestHandler):
    hosts: List[str] = []

    def do_GET(self) -> None:  # noqa: N802
        DataOutStub.hosts.append(self.headers.get("Host", ""))
        if self.path == "/redirect.json":
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:1/x")
            self.end_headers()
            return
        body = b'{"ok": true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: Any) -> None:
        return None


class ProxyStub(BaseHTTPRequestHandler):
    """A forward proxy that answers status.json itself and 404 for the rest."""

    requested: List[str] = []

    def do_GET(self) -> None:  # noqa: N802
        ProxyStub.requested.append(self.path)
        found = self.path.endswith("/status.json")
        body = b'{"ok": true}' if found else b"{}"
        self.send_response(200 if found else 404)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: Any) -> None:
        return None


def unresolvable(*args: Any, **kwargs: Any) -> Any:
    raise socket.gaierror(socket.EAI_NONAME, "Name or service not known")


class CollectorPathTests(unittest.TestCase):
    """fetch_resource with the resolver patched in; the system resolver always fails here."""

    def setUp(self) -> None:
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), DataOutStub)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        DataOutStub.hosts = []
        # Direct connections only, whatever proxy the environment has.
        proxies = mock.patch.dict(os.environ, {key: "" for key in ("http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY")})
        proxies.start()
        self.addCleanup(proxies.stop)
        # The URL keeps port 8081; the pinned connect goes to the stub's port.
        real_connect = socket.create_connection
        port = self.port

        def connect(address: Tuple[str, int], *args: Any, **kwargs: Any) -> socket.socket:
            host, wanted = address
            self.connects.append((host, wanted))
            if host == "doasdr.local":
                raise socket.gaierror(socket.EAI_NONAME, "Name or service not known")
            return real_connect((host, port if wanted == 8081 else wanted), *args, **kwargs)

        self.connects: List[Tuple[str, int]] = []
        patcher = mock.patch.object(socket, "create_connection", connect)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def fetch(self, resolver: Any, path: str = collector.PATH_STATUS, base_url: str = "http://doasdr.local:8081") -> collector.FetchedResource:
        return collector.fetch_resource(base_url, path, 2.0, mdns_resolver=resolver)

    def test_falls_back_to_mdns_and_keeps_the_host_header(self) -> None:
        resolver = StubResolver("127.0.0.1")
        fetched = self.fetch(resolver)
        self.assertTrue(fetched.ok, fetched.error)
        self.assertEqual(fetched.body, b'{"ok": true}')
        self.assertEqual((fetched.resolved_via, fetched.resolved_address), ("mdns", "127.0.0.1"))
        self.assertEqual(fetched.url, "http://doasdr.local:8081/status.json")
        self.assertEqual(DataOutStub.hosts, ["doasdr.local:8081"])
        self.assertEqual(self.connects, [("doasdr.local", 8081), ("127.0.0.1", 8081)], "system resolver first, then the mDNS address")
        self.assertEqual(len(resolver.resolve_calls), 1)
        self.assertLessEqual(resolver.resolve_calls[0][1], 2.0)
        # While the address is cached the system resolver is not asked again.
        self.connects.clear()
        self.assertTrue(self.fetch(resolver, collector.PATH_SETTINGS).ok)
        self.assertEqual(self.connects, [("127.0.0.1", 8081)])
        self.assertEqual(len(resolver.resolve_calls), 1)

    def test_says_to_use_an_ip_address_when_mdns_fails_too(self) -> None:
        fetched = self.fetch(StubResolver(None))
        self.assertFalse(fetched.ok)
        self.assertEqual(fetched.error, "doasdr.local could not be resolved (system and mDNS); use an IP address")
        self.assertEqual(fetched.error_kind, "unreachable")
        self.assertIsNone(fetched.resolved_via)

    def test_without_a_resolver_the_old_error_stays(self) -> None:
        fetched = self.fetch(None)
        self.assertEqual((fetched.error, fetched.error_kind), ("host name resolution failed", "unreachable"))

    def test_only_local_names_go_to_mdns(self) -> None:
        resolver = StubResolver("127.0.0.1")
        with mock.patch.object(socket, "getaddrinfo", unresolvable):
            fetched = collector.fetch_resource("http://rdf.lan:8081", collector.PATH_STATUS, 2.0, allowed_hosts=["rdf.lan"], mdns_resolver=resolver)
        self.assertFalse(fetched.ok)
        self.assertEqual(resolver.resolve_calls, [])
        literal = collector.fetch_resource("http://127.0.0.1:8081", collector.PATH_STATUS, 2.0, mdns_resolver=resolver)
        self.assertTrue(literal.ok, literal.error)
        self.assertEqual((literal.resolved_via, literal.resolved_address), ("literal", "127.0.0.1"))
        self.assertEqual(resolver.resolve_calls, [])

    def test_through_a_proxy_mdns_is_not_used(self) -> None:
        resolver = StubResolver("127.0.0.1")
        with mock.patch.dict(os.environ, {"http_proxy": "http://proxy.invalid:3128", "no_proxy": ""}), \
                mock.patch.object(socket, "getaddrinfo", unresolvable):
            fetched = self.fetch(resolver)
        self.assertFalse(fetched.ok)
        self.assertEqual(resolver.resolve_calls, [], "the proxy resolves the name; no mDNS, no direct connect")

    def test_through_a_proxy_no_address_is_recorded(self) -> None:
        # The peer of a proxied request is the proxy, not the Data Out host.
        proxy = ThreadingHTTPServer(("127.0.0.1", 0), ProxyStub)
        thread = threading.Thread(target=proxy.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 2)
        self.addCleanup(proxy.server_close)
        self.addCleanup(proxy.shutdown)
        ProxyStub.requested = []
        resolver = StubResolver("10.9.9.9")
        with mock.patch.dict(os.environ, {"http_proxy": f"http://127.0.0.1:{proxy.server_address[1]}", "no_proxy": ""}):
            fetched = self.fetch(resolver)
            missing = self.fetch(resolver, collector.PATH_CSV)
            result = collector.collect("http://doasdr.local:8081", total_budget_s=3.0, mdns_resolver=resolver)
        self.assertTrue(fetched.ok, fetched.error)
        self.assertEqual((fetched.resolved_via, fetched.resolved_address), ("proxy", None))
        self.assertEqual((missing.http_status, missing.resolved_via, missing.resolved_address), (404, "proxy", None))
        self.assertEqual(result["collection"]["host_resolution"], {"host": "doasdr.local", "method": "proxy", "address": None})
        self.assertIn("http://doasdr.local:8081/status.json", ProxyStub.requested)
        self.assertEqual(resolver.resolve_calls, [])

    def test_the_pinned_request_keeps_every_rule(self) -> None:
        resolver = StubResolver("127.0.0.1")
        # Not on the host list: refused before any lookup.
        refused = collector.fetch_resource("http://rdf.local:8081", collector.PATH_STATUS, 2.0, mdns_resolver=resolver)
        self.assertEqual(refused.error_kind, "invalid_target")
        self.assertEqual(resolver.resolve_calls, [])
        with self.assertRaises(ValueError):
            self.fetch(resolver, "/redirect.json")
        # No redirects and the size bound on the mDNS connection too.
        with mock.patch.object(collector, "PATH_STATUS", "/redirect.json"):
            redirected = collector.fetch_resource("http://doasdr.local:8081", "/redirect.json", 2.0, mdns_resolver=resolver)
        self.assertEqual(redirected.error_kind, "redirect")
        resolver.cache.clear()
        small = collector.fetch_resource("http://doasdr.local:8081", collector.PATH_STATUS, 2.0, max_body_bytes=4, mdns_resolver=resolver)
        self.assertEqual((small.error_kind, small.resolved_via), ("body_too_large", "mdns"))

    def test_collect_reports_how_the_host_was_resolved(self) -> None:
        resolver = StubResolver("127.0.0.1")
        result = collector.collect("http://doasdr.local:8081", total_budget_s=3.0, mdns_resolver=resolver)
        self.assertEqual(result["collection"]["host_resolution"], {"host": "doasdr.local", "method": "mdns", "address": "127.0.0.1"})
        failed = collector.collect("http://doasdr.local:8081", total_budget_s=3.0, mdns_resolver=StubResolver(None))
        self.assertEqual(failed["collection"]["host_resolution"], {"host": "doasdr.local", "method": None, "address": None})
        self.assertEqual(failed["resources"]["/status.json"]["error"], "doasdr.local could not be resolved (system and mDNS); use an IP address")
        literal = collector.collect("http://127.0.0.1:8081", total_budget_s=3.0)
        self.assertEqual(literal["collection"]["host_resolution"], {"host": "127.0.0.1", "method": "literal", "address": "127.0.0.1"})

    def test_collect_reports_the_system_resolver_and_peer(self) -> None:
        # localhost is resolved by the system resolver (setUp only moves the
        # port to the stub); the connected peer is the address recorded.
        resolver = StubResolver("10.9.9.9")
        result = collector.collect("http://localhost:8081", total_budget_s=3.0, mdns_resolver=resolver)
        self.assertEqual(result["collection"]["host_resolution"], {"host": "localhost", "method": "system", "address": "127.0.0.1"})
        self.assertEqual(resolver.resolve_calls, [])


if __name__ == "__main__":
    unittest.main()
