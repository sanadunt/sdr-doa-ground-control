# SDR-DoA Ground Console Quickstart

Panduan ini menjalankan Ground Console lokal dari checkout repository. Jalur production lokal memakai Python untuk menyajikan `frontend/dist` dan menyediakan API same-origin. Vite hanya dipakai untuk development/build.

## Prasyarat

Install terlebih dahulu:

- Git.
- Node.js LTS. Dokumentasi project merekomendasikan Node 22.12 atau lebih baru dalam lini Node 22. Vite saat ini membutuhkan Node `^20.19.0` atau `>=22.12.0`. Tes Node untuk Receiver (`tools/test_receiver_*.mjs`) membutuhkan Node 22.13 atau lebih baru.
- Python 3.9 atau lebih baru. Ground Console mengimpor `zoneinfo` saat start (lewat store Receiver), sehingga Python 3.8 langsung berhenti dengan `ModuleNotFoundError: No module named 'zoneinfo'`.
- Browser berbasis Chromium (Chrome atau Edge) bila memakai Receiver dengan HackRF, karena HackRF tersambung lewat WebUSB.
- WebGL2 di browser untuk peta. Tanpa WebGL2 peta menampilkan pemberitahuan dan overlay kanvas sederhana; halaman lain tetap berjalan.
- Akses HTTPS ke `tile.openstreetmap.de` dan/atau `tile.openstreetmap.org` jika ingin basemap tampil.
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

Opsional, buat file environment lokal untuk admin branding/config:

```sh
cp .env.example .env
```

Edit `.env` dan ganti `SDR_DOA_ADMIN_PASSWORD` jika login admin lokal diperlukan. Jangan commit `.env`. Tanpa variabel ini, panel admin di **Konfigurasi** menampilkan DISABLED.

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

Seperti di macOS/Linux, monitor MQTT default membutuhkan `paho-mqtt`; tanpa paket ini console tetap berjalan dengan monitor berstatus ERROR. Python di Windows juga tidak membawa database zona waktu, jadi pasang `tzdata` agar filter tanggal dan jam di **Records** Receiver memakai zona waktu browser lengkap dengan aturan DST.

PowerShell:

```powershell
.\.venv\Scripts\python.exe -m pip install paho-mqtt==2.1.0 tzdata
```

Command Prompt:

```bat
.venv\Scripts\python.exe -m pip install paho-mqtt==2.1.0 tzdata
```

Tanpa `tzdata`, Records tetap terbuka, tetapi filter memakai offset UTC browser saat ini dan label tanggal menandai "UTC offset".

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

## Receiver embedded

Pilih menu **Receiver** (tombol `7`) atau buka `http://127.0.0.1:8787/#/receiver`. Receiver juga dapat dibuka langsung di `http://127.0.0.1:8787/receiver/`.

- **Browser.** Firefox dan Safari tidak punya WebUSB; di sana **Connect Device** hanya menampilkan pesan bahwa WebUSB tidak tersedia dan meminta Chrome atau Edge.
- **Mock SDR.** Untuk uji tanpa hardware, buka Receiver langsung dengan `?mock=1` dari alamat loopback, misalnya `http://127.0.0.1:8787/receiver/?mock=1`. Dari dalam console, buka `http://127.0.0.1:8787/?mock=1#/receiver` (`?mock=1` ditulis sebelum `#`); halaman Receiver meneruskan `mock=1` ke frame-nya hanya bila host console adalah loopback. Pilih **Connect Mock SDR** (**Sambungkan Mock SDR** dalam bahasa Indonesia). Koneksi mock berlabel `MOCK` (`Radio SDR ON · MOCK (no RF)`, dalam bahasa Indonesia `MOCK (tanpa RF)`, dan `MOCK DEVICE`).
- **Tetap berjalan saat pindah halaman.** Setelah Receiver dibuka pertama kali, pindah ke halaman lain tidak menghentikan RX, scan, atau rekaman. Receiver berjalan tersembunyi sampai halaman console di-reload atau ditutup, dan tetap mengikuti perubahan tema dan bahasa. Reload console menghentikan sesi Receiver; audio yang sudah terekam tetap tersimpan.
- **Rekaman aman saat reload atau crash.** Rekaman dan scan arsip ditutup saat halaman unload bila memungkinkan, atau oleh console setelah 2 menit tanpa aktivitas. Segmen seperti itu berstatus "Interrupted" dan tetap bisa diputar. Upload yang gagal menyimpan audio yang sudah masuk sebagai "Partly saved". Rekaman berlanjut di file atau sesi baru saat batas ukuran tercapai, setelah chunk hilang, atau setelah sample rate/FFT size berubah (ada pemberitahuan). Satu sesi armed yang tidak menerima audio selama 2 menit bisa terpecah menjadi beberapa sesi.
- **Indikator rekaman.** Records menampilkan rekaman yang sedang berjalan ("recording in progress"), tab Listener menampilkan indikator `REC`, dan Spectrum meminta konfirmasi sebelum menghentikan rekaman yang berjalan.
- **Radio terputus.** Bila HackRF dicabut, atau transfer USB gagal saat RX, Receiver menghentikan RX dan scan, menutup rekaman yang berjalan (audio yang sudah masuk tetap ada), lalu menampilkan alert. Bila radio masih tersambung, pesannya meminta memeriksa kabel lalu menekan **Resume** atau menyambungkan ulang radio. Gangguan USB sesaat pun menghentikan listening sampai Resume ditekan.
- **Sumber scan.** Sumber scan mengikuti radio yang tersambung. Sumber Simulation selalu menampilkan badge `SIMULATION` dan label di atas grafik. Pengaturan scan diingat antar kunjungan.
- **Deteksi wide scan.** Sinyal lemah (SNR antara Detection SNR dan 16 dB di atas floor) baru masuk daftar setelah terlihat sekitar 6 sweep; sinyal 16 dB atau lebih di atas floor muncul di sweep pertama. Riwayat menyimpan paling banyak 1000 kandidat. Noise floor dan SNR mengacu ke median trace rata-rata, sehingga SNR terbaca sekitar 1,5 dB lebih rendah dari versi sebelumnya. Sinyal wideband (DAB, DVB-T, hingga sekitar 20 MHz) terdeteksi sebagai satu band. Grup puncak hanya menggabungkan kandidat yang band-nya bertumpuk atau bersentuhan.
- **Minimum peak.** Preset sekarang All (default) dan −50 sampai 0 dBFS.
- **Listen.** Listen meng-unmute VFO aktif dan menerapkan Freq Shift: scan menampilkan frekuensi SDR (perangkat), Listener menampilkan frekuensi tampilan.
- **IQ Correction (DC).** Koreksi kini menghapus offset DC pecahan. Pada gain sangat rendah noise floor naik sekitar 0,7–2 dB; matikan koreksi bila itu penting.
- **Waterfall dan arsip** menyimpan level hingga +60 dB. Arsip dan sesi lama tetap terbuka dengan batas 0 dB lamanya.
- **Marker.** Dengan mouse, klik menambah marker dan `Ctrl+Z` (`⌘Z`) menghapus marker terakhir. Di layar sentuh, tap membaca level dan tahan untuk menambah marker. Menyimpan marker set dengan nama yang sudah ada meminta konfirmasi sebelum mengganti.
- **Filter audio.** Filter tanggal dan jam mencocokkan rekaman yang tumpang tindih dengan jendela, dan jendela boleh melewati tengah malam (misalnya 22:00–02:00).
- **Upload arsip gagal.** Dengan arsip scan otomatis aktif, upload trace atau kandidat yang gagal menampilkan banner merah di Spectrum dan Records. Banner hilang sendiri setelah penyimpanan pulih; trace yang hilang tampil di Records sebagai "(N tidak tersimpan)". Kandidat yang gagal dikirim ulang otomatis.
- **Bahasa.** Receiver mengikuti EN/ID console. Status code (`SIMULATION`, `SCANNING`, `STOPPED`, `MOCK`, `REC`, `LIVE`), satuan, dan detail error dari browser atau radio tetap berbahasa Inggris.
- **Tanpa service worker dan font remote.** Build Receiver tidak mendaftarkan service worker dan tidak memuat font dari internet. Browser yang masih punya service worker dari build lama menghapusnya sendiri pada kunjungan berikutnya; bila tampilan masih lama, muat ulang sekali lagi. Origin berbeda (`localhost:8787` dan `127.0.0.1:8787`) memerlukan izin WebUSB masing-masing.
- **Mutasi API.** Mutasi `/api/receiver/*` memerlukan header `Origin` same-origin yang cocok dengan host dan port loopback; tanpa header itu atau dari origin lain, server mengembalikan HTTP 403.

## Menjalankan tanpa perangkat SDR

Ground Console tetap dapat digunakan untuk memeriksa UI tanpa Raspberry atau Data Out live:

1. Buka tab **Simulasi**.
2. Aktifkan simulasi (`SIMULATION`).
3. Atur latitude, longitude, **Bearing dari utara (0–359°)**, dan lebar lobe.
4. Klik **Terapkan skenario**.
5. Buka **Ringkasan** (Overview).
6. Periksa direction helper di peta dan kurva polar sintetis.

Sudut yang dimasukkan adalah bearing geografis: 0° utara, searah jarum jam. Readout, plot polar (selalu mode Compass saat simulasi), dan peta menampilkan angka yang sama; misalnya 45° tampil di arah timur laut di ketiganya. Detail readout menampilkan θ₀ 315° sebagai sudut array yang setara. Panel polar menampilkan badge `SIMULATION`. Simulasi kembali OFF setelah reload.

Mode simulasi hanya mengganti data Overview. Health, diagnostics, MQTT, dan publication gate tetap menggunakan sumber nyata atau tetap `BLOCKED`. Untuk Receiver tanpa hardware, buka `http://127.0.0.1:8787/?mock=1#/receiver` untuk memakai Mock SDR (lihat bagian Receiver).

## Menghubungkan Data Out live

Ground Console default memakai:

```text
http://doasdr.local:8081
```

Host yang diizinkan collector adalah `doasdr.local`, `192.168.100.100`, `127.0.0.1`, dan `localhost`, dengan port `8081`. Jika alamat Data Out berbeda, jalankan dengan `--base-url`, misalnya:

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

Flag yang diketik eksplisit (`--base-url`, `--mqtt-host`, `--mqtt-port`, `--mqtt-transport`, `--mqtt-ws-path`) mengalahkan konfigurasi tersimpan (`~/.config/sdr-doa-ground-console/console.json`) untuk run itu saja. Server mencetak pemberitahuan seperti `--base-url from the command line overrides the saved console config for this run`. File tersimpan tidak berubah sampai Anda menyimpan form **Konfigurasi → Connection**; saat itu nilai yang sedang aktif ikut tersimpan. Flag yang tidak diketik memakai nilai tersimpan.

Bila `console.json` rusak, field yang valid tetap dipakai, server mencatat nama field yang dikembalikan ke default, dan salinan file asli disimpan sebagai `console.json.invalid.bak`.

Collector tetap read-only dan hanya memakai HTTP GET.

## Membaca status di console

### Strip status

Strip di bagian atas punya enam item, dari kiri ke kanan: DATA, DOA, PUBLIKASI, SNAPSHOT, MQTT, dan SIM. Arahkan kursor ke sebuah item untuk melihat apa yang dilaporkannya; detail status saat ini, misalnya penyebab sebuah masalah, tampil di baris berikutnya.

- **DATA** mengklasifikasikan isi pembacaan Data Out terakhir:
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
- **DOA** menyatakan apakah bearing dan vektor 360 bin bisa ditampilkan di Ringkasan: `AVAILABLE`, atau `DEGRADED`, `CONFLICT`, `UNAVAILABLE`, `INCOMPLETE`, dan `STALE` dengan penyebab di tooltip. Sebelum pembacaan pertama nilainya `WAITING`. Ini keputusan yang sama yang dipakai readout, plot polar, dan peta.
- **PUBLIKASI** (`DELIVERY` di bahasa Inggris) adalah gate publikasi dari collector: `READY` hanya bila semua pemeriksaan untuk memublikasikan bearing lolos, selain itu `BLOCKED`. Di Ground Console nilainya selalu `BLOCKED`, juga saat DATA dan DOA `AVAILABLE`; penyebabnya dijelaskan di bagian Kesehatan Sistem di bawah. Tooltip menyebut reason teratas beserta kodenya.
- **SNAPSHOT** menyangkut pembacaan `/api/snapshot` itu sendiri: `CURRENT` selama 5 detik setelah pembacaan selesai (termasuk yang melaporkan UNAVAILABLE), lalu `STALE`; `ERROR` bila request terakhir gagal. Sebelum pembacaan pertama nilainya `LOADING` atau `WAITING`.
- **MQTT** adalah koneksi monitor lokal yang hanya berlangganan (subscriber-only) dan tidak pernah publish: `CONNECTED`, `CONNECTING`, `DISCONNECTED`, `ERROR`, atau `OFF` bila host MQTT tidak dikonfigurasi. `ERROR` juga muncul bila monitor tidak bisa dibuat (misalnya `paho-mqtt` tidak terpasang) atau console tidak bisa membaca status monitor; detailnya ada di tooltip.
- **SIM** bernilai `ON` selama simulasi aktif, yaitu saat Ringkasan menampilkan data sintetis dari browser, dan `OFF` bila Ringkasan memakai Data Out live. Item lain di strip tetap melaporkan data live, juga saat simulasi `ON`.

Bila pembacaan gagal, penyebabnya juga ditulis di banner di bawah strip.

### Refresh

- Pilihan interval: Manual, 1, 2, 5, 10, dan 30 detik. Instalasi baru memakai 2 detik.
- Data DoA dianggap segar 5 detik setelah dibaca. Dengan Manual atau interval di atas 5 detik, bearing dan kurva polar kosong di antara pembacaan; form Konfigurasi memberi peringatan untuk pilihan itu.
- Pembacaan yang sedang berjalan tidak dibatalkan oleh tick berikutnya. Layar mempertahankan data terakhir selama refresh, sehingga tidak berkedip setiap poll.
- "Membaca…" hanya muncul pada pembacaan pertama atau pembacaan yang lebih lama dari 1 detik.
- Tombol Refresh dan tombol `R` tetap bisa dipakai saat pembacaan berjalan; keduanya menunggu pembacaan itu.
- Data Out yang tidak terjangkau atau macet tampil `UNAVAILABLE` dalam sekitar 4 detik.

### Ringkasan (Overview)

- **Bearing dari utara** adalah bearing geografis searah jarum jam: (360 − θ₀ + compass_offset) mod 360. θ₀ mentah dari Data Out (sudut array berlawanan jarum jam) tampil di bawahnya sebagai "θ₀ … (kerangka array)", bersama offset dan sumbernya:
  - `DATA_OUT`;
  - `DATA_OUT · LOCAL AXIS` bila plot KrakenSDR bertipe Linear;
  - `MANUAL`;
  - "DATA_OUT terakhir diketahui N dtk": `settings.json` gagal dibaca dan console memakai pengaturan terakhir dari node yang sama, paling lama 90 detik;
  - "diasumsikan, hanya referensi" (amber) bila offset tidak dilaporkan.
- **Display peak** menyebut sumbunya (sumbu Compass atau sumbu θ₀ Polar).
- **Gate publikasi** di readout selalu `BLOCKED` di Ground Console, juga saat bearing tampil normal. Teksnya menyebut reason teratas, biasanya "Sumber otoritas DoA belum dipilih (+2 lagi)". Console ini read-only dan tidak memilih sumber otoritas DoA, jadi `BLOCKED` di sini bukan tanda data rusak; bearing yang tampil tetap bisa dibaca sebagai observasi. Penjelasan lengkap ada di bagian Kesehatan Sistem di bawah.
- **Bearing disembunyikan bila data tidak bisa dipercaya.** Bearing dan display peak menjadi "—", kurva polar dan overlay peta dikosongkan, dan penyebabnya disebutkan bila:
  - DAQ sync tidak PASS (FAIL atau UNKNOWN) atau ADC overdrive dilaporkan. Status menjadi `DEGRADED`, dan strip menampilkan DATA DEGRADED dan DOA DEGRADED.
  - CSV/XML `CONFLICT`.
  - Satu view hilang atau tidak bisa diparse.
  - Node berhenti diperbarui.
  - Record sudah tua, atau jendela lokal 5 detik habis.

  Satu aturan yang sama dipakai untuk readout, polar, dan peta.
- **Node beku.** Bila DSP node berhenti tetapi port 8081 tetap melayani, data menjadi `STALE` sekitar 5 detik kemudian. Setelah sekitar 10 detik tanpa perubahan timestamp, uptime, atau frame index, reason `NODE_CLOCK_STALLED` muncul dan readout menulis "Output node berhenti diperbarui". Deteksi butuh minimal dua pembacaan, sehingga node yang sudah beku sebelum console start baru terdeteksi setelah pembacaan berikutnya.
- **Posisi stasiun saat celah freshness.** Readout dan marker peta mempertahankan posisi Data Out live terakhir dengan label "POSISI STASIUN TERAKHIR · STALE". Posisi referensi ("REFERENSI SAJA · BUKAN GPS LIVE") baru dipakai bila `status.json` yang segar melaporkan GPS tanpa fix.
- **Peta.**
  - Overlay memakai bearing geografis yang sama dengan pembacaan Compass dan display peak. Hover menampilkan bearing, bin θ₀, dan dB.
  - Bila offset kompas tidak dilaporkan, muncul pemberitahuan REFERENSI.
  - **Skala dB** overlay default Auto (dari vektor). Min, Max, dan Noise threshold hanya berlaku di mode Manual, dan legend memberi peringatan bila skala manual jenuh.
  - Field angka berlaku saat Enter atau saat field ditinggalkan; `Esc` membatalkan, dan nilai tidak valid ditolak dengan pesan di samping field.
  - Basemap mencoba `tile.openstreetmap.de` dulu dan pindah ke `tile.openstreetmap.org` setelah beberapa kegagalan; kedua host tidak dipakai bersamaan. Bila keduanya gagal, chip "BASEMAP TIDAK TERSEDIA" muncul dan overlay tetap digambar di latar netral.
  - Tanpa WebGL2, setelah WebGL context hilang, atau bila worker MapLibre gagal, peta menampilkan pemberitahuan dan overlay kanvas sederhana. Crash di dalam peta hanya memengaruhi panel peta.
  - Kamera bertahan saat berpindah halaman. Peta membingkai ulang saat sumber posisi berubah (misalnya fix GPS nyata pertama datang) dan saat panel berubah ukuran, selama operator belum menggeser kamera.
- **Plot polar.**
  - Mode Polar menggambar θ₀ berlawanan jarum jam seperti plot Polar KrakenSDR. Mode Compass tetap north-up searah jarum jam. Pada offset 0 kedua mode menaruh lobe di tempat yang sama; hanya labelnya berbeda.
  - Skala radial otomatis mengikuti rentang data (misalnya 0–1,5 dB). Untuk rentang tetap, centang **Rentang dB manual** di Graph settings; Head Up saja tidak lagi memaksa rentang manual.
  - Modebar tidak punya tombol Share ke Plotly Cloud, dan "Download plot as a PNG" berfungsi.
  - Teks status polar menyebut penyebabnya: CONFLICT, UNAVAILABLE, INCOMPLETE, STALE, atau DEGRADED.

### Kesehatan Sistem dan Diagnostik DoA

- **Kesehatan Sistem.**
  - Badge **Data Out HTTP** dihitung dari GET per resource pada pembacaan terakhir: `AVAILABLE` (keempat file menjawab), `PARTIAL`, `UNAVAILABLE`, atau `UNKNOWN`. Di bawahnya tampil `overall_state` dari collector dalam huruf besar. Banner "STALE EVIDENCE" hanya muncul bila pembacaan terakhir punya DoA segar yang kemudian kedaluwarsa.
  - **`UNVERIFIED` pada data sehat itu normal.** Collector menentukan `overall_state` berurutan: `UNAVAILABLE` (`status.json` tidak terbaca), `DEGRADED` (DAQ tidak PASS atau ADC overdrive), `INVALID` (tidak ada view DoA yang bisa diparse), `CONFLICT`, `STALE` (tidak ada view DoA yang segar), `INCOMPLETE` (CSV dan XML tidak bisa dibandingkan), lalu `UNVERIFIED` bila belum ada sumber otoritas DoA (`authority` = `none`) atau sudut kanonik belum disetujui. Ground Console selalu memanggil collector dengan `authority="none"` dan tanpa persetujuan sudut kanonik, dan tidak ada flag atau form console yang mengubahnya. Artinya `UNVERIFIED` adalah status terbaik yang bisa tampil: data terbaca, segar, dan CSV/XML konsisten, tetapi tidak ada keputusan yang menetapkan CSV atau XML sebagai sumber bearing resmi. `LIVE` tidak pernah tampil di console ini. Bila data lokal kedaluwarsa, headline berganti menjadi `STALE`.
  - **Karena itu PUBLIKASI selalu `BLOCKED`.** Gate publikasi (PUBLIKASI di strip, Gate publikasi di Ringkasan, Pemeriksaan gate publikasi di Diagnostik DoA) baru `READY` bila semua pemeriksaannya lolos. Pada data sehat ada tiga reason yang selalu muncul: `DOA_AUTHORITY_NOT_SELECTED` (Sumber otoritas DoA belum dipilih), `CANONICAL_ANGLE_NOT_CONFIGURED` (Konvensi sudut kanonik belum disetujui), dan `GROUND_CLOCK_UNVERIFIED` (Jam ground dan node belum diverifikasi; console tidak memverifikasi jam node, sehingga baris **Jam ground** di Status subsistem selalu `UNVERIFIED`). Di Diagnostik DoA, pemeriksaan Otoritas dipilih, Sudut kanonik siap, DoA terpilih fresh, dan Satuan terpilih valid tampil `BLOCKED`, Status node fresh tampil BELUM DIKONFIGURASI, Otoritas terpilih bernilai `NONE`, dan Kesiapan sudut BELUM DIKONFIGURASI. Memilih sumber otoritas dan menyetujui sudut kanonik adalah keputusan deployment di luar console read-only ini, jadi status tersebut bukan kerusakan data atau node. Reason lain di luar ketiganya menunjukkan masalah nyata.
  - Tabel **Pembacaan resource** menampilkan setiap GET (`/status.json`, `/settings.json`, `/DOA_value.html`, `/doa.xml`) dengan kode HTTP atau jenis error (Connection refused, Timed out, Skipped, Deadline exceeded, dan seterusnya), waktu, dan jumlah percobaan. Catatan di bawahnya membandingkan waktu koleksi dengan anggaran 4 detik dan menjelaskan bila file lain dilewati karena `status.json` tidak terjangkau.
  - Inspector menampilkan status node (VALID/INVALID/UNAVAILABLE), DAQ health, Node progress (`ADVANCING`, `STALLED`, `FIRST_SAMPLE`, `UNAVAILABLE`, `UNTRACKED`), ADC overdrive (PASS, OVERDRIVE dengan mask kanal, atau UNKNOWN), SNR (native XML, tidak terkalibrasi), dan PAPR CSV/XML dalam dB. PAPR bukan confidence 0–1.
- **Diagnostik DoA.**
  - Reason gate diurutkan dari yang paling bisa ditindaklanjuti, masing-masing dengan kode mentahnya. Reason baru: `NODE_CLOCK_STALLED`, `ADC_OVERDRIVE`, `COLLECTION_DEADLINE_EXCEEDED`, `CSV_VIEW_UNAVAILABLE`, `XML_VIEW_UNAVAILABLE`, `NATIVE_ANGLE_INVALID`, `ANGULAR_PEAK_ANGLE_MISMATCH` (puncak vektor CSV berjarak lebih dari 3° dari θ₀), dan `NATIVE_ANGLE_UNCHECKED` (CSV dan XML berasal dari frame berbeda, sehingga sudutnya tidak dicek silang).
  - Relasi CSV/XML tampil sebagai EQUAL, NOT CHECKED, NOT COMPARABLE, CONFLICT, atau ANGLE INVALID, beserta relasi frame, selisih timestamp, jarak, dan toleransi.
  - Dengan Output VFO = ALL di KrakenSDR, baris CSV dipilih berdasarkan frekuensi XML, dan baris VFO lain tampil di tabel tanpa vektor. Format data "Kerberos App" tidak didukung dan mendapat error yang jelas.
  - Effective config menampilkan semua setting yang diizinkan.

### Konfigurasi

- Enter di bagian mana pun men-submit bagian itu.
- URL Data Out disimpan tanpa garis miring di akhir. Port MQTT harus bilangan bulat 1–65535.
- **Transport MQTT** (WebSocket default, atau TCP) harus sama dengan listener broker. **Path WebSocket** (default `/mqtt`) hanya dipakai dengan WebSocket. Mengubah host, port, transport, atau path me-restart monitor dan mereset penghitungnya.
- Dry-run config patch mewajibkan **Base config revision**, yaitu `config_rev` terakhir yang dilaporkan node.
- Logo PNG boleh grayscale, RGB, RGBA, atau palette, 8/16-bit, interlaced, maksimal 256 KiB dan 4096 × 4096 px. Logo diperiksa di browser sebelum di-stage.
- Pilihan sumber GPS dan Compass disimpan di browser ini dan dipulihkan setelah reload. Masing-masing punya tombol restore default sendiri. Offset kompas manual berkisar −360 sampai 360.
- Bila konfigurasi console tidak bisa dibaca, halaman menampilkan "Konfigurasi console tidak tersedia … Dicoba ulang otomatis" tanpa form. Console mencoba lagi sendiri (1, 2, 4, 8, lalu setiap 15 detik).

### Monitor Pesan

- Baris metrik: Received, Valid, Invalid, Bytes, Last latency. Last latency hanya menghitung pesan live. Di ponsel baris ini dua kolom.
- Banner menampilkan status koneksi dan transport ("MQTT over TCP" atau "MQTT over WebSocket, path /x").
- Tabel per kind:
  - **Count** adalah jumlah pesan per kind sejak monitor start.
  - **Age** menghitung naik setiap detik sejak console menerima pesan. Badge `STALE` muncul setelah doa 5 detik, nav 5 detik, health 8 detik, dan state/config_reported 65 detik. Ini ambang tampilan, bukan gate.
  - **Contract** bernilai `VALID`, `INVALID`, atau `CLEARED` (publisher menghapus nilai retained).
  - Badge `RETAINED` berarti pesan di-replay broker saat subscribe; pesan seperti itu dinilai dari timestamp-nya sendiri dan tidak punya latency.
  - Payload status menampilkan flag node apa adanya (`valid`, `doa_valid`, `settings_valid`), state health beserta reason, dan availability `ONLINE`/`OFFLINE`.
  - Badge `SYNTHETIC` muncul untuk payload dengan `source: "synthetic"`.
- **Sambungkan ulang monitor lokal** selalu membuka sesi subscriber baru dengan pengaturan broker tersimpan; penghitung dan record terakhir mulai dari nol. Tanpa tombol ini, monitor mencoba lagi sendiri dalam sekitar 10 detik.
- Client id MQTT sekarang `groundconsole` plus 10 karakter hex acak per monitor, sehingga dua console bisa memakai satu broker. ACL atau log broker yang memakai id lama `ground-console-monitor` perlu diperbarui.
- Status MQTT diperbarui sendiri setiap 2 detik di Monitor Pesan dan Kesehatan Sistem, dan setiap 5 detik di halaman lain.
- Panel **Telemetri RDF Node v2** dijelaskan di bagian MQTT di bawah.

### Shortcut keyboard

- `1`–`7` membuka halaman sesuai urutan menu, `R` me-refresh. Shortcut juga bekerja saat fokus berada di dalam Receiver, kecuali saat mengetik di field teks atau angka.
- Shortcut tetap bekerja setelah mengklik checkbox, radio button, atau slider.
- Di ponsel, shortcut menutup drawer menu yang terbuka, dan konten di belakang drawer tidak bisa dicapai dengan Tab.
- "Skip to workspace" memindahkan fokus ke isi halaman tanpa mengganti halaman.

### Console di-restart atau di-build ulang

Kode halaman, termasuk peta, diambil di latar belakang tidak lama setelah console dimuat, sehingga restart berikutnya tidak merusak navigasi. Bila sebuah halaman atau peta tetap gagal dimuat, hanya area itu yang menampilkan "Halaman ini gagal dimuat" atau pesan peta dengan tombol **Muat ulang console**. Muat ulang menghentikan sesi Receiver yang sedang berjalan.

## MQTT staging, opsional

MQTT tidak diperlukan untuk Overview atau simulasi. Ground Console memakai satu koneksi subscriber-only ke broker yang dikonfigurasi; koneksi itu membaca topic v1 dan RDF Node v2 sekaligus. `paho-mqtt` diperlukan untuk monitor MQTT dan synthetic publisher.

Koneksi MQTT default adalah `10.90.0.1:9001`, WebSocket, path `/mqtt`. Host menerima literal IPv4/IPv6 apa pun atau `localhost`, bukan nama DNS; masukkan IPv6 tanpa kurung siku. Ground Console membuka koneksi keluar ke broker, tetapi HTTP Ground Console tetap bind ke loopback. Monitor tidak punya opsi username, password, atau TLS untuk TCP maupun WebSocket, sehingga payload melintas tanpa enkripsi. Gunakan hanya broker dan jaringan tepercaya; jangan kirim payload rahasia melalui koneksi ini.

Monitor memakai MQTTv5 dan satu konfigurasi broker bersama: host, port, transport, dan WebSocket path berlaku untuk kedua keluarga topic. Filter v1 adalah `sdr/v1/uav-01/#`; RDF Node v2 memakai prefix `sdr/v2/uav-01/` dan sepuluh suffix: `telemetry/doa`, `telemetry/health`, `telemetry/health/detail`, `telemetry/angular`, `state`, `capabilities`, `config/reported`, `availability`, `ack/config`, dan `ack/operation`. Status `READY` menunggu SUBACK berhasil untuk seluruh filter bersama. Parser dan snapshot v1/v2 tetap terpisah agar validasi satu schema tidak mengubah statistik schema lain.

Konfigurasi lama `rdf_node_mqtt` tidak digunakan atau dimigrasikan; field itu hilang saat konfigurasi disimpan berikutnya. Atur endpoint kedua keluarga topic melalui **Konfigurasi → Connection**.

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

### RDF Node v2 telemetry

Pastikan `paho-mqtt==2.1.0` terpasang di virtual environment yang sama dengan Ground Console; jika dependency tidak tersedia, status monitor melaporkan error tanpa mematikan Ground Console.

Subscriber hanya membaca sepuluh filter v2 di atas. Ground tidak publish, tidak mengirim command, dan tidak mengubah setting Edge. Endpoint browser v2 hanya `GET /api/mqtt/rdf-node`.

Panel **Telemetri RDF Node v2** ada di halaman Monitor Pesan:

- Panel memakai koneksi broker yang sama dengan v1, tetapi penghitungnya terpisah. Panel dibaca setiap 2 detik hanya selama halaman Monitor Pesan terbuka.
- `READY` berarti seluruh SUBACK untuk filter bersama berhasil, bukan DAQ sehat. Availability adalah petunjuk koneksi, bukan health.
- Per topic tampil count, status (`FRESH`, `STALE`, `CONTEXT`, `INCONSISTENT`, `INVALID`, atau `UNAVAILABLE` bila belum pernah diterima), umur, RETAINED/LIVE, dan ringkasan field. Nilai retained yang dihapus publisher (pesan retained kosong) tampil `UNAVAILABLE`.
- Nilai DoA dan Angular hanya tampil selama `FRESH`. `FRESH` menjadi `STALE` bila halaman tidak membaca state v2 baru selama 5 detik.
- Untuk menerima Angular live, atur `require_ground_receipt_for_bulk=false` secara terpisah pada Edge. MQTT v2 tidak mengubah HTTP Data Out, publication gate, atau simulasi Overview.

Broker TLS, PPP/T900, dan MQTT production tidak disiapkan oleh quickstart ini. Contoh payload dan fixture lokal bukan bukti kompatibilitas perangkat atau acceptance hardware.

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

### Data Out UNAVAILABLE, ERROR, atau STALE

Ini tidak selalu berarti frontend rusak. Buka **Kesehatan Sistem → Pembacaan resource** untuk melihat file mana yang gagal dan kenapa. Periksa DNS atau koneksi ke `doasdr.local:8081`, dan gunakan alamat Data Out yang diizinkan. `STALE` dengan `NODE_CLOCK_STALLED` berarti port 8081 menjawab tetapi DSP node berhenti. `DEGRADED` berarti DAQ sync gagal atau ADC overdrive; turunkan gain bila overdrive. Gunakan tab **Simulasi** untuk memeriksa renderer tanpa hardware.

### Basemap OSM tidak tampil

MapLibre membutuhkan koneksi HTTPS ke `tile.openstreetmap.de` atau `tile.openstreetmap.org` dan CSP yang sesuai. Kegagalan tile tidak berarti overlay atau polar plot gagal; chip "BASEMAP TIDAK TERSEDIA" muncul bila semua host gagal.

### Keamanan lokal

Tetap gunakan `--bind 127.0.0.1`. Jangan memakai `0.0.0.0` untuk quickstart, jangan memasukkan secret ke frontend, dan jangan menganggap config dry-run sebagai command nyata ke Raspberry.
