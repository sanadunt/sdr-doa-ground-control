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

`paho-mqtt==2.1.0` diperlukan untuk monitor MQTT lokal default, synthetic publisher, dan test MQTT. Install ke virtual environment yang sama dengan Ground Console:

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

`paho-mqtt==2.1.0` diperlukan untuk monitor MQTT lokal default. Install ke virtual environment yang sama dengan Ground Console:

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

MQTT tidak diperlukan untuk Overview atau simulasi. Ground Console memakai satu koneksi subscriber-only ke broker yang dikonfigurasi; koneksi itu membaca topic v1 dan RDF Node v2 sekaligus. `paho-mqtt` diperlukan untuk monitor MQTT; synthetic publisher juga memerlukan broker lokal.

Konfigurasi broker staging:

```text
tools/mqtt_stage4.conf
```

The staging broker pada `tools/mqtt_stage4.conf` menyediakan MQTT/TCP di `127.0.0.1:18884`, bukan default Ground Console. Untuk mengujinya, jalankan Ground Console seperti biasa, lalu di **Configuration → Connection** set host `127.0.0.1`, port `18884`, dan transport **TCP**. Simpan untuk mengalihkan satu monitor subscriber-only ke broker staging.

Koneksi MQTT Ground Console default memakai `10.90.0.1:9001`, WebSocket, path `/mqtt`. Nilai tersimpan tetap dipakai; field yang belum ada memakai default tersebut. Host menerima literal IPv4/IPv6 apa pun atau `localhost`, bukan nama DNS; masukkan IPv6 tanpa kurung siku. Ground melakukan koneksi keluar ke alamat ini. Ground Console sendiri tetap bind loopback.

Monitor memakai MQTTv5 dan satu konfigurasi broker bersama: host, port, transport, dan WebSocket path berlaku untuk kedua keluarga topic. Filter v1 tetap `sdr/v1/uav-01/#`. RDF Node v2 memakai prefix `sdr/v2/{rdf_node_id}/`; atur **RDF Node v2 ID** di **Configuration → Connection** (default `uav-01`, satu topic segment `[A-Za-z0-9_-]{1,64}`). Pengaturan ini hanya mengubah prefix v2; filter v1 tidak berubah.

Dengan ID default, subscriber membaca tepat 12 suffix v2: `telemetry/doa`, `telemetry/diagnostic/doa`, `telemetry/diagnostic/angular`, `telemetry/health`, `telemetry/health/detail`, `telemetry/angular`, `state`, `capabilities`, `config/reported`, `availability`, `ack/config`, dan `ack/operation`. Status `READY` menunggu SUBACK berhasil untuk seluruh filter bersama. Parser dan snapshot v1/v2 tetap terpisah agar validasi satu schema tidak mengubah statistik schema lain.

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

Subscriber RDF Node v2 hanya membaca dua belas filter di atas. Ground Console tidak publish MQTT, tidak mengirim command atau receipt, dan tidak mengubah setting Edge. Endpoint same-origin `GET /api/mqtt/rdf-node` menyajikan snapshot topik; `GET /api/v2/angular/diagnostic/latest` menyajikan status kandidat Angular diagnostik yang terpisah dan read-only.

Di **Message monitor**, `READY` berarti seluruh SUBACK untuk filter bersama berhasil, bukan DAQ sehat. Status availability adalah petunjuk koneksi Control, bukan health. DoA dan Angular live hanya ditandai current bila freshness, DAQ, sesi, dan revision lolos gate. Diagnostic DoA dan Angular ditampilkan terpisah dengan trust `UNVERIFIED`; freshness tidak berarti terverifikasi dan keduanya tidak mengubah DoA/Angular canonical, readiness, atau history. Diagnostic DoA current hanya dengan receive age ≤ 3 s dan source age ≤ 5 s; diagnostic Angular memerlukan receive age ≤ 3 s, source age ≤ 10 s, dan flag bit 1. Untuk menerima Angular live, atur `require_ground_receipt_for_bulk=false` secara terpisah pada Edge. MQTT v2 tidak mengubah HTTP Data Out, publication gate, atau simulasi Overview.

System Health menyediakan daftar **MQTT topic payloads** yang tertutup secara default untuk 12 topic. Tiap baris menampilkan status topic, timestamp penerimaan, umur relatif dalam detik, menit, jam, atau hari, serta field yang dapat dibuka; koneksi broker dan umur update MQTT terbaru ditampilkan terpisah. Pesan berstatus `INVALID` dengan objek JSON yang dapat diparse dalam batas ukuran tersedia sebagai `candidate_payload` display-only, diproyeksikan melalui allowlist topic dengan redaksi kredensial ACK yang sudah berlaku. Statusnya tetap `INVALID`, diberi label oranye `UNVERIFIED`, dan tidak pernah menjadi telemetry canonical atau bukti readiness. Message Monitor juga menampilkan candidate invalid. Pesan malformed, oversized, non-object, dan binary hanya menampilkan waktu penerimaan serta error parser. Timestamp mengukur waktu penerimaan/freshness, bukan autentisitas.

Broker TLS, PPP/T900, dan MQTT production tidak disiapkan oleh quickstart ini. Contoh payload dan fixture lokal bersifat sintetis dan tidak membuktikan kompatibilitas Raspberry atau broker production maupun acceptance hardware.


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

### BrowSDR build menolak perubahan lokal

Periksa perubahan sebelum memilih cara build:

```sh
git -C vendor/BrowSDR status --short
```

Pemeriksaan ini sengaja menjaga bundle tetap reproducible: checkout harus bersih dan `HEAD` harus sama dengan `BROWSDR_REVISION` di `tools/build_browsdr_receiver.py`. Untuk membangun perubahan lokal tanpa mengubah atau membuang checkout, salin source ke direktori sementara tanpa metadata Git lalu jalankan builder dengan `--source`.

macOS/Linux, dari root repository:

```sh
.venv/bin/python - <<'PY'
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ignore = shutil.ignore_patterns(
    ".git", ".wrangler", ".vscode", "AGENTS.md", "__pycache__", "dist", "node_modules"
)
with tempfile.TemporaryDirectory(prefix="browsdr-local-build-") as temporary:
    source = Path(temporary) / "BrowSDR"
    shutil.copytree(Path("vendor/BrowSDR"), source, ignore=ignore)
    subprocess.run(
        [sys.executable, "tools/build_browsdr_receiver.py", "--source", str(source)],
        check=True,
    )
PY
```

PowerShell, dari root repository:

```powershell
@'
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ignore = shutil.ignore_patterns(
    ".git", ".wrangler", ".vscode", "AGENTS.md", "__pycache__", "dist", "node_modules"
)
with tempfile.TemporaryDirectory(prefix="browsdr-local-build-") as temporary:
    source = Path(temporary) / "BrowSDR"
    shutil.copytree(Path("vendor/BrowSDR"), source, ignore=ignore)
    subprocess.run(
        [sys.executable, "tools/build_browsdr_receiver.py", "--source", str(source)],
        check=True,
    )
'@ | .\.venv\Scripts\python.exe -
```

Untuk menjadikan perubahan itu build standar yang dapat direproduksi, review dan commit perubahan di submodule, perbarui `BROWSDR_REVISION` ke commit tersebut, lalu commit gitlink submodule di repository utama. Jangan memakai `git reset --hard` atau menghapus perubahan yang belum direview.

### Data Out unavailable

Untuk Overview, DoA Diagnostics, dan route lain yang memakai Data Out, status ini tidak selalu berarti frontend rusak. Periksa DNS atau koneksi ke `doasdr.local:8081`, gunakan alamat Data Out yang diizinkan, dan lihat status `STALE`, `UNAVAILABLE`, atau `ERROR` di UI. Gunakan tab `Simulasi` untuk memeriksa renderer tanpa hardware.

System Health menampilkan pemeriksaan lokal yang terpisah: USB hanya diperiksa pada host Ground Console dan dicocokkan dengan VID:PID `1a86:7523`; status PPP mengacu ke interface lokal `ppp0`. Saat halaman System Health terbuka dan `ppp0` berstatus up, Ground Console mengirim paling banyak satu ICMP echo ke Raspberry `10.90.0.2` setiap lima detik. `NO_REPLY` berarti tidak ada balasan ICMP, bukan bukti Raspberry offline; ping yang berhasil pun tidak membuktikan Data Out atau telemetry sehat. Pemeriksaan lokal ini tetap terpisah dari indikator Edge.

Blok **Telemetry & processing** pada System Health hanya memakai snapshot monitor MQTT v2 Ground Console, bukan Data Out HTTP atau freshness Data Out. Status tiap topic tetap terpisah dari koneksi broker: `READY` tidak membuat topic stale menjadi sehat. Ringkasan Edge menampilkan run state, source age, temperatur, DAQ, dropped frames, Edge clock, dan sync; subgroup Edge health detail memisahkan USB, tiga flag sync berurutan, CPU/memory/free disk, throttle/undervoltage, TX/RX, acquisition drops, dan parse errors dari pemeriksaan USB/PPP/peer host Ground. DoA canonical tetap memakai `telemetry/doa`. Diagnostic DoA/Angular ditampilkan terpisah sebagai `UNVERIFIED`, dengan freshness dan umur receive/source terpisah; diagnostic tidak mengubah live DoA/Angular, readiness, atau history. Kontrak MQTT saat ini tidak menyediakan GPS status, CSV/XML source, atau DAQ frame index; indikator tersebut tetap `NOT PROVIDED`.

System Health memisahkan indikator Edge dan diagnostic dari pemeriksaan lokal serta menampilkan waktu pemeriksaan lokal pada `Last checked`. Jika pemeriksaan lokal gagal, waktu pemeriksaan sukses terakhir tetap ditampilkan dan kegagalan itu tidak disimpan sebagai pemeriksaan berhasil. Riwayat otomatis disimpan hanya di `localStorage` browser pada origin lokal yang digunakan, satu catatan per timestamp probe unik; riwayat MQTT v2 dibatasi 2.000 catatan. Catatan v1 tetap dibaca tanpa ditulis ulang dan ditampilkan sebagai `Legacy Data Out`. Catatan baru v2 memakai source `mqtt-v2` dan hanya menyimpan status ringkas yang ditampilkan serta hasil probe lokal, bukan payload/topic MQTT mentah. Panel riwayat menampilkan 20 terbaru; `Export CSV` mengunduh seluruh riwayat dengan kolom source, sedangkan `Clear history` menghapus kedua versi setelah konfirmasi. CSV memisahkan waktu capture dari waktu probe lokal.

### Basemap OSM tidak tampil

MapLibre membutuhkan koneksi HTTPS ke tile OSM dan CSP yang sesuai. Kegagalan tile tidak otomatis berarti geometry overlay atau polar plot gagal.

### Keamanan lokal

Tetap gunakan `--bind 127.0.0.1`. Jangan memakai `0.0.0.0` untuk quickstart, jangan memasukkan secret ke frontend, dan jangan menganggap config dry-run sebagai command nyata ke Raspberry.
