"""Health check of the Ground Console image and the native launcher.

GET http://127.0.0.1:<port>/api/health, never through a proxy, and exit 0 only
for a 200 reply with {"ok": true}. The port comes from the first argument or
SDR_DOA_PORT (default 8787).
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request


def main(argv: list) -> int:
    port = argv[1] if len(argv) > 1 else os.environ.get("SDR_DOA_PORT", "8787")
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
    print(f"healthy: version {body.get('version', 'unknown')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
