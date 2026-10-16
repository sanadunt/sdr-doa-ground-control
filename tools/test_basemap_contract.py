#!/usr/bin/env python3
"""Contract between the basemap catalogue and the console's tile cache.

``frontend/src/lib/basemaps.ts`` names the tile sources the map draws from
``/api/tiles/<source>/...`` and the highest zoom of each; ``tools/tile_cache.py``
holds the upstreams behind those ids. Both lists must match, the frontend must
not reach a tile provider itself, and the page CSP must list no tile host.
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = TOOLS_DIR.parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import tile_cache  # noqa: E402

BASEMAPS_TS = PROJECT_ROOT / "frontend" / "src" / "lib" / "basemaps.ts"
FRONTEND_SRC = PROJECT_ROOT / "frontend" / "src"
GROUND_CONSOLE = TOOLS_DIR / "ground_console.py"


def _ts_tile_sources(text: str) -> dict:
    block = re.search(r"export const TILE_SOURCES[^=]*=\s*\{(.*?)\n\};", text, re.S)
    if block is None:
        raise AssertionError("TILE_SOURCES not found in basemaps.ts")
    entries = re.findall(r"^\s*'?([a-z][a-z0-9-]*)'?\s*:\s*\{\s*maxzoom:\s*(\d+)\s*\}", block.group(1), re.M)
    return {name: int(maxzoom) for name, maxzoom in entries}


class BasemapContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.text = BASEMAPS_TS.read_text(encoding="utf-8")

    def test_source_ids_and_maxzoom_match_the_tile_cache(self) -> None:
        expected = {source.id: source.maxzoom for source in tile_cache.TILE_SOURCES.values()}
        self.assertEqual(_ts_tile_sources(self.text), expected)
        union = re.search(r"export type TileSourceId = ([^;]+);", self.text)
        self.assertIsNotNone(union)
        self.assertEqual(set(re.findall(r"'([a-z-]+)'", union.group(1))), set(expected))

    def test_every_style_layer_uses_a_known_source(self) -> None:
        used = set(re.findall(r"source:\s*'([a-z-]+)'", self.text))
        self.assertTrue(used)
        self.assertLessEqual(used, set(tile_cache.TILE_SOURCES))

    def test_route_prefix_matches(self) -> None:
        match = re.search(r"export const TILE_ROUTE = '([^']+)';", self.text)
        self.assertIsNotNone(match)
        self.assertEqual(match.group(1) + "/", tile_cache.TILE_ROUTE_PREFIX)

    def test_frontend_has_no_remote_tile_template(self) -> None:
        offenders = []
        for path in FRONTEND_SRC.rglob("*"):
            if path.suffix not in {".ts", ".tsx"}:
                continue
            for literal in re.findall(r"""['"`]([^'"`\n]*\{z\}[^'"`\n]*)['"`]""", path.read_text(encoding="utf-8")):
                if re.match(r"https?://", literal):
                    offenders.append(f"{path.relative_to(PROJECT_ROOT)}: {literal}")
        self.assertEqual(offenders, [], "tiles go through /api/tiles; the browser never names a tile host")

    def test_no_console_csp_lists_a_tile_host(self) -> None:
        source = GROUND_CONSOLE.read_text(encoding="utf-8")
        hosts = {re.sub(r":\d+$", "", template.split("/")[2]) for item in tile_cache.TILE_SOURCES.values() for template in item.templates}
        for host in sorted(hosts):
            with self.subTest(host):
                self.assertNotIn(host, source)


if __name__ == "__main__":
    unittest.main()
