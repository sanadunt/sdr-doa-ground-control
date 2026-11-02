# Catatan perubahan

Versi mengikuti `VERSION`. Rilis dibuat oleh CI dari tag `v<VERSION>` (lihat `QUICKSTART.md`, "Rilis di GitHub").

## 3.8.0

Rilis minor: tidak ada yang dihapus. Tablet di mode LAN kini bisa **mendengar** audio Receiver groundstation (keputusan pemilik 2026-11-02). Ini jalur baca baru di listener LAN, bukan penulisan; tetap tanpa login, untuk setiap klien di `allowed_clients`. Kanal `3` dan timer update memasangnya sendiri.

- **Dengar di tablet.** Tombol **Dengar** di dock MIRROR dan di kartu Spektrum rute Receiver tablet kini aktif, dan menyalakan audio di tablet itu sendiri.
  - Klik pertama membuka audio di dalam klik itu (aturan autoplay browser). Dengar mati setiap kali halaman dimuat.
  - Di sampingnya tertulis perkiraan tunda, sekitar **≈ 0,5 dtk**.
  - Bila tidak ada suara, tertulis alasannya: "Tidak ada audio dari groundstation (VFO bisu?)", "RX OFF · tidak ada audio", "Pindai berjalan; tidak ada audio", **SUMBER PUTUS**, "Pendengar penuh (4)" atau "Browser menahan audio; ketuk Dengar lagi."
  - Yang terdengar persis yang diputar speaker groundstation: VFO yang dibisukan di sana juga bisu di tablet. Tablet tidak menala, tidak membuka bisu VFO dan tidak merekam.
- **Cara kerjanya.** Selama ada pendengar, halaman groundstation menyadap audio Receiver, menurunkannya ke PCM 16 kHz, dan mengirim potongan 200 ms ke console (`POST /api/mirror/receiver/audio`, hanya loopback).
  - Tablet membaca satu stream `GET /api/mirror/receiver/audio`: paling banyak 4 pendengar dan satu per alamat, sekitar 256 kbit/s per tablet.
  - Server hanya menyimpan 2 detik terakhir di memori dan tidak menulis apa pun ke disk. Menutup mode LAN memutus semua stream.
  - Tanpa pendengar, halaman groundstation tidak menyadap apa pun.
  - Setiap stream yang dibuka dan ditutup tercatat di log console dengan alamat tablet.
- **Halaman groundstation tetap harus terbuka.** Audio tetap mengalir saat tab groundstation tersembunyi selama Receiver memutar suara. Bila halaman ditutup atau dimuat ulang, tablet menampilkan **SUMBER PUTUS** dan menyambung lagi sendiri. Halaman groundstation yang dimuat sebelum 3.8.0 tidak mengirim audio, jadi muat ulang sekali setelah update.
- Kontrak lengkap, pilihan yang ditimbang (WebRTC, Opus) dan pengukuran latensinya ada di `docs/RECEIVER_MIRROR.md` bagian 10a.

## 3.7.0

Rilis minor: tidak ada yang dihapus, dan tanpa file peta semuanya berjalan seperti 3.6.0. Menu peta mendapat gaya **Offline**: peta dari satu file di console sendiri, yang tampil tanpa internet.

- **Gaya Offline.** Peta vektor (jalan, bangunan, air, batas wilayah, nama tempat; data OpenStreetMap dalam format Protomaps) digambar dari `maps/offline.pmtiles`, di sebelah `console.json` (`--maps-dir` mengubahnya; Docker: `/data/maps`). Tidak ada permintaan ke penyedia tile, tampilan LAN (tablet) ikut bisa memakainya, dan gaya lain tidak berubah. Tanpa file itu, gaya Offline menampilkan BASEMAP UNAVAILABLE · Offline.
  - Cakupan dan zoom tertinggi mengikuti file; di atasnya peta hanya diperbesar. Seluruh Indonesia sampai zoom 12 berukuran 216 MB, sampai zoom 13 454 MB, sampai zoom 14 942 MB.
  - Tanpa ikon POI dan perisai jalan; nama tempat memakai huruf Latin.
- **Rute baru `GET /api/maps/offline.pmtiles`.** Satu nama file tetap, hanya baca: browser membaca file dengan permintaan rentang byte, jadi `Range` wajib dan satu jawaban paling banyak 4 MiB. Tampilan LAN menjawab path itu saja; tidak ada yang bisa ditulis lewatnya.
- **Memasang file.** `docs/PETA_OFFLINE.md` menjelaskan cara membuat file dengan `pmtiles extract` dan memasangnya. Di Docker: `docker compose exec console mkdir -p /data/maps`, lalu `docker compose cp offline.pmtiles console:/data/maps/offline.pmtiles`. Console membaca file pada setiap permintaan, jadi mengganti file tidak perlu restart.
- Font peta (Noto Sans, lisensi SIL OFL) ikut di `assets/map-fonts`; dependensi frontend baru `pmtiles` dan `@protomaps/basemaps`.

## 3.6.0

Rilis minor: tidak ada yang dihapus. Groundstation kini punya lokasi sendiri dari GPS USB-nya, dan peta menampilkan jaraknya ke RDF-SDR. Kanal `3` dan timer update memasang console-nya sendiri. Pembaca GPS di host dipasang sekali dengan `sudo`.

- **GPS groundstation.** Service host baru, `packaging/ground-gps`, membaca GPS USB groundstation (u-blox 7).
  - Ia berjalan di luar Docker seperti jembatan LoRa, hanya membaca, dan tidak bisa membuka port LoRa.
  - Posisinya diterbitkan ke broker lokal di topik `sdr/v2/uav-01/ground/gps`. Console membacanya lewat MQTT, tanpa akses ke perangkat USB.
  - Pasang: `sudo sh packaging/ground-gps/install.sh` dari tarball rilis. Coba dulu dengan `--dry-run`.
- **Di peta:** penanda kotak "GS" dan garis titik-titik ke RDF-SDR, dengan jarak dan arah.
  - Bila posisi RDF-SDR bukan posisi langsung (cadangan, manual, atau posisi terakhir yang ditahan), garisnya abu-abu dan bertanda "REFERENCE".
  - Kartu RDF-SDR punya baris Groundstation, misalnya "FIX 3D · 4 sat · 1.23 km", dan System Health punya kartu GPS groundstation.
  - Tablet di tampilan LAN ikut melihatnya.
- **Heading RDF-SDR di peta.** Kompas RDF-SDR (heading dari `telemetry/health`) ditampilkan sebagai segitiga ungu di lingkaran stasiun dan garis putus-putus dengan label "HDG 87°". Keduanya otomatis berputar mengikuti heading.
  - Heading yang sudah basi tampil abu-abu dengan tanda BASI. Bila kompas tidak OK, tidak ada yang digambar.
  - Bisa dinyalakan atau dimatikan di Lapisan.
  - Ini arah gerak RDF-SDR, terpisah dari garis bearing DoA.
- **Jarak UCA dari Kontrol (RDF Node Edge 1.8).** Kontrol menampilkan kolom "Jarak UCA" bila RDF-SDR mendukungnya.
  - Rule band mengirim 0,3 m (VHF) atau 0,128 m (UHF) bersama gain.
  - Di band ini engine KrakenSDR menetapkan jaraknya sendiri. Jarak lain ditolak RDF-SDR dengan pesan, dan Kontrol menyebut bila RDF-SDR ikut menulis jarak band.
  - Di luar rule band, Kontrol menulis bahwa RDF-SDR mengatur jarak UCA sendiri untuk frekuensi itu.
  - Kartu RDF-SDR menampilkan UCA sebagai setelan.
  - Edge yang lebih lama tetap memakai lima kolom seperti sebelumnya.

## 3.5.0

Rilis minor: tidak ada yang dihapus. Console membaca tambahan kontrak 1.7 dari RDF Node Edge 1.7.0, sehingga lewat Telemetry LoRa Dashboard menampilkan frekuensi, dB dan setelan SDR, dan Kontrol menampilkan cara RDF-SDR menerapkan perubahan. Edge yang lebih lama tetap tampil seperti sebelumnya. Kanal `3` dan timer update memasangnya sendiri.

- **Frekuensi dan dB di HUD dan kartu RDF-SDR.**
  - Satu baris "Sinyal" menampilkan frekuensi dan daya rekaman DoA, misalnya "103.100 MHz · -97.1 dB".
  - DoA `ok=0` (belum diverifikasi di RDF-SDR) tetap ditampilkan, tetapi redup dan bertanda BELUM VALID, tidak pernah dengan gaya data yang valid.
  - Tanpa rekaman terkini, HUD menampilkan frekuensi yang disetel dengan label "Setelan".
- **Setelan SDR lewat LoRa (`state.rf`).** Frekuensi tengah, gain, VFO0, bandwidth dan squelch kini muncul di kartu RDF-SDR, bertanda "setelan": nilai settings.json, bukan bukti radio berjalan dengannya. "Ikuti frekuensi node" di dock Spektrum juga memakainya.
- **ADC overdrive lewat LoRa.** RDF-SDR melaporkan ADC overdrive di `telemetry/health/detail` (`ovr`), dan console memakainya selama 65 detik.
  - Overdrive menyembunyikan bearing, sama seperti lewat Data Out.
  - `false` menghapus DOA `DEGRADED` karena "ADC overdrive tidak diketahui". System Health menampilkan ADC dari `health/detail`.
- **Kontrol menyebut tahap dan cara penerapan.**
  - Selama menunggu: "RDF-SDR melakukan retune langsung…" atau "RDF-SDR me-restart SDR (alasan)…". Contoh alasan: perubahan gain, lompatan frekuensi, atau engine yang menimpa gain saat retune langsung.
  - Setelah `APPLIED`: "Diterapkan dengan retune langsung" atau "Diterapkan dengan restart SDR (alasan)". Kode dan bukti DAQ tampil di baris kode.
  - Hasil 1.7 lainnya punya teks sendiri:
    - engine tidak berhenti (settings.json tidak diubah);
    - DAQ tidak sehat setelah restart;
    - engine tidak berjalan;
    - engine mengubah nilai saat mulai.
  - Begitu RDF-SDR menyebut retune langsung atau restart, Kontrol menunggu hasil akhir sampai 270 detik, bukan 90 detik. Restart SDR bisa makan waktu hingga batas start 180 detik.
  - `APPLIED` tetap satu-satunya keberhasilan, dan tidak ada yang dikirim ulang.
- **Rule band frekuensi di Kontrol.** Frekuensi tengah baru di dalam sebuah band otomatis membawa gain band itu. Ini berlaku saat diketik maupun saat dikirim dari dock Spektrum:
  - **VHF 136–174 MHz:** gain 25.4 dB, UCA 0,3 m.
  - **UHF 400–480 MHz:** gain 15.7 dB, UCA 0,128 m.

  Nilai 25 dan 15 dB dari rule dibulatkan ke nilai terdekat di tabel gain KrakenSDR. Di luar kedua band, gain tidak diubah. Kontrol menulis band mana yang berlaku. Jarak UCA belum bisa dikirim karena RDF-SDR belum menerimanya lewat `config.patch`, jadi untuk sementara atur di RDF-SDR.
- **Tablet 8".**
  - Dalam portrait, strip status yang memuat Telemetry LoRa menjadi dua baris berisi empat, sehingga UNAVAILABLE dan label Telemetry LoRa tidak lagi terpotong.
  - Waterfall Mirror Receiver mengisi kartunya.
  - Baris pertama kartu RDF-SDR dan label kode di DoA Diagnostics boleh pindah baris.
  - Saat halaman dimuat, tertulis "Menunggu pembacaan pertama", bukan "Menunggu Data Out".
- **LoRa tanpa telemetri segar.** Bila RDF-SDR terhubung lewat LoRa tetapi telemetrinya tidak segar (misalnya DAQ dilaporkan tidak sehat), HUD, kartu RDF-SDR, chip DATA, System Health dan DoA Diagnostics menulis "Belum ada telemetri RDF-SDR terkini lewat Telemetry LoRa", bukan "Data Out tidak terjangkau" atau tabel CSV/XML.

## 3.4.4

Rilis patch: tidak ada yang dihapus. Selama Telemetry LoRa, halaman data tidak lagi menyebut Data Out, settings.json atau PPP, yang tidak dipakai di jalur itu. Tanpa jembatan LoRa, semuanya tetap seperti biasa. Kanal `3` dan timer update memasangnya sendiri.

- **ADC overdrive lewat LoRa.** Alasan gate kini `ADC_OVERDRIVE_NOT_OVER_LORA`: "ADC overdrive tidak dikirim lewat Telemetry LoRa".
  - Alasan lama, `ADC_OVERDRIVE_UNKNOWN`, menyebut status.json, doa.xml dan Data Out.
  - Ini sifat jalurnya, bukan masalah data. Delivery/Publikasi tidak lagi menulis ADA MASALAH karenanya, dan tooltip DATA menyebut alasan yang sebenarnya, misalnya DoA yang belum dikirim RDF-SDR.
- **Dashboard.**
  - Notice peta kini "offset kompas tidak tersedia lewat Telemetry LoRa", bukan "settings Data Out belum terbaca".
  - Tombol muat ulang bernama "Muat ulang".
  - Kartu RDF-SDR tidak lagi menampilkan alamat Data Out, DAQ frame dan Remote control.
- **System Health.** Chip HTTP, ubin SNR dan PAPR, Frame index dan Noise source disembunyikan.
  - ADC menulis "tidak tersedia lewat Telemetry LoRa".
  - Status GPS diambil dari `telemetry/health`.
- **DoA Diagnostics.**
  - Sumber ditulis "MQTT · Telemetry LoRa".
  - Baris Native views, Settings source dan `raw_settings_omitted` disembunyikan.
  - Effective config menjelaskan bahwa settings.json tidak dibaca lewat LoRa, dan Kontrol → Baca settings menanyakannya ke RDF-SDR.
- **Configuration.** Pilihan sumber "Data Out" di GPS & Compass bernama "RDF-SDR (Telemetry LoRa)".
- **Message Monitor.** Field PPP dari `telemetry/health/detail` (`ppp`, `peer`, `ppp_svc`, `ppp_restarts`) tidak ditampilkan.

## 3.4.3

Rilis patch: tidak ada yang dihapus. Pemeriksaan Kontrol setelah sebuah perintah kini menyebut apa yang sebenarnya diperiksanya: isi settings.json RDF-SDR, bukan radio yang berjalan. Kanal `3` dan timer update memasangnya sendiri.

- **"Tersimpan di settings.json", bukan "RDF-SDR berubah".** Pemeriksaan membandingkan nilai yang dikirim dengan settings.json yang dilaporkan RDF-SDR. Nilai yang cocok berarti tersimpan di sana, bukan bahwa radio berjalan dengan nilai itu.
  - Pada uji 1 November, KrakenSDR menyimpan 105 MHz lalu DAQ-nya gagal, tetapi Kontrol menulis "RDF-SDR berubah · CONFIRMED".
  - Kini judulnya **Cek settings.json** dan statusnya **`SAVED`**, dengan nada info, bukan hijau.
  - Ringkasannya "Tersimpan di settings.json · n/m", "Sebagian tersimpan…", "Memeriksa settings.json…" atau "settings.json belum berubah".
- **Bukti radio berjalan tetap hanya `APPLIED`** dari RDF-SDR sendiri.
  - `PERSISTED_UNVERIFIED` kini berbunyi: tersimpan, tetapi belum ada bukti radio berjalan dengan setiap nilai.
  - Periksa status DAQ dan DoA sebelum mengirim lagi.

## 3.4.2

Rilis patch: tidak ada yang dihapus. Console kini menyesuaikan diri dengan Telemetry LoRa: Data Out disembunyikan selama jalurnya LoRa, Kontrol menyebut perintah yang menunggu giliran radio, dan dock Polar menyebut umur kurva Angular. Kanal `3` dan timer update memasangnya sendiri.

- **Data Out tidak dipakai selama Telemetry LoRa.** Selama broker groundstation memegang status jembatan `lora/ground`, console sama sekali tidak membaca Data Out.
  - Tidak ada lagi bacaan ringan tiap 30 detik yang pasti gagal.
  - Bila MQTT tidak segar, sumber langsung **tidak ada**, dengan alasan "Data Out tidak dipakai lewat Telemetry LoRa" (`DATA_OUT_NOT_OVER_LORA`). Console tidak menunggu 4 detik untuk Data Out yang tidak terjangkau.
  - **Konfigurasi:** URL dan daftar host Data Out dilipat ke "Data Out · tidak dipakai selama Telemetry LoRa". Setelannya tetap tersimpan.
  - **System Health:** kartu Data Out tidak ditampilkan.
  - Tanpa jembatan LoRa, semuanya kembali seperti biasa.
- **Kontrol menunggu giliran radio.** Lewat Telemetry LoRa sebuah perintah menunggu giliran pancar groundstation (ACK biasanya 2–5 detik). Selama perintah sudah dikirim tapi belum dijawab, Kontrol menulis "Menunggu giliran radio Telemetry LoRa…".
  - Batas waktunya tidak berubah: tidak ada ACK sampai batas 15 detik ditambah 5 detik, dan tidak ada yang dikirim ulang otomatis.
  - Hanya satu patch dan satu Baca settings yang berjalan sekaligus.
- **Umur kurva Angular.** Lewat Telemetry LoRa frame Angular datang paling cepat tiap 20 detik. Kaki dock Polar kini menyebut umurnya ("Angular 14 dtk lalu"), supaya kurva tidak terlihat macet.
- **Ritme jembatan LoRa yang baru** (health sekitar tiap 2 detik dengan `q` naik sekitar 2, DoA diprioritaskan) sudah cocok dengan aturan console: health dianggap segar 8 detik selama `q` naik, dan indikator data masuk memakai jumlah pesan antar status jembatan.

## 3.4.1

Rilis patch: tidak ada yang dihapus. Istilah link LoRa di console kini **Telemetry LoRa**, dan kartu node menampilkan kompas dan GPS RDF-SDR. Kanal `3` dan timer update memasangnya sendiri.

- **Telemetry LoRa.** Lewat jembatan LoRa serial, console tetap membaca topik MQTT RDF Node dari broker lokal groundstation, tapi tampilan kini menyebut jalurnya. Chip **Sumber** dan badge HUD menjadi **Telemetry LoRa** selama jawaban MQTT membawa `source.link: "lora"` (tanpa jembatan tetap **MQTT**). "Tidak ada DoA LIVE lewat MQTT" menjadi **"Tidak ada DoA LIVE lewat Telemetry LoRa"**, juga di notifikasi peta dan DoA Diagnostics. Chip, kartu System Health, tooltip, dan teks "tidak tersedia lewat Telemetry LoRa" memakai nama yang sama. Chip **MQTT** tetap: itu koneksi console ke broker lokal yang juga dipakai jembatan.
- **Panel Kontrol berjudul "Kontrol RDF-SDR"** (sebelumnya "Kontrol MQTT"): yang dikendalikan adalah RDF-SDR, apa pun jalurnya.
- **Kompas dan GPS RDF-SDR di kartu node.** Bila RDF Node 1.6 mengirim field nav di `telemetry/health`, kartu node (dibuka) menampilkan heading kompas (atau state-nya bila belum `OK`), state GPS dengan fix dan jumlah satelit, ketinggian dan kecepatan. Heading hanya ditampilkan; bearing di peta tetap memakai offset kompas yang dipilih.

## 3.4.0

Rilis minor: tidak ada yang dihapus. Console kini siap untuk link LoRa serial ke RDF-SDR, yang menggantikan T900/PPP. Ada status link LoRa di bilah atas dan System Health, posisi stasiun dari GPS RDF-SDR, dan label jujur untuk nilai yang tidak bisa lewat LoRa. Kanal `3` dan timer update memasangnya sendiri. Tanpa jembatan LoRa, tampilan console sama seperti 3.3.0.

- **Jembatan LoRa bukan bagian console.** Link-nya dibawa jembatan RDF Node `run.py lora-bridge` (protokol RLS1, `docs/LORA_SERIAL.md` di `sanadunt/rdf-indicator-raspberry`), yang dipasang terpisah di kedua sisi: `--role edge` di RDF-SDR dan `--role ground` di groundstation. Jembatan itu meneruskan topik MQTT RDF Node apa adanya ke broker groundstation, jadi kontrak MQTT dan Kontrol tidak berubah.
- **Chip LoRa di bilah atas**, setelah MQTT, hanya bila jembatan groundstation mempublish statusnya (`sdr/v2/<node>/lora/ground`):
  - `RX` (titiknya berkedip): telemetri masuk lewat radio
  - `IDLE`: hanya heartbeat
  - `NO RX`: tidak ada frame 6 detik
  - `DOWN`: jembatan tidak menerima frame 15 detik
  - `PORT`: port radio tidak bisa dibuka
  - `STALE`: status jembatan sendiri lebih tua dari 15 detik, artinya jembatan berhenti

  Chip berwarna peringatan dan tooltip-nya menjelaskan bila jam RDF-SDR selisih lebih dari 1 detik, karena datanya akan ditolak `SOURCE_TIMESTAMP_NOT_FRESH`.
- **Kartu Link LoRa di System Health**: data masuk, frame terakhir, pesan dan frame per detik, error CRC, frame hilang, yang diterima RDF-SDR, selisih jam, antrean kirim, port radio, broker jembatan, umur status, dan pergantian link. `GET /api/mqtt` membawanya sebagai `lora`.
- **Posisi stasiun dari GPS RDF-SDR.**
  - Console membaca field nav opsional di `telemetry/health` (kontrak 1.6: kompas, status GPS, fix, satelit, lat/lon, ketinggian, kecepatan, arah). Field nav yang rusak dibuang dengan catatan dan tidak pernah membuat health ditolak.
  - Peta memakai lat/lon itu bila Data Out tidak memberi posisi, hanya dengan fix GPS. Di RDF-SDR, `nav.gps.publish_position` harus menyala.
  - doa.xml Data Out tetap didahulukan bila ada.
- **"Tidak tersedia lewat LoRa".** Lewat LoRa tidak ada jalur IP, jadi tidak ada Data Out.
  - Kartu node menulis "tidak tersedia lewat LoRa" untuk frekuensi tengah, gain, SNR dan ADC.
  - HUD menulis "ADC overdrive tidak diketahui · tidak tersedia lewat LoRa"; DOA tetap `DEGRADED`, bearing tetap tampil.
  - Tidak ada nilai yang dikarang. Jawaban `/api/snapshot` dari MQTT membawa `source.link: "lora"` dan blok `nav`.

## 3.3.0

Rilis minor: tidak ada yang dihapus. Tablet di tampilan LAN kini bisa menandai spektrum, dan console groundstation punya tombol Mulai ulang dan Matikan. Kanal `3` dan timer update memasang image-nya sendiri. Tombol daya baru aktif setelah langkah host sekali: script `sdr-doa-docker` 3.3.0, `sdr-doa-docker install`, dan `packaging/host-power/install.sh` (lihat poin Docker di bawah).

- **Penanda dari tablet.** Tampilan LAN kini bisa menambah dan menghapus penanda spektrum Receiver groundstation, sementara operator groundstation memperhatikan DoA (keputusan pemilik 2026-10-31). Ini satu-satunya penulisan dari tampilan LAN; tune, gain, pindai, dengar dan pengaturan tetap tertutup.
  - Tombol **Penanda** di dock MIRROR dan di kartu Spektrum rute Receiver tablet. Ketuk grafik untuk menambah penanda, ketuk dekat penanda untuk memilihnya, lalu **Hapus**. Tombol keyboard sama dengan dock groundstation, kecuali panah dan **Tala ke sini**: tablet tidak menala.
  - Penanda masuk daftar **Penanda spektrum** Receiver sendiri, langsung tampil di dock dan halaman Receiver groundstation, dan tersimpan ke marker set yang dipilih di sana. Tanpa login: setiap klien di `allowed_clients` boleh menambah penanda dan menghapus penanda mana pun, termasuk buatan operator. Matikan tampilan LAN atau persempit `allowed_clients` bila itu tidak boleh.
  - Jalurnya: `POST /api/mirror/receiver/markers` di listener LAN (hanya method dan path ini, `Origin` harus halaman tampilan LAN itu sendiri, 512 byte, 4 perintah per detik per tablet, antrean 16, kedaluwarsa 15 detik), lalu halaman console groundstation mengambilnya dari jawaban post mirror-nya, menjalankannya lewat bridge Receiver, dan melaporkan hasilnya. Tablet membaca statusnya di `GET /api/mirror/receiver/markers/<id>`. Setiap perintah tercatat di log console dengan alamat tablet.
  - Menandai dijeda dengan alasannya selama mirror **SUMBER PUTUS** atau `STALE`. Halaman groundstation yang dimuat sebelum update belum menjalankan perintah penanda (perintahnya kedaluwarsa); muat ulang halaman itu sekali setelah update.
- **Heartbeat mirror 500 ms** (sebelumnya 2 detik), supaya perintah penanda diambil cepat juga saat RX berhenti. Post mirror kini juga membawa daftar penanda Receiver (paling banyak 64 terdekat dari tampilan).
- **Mulai ulang dan Matikan PC groundstation dari console.** Bilah atas punya dua tombol setelah EN|ID, hanya di halaman console groundstation sendiri: tablet di tampilan LAN tidak mendapat tombol, `host_power` di `/api/capabilities`, maupun route-nya (`POST` di listener LAN tetap `405 LAN_READ_ONLY`). Klik membuka konfirmasi yang menyebut aksinya, dengan fokus di **Batal** dan Escape untuk batal; konfirmasi memperingatkan bila `/api/health` melaporkan `receiver_busy` (rekaman atau pindai Receiver sedang ditulis). Tanpa admin: keputusan pemilik 2026-10-31.
- **Satu kata, satu direktori.** `POST /api/host/power {action, confirm: true}` hanya dari `Origin` loopback yang sama, body paling besar 256 byte. Console menulis `/run/sdr-doa-host-power/request` berisi tepat `reboot` atau `poweroff`, secara atomik, dan tidak menjalankan apa pun di host. Kode errornya sendiri (`HOST_POWER_*`, di luar daftar kode Kontrol); `503 HOST_POWER_UNAVAILABLE` dengan alasannya bila sisi host belum dipasang.
- **Sisi host baru: `packaging/host-power`** (di tarball console, tidak di image). Aturan tmpfiles.d membuat direktori permintaan untuk uid console, unit `.path` memicu service root oneshot (`PrivateDevices=yes`) yang mengambil permintaan dengan hard link ke direktori milik root sebelum memeriksa atau membacanya, tanpa menunggu (user console tidak bisa menukarnya dengan FIFO atau symlink, menahannya dengan lease, atau membuatnya disalin), hanya menerima dua kata itu, menghapus permintaan sebelum bertindak, menolak permintaan kedua dalam 60 detik pada boot yang sama, mencatat dengan tag `sdr-doa-host-power`, lalu menjalankan `systemctl reboot` atau `systemctl poweroff`. Pasang dengan `sudo sh packaging/host-power/install.sh` (Docker, uid 10001) atau `--console-user <user>` (native); `--helper-dry-run` untuk uji tanpa mematikan PC. Langkahnya di `docs/RUNBOOK_INSTALL_UPDATE.md` 5.5.
- **Docker: satu mount host.** Setiap compose (dan `compose.yml` yang ditulis `sdr-doa-docker`) me-mount `/run/sdr-doa-host-power` ke path yang sama; tetap tanpa socket Docker, D-Bus, capability tambahan, atau port. `sdr-doa-docker update` dan timernya hanya mengganti image dan tidak menulis ulang `compose.yml`, jadi instalasi yang ada tetap tanpa mount setelah update dan tombolnya tampil nonaktif dengan alasan "Direktori permintaan belum di-mount". `update` juga tidak mengganti script `sdr-doa-docker` yang terpasang, dan `install` dari script 3.2.0 itu menulis `compose.yml` tanpa mount. Perbaikannya sekali: pasang dulu script 3.3.0 (`sudo install -m 0755 sdr-doa-docker /usr/local/bin/sdr-doa-docker`), lalu `sudo /usr/local/bin/sdr-doa-docker install --dir /opt/sdr-doa-ground-console`: `.env`, volume `sdr-doa-data` dan timer update tetap, dan `packaging/host-power/install.sh` memperingatkan bila mount itu belum ada. Tanpa sisi host kedua tombol tampil nonaktif dengan alasan "Helper host belum dipasang".

## 3.2.0

Rilis minor: tidak ada yang dihapus. Tampilan LAN kini juga membaca **Rekaman** Receiver, hanya baca, dan mirror Receiver-nya menampilkan gain pindai dan frame pertama mode baru dengan benar. Kanal `3` dan timer update memasangnya sendiri.

- **Rekaman di tablet.** Rute Receiver di tampilan LAN punya tab **Mirror | Rekaman**. Rekaman menampilkan rekaman audio dan pindai groundstation per hari (kalender bertitik, linimasa 24 jam, filter jenis, status, frekuensi dan cari, 50 baris per halaman) atau semua tanggal, memutar audio, menampilkan pratinjau pindai, dan mengunduh satu rekaman per baris (`.webm` atau ZIP pindai). Hapus, ZIP pilihan, Retensi dan Arsip otomatis tetap hanya di groundstation.
- **Ikut terbuka bersama tampilan LAN**, tanpa pengaturan baru: setelah update, setiap klien di `allowed_clients` bisa membaca dan mengunduh rekaman. Matikan tampilan LAN bila rekaman tidak boleh terlihat dari LAN.
- **Hanya route baca yang dibuka** (`GET`, dicocokkan persis dengan UUID rekaman): `archive/facets`, `calendar`, `timeline`, `items`, `scans/<id>/preview`, `audio/<id>/download`, `scans/<id>/download` dan `audio-segments/<id>/audio`. Aturan bacanya sendiri: aturan `Host` tampilan LAN dan `Sec-Fetch-Site` tidak ada, `none` atau `same-origin`. Pengaturan Receiver, set penanda, route pindai mentah, ekspor, hapus, retensi dan setiap penulisan tetap `LAN_READ_ONLY`.
- **Batas beban**, karena setiap bacaan memakai kunci penyimpanan yang sama dengan upload rekaman yang sedang berjalan: satu bacaan daftar per tablet (yang kedua menunggu sampai 5 detik, lalu `429 LAN_RECORDS_BUSY`), paling banyak 50 baris per halaman, 4 unduhan atau pemutaran per tablet, dan satu ZIP pindai untuk seluruh tampilan LAN, terpisah dari dua slot ZIP groundstation. `HEAD` pada unduhan dan pemutaran dijawab `405`, jadi tidak membaca file atau membuat ZIP. Bacaan dari LAN tidak menutup sesi rekaman yang macet; itu tetap terjadi pada bacaan lokal berikutnya.
- **Gain pindai di mirror.** Selama pindai lebar dimulai, berjalan atau berhenti, baris LNA, VGA dan +14 dB di rute Receiver tablet menampilkan gain pindai itu sendiri (`LNA · pindai`), bukan gain RX, dan baris info dock MIRROR di mode Spektrum menampilkannya juga. Halaman groundstation yang dimuat sebelum update belum mengirim gain pindai; mirror tetap berjalan dan baris itu tampil `—` sampai halaman itu dimuat ulang.
- **Frame pertama mode baru tidak lagi hilang di mirror.** Tablet yang dibuka setelah pindai berhenti kini menampilkan trace dan waterfall terakhir pindai itu di bawah SCAN OFF, bukan kanvas kosong, dan frame pertama setelah pindah RX ↔ Spektrum ikut tergambar.

## 3.1.0

Rilis minor: tidak ada yang dihapus. Console kini mengikuti prinsip data di `docs/PRINSIP_DATA.md`: data tetap mengalir, dibaca dengan longgar, diberi label alih-alih ditolak, dan kegagalan tampil dalam bahasa operator. Kanal `3` dan timer update memasangnya sendiri.

### Pembacaan

- **MQTT** (`tools/rdf_node_mqtt_v2.py`):
  - Hanya pesan yang tidak terbaca yang `INVALID`, dengan kodenya: bukan JSON, bukan objek, `sid` kosong atau rusak, `v` lain, terlalu besar, field inti hilang, atau encoding Angular selain `json`.
  - Variasi lain diterima dengan catatan `KODE:field` yang terlihat di Monitor Pesan: angka sebagai teks, boolean `0`/`1`, waktu dalam detik, field opsional yang hilang, QoS atau retain lain, status ACK yang tidak dikenal, bukti Angular yang tidak lengkap, dan penghitung `q` yang mulai ulang.
  - Health, DoA dan Angular di luar jendela waktunya atau tanpa health tetap disimpan sebagai `STALE` atau `INCONSISTENT`. Aturan `LIVE` tidak berubah.
- **Data Out (cadangan)**:
  - status.json cukup punya `timestamp_ms`. Field DAQ yang hilang membuat DAQ `UNKNOWN` (`DAQ_HEALTH_UNKNOWN`), bukan `FAIL`. Overdrive yang tidak dilaporkan di mana pun "tidak diketahui" (`ADC_OVERDRIVE_UNKNOWN`), bukan lolos.
  - CSV dan XML hanya mewajibkan waktu, sudut dan vektor 360 bin. Kolom lain menjadi null.
  - CSV multi-VFO tanpa satu frekuensi XML yang cocok memakai baris VFO 0 (`CSV_VFO_ROW_UNCONFIRMED`).
  - Light read yang gagal tidak menghapus nilai light read baik terakhir selama nilainya masih berlaku (65 detik).

### Tampilan

- **DoA belum valid tetap tampil.** Ini berlaku untuk DoA ok=0, rekaman basi, node macet, dan DAQ yang tidak diketahui.
  - Di HUD, bearing terakhirnya redup dengan label **BELUM VALID** atau **BASI N dtk**.
  - Di peta, garisnya putus-putus abu-abu berlabel BELUM VALID.
  - Konflik CSV/XML, DAQ gagal, dan ADC overdrive tetap disembunyikan.
- **Data Out tanpa doa.xml** menggambar tampilan CSV saja dengan status DoA `PARTIAL` dan label **SEBAGIAN**.
- **Kurva polar** terakhir tetap tampil redup dengan "Belum ada update · terakhir HH.MM.SS".
- **Chip Publikasi** berisi **PERLU DISIAPKAN** bila yang menahan hanya pengaturan, atau **ADA MASALAH** bila datanya bermasalah. Klik chip untuk membuka checklist alasan dan pemeriksaan gate.
- **DoA Diagnostics** menulis "Sumber: MQTT · Data Out (cadangan) tidak dipakai" di kartu DoA MQTT.
- **Banner REFERENSI kompas** di peta menyebut penyebabnya dan punya tombol ke Konfigurasi → GPS & Kompas.

### Kontrol

- **Revisi berubah tidak lagi mengunci Kontrol.** Ini berlaku untuk `CONFIG_REVISION_STALE`, `CONFIG_REVISION_UNKNOWN`, `state.cfg` yang berubah saat meninjau, dan `CONFIG_REVISION_CONFLICT` dari RDF-SDR. Console meminta settings, membaca ulang nilai, dan menampilkan lagi perubahan yang sama di revisi baru. Satu kali Kirim mengonfirmasinya.
- **`config.get` dikirim sendiri** sekali per sesi dan revisi RDF-SDR, juga saat `state.cfg` belum ada.
- **`remote_config_patch false`**: Kirim tetap bisa dipakai setelah peringatan dan konfirmasi kedua.
- **Hasil ACK dalam bahasa operator** (Diterapkan, Tersimpan belum terbukti, Hasil tidak diketahui, Ditolak RDF-SDR, ...), dengan kode mentahnya di baris "Kode: …".
  - `OSERROR`, `FILENOTFOUNDERROR`, `PERMISSIONERROR` dan `TIMEOUTEXPIRED` menyebut helper settings di RDF-SDR sebagai penyebab yang mungkin.
  - `CONNECTION_LOST` menyebut link yang putus.
- **Tidak berubah**: login admin, tinjauan, batas nilai, expiry 15 detik, bind `127.0.0.1`, dan mode LAN lihat-saja.

### Dokumen

- `docs/PRINSIP_DATA.md` (baru).
- Aturan validasi di `docs/MQTT_KONTRAK.md` bagian 3.
- `QUICKSTART.md`.
- Runbook bagian 7.4: langkah sekali untuk merapikan groundstation lama, yaitu mode LAN lihat-saja menggantikan forward `socat`, Data Out langsung ke IP RDF-SDR, kanal `3` dengan auto-update, dan hapus retained `sdr/v2/uav-01/config/reported` yang basi.

### Pindah ke 3.1.0

Update biasa:
- Docker: `sudo /usr/local/bin/sdr-doa-docker update --dir /opt/sdr-doa-ground-console`, atau tunggu timer harian.
- Native: `sdr-doa-console update`.

Data, pengaturan, dan kata sandi tetap. Groundstation yang masih memakai forward sementara: jalankan runbook 7.4 setelah update.

## 3.0.0

Rilis mayor karena fitur dihapus: sistem kini memakai satu MQTT, yaitu kontrak RDF Node edge (keputusan di `docs/KEPUTUSAN_MQTT.md`, kontrak di `docs/MQTT_KONTRAK.md`). Kanal update `2` tidak memasang rilis ini sendiri; cara pindah ada di bagian terakhir.

### Yang berubah

- **Satu MQTT.** Console hanya berlangganan topik RDF Node di root `sdr/v2/uav-01`. Dashboard, peta, polar, DoA, dan health memakai MQTT; Data Out (cadangan) di HTTP port 8081 hanya dibaca saat MQTT tidak segar (8 detik setelah `telemetry/health` terakhir yang `daq=1`), dan UI menampilkan sumber datanya (#7, #8).
- **Kontrol** mengirim `config.get` dan `config.patch` dengan envelope edge ke `sdr/v2/uav-01/cmd/config/get|patch` (QoS 1, tidak retained) dan membaca `ack/config` serta `settings/reported` (#9).
- **Baca settings tanpa TLS.** RDF Node commit `35984d8` (PR `sanadunt/rdf-indicator-raspberry#5`) menjawab `config.get` lewat broker utama juga bila koneksinya tanpa TLS (PPP/T900 privat), jadi nilai Kontrol datang dari `settings/reported` lewat MQTT. RDF Node `8691ad0` yang terpasang sekarang tetap menolaknya dengan `TLS_REQUIRED_FOR_SETTINGS_REPORT`, dan Kontrol memakai Data Out (cadangan); pesan Kontrol untuk kode itu kini menyebut kedua kasus (broker cadangan, atau RDF-SDR versi lama). Fixture perintah kini per commit edge (`commands.8691ad0.json`, `commands.35984d8.json`), ditambah `compat.35984d8.json` (#9).
- **`GET /api/mqtt` adalah status MQTT tunggal**: broker, transport, koneksi, `node_id`, `root` (`sdr/v2/uav-01`) dan jumlah pesan semua topik RDF Node yang dilanggan (`received`, `valid`, `invalid`, `cleared`, `last_received_at_ms`, `last_age_ms`), sama dengan hitungan `GET /api/mqtt/rdf-node`. Field per jenis pesan topik lama (`last_by_kind`, `kind_counts`, `topic_counts`, `last_topic`, `total_bytes`, `last_latency_ms`) tidak ada lagi.
- **Monitor Pesan** tanpa sakelar keluarga topik: langsung menampilkan state node, ACK, dan status tiap topik RDF Node, dengan kartu Koneksi (broker, transport, root topik, mode publish).
- **Konfigurasi**: kartu MQTT menampilkan jumlah pesan MQTT dan umur pesan terakhir. Kartu itu dan kartu di System Health kini berjudul "MQTT".
- **`sdr-doa-docker`**: kanal default `3`, hanya untuk console. `SDR_DOA_AGENT_SETTLE` menjadi `SDR_DOA_SETTLE` (detik yang harus dilewati image tanpa healthcheck). Instalasi agent yang ditulis versi 2 disebut dengan jelas dan tidak dikelola lagi.
- **CI** menguji monitor lewat broker sungguhan (`tools/test_rdf_node_broker.py`, mosquitto loopback) dengan payload buatan kode edge di `tools/fixtures/rdf-node`.

### Yang dihapus

- Monitor dan kontrak topik lama `sdr/v1/uav-01`: `tools/sdr_doa_mqtt.py` dan bagian topik lama di `tools/sdr_doa_mqtt_monitor.py`. Koneksi paho bersama tetap, dipakai topik RDF Node dan Kontrol.
- Agent RDF-SDR bawaan repo, yang tidak terpasang di Raspberry: `tools/sdr_doa_lan_agent.py`, klien MQTT stdlib `tools/sdr_doa_mqtt_stdlib.py`, `packaging/agent/`, `Dockerfile.agent`, `docker-compose.agent.yml`, `deploy/sdr-doa-lan-agent.service.example`, `deploy/mosquitto-sdr-doa-lan.acl.example`, dan broker staging TLS-nya `tools/mqtt_lan_stage.conf`. Raspberry menjalankan RDF Node edge dari repo `sanadunt/rdf-indicator-raspberry`.
- Aset rilis `sdr-doa-rdf-sdr-agent-<V>.tar.gz` dan image `ghcr.io/sanadunt/sdr-doa-rdf-sdr-agent`. Rilis kini berisi `sdr-doa-ground-console-<V>-linux.tar.gz`, `sdr-doa-docker`, dan `SHA256SUMS`; tag image agent 2.x yang sudah ada tidak diperbarui lagi.
- Opsi `sdr-doa-docker install --agent`, `--enable-config`, `--disable-config`, `--share-dir`, dan `--user` (ditolak dengan pesan).
- Penerbit sintetis `tools/synthetic_mqtt_publisher.py` dan test topik lama; test memakai fixture kontrak edge.

### Pindah ke 3.0.0

Data di direktori data (Docker: volume `sdr-doa-data`; native: `~/.local/share/sdr-doa-ground-console`) tetap, termasuk `console.json` dengan pengaturan broker MQTT, Rekaman Receiver, dan kata sandi admin. Sebelum pindah, pastikan `curl -s --noproxy '*' http://127.0.0.1:8787/api/health` berisi `"receiver_busy": false` (update me-restart console sekali).

**Console Docker (`sdr-doa-docker`).** Kanal `2` tidak pernah pindah ke 3.x, dan `sdr-doa-docker` 2 tidak meng-update dirinya. Ambil `sdr-doa-docker` dari rilis 3.0.0, lalu jalankan `install` dengan kanal baru (runbook `docs/RUNBOOK_INSTALL_UPDATE.md` bagian 7.1, langkah unduh di 5.1 dan A1):

```sh
sudo sh sdr-doa-docker install --channel 3 --dir /opt/sdr-doa-ground-console
```

`install` mempertahankan `.env` (hanya kanal yang berubah), memasang `/usr/local/bin/sdr-doa-docker` versi 3, mem-pull `ghcr.io/sanadunt/sdr-doa-ground-console:3`, dan menunggu healthy. Timer harian yang sudah ada tetap jalan dan sejak itu mengikuti kanal `3`.

**Console native (`sdr-doa-console`).** Updater native tetap di dalam satu versi mayor: `sdr-doa-console update --check` dan timer harian (`update --auto`) hanya melaporkan `2.x is installed; 3.0.0 changes the major version ...` dan tidak memasang apa pun. Setelah membaca catatan ini:

```sh
sdr-doa-console update --allow-major          # bertanya dulu; tanpa terminal tambahkan --yes
```

Sesudahnya timer harian mengikuti rilis 3.x.

**Instalasi agent RDF-SDR dari versi 2.** Console 3 tidak mengelolanya lagi. Hentikan supaya tidak ada dua penerbit di broker: instalasi Docker dengan `cd /opt/sdr-doa-agent && sudo docker compose down` (`sdr-doa-docker` 3 menolak direktori itu dan menyebut perintah ini), instalasi native dengan uninstaller dari tarball agent 2.x (`sudo sh /opt/sdr-doa-agent/uninstall.sh`).

**Broker.** Console membaca topik `sdr/v2/uav-01/...` yang dikirim RDF Node edge. Pakai broker groundstation yang dipakai edge, lewat listener yang menerima console tanpa TLS dan kredensial (lihat `QUICKSTART.md`, bagian MQTT); tidak ada pengaturan baru di Konfigurasi.
