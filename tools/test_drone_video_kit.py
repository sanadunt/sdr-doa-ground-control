#!/usr/bin/env python3
"""Tests for packaging/drone-video: drone-video-supervisor, its unit, the
installer and the uninstaller.

The supervisor is loaded as a module: the mediamtx configuration for every
encoder, the auto encoder choice, the camera host from the console's
/api/drone answer (and against a loopback fake console), the settings file,
and the supervisor loop on a fake clock with a fake Popen (start, a new camera
host, an exit with backoff, the stop). The installer and uninstaller run with
sh against fake systemctl and id in a --root tree; nothing starts mediamtx or
ffmpeg or touches a real systemd unit.
"""

from __future__ import annotations

import http.server
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from typing import Dict, List, Optional

ROOT = Path(__file__).resolve().parent.parent
KIT = ROOT / "packaging/drone-video"
SUPERVISOR = KIT / "drone-video-supervisor"
INSTALL = KIT / "install.sh"
UNINSTALL = KIT / "uninstall.sh"
SCRIPTS = (INSTALL, UNINSTALL)
SH = shutil.which("dash") or shutil.which("sh") or "/bin/sh"
CAMERA = "rtsp://192.168.1.162:8554/main.264"


def load_supervisor():
    """The script as a module, without writing a __pycache__ into packaging/ (it would ship)."""
    module = types.ModuleType("drone_video_supervisor")
    module.__file__ = str(SUPERVISOR)
    sys.modules[module.__name__] = module
    exec(compile(SUPERVISOR.read_text(encoding="utf-8"), str(SUPERVISOR), "exec"), module.__dict__)
    return module


dv = load_supervisor()
LOGS: List[str] = []
dv.log = LOGS.append


def settings(**values: str) -> Dict[str, object]:
    return dv.validate_config(dict(dv.DEFAULTS, **values), environ={})


# ---------------------------------------------------------------------------


class BuildConfigTests(unittest.TestCase):
    def config(self, encoder: str = "x264", camera: Optional[str] = CAMERA, hosts=None) -> dict:
        text = dv.build_config(camera, encoder, "2500k", hosts or [], "ffmpeg")
        return json.loads(text)

    def test_server_settings(self):
        config = self.config(hosts=["192.168.1.10", "gs.local"])
        self.assertEqual(config["logLevel"], "warn")
        self.assertEqual(config["rtspAddress"], "127.0.0.1:8654")
        self.assertEqual(config["rtspTransports"], ["tcp"])
        self.assertIs(config["webrtc"], True)
        self.assertEqual(config["webrtcAddress"], ":8889")
        self.assertEqual(config["webrtcLocalUDPAddress"], ":8189")
        self.assertEqual(config["webrtcAllowOrigins"], ["*"])
        self.assertEqual(config["webrtcAdditionalHosts"], ["192.168.1.10", "gs.local"])
        self.assertIs(config["api"], True)
        self.assertEqual(config["apiAddress"], "127.0.0.1:9997")
        for name in ("hls", "rtmp", "srt", "moq", "metrics", "playback", "pprof"):
            self.assertIs(config[name], False, name)
        self.assertEqual(set(config["paths"]), {"raw", "drone"})
        self.assertEqual(config["paths"]["raw"], {"source": CAMERA, "rtspTransport": "tcp", "sourceOnDemand": False})
        self.assertIs(config["paths"]["drone"]["runOnInitRestart"], True)

    def test_transcode_command_per_encoder(self):
        expected = {
            "videotoolbox": "-c:v h264_videotoolbox -realtime 1 -profile:v baseline",
            "x264": "-c:v libx264 -preset ultrafast -tune zerolatency -profile:v baseline -pix_fmt yuv420p",
            "vaapi": "-vaapi_device /dev/dri/renderD128 -vf format=nv12,hwupload -c:v h264_vaapi "
                     "-profile:v constrained_baseline",
            "nvenc": "-c:v h264_nvenc -preset p1 -tune ll -profile:v baseline",
            "v4l2m2m": "-c:v h264_v4l2m2m -pix_fmt yuv420p",
        }
        for encoder, args in expected.items():
            command = self.config(encoder)["paths"]["drone"]["runOnInit"]
            self.assertEqual(command, "ffmpeg -hide_banner -loglevel error -rtsp_transport tcp -i "
                             f"rtsp://127.0.0.1:8654/raw -an {args} -b:v 2500k -g 30 -bf 0 -f rtsp "
                             "-rtsp_transport tcp rtsp://127.0.0.1:8654/drone", encoder)
        with self.assertRaises(ValueError):
            dv.build_config(CAMERA, "auto", "2500k", [], "ffmpeg")

    def test_ffmpeg_path_and_bitrate(self):
        text = dv.build_config(CAMERA, "x264", "4M", [], "/opt/ff/bin/ffmpeg")
        command = json.loads(text)["paths"]["drone"]["runOnInit"]
        self.assertTrue(command.startswith("/opt/ff/bin/ffmpeg -hide_banner"))
        self.assertIn(" -b:v 4M ", command)

    def test_on_demand_pulls_the_camera_only_while_someone_watches(self):
        # Owner's choice of 2026-11-04: the radio carries the camera only while a page plays it
        # (the remote's own VGCS already takes one of the about two streams the link carries).
        config = json.loads(dv.build_config(CAMERA, "x264", "2500k", [], "ffmpeg", pull="on-demand"))
        self.assertEqual(config["paths"]["raw"], {
            "source": CAMERA, "rtspTransport": "tcp", "sourceOnDemand": True,
            "sourceOnDemandStartTimeout": "10s", "sourceOnDemandCloseAfter": "10s",
        })
        drone = config["paths"]["drone"]
        self.assertNotIn("runOnInit", drone)
        self.assertTrue(drone["runOnDemand"].startswith("ffmpeg -hide_banner"))
        self.assertEqual((drone["runOnDemandRestart"], drone["runOnDemandStartTimeout"], drone["runOnDemandCloseAfter"]),
                         (True, "20s", "10s"))
        with self.assertRaises(ValueError):
            dv.build_config(CAMERA, "x264", "2500k", [], "ffmpeg", pull="sometimes")

    def test_pull_setting(self):
        self.assertEqual(settings()["pull"], "on-demand")
        self.assertEqual(settings(PULL="always")["pull"], "always")
        with self.assertRaises(dv.ConfigError):
            settings(PULL="sometimes")

    def test_unknown_camera_leaves_raw_a_publisher_path(self):
        config = self.config(camera=None)
        self.assertEqual(config["paths"]["raw"], {})
        self.assertIn("runOnInit", config["paths"]["drone"])


class EncoderTests(unittest.TestCase):
    def test_pick_encoder(self):
        everything = {"h264_videotoolbox", "h264_vaapi", "libx264", "h264_nvenc"}
        cases = [
            (("auto", False, everything, "darwin"), "videotoolbox"),
            (("auto", False, {"libx264"}, "darwin"), "x264"),
            (("auto", True, everything, "linux"), "vaapi"),
            (("auto", True, {"libx264"}, "linux"), "x264"),
            (("auto", False, everything, "linux"), "x264"),
            (("auto", True, set(), "linux"), "x264"),
            (("nvenc", False, set(), "linux"), "nvenc"),
            (("vaapi", False, set(), "linux"), "vaapi"),
            (("v4l2m2m", False, set(), "darwin"), "v4l2m2m"),
        ]
        for args, expected in cases:
            self.assertEqual(dv.pick_encoder(*args), expected, args)

    def test_ffmpeg_encoders_parses_the_list(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        fake = Path(tmp.name) / "ffmpeg"
        fake.write_text("#!/bin/sh\ncat <<'EOF'\nEncoders:\n V..... = Video\n A..... = Audio\n ------\n"
                        " V....D libx264              libx264 H.264 / AVC\n"
                        " V....D h264_vaapi           H.264/AVC (VAAPI) (codec h264)\n"
                        " A....D aac                  AAC (Advanced Audio Coding)\nEOF\n", encoding="utf-8")
        fake.chmod(0o755)
        self.assertEqual(dv.ffmpeg_encoders(str(fake)), {"libx264", "h264_vaapi", "aac"})
        self.assertEqual(dv.ffmpeg_encoders(str(Path(tmp.name) / "missing")), set())


class ConsoleTests(unittest.TestCase):
    def test_camera_url_from_console(self):
        self.assertEqual(dv.camera_url_from_console({"host": "192.168.1.162"}), CAMERA)
        self.assertEqual(dv.camera_url_from_console({"drone": {"host": "10.0.0.7"}}),
                         "rtsp://10.0.0.7:8554/main.264")
        self.assertEqual(dv.camera_url_from_console({"host": "fd00::7"}), "rtsp://[fd00::7]:8554/main.264")
        for body in ({"host": "drone.local"}, {"host": None}, {}, {"host": 5}, {"host": "0.0.0.0"},
                     {"host": "fe80::1%eth0"}, {"host": "224.0.0.1"}, None, [], "192.168.1.1"):
            self.assertIsNone(dv.camera_url_from_console(body), body)

    def test_fetch_console_drone_against_a_loopback_server(self):
        answers: Dict[str, object] = {"status": 200, "body": b'{"host": "192.168.1.162", "port": 1883}'}
        seen: List[str] = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                seen.append(self.path)
                body = answers["body"]
                self.send_response(answers["status"])  # type: ignore[arg-type]
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))  # type: ignore[arg-type]
                self.end_headers()
                self.wfile.write(body)  # type: ignore[arg-type]

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        url = f"http://127.0.0.1:{server.server_address[1]}"
        # A proxy in the environment must not take the request.
        previous = {name: os.environ.get(name) for name in ("http_proxy", "HTTP_PROXY", "no_proxy", "NO_PROXY")}
        os.environ["http_proxy"] = os.environ["HTTP_PROXY"] = "http://127.0.0.1:9"
        os.environ.pop("no_proxy", None)
        os.environ.pop("NO_PROXY", None)
        try:
            self.assertEqual(dv.fetch_console_drone(url + "/"), {"host": "192.168.1.162", "port": 1883})
            self.assertEqual(seen, ["/api/drone"])
            answers["body"] = b"[1, 2]"
            self.assertIsNone(dv.fetch_console_drone(url))
            answers["body"] = b"not json"
            self.assertIsNone(dv.fetch_console_drone(url))
            answers["body"] = b'{"host": "' + b"x" * (70 * 1024) + b'"}'
            self.assertIsNone(dv.fetch_console_drone(url), "bodies over 64 KiB are refused")
            answers["status"] = 503
            answers["body"] = b'{"host": "192.168.1.162"}'
            self.assertIsNone(dv.fetch_console_drone(url))
        finally:
            for name, value in previous.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value
        server.shutdown()
        self.assertIsNone(dv.fetch_console_drone(url, timeout=0.5), "a console that is gone")


class ConfigTests(unittest.TestCase):
    def test_defaults(self):
        values = dv.validate_config(dv.read_config_text(""), environ={})
        self.assertEqual(values, {
            "camera_url": None, "console_url": "http://127.0.0.1:8787", "encoder": "auto", "bitrate": "2500k", "pull": "on-demand",
            "additional_hosts": [], "mediamtx_bin": "mediamtx", "ffmpeg_bin": "ffmpeg",
            "runtime_dir": "/run/drone-video",
        })
        self.assertEqual(dv.validate_config(dict(dv.DEFAULTS), environ={"RUNTIME_DIRECTORY": "/run/x"})["runtime_dir"],
                         "/run/x")
        self.assertEqual(settings(RUNTIME_DIR="/tmp/dv")["runtime_dir"], "/tmp/dv")

    def test_values(self):
        text = ("# comment\n\nCAMERA_URL='rtsp://user:pw@10.0.0.7:8554/main.264'\nCONSOLE_URL=http://127.0.0.1:9000/\n"
                "ENCODER=vaapi\nBITRATE=3M\nWEBRTC_ADDITIONAL_HOSTS=192.168.1.10, gs.local ,192.168.1.10\n"
                "MEDIAMTX_BIN=/opt/mediamtx/mediamtx\nFFMPEG_BIN=/usr/bin/ffmpeg\n")
        values = dv.validate_config(dv.read_config_text(text), environ={})
        self.assertEqual(values["camera_url"], "rtsp://user:pw@10.0.0.7:8554/main.264")
        self.assertEqual(values["console_url"], "http://127.0.0.1:9000")
        self.assertEqual(values["encoder"], "vaapi")
        self.assertEqual(values["bitrate"], "3M")
        self.assertEqual(values["additional_hosts"], ["192.168.1.10", "gs.local"])
        self.assertEqual(values["mediamtx_bin"], "/opt/mediamtx/mediamtx")
        self.assertEqual(dv.redact(values["camera_url"]), "rtsp://***@10.0.0.7:8554/main.264")

    def test_refusals(self):
        bad = [
            ("CAMERA_URL", "http://10.0.0.7/x"), ("CAMERA_URL", "rtsp://"), ("CAMERA_URL", "rtsp://a b/x"),
            ("CONSOLE_URL", "https://127.0.0.1:8787"), ("CONSOLE_URL", "http://127.0.0.1:8787/api"),
            ("CONSOLE_URL", "127.0.0.1:8787"), ("ENCODER", "hevc"), ("BITRATE", "2500"), ("BITRATE", "0k"),
            ("BITRATE", "2.5M"), ("WEBRTC_ADDITIONAL_HOSTS", "a b"), ("WEBRTC_ADDITIONAL_HOSTS", "-x"),
            ("MEDIAMTX_BIN", "media mtx"), ("FFMPEG_BIN", "ffmpeg;rm"), ("FFMPEG_BIN", ""),
            ("RUNTIME_DIR", "run/x"),
        ]
        for name, value in bad:
            with self.assertRaises(dv.ConfigError, msg=f"{name}={value}"):
                settings(**{name: value})
        with self.assertRaisesRegex(dv.ConfigError, "unknown setting CAMERA"):
            dv.read_config_text("CAMERA=auto\n")
        with self.assertRaisesRegex(dv.ConfigError, "expected NAME=VALUE"):
            dv.read_config_text("ENCODER\n")

    def run_command(self, *args: str, config_text: Optional[str] = None,
                    env: Optional[Dict[str, str]] = None) -> subprocess.CompletedProcess:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        environment = {"PATH": os.environ.get("PATH", ""), "RUNTIME_DIRECTORY": ""}
        if config_text is not None:
            path = Path(tmp.name) / "drone-video.conf"
            path.write_text(config_text, encoding="utf-8")
            environment["DRONE_VIDEO_CONFIG"] = str(path)
        environment.update(env or {})
        return subprocess.run([sys.executable, "-I", "-B", str(SUPERVISOR), *args], capture_output=True, text=True,
                              env=environment, timeout=30)

    def test_check_config_command_and_exit_78(self):
        result = self.run_command("check-config", config_text="ENCODER=x264\nCAMERA_URL=rtsp://u:p@10.0.0.7/a\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("ENCODER=x264\n", result.stdout)
        self.assertIn("CAMERA_URL=rtsp://***@10.0.0.7/a\n", result.stdout)
        self.assertIn("RUNTIME_DIR=/run/drone-video\n", result.stdout)
        result = self.run_command("check-config", config_text="ENCODER=hevc\n")
        self.assertEqual(result.returncode, 78)
        self.assertIn("ENCODER must be one of", result.stderr)
        result = self.run_command("check-config", config_text="NAME=x\n")
        self.assertEqual(result.returncode, 78)
        self.assertIn("unknown setting NAME", result.stderr)
        result = self.run_command("check-config", "--config", "/nonexistent/drone-video.conf")
        self.assertEqual(result.returncode, 78)
        self.assertIn("does not exist", result.stderr)

    def test_print_config_command(self):
        result = self.run_command("print-config", config_text=f"ENCODER=nvenc\nCAMERA_URL={CAMERA}\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        config = json.loads(result.stdout)
        self.assertEqual(config["paths"]["raw"]["source"], CAMERA)
        # PULL defaults to on-demand.
        self.assertIn("-c:v h264_nvenc", config["paths"]["drone"]["runOnDemand"])
        self.assertIs(config["paths"]["raw"]["sourceOnDemand"], True)


# ---------------------------------------------------------------------------


class Clock:
    def __init__(self, start: float = 100.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now


class FakeChild:
    def __init__(self, args: List[str], stubborn: bool = False) -> None:
        self.args = args
        self.pid = 4000 + len(args)
        self.code: Optional[int] = None
        self.stubborn = stubborn
        self.signals: List[str] = []

    def poll(self) -> Optional[int]:
        return self.code

    def terminate(self) -> None:
        self.signals.append("TERM")
        if not self.stubborn:
            self.code = -15

    def kill(self) -> None:
        self.signals.append("KILL")
        self.code = -9

    def wait(self, timeout: Optional[float] = None) -> int:
        if self.code is None:
            raise subprocess.TimeoutExpired(self.args, timeout or 0)
        return self.code


class SupervisorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.clock = Clock()
        self.children: List[FakeChild] = []
        self.answers: List[Optional[dict]] = []
        self.fetched: List[str] = []
        self.logs: List[str] = []
        self.stubborn = False

    def popen(self, args: List[str]) -> FakeChild:
        child = FakeChild(args, stubborn=self.stubborn)
        self.children.append(child)
        return child

    def fetch(self, url: str) -> Optional[dict]:
        self.fetched.append(url)
        return self.answers[-1] if self.answers else None

    def supervisor(self, **values: str):
        values.setdefault("RUNTIME_DIR", self.tmp.name)
        values.setdefault("ENCODER", "x264")
        return dv.Supervisor(settings(**values), monotonic=self.clock, popen=self.popen, fetch=self.fetch,
                             encoders=set(), has_render_node=False, platform="linux", logger=self.logs.append)

    def written(self) -> dict:
        return json.loads((Path(self.tmp.name) / "mediamtx.yml").read_text(encoding="utf-8"))

    def test_fixed_camera_starts_mediamtx_once_with_the_config(self):
        supervisor = self.supervisor(CAMERA_URL=CAMERA)
        for _ in range(5):
            supervisor.step()
            self.clock.now += 1
        self.assertEqual(len(self.children), 1)
        path = str(Path(self.tmp.name) / "mediamtx.yml")
        self.assertEqual(self.children[0].args, ["mediamtx", path])
        self.assertEqual(self.written()["paths"]["raw"]["source"], CAMERA)
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.assertEqual(self.fetched, [], "a fixed camera never asks the console")
        self.assertEqual([name for name in os.listdir(self.tmp.name)], ["mediamtx.yml"], "no temporary file left")

    def test_auto_follows_the_console_host(self):
        supervisor = self.supervisor()
        supervisor.step()
        self.assertEqual(len(self.children), 1, "started without a camera")
        self.assertEqual(self.written()["paths"]["raw"], {})
        self.assertIn("console http://127.0.0.1:8787: no answer from /api/drone", self.logs)
        self.answers.append({"host": "192.168.1.162"})
        self.clock.now += 1
        supervisor.step()
        self.assertEqual(len(self.children), 1, "the console is asked every 5 s only")
        self.clock.now += 4
        supervisor.step()
        self.assertEqual(len(self.children), 2, "a new camera restarts mediamtx")
        self.assertEqual(self.children[0].signals, ["TERM"])
        self.assertEqual(self.written()["paths"]["raw"]["source"], CAMERA)
        self.assertEqual(self.fetched, ["http://127.0.0.1:8787"] * 2)
        # The same host, or a console that does not know it for a while, changes nothing.
        for answer in ({"host": "192.168.1.162"}, {"host": None}, None):
            self.answers.append(answer)
            self.clock.now += 5
            supervisor.step()
        self.assertEqual(len(self.children), 2)
        self.answers.append({"host": "192.168.1.163"})
        self.clock.now += 5
        supervisor.step()
        self.assertEqual(len(self.children), 3)
        self.assertEqual(self.written()["paths"]["raw"]["source"], "rtsp://192.168.1.163:8554/main.264")
        self.assertIn("camera rtsp://192.168.1.162:8554/main.264 -> rtsp://192.168.1.163:8554/main.264", self.logs)

    def test_exit_restarts_with_backoff(self):
        supervisor = self.supervisor(CAMERA_URL=CAMERA)
        starts: List[float] = []
        for _ in range(220):
            count = len(self.children)
            supervisor.step()
            if len(self.children) > count:
                starts.append(self.clock.now - 100.0)
                self.children[-1].code = 1  # exits at once, seen by the next step half a second later
            self.clock.now += 0.5
        gaps = [b - a for a, b in zip(starts, starts[1:])]
        self.assertEqual(gaps[:6], [2.5, 4.5, 8.5, 16.5, 30.5, 30.5], "2 s doubling to 30 s after the exit")
        self.assertIn("mediamtx exited with 1; again in 2 s", self.logs)
        self.assertIn("mediamtx exited with 1; again in 30 s", self.logs)
        # A child that ran for 60 s resets the backoff.
        while True:
            count = len(self.children)
            supervisor.step()
            if len(self.children) > count:
                break
            self.clock.now += 0.5
        self.clock.now += 61
        supervisor.step()
        self.children[-1].code = 1
        count = len(self.children)
        supervisor.step()
        self.clock.now += 2
        supervisor.step()
        self.assertEqual(len(self.children), count + 1)

    def test_missing_mediamtx_backs_off(self):
        def missing(args):
            raise FileNotFoundError(2, "No such file or directory", args[0])

        supervisor = self.supervisor(CAMERA_URL=CAMERA)
        supervisor.popen = missing
        supervisor.step()
        self.assertIsNone(supervisor.child)
        self.assertTrue(any(line.startswith("cannot start mediamtx") for line in self.logs))
        self.clock.now += 1
        supervisor.step()
        self.assertEqual(supervisor.starts, 1)
        self.clock.now += 1
        supervisor.step()
        self.assertEqual(supervisor.starts, 2)

    def test_stop_terminates_then_kills(self):
        supervisor = self.supervisor(CAMERA_URL=CAMERA)
        supervisor.step()
        flags = iter([False, False, True])
        supervisor.run(lambda: next(flags), sleep=lambda seconds: None)
        self.assertEqual(self.children[0].signals, ["TERM"])
        self.assertIsNone(supervisor.child)
        self.stubborn = True
        supervisor.step()
        self.assertEqual(supervisor.stop_child(), -9)
        self.assertEqual(self.children[1].signals, ["TERM", "KILL"])

    def test_auto_encoder_at_start(self):
        supervisor = dv.Supervisor(settings(RUNTIME_DIR=self.tmp.name), monotonic=self.clock, popen=self.popen,
                                   fetch=self.fetch, encoders={"h264_vaapi", "libx264"}, has_render_node=True,
                                   platform="linux", logger=self.logs.append)
        self.assertEqual(supervisor.encoder, "vaapi")
        self.assertTrue(self.logs[0].startswith("encoder vaapi (auto)"), self.logs)

    def test_sigterm_ends_the_process_and_its_child(self):
        tmp = Path(self.tmp.name)
        child = tmp / "fake-mediamtx"
        child.write_text("#!/bin/sh\ntrap 'echo stopped > \"$(dirname \"$1\")/child.txt\"; exit 0' TERM\n"
                         "echo started > \"$(dirname \"$1\")/child.txt\"\nwhile :; do sleep 0.1; done\n",
                         encoding="utf-8")
        child.chmod(0o755)
        conf = tmp / "drone-video.conf"
        conf.write_text(f"CAMERA_URL={CAMERA}\nENCODER=x264\nMEDIAMTX_BIN={child}\nRUNTIME_DIR={tmp}/run\n",
                        encoding="utf-8")
        process = subprocess.Popen([sys.executable, "-I", "-B", str(SUPERVISOR), "run", "--config", str(conf)],
                                   stderr=subprocess.PIPE, text=True)
        marker = tmp / "run" / "child.txt"
        for _ in range(100):
            if marker.exists() and marker.read_text().strip() == "started":
                break
            threading.Event().wait(0.05)
        self.assertEqual(marker.read_text().strip(), "started")
        process.terminate()
        _, stderr = process.communicate(timeout=15)
        self.assertEqual(process.returncode, 0, stderr)
        self.assertEqual(marker.read_text().strip(), "stopped")
        self.assertIn("mediamtx started", stderr)
        self.assertIn("stopped", stderr.splitlines()[-1])


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
        self._tmp = tempfile.TemporaryDirectory(prefix="test-drone-video-")
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

    def add_programs(self) -> None:
        for name in ("mediamtx", "ffmpeg"):
            program = self.fakebin / name
            program.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            program.chmod(0o755)

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
            "DRONE_VIDEO_ROOT_UID": str(os.geteuid()),
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
        self.h.add_programs()
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("was not found", result.stderr)
        self.assertEqual(self.files(), {
            "usr/local/bin/drone-video-supervisor",
            "usr/local/share/drone-video/README.md",
            "usr/local/share/drone-video/uninstall.sh",
            "usr/local/share/drone-video/drone-video.conf.example",
            "usr/local/share/drone-video/install-info",
            "etc/drone-video/drone-video.conf",
            "etc/systemd/system/drone-video.service",
        })
        for name in ("usr/local/bin/drone-video-supervisor", "usr/local/share/drone-video/uninstall.sh"):
            self.assertEqual(stat.S_IMODE((self.root / name).stat().st_mode), 0o755, name)
        for name in ("etc/drone-video/drone-video.conf", "etc/systemd/system/drone-video.service",
                     "usr/local/share/drone-video/install-info"):
            self.assertEqual(stat.S_IMODE((self.root / name).stat().st_mode), 0o644, name)
        self.assertEqual(self.read("etc/drone-video/drone-video.conf"),
                         (KIT / "drone-video.conf.example").read_text(encoding="utf-8"))
        service = self.read("etc/systemd/system/drone-video.service")
        python = str(self.h.realbin / "python3")
        self.assertIn(f"ExecStart={python} -I /usr/local/bin/drone-video-supervisor run --config "
                      "/etc/drone-video/drone-video.conf\n", service)
        for line in ("Type=simple", "DynamicUser=yes", "SupplementaryGroups=render video",
                     "RuntimeDirectory=drone-video", "Restart=always", "RestartSec=3", "RestartPreventExitStatus=78",
                     "NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=yes", "PrivateTmp=yes",
                     "WantedBy=multi-user.target", "Documentation=file:///usr/local/share/drone-video/README.md"):
            self.assertIn(line + "\n", service)
        self.assertNotIn("DevicePolicy=", service, "VAAPI needs /dev/dri")
        self.assertNotIn("User=root", service)
        self.assertIn("UDP 8189", service)
        self.assertIn("TCP 8889", service)
        self.assertNotRegex(service, r"@[A-Z_]+@")
        self.assertIn("packaging/drone-video", service)
        info = self.read("usr/local/share/drone-video/install-info")
        for line in ("PREFIX=/usr/local\n", "CONFIG_DIR=/etc/drone-video\n", "UNIT_DIR=/etc/systemd/system\n"):
            self.assertIn(line, info)
        for line in ("skipped (--root): systemctl daemon-reload", "skipped (--root): systemctl enable drone-video.service",
                     "skipped (--root): systemctl restart drone-video.service", "Camera:  auto    Encoder: auto"):
            self.assertIn(line, result.stdout)
        self.assertEqual(self.h.actions(), [])

    def test_warns_when_mediamtx_or_ffmpeg_is_missing(self):
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("warning: MEDIAMTX_BIN mediamtx was not found", result.stderr)
        self.assertIn("github.com/bluenviron/mediamtx/releases", result.stderr)
        self.assertIn("warning: FFMPEG_BIN ffmpeg was not found", result.stderr)
        self.assertIn("sudo apt install ffmpeg", result.stderr)

    def test_installer_downloads_nothing_and_touches_no_firewall(self):
        text = INSTALL.read_text(encoding="utf-8") + UNINSTALL.read_text(encoding="utf-8")
        # "curl -s http://127.0.0.1:9997/..." is only printed as a check for the operator.
        for forbidden in ("curl -L", "curl -o", "curl -O", "curl -f", "wget", "| sh", "ufw", "iptables", "nft ",
                          "firewall-cmd", "/etc/udev", "udevadm", "usermod", "useradd", "apt-get", "apt install -y"):
            self.assertFalse(forbidden in text, forbidden)

    def test_rerun_keeps_the_config_and_a_bad_one_stops(self):
        self.assertEqual(self.install().returncode, 0)
        config_path = self.root / "etc/drone-video/drone-video.conf"
        config_path.write_text("ENCODER=x264\n", encoding="utf-8")
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Keeping /etc/drone-video/drone-video.conf", result.stdout)
        self.assertIn("Encoder: x264", result.stdout)
        self.assertEqual(config_path.read_text(encoding="utf-8"), "ENCODER=x264\n")
        config_path.write_text("ENCODER=x264\nCAMERA=x\n", encoding="utf-8")
        result = self.install()
        self.assertEqual(result.returncode, 1)
        self.assertIn("unknown setting CAMERA", result.stderr)

    def test_refuses_to_replace_a_foreign_file(self):
        foreign = self.root / "etc/systemd/system/drone-video.service"
        foreign.parent.mkdir(parents=True)
        foreign.write_text("[Service]\nExecStart=/opt/other\n", encoding="utf-8")
        result = self.install()
        self.assertEqual(result.returncode, 1)
        self.assertIn("was not written by this installer", result.stderr)
        self.assertEqual(foreign.read_text(encoding="utf-8"), "[Service]\nExecStart=/opt/other\n")
        self.assertFalse((self.root / "usr/local/bin/drone-video-supervisor").exists())

    def test_refuses_a_prefix_others_can_change(self):
        opt = self.root / "opt"
        opt.mkdir(mode=0o755)
        opt.chmod(0o775)
        result = self.install("--prefix", "/opt/video")
        self.assertEqual(result.returncode, 1)
        self.assertIn(f"{opt} is not owned by root or is writable by another user", result.stderr)
        self.assertFalse((opt / "video").exists(), "refused before anything was written")
        opt.chmod(0o755)
        result = self.install("--prefix", "/opt/video")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("/opt/video/bin/drone-video-supervisor run", self.read("etc/systemd/system/drone-video.service"))
        if os.geteuid() != 0:
            result = self.install("--prefix", "/opt/video", DRONE_VIDEO_ROOT_UID="0")
            self.assertEqual(result.returncode, 1)
            self.assertIn("is not owned by root or is writable by another user", result.stderr)

    def test_dry_run_changes_nothing_and_shows_refusals(self):
        result = self.install("--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.files(), set())
        self.assertIn("would run: systemctl enable drone-video.service", result.stdout)
        self.assertIn("would run: systemctl restart drone-video.service", result.stdout)
        self.assertIn("--- /etc/systemd/system/drone-video.service", result.stdout)
        self.assertIn("Dry run: nothing was changed.", result.stdout)
        foreign = self.root / "usr/local/bin/drone-video-supervisor"
        foreign.parent.mkdir(parents=True)
        foreign.write_text("#!/bin/sh\n", encoding="utf-8")
        result = self.install("--dry-run")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn(f"the install would stop here: {foreign} exists and was not written by this installer",
                      result.stderr)
        self.assertIn("The install would stop: see the warnings.", result.stdout)
        self.assertEqual(self.files(), {"usr/local/bin/drone-video-supervisor"})
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
        foreign = self.root / "usr/local/bin/drone-video-supervisor"
        foreign.write_text("#!/bin/sh\necho mine\n", encoding="utf-8")
        script = self.root / "usr/local/share/drone-video/uninstall.sh"
        result = self.h.run(script, "--root", str(self.root))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("kept /usr/local/bin/drone-video-supervisor: not written by the drone-video installer",
                      result.stdout)
        self.assertEqual(self.files(), {"etc/drone-video/drone-video.conf", "usr/local/bin/drone-video-supervisor"})
        foreign.unlink()
        self.assertEqual(self.install().returncode, 0)
        result = self.h.run(script, "--root", str(self.root), "--purge")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.files(), set())
        self.assertEqual(self.h.actions(), [])

    def test_uninstall_dry_run(self):
        self.assertEqual(self.install().returncode, 0)
        before = self.files()
        script = self.root / "usr/local/share/drone-video/uninstall.sh"
        result = self.h.run(script, "--root", str(self.root), "--dry-run", "--purge")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("would run: systemctl disable --now drone-video.service", result.stdout)
        self.assertIn("would remove /etc/systemd/system/drone-video.service", result.stdout)
        self.assertIn("would remove /etc/drone-video/drone-video.conf", result.stdout)
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
        self.assertTrue(os.access(SUPERVISOR, os.X_OK))
        self.assertTrue(SUPERVISOR.read_text(encoding="utf-8").startswith("#!/usr/bin/env python3\n"))

    def test_supervisor_uses_the_standard_library_only(self):
        source = f"exec(compile(open({str(SUPERVISOR)!r}).read(), 'p', 'exec'), {{'__name__': 'p'}})"
        result = subprocess.run([sys.executable, "-I", "-S", "-B", "-c", source],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_python_39_syntax(self):
        import ast
        tree = ast.parse(SUPERVISOR.read_text(encoding="utf-8"), feature_version=(3, 9))
        self.assertFalse([node for node in ast.walk(tree) if type(node).__name__ == "Match"])

    def test_shellcheck(self):
        shellcheck = os.environ.get("SHELLCHECK") or shutil.which("shellcheck")
        if not shellcheck:
            self.skipTest("shellcheck is not installed")
        result = subprocess.run([shellcheck, "-s", "sh", *map(str, SCRIPTS)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
