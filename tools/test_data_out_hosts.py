#!/usr/bin/env python3
"""The Data Out host list as a saved console setting (issue #11).

The host rules against tools/fixtures/data_out_hosts.json (the same cases
frontend/src/lib/dataOutHosts.test.ts runs), console.json validation and
loading, first-start seeding (SDR_DOA_SEED_DATA_OUT_HOSTS), the --base-url
check in main(), and over HTTP: /api/console-config with its DATA_OUT_*
codes, /api/snapshot handing the list and the mDNS resolver to the
collector, and the legacy UI. No network: a loopback console only.
"""

from __future__ import annotations

import http.client
import json
import os
import random
import socket
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from unittest import mock

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))

import ground_console  # noqa: E402
import sdr_doa_collector as collector  # noqa: E402

CASES = json.loads((TOOLS / "fixtures" / "data_out_hosts.json").read_text(encoding="utf-8"))
DEFAULTS = ["doasdr.local", "192.168.100.100", "127.0.0.1", "localhost"]
FRONTEND_TEST = TOOLS.parent / "frontend" / "src" / "lib" / "dataOutHosts.test.ts"


class Logs:
    def __init__(self) -> None:
        self.lines: List[str] = []

    def __call__(self, message: str) -> None:
        self.lines.append(message)


class HostRuleTests(unittest.TestCase):
    def test_python_rules_match_the_shared_cases(self) -> None:
        for value, expected in CASES["hosts"]:
            with self.subTest(host=value):
                self.assertEqual(collector.data_out_host_key(value), expected)
        for value, expected in CASES["urls"]:
            with self.subTest(url=value):
                self.assertEqual(collector.data_out_url_host(value), expected)

    def test_a_saved_host_reads_back_as_itself(self) -> None:
        # The saved form must pass the same check on the next load (and in
        # dataOutHosts.ts, which runs the fixture). Some Python releases write
        # an IPv4-mapped address with a dotted quad, so those are refused.
        for value, expected in CASES["hosts"]:
            if expected is not None:
                with self.subTest(host=value):
                    self.assertEqual(collector.data_out_host_key(expected), expected)
        generator = random.Random(11)
        prefixes = ([0, 0, 0, 0, 0, 0xFFFF], [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0xFFFF, 0], [0x64, 0xFF9B, 0, 0, 0, 0])
        for _ in range(4000):
            groups = list(generator.choice(prefixes)) + [generator.choice((0, 1, 0x7F00, 0xC0A8, generator.randrange(0x10000))) for _ in range(2)]
            if generator.random() < 0.3:
                groups = [generator.choice((0, 0, 1, 0xFFFF, generator.randrange(0x10000))) for _ in range(8)]
            text = ":".join(f"{group:x}" for group in groups)
            saved = collector.data_out_host_key(text)
            mapped = groups[:6] == [0, 0, 0, 0, 0, 0xFFFF]
            with self.subTest(host=text):
                if mapped or not any(groups):
                    self.assertIsNone(saved)
                else:
                    self.assertIsNotNone(saved)
                    self.assertNotIn(".", saved or "")
                    self.assertEqual(collector.data_out_host_key(saved), saved)

    def test_defaults_port_limit_and_codes_match_the_frontend_cases(self) -> None:
        self.assertEqual(list(collector.DEFAULT_DATA_OUT_HOSTS), CASES["defaults"])
        self.assertEqual(collector.DATA_OUT_PORT, CASES["port"])
        self.assertEqual(collector.MAX_DATA_OUT_HOSTS, CASES["max_hosts"])
        codes = [
            collector.DATA_OUT_HOST_INVALID,
            collector.DATA_OUT_HOSTS_EMPTY,
            collector.DATA_OUT_HOSTS_TOO_MANY,
            collector.DATA_OUT_HOST_IN_USE,
            collector.DATA_OUT_URL_NOT_ALLOWED,
        ]
        self.assertEqual(codes, CASES["error_codes"])
        # The frontend runs the same file; dropping it there breaks the contract.
        self.assertIn("tools/fixtures/data_out_hosts.json", FRONTEND_TEST.read_text(encoding="utf-8"))

    def test_a_list_is_normalized_deduplicated_and_bounded(self) -> None:
        self.assertEqual(collector.normalize_data_out_hosts(["RDF.local.", "rdf.local", "[FD00::1]", "fd00:0::1"]), ["rdf.local", "fd00::1"])
        cases = {
            collector.DATA_OUT_HOSTS_EMPTY: [],
            collector.DATA_OUT_HOSTS_TOO_MANY: [f"n{index}.local" for index in range(17)],
            collector.DATA_OUT_HOST_INVALID: ["rdf.local", "*.local"],
        }
        for code, value in cases.items():
            with self.subTest(code):
                with self.assertRaises(collector.DataOutHostError) as caught:
                    collector.normalize_data_out_hosts(value)
                self.assertEqual(caught.exception.code, code)
        # Duplicates do not count against the limit, but a huge raw list is refused.
        self.assertEqual(collector.normalize_data_out_hosts(["rdf.local"] * 40), ["rdf.local"])
        with self.assertRaises(collector.DataOutHostError):
            collector.normalize_data_out_hosts(["rdf.local"] * 65)
        for value in ("rdf.local", None, {"rdf.local": 1}, [7]):
            with self.assertRaises(collector.DataOutHostError):
                collector.normalize_data_out_hosts(value)

    def test_the_url_error_names_the_hosts_and_the_port(self) -> None:
        with self.assertRaises(collector.DataOutHostError) as caught:
            collector.check_data_out_url("http://rdf.local:8081", DEFAULTS)
        error = caught.exception
        self.assertEqual(error.code, collector.DATA_OUT_URL_NOT_ALLOWED)
        self.assertEqual(error.hosts, tuple(DEFAULTS))
        self.assertEqual(error.host, "rdf.local")
        self.assertIn("8081", str(error))
        for host in DEFAULTS:
            self.assertIn(host, str(error))
        self.assertEqual(collector.check_data_out_url("http://RDF.local:8081/", ["rdf.local"]), "http://RDF.local:8081")
        # The collector refuses the same URL before any request.
        fetched = collector.fetch_resource("http://rdf.local:8081", collector.PATH_STATUS)
        self.assertEqual(fetched.error_kind, "invalid_target")
        self.assertIn("doasdr.local", fetched.error or "")

    def test_the_collector_cli_takes_its_own_host_list(self) -> None:
        parser = collector._build_parser()
        args = parser.parse_args(["--base-url", "http://rdf.local:8081", "--data-out-host", "rdf.local", "--data-out-host", "RDF.local"])
        self.assertEqual(collector.normalize_data_out_hosts(args.data_out_host), ["rdf.local"])
        captured: Dict[str, Any] = {}

        def fake_collect(**kwargs: Any) -> Dict[str, Any]:
            captured.update(kwargs)
            return {"ok": True}

        with mock.patch.object(collector, "collect", fake_collect), mock.patch("builtins.print"):
            self.assertEqual(collector.main(["--base-url", "http://rdf.local:8081", "--data-out-host", "rdf.local"]), 0)
        self.assertEqual(captured["allowed_hosts"], ["rdf.local"])


class ConsoleConfigTests(unittest.TestCase):
    def test_the_default_config_carries_the_default_list(self) -> None:
        config = ground_console._default_console_config()
        self.assertEqual(config["data_out_hosts"], DEFAULTS)
        self.assertEqual(ground_console._validate_console_config({}), config)

    def test_a_url_on_a_saved_host_is_accepted(self) -> None:
        config = ground_console._validate_console_config({"base_url": "http://rdf.local:8081/", "data_out_hosts": ["RDF.local", "doasdr.local", "rdf.local"]})
        self.assertEqual((config["base_url"], config["data_out_hosts"]), ("http://rdf.local:8081", ["rdf.local", "doasdr.local"]))
        both = ground_console._validate_console_config({"base_url": "http://[fd00::1]:8081", "data_out_hosts": ["fd00::1"]})
        self.assertEqual(both["data_out_hosts"], ["fd00::1"])

    def test_a_url_outside_the_list_is_refused_with_the_list(self) -> None:
        for base_url in ("http://rdf.local:8081", "http://doasdr.local:9999", "https://doasdr.local:8081", "http://doasdr.local:8081/x"):
            with self.subTest(base_url):
                with self.assertRaises(collector.DataOutHostError) as caught:
                    ground_console._validate_console_config({"base_url": base_url})
                self.assertEqual(caught.exception.code, collector.DATA_OUT_URL_NOT_ALLOWED)
                self.assertEqual(list(caught.exception.hosts), DEFAULTS)

    def test_the_list_must_keep_the_host_of_the_url(self) -> None:
        saved = ground_console._validate_console_config({"base_url": "http://rdf.local:8081", "data_out_hosts": ["rdf.local", "doasdr.local"]})
        with self.assertRaises(collector.DataOutHostError) as caught:
            ground_console._validate_console_config({**saved, "data_out_hosts": ["doasdr.local"]}, saved)
        self.assertEqual(caught.exception.code, collector.DATA_OUT_HOST_IN_USE)
        self.assertEqual(caught.exception.host, "rdf.local")
        # Moving the URL and dropping the old host in one save is fine.
        moved = ground_console._validate_console_config({**saved, "base_url": "http://doasdr.local:8081", "data_out_hosts": ["doasdr.local"]}, saved)
        self.assertEqual((moved["base_url"], moved["data_out_hosts"]), ("http://doasdr.local:8081", ["doasdr.local"]))

    def test_loading_keeps_a_valid_pair_when_another_field_is_bad(self) -> None:
        logs = Logs()
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "console.json"
            path.write_text(json.dumps({"base_url": "http://rdf.local:8081", "data_out_hosts": ["rdf.local"], "mqtt_port": "x"}), encoding="utf-8")
            config = ground_console._load_console_config(path, log=logs)
            self.assertEqual((config["base_url"], config["data_out_hosts"], config["mqtt_port"]), ("http://rdf.local:8081", ["rdf.local"], 9001))
            self.assertTrue(any("mqtt_port" in line and "base_url" not in line for line in logs.lines), logs.lines)
            # A bad list takes the URL on that host with it.
            path.write_text(json.dumps({"base_url": "http://rdf.local:8081", "data_out_hosts": ["*.local"]}), encoding="utf-8")
            config = ground_console._load_console_config(path, log=logs)
            self.assertEqual((config["base_url"], config["data_out_hosts"]), ("http://doasdr.local:8081", DEFAULTS))
            self.assertTrue(any("base_url" in line and "data_out_hosts" in line for line in logs.lines), logs.lines)
            # A bad URL keeps a list that still holds the default URL's host.
            path.write_text(json.dumps({"base_url": "ftp://x", "data_out_hosts": ["doasdr.local", "rdf.local"]}), encoding="utf-8")
            config = ground_console._load_console_config(path, log=logs)
            self.assertEqual((config["base_url"], config["data_out_hosts"]), ("http://doasdr.local:8081", ["doasdr.local", "rdf.local"]))
            # A file without the field (written before #11) gets the defaults.
            path.write_text(json.dumps({"base_url": "http://192.168.100.100:8081", "refresh_seconds": 5}), encoding="utf-8")
            config = ground_console._load_console_config(path, log=logs)
            self.assertEqual((config["base_url"], config["data_out_hosts"]), ("http://192.168.100.100:8081", DEFAULTS))


class SeedTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="sdr-doa-hosts-seed-")
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / "console.json"
        self.logs = Logs()
        quiet = mock.patch("builtins.print")
        quiet.start()
        self.addCleanup(quiet.stop)

    def initial(self, environ: Dict[str, str]) -> Dict[str, Any]:
        return ground_console._initial_console_config(self.path, environ, {}, log=self.logs)

    def test_the_host_seed_lets_the_url_seed_use_its_hosts(self) -> None:
        config = self.initial({
            "SDR_DOA_SEED_DATA_OUT_HOSTS": " RDF.local , 192.168.100.100,rdf.local",
            "SDR_DOA_SEED_BASE_URL": "http://rdf.local:8081",
        })
        self.assertEqual((config["base_url"], config["data_out_hosts"]), ("http://rdf.local:8081", ["rdf.local", "192.168.100.100"]))
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8"))["data_out_hosts"], ["rdf.local", "192.168.100.100"])
        self.assertEqual(self.logs.lines, [])

    def test_a_host_seed_with_the_default_url_host_applies_alone(self) -> None:
        config = self.initial({"SDR_DOA_SEED_DATA_OUT_HOSTS": "doasdr.local,rdf.local"})
        self.assertEqual((config["base_url"], config["data_out_hosts"]), ("http://doasdr.local:8081", ["doasdr.local", "rdf.local"]))

    def test_invalid_or_orphaning_seeds_are_ignored_by_name(self) -> None:
        cases = [
            ({"SDR_DOA_SEED_DATA_OUT_HOSTS": "rdf.local,*.local"}, "SDR_DOA_SEED_DATA_OUT_HOSTS", "*.local"),
            ({"SDR_DOA_SEED_DATA_OUT_HOSTS": ","}, "SDR_DOA_SEED_DATA_OUT_HOSTS", ","),
            ({"SDR_DOA_SEED_DATA_OUT_HOSTS": "rdf.local"}, "SDR_DOA_SEED_DATA_OUT_HOSTS", "rdf.local"),
            ({"SDR_DOA_SEED_BASE_URL": "http://rdf.local:8081"}, "SDR_DOA_SEED_BASE_URL", "rdf.local"),
            ({"SDR_DOA_SEED_DATA_OUT_HOSTS": "192.168.100.100", "SDR_DOA_SEED_BASE_URL": "http://rdf.local:8081"}, "SDR_DOA_SEED_BASE_URL", "rdf.local"),
        ]
        for environ, variable, value in cases:
            with self.subTest(environ=environ):
                if self.path.exists():
                    self.path.unlink()
                self.logs.lines.clear()
                config = self.initial(environ)
                self.assertEqual(config, ground_console._default_console_config())
                self.assertTrue(any(variable in line for line in self.logs.lines), self.logs.lines)
                self.assertFalse(any(value in line for line in self.logs.lines), f"the value is not echoed: {self.logs.lines}")

    def test_an_empty_host_seed_counts_as_unset(self) -> None:
        config = self.initial({"SDR_DOA_SEED_DATA_OUT_HOSTS": "  ", "SDR_DOA_SEED_BASE_URL": "http://127.0.0.1:8081"})
        self.assertEqual((config["base_url"], config["data_out_hosts"]), ("http://127.0.0.1:8081", DEFAULTS))
        self.assertEqual(self.logs.lines, [])

    def test_the_seed_variables_are_listed(self) -> None:
        variables = [variable for variable, _field, _integer in ground_console.SEED_ENV_FIELDS]
        self.assertEqual(variables[:2], ["SDR_DOA_SEED_DATA_OUT_HOSTS", "SDR_DOA_SEED_BASE_URL"])


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


class _StubMonitor:
    def __init__(self, host: str, port: int, transport: str = "tcp", ws_path: str = "/mqtt") -> None:
        self.host, self.port, self.transport, self.ws_path = host, port, transport, ws_path

    def start(self) -> None:
        return None

    def stop(self) -> None:
        return None


class MainTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="sdr-doa-hosts-main-")
        self.addCleanup(temporary.cleanup)
        self.data = Path(temporary.name)
        clean = {key: value for key, value in os.environ.items() if not key.startswith("SDR_DOA_")}
        for patcher in (
            mock.patch.dict(os.environ, clean, clear=True),
            mock.patch.object(ground_console, "ADMIN_PASSWORD", "before-main"),
            mock.patch.object(ground_console, "_new_mqtt_monitor", lambda *args: _StubMonitor(*args)),
            mock.patch("builtins.print"),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.servers: List[Any] = []
        servers = self.servers

        def serve(server: Any) -> None:
            servers.append(server)
            raise KeyboardInterrupt

        patcher = mock.patch.object(ground_console.GroundConsoleServer, "serve_forever", serve)
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_main(self, *extra: str) -> Any:
        argv = [
            "--port", str(_free_port()),
            "--config-path", str(self.data / "console.json"),
            "--branding-path", str(self.data / "branding.json"),
            "--preferences-path", str(self.data / "preferences.json"),
            "--data-dir", str(self.data / "receiver"),
            "--tile-cache-dir", str(self.data / "tiles"),
            "--env-file", str(self.data / ".env"),
            *extra,
        ]
        self.assertEqual(ground_console.main(argv), 0)
        return self.servers[-1]

    def test_base_url_flag_is_checked_against_the_saved_list(self) -> None:
        with self.assertRaises(SystemExit) as refused:
            self.run_main("--base-url", "http://rdf.local:8081")
        message = str(refused.exception)
        self.assertIn("--base-url", message)
        self.assertIn("8081", message)
        for host in DEFAULTS:
            self.assertIn(host, message)
        saved = json.loads((self.data / "console.json").read_text(encoding="utf-8"))
        saved["data_out_hosts"] = ["doasdr.local", "rdf.local"]
        (self.data / "console.json").write_text(json.dumps(saved), encoding="utf-8")
        server = self.run_main("--base-url", "http://rdf.local:8081")
        self.assertEqual(server.get_config()["base_url"], "http://rdf.local:8081")
        self.assertEqual(server.data_out_hosts, ["doasdr.local", "rdf.local"])
        self.assertEqual(json.loads((self.data / "console.json").read_text(encoding="utf-8"))["base_url"], "http://doasdr.local:8081")

    def test_a_first_start_checks_the_flag_against_the_seeded_list(self) -> None:
        (self.data / ".env").write_text("SDR_DOA_SEED_DATA_OUT_HOSTS=rdf.local,doasdr.local\n", encoding="utf-8")
        server = self.run_main("--base-url", "http://rdf.local:8081")
        self.assertEqual(server.get_config()["base_url"], "http://rdf.local:8081")
        self.assertEqual(json.loads((self.data / "console.json").read_text(encoding="utf-8"))["data_out_hosts"], ["rdf.local", "doasdr.local"])


class Console:
    """One console on 127.0.0.1 with temporary state and the legacy UI."""

    def __init__(self, config: Optional[Dict[str, Any]] = None, base_url: str = "http://doasdr.local:8081") -> None:
        self._temporary = tempfile.TemporaryDirectory(prefix="sdr-doa-hosts-http-")
        root = Path(self._temporary.name)
        self.config_path = root / "console.json"
        try:
            with mock.patch("builtins.print"):
                self.server = ground_console.GroundConsoleServer(
                    ("127.0.0.1", 0),
                    base_url,
                    None,
                    str(root / "branding.json"),
                    str(self.config_path),
                    config,
                    frontend_dir=None,
                    receiver_data_dir=root / "receiver",
                    preferences_path=str(root / "preferences.json"),
                    tile_cache_dir=root / "tiles",
                )
        except BaseException:
            self._temporary.cleanup()
            raise
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.thread.join(5)
        self.server.server_close()
        self._temporary.cleanup()

    def request(self, method: str, path: str, payload: Any = None, origin: Optional[str] = "same") -> Tuple[int, Any]:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {"Connection": "close"}
        body = None
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if origin == "same":
            headers["Origin"] = f"http://127.0.0.1:{self.port}"
        elif origin is not None:
            headers["Origin"] = origin
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            raw = response.read()
        finally:
            connection.close()
        try:
            return response.status, json.loads(raw.decode("utf-8"))
        except ValueError:
            return response.status, raw.decode("utf-8", "replace")


class HttpTests(unittest.TestCase):
    def setUp(self) -> None:
        quiet = mock.patch.object(ground_console.ConsoleHandler, "log_message", lambda *args: None)
        quiet.start()
        self.addCleanup(quiet.stop)
        self.console = Console()
        self.addCleanup(self.console.close)

    def config(self) -> Dict[str, Any]:
        status, body = self.console.request("GET", "/api/console-config")
        self.assertEqual(status, 200)
        return body

    def test_the_list_is_saved_through_console_config(self) -> None:
        self.assertEqual(self.config()["data_out_hosts"], DEFAULTS)
        status, body = self.console.request("POST", "/api/console-config", {
            "base_url": "http://rdf.local:8081",
            "data_out_hosts": ["RDF.local.", "doasdr.local", "rdf.local"],
        })
        self.assertEqual(status, 200, body)
        self.assertEqual((body["base_url"], body["data_out_hosts"]), ("http://rdf.local:8081", ["rdf.local", "doasdr.local"]))
        self.assertEqual(self.config(), body)
        saved = json.loads(self.console.config_path.read_text(encoding="utf-8"))
        self.assertEqual(saved["data_out_hosts"], ["rdf.local", "doasdr.local"])
        # A save of another field keeps the list.
        status, body = self.console.request("POST", "/api/console-config", {"refresh_seconds": 5})
        self.assertEqual((status, body["data_out_hosts"]), (200, ["rdf.local", "doasdr.local"]))

    def test_refusals_carry_a_code_the_list_and_the_port(self) -> None:
        before = self.config()
        cases = [
            ({"base_url": "http://rdf.local:8081"}, collector.DATA_OUT_URL_NOT_ALLOWED, DEFAULTS),
            ({"base_url": "http://doasdr.local:8082"}, collector.DATA_OUT_URL_NOT_ALLOWED, DEFAULTS),
            ({"data_out_hosts": ["192.168.100.100"]}, collector.DATA_OUT_HOST_IN_USE, ["192.168.100.100"]),
            ({"data_out_hosts": ["doasdr.local", "*.local"]}, collector.DATA_OUT_HOST_INVALID, []),
            ({"data_out_hosts": ["doasdr.local", "::ffff:c0a8:6464"]}, collector.DATA_OUT_HOST_INVALID, []),
            ({"base_url": "http://[::ffff:c0a8:6464]:8081", "data_out_hosts": ["doasdr.local", "::ffff:c0a8:6464"]}, collector.DATA_OUT_HOST_INVALID, []),
            ({"data_out_hosts": ["doasdr.local", "http://rdf.local:8081"]}, collector.DATA_OUT_HOST_INVALID, []),
            ({"data_out_hosts": []}, collector.DATA_OUT_HOSTS_EMPTY, []),
            ({"data_out_hosts": [f"n{index}.local" for index in range(16)] + ["doasdr.local"]}, collector.DATA_OUT_HOSTS_TOO_MANY, []),
            ({"data_out_hosts": "doasdr.local"}, collector.DATA_OUT_HOST_INVALID, []),
        ]
        for payload, code, hosts in cases:
            with self.subTest(payload=payload):
                status, body = self.console.request("POST", "/api/console-config", payload)
                self.assertEqual(status, 400)
                self.assertEqual(body["code"], code)
                self.assertEqual(body["data_out_hosts"], hosts)
                self.assertEqual(body["port"], 8081)
                self.assertIs(body["ok"], False)
                if code == collector.DATA_OUT_URL_NOT_ALLOWED:
                    self.assertIn("8081", body["error"])
                    for host in DEFAULTS:
                        self.assertIn(host, body["error"])
        self.assertEqual(self.config(), before)

    def test_the_list_has_the_same_origin_gate_as_the_url(self) -> None:
        before = self.config()
        for origin in (None, "http://evil.example", f"http://localhost:{self.console.port + 1}"):
            with self.subTest(origin=origin):
                status, body = self.console.request("POST", "/api/console-config", {"data_out_hosts": ["doasdr.local", "evil.example"]}, origin=origin)
                self.assertEqual((status, body["code"]), (403, "ORIGIN_REJECTED"))
        self.assertEqual(self.config(), before)

    def test_snapshot_uses_the_saved_list_and_the_resolver(self) -> None:
        calls: List[Dict[str, Any]] = []

        def fake_collect(**kwargs: Any) -> Dict[str, Any]:
            calls.append(kwargs)
            return {"collector": {"base_url": kwargs["base_url"]}}

        with mock.patch.object(ground_console, "collect", fake_collect):
            status, body = self.console.request("GET", "/api/snapshot?base_url=http%3A%2F%2Frdf.local%3A8081")
            self.assertEqual((status, body["code"]), (400, collector.DATA_OUT_URL_NOT_ALLOWED))
            self.assertEqual((body["data_out_hosts"], body["port"]), (DEFAULTS, 8081))
            self.assertEqual(calls, [])
            status, _ = self.console.request("POST", "/api/console-config", {"base_url": "http://rdf.local:8081", "data_out_hosts": ["rdf.local"]})
            self.assertEqual(status, 200)
            status, body = self.console.request("GET", "/api/snapshot?base_url=http%3A%2F%2Frdf.local%3A8081")
            self.assertEqual(status, 200, body)
            first_id = body["collection"]["id"]
            # The saved URL is the same node: answered from the shared read.
            status, body = self.console.request("GET", "/api/snapshot")
            self.assertEqual(status, 200, body)
            self.assertEqual((body["collection"]["id"], body["collection"]["shared"]), (first_id, True))
            status, body = self.console.request("GET", "/api/snapshot?base_url=http%3A%2F%2Fdoasdr.local%3A8081")
            self.assertEqual((status, body["code"]), (400, collector.DATA_OUT_URL_NOT_ALLOWED))
        self.assertEqual(len(calls), 1)
        for call in calls:
            self.assertEqual(call["allowed_hosts"], ["rdf.local"])
            self.assertIs(call["mdns_resolver"], self.console.server.mdns_resolver)
        self.assertIsInstance(self.console.server.mdns_resolver, ground_console.MdnsResolver)

    def test_the_legacy_ui_still_serves_and_saves(self) -> None:
        status, page = self.console.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn('value="http://doasdr.local:8081"', page)
        self.assertIn('"data_out_hosts":["doasdr.local","192.168.100.100","127.0.0.1","localhost"]', page)
        # The legacy page posts only these fields; the list stays as saved.
        status, body = self.console.request("POST", "/api/console-config", {"base_url": "http://127.0.0.1:8081", "mqtt_host": "", "mqtt_port": 1883, "refresh_seconds": 0})
        self.assertEqual((status, body["base_url"], body["data_out_hosts"]), (200, "http://127.0.0.1:8081", DEFAULTS))


class ServerTests(unittest.TestCase):
    def test_the_fallback_url_must_be_in_the_list_in_use(self) -> None:
        with mock.patch("builtins.print"):
            with self.assertRaises(collector.DataOutHostError):
                Console(base_url="http://rdf.local:8081")
        console = Console(config={"base_url": "http://rdf.local:8081", "data_out_hosts": ["rdf.local"]}, base_url="http://rdf.local:8081")
        try:
            self.assertEqual(console.server.data_out_hosts, ["rdf.local"])
        finally:
            console.close()


if __name__ == "__main__":
    unittest.main()
