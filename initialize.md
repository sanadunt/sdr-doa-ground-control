# Initialize Context — `doa-sdr-telemetry`

Dokumen ini adalah entrypoint untuk AI coding agent atau developer yang baru masuk ke repository. Baca sebelum mengubah kode. Isinya mencerminkan kondisi workspace saat ini, bukan janji fitur masa depan.

Bahasa kerja project: Bahasa Indonesia. Nama file, identifier, endpoint, schema, dan komentar teknis yang sudah memakai Bahasa Inggris dipertahankan.

---

## 1. Identitas dan tujuan sistem

Semua path dan perintah di dokumen ini relatif terhadap root repository (checkout `sdr-doa-ground-control`). Catatan historis lain di repo kadang masih memakai path `/Users/mac/...` dari mesin lain.

Project ini adalah **Ground Console lokal** untuk observasi SDR-DoA yang berjalan pada Raspberry Pi/UAV. Sistem membaca Data Out SDR-DoA, memvalidasi freshness/health/consistency, menampilkan native CSV/XML secara terpisah, dan menyediakan monitor MQTT subscriber-only.

Tujuan UI:

- melihat status sistem dan kualitas data;
- melihat DoA canonical serta angular power 360 bin;
- melihat station reference dan helper arah pada peta;
- menguji renderer dengan data simulasi tanpa perangkat SDR;
- mencoba perubahan konfigurasi secara lokal/dry-run;
- tidak mengirim command remote secara default.

### Batas keamanan dan interpretasi

- Ground Console adalah **local/loopback console**.
- Data Out dibaca melalui HTTP `GET` bounded; jangan mengubah read path menjadi remote mutation.
- MQTT monitor harus tetap subscriber-only: tidak publish command dari GUI.
- Settings pada GUI adalah local configuration atau dry-run kecuali alur command nyata secara eksplisit disetujui dan diuji.
- Raw secret, token, credential, raw settings sensitif, raw IQ, dan raw log tidak boleh diteruskan ke browser/MQTT.
- Publication gate tetap eksplisit. Health/observability bukan berarti DoA siap dipublikasikan.
- Overlay map dan simulasi adalah **direction helper/visualisasi**, bukan lokasi target, jarak target, RF coverage, atau estimasi lokasi pemancar.

---

## 2. Status implementasi saat ini

### Sudah tersedia

- Python Ground Console pada `tools/ground_console.py`.
- React + TypeScript + Vite frontend pada `frontend/`.
- Tujuh halaman: Overview (Ringkasan), System Health, DoA Diagnostics, Configuration, Message Monitor, Simulasi, dan Receiver. Shortcut keyboard `1`–`7` dan `R` untuk refresh.
- Overview dengan map dan plot polar/compass. Readout, polar, dan overlay peta memakai satu predikat kesiapan (`overviewDoaStatus()` di `frontend/src/lib/doaStatus.ts`), sehingga DAQ gagal, ADC overdrive, CONFLICT, view hilang, atau node beku menyembunyikan ketiganya sekaligus.
- Bearing geografis dihitung dari θ₀ dengan `geographicBearingForBin()` (`frontend/src/lib/polar.ts`): (360 − θ₀ + compass_offset) mod 360. θ₀ tetap ditampilkan sebagai sudut array.
- Plot DoA menggunakan bundle Plotly parsial (`plotly.js/lib/core` + `lib/scatterpolar`, didaftarkan di `frontend/src/lib/plotlyPolar.ts`) dan update data mempertahankan camera state selama memungkinkan.
- Map menggunakan MapLibre GL JS dengan basemap tile OSM publik (`tile.openstreetmap.de`, lalu `tile.openstreetmap.org` bila host pertama gagal).
- DoA map overlay: station marker, bearing, lobe, guide angle, dan heat-style direction helper.
- Canvas fallback overlay menjaga visualisasi DoA tetap terlihat jika WebGL2 tidak tersedia, context WebGL hilang, worker MapLibre gagal, atau layer GeoJSON bermasalah.
- Overlay settings tersimpan lokal dan memiliki kontrol advanced untuk jarak/radius, min/max dB, threshold, contrast/intensity, radial samples, distance falloff, opacity, blur, guide interval, dan palette.
- Marker station interaktif dan dapat membuka popup detail.
- Tab `Simulasi`: lokasi, sudut DoA, lebar lobe, randomize manual, randomize otomatis.
- Halaman System Health (termasuk tabel pembacaan per resource), DoA Diagnostics, Configuration, dan Message Monitor (sdr/v1 plus panel RDF Node v2).
- Collector mendeteksi node beku (`NODE_CLOCK_STALLED`), membatasi satu koleksi dengan anggaran waktu (4 detik untuk `/api/snapshot`), dan membandingkan sudut CSV/XML hanya untuk pasangan dari frame yang sama.
- Freshness expiry di renderer browser; snapshot stale tidak boleh terus ditampilkan sebagai data aktif. Refresh otomatis default 2 detik (pilihan 1, 2, 5, 10, 30 detik atau manual).
- Receiver embedded (BrowSDR dari submodule `vendor/BrowSDR`, dengan overlay di `tools/browsdr_receiver_overlay/`) untuk spektrum, scan, rekaman audio, dan Records yang disimpan lokal.
- Branding lokal dan konfigurasi console lokal.

### Staging/rancangan—jangan dianggap production

- Telemetry nyata melalui PPP/T900 belum dianggap lulus hanya karena adapter staging tersedia.
- Publication gate live terakhir dilaporkan `DEGRADED/BLOCKED` pada dokumentasi baseline karena `daq_ok=false`, sinkronisasi IQ/sample-delay gagal, atau output DoA stale.
- Command settings nyata ke Raspberry, ACK/read-back production, dan deployment PPP/T900 bukan tanggung jawab UI saat ini.
- Dokumen arsitektur MQTT menjelaskan desain target; cocokkan selalu dengan implementasi `tools/` dan test.
- Tahap PPP/T900 synthetic end-to-end tertentu masih tercatat blocked/tergantung interface dan route environment.

---

## 3. Arsitektur tingkat tinggi

```text
SDR-DoA / DAQ / DSP pada Raspberry
        │
        ├── Data Out HTTP / file output lokal
        │       status, CSV, XML, settings
        │
        └── Edge agent staging / MQTT adapter
                 │ health + freshness + authority + redaction
                 ▼
Ground Console Python (loopback)
        │
        ├── /api/snapshot?base_url=...
        ├── /api/capabilities
        ├── /api/console-config
        ├── /api/branding, /api/admin/*
        ├── /api/mqtt, /api/mqtt/connect, /api/mqtt/rdf-node
        ├── /api/dry-run/config-patch
        ├── /api/receiver/*   (SQLite + file audio di --data-dir)
        └── /receiver/        (build BrowSDR, static root terpisah)
                 │ same-origin fetch
                 ▼
React frontend
        ├── Overview: MapLibre/OSM + DoA overlay + Plotly polar
        ├── System Health
        ├── DoA Diagnostics
        ├── Configuration
        ├── Message Monitor
        ├── Simulasi (browser-only)
        └── Receiver (iframe /receiver/, tetap ter-mount setelah dibuka)
```

Arsitektur target telemetry yang terdokumentasi:

```text
DAQ/DSP → edge agent → health/freshness/authority gate
       → normalized compact payload → MQTT → Ground consumer
```

MQTT adalah transport/contract, bukan pengganti DAQ, DSP, normalisasi, gate, atau read-back.

---

## 4. Struktur repository dan file penting

### Backend dan tools

| Path | Peran |
|---|---|
| `tools/ground_console.py` | HTTP Ground Console, API lokal, static frontend serving, CSP, config/branding/admin lokal |
| `tools/sdr_doa_collector.py` | Collector read-only, parsing terbatas, redaction, freshness, candidate, gate |
| `tools/sdr_doa_lan_agent.py` | Edge agent/LAN staging dan payload health/state/config |
| `tools/sdr_doa_mqtt.py` | MQTT contract/adapter staging |
| `tools/sdr_doa_mqtt_monitor.py` | MQTT monitor subscriber-only; memerlukan `paho-mqtt` (tanpa paket ini monitor berstatus ERROR, console tetap jalan) |
| `tools/rdf_node_mqtt_v2.py` | Parser dan snapshot RDF Node v2 untuk `/api/mqtt/rdf-node` |
| `tools/receiver_record_store.py` | Store SQLite dan file audio Receiver di bawah `--data-dir` |
| `tools/build_browsdr_receiver.py` | Builder Receiver: salin submodule, terapkan overlay, `npm ci` + build, tulis `frontend/dist/receiver` |
| `tools/browsdr_receiver_overlay/` | Perubahan lokal Receiver yang diterapkan saat build; `vendor/BrowSDR` tidak diedit |
| `tools/sdr_doa_mqtt_stdlib.py` | Jalur MQTT stdlib/staging alternatif |
| `tools/synthetic_mqtt_publisher.py` | Publisher synthetic untuk test/staging; bukan production telemetry |
| `tools/fixtures/` | Fixture valid, stale, unhealthy, malformed, missing-status, conflict, partial, nonfinite, dan peak-mismatch |

### Frontend

| Path | Peran |
|---|---|
| `frontend/src/App.tsx` | Route, lifecycle snapshot/config/MQTT, simulation state, freshness expiry, page composition |
| `frontend/src/api.ts` | Same-origin API adapter dengan timeout, abort, validasi shape, dan read-back |
| `frontend/src/types.ts` | Contract TypeScript untuk snapshot, candidate, gate, config, map, MQTT |
| `frontend/src/components/Shell.tsx` | Sidebar, route, runtime badges, theme, read strip, navigation |
| `frontend/src/components/TacticalMap.tsx` | MapLibre, OSM tile, marker, popup, overlay settings, overlay lifecycle |
| `frontend/src/components/PolarPanel.tsx` | Panel angular response dan metadata DoA |
| `frontend/src/components/PolarPlot.tsx` | Plotly polar/compass renderer, camera state, head-up, manual dB range |
| `frontend/src/lib/telemetry.ts` | Candidate selection, data state, formatting, gate helpers |
| `frontend/src/lib/doaStatus.ts` | Predikat kesiapan DoA bersama untuk readout, polar, dan peta |
| `frontend/src/lib/mqttMonitor.ts` | Normalisasi snapshot MQTT v1/v2 dan redaksi record |
| `frontend/src/pages/ReceiverPage.tsx` | Host iframe Receiver, sinkron tema/bahasa, penerusan shortcut |
| `frontend/scripts/build-receiver.mjs` | Menjalankan builder Receiver untuk `npm run build:receiver` dan `build:all` |
| `frontend/src/lib/simulation.ts` | Synthetic 360-bin snapshot, validation, randomization |
| `frontend/src/lib/doaGeometry.ts` | Geometry bearing/lobe/heat/guides dari coordinate + vector + settings |
| `frontend/src/lib/mapOverlaySettings.ts` | Default, validation, persistence, preset overlay settings |
| `frontend/src/lib/map.ts` | GPS source resolution, fallback coordinate, posisi live terakhir, OSM tile hosts dan perpindahannya |
| `frontend/src/lib/polar.ts` | Angle convention, bearing geografis, polar metadata, source conversion |
| `frontend/src/pages/` | Overview, health, diagnostics, configuration, monitor, simulation, receiver |
| `frontend/src/console-design.css` | Design layer Ground Console dan responsive/accessibility rules |
| `frontend/src/polar-layout.css` | Plotly layout/controls |

### Dokumentasi utama

- `QUICKSTART.md`: install, build, run, perilaku yang terlihat operator, dan troubleshooting.
- `anti-slop/audit-006-2026-10-12-functional.md`: audit fungsional AUD-01..148 beserta status perbaikannya.
- `SUMMARY.md`: ringkasan historis dan arsitektur besar.
- `SDR_DOA_TELEMETRY_ARCHITECTURE_AND_SETTINGS_CONTROL.md`: rancangan telemetry/MQTT/settings; sebagian target architecture.
- `SDR_DOA_8081_DATA_REFERENCE.md`: referensi endpoint dan payload Data Out.
- `SDR_DOA_DATA_ACCESS_AND_GUI_CUSTOMIZATION.md`: akses data dan titik kustomisasi GUI upstream.
- `BACKEND_PAYLOAD_PLAN.md`: payload compact, throughput, topic, dan policy bandwidth.
- `MAPLIBRE_DOA_OVERLAY_PLAN.md`: keputusan serta implementasi overlay map.
- `evaluasi GUI.md`: evaluasi visual, accessibility, validasi browser, dan keputusan UI. Baca bagian "Status saat ini" di atasnya dulu; entri lama di bawahnya sebagian sudah tidak berlaku.
- `SDR_DOA_FRONTEND_WORKFLOW.md`: workflow build/test frontend.
- Dokumentasi `Dokumentasi_*.md`: arsip setup Raspberry, T900/PPP, MQTT, jaringan, service, dan throughput.

Repository tidak memiliki `README.md` saat ini. Gunakan dokumen ini sebagai entrypoint sebelum membaca dokumen historis lain.

---

## 5. Contract data DoA yang harus dipahami

`TelemetrySnapshot` utama berada di `frontend/src/types.ts`. Field penting:

```text
snapshot.status
snapshot.settings
snapshot.doa_candidates.csv
snapshot.doa_candidates.xml
snapshot.native_consistency
snapshot.authority
snapshot.publication_gate
snapshot.overall_state
```

Candidate DoA dapat memiliki:

```text
available
source_format
freshness
canonical_angle_deg
angular_power_db       // angular spectrum, biasanya 360 bin
angular_peak_index
angular_peak_db
angular_bins
latitude / longitude
heading / gps_heading / compass_heading
```

### Aturan native CSV/XML

- CSV dan XML tetap disimpan sebagai candidate terpisah.
- Jangan menggabungkan native records secara diam-diam.
- `native_consistency` dan conflict harus tetap terlihat.
- `canonical_angle_deg` adalah θ₀ native: sudut kerangka array, berlawanan jarum jam. Nilai ini bukan bearing geografis dan tidak otomatis sama dengan plotted display peak. Konversi ke bearing dilakukan di renderer dengan `geographicBearingForBin()`.
- Sudut CSV dan XML hanya dibandingkan bila keduanya dari frame yang sama (`native_consistency.frame_relation`); pasangan frame berbeda menambah reason `NATIVE_ANGLE_UNCHECKED`.
- `angular_power_db` adalah **angular DoA spectrum**, bukan frequency spectrum.
- Konversi Compass/Polar dilakukan di renderer berdasarkan settings; jangan mengubah data sumber hanya untuk tampilan.

### Freshness dan gate

- Data expired harus dikosongkan/ditandai stale pada visual aktif.
- Local expiry browser tidak boleh me-restart umur data dari nol setiap response.
- `publication_gate.state` dan `reasons` harus tetap eksplisit.
- Health available, Data Out available, native records present, dan delivery READY adalah hal berbeda.
- `overall_state` diperiksa berurutan: UNAVAILABLE, DEGRADED (DAQ gagal atau ADC overdrive), INVALID, CONFLICT, STALE (termasuk node beku), INCOMPLETE, lalu UNVERIFIED/LIVE. Field pendukung: `node_progress`, `signal_quality`, `collection`, dan `resources`.

---

## 6. Map, overlay, dan simulasi

### MapLibre/OSM

MapLibre adalah renderer, bukan penyedia peta. Basemap memakai tile OSM publik tanpa API key melalui template di `frontend/src/lib/map.ts`. Peta memakai satu host pada satu waktu: `tile.openstreetmap.de` dulu, lalu `tile.openstreetmap.org` setelah 4 kegagalan berturut-turut atau host yang diam. CSP pada `ground_console.py` harus mengizinkan kedua host pada `connect-src` dan `img-src`.

Jika basemap gagal, cek CSP/network browser, tile host, request tile, proxy, VPN, firewall, atau policy jaringan. Jangan menghapus overlay hanya karena imagery OSM gagal.

### Overlay direction helper

Overlay memakai coordinate station + vector angular. Ia membantu membaca arah, bukan menunjukkan target. Renderer/layer yang ada:

- station center marker + popup;
- bearing direction;
- lobe/pola angular;
- guide angle lines;
- heat-style samples sepanjang arah;
- legend dan overlay settings.

Parameter settings bersifat **visual**, bukan parameter fisik RF:

- visibility lobe/bearing/heatmap/guides;
- projection distance dan lobe radius;
- skala dB Auto (dari vektor, default) atau Manual dengan min/max dB dan noise threshold;
- contrast/intensity;
- radial samples dan distance falloff;
- heat opacity dan blur;
- guide interval;
- heat palette/preset jika tersedia.

Setiap perubahan overlay harus berdampak pada `doaGeometry.ts` dan renderer aktual, bukan hanya menambah input UI. Uji pan/zoom/resize, data update, koordinat datang terlambat, dan tile gagal.

### Simulasi

`frontend/src/lib/simulation.ts` membuat snapshot sintetis browser-only. Simulasi memiliki coordinate, canonical angle, angular vector 360 bin, freshness synthetic, randomize manual, dan randomize tiap satu detik.

Simulasi hanya menggantikan sumber Overview. Simulasi tidak boleh memalsukan System Health, Diagnostics, MQTT, publication gate, atau mengirim data ke Raspberry.

---

## 7. Cara menjalankan

Langkah lengkap per OS ada di `QUICKSTART.md`. Ringkasnya, dari root repository:

### Install dan validasi frontend

```bash
git submodule update --init --recursive   # hanya bila Receiver dipakai
cd frontend
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run build:all
```

`npm run build:all` menjalankan `npm run build` lalu `tools/build_browsdr_receiver.py`, dan menghasilkan `frontend/dist` beserta `frontend/dist/receiver`. `npm run build` saja mengosongkan `frontend/dist`, termasuk Receiver; tanpa submodule, pakai `npm run build` dan Receiver tidak tersedia.

### Menjalankan Ground Console

Gunakan virtual environment project dengan Python 3.9 atau lebih baru, bukan Python global. Console mengimpor `zoneinfo` saat start.

```bash
python3 -m venv .venv
.venv/bin/python -m pip install 'paho-mqtt==2.1.0'
.venv/bin/python tools/ground_console.py --bind 127.0.0.1 --port 8787
```

Default URL:

```text
http://127.0.0.1:8787/
```

Default CLI mengaktifkan monitor MQTT ke `10.90.0.1:9001` (WebSocket). Tanpa `paho-mqtt` console tetap berjalan dan monitor berstatus ERROR; `--mqtt-host ''` mematikan monitor. Flag eksplisit (`--base-url`, `--mqtt-host`, `--mqtt-port`, `--mqtt-transport`, `--mqtt-ws-path`) mengalahkan `console.json` tersimpan untuk run itu. Data Receiver disimpan di `--data-dir` (default `~/.local/share/sdr-doa-ground-console`). Di Windows, pasang juga `tzdata`.

Jangan memasang dependency ke Python system/Homebrew tanpa alasan. Development frontend saja:

```bash
cd frontend
npm run dev
```

Vite dev hanya untuk frontend; endpoint `/api` tetap membutuhkan Ground Console atau proxy yang sesuai.

### Validasi backend

```bash
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest discover -s tools -p 'test_*.py'
```

Untuk static serving/security saja:

```bash
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest tools.test_ground_console_static
```

Suite static gagal pada cek Receiver bila `frontend/dist` ada dan submodule sudah diambil tetapi `frontend/dist/receiver` tidak ada. Banyak file test Python adalah script standalone yang tidak dijalankan `unittest discover`; jalankan script modul yang diubah (misalnya `python3 tools/test_sdr_doa_collector.py`). Tes Node Receiver: `node --test tools/test_receiver_*.mjs` (Node 22.13+).

---

## 8. Aturan kerja untuk AI agent

### Sebelum mengedit

1. Baca `initialize.md` ini.
2. Baca file target dan test yang berkaitan.
3. Cari caller/interface sebelum mengubah contract.
4. Bedakan source live, fixture, synthetic simulation, dan browser-local setting.
5. Jangan menganggap dokumen historis sebagai bukti runtime terbaru.

### Saat mengedit

- Pilih perubahan kecil dan terlokalisasi.
- Pertahankan nama route, exported field, node/endpoint, dan schema yang sudah digunakan.
- Jangan menghapus freshness gate, publication gate, redaction, timeout, abort, CSP, atau subscriber-only guard.
- Jangan menambah library sebelum memastikan library belum tersedia dan kebutuhan tidak bisa dipenuhi oleh implementation yang ada.
- Untuk UI, setiap control harus benar-benar memengaruhi renderer atau dihapus.
- Untuk simulasi, beri label jelas `SIMULATION`; jangan mencampur synthetic dengan health/MQTT nyata.
- Untuk map, gunakan bahasa helper arah; jangan menyebut overlay sebagai target atau lokasi pemancar.
- Untuk settings remote, jangan mengubah dry-run menjadi command nyata tanpa requirement dan test baru.
- Jangan menyimpan secret/API key/password di repository atau Brain.

### Setelah mengedit

```bash
cd frontend
npm test
npm run check
npm run build:all

cd ..
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest discover -s tools -p 'test_*.py'
node --test tools/test_receiver_*.mjs   # bila kode Receiver berubah
git diff --check
```

Untuk perubahan UI, validasi browser bila tersedia: hard refresh production build; cek console/network/CSP; cek Overview no-data, stale, simulation ON/OFF, dan update; cek viewport laptop pendek/mobile; cek keyboard focus dan `prefers-reduced-motion`.

---

## 9. Failure modes yang pernah terjadi

### Monitor MQTT ERROR: `paho-mqtt is not installed`

Console tetap berjalan tanpa `paho-mqtt`, tetapi monitor MQTT tidak bisa tersambung. Jalankan dengan `.venv` project dan install `paho-mqtt==2.1.0` di environment tersebut. `ModuleNotFoundError: No module named 'paho'` dari synthetic publisher atau tes MQTT punya penyebab yang sama.

### Receiver menampilkan "Receiver is not built"

`npm run build` mengosongkan `frontend/dist/receiver`. Jalankan `npm run build:all`, atau `tools/build_browsdr_receiver.py` setelah `npm run build`.

### OSM/MapLibre basemap tidak muncul

MapLibre bukan tile provider. Periksa `connect-src`/`img-src` CSP, host tile, request Network, proxy, VPN, firewall, atau policy jaringan. Tile failure tidak otomatis berarti overlay gagal.

### Overlay ada di DOM tetapi tidak terlihat

Periksa berurutan: predikat kesiapan DoA (`doaReady`: DAQ, ADC overdrive, CONFLICT, view hilang, node beku); coordinate valid dan kamera sudah menuju coordinate; `angular_power_db` fresh dan panjang 360; geometry tidak kosong; visibility/opacity/paint; canvas berada di atas map dan mengikuti transform; map resize; localStorage setting versi lama.

### Grafik/overlay kembali ke awal saat data update

Update data harus memakai jalur update data (`restyle`/set data) dan tidak mengirim ulang layout/camera secara tidak perlu. State user seperti zoom, rotation, head-up, dan range manual harus dipisahkan dari data revision.

---

## 10. Urutan pembacaan yang disarankan

1. `initialize.md` ini.
2. `SUMMARY.md` bagian identitas, arsitektur, status tahapan, dan data contract.
3. `SDR_DOA_8081_DATA_REFERENCE.md` untuk payload Data Out.
4. `tools/sdr_doa_collector.py` dan test collectornya.
5. `frontend/src/types.ts`, `telemetry.ts`, dan `App.tsx`.
6. Modul target UI: `TacticalMap.tsx`, `PolarPlot.tsx`, `simulation.ts`, `doaGeometry.ts`.
7. `MAPLIBRE_DOA_OVERLAY_PLAN.md` dan `evaluasi GUI.md` (mulai dari bagian "Status saat ini") untuk riwayat keputusan visual/overlay.
8. `SDR_DOA_TELEMETRY_ARCHITECTURE_AND_SETTINGS_CONTROL.md` dan `BACKEND_PAYLOAD_PLAN.md` setelah memahami mana yang staging dan mana yang masih rancangan.

Jika dokumen bertentangan dengan kode/test aktif, jadikan **kode dan test aktif sebagai sumber kebenaran**, lalu perbarui dokumentasi stale setelah perubahan tervalidasi.