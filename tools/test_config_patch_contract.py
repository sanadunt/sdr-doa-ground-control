"""Contract between the Kontrol panel and its command API.

The frontend keeps a hard-coded list of the error codes the backend can return
(frontend/src/lib/configPatch.ts CONFIG_PATCH_ERROR_CODES) so that each one has
an EN and ID message. The codes come from ground_console.py and, for the field
rules, from rdf_node_commands.py. These tests fail when the backend starts
returning a code the frontend does not know, or when the two disagree on the
edge's safe fields, their ranges or the gain table.
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import rdf_node_commands  # noqa: E402

GROUND_CONSOLE = (ROOT / "tools" / "ground_console.py").read_text(encoding="utf-8")
RDF_NODE_COMMANDS = (ROOT / "tools" / "rdf_node_commands.py").read_text(encoding="utf-8")
CONFIG_PATCH_TS = (ROOT / "frontend" / "src" / "lib" / "configPatch.ts").read_text(encoding="utf-8")
CONTROL_DRAFT_TS = (ROOT / "frontend" / "src" / "lib" / "controlDraft.ts").read_text(encoding="utf-8")
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
    # The edge's field rules raise CommandRefused("CODE", ...); the server passes the code on.
    for refused in re.finditer(r"CommandRefused\(\s*\"([A-Z][A-Z0-9_]+)\"", RDF_NODE_COMMANDS):
        codes.add(refused.group(1))
    return codes


class ConfigPatchContractTests(unittest.TestCase):
    def test_backend_codes_are_known_to_the_frontend(self) -> None:
        backend = _backend_config_patch_codes()
        self.assertGreaterEqual(len(backend), 10, "code extraction from ground_console.py found too little")
        for code in ("NODE_NOT_FRESH", "SETTINGS_REQUEST_PENDING", "GAIN_NOT_IN_APPROVED_TABLE", "MVP_CENTER_MUST_EQUAL_VFO0"):
            self.assertIn(code, backend, "code extraction missed a known code")
        missing = backend - _frontend_error_codes() - LOGIN_ONLY_CODES
        self.assertFalse(missing, f"backend codes without a frontend message: {sorted(missing)}")

    def test_every_frontend_code_has_en_and_id_messages(self) -> None:
        for code in _frontend_error_codes():
            key = f"'control.error.{code}'"
            self.assertEqual(I18N_TS.count(key), 2, f"{key} should appear once in EN and once in ID")

    def test_field_allowlist_matches_the_edge_fields(self) -> None:
        match = re.search(r"CONFIG_PATCH_KEYS\s*=\s*\[(.*?)\]\s*as const", CONTROL_DRAFT_TS, re.S)
        self.assertIsNotNone(match, "CONFIG_PATCH_KEYS not found in controlDraft.ts")
        keys = tuple(re.findall(r"'([a-z0-9_]+)'", match.group(1)))
        self.assertEqual(keys, rdf_node_commands.PATCH_FIELDS)
        # The Kontrol fields name the same keys in the same order.
        fields = tuple(re.findall(r"\{ key: '([a-z0-9_]+)'", CONFIG_PATCH_TS))
        self.assertEqual(fields, rdf_node_commands.PATCH_FIELDS)

    def test_field_ranges_and_integers_match_the_edge(self) -> None:
        for key, (low, high) in rdf_node_commands.PATCH_RANGES.items():
            row = re.search(r"\{ key: '" + key + r"'[^}]*\}", CONFIG_PATCH_TS)
            self.assertIsNotNone(row, key)
            text = row.group(0).replace("_", "")
            self.assertRegex(text, rf"min: {int(low)}\b", key)
            self.assertRegex(text, rf"max: {int(high)}\b", key)
            whole = key in rdf_node_commands.INTEGER_FIELDS
            self.assertIn(f"integer: {'true' if whole else 'false'}", text, key)

    def test_gain_table_matches_the_edge(self) -> None:
        match = re.search(r"GAIN_TABLE_DB: readonly number\[\] = \[(.*?)\];", CONFIG_PATCH_TS, re.S)
        self.assertIsNotNone(match, "GAIN_TABLE_DB not found in configPatch.ts")
        table = tuple(float(entry) for entry in re.findall(r"-?\d+(?:\.\d+)?", match.group(1)))
        self.assertEqual(table, rdf_node_commands.GAIN_TABLE_DB)

    def test_every_edge_error_message_exists_in_both_languages(self) -> None:
        match = re.search(r"EDGE_ERROR_KEYS[^=]*=\s*\{(.*?)\};", CONFIG_PATCH_TS, re.S)
        self.assertIsNotNone(match, "EDGE_ERROR_KEYS not found in configPatch.ts")
        keys = set(re.findall(r"'(control\.(?:edge|error)\.[A-Z0-9_]+)'", match.group(1)))
        self.assertGreaterEqual(len(keys), 10)
        for key in keys:
            self.assertEqual(I18N_TS.count(f"'{key}'"), 2, f"{key} should appear once in EN and once in ID")


if __name__ == "__main__":
    unittest.main()
