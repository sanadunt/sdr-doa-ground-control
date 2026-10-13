> Arsip audit-006. Bagian 1–6 di bawah adalah teks laporan audit fungsional 2026-10-12 yang disalin utuh, termasuk nomor baris dan commit (`c474aa8`) yang dirujuknya. Bagian 7 ditambahkan 2026-10-13 dan mencatat status perbaikan per temuan.

# Laporan Audit Fungsional SDR-DoA Ground Console

- Tanggal: 2026-10-12
- Repositori: `/home/user/sdr-doa-ground-control` (commit `c474aa8`)
- Fokus: perilaku aplikasi saat dipakai operator. Keamanan dikecualikan atas permintaan pengguna.

## 1. Cakupan dan metode

### Area yang diperiksa

- Collector Data Out (`tools/sdr_doa_collector.py`): parsing, freshness, konsistensi CSV/XML, publication gate.
- Server console dan API (`tools/ground_console.py`): `/api/snapshot`, konfigurasi, branding/admin, dry-run, legacy UI, static serving, `/api/receiver/*`.
- Kontrak data: collector ke frontend (`types.ts`, `telemetry.ts`, `polar.ts`, `map.ts`) dan kontrak MQTT (`sdr_doa_mqtt.py`).
- Frontend React: state dan freshness (`App.tsx`, `Shell.tsx`), peta MapLibre (`TacticalMap.tsx`, `doaGeometry.ts`), polar Plotly (`PolarPlot.tsx`, `PolarPanel.tsx`, `DoaReadout.tsx`), halaman Health, Diagnostics, Configuration, Message Monitor, Simulation.
- MQTT monitor (`sdr_doa_mqtt_monitor.py`) dan edge agent staging (`sdr_doa_lan_agent.py`, `sdr_doa_mqtt_stdlib.py`).
- Receiver (BrowSDR embedded): store (`tools/receiver_record_store.py`), sweep/scan, UI, rekaman audio, Records (overlay di `tools/browsdr_receiver_overlay/src/` dan patch builder).
- Dokumentasi (QUICKSTART, initialize.md, AGENTS.md/CLAUDE.md, SDR_DOA_FRONTEND_WORKFLOW.md, evaluasi GUI.md, rencana MapLibre) dan laporan audit anti-slop 001–005.
- Performa dan pemakaian jangka panjang.

### Pengujian langsung yang dijalankan

- **API E2E dengan fixture.** `GroundConsoleServer` in-process dengan fetcher Data Out palsu (port 8081 tidak pernah dipakai). Kedelapan family fixture (valid, stale, unhealthy, malformed, nonfinite, missing-status, conflict, partial) dipoll lewat HTTP nyata, ditambah varian: wrap 0/360, batas toleransi sudut tepat 1,0°, jendela umur 5 s dan 2 s, future skew, sudut ROOT-MUSIC di luar rentang, frame bersebelahan dengan bearing bergerak (120 poll), `settings.json` 404/500/terpotong, `doa.xml` 404, status gagal dengan offset jam node −2 jam/+30 s, body terpotong, baris status non-HTTP.
- **Browser E2E console.** Playwright Chromium headless (WebGL SwiftShader) terhadap `frontend/dist` yang dilayani `ground_console.py`. Semua route pada 320–1440 px, tema gelap/terang, EN/ID, simulasi ON/OFF, Data Out dan console dimatikan lalu dinyalakan lagi, tile OSM diblokir, worker MapLibre 404, WebGL context loss/restore, Plotly modebar, shortcut keyboard, 30 siklus route.
- **Browser E2E Receiver dengan Mock SDR.** Scan simulasi, kandidat, waterfall, Connect Mock SDR, Listen dari kandidat, rekaman VFO (dua segmen, audio Opus ter-decode tidak hening), Records, marker set, ekspor JSON/CSV, bookmark, restart server saat scan arsip dan saat rekaman, font eksternal yang macet, browser tanpa WebUSB, layout 390–1440 px.
- **Pengukuran performa.** First load pada CPU 1x dan 4x throttle, biaya main thread per update, heap setelah forced GC selama 14 menit (live, simulasi 1 Hz, 75 pergantian route), thread/RSS/CPU server Python, buffer MQTT monitor dengan 200 ribu pesan, store Receiver pada 10 scan × 20 ribu kandidat × 1.800 trace (DB 222 MB).
- **Verifikasi adversarial per temuan.** Setiap temuan diperiksa verifikator terpisah yang mencoba menyanggahnya (membaca kode, mereproduksi, membandingkan dengan source upstream KrakenSDR `krakenrf/krakensdr_doa`). Satu cluster tersanggah dan dikeluarkan. Bila verifikator mengoreksi cakupan atau dampak, versi koreksi yang dipakai di laporan ini dan ditandai "dikoreksi". Semua temuan critical dan high diperiksa ulang oleh penulis laporan dengan membaca kode yang dirujuk; tidak ada yang perlu diubah severity-nya.

### Yang dikecualikan

Keamanan: autentikasi, CSP, XSS, Origin/CSRF, pembatasan loopback, redaksi, batas DoS. Pengecualiannya adalah mekanisme keamanan yang menghalangi pemakaian sah (contoh: AUD-37, CSP memblokir ekspor PNG). Gaya kode murni juga di luar cakupan.

### Baseline tes

Semua tes lulus kecuali `tools/test_sdr_doa_mqtt_stdlib.py`, yang membutuhkan broker lokal di `127.0.0.1:18884` (tidak tersedia). Pengecekan ulang pada 2026-10-12: `unittest discover -s tools -p 'test_*.py'` menjalankan 63 tes, OK; `tools/test_stage3.py` 13 tes lulus. Lihat AUD-148 untuk efek samping suite tes.

### Skala severity

| Severity | Arti |
|---|---|
| critical | Fungsi inti salah atau tidak bisa dipakai dalam penggunaan normal |
| high | Fitur utama rusak atau menyesatkan dalam situasi yang umum |
| medium | Kasus tepi yang realistis atau cacat UX yang jelas |
| low | Polesan, kasus jarang, atau dokumentasi tertinggal |

## 2. Ringkasan eksekutif

Audit menghasilkan 148 temuan terverifikasi: 3 critical, 14 high, 51 medium, 80 low. Yang paling penting:

1. **Arah di peta salah.** Peta memakai θ₀ KrakenSDR (sudut array berlawanan jarum jam) langsung sebagai bearing searah jarum jam dari utara dan tidak menerapkan `compass_offset`. Dalam mode Compass, yang juga menjadi fallback untuk default KrakenSDR `Linear`, garis bearing dan lobe di peta menunjuk ke arah cermin dari plot polar dan "Display peak" di layar yang sama. Readout utama "Canonical bearing" juga menampilkan θ₀ mentah berlabel "Compass · CSV" (AUD-01). Mode Polar pada plot juga tercermin terhadap upstream (AUD-06).
2. **Data lama tampil sebagai live.** Node yang DSP-nya berhenti tetapi server 8081 tetap jalan tampil CURRENT dengan umur 0,0 s tanpa batas waktu (AUD-02). Kegagalan sinkronisasi DAQ dan ADC overdrive tidak membatasi tampilan: bearing tetap hijau CURRENT (AUD-04, AUD-05).
3. **Siklus refresh merusak tampilan.** Setiap refresh mengosongkan Overview dan memindahkan stasiun ke koordinat fallback Bandung selama request berjalan (AUD-08). Bila Data Out lambat atau terputus, UI tetap LOADING tanpa batas dan tidak pernah menampilkan ERROR atau UNAVAILABLE, sementara thread collect menumpuk di server (AUD-09). Semua interval yang ditawarkan lebih panjang dari jendela freshness 5 s (AUD-24), dan hampir semua kondisi buruk dilabeli STALE (AUD-25, AUD-26).
4. **Peta sulit dipakai untuk data live.** Lobe dan heat jenuh menjadi lingkaran penuh karena skala default −60..0 dB tidak cocok dengan vektor live yang bernilai ≥ 0 (AUD-07). Kamera bisa terkunci pada posisi fallback (AUD-10). Tanpa WebGL2 seluruh console menjadi halaman kosong (AUD-11).
5. **Receiver bisa kehilangan data.** Rekaman audio dan scan arsip hilang permanen dari Records bila operator pindah halaman, reload, atau browser crash (AUD-03). Satu chunk yang gagal di-upload menghapus seluruh segmen hingga 256 MiB (AUD-13). Records tidak bisa dimuat di Windows atau dengan nama zona waktu legacy (AUD-14).
6. **Hasil scan Receiver menyesatkan.** Wide scan default ke sumber Simulation walau radio tersambung, tanpa label SIMULATION (AUD-15). Kandidat dibanjiri noise tanpa batas (AUD-16), dan grouping menyembunyikan sinyal nyata yang terpisah megahertz (AUD-17).
7. **Edge agent diam total** bila KrakenSDR memakai Output VFO = ALL, termasuk health (AUD-12).
8. Temuan medium yang menonjol: CONFLICT palsu pada data sehat (AUD-18), konvensi tampilan berubah saat satu `settings.json` gagal dibaca (AUD-19), Message Monitor yang tidak dipoll dan kolom Count yang selalu N/A (AUD-44, AUD-45), tombol Plotly "Share chart..." yang mengunggah vektor DoA ke Plotly Cloud (AUD-36), urutan build terdokumentasi yang menghapus Receiver (AUD-67), dan bundle Plotly 4,6 MB yang membekukan Overview 1,2–1,4 s, sekitar 6–7 s di CPU lambat (AUD-38).

Yang sudah berjalan baik: parsing CSV/XML sesuai upstream, latest-request-wins, isolasi simulasi, tidak ada memory leak dalam sesi 14 menit, server ringan, dan perbaikan audit anti-slop sebelumnya tidak regresi (detail di bagian 4).

### Jumlah temuan per severity

| Severity | Jumlah |
|---|---|
| critical | 3 |
| high | 14 |
| medium | 51 |
| low | 80 |
| **Total** | **148** |

### Jumlah temuan per area

| Area | Critical | High | Medium | Low | Total |
|---|---|---|---|---|---|
| Collector & kontrak data | 1 | 2 | 4 | 10 | 17 |
| Server console & konfigurasi | 0 | 0 | 4 | 7 | 11 |
| Frontend: status & freshness | 0 | 2 | 3 | 1 | 6 |
| Frontend: peta | 1 | 3 | 5 | 6 | 15 |
| Frontend: polar & readout | 0 | 1 | 5 | 6 | 12 |
| Frontend: halaman, i18n, layout | 0 | 0 | 4 | 11 | 15 |
| MQTT monitor | 0 | 0 | 8 | 2 | 10 |
| Edge agent (staging) | 0 | 1 | 2 | 9 | 12 |
| Receiver: backend & penyimpanan | 1 | 2 | 1 | 6 | 10 |
| Receiver: scan/sweep | 0 | 2 | 6 | 6 | 14 |
| Receiver: UI, rekaman, Records | 0 | 1 | 6 | 10 | 17 |
| Dokumentasi & build | 0 | 0 | 2 | 5 | 7 |
| Performa | 0 | 0 | 1 | 0 | 1 |
| Tes & tooling | 0 | 0 | 0 | 1 | 1 |
| **Total** | **3** | **14** | **51** | **80** | **148** |

Status verifikasi: semua 147 cluster dari putaran audit berstatus terkonfirmasi (tidak ada yang disputed atau unverified). AUD-148 ditambahkan dan diverifikasi oleh penulis laporan. Kode cluster asal (Cxxx) dicantumkan per temuan untuk ketertelusuran.

## 3. Temuan

### 3.1 Critical

#### AUD-01 — Peta dan readout utama memakai θ₀ (berlawanan jarum jam) sebagai bearing kompas tanpa konversi dan tanpa `compass_offset`

- Severity: **critical** · Area: Frontend: peta (kontrak lintas collector) · Status: terkonfirmasi (dua verifikator, source upstream dicek) · Cluster: C002
- Lokasi: `frontend/src/components/TacticalMap.tsx:104-108`, `frontend/src/lib/doaGeometry.ts:57-65`, `frontend/src/lib/doaGeometry.ts:78-88`, `frontend/src/components/DoaReadout.tsx:51`, `frontend/src/pages/OverviewPage.tsx:40`, `frontend/src/lib/polar.ts:126-128`, `tools/sdr_doa_collector.py:603-637`

**Masalah.** Collector menerbitkan `canonical_angle_deg` sebagai θ₀ upstream (XML DOA mentah, CSV 360 − raw) dengan konvensi `upstream_theta_0`. Di KrakenSDR, θ₀ adalah sudut array berlawanan jarum jam. Tampilan Compass upstream memakai (360 − θ + compass_offset) % 360, dan proyeksi geografis upstream memakai heading + (360 − θ₀). `TacticalMap` memakai `canonical_angle_deg` (dengan fallback `angular_peak_index`) langsung sebagai bearing searah jarum jam dari utara di `destination()`. Bin i dipakai sebagai bearing i untuk lobe, beam, heat, tepi −3 dB, dan hover. `TacticalMap` tidak menerima pengaturan compass, karena `OverviewPage` hanya meneruskannya ke readout dan polar, sehingga `compass_offset` tidak pernah diterapkan di peta. Sel utama "Canonical bearing" juga menampilkan θ₀ mentah dengan detail `Compass · CSV`, sehingga terbaca sebagai bearing kompas.

**Dampak ke operator.** Dalam mode Compass (juga fallback saat `doa_fig_type` = `Linear`, default KrakenSDR), garis bearing, lobe, dan hover di peta menunjuk ke arah cermin dari polar dan "Display peak" di layar yang sama. Contoh: θ₀ = 90 membuat peta menunjuk Timur (90°) sementara polar dan Display peak menunjuk 270° (Barat); dengan offset 30, peta tetap 90° sementara display peak 300°. Kedua tampilan hanya kebetulan sama saat θ₀ = 0 atau 180 dengan offset 0. Operator yang mengikuti peta bergerak ke arah yang salah.

**Bukti.** Console nyata dengan Data Out palsu (XML DOA 90, CSV raw 270): readout `CANONICAL BEARING 90.0° Compass · CSV | DISPLAY PEAK 270°`, sedangkan label peta 90.0° mengarah ke Timur. Dengan sampel referensi repo (peak bin 350, CSV 10): label peta 350°, polar Compass 10°. Verifikator membandingkan dengan `kraken_web_doa.py` (Polar berlawanan jarum jam, Compass `(360 - thetas + compass_offset) % 360`) dan `calculate_end_lat_lng` di `kraken_sdr_signal_processor.py`.

**Usulan perbaikan.** Buat satu adapter geografis (langkah `doaObservation` di `MAPLIBRE_DOA_OVERLAY_PLAN.md` §5): bearing = (360 − θ₀ + offset/heading) % 360, dengan sumber orientasi yang diberi label. Pakai untuk semua layer peta (bin i → adapter(i)), hover, popup, dan readout. Beri label nilai mentah sebagai "θ₀ (kerangka array)", atau tampilkan nilai kompas sebagai bearing utama. Tambahkan tes truth table 0/90/180/270 × offset yang memastikan display peak polar sama dengan bearing peta. Selama sumber orientasi belum terverifikasi, tandai overlay sebagai REFERENCE.

#### AUD-02 — Node beku (DSP berhenti, port 8081 tetap melayani) tampil CURRENT/AVAILABLE tanpa batas waktu

- Severity: **critical** · Area: Collector & kontrak data · Status: terkonfirmasi (direproduksi end-to-end) · Cluster: C001
- Lokasi: `tools/sdr_doa_collector.py:837-844`, `tools/sdr_doa_collector.py:916-945`, `tools/ground_console.py:1874-1878`, `frontend/src/App.tsx:61-73`, `frontend/src/App.tsx:80-104`

**Masalah.** `/api/snapshot` selalu memanggil `collect(authority='none', clock_source='remote_unverified')`. Dalam mode ini umur `status.json` ditandai `freshness_known=False` dan `gate_checks.status_fresh` bernilai `None`. Umur DoA hanya dihitung terhadap `timestamp_ms` milik `status.json`, yang berasal dari jam node yang sama. Upstream menulis `status.json`, `DOA_value.html`, dan `doa.xml` dari loop DSP yang sama, sedangkan port 8081 dilayani proses terpisah (php -S/miniserve). Bila DSP berhenti atau hang sementara server 8081 tetap jalan, ketiga file membeku dengan timestamp yang saling cocok, sehingga umur DoA tetap sekitar 0 dan `fresh=True` di setiap poll. Tidak ada kode yang memeriksa apakah `timestamp_ms`, `uptime_ms`, atau `data_frame_index` bertambah di antara poll. Di `App.tsx`, `freshnessRemaining()` melewati record status (karena `freshness_known` false), dan jendela kandidat 5 s dimulai ulang setiap respons.

**Dampak ke operator.** Bearing berumur menit atau jam tampil persis seperti data live: DATA AVAILABLE, DOA AVAILABLE, SNAPSHOT CURRENT, AGE AT READ 0.0 s, garis bearing di peta, dan kurva polar. Operator tidak punya cara untuk mengetahui bahwa node sudah berhenti menghasilkan data.

**Bukti.** Data Out in-memory dengan semua timestamp 10 menit di masa lalu: `/api/snapshot` mengembalikan `csv fresh True age 0` padahal `observed_at − csv ts = 607 s`, dan `status.freshness = {freshness_known: False, fresh: None}`. Playwright: `CANONICAL BEARING 350.0° | AGE AT READ 0.0 s | CURRENT`. Pada mode beku selama 32 s, tampilan kembali CURRENT setelah setiap poll.

**Usulan perbaikan.** Simpan nilai terakhir per `base_url` (di `ground_console` atau `App`). Tandai snapshot STALE dengan reason baru (misalnya `NODE_CLOCK_STALLED`) bila `timestamp_ms`, `uptime_ms`, atau `data_frame_index` tidak maju sementara waktu monotonic lokal sudah maju lebih dari `status_max_age_ms`. Cara ini hanya membandingkan laju, sehingga tidak butuh sinkronisasi jam Ground dan node. Alternatifnya, pakai header HTTP `Date` dari server 8081 sebagai "now" di jam node (perlu dicek apakah php -S/miniserve mengirimnya). Tambahkan tes regresi dengan file beku.

#### AUD-03 — Rekaman audio dan scan arsip Receiver hilang permanen dari Records saat operator pindah halaman, reload, atau browser crash

- Severity: **critical** · Area: Receiver: backend & penyimpanan · Status: terkonfirmasi (direproduksi di browser dan HTTP) · Cluster: C045
- Lokasi: `frontend/src/App.tsx:150-158`, `frontend/src/App.tsx:445`, `tools/browsdr_receiver_overlay/src/client/app/main.ts:223-227`, `tools/receiver_record_store.py:404-416`, `tools/receiver_record_store.py:472-487`, `tools/receiver_record_store.py:639`

**Masalah.** Scan yang diarsipkan baru mendapat baris `records` di `finish_scan`, dan sesi audio hanya muncul di daftar bila `finished_at IS NOT NULL`. Finalisasi hanya dilakukan browser (`stopSweep`, `VfoAudioRecorder.disarm`) lewat hook Vue `beforeUnmount`. Hook itu tidak pernah jalan saat iframe dihapus, halaman di-reload, atau tab ditutup, dan tidak ada handler `pagehide`, `beforeunload`, atau `sendBeacon` di client Receiver. `App.tsx` hanya merender route aktif (`<section key={route}>`), sehingga pindah dari `#/receiver` menghancurkan iframe. Server tidak memulihkan data yatim saat start, dan scan yatim bahkan tidak bisa dihapus (`DELETE` → 404 `'record not found'`).

**Dampak ke operator.** Operator yang merekam audio VFO atau menjalankan scan arsip, lalu membuka Overview atau Health (pemakaian normal), me-reload, atau mengalami crash browser, kehilangan sesi itu dari Records secara permanen. Ini termasuk segmen yang sudah selesai sebagai `.webm`. Data tertinggal sebagai baris SQLite dan file `tmp/*.part` yang tidak bisa dijangkau UI dan terus menumpuk di disk.

**Bukti.** Scan Simulation terarsip selama 6 s, lalu `location.hash='#/overview'`: `iframe still present: 0`, `scan records: {"items":[],"total":0}`, di DB `finished_at=None` dengan 12 frame. Audio: Connect Mock SDR, Record 5 s, pindah ke `#/system-health`: sesi `finished=None`, file `.part` 64.932 byte, tidak terdaftar, dan tetap hilang setelah server di-restart.

**Usulan perbaikan.** (1) Biarkan iframe Receiver tetap ter-mount (disembunyikan) saat route berganti, atau minta konfirmasi sebelum meninggalkan `#/receiver` selama merekam atau scan. (2) Finalisasi best-effort pada `pagehide` dengan `fetch` keepalive atau `sendBeacon`. (3) Pulihkan data yatim saat store start: segmen `.part` yang ukurannya cocok dengan `byte_count` dijadikan selesai atau `interrupted`, `finished_at` sesi diisi, dan scan arsip yang menggantung dijadikan record `interrupted`. Izinkan `delete_record` menghapus scan yatim.

### 3.2 High

#### AUD-04 — Kegagalan sinkronisasi DAQ tidak membatasi Overview: bearing, polar, dan peta tetap hijau CURRENT

- Severity: **high** · Area: Frontend: status & freshness · Status: terkonfirmasi · Cluster: C122
- Lokasi: `frontend/src/lib/telemetry.ts:54-66`, `frontend/src/lib/telemetry.ts:70-78`, `frontend/src/components/Shell.tsx:118-122`, `frontend/src/components/DoaReadout.tsx:33`, `frontend/src/components/PolarPanel.tsx:22-30`, `frontend/src/components/TacticalMap.tsx:105`

**Masalah.** `nativeViewsReady`/`polarDataReady` dan gate untuk readout, polar, chip DoA, dan peta tidak membaca `status.daq_health`. Hanya chip DATA yang memakainya. Dengan fixture `unhealthy` (`daq_ok=false`, ketiga flag sync false), collector memberi `overall_state` DEGRADED dan reason `DAQ_HEALTH_GATE_FAILED`, tetapi Overview menampilkan bearing 211.0° di sel hijau CURRENT, chip DoA AVAILABLE, polar "AVAILABLE · Data available", dan peta menggambar lobe, heat, dan bearing. Sel Delivery gate menampilkan `reasons[0]`, yaitu `GROUND_CLOCK_UNVERIFIED`, sehingga reason DAQ tersembunyi.

**Dampak ke operator.** Ini kegagalan lapangan yang paling sering terdokumentasi (`initialize.md`: baseline live terakhir DEGRADED karena `daq_ok=false` dan sync IQ/sample-delay gagal). Operator melihat arah yang tampak meyakinkan, padahal tanpa sinkronisasi koheren bearing KrakenSDR tidak bermakna. `QUICKSTART.md:268` menjanjikan DoA hanya ditandai current bila DAQ lolos gate.

**Bukti.** Fake Data Out dengan fixture `unhealthy` bertimestamp segar: strip `Data=DEGRADED | DoA=AVAILABLE | Delivery=BLOCKED | Snapshot=CURRENT`, readout `CANONICAL BEARING 211.0°`, overlay peta tergambar. System Health pada snapshot yang sama: `DAQ FAIL`, `SYNC 0 / 3`.

**Usulan perbaikan.** Bila `daq_health !== 'PASS'`, jangan tampilkan DoA sebagai AVAILABLE/CURRENT: ubah chip DoA menjadi DEGRADED/UNAVAILABLE, status polar menjadi "DAQ not synchronized", dan tone readout menjadi warn. Alternatifnya tetap menggambar, tetapi dengan badge eksplisit "DAQ FAIL · bearing tidak andal" di readout, polar, dan legenda peta. Tampilkan reason gate yang paling bisa ditindaklanjuti (DAQ, conflict, stale) di urutan pertama.

#### AUD-05 — ADC overdrive, SNR, dan confidence native diparse tetapi tidak dipakai di gate maupun tampilan

- Severity: **high** · Area: Collector & kontrak data · Status: terkonfirmasi · Cluster: C113
- Lokasi: `tools/sdr_doa_collector.py:391`, `tools/sdr_doa_collector.py:400-408`, `tools/sdr_doa_collector.py:576-578`, `frontend/src/lib/telemetry.ts:70-78`, `frontend/src/pages/SystemHealthPage.tsx`

**Masalah.** Collector mem-parse `status.daq_status.adc_overdrive` (boolean) dan XML `ADC_OVERDRIVE` (bitmask per kanal, disimpan sebagai teks), juga `SNR_DB` dan `confidence_metric_db`. Tidak satu pun memengaruhi `daq_health` (yang hanya dihitung dari `daq_ok` dan tiga flag sync), `overall_state`, atau publication gate. Tidak ada konsumen di frontend: grep `overdrive`, `snr`, `confidence_metric` di `frontend/src` kosong. Padahal `SDR_DOA_DATA_ACCESS_AND_GUI_CUSTOMIZATION.md` §16 meminta confidence, SNR, power, dan age ditampilkan.

**Dampak ke operator.** Bila RF kuat di dekat stasiun membuat satu atau lebih ADC clipping, fase antar-kanal yang menjadi dasar bearing rusak. Console tetap menampilkan DAQ PASS, Sync 3/3, DATA AVAILABLE, dan bearing CURRENT. Tidak ada pembeda antara bearing yang bisa dipercaya dan bearing yang clipping atau ber-SNR rendah, sedangkan UI KrakenSDR sendiri menandai overdrive.

**Bukti.** Skenario overdrive (status `adc_overdrive=true`, XML `ADC_OVERDRIVE=1`) melalui collector, bundle TS, dan browser: `overall UNVERIFIED`, `daq_health PASS`, reason tidak berubah, strip `DATA AVAILABLE | DOA AVAILABLE | SNAPSHOT CURRENT`. Kata overdrive dan SNR tidak muncul di halaman mana pun.

**Usulan perbaikan.** Parse `ADC_OVERDRIVE` sebagai integer bitmask. Jadikan overdrive sebagai state `daq_health` tersendiri (misalnya `OVERDRIVE`) atau reason gate `ADC_OVERDRIVE`. Tampilkan di System Health dan sebagai peringatan di readout DoA. Tampilkan `SNR_DB` dan confidence native (diberi label "PAPR dB, belum dipetakan") di Diagnostics dan readout.

#### AUD-06 — Mode Polar menggambar bin searah jarum jam, sehingga berganti Polar/Compass mencerminkan lobe

- Severity: **high** · Area: Frontend: polar & readout · Status: terkonfirmasi (source upstream dicek) · Cluster: C095
- Lokasi: `frontend/src/components/PolarPlot.tsx:85`, `frontend/src/lib/polar.ts:126-128`

**Masalah.** `angularaxis` selalu memakai `direction: 'clockwise'` dengan `rotation: 90 + head`. `displayAngleForBin` mengembalikan bin apa adanya di mode Polar dan 360 − bin + offset di mode Compass. Akibatnya bin θ digambar θ° searah jarum jam dari atas di Polar, tetapi θ° berlawanan jarum jam di Compass. Upstream menggambar Polar berlawanan jarum jam (default Plotly, rotation 90), sehingga di upstream kedua mode menempatkan bin yang sama di posisi layar yang sama. Canvas fallback (`drawPolarCanvas`) memakai pemetaan yang sama dengan console. Akar masalahnya sama dengan AUD-01.

**Dampak ke operator.** Untuk θ₀ = 60, mode Compass menggambar lobe di kiri atas (label 300°) dan mode Polar di kanan atas (label 60°). Operator yang membandingkan dengan UI KrakenSDR mode Polar, atau yang berganti mode, melihat arah tercermin.

**Bukti.** Collector nyata (peak bin 60, CSV 300, XML 60), bundle produksi lewat `ground_console.py`, Playwright: Compass `peakTheta=300`, Polar `peakTheta=60`, keduanya `direction=clockwise`. Screenshot menunjukkan lobe di kiri atas vs kanan atas untuk snapshot yang sama. Upstream dicek di `krakenrf/krakensdr_doa@2e1c4e6`, `kraken_web_doa.py`.

**Usulan perbaikan.** Di mode Polar, pakai orientasi upstream (`direction: 'counterclockwise'`, atau tetap clockwise dengan plot 360 − bin), sehingga Polar dan Compass dengan offset 0 menampilkan gambar fisik yang sama dengan label berbeda. Perbarui `SDR_DOA_8081_DATA_REFERENCE.md` dan komentar canvas fallback. Kerjakan bersama adapter AUD-01.

#### AUD-07 — Skala dB overlay peta default (−60..0) menjenuhkan vektor live, sehingga lobe menjadi lingkaran penuh dan heat seragam

- Severity: **high** · Area: Frontend: peta · Status: terkonfirmasi · Cluster: C079
- Lokasi: `frontend/src/lib/doaGeometry.ts:36-44`, `frontend/src/lib/doaGeometry.ts:67-70`, `frontend/src/lib/doaGeometry.ts:78-84`, `frontend/src/lib/doaGeometry.ts:105`, `frontend/src/lib/doaGeometry.ts:141`, `frontend/src/components/TacticalMap.tsx:104-105`, `tools/sdr_doa_collector.py:514-520`

**Masalah.** Vektor CSV live disimpan sebagai dB yang digeser terhadap minimumnya sendiri (unit `dB_relative_to_source_floor`, semua bin ≥ 0; snapshot referensi repo 0.00..1.46 dB). Overlay peta menormalkan terhadap default tetap `minDb −60`, `maxDb 0`, `thresholdDb −60`, sehingga `normalizeDb` memberi bobot 1 untuk setiap bin ≥ 0. Tidak ada mode auto untuk data live. Data simulasi memang berada di −60..0, jadi masalah ini tidak terlihat dalam simulasi.

**Dampak ke operator.** Dengan pengaturan default dan Data Out nyata, lobe peta menjadi lingkaran sempurna 1 km dan heat beam menjadi cakram merah seragam. Peta tidak menunjukkan arah selain garis bearing tipis (yang arahnya pun salah, lihat AUD-01), sementara polar di sebelahnya menunjukkan lobe yang jelas.

**Bukti.** Vektor Gaussian 0..1.46 dB dengan puncak di bin 350: `default scale -60 0 -> weight min/max 1 1`, `lobe radius min/max m 1000.0 1000.0`, 2.880 fitur beam dengan satu nilai bobot. Screenshot browser: cakram merah penuh plus lobe melingkar, sementara polar menunjukkan lobe sempit.

**Usulan perbaikan.** Untuk data live, jadikan default skala overlay rentang auto berlabel yang diambil dari vektor (min..max, atau 0..max untuk data tergeser), seperti polar. Pertahankan −60..0 hanya untuk simulasi. Tampilkan indikator saturasi bila sebagian besar bin berbobot 1.

#### AUD-08 — Setiap refresh mengosongkan Overview dan memindahkan stasiun ke koordinat fallback selama request berjalan

- Severity: **high** · Area: Frontend: status & freshness · Status: terkonfirmasi · Cluster: C089
- Lokasi: `frontend/src/App.tsx:288`, `frontend/src/App.tsx:423-426`, `frontend/src/pages/OverviewPage.tsx:38`, `frontend/src/components/Shell.tsx:118-122`

**Masalah.** `refresh()` memanggil `setLoading(true)` sebelum menunggu `getSnapshot`, dan `currentLocalFresh` memuat `!loading`. Akibatnya, selama request berjalan, data di layar dianggap tidak segar walaupun masih dalam jendela freshness-nya. Shell menampilkan DATA STALE dan SNAPSHOT STALE. `OverviewPage` memberi `evidence = null`, sehingga GPS DATA_OUT jatuh ke koordinat fallback, dan readout, polar, serta peta dikosongkan. Health dan Diagnostics menampilkan banner STALE EVIDENCE.

**Dampak ke operator.** Dengan auto-refresh, setiap siklus bearing berubah menjadi "—", plot dan overlay hilang, dan posisi berubah ke "REFERENCE ONLY · NOT LIVE GPS" (Bandung) selama request berlangsung (sekitar 0,1–1 s, lebih lama pada link lambat). Tampilan berkedip, penanda stasiun keluar layar setiap poll, dan zoom polar ikut rusak (AUD-33).

**Bukti.** Refresh 5 s, Data Out palsu sekitar 400 ms per collect: pada 5,16 s `Data=STALE DoA=UNAVAILABLE bearing=— pos=-6.93247, 107.66069 REFERENCE ONLY`; pada 5,65 s kembali `AVAILABLE bearing=60.0° STATION POSITION`. Pola yang sama berulang setiap 5 s.

**Usulan perbaikan.** Hapus `!loading` dari predikat freshness. Tampilkan status "membaca…" sebagai indikator terpisah. Kesiapan tampilan harus bergantung pada umur data, bukan pada ada atau tidaknya request yang sedang berjalan.

#### AUD-09 — Data Out lambat atau tak terjangkau: UI tetap LOADING tanpa batas dan tidak pernah menampilkan ERROR/UNAVAILABLE, sementara collect menumpuk di server

- Severity: **high** · Area: Collector & kontrak data (juga server dan frontend) · Status: terkonfirmasi · Cluster: C004
- Lokasi: `tools/sdr_doa_collector.py:337-368`, `tools/sdr_doa_collector.py:785-797`, `tools/ground_console.py:1874-1878`, `frontend/src/App.tsx:284-289`, `frontend/src/App.tsx:369-375`, `frontend/src/api.ts:3`

**Masalah.** `fetch_and_parse_with_retry` juga me-retry kegagalan transport, bukan hanya file parsial seperti yang tertulis di docstring-nya. `collect()` membaca empat resource berurutan tanpa deadline total. Akibatnya Data Out yang di-blackhole butuh 4 × 3 × 5 s ≈ 60 s per snapshot, satu resource macet butuh 15 s, dan Data Out lambat 1,3 s per resource butuh 5,3 s. Di frontend, setiap tick interval memanggil `refresh()` yang membatalkan request sebelumnya; `AbortError` ditelan dan `loading` tetap true. Pada interval 5 s (dan praktis juga 10 s), timeout 10 s tidak pernah sempat muncul. Server tetap menjalankan setiap collect yang sudah ditinggalkan klien.

**Dampak ke operator.** Bila Pi mati atau link (PPP/radio) putus, strip menampilkan DATA LOADING/SNAPSHOT LOADING (atau STALE dengan "Reading…") tanpa batas. Operator tidak pernah melihat ERROR atau UNAVAILABLE beserta reason-nya, dan tombol Refresh serta tombol R nonaktif selama itu. Link yang lambat tetapi berfungsi (link T900 terdokumentasi) dengan auto-refresh 5 s tidak pernah menampilkan data sama sekali. Sekitar 9–12 thread collect menumpuk di server dan terus mengirim GET ke node yang sedang kesulitan. Dalam mode manual, operator hanya melihat `request timed out after 10000 ms` setelah 10 s, bukan snapshot diagnostik.

**Bukti.** `base_url` 192.168.100.100 (blackhole): `time curl /api/snapshot` 1m0,7s dengan hasil UNAVAILABLE. Playwright refresh 5 s selama 36 s: selalu LOADING, setiap `/api/snapshot` berakhir `net::ERR_ABORTED`, thread server naik dari 2 ke 9. Delay 1,5 s per resource: 6 request dimulai, tidak satu pun dirender.

**Usulan perbaikan.** Beri `collect()` deadline total (misalnya 3–4 s) dengan fetch paralel, jangan retry error koneksi, dan hentikan lebih awal bila `status.json` gagal di level transport. Di frontend, lewati tick selama request masih berjalan (atau jadwalkan poll berikutnya setelah request selesai), pertahankan error terakhir sampai ada read yang sukses, dan pastikan timeout lebih pendek dari interval.

#### AUD-10 — Kamera peta dibingkai sekali pada koordinat pertama, sering koordinat fallback, dan tidak dibingkai ulang saat fix nyata datang

- Severity: **high** · Area: Frontend: peta · Status: terkonfirmasi · Cluster: C082
- Lokasi: `frontend/src/components/TacticalMap.tsx:217-229`, `frontend/src/pages/OverviewPage.tsx:38-39`, `frontend/src/lib/map.ts:103-110`

**Masalah.** Kamera hanya menjalankan `fitBounds` sekali, saat `centeredCoordinateRef` masih null. Dengan sumber GPS default DATA_OUT, `resolveGpsSource` selalu mengembalikan koordinat FALLBACK (Bandung) bila belum ada snapshot segar, dan saat loading pertama snapshot dianggap tidak segar (AUD-08). Bila style MapLibre siap lebih dulu, kamera membingkai Bandung. Fix DATA_OUT atau MANUAL yang datang kemudian hanya memindahkan marker dan overlay. Hanya tombol Center yang membingkai ulang.

**Dampak ke operator.** Setelah membuka console dengan Data Out sedikit lambat atau sempat tak terjangkau, peta menampilkan area kosong di sekitar Bandung, sementara readout menyatakan DATA AVAILABLE dan STATION POSITION. Stasiun, lobe, dan bearing berada di luar layar sampai operator terpikir untuk menekan Center.

**Bukti.** Data Out palsu 0,6 s per resource: `live GPS after 2840 ms`, lalu `STATION POSITION -6.200000°, 106.800000° ... in view false`. Dengan latensi 0 s stasiun berada di tengah, yang mengonfirmasi adanya race.

**Usulan perbaikan.** Simpan sumber efektif yang dipakai untuk framing. Bingkai ulang sekali ketika sumber berubah dari FALLBACK (atau kosong) ke fix DATA_OUT/MANUAL, atau bila stasiun berada di luar viewport pada fix live pertama. Update data biasa tetap tidak boleh menggerakkan kamera.

#### AUD-11 — Tanpa WebGL2 konstruktor MapLibre melempar error di dalam effect dan seluruh console menjadi kosong

- Severity: **high** · Area: Frontend: peta · Status: terkonfirmasi · Cluster: C081
- Lokasi: `frontend/src/components/TacticalMap.tsx:134`, `frontend/src/components/TacticalMap.tsx:150-158`, `frontend/src/main.tsx` (tidak ada error boundary di `frontend/src`)

**Masalah.** maplibre-gl 6.10 melempar error secara sinkron di konstruktor bila WebGL2 tidak tersedia. Konstruksi map berada di dalam `useEffect` tanpa try/catch, dan tidak ada error boundary di mana pun (`componentDidCatch`/`getDerivedStateFromError` tidak ditemukan), sehingga React meng-unmount seluruh root. State `unavailable` tidak pernah diset, dan canvas fallback hanya aktif dari event `error` pada map yang sudah berhasil dibuat. `MAPLIBRE_DOA_OVERLAY_PLAN.md:105` meminta pesan yang jelas sementara Plotly tetap berfungsi.

**Dampak ke operator.** Di browser atau mesin tanpa WebGL2 (GPU di-blocklist, akselerasi hardware mati, VM, sesi remote desktop), membuka Overview, yang merupakan route default, menghasilkan halaman kosong total. Header, health, diagnostics, polar, dan navigasi hilang tanpa penjelasan.

**Bukti.** Chromium dengan `--disable-webgl2` dan dengan `--disable-3d-apis`: `{"webgl2":false,"rootChildren":0,"bodyText":""}`, `pageerror: WebGL2 is required to display this map`.

**Usulan perbaikan.** Bungkus konstruksi map dengan try/catch; saat gagal set state `unavailable` dan tampilkan EmptyState "WebGL2 tidak tersedia" sehingga Overview dan polar tetap berjalan. Tambahkan error boundary di sekitar `TacticalMap` dan route (lihat juga AUD-42). Bila canvas fallback harus bisa jalan tanpa GL, beri ia proyeksi Web Mercator sendiri alih-alih `map.project()`.

#### AUD-12 — Edge agent tidak mempublikasikan apa pun (termasuk health) saat KrakenSDR memakai Output VFO = ALL

- Severity: **high** · Area: Edge agent (staging) · Status: terkonfirmasi (direproduksi) · Cluster: C112
- Lokasi: `tools/sdr_doa_lan_agent.py:131`, `tools/sdr_doa_lan_agent.py:154-170`, `tools/sdr_doa_lan_agent.py:643-660`, `tools/sdr_doa_lan_agent.py:699-702`, `tools/sdr_doa_mqtt.py:486`

**Masalah.** `build_messages()` menyalin `settings.output_vfo` apa adanya ke payload `state` dan `config_reported`, sedangkan kontrak MQTT mensyaratkan `require_int("output_vfo", 0)`. KrakenSDR menyimpan "Output VFO: ALL" sebagai −1, yang merupakan setting sah. `contract.build_state()` melempar `ContractError` (subkelas `ValueError`) sebelum apa pun dimasukkan ke antrean, termasuk health yang sudah dibangun. `run()` menangkapnya sebagai kegagalan transport, lalu disconnect dan reconnect dengan backoff hingga 30 s, berulang di setiap siklus. `--once` berakhir dengan traceback.

**Dampak ke operator.** Operator yang memilih Output VFO = ALL kehilangan seluruh telemetri edge, termasuk health yang justru seharusnya melaporkan kondisi degraded. Broker melihat klien yang connect lalu langsung putus. State retained yang lama tetap tampil di Message Monitor sebagai data terkini (AUD-115).

**Bukti.** `AgentRuntime.run(duration_s=3)` dengan klien MQTT palsu: `output_vfo=0` → 60 iterasi, 30 health; `output_vfo=-1` → 0 iterasi, tidak ada publish, `last_error 'state.output_vfo is below minimum'`.

**Usulan perbaikan.** Representasikan "semua VFO" secara eksplisit di kontrak (izinkan −1, atau tambahkan `output_vfo_all: true`). Bangun setiap jenis pesan di blok try sendiri agar kegagalan state/config tidak memblokir health, dan tambahkan flag atau reason di health untuk kasus itu. Bedakan error pembuatan payload dari error transport (tanpa disconnect), dan log di setiap siklus.

#### AUD-13 — Satu chunk audio yang gagal, atau mencapai batas ukuran, membuat seluruh segmen dihapus (hingga 256 MiB audio valid)

- Severity: **high** · Area: Receiver: backend & penyimpanan · Status: terkonfirmasi, dikoreksi · Cluster: C046
- Lokasi: `tools/receiver_record_store.py:878-879`, `tools/receiver_record_store.py:947-959`, `tools/browsdr_receiver_overlay/src/client/app/vfo-audio-recorder.ts:267-272`, `tools/browsdr_receiver_overlay/src/client/app/vfo-audio-recorder.ts:345-353`

**Masalah.** Segmen yang gagal memang dirancang tidak bisa diputar, tetapi recorder membuat kegagalan terlalu mudah terjadi. Chunk yang gagal tidak di-retry (satu request dengan timeout 30 s). Tidak ada rollover ke segmen baru saat mencapai batas 256 MiB per segmen atau 1 GiB per sesi. Begitu satu chunk gagal, seluruh segmen di-finish dengan status `failed`. `finish_segment` lalu menghapus seluruh file `.part`, termasuk bagian awal yang valid dan sudah di-fsync. Record setelahnya masih melaporkan jumlah byte penuh untuk audio yang sudah tidak ada.

**Dampak ke operator.** Satu error upload sesaat, restart server console, atau tercapainya batas ukuran (sekitar 4,7 jam pada satu frekuensi, lebih cepat bila beberapa VFO direkam dalam satu sesi) menghapus seluruh audio segmen itu. UI memang menampilkan error saat chunk pertama gagal, tetapi tidak memperingatkan menjelang batas, tidak mengatakan bahwa segmen akan dibuang, dan tetap merekam.

**Bukti.** 256 chunk berukuran 1 MiB, lalu chunk berikutnya → 400 `audio recording size limit exceeded`. Setelah `finish(failed)`: file `.part` hilang, folder audio kosong, play → 404, record `{'bytes': 268435456, 'status': 'failed'}`. Varian dengan restart server di tengah rekaman memberi hasil yang sama.

**Usulan perbaikan.** Jangan hapus data saat gagal: simpan `.part` (atau bagian sampai chunk baik terakhir) sebagai `audio/<id>.webm` dengan status `partial`. Saat append gagal, retry beberapa kali; bila tetap gagal, tutup segmen dan buka segmen baru agar stream WebM tetap utuh. Peringatkan operator menjelang batas dan lakukan rollover otomatis. Set `bytes` menjadi 0 bila file dihapus.

#### AUD-14 — Receiver Records gagal dimuat bila Python tidak mengenali zona waktu browser (Windows tanpa tzdata, nama zona legacy Chromium)

- Severity: **high** · Area: Receiver: backend & penyimpanan · Status: terkonfirmasi · Cluster: C047
- Lokasi: `tools/receiver_record_store.py:60-66`, `tools/build_browsdr_receiver.py:346-350`, `tools/build_browsdr_receiver.py:380-388`, `QUICKSTART.md:11`, `QUICKSTART.md:82`

**Masalah.** `loadReceiverRecords` (hasil patch builder) memuat halaman scan, halaman audio, dan `audio-facets` (dengan zona waktu browser) dalam satu `Promise.all`. Server memvalidasi zona dengan `zoneinfo.ZoneInfo`, dan `ZoneInfoNotFoundError` diubah menjadi 400, sehingga seluruh `Promise.all` gagal dan kedua daftar tidak terisi. Dua setup umum terdampak: (1) Python di Windows, platform yang terdokumentasi, tidak punya database tz sistem, dan langkah instalasi tidak memasang paket `tzdata` (`.venv` di repo ini pun tidak punya), sehingga semua zona gagal termasuk `UTC` dan `Asia/Jakarta`; (2) Chromium melaporkan nama legacy (`Asia/Calcutta`, `Asia/Saigon`, `Europe/Kiev`) yang tidak dikenal tzdata distro tanpa link legacy, misalnya Ubuntu 24.04 di host audit ini.

**Dampak ke operator.** Tab Records menampilkan "Could not load local Receiver records: time_zone must be a valid IANA time zone" dan "0 scans / No saved spectrum scans" walaupun record ada. Scan arsip tidak bisa dibuka, dan rekaman tidak bisa diputar atau dihapus.

**Bukti.** Playwright dengan timezone `Asia/Kolkata` (Chromium melaporkan `Asia/Calcutta`): 400 pada `/api/receiver/audio-facets`, "0 scans". Dengan `Asia/Jakarta`: "1 scan". Simulasi Windows (`PYTHONTZPATH` kosong, tanpa modul `tzdata`): `?time_zone=UTC` → 400.

**Usulan perbaikan.** Pakai `Promise.allSettled` agar kegagalan facets tidak menyembunyikan daftar. Di server, fallback ke UTC atau offset tetap dengan peringatan, dan petakan alias legacy ke nama kanonik. Dokumentasikan `pip install tzdata`, setidaknya untuk Windows.

#### AUD-15 — Wide scan default ke sumber Simulation walau radio tersambung, tanpa label SIMULATION, dan reset di setiap kunjungan

- Severity: **high** · Area: Receiver: UI, rekaman, Records · Status: terkonfirmasi · Cluster: C068
- Lokasi: `tools/browsdr_receiver_overlay/src/client/app/state.ts:82`, `tools/browsdr_receiver_overlay/src/client/app/connection.ts` (`connectToDevice`, `connectMock`), `tools/browsdr_receiver_overlay/src/client/index.html:516-517`, `tools/browsdr_receiver_overlay/src/client/app/settings.ts`

**Masalah.** Overlay mengubah default `sweep.source` dari `native` (upstream) menjadi `simulated`. Menyambungkan perangkat tidak mengubahnya; hanya jalur listen-lalu-kembali (`startHardwareSweep`) yang beralih ke native atau manual. Selama scan simulasi, header menampilkan "DEVICE CONNECTED" dan "SCANNING", dan satu-satunya petunjuk bahwa puncaknya sintetis adalah opsi terpilih di `<select>` Source. Pengaturan sweep tidak disimpan, dan iframe dibuat ulang setiap kunjungan, sehingga sumber kembali ke Simulation dan rentang kembali ke 100–1000 MHz.

**Dampak ke operator.** Setelah menyambungkan HackRF dan menekan Start scan, operator melihat puncak sintetis sempit dan lebar di bawah "DEVICE CONNECTED · SCANNING", dan bisa mengira itu aktivitas RF nyata, bahkan mengarsipkannya. Ini melanggar aturan proyek bahwa simulasi harus terlihat berlabel SIMULATION. Pengaturan scan juga harus diisi ulang setiap kali kembali ke halaman.

**Bukti.** Connect Mock SDR, lalu tab Spectrum: `selected: simulated`. Setelah Start scan: header `DEVICE CONNECTEDSCANNING`, `visible SIMULATION label anywhere outside the select? false`. Rentang 400–480 MHz kembali menjadi 100–1000 setelah pindah route. Bundle hasil build berisi `source:"simulated"`.

**Usulan perbaikan.** Saat perangkat yang mendukung sweep tersambung, pilih native atau manual. Simpan pilihan sumber dan pengaturan scan di `localStorage`. Selama `source === 'simulated'`, tampilkan badge SIMULATION yang mencolok di header sweep, status, dan canvas.

#### AUD-16 — Batas kandidat sweep dihapus: noise membanjiri riwayat tanpa batas, Save JSON ditolak, dan persistensi arsip tertinggal

- Severity: **high** · Area: Receiver: scan/sweep · Status: terkonfirmasi · Cluster: C055
- Lokasi: `tools/browsdr_receiver_overlay/src/client/worker/sweep-types.ts:1-11` (tidak ada `SWEEP_MAX_CANDIDATES`; upstream `vendor/BrowSDR/src/client/worker/sweep-types.ts:10` = 1000), `tools/browsdr_receiver_overlay/src/client/worker/sweep-processing.ts:196-260`, `tools/browsdr_receiver_overlay/src/client/worker/sweep-engine.ts:143`, `tools/browsdr_receiver_overlay/src/client/app/sweep.ts:837`

**Masalah.** Overlay membuang batas upstream `SWEEP_MAX_CANDIDATES = 1000` (dengan eviction kandidat tertua) dan merge berbasis overlap band, lalu menggantinya dengan identitas berbasis kedekatan puncak 50 kHz tanpa eviction. Deteksi membandingkan bin `current` dari satu sweep dengan persentil 25 rata-rata EMA ditambah `minSnrDb` (8 dB). Pada noise penerima biasa, beberapa persen bin melewati ambang itu di setiap sweep. Kandidat di worker dan `candidateMap` di main thread tumbuh tanpa batas, dan setiap laporan mengirim sekitar 16 ribu objek lewat Comlink.

**Dampak ke operator.** Dengan pengaturan default (100–1000 MHz, FFT 8192, SNR 8 dB) dan tanpa sinyal sama sekali, riwayat berisi sekitar 29.000 kandidat setelah sweep pertama dan terus naik. "Save JSON" gagal ("Sweep JSON exceeds the 8 MiB import limit") setelah satu sweep. Dengan arsip Records aktif, setiap sweep mengantrikan 16–29 ribu upsert (sekitar 2 s persist plus 1 s query grup), sehingga backlog menumpuk dan Stop harus menunggu "Saving archive…". CPU dan memori naik selama sesi panjang.

**Bukti.** Harness esbuild dari source build dengan FFT wasm yang dipin: sweep 1 overlay 29.227 kandidat vs upstream 1.000; sweep 40: 40.302 vs 1.000; 100–200 MHz selama 3.000 sweep: 19.740 dan masih tumbuh. Session JSON 11,1 MiB setelah 1 sweep.

**Usulan perbaikan.** Kembalikan batas riwayat (misalnya 1000 dengan eviction least-recently-seen), atau buang kandidat yang hits-nya tetap 1 setelah N sweep. Kurangi false alarm: wajibkan kandidat bertahan K sweep, atau deteksi pada trace rata-rata, bukan `current`. Throttle persistensi agar antrean tidak pernah berisi lebih dari satu batch.

#### AUD-17 — Grouping kandidat berantai transitif per 100 kHz dan menyembunyikan sinyal berbeda, termasuk yang terpisah beberapa MHz

- Severity: **high** · Area: Receiver: scan/sweep · Status: terkonfirmasi · Cluster: C056
- Lokasi: `tools/browsdr_receiver_overlay/src/client/app/candidate-bands.ts:3`, `tools/browsdr_receiver_overlay/src/client/app/candidate-bands.ts:11-40`, `tools/receiver_record_store.py:326-345`, `tools/browsdr_receiver_overlay/src/client/app/sweep.ts:123`

**Masalah.** `groupAdjacentCandidates` mengurutkan kandidat menurut frekuensi puncak dan memulai baris baru hanya bila puncak berikutnya lebih dari 100 kHz di atas ujung grup, tanpa batas lebar. Grup berantai secara transitif, dan hanya field kandidat terkuat yang disimpan. SQL di server (`LAG(peak_hz)`) berperilaku sama. Menggabungkan sinyal yang berjarak kurang dari 100 kHz memang desain peak-group, tetapi kandidat noise dari AUD-16 berjarak sekitar 17–20 kHz di seluruh span, sehingga menjembatani carrier yang terpisah megahertz.

**Dampak ke operator.** Tabel sinyal Spectrum, satu-satunya tempat tombol Listen, diam-diam menghilangkan sinyal nyata. Contoh: carrier dengan SNR sekitar 45 dB di 128 MHz tidak punya baris sendiri; ia terlipat ke baris 123,571–130,226 MHz yang puncak dan target Listen-nya adalah carrier lain di 125 MHz. Kanal lemah yang berjarak 62,5 kHz dari kanal kuat tidak pernah terdaftar. Baris terlebar pada run default mencakup 20,4 MHz noise murni.

**Bukti.** `test_grouping_hides.mjs` (100–140 MHz, carrier di 121,0 / 121,0625 / 125,0 / 128,0 MHz, 10 sweep): 1.743 kandidat menjadi 22 baris; sinyal 121,0625 MHz dan 128,0 MHz `HIDDEN`.

**Usulan perbaikan.** Kelompokkan berdasarkan overlap band yang terisi, bukan rantai jarak puncak ke puncak, atau batasi lebar total grup (misalnya 2 × adjacency). Terapkan perubahan yang sama di SQL `get_candidates` agar tampilan lokal dan arsip tetap identik. Kerjakan bersama pengurangan noise di AUD-16.

### 3.3 Medium

#### AUD-18 — Pergerakan bearing antar-frame yang normal dilaporkan sebagai NATIVE_DOA_VIEWS_CONFLICT pada node yang sehat

- **medium** · Collector & kontrak data · terkonfirmasi · C116
- Lokasi: `tools/sdr_doa_collector.py:742-790`, `frontend/src/lib/telemetry.ts:72`, `tools/test_sdr_doa_collector.py:125`
- Masalah: `collect()` membaca CSV dan XML berurutan. `assess_native_conflict()` sengaja menganggap pasangan dengan selisih timestamp hingga 2.000 ms masih bisa dibandingkan ("two neighboring processing frames"), tetapi tetap memakai toleransi sudut untuk frame yang sama (`ANGLE_CONSISTENCY_TOLERANCE_DEG = 1.0`). Bila node menulis frame baru di antara GET CSV dan GET XML dan bearing bergeser ≥ 2°, pasangan itu ditandai conflict. Tes frame bersebelahan yang ada hanya memakai sudut identik.
- Dampak: Sebagian refresh pada node sehat menampilkan DATA CONFLICT dengan readout dan plot kosong. Dalam simulasi sekitar 10% read; angkanya bergantung pada frame rate, latensi, dan jitter bearing. Operator jadi terbiasa mengabaikan CONFLICT, padahal gate itu dibuat untuk menangkap kesalahan konvensi yang nyata. Diagnostics tidak menampilkan selisih timestamp.
- Bukti: CSV frame N (θ 211) dan XML frame N+1 (213), selisih 289 ms → `conflict:true, circular_distance_deg:2`. Simulasi node 250 ms/frame dengan jitter ±2° selama 120 poll: 12 conflict, semuanya dengan `timestamp_delta_ms 250`.
- Perbaikan: Jalankan uji sudut hanya pada pasangan same-frame. Untuk frame bersebelahan, baca ulang CSV/XML (dibatasi, misalnya 2 kali) sampai TIME sama, atau laporkan "comparable: different frames" tanpa conflict. Tambahkan tes dan tampilkan `timestamp_delta_ms` di Diagnostics.

#### AUD-19 — Satu kegagalan baca `settings.json` memutar atau mencerminkan bearing yang ditampilkan tanpa peringatan

- **medium** · Collector & kontrak data · terkonfirmasi, dikoreksi · C117
- Lokasi: `frontend/src/lib/polar.ts:56-68`, `frontend/src/lib/polar.ts:93-111`, `frontend/src/pages/OverviewPage.tsx:40`, `tools/sdr_doa_collector.py:828-835`
- Masalah: Konvensi tampilan (`doa_fig_type`, `compass_offset`) di-resolve ulang dari setiap snapshot, dan tidak ada nilai last-known-good. Bila `settings.json` gagal di ketiga percobaan dalam satu poll sementara status, CSV, dan XML tetap segar, Overview diam-diam beralih ke konvensi fallback lokal (Compass, offset 0). Label fallback tidak pernah ditampilkan.
- Dampak: Selama satu periode refresh, Display Peak dan plot polar bergeser sebesar `compass_offset` (atau tercermin bila node memakai Polar), sementara strip dan badge tetap AVAILABLE/CURRENT. Nilai canonical dan bearing peta tidak terdampak.
- Bukti: `settings.json` {Compass, offset 45}, peak bin 60: kondisi normal `DISPLAY PEAK 345°`; `settings.json` HTTP 500 → `DISPLAY PEAK 300°` dengan strip tetap `DATA AVAILABLE … SNAPSHOT CURRENT`; setelah pulih kembali 345°.
- Perbaikan: Simpan settings Data Out terakhir yang berhasil dibaca (beserta waktunya) dan tetap pakai selama identitas node dan status tidak berubah. Bila belum pernah terbaca atau terlalu lama, tampilkan state "display settings unavailable" secara eksplisit.

#### AUD-20 — `compass_offset` dari Data Out dibuang bila `doa_fig_type` = `Linear` (default KrakenSDR)

- **medium** · Collector & kontrak data · terkonfirmasi · C114
- Lokasi: `frontend/src/lib/polar.ts:56-68`, `frontend/src/pages/OverviewPage.tsx:40`
- Masalah: `hasUsableDataOutCompassSettings()` menolak semua setting renderer Data Out begitu `doa_fig_type` bukan polar atau compass. Upstream default ke `Linear` dan selalu menulis `compass_offset` di sebelahnya. `resolveCompassSource()` lalu memakai fallback {Compass, 0}, dan label fallback tidak dirender.
- Dampak: Pada node yang array-nya dipasang dengan offset bukan nol, Display Peak dan plot polar berputar tepat sebesar offset itu (30° dalam tes) selama UI Kraken memakai plot Linear. Mengubah plot Kraken ke Compass seolah "memperbaiki" bearing di console, yang membingungkan.
- Bukti: {Linear, offset 30} → FALLBACK {Compass, 0}, `DISPLAY PEAK 350°`; {Compass, offset 30} → `DISPLAY PEAK 20°`.
- Perbaikan: Validasi `doa_fig_type` dan `compass_offset` secara terpisah: untuk Linear atau nilai tidak dikenal, pakai sumbu fallback tetapi tetap gunakan offset finite dari Data Out, dan beri label sumbernya (misalnya "DATA_OUT OFFSET · LOCAL AXIS"). Masukkan ke adapter AUD-01.

#### AUD-21 — Peta tetap menggambar lobe, heat, dan bearing saat CSV/XML CONFLICT atau `doa.xml` hilang, sementara readout dan polar kosong

- **medium** · Frontend: peta · terkonfirmasi · C080
- Lokasi: `frontend/src/components/TacticalMap.tsx:104-108`, `frontend/src/lib/polar.ts:157`, `frontend/src/lib/telemetry.ts:54-66`, `frontend/src/App.tsx:80-104`
- Masalah: Overlay peta hanya mensyaratkan `localSnapshotFresh !== false` dan vektor 360 bin, bukan `polarDataReady` seperti readout dan polar. Bila `canonical_angle_deg` kosong (kandidat dikarantina), peta memakai `angular_peak_index`, padahal hal itu dilarang `MAPLIBRE_DOA_OVERLAY_PLAN.md:151`.
- Dampak: Header menyatakan DATA CONFLICT / DOA UNAVAILABLE dan readout "No fresh DoA record", tetapi peta menampilkan lobe penuh, heat, tepi −3 dB, dan garis bearing 90.0°. Dengan GPS MANUAL, tampilan peta terlihat sepenuhnya valid.
- Bukti: Conflict (XML selisih 40°): readout "—", polar "NOT READY", peta "360 bins · 90° reference" tanpa chip "Overlay cleared". `doa.xml` 404: hasil serupa.
- Perbaikan: Pakai satu predikat kesiapan bersama (local fresh && `polarDataReady` && vektor lengkap && sudut canonical ada) untuk peta, readout, dan polar. Hapus fallback `angular_peak_index`.

#### AUD-22 — Output multi-VFO (Output VFO = ALL) atau format "Kerberos App" membuat CSV selalu ditolak dan Overview kosong tanpa reason

- **medium** · Collector & kontrak data · terkonfirmasi · C003
- Lokasi: `tools/sdr_doa_collector.py:455`, `tools/sdr_doa_collector.py:968`, `frontend/src/lib/telemetry.ts:54-66`
- Masalah: `_parse_csv_row` hanya menerima tepat satu baris. Upstream menulis satu baris per VFO bila `output_vfo < 0` dan lebih dari satu VFO lolos squelch, dan format Kerberos App menulis snippet XML ke file yang sama. CSV ditandai unavailable, `assess_native_conflict` memberi comparable=false, dan tidak ada reason gate yang ditambahkan.
- Dampak: Pada node multi-VFO yang berfungsi, Overview terus menampilkan "No fresh DoA record", DATA STALE, DOA UNAVAILABLE. Diagnostics menampilkan CSV MISSING dengan semua check PASS dan tanpa reason, sehingga operator tidak tahu penyebabnya.
- Bukti: Dua baris format upstream: `csv {"available": false, "error": "expected one CSV row, found 2"}`, XML segar (canonical 350), reason tidak berubah.
- Perbaikan: Terima 1..16 baris, pilih baris yang cocok dengan XML/VFO utama, dan ekspos sisanya sebagai record VFO tambahan. Tambahkan reason seperti `CSV_VIEW_UNAVAILABLE` beserta error parse-nya.

#### AUD-23 — Jendela freshness tidak menghitung waktu koleksi, sehingga record DoA berumur hingga ~10 s tampil CURRENT

- **medium** · Server console & konfigurasi · terkonfirmasi · C011
- Lokasi: `tools/sdr_doa_collector.py:837-844`, `frontend/src/App.tsx:61-73`, `frontend/src/App.tsx:80-104`
- Masalah: Umur kandidat dihitung terhadap `timestamp_ms` status yang dibaca pertama, lalu di-clamp ke ≥ 0. Waktu di sisi Ground sejak `retrieved_at_ms` sampai respons diterima tidak pernah ditambahkan. `localSnapshotFresh()` membuka jendela 5 s penuh terhitung sejak respons diterima.
- Dampak: Pada Data Out yang lambat, bearing dan spektrum dari CSV dilabeli CURRENT selama 5 s setelah tiba, padahal sudah berumur beberapa detik. Umur efektif bisa hampir dua kali batas 5 s yang terdokumentasi.
- Bukti: `doa.xml` ditunda 4,5 s: snapshot butuh 4,57 s, CSV dibaca 38 ms setelah `observed_at` tetapi `age_ms 0`. Playwright: CURRENT dari 4,65 s sampai 10,06 s.
- Perbaikan: Tambahkan selisih waktu Ground (selesai − `retrieved_at_ms`) ke `age_ms`, atau ekspos `collected_at_ms` dan `retrieved_at_ms` agar frontend bisa menguranginya. Keduanya berasal dari jam Ground, jadi tetap valid dalam mode `remote_unverified`.

#### AUD-24 — Semua interval refresh yang ditawarkan (manual, 5, 10, 30 s) tidak lebih pendek dari jendela freshness DoA 5 s

- **medium** · Frontend: status & freshness · terkonfirmasi, dikoreksi · C090
- Lokasi: `tools/ground_console.py:174`, `tools/ground_console.py:264`, `tools/sdr_doa_collector.py:31`, `frontend/src/pages/ConfigurationPage.tsx:266-270`, `frontend/src/App.tsx:369-375`
- Masalah: `ALLOWED_REFRESH_INTERVALS = {0, 5, 10, 30}` dengan default 0 (manual), sedangkan `DEFAULT_DOA_MAX_AGE_MS = 5000`. Jendela lokal = 5000 ms − umur DoA saat dibaca. Pengosongan data yang kedaluwarsa memang disengaja; masalahnya, tidak ada interval yang lebih pendek dari jendela itu dan tidak ada peringatan di Configuration.
- Dampak: Dengan default manual, atau dengan interval 10 s dan 30 s, bearing, kurva polar, dan overlay kosong atau STALE pada sebagian besar siklus (≥ 5 dari 10 s, 25 dari 30 s). Pada 5 s celahnya hanya sebesar umur DoA saat dibaca; kedipan yang terlihat pada 5 s terutama berasal dari AUD-08.
- Bukti: Refresh 10 s dengan lag DoA 1,5 s: CURRENT sekitar 3,8 s dan STALE sekitar 6,2 s per siklus.
- Perbaikan: Tawarkan interval 1 s dan 2 s dan jadikan salah satunya default, atau jadwalkan read berikutnya dari sisa jendela freshness (max_age − age − latensi). Tambahkan peringatan bila interval lebih panjang dari jendela.

#### AUD-25 — Data Out tak terjangkau atau status invalid ditampilkan sebagai STALE, bukan UNAVAILABLE, bahkan tepat setelah read selesai

- **medium** · Frontend: status & freshness · terkonfirmasi · C091
- Lokasi: `frontend/src/components/Shell.tsx:118-122`, `frontend/src/App.tsx:85`, `frontend/src/pages/SystemHealthPage.tsx`
- Masalah: `localSnapshotFresh` bernilai false bila `status.available !== true`, dan Shell memetakan semua snapshot yang tidak segar ke STALE, sehingga cabang UNAVAILABLE di `deriveDataState` tidak pernah sampai ke strip. SNAPSHOT juga STALE untuk read yang baru saja selesai. System Health menampilkan banner "health values are not current".
- Dampak: Saat perangkat dicabut atau Data Out menolak koneksi, console mengesankan data lama, bukan "Data Out tidak tersedia". Pada load pertama ke node mati, console menulis STALE untuk data yang tidak pernah ada.
- Bukti: Snapshot `UNAVAILABLE … resource fetch failed [STATUS_UNAVAILABLE_OR_INVALID, …]`; UI setelah read sukses: `Data=STALE DoA=UNAVAILABLE Snapshot=STALE`.
- Perbaikan: Klasifikasikan snapshot lebih dulu (UNAVAILABLE, CONFLICT, DEGRADED, INCOMPLETE) dan pakai STALE hanya untuk snapshot valid yang jendelanya sudah habis. Pertahankan SNAPSHOT CURRENT untuk read yang baru selesai, apa pun isinya.

#### AUD-26 — Tidak ada state INVALID/INCOMPLETE: view native yang hilang, invalid, atau tak terbandingkan ditampilkan STALE di samping SNAPSHOT CURRENT

- **medium** · Frontend: status & freshness · terkonfirmasi · C092
- Lokasi: `frontend/src/lib/telemetry.ts:70-78`, `frontend/src/App.tsx:80-104`, `frontend/src/components/Shell.tsx:118`, `frontend/src/pages/SystemHealthPage.tsx:30`
- Masalah: `deriveDataState()` mengembalikan STALE setiap kali `nativeViewsReady()` false, termasuk saat view hilang atau tidak bisa diparse, padahal tidak ada yang lama. `overall_state` collector (INVALID bila tidak ada view yang terparse, UNVERIFIED bila XML hilang) tidak pernah dipetakan. Health menampilkan badge hijau AVAILABLE di samping headline "INVALID".
- Dampak: Record Data Out yang rusak terlihat seperti record lama, sehingga operator menunggu atau me-restart DSP alih-alih memeriksa format output. Tampilan saling bertentangan, dan pada kasus `doa.xml` hilang peta tetap menggambar bearing.
- Bukti: Fixture malformed/nonfinite/partial: overall INVALID, `localSnapshotFresh` true, `deriveDataState` STALE; strip `DATA STALE | DOA UNAVAILABLE | SNAPSHOT CURRENT`; Health "AVAILABLE INVALID".
- Perbaikan: Tambahkan INVALID dan INCOMPLETE ke `DataState`, kembalikan state itu sebelum cabang STALE, petakan `overall_state` secara eksplisit, dan tampilkan error kandidat.

#### AUD-27 — Penyebab kegagalan tidak pernah tampil di layar: error collector dibuang dan read error hanya ada di tooltip

- **medium** · Frontend: halaman, i18n, layout · terkonfirmasi · C104
- Lokasi: `frontend/src/pages/SystemHealthPage.tsx`, `frontend/src/pages/DoADiagnosticsPage.tsx:48`, `frontend/src/components/Shell.tsx:267`
- Masalah: Tidak ada `.tsx` yang merender `status.error`, `doa_candidates.*.error`, `settings.error`, atau `resources[*].error`/`http_status`. Diagnostics hanya menampilkan PRESENT/MISSING per record native, dan `readError` hanya muncul sebagai atribut `title`.
- Dampak: Halaman yang dibuat untuk diagnosis tidak bisa memberi tahu operator mengapa Data Out gagal (host tak terjangkau, 404, CSV rusak, timeout). Di perangkat sentuh, tooltip tidak bisa dilihat sama sekali.
- Bukti: Mode down: teks halaman Health tidak memuat "connection refused" walau `status.error` memuatnya. Error collector 502: `document.body.innerText.includes('simulated collector failure') → false`.
- Perbaikan: Render error status, kandidat, dan HTTP status di inspector Health dan record native Diagnostics. Tampilkan `readError` sebagai teks yang terlihat (banner inline atau di bawah label read).

#### AUD-28 — Legacy UI (`--legacy-ui`) tidak punya timeout request atau expiry lokal, sehingga bearing terakhir tetap berlabel segar saat Data Out tidak merespons

- **medium** · Server console & konfigurasi · terkonfirmasi · C010
- Lokasi: `tools/ground_console.py:1288-1314` (script halaman legacy)
- Masalah: `refresh()` membatalkan request sebelumnya di setiap tick, fetch tidak punya timeout, `AbortError` diabaikan, dan DOA AGE hanya ditulis saat respons datang. Tidak ada yang menuakan tampilan atau mengosongkannya secara lokal.
- Dampak: Operator legacy UI melihat bearing 211.0°, DATA AVAILABLE, DOA AGE 0.0 s, dan DAQ PASS lama setelah link mati. Petunjuknya hanya "Reading Data Out…" dan stempel waktu last-read yang tidak bergerak.
- Bukti: Setelah semua resource dibuat macet, sampel pada +5 s sampai +25 s semuanya `doa-age:'0.0 s'`, `polar-canonical:'211.0°'`.
- Perbaikan: Tambahkan timeout request dan expiry lokal setara `localSnapshotFresh`, dan lewati tick bila request masih berjalan. Deadline collector (AUD-09) ikut membatasi dampaknya.

#### AUD-29 — Saat celah freshness dan tanpa fix GPS, stasiun diam-diam pindah ke koordinat fallback Bandung

- **medium** · Frontend: peta · terkonfirmasi · C083
- Lokasi: `frontend/src/pages/OverviewPage.tsx:38`, `frontend/src/lib/map.ts:103-110`, `frontend/src/App.tsx:171`
- Masalah: GPS di-resolve dari `localSnapshotFresh ? snapshot : null`. Setiap kali snapshot dianggap tidak segar (setiap request, lihat AUD-08, dan setelah jendela habis), `resolveGpsSource` mengembalikan koordinat FALLBACK yang non-null, bukan koordinat live terakhir yang ditandai stale.
- Dampak: Marker dan ring berpindah keluar layar sekitar 0,7–0,8 s di setiap refresh 5 s, dan sel posisi bergantian antara koordinat nyata dan Bandung. Tanpa fix GPS, bearing live digambar dari Bandung kecuali operator memasukkan posisi manual lagi setelah setiap reload (AUD-39).
- Bukti: Sampling setiap 25 ms: `STATION POSITION` ↔ `REFERENCE ONLY · NOT LIVE GPS` berulang setiap 5 s.
- Perbaikan: Saat data hanya kedaluwarsa secara lokal, pertahankan koordinat live terakhir dengan tanda STALE (atau sembunyikan marker). Gambar geometri DoA live di atas FALLBACK hanya bila operator memilih mode referensi secara eksplisit.

#### AUD-30 — Field angka overlay divalidasi dan di-clamp di setiap ketikan, sehingga nilai rusak dan overlay bisa hilang secara persisten

- **medium** · Frontend: peta · terkonfirmasi · C084
- Lokasi: `frontend/src/components/OverlayControls.tsx:5`, `frontend/src/components/OverlayControls.tsx:48-52`, `frontend/src/components/TacticalMap.tsx` (`updateSettings`)
- Masalah: Input number dikontrol penuh; setiap event input menjalankan `validateOverlaySettings`, `saveOverlaySettings`, clamp, dan aturan `maxDb = minDb + 1`. `''` dan `'-'` dibaca sebagai 0.
- Dampak: Mengetik "-80" di Minimum dB menghasilkan min 20 / max 20, overlay DoA hilang, dan tetap hilang setelah reload. Mengetik 2500 m menjadi 20 km, 700 m menjadi 10 km. Satu-satunya cara memperbaiki skala live yang jenuh (AUD-07) jadi tidak praktis.
- Bukti: Ctrl+A lalu ketik: "2500" → 20000, "700" → 10000, "16" → 26, Maximum dB "-10" → 010.
- Perbaikan: Simpan draft string per field, validasi saat blur, Enter, atau tombol Apply, anggap `''`/`'-'` belum lengkap, dan tampilkan error inline untuk min ≥ max alih-alih menulis ulang max.

#### AUD-31 — WebGL context lost dan kegagalan worker tidak ditangani: layer GL hilang diam-diam dan canvas fallback tidak aktif

- **medium** · Frontend: peta · terkonfirmasi · C125
- Lokasi: `frontend/src/components/TacticalMap.tsx:150-163`, `frontend/src/components/TacticalMap.tsx:315`
- Masalah: `mapState` hanya menjadi `error` dari event `error` MapLibre. Event `webglcontextlost` tidak ditangani (MapLibre tidak menembakkan `error` untuk itu), dan worker yang gagal dimuat juga tidak menghasilkan error.
- Dampak: Setelah reset GPU, sleep/resume, atau gangguan driver pada stasiun yang berjalan lama (atau bila asset worker diblokir), peta hanya menampilkan label DOM ("250 m", "211.0°") dan legenda tanpa garis maupun lobe, dan tanpa peringatan. Chip DoA tetap AVAILABLE. `initialize.md:50` menjanjikan canvas fallback untuk kasus ini.
- Bukti: `loseContext()` lalu R: strip `DoA=AVAILABLE … CURRENT`, canvas fallback hidden, frame peta putih. Worker 404: hasil yang sama.
- Perbaikan: Tangani `webglcontextlost`/`webglcontextrestored` dengan state `gl-lost` yang mengaktifkan canvas fallback dan menampilkan notice. Pertimbangkan watchdog bila `setData` tidak diikuti `idle` dalam N detik.

#### AUD-32 — Host tile OSM "fallback" sebenarnya round-robin: bila satu host diblokir, separuh tile basemap hilang

- **medium** · Frontend: peta · terkonfirmasi · C140
- Lokasi: `frontend/src/lib/map.ts:4-8`, `frontend/src/components/TacticalMap.tsx:134`, `frontend/src/components/TacticalMap.tsx:150-153`, `evaluasi GUI.md:95`, `SDR_DOA_FRONTEND_WORKFLOW.md:59`
- Masalah: `OSM_TILE_TEMPLATES = [.de, .org]` diberikan sebagai array `tiles`. MapLibre membagi tile ke URL dengan `urls[(x + y) % urls.length]`, bukan mencoba URL berikutnya bila gagal. Komentar di `onError` menyebut alternatif "is retried", tetapi tidak ada retry.
- Dampak: Justru di jaringan terbatas yang menjadi alasan fitur ini dibuat, operator melihat basemap berpola papan catur, termasuk tile kosong di bawah stasiun, tanpa penjelasan (lihat juga AUD-89).
- Bukti: `.org` diblokir: request {org 13, de 8}, screenshot papan catur; `.de` diblokir: pola yang sama; tidak ada request yang diulang ke host lain.
- Perbaikan: Pakai satu template, dan saat error raster berulang ganti dengan `getSource('osm').setTiles([lain])`, atau biarkan operator memilih host. Perbaiki komentar dan dokumentasi.

#### AUD-33 — Zoom dan rotasi polar dari operator di-reset atau rusak setiap kali data sesaat tidak segar

- **medium** · Frontend: polar & readout · terkonfirmasi · C096
- Lokasi: `frontend/src/components/PolarPlot.tsx:6-11`, `frontend/src/components/PolarPlot.tsx:62-64`, `frontend/src/pages/OverviewPage.tsx:38-40`
- Masalah: Selama request (AUD-08), `values` bernilai null dan `radialDomain(null)` mengembalikan [−60, 0], sehingga layout key berubah dan `plot.react` mengirim range baru. Dengan `evidence` null, konvensi compass jatuh ke default, sehingga `polarUiRevision` ikut berubah bila node memakai Polar atau offset bukan nol.
- Dampak: Zoom radial tidak bertahan melewati refresh biasa: range melompat ke nilai yang tidak dipilih operator atau reset total. Dengan Data Out Polar, rotasi hasil drag dan label sumbu reset di setiap refresh.
- Bukti: Zoom [7.0, 21.1] → [7, 30] setelah satu refresh; rotasi 38,3° → 90 pada Data Out Polar.
- Perbaikan: Pertahankan domain radial terakhir saat `values` null, dan resolve setting compass dari snapshot terakhir yang memilikinya. Menghapus `!loading` (AUD-08) menghilangkan sebagian besar pemicunya.

#### AUD-34 — Menerapkan Head Up saja memaksa range manual −60..0 dB, sehingga data live menjadi cakram penuh

- **medium** · Frontend: polar & readout · terkonfirmasi · C097
- Lokasi: `frontend/src/components/PolarPlot.tsx:32`, `frontend/src/components/PolarPlot.tsx:120-130`
- Masalah: State draft dimulai dari {head 0, min −60, max 0} dan hanya disinkronkan ulang oleh tombol Default. Submit selalu mengaktifkan mode manual dengan min/max dari draft.
- Dampak: Operator yang membuka Graph settings, mengisi Head Up 90, lalu menekan Apply kehilangan lobe: plot menjadi lingkaran terisi penuh dengan caption "manual scale -60 to 0 dB". Default memulihkannya.
- Bukti: Data live 0..30 dB: setelah Head Up 90 dan Apply, range [0, 60] dengan r min 60 max 90, plot berupa cakram penuh.
- Perbaikan: Inisialisasi dan sinkronkan draft min/max dari `radialDomain(values)`, atau pisahkan Head Up dari range manual (misalnya dengan checkbox "manual range").

#### AUD-35 — Skala radial auto dibulatkan ke kelipatan 10 dB, sehingga spektrum KrakenSDR berkontras rendah tampil sebagai gumpalan kecil

- **medium** · Frontend: polar & readout · terkonfirmasi · C098
- Lokasi: `frontend/src/components/PolarPlot.tsx:6-11`, `SDR_DOA_8081_DATA_REFERENCE.md:309`
- Masalah: `radialDomain` membulatkan minimum ke bawah dan maksimum ke atas ke kelipatan 10 dB, sehingga setiap span ≤ 10 dB mendapat [0, 10]. Snapshot live referensi repo memiliki span 0,00–1,46 dB.
- Dampak: Kurva hanya mengisi sekitar 15% radius. Membaca arah butuh pengaturan range manual, dan jalur itu punya jebakan sendiri (AUD-34).
- Bukti: Span 1,46 dB → range [0, 10], lobe di dalam ring terdalam.
- Perbaikan: Pilih step dari span data (1/2/5 × 10^k dengan span minimum sekitar 1–3 dB), atau skala ke [floor, max] dengan padding.

#### AUD-36 — Modebar Plotly menyertakan tombol "Share chart..." yang menawarkan unggah vektor DoA ke Plotly Cloud

- **medium** · Frontend: polar & readout · terkonfirmasi · C123
- Lokasi: `frontend/src/components/PolarPlot.tsx:93`, `frontend/src/lib/i18n.ts:29`
- Masalah: Config Plotly hanya `{ responsive, displaylogo: false, displayModeBar: true }`. Di plotly.js-dist-min 4.1.1, `showSendToCloud` default true dengan `plotlyServerURL` `https://cloud.plotly.com/newchart`. Klik Share membuka jendela ke cloud.plotly.com, lalu figure lengkap, termasuk kurva 360 bin, dikirim lewat `postMessage`. CSP tidak menghalanginya karena ini `window.open` tingkat atas.
- Dampak: Dua klik pada ikon di samping plot utama mengirim data DoA live ke layanan pihak ketiga. Ini berlawanan dengan footer di setiap layar ("No remote writes · Angular vectors stay local") dan aturan AGENTS.md. Saat offline, tombol itu hanya membuka tab error. Dialognya juga tidak diterjemahkan.
- Bukti: Judul tombol modebar: `Download plot as a PNG ; Share chart... ; Zoom`. Setelah Share: `GET https://cloud.plotly.com/newchart?origin=http%3A%2F%2F127.0.0.1%3A8787` dan halaman baru terbuka.
- Perbaikan: Set `showSendToCloud: false` (dan `plotlyServerURL: ''`) atau `modeBarButtonsToRemove: ['sendChartToCloud']`, batasi modebar ke tombol yang diperlukan, dan tambahkan tes config.

#### AUD-37 — "Download plot as a PNG" di polar selalu gagal karena CSP `img-src` tidak memuat `blob:`

- **medium** · Frontend: polar & readout · terkonfirmasi · C124
- Lokasi: `tools/ground_console.py:1825`, `frontend/src/components/PolarPlot.tsx:93`
- Masalah: CSP aplikasi utama `img-src 'self' data: <dua host OSM>` menolak blob: URL yang dipakai `toImage` Plotly di Chromium. CSP Receiver (`ground_console.py:1813`) mengizinkan `blob:`. Ini mekanisme keamanan yang menghalangi fitur sah yang ditampilkan menonjol.
- Dampak: Operator yang ingin menyimpan pola DoA untuk laporan atau log selalu mendapat "Sorry, there was a problem downloading your image!". Tidak ada cara ekspor lain dari UI.
- Bukti: `[requestfailed] GET blob:http://127.0.0.1:8787/… csp`, tidak ada event download.
- Perbaikan: Tambahkan `blob:` ke `img-src` aplikasi utama, atau hapus tombolnya. Tambahkan tes regresi.

#### AUD-38 — Overview mengevaluasi seluruh bundle Plotly 4,6 MB dalam satu task main thread (beku 1,2–1,4 s; sekitar 6–7 s di CPU 4x lebih lambat)

- **medium** · Performa · terkonfirmasi · C148
- Lokasi: `frontend/src/components/PolarPlot.tsx:51`, `frontend/package.json:15`, `frontend/src/pages/OverviewPage.tsx:11`
- Masalah: `PolarPlot` mengimpor `plotly.js-dist-min` lengkap (4.775.071 byte) saat Overview di-mount, padahal hanya satu trace `scatterpolar` yang dipakai. Evaluasi modul berlangsung sebagai satu task yang tidak bisa diinterupsi, setelah peta dan tombol sudah tergambar. Komentar `OverviewPage.tsx:11` menyebut MapLibre sebagai dependency terbesar, padahal Plotly 4,5x lebih besar.
- Dampak: Saat awal shift, setelah browser atau kiosk di-restart, atau setelah rebuild, peta tampak siap tetapi tidak merespons klik, pan, maupun shortcut selama lebih dari 1 s (6–7 s di laptop lapangan lambat), dan klik diproses beberapa detik kemudian. Biaya ini muncul lagi di setiap start browser; reload dalam proses browser yang sama lebih murah (0,3–0,45 s).
- Bukti: 1x: long task 658–1319 ms, klik Layers pada 1.002 ms baru diproses pada 2.185 ms. 4x: long task 6.664 ms, polar muncul pada 8.569 ms. Dengan chunk Plotly diblokir, task terbesar sekitar 500 ms.
- Perbaikan: Bangun bundle Plotly parsial (`plotly.js/lib/core` + `scatterpolar`), atau pakai renderer ringan (`drawPolarCanvas` sudah ada), atau tunda impor sampai idle dengan placeholder. Perbaiki komentar di `OverviewPage.tsx`.

#### AUD-39 — Konfigurasi sumber GPS dan Compass hilang setiap reload, walau copy menyebut "local to this browser"

- **medium** · Frontend: halaman, i18n, layout · terkonfirmasi, dikoreksi · C103
- Lokasi: `frontend/src/App.tsx:171-172`, `frontend/src/pages/ConfigurationPage.tsx:125`, `frontend/src/lib/i18n.ts:435`
- Masalah: `gpsConfig` dan `compassConfig` hanya berupa `useState(DEFAULT_*)` dan tidak disimpan di mana pun. Configuration tidak memberi peringatan, berbeda dengan copy Simulation yang menyatakan reset saat reload.
- Dampak: Di stasiun yang node-nya melaporkan GPS "Disabled" (seperti fixture valid), posisi MANUAL dan sumbu/offset compass manual kembali ke DATA_OUT dan default setiap reload, restart browser, atau reboot kiosk. Marker dan bearing kembali ke Bandung, dan orientasi polar bisa tercermin sampai operator mengisi ulang. Caption memang menunjukkan "DATA_OUT GPS · DEFAULT FALLBACK".
- Bukti: Set MANUAL −7,25 / 112,75 lalu `page.reload()`: `gps after reload: DATA_OUT -6.932468…`.
- Perbaikan: Simpan `GpsConfig` dan `CompassConfig` yang sudah divalidasi (`localStorage` dengan validasi saat restore, seperti setting overlay, atau config server), atau tulis dengan jelas bahwa nilainya reset saat reload.

#### AUD-40 — Link "Skip to workspace" memindahkan operator ke Overview dari halaman mana pun

- **medium** · Frontend: halaman, i18n, layout · terkonfirmasi · C105
- Lokasi: `frontend/src/components/Shell.tsx:210`, `frontend/src/components/Shell.tsx:26`
- Masalah: `<a href="#console-content">` tidak diintersep. Routing berbasis hash, dan `routeFromHash('console-content')` tidak cocok dengan route mana pun sehingga mengembalikan `overview`.
- Dampak: Pengguna keyboard yang menekan Enter pada tab stop pertama di Configuration atau Health dipindahkan ke Overview, dan edit Configuration yang belum disimpan hilang.
- Bukti: Di `#/configuration`, Enter pada `.skip-link` → `route title: Overview`.
- Perbaikan: Tangani di JS (`preventDefault`, lalu fokus `#console-content`), dan pastikan anchor di dalam halaman tidak dianggap pergantian route.

#### AUD-41 — Save konfigurasi membandingkan input mentah dengan read-back yang sudah dinormalisasi server, sehingga melaporkan gagal padahal server sudah menyimpan

- **medium** · Server console & konfigurasi · terkonfirmasi · C012
- Lokasi: `tools/ground_console.py:305`, `frontend/src/api.ts:149`, `frontend/src/api.ts:188`, `frontend/src/pages/ConfigurationPage.tsx:154`
- Masalah: Server menormalkan input (`rstrip('/')`, `strip()`, `int(port)`) lalu menyimpan dan menerapkannya. Klien membandingkan nilai mentah dengan hasil GET secara strict dan melempar error sebelum `onConfigSaved` dipanggil.
- Dampak: URL yang ditempel dari address bar dengan garis miring di akhir menghasilkan "console config read-back did not match", sehingga tampak gagal. Server sudah beralih ke URL baru, tetapi tab ini terus mem-poll URL lama sampai reload. Port pecahan seperti 1883,9 terpotong diam-diam.
- Bukti: `http://127.0.0.1:8081/` → pesan mismatch; GET mengembalikan `http://127.0.0.1:8081`, sementara request snapshot tetap ke base_url lama.
- Perbaikan: Normalkan di klien sebelum POST, atau bandingkan dengan respons POST. Tolak port non-integer di server.

#### AUD-42 — Chunk lazy TacticalMap tidak di-prefetch dan tidak ada error boundary, sehingga setelah rebuild atau restart seluruh app kosong saat membuka Overview

- **medium** · Server console & konfigurasi · terkonfirmasi · C017
- Lokasi: `frontend/src/pages/OverviewPage.tsx:13`, `frontend/src/App.tsx:25-32`, `frontend/src/App.tsx:445`
- Masalah: `prefetchRoutes()` hanya memanaskan enam chunk halaman, tidak termasuk `TacticalMap`. Tidak ada error boundary maupun handler `vite:preloadError`, sehingga dynamic import yang gagal meng-unmount root.
- Dampak: Operator yang membuka console di `#/configuration` atau `#/receiver` lalu console di-rebuild atau di-restart mendapat halaman kosong saat pindah ke Overview, dan tetap kosong sampai reload manual.
- Bukti: Asset `TacticalMap-*.js` di-rename, lalu tekan 1: `404 /assets/TacticalMap-….js`, root text length 0.
- Perbaikan: Tambahkan error boundary dengan tombol reload, retry import sekali (atau reload saat chunk-load error), dan masukkan `TacticalMap` ke `prefetchRoutes`.

#### AUD-43 — Baris metrik Message Monitor tetap 5 kolom di ponsel, sehingga nilai terpotong

- **medium** · Frontend: halaman, i18n, layout · terkonfirmasi · C032
- Lokasi: `frontend/src/styles.css:61`, `frontend/src/console-design.css:442`
- Masalah: Override mobile `.monitor-metrics` (spesifisitas 0,1,0) kalah dari `.metric-grid.five` (0,2,0).
- Dampak: Pada 360–430 px, nilai Received/Valid/Invalid/Bytes/Latency terpotong, bahkan "N/A" pada 360 px, dan label Indonesia terpecah di tengah kata ("TIDA K VALID").
- Bukti: Grid terhitung 5 × 62 px pada 360 px; scrollWidth 40 vs clientWidth 34.
- Perbaikan: Naikkan spesifisitas override (`.metric-grid.monitor-metrics`) atau hapus kelas `five` pada elemen ini.

#### AUD-44 — State MQTT hanya dibaca bersamaan dengan refresh snapshot dan tidak pernah dituakan

- **medium** · MQTT monitor · terkonfirmasi · C028
- Lokasi: `frontend/src/App.tsx:219`, `frontend/src/App.tsx:298`, `frontend/src/App.tsx:335`, `frontend/src/App.tsx:369-375`, `frontend/src/components/Shell.tsx:124-125`
- Masalah: `refreshMqtt()` hanya dipanggil saat config dimuat, saat config disimpan, setelah refresh Data Out berhasil, dan dari tombol manual. Tidak ada interval tersendiri, dan default refresh adalah manual. `last_age_ms` dari server ditampilkan statis.
- Dampak: Dengan pengaturan default, Message Monitor dan strip shell menampilkan satu snapshot dari saat halaman dimuat: counter tidak bertambah dan status "MQTT CONNECTED" tetap tampil setelah broker mati.
- Bukti: Setelah publisher sintetis berjalan 4 s dan menunggu 6 s: tetap `RECEIVED | 2`; setelah "Refresh metrics": `RECEIVED | 18`.
- Perbaikan: Poll `/api/mqtt` dengan interval sendiri (1–2 s saat Monitor atau Health terlihat), dan hitung umur secara lokal dari `last_received_at_ms`.

#### AUD-45 — Kolom "Count" di Message Monitor selalu N/A

- **medium** · MQTT monitor · terkonfirmasi · C016
- Lokasi: `frontend/src/pages/MessageMonitorPage.tsx:94`, `tools/sdr_doa_mqtt_monitor.py:336-341`, `tools/sdr_doa_mqtt_monitor.py:383`
- Masalah: Backend menghitung `topic_counts` per topic lengkap, sedangkan UI mencarinya per kind (`topic_counts[kind]`). Kuncinya tidak pernah cocok.
- Dampak: Hitungan per jenis pesan, tujuan utama panel Kind counters, tidak pernah tampil, sehingga operator tidak bisa melihat laju atau stream mana yang datang.
- Bukti: Baris `doa | N/A | VALID …` sementara `/api/mqtt` berisi `{"sdr/v1/uav-01/telemetry/doa": 4, …}`.
- Perbaikan: Ekspos `kind_counts` dari backend, atau agregasikan per `_kind_for_topic` sebelum dirender.

#### AUD-46 — Tampilan record terdekode meredaksi flag `valid`/`doa_valid`/`settings_valid`, sementara baris menampilkan badge VALID hijau

- **medium** · MQTT monitor · terkonfirmasi · C029
- Lokasi: `frontend/src/lib/telemetry.ts:170`, `frontend/src/pages/MessageMonitorPage.tsx:94`, `tools/sdr_doa_mqtt_monitor.py:313-318`
- Masalah: Regex identifier `/(station|unit|hardware|serial|client|device|host|topic|id)$/i` tidak dibatasi token, sehingga `valid` (berakhiran "id") ikut diredaksi. Badge VALID berasal dari keberhasilan decode kontrak, bukan dari isi `valid`.
- Dampak: Untuk pesan DoA yang ditandai node sebagai tidak valid, operator melihat badge hijau VALID dan `"valid": "[REDACTED]"`, sehingga validitas bearing tidak bisa dibaca.
- Bukti: `safeMqttEntries` pada payload sintetis: `doa.payload.valid: "[REDACTED]"`, `health.payload.doa_valid: "[REDACTED]"`.
- Perbaikan: Batasi pola ke token utuh (misalnya `(^|_)(id|serial|host|…)$`) atau pakai allowlist key kontrak. Tampilkan `valid` dan `doa_valid` di samping badge validitas kontrak.

#### AUD-47 — Message Monitor tidak punya umur per kind: record DoA berumur 10 menit tampil VALID dengan latency 0 ms

- **medium** · MQTT monitor · terkonfirmasi · C030
- Lokasi: `frontend/src/lib/telemetry.ts:179`, `frontend/src/pages/MessageMonitorPage.tsx:94`, `tools/sdr_doa_mqtt_monitor.py:342`
- Masalah: Satu-satunya field umur adalah `last_age_ms` global. `safeMqttEntries` membuang `received_at_ms`, dan tabel hanya punya kolom Kind, Count, Validity, Bytes, Latency.
- Dampak: Bila LAN agent berhenti mengirim DoA (gate BLOCKED) tetapi terus mengirim health, DoA terakhir tetap tampil VALID dengan latency kecil dan "Last message age" mendekati nol. DoA lama terlihat terkini.
- Bukti: Satu DoA lalu 600 health selama 10 menit: `last_age_ms = 0`, `doa valid = True`, umur sebenarnya 600.000 ms.
- Perbaikan: Tambahkan kolom umur per kind dari `received_at_ms` dengan tick lokal dan tone stale per ambang.

#### AUD-48 — "Reconnect local monitor" tidak melakukan apa-apa (tetapi melaporkan sukses) bila host/port tidak berubah

- **medium** · MQTT monitor · terkonfirmasi · C014
- Lokasi: `tools/ground_console.py:1985`, `tools/ground_console.py:2087-2090`, `frontend/src/pages/MessageMonitorPage.tsx:59-75`
- Masalah: `/api/mqtt/connect` menjalankan `apply_config`. Bila host, port, dan transport sama, `monitor_changed` bernilai false sehingga tidak ada reconnect dan backoff paho (1 s berlipat hingga 120 s) tidak di-reset.
- Dampak: Setelah broker atau link pulih, operator menekan Reconnect dan mendapat "Local MQTT monitor requested as subscriber-only.", tetapi status tetap ERROR sampai tick backoff paho berikutnya, yang bisa sampai sekitar 2 menit.
- Bukti: Broker dimatikan 45 s (reconnect_delay 32), lalu dinyalakan dan Reconnect ditekan: monitor baru tersambung 18 s kemudian.
- Perbaikan: Paksa restart atau panggil `client.reconnect()` dengan reset delay, atau batasi backoff dengan `reconnect_delay_set(1, 10)`.

#### AUD-49 — `client_id` MQTT tetap "ground-console-monitor" membuat dua Ground Console pada satu broker saling mengusir

- **medium** · MQTT monitor · terkonfirmasi · C015
- Lokasi: `tools/sdr_doa_mqtt_monitor.py:130`
- Masalah: Sesuai MQTT 3.1.4-3, broker memutus sesi lama saat klien baru connect dengan ClientId yang sama. paho me-reset delay setelah setiap CONNACK, sehingga kedua klien reconnect sekitar setiap 1 s.
- Dampak: Dua laptop operator atau dua instance console pada broker yang sama (misalnya 10.90.0.1) berkedip CONNECTED/DISCONNECTED dan kehilangan pesan, tanpa penjelasan di UI.
- Bukti: 12 event TAKEOVER dalam 12 s; status kedua console bergantian berlawanan fase.
- Perbaikan: Pakai client id unik per proses (sufiks acak) atau id kosong dengan clean start.

#### AUD-50 — Telemetri RDF Node v2 dikumpulkan tetapi tidak pernah ditampilkan, padahal QUICKSTART menjanjikan panel v1 dan v2

- **medium** · MQTT monitor · terkonfirmasi · C020
- Lokasi: `tools/ground_console.py:1904-1909`, `frontend/src/api.ts:252`, `frontend/src/pages/MessageMonitorPage.tsx:91`, `QUICKSTART.md:266-268`
- Masalah: Backend subscribe ke filter `sdr/v2/uav-01/*` dan menyajikan `GET /api/mqtt/rdf-node`, tetapi tidak ada konsumen di `frontend/src`, `frontend/dist`, maupun legacy UI.
- Dampak: Bila node memakai MQTT v2, operator melihat "CONNECTED", "RECEIVED 0", dan "No bounded subscriber events observed." sementara DoA, health, dan frame angular v2 yang valid sedang mengalir. Gate freshness, sesi, dan revisi v2 yang didokumentasikan tidak terlihat di mana pun.
- Bukti: Publisher v2 lewat broker: UI `RECEIVED | 0`, sedangkan `fetch('/api/mqtt/rdf-node')` → `connection=ready`.
- Perbaikan: Tambahkan panel v2 (normalizer dan type di `api.ts`/`types.ts`), atau perbaiki QUICKSTART agar menyatakan v2 hanya tersedia lewat API.

#### AUD-51 — Transport MQTT, path WebSocket, dan kredensial tidak ada di kontrak config maupun form, sehingga GUI tidak bisa memilih broker TCP

- **medium** · MQTT monitor · terkonfirmasi, dikoreksi · C021
- Lokasi: `frontend/src/api.ts:128-147`, `frontend/src/pages/ConfigurationPage.tsx:266-270`, `tools/ground_console.py:1920-1926`, `QUICKSTART.md:234-240`
- Masalah: `ConsoleConfig` hanya berisi base_url, mqtt_host, mqtt_port, dan refresh_seconds. Save dari GUI selalu mempertahankan transport yang tersimpan, dan transport tidak terlihat di layar.
- Dampak: Mengarahkan config yang ada ke broker staging TCP terdokumentasi (127.0.0.1:18884) membuat monitor tertahan di CONNECTING/ERROR tanpa petunjuk bahwa ia memakai WebSocket. Jalan keluarnya hanya di luar GUI: `--config-path` baru dengan `--mqtt-transport tcp`, edit `console.json`, atau POST API. Broker yang butuh autentikasi tidak bisa dipakai.
- Bukti: POST {127.0.0.1, 23040} → `mqtt_transport: "websockets"` tetap, status connecting 10 s tanpa CONNECT di log TCP.
- Perbaikan: Tambahkan `mqtt_transport` (opsional `ws_path` dan kredensial via environment) ke kontrak, form, dan `/api/mqtt/connect`. Tampilkan transport di Monitor. Lengkapi QUICKSTART (lihat AUD-120).

#### AUD-52 — Loop edge agent single-thread tertahan sekitar 60 s di `collect()` saat Data Out macet, sehingga broker memutusnya karena keepalive dan health UNAVAILABLE tidak pernah terkirim

- **medium** · Edge agent (staging) · terkonfirmasi · C034
- Lokasi: `tools/sdr_doa_lan_agent.py:636-660`, `tools/sdr_doa_lan_agent.py:686-705`, `tools/sdr_doa_collector.py:785-880`
- Masalah: `collect_once()` memakai timeout 5 s dan 3 percobaan untuk empat resource (sekitar 60 s) di thread yang sama dengan I/O MQTT. Keepalive 30 s terlewati, sehingga broker memutus klien di 1,5 × keepalive.
- Dampak: Saat Data Out macet atau LAN putus, yaitu saat health paling dibutuhkan, subscriber tidak menerima health lebih dari satu menit dan tidak pernah melihat UNAVAILABLE. Monitor Ground tetap menampilkan health DEGRADED/ONLINE terakhir.
- Bukti: Subscriber: DEGRADED pada +0,2..+5,6 s, lalu tidak ada pesan sampai +77,2 s; log broker `KEEPALIVE_TIMEOUT`.
- Perbaikan: Beri anggaran collect sendiri jauh di bawah keepalive/2 (timeout sekitar 1 s, 1 percobaan, atau deadline total), atau jalankan collect di worker thread dan publikasikan health "status unavailable/stale" bila collect melebihi anggaran.

#### AUD-53 — Edge agent mem-poll Data Out 5–7 kali per detik (20–29 request HTTP/s) untuk health 1 Hz, bahkan dengan DoA nonaktif

- **medium** · Edge agent (staging) · terkonfirmasi · C039
- Lokasi: `tools/sdr_doa_lan_agent.py:689-705`, `tools/sdr_doa_lan_agent.py:748`
- Masalah: `run()` memanggil `collect_once()` di setiap iterasi (sleep 0,05 s, atau 0,1 s di contoh deploy), dan collect selalu membaca keempat resource. Interval health dan DoA hanya mengatur apa yang diantrekan, bukan seberapa sering koleksi berjalan.
- Dampak: Pada Raspberry Pi yang juga menjalankan DSP DoA dan melayani Ground Console, agent menambah 20–30 request/s, sekitar 5–30 kali lebih banyak dari kebutuhan health 1 Hz. Dampaknya belum diukur di hardware Pi.
- Bukti: Flag contoh deploy selama 10 s: 216 request (21,8/s) untuk 10 publikasi health; default: 29,1 req/s.
- Perbaikan: Jalankan koleksi mengikuti jadwal health/DoA dan pakai poll cepat hanya untuk I/O MQTT. Lewati CSV/XML bila DoA nonaktif dan authority tidak dipilih.

#### AUD-54 — `index.html` Receiver memuat stylesheet Google Fonts yang render-blocking, sehingga iframe kosong selama timeout jaringan saat fonts.googleapis.com tak terjangkau

- **medium** · Receiver: UI, rekaman, Records · terkonfirmasi · C132
- Lokasi: `tools/browsdr_receiver_overlay/src/client/index.html:31`, `frontend/dist/receiver/index.html:31`, `tools/ground_console.py:1812-1813`
- Masalah: `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?…">` berada di `<head>` sebelum module script, sehingga memblokir paint dan bootstrap Vue. Service worker tidak meng-cache-nya. CSP Receiver memang mengizinkan host itu, dan builder tidak menghapusnya.
- Dampak: Di jaringan lapangan tanpa internet yang membuang paket tanpa menolak (gateway berfirewall, DNS yang tidak menjawab), Receiver menjadi kotak kosong tanpa spinner atau error selama timeout OS: sekitar 21 s per kunjungan dan 43 s pada kunjungan pertama karena reload SW (AUD-133), atau tanpa batas bila koneksi tidak pernah gagal. Saat DNS langsung gagal, halaman normal, sehingga masalahnya tampak acak.
- Bukti: Request font tidak pernah dijawab → `not mounted after 60 s`; gagal setelah 21 s → kunjungan pertama 43,1 s, kunjungan kedua 21,3 s; abort langsung → 0,55 s.
- Perbaikan: Hapus link font remote (fallback sistem sudah ada di CSS) atau self-host Inter/Roboto Mono di `/receiver/`, lalu hapus host font dari CSP Receiver. Tambahkan forbidden-string check `fonts.googleapis.com` di verifikasi build.

#### AUD-55 — Rekaman VFO berhenti diam-diam saat sample rate atau FFT size berubah, VFO dihapus, atau bookmark grup mengubah rate

- **medium** · Receiver: UI, rekaman, Records · terkonfirmasi · C071
- Lokasi: `tools/browsdr_receiver_overlay/src/client/app/main.ts:101-119`, `tools/browsdr_receiver_overlay/src/client/app/connection.ts:177-178`, `tools/browsdr_receiver_overlay/src/client/app/vfo.ts:281`, `tools/browsdr_receiver_overlay/src/client/app/bookmarks.ts:101`
- Masalah: Perubahan `radio.sampleRate` atau `fftSize` saat berjalan memanggil `togglePlay()` lalu `togglePlay(true)`. Cabang stop selalu menjalankan `disarmVfoAudioRecording()` dan menutup AudioContext, dan `startStream()` tidak pernah meng-arm ulang. `removeVfo()` juga men-disarm. Tidak ada pesan, dan snackbar tetap "Per-VFO audio recording started."
- Dampak: Operator yang mengubah sample rate, FFT size, atau daftar VFO saat merekam mengira rekaman masih berjalan, padahal semua setelah titik itu tidak tertangkap.
- Bukti: Setelah memilih 2 MSPS, label tombol berubah ke "Record VFO audio" sementara snackbar masih "started"; sesi selesai sekitar 5 s setelah mulai.
- Perbaikan: Pertahankan sesi tetap armed melewati restart RX (tutup segmen lalu buka lagi di stream baru), atau blokir/konfirmasi perubahan ini selama merekam, dan selalu tampilkan "Recording stopped because …".

#### AUD-56 — Lepasnya HackRF tidak terdeteksi: "Radio SDR ON" tetap menyala dan rekaman yang armed terus menulis keheningan

- **medium** · Receiver: UI, rekaman, Records · terkonfirmasi (code trace) · C072
- Lokasi: `tools/browsdr_receiver_overlay/src/client/app/connection.ts:142`, `tools/build_browsdr_receiver.py:151-166`, `vendor/BrowSDR/src/client/hackrf.ts:417-442`
- Masalah: Tidak ada listener `navigator.usb` `disconnect` di overlay maupun vendor. Loop transfer RX hanya `console.error` dan `break` saat gagal, tanpa callback error. `connected` dan `running` hanya di-reset di jalur yang dipicu user.
- Dampak: Kabel USB yang longgar tidak ketahuan: status menyatakan radio ON, dan rekaman terus menghasilkan segmen "complete" yang hening sampai ada yang memeriksa.
- Bukti: Grep listener disconnect hanya menemukan dua tombol Disconnect. Tidak ada hardware untuk reproduksi langsung.
- Perbaikan: Dengarkan event `disconnect` untuk perangkat yang terbuka dan error transfer RX dari worker. Saat perangkat hilang, set connected/running false, finalisasi sesi rekaman dengan alasan "device lost", dan tampilkan alert.

#### AUD-57 — File WebM rekaman tidak punya Duration maupun Cues, sehingga player Records tidak menampilkan panjang dan seek tidak berfungsi

- **medium** · Receiver: UI, rekaman, Records · terkonfirmasi · C070
- Lokasi: `tools/browsdr_receiver_overlay/src/client/app/vfo-audio-recorder.ts:62`, `tools/browsdr_receiver_overlay/src/client/app/vfo-audio-recorder.ts:281`, `tools/receiver_record_store.py:965`
- Masalah: Output MediaRecorder (`audio/webm;codecs=opus`, chunk 1 s) disimpan apa adanya. Header EBML tidak pernah ditulis ulang; `duration_seconds` hanya disimpan sebagai metadata.
- Dampak: Setiap player di Records menampilkan "0:00 / 0:00" tanpa total durasi, dan scrub bar tidak bisa dipakai untuk melompat. Meninjau rekaman berjam-jam harus diputar dari awal.
- Bukti: Segmen 5 s: `{"duration":"Infinity","seekable":["0","Infinity"]}`; pemindaian byte menunjukkan `has Duration: False has Cues: False`.
- Perbaikan: Saat segmen selesai, tulis elemen Duration ke header EBML Info dari `duration_seconds` (edit byte kecil dengan stdlib), buat Cues, atau rekam ke format dengan panjang eksplisit.

#### AUD-58 — Service worker PWA embedded meng-cache setiap GET `/api/*` (NetworkFirst), sehingga Records menampilkan data lama tanpa error saat console mati

- **medium** · Receiver: UI, rekaman, Records · terkonfirmasi · C069
- Lokasi: `vendor/BrowSDR/vite.config.ts:168`, `tools/build_browsdr_receiver.py:1853`, `frontend/dist/receiver/sw.js`
- Masalah: Aturan runtimeCaching `/^.*\/api\/.*/i` NetworkFirst (`api-cache`, timeout jaringan 5 s, kedaluwarsa 1 jam) ikut terbawa ke build embedded. `cache: 'no-store'` di klien tidak mencegah Workbox.
- Dampak: Bila proses Ground Console berhenti atau hang, Refresh di Records tetap menampilkan daftar lama, termasuk record yang sudah dihapus, tanpa error. Respons yang lebih lambat dari 5 s bisa diam-diam diganti halaman lama.
- Bukti: Satu scan dihapus lewat API, server dimatikan, lalu Refresh: `scans shown: 2 scans | errors: []`.
- Perbaikan: Hapus aturan `/api` (NetworkOnly) atau nonaktifkan SW di build embedded lewat `_apply_embedded_changes`, dan tambahkan forbidden-string check `api-cache`.

#### AUD-59 — Filter jam dan tanggal audio hanya memakai waktu mulai segmen, sehingga rekaman yang tumpang tindih dengan jendela tersembunyi

- **medium** · Receiver: backend & penyimpanan · terkonfirmasi · C051
- Lokasi: `tools/receiver_record_store.py:669-682`, `tools/receiver_record_store.py:736-738`
- Masalah: Pengecekan time-of-day dan started_after/started_before hanya memakai `started_at`, dan `available_dates` juga dari `started_at`. Segmen baru ditutup saat frekuensi, mode, atau bandwidth berubah, sehingga segmen berjam-jam adalah hal normal. Label UI ("Date recorded", "Time of day", "Highlighted dates contain recordings") mengesankan cakupan, bukan waktu mulai.
- Dampak: Pertanyaan "apa yang kita rekam antara 22:00 dan 23:00?" tidak menemukan rekaman 21:55–23:30 yang justru mencakup periode itu.
- Bukti: Segmen 21:55–23:30 WIB tidak termasuk dalam hasil filter 22:00–23:00.
- Perbaikan: Filter berdasarkan overlap [started_at, ended_at] dengan jendela, atau ubah label menjadi "Start time"/"Start date".

#### AUD-60 — CSS Receiver tidak punya gaya `.btn:disabled`, sehingga tombol nonaktif terlihat dan ber-hover sama seperti tombol aktif

- **medium** · Receiver: UI, rekaman, Records · terkonfirmasi · C135
- Lokasi: `tools/browsdr_receiver_overlay/src/client/style.css`, `tools/browsdr_receiver_overlay/src/client/index.html` (sekitar 30 `.btn` dengan binding `:disabled`)
- Masalah: Ada gaya disabled untuk `.icon-btn`, `.receiver-view-tab`, `.sweep-listen-button`, dan input sweep, tetapi tidak untuk `.btn`. Tombol nonaktif tetap opacity 1, berwarna normal, dan bercursor pointer.
- Dampak: Operator tidak bisa tahu aksi mana yang tersedia. Klik "Start scan" saat scan berjalan, atau "Record VFO audio" saat receiver dijeda, tidak menghasilkan apa-apa, sehingga fitur tampak rusak.
- Bukti: Computed style `Start scan dis=true op=1 bg=rgb(58,134,255) cur=pointer`, identik dengan saat aktif.
- Perbaikan: Tambahkan `.btn:disabled{opacity:.45;cursor:not-allowed}` dan versi redup `.btn-primary`, lalu cek tema gelap dan terang.

#### AUD-61 — Listen dari kandidat sweep tidak lagi meng-unmute VFO, sehingga audio bisa hening sementara UI menyatakan "Listening at …"

- **medium** · Receiver: scan/sweep · terkonfirmasi (code trace) · C061
- Lokasi: `tools/browsdr_receiver_overlay/src/client/app/sweep.ts:993-1040`, `tools/browsdr_receiver_overlay/src/client/app/connection.ts:340`
- Masalah: Upstream `listenToSweepCandidate` menjalankan `currentVfo.enabled = true` sebelum `startStream(true)`; salinan overlay menghapus baris itu. `startStream(isRestart=true)` tidak mengaktifkan VFO, dan `updateBackendVfoParams` mengirim `enabled: false`.
- Dampak: Bila VFO aktif adalah VFO yang baru ditambahkan atau sedang di-mute, Listen men-tune radio dan pindah ke Listener dengan pesan "Listening at X MHz", tetapi tidak ada suara. Alur dasar satu VFO tidak terdampak.
- Bukti: Diff upstream vs overlay, dan bundle hasil build tidak memuat baris tersebut.
- Perbaikan: Kembalikan `currentVfo.enabled = true`; `restoreListeningState` sudah mengembalikan status mute sebelumnya.

#### AUD-62 — Pencocokan puncak first-fit memecah satu carrier stabil menjadi banyak kandidat dengan hits, bandwidth, dan statistik yang salah

- **medium** · Receiver: scan/sweep · terkonfirmasi · C057
- Lokasi: `tools/browsdr_receiver_overlay/src/client/worker/sweep-processing.ts:250-290`
- Masalah: Setiap run deteksi mengklaim kandidat pertama (urutan Set) dalam 50 kHz yang belum cocok di sweep itu, bukan kandidat terdekat. Run noise di bawah carrier mengambil kandidat carrier lebih dulu, lalu rentang dan statistiknya digabung.
- Dampak: Satu carrier CW yang ada di setiap sweep menjadi 15 kandidat dengan hits 17–49 dari 100, occupied bandwidth 171–571 kHz, dan mean peak bergeser hingga ±250 kHz. Kolom Peak range, Hits, dan Occupied bandwidth salah, begitu pula ekspor CSV dan arsip.
- Bukti: Carrier 112,3 MHz di 100 sweep: 15 kandidat, misalnya `id=506 hits=24/100 bandwidth=571.3 kHz`.
- Perbaikan: Pilih kandidat terdekat yang belum cocok, atau selesaikan pencocokan global per sweep (deteksi terkuat lebih dulu). Jangan gabungkan rentang dari run yang puncaknya bergeser lebih dari sekitar satu bin.

#### AUD-63 — Sinyal wideband tidak terdeteksi karena noise floor per blok berubah menjadi level sinyal itu sendiri

- **medium** · Receiver: scan/sweep · terkonfirmasi · C062
- Lokasi: `tools/browsdr_receiver_overlay/src/client/worker/sweep-processing.ts:196-235`
- Masalah: Floor setiap blok 128 bin (312 kHz pada FFT 8192) adalah persentil 25 dari blok itu sendiri. Sinyal yang mengisi lebih dari sekitar 75% blok menaikkan floor-nya sendiri, sehingga hanya blok tepi yang menghasilkan kandidat. Logika ini warisan upstream.
- Dampak: DAB, DVB-T, LTE, Wi-Fi, dan sinyal lain yang lebih lebar dari sekitar dua blok terlewat, atau tercatat sebagai sliver sempit di tepi dengan level dan frekuensi salah. Contoh wideband simulator (8,1 MHz di 496 MHz) hanya muncul sebagai `500.0012 MHz @ −64.9 dB, bw 49 kHz`, padahal teks empty-state menjanjikan contoh wideband.
- Bukti: `test_wideband.mjs` dan uji end-to-end simulator: tidak ada baris di sekitar 496 MHz.
- Perbaikan: Estimasi floor dari jendela yang jauh lebih lebar (beberapa MHz, atau persentil rendah seluruh sweep yang dihaluskan), atau ambil minimum dari blok tetangga.

#### AUD-64 — IQ Correction (DC) membulatkan offset ke LSB bulat, sehingga spike DC 21–31 dB tetap ada walau koreksi ON

- **medium** · Receiver: scan/sweep · terkonfirmasi · C058
- Lokasi: `tools/browsdr_receiver_overlay/src/client/worker/iq-spectrum.ts:13`, `tools/browsdr_receiver_overlay/src/client/worker/rx-stream.ts:655`
- Masalah: `processSpectrumFft` mengurangkan `Math.round(mean)` dari `Int8Array` secara in-place, sehingga bagian pecahan offset tetap ada dan offset < 0,5 LSB tidak tersentuh. Residu DC koheren bertambah besar dengan N, sementara noise floor tidak. Bin tengah tidak di-mask.
- Dampak: Dengan "IQ Correction (DC offset)" aktif, spektrum Listener tetap menampilkan spike tengah yang besar dalam kasus umum, dan bisa dikira carrier di frekuensi tuning. Tooltip menjanjikan DC dihapus.
- Bukti: N=8192, dc=(0,45, −0,4): off −16,7 dB, on −16,5 dB (21,3 dB di atas noise); N=65536: 30,7 dB di atas noise.
- Perbaikan: Hapus DC setelah FFT (kurangi mean × W(k) dari bin kompleks, atau interpolasi bin tengah ±1–2), atau pakai buffer Float32. Tambahkan tes offset pecahan.

#### AUD-65 — Waterfall dan trace arsip ter-clip di 0 dB, padahal level FFT sweep mencapai sekitar +33 dB dan grafik mengizinkan +60

- **medium** · Receiver: scan/sweep · terkonfirmasi · C059
- Lokasi: `tools/browsdr_receiver_overlay/src/client/app/sweep-waterfall.ts:8`, `tools/browsdr_receiver_overlay/src/client/app/sweep.ts:235`, `tools/browsdr_receiver_overlay/src/client/app/sweep.ts:750`
- Masalah: Builder menaikkan batas grafik ke +60, tetapi `SWEEP_WATERFALL_MAX_DB` masih 0, `compactAverageTrace` meng-clamp ke −160..0, dan decoder arsip memetakan byte ke −160..0.
- Dampak: Semua sinyal kuat berwarna jenuh yang sama di waterfall. Display max +30 tidak menampilkan warna di atas 0 dB. Hover waterfall membaca 0.0 dB sementara hover Spectrum membaca +17 dB. Scan arsip yang dibuka ulang menggambar sinyal kuat rata di 0 dB, sehingga level aslinya hilang.
- Bukti: Tone 20 LSB: frame spektrum 17,0 dB, baris waterfall 0,0 dB, byte trace arsip 255 → 0,0 dB.
- Perbaikan: Kuantisasi byte waterfall dan trace dengan rentang yang sesuai skala FFT (misalnya −100..+60 dB), dan pakai konstanta yang sama di encoder dan decoder.

#### AUD-66 — Preset "Minimum peak" (−160 sampai −60 dBFS, default −80) berada di bawah level noise terendah, sehingga tidak menyaring apa pun

- **medium** · Receiver: scan/sweep · terkonfirmasi · C060
- Lokasi: `tools/browsdr_receiver_overlay/src/client/index.html:698`, `tools/browsdr_receiver_overlay/src/client/app/state.ts:90`
- Masalah: Filter membandingkan `candidate.peakDb` dengan nilai absolut preset, sedangkan pada skala FFT ini noise int8 sudah berada di sekitar −48 sampai −27 dB.
- Dampak: Operator yang memilih preset paling ketat (−60 dBFS) untuk membuang sampah tetap melihat semua kandidat noise, sehingga tabel terkesan tidak bisa disaring. Ini memperparah AUD-16 dan AUD-17. Field "Exact dBFS" kustom masih berfungsi.
- Bukti: Total 40.302 kandidat dengan peakDb −31,0..−21,6; filter ≥ −80 dB menyisakan 40.302.
- Perbaikan: Skala ulang preset ke rentang FFT ini (−50/−40/−30/−20/−10 dB), atau lebih baik filter berdasarkan SNR di atas floor dengan default yang mengecualikan noise floor.

#### AUD-67 — Urutan build dan verifikasi yang didokumentasikan menghapus Receiver dan tidak membangunnya ulang, sementara suite static melewati cek Receiver dan tetap OK

- **medium** · Dokumentasi & build · terkonfirmasi (code trace) · C141
- Lokasi: `QUICKSTART.md:273-283`, `QUICKSTART.md:312-314`, `initialize.md:331-339`, `CLAUDE.md:49`, `AGENTS.md:123`, `frontend/vite.config.ts`, `tools/test_ground_console_static.py:1025-1027`
- Masalah: Vite mengosongkan `frontend/dist`, termasuk `dist/receiver`, di setiap `npm run build` karena tidak ada override `emptyOutDir`. QUICKSTART "Validasi setelah install", troubleshooting "UI tidak muncul", `initialize.md`, `CLAUDE.md` "Verification after a change", dan AGENTS.md semuanya diakhiri `npm run build` tanpa langkah `tools/build_browsdr_receiver.py`. Tes Receiver di suite static memakai `skipTest` bila build tidak ada.
- Dampak: Siapa pun yang mengikuti QUICKSTART dari atas ke bawah, atau mengikuti checklist verifikasi, berakhir dengan halaman Receiver berisi JSON 404 mentah (AUD-126), sementara tes melaporkan sukses.
- Bukti: Urutan bagian QUICKSTART (build → Receiver → validasi dengan build ulang), `vite.config.ts` tanpa `emptyOutDir`, dan `skipTest("embedded BrowSDR receiver is absent…")`.
- Perbaikan: Tambahkan langkah builder Receiver tepat setelah setiap `npm run build` di semua dokumen, atau buat npm script yang merangkai kedua build. Buat tes gagal (bukan skip) bila submodule ada tetapi `dist/receiver` tidak ada.

#### AUD-68 — Builder Receiver memanggil `npm` lewat subprocess tanpa me-resolve `npm.cmd`, sehingga perintah build Windows yang didokumentasikan tidak bisa berjalan

- **medium** · Dokumentasi & build · terkonfirmasi (code trace) · C142
- Lokasi: `tools/build_browsdr_receiver.py:1880-1886`, `tools/build_browsdr_receiver.py:1905`, `QUICKSTART.md:151-156`
- Masalah: `subprocess.run(["npm", "ci", …])` tanpa `shell=True` dan tanpa `shutil.which`. Di Windows, npm terpasang sebagai `npm.cmd`, sedangkan CreateProcess hanya menambahkan `.exe` dan tidak mencari PATHEXT. `FileNotFoundError` tertangkap sebagai `OSError`.
- Dampak: Di platform yang terdokumentasi, Receiver tidak pernah bisa dibangun. Pesan "BrowSDR build failed: [WinError 2] The system cannot find the file specified" tidak memberi petunjuk penyebabnya.
- Bukti: Code trace; host Windows tidak tersedia. Pemanggilan `git` tidak terdampak karena git menyediakan `git.exe`.
- Perbaikan: `npm = shutil.which("npm")` (mengembalikan `npm.CMD` di Windows) dan beri pesan jelas bila npm tidak ditemukan.

### 3.4 Low

Semua temuan low di bawah berstatus terkonfirmasi. Tanda "(dikoreksi)" berarti cakupan atau dampaknya sudah dipersempit oleh verifikator, dan teks di sini memakai versi koreksi.

#### Collector & kontrak data

| ID | Cluster | Lokasi | Masalah dan dampak | Usulan perbaikan |
|---|---|---|---|---|
| AUD-69 | C005 | `tools/sdr_doa_collector.py:603-614`, `:771` | Sudut native di luar [0, 360] (ROOT-MUSIC + array_offset tanpa modulo di upstream) memicu error lalu dilaporkan sebagai `NATIVE_DOA_VIEWS_CONFLICT`, padahal CSV dan XML sepakat. Overview menampilkan CONFLICT. | Normalkan dengan % 360 sebelum konvensi diterapkan; beri reason tersendiri (`NATIVE_ANGLE_INVALID`) untuk sudut yang memang tidak bisa dipakai. |
| AUD-70 | C006 | `tools/sdr_doa_collector.py:873-875`, `:312` | Error parse XML diganti "resource unavailable". `HTTPError` (misalnya 404) jatuh ke cabang `URLError`, sehingga `http_status` kosong dan teksnya sama dengan koneksi ditolak. | Simpan error parse seperti di cabang CSV; tangkap `HTTPError` lebih dulu dan isi `http_status`. |
| AUD-71 | C007 (dikoreksi) | `tools/sdr_doa_collector.py:458`, `:568` | `STATION_ID` kosong menolak seluruh record XML. Koma di station ID (ditandai invalid oleh UI Kraken tetapi tidak disanitasi) membuat CSV 378 field dan ditolak. Readout dan polar menjadi unavailable dan strip STALE, sementara peta tetap menggambar bearing CSV (pada kasus XML). | Jadikan `STATION_ID` opsional; parse CSV dari 13 field header ditambah 360 nilai terakhir. |
| AUD-72 | C008 | `tools/sdr_doa_collector.py:683` | Upstream meng-clip XML PWR di 0,0 (pwr + 100), tetapi deteksi floor memakai −100. Daya yang ter-clip dilaporkan valid −100 dB dengan `power_mapping_lossy` False. | Tandai lossy bila `transformed_power <= 0.0` (XML) dan `power_raw <= -100` (CSV). |
| AUD-73 | C009 (dikoreksi) | `tools/fixtures/valid/DOA_value.html`, `tools/sdr_doa_collector.py:34`, `tools/test_sdr_doa_collector.py` | Fixture menaruh puncak vektor di bin 10 sementara θ₀ = 211 (240 di fixture conflict), bertentangan dengan konvensi upstream (peak bin = θ₀). `ANGULAR_PEAK_ANGLE_TOLERANCE_DEG` tidak pernah dipakai, sehingga regresi konvensi bin (vektor tercermin atau ter-offset) lolos semua tes. | Regenerasi fixture (sisakan satu fixture mismatch yang eksplisit); pakai konstanta itu untuk diagnostic atau reason. |
| AUD-74 | C115 (dikoreksi) | `tools/ground_console.py:1347-1383`, `tools/sdr_doa_mqtt.py:398-405`, `frontend/src/lib/i18n.ts:382` | Dry-run config patch melabeli `base_config_rev` sebagai "optional" dan menyatakan "Validation passed", padahal kontrak MQTT dan edge agent mewajibkannya. Agent akan membuang perintah itu tanpa ACK. Dampaknya terbatas karena console tidak punya transport dan preview kedaluwarsa dalam 10 s. | Pakai validator kontrak bersama (`build_config_patch`/`validate_config_patch`), atau wajibkan field tersebut. |
| AUD-75 | C118 | `tools/sdr_doa_collector.py:953-966`, `frontend/src/pages/SystemHealthPage.tsx:29-30` | Tangga `overall_state` tidak mempertimbangkan `native_consistency`. CONFLICT atau pasangan yang tak terbandingkan dilaporkan UNVERIFIED, sehingga ringkasan Health menampilkan badge hijau AVAILABLE saat strip menyatakan DATA CONFLICT. | Tambahkan CONFLICT/INCOMPLETE ke tangga `overall_state`, atau turunkan headline Health dari `deriveDataState()`. |
| AUD-76 | C119 | `tools/sdr_doa_collector.py:837-844` | Bila `status.json` gagal, umur DoA dihitung terhadap jam Ground dengan `freshness_known=True` walau mode `remote_unverified`. Dengan jam node yang tidak sinkron muncul umur berjam-jam sampai puluhan tahun dan reason `DOA_CANDIDATES_STALE` yang mengarahkan troubleshooting ke tempat yang salah. | Saat status tidak tersedia, set `freshness_known=false` dan jangan tambahkan `DOA_CANDIDATES_STALE`. |
| AUD-77 | C120 | `tools/sdr_doa_collector.py:312`, `tools/ground_console.py:1876-1881` | `http.client.BadStatusLine`/`LineTooLong` (bukan `OSError`) lolos dari `fetch_resource` dan handler `/api/snapshot`. Koneksi diputus tanpa respons, dan data tiga resource lain yang terbaca ikut dibuang. | Tangkap `http.client.HTTPException` di `fetch_resource` dan kembalikan `ok=False` per resource. |
| AUD-78 | C121 | `tools/sdr_doa_collector.py:1032`, `:39` | Help CLI collector memberi contoh `http://10.90.0.2:8081` yang ditolak allowlist, sehingga hasilnya UNAVAILABLE dengan "base_url host is not allowlisted". | Ganti contoh dengan host yang diizinkan dan sebutkan allowlist-nya. |

#### Server console & konfigurasi

| ID | Cluster | Lokasi | Masalah dan dampak | Usulan perbaikan |
|---|---|---|---|---|
| AUD-79 | C013 (dikoreksi) | `tools/ground_console.py:1920-1930`, `:2093` | Startup default tanpa paho memang terdokumentasi gagal. Cacat sebenarnya: saat console berjalan tanpa paho, `POST /api/console-config` dengan `mqtt_host` apa pun melempar `RuntimeError` yang tidak tertangkap (handler hanya menangkap `ValueError`/`OSError`). Koneksi putus, UI menampilkan fetch failure, dan field lain dalam save yang sama ikut hilang. `/api/mqtt/connect` sudah menangani kasus ini dengan 502. | Tangkap `RuntimeError` dan kembalikan JSON 400/502, atau beri slot monitor status error "paho-mqtt not installed". |
| AUD-80 | C018 | `tools/ground_console.py:433-452`, `frontend/src/pages/ConfigurationPage.tsx` (`chooseLogo`) | Validator logo menolak PNG berpalet (chunk PLTE kena cabang "unsupported critical chunk" sebelum pengecekan PLTE sempat jalan), PNG 16-bit, dan interlaced dengan pesan kriptis, sementara klien sudah menampilkan "New local logo staged". | Terima PLTE dengan color type 3, atau beri pesan jelas "8-bit RGB/RGBA non-interlaced"; validasi juga di klien. |
| AUD-81 | C019 | `tools/ground_console.py:159`, `:1937` | Tanpa `SDR_DOA_ADMIN_PASSWORD`, login admin menjawab 401 "password admin salah" (dalam bahasa Indonesia, juga di UI Inggris), bukan "admin dinonaktifkan". `/api/capabilities` tidak punya flag aktif. | Kembalikan 503 "admin login disabled: set SDR_DOA_ADMIN_PASSWORD" dan ekspos `admin_enabled`. |
| AUD-82 | C022 (dikoreksi) | `tools/ground_console.py:282-310`, `:2195-2201`, `QUICKSTART.md:205-212` | `console.json` yang tersimpan menimpa flag eksplisit `--base-url`, `--mqtt-host`, `--mqtt-port`, dan `--mqtt-transport`. Presedensi ini didokumentasikan (`QUICKSTART.md:26`, `:236`), tetapi bagian "Menghubungkan Data Out live" menyuruh memakai `--base-url` tanpa catatan, dan server tidak memberi peringatan. Operator mendapat host lama; pemulihan lewat Configuration → Connection. | Biarkan flag eksplisit menang (argparse default `None`), atau log "saved config overrides --base-url"; perbarui QUICKSTART. |
| AUD-83 | C023 | `tools/ground_console.py:2074-2108` | `apply_config` memanggil `previous.stop()` (yang menunggu thread paho) sambil memegang `_config_lock`. Saat broker lama tak terjangkau, POST dan GET `/api/console-config` yang bersamaan tertahan hingga sekitar 5 s. | Tukar referensi monitor di bawah lock, lalu panggil `stop()` di luar lock atau di thread latar. |
| AUD-84 | C024 | `tools/ground_console.py:308` | Satu field invalid atau typo JSON di `console.json` membuang semua setting koneksi tersimpan tanpa log. Save berikutnya menimpa file dengan nilai default. | Log peringatan dengan nama field, fallback per field, dan backup file sebelum menimpa. |
| AUD-85 | C025 | `tools/ground_console.py:635`, `:970` | Legacy UI: `.brand-mark img {display:block}` mengalahkan `[hidden]`, sehingga tanpa logo tampil ikon gambar rusak (dan placeholder tidak tersembunyi saat logo ada). | Tambahkan `[hidden]{display:none!important}`. |

#### Frontend: status & freshness

| ID | Cluster | Lokasi | Masalah dan dampak | Usulan perbaikan |
|---|---|---|---|---|
| AUD-86 | C093 (dikoreksi) | `frontend/src/App.tsx:273-277`, `:323-337` | Bila `GET /api/console-config` pertama gagal (misalnya console restart tepat setelah `index.html` dimuat), tidak ada retry. R, Refresh, dan interval keluar lebih awal sampai reload. Configuration menampilkan `DEFAULT_CONSOLE_CONFIG` dengan status "Local values are loaded" dan Save aktif, sehingga bisa menimpa config asli dengan default. | Retry dengan backoff; tampilkan status "unavailable" dan nonaktifkan Save sampai berhasil. |

#### Frontend: peta

| ID | Cluster | Lokasi | Masalah dan dampak | Usulan perbaikan |
|---|---|---|---|---|
| AUD-87 | C085 | `frontend/src/lib/doaGeometry.ts:78-84` | Ring poligon lobe dimulai dari titik stasiun dan tidak tertutup, sehingga outline menggambar jari-jari dari stasiun ke arah 0°. | Bentuk ring dari 360 titik keliling saja: `[p0..p359, p0]`. |
| AUD-88 | C086 | `frontend/src/lib/doaGeometry.ts:64`, `frontend/src/components/TacticalMap.tsx:65-72` | Untuk stasiun dalam 20 km dari ±180°, poligon dan garis membentang melintasi dunia. Ini item penerimaan di `MAPLIBRE_DOA_OVERLAY_PLAN.md:136`. | Kembalikan longitude yang kontinu terhadap origin; normalkan hanya untuk teks. |
| AUD-89 | C087 | `frontend/src/components/TacticalMap.tsx:150-158` | Error tile OSM diabaikan diam-diam, sehingga notice "Basemap unavailable" tidak pernah muncul saat offline (dijanjikan di plan :225 dan :290). Overlay tetap tergambar di atas latar kosong. | Lacak gagal dan sukses tile `osm`; tampilkan notice non-blok setelah N kegagalan. |
| AUD-90 | C088 | `frontend/src/App.tsx:445`, `frontend/src/components/TacticalMap.tsx:164`, `:226` | Kamera (zoom, pan, rotasi) reset setiap kali kembali ke Overview karena route di-remount. Plan :207 dan :246 menjanjikan kamera bertahan antar tab. | Simpan center/zoom/bearing/pitch saat unmount atau `moveend`, lalu pulihkan. |
| AUD-91 | C130 | `frontend/src/console-design.css:333-339`, `:412` | Tombol close popup stasiun (30×30, atau 44×44 di perangkat sentuh) menutupi nilai baris pertama (Source, misalnya "FALLBACK"). | Tambahkan `padding-right` sekitar 40 px atau baris judul. |
| AUD-92 | C131 | `frontend/src/components/TacticalMap.tsx:171-172`, `frontend/src/console-design.css:214`, `:237` | Membuka Layers atau Expand mengecilkan frame peta tanpa re-frame, sehingga overlay terpotong (label W/E atau S) sampai Center ditekan. | `fitBounds` ulang saat resize karena perubahan layout, bila kamera belum digeser operator. |

#### Frontend: polar & readout

| ID | Cluster | Lokasi | Masalah dan dampak | Usulan perbaikan |
|---|---|---|---|---|
| AUD-93 | C099 | `frontend/src/components/PolarPanel.tsx:22-30`, `frontend/src/components/DoaReadout.tsx:33-60` | Teks status menyebut sebab yang salah. "Local snapshot expired" juga dipakai saat sumber stale atau read error. Readout menyebut semua kasus "No fresh DoA record" dan menampilkan "CURRENT" saat conflict. Sel gate selalu menampilkan `GROUND_CLOCK_UNVERIFIED` lebih dulu. | Turunkan teks dari `deriveDataState`/gate checks dan urutkan reason berdasarkan kegunaan. |
| AUD-94 | C100 | `frontend/src/components/PolarPlot.tsx:82-90` | Label tick "W 270°" terpotong di tepi kiri (margin 48 px) dan terbaca "N 270°" pada lebar desktop umum. | Margin sekitar 64 px atau label cardinal yang lebih pendek. |
| AUD-95 | C101 | `frontend/src/components/DoaReadout.tsx:51`, `:56` | Normalisasi dilakukan sebelum pembulatan, sehingga bisa tampil "360.0°"/"360°" alih-alih 0° (dapat dipicu offset kompas pecahan). | Bulatkan dulu, lalu terapkan % 360. |
| AUD-96 | C102 | `frontend/src/components/PolarPlot.tsx:80`, `:111-118` | Caption selalu menambahkan "compass heading unverified" dan offset, walau mode Polar mengabaikan offset. Hovertemplate di-hard-code dalam bahasa Inggris. | Buat caption kondisional; pindahkan teks hover ke i18n. |
| AUD-97 | C127 | `frontend/src/components/PolarPlot.tsx:61`, `frontend/src/components/TacticalMap.tsx:163`, `frontend/src/lib/i18n.ts` | Di UI Indonesia, peta memakai U/T/S/B sementara polar di sebelahnya memakai N/E/S/W. Judul kontrol MapLibre dan modebar Plotly tetap bahasa Inggris. | Ambil ticktext dari kunci `map.cardinal*` dan masukkan bahasa ke layout key; set `locale` MapLibre. |
| AUD-98 | C129 (dikoreksi) | `frontend/src/components/PolarPanel.tsx:22-30`, `frontend/src/components/DoaReadout.tsx:41-49` | Dengan Simulation ON, PolarPanel menampilkan status live "AVAILABLE · Data available…" tanpa badge SIMULATION (hanya kata "fixed" di caption). Bila dilihat sendiri (layout mobile tergulir, atau Expand), kurva sintetis tampak seperti data live. Bagian Overview lain sudah berlabel SIMULATION. | Tambahkan badge dan status khusus simulasi di PolarPanel. |

#### Frontend: halaman, i18n, layout

| ID | Cluster | Lokasi | Masalah dan dampak | Usulan perbaikan |
|---|---|---|---|---|
| AUD-99 | C026 | `frontend/src/lib/telemetry.ts:26-32`, `frontend/src/pages/DoADiagnosticsPage.tsx:7`, `frontend/src/App.tsx` | String error App/api/server dan helper (`formatAge` "h", label gate-check, validasi GPS) melewati i18n. Bahasa Inggris bocor ke UI Indonesia ("Dibaca 2 h lalu"), dan bahasa Indonesia ("password admin salah") ke UI Inggris. | Pakai kunci i18n ("jam", "menit"); server mengembalikan kode error. |
| AUD-100 | C027 | `frontend/src/lib/i18n.ts:350-352`, `AGENTS.md:116` | Copy bantuan dan AGENTS.md menyebut host monitor MQTT harus loopback, padahal backend default 10.90.0.1 dan menerima IP apa pun. Bantuan Data Out tidak menyebut host yang diizinkan (doasdr.local, 192.168.100.100, 127.0.0.1, localhost; port 8081). | Perbaiki copy, pesan error, dan AGENTS.md. |
| AUD-101 | C094 | `frontend/src/pages/SystemHealthPage.tsx:30-60` | Kartu "Data Out / HTTP" dan badge ringkasan diturunkan dari validitas skema `status.json`, bukan dari keterjangkauan HTTP per resource. Status tanpa `daq_ok` menghasilkan UNAVAILABLE walau semua GET 200; `doa.xml` 404 tetap AVAILABLE. | Turunkan dari `snapshot.resources`; tampilkan validitas status sebagai baris tersendiri. |
| AUD-102 | C106 | `frontend/src/console-design.css:104` | Strip telemetri memakai `justify-content:center` dengan overflow, sehingga item pertama (DATA) terpotong dan tidak bisa di-scroll pada 1024–1100 px dengan rail terbuka. | `justify-content: safe center` dan indikator scroll. |
| AUD-103 | C107 | `frontend/src/console-design.css:345-348`, `frontend/src/styles.css:60` | Metrik ringkasan System Health terpotong menjadi "P…" dan "3 …" pada 1024–1100 px (detail terpotong hingga sekitar 1440 px). Informasi yang sama ada di Node inspector. | Susun vertikal di bawah sekitar 1200 px. |
| AUD-104 | C108 | `frontend/src/pages/DoADiagnosticsPage.tsx:59`, `tools/ground_console.py:1419` | "Effective config" diam-diam hanya menampilkan 12 setting pertama secara alfabetis; `uniform_gain` dan `vfo_mode` hilang pada fixture valid. | Tampilkan semua atau tambahkan "+N lagi". |
| AUD-105 | C109 | `frontend/src/styles.css:111` | Di tema terang, tile native-record di Diagnostics tetap ber-tint hijau gelap dengan kontras label 2,65:1. | Override dengan token tema. |
| AUD-106 | C110 | `frontend/src/pages/ConfigurationPage.tsx:140`, `:269`, `:301`, `:315` | Enter tidak pernah men-submit form (tidak ada `<form>`). Port MQTT menjadi 0 saat dikosongkan (tampil "01883" saat diketik). "Restore defaults" di blok GPS juga mereset Compass. | Pakai `<form onSubmit>`, draft string untuk port, dan handler restore terpisah. |
| AUD-107 | C111 | `frontend/src/components/Shell.tsx:151-154`, `:170-185`, `:212` | Navigasi shortcut saat drawer mobile terbuka tidak menutup drawer dan memindahkan fokus ke belakangnya. Tidak ada focus trap atau `inert`. | Lewatkan shortcut melalui wrapper navigate Shell; buat background `inert`. |
| AUD-108 | C126 | `frontend/src/components/Shell.tsx:63-66` | `editableTarget()` menganggap semua INPUT sebagai field teks, sehingga shortcut 1–7 dan R mati setelah mengklik checkbox, radio, atau slider (toggle Simulation, panel Layers). | Batasi ke tipe input teks. |
| AUD-109 | C128 | `frontend/src/console-design.css:195-203` | Baris readout Overview memotong koordinat stasiun ("107.6…"), label, dan caveat "NOT LIVE GPS" pada 1024–1150 px dengan rail terbuka. | Bungkus menjadi 3 + 2 sel di bawah sekitar 1200 px. |

#### MQTT monitor

| ID | Cluster | Lokasi | Masalah dan dampak | Usulan perbaikan |
|---|---|---|---|---|
| AUD-110 | C031 (dikoreksi) | `tools/sdr_doa_mqtt_monitor.py:324` | State dan config_reported retained yang di-replay saat (re)subscribe melaporkan umurnya sebagai "latency". Nilai global hanya bertahan sampai health berikutnya, di baris kind hingga sekitar 30 s, dan berjam-jam bila agent sudah berhenti. | Tampilkan sebagai age; bedakan replay tanpa mengandalkan flag retain (`retainAsPublished`). |
| AUD-111 | C033 | `tools/sdr_doa_mqtt_monitor.py:314` | Pesan v1 `ack/config` tidak pernah di-decode: payload apa pun ≤ 16 KiB dihitung VALID, dan isi ACK (status, config_rev, error.code) tidak pernah tampil. | Tambahkan `ack_config` ke set decode. |

#### Edge agent (staging)

| ID | Cluster | Lokasi | Masalah dan dampak | Usulan perbaikan |
|---|---|---|---|---|
| AUD-112 | C035 (dikoreksi) | `tools/sdr_doa_lan_agent.py:117-123`, `tools/sdr_doa_collector.py:661`, `:695` | `confidence_mapping_ready` di-hard-code False, sehingga gate tidak pernah READY dan `health.state` hanya DEGRADED atau UNAVAILABLE. ONLINE dan STALE yang didokumentasikan tidak pernah dikirim, dan node sehat bernilai sama dengan node beku. | Lepaskan health node dari kesiapan publikasi DoA. |
| AUD-113 | C036 (dikoreksi) | `deploy/sdr-doa-lan-agent.service.example:15`, `tools/sdr_doa_mqtt_stdlib.py:183-185`, `tools/sdr_doa_lan_agent.py:501-507` | Agent tidak punya opsi TLS atau kredensial, tetapi klien stdlib mewajibkannya untuk broker non-loopback. Contoh deploy (192.168.100.173:18885) tidak bisa publish; run panjang me-retry selamanya lalu exit 0. Hanya menyangkut materi contoh. | Tambahkan `--mqtt-username`, password via environment, dan `--mqtt-cafile`, atau revisi rencana deploy. |
| AUD-114 | C037 | `tools/sdr_doa_lan_agent.py:428-475` | Perintah config yang ditolak (retry dengan id sama, skew jam, kedaluwarsa, QoS 0, field tidak diizinkan) tidak mendapat ACK, padahal kontrak mendefinisikan kodenya. | Kirim ACK rejected/expired dengan kode kontrak yang sesuai. |
| AUD-115 | C038 (dikoreksi) | `tools/synthetic_mqtt_publisher.py:148`, `tools/sdr_doa_lan_agent.py:535` | State dan config_reported retained dari publisher sintetis atau agent yang mati tetap di broker dan tampil VALID ke monitor yang baru tersambung, tanpa tanda sintetis atau offline (v1 tidak punya LWT maupun availability). Umurnya hanya bisa disimpulkan dari angka "latency". | Topic root terpisah atau `source:'synthetic'`, bersihkan retained saat keluar, tambahkan LWT/availability. |
| AUD-116 | C040 | `tools/sdr_doa_lan_agent.py:663`, `:677-683` | `--once --publish` mencetak output yang sama walau broker mati dan tidak mengirim DISCONNECT, sehingga smoke check tidak bisa memastikan ada yang terpublikasi. | Laporkan kind yang terpublikasi dan `last_error`; exit non-zero bila tidak ada yang terkirim. |
| AUD-117 | C041 (dikoreksi) | `tools/sdr_doa_mqtt_stdlib.py:290`, `:361`, `:370` | Klien stdlib menghitung paket masuk sebagai aktivitas keepalive, sehingga klien yang terutama menerima QoS 0 tidak pernah mengirim PINGREQ dan diputus broker. Saat ini tidak ada komponen yang dikirim yang realistis terdampak. | Lacak waktu kirim keluar secara terpisah. |
| AUD-118 | C042 | `tools/sdr_doa_lan_agent.py:421`, `:644` | `health.telemetry_drop_count` selalu 0 (`doa_drop_count` dan `queue.stats.replaced` tidak diteruskan). | Teruskan nilai itu ke `build_messages`. |
| AUD-119 | C043 | `tools/sdr_doa_lan_agent.py:498-519`, `:651` | Setelah reconnect MQTT, state dan config_reported baru dikirim ulang pada interval berikutnya (hingga 30 s); broker staging tidak memakai persistence. | Set `force_state = True` setelah connect berhasil. |
| AUD-120 | C044 | `QUICKSTART.md:234-236` | QUICKSTART menjanjikan perintah Ground Console dengan transport TCP untuk broker staging, tetapi blok perintahnya hilang. | Tambahkan perintah dengan `--mqtt-host 127.0.0.1 --mqtt-port 18884 --mqtt-transport tcp` dan `--config-path` terpisah. |

#### Receiver: backend & penyimpanan

| ID | Cluster | Lokasi | Masalah dan dampak | Usulan perbaikan |
|---|---|---|---|---|
| AUD-121 | C048 (dikoreksi) | `tools/receiver_record_store.py:1021-1025`, `tools/browsdr_receiver_overlay/src/client/app/records.ts:177` | Upsert marker set berdasarkan nama adalah kontrak yang disengaja dan teruji. Cacatnya ada di UI: setelah "New", menyimpan dengan nama yang sudah ada mengganti isi set itu tanpa konfirmasi. | Kembalikan 409 untuk create dengan nama yang sudah ada dan tanyakan overwrite. |
| AUD-122 | C049 | `tools/receiver_record_store.py:125`, `:1023-1025`, `tools/ground_console.py:1688` | Mengganti nama marker set ke nama yang sudah dipakai (dan error sqlite3/zlib lain) lolos dari handler, yang hanya menangkap `ValueError`/`KeyError`/`OSError`. Koneksi putus, UI hanya "Failed to fetch", dan autosave setelah edit marker ikut gagal. | Tangkap `IntegrityError` → 409; `sqlite3.Error`/`zlib.error` → 500 dengan pesan. |
| AUD-123 | C050 (dikoreksi) | `tools/receiver_record_store.py:591-592` | Filter jam audio tidak bisa melewati tengah malam: 22:00–02:00 menghasilkan 400 "time_from must not be later than time_to". Daftar audio kosong dan scan tidak di-refresh; shift malam harus dicek dengan dua query. | Bila from > to, cocokkan ≥ from ATAU ≤ to. |
| AUD-124 | C052 | `tools/receiver_record_store.py:778-824` | Delete menghapus baris DB sebelum file. Bila unlink gagal (misalnya di Windows saat file sedang di-stream), file yatim tertinggal dan pesan error menyesatkan. | Unlink atau pindahkan ke trash lebih dulu; sweep file yang tidak lagi direferensikan. |
| AUD-125 | C053 | `tools/ground_console.py:1505-1507` | Error "not found" sampai ke UI masih berkutip Python (`'scan not found'`) karena `str(KeyError)`. | Pakai `exc.args[0]`. |
| AUD-126 | C054 | `tools/ground_console.py:1798`, `frontend/vite.config.ts` | Bila build Receiver tidak ada, server mengembalikan JSON 404 mentah yang menyuruh menjalankan `npm run build`, padahal perintah itulah yang menghapus Receiver. | Untuk path `/receiver`, tampilkan pesan HTML yang menyuruh menjalankan `tools/build_browsdr_receiver.py` setelah `npm run build`. |

#### Receiver: scan/sweep

| ID | Cluster | Lokasi | Masalah dan dampak | Usulan perbaikan |
|---|---|---|---|---|
| AUD-127 | C063 | `tools/browsdr_receiver_overlay/src/client/worker/sweep-processing.ts:103`, `tools/browsdr_receiver_overlay/src/client/worker/sweep-engine.ts:283` | Manual sweep tidak pernah mengukur sekitar 12 kHz di setiap pusat tuning (start + 7,5 + k·10 MHz), sehingga carrier sempit di sana tidak terlihat. Mode manual juga menjadi fallback HackRF tanpa native sweep. | Geser grid tuning, atau jangan lewati bin DC saat `iqCorrection` aktif. |
| AUD-128 | C064 | `tools/browsdr_receiver_overlay/src/client/worker/sweep-processing.ts:76`, `:236` | Frekuensi puncak bias setengah bin (floor lalu +0,5), sehingga Listen men-tune sedikit meleset. | Pakai round, atau interpolasi parabola 3 bin. |
| AUD-129 | C065 | `tools/browsdr_receiver_overlay/src/client/app/sweep.ts:1005` | Sweep memakai frekuensi perangkat, tetapi Listen menulis puncak ke `centerFreq` (frekuensi tampilan). Pengguna upconverter (Freq Shift −125 MHz) mendengar F + 125 MHz. | Samakan domain frekuensi, atau set `centerFreq = peak + shift`. |
| AUD-130 | C066 | `tools/browsdr_receiver_overlay/src/client/app/sweep.ts:174-178` | Kandidat terpilih melompat ke kandidat mentah lain di setiap flush 1 s (id grup = id anggota terkecil), sehingga highlight canvas dan waterfall tidak lagi sesuai baris. | Simpan rentang puncak grup, lalu pilih ulang dari halaman tergrup. |
| AUD-131 | C067 | `tools/browsdr_receiver_overlay/src/client/app/sweep-session.ts:114`, `tools/browsdr_receiver_overlay/src/client/worker/sweep-processing.ts:236` | Sweep JSON tidak bisa dibuka ulang bila ada kandidat di bin parsial terakhir: pusatnya > `endHz`, dan parser menolak seluruh file. | Clamp frekuensi puncak/mean/min/max ke [startHz, endHz]. |
| AUD-132 | C134 (dikoreksi) | `tools/browsdr_receiver_overlay/src/client/app/sweep.ts:272`, `:1153`, `tools/browsdr_receiver_overlay/src/client/app/records.ts:137` | Klik atau tap non-drag pada spectrum/waterfall menambah marker, dan bila marker set tersimpan sedang dipilih, langsung disimpan ke server. Klik-untuk-marker memang disengaja, tetapi tidak ada hint maupun undo. Di perangkat sentuh, membaca nilai sama dengan menambah marker. | Gestur eksplisit untuk menambah marker, atau hint plus snackbar undo. |

#### Receiver: UI, rekaman, Records

| ID | Cluster | Lokasi | Masalah dan dampak | Usulan perbaikan |
|---|---|---|---|---|
| AUD-133 | C073 | `tools/browsdr_receiver_overlay/src/client/app/main.ts:23-27` | Handler `controllerchange` service worker me-reload iframe sekitar 1 s setelah kunjungan pertama dan setelah setiap rebuild. Aksi pada detik pertama hilang, dan tema berkedip. | Reload hanya bila sebelumnya sudah ada controller. |
| AUD-134 | C075 | `tools/browsdr_receiver_overlay/src/client/index.html:143`, `tools/browsdr_receiver_overlay/src/client/app/computed.ts:43-46` | Tombol "Connect Mock SDR" selalu tampil di 127.0.0.1, dan koneksi mock menampilkan "Radio SDR ON"/"DEVICE CONNECTED" tanpa nama board. | Hapus atau gate tombol mock; tampilkan "MOCK" di status radio. |
| AUD-135 | C076 | `frontend/src/pages/ReceiverPage.tsx:9` | Receiver selalu berbahasa Inggris (`lang=en`) walau console memakai bahasa Indonesia, sehingga operator mendapat UI campuran. | Teruskan bahasa seperti tema, atau dokumentasikan bahwa Receiver English-only. |
| AUD-136 | C077 | `frontend/src/pages/ReceiverPage.tsx:37` | Iframe Receiver tampil dengan tema gelap sampai event `load`, walau console bertema terang (dua kali pada kunjungan pertama karena reload SW). | Receiver membaca `sdr-console-theme` dari localStorage atau query sebelum first paint. |
| AUD-137 | C078 | `frontend/src/components/Shell.tsx:170-185` | Shortcut 1–7 dan R tidak berfungsi selama fokus berada di iframe Receiver, padahal hint di rail tetap tampil. | Forward keydown dari window iframe dengan guard yang sama. |
| AUD-138 | C133 (dikoreksi) | `tools/browsdr_receiver_overlay/src/client/app/sweep.ts:415-426`, `tools/browsdr_receiver_overlay/src/client/app/connection.ts:177-178`, `tools/browsdr_receiver_overlay/src/client/app/audio-recording.ts:97-114` | Membuka workspace Spectrum menghentikan RX Listener sesuai desain, tetapi rekaman VFO yang armed ikut difinalisasi tanpa konfirmasi, snackbar, atau notice. Audio yang sudah terekam tetap tersimpan. | Minta konfirmasi, atau tampilkan notice "Recording stopped". |
| AUD-139 | C136 (dikoreksi) | `tools/browsdr_receiver_overlay/src/client/app/sweep.ts:169`, `:581-586`, `tools/browsdr_receiver_overlay/src/client/app/vfo-audio-recorder.ts:218`, `tools/receiver_record_store.py:439`, `:506` | Saat arsip aktif dan console sempat tak terjangkau, upload trace yang gagal tidak di-retry, dan scan tersimpan tanpa penanda celah ("Archived sweeps 27" untuk 36 sweep). Banner hanya menyebut kegagalan terakhir dan tidak hilang setelah pulih. Chunk audio yang gagal dilaporkan sebagai "Could not finalize audio recording". | Antrean retry, hitung celah dan tampilkan di Records, pesan sebab yang benar. |
| AUD-140 | C137 | `tools/receiver_record_store.py:480-487`, `:639`, `tools/browsdr_receiver_overlay/src/client/index.html:872` | Records tidak pernah menampilkan rekaman yang sedang berjalan (label "in progress" di template tidak pernah terpakai), dan tidak ada indikator REC di luar Listener. | Kembalikan sesi aktif berlabel in-progress; tambahkan indikator REC di rail workspace. |
| AUD-141 | C138 | `tools/build_browsdr_receiver.py:78-80`, `tools/browsdr_receiver_overlay/src/client/style.css` | Top bar kosong 48–60 px di Spectrum dan Records, tombol Refresh membentang selebar header, dan tabel audio 760 px di kontainer 350 px sehingga player dan tombol Delete di luar layar ponsel. | Sembunyikan top bar di luar Listener, `flex: 0 0 auto` untuk tombol, kartu bertumpuk di bawah 600 px. |
| AUD-142 | C139 | `tools/browsdr_receiver_overlay/src/client/app/connection.ts:24-29`, `QUICKSTART.md:52-66` | "Connect Device" memanggil `navigator.usb` tanpa cek fitur. Di Firefox atau Safari tidak terjadi apa-apa (hanya TypeError di console), dan QUICKSTART tidak menyebut bahwa Chromium/WebUSB diperlukan. | Guard `'usb' in navigator` dengan pesan yang jelas; dokumentasikan kebutuhan browser. |

#### Dokumentasi & build

| ID | Cluster | Lokasi | Masalah dan dampak | Usulan perbaikan |
|---|---|---|---|---|
| AUD-143 | C143 | `QUICKSTART.md:11`, `CLAUDE.md:40`, `tools/ground_console.py:44`, `tools/receiver_record_store.py:14` | Dokumen menyatakan Python 3.x cukup untuk console dan 3.9+ hanya untuk Receiver, padahal console mengimpor `zoneinfo` saat start. Di Python 3.8 console langsung gagal. | Nyatakan minimum 3.9, atau impor `zoneinfo` secara lazy. |
| AUD-144 | C144 | `initialize.md:81-95`, `initialize.md:277`, `CLAUDE.md:68`, `evaluasi GUI.md:187` | Syarat paho ditulis "jika konfigurasi lokal punya `mqtt_host`", padahal default CLI 10.90.0.1 sehingga instalasi baru tanpa paho langsung exit. `initialize.md` tidak menyebut Receiver, `/api/receiver/*`, `/api/mqtt/rdf-node`, `--data-dir`, dan masih memakai path `/Users/mac`. | Selaraskan dengan `QUICKSTART.md:26`; lengkapi arsitektur dan daftar halaman. |
| AUD-145 | C145 | `SDR_DOA_FRONTEND_WORKFLOW.md:28-59` | Dokumen menjelaskan UI lama (Leaflet, lima halaman, satu host tile), dan perintah run/rollback `python3 tools/ground_console.py` gagal tanpa paho. | Pakai `.venv` dengan paho atau `--mqtt-host ''`; tujuh halaman; MapLibre dan kebutuhan WebGL2; langkah builder Receiver. |
| AUD-146 | C146 | `evaluasi GUI.md:329`, `GUI_RESPONSIVE_TECHY_PLAN.md:223`, `frontend/src/console-design.css:473`, `frontend/src/polar-layout.css:6` | Kriteria target sentuh ≥ 44 px yang dicatat terpenuhi tidak lagi benar pada 320 px: tombol EN/ID 34×44, modebar Plotly 44×22, summary Graph settings tinggi 40 px. | Perbesar target, lalu ulangi cek 320 px dan perbarui catatan. |
| AUD-147 | C147 | `evaluasi GUI.md:70`, `:87`, `:95-97`, `:210`, `:268`, `:335` | Dokumen yang ditunjuk AGENTS.md sebagai sumber keputusan UI terbaru bertentangan dengan UI sekarang: GSAP, Leaflet, banner simulasi, event `load`, urutan mobile, prioritas tile `.de`. | Tambahkan header "superseded" atau bagian "current state" di atas, lalu arahkan AGENTS.md dan initialize.md ke sana. |

#### Tes & tooling

| ID | Cluster | Lokasi | Masalah dan dampak | Usulan perbaikan |
|---|---|---|---|---|
| AUD-148 | baru (diverifikasi penulis laporan) | `tools/test_stage3.py:180`, `:345`, `:361`, `:426`, `:464`, `:491`, `tools/receiver_record_store.py:21`, `:83-90` | `tools/test_stage3.py`, yang disebut AGENTS.md sebagai cek backend, membuat `GroundConsoleServer` tanpa `receiver_data_dir`. Menjalankannya membuat `~/.local/share/sdr-doa-ground-console/receiver.sqlite3` (beserta `audio/` dan `tmp/`) di home developer yang sebenarnya. Diverifikasi dengan `HOME` sementara: `test_stage3.py` membuat direktori itu, sedangkan `unittest discover` dan `test_ground_console_static` tidak (keduanya memakai direktori sementara). Selain itu, suite mencetak banyak `ResourceWarning: unclosed database` (221 baris dalam satu run discover), karena store memakai `with self._connect() as db`, yang hanya commit atau rollback tanpa menutup koneksi. Ini noise, bukan leak: koneksi tertutup saat referensi lepas, dan 3.600 request tetap memakai 4 fd. | Beri `test_stage3.py` `receiver_data_dir` sementara (atau patch `DEFAULT_DATA_DIR`). Tutup koneksi secara eksplisit di store, misalnya dengan `contextlib.closing`. |

## 4. Yang sudah berjalan baik (terverifikasi)

- **Parsing sesuai upstream.** Kolom CSV (17 field + 360 bin, nilai tergeser non-negatif), skala XML (FREQUENCY MHz, CONF ×100, PWR +100), dan θ₀ kanonik (CSV 10 → 350 = XML 350) sesuai writer KrakenSDR. Wrap 0/360 dan jarak sirkular benar (359,6 vs 0,3 → 0,7°), dan batas toleransi 1,0° inklusif.
- **Gate dan pemisahan data.** CSV dan XML selalu terpisah dengan freshness masing-masing. `publication_gate` selalu BLOCKED dengan reason eksplisit, dan setiap reason punya label EN dan ID. Nilai non-finite ditolak per resource, JSON tidak pernah berisi NaN, dan body parsial di-retry serta diisolasi.
- **Orkestrasi frontend.** Latest-request-wins benar (respons lama tidak menimpa yang baru) dan semua request dibatalkan saat unmount. Timeout 10 s per request. `OverviewPage` memo bekerja (tick 500 ms tidak me-render ulang peta dan plot). Console pulih otomatis setelah server restart.
- **Simulasi.** Hanya memengaruhi Overview, selalu BLOCKED tanpa authority, dan berlabel di readout, strip, dan peta (kecuali panel polar, AUD-98).
- **Peta.** Kegagalan tile tidak mematikan overlay GeoJSON. Worker MapLibre termuat di bawah CSP. Update data lewat `setData` tidak menggerakkan kamera. Peta pulih setelah WebGL context dipulihkan. `halfPowerWidth` menangani wrap 0/360.
- **Stabilitas jangka panjang.** Tidak ada memory leak: heap datar selama 14 menit live (171 snapshot), simulasi 1 Hz, dan 75 pergantian route. Instance MapLibre dan Plotly dibuang saat unmount tanpa kehabisan konteks WebGL. Server Python tetap 2 thread dengan CPU < 1%, snapshot sekitar 9 KB dalam sekitar 2 ms, dan endpoint lain tetap responsif saat snapshot macet.
- **Konfigurasi.** Interval dan host yang buruk ditolak tanpa penyimpanan sebagian, read-back GET dilakukan, nilai bertahan setelah restart, dan POST config tidak terblokir oleh snapshot yang sedang berjalan. Endpoint dry-run tidak pernah menerapkan apa pun.
- **MQTT.** Monitor tersambung lewat TCP dan WS, subscribe 11 filter dalam satu SUBACK, reconnect dan resubscribe otomatis, buffer terbatas (`topic_counts` ≤ 128), dan tidak pernah publish. Builder dan validator kontrak konsisten untuk semua kind yang dikirim agent dan publisher sintetis (kecuali AUD-12).
- **Edge agent.** Framing MQTT benar, antrean latest-value benar, koneksi ditolak menghasilkan health UNAVAILABLE dalam sekitar 1 s, backoff 1–30 s, dan config apply atomik dengan read-back.
- **Receiver.** Bentuk respons `/api/receiver/*` cocok dengan parser klien. Chunk audio di-fsync dan di-rollback saat DB gagal. Playback Range (206/416) berfungsi. Ekspor marker dan sweep, bookmark, dan segmentasi audio per retune berjalan end-to-end, dan audio yang terekam benar-benar berisi suara. Sinkron tema berjalan live. Tidak ada leak selama scan. Store tetap cepat pada skala 222 MB.
- **Audit sebelumnya.** Perbaikan anti-slop 001–005 tidak regresi. Tidak ada horizontal overflow halaman di 320 dan 390 px pada ketujuh route. Shortcut dijaga saat mengetik di input, `html lang` benar, dan paritas kunci i18n utuh.

## 5. Keterbatasan audit

- **Hardware nyata tidak tersedia.** Tidak ada Raspberry Pi, KrakenSDR, atau HackRF. Konvensi sudut KrakenSDR disimpulkan dari source upstream. Native/manual sweep, unplug USB, WebUSB chooser, offset DC, dan noise nyata dimodelkan, sehingga besaran backlog arsip dan residu DC adalah estimasi.
- **Broker MQTT.** mosquitto tidak terpasang dan tidak ada broker produksi. Pengujian memakai broker uji buatan sendiri yang mengikuti spesifikasi, sehingga timing takeover dan keepalive di mosquitto bisa sedikit berbeda. `test_sdr_doa_mqtt_stdlib.py` tidak dijalankan. RDF Node v2 tidak punya producer di repo.
- **Basemap.** Tile OSM tidak terjangkau dari sandbox (egress proxy), jadi hanya jalur offline atau tile tiruan yang diamati.
- **GPU.** WebGL hanya lewat SwiftShader, sehingga biaya sisi GL kemungkinan berlebihan dan tidak dilaporkan. Tidak ada uji di GPU nyata.
- **Platform.** Windows dan Python 3.8 hanya diemulasikan (`PYTHONTZPATH` kosong, pemblokiran `zoneinfo`); temuan `npm.cmd` berasal dari code trace. Hanya Chromium yang diuji; Firefox dan Safari hanya disimulasikan dengan menghapus `navigator.usb`. Gestur sentuh dan screen reader tidak diuji.
- **Build.** `npm run build`, `vite build`, dan builder Receiver tidak dijalankan sesuai aturan audit, sehingga AUD-67 dan AUD-68 berasal dari code trace.
- **Durasi.** Sesi terpanjang sekitar 14 menit, tanpa soak multi-jam. Agen lain memakai CPU yang sama (load hingga 8), sehingga angka waktu absolut punya noise sekitar ±30%.
- **Asumsi simulasi.** Frekuensi CONFLICT sekitar 10% di AUD-18 bergantung pada asumsi frame 250 ms, latensi 30 ms per request, dan jitter ±2°. Mekanismenya sendiri deterministik.
- **Area yang tidak atau kurang diperiksa.** Legacy UI field per field, login admin dan unggah branding di browser, form dry-run di browser, perpindahan sumber GPS MANUAL dan Compass manual di browser, Whisper dan POCSAG, mode remote/WebRTC (dihapus builder), dua proses server yang berbagi satu data dir, serta latensi resolusi mDNS `doasdr.local` di Windows dan macOS.
- **Celah dari completeness critic (disarankan sebagai pemeriksaan lanjutan).** (1) Konsistensi saat console atau Receiver dibuka di beberapa tab sekaligus. (2) Operasi saat tab berada di latar belakang, di-minimize, atau dibekukan browser (timer throttling, rekaman Receiver, refresh saat tab terlihat kembali). (3) Review metadata rekaman Receiver (frekuensi, mode, bandwidth, durasi per segmen terhadap isi audio).
- **Temuan yang dikeluarkan.** Satu cluster tersanggah dan tidak dimasukkan: "Tuning a VFO while recording splits the audio into one tiny segment and file per frequency step".

## 6. Urutan perbaikan yang disarankan

### Segera

1. **Satu adapter arah untuk semua tampilan** — AUD-01, AUD-06, AUD-20, AUD-19, AUD-95. Konversi θ₀ ke bearing utara-searah-jarum-jam dengan `compass_offset` di satu tempat; pakai untuk peta, readout, dan polar; perbaiki orientasi mode Polar; simpan settings Data Out terakhir yang valid; tambahkan tes truth table. Perbaiki juga fixture yang melanggar konvensi bin (AUD-73) agar regresi bisa tertangkap.
2. **Gate kesiapan DoA yang jujur** — AUD-02, AUD-04, AUD-05, AUD-21, AUD-26, AUD-25, AUD-18. Deteksi node beku dari timestamp yang tidak maju. Batasi tampilan saat DAQ FAIL atau ADC overdrive. Pakai satu predikat kesiapan untuk peta, readout, dan polar. Tambahkan state INVALID/INCOMPLETE dan pakai STALE hanya untuk data yang memang kedaluwarsa. Uji conflict hanya pada pasangan same-frame.
3. **Loop refresh dan deadline collector** — AUD-08, AUD-09, AUD-24, AUD-23, AUD-33. Hapus `!loading` dari freshness, jangan batalkan request yang sedang berjalan saat tick, beri `collect()` deadline total tanpa retry error koneksi, tawarkan interval yang lebih pendek dari jendela freshness, dan hitung waktu koleksi ke umur data.
4. **Keselamatan data Receiver** — AUD-03, AUD-13, AUD-14. Pertahankan iframe atau minta konfirmasi sebelum keluar, finalisasi pada `pagehide`, pulihkan data yatim saat start, jangan hapus segmen yang gagal (rollover dan retry), pakai `Promise.allSettled` dan fallback zona waktu, dan dokumentasikan `tzdata`.
5. **Peta yang bisa dibaca untuk data live** — AUD-07, AUD-10, AUD-11, AUD-42, AUD-31. Skala overlay auto untuk data live, re-frame saat fix nyata pertama datang, try/catch dan error boundary untuk MapLibre dan chunk lazy, dan penanganan WebGL context lost.
6. **Label simulasi di scan Receiver** — AUD-15. Pilih native/manual saat perangkat tersambung, tampilkan badge SIMULATION, dan simpan pengaturan scan. Perbaikannya kecil tetapi mencegah data sintetis dianggap nyata.

### Berikutnya

7. **Kualitas deteksi scan** — AUD-16, AUD-17, AUD-62, AUD-63, AUD-66, AUD-65, AUD-64, AUD-61, AUD-128. Batas kandidat dan persistensi deteksi, grouping berdasarkan overlap (klien dan SQL), pencocokan kandidat terdekat, floor noise yang lebih lebar, preset berbasis SNR, rentang waterfall, koreksi DC setelah FFT, unmute VFO saat Listen, dan bias setengah bin.
8. **Edge agent** — AUD-12, AUD-52, AUD-53, AUD-112, AUD-114, AUD-118, AUD-119, AUD-116. Dukungan `output_vfo = -1`, isolasi pembuatan payload per jenis pesan, anggaran collect di bawah keepalive, koleksi mengikuti jadwal publish, state health yang bermakna, ACK untuk penolakan, dan drop count.
9. **MQTT monitor** — AUD-44, AUD-45, AUD-46, AUD-47, AUD-48, AUD-49, AUD-51, AUD-50, AUD-43, AUD-110, AUD-111, AUD-115. Poll tersendiri, Count per kind, regex redaksi yang benar, umur per kind, Reconnect yang benar-benar reconnect, client id unik, transport di form, keputusan panel v2 (implementasi atau koreksi dokumen), grid metrik di ponsel, dan penanda retained/sintetis.
10. **Visibilitas error** — AUD-27, AUD-93, AUD-101, AUD-75, AUD-76, AUD-77, AUD-70, AUD-28. Tampilkan error collector dan HTTP status di layar, teks status yang menyebut sebab sebenarnya, kartu Data Out/HTTP dari resource, `overall_state` yang mempertimbangkan conflict, dan timeout serta expiry di legacy UI.
11. **Polar dan Plotly** — AUD-36, AUD-37, AUD-38, AUD-34, AUD-35. Hapus tombol Share ke Plotly Cloud, perbaiki CSP untuk ekspor PNG, pakai bundle Plotly parsial atau impor tertunda, pisahkan Head Up dari range manual, dan skala radial yang mengikuti span data.
12. **Receiver UI dan rekaman** — AUD-54, AUD-58, AUD-133, AUD-60, AUD-57, AUD-55, AUD-138, AUD-56, AUD-59, AUD-139, AUD-140, AUD-142. Hapus font remote dan cache `/api` di service worker, reload SW hanya saat update, gaya tombol disabled, header Duration WebM, rekaman yang bertahan atau setidaknya memberi tahu saat RX restart, deteksi unplug, filter berdasarkan overlap, penanda celah arsip, rekaman aktif di Records, dan guard WebUSB.
13. **Konfigurasi dan form** — AUD-39, AUD-41, AUD-40, AUD-30, AUD-29, AUD-22, AUD-32, AUD-82, AUD-84, AUD-86. Simpan konfigurasi GPS dan Compass, normalisasi sebelum read-back, skip link yang tidak berpindah route, input overlay berbasis draft, pertahankan koordinat live terakhir saat stale, dukungan CSV multi-VFO, satu host tile dengan switch saat gagal, presedensi CLI yang terlihat, dan retry config awal.
14. **Build dan dokumentasi** — AUD-67, AUD-68, AUD-126, AUD-143, AUD-144, AUD-145, AUD-120, AUD-100, AUD-148. Rangkai build frontend dan Receiver dalam satu langkah, buat tes gagal saat Receiver hilang, resolve `npm.cmd`, perbaiki syarat Python dan paho di dokumen, lengkapi perintah staging TCP, perbaiki copy loopback, dan isolasi data dir di `test_stage3.py`.

### Nanti

15. **Layout dan polesan** — AUD-102, AUD-103, AUD-105, AUD-109, AUD-91, AUD-92, AUD-94, AUD-141, AUD-146.
16. **i18n dan copy** — AUD-99, AUD-97, AUD-96, AUD-98, AUD-135, AUD-81, AUD-74, AUD-78, AUD-147.
17. **Perilaku interaksi minor** — AUD-106, AUD-107, AUD-108, AUD-137, AUD-136, AUD-130, AUD-132, AUD-121, AUD-122, AUD-123, AUD-125, AUD-134.
18. **Kasus tepi geometri dan data** — AUD-87, AUD-88, AUD-89, AUD-90, AUD-69, AUD-71, AUD-72, AUD-104, AUD-127, AUD-129, AUD-131, AUD-124.
19. **Server dan staging minor** — AUD-79, AUD-80, AUD-83, AUD-85, AUD-113, AUD-117.

## 7. Status perbaikan (per 2026-10-13)

Perbaikan dikerjakan dalam tiga gelombang di branch `claude/admiring-volta-5pijou`. Kolom commit:

| Commit | Isi |
|---|---|
| `2111c88` | Helper bearing geografis untuk θ₀ (`geographicBearingForBin`) |
| `bc5be0e` | Wave 1: jalur data, Overview, Receiver, MQTT, edge agent |
| `f5c5449` | Wave 2: state App, halaman, Message Monitor |
| `2cd42ce` | Wave 2: tindak lanjut Receiver |
| wave 3 (belum di-commit) | Perubahan di working tree saat dokumen ini ditulis: integrasi frontend, perbaikan backend kecil, dokumentasi dan tooling build |

Status: `fixed` = temuan tertangani untuk kasus yang dilaporkan; `partial` = sebagian tertangani, sisanya dicatat di 7.2; `not_applicable` dan `deferred` tidak dipakai untuk temuan mana pun pada saat penulisan. Status mengikuti laporan per paket perbaikan dan pemeriksaan ulang kode saat dokumen ini ditulis. Status `fixed` bukan bukti uji di hardware (lihat 7.3).

Jumlah: 147 fixed, 1 partial, 0 not_applicable, 0 deferred, dari 148 temuan. 23 temuan menyertakan perubahan wave 3.

### 7.1 Tabel status

| AUD-ID | Status | Ringkasan | Commit |
|---|---|---|---|
| AUD-01 | fixed | Peta, hover, popup, dan readout memakai bearing geografis (360 − θ₀ + compass_offset) mod 360 lewat `geographicBearingForBin`; θ₀ tetap tampil sebagai sudut array. | `2111c88`, `bc5be0e` |
| AUD-02 | fixed | `NodeProgressTracker` per base URL mendeteksi timestamp, uptime, dan frame index yang tidak maju (`NODE_CLOCK_STALLED` setelah 10 s); UI menampilkan STALE dan teks node berhenti. | `bc5be0e`, `f5c5449` |
| AUD-03 | fixed | Store menutup sesi yatim (Interrupted) saat start dan saat Records dibuka, finalisasi saat `pagehide`; iframe Receiver tetap ter-mount saat pindah halaman. | `bc5be0e`, `f5c5449` |
| AUD-04 | fixed | Satu predikat `overviewDoaStatus()` menyembunyikan bearing, kurva polar, dan overlay saat DAQ sync tidak PASS atau ADC overdrive; status DEGRADED. Wave 3 menambah teks khusus DAQ UNKNOWN. | `f5c5449`, wave 3 (belum di-commit) |
| AUD-05 | fixed | ADC overdrive diparse (bool/bitmask) dan membuat snapshot DEGRADED; SNR dan PAPR native tampil di Health dan Diagnostics. Tidak ada ambang SNR/confidence (keputusan produk). | `bc5be0e`, `f5c5449` |
| AUD-06 | fixed | Mode Polar menggambar θ₀ berlawanan jarum jam seperti upstream KrakenSDR; Compass tetap north-up searah jarum jam. | `bc5be0e` |
| AUD-07 | fixed | Skala dB overlay default Auto dari vektor (span minimum 1 dB); Manual tetap tersedia dengan peringatan jenuh di legend. | `bc5be0e` |
| AUD-08 | fixed | Freshness tidak lagi bergantung pada `loading`; data terakhir tetap tampil selama refresh dan "Membaca…" hanya muncul untuk pembacaan pertama atau > 1 s. | `f5c5449` |
| AUD-09 | fixed | `collect(total_budget_s)` tanpa retry error transport, `/api/snapshot` single-flight dengan anggaran 4 s; UI berbagi request yang berjalan dan menampilkan UNAVAILABLE dalam sekitar 4 s. | `bc5be0e`, `f5c5449` |
| AUD-10 | fixed | Kamera membingkai ulang saat sumber posisi berubah (misalnya fix nyata pertama), kecuali operator sudah menggeser kamera dan stasiun masih terlihat. | `bc5be0e` |
| AUD-11 | fixed | Konstruktor MapLibre dibungkus try/catch; tanpa WebGL2 peta masuk state `no-webgl` dengan pemberitahuan dan overlay kanvas. | `bc5be0e` |
| AUD-12 | fixed | Kontrak menerima `output_vfo = -1`; tiap jenis pesan dibangun terpisah sehingga health tetap terkirim. | `bc5be0e` |
| AUD-13 | fixed | Upload gagal tidak menghapus segmen; audio tersimpan ditandai partial dan tetap bisa diputar. | `bc5be0e` |
| AUD-14 | fixed | Records memakai `Promise.allSettled`, server menerima alias UTC dan memetakan nama zona legacy, fallback ke offset UTC; QUICKSTART menyebut `tzdata` di Windows. | `bc5be0e` |
| AUD-15 | fixed | Sumber scan mengikuti radio yang tersambung, sumber Simulation selalu berlabel SIMULATION, pengaturan scan disimpan. | `bc5be0e` |
| AUD-16 | fixed | Riwayat kandidat dibatasi 1000 (evict yang paling lama tidak terlihat); sinyal lemah butuh konfirmasi sekitar 6 sweep. | `bc5be0e` |
| AUD-17 | fixed | Grouping di klien dan SQL memakai overlap band [start, end], tidak lagi rantai 100 kHz. | `bc5be0e` |
| AUD-18 | fixed | Uji sudut 1° hanya untuk pasangan same-frame, dengan re-read paralel untuk frame bersebelahan. Wave 3: pasangan yang tidak dicek memblokir publikasi dengan `NATIVE_ANGLE_UNCHECKED`. | `bc5be0e`, wave 3 (belum di-commit) |
| AUD-19 | fixed | Pengaturan Data Out terakhir yang valid dipakai ulang hingga 90 s dengan label "last known", lalu fallback berlabel assumed. | `bc5be0e` |
| AUD-20 | fixed | `compass_offset` dari Data Out dipakai juga untuk plot Linear, berlabel `DATA_OUT · LOCAL AXIS`. | `bc5be0e` |
| AUD-21 | fixed | Peta memakai `doaReady` dari predikat yang sama dengan readout dan polar; CONFLICT atau view hilang mengosongkan ketiganya. Wave 3: pemberitahuan peta menyebut penyebabnya. | `f5c5449`, wave 3 (belum di-commit) |
| AUD-22 | fixed | CSV multi-VFO (1–16 baris) diterima dan baris dipilih lewat frekuensi XML; format "Kerberos App" mendapat error eksplisit (tidak diparse). | `bc5be0e`, `f5c5449` |
| AUD-23 | fixed | Umur DoA menghitung waktu koleksi di Ground (`ground_elapsed_ms`). | `bc5be0e` |
| AUD-24 | fixed | Interval 1 s dan 2 s ditambahkan, default instalasi baru 2 s; form memberi peringatan untuk Manual dan > 5 s. | `bc5be0e`, `f5c5449` |
| AUD-25 | fixed | `deriveDataState` mengikuti urutan collector: UNAVAILABLE sebelum STALE; STALE hanya untuk data yang memang tua. | `f5c5449` |
| AUD-26 | fixed | State INVALID dan INCOMPLETE ditambahkan, juga CONFLICT dan INCOMPLETE di `overall_state`. | `bc5be0e`, `f5c5449` |
| AUD-27 | fixed | Tabel Pembacaan resource dan error per view tampil di Health dan Diagnostics. Wave 3: error `/api/snapshot` tampil sebagai banner, bukan hanya tooltip. | `f5c5449`, wave 3 (belum di-commit) |
| AUD-28 | fixed | Legacy UI mendapat timeout request 8 s, expiry lokal, dan interval 1/2 s. | `bc5be0e` |
| AUD-29 | fixed | Posisi Data Out live terakhir dipertahankan di peta dan readout ("POSISI STASIUN TERAKHIR · STALE"). Wave 3: hanya `gps_status` tanpa fix yang menjatuhkan ke posisi referensi. | `bc5be0e`, `f5c5449`, wave 3 (belum di-commit) |
| AUD-30 | fixed | Field angka overlay berupa draft yang berlaku saat Enter/blur; nilai tidak valid ditolak dengan pesan, tidak di-clamp. | `bc5be0e` |
| AUD-31 | fixed | WebGL context lost dan worker macet ditangani: kanvas fallback aktif dengan pemberitahuan, pulih saat context dipulihkan. | `bc5be0e` |
| AUD-32 | fixed | Satu host tile pada satu waktu (`.de` lalu `.org` setelah 4 kegagalan atau host diam), chip BASEMAP UNAVAILABLE; dokumen diperbarui di wave 3. | `bc5be0e`, wave 3 (belum di-commit) |
| AUD-33 | fixed | Domain radial terakhir dipertahankan saat nilai sesaat null, sehingga hanya restyle yang berjalan dan zoom/rotasi bertahan. | `bc5be0e` |
| AUD-34 | fixed | Checkbox "Rentang dB manual" terpisah; Head Up saja mempertahankan skala auto. | `bc5be0e` |
| AUD-35 | fixed | `radialDomain()` memakai langkah 1/2/5 × 10^k dari span data (minimum 1 dB); `SDR_DOA_8081_DATA_REFERENCE.md` diperbarui di wave 3. | `bc5be0e`, wave 3 (belum di-commit) |
| AUD-36 | fixed | Tombol Share (`sendChartToCloud`) dihapus dan `showSendToCloud` false. | `bc5be0e` |
| AUD-37 | fixed | CSP `img-src` memuat `blob:`; ekspor PNG diverifikasi di Playwright. | `bc5be0e` |
| AUD-38 | fixed | Bundle Plotly parsial (core + scatterpolar), chunk sekitar 1,2 MB; freeze Overview turun dari sekitar 1,2 s ke sekitar 0,25 s (CPU 1x, sandbox). | `bc5be0e` |
| AUD-39 | fixed | `lib/sourceConfigStorage.ts` menyimpan pilihan GPS/Compass dengan validasi; wave 3 memulihkannya saat App start. | `f5c5449`, wave 3 (belum di-commit) |
| AUD-40 | fixed | Skip link memfokuskan `#console-content` tanpa mengubah route. | `f5c5449` |
| AUD-41 | fixed | Form menormalkan nilai sebelum read-back; wave 3: server menolak port/interval pecahan atau boolean, tidak lagi memotongnya. | `f5c5449`, wave 3 (belum di-commit) |
| AUD-42 | fixed | Chunk di-prefetch dan dimuat lewat `lazyWithRetry`; `LoadErrorBoundary` membatasi kegagalan ke halaman atau panel peta. | `f5c5449` |
| AUD-43 | fixed | Baris metrik Message Monitor menjadi dua kolom di ≤ 639 px. | `f5c5449` |
| AUD-44 | fixed | `/api/mqtt` punya poll sendiri: 2 s di Monitor Pesan dan Kesehatan Sistem, 5 s di halaman lain. | `f5c5449` |
| AUD-45 | fixed | Snapshot monitor punya `kind_counts`; kolom Count membacanya. | `bc5be0e`, `f5c5449` |
| AUD-46 | fixed | Flag `valid`/`doa_valid`/`settings_valid` disalin ke `validity_flags` dan tampil apa adanya; regex redaksi hanya memeriksa kata terakhir key. | `bc5be0e`, `f5c5449` |
| AUD-47 | fixed | Tiap kind punya `age_ms`/`source_ts_ms`, kolom Age berjalan lokal, badge STALE per kind. | `bc5be0e`, `f5c5449` |
| AUD-48 | fixed | Reconnect selalu membuat client baru dan mereset penghitung; pesan UI menyebutnya. Wave 3 meneruskan transport dan path secara eksplisit. | `bc5be0e`, `f5c5449`, wave 3 (belum di-commit) |
| AUD-49 | fixed | Client id `groundconsole` + 10 hex acak per monitor. | `bc5be0e` |
| AUD-50 | fixed | Panel RDF Node v2 di Monitor Pesan (poll `GET /api/mqtt/rdf-node` 2 s selama halaman terbuka). Wave 3: retained clear v2 tampil UNAVAILABLE. | `f5c5449`, wave 3 (belum di-commit) |
| AUD-51 | partial | Transport (`tcp`/`websockets`) dan `mqtt_ws_path` ada di kontrak, CLI, dan form. Kredensial dan TLS sengaja belum dibuat karena POST config/connect belum punya guard Origin. | `bc5be0e`, `f5c5449` |
| AUD-52 | fixed | Agent memakai `--collect-budget` (default 2 s, maks 10 s) di bawah keepalive/2. | `bc5be0e` |
| AUD-53 | fixed | Koleksi mengikuti jadwal publish; CSV/XML hanya dibaca bila authority dipilih. | `bc5be0e` |
| AUD-54 | fixed | Google Fonts dihapus dari Receiver dan CSP-nya; builder gagal bila host font muncul lagi. | `bc5be0e` |
| AUD-55 | fixed | Perubahan sample rate/FFT size me-restart RX lalu melanjutkan rekaman di sesi baru dengan pemberitahuan. | `bc5be0e` |
| AUD-56 | fixed | Event USB `disconnect` dan error transfer RX dari worker menghentikan RX/scan, menutup rekaman, dan menampilkan alert. Belum diuji dengan HackRF nyata. | `bc5be0e`, `2cd42ce` |
| AUD-57 | fixed | Store menulis elemen Duration Matroska saat segmen selesai atau dipulihkan, sehingga seek berfungsi. | `bc5be0e` |
| AUD-58 | fixed | Build embedded tidak mendaftarkan service worker; `sw.js` pengganti menghapus cache lama lalu unregister. | `bc5be0e` |
| AUD-59 | fixed | Filter audio memakai overlap [started_at, ended_at]; segmen yang berjalan dihitung sampai sekarang. | `bc5be0e` |
| AUD-60 | fixed | `.btn:disabled` punya opacity, kursor not-allowed, dan tanpa hover. | `bc5be0e` |
| AUD-61 | fixed | Listen kembali meng-unmute VFO aktif sebelum `startStream`. | `bc5be0e` |
| AUD-62 | fixed | Pencocokan run ke kandidat terdekat (≤ 50 kHz) setelah diurutkan dari yang terkuat. | `bc5be0e` |
| AUD-63 | fixed | Floor blok = min(median blok, persentil 25 floor blok ±10 MHz), sehingga sinyal wideband tidak menjadi floor-nya sendiri. | `bc5be0e` |
| AUD-64 | fixed | Bagian pecahan offset DC dihapus dengan pembulatan ber-dither; noise floor naik sekitar 0,7–2 dB pada gain sangat rendah. | `bc5be0e` |
| AUD-65 | fixed | Skala byte waterfall dan trace arsip −160..+60 dB; arsip lama tetap terbuka. | `bc5be0e` |
| AUD-66 | fixed | Preset minimum peak All (default) dan −50..0 dBFS. | `bc5be0e` |
| AUD-67 | fixed | Script `npm run build:all` (dan `build:receiver`) merangkai build console dan Receiver; tes static gagal (bukan skip) bila `dist` ada, submodule ada, tetapi `dist/receiver` hilang; semua dokumen build/verifikasi diperbarui. | wave 3 (belum di-commit) |
| AUD-68 | fixed | Builder me-resolve npm lewat `shutil.which` (menemukan `npm.cmd` di Windows) dan memberi pesan jelas bila npm tidak ada; diuji dengan mock, tanpa host Windows. | wave 3 (belum di-commit) |
| AUD-69 | fixed | Sudut native di [−360, 720] direduksi modulo 360 sebelum konvensi diterapkan; sudut yang tidak bisa dipakai menjadi `NATIVE_ANGLE_INVALID`. | `bc5be0e` |
| AUD-70 | fixed | `HTTPError` ditangkap sebelum `URLError`, `http_status` terisi, error parse XML disimpan di candidate. | `bc5be0e` |
| AUD-71 | fixed | `STATION_ID` XML opsional; koma di station ID CSV diserap ke field station. | `bc5be0e` |
| AUD-72 | fixed | Daya XML ≤ 0,0 dan CSV ≤ −100 ditandai lossy (`POWER_FLOOR_LOSSY`). | `bc5be0e` |
| AUD-73 | fixed | Fixture mengikuti konvensi peak bin = θ₀; fixture baru `peak-mismatch` menguji `ANGULAR_PEAK_ANGLE_MISMATCH`. | `bc5be0e` |
| AUD-74 | fixed | Dry-run memakai builder/validator kontrak MQTT dan mewajibkan `base_config_rev`; label "(optional)" dihapus. | `bc5be0e`, `f5c5449` |
| AUD-75 | fixed | Tangga `overall_state` memeriksa CONFLICT dan INCOMPLETE sebelum UNVERIFIED/LIVE. | `bc5be0e` |
| AUD-76 | fixed | Tanpa `status.json` di mode remote_unverified, freshness DoA tidak diketahui (age null), bukan dihitung dengan jam Ground. | `bc5be0e` |
| AUD-77 | fixed | `http.client.HTTPException` ditangkap per resource (`error_kind=protocol`) dan di handler snapshot. | `bc5be0e` |
| AUD-78 | fixed | Help CLI collector memakai contoh `http://192.168.100.100:8081` dan daftar host; opsi `--total-budget` ditambahkan. | `bc5be0e` |
| AUD-79 | fixed | Tanpa paho, slot monitor berisi placeholder berstatus error; POST config tidak lagi memutus koneksi. | `bc5be0e` |
| AUD-80 | fixed | Server menerima PNG palette, 16-bit, dan interlaced; klien memvalidasi PNG sebelum di-stage. | `bc5be0e`, `f5c5449` |
| AUD-81 | fixed | Tanpa `SDR_DOA_ADMIN_PASSWORD` login menjawab 503 `ADMIN_DISABLED`; panel menampilkan DISABLED, error diterjemahkan. | `bc5be0e`, `f5c5449` |
| AUD-82 | fixed | Flag CLI eksplisit mengalahkan `console.json` untuk run itu dengan pemberitahuan di log; QUICKSTART dan dokumen lain diperbarui di wave 3. | `bc5be0e`, wave 3 (belum di-commit) |
| AUD-83 | fixed | Referensi monitor ditukar di bawah lock; `stop()` dipanggil setelah lock dilepas. | `bc5be0e` |
| AUD-84 | fixed | Field invalid di `console.json` jatuh ke default per field dengan log; file asli disalin ke `console.json.invalid.bak`. | `bc5be0e` |
| AUD-85 | fixed | Legacy CSS punya `[hidden]{display:none!important}`. | `bc5be0e` |
| AUD-86 | fixed | GET config awal dicoba ulang 1, 2, 4, 8, lalu setiap 15 s; Konfigurasi menampilkan pemberitahuan sampai termuat. | `f5c5449` |
| AUD-87 | fixed | Ring lobe ditutup pada titik perimeter pertama, tanpa jari-jari ke 0°. | `bc5be0e` |
| AUD-88 | fixed | `destination()` menjaga longitude kontinu dengan origin, sehingga geometri tidak melintasi dunia dekat ±180°. | `bc5be0e` |
| AUD-89 | fixed | Chip BASEMAP UNAVAILABLE muncul setelah semua host gagal dan hilang saat tile berikutnya termuat. | `bc5be0e` |
| AUD-90 | fixed | Kamera disimpan di module scope saat unmount dan dipulihkan saat kembali ke Overview. | `bc5be0e` |
| AUD-91 | fixed | Popup stasiun punya baris judul sehingga tombol close tidak menutupi nilai pertama. | `bc5be0e` |
| AUD-92 | fixed | ResizeObserver membingkai ulang overlay saat Layers/Expand/resize bila kamera belum digeser operator. | `bc5be0e` |
| AUD-93 | fixed | `lib/doaStatus.ts` memberi kode dan teks per penyebab (conflict, status tak terbaca, view hilang, node beku, stale, expiry lokal, DAQ/ADC). Wave 3 merapikan teks polar. | `bc5be0e`, wave 3 (belum di-commit) |
| AUD-94 | fixed | Margin plot 64 px (lebar) dan 40 px (ringkas); label W 270° tidak terpotong. | `bc5be0e` |
| AUD-95 | fixed | `formatDegrees()` membulatkan dulu lalu wrap, sehingga tidak muncul 360,0°. | `bc5be0e` |
| AUD-96 | fixed | Caption dipisah per mode; Polar tidak menyebut offset; hovertemplate diterjemahkan. | `bc5be0e` |
| AUD-97 | fixed | Huruf kardinal U/T/S/B di polar ID, locale Plotly dan judul kontrol MapLibre mengikuti bahasa. | `bc5be0e` |
| AUD-98 | fixed | PolarPanel menampilkan badge SIMULATION dan teks kurva sintetis. | `bc5be0e` |
| AUD-99 | fixed | Durasi dilokalkan (`common.duration*`), label gate-check, validasi GPS, dan error admin diterjemahkan; wave 3 menerjemahkan error App/api dan `formatElapsed`. Detail error dari browser/radio tetap Inggris. | `f5c5449`, wave 3 (belum di-commit) |
| AUD-100 | fixed | Copy bantuan host MQTT dan Base URL (EN/ID) menyebut aturan yang sebenarnya; AGENTS.md tidak lagi menyebut host MQTT harus loopback. | wave 3 (belum di-commit) |
| AUD-101 | fixed | Kartu dan badge Data Out HTTP dihitung dari `snapshot.resources` (AVAILABLE/PARTIAL/UNAVAILABLE/UNKNOWN). | `f5c5449` |
| AUD-102 | fixed | Auto margin pada item pertama/terakhir strip; DATA tidak terpotong. Di ponsel strip tetap scroll horizontal dengan bayangan tepi. | `f5c5449` |
| AUD-103 | fixed | Container query pada panel ringkasan Health; metrik bertumpuk di bawah 520 px lebar panel. | `f5c5449` |
| AUD-104 | fixed | `.slice(0, 12)` dihapus; Effective config menampilkan semua setting (server tidak perlu diubah). | `f5c5449` |
| AUD-105 | fixed | Tile native-record tanpa tint hijau gelap; kontras label sekitar 5,6:1 di tema terang. | `f5c5449` |
| AUD-106 | fixed | Setiap bagian Konfigurasi adalah `<form>` (Enter men-submit); port kosong tidak menjadi 0; restore default per blok. | `f5c5449` |
| AUD-107 | fixed | Shortcut menutup drawer; konten utama `inert` selama drawer terbuka. | `f5c5449` |
| AUD-108 | fixed | `isTextEntryTarget` hanya memblokir input bertipe teks, textarea, select, dan contenteditable. | `f5c5449` |
| AUD-109 | fixed | Readout Overview membungkus ke 3 + 2 sel di 1024–1199 px (hingga 1279 px dengan rail terbuka). | `f5c5449` |
| AUD-110 | fixed | Filter v1 memakai Retain As Published = 0; replay retained tidak lagi dihitung sebagai latency. | `bc5be0e` |
| AUD-111 | fixed | `ack/config` di-decode sesuai kontrak; ACK rusak dihitung invalid. | `bc5be0e` |
| AUD-112 | fixed | `node_health()` menghasilkan ONLINE/STALE/DEGRADED/UNAVAILABLE dengan `health.reasons`, terpisah dari kesiapan DoA. | `bc5be0e` |
| AUD-113 | fixed | Agent punya `--mqtt-username` (password dari `SDR_DOA_MQTT_PASSWORD`), `--mqtt-tls`, `--mqtt-cafile`; broker non-loopback tanpa TLS/username ditolak saat start. | `bc5be0e` |
| AUD-114 | fixed | Perintah config yang ditolak mendapat ACK dengan kode kontrak. | `bc5be0e` |
| AUD-115 | fixed | Publisher sintetis memberi `source: "synthetic"` dan menghapus retained saat keluar; agent punya topic availability; monitor menampilkan badge SYNTHETIC dan CLEARED. | `bc5be0e`, `f5c5449` |
| AUD-116 | fixed | `--once` melaporkan `published_kinds` dan `last_error`, mengirim DISCONNECT, dan exit 1 bila tidak ada yang terkirim. | `bc5be0e` |
| AUD-117 | fixed | PINGREQ dijadwalkan dari paket keluar terakhir saja. | `bc5be0e` |
| AUD-118 | fixed | `telemetry_drop_count` menghitung sampel health/DoA yang tergantikan sebelum terkirim (tertinggal satu sampel). | `bc5be0e` |
| AUD-119 | fixed | Setelah reconnect, state dan config_reported dikirim ulang segera. | `bc5be0e` |
| AUD-120 | fixed | QUICKSTART punya perintah broker staging (`mosquitto -c tools/mqtt_stage4.conf`) dan Ground Console dengan `--mqtt-transport tcp` serta `--config-path` terpisah. | wave 3 (belum di-commit) |
| AUD-121 | fixed | Menyimpan marker set dengan nama yang sudah ada menjawab 409; UI meminta konfirmasi sebelum mengganti. | `bc5be0e` |
| AUD-122 | fixed | Rename ke nama yang dipakai menjawab 409; error sqlite3/zlib menjadi 500 dengan pesan storage. | `bc5be0e` |
| AUD-123 | fixed | Jendela waktu boleh melewati tengah malam (22:00–02:00). | `bc5be0e` |
| AUD-124 | fixed | Delete menghapus file dulu; bila gagal, baris dipertahankan agar bisa diulang; file yatim dibersihkan saat start. | `bc5be0e` |
| AUD-125 | fixed | Pesan not-found memakai `exc.args[0]`, tanpa kutip Python. | `bc5be0e` |
| AUD-126 | fixed | Tanpa build Receiver, `/receiver/` mengembalikan halaman HTML 404 berisi langkah build ulang. | `bc5be0e` |
| AUD-127 | fixed | Grid tuning manual sweep bergeser setengah langkah di setiap pass ganjil, sehingga bin DC terukur bergantian. | `bc5be0e` |
| AUD-128 | fixed | Posisi sampel di dalam bin dicatat dan puncak diinterpolasi; bias setengah bin hilang. | `bc5be0e` |
| AUD-129 | fixed | Listen men-tune ke frekuensi tampilan (puncak + Freq Shift), sehingga hardware men-tune ke frekuensi yang di-scan. | `bc5be0e` |
| AUD-130 | fixed | `reselectCandidateBand` mempertahankan grup terpilih antar flush. | `bc5be0e` |
| AUD-131 | fixed | Tepi run dan puncak di-clamp ke [startHz, endHz]; parser sesi menerima nilai dalam satu bin dari batas. | `bc5be0e` |
| AUD-132 | fixed | Klik mouse tetap menambah marker dengan snackbar dan Ctrl+Z untuk membatalkan; di layar sentuh tap membaca level, tahan untuk menambah. | `bc5be0e` |
| AUD-133 | fixed | Tanpa service worker tidak ada reload otomatis; handler `controllerchange` hanya reload bila aman. | `bc5be0e` |
| AUD-134 | fixed | Connect Mock SDR hanya muncul di host loopback dengan `?mock=1` dan berlabel MOCK. | `bc5be0e` |
| AUD-135 | fixed | Receiver mengikuti bahasa console (`?lang=` dan event `console-language-change`); hampir semua teks overlay diterjemahkan. Sisa Inggris: label kanvas `VFO n (mute)`, `Amp`, dan locale timestamp. | `bc5be0e`, `2cd42ce` |
| AUD-136 | fixed | `receiver-boot.js` memasang tema dan bahasa sebelum stylesheet dimuat. | `bc5be0e` |
| AUD-137 | fixed | Listener keydown pada window frame Receiver meneruskan 1–9 dan R ke console, kecuali saat mengetik. | `f5c5449` |
| AUD-138 | fixed | Membuka Spectrum saat rekaman berjalan meminta konfirmasi; penghentian karena transisi scan memberi pemberitahuan. | `bc5be0e` |
| AUD-139 | fixed | Upload trace/kandidat di-retry; banner gagal hilang sendiri saat pulih; kandidat yang gagal dikirim ulang; Records menampilkan "(N tidak tersimpan)". | `bc5be0e`, `2cd42ce` |
| AUD-140 | fixed | Records menampilkan sesi yang sedang merekam; tab Listener punya indikator REC. | `bc5be0e` |
| AUD-141 | fixed | Top bar disembunyikan di luar Listener, tombol Refresh tidak melebar, tabel Records menjadi kartu di bawah 600 px. | `bc5be0e` |
| AUD-142 | fixed | Connect Device memeriksa WebUSB dulu dan meminta Chrome/Edge; QUICKSTART menyebut kebutuhan Chromium. | `bc5be0e` |
| AUD-143 | fixed | Dokumen (QUICKSTART, CLAUDE.md, AGENTS.md, initialize.md, workflow) menyatakan minimum Python 3.9 untuk console; impor `zoneinfo` tidak dibuat lazy. | wave 3 (belum di-commit) |
| AUD-144 | fixed | Syarat paho diselaraskan (console start tanpa paho, monitor ERROR); initialize.md menyebut Receiver, `/api/receiver/*`, `/api/mqtt/rdf-node`, `--data-dir`, dan memakai path relatif. | wave 3 (belum di-commit) |
| AUD-145 | fixed | `SDR_DOA_FRONTEND_WORKFLOW.md` ditulis ulang: `.venv` + paho atau `--mqtt-host ''`, tujuh halaman, MapLibre dan WebGL2, host tile bergantian, `npm run build:all`. | wave 3 (belum di-commit) |
| AUD-146 | fixed | Target sentuh diperbesar untuk pointer coarse dan ≤ 639 px (tombol bahasa, modebar Plotly, summary Graph settings); diukur ulang di Playwright Chromium, belum di perangkat sentuh nyata. | wave 3 (belum di-commit) |
| AUD-147 | fixed | `evaluasi GUI.md` punya bagian "Status saat ini" yang menandai GSAP, Leaflet, banner simulasi, event `load`, urutan mobile, dan prioritas tile sebagai superseded; AGENTS.md dan initialize.md menunjuk ke sana. | wave 3 (belum di-commit) |
| AUD-148 | fixed | `test_stage3.py` memakai direktori sementara untuk config, branding, dan data Receiver; store menutup koneksi sqlite (tes regresi ResourceWarning di wave 2). | `bc5be0e`, `2cd42ce` |

### 7.2 Item partial dan sisa pekerjaan

- **AUD-51 (partial).** Monitor MQTT tidak punya username, password, atau TLS. `POST /api/console-config` dan `POST /api/mqtt/connect` belum punya guard Origin same-origin seperti `/api/receiver/*`, sehingga halaman lokal lain bisa mengarahkan monitor ke broker lain. Kredensial sengaja tidak ditambahkan sebelum guard itu ada; ini butuh keputusan keamanan/produk.
- **AUD-29, sisa keputusan produk.** Node tanpa fix GPS tetap menggambar bearing live dari posisi referensi dengan label "REFERENCE ONLY · NOT LIVE GPS". Usulan audit (overlay live di posisi fallback hanya lewat opt-in `Reference preview`, sesuai `MAPLIBRE_DOA_OVERLAY_PLAN.md` §5) belum dikerjakan.
- **AUD-05.** ADC overdrive membatasi tampilan, tetapi SNR dan PAPR hanya ditampilkan. Tidak ada ambang SNR atau confidence sebagai gate. Format XML `ADC_OVERDRIVE` (bool atau bitmask desimal) diparse secara defensif; format lain menjadi null.
- **AUD-18.** Pasangan CSV/XML dari frame bersebelahan tidak dicek silang sudutnya. Sejak wave 3 pasangan seperti itu memblokir publikasi (`NATIVE_ANGLE_UNCHECKED`), tetapi `overall_state` tetap LIVE dan Overview tetap menampilkan bearing.
- **AUD-56.** RX berhenti pada transfer USB pertama yang gagal, termasuk stall sesaat; operator harus menekan Resume. Upstream sebelumnya diam-diam menghentikan loop transfer. Ini pilihan desain yang perlu ditinjau.
- **AUD-135.** Masih berbahasa Inggris: label kanvas `VFO n (mute)` (perlu anchor builder baru), nama checkbox gain `Amp` (dari kapabilitas perangkat), tooltip mode remote (tidak terjangkau karena remote sharing dihapus builder), dan timestamp record yang memakai locale browser.
- **AUD-139.** Bila banner trace sudah diganti error lain sebelum upload pulih, snackbar "saving again" tidak muncul. Entri retry kandidat untuk scan yang berakhir tanpa `finishRecordedScan` tertinggal di memori sampai reload.
- **AUD-03.** Sesi armed yang tidak menerima audio selama 2 menit (misalnya semua VFO di luar band) ditutup console, lalu recorder membuka sesi baru; satu rekaman bisa tampil sebagai beberapa sesi. Browser yang masih memakai service worker Workbox lama menjalankan satu kunjungan terakhir di bawah worker itu, sehingga keepalive saat unload bisa batal pada kunjungan tersebut.
- **AUD-02.** Deteksi node beku butuh minimal dua pembacaan dan mengasumsikan `status.json` ditulis ulang setidaknya setiap 10 s. Di edge agent dengan `--clock-source remote_unverified`, node yang sudah beku sebelum agent start bisa terbaca ONLINE hingga sekitar 10 s.
- **AUD-09.** Bila pembacaan status habis tepat di batas 4 s, snapshot melaporkan `STATUS_UNAVAILABLE_OR_INVALID` dengan error `timed out`, bukan `COLLECTION_DEADLINE_EXCEEDED`.
- **AUD-102.** Di ponsel strip status tetap scroll horizontal (dengan bayangan tepi), tidak membungkus ke dua baris.
- **AUD-143.** Dokumen kini menyatakan Python 3.9 sebagai minimum; impor `zoneinfo` tidak dibuat lazy, jadi Python 3.8 tetap gagal saat start.
- **AUD-67.** `npm run build:all` gagal bila submodule `vendor/BrowSDR` belum diambil; untuk checkout tanpa Receiver, `npm run build` tetap jalur yang benar dan cek Receiver di suite static dilewati.
- **Dependensi baru.** Bundle Plotly parsial menambah pohon dependensi (termasuk `es5-ext` dengan postinstall yang hanya mencetak pesan; dilewati oleh `npm ci --ignore-scripts`). Bila `plotly.js` dinaikkan versinya, periksa ulang `plotly.js/lib/core`, `lib/scatterpolar`, dan stub CSS MapLibre di `vite.config.ts`.
- **Di luar temuan.** RDF Node v2 tidak punya spesifikasi di repo; penanganan retained clear v2 (UNAVAILABLE, `RETAINED_CLEARED`) di wave 3 adalah interpretasi. Legacy UI (`--legacy-ui`) hanya diperbarui sebatas monitor MQTT dan timeout/expiry. `tools/test_sdr_doa_security_regressions.py` masih menulis ke `/tmp/sdr-doa-security-test*`.

### 7.3 Batas verifikasi perbaikan

- **Hardware tidak tersedia.** Tidak ada Raspberry Pi, KrakenSDR, atau HackRF. Konvensi sudut (θ₀ berlawanan jarum jam, peak bin = θ₀ untuk `ANGULAR_PEAK_ANGLE_MISMATCH`) diambil dari source upstream `krakenrf/krakensdr_doa`, bukan dari node nyata. Deteksi lepasnya HackRF, error transfer USB, koreksi DC, dan deteksi sweep diuji dengan Mock SDR, tes Node, dan noise sintetis; floor HackRF nyata yang berubah per tuning bisa menaikkan konfirmasi palsu.
- **MQTT.** Tidak ada broker produksi dan mosquitto tidak terpasang di lingkungan perbaikan. Pengujian memakai broker uji buatan sendiri. `tools/test_sdr_doa_mqtt_stdlib.py` membutuhkan broker di `127.0.0.1:18884` dan tidak dijalankan.
- **Platform.** Tidak ada host Windows: perbaikan `npm.cmd` (AUD-68) diuji dengan `shutil.which` yang di-mock, dan fallback zona waktu tanpa `tzdata` diemulasikan. Browser yang dipakai hanya Chromium headless dengan WebGL SwiftShader; Firefox, Safari, GPU nyata, perangkat sentuh, dan screen reader tidak diuji. Throttling timer di frame Receiver yang tersembunyi hanya diamati di Chromium headless.
- **Basemap.** Tile OSM tidak terjangkau dari sandbox, sehingga perpindahan host tile hanya diuji dengan tile tiruan dan host yang diblokir.
- **Build.** Agen perbaikan tidak menjalankan `npm run build` ke `frontend/dist` (aturan kerja); pemeriksaan browser memakai build di direktori scratch. `frontend/dist/receiver` dibangun ulang oleh agen Receiver wave 2. Bundle console di `frontend/dist` harus dibangun ulang dengan `npm run build:all` sebelum dipakai.
- **Durasi.** Tidak ada soak multi-jam setelah perbaikan.

### 7.4 Hasil tes saat dokumen ini ditulis

Dijalankan 2026-10-13 pada working tree (wave 1, wave 2, dan perubahan wave 3):

- `cd frontend && npx vitest run`: 26 file, 310 tes lulus; `npm run check` lulus.
- `PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest discover -s tools -p 'test_*.py'`: 125 tes, OK.
- `node --test tools/test_receiver_*.mjs`: 37 tes lulus.
- `git diff --check`: bersih.

- Script standalone: `test_sdr_doa_collector.py` 33, `test_stage3.py` 25, `test_sdr_doa_lan_agent.py` 20, `test_sdr_doa_lan_agent_hardening.py` 7, `test_sdr_doa_mqtt.py` 8, `test_sdr_doa_config_apply.py` 4 tes lulus.

Tidak dijalankan saat dokumen ini ditulis: `tools/test_sdr_doa_mqtt_stdlib.py` (butuh broker `127.0.0.1:18884`) dan `tools/test_sdr_doa_security_regressions.py` (menulis ke `/tmp` di luar direktori kerja; dijalankan oleh paket wave 3 backend).
