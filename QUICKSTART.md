# SDR-DoA Ground Console Quickstart

Panduan ini menjalankan Ground Console lokal dari checkout repository. Jalur production lokal memakai Python untuk menyajikan `frontend/dist` dan menyediakan API same-origin. Vite hanya dipakai untuk development/build.

## Prasyarat

Install terlebih dahulu:

- Git.
- Node.js LTS. Dokumentasi project merekomendasikan Node 22.12 atau lebih baru dalam lini Node 22. Vite saat ini membutuhkan Node `^20.19.0` atau `>=22.12.0`.
- Python 3.x. Repository belum mem-pin versi Python dan sebagian besar tools memakai standard library.
- Akses jaringan ke tile OpenStreetMap jika ingin basemap peta tampil.
- Mosquitto lokal hanya jika ingin menguji MQTT staging.

Buka terminal di root repository sebelum menjalankan perintah berikut.

## macOS dan Linux

### 1. Buat environment Python

```sh
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
```

`paho-mqtt` hanya diperlukan untuk MQTT monitor, synthetic publisher, atau test MQTT. Install jika fitur tersebut diperlukan:

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

Install dependency MQTT hanya jika diperlukan:

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
5. Buka `Overview`.
6. Periksa map direction helper dan kurva polar synthetic.

Mode simulasi hanya mengganti data Overview. Health, diagnostics, MQTT, dan publication gate tetap menggunakan sumber nyata atau tetap `BLOCKED`.

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

MQTT tidak diperlukan untuk menjalankan Overview atau simulasi. Untuk monitor synthetic, diperlukan broker lokal dan `paho-mqtt`.

Konfigurasi staging yang tersedia:

```text
tools/mqtt_stage4.conf
```

Konfigurasi tersebut ditujukan untuk broker loopback pada `127.0.0.1:18884`, bukan deployment production. Setelah broker berjalan, Ground Console dapat dijalankan dengan:

```sh
.venv/bin/python tools/ground_console.py \
  --mqtt-host 127.0.0.1 \
  --mqtt-port 18884 \
  --bind 127.0.0.1 \
  --port 8787
```

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

Broker, PPP/T900, dan MQTT production tidak disiapkan oleh quickstart ini.

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

MapLibre membutuhkan koneksi HTTPS ke tile OSM dan CSP yang sesuai. Kegagalan tile tidak otomatis berarti geometry overlay atau polar plot gagal.

### Keamanan lokal

Tetap gunakan `--bind 127.0.0.1`. Jangan memakai `0.0.0.0` untuk quickstart, jangan memasukkan secret ke frontend, dan jangan menganggap config dry-run sebagai command nyata ke Raspberry.
