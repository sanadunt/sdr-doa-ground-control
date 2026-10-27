# Initialize Context — `doa-sdr-telemetry`

Dokumen ini adalah entrypoint untuk AI coding agent atau developer yang baru masuk ke repository. Baca sebelum mengubah kode. Isinya mencerminkan kondisi workspace saat ini, bukan janji fitur masa depan.

Bahasa kerja project: Bahasa Indonesia. Nama file, identifier, endpoint, schema, dan komentar teknis yang sudah memakai Bahasa Inggris dipertahankan.

---

## 1. Identitas dan tujuan sistem

Semua path dan perintah di dokumen ini relatif terhadap root repository (checkout `sdr-doa-ground-control`). Catatan historis lain di repo kadang masih memakai path `/Users/mac/...` dari mesin lain.

Project ini adalah **Ground Console lokal** untuk observasi SDR-DoA yang berjalan pada Raspberry Pi/UAV. Dashboard memakai MQTT RDF Node selama segar dan Data Out SDR-DoA sebagai cadangan; sistem memvalidasi freshness/health/consistency, menampilkan native CSV/XML secara terpisah, dan menyediakan monitor MQTT yang berlangganan. Satu-satunya penulisan jarak jauh adalah patch konfigurasi yang ditinjau dan dikonfirmasi admin di panel Kontrol.

Tujuan UI:

- melihat status sistem dan kualitas data;
- melihat DoA canonical serta angular power 360 bin;
- melihat station reference dan helper arah pada peta;
- menguji renderer dengan data simulasi tanpa perangkat SDR;
- mencoba perubahan konfigurasi secara lokal/dry-run;
- melihat spektrum RadioSpectrum (HackRF) lewat Receiver, mendengar VFO, dan menala dari dasbor;
- mengirim patch konfigurasi ke RDF-SDR (node Raspberry) hanya lewat Kontrol, dengan login admin, tinjauan, dan konfirmasi eksplisit, dan meminta settings RDF-SDR (`config.get`) dari Kontrol yang sama; selain itu tidak ada command remote.

### Batas keamanan dan interpretasi

- Ground Console adalah **local/loopback console**.
- Data Out dibaca melalui HTTP `GET` bounded; jangan mengubah read path menjadi remote mutation.
- MQTT monitor hanya berlangganan dan tidak pernah publish sendiri. Satu-satunya publish console adalah perintah RDF Node dari Kontrol dalam format edge (`docs/MQTT_KONTRAK.md` bagian 9): `config.patch` (`POST /api/mqtt/config-patch` ke `sdr/v2/uav-01/cmd/config/patch`) dan `config.get` (`POST /api/mqtt/config-get` ke `sdr/v2/uav-01/cmd/config/get`). Aturannya jangan dilonggarkan:
  - server hanya bind ke loopback, dan request wajib membawa header `Origin` same-origin loopback dengan port yang sama;
  - wajib sesi admin, dan untuk patch `confirm: true` hanya dikirim setelah langkah tinjauan di UI;
  - envelope dibuat server (`tools/rdf_node_commands.py`), field dan aturan edge diperiksa di server, patch butuh health RDF-SDR yang segar, dan `base_rev` yang ditinjau harus sama dengan `state.cfg` RDF-SDR;
  - QoS 1, tidak retained, kedaluwarsa 15 detik; hanya satu patch yang boleh menunggu hasil; tidak ada kirim ulang otomatis; publish hanya saat monitor terhubung;
  - tidak ada MQTT di browser dan tidak ada credential MQTT di console.

  RDF Node di Raspberry yang memutuskan menerapkan patch, lalu menjawab di `ack/config`. Console sendiri tidak pernah memublikasikan bearing DoA.
- Form Konfigurasi tetap local configuration atau dry-run. Jangan menambah jalur penulisan jarak jauh lain.
- Raw secret, token, credential, raw settings sensitif, raw IQ, dan raw log tidak boleh diteruskan ke browser/MQTT.
- Publication gate tetap eksplisit. Health/observability bukan berarti DoA siap dipublikasikan.
- Overlay map dan simulasi adalah **direction helper/visualisasi**, bukan lokasi target, jarak target, RF coverage, atau estimasi lokasi pemancar.

---

## 2. Status implementasi saat ini

### Sudah tersedia

- Python Ground Console pada `tools/ground_console.py`.
- React + TypeScript + Vite frontend pada `frontend/`.
- Tujuh halaman, berurutan: Dashboard (`#/dashboard`; `#/overview` tetap dibuka), Receiver, System Health, DoA Diagnostics, Configuration, Message Monitor, dan Simulasi, dibuka lewat menu halaman di top bar atau shortcut keyboard `1`–`7` sesuai urutan itu (Receiver `2`); `R` untuk refresh. Top bar yang sama ada di semua halaman. Halaman selain Dashboard dan Receiver memakai page kit yang sama (`frontend/src/components/page/`, `frontend/src/page-kit.css`).
- Dashboard (route id `overview`) berupa dasbor peta penuh: HUD bearing, kartu node, panel Lapisan, panel Kontrol, dan dock bawah berisi Polar (dengan pengaturan Atur) dan Spektrum. Panel diaktifkan lewat tombol Lapisan, Polar, Spektrum, dan Kontrol di top bar. HUD bearing, polar, dan overlay peta memakai satu predikat kesiapan (`overviewDoaStatus()` di `frontend/src/lib/doaStatus.ts`), sehingga DAQ gagal, ADC overdrive, CONFLICT, view hilang, atau node beku menyembunyikan ketiganya sekaligus.
- Bearing geografis dihitung dari θ₀ dengan `geographicBearingForBin()` (`frontend/src/lib/polar.ts`): (360 − θ₀ + compass_offset) mod 360. θ₀ tetap ditampilkan sebagai sudut array.
- Plot DoA menggunakan bundle Plotly parsial (`plotly.js/lib/core` + `lib/scatterpolar`, didaftarkan di `frontend/src/lib/plotlyPolar.ts`) dan update data mempertahankan camera state selama memungkinkan.
- Map menggunakan MapLibre GL JS dengan delapan gaya peta dasar (`frontend/src/lib/basemaps.ts`: Standar, Hot, Terang, Gelap, Satelit, Satelit + label, Topografi, Polos). Semua tile diambil lewat route console `/api/tiles/<sumber>/<z>/<x>/<y>` (`tools/tile_cache.py`), yang menyimpan tile di disk sehingga area yang pernah tampil tetap terlihat saat offline.
- DoA map overlay: station marker, bearing, lobe, guide angle, dan heat-style direction helper.
- Canvas fallback overlay menjaga visualisasi DoA tetap terlihat jika WebGL2 tidak tersedia, context WebGL hilang, worker MapLibre gagal, atau layer GeoJSON bermasalah.
- Overlay settings tersimpan lokal. Panel Lapisan berisi tujuh sakelar layer dan opasitas overlay, dan bagian Lanjutan berisi kontrol advanced untuk jarak/radius, min/max dB, threshold, contrast/intensity, radial samples, distance falloff, opacity, blur, guide interval, dan palette.
- Marker station interaktif dan dapat membuka popup detail.
- Tab `Simulasi`: lokasi, sudut DoA, lebar lobe, randomize manual, randomize otomatis.
- Halaman System Health (termasuk tabel pembacaan per resource), DoA Diagnostics, Configuration, dan Message Monitor (MQTT: tampilan RDF Node dan kartu koneksi, tanpa sakelar keluarga topik).
- Collector mendeteksi node beku (`NODE_CLOCK_STALLED`), membatasi satu koleksi dengan anggaran waktu (4 detik untuk `/api/snapshot`), dan membandingkan sudut CSV/XML hanya untuk pasangan dari frame yang sama.
- Console membaca Data Out satu kali per interval refresh untuk semua penampil (`tools/data_out_reader.py`) dan memakai ulang `settings.json` paling lama 30 detik; umur data di browser dihitung sejak node dibaca.
- MQTT dulu, Data Out cadangan (`tools/telemetry_source.py`, `docs/MQTT_KONTRAK.md` bagian 8): selama health RDF Node lewat MQTT segar (8 detik, `daq=1`) jawaban `/api/snapshot` dibangun dari DoA LIVE dan Angular LIVE MQTT, Data Out hanya dibaca ringan (`status.json`, `settings.json`, `doa.xml`) tiap 30 detik, dan chip SUMBER di strip status serta badge di HUD menyebut sumbernya. DoA yang UNVERIFIED tidak pernah tampil sebagai bearing.
- Freshness expiry di renderer browser; snapshot stale tidak boleh terus ditampilkan sebagai data aktif. Refresh otomatis default 2 detik (pilihan 1, 2, 5, 10, 30 detik atau manual).
- Receiver embedded (BrowSDR dari submodule `vendor/BrowSDR`, dengan overlay di `tools/browsdr_receiver_overlay/`) untuk spektrum, scan, rekaman audio, dan Records yang disimpan lokal. Panel Spektrum di Dashboard mengendalikan frame Receiver yang tersembunyi lewat bridge `postMessage` (Mulai/Berhenti, Dengar dengan modulasi, klik untuk menala, Ikuti frekuensi node, Skala dB RX, sample rate, LNA, VGA, +14 dB, mode RX | Spektrum untuk pindai lebar, dan Penanda).
- Kontrol: perintah RDF Node yang dibatasi admin (`config.patch`, `config.get`), dengan pelacakan ACK dan `settings/reported` di server (`tools/config_command_tracker.py`).
- Branding lokal dan konfigurasi console lokal.
- Pengaturan tersimpan di server console: koneksi/MQTT/interval di `console.json`, branding, preferensi tampilan browser di `preferences.json` (`GET`/`PUT /api/preferences`, `tools/preferences_store.py`, `frontend/src/lib/preferenceStore.ts`), rekaman Receiver, dan `.env`. Start pertama membuat `console.json` dari `SDR_DOA_SEED_*`. `GET /api/health` untuk healthcheck; versi dari file `VERSION`.
- Paket Linux: image Docker (`Dockerfile`, `Dockerfile.release`, `docker-compose*.yml`, network host), rilis tar (`tools/make_release.py`), dan installer console dengan systemd user service (`packaging/console/`). Sejak 3.0.0 repository ini tidak lagi membawa agent RDF-SDR; Raspberry menjalankan RDF Node edge dari `sanadunt/rdf-indicator-raspberry` (`CHANGELOG.md`). Lihat QUICKSTART bagian Instalasi Linux.

### Staging/rancangan—jangan dianggap production

- Telemetry nyata melalui PPP/T900 belum dianggap lulus hanya karena adapter staging tersedia.
- Publication gate live terakhir dilaporkan `DEGRADED/BLOCKED` pada dokumentasi baseline karena `daq_ok=false`, sinkronisasi IQ/sample-delay gagal, atau output DoA stale.
- Kontrol mengirim patch konfigurasi nyata dan membaca ACK. Tes otomatisnya memakai fake monitor, client MQTT palsu, dan envelope yang dinilai kode edge RDF Node sendiri (`tools/fixtures/rdf-node/commands.json`); repo ini tidak membuktikan alur end-to-end dengan Raspberry nyata. `APPLIED` hanya membuktikan RDF Node menulis `settings.json` dan melihat bukti runtime; `PERSISTED_UNVERIFIED` dan `OUTCOME_UNKNOWN` bukan berhasil dan bukan gagal. ACK/read-back production dan deployment PPP/T900 belum dianggap lulus.
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
        └── RDF Node edge (repo sanadunt/rdf-indicator-raspberry) / MQTT sdr/v2/uav-01
                 │ health + freshness + authority + redaction
                 ▼
Ground Console Python (loopback)
        │
        ├── /api/snapshot?base_url=...
        ├── /api/capabilities
        ├── /api/console-config
        ├── /api/branding, /api/admin/*
        ├── /api/mqtt, /api/mqtt/connect, /api/mqtt/rdf-node
        ├── /api/mqtt/config-reported, /api/mqtt/config-patch[/<id>], /api/mqtt/config-get   (Kontrol, admin)
        ├── /api/dry-run/config-patch
        ├── /api/receiver/*   (SQLite + file audio di --data-dir)
        └── /receiver/        (build BrowSDR, static root terpisah)
                 │ same-origin fetch
                 ▼
React frontend
        ├── Dashboard (OverviewPage): dasbor MapLibre/OSM + DoA overlay + Plotly polar + Spektrum + Kontrol
        ├── Receiver (iframe /receiver/, dimuat saat dibuka pertama kali atau saat Mulai/Dengar
        │             di Spektrum, lalu tetap ter-mount; bridge postMessage ke Dashboard)
        ├── System Health
        ├── DoA Diagnostics
        ├── Configuration
        ├── Message Monitor
        └── Simulasi (browser-only)
```

Jalur Kontrol:

```text
Kontrol (admin) → POST /api/mqtt/config-patch | config-get → envelope edge → monitor MQTT
        → sdr/v2/uav-01/cmd/config/patch | cmd/config/get → RDF Node di Raspberry
        → ack/config, settings/reported → status perintah di server → Kontrol
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
| `tools/ground_console.py` | HTTP Ground Console, API lokal, static frontend serving, CSP, config/branding/admin lokal, route perintah Kontrol (`config.patch`, `config.get`) |
| `tools/sdr_doa_collector.py` | Collector read-only, parsing terbatas, redaction, freshness, candidate, gate |
| `tools/telemetry_source.py`, `tools/data_out_reader.py` | Sumber `/api/snapshot`: MQTT dulu, Data Out (cadangan) bila MQTT tidak segar; satu pembacaan Data Out bersama untuk semua penampil |
| `tools/sdr_doa_mqtt_monitor.py` | MQTT monitor; berlangganan, dan hanya publish perintah RDF Node dari Kontrol lewat `publish_rdf_node_command`. Memerlukan `paho-mqtt` (tanpa paket ini monitor berstatus ERROR, console tetap jalan) |
| `tools/rdf_node_mqtt_v2.py` | Parser kontrak MQTT RDF Node (`docs/MQTT_KONTRAK.md`), node view, dan snapshot untuk `/api/mqtt/rdf-node` |
| `tools/receiver_record_store.py` | Store SQLite dan file audio Receiver di bawah `--data-dir` |
| `tools/preferences_store.py` | Salinan preferensi browser di server (allowlist key, batas ukuran, tulis atomik) untuk `/api/preferences` |
| `tools/tile_cache.py` | Cache tile basemap untuk `/api/tiles`: upstream tetap (HTTPS, maksimal dua host per sumber), cache disk LRU, sajian stale saat offline |
| `tools/make_release.py` | Membuat tarball rilis console, `sdr-doa-docker`, dan `SHA256SUMS`; juga `--stage-console` untuk Docker dan installer |
| `packaging/`, `Dockerfile*`, `docker-compose*.yml`, `VERSION`, `CHANGELOG.md` | Docker, installer native, systemd unit, versi rilis, dan catatan tiap rilis |
| `tools/build_browsdr_receiver.py` | Builder Receiver: salin submodule, terapkan overlay, `npm ci` + build, tulis `frontend/dist/receiver` |
| `tools/browsdr_receiver_overlay/` | Perubahan lokal Receiver yang diterapkan saat build; `vendor/BrowSDR` tidak diedit |
| `tools/fixtures/` | Fixture valid, stale, unhealthy, malformed, missing-status, conflict, partial, nonfinite, dan peak-mismatch |

### Frontend

| Path | Peran |
|---|---|
| `frontend/src/App.tsx` | Route, lifecycle snapshot/config/MQTT, simulation state, freshness expiry, page composition |
| `frontend/src/api.ts` | Same-origin API adapter dengan timeout, abort, validasi shape, dan read-back |
| `frontend/src/types.ts` | Contract TypeScript untuk snapshot, candidate, gate, config, map, MQTT |
| `frontend/src/components/Shell.tsx` | Top bar, menu halaman, route, runtime badges, theme, read strip, interval refresh |
| `frontend/src/components/TacticalMap.tsx` | MapLibre, layer raster peta dasar dan penggantiannya, marker, popup, overlay settings, overlay lifecycle |
| `frontend/src/lib/basemaps.ts`, `frontend/src/components/overview/BasemapPicker.tsx` | Katalog gaya peta dasar (sumber tile, maxzoom, paint raster, atribusi) dan menu/select pemilihnya |
| `frontend/src/pages/OverviewPage.tsx`, `frontend/src/components/overview/` | Dasbor Overview: kartu node, Lapisan, Kontrol (`ControlPanel.tsx`), dock Polar (`PolarDock.tsx`) dan Spektrum (`SpectrumDock.tsx`) |
| `frontend/src/components/PolarPlot.tsx` | Plotly polar/compass renderer, camera state, head-up, manual dB range |
| `frontend/src/lib/telemetry.ts` | Candidate selection, data state, formatting, gate helpers |
| `frontend/src/lib/doaStatus.ts` | Predikat kesiapan DoA bersama untuk readout, polar, dan peta |
| `frontend/src/lib/mqttMonitor.ts` | Normalisasi status MQTT (`/api/mqtt`: koneksi, root topik, hitungan pesan) dan snapshot RDF Node |
| `frontend/src/pages/ReceiverPage.tsx` | Host iframe Receiver, sinkron tema/bahasa, penerusan shortcut, menyambungkan bridge ke frame |
| `frontend/src/lib/receiverBridge.ts`, `receiverBridgeProtocol.ts` | Sisi console bridge Receiver; salinan protokol sisi frame ada di `tools/browsdr_receiver_overlay/src/client/app/console-bridge-protocol.ts` |
| `frontend/src/lib/configPatch.ts` | Field edge, satuan, rentang, tabel gain, hasil ACK, dan kode error perintah Kontrol |
| `tools/rdf_node_commands.py`, `tools/config_command_tracker.py` | Envelope perintah RDF Node dan aturan field edge; status tiap perintah Kontrol di server |
| `frontend/scripts/build-receiver.mjs` | Menjalankan builder Receiver untuk `npm run build:receiver` dan `build:all` |
| `frontend/src/lib/simulation.ts` | Synthetic 360-bin snapshot, validation, randomization |
| `frontend/src/lib/doaGeometry.ts` | Geometry bearing/lobe/heat/guides dari coordinate + vector + settings |
| `frontend/src/lib/mapOverlaySettings.ts` | Default, validation, persistence, preset overlay settings |
| `frontend/src/lib/map.ts` | GPS source resolution, fallback coordinate, posisi live terakhir, kesehatan basemap, warna garis sesuai tone tile |
| `frontend/src/lib/polar.ts` | Angle convention, bearing geografis, polar metadata, source conversion |
| `frontend/src/pages/` | Overview, health, diagnostics, configuration, monitor, simulation, receiver |
| `frontend/src/console-design.css` | Design layer Ground Console dan responsive/accessibility rules |
| `frontend/src/polar-layout.css` | Plotly layout/controls |
| `frontend/src/overview-dashboard.css` | Layout dasbor Overview (`.ov-*`), dimuat setelah `polar-layout.css` |

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

### MapLibre dan peta dasar

MapLibre adalah renderer, bukan penyedia peta. Gaya peta dasar ada di `frontend/src/lib/basemaps.ts`; semuanya menggambar tile dari route console `/api/tiles/<sumber>/<z>/<x>/<y>`, sehingga `img-src`/`connect-src` di CSP halaman tidak berisi host tile mana pun. Upstream tiap sumber (`osm`, `hot`, `imagery`, `imagery-labels`, `topo`) tetap di `TILE_SOURCES` pada `tools/tile_cache.py`: HTTPS, maksimal dua host yang dicoba satu per satu (OSM: `tile.openstreetmap.de` lalu `tile.openstreetmap.org`), tanpa redirect, timeout 5 s, isi maksimal 1 MiB dan hanya PNG/JPEG/WebP. Id dan maxzoom kedua daftar harus sama (`tools/test_basemap_contract.py`). Terang dan Gelap adalah tile Standar dengan paint raster MapLibre.

Ganti gaya hanya menukar source dan layer raster di bawah `doa-beam`; `map.setStyle()` tidak pernah dipakai karena akan menghapus data GeoJSON dan paint runtime. Cache tile disimpan di `--tile-cache-dir` dan segar selama max(max-age upstream, 7 hari), paling lama 30 hari; saat upstream tidak terjangkau tile lama tetap disajikan, dan tile yang belum tersimpan dijawab 504. Tidak ada prefetch atau unduh massal.

Jika basemap gagal, cek log console (`tiles <sumber>: upstream unavailable`), koneksi HTTPS dari host console ke upstream, proxy (`HTTPS_PROXY`), VPN, firewall, dan apakah `--tile-cache-dir` bisa ditulis. Jangan menghapus overlay hanya karena tile gagal.

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

Simulasi hanya menggantikan sumber Dashboard. Simulasi tidak boleh memalsukan System Health, Diagnostics, MQTT, publication gate, atau mengirim data ke Raspberry.

### Dasbor: Spektrum, Dengar dan Kontrol

Dashboard adalah dasbor peta penuh. Langkah operator yang lebih rinci ada di `QUICKSTART.md`. Di UI, node Raspberry tampil sebagai **RDF-SDR** dan receiver HackRF sebagai **RadioSpectrum**; identifier, field API, topik MQTT, dan filter WebUSB tetap memakai nama teknisnya. Dasbor hanya menampilkan label, nilai, chip status, error, dan prompt yang butuh tindakan, tanpa teks penjelasan kecil. Ringkasnya:

- **Panel.** Tombol Lapisan, Polar, Spektrum, dan Kontrol di top bar menampilkan atau menyembunyikan panel. Secara bawaan Polar dan Spektrum aktif. Pilihan panel disimpan di console (`/api/preferences`), jadi ikut ke browser lain.
- **Mulai/Berhenti.** Mulai memuat Receiver tersembunyi (saat pertama kali), menyambungkan RadioSpectrum yang sudah dipasangkan ke browser ini, dan menjalankan RX tanpa suara. Spektrum menampilkan 2 MHz di sekitar tengah RX. RadioSpectrum yang belum pernah dipasangkan (`NEEDS_PAIRING`) dipasangkan sekali di halaman Receiver (tombol `2`). Berhenti menghentikan RX.
- **Klik untuk menala.** Klik trace atau waterfall untuk memindahkan tengah RX dan VFO ke frekuensi itu (dibulatkan 1 kHz); ←/→ menggeser 10 kHz, Shift+←/→ 100 kHz. Klik ini mematikan Ikuti frekuensi node. Tengah dan VFO dipegang Receiver dan sinkron dua arah: perubahan di halaman Receiver tampil di Spektrum dan juga mematikan Ikuti frekuensi node.
- **Ikuti frekuensi node.** Selama data node segar, tengah RX mengikuti `center_freq` dari `settings.json` node dan VFO mengikuti frekuensi DoA (CSV Data Out, atau DoA LIVE lewat MQTT).
- **Dengar dengan modulasi.** Dengar memutar audio VFO dengan modulasi yang dipilih (NFM bawaan, WFM, AM, USB, LSB, DSB, CW, RAW), dan menyalakan RX bila belum jalan. Tekan lagi untuk berhenti mendengar.
- **Kirim ke RDF-SDR → Kontrol.** Tombol di header Spektrum hanya membuka Kontrol dengan draf: frekuensi VFO yang didengar sebagai frekuensi tengah dan VFO 0. Di Kontrol: buka kunci dengan kata sandi admin, **Baca settings** bila perlu, ubah nilai, **Tinjau perubahan**, lalu **Kirim ke RDF-SDR**. Hasilnya `ACK · APPLIED` (satu-satunya berhasil), `ACK · PERSISTED_UNVERIFIED` atau `OUTCOME_UNKNOWN` (bukan berhasil dan bukan gagal), `Ditolak · REJECTED · KODE` (misalnya `CONFIG_REVISION_CONFLICT` atau `BUSY`), **Belum ada ACK** setelah sekitar 20 detik, atau **Publish gagal** bila broker menolak.
- **Spektrum → Atur.** Kolom pengaturan Spektrum. Pada dock yang lebih sempit dari 1400 px, Ikuti frekuensi node, modulasi, dan Kirim ke RDF-SDR pindah dari header ke kolom ini. **Skala dB** (Auto atau Manual dengan min dan maks, −160 s/d 60 dB, selisih minimal 5 dB) sama dengan panel Skala dB di tab Dengar halaman Receiver dan sinkron dua arah; trace dan seluruh waterfall diwarnai ulang. Skala terakhir yang diketahui dock disimpan di console (`sdr-console-spectrum-dock-v1`). **Sample rate**, **LNA**, **VGA**, dan **+14 dB** adalah pengaturan Listener Receiver dan sinkron dua arah; gain berlaku langsung, sample rate memulai ulang RX yang sedang jalan (ditanyakan dulu bila rekaman VFO berjalan, ditolak selama pindai). Sebelum Receiver dimuat isian ini nonaktif dengan `—`.
- **RX | Spektrum.** Sakelar setelah chip Spektrum memilih isi grafik dan apa yang dijalankan Mulai: RX (2 MHz di sekitar tengah RX) atau pindai lebar Receiver di rentangnya sendiri. Dock menampilkan mode yang sedang berjalan, termasuk pindai yang dimulai di halaman Receiver (chip `SCAN` dengan grafik hidup; `BUSY` hanya untuk dengar-pindai). Pada mode Spektrum, klik grafik menyimpan tengah dan VFO untuk RX berikutnya tanpa menghentikan pindai, dan Dengar menghentikan pindai lalu menjalankan RX. Di Atur, mode Spektrum menampilkan Skala dB pindai (Manual = Grafik min./maks. halaman Receiver, sinkron dua arah), Rentang dengan Pusatkan ke RX, Resolusi, dan Gain pindai; isian pindai terkunci selama pindai berjalan, sama seperti di halaman Receiver.
- **Penanda.** Tombol setelah sakelar RX | Spektrum menyalakan mode menandai (tidak disimpan; mati setiap kali dock dibuka). Penandanya adalah daftar Penanda spektrum Receiver: tampil di dock (trace dan waterfall, kedua mode), di grafik Spektrum dan trace Dengar halaman Receiver, dan sinkron dua arah. Klik grafik menambah penanda, klik dekat penanda memilihnya (Hapus, Tala ke sini); Enter, `[` `]`, Delete, Ctrl+Z, dan Esc bekerja pada grafik. Menandai juga bisa selama pindai, dengan daya diukur dari pindai itu. Penanda tersimpan hanya bila marker set dipilih di halaman Receiver (tag **Belum disimpan** bila belum).
- **Polar → Atur.** Putar grafik (Head Up) dan Puncak ke atas, offset kompas Data Out atau Manual (berlaku untuk peta, plot, dan bearing), skala dB Auto atau Manual, dan tombol reset tampilan. Pilihan Kompas|Polar hanya mengubah plot.
- **Lapisan.** Tujuh sakelar layer overlay, opasitas overlay, dan pengaturan Lanjutan.

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

Kata sandi admin dibaca dari `SDR_DOA_ADMIN_PASSWORD` di environment proses atau di `.env` root repository (salin dari `.env.example`, ganti nilainya, jangan di-commit). Bila variabel tidak ada di keduanya, console memakai kata sandi bawaan `123456`, mencetak peringatan saat start, dan Kontrol menampilkan peringatan; ganti dengan kata sandi sendiri. Nilai kosong (`SDR_DOA_ADMIN_PASSWORD=`) menonaktifkan login admin, begitu juga `.env` yang tidak bisa dibaca. Perubahan kata sandi berlaku setelah console di-restart.

Default CLI mengaktifkan monitor MQTT ke `10.90.0.1:9001` (WebSocket). Tanpa `paho-mqtt` console tetap berjalan dan monitor berstatus ERROR; `--mqtt-host ''` mematikan monitor. Flag eksplisit (`--base-url`, `--mqtt-host`, `--mqtt-port`, `--mqtt-transport`, `--mqtt-ws-path`) mengalahkan `console.json` tersimpan untuk run itu; host `--base-url` harus ada di daftar host Data Out (cadangan) tersimpan (`data_out_hosts`, diubah di Konfigurasi), port selalu 8081. Data Receiver disimpan di `--data-dir` (default `~/.local/share/sdr-doa-ground-console`). Cache tile peta dasar disimpan di `--tile-cache-dir` (default `~/.cache/sdr-doa-ground-console/tiles`, paling banyak `--tile-cache-max-mb`, bawaan 512 MB). Preferensi browser disimpan di `--preferences-path` (default `~/.config/sdr-doa-ground-console/preferences.json`), dan `--env-file` memilih file `.env` lain untuk kata sandi admin dan `SDR_DOA_SEED_*`. Bila `console.json` belum ada, start pertama membuatnya dari `SDR_DOA_SEED_*` dan menyimpannya; start berikutnya mengabaikan seed. Karena flag eksplisit hanya berlaku untuk satu run, service dan container tidak memakainya. Di Windows, pasang juga `tzdata`. Untuk instalasi Linux di background (Docker atau `install.sh`) dan agent RDF-SDR, lihat `QUICKSTART.md` dan `packaging/`.

Jangan memasang dependency ke Python system/Homebrew tanpa alasan. Development frontend saja:

```bash
cd frontend
npm run dev
```

Vite dev hanya untuk frontend; endpoint `/api` tetap membutuhkan Ground Console atau proxy yang sesuai.

### Setelah `git pull`

`frontend/dist` tidak ikut diperbarui oleh `git pull`; tanpa build ulang, console menyajikan UI lama. Build ulang lalu restart console:

```bash
git submodule update --init --recursive   # bila Receiver dipakai
cd frontend && npm ci && npm run build:all
```

Tanpa submodule Receiver, ganti `npm run build:all` dengan `npm run build`. Setelah itu hentikan console yang berjalan, jalankan lagi, dan muat ulang halaman browser.

### Validasi backend

```bash
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest discover -s tools -p 'test_*.py'
```

Untuk static serving/security saja:

```bash
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest tools.test_ground_console_static
```

Suite static gagal pada cek Receiver bila `frontend/dist` ada dan submodule sudah diambil tetapi `frontend/dist/receiver` tidak ada. Banyak file test Python adalah script standalone yang tidak dijalankan `unittest discover`; jalankan script modul yang diubah (misalnya `python3 tools/test_sdr_doa_collector.py`). Tes Node Receiver: `node --test tools/test_receiver_*.mjs` (Node 22.13+), termasuk bridge dasbor (`test_receiver_console_bridge.mjs`) dan kecocokan dua salinan protokolnya (`test_receiver_bridge_contract.mjs`). Jalur Kontrol dicakup `tools/test_mqtt_config_patch.py` dan `tools/test_config_patch_contract.py`; keduanya ikut `unittest discover` dan tidak butuh broker. Cache tile dicakup `tools/test_tile_cache.py` (upstream palsu di loopback lewat constructor `GroundConsoleServer`) dan kecocokan katalog peta dasar dengan cache oleh `tools/test_basemap_contract.py`; keduanya juga ikut `unittest discover`.

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
- Jangan menghapus freshness gate, publication gate, redaction, timeout, abort, CSP, atau aturan jalur publish Kontrol (lihat bagian 1). Monitor MQTT tidak boleh publish sendiri.
- Jangan menambah library sebelum memastikan library belum tersedia dan kebutuhan tidak bisa dipenuhi oleh implementation yang ada.
- Untuk UI, setiap control harus benar-benar memengaruhi renderer atau dihapus.
- Untuk simulasi, beri label jelas `SIMULATION`; jangan mencampur synthetic dengan health/MQTT nyata.
- Untuk map, gunakan bahasa helper arah; jangan menyebut overlay sebagai target atau lokasi pemancar.
- Untuk settings remote, form dry-run di Konfigurasi tetap pratinjau. Kontrol adalah satu-satunya command nyata; jangan menambah jalur penulisan jarak jauh lain atau melonggarkan aturannya tanpa requirement dan test baru.
- Setiap prop yang diteruskan `App.tsx` ke `OverviewPage` (yang di-memo) harus stabil: state, `useCallback`, atau ref. Frame Receiver jangan dipindah atau diberi `key`, karena frame akan reload dan RX berhenti.
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

Untuk perubahan UI, validasi browser bila tersedia: hard refresh production build; cek console/network/CSP; cek Dashboard no-data, stale, simulation ON/OFF, dan update; cek viewport laptop pendek/mobile; cek keyboard focus dan `prefers-reduced-motion`.

---

## 9. Failure modes yang pernah terjadi

### Monitor MQTT ERROR: `paho-mqtt is not installed`

Console tetap berjalan tanpa `paho-mqtt`, tetapi monitor MQTT tidak bisa tersambung. Jalankan dengan `.venv` project dan install `paho-mqtt==2.1.0` di environment tersebut. `ModuleNotFoundError: No module named 'paho'` dari tes MQTT punya penyebab yang sama.

### Receiver menampilkan "Receiver is not built"

`npm run build` mengosongkan `frontend/dist/receiver`. Jalankan `npm run build:all`, atau `tools/build_browsdr_receiver.py` setelah `npm run build`. Panel Spektrum di Dashboard menampilkan `NOT BUILT` untuk penyebab yang sama.

### UI masih versi lama setelah `git pull`

`frontend/dist` belum di-build ulang (misalnya masih ada menu samping dan Dashboard belum berupa dasbor). Jalankan `cd frontend && npm ci && npm run build:all`, lalu restart console.

### Kontrol tidak mendapat jawaban

- **Belum ada ACK** sekitar 20 detik setelah kirim: RDF Node di Raspberry tidak berjalan atau memakai broker lain. Agent RDF-SDR dari console 2.x memakai topik lama dan tidak menjawab Kontrol; hapus bila masih terpasang (runbook 10.3).
- Kirim nonaktif, `NODE_SESSION_UNAVAILABLE`, `CONFIG_REVISION_UNKNOWN` atau `NODE_NOT_FRESH`: belum ada `state` RDF Node sejak monitor tersambung, `state.cfg` kosong, atau `telemetry/health` lebih tua dari 8 detik.
- `TLS_REQUIRED_FOR_SETTINGS_REPORT` setelah **Baca settings**: RDF-SDR tersambung ke broker tanpa TLS, jadi tidak mengirim `settings/reported`; nilai diambil dari Data Out (cadangan).
- `Ditolak · REJECTED · CONFIG_REVISION_CONFLICT` atau `BUSY`: pengirim lain (misalnya `rdf-ground.service`) mengubah settings atau sedang mengirim perintah. Baca ulang nilai lalu tinjau; satu pengendali sekaligus.
- **Publish gagal** (PUBACK 128 ke atas): ACL broker tidak mengizinkan console publish ke `sdr/v2/uav-01/cmd/config/patch` atau `cmd/config/get`.
- Monitor console tidak memakai TLS atau password, jadi broker yang mewajibkannya untuk semua klien tidak bisa dipakai console; pakai `tools/mqtt_stage4.conf` untuk uji lokal.

### Basemap MapLibre tidak muncul

MapLibre bukan tile provider. Tile datang dari `/api/tiles` di console; periksa log console, `X-Tile-Cache` pada response tile (hit, miss, stale; 504 berarti belum tersimpan dan upstream tidak terjangkau), koneksi HTTPS host console ke upstream di `tools/tile_cache.py`, proxy, VPN, firewall, dan izin tulis `--tile-cache-dir`. Tile failure tidak otomatis berarti overlay gagal.

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