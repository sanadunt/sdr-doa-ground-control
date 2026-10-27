#!/usr/bin/env python3
"""Local-only regression tests for the Data Out read's safety gates."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import sdr_doa_collector as collector


def test_base_url_allowlist() -> None:
    for base_url, label in (
        ("http://example.com:8081", "arbitrary host"),
        ("http://user:pass@doasdr.local:8081", "userinfo"),
        ("https://doasdr.local:8081", "https scheme"),
        ("http://doasdr.local:9999", "port"),
    ):
        result = collector.fetch_resource(base_url, "/status.json")
        assert result.ok is False, label
        assert "pass" not in (result.error or "").lower(), label
    try:
        collector.fetch_resource("http://doasdr.local:8081", "/not-allowlisted")
    except ValueError:
        pass
    else:
        raise AssertionError("path allowlist did not reject")
    print("PASS base URL/path allowlist")


def main() -> int:
    tests = [
        test_base_url_allowlist,
    ]
    for test in tests:
        test()
    print(f"{len(tests)} security regression tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
