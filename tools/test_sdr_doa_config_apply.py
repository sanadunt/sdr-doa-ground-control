#!/usr/bin/env python3
"""Local-only tests for the staged config patch applier."""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import sdr_doa_lan_agent as agent
import sdr_doa_mqtt as contract


def command(base_rev: int = 0, **changes: object) -> dict:
    return contract.build_config_patch(
        command_id="local-test-command",
        base_config_rev=base_rev,
        changes=changes or {"gain_db": 24},
        issued_ts_ms=1_000,
        expires_ts_ms=11_000,
    )


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="sdr-doa-config-test-") as tmp:
        root = Path(tmp)
        settings_path = root / "_share" / "settings.json"
        settings_path.parent.mkdir()
        initial = {
            "center_freq": 415.7882,
            "uniform_gain": 15.7,
            "vfo_freq_0": 415788192.0,
            "vfo_bw_0": 12_500,
            "vfo_squelch_0": -84,
            "ext_upd_flag": False,
            "secret_token": "must-remain-local",
        }
        settings_path.write_text(json.dumps(initial), encoding="utf-8")
        applier = agent.AtomicConfigApplier(str(settings_path), str(root / "state"))

        applied = applier.apply(command(gain_db=24, center_frequency_hz=433_920_000), now_ms=2_000)
        assert applied["status"] == "applied"
        assert applied["readback_ok"] is True
        result = json.loads(settings_path.read_text(encoding="utf-8"))
        assert result["uniform_gain"] == 24
        assert result["center_freq"] == 433.92
        assert result["ext_upd_flag"] is True
        assert result["secret_token"] == "must-remain-local"
        assert applier.current_revision() == 1
        print("PASS config apply atomic merge/read-back/revision")

        conflict = applier.apply(command(0, gain_db=25), now_ms=2_000)
        assert conflict["status"] == "conflict"
        assert applier.current_revision() == 1
        print("PASS config revision conflict")

        expired = applier.apply(command(1, gain_db=26), now_ms=12_000)
        assert expired["status"] == "expired"
        assert applier.current_revision() == 1
        print("PASS config expiry")

        forbidden = contract.build_config_patch(
            command_id="local-forbidden",
            base_config_rev=1,
            changes={"gain_db": 27},
            issued_ts_ms=1_000,
            expires_ts_ms=11_000,
        )
        forbidden["changes"]["secret_token"] = "bad"
        rejected = applier.apply(forbidden, now_ms=2_000)
        assert rejected["status"] == "rejected"
        assert applier.current_revision() == 1
        print("PASS config allowlist rejection")

    print("4 config-apply tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
