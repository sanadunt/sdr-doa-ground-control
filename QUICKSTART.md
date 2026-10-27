# SDR-DoA Ground Console Quickstart

Panduan ini menjalankan Ground Console lokal dari checkout repository. Jalur production lokal memakai Python untuk menyajikan `frontend/dist` dan menyediakan API same-origin. Vite hanya dipakai untuk development/build.

Untuk ground station Linux yang hanya ingin memakai console (tanpa build, jalan di background, hidup lagi setelah reboot), lihat [Instalasi Linux: Docker, rilis tar dan service](#instalasi-linux-docker-rilis-tar-dan-service). Agent di RDF-SDR (Raspberry) ada di [Agent RDF-SDR](#agent-rdf-sdr-raspberry).

Di UI, node Raspberry tampil sebagai **RDF-SDR** dan receiver HackRF sebagai **RadioSpectrum**. Panduan ini memakai nama UI tersebut; perintah, nama file, field API, dan topik MQTT tetap memakai nama teknisnya.

## Prasyarat

Install terlebih dahulu:

- Git.
- Node.js LTS. Dokumentasi project merekomendasikan Node 22.12 atau lebih baru dalam lini Node 22. Vite saat ini membutuhkan Node `^20.19.0` atau `>=22.12.0`. Tes Node untuk Receiver (`tools/test_receiver_*.mjs`) membutuhkan Node 22.13 atau lebih baru.
- Python 3.9 atau lebih baru. Ground Console mengimpor `zoneinfo` saat start (lewat store Receiver), sehingga Python 3.8 langsung berhenti dengan `ModuleNotFoundError: No module named 'zoneinfo'`.
- Browser berbasis Chromium (Chrome atau Edge) bila memakai Receiver dengan RadioSpectrum, karena RadioSpectrum tersambung lewat WebUSB.
- WebGL2 di browser untuk peta. Tanpa WebGL2 peta menampilkan pemberitahuan dan overlay kanvas sederhana; halaman lain tetap berjalan.
- Akses HTTPS dari komputer console ke penyedia tile jika ingin basemap tampil (host-nya tetap, di `tools/tile_cache.py`). Browser tidak menghubungi penyedia tile; console mengambil dan menyimpan tile, sehingga area yang pernah tampil tetap terlihat saat offline.
- Mosquitto lokal hanya jika ingin menguji MQTT staging.

Buka terminal di root repository sebelum menjalankan perintah berikut.

## macOS dan Linux

### 1. Buat environment Python

```sh
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
```

Perintah Ground Console default mengaktifkan monitor MQTT ke `10.90.0.1:9001` (WebSocket). Tanpa `paho-mqtt`, Ground Console tetap berjalan, mencetak `MQTT monitor unavailable: MQTT monitor dependency paho-mqtt is not installed`, dan monitor MQTT berstatus ERROR. Pasang paket ini bila monitor MQTT dipakai:

```sh
.venv/bin/python -m pip install 'paho-mqtt==2.1.0'
```

Untuk menjalankan tanpa monitor, tambahkan `--mqtt-host ''` pada perintah Ground Console.

Atur kata sandi admin sendiri. Login admin membuka branding di **Konfigurasi** dan panel **Kontrol** di Dashboard, yang mengirim perubahan konfigurasi ke RDF-SDR. Buat file environment lokal:

```sh
cp .env.example .env
```

Edit `.env` dan ganti nilai contoh `SDR_DOA_ADMIN_PASSWORD` dengan kata sandi Anda. Jangan commit `.env`. Aturannya:

- Bila `SDR_DOA_ADMIN_PASSWORD` tidak ada di environment proses maupun di `.env`, console memakai kata sandi bawaan `123456`. Saat start, console mencetak `Warning: the default admin password is in use`, dan Kontrol menampilkan peringatan. Jangan biarkan kata sandi bawaan di komputer yang dipakai bersama.
- Bila variabel ada tetapi kosong (`SDR_DOA_ADMIN_PASSWORD=`), login admin nonaktif: panel admin di **Konfigurasi** menampilkan DISABLED dan Kontrol tidak bisa dibuka. `.env` yang ada tetapi tidak bisa dibaca juga menonaktifkan login.
- Environment proses mengalahkan `.env`. Kata sandi baru berlaku setelah console di-restart.
- Setelah 5 login gagal dalam 60 detik, semua login ditolak selama 30 detik.

### 2. Ambil source Receiver (opsional)

Receiver dibangun dari submodule `vendor/BrowSDR`. Untuk clone baru, pakai `git clone --recurse-submodules`. Untuk checkout yang sudah ada:

```sh
git submodule update --init --recursive
```

Lewati langkah ini bila Receiver tidak dipakai.

### 3. Install dan build frontend

```sh
cd frontend
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run build:all
cd ..
```

`npm run build:all` menjalankan `npm run build`, lalu builder Receiver `tools/build_browsdr_receiver.py` (memakai Python dari `.venv` bila ada). Hasilnya `frontend/dist` beserta `frontend/dist/receiver`. Folder ini adalah output generated, bukan tempat mengedit source.

`npm run build` saja mengosongkan seluruh `frontend/dist`, termasuk Receiver. Tanpa submodule, pakai `npm run build`; halaman Receiver lalu menampilkan petunjuk cara membangunnya. Bila Anda menjalankan `npm run build` saja, bangun Receiver lagi sesudahnya dari root repository:

```sh
.venv/bin/python tools/build_browsdr_receiver.py
```

### 4. Jalankan Ground Console

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

Seperti di macOS/Linux, monitor MQTT default membutuhkan `paho-mqtt`; tanpa paket ini console tetap berjalan dengan monitor berstatus ERROR. Python di Windows juga tidak membawa database zona waktu. Kalender dan rentang waktu di **Rekaman** Receiver memakai batas hari dari browser sendiri, jadi tidak bergantung pada `tzdata`; paket ini hanya membuat jam lokal di nama file ZIP mengikuti zona waktu browser lengkap dengan aturan DST.

PowerShell:

```powershell
.\.venv\Scripts\python.exe -m pip install paho-mqtt==2.1.0 tzdata
```

Command Prompt:

```bat
.venv\Scripts\python.exe -m pip install paho-mqtt==2.1.0 tzdata
```

Tanpa `tzdata`, Rekaman tetap bekerja seperti biasa; hanya jam di nama file ZIP yang memakai offset UTC browser saat ini.

Opsional, buat file environment lokal:

PowerShell:

```powershell
Copy-Item .env.example .env
```

Command Prompt:

```bat
copy .env.example .env
```

Edit `.env` dan ganti nilai contoh `SDR_DOA_ADMIN_PASSWORD` dengan kata sandi Anda. Jangan commit `.env`. Aturan kata sandi bawaan `123456` dan nilai kosong sama seperti di macOS dan Linux.

### 2. Ambil source Receiver (opsional)

```text
git submodule update --init --recursive
```

### 3. Install dan build frontend

Perintah npm sama di PowerShell dan Command Prompt:

```text
cd frontend
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run build:all
cd ..
```

Build menghasilkan `frontend\dist` dan `frontend\dist\receiver`. Tanpa submodule, pakai `npm run build`. Builder Receiver mencari `npm` lewat `PATH`, termasuk `npm.cmd`. Jika muncul `BrowSDR build failed: npm was not found on PATH`, pasang Node.js lalu buka terminal baru. Builder juga dapat dijalankan langsung setelah `npm run build`:

```powershell
.\.venv\Scripts\python.exe tools\build_browsdr_receiver.py
```

### 4. Jalankan Ground Console

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

## Setelah `git pull`

`frontend/dist` adalah hasil build dan tidak ikut diperbarui oleh `git pull`. Tanpa build ulang, console tetap menyajikan UI lama (misalnya menu samping, bukan top bar dan dasbor peta). Setelah setiap `git pull`, build ulang lalu restart console, karena kode Python bisa ikut berubah.

macOS dan Linux:

```sh
git submodule update --init --recursive   # bila Receiver dipakai
cd frontend && npm ci && npm run build:all
cd ..
```

Windows (PowerShell atau Command Prompt):

```text
git submodule update --init --recursive
cd frontend
npm ci
npm run build:all
cd ..
```

Tanpa submodule Receiver, ganti `npm run build:all` dengan `npm run build`. Lalu hentikan console yang sedang berjalan (`Ctrl+C`), jalankan lagi seperti di langkah 4, dan muat ulang halaman di browser.

## Receiver embedded

Pilih menu **Receiver** (tombol `2`) atau buka `http://127.0.0.1:8787/#/receiver`. Receiver juga dapat dibuka langsung di `http://127.0.0.1:8787/receiver/`.

- **Browser.** Firefox dan Safari tidak punya WebUSB; di sana **Connect Device** hanya menampilkan pesan bahwa WebUSB tidak tersedia dan meminta Chrome atau Edge.
- **Mock SDR.** Untuk uji tanpa hardware, buka Receiver langsung dengan `?mock=1` dari alamat loopback, misalnya `http://127.0.0.1:8787/receiver/?mock=1`. Dari dalam console, buka `http://127.0.0.1:8787/?mock=1#/receiver` (`?mock=1` ditulis sebelum `#`); halaman Receiver meneruskan `mock=1` ke frame-nya hanya bila host console adalah loopback. Pilih **Connect Mock SDR** (**Sambungkan Mock SDR** dalam bahasa Indonesia). Koneksi mock berlabel `MOCK` (`Radio SDR ON · MOCK (no RF)`, dalam bahasa Indonesia `MOCK (tanpa RF)`, dan `MOCK DEVICE`). Untuk dasbor, buka `http://127.0.0.1:8787/?mock=1#/dashboard` lalu tekan **Mulai** di panel Spektrum.
- **Kapan Receiver dimuat.** Receiver tidak dimuat saat console dibuka, karena memuatnya langsung menyambungkan RadioSpectrum yang sudah diizinkan. Receiver dimuat saat halaman Receiver dibuka pertama kali, atau saat **Mulai** atau **Dengar** ditekan pertama kali di panel Spektrum Dashboard.
- **Tetap berjalan saat pindah halaman.** Setelah Receiver dimuat, pindah ke halaman lain tidak menghentikan RX, scan, atau rekaman. Receiver berjalan tersembunyi sampai halaman console di-reload atau ditutup, dan tetap mengikuti perubahan tema dan bahasa. Reload console menghentikan sesi Receiver; audio yang sudah terekam tetap tersimpan.
- **Rekaman aman saat reload atau crash.** Rekaman dan scan arsip ditutup saat halaman unload bila memungkinkan, atau oleh console setelah 2 menit tanpa aktivitas. Segmen seperti itu berstatus "Interrupted" dan tetap bisa diputar. Upload yang gagal menyimpan audio yang sudah masuk sebagai "Partly saved". Rekaman berlanjut di file atau sesi baru saat batas ukuran tercapai, setelah chunk hilang, atau setelah sample rate/FFT size berubah (ada pemberitahuan). Satu sesi armed yang tidak menerima audio selama 2 menit bisa terpecah menjadi beberapa sesi.
- **Indikator rekaman.** Di **Rekaman**, segmen yang sedang direkam berstatus `REC` dan pindai yang sedang berjalan `SCANNING`; keduanya ikut diperbarui setiap 10 detik selama tab terbuka. Tab Listener menampilkan indikator `REC`, dan Spectrum meminta konfirmasi sebelum menghentikan rekaman yang berjalan.
- **Radio terputus.** Bila RadioSpectrum dicabut, atau transfer USB gagal saat RX, Receiver menghentikan RX dan scan, menutup rekaman yang berjalan (audio yang sudah masuk tetap ada), lalu menampilkan alert. Bila radio masih tersambung, pesannya meminta memeriksa kabel lalu menekan **Resume** atau menyambungkan ulang radio. Gangguan USB sesaat pun menghentikan listening sampai Resume ditekan.
- **Sumber scan.** Sumber scan mengikuti radio yang tersambung. Sumber Simulation selalu menampilkan badge `SIMULATION` dan label di atas grafik. Pengaturan scan diingat antar kunjungan.
- **Deteksi wide scan.** Sinyal lemah (SNR antara Detection SNR dan 16 dB di atas floor) baru masuk daftar setelah terlihat sekitar 6 sweep; sinyal 16 dB atau lebih di atas floor muncul di sweep pertama. Riwayat menyimpan paling banyak 1000 kandidat. Noise floor dan SNR mengacu ke median trace rata-rata, sehingga SNR terbaca sekitar 1,5 dB lebih rendah dari versi sebelumnya. Sinyal wideband (DAB, DVB-T, hingga sekitar 20 MHz) terdeteksi sebagai satu band. Grup puncak hanya menggabungkan kandidat yang band-nya bertumpuk atau bersentuhan.
- **Minimum peak.** Preset sekarang All (default) dan −50 sampai 0 dBFS.
- **Listen.** Listen meng-unmute VFO aktif dan menerapkan Freq Shift: scan menampilkan frekuensi SDR (perangkat), Listener menampilkan frekuensi tampilan.
- **IQ Correction (DC).** Koreksi kini menghapus offset DC pecahan. Pada gain sangat rendah noise floor naik sekitar 0,7–2 dB; matikan koreksi bila itu penting.
- **Waterfall dan arsip** menyimpan level hingga +60 dB. Arsip dan sesi lama tetap terbuka dengan batas 0 dB lamanya.
- **Skala dB Listener.** Tab Listener (Dengar) punya panel **Skala dB**: Auto (bawaan) mengikuti bagian spektrum yang tampil, Manual memakai Minimum dan Maksimum dBFS (−160 s/d 60, selisih minimal 5 dB; berlaku saat Enter atau keluar dari kolom). Skala dipakai trace dan waterfall Listener, diingat bersama pengaturan Receiver, dan sama dengan Skala dB di dock Spektrum Dashboard. Pengaturan Receiver yang tersimpan sebelum panel ini ada terbuka dengan Auto. Waterfall Listener memakai skala baru untuk baris berikutnya; baris yang sudah tergambar tetap.
- **Marker.** Dengan mouse, klik menambah marker dan `Ctrl+Z` (`⌘Z`) menghapus marker terakhir. Di layar sentuh, tap membaca level dan tahan untuk menambah marker. Menyimpan marker set dengan nama yang sudah ada meminta konfirmasi sebelum mengganti. Daftar **Penanda spektrum** juga tampil di trace tab **Dengar** (garis dan label pada rentang yang tampil, pada frekuensi tampilan bila memakai Freq Shift; di grafik Spektrum dan trace Dengar label yang akan bertumpuk pindah ke baris berikutnya, dan setelah empat baris tidak ditampilkan, sedangkan garisnya tetap) dan di dock Spektrum Dashboard, yang bisa menambah dan menghapus marker di daftar yang sama (lihat **Penanda** di bawah). Marker hanya tersimpan bila sebuah marker set dipilih; tanpa itu daftar hilang saat console dimuat ulang.
- **Rekaman: kalender dan linimasa.** Tab **Rekaman** dibuka seperti rekaman CCTV: kalender menandai hari yang punya audio (titik biru) dan pindai (titik kuning); pilih **Hari**, **Rentang** (klik hari awal lalu hari akhir, maksimal 366 hari) atau **Semua tanggal**. Dalam mode Hari, linimasa 24 jam menampilkan audio dan pindai hari itu: klik memilih satu jam, seret memilih rentang (kelipatan 5 menit), atau ketik **Dari**/**Sampai**; **Sepanjang hari** menghapus pilihan. Hari dan jam memakai jam lokal browser.
- **Rekaman: tabel dan filter.** Tabel menampilkan audio dan pindai bersama (Mulai, Selesai, Jenis, Frekuensi, Mode, Durasi, Ukuran, Status), bisa diurutkan per kolom dan dibagi per halaman (50/100/200 baris). Filter: jenis, status, frekuensi (MHz), VFO, mode, bandwidth, cari, dan **Jam (lokal)** Dari–Sampai untuk mode Rentang sampai 62 hari (Sampai lebih awal dari Dari berarti melewati tengah malam, misalnya 22:00–02:00).
- **Rekaman: pratinjau dan unduhan.** Tombol putar memutar audio di baris itu; pratinjau pindai menampilkan trace Max dan Rata-rata, kandidat teratas, dan **Buka di Spektrum** (bila RX atau rekaman berjalan, ada konfirmasi di halaman lebih dulu). **Unduh** di baris mengunduh satu file: `.webm` untuk audio, ZIP untuk pindai. Centang baris (atau **Pilih halaman**, lalu **Pilih semua hasil**) lalu **Unduh ZIP** untuk banyak rekaman sekaligus: maksimal 1000 rekaman atau perkiraan 4 GiB per ZIP, dengan `manifest.json` di akhir yang mencatat rekaman yang tidak ikut. Paling banyak dua ZIP berjalan bersamaan; Chrome bisa meminta izin satu kali untuk beberapa unduhan.
- **Rekaman: hapus dan Retensi.** **Hapus** (per baris atau untuk pilihan) meminta konfirmasi di halaman, bukan dialog browser; rekaman yang sedang direkam dan pindai yang berjalan tidak bisa dihapus. **Retensi** (Mati, 1, 3, 7, 14, 30, 60 atau 90 hari) menampilkan berapa rekaman akan terhapus sebelum **Terapkan**. Setelah aktif, retensi berjalan 1 menit setelah console start, lalu tiap jam, dan langsung setelah diubah; set penanda, sesi yang masih merekam dan pindai yang berjalan tidak pernah dihapus. File database tidak mengecil setelah retensi; ruang dipakai ulang untuk rekaman baru.
- **Upload arsip gagal.** Dengan arsip scan otomatis aktif, upload trace atau kandidat yang gagal menampilkan banner merah di Spectrum dan Rekaman. Banner hilang sendiri setelah penyimpanan pulih; trace yang hilang tampil di status pindai sebagai chip "N tidak tersimpan". Kandidat yang gagal dikirim ulang otomatis.
- **Bahasa.** Receiver mengikuti EN/ID console. Status code (`SIMULATION`, `SCANNING`, `STOPPED`, `MOCK`, `REC`, `LIVE`), satuan, dan detail error dari browser atau radio tetap berbahasa Inggris.
- **Tanpa service worker dan font remote.** Build Receiver tidak mendaftarkan service worker dan tidak memuat font dari internet. Browser yang masih punya service worker dari build lama menghapusnya sendiri pada kunjungan berikutnya; bila tampilan masih lama, muat ulang sekali lagi. Origin berbeda (`localhost:8787` dan `127.0.0.1:8787`) memerlukan izin WebUSB masing-masing.
- **Mutasi API.** Mutasi `/api/receiver/*` memerlukan header `Origin` same-origin yang cocok dengan host dan port loopback; tanpa header itu atau dari origin lain, server mengembalikan HTTP 403.

## Dasbor: Spektrum, Dengar dan Kontrol

Dashboard (dulu Ringkasan) adalah dasbor peta penuh di `#/dashboard`; alamat lama `#/overview` tetap dibuka. Peta mengisi layar. Di kiri ada HUD bearing (dan panel Lapisan), di kanan kartu node (dan panel Kontrol), dan di bawah ada dock berisi Polar dan Spektrum. Pada lebar 1023 px ke bawah semua panel tersusun ke bawah dan halaman bisa digulir.

### Top bar dan panel

- Tombol menu di kiri top bar membuka menu halaman: tujuh halaman (label dan tombolnya saja), tombol tema, dan chip kontrol admin. Urutannya Dashboard (`1`), Receiver (`2`), Kesehatan Sistem (`3`), Diagnostik DoA (`4`), Konfigurasi (`5`), Monitor Pesan (`6`), dan Simulasi (`7`). Menu tertutup dengan `Esc`, klik di luar menu, atau setelah memilih halaman. Tombol `1`–`7` tetap berlaku.
- Di Dashboard, top bar punya tombol panel **Lapisan**, **Polar**, **Spektrum**, dan **Kontrol**. Secara bawaan Polar dan Spektrum aktif, Lapisan dan Kontrol mati, dan kartu node tampil ringkas. Pilihan ini diingat browser. Bila Polar dan Spektrum dimatikan, dock hilang dan peta memakai seluruh tinggi layar.
- Select interval di samping tombol refresh menyimpan interval refresh ke konfigurasi console, sama seperti form **Konfigurasi → Koneksi**.
- Kartu node menampilkan frekuensi tengah, gain, dan posisi stasiun. Tombol panah di kartu membuka detail: SNR, DAQ, ADC, frame DAQ, kontrol jarak jauh (`en_remote_control`), dan offset kompas.
- Tombol peta ada di kiri bawah: zoom masuk dan keluar, pusatkan ke stasiun, kembalikan utara ke atas, **Peta dasar**, dan chip sumber peta (tautan atribusi).

### Spektrum dan Dengar

Spektrum memakai RadioSpectrum yang sama dengan halaman Receiver, jadi butuh Chrome atau Edge (WebUSB) dan build Receiver. Tanpa build Receiver, chip menampilkan `NOT BUILT`.

- **Mulai** memuat Receiver di latar belakang (saat pertama kali), menyambungkan RadioSpectrum yang sudah dipasangkan ke browser ini, dan menjalankan RX tanpa suara. Selama RX mati, grafik bertuliskan "RX berhenti". Grafik menampilkan 2 MHz di sekitar tengah RX: trace di atas, waterfall di bawah, dan pita VFO. Level dalam dBFS relatif, tidak terkalibrasi. **Berhenti** menghentikan RX.
- **RadioSpectrum pertama kali.** Bila chip menampilkan `NEEDS_PAIRING`, tekan **Buka Receiver (2)**, sambungkan RadioSpectrum lewat **Connect Device** di halaman Receiver, kembali ke Dashboard, lalu tekan **Mulai**. Pemilih USB milik browser tetap menampilkan nama produk USB perangkat (misalnya HackRF One); nama itu berasal dari perangkat dan tidak bisa diganti console. `NEEDS_DEVICE_CHOICE` berarti lebih dari satu RadioSpectrum sudah dipasangkan; pilih satu di halaman Receiver. Izin WebUSB berlaku per alamat, jadi `localhost:8787` dan `127.0.0.1:8787` dipasangkan masing-masing.
- **Klik untuk menala.** Klik trace atau waterfall untuk memindahkan tengah RX dan VFO ke frekuensi itu (dibulatkan ke 1 kHz). Klik ini mematikan **Ikuti frekuensi node**. Saat **Penanda** aktif, klik menambah penanda, bukan menala. Dengan keyboard, fokuskan grafik lalu tekan ←/→ untuk langkah 10 kHz, atau Shift+←/→ untuk 100 kHz; menahan tombol melangkah dari frekuensi yang tampil, jadi tidak ada langkah yang hilang. Arahkan kursor ke grafik untuk membaca frekuensi dan level. VFO lalu berada tepat di tengah RX, tempat spike DC RadioSpectrum muncul. Bila Receiver menolak tuning itu (misalnya `SWEEP_BUSY`), grafik kembali ke frekuensi Receiver.
- **Sinkron dengan halaman Receiver.** Tengah RX dan VFO dipegang Receiver. Perubahan di halaman Receiver (misalnya Center 100 → 150 MHz) tampil di Spektrum dalam sekitar 150 ms, juga bila Anda baru kembali dari halaman Receiver. Klik atau ←/→ di Spektrum langsung mengubah Center dan VFO di halaman Receiver; sampai radio benar-benar pindah frekuensi (Receiver menunggu sekitar 200 ms), spektrum lama tetap digambar di frekuensinya sendiri. Mengubah tengah atau VFO di halaman Receiver, termasuk memanggil bookmark atau selesai dengar-pindai, mematikan **Ikuti frekuensi node**, sama seperti klik di grafik; centang lagi untuk kembali ke frekuensi node. Modulasi yang dipilih di halaman Receiver juga menjadi modulasi untuk Mulai berikutnya. Setelah console dimuat ulang dan sebelum Receiver dimuat, grafik menampilkan tengah dan VFO terakhir yang disimpan Receiver bila Ikuti frekuensi node tidak sedang menunjuk node; nilai itu hanya tampilan, Mulai tetap memakai setelan Receiver.
- **Ikuti frekuensi node** (aktif bawaan). Selama data node segar, tengah RX mengikuti `center_freq` dari `settings.json` node (lewat MQTT: dari pembacaan ringan Data Out) dan VFO mengikuti frekuensi DoA (baris CSV Data Out, atau DoA LIVE lewat MQTT). Receiver ditala ulang bila frekuensi node bergeser lebih dari 1 kHz; mengganti Sample rate (di dock atau di halaman Receiver) tidak menala ulang. Tanpa Data Out segar, tuning saat ini dipertahankan. Bila Receiver memakai Freq Shift, muncul tag `UPCONVERTER`; frekuensi node dipakai tanpa shift itu, jadi set Freq Shift ke 0 agar RadioSpectrum benar-benar menala ke frekuensi node.
- **Dengar** memutar audio VFO di browser ini dengan modulasi yang dipilih di sebelahnya (di **Atur** bila dock sempit): NFM (bawaan), WFM, AM, USB, LSB, DSB, CW, atau RAW. Bila RX belum jalan, Dengar sekaligus menyalakannya. Mengganti modulasi langsung berlaku dan diingat browser. Tekan Dengar lagi untuk berhenti mendengar. Bila browser memblokir audio, tekan Dengar sekali lagi.
- **RX | Spektrum** (sakelar setelah chip) memilih isi grafik dan apa yang dijalankan **Mulai**: **RX** (2 MHz di sekitar tengah RX) atau **Spektrum** (pindai lebar Receiver di rentangnya sendiri). Selama tidak ada yang berjalan, sakelar hanya memilih mode dan tidak memuat Receiver. Dock selalu menampilkan mode yang sedang berjalan: pindai yang dimulai di halaman Receiver tampil sebagai Spektrum dengan grafik hidup.
- **Mode Spektrum.** **Mulai** menjalankan pindai lebar dengan rentang dan pengaturan pindai Receiver (bawaan 100–1000 MHz), **Berhenti** menghentikannya tanpa menyalakan RX. Chip `SCAN` berarti pindai berjalan, `…` berarti pindai sedang dimulai atau dihentikan, `SCAN OFF` berarti berhenti. Dengan `?mock=1` pindai memakai sumber simulasi dan header menampilkan tag `SIM` selama pindai itu berjalan. Baris info menampilkan rentang, RBW, LNA, dan VGA pindai. Klik atau ←/→ pada grafik menyimpan tengah dan VFO untuk RX berikutnya (pada bin terkuat di dekat klik; langkah ←/→ 1/200 rentang, minimal 10 kHz) dan mematikan **Ikuti frekuensi node**; pindai tetap berjalan. **Dengar** menghentikan pindai lalu menjalankan RX dan memutar audio. Pindah ke **RX** saat pindai berjalan menghentikan pindai dan menjalankan RX; pindah ke **Spektrum** saat RX berjalan memulai pindai. Pindai menghentikan RX, jadi bila rekaman audio VFO sedang berjalan console menanyakan dulu karena rekaman itu berakhir.
- **Penanda** (tombol setelah sakelar RX | Spektrum, dengan jumlah penanda di daftar Receiver) menyalakan mode menandai untuk kunjungan ini saja; setelah halaman dibuka lagi mode ini mati. Pada dock selebar 761–1099 px tombol ini hanya menampilkan ikon dan jumlah. Penandanya adalah daftar **Penanda spektrum** halaman Receiver: garis merah muda di trace dan garis putus-putus di waterfall, pada mode RX dan Spektrum, juga saat mode menandai mati. Saat menandai, klik grafik menambah penanda di frekuensi itu (dibulatkan ke 1 kHz; pada mode Spektrum di bin terkuat di dekat klik), dan klik dekat penanda memilihnya. Baris di atas grafik menampilkan penanda terpilih (nama, MHz, dan dB bila diukur) dengan **Hapus** dan **Tala ke sini** (menala RX ke penanda itu dan mematikan **Ikuti frekuensi node**; nonaktif di atas 6000 MHz). Tag **Belum disimpan** berarti belum ada marker set yang dipilih di halaman Receiver. Dengan keyboard pada grafik: Enter menandai VFO, `[` dan `]` memilih penanda sebelumnya atau berikutnya, Delete menghapus penanda terpilih, `Ctrl+Z` (`⌘Z`) menghapus penanda terakhir dari dock, Esc melepas pilihan; ←/→ tetap menala. Menandai juga bisa selama pindai berjalan; daya penanda diukur dari pindai itu, sedangkan penanda pada mode RX tidak punya daya. Penanda dari dock langsung tampil di halaman Receiver (daftar, grafik Spektrum, dan trace Dengar), dan perubahan di halaman Receiver tampil di dock dalam sekitar 100 ms.
- Chip `BUSY` berarti dengar-pindai sedang berjalan di halaman Receiver (Receiver sedang mendengarkan satu kandidat). Dasbor tidak mengganggunya: Mulai, Berhenti, Dengar, dan klik di grafik ditolak sampai dengar-pindai dihentikan dari halaman Receiver.
- RX tetap berjalan saat pindah halaman, sama seperti Receiver. Data spektrum hanya dikirim ke dasbor selama panel Spektrum terbuka dan tab browser terlihat.
- **Atur** (tombol terakhir di header) membuka kolom pengaturan di samping grafik. Bila dock Spektrum lebih sempit dari 1400 px (misalnya layar 1440 px dengan Polar terbuka), **Ikuti frekuensi node**, modulasi, dan **Kirim ke RDF-SDR** pindah dari header ke kolom ini, sehingga header tetap satu baris pada dock selebar kira-kira 950 px ke atas; pada dock yang lebih sempit tombol header turun ke baris berikutnya dan dock bertambah tinggi. Pada dock 760 px ke bawah (misalnya layar 1024 px dengan Polar terbuka) kolom ini terbuka di bawah waterfall, dua kolom bila muat, tanpa menutupi grafik atau tombol penanda, dan dock bertambah tinggi selama peta di atasnya masih setinggi 256 px; selebihnya grafik dan kolom digulir di bawah header. Pada layar 1023 px ke bawah kolom ini juga ada di bawah waterfall.
- **Sample rate** dan **Gain** di **Atur** adalah pengaturan Listener di halaman Receiver: Sample rate 2, 4, 5, 8, 10, 16 atau 20 MSPS, LNA 0–40 dB (langkah 8), VGA 0–62 dB (langkah 2), dan tombol **+14 dB** (penguat RF). Nilainya sama dengan isian Radio di tab **Dengar** dan sinkron dua arah: perubahan di halaman Receiver tampil di dock dalam sekitar 100 ms, perubahan di dock langsung terlihat di halaman Receiver. Gain berlaku langsung tanpa menghentikan RX. Mengganti Sample rate saat RX jalan memulai ulang RX sebentar (chip `…`); spektrum dock tetap 2 MHz. Bila rekaman audio VFO sedang berjalan, console menanyakan dulu; rekaman berlanjut di segmen baru. Bila audio diblokir browser setelah RX dimulai ulang, tekan **Dengar** sekali lagi. Sample rate tidak bisa diganti selama pindai, dan sebelum Receiver dimuat semua isian ini nonaktif dengan `—`. Baris info di atas grafik menampilkan sample rate, LNA, VGA, dan `+14 dB` bila penguat RF aktif.
- **Skala dB** di **Atur**: Auto (bawaan) mengikuti sinyal. Manual memakai Min dB dan Maks dB yang diketik; nilai berlaku saat menekan Enter atau keluar dari kolom, dibatasi −160 s/d 60 dB dengan selisih minimal 5 dB. Trace dan seluruh riwayat waterfall langsung diwarnai ulang. Manual dimulai dari rentang yang sedang tampil. Skala ini sama dengan panel **Skala dB** di tab **Dengar** halaman Receiver: mengubahnya di satu tempat mengubah yang lain. Sebelum Receiver dimuat, dock memakai skala terakhir yang diketahuinya; perubahan saat itu dikirim ke Receiver begitu Receiver dimuat.
- **Atur pada mode Spektrum.** Kolom ini menampilkan pengaturan pindai Receiver, bukan pengaturan RX: **Skala dB** pindai, **Rentang** (Awal dan Akhir MHz, berlaku saat Enter atau keluar dari kolom; tombol **Pusatkan ke RX** memusatkan lebar rentang yang sama pada tengah RX), **Resolusi** (4.88 kHz atau 2.44 kHz; resolusi yang tidak muat untuk rentang itu nonaktif), dan **Gain** pindai (LNA, VGA, +14 dB), yang terpisah dari gain RX seperti di halaman Receiver. Rentang 1–7250 MHz (frekuensi perangkat; dengan Freq Shift kolom menampilkan frekuensi tampilan), minimal 1 MHz, dan paling lebar 1220 MHz pada 2.44 kHz atau 2441 MHz pada 4.88 kHz. Selama pindai berjalan isian ini terkunci ("Terkunci selama pindai"), sama seperti di halaman Receiver; hentikan pindai untuk mengubahnya. Manual pada **Skala dB** pindai adalah **Grafik min./maks.** halaman Receiver: memilih Manual memakai nilai Receiver tanpa mengubahnya, dan nilai yang diketik langsung berlaku di halaman Receiver (juga saat pindai berjalan). Auto hanya berlaku di dock. Sebelum Receiver dimuat, kolom menampilkan pengaturan pindai yang terakhir disimpan Receiver, nonaktif.

### Kirim ke RDF-SDR dan Kontrol

Kontrol adalah satu-satunya cara console mengubah setelan di RDF-SDR. Console mengirim perintah RDF Node dalam format edge (`docs/MQTT_KONTRAK.md` bagian 9): `config.patch` ke `sdr/v2/uav-01/cmd/config/patch` untuk mengubah nilai, dan `config.get` ke `sdr/v2/uav-01/cmd/config/get` untuk membaca settings. Keduanya QoS 1, tidak retained, kedaluwarsa 15 detik. RDF Node di RDF-SDR yang memutuskan menerapkannya, lalu menjawab di `ack/config`.

1. **Kirim ke RDF-SDR** di header Spektrum (di **Atur** bila dock sempit) membuka Kontrol dengan draf: Frekuensi tengah dan Frekuensi VFO sama-sama diisi frekuensi VFO yang sedang didengar, karena RDF-SDR hanya menerima perubahan frekuensi tengah bersama VFO 0 di frekuensi yang sama. Tombol ini belum mengirim apa pun, dan nonaktif bila frekuensi belum diketahui atau di luar 24–1766 MHz. Kontrol juga bisa dibuka dengan tombol panel **Kontrol**.
2. **Buka kunci.** Masukkan kata sandi admin lalu tekan **Buka kunci**. Sesinya sama dengan login admin di Konfigurasi dan berlaku 30 menit.
3. **Baca nilai.** Baris atas menampilkan topik, broker, status koneksi, `rev dasar` (yaitu `state.cfg` RDF-SDR), sesi RDF-SDR dengan status health (`FRESH` atau `STALE`), laporan `settings/reported` terakhir, dan sumber nilai. Setelah kunci dibuka, Kontrol mengirim `config.get` sekali bila belum ada laporan untuk revisi sekarang; **Baca settings** mengirimnya lagi (paling cepat sekali per detik). RDF-SDR menjawab dengan `settings/reported` hanya bila koneksinya sendiri ke broker memakai TLS. Tanpa TLS jawabannya `TLS_REQUIRED_FOR_SETTINGS_REPORT`, dan nilai diambil dari `settings.json` Data Out (cadangan) yang masih segar (collector membaca `center_freq`, `uniform_gain`, `vfo_freq_0`, `vfo_bw_0` dan `vfo_squelch_0`). Baris "Nilai: settings/reported", "Nilai: Data Out (cadangan)" atau "Nilai: tidak dilaporkan" menyebut sumbernya.
4. **Ubah nilai.** Ada lima field: Frekuensi tengah (MHz), Gain (pilihan dari tabel gain RDF-SDR), Frekuensi VFO (MHz), Bandwidth VFO (kHz), dan Squelch VFO (dB). Frekuensi dan bandwidth dikirim dalam Hz bulat. Mengetik Frekuensi tengah ikut mengisi Frekuensi VFO dengan nilai sama ("Dikirim bersama frekuensi tengah"); VFO yang berbeda dari tengah yang diubah ditolak di field itu. Field bertuliskan "tidak dilaporkan" bila tidak ada sumber yang membawa nilainya. Field yang diubah ditandai "Diubah dari …", dan nilai di luar rentang diberi pesan di field itu; field lain tidak punya keterangan di bawahnya.
5. **Tinjau perubahan** menampilkan nilai lama → baru dengan nama field edge (`center_frequency_hz`, `vfo0_frequency_hz`, ...) dan "QoS 1 · kedaluwarsa 15 dtk · rev dasar N". **Kembali** untuk mengedit lagi.
6. **Kirim ke RDF-SDR** di layar tinjauan inilah yang benar-benar mengirim. Tombolnya nonaktif bila monitor MQTT belum terhubung, belum ada `state` RDF-SDR, rev dasar belum diketahui, atau health RDF-SDR tidak segar. Setelah terkirim, Kontrol menunggu jawaban, memeriksa statusnya setiap detik, dan menampilkan progresnya (misalnya `ACCEPTED`). Hanya satu patch yang boleh menunggu hasil pada satu waktu. Console tidak pernah mengirim ulang sendiri.
7. Hasil:
   - `ACK · APPLIED`: satu-satunya hasil berhasil. RDF-SDR menulis `settings.json` dan melihat bukti runtime untuk tiap field; config rev naik.
   - `ACK · PERSISTED_UNVERIFIED` dan `ACK · OUTCOME_UNKNOWN` (biru): bukan berhasil dan bukan gagal. Yang pertama tersimpan tetapi buktinya belum lengkap; yang kedua tidak diketahui. Jangan kirim ulang; baca settings dulu dan lihat **Cek RDF-SDR**.
   - **Tidak ada ACK akhir** (90 detik setelah kirim, hanya ada `ACCEPTED`): sama, hasilnya tidak diketahui.
   - `Ditolak · REJECTED · CONFIG_REVISION_CONFLICT`: settings di RDF-SDR berubah setelah rev dasar dibaca. Tekan **Baca ulang nilai**, tinjau, lalu kirim lagi.
   - `Ditolak · REJECTED · BUSY`: RDF-SDR masih mengerjakan perintah lain, mungkin dari `rdf-ground.service`. Kode lain (`EXPIRED`, `CANCELLED`, `FAILED`, atau penolakan lain) ditampilkan dengan pesannya. `EXPIRED_OR_INVALID_DEADLINE` biasanya berarti jam console dan RDF-SDR berselisih lebih dari 1 detik.
   - **Belum ada ACK** (sekitar 20 detik setelah kirim): RDF-SDR tidak menjawab. Periksa bahwa RDF Node berjalan dan memakai broker yang sama.
   - **Publish gagal** (PUBACK 128 ke atas): broker menolak publish dari console, biasanya karena ACL.
   - **Tidak terkirim · KODE**: console menolak sebelum publish. Contohnya `CONFIG_REVISION_STALE` (rev berubah sejak ditinjau; nilai dibaca ulang, tinjau lagi), `NODE_NOT_FRESH` (health RDF-SDR tidak segar), `MQTT_NOT_CONNECTED`, dan `COMMAND_IN_FLIGHT` (patch lain masih menunggu hasil).
8. **Cek RDF-SDR.** Setelah hasil akhir (semua kecuali **Publish gagal**), Kontrol mengirim `config.get` dan membandingkan tiap field yang dikirim dengan nilai terbaru dari RDF-SDR. Tiap baris menampilkan Dikirim, MQTT (`settings/reported`) dan Data Out, plus status:
   - `CONFIRMED`: nilai RDF-SDR sama dengan yang dikirim (toleransi ±500 Hz untuk frekuensi, ±1 Hz untuk bandwidth, ±0,05 dB untuk gain dan squelch).
   - `PENDING`: belum sama, atau belum ada data segar; masih ditunggu sampai 90 detik setelah hasil akhir. Kalau RDF-SDR tidak menerapkan perintah (`REJECTED`, `CONFLICT`, `EXPIRED`, `FAILED`, `CANCELLED`), tidak ada masa tunggu: hasil cek langsung keluar.
   - `UNCHANGED`: setelah 90 detik (atau langsung, setelah penolakan) nilainya tetap belum sama.
   - `NOT REPORTED`: tidak ada sumber yang membawa field itu.

   `settings/reported` yang diterima setelah perintah dikirim yang menentukan. Data Out (`settings.json` dari pembacaan yang masih segar) hanya dipakai bila laporan itu tidak ada. Snapshot STALE dan data simulasi tidak dihitung. Ringkasan di atas baris, misalnya "RDF-SDR berubah · 2/2" atau "Belum berubah · 0/2", merangkum semuanya. **Cek ulang** mengirim `config.get` dan membaca Data Out (termasuk `settings.json`) saat itu juga; pembacaan yang sama berjalan sekali saat perintah selesai. Karena console memakai ulang `settings.json` paling lama 30 detik, nilai Data Out hanya dihitung bila `settings.json` dibaca setelah perintah dikirim. Dengan interval refresh Manual atau lebih lama dari jendela segar, Data Out hanya terbaca saat **Cek ulang** atau Refresh ditekan.
9. **Selesai** mengembalikan form ke nilai yang dilaporkan. **Kunci lagi** menutup sesi admin.

Monitor MQTT console tidak memakai TLS, username, atau password. Kontrol hanya bekerja lewat broker yang menerima koneksi seperti itu dan mengizinkan console publish ke `sdr/v2/uav-01/cmd/config/patch` dan `cmd/config/get`. Broker yang sama perlu listener TLS untuk RDF-SDR agar `settings/reported` dikirim; console tetap memakai listener biasa. Broker `tools/mqtt_lan_stage.conf` (TLS dan password) tidak bisa dipakai console.

Satu operator, satu pengendali: `rdf-ground.service` di groundstation juga bisa mengirim perintah ke RDF-SDR. RDF-SDR mengerjakan satu perubahan sekaligus (`BUSY`), dan perubahan dari pengirim lain membuat rev dasar Kontrol usang (`CONFIG_REVISION_CONFLICT`). Pakai satu console dengan Kontrol terbuka, atau `rdf-ground.service`, tidak keduanya sekaligus.

### Polar dan Atur

- **Kompas | Polar** memilih mode plot. Pilihan ini hanya mengubah plot dan nilai Puncak di HUD; peta dan bearing tidak berubah.
- **Atur** membuka pengaturan di samping plot:
  - **Putar grafik (Head Up)**: geser 0–359° atau ketik nilainya. **Puncak ke atas** memutar plot sehingga θ₀ berada di atas; tombol ini nonaktif saat DoA tidak ditampilkan.
  - **Arah kompas (offset)**: **Data Out** memakai `compass_offset` dari `settings.json` node. **Manual** memakai nilai yang Anda ketik, −360 sampai 360. Offset berlaku untuk peta, plot, dan bearing (tag `MANUAL · peta + polar`), dan tanda "→" menunjukkan bearing hasilnya. Ini pilihan yang sama dengan sumber Compass di Konfigurasi dan disimpan di console (lihat [Apa yang tersimpan](#apa-yang-tersimpan-dan-di-mana)). Saat simulasi pilihan ini terkunci.
  - **Skala dB (relatif)**: Auto mengikuti data. Manual memakai Min dB dan Maks dB; min harus lebih kecil dari maks.
  - **Atur ulang tampilan grafik** mengembalikan Head Up ke 0°, mode plot ke pengaturan sumbernya, dan skala dB ke Auto. Offset kompas tidak ikut direset.
- Baris di bawah plot menampilkan puncak (θ₀ di mode Polar), lebar −3 dB, dan Head Up.

### Peta dasar

- Delapan gaya: **Standar**, **Hot**, **Terang**, **Gelap**, **Satelit**, **Satelit + label**, **Topografi**, dan **Polos**. Pilih lewat tombol peta (ikon peta) di kontrol peta atau select **Peta dasar** di baris pertama panel Lapisan; keduanya memakai pilihan yang sama.
- Menu terbuka di atas tombol. Gaya langsung berlaku dan menu tetap terbuka, jadi tombol panah bisa dipakai untuk berpindah gaya; `Esc`, klik di luar menu, atau Tab keluar menutupnya.
- Ganti gaya tidak mengubah kamera, overlay DoA, label, marker stasiun, maupun readout hover.
- Terang dan Gelap memakai tile Standar yang diwarnai ulang di browser (Gelap membalik warnanya), jadi tidak ada penyedia tambahan. Pada Gelap dan Satelit, cincin, arah, tepi −3 dB, dan garis tepi lobe berubah terang.
- Polos tidak meminta tile sama sekali.
- Nama gaya tidak menyebut penyedia. Chip kecil di samping tombol peta menyebut sumber data dan citra karena lisensinya mewajibkan atribusi; teks lengkapnya ada di tooltip chip.
- Satelit dan Satelit + label memakai layanan citra Esri tanpa kunci API. Syarat pemakaian komersialnya diterima dengan risiko; periksa syarat Esri sebelum dipakai di lapangan.
- Pilihan disimpan di console (`sdr-console-basemap`), sama seperti pengaturan Lapisan. Reset di Lapisan → Lanjutan tidak mengubah peta dasar.

### Lapisan

- **Peta dasar** di baris pertama (lihat di atas).
- Tujuh sakelar overlay peta: Sorotan beam, Lobe, Garis bearing, Tepi −3 dB, Cincin jarak, Arah U/T/S/B, dan Label teks.
- **Opasitas overlay** 20–100 %.
- **Lanjutan** membuka pengaturan overlay lengkap: jarak proyeksi, skala dB manual dan noise threshold, palet, blur, dan seterusnya.

Semua pengaturan Lapisan disimpan di console, jadi tetap sama di browser lain atau setelah cache dibersihkan.

## Menjalankan tanpa perangkat SDR

Ground Console tetap dapat digunakan untuk memeriksa UI tanpa RDF-SDR atau Data Out live:

1. Buka tab **Simulasi**.
2. Aktifkan simulasi (`SIMULATION`).
3. Atur latitude, longitude, **Bearing dari utara (0–359°)**, dan lebar lobe.
4. Klik **Terapkan skenario**.
5. Buka **Dashboard**.
6. Periksa direction helper di peta dan kurva polar sintetis.

Sudut yang dimasukkan adalah bearing geografis: 0° utara, searah jarum jam. HUD, plot polar (mode Compass, kecuali Anda memilih Polar di dock), dan peta menampilkan angka yang sama; misalnya 45° tampil di arah timur laut di ketiganya. HUD menampilkan θ₀ 315° sebagai sudut array yang setara. Panel polar menampilkan badge `SIMULATION`. Simulasi kembali OFF setelah reload.

Mode simulasi hanya mengganti data Dashboard. Health, diagnostics, MQTT, dan publication gate tetap menggunakan sumber nyata atau tetap `BLOCKED`. Untuk Receiver tanpa hardware, buka `http://127.0.0.1:8787/?mock=1#/receiver` untuk memakai Mock SDR (lihat bagian Receiver).

## Menghubungkan Data Out live

Ground Console default memakai:

```text
http://doasdr.local:8081
```

Data Out (cadangan) hanya dibaca dari host di daftar **Host Data Out (cadangan)**, selalu di port `8081`. Daftar itu disimpan di `console.json` (`data_out_hosts`) dan diubah di **Konfigurasi → Koneksi & refresh**: tambah host (nama DNS seperti `rdf.local` atau alamat IPv4/IPv6, tanpa skema, port, path, atau wildcard; untuk alamat IPv4-mapped `::ffff:…` masukkan alamat IPv4-nya), hapus host, lalu **Simpan** bersama base URL. Default-nya `doasdr.local`, `192.168.100.100`, `127.0.0.1`, dan `localhost`; paling banyak 16 host, dan host base URL yang dipakai tidak bisa dihapus. Base URL di luar daftar ditolak dengan pesan yang menyebut host yang diizinkan dan port `8081`.

Untuk satu run saja, jalankan dengan `--base-url`; host-nya harus ada di daftar tersimpan (pada start pertama: daftar dari `SDR_DOA_SEED_DATA_OUT_HOSTS`, atau default), misalnya:

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

Flag yang diketik eksplisit (`--base-url`, `--mqtt-host`, `--mqtt-port`, `--mqtt-transport`, `--mqtt-ws-path`) mengalahkan konfigurasi tersimpan (`~/.config/sdr-doa-ground-console/console.json`) untuk run itu saja. Server mencetak pemberitahuan seperti `--base-url from the command line overrides the saved console config for this run`. Nilai flag tidak pernah masuk ke file: setiap penyimpanan (form **Konfigurasi → Koneksi** atau **Konfigurasi → MQTT**, pilihan interval di top bar, kartu **Akses LAN**) hanya menulis field yang diubahnya, jadi field yang masih memakai nilai flag tetap dengan nilai tersimpannya. Field yang Anda ubah tersimpan dengan nilai baru dan mengakhiri flag-nya untuk run itu. Satu pengecualian: bila daftar host Data Out (cadangan) yang disimpan tidak lagi memuat host URL tersimpan, URL yang sedang aktif ikut tersimpan, karena hanya URL itu yang cocok dengan daftar. Flag yang tidak diketik memakai nilai tersimpan.

Bila `console.json` rusak, field yang valid tetap dipakai, server mencatat nama field yang dikembalikan ke default, dan salinan file asli disimpan sebagai `console.json.invalid.bak`.

Collector tetap read-only dan hanya memakai HTTP GET.

## Membaca status di console

### Strip status

Strip di top bar punya tujuh item, dari kiri ke kanan: SUMBER, DATA, DOA, PUBLIKASI, SNAPSHOT, MQTT, dan SIM. Arahkan kursor ke sebuah item untuk melihat apa yang dilaporkannya; detail status saat ini, misalnya penyebab sebuah masalah, tampil di baris berikutnya.

- **SUMBER** (`SOURCE` di bahasa Inggris) menyebut dari mana console mengambil jawaban terakhir (lihat [Sumber data Dashboard](#sumber-data-dashboard)): `MQTT` (hijau), `Data Out (cadangan)` (amber) bila MQTT tidak segar, atau `tidak ada` (merah) bila Data Out juga tidak terbaca. Tooltip-nya menyebut kode dan alasan, misalnya `MQTT_HEALTH_STALE · Health MQTT lebih tua dari 8 dtk`. Chip ini muncul setelah jawaban pertama console.
- **DATA** mengklasifikasikan isi jawaban terakhir (MQTT atau Data Out):
  - `LOADING`: belum ada pembacaan yang selesai.
  - `ERROR`: request ke console gagal.
  - `UNAVAILABLE`: `status.json` tidak terbaca, atau kedua file DoA tidak bisa diambil.
  - `DEGRADED`: sinkronisasi DAQ tidak PASS atau ADC overdrive.
  - `INVALID`: tidak ada view DoA yang bisa diparse.
  - `CONFLICT`: CSV dan XML dari frame yang sama tidak sepakat.
  - `STALE`: data sumber sudah tua, node berhenti diperbarui, atau jendela lokal 5 detik habis.
  - `INCOMPLETE`: satu view hilang atau tidak bisa dibandingkan.
  - `AVAILABLE`: data node terbaca, segar, dan konsisten.

  Untuk status selain `AVAILABLE`, tooltip DATA menyebut gate reason utama dan error per view (misalnya "XML: HTTP 404").
- **DOA** menyatakan apakah bearing dan vektor 360 bin bisa ditampilkan di Dashboard: `AVAILABLE`, atau `DEGRADED`, `CONFLICT`, `UNAVAILABLE`, `INCOMPLETE`, `STALE`, dan `UNVERIFIED` (DoA lewat MQTT yang belum diverifikasi RDF-SDR) dengan penyebab di tooltip. Sebelum pembacaan pertama nilainya `WAITING`. Ini keputusan yang sama yang dipakai readout, plot polar, dan peta.
- **PUBLIKASI** (`DELIVERY` di bahasa Inggris) adalah gate publikasi dari collector: `READY` hanya bila semua pemeriksaan untuk memublikasikan bearing lolos, selain itu `BLOCKED`. Di Ground Console nilainya selalu `BLOCKED`, juga saat DATA dan DOA `AVAILABLE`; penyebabnya dijelaskan di bagian Kesehatan Sistem di bawah. Tooltip menyebut reason teratas beserta kodenya.
- **SNAPSHOT** menyangkut pembacaan `/api/snapshot` itu sendiri: `CURRENT` selama 5 detik setelah console membaca node (termasuk pembacaan yang melaporkan UNAVAILABLE), lalu `STALE`; `ERROR` bila request terakhir gagal. Sebelum pembacaan pertama nilainya `LOADING` atau `WAITING`.
- **MQTT** adalah koneksi monitor lokal. Monitor ini berlangganan dan tidak pernah publish sendiri; satu-satunya publish adalah perintah Kontrol yang dibuka admin (patch yang dikonfirmasi, dan permintaan settings). Nilainya `CONNECTED`, `CONNECTING`, `DISCONNECTED`, `ERROR`, atau `OFF` bila host MQTT tidak dikonfigurasi. `ERROR` juga muncul bila monitor tidak bisa dibuat (misalnya `paho-mqtt` tidak terpasang) atau console tidak bisa membaca status monitor; detailnya ada di tooltip.
- **SIM** bernilai `ON` selama simulasi aktif, yaitu saat Dashboard menampilkan data sintetis dari browser, dan `OFF` bila Dashboard memakai data live (MQTT atau Data Out). Item lain di strip tetap melaporkan data live, juga saat simulasi `ON`.

Bila pembacaan gagal, penyebabnya juga ditulis di banner di bawah strip.

### Refresh

- Selama MQTT segar, Dashboard memakai MQTT dan console tidak membaca Data Out penuh; interval refresh hanya mengatur seberapa sering halaman mengambil jawaban dari console (lihat [Sumber data Dashboard](#sumber-data-dashboard)). Butir tentang pembacaan Data Out di bawah ini berlaku saat Data Out (cadangan) yang menjawab.
- Pilihan interval: Manual, 1, 2, 5, 10, dan 30 detik. Instalasi baru memakai 2 detik. Interval bisa diganti di select samping tombol refresh di top bar atau di **Konfigurasi → Koneksi**; keduanya menyimpan ke konfigurasi console. Halaman yang sudah terbuka di PC atau tablet lain mengikuti interval baru itu pada jawaban berikutnya, termasuk select di top bar-nya.
- Console membaca Data Out satu kali per interval untuk semua penampil. PC atau tablet lain yang membuka console mendapat hasil pembacaan yang sama, jadi jumlah penampil tidak menambah beban ke node atau link PPP. Pembacaan dipakai bersama selama interval refresh (minimal 1 detik) sejak node dibaca. Halaman yang dibuka menyesuaikan jadwal poll-nya dengan pembacaan bersama itu, juga poll pertamanya, sehingga halaman yang baru dibuka langsung meminta pembacaan berikutnya saat jatuh tempo.
- `settings.json` (4,7 kB dari sekitar 8 kB satu pembacaan) dipakai ulang paling lama 30 detik. File itu dibaca lagi lebih cepat bila node restart, bila nilai `status.json` yang mengikuti pengaturan berubah, atau bila CSV/XML DoA menunjukkan frekuensi VFO, jumlah VFO, susunan antena, atau station lain. Setelah console di-restart, pembacaan pertama selalu membaca `settings.json`.
- Umur "Dibaca … lalu" di top bar dan status SNAPSHOT dihitung sejak node dibaca, bukan sejak browser menerima jawaban; begitu juga jendela segar DoA dan umur di HUD Dashboard (umur DoA saat jawaban tiba, termasuk lama pembacaan bersama itu disimpan console).
- Data DoA dianggap segar 5 detik setelah dibaca. Dengan Manual atau interval di atas 5 detik, bearing dan kurva polar kosong di antara pembacaan; form Konfigurasi memberi peringatan untuk pilihan itu.
- Pembacaan yang sedang berjalan tidak dibatalkan oleh tick berikutnya. Layar mempertahankan data terakhir selama refresh, sehingga tidak berkedip setiap poll.
- "Membaca…" hanya muncul pada pembacaan pertama atau pembacaan yang lebih lama dari 1 detik.
- Tombol Refresh dan tombol `R` tetap bisa dipakai saat pembacaan berjalan; keduanya menunggu pembacaan itu lalu meminta pembacaan baru. Console membaca node lagi hanya bila pembacaan terakhir sudah berumur minimal 1 detik; sebelum itu Refresh mendapat pembacaan yang sama.
- Data Out yang tidak terjangkau atau macet tampil `UNAVAILABLE` dalam sekitar 4 detik.

### Sumber data Dashboard

Dashboard, peta, polar, readout DoA, dan chip DATA/DOA memakai **MQTT** dulu dan **Data Out (cadangan)** hanya bila MQTT tidak segar. Console memutuskannya di server untuk setiap jawaban `/api/snapshot`; kontrak lengkapnya di `docs/MQTT_KONTRAK.md` bagian 8.

- **MQTT segar** berarti `telemetry/health` RDF Node dari sesi `state` sekarang diterima paling lama 8 detik lalu, dengan `q` yang maju dan `daq=1`. MQTT tersambung saja tidak cukup. Health dengan `daq` 0 atau 2 membuat console beralih ke Data Out, yang lalu menunjukkan detail DAQ-nya.
- **Dari MQTT**: θ₀, frekuensi, PAPR, dan power dari `telemetry/doa` `ok=1` (LIVE), vektor 360 bin dari `telemetry/angular` `flags=63` (LIVE) dengan frekuensi dan revisi yang sama, dan status DAQ dari health. Frame Angular dari record yang lebih lama (edge mengirim DoA tiap 1 detik, Angular tiap 4 detik) hanya dipakai selama puncaknya paling jauh 3° dari θ₀ DoA terbaru; lebih jauh, DOA `INCOMPLETE` sampai frame berikutnya, jadi bearing dan kurva tidak pernah menunjuk ke arah berbeda. θ₀ hanya dihitung bila `capabilities.angle` sesi ini `theta_mirror` atau `csv_native`.
- **DoA UNVERIFIED tidak pernah tampil sebagai bearing.** `ok=0`, Angular `flags` selain 63, dan kedua topik diagnostik membuat chip DOA `UNVERIFIED` dan HUD menulis "DoA lewat MQTT UNVERIFIED di RDF-SDR"; nilainya tetap terlihat di **Diagnostik DoA** (kartu DoA MQTT) dan **Monitor Pesan**. Dengan konfigurasi edge default (authority dan sudut belum diverifikasi) Dashboard tidak menampilkan bearing selama MQTT segar. Profile stream `control` tidak mengirim Angular, sehingga DOA `INCOMPLETE`; pakai `balanced` atau `graph_u8`.
- **Yang tidak dibawa MQTT** (posisi stasiun dari `doa.xml`, field `settings.json` untuk kartu node, ikuti-frekuensi, compass offset dan read-back Kontrol, serta ADC overdrive dan SNR) datang dari pembacaan ringan Data Out: `status.json`, `settings.json`, dan `doa.xml`, sekitar 5,8 kB tiap 30 detik (~0,2 kB/s), dibanding ~1,9 kB/s untuk Data Out penuh dengan interval 2 detik di link T900 (~5,6 kB/s). Pembacaan ringan juga jalan segera bila revisi konfigurasi node (`state.cfg`) berubah (lalu `settings.json` dibaca ulang, bukan salinan lama), dan saat Kontrol menekan **Cek ulang**. Hasilnya berlaku 65 detik; yang lebih tua (misalnya dari sebelum MQTT sempat basi) dianggap belum dibaca. Tombol Refresh (`R`) tidak membaca Data Out selama MQTT segar.
- **Data Out mati, MQTT sehat**: bearing tetap tampil dengan badge `MQTT`; kartu node tanpa frekuensi dan gain, compass offset memakai nilai Data Out terakhir yang diketahui (paling lama 90 detik, setelah itu "diasumsikan"), dan peta mempertahankan posisi terakhir.
- **MQTT basi, Data Out sehat**: jawaban berikutnya dibaca penuh dari Data Out dengan badge `Data Out (cadangan)`, persis seperti sebelum ada MQTT. Tidak keduanya: `tidak ada`.
- Gate publikasi tetap `BLOCKED` dan state tidak pernah `LIVE` dengan kedua sumber.

### Dashboard

- **Bearing dari utara** adalah bearing geografis searah jarum jam: (360 − θ₀ + compass_offset) mod 360. θ₀ mentah dari MQTT atau Data Out (sudut array berlawanan jarum jam) tampil di bawahnya di HUD, bersama Puncak (display peak), umur data, dan offset beserta sumbernya; badge di HUD menyebut sumber datanya (`MQTT` atau `Data Out (cadangan)`):
  - `DATA_OUT`;
  - `DATA_OUT · LOCAL AXIS` bila plot KrakenSDR bertipe Linear;
  - `MANUAL`;
  - "DATA_OUT terakhir diketahui N dtk": `settings.json` gagal dibaca dan console memakai pengaturan terakhir dari node yang sama, paling lama 90 detik;
  - "diasumsikan, hanya referensi" (amber) bila offset tidak dilaporkan.
- **Puncak** (display peak) menyebut sumbunya di tooltip (sumbu Compass atau sumbu θ₀ Polar).
- **Gate publikasi** tidak lagi tampil di panel Dashboard; lihat chip PUBLIKASI di top bar. Nilainya selalu `BLOCKED` di Ground Console, juga saat bearing tampil normal, dan tooltip-nya menyebut reason teratas, biasanya "Sumber otoritas DoA belum dipilih". Console ini tidak memilih sumber otoritas DoA dan tidak pernah memublikasikan bearing, jadi `BLOCKED` di sini bukan tanda data rusak; bearing yang tampil tetap bisa dibaca sebagai observasi. Penjelasan lengkap ada di bagian Kesehatan Sistem di bawah.
- **Bearing disembunyikan bila data tidak bisa dipercaya.** Bearing dan display peak menjadi "—", kurva polar dan overlay peta dikosongkan, dan penyebabnya disebutkan bila:
  - DAQ sync tidak PASS (FAIL atau UNKNOWN) atau ADC overdrive dilaporkan. Status menjadi `DEGRADED`, dan strip menampilkan DATA DEGRADED dan DOA DEGRADED.
  - CSV/XML `CONFLICT`.
  - Satu view hilang atau tidak bisa diparse.
  - Node berhenti diperbarui.
  - Record sudah tua, atau jendela lokal 5 detik habis.

  Satu aturan yang sama dipakai untuk readout, polar, dan peta.
- **Node beku.** Bila DSP node berhenti tetapi port 8081 tetap melayani, data menjadi `STALE` sekitar 5 detik kemudian. Setelah sekitar 10 detik tanpa perubahan timestamp, uptime, atau frame index, reason `NODE_CLOCK_STALLED` muncul dan readout menulis "Output node berhenti". Deteksi butuh minimal dua pembacaan, sehingga node yang sudah beku sebelum console start baru terdeteksi setelah pembacaan berikutnya.
- **Posisi stasiun saat celah freshness.** Kartu node dan marker peta mempertahankan posisi Data Out live terakhir dengan label "POSISI STASIUN TERAKHIR · STALE". Posisi referensi ("REFERENSI SAJA · BUKAN GPS LIVE") baru dipakai bila `status.json` yang segar melaporkan GPS tanpa fix.
- **Peta.**
  - Overlay memakai bearing geografis yang sama dengan pembacaan Compass dan display peak. Hover menampilkan bearing, bin θ₀, dan dB.
  - Bila offset kompas tidak dilaporkan, muncul pemberitahuan REFERENSI.
  - **Skala dB** overlay default Auto (dari vektor). Min, Max, dan Noise threshold (Lapisan → Lanjutan) hanya berlaku di mode Manual, dan legend memberi peringatan bila skala manual jenuh.
  - Field angka berlaku saat Enter atau saat field ditinggalkan; `Esc` membatalkan, dan nilai tidak valid ditolak dengan pesan di samping field.
  - Tile basemap selalu diambil dari console (`/api/tiles/<sumber>/<z>/<x>/<y>`). Console mencoba host upstream satu per satu (OSM: `tile.openstreetmap.de` dulu, lalu `tile.openstreetmap.org`), menyimpan tile di cache disk, dan menyajikan tile tersimpan tanpa jaringan. Bila tile area yang tampil tidak bisa diambil dan belum tersimpan, chip "BASEMAP TIDAK TERSEDIA · <gaya>" muncul, overlay tetap digambar di latar netral, dan peta mencoba lagi setiap 60 detik. Bila sebagian tile tampil (misalnya offline dan hanya sebagian area pernah tersimpan) sementara tile lain terus gagal, chip "BASEMAP SEBAGIAN · <gaya>" muncul; peta juga mencoba lagi setiap 60 detik dan chip hilang bila percobaan berikutnya tidak gagal lagi. Bila tampilan tidak lagi menggambar satu pun tile gaya itu (misalnya setelah menggeser peta offline ke area yang belum pernah tampil), chip kembali menjadi "BASEMAP TIDAK TERSEDIA · <gaya>". Gaya tidak diganti otomatis.
  - Tanpa WebGL2, setelah WebGL context hilang, atau bila worker MapLibre gagal, peta menampilkan pemberitahuan dan overlay kanvas sederhana. Crash di dalam peta hanya memengaruhi panel peta.
  - Kamera bertahan saat berpindah halaman. Peta membingkai ulang saat sumber posisi berubah (misalnya fix GPS nyata pertama datang) dan saat panel berubah ukuran, selama operator belum menggeser kamera. Panel yang melayang di atas peta dihitung sebagai padding, sehingga stasiun dibingkai di bagian peta yang terlihat.
- **Plot polar.**
  - Mode Polar menggambar θ₀ berlawanan jarum jam seperti plot Polar KrakenSDR. Mode Compass tetap north-up searah jarum jam. Pada offset 0 kedua mode menaruh lobe di tempat yang sama; hanya labelnya berbeda.
  - Skala radial otomatis mengikuti rentang data (misalnya 0–1,5 dB). Untuk rentang tetap, pilih Manual di **Polar → Atur → Skala dB**; Head Up saja tidak memaksa rentang manual.
  - Plot di dock tidak menampilkan modebar Plotly.
  - Teks status polar menyebut penyebabnya: CONFLICT, UNAVAILABLE, INCOMPLETE, STALE, atau DEGRADED.

### Kesehatan Sistem dan Diagnostik DoA

- **Kesehatan Sistem.**
  - Bilah halaman menampilkan `overall_state` dari collector, lalu chip **HTTP**, **Node**, dan **Progres**. Chip HTTP dihitung dari GET per resource pada pembacaan terakhir: `AVAILABLE` (keempat file menjawab), `PARTIAL`, `UNAVAILABLE`, `UNKNOWN`, atau `WAITING` sebelum pembacaan pertama. Peringatan "DATA LAMA" (EN: STALE EVIDENCE) hanya muncul bila pembacaan terakhir punya DoA segar yang kemudian kedaluwarsa.
  - **`UNVERIFIED` pada data sehat itu normal.** Collector menentukan `overall_state` berurutan: `UNAVAILABLE` (`status.json` tidak terbaca), `DEGRADED` (DAQ tidak PASS atau ADC overdrive), `INVALID` (tidak ada view DoA yang bisa diparse), `CONFLICT`, `STALE` (tidak ada view DoA yang segar), `INCOMPLETE` (CSV dan XML tidak bisa dibandingkan), lalu `UNVERIFIED` bila belum ada sumber otoritas DoA (`authority` = `none`) atau sudut kanonik belum disetujui. Ground Console selalu memanggil collector dengan `authority="none"` dan tanpa persetujuan sudut kanonik, dan tidak ada flag atau form console yang mengubahnya. Artinya `UNVERIFIED` adalah status terbaik yang bisa tampil: data terbaca, segar, dan CSV/XML konsisten, tetapi tidak ada keputusan yang menetapkan CSV atau XML sebagai sumber bearing resmi. `LIVE` tidak pernah tampil di console ini. Bila data lokal kedaluwarsa, headline berganti menjadi `STALE`.
  - **Karena itu PUBLIKASI selalu `BLOCKED`.** Gate publikasi (PUBLIKASI di strip dan kartu **Gate publikasi** di Diagnostik DoA) baru `READY` bila semua pemeriksaannya lolos. Pada data sehat ada tiga reason yang selalu muncul: `DOA_AUTHORITY_NOT_SELECTED` (Sumber otoritas DoA belum dipilih), `CANONICAL_ANGLE_NOT_CONFIGURED` (Konvensi sudut kanonik belum disetujui), dan `GROUND_CLOCK_UNVERIFIED` (Jam ground dan node belum diverifikasi; console tidak memverifikasi jam node, sehingga tile **Jam** di baris stat Kesehatan Sistem selalu `UNVERIFIED`). Di Diagnostik DoA, pemeriksaan Otoritas dipilih, Sudut kanonik siap, DoA terpilih fresh, dan Satuan terpilih valid tampil `BLOCKED`, Status node fresh tampil `NOT CONFIGURED`, dan di kartu Collector Otoritas bernilai `NONE` dan Kesiapan sudut `NOT CONFIGURED`. Memilih sumber otoritas dan menyetujui sudut kanonik adalah keputusan deployment di luar console ini, jadi status tersebut bukan kerusakan data atau node. Reason lain di luar ketiganya menunjukkan masalah nyata.
  - Baris stat menampilkan DAQ health (dengan jumlah frame hilang), sinkron (`x/3`), ADC overdrive (PASS, OVERDRIVE dengan file yang melaporkannya, atau UNKNOWN), SNR (native XML, tidak terkalibrasi), PAPR CSV/XML dalam dB, MQTT, dan Jam. PAPR bukan confidence 0–1.
  - Kartu **RDF-SDR** menampilkan status node (VALID/INVALID/UNAVAILABLE) dan Progres (`ADVANCING`, `UNCHANGED` dengan umurnya, `STALLED`, `FIRST_SAMPLE`, `UNAVAILABLE`, `UNTRACKED`), indeks frame, frame hilang, flag sinkron, sumber noise, dan status GPS. Tooltip Progres hanya muncul bila ada penyebab: counter yang berhenti atau mundur, atau `status.json` yang tidak bisa dipakai. ADC overdrive (dengan mask kanal), sync gagal, dan node beku tampil sebagai peringatan di kartu ini. Kartu **Tampilan DoA** menampilkan CSV dan XML dengan statusnya dan umurnya saat dibaca.
  - Kartu **Data Out** menampilkan setiap GET (`/status.json`, `/settings.json`, `/DOA_value.html`, `/doa.xml`) dengan kode HTTP atau jenis error (Connection refused, Timed out, Skipped, Deadline exceeded, dan seterusnya) dan waktunya; jumlah percobaan tampil bila lebih dari satu. `settings.json` yang dipakai ulang dari pembacaan sebelumnya tampil `REUSED` dengan umurnya. Kepala kartu membandingkan waktu koleksi dengan anggaran 4 detik (misalnya `372 ms / 4.0 dtk`). Peringatan `COLLECTION_DEADLINE_EXCEEDED` muncul bila pembacaan dihentikan di batas waktu, dan peringatan `status.json` bila file lain dilewati karena `status.json` tidak terjangkau. Kartu **Monitor MQTT** menampilkan broker, transport, publish, pesan terakhir, jumlah pesan, dan pesan tidak valid.
- **Diagnostik DoA.**
  - Reason gate diurutkan dari yang paling bisa ditindaklanjuti, masing-masing dengan kode mentahnya. Reason baru: `NODE_CLOCK_STALLED`, `ADC_OVERDRIVE`, `COLLECTION_DEADLINE_EXCEEDED`, `CSV_VIEW_UNAVAILABLE`, `XML_VIEW_UNAVAILABLE`, `NATIVE_ANGLE_INVALID`, `ANGULAR_PEAK_ANGLE_MISMATCH` (puncak vektor CSV berjarak lebih dari 3° dari θ₀), dan `NATIVE_ANGLE_UNCHECKED` (CSV dan XML berasal dari frame berbeda, sehingga sudutnya tidak dicek silang).
  - Relasi CSV/XML tampil sebagai EQUAL, NOT CHECKED, NOT COMPARABLE, CONFLICT, atau ANGLE INVALID, beserta relasi frame, selisih timestamp, jarak, dan toleransi.
  - Dengan Output VFO = ALL di KrakenSDR, baris CSV dipilih berdasarkan frekuensi XML, dan baris VFO lain tampil di tabel tanpa vektor. Format data "Kerberos App" tidak didukung dan mendapat error yang jelas.
  - Effective config menampilkan semua setting yang diizinkan.

### Konfigurasi

- Kartu tersusun dalam dua kolom setinggi isinya masing-masing: **Koneksi & refresh**, **Monitor MQTT** dan **Akses LAN** di kiri, **GPS & Kompas** dan **Branding & admin** di kanan, lalu **Patch dry-run** selebar halaman. Bilah bagian (Koneksi, MQTT, Akses LAN, GPS & Kompas, Branding, Dry-run) mengikuti urutan itu. Pada lebar 1024–1279 px Koneksi dan MQTT berdampingan dan kartu lain selebar halaman; di bawah 1024 px semua kartu satu kolom dengan urutan yang sama.
- Enter di bagian mana pun men-submit bagian itu.
- URL Data Out disimpan tanpa garis miring di akhir. Port MQTT harus bilangan bulat 1–65535.
- **Transport MQTT** (WebSocket default, atau TCP) harus sama dengan listener broker. **Path WebSocket** (default `/mqtt`) hanya dipakai dengan WebSocket. Mengubah host, port, transport, atau path me-restart monitor dan mereset penghitungnya.
- Dry-run config patch hanya meminta nilai field, dengan aturan yang sama seperti Kontrol. Hasilnya pratinjau envelope `config.patch` yang akan dikirim saat itu: topik, `sid` dan `base_rev` dari `state` RDF-SDR terakhir (`—` bila belum ada), field, dan masa berlaku 15 detik. Dry-run tidak mengirim apa pun; perubahan nyata dikirim lewat Kontrol di Dashboard.
- Login admin di sini juga membuka Kontrol di Dashboard (sesi yang sama, 30 menit). Chip **PATCH** di bilah halaman bernilai `ADMIN ONLY`.
- **Akses LAN** menyalakan tampilan LAN lihat-saja (lihat [Tampilan LAN](#tampilan-lan-lihat-saja)): **Lihat dari LAN**, **Port**, **Alamat bind**, **Klien yang diizinkan**, dan statusnya (`OPEN` dengan alamatnya, atau `CLOSED` dengan alasannya). Mengubahnya butuh admin; tanpa admin isian terkunci.
- Logo PNG boleh grayscale, RGB, RGBA, atau palette, 8/16-bit, interlaced, maksimal 256 KiB dan 4096 × 4096 px. Logo diperiksa di browser sebelum di-stage.
- Pilihan sumber GPS dan Compass disimpan di console dan dipulihkan setelah reload, di browser lain, dan setelah console di-restart. Masing-masing punya tombol restore default sendiri. Offset kompas manual berkisar −360 sampai 360, dan juga bisa diatur dari **Polar → Atur** di Dashboard.
- Bila konfigurasi console tidak bisa dibaca, halaman menampilkan "Konfigurasi console tidak tersedia … Dicoba ulang otomatis" tanpa form. Console mencoba lagi sendiri (1, 2, 4, 8, lalu setiap 15 detik).

### Monitor Pesan

- Bilah halaman menampilkan chip koneksi, tag transport (`TCP` atau `WS`), `SYNTHETIC` bila ada payload sintetis, sakelar sdr/v1 | RDF Node, **Muat ulang**, dan **Sambungkan ulang**. Kartu **Koneksi** menampilkan broker, transport (`TCP` atau `WS /path`), topik terakhir (disamarkan), dan publish.
- Baris metrik: Diterima, Valid, Tidak valid, Byte, Latensi terakhir, Pesan terakhir. Latensi terakhir hanya menghitung pesan live. Di ponsel baris ini dua kolom.
- Tabel per kind:
  - **Count** adalah jumlah pesan per kind sejak monitor start.
  - **Age** menghitung naik setiap detik sejak console menerima pesan. Badge `STALE` muncul setelah doa 5 detik, nav 5 detik, health 8 detik, dan state/config_reported 65 detik. Ini ambang tampilan, bukan gate.
  - **Contract** bernilai `VALID`, `INVALID`, atau `CLEARED` (publisher menghapus nilai retained).
  - Badge `RETAINED` berarti pesan di-replay broker saat subscribe; pesan seperti itu dinilai dari timestamp-nya sendiri dan tidak punya latency.
  - Payload status menampilkan flag node apa adanya (`valid`, `doa_valid`, `settings_valid`), state health beserta reason, dan availability `ONLINE`/`OFFLINE`.
  - Badge `SYNTHETIC` muncul untuk payload dengan `source: "synthetic"`.
- **Sambungkan ulang** selalu membuka sesi subscriber baru dengan pengaturan broker tersimpan; penghitung dan record terakhir mulai dari nol. Tanpa tombol ini, monitor mencoba lagi sendiri dalam sekitar 10 detik.
- Client id MQTT sekarang `groundconsole` plus 10 karakter hex acak per monitor, sehingga dua console bisa memakai satu broker. ACL atau log broker yang memakai id lama `ground-console-monitor` perlu diperbarui.
- Status MQTT diperbarui sendiri setiap 2 detik di Monitor Pesan dan Kesehatan Sistem, dan setiap 5 detik di halaman lain.
- Tampilan **RDF Node** dijelaskan di bagian [RDF Node](#rdf-node) di bawah.

### Shortcut keyboard

- `1`–`7` membuka halaman sesuai urutan menu, `R` me-refresh. Shortcut juga bekerja saat fokus berada di dalam Receiver, kecuali saat mengetik di field teks atau angka.
- Shortcut tetap bekerja setelah mengklik checkbox atau radio button. Selama fokus berada di slider (misalnya Head Up atau opasitas overlay), shortcut tidak aktif, sehingga tombol angka tidak berpindah halaman. Di menu basemap yang terbuka, tombol angka juga tidak berpindah halaman; `R` tetap me-refresh.
- Shortcut halaman menutup menu halaman yang terbuka. `Esc`, klik di luar menu, atau Tab keluar dari menu juga menutupnya.
- "Skip to workspace" memindahkan fokus ke isi halaman tanpa mengganti halaman.

### Console di-restart atau di-build ulang

Kode halaman, termasuk peta, diambil di latar belakang tidak lama setelah console dimuat, sehingga restart berikutnya tidak merusak navigasi. Bila sebuah halaman atau peta tetap gagal dimuat, hanya area itu yang menampilkan "Halaman ini gagal dimuat" atau pesan peta dengan tombol **Muat ulang console**. Muat ulang menghentikan sesi Receiver yang sedang berjalan. Setelah `git pull`, build ulang dulu (lihat [Setelah `git pull`](#setelah-git-pull)); tanpa itu console tetap menyajikan UI lama.

## MQTT staging, opsional

MQTT adalah sumber utama Dashboard, peta, dan polar; tanpa MQTT yang segar console memakai Data Out (cadangan), lihat [Sumber data Dashboard](#sumber-data-dashboard). Spektrum dan simulasi tidak memerlukan MQTT; Kontrol membutuhkannya. Ground Console memakai satu koneksi ke broker yang dikonfigurasi. Koneksi itu berlangganan topik `sdr/v1/uav-01` dan topik RDF Node di `sdr/v2/uav-01` sekaligus, dan hanya publish perintah Kontrol (admin) ke `sdr/v2/uav-01/cmd/config/patch` dan `cmd/config/get`. `paho-mqtt` diperlukan untuk monitor MQTT, Kontrol, dan synthetic publisher.

Koneksi MQTT default adalah `10.90.0.1:9001`, WebSocket, path `/mqtt`. Host menerima literal IPv4/IPv6 apa pun atau `localhost`, bukan nama DNS; masukkan IPv6 tanpa kurung siku. Ground Console membuka koneksi keluar ke broker, tetapi HTTP Ground Console tetap bind ke loopback. Monitor tidak punya opsi username, password, atau TLS untuk TCP maupun WebSocket, sehingga payload, termasuk patch dari Kontrol, melintas tanpa enkripsi. Gunakan hanya broker dan jaringan tepercaya; jangan kirim payload rahasia melalui koneksi ini. Karena itu console tidak bisa tersambung ke broker LAN `tools/mqtt_lan_stage.conf` yang mewajibkan TLS dan password.

Monitor memakai MQTTv5 dan satu konfigurasi broker bersama: host, port, transport, dan WebSocket path berlaku untuk kedua root topik. Filter `sdr/v1/uav-01/#` tetap ada sampai jalur lama dihapus; RDF Node memakai prefix `sdr/v2/uav-01/` dan 12 suffix dari kontrak edge (`docs/MQTT_KONTRAK.md`): `state`, `capabilities`, `availability`, `telemetry/health`, `telemetry/health/detail`, `telemetry/doa`, `telemetry/diagnostic/doa`, `telemetry/angular`, `telemetry/diagnostic/angular`, `settings/reported`, `ack/config`, dan `ack/operation`. `config/reported` bukan bagian kontrak dan tidak di-subscribe, jadi nilai retained sisa di broker tidak dibaca. Status `READY` menunggu SUBACK berhasil untuk seluruh filter bersama. Parser dan snapshot kedua root tetap terpisah agar validasi satu schema tidak mengubah statistik schema lain.

Konfigurasi lama `rdf_node_mqtt` tidak digunakan atau dimigrasikan; field itu hilang saat konfigurasi disimpan berikutnya. Atur endpoint kedua keluarga topic melalui **Konfigurasi → MQTT**.

### Broker staging lokal

Konfigurasi broker staging tersedia di `tools/mqtt_stage4.conf`: MQTT/TCP di `127.0.0.1:18884`, bukan WebSocket. Jalankan broker:

```sh
mosquitto -c tools/mqtt_stage4.conf
```

Jalankan Ground Console dengan transport TCP dan file konfigurasi staging terpisah, agar konfigurasi koneksi utama tidak tertimpa:

```sh
.venv/bin/python tools/ground_console.py \
  --bind 127.0.0.1 \
  --port 8787 \
  --mqtt-host 127.0.0.1 \
  --mqtt-port 18884 \
  --mqtt-transport tcp \
  --config-path .config/staging-console.json
```

Windows PowerShell:

```powershell
.\.venv\Scripts\python.exe tools\ground_console.py --bind 127.0.0.1 --port 8787 --mqtt-host 127.0.0.1 --mqtt-port 18884 --mqtt-transport tcp --config-path .config\staging-console.json
```

Folder `.config/` di root repository diabaikan Git.

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

Semua payload synthetic publisher membawa `source: "synthetic"` dan tampil dengan badge `SYNTHETIC`. State dan config retained-nya dihapus saat publisher selesai; tambahkan `--keep-retained` bila ingin menyimpannya di broker.

### Menguji Kontrol di broker staging

Broker `tools/mqtt_stage4.conf` menerima koneksi anonim di loopback, jadi console bisa publish ke sana. Kontrol butuh RDF Node (edge) yang tersambung ke broker yang sama dan mengirim `state` dan `telemetry/health`; agent bawaan repo ini dan synthetic publisher memakai topik lama dan tidak menjawab Kontrol. Tanpa RDF Node, Kirim nonaktif ("Kirim butuh state RDF-SDR lewat MQTT"). Listener `mqtt_stage4.conf` tidak memakai TLS, jadi RDF Node menjawab **Baca settings** dengan `TLS_REQUIRED_FOR_SETTINGS_REPORT`. Tanpa perangkat, `tools/test_mqtt_config_patch.py` dan `tools/test_rdf_node_commands.py` menjalankan alur Kontrol dengan payload yang dinilai kode edge sendiri (`tools/fixtures/rdf-node/commands.json`).

### RDF Node

Pastikan `paho-mqtt==2.1.0` terpasang di virtual environment yang sama dengan Ground Console; jika dependency tidak tersedia, status monitor melaporkan error tanpa mematikan Ground Console.

Untuk RDF Node, console berlangganan 12 filter di atas. Satu-satunya publish console adalah perintah Kontrol ke `sdr/v2/uav-01/cmd/config/patch` dan `cmd/config/get` (lihat [Kirim ke RDF-SDR dan Kontrol](#kirim-ke-rdf-sdr-dan-kontrol)). RDF Node tidak punya `config/reported`; Kontrol membaca nilai dari `settings/reported` (jawaban `config.get`, hanya bila RDF-SDR tersambung ke broker lewat TLS) atau dari Data Out (cadangan).

Kontrak per topik (field wajib, QoS, retained, expiry, batas freshness, dan aturan status console) ada di `docs/MQTT_KONTRAK.md`, diambil dari edge commit `8691ad0` (rilis `1.0.0-20261013194717`). Field edge yang lebih baru, misalnya field PPP di `telemetry/health/detail`, diterima tetapi tidak wajib.

Tampilan **RDF Node** ada di halaman Monitor Pesan:

- Memakai koneksi broker yang sama dengan `sdr/v1`, tetapi penghitungnya terpisah. Dibaca setiap 2 detik hanya selama tampilan ini terbuka.
- `READY` berarti seluruh SUBACK untuk filter bersama berhasil, bukan DAQ sehat. Availability adalah petunjuk koneksi, bukan health.
- Kartu **Node** berisi nilai terakhir yang diterima, per bagian: Sesi (`sid`, `cfg`, run, profile, clock dari `state`), Health (segar 8 detik), Detail health, DoA (`LIVE` hanya untuk `ok=1` dengan health segar `daq=1`), DoA RAW (`ok=0`, selalu `UNVERIFIED`), DoA doa.xml (diagnostik), Angular (`LIVE` hanya untuk `flags=63`), Kandidat Angular (trust-only atau diagnostik, `UNVERIFIED`, dengan alasannya), Kapabilitas, Ketersediaan, dan Settings (hanya setelah `config.get`; teks `settings.json` tetap di server). Pesan yang ditolak tidak pernah masuk kartu ini.
- Kartu **ACK** menampilkan ACK terakhir per perintah dengan status jurnal edge, tag `FINAL`, dan kode error edge (sampai 64 karakter, misalnya `CENTER_CHANGE_REQUIRES_VFO0_TARGET`). `challenge` dari ACK prepare tidak disimpan.
- Tabel topik menampilkan count, status pesan terakhir (`LIVE`, `UNVERIFIED`, `FRESH`, `CONTEXT`, `STALE`, `INCONSISTENT`, `IGNORED`, `INVALID`, `UNAVAILABLE` bila belum pernah diterima, atau `CLEARED` bila publisher menghapus nilai retained), umur, RETAINED/LIVE, ringkasan field, dan kode penolakan beserta nama field (misalnya `INVALID_FIELD a`).
- Nilai arah DoA dan Angular (`a`, `raw_doa_deg`, `peak_index`), di tabel topik maupun kartu Node, hanya tampil selama `LIVE` atau `UNVERIFIED`; selain itu tertulis "nilai disembunyikan". Tiap topik Angular menjadi `STALE` 10 detik setelah waktu sumber frame terakhirnya sendiri. `LIVE`, `UNVERIFIED`, dan `FRESH` menjadi `STALE` bila halaman tidak membaca state baru selama 5 detik.
- `IGNORED NO_SESSION` berarti `state` belum diterima; edge mengirimnya retained dan paling lambat tiap 60 detik. `STALE SOURCE_TIMESTAMP_NOT_FRESH` di semua telemetry biasanya berarti jam Raspberry dan groundstation berbeda lebih dari batasnya; periksa sinkronisasi jam.
- Dashboard memakai DoA LIVE, Angular LIVE, dan health dari sini selama MQTT segar (lihat [Sumber data Dashboard](#sumber-data-dashboard)); publication gate dan simulasi Dashboard tidak berubah.

Broker TLS, PPP/T900, dan MQTT production tidak disiapkan oleh quickstart ini. Contoh payload dan fixture lokal bukan bukti kompatibilitas perangkat atau acceptance hardware.

## Instalasi Linux: Docker, rilis tar dan service

Bagian ini untuk komputer ground station **Linux** yang hanya memakai console: tidak perlu Node.js atau build, console jalan di background, hidup lagi setelah reboot, dan semua pengaturan tersimpan otomatis. Ada tiga cara, pilih salah satu: Docker dari image GHCR (paling mudah di-update), Docker yang di-build dari rilis atau repository, atau rilis tar dengan `install.sh`. Image GHCR dan rilis tar bisa di-update otomatis tanpa login GitHub. Keduanya tetap bind ke `127.0.0.1:8787`, jadi console hanya bisa dibuka dari komputer itu sendiri: `http://127.0.0.1:8787/` di Chromium atau Chrome. Tablet dan komputer lain di LAN hanya bisa melihat, lewat [tampilan LAN](#tampilan-lan-lihat-saja) yang dinyalakan admin. Detail lengkap ada di `packaging/console/README.md`.

### Membuat rilis tar

Di mesin build (repository dengan submodule `vendor/BrowSDR`, Node.js dan Python):

```sh
python3 tools/make_release.py              # npm ci + npm run build:all, lalu kedua tarball
python3 tools/make_release.py --skip-build # pakai frontend/dist yang sudah di-build
cd dist/release && sha256sum -c SHA256SUMS
```

Hasilnya di `dist/release/`: `sdr-doa-ground-console-<VERSI>-linux.tar.gz` (console, frontend sudah di-build, installer, Dockerfile rilis, panduan), `sdr-doa-rdf-sdr-agent-<VERSI>.tar.gz` (agent RDF-SDR), `sdr-doa-docker` (script host Docker) dan `SHA256SUMS`. Build lokal ini untuk uji coba atau instalasi tanpa internet; rilis untuk operator dibuat di GitHub (bagian berikut). Versi diambil dari file `VERSION` di root repository. `--with-wheels` ikut membawa wheel `paho-mqtt` dan `tzdata` untuk instalasi tanpa internet. Build penuh menolak berjalan bila ada perubahan yang belum di-commit pada input build.

### Rilis di GitHub

Rilis resmi dibuat GitHub Actions (`.github/workflows/release.yml`), bukan dari build lokal:

1. Naikkan `VERSION` di `main` (misalnya `2.0.1`; prerelease `2.1.0-rc.1`; tanpa nol di depan dan tanpa `+build`), lalu merge ke `main`. Di commit yang sama ubah juga file yang menyebut versi itu, karena job `test` gagal bila salah satunya tertinggal:
   - setiap rilis: tag `image:` di `docker-compose.yml`, `docker-compose.release.yml` dan `docker-compose.agent.yml`, serta `sdr-doa-agent:<VERSI>` di `Dockerfile.agent`;
   - versi mayor baru (misalnya 3.0.0): juga `DEFAULT_CHANNEL` di `packaging/docker/sdr-doa-docker`, default `${SDR_DOA_IMAGE_TAG:-N}` di `docker-compose.ghcr.yml`, dan teks kanal `2` di bantuan script, komentar `docker-compose.ghcr.yml` serta dokumentasi ini (`--channel 2`, `install --channel 3`);
   - sebaiknya setiap rilis: digest `PYTHON_IMAGE` di job `images` (`.github/workflows/release.yml`), agar image membawa perbaikan keamanan Debian terbaru (`docker buildx imagetools inspect python:3.12-slim-bookworm`, salin `Digest` index-nya).
2. Push tag yang sama persis dengan `VERSION`: `git tag v2.0.1 && git push origin v2.0.1`. Atau buka **Actions > Release > Run workflow** di branch `main`; tag `v<VERSI>` dibuat otomatis bila belum ada.

Workflow menjalankan seluruh test (`ci.yml`), membangun tarball dengan `make_release.py --with-wheels`, lalu menerbitkan rilis `v<VERSI>` dengan empat aset: `sdr-doa-ground-console-<VERSI>-linux.tar.gz`, `sdr-doa-rdf-sdr-agent-<VERSI>.tar.gz`, `sdr-doa-docker` dan `SHA256SUMS`. Setelah rilis itu ada, dari tarball yang sama dibuat image `ghcr.io/sanadunt/sdr-doa-ground-console` (amd64, arm64) dan `ghcr.io/sanadunt/sdr-doa-rdf-sdr-agent` (amd64, arm64, armv7) dengan tag `<VERSI>`. Tag kanal `<MAYOR>.<MINOR>`, `<MAYOR>` dan `latest` lalu diarahkan ke image yang sama, masing-masing hanya bila belum ada rilis stabil lebih tinggi yang dicakupnya; rilis lama yang selesai belakangan, rerun tag lama, atau backport 2.0.z setelah 2.1.0 tidak pernah memundurkan `2` atau `latest` (backport juga tidak menjadi "Latest" di GitHub). Prerelease hanya mendapat `<VERSI>`. Image `<VERSI>` yang sudah ada dari commit yang sama tidak di-build ulang saat rerun, jadi host tidak di-restart untuk versi yang sama; input `force_images` di Run workflow memaksa build ulang. Tag yang tidak sama dengan `VERSION`, atau commit yang belum ada di `main`, menghentikan workflow dengan pesan yang menyebut sebabnya.

Aset rilis bisa diunduh tanpa login karena repository publik:

- aset yang namanya tetap, dari rilis terbaru: `https://github.com/sanadunt/sdr-doa-ground-control/releases/latest/download/sdr-doa-docker` dan `https://github.com/sanadunt/sdr-doa-ground-control/releases/latest/download/SHA256SUMS`;
- tarball, yang namanya memuat versi: `https://github.com/sanadunt/sdr-doa-ground-control/releases/download/v2.0.0/sdr-doa-ground-console-2.0.0-linux.tar.gz` (`latest/download/<aset>` juga bisa, asal versi di nama file memang versi terbaru).

**Sekali setelah rilis pertama**: GHCR bisa membuat package baru sebagai private. Bila job `images` memberi peringatan bahwa image tidak bisa di-pull tanpa login, buka GitHub > profil > **Packages** > `sdr-doa-ground-console` > **Package settings** > **Change visibility** > **Public**, lalu lakukan hal yang sama untuk `sdr-doa-rdf-sdr-agent`. Sebelum itu `docker pull` dari komputer lain ditolak (`denied` atau `unauthorized`). Rilis berikutnya tidak perlu langkah ini lagi.

**Siapa yang bisa menerbitkan**: update otomatis memasang apa pun yang diterbitkan repository ini, di setiap host dalam sehari (timer Docker berjalan sebagai root). Jadi setiap orang dengan akses write ke repository, dan setiap token dengan `contents:write` atau `packages:write`, bisa menjangkau semua host itu: tag dari commit yang belum di-review menjalankan `release.yml` versi commit itu, dan pemeriksaan tag di dalam repository tidak bisa mencegahnya. Pengaturan sekali di GitHub yang disarankan:

- akses write hanya untuk maintainer yang dipercaya, dengan 2FA;
- branch ruleset pada `main` yang mewajibkan pull request yang sudah di-review;
- tag ruleset pada `refs/tags/v*` yang membatasi create, update dan delete untuk pemilik saja. `GITHUB_TOKEN` bukan bypass actor, jadi langkah "Create the tag on main" pada Run workflow lalu ditolak; rilis dengan push tag sendiri, seperti yang disebut pesan error langkah itu;
- di **Package settings > Manage Actions access** kedua package, izinkan hanya repository ini dan jangan tambahkan user lain.

Image atau aset yang ditandatangani (cosign keyless atau `attest-build-provenance`, lalu diverifikasi `sdr-doa-docker`) adalah langkah terpisah untuk nanti.

### Docker dari image GHCR (tanpa build, update otomatis)

Setiap rilis GitHub (`v<VERSI>`) juga menerbitkan image publik `ghcr.io/sanadunt/sdr-doa-ground-console` (amd64, arm64) dan `ghcr.io/sanadunt/sdr-doa-rdf-sdr-agent` (amd64, arm64, armv7). Image publik bisa di-pull tanpa login GitHub, jadi update cukup `docker pull`. Script `sdr-doa-docker` (aset rilis, juga ada di tarball console sebagai `packaging/docker/sdr-doa-docker`) mengurus pemasangan, update, rollback, dan timer update harian. Update hanya butuh Docker Engine dengan Compose v2 (tanpa git, curl, Python, atau login GitHub); unduhan pertama butuh `curl` atau `wget`.

```sh
curl -fLO https://github.com/sanadunt/sdr-doa-ground-control/releases/latest/download/sdr-doa-docker
curl -fLO https://github.com/sanadunt/sdr-doa-ground-control/releases/latest/download/SHA256SUMS
# tanpa curl: wget https://github.com/sanadunt/sdr-doa-ground-control/releases/latest/download/sdr-doa-docker
#             wget https://github.com/sanadunt/sdr-doa-ground-control/releases/latest/download/SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS
sudo sh sdr-doa-docker install --auto-update   # /opt/sdr-doa-ground-console, update harian 03:30
sudo sdr-doa-docker status
sudo sdr-doa-docker update                     # update sekarang
sudo sdr-doa-docker rollback                   # kembali ke image sebelumnya
```

Semua perintah untuk instalasi di `/opt` pakai `sudo`: `.env` di sana milik root dengan mode 0600, dan tanpa `sudo` script berhenti dengan "cannot read ... run with sudo".

- **Kanal update**: `SDR_DOA_IMAGE_TAG` di `/opt/sdr-doa-ground-console/.env`. Bawaannya `2`, yaitu setiap rilis 2.x.y; `2.0` hanya 2.0.z; `2.0.0` tetap di rilis itu. Versi mayor baru hanya datang bila kanal diganti, misalnya `sudo sdr-doa-docker install --channel 3`. Port diatur dengan `--port` (`SDR_DOA_PORT`).
- **Mengubah `.env`**: `update` hanya mengganti image. Perubahan `.env` diterapkan dengan `cd /opt/sdr-doa-ground-console && sudo docker compose up -d` (atau `sudo sdr-doa-docker install` lagi). Kata sandi admin sebaiknya diatur dengan `sdr-doa-set-admin-password` (lihat di bawah; disimpan di `/data/.env` di volume). Bila `SDR_DOA_ADMIN_PASSWORD` atau `SDR_DOA_SEED_*` tetap ditulis di `.env`, bungkus nilainya dengan tanda kutip tunggal (`SDR_DOA_ADMIN_PASSWORD='Xk9$q2!aB'`): docker compose mengganti `$nama` di nilai tanpa kutip atau berkutip ganda, sehingga console menerima kata sandi lain atau kosong (kosong menonaktifkan login admin). `install`, `update` dan `status` memberi peringatan (hanya nama variabel) bila ada `$` di luar kutip tunggal. Hanya nilai dari `.env` yang dipakai; nilai variabel itu di shell diabaikan.
- **Update**: `update` mem-pull tag kanal. Bila image-nya berubah, container dibuat ulang lalu ditunggu sampai healthcheck `healthy` (paling lama 180 detik). Bila image itu gagal (unhealthy, berhenti, atau restart terus), image sebelumnya dipasang lagi dan image yang gagal dicatat di `.bad-images`, sehingga update otomatis melewatinya sampai ada image lain. Gagal karena hal lain (error `docker compose up`, disk penuh, host lambat sampai 180 detik habis) juga dikembalikan, tetapi tidak dicatat, jadi update berikutnya mencoba lagi. Image sebelumnya disimpan dengan tag `sdr-doa-previous`, yang lebih lama dihapus. Bila container dari image kanal ternyata tidak sehat (misalnya update terputus karena listrik padam), `update` berikutnya kembali ke `sdr-doa-previous`. Image yang versinya lebih lama dari yang sedang jalan dilewati update otomatis; `sudo sdr-doa-docker update` menanyakannya di terminal, dan `install --channel` memasangnya. `update --check` hanya memberi tahu apakah ada image baru; tanpa plugin `docker buildx`, `--check` mem-pull image untuk membandingkannya (container dan tag yang jalan tetap).
- **Rekaman dan pindai Receiver**: selama Receiver merekam audio atau mengarsipkan pindai, update otomatis ditunda (`deferred: Receiver recording or scan active` di `update.log`) dan dicoba lagi pada jadwal berikutnya; setelah 7 hari tertunda terus, update tetap dijalankan. `sudo sdr-doa-docker update` di terminal menanyakannya dulu; tanpa terminal butuh `--yes`.
- **Update otomatis**: `sudo sdr-doa-docker auto-update on --time 03:30` memasang `sdr-doa-docker-update.timer` (harian, ditambah acak sampai 15 menit, menyusul bila komputer mati pada jam itu); `auto-update off` dan `auto-update status`. Satu host hanya punya satu timer: `auto-update on` untuk instalasi kedua (misalnya agent di samping console) ditolak, kecuali dengan `--force`, yang memindahkan timer ke instalasi itu. Timer root hanya menjalankan salinan script di `/usr/local/bin` dan hanya untuk direktori yang dimiliki root dan tidak bisa ditulis user lain; untuk instalasi milik user (misalnya rootless Docker di `~/sdr-doa-ground-console`), `sdr-doa-docker auto-update on` tanpa sudo mencetak baris crontab user itu. Tanpa systemd, perintah itu mencetak baris cron. Setiap langkah tercatat di `update.log`. Container yang di-stop manual tidak dinyalakan oleh update otomatis.
- **Data**: nama project compose dan volume sama dengan `docker-compose.yml` (`sdr-doa-ground-console`, `sdr-doa-data`), jadi console yang sebelumnya di-build dari repository atau dari rilis tetap memakai datanya setelah pindah ke image GHCR. Pengaturan di `.env` lama (di sebelah `docker-compose.yml`) tidak ikut pindah: salin baris `SDR_DOA_ADMIN_PASSWORD`, `SDR_DOA_PORT` dan `SDR_DOA_SEED_*` dari sana ke `/opt/sdr-doa-ground-console/.env` (atau pakai `--port N`), lalu `cd /opt/sdr-doa-ground-console && sudo docker compose up -d`. Setelah itu jangan jalankan `docker compose` lagi di direktori lama: project-nya sama, jadi `docker compose up -d --build` di sana mengembalikan console ke build lokal.
- **Kata sandi admin**: `cd /opt/sdr-doa-ground-console && sudo docker compose exec console sdr-doa-set-admin-password && sudo docker compose restart console`.
- **Tanpa script**: `docker-compose.ghcr.yml` (di repository dan tarball console) berisi compose yang sama; `docker compose -f docker-compose.ghcr.yml pull` lalu `docker compose -f docker-compose.ghcr.yml up -d`, tanpa tunggu healthcheck dan rollback.
- **Agent RDF-SDR**: `sudo sh sdr-doa-docker install --agent` memasang agent di `/opt/sdr-doa-agent` dengan pengaturan di `agent.env`; `--enable-config` me-mount `/home/doasdr/doasdr/_share` (`--share-dir`) dan menjalankan agent sebagai pemiliknya. Langkahnya ada di [Agent RDF-SDR](#agent-rdf-sdr-raspberry).
- **Script-nya sendiri** tidak meng-update dirinya. Untuk versi script yang lebih baru, unduh lagi `sdr-doa-docker` dari rilis terbaru dan jalankan `sudo sh sdr-doa-docker install` (pengaturan di `.env` tetap).

### Docker

Butuh Docker Engine dan Compose v2 di Linux. Console memakai `network_mode: host`: console bind ke `127.0.0.1` dan menolak alamat lain, dan dengan network host loopback itu adalah loopback komputer ini. Tampilan LAN, bila dinyalakan, juga langsung memakai network host. Jangan ganti ke network bridge dengan `ports:`. Docker Desktop di macOS/Windows tidak didukung.

```sh
# dari rilis (tanpa Node.js)
tar -xzf sdr-doa-ground-console-2.0.0-linux.tar.gz
cd sdr-doa-ground-console-2.0.0-linux
docker compose up -d --build

# atau dari clone repository biasa (bukan worktree), build frontend di dalam image
git submodule update --init --recursive
docker compose up -d --build
```

- **Data**: semua yang disimpan console ada di volume `sdr-doa-ground-console_sdr-doa-data`, di-mount sebagai `/data`. Volume tetap ada saat container di-restart, dibuat ulang, atau di-upgrade.
- **Kata sandi admin**: simpan di volume dengan `docker compose exec console sdr-doa-set-admin-password` lalu `docker compose restart console`. Bisa juga lewat `SDR_DOA_ADMIN_PASSWORD` di file `.env` di sebelah `docker-compose.yml`, dengan nilai dalam kutip tunggal bila ada `$` (docker compose mengganti `$nama` di nilai lain); environment menang atas `/data/.env`. Tanpa keduanya berlaku default `123456` dan UI memberi peringatan.
- **Nilai awal (seed)**: `SDR_DOA_SEED_DATA_OUT_HOSTS`, `SDR_DOA_SEED_BASE_URL`, `SDR_DOA_SEED_MQTT_HOST`, `SDR_DOA_SEED_MQTT_PORT`, `SDR_DOA_SEED_MQTT_TRANSPORT`, `SDR_DOA_SEED_MQTT_WS_PATH` dan `SDR_DOA_SEED_REFRESH_SECONDS` di `.env` sebelah compose hanya dipakai pada start pertama, saat `/data/console.json` belum ada. `SDR_DOA_SEED_DATA_OUT_HOSTS` berisi host Data Out dipisah koma (misalnya `rdf.local,192.168.100.100`) dan menggantikan daftar default; `SDR_DOA_SEED_BASE_URL` harus memakai salah satunya. Daftar yang tidak memuat host base URL diabaikan dengan peringatan (hanya nama variabel). Setelah itu ubah lewat halaman Konfigurasi. Port diatur dengan `SDR_DOA_PORT` di `.env` yang sama (jangan hanya di shell, karena `docker compose up` berikutnya kembali ke 8787).
- **Log dan status**: `docker compose ps` (kolom health dari `/api/health`), `docker compose logs -f console`.
- **Update**: ekstrak rilis baru (atau `git pull` dan `git submodule update`), lalu `docker compose up -d --build`. Volume dan isinya tetap. Untuk update tanpa build, pindah ke image GHCR dengan `sudo sh sdr-doa-docker install` (bagian sebelumnya); salin dulu `SDR_DOA_ADMIN_PASSWORD`, `SDR_DOA_PORT` dan `SDR_DOA_SEED_*` dari `.env` di sini ke `/opt/sdr-doa-ground-console/.env`, lalu jangan pakai `docker compose` di direktori ini lagi (lihat **Data** di bagian sebelumnya).
- **Stop**: `docker compose down` (volume tetap); `docker compose down -v` juga menghapus semua data.

Container berjalan sebagai uid 10001 dan `restart: unless-stopped` menyalakannya lagi bersama Docker saat boot (pastikan `systemctl is-enabled docker` bernilai `enabled`).

### Rilis tar dan `install.sh` (tanpa Docker)

Butuh Python 3.9+ dengan modul `venv` (`sudo apt install python3-venv` di Debian/Ubuntu). Jalankan sebagai user desktop biasa, bukan root:

```sh
curl -fLO https://github.com/sanadunt/sdr-doa-ground-control/releases/download/v2.0.0/sdr-doa-ground-console-2.0.0-linux.tar.gz
curl -fLO https://github.com/sanadunt/sdr-doa-ground-control/releases/download/v2.0.0/SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS
tar -xzf sdr-doa-ground-console-2.0.0-linux.tar.gz
cd sdr-doa-ground-console-2.0.0-linux
sh install.sh            # menanyakan kata sandi admin; Enter = default 123456
sdr-doa-console auto-update on   # opsional: update otomatis setiap hari 03.45
```

Tanpa pertanyaan, dengan nilai awal: `sh install.sh --yes --generate-password --base-url http://192.168.100.100:8081 --mqtt-host 10.90.0.1 --mqtt-port 9001 --refresh-seconds 2`. Untuk host Data Out di luar daftar default, tambahkan misalnya `--data-out-hosts rdf.local,192.168.100.100 --base-url http://rdf.local:8081`. Opsi lain: `--password NILAI`, `--port`, `--prefix`, `--data-dir`, `--no-service`, `--no-desktop` (lihat `sh install.sh --help`). Installer memeriksa file rilis terhadap `MANIFEST.sha256`, memasang program dan venv (`paho-mqtt`, `tzdata`) di `~/.local/share/sdr-doa-ground-console/app`, membuat systemd user service, perintah `sdr-doa-console` di `~/.local/bin`, dan entri menu, lalu langsung menjalankan console. Dari repository, `sh packaging/console/install.sh` bekerja sama setelah `npm run build:all`.

```text
sdr-doa-console open        start bila perlu, lalu buka di Chromium/Chrome
sdr-doa-console start | stop | restart | status
sdr-doa-console logs        ikuti log (journalctl --user)
sdr-doa-console password    ganti kata sandi admin, lalu restart console
sdr-doa-console update      pasang rilis terbaru dari GitHub (--check hanya menampilkan)
sdr-doa-console auto-update on|off|status   update otomatis setiap hari (default 03.45)
sdr-doa-console info        versi dan lokasi file
sdr-doa-console uninstall   hapus program; --purge juga menghapus data
```

Upgrade: `sdr-doa-console update` mengambil rilis terbaru dengan versi mayor yang sama dari GitHub Releases tanpa login (repository publik), memeriksa SHA-256-nya, lalu menjalankan `install.sh` rilis itu dengan opsi instalasi sekarang. Bila versi baru tidak menjawab `/api/health` dalam 60 detik, program lama dikembalikan dan dijalankan lagi. `sdr-doa-console auto-update on` melakukannya setiap hari lewat systemd user timer (`sdr-doa-console update --auto`); selama Receiver merekam atau mengarsipkan pindai, update itu ditunda ke jadwal berikutnya, paling lama 7 hari. Instalasi dari tarball tanpa perintah `update` (semua instalasi sebelum rilis GitHub pertama) menjalankan sekali `sh install.sh` dari rilis baru; setelah itu `sdr-doa-console update` dan `auto-update on` tersedia. Cara manual tetap bisa: ekstrak rilis baru dan jalankan `sh install.sh` lagi. Program dan venv diganti; data, kata sandi, dan console yang sedang jalan dipertahankan. Rincian di `packaging/console/README.md`.

### Jalan di background dan saat boot

- **Native**: console adalah systemd user service `sdr-doa-ground-console.service` (restart otomatis bila gagal). Installer menjalankan `loginctl enable-linger $USER` agar service mulai saat boot tanpa login; bila ditolak, jalankan sekali `sudo loginctl enable-linger $USER`. Cek dengan `systemctl --user status sdr-doa-ground-console` dan `loginctl show-user $USER -p Linger`. Dengan `--no-service`, atau tanpa systemd user session, console jalan di background sampai reboot berikutnya (`sdr-doa-console start` setelah login).
- **Docker**: `restart: unless-stopped`, selama service Docker sendiri aktif saat boot.
- **Agent RDF-SDR**: systemd system service `sdr-doa-agent.service`, enabled, atau container dengan `restart: unless-stopped` (lihat di bawah).

### Apa yang tersimpan dan di mana

Semua yang diubah lewat UI disimpan di server console, bukan hanya di browser. Pengaturan tetap ada saat browser lain dipakai, cache dibersihkan, console di-restart, container dibuat ulang, atau komputer reboot.

| File | Isi | Native | Docker |
|---|---|---|---|
| `console.json` | Data Out (base URL dan daftar host), MQTT (host, port, transport, path WebSocket), interval refresh, akses LAN (`lan_access`) | `~/.local/share/sdr-doa-ground-console/` | `/data/` |
| `branding.json` | nama aplikasi dan logo | sama | sama |
| `preferences.json` | tema, bahasa, panel Dashboard dan node card, peta dasar, Lapisan/overlay, tampilan polar, sumber dan offset kompas, sumber GPS, mode Dengar, ikuti frekuensi node, mode dock Spektrum (RX atau Spektrum) dan skala dB terakhirnya, pengaturan (termasuk Skala dB tab Dengar), pengaturan pindai (termasuk Grafik min./maks.) dan bookmark Receiver | sama | sama |
| `receiver/` | rekaman, scan, dan marker set Receiver | sama | sama |
| `tiles/` | cache tile basemap; boleh dihapus, terisi lagi saat peta dilihat | sama | sama |
| `.env` | `SDR_DOA_ADMIN_PASSWORD` (mode 0600) | sama | sama |

- Data realtime (snapshot DoA, pesan MQTT, spektrum) tidak disimpan; data itu terus diperbarui.
- Browser menyalin preferensi ke console sekitar setengah detik setelah perubahan, dan saat halaman dibuka membaca salinan console lebih dulu. Bila console sedang tidak bisa dihubungi, perubahan dikirim begitu console menjawab lagi.
- Pengaturan Receiver ikut tersimpan selama halaman console terbuka. ID perangkat Receiver tetap di browser.
- Saat console dijalankan langsung dari repository tanpa flag, file berada di `~/.config/sdr-doa-ground-console/` (`console.json`, `branding.json`, `preferences.json`), rekaman di `~/.local/share/sdr-doa-ground-console`, cache tile di `~/.cache/sdr-doa-ground-console/tiles`, dan kata sandi di `.env` root repository. Lokasinya bisa diubah dengan `--config-path`, `--branding-path`, `--preferences-path`, `--data-dir`, `--tile-cache-dir` dan `--env-file`; console mencetak lokasinya saat start.

### Cache tile dan peta offline

- Console menyimpan setiap tile yang pernah tampil di `--tile-cache-dir` (instalasi: `DATA/tiles`), paling banyak `--tile-cache-max-mb` (bawaan 512 MB; tile yang paling lama tidak dipakai dihapus lebih dulu; `0` berarti tidak menyimpan apa pun).
- Tile dianggap segar selama max(`max-age` dari upstream, 7 hari), paling lama 30 hari, dan selama segar disajikan tanpa jaringan. Setelah itu console mengambilnya lagi; bila upstream tidak bisa dihubungi, salinan lama tetap disajikan. Tile yang belum pernah tersimpan dijawab 504.
- Tidak ada unduh massal per area; kebijakan penyedia tile melarangnya. Untuk menyiapkan area sebelum ke lapangan, buka area itu di Dashboard pada zoom dan gaya yang akan dipakai selagi masih online.
- Host yang gagal dilewati selama 30 detik, sehingga tile yang belum tersimpan langsung dijawab saat offline. Log console mencatat sekali saat upstream sebuah sumber tidak bisa dihubungi dan sekali saat kembali; tile yang berhasil disajikan tidak dicatat.
- Permintaan keluar memakai proxy standar dari environment (`HTTPS_PROXY`, `NO_PROXY`) dan User-Agent `SDR-DoA-Ground-Console/<versi>`.
- Setiap tile yang belum tersimpan memberi tahu penyedia area stasiun. Gaya Polos tidak meminta tile.
- `--base-url` dan `--mqtt-*` menimpa pengaturan tersimpan hanya untuk satu kali jalan dan tidak disimpan. Service dan container sengaja tidak memakainya.

### Tampilan LAN (lihat saja)

Untuk tablet atau komputer lain di LAN yang hanya perlu melihat Dashboard, peta, polar, health dan monitor. Ini pengganti forward `socat 0.0.0.0:8788 → 127.0.0.1:8787`; hentikan forward itu dulu, karena ia meneruskan login admin dan Kontrol juga.

- Listener kedua di proses console, mati secara default. Port console tetap hanya `127.0.0.1:8787`.
- Dinyalakan di **Konfigurasi → Akses LAN** setelah buka kunci admin: **Lihat dari LAN**, **Port** (`8788`), **Alamat bind** (`0.0.0.0`, `::` atau IP antarmuka LAN), dan **Klien yang diizinkan** (alamat atau jaringan IPv4/IPv6, misalnya `192.168.1.20, 192.168.1.0/24`; paling banyak 32, tidak lebih luas dari /16 atau /48; daftar kosong berarti tidak ada yang boleh). Simpan langsung membuka, memindah atau menutup listener. Bila alamat bind belum ada di host ini (misalnya IP antarmuka LAN yang baru muncul setelah console start saat boot) atau port masih dipakai, console mencoba lagi setelah 5, 10, 20 dan 40 detik lalu tiap 60 detik selama pengaturan menyala, tanpa perlu restart atau Simpan.
- Ditolak selama kata sandi admin masih `123456` atau login admin mati. Pengaturan yang menyala tetap tertutup saat start dalam keadaan itu; alasannya ada di log, `/api/health` dan kartu Akses LAN.
- Klien lain mendapat 403 tanpa isi; permintaannya tidak dibaca (dicatat di log sekali per menit per alamat). Klien yang diizinkan hanya mendapat UI dan API baca-saja; login admin, Kontrol, Konfigurasi, preferensi, Receiver dan Rekaman ditolak (`LAN_READ_ONLY`). Preferensi yang terbaca dari LAN hanya pilihan tampilan (tema, bahasa, panel, peta, polar, GPS dan Kompas), tanpa pengaturan dan bookmark Receiver. `Host` harus IP, nama host komputer ini atau `<nama host>.local`; nama `.local` lain ditolak. Paling banyak 32 permintaan berjalan sekaligus (selebihnya 503 tanpa isi), dan tiap permintaan harus terkirim dalam 10 detik.
- Di tablet, top bar menampilkan **LIHAT SAJA**, Kontrol dan buka kunci admin tidak ada, dan Konfigurasi hanya menampilkan nilai. Pilihan tampilan tablet disimpan di browser tablet saja.
- Receiver di tablet adalah **mirror** dari Receiver groundstation (RadioSpectrum tetap di USB groundstation): panel Spektrum menampilkan tag `MIRROR`, umur frame, dan spektrum serta waterfall yang dikirim halaman console groundstation, dengan semua tombol nonaktif dan tanpa audio; rute Receiver menampilkan spektrum yang sama dan status Receiver (tengah, sample rate, gain, VFO, RX, rekaman, pindai). Chip `STALE` berarti frame terakhir lebih tua dari 3 detik; **SUMBER PUTUS** (EN: SOURCE LOST) berarti groundstation tidak mengirim apa pun selama 10 detik. Mirror hanya mengalir selama halaman console di groundstation memasang Receiver (rute Receiver pernah dibuka, atau Mulai di panel Spektrum) dan **terlihat** di layar; halaman yang tersembunyi atau diminimalkan berhenti mengirim frame. Kontraknya: `docs/RECEIVER_MIRROR.md`. Kontrol Receiver dari tablet belum ada.
- Firewall: buka port LAN hanya untuk jaringan LAN, misalnya `sudo ufw allow from 192.168.1.0/24 to any port 8788 proto tcp`. Port console jangan dibuka.
- Cek dari komputer lain yang diizinkan: `curl http://<IP groundstation>:8788/api/health` menjawab `"ok": true`, `curl -o /dev/null -w '%{http_code}\n' http://<IP groundstation>:8788/api/receiver/settings` mencetak `403`, dan `curl http://<IP groundstation>:8788/api/mirror/receiver` menjawab `"ok": true` dengan `source_age_ms` di bawah 10000 selama Receiver groundstation terbuka. Langkah lengkap ada di `docs/RUNBOOK_INSTALL_UPDATE.md` bagian 6.2.

## Agent RDF-SDR (Raspberry)

Agent bawaan repo ini membaca Data Out KrakenSDR dan publish `health`, `state` dan `config_reported` ke topik lama `sdr/v1/uav-01`, lalu menjawab patch di topik itu. Kontrol tidak lagi memakainya: Kontrol mengirim perintah ke RDF Node (`sdr/v2/uav-01`) yang dipasang di RDF-SDR dari repository RDF Node. Detail lengkap ada di `packaging/agent/README.md`.

```sh
tar -xzf sdr-doa-rdf-sdr-agent-2.0.0.tar.gz
cd sdr-doa-rdf-sdr-agent-2.0.0
sudo sh install.sh --dry-run --mqtt-host 127.0.0.1    # lihat dulu apa yang akan dilakukan
sudo sh install.sh --mqtt-host 127.0.0.1              # pasang dan start (broker di RDF-SDR sendiri)
systemctl status sdr-doa-agent
journalctl -u sdr-doa-agent -f
```

- Agent berjalan sebagai service `sdr-doa-agent` (mulai saat boot, restart bila gagal) dengan user biasa: pemilik `settings.json` KrakenSDR, `doasdr`, atau user sistem baru `sdr-doa-agent`. Installer menolak user root.
- Pengaturan ada di `/etc/sdr-doa-agent/agent.env` (`root:<grup service>`, 0640). Setelah mengubahnya: `sudo systemctl restart sdr-doa-agent`. Variabel lain bisa diset dengan `--set NAMA=NILAI`, misalnya `--set DOA_RATE=0`.
- Secara bawaan agent menjawab setiap patch dengan `REMOTE_CONTROL_DISABLED`. `sudo sh install.sh --enable-config` mengizinkan patch di topik lama `sdr/v1/uav-01/cmd/config/patch` mengubah `settings.json`; `--disable-config` mematikannya lagi. Aktifkan hanya di broker dan jaringan yang dipercaya.
- Agent memakai MQTT lewat TCP (default port 1883), bukan WebSocket. Console dan agent harus memakai broker yang sama. Broker di luar loopback wajib TLS dan username (`MQTT_TLS=1` atau `MQTT_CAFILE`, `MQTT_USERNAME`, dan `SDR_DOA_MQTT_PASSWORD` di `agent.env`; lihat `packaging/agent/README.md`).
- Docker dari image GHCR (arm64 atau armv7, tanpa build, update otomatis tanpa login GitHub), sebagai pengganti service di atas, bukan bersamaan. Selama service native masih terpasang, script menolak memasang agent; hapus dulu dengan `sudo sh /opt/sdr-doa-agent/uninstall.sh` (pengaturan di `/etc/sdr-doa-agent/agent.env` tetap, salin nilainya ke `agent.env` yang baru):

  ```sh
  curl -fLO https://github.com/sanadunt/sdr-doa-ground-control/releases/latest/download/sdr-doa-docker
  curl -fLO https://github.com/sanadunt/sdr-doa-ground-control/releases/latest/download/SHA256SUMS
  # tanpa curl: wget dengan URL yang sama
  sha256sum -c --ignore-missing SHA256SUMS
  sudo sh sdr-doa-docker install --agent --auto-update     # /opt/sdr-doa-agent, update harian 03:30
  sudoedit /opt/sdr-doa-agent/agent.env                     # MQTT_HOST, MQTT_PORT, dan lain-lain
  cd /opt/sdr-doa-agent && sudo docker compose up -d        # terapkan agent.env yang diubah
  sudo docker compose logs -f agent
  ```

  `--enable-config` mengizinkan patch di topik lama mengubah `settings.json`: script me-mount `/home/doasdr/doasdr/_share` (`--share-dir`) dan menjalankan agent sebagai pemilik direktori itu; `--disable-config` mematikannya lagi. `sdr-doa-docker update --dir /opt/sdr-doa-agent` dan `rollback` bekerja seperti pada console; image agent tidak punya healthcheck, jadi image baru dianggap gagal bila container berhenti atau restart dalam 20 detik pertama.
- Docker yang di-build sendiri (juga arm64/armv7): salin `packaging/agent/agent.env.example` ke `agent.env`, edit, lalu `docker compose up -d --build` di folder rilis agent (atau `docker compose -f docker-compose.agent.yml up -d --build` di repository). Butuh Compose v2.24+. Project dan volume-nya sama dengan yang ditulis `sdr-doa-docker install --agent`, jadi state di volume `agent-state` tetap saat pindah ke image GHCR; salin isi `agent.env` lama ke `/opt/sdr-doa-agent/agent.env`.
- Upgrade service: jalankan installer rilis baru lagi; `agent.env` dan state tetap. Hapus dengan `sudo sh /opt/sdr-doa-agent/uninstall.sh` (`--purge` juga menghapus pengaturan dan state).

## Link T900/PPP di groundstation

`packaging/ground-link/` (juga di tarball console) berisi alat host untuk link PPP lewat T900 ke RDF-SDR. Semuanya dipasang di host groundstation, di luar Docker; console tidak mendapat kendali host. Detail, prosedur insiden dan pengaturan ada di `packaging/ground-link/README.md`.

```sh
sudo sh packaging/ground-link/install.sh --dry-run   # lihat dulu
sudo sh packaging/ground-link/install.sh             # operator: user rdf (--user NAMA)
t900-link status                                     # service PPP, ppp0, status watchdog
mkdir -p ~/t900 && sudo t900-ground-diag -o ~/t900   # laporan diagnosis bertanda waktu
t900-link restart                                    # restart t900-ground-ppp.service
t900-link usb-reset                                  # usbreset 1a86:7523, lalu restart service
journalctl -t t900-ground-watchdog -f                # setiap tindakan watchdog
```

- `t900-ground-diag` hanya membaca: status service, 50 baris journal pppd, `ip addr` dari `ppp0`, node `/dev/t900-ground`, `lsusb`, 30 baris kernel tentang USB dan `ch341`, ping ke `10.90.0.2`, dan `udevadm info`. Tanpa root bagian journal dilewati dan disebut di laporan. Di Raspberry: `t900-ground-diag --raspberry`.
- `t900-ground-watchdog.timer` memeriksa link tiap 30 detik. Bila `ppp0` tidak punya alamat atau peer tidak menjawab ping selama 180 detik, watchdog restart service, lalu mengenumerasi ulang USB, lalu (hanya bila hardware-nya diatur) memutus daya T900, dengan jarak yang makin panjang. Setelah 4 tindakan dalam satu jam ia berhenti dengan status "remote unreachable" sampai sesi PPP baru terbentuk atau host di-boot ulang.
- Installer tidak mengubah `t900-ground-ppp.service`, `/etc/ppp/peers/t900-ground` atau udev rule, dan tidak membuka port. `--watchdog-dry-run` membuat pemeriksaan watchdog hanya mencatat tindakannya; `t900-link usb-reset` tetap dijalankan.

## Validasi setelah install

Frontend:

```sh
cd frontend
npm run check
npm test
npm run build:all
cd ..
```

Backend (macOS/Linux):

```sh
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest discover -s tools -p 'test_*.py'
python3 tools/test_sdr_doa_collector.py
python3 tools/test_stage3.py
node --test tools/test_receiver_*.mjs
```

Windows PowerShell:

```powershell
$env:PYTHONDONTWRITEBYTECODE = "1"
.\.venv\Scripts\python.exe -m unittest discover -s tools -p "test_*.py"
.\.venv\Scripts\python.exe tools\test_sdr_doa_collector.py
.\.venv\Scripts\python.exe tools\test_stage3.py
```

`unittest discover` tidak menjalankan semua test Python karena banyak file test memakai fungsi `test_*` dan runner standalone. Jalankan script yang relevan ketika mengubah modul tertentu. Tes Node Receiver membutuhkan submodule `vendor/BrowSDR`. `tools/test_sdr_doa_mqtt_stdlib.py` membutuhkan broker staging di `127.0.0.1:18884`.

Suite static (`tools.test_ground_console_static`) melewati cek yang butuh build bila `frontend/dist/index.html` tidak ada. Bila `frontend/dist` ada dan submodule `vendor/BrowSDR` sudah diambil tetapi `frontend/dist/receiver` tidak ada, cek Receiver gagal (bukan dilewati) dan pesannya menyebut perintah build.

## Troubleshooting singkat

### Monitor MQTT ERROR: `paho-mqtt is not installed`

Install `paho-mqtt==2.1.0` ke `.venv` yang sama dengan Python server, lalu restart console. Jangan mengandalkan Python system/Homebrew. `ModuleNotFoundError: No module named 'paho'` dari synthetic publisher atau tes MQTT punya penyebab yang sama.

### Console berhenti dengan `No module named 'zoneinfo'`

Python terlalu lama. Buat ulang `.venv` dengan Python 3.9 atau lebih baru.

### UI tidak muncul atau `frontend/dist/index.html` tidak ada

Jalankan `npm run build:all` (atau `npm run build` tanpa Receiver) dari `frontend/`, lalu restart Ground Console.

### UI masih versi lama setelah `git pull`

Misalnya masih ada menu samping, atau Dashboard belum berupa dasbor peta penuh. `frontend/dist` belum di-build ulang. Jalankan `cd frontend && npm ci && npm run build:all`, restart console, lalu muat ulang halaman. Lihat [Setelah `git pull`](#setelah-git-pull).

### Spektrum: `NEEDS_PAIRING`, `NO_WEBUSB`, atau `NO BRIDGE`

`NEEDS_PAIRING`: pasangkan RadioSpectrum sekali di halaman Receiver (tombol `2`), lalu tekan **Mulai** lagi di Dashboard. `NO_WEBUSB`: buka console di Chrome atau Edge. `NO BRIDGE`: frame Receiver tidak menjawab; buka halaman Receiver atau muat ulang console.

### Spektrum: Ikuti frekuensi node mati sendiri

Tengah atau VFO diubah di halaman Receiver (mengetik Center atau VFO, menggeser VFO di grafik Receiver, memanggil bookmark, atau selesai dengar-pindai), grafik diklik pada mode Spektrum, atau **Tala ke sini** ditekan pada sebuah penanda. Dasbor lalu memakai frekuensi itu dan berhenti mengikuti node agar node tidak menimpanya. Centang **Ikuti frekuensi node** lagi untuk kembali ke frekuensi node.

### Spektrum: mode Spektrum `SWEEP_UNSUPPORTED`, `SWEEP_FAILED`, atau isian Atur terkunci

`SWEEP_UNSUPPORTED`: radio yang tersambung tidak punya sweep hardware (Mock SDR hanya memakai sumber simulasi, dan hanya dengan `?mock=1`). `SWEEP_FAILED`: pindai gagal dimulai; teks di sampingnya adalah pesan Receiver, dan halaman Receiver (tombol `2`) menampilkan detailnya, misalnya rentang yang ditolak sweep native di dekat 7250 MHz. RX yang dihentikan untuk pindai itu jalan lagi, dan VFO tetap terdengar atau tetap senyap seperti sebelumnya. Rentang, Resolusi, dan Gain pindai terkunci selama pindai berjalan; tekan **Berhenti** lalu ubah.

### Spektrum: Penanda nonaktif, **Belum disimpan**, atau penanda ditolak

- **Penanda** nonaktif: Receiver belum dimuat atau tidak menjawab. Tekan **Mulai** (atau buka halaman Receiver) dulu.
- **Belum disimpan**: belum ada marker set yang dipilih di halaman Receiver, jadi penanda hilang saat console dimuat ulang. Di halaman Receiver (tombol `2`), pilih set di **Set tersimpan** atau isi nama lalu **Simpan set**; penanda berikutnya dari dock tersimpan ke set itu.
- **Penanda tidak tersimpan ke set**: penanda masuk daftar, tetapi penyimpanan ke set gagal; teks dalam kurung adalah pesan Receiver. Periksa console, lalu simpan set lagi di halaman Receiver.
- **Di luar jangkauan penanda**: frekuensi perangkat (tanpa Freq Shift) harus 1–7250 MHz. **Batas penanda tercapai**: daftar sudah berisi 10 000 penanda. **Penanda sudah tidak ada**: penanda itu sudah dihapus di halaman Receiver.

### Kontrol: Kirim nonaktif, `NODE_NOT_FRESH`, `TLS_REQUIRED_FOR_SETTINGS_REPORT`, atau Belum ada ACK

- Kirim nonaktif ("Kirim butuh state RDF-SDR lewat MQTT", "... revisi konfigurasi (state.cfg) RDF-SDR", "... telemetry/health yang segar dari RDF-SDR"), atau console menjawab `NODE_SESSION_UNAVAILABLE`, `CONFIG_REVISION_UNKNOWN`, `NODE_NOT_FRESH`: belum ada `state` RDF Node di broker yang sama, `state.cfg` masih kosong, atau `telemetry/health` lebih tua dari 8 detik. Periksa tampilan **RDF Node** di **Monitor Pesan**.
- `TLS_REQUIRED_FOR_SETTINGS_REPORT` setelah **Baca settings**: koneksi RDF-SDR ke broker tidak memakai TLS, jadi RDF-SDR tidak mengirim `settings/reported`. Nilai diambil dari Data Out (cadangan) dan patch tetap bisa dikirim. Beri broker listener TLS untuk RDF-SDR; console tetap memakai listener biasa.
- **Belum ada ACK** (sekitar 20 detik): RDF Node tidak menjawab di `sdr/v2/uav-01/ack/config`. RDF Node mati atau memakai broker lain. Agent bawaan repo ini tidak menjawab Kontrol.
- `Ditolak · REJECTED · CONFIG_REVISION_CONFLICT` atau `Ditolak · REJECTED · BUSY`: settings berubah oleh pengirim lain, atau RDF-SDR masih mengerjakan perintah lain, misalnya dari `rdf-ground.service`. Baca ulang nilai, tinjau, kirim lagi; pakai satu pengendali sekaligus.
- `Ditolak · REJECTED · EXPIRED_OR_INVALID_DEADLINE`: jam host console lebih dari 1 detik di depan jam RDF-SDR, atau perintah tiba setelah 15 detik. Periksa NTP di kedua host.
- `ACK · FAILED · CONFIG_TARGET_NOT_READY`: RDF Node belum punya target settings yang disetujui (`sudo rdf-node controls approve --settings` di RDF-SDR).
- **Publish gagal**: ACL broker tidak mengizinkan console publish ke `sdr/v2/uav-01/cmd/config/patch` atau `cmd/config/get`.
- Kontrol tidak bisa dibuka karena login admin nonaktif: `SDR_DOA_ADMIN_PASSWORD` diisi nilai kosong, atau `.env` tidak bisa dibaca. Isi kata sandi lalu restart console.

### `sdr-doa-docker`: pull ditolak (`denied`, `unauthorized`)

Package GHCR masih private (lihat [Rilis di GitHub](#rilis-di-github)), atau Docker menyimpan login `ghcr.io` lama yang tokennya sudah kedaluwarsa (`~/.docker/config.json`, untuk sudo `/root/.docker/config.json`): jalankan `sudo docker logout ghcr.io` lalu ulangi. Image publik tidak butuh login. Di belakang proxy, daemon Docker memakai proxy dari konfigurasi service Docker, bukan dari shell.

### Update dibatalkan dan versi lama jalan lagi

Docker: `update.log` di direktori install (`/opt/sdr-doa-ground-console` atau `/opt/sdr-doa-agent`) menyebut sebabnya pada baris `FAILED`. Image yang gagal healthcheck dicatat di `.bad-images`, dan update otomatis melewatinya sampai ada image lain; `sudo sdr-doa-docker update` di terminal menawarkan untuk mencobanya lagi. Gagal karena hal lain (error compose, waktu habis) tidak dicatat dan dicoba lagi pada jadwal berikutnya. Baris `deferred:` berarti Receiver sedang merekam atau mengarsipkan pindai; `skipped: ... points to older` berarti tag kanal menunjuk versi yang lebih lama dari yang jalan. Native: `sdr-doa-console auto-update status` menampilkan hasil terakhir, `journalctl --user -u sdr-doa-console-update` lognya; rilis yang gagal dilewati sampai ada rilis yang lebih baru, dan `sdr-doa-console update --to <versi>` mencobanya lagi.

### Halaman Receiver menampilkan "Receiver is not built"

`npm run build` sudah mengosongkan `frontend/dist/receiver`. Jalankan `npm run build:all` dari `frontend/`, atau `tools/build_browsdr_receiver.py` dari root repository, lalu muat ulang halaman.

### `BrowSDR build failed: npm was not found on PATH`

Builder tidak menemukan `npm` (atau `npm.cmd` di Windows). Pasang Node.js, buka terminal baru, lalu ulangi build.

### Vite atau npm menolak versi Node

Periksa:

```sh
node --version
npm --version
```

Gunakan Node LTS yang memenuhi requirement Vite. Node 22.12+ direkomendasikan oleh workflow project.

### Nilai `settings.json` terlambat atau tampil `REUSED`

Console memakai ulang `settings.json` paling lama 30 detik (lihat [Refresh](#refresh)), jadi perubahan gain, bandwidth, squelch, atau offset kompas yang dibuat langsung di node bisa tampil hingga 30 detik kemudian. **Cek ulang** di Kontrol membaca `settings.json` saat itu juga dan meminta `settings/reported` dari RDF-SDR. Refresh atau tab lain dalam 1 detik setelah pembacaan terakhir mendapat pembacaan yang sama, bukan pembacaan baru.

### Data Out UNAVAILABLE, ERROR, atau STALE

Ini tidak selalu berarti frontend rusak. Buka **Kesehatan Sistem → Pembacaan resource** untuk melihat file mana yang gagal dan kenapa. Periksa DNS atau koneksi ke `doasdr.local:8081`, dan gunakan host yang ada di daftar **Host Data Out (cadangan)** (Konfigurasi). Nama `.local` dicoba dulu lewat resolver sistem; bila gagal (misalnya di container Docker yang tidak punya mDNS), collector mengirim query mDNS, sekali lewat setiap interface yang aktif dan punya alamat IPv4, juga di LAN tanpa default route (paling lama sekitar 1 detik, hasil disimpan 5 sampai 60 detik) dan tetap memakai nama itu di header `Host`. Kartu Data Out di Kesehatan Sistem lalu menampilkan `mDNS <alamat>`. Bila mDNS juga tidak menjawab, pesannya "`<nama>.local` tidak bisa di-resolve, juga lewat mDNS": pakai alamat IP node di base URL (dan di daftar host). Firewall host (misalnya ufw) bisa membuang jawaban mDNS itu, karena node menjawab lewat unicast dari UDP port 5353 ke port acak console; izinkan dengan `sudo ufw allow proto udp from <subnet LAN> port 5353`, atau pakai alamat IP. Lewat proxy (`HTTP_PROXY` tanpa `NO_PROXY` untuk host itu) tidak ada fallback mDNS, karena proxy yang meresolusi nama, dan kartu itu tidak menampilkan alamat. `STALE` dengan `NODE_CLOCK_STALLED` berarti port 8081 menjawab tetapi DSP node berhenti. `DEGRADED` berarti DAQ sync gagal atau ADC overdrive; turunkan gain bila overdrive. Gunakan tab **Simulasi** untuk memeriksa renderer tanpa hardware.

### Basemap tidak tampil

MapLibre hanya renderer; tile datang dari console lewat `/api/tiles`, dan CSP halaman tidak mengizinkan host tile lain. Kegagalan tile tidak berarti overlay atau polar plot gagal; chip "BASEMAP TIDAK TERSEDIA · <gaya>" muncul bila tile area yang tampil tidak bisa diambil dan belum tersimpan, dan "BASEMAP SEBAGIAN · <gaya>" bila sebagian tile tampil dan sisanya gagal.

- Lihat log console: `tiles <sumber>: upstream unavailable (...)` menyebut penyebabnya (DNS, koneksi ditolak, timeout, HTTP 4xx/5xx, tipe isi ditolak).
- Periksa koneksi HTTPS dari komputer console (bukan dari browser) ke host di `tools/tile_cache.py`, serta proxy (`HTTPS_PROXY`, `NO_PROXY`), VPN, dan firewall.
- `curl -s -D - -o /dev/null http://127.0.0.1:8787/api/tiles/osm/0/0/0` menampilkan `X-Tile-Cache: hit`, `miss` atau `stale`; 504 berarti tile belum tersimpan dan upstream tidak terjangkau.
- Pastikan `--tile-cache-dir` bisa ditulis user console; bila tidak, log mencatat `tile cache ... is not writable` dan tile tetap disajikan tanpa disimpan.
- Coba gaya lain: tiap gaya punya sumber sendiri, kecuali Terang dan Gelap yang memakai tile Standar.

### Link PPP ke RDF-SDR putus (`LCP: timeout` di journal pppd)

Jalankan `sudo t900-ground-diag` lalu lihat `t900-link status`. Status "remote unreachable" berarti tindakan watchdog dalam satu jam terakhir tidak memulihkan link. Ikuti prosedur insiden di `packaging/ground-link/README.md`: restart service, lalu `usbreset` dan restart, baru cabut-colok, masing-masing ditunggu 30–60 detik dan diikuti diag. Langkah yang memulihkan menunjukkan lapisan yang macet (pppd, CH340, radio T900 ground, atau link RF dan sisi Raspberry).

### Keamanan lokal

Tetap gunakan `--bind 127.0.0.1` (di Docker: `network_mode: host`). Jangan memakai `0.0.0.0` untuk quickstart dan jangan memasukkan secret ke frontend. Satu-satunya jalan dari LAN adalah [tampilan LAN lihat-saja](#tampilan-lan-lihat-saja), bukan reverse proxy atau `socat`. Config dry-run di Konfigurasi bukan command nyata, tetapi Kontrol di Dashboard adalah command nyata ke RDF-SDR. Ganti kata sandi admin bawaan `123456` sebelum console dipakai di komputer bersama. Console menolak `POST /api/mqtt/config-patch` tanpa header `Origin` dari halaman console itu sendiri, tanpa sesi admin, atau tanpa `confirm: true`.
