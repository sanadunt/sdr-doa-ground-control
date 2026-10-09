import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS_DIR))

from mbtiles_store import MbtilesCatalog

PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 16


def write_mbtiles(path: Path, metadata: dict, tiles: dict) -> None:
    with closing(sqlite3.connect(path)) as db, db:
        db.execute("CREATE TABLE metadata (name TEXT, value TEXT)")
        db.execute("CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)")
        db.executemany("INSERT INTO metadata VALUES (?,?)", metadata.items())
        db.executemany("INSERT INTO tiles VALUES (?,?,?,?)", [(z, x, y, data) for (z, x, y), data in tiles.items()])


class MbtilesCatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.tiles_dir = self.root / "tiles"
        self.tiles_dir.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def test_lists_raster_files_and_serves_xyz_tiles_from_tms_rows(self):
        # XYZ (z=2, x=1, y=0) is TMS row 3.
        write_mbtiles(self.tiles_dir / "Bandung area.mbtiles", {
            "name": "Bandung", "format": "png", "minzoom": "0", "maxzoom": "2",
            "bounds": "107.5,-7.0,107.8,-6.8", "attribution": "© OpenStreetMap contributors",
        }, {(2, 1, 3): PNG})
        catalog = MbtilesCatalog([self.tiles_dir])
        items = catalog.list()
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["id"], "Bandung-area")
        self.assertEqual(items[0]["name"], "Bandung")
        self.assertEqual((items[0]["minzoom"], items[0]["maxzoom"]), (0, 2))
        self.assertEqual(items[0]["bounds"], [107.5, -7.0, 107.8, -6.8])
        self.assertNotIn("path", items[0])
        self.assertEqual(catalog.tile("Bandung-area", 2, 1, 0), (PNG, "image/png"))
        self.assertIsNone(catalog.tile("Bandung-area", 2, 1, 3))

    def test_format_is_sniffed_and_vector_or_broken_files_are_skipped(self):
        write_mbtiles(self.tiles_dir / "nofmt.mbtiles", {"name": "No format"}, {(0, 0, 0): b"\xff\xd8\xff\xe0jpeg"})
        write_mbtiles(self.tiles_dir / "vector.mbtiles", {"name": "Vector", "format": "pbf"}, {(0, 0, 0): b"\x1a\x00"})
        (self.tiles_dir / "broken.mbtiles").write_bytes(b"not sqlite")
        items = MbtilesCatalog([self.tiles_dir]).list()
        self.assertEqual([(item["id"], item["format"]) for item in items], [("nofmt", "jpg")])

    def test_requests_select_by_id_only(self):
        write_mbtiles(self.tiles_dir / "area.mbtiles", {"format": "png"}, {(0, 0, 0): PNG})
        catalog = MbtilesCatalog([self.tiles_dir])
        catalog.list()
        for bad in ("../area", "area.mbtiles", "", "a/b"):
            with self.assertRaises(ValueError):
                catalog.tile(bad, 0, 0, 0)
        with self.assertRaises(KeyError):
            catalog.tile("missing", 0, 0, 0)
        with self.assertRaises(ValueError):
            catalog.tile("area", 1, 2, 0)

    def test_explicit_files_join_the_catalog_and_ids_stay_unique(self):
        other = self.root / "elsewhere"
        other.mkdir()
        write_mbtiles(self.tiles_dir / "area.mbtiles", {"format": "png", "name": "A"}, {(0, 0, 0): PNG})
        write_mbtiles(other / "area.mbtiles", {"format": "png", "name": "B"}, {(0, 0, 0): PNG})
        ids = sorted(item["id"] for item in MbtilesCatalog([self.tiles_dir], [other / "area.mbtiles"]).list())
        self.assertEqual(ids, ["area", "area-2"])

    def test_tile_files_are_opened_read_only(self):
        path = self.tiles_dir / "area.mbtiles"
        write_mbtiles(path, {"format": "png"}, {(0, 0, 0): PNG})
        catalog = MbtilesCatalog([self.tiles_dir])
        catalog.list()
        db = catalog._open(path)
        try:
            with self.assertRaises(sqlite3.OperationalError):
                db.execute("DELETE FROM tiles")
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
