# Anti-Slop Audit 008: Receiver Database, Full-Map Dashboard, Basemaps

Date: 2026-10-09  
Mode: reviewed during the work, as the user chose.  
Status: Implemented and validated. `antislop.md` and `skills/antislop-*` are still missing, so this audit follows the format of audits 001–007.

## Requests

1. Check and fix the database that saves data (the Receiver/Monobs SQLite store).
2. Make the Dashboard a full map with the DoA graph as an overlay that can be hidden or shown.
3. Basemaps: OSM normal, light, dark, and HOT; Esri satellite; and offline maps from MBTiles.

User decisions recorded before the work:

- Light and dark are recoloured OSM tiles. No new provider was added.
- MBTiles files go in the local data folder. There is no browser upload path.

## Database findings (all reproduced before fixing)

1. **Connections were never closed.** `with sqlite3.connect(...) as db` only commits or rolls back. Under Python 3.13 every request left an open connection behind, and the test run showed dozens of `ResourceWarning: unclosed database` messages.
2. **SQLite errors dropped the request.** Renaming one marker set to the name of another raised `sqlite3.IntegrityError`. The handlers caught only `ValueError`, `KeyError` and `OSError`, so the error escaped and the connection closed with no response. The client saw a generic network failure. A locked or full database would have behaved the same way.
3. **Interrupted recordings disappeared.** If the browser closed or the console restarted mid-recording, the audio session stayed unfinished forever. It never appeared in Records, and its `.part` file stayed in `tmp/`. Reproduction: append 100 bytes, restart, and Records showed 0 sessions with the file still in `tmp/`.
4. **Interrupted archive scans disappeared.** An auto-archived scan that never received `finish` had its traces stored but no record row, so it was invisible in Records.
5. **Marker-set saves could lose markers.** Every marker edit on a saved set sends a save. Each response replaced the local marker list with the server's copy of that request, so a slower, older response could remove markers added after it was sent. Saves could also run concurrently.
6. **Marker labels and ids were not validated** before being stored.
7. **404 messages carried quotes.** The text was `'scan not found'` because it came from `str(KeyError(...))`.

## Changes

**Database (`tools/receiver_record_store.py`)**

- All operations use `_db()`, which commits or rolls back and always closes the connection.
- The database runs in WAL mode.
- Recovery:
  - **Unfinished archive scans:** at startup, and when a new scan starts, they become `stopped` records marked `interrupted`.
  - **Abandoned audio sessions:** they are finalized at startup, and also when a new recording starts after 120 s without file activity.
  - **Segments with audio:** they keep that audio and are marked `recovered`, with a duration estimated from the file time. Any unacknowledged tail is trimmed so the file matches the stored byte count.
  - **Segments without audio:** they are marked failed.
  - **Empty sessions:** they are removed.
- Marker sets:
  - Renaming onto an existing name gives a readable error.
  - Labels must be text of at most 80 characters, marker ids are short strings, and set names are at most 120 characters.

**HTTP (`tools/ground_console.py`)**

- SQLite errors return JSON and are logged: 503 for an operational fault such as a locked database, otherwise 500.
- 404 messages no longer carry quotes.

**Monobs client (`records.ts`)**

- Marker-set saves run one at a time, and overlapping requests fold into a single follow-up save.
- A follow-up save also runs when markers changed while a request was in flight.
- A response never replaces the local marker list.

## Dashboard and basemaps

**Full map**

- The map fills the Dashboard under the DoA readout strip.
- The polar graph floats at the top right. It has a Hide button (×) and Expand, and a `DoA graph` toggle in the map toolbar shows it again. The choice is stored under `sdr-console-polar-overlay`.
- On phones the graph becomes a sheet over the lower part of the map.
- Zoom controls moved to the bottom right so the graph does not cover them.

**Basemap menu**

- Online options: OSM Normal, OSM Light, OSM Dark, OSM HOT (humanitarian), and Satellite (Esri).
  - Light and dark recolour the OSM tiles with MapLibre raster paint. Dark inverts brightness and rotates hue so water and parks stay readable.
  - On the dark and satellite basemaps, range rings and guides switch to light lines.
- Offline section: MBTiles files found by the server, each with its zoom range.
- With no files, the menu explains where to put them. The list refreshes each time the menu opens.
- The choice is stored under `sdr-console-basemap`, and the attribution line follows the active basemap.

**MBTiles (`tools/mbtiles_store.py`, `/api/tiles`)**

- Files are read read-only (`mode=ro`) from `<data dir>/tiles/*.mbtiles` and from `--mbtiles PATH`.
- Requests select a file by catalog id, never by path. XYZ rows are flipped to TMS.
- A missing tile returns 204, so MapLibre leaves that area blank.
- Only raster MBTiles are supported (png, jpg or webp, declared or detected). Vector `pbf` files are skipped, because they need a style and fonts the console does not ship.

**CSP**

- The only additions are the three HOT hosts (`a`, `b`, `c.tile.openstreetmap.fr`) and `server.arcgisonline.com`.
- They are kept in one list, `BASEMAP_TILE_HOSTS`, and a Vitest check fails if a basemap uses a host outside it.

## Copy review

- Basemap names say what the map is, such as "Satellite (Esri)" and "OSM HOT (humanitarian)". There are no marketing labels.
- The empty offline state gives the action: where to put files and when the list refreshes.
- The toolbar toggle says "DoA graph" when the graph is hidden and "Hide DoA graph" when it is shown. Hiding from inside the graph uses the same words in its label.
- Attribution text follows each provider's requested credit.

## Verification

- **Python:**
  - `unittest discover -s tools` passed (79 tests), run with `-W error::ResourceWarning`.
  - `test_receiver_record_store`: 22 tests, 10 of them new. The new tests cover connection closing, WAL, the rename conflict, label validation, restart recovery including tail trimming, failed empty segments, empty-session removal, idle recovery while an active recorder keeps writing, interrupted archive scans, and archive scans abandoned by a new scan.
  - `test_mbtiles_store`: 5 new tests.
  - Static HTTP tests: added a marker conflict returning 400 JSON, a 404 message without quotes, and `/api/tiles` listing with 200, 204, 404 and 400 tile responses. The updated exact CSP is asserted.
- **Frontend:**
  - `npm test` passed (92 tests), with the new `basemaps.test.ts` covering order, the CSP host check, MBTiles resolution, fallback and normalization.
  - `npm run check` and `npm run build` passed.
- **Receiver:**
  - `node --test` passed (11 tests).
  - The patched-tree `tsc` shows only the 2 baseline `HTMLSummaryElement` errors.
  - `git diff --check` is clean.
- **Browser checks** (Playwright + Chromium, simulation on, generated MBTiles test file):
  - All six basemaps rendered at 1440 px.
  - Requests reached each expected host, with no failed responses and no CSP errors; the only console error was the known `favicon.ico` 404.
  - Hide and show worked and persisted. The basemap choice survived a reload, including the MBTiles choice after the list loaded.
  - At 390 px the basemap menu opens above the graph sheet.
  - Marker-set race in Monobs: with save requests delayed by 700 ms, four rapid "Add marker" actions on a saved set ended with 4 markers both locally and on the server, and no error.

## Limits

- Esri World Imagery is offered with its attribution, but its terms of use apply to operational use. Check them before relying on it outside testing.
- The light and dark basemaps are recolours, not purpose-made cartography. Label contrast on Dark is lower than on Normal.
- Audio recovery estimates duration from the file's modification time. A recovered WebM may end mid-frame, which players usually handle.
- Idle recovery runs only when a new recording starts or the console restarts. A session abandoned while the console keeps running stays unfinished until one of those happens.
- MBTiles was tested with a generated grid file, not a real regional extract. Very large files have not been timed.
