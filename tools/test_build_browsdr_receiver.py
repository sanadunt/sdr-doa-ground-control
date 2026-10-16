#!/usr/bin/env python3
"""Regression tests for the pinned BrowSDR build boundary."""

from __future__ import annotations

import io
import re
import shutil
import subprocess
import tempfile
import unittest
from contextlib import ExitStack, redirect_stderr
from pathlib import Path
from unittest import mock

from tools import build_browsdr_receiver as builder


class ReceiverBuildSourceTests(unittest.TestCase):
    def test_pinned_source_requires_exact_clean_git_checkout(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source"
            source.mkdir()
            with self.assertRaisesRegex(RuntimeError, "Git checkout"):
                builder._assert_pinned_source(source)

            subprocess.run(["git", "-C", str(source), "init", "--quiet"], check=True)
            (source / "README.md").write_text("pinned test source\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(source), "add", "README.md"], check=True)
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(source),
                    "-c",
                    "user.name=Receiver build test",
                    "-c",
                    "user.email=receiver-build-test@example.invalid",
                    "commit",
                    "--quiet",
                    "-m",
                    "initial source",
                ],
                check=True,
            )
            revision = subprocess.run(
                ["git", "-C", str(source), "rev-parse", "HEAD"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()

            with mock.patch.object(builder, "BROWSDR_REVISION", revision):
                builder._assert_pinned_source(source)
            with mock.patch.object(builder, "BROWSDR_REVISION", "0" * 40):
                with self.assertRaisesRegex(RuntimeError, "expected pinned commit"):
                    builder._assert_pinned_source(source)

            (source / "README.md").write_text("modified source\n", encoding="utf-8")
            with mock.patch.object(builder, "BROWSDR_REVISION", revision):
                with self.assertRaisesRegex(RuntimeError, "local changes"):
                    builder._assert_pinned_source(source)


    def test_embedded_build_rejects_unscoped_receiver_assets(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            build = Path(temporary)
            assets = build / "assets"
            assets.mkdir()
            (build / "index.html").write_text(
                '<script type="module" src="/receiver/assets/index.js"></script>',
                encoding="utf-8",
            )
            (build / "manifest.webmanifest").write_text(
                '{"start_url":"/receiver/","scope":"/receiver/"}',
                encoding="utf-8",
            )
            wasm = build / "hackrf-web/pkg"
            wasm.mkdir(parents=True)
            (wasm / "hackrf_web.js").write_text("export {};", encoding="utf-8")
            (wasm / "hackrf_web_bg.wasm").write_bytes(b"wasm")
            bundle = assets / "index.js"

            for asset_url in (
                "/30-seconds-of-silence.mp3",
                "/icon-96.png",
                "/icon-192.png",
                "/icon-512.png",
            ):
                with self.subTest(asset_url=asset_url):
                    bundle.write_text(f"const asset = {asset_url!r};", encoding="utf-8")
                    with self.assertRaisesRegex(RuntimeError, "root-scoped asset path"):
                        builder._verify_embedded_build(build)

    def _valid_build(self, root: Path) -> Path:
        build = root / "build"
        (build / "assets").mkdir(parents=True)
        (build / "index.html").write_text(
            '<script src="/receiver/receiver-boot.js"></script>'
            '<script type="module" src="/receiver/assets/index.js"></script>',
            encoding="utf-8",
        )
        (build / "receiver-boot.js").write_text("// boot", encoding="utf-8")
        (build / "manifest.webmanifest").write_text('{"start_url":"/receiver/","scope":"/receiver/"}', encoding="utf-8")
        wasm = build / "hackrf-web/pkg"
        wasm.mkdir(parents=True)
        (wasm / "hackrf_web.js").write_text("export {};", encoding="utf-8")
        (wasm / "hackrf_web_bg.wasm").write_bytes(b"wasm")
        (build / "assets/index.js").write_text(
            f"export const receiver = true; const channel = {builder.CONSOLE_BRIDGE_CHANNEL!r};",
            encoding="utf-8",
        )
        (build / "sw.js").write_text("self.workbox; registerRoute(/api/, new NetworkFirst({cacheName:'api-cache'}))", encoding="utf-8")
        (build / "workbox-1234.js").write_text("workbox runtime", encoding="utf-8")
        return build

    def test_service_worker_is_retired_and_verified(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            build = self._valid_build(Path(temporary))
            with self.assertRaisesRegex(RuntimeError, "self-removing service worker"):
                builder._verify_embedded_build(build)
            builder._retire_service_worker(build)
            builder._verify_embedded_build(build)
            service_worker = (build / "sw.js").read_text(encoding="utf-8")
            self.assertIn("registration.unregister()", service_worker)
            self.assertNotIn("registerRoute", service_worker)
            self.assertEqual(list(build.glob("workbox-*.js")), [])

    def test_embedded_build_rejects_remote_fonts_sw_registration_and_missing_boot_script(self) -> None:
        cases = {
            "remote fonts": ('<link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet">', None),
            "registers a caching service worker": ('<script id="vite-plugin-pwa:register-sw" src="/receiver/registerSW.js"></script>', None),
            "theme boot script": (None, "remove-boot"),
        }
        for message, (extra_html, action) in cases.items():
            with self.subTest(message=message), tempfile.TemporaryDirectory() as temporary:
                build = self._valid_build(Path(temporary))
                builder._retire_service_worker(build)
                index = build / "index.html"
                if extra_html:
                    index.write_text(index.read_text(encoding="utf-8") + extra_html, encoding="utf-8")
                if action == "remove-boot":
                    (build / "receiver-boot.js").unlink()
                with self.assertRaisesRegex(RuntimeError, message):
                    builder._verify_embedded_build(build)

    def test_embedded_build_requires_the_console_bridge(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            build = self._valid_build(Path(temporary))
            builder._retire_service_worker(build)
            builder._verify_embedded_build(build)
            (build / "assets/index.js").write_text("export const receiver = true;", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "console dashboard bridge"):
                builder._verify_embedded_build(build)

    def test_bridge_channel_matches_the_overlay_protocol(self) -> None:
        protocol = (
            builder.PROJECT_ROOT / "tools/browsdr_receiver_overlay/src/client/app/console-bridge-protocol.ts"
        ).read_text(encoding="utf-8")
        match = re.search(r"export const BRIDGE_CHANNEL = '([^']+)';", protocol)
        self.assertIsNotNone(match)
        self.assertEqual(match.group(1), builder.CONSOLE_BRIDGE_CHANNEL)

    @unittest.skipUnless(
        (builder.PROJECT_ROOT / "vendor/BrowSDR/package.json").is_file(),
        "vendor/BrowSDR submodule is not checked out",
    )
    def test_overlay_and_embedded_patches_apply_to_the_pinned_source(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary) / "source"
            shutil.copytree(builder.PROJECT_ROOT / "vendor/BrowSDR", work, ignore=builder._copy_ignore)
            builder._apply_receiver_source_overlay(work, builder.PROJECT_ROOT / "tools/browsdr_receiver_overlay")
            builder._apply_embedded_changes(work)
            html = (work / "src/client/index.html").read_text(encoding="utf-8")
            vite = (work / "vite.config.ts").read_text(encoding="utf-8")
            self.assertIn('<script src="/receiver/receiver-boot.js"></script>', html)
            self.assertIn(
                '<div class="brand" v-show="activeWorkspace === \'listener\'">{{ t(\'Freq. Spectrum\') }}</div>',
                html,
            )
            self.assertNotIn(">BrowSDR</div>", html)
            self.assertNotIn("fonts.googleapis.com", html)
            self.assertIn("injectRegister: false", vite)
            self.assertNotIn("api-cache", vite)
            self.assertTrue((work / "public/receiver-boot.js").is_file())
            self.assertFalse((work / "public/lib/peerjs.min.js").exists())
            hackrf = (work / "src/client/hackrf.ts").read_text(encoding="utf-8")
            self.assertIn("async startRx(callback: RxCallback, onError?: (error: unknown) => void)", hackrf)
            self.assertEqual(hackrf.count("onError?.("), 4)
            app = work / "src/client/app"
            self.assertTrue((app / "console-bridge.ts").is_file())
            self.assertTrue((app / "console-bridge-protocol.ts").is_file())
            self.assertIn("installConsoleBridge(this)", (app / "main.ts").read_text(encoding="utf-8"))
            connection = (app / "connection.ts").read_text(encoding="utf-8")
            self.assertIn("this._consoleBridge?.spectrum(spectrumData)", connection)
            self.assertIn("this._consoleBridge?.initialVfoEnabled() ?? true", connection)
            # The Dengar tab's dB scale drives the Listener trace and waterfall.
            self.assertIn("this.updateListenerAutoRange(spectrumData);", connection)
            self.assertIn("...listenerDisplayMethods,", (app / "main.ts").read_text(encoding="utf-8"))
            canvas = (app / "canvas.ts").read_text(encoding="utf-8")
            self.assertNotIn("this.display.minDB", canvas)
            self.assertNotIn("this.display.maxDB", canvas)
            self.assertIn("const displayRange = this.listenerDbRange();", canvas)
            self.assertIn("this.syncListenerEngineRange(true);", canvas)
            # The spectrum markers are drawn on the Listener trace after the VFO highlights.
            draw_markers = canvas.index("this.drawListenerMarkers(ctx, w, h);")
            self.assertGreater(draw_markers, canvas.index("// Draw VFO highlights"))
            self.assertLess(draw_markers, canvas.index("export function mountCanvas("))
            self.assertIn("...listenerMarkerMethods,", (app / "main.ts").read_text(encoding="utf-8"))
            self.assertIn("@click=\"setListenerDbAuto(false)\"", html)
            # Every dB limit field (Dengar dB scale, scan Graph min./max.) takes any value the
            # console may send, such as 0.1 dB, so none of them is marked invalid.
            db_inputs = re.findall(
                r"<input [^>]*(?:sweep\.displayM(?:in|ax)Db|listener-db-m(?:in|ax))[^>]*>", html
            )
            self.assertEqual(len(db_inputs), 4)
            for field in db_inputs:
                self.assertIn('step="any"', field)
            # The Listener's WebGL waterfall is transparent where it has no data, and the
            # canvas background behind it follows the theme.
            utils = (work / "src/client/utils.ts").read_text(encoding="utf-8")
            self.assertIn("gl.RGBA, gl.UNSIGNED_BYTE, null);", utils)
            self.assertNotIn("gl.UNSIGNED_BYTE, this.canvas);", utils)
            self.assertNotIn("vec4(0.0, 0.0, 0.0, 1.0)", utils)
            self.assertIn("gl.clearColor(0.0, 0.0, 0.0, 0.0);", utils)
            style = (work / "src/client/style.css").read_text(encoding="utf-8")
            self.assertIn("#waterfall {\n\tbackground: var(--canvas-bg);\n}", style)
            self.assertIn("--canvas-bg: #fafbf9;", style)


class _StopAfterFirstNpmCall(Exception):
    pass


class ReceiverBuildNpmTests(unittest.TestCase):
    def test_npm_is_resolved_through_path_lookup(self) -> None:
        windows_npm = r"C:\Program Files\nodejs\npm.CMD"
        with mock.patch.object(builder.shutil, "which", return_value=windows_npm) as which:
            self.assertEqual(builder._npm_command(), windows_npm)
        which.assert_called_once_with("npm")

    def test_build_runs_the_resolved_npm_executable(self) -> None:
        windows_npm = r"C:\Program Files\nodejs\npm.CMD"
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source"
            (source / "src/client").mkdir(parents=True)
            for name in ("package.json", "package-lock.json", "LICENSE", "src/client/index.html"):
                (source / name).write_text("{}\n", encoding="utf-8")
            calls = []

            def record(argv, **_kwargs):
                calls.append(list(argv))
                raise _StopAfterFirstNpmCall()

            with ExitStack() as stack:
                stack.enter_context(mock.patch.object(builder.shutil, "which", return_value=windows_npm))
                for helper in (
                    "_assert_pinned_source",
                    "_apply_receiver_source_overlay",
                    "_apply_embedded_changes",
                    "_write_source_instructions",
                    "_create_source_archive",
                ):
                    stack.enter_context(mock.patch.object(builder, helper))
                stack.enter_context(mock.patch.object(builder.subprocess, "run", side_effect=record))
                with self.assertRaises(_StopAfterFirstNpmCall):
                    builder.build_receiver(source)
        self.assertEqual(calls, [[windows_npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"]])

    def test_missing_npm_fails_before_reading_the_source(self) -> None:
        stderr = io.StringIO()
        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(builder.shutil, "which", return_value=None))
            pinned = stack.enter_context(mock.patch.object(builder, "_assert_pinned_source"))
            stack.enter_context(mock.patch.object(builder.sys, "argv", ["build_browsdr_receiver.py"]))
            stack.enter_context(redirect_stderr(stderr))
            self.assertEqual(builder.main(), 1)
        pinned.assert_not_called()
        self.assertIn("npm was not found on PATH", stderr.getvalue())
        self.assertIn("npm.cmd on Windows", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
