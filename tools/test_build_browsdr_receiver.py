#!/usr/bin/env python3
"""Regression tests for the pinned BrowSDR build boundary."""

from __future__ import annotations

import subprocess
import tempfile
import unittest
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


if __name__ == "__main__":
    unittest.main()
