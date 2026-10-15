"""Contract between the Kontrol panel and the config-patch API.

The frontend keeps a hard-coded list of the error codes the backend can return
(frontend/src/lib/configPatch.ts CONFIG_PATCH_ERROR_CODES) so that each one has
an EN and ID message. These tests fail when the backend starts returning a code
the frontend does not know, or when the two disagree on the allowlisted fields.
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import sdr_doa_mqtt  # noqa: E402

GROUND_CONSOLE = (ROOT / "tools" / "ground_console.py").read_text(encoding="utf-8")
CONFIG_PATCH_TS = (ROOT / "frontend" / "src" / "lib" / "configPatch.ts").read_text(encoding="utf-8")
I18N_TS = (ROOT / "frontend" / "src" / "lib" / "i18n.ts").read_text(encoding="utf-8")

# Login codes that the shared admin form maps through adminErrorKey instead of control.error.*.
LOGIN_ONLY_CODES = {"ADMIN_DISABLED", "ADMIN_PASSWORD_INVALID"}


def _frontend_error_codes() -> set[str]:
    match = re.search(r"CONFIG_PATCH_ERROR_CODES\s*=\s*\[(.*?)\]\s*as const", CONFIG_PATCH_TS, re.S)
    assert match, "CONFIG_PATCH_ERROR_CODES not found in configPatch.ts"
    return set(re.findall(r"'([A-Z][A-Z0-9_]+)'", match.group(1)))


def _backend_config_patch_codes() -> set[str]:
    codes: set[str] = set()
    # ConfigPatchRejected(status, "CODE", ...) and _send_config_patch_error(status, "CODE", ...),
    # possibly with the code on the next line.
    for call in re.finditer(r"(?:ConfigPatchRejected|_send_config_patch_error)\(\s*HTTPStatus\.\w+,\s*\"([A-Z][A-Z0-9_]+)\"", GROUND_CONSOLE):
        codes.add(call.group(1))
    for literal in re.finditer(r"\"code\":\s*\"([A-Z][A-Z0-9_]+)\"", GROUND_CONSOLE):
        codes.add(literal.group(1))
    for raised in re.finditer(r"MonitorPublishError\(\s*\"([A-Z][A-Z0-9_]+)\"", GROUND_CONSOLE):
        codes.add(raised.group(1))
    return codes


class ConfigPatchContractTests(unittest.TestCase):
    def test_backend_codes_are_known_to_the_frontend(self) -> None:
        backend = _backend_config_patch_codes()
        self.assertGreaterEqual(len(backend), 10, "code extraction from ground_console.py found too little")
        missing = backend - _frontend_error_codes() - LOGIN_ONLY_CODES
        self.assertFalse(missing, f"backend codes without a frontend message: {sorted(missing)}")

    def test_every_frontend_code_has_en_and_id_messages(self) -> None:
        for code in _frontend_error_codes():
            key = f"'control.error.{code}'"
            self.assertEqual(I18N_TS.count(key), 2, f"{key} should appear once in EN and once in ID")

    def test_field_allowlist_matches_contract(self) -> None:
        keys = set(re.findall(r"'(center_frequency_hz|gain_db|vfo_frequency_hz|vfo_bandwidth_hz|vfo_squelch_db)'", CONFIG_PATCH_TS))
        self.assertEqual(keys, set(sdr_doa_mqtt.CONFIG_RANGES))


if __name__ == "__main__":
    unittest.main()
