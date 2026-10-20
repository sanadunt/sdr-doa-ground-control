"""Health check of the Ground Console image and the native launcher.

GET http://127.0.0.1:<port>/api/health, never through a proxy, and exit 0 only
for a 200 reply with {"ok": true}. The port comes from the first argument or
SDR_DOA_PORT (default 8787).

With --busy it prints "busy" while the console reports receiver_busy (the
Receiver records audio or archives a scan), else "idle", and exits 0; when the
console does not answer it exits 1. sdr-doa-docker runs it in the container
to hold an automatic update back; an image whose health check has no --busy
answers neither word and so counts as not busy.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request


def main(argv: list) -> int:
    args = list(argv[1:])
    busy = "--busy" in args
    args = [arg for arg in args if arg != "--busy"]
    port = args[0] if args else os.environ.get("SDR_DOA_PORT", "8787")
    if not port.isdigit() or not 1 <= int(port) <= 65535:
        print(f"unhealthy: invalid port {port!r}")
        return 1
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(f"http://127.0.0.1:{int(port)}/api/health", timeout=4) as response:
            body = json.loads(response.read(4096).decode("utf-8"))
    except Exception as exc:  # any failure is "unhealthy"; the message names it
        print(f"unhealthy: {exc}")
        return 1
    if not isinstance(body, dict) or body.get("ok") is not True:
        print("unhealthy: /api/health did not answer ok")
        return 1
    if busy:
        print("busy" if body.get("receiver_busy") is True else "idle")
        return 0
    print(f"healthy: version {body.get('version', 'unknown')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
