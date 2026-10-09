# SDR-DoA Ground Console Quickstart

Panduan ini menjalankan Ground Console lokal dari checkout repository. Jalur production lokal memakai Python untuk menyajikan `frontend/dist` dan menyediakan API same-origin. Vite hanya dipakai untuk development/build.

## Prasyarat

Install terlebih dahulu:

- Git.
- Node.js LTS. Dokumentasi project merekomendasikan Node 22.12 atau lebih baru dalam lini Node 22. Vite saat ini membutuhkan Node `^20.19.0` atau `>=22.12.0`.
- Python 3.x untuk Ground Console; Python 3.9+ jika memakai Receiver karena filter waktu audio menggunakan `zoneinfo`.
- Akses jaringan ke tile OpenStreetMap jika ingin basemap peta tampil.
- Mosquitto lokal hanya jika ingin menguji MQTT staging.

Buka terminal di root repository sebelum menjalankan perintah berikut.

## macOS dan Linux

### 1. Buat environment Python

```sh
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
```

Perintah Ground Console default di bawah mengaktifkan monitor MQTT (`10.90.0.1:9001`), sehingga `paho-mqtt` harus diinstal sebelum server dijalankan meskipun broker belum tersedia. Untuk menjalankan tanpa monitor di instalasi baru, gunakan `--mqtt-host ''`; konfigurasi koneksi yang sudah tersimpan tetap mengalahkan nilai CLI.

```sh
.venv/bin/python -m pip install 'paho-mqtt==2.1.0'
```

Opsional, buat file environment lokal untuk admin branding/config:

```sh
cp .env.example .env
```

Edit `.env` dan ganti `SDR_DOA_ADMIN_PASSWORD` jika login admin lokal diperlukan. Jangan commit `.env`.

### 2. Install dan build frontend

```sh
cd frontend
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run build
cd ..
```

Build menghasilkan `frontend/dist`. Folder ini adalah output generated, bukan tempat mengedit source.

### Receiver embedded (opsional)

Untuk clone baru, sertakan submodule dengan opsi `--recurse-submodules` pada `git clone`. Untuk checkout yang sudah ada, jalankan dari root repository:

```sh
git submodule update --init --recursive
.venv/bin/python tools/build_browsdr_receiver.py
```

Jalankan builder Receiver setelah `npm run build`; output Receiver berada di `frontend/dist/receiver`. Setelah Ground Console aktif, pilih menu **Monobs**, tepat di bawah Dashboard (atau buka `http://127.0.0.1:8787/#/receiver`). Receiver juga tetap dapat dibuka langsung di `http://127.0.0.1:8787/receiver/`.

Sesudah memperbarui Receiver, muat ulang halaman Receiver agar worker dan WASM dari build yang sama dipakai. Jika browser masih memuat bundle lama, bersihkan service worker/cache untuk origin Ground Console yang sedang digunakan (misalnya `localhost:8787`, bukan `127.0.0.1:8787`) lalu buka ulang halaman; origin yang berbeda juga memerlukan izin WebUSB tersendiri.

Mutasi `/api/receiver/*` memerlukan header `Origin` same-origin yang cocok dengan host dan port loopback; tanpa header itu atau dari origin lain, server mengembalikan HTTP 403.

### 3. Jalankan Ground Console

```sh
.venv/bin/python tools/ground_console.py --bind 127.0.0.1 --port 8787
```

Buka:

```text
http://127.0.0.1:8787/
```

Hentikan server dengan `Ctrl+C`.

## Windows

Gunakan PowerShell atau Command Prompt. Perintah di bawah menghindari aktivasi virtualenv, sehingga tidak bergantung pada Execution Policy PowerShell.

### 1. Buat environment Python

PowerShell:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
```

Command Prompt:

```bat
py -3 -m venv .venv
.venv\Scripts\python.exe -m pip install --upgrade pip
```

Perintah Ground Console default di bawah mengaktifkan monitor MQTT (`10.90.0.1:9001`), sehingga `paho-mqtt` harus diinstal sebelum server dijalankan meskipun broker belum tersedia:

PowerShell:

```powershell
.\.venv\Scripts\python.exe -m pip install paho-mqtt==2.1.0
```

Command Prompt:

```bat
.venv\Scripts\python.exe -m pip install paho-mqtt==2.1.0
```

Opsional, buat file environment lokal:

PowerShell:

```powershell
Copy-Item .env.example .env
```

Command Prompt:

```bat
copy .env.example .env
```

Edit `.env` dan ganti `SDR_DOA_ADMIN_PASSWORD` jika login admin lokal diperlukan. Jangan commit `.env`.

### 2. Install dan build frontend

Perintah npm sama di PowerShell dan Command Prompt:

```text
cd frontend
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run build
cd ..
```

Build menghasilkan `frontend\dist`.

### Receiver embedded (opsional)

Untuk clone baru, sertakan submodule dengan opsi `--recurse-submodules` pada `git clone`. Untuk checkout yang sudah ada, jalankan dari root repository:

```powershell
git submodule update --init --recursive
.\.venv\Scripts\python.exe tools\build_browsdr_receiver.py
```

Jalankan builder Receiver setelah `npm run build`; output Receiver berada di `frontend\dist\receiver`. Setelah Ground Console aktif, pilih menu **Monobs**, tepat di bawah Dashboard (atau buka `http://127.0.0.1:8787/#/receiver`). Receiver juga tetap dapat dibuka langsung di `http://127.0.0.1:8787/receiver/`.

Sesudah memperbarui Receiver, muat ulang halaman Receiver agar worker dan WASM dari build yang sama dipakai. Jika browser masih memuat bundle lama, bersihkan service worker/cache untuk origin Ground Console yang sedang digunakan (misalnya `localhost:8787`, bukan `127.0.0.1:8787`) lalu buka ulang halaman; origin yang berbeda juga memerlukan izin WebUSB tersendiri.

Mutasi `/api/receiver/*` memerlukan header `Origin` same-origin yang cocok dengan host dan port loopback; tanpa header itu atau dari origin lain, server mengembalikan HTTP 403.

### 3. Jalankan Ground Console

PowerShell:

```powershell
.\.venv\Scripts\python.exe tools\ground_console.py --bind 127.0.0.1 --port 8787
```

Command Prompt:

```bat
.venv\Scripts\python.exe tools\ground_console.py --bind 127.0.0.1 --port 8787
```

Buka:

```text
http://127.0.0.1:8787/
```

Hentikan server dengan `Ctrl+C`.

## Menjalankan tanpa perangkat SDR

Ground Console tetap dapat digunakan untuk memeriksa UI tanpa Raspberry atau Data Out live:

1. Buka tab `Simulasi`.
2. Aktifkan `SIMULATION`.
3. Atur latitude, longitude, sudut DoA, dan lebar lobe.
4. Klik `Terapkan skenario`.
5. Buka `Dashboard`.
6. Periksa map direction helper dan kurva polar synthetic.

Mode simulasi hanya mengganti data Dashboard. Health, diagnostics, MQTT, dan publication gate tetap menggunakan sumber nyata atau tetap `BLOCKED`.

## Peta dasar dan peta offline (MBTiles)

Dashboard menampilkan peta penuh. Grafik DoA mengambang di atas peta dan bisa disembunyikan atau ditampilkan lagi lewat tombol `Grafik DoA` di toolbar peta (pilihan ini diingat browser).

Tombol peta dasar di toolbar memberi pilihan:

- **OSM Normal**, **OSM Terang**, **OSM Gelap**: tile OpenStreetMap standar. Versi terang dan gelap hanya diwarnai ulang di browser, tanpa penyedia tambahan.
- **OSM HOT**: gaya Humanitarian OpenStreetMap Team dari server OpenStreetMap France.
- **Satelit (Esri)**: Esri World Imagery. Periksa syarat penggunaan Esri sebelum dipakai secara operasional.
- **Luring (MBTiles)**: file `.mbtiles` raster (PNG, JPEG, atau WebP) dari komputer Ground Console sendiri, tanpa internet.

Untuk peta offline, salin file `.mbtiles` ke folder `tiles` di dalam direktori data Ground Console. Defaultnya `~/.local/share/sdr-doa-ground-console/tiles`, atau `<--data-dir>/tiles` bila `--data-dir` dipakai. Folder dibuat otomatis dan lokasinya dicetak saat console start. File di lokasi lain bisa ditambahkan dengan `--mbtiles PATH` (boleh diulang). Buka lagi menu peta dasar setelah menyalin file agar daftar diperbarui. MBTiles vektor (`pbf`) tidak didukung karena butuh style dan font yang tidak dibawa console.

## Menghubungkan Data Out live

Ground Console default memakai:

```text
http://doasdr.local:8081
```

Jika alamat Data Out berbeda, jalankan dengan host yang diizinkan collector, misalnya:

```sh
.venv/bin/python tools/ground_console.py \
  --base-url http://192.168.100.100:8081 \
  --bind 127.0.0.1 \
  --port 8787
```

Windows PowerShell:

```powershell
.\.venv\Scripts\python.exe tools\ground_console.py --base-url http://192.168.100.100:8081 --bind 127.0.0.1 --port 8787
```

Host Data Out harus lolos allowlist collector dan port harus `8081`. Collector tetap read-only dan hanya memakai HTTP GET.

## MQTT staging, opsional

MQTT tidak diperlukan untuk Dashboard atau simulasi. Ground Console memakai satu koneksi subscriber-only ke broker yang dikonfigurasi; koneksi itu membaca topic v1 dan RDF Node v2 sekaligus. `paho-mqtt` diperlukan untuk monitor MQTT; synthetic publisher juga memerlukan broker lokal.

Host broker menerima literal IPv4/IPv6 apa pun atau `localhost`; nama DNS ditolak. Masukkan IPv6 tanpa kurung siku. Ground Console membuka koneksi keluar ke broker, tetapi HTTP Ground Console tetap bind ke loopback. MQTT v1 tidak memakai TLS, sehingga payload melintas tanpa enkripsi; gunakan hanya broker dan jaringan tepercaya.

Konfigurasi staging yang tersedia:

```text
tools/mqtt_stage4.conf
```

Broker staging tersebut menggunakan MQTT/TCP di `127.0.0.1:18884`, bukan WebSocket default. Pada konfigurasi baru, jalankan Ground Console dengan transport TCP dan file konfigurasi staging terpisah:

Koneksi MQTT Ground Console default memakai `10.90.0.1:9001`, WebSocket, path `/mqtt`. Nilai tersimpan tetap dipakai; field yang belum ada memakai default tersebut. Host menerima literal IPv4/IPv6 apa pun atau `localhost`, bukan nama DNS; masukkan IPv6 tanpa kurung siku. Ground melakukan koneksi keluar ke alamat ini. Ground Console sendiri tetap bind loopback.

Monitor memakai MQTTv5 dan satu konfigurasi broker bersama: host, port, transport, dan WebSocket path berlaku untuk kedua keluarga topic. Filter v1 adalah `sdr/v1/uav-01/#`; RDF Node v2 memakai prefix `sdr/v2/uav-01/` dan sepuluh suffix: `telemetry/doa`, `telemetry/health`, `telemetry/health/detail`, `telemetry/angular`, `state`, `capabilities`, `config/reported`, `availability`, `ack/config`, dan `ack/operation`. Status `READY` menunggu SUBACK berhasil untuk seluruh filter bersama. Parser dan snapshot v1/v2 tetap terpisah agar validasi satu schema tidak mengubah statistik schema lain.

MQTT tidak mengonfigurasi TLS untuk TCP maupun WebSocket, sehingga payload melintas tanpa enkripsi. Gunakan hanya broker dan jaringan tepercaya; jangan kirim payload rahasia melalui koneksi ini.

Konfigurasi lama `rdf_node_mqtt` tidak digunakan atau dimigrasikan; field itu hilang saat konfigurasi disimpan berikutnya. Atur endpoint kedua keluarga topic melalui **Configuration → Connection**.

Synthetic publisher:

```sh
.venv/bin/python tools/synthetic_mqtt_publisher.py \
  --host 127.0.0.1 \
  --port 18884 \
  --duration 5 \
  --doa-rate 2 \
  --nav-rate 1 \
  --health-rate 1
```

Di Windows, ganti prefix Python menjadi `.\.venv\Scripts\python.exe`:

```powershell
.\.venv\Scripts\python.exe tools\synthetic_mqtt_publisher.py --host 127.0.0.1 --port 18884 --duration 5 --doa-rate 2 --nav-rate 1 --health-rate 1
```

### RDF Node v2 telemetry

Pastikan `paho-mqtt==2.1.0` terpasang di virtual environment yang sama dengan Ground Console; instruksi pemasangan ada di bagian atas halaman ini. Jika dependency tidak tersedia, status monitor melaporkan error tanpa mematikan Ground Console.

Subscriber hanya membaca sepuluh filter v2 di atas. Ground tidak publish, tidak mengirim command, dan tidak mengubah setting Edge. Endpoint browser v2 hanya `GET /api/mqtt/rdf-node`; panel v1 dan v2 menampilkan snapshot schema masing-masing dari satu koneksi broker.

Di **Message monitor**, `READY` berarti seluruh SUBACK untuk filter bersama berhasil, bukan DAQ sehat. Status availability adalah petunjuk koneksi Control, bukan health. DoA dan Angular hanya ditandai current bila freshness, DAQ, sesi, dan revision lolos gate. Untuk menerima Angular live, atur `require_ground_receipt_for_bulk=false` secara terpisah pada Edge. MQTT v2 tidak mengubah HTTP Data Out, publication gate, atau simulasi Dashboard.

Broker TLS, PPP/T900, dan MQTT production tidak disiapkan oleh quickstart ini. Contoh payload dan fixture lokal bukan bukti kompatibilitas perangkat atau acceptance hardware.


## Validasi setelah install

Frontend:

```sh
cd frontend
npm run check
npm test
npm run build
cd ..
```

Backend static/security:

macOS/Linux:

```sh
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest tools.test_ground_console_static
python3 tools/test_sdr_doa_collector.py
python3 tools/test_stage3.py
```

Windows PowerShell:

```powershell
$env:PYTHONDONTWRITEBYTECODE = "1"
.\.venv\Scripts\python.exe -m unittest tools.test_ground_console_static
.\.venv\Scripts\python.exe tools\test_sdr_doa_collector.py
.\.venv\Scripts\python.exe tools\test_stage3.py
```

`unittest discover` tidak menjalankan semua test Python karena banyak file test memakai fungsi `test_*` dan runner standalone. Jalankan script yang relevan ketika mengubah modul tertentu.

## Troubleshooting singkat

### `ModuleNotFoundError: No module named 'paho'`

Install `paho-mqtt` ke `.venv` yang sama dengan Python server. Jangan mengandalkan Python system/Homebrew.

### UI tidak muncul atau `frontend/dist/index.html` tidak ada

Jalankan `npm run build` dari `frontend/`, lalu restart Ground Console.

### Vite atau npm menolak versi Node

Periksa:

```sh
node --version
npm --version
```

Gunakan Node LTS yang memenuhi requirement Vite. Node 22.12+ direkomendasikan oleh workflow project.

### Data Out unavailable

Ini tidak selalu berarti frontend rusak. Periksa DNS atau koneksi ke `doasdr.local:8081`, gunakan alamat Data Out yang diizinkan, dan lihat status `STALE`, `UNAVAILABLE`, atau `ERROR` di UI. Gunakan tab `Simulasi` untuk memeriksa renderer tanpa hardware.

### Basemap OSM tidak tampil

MapLibre membutuhkan koneksi HTTPS ke host tile dan CSP yang sesuai (`BASEMAP_TILE_HOSTS` di `tools/ground_console.py`). Kegagalan tile tidak otomatis berarti geometry overlay atau polar plot gagal. Tanpa internet, pilih peta dasar `Luring (MBTiles)`.

### Keamanan lokal

Tetap gunakan `--bind 127.0.0.1`. Jangan memakai `0.0.0.0` untuk quickstart, jangan memasukkan secret ke frontend, dan jangan menganggap config dry-run sebagai command nyata ke Raspberry.
