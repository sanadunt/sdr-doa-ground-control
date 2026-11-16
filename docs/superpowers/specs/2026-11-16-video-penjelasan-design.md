# Video penjelasan Ground Console SDR-DoA (rencana)

- Tanggal: 2026-11-16
- Permintaan pemilik: "bikin video penjelasannya yang lengkap tapi ringkas gitu. Bisa kita coba planning dulu yaa", lalu "minta planning lengkap ke markdown yaa, aku mau run nya di session lain".
- Versi konsol yang ditampilkan: 3.25.0.
- Status: rencana. Pemilik belum menjawab pertanyaan tentang penonton, jadi beberapa pilihan di bawah adalah **usulan saya** (ditandai *Usulan*). Sesi pelaksana menanyakan tiga hal di bagian "Sebelum mulai" lalu menyesuaikan.

## 1. Maksud

Satu video yang menjelaskan apa itu Ground Console dan apa yang bisa dilakukannya, dari sinyal di udara sampai titik perkiraan di peta. Isinya lengkap (semua bagian besar disebut), tapi ringkas: satu cerita yang mengalir, bukan tur menu.

**Gagasan inti** yang harus ditangkap penonton di akhir video (*Usulan*):

> Drone membawa RDF-SDR yang mencari arah sinyal. Groundstation menerima arahnya lewat LoRa, menggambarnya di peta, dan dari banyak arah memperkirakan di mana pemancarnya. Semua bisa dilihat dan didengar juga dari tablet.

## 2. Penonton, durasi, bahasa, tempat tayang

| Hal | Usulan | Alasan |
|---|---|---|
| Penonton | Campuran: atasan atau klien (Pusjianstra) dan operator baru | Ada blueprint DF untuk Pusjianstra, jadi kemungkinan ada penonton dari luar tim. Cerita dari sudut misi bisa diikuti keduanya. Detail teknis (MQTT, kontrak, port) tidak masuk. |
| Durasi | Versi utama **sekitar 3 menit** (180 s). Opsional potongan 60 s dari bahan yang sama. | Lebih dari 3 menit tidak lagi ringkas. Kurang dari 2 menit tidak cukup untuk semua bagian besar. |
| Bahasa | Indonesia | Pemilik dan operator berbahasa Indonesia. |
| Narasi | Narasi suara dan teks besar singkat di layar, ditambah takarir (subtitle) SRT terpisah | Bisa ditonton bersuara di presentasi atau tanpa suara di WhatsApp. |
| Suara narator | Rekaman suara pemilik bila mau. Kalau tidak, TTS macOS `say -v "Damayanti (Enhanced)"` (sudah terpasang di Mac ini) | TTS cukup untuk draf. Untuk penonton luar, suara asli lebih meyakinkan. |
| Musik | Musik latar pelan di bawah narasi, bebas lisensi | Konvensi HyperFrames untuk video bercerita lebih dari 15 s. |
| Tempat tayang | MP4 1920×1080, 30 fps, H.264 dan AAC, di bawah 100 MB | Bisa diputar di laptop presentasi, proyektor dan WhatsApp. |

## 3. Tujuan, bukan tujuan, dan yang tidak boleh terjadi

**Tujuan**
- Penonton paham alur sistem: RDF-SDR di drone, Telemetry LoRa, groundstation, Dashboard, tablet.
- Penonton melihat layar yang **asli** dari konsol 3.25.0, bukan tiruan.
- Setiap bagian besar disebut sekali: Dashboard dan bearing, estimasi posisi dengan riwayat, putar ulang dan Google Earth, Receiver (Dengar, filter suara, pindai 300–6000 MHz), drone (video dan telemetri), tablet (LAN view dan aplikasi Android), Kontrol RDF-SDR, tombol Update.

**Bukan tujuan**
- Bukan tutorial langkah demi langkah. Itu video lain kalau nanti dibutuhkan.
- Bukan penjelasan teknis untuk pengembang (kontrak MQTT, API, port, Docker).

**Yang tidak boleh terjadi (meski videonya jadi)**
- **Mengklaim posisi terukur.** Estimasi posisi adalah perkiraan dari sudut-sudut yang bersilangan, dengan radius ketidakpastian. Narasi selalu menyebutnya "perkiraan", tidak pernah "lokasi pemancar".
- **Menyembunyikan label SIMULASI.** Adegan dari simulasi terbang tetap menampilkan label SIMULASI dari konsol. Narasi menyebut bahwa adegan itu simulasi untuk peragaan.
- **Menampilkan rahasia atau data sensitif:** kata sandi admin, IP LAN groundstation yang sebenarnya, koordinat groundstation atau lokasi operasi sungguhan, nama jaringan Wi-Fi. Pakai koordinat simulasi di tempat netral, dan buramkan atau potong bila tetap terlihat.
- **Menghapus atribusi peta.** Chip atribusi basemap (OSM dan lainnya) tetap terlihat di setiap adegan peta, karena lisensinya mewajibkan.
- **Menyentuh groundstation atau RDF-SDR sungguhan** untuk merekam. Semua rekaman dibuat dari konsol lokal di Mac, kecuali bahan yang dikirim pemilik (lihat bagian 7).

## 4. Pendekatan yang dipertimbangkan

1. **Rekaman layar saja dengan narasi.** Paling cepat dibuat. Tapi alur sistem (drone ke LoRa ke groundstation) tidak terlihat di layar konsol, dan tur menu terasa panjang.
2. **Motion graphics saja (diagram dan animasi).** Rapi untuk penonton luar, tapi tidak memperlihatkan perangkat lunak yang nyata. Klien perlu melihat bahwa ini sudah jalan.
3. **Campuran (*Usulan, dipilih*).** Diagram animasi untuk alur sistem dan transisi antarbagian. Rekaman layar konsol asli untuk setiap fitur, dengan sorotan dan perbesaran pada detail penting. Dirakit di HyperFrames (HTML ke video, render deterministik, bisa disunting di HyperFrames desktop app).

Alasan memilih 3: satu diagram yang tumbuh menjelaskan alur lebih cepat daripada kata-kata, sedangkan layar asli membuktikan sistemnya nyata. Pendekatan 1 dan 2 masing-masing kehilangan salah satunya.

## 5. Struktur adegan (sekitar 180 s)

Narasinya masih draf. Patokannya sekitar 2,3 kata per detik, dan paling banyak sekitar 19 kata per potongan kalimat yang tampil bersama satu gambar. Teks di layar paling banyak sekitar 8 kata. Yang tampil di layar tidak mengulang narasi kata per kata.

| # | Waktu | Bagian | Visual | Narasi (draf) | Teks layar |
|---|---|---|---|---|---|
| 1 | 0–12 s | Pembuka: pertanyaannya | Peta gelap, drone kecil terbang, satu sinyal berdenyut tanpa titik. Lalu potong ke Dashboard. | "Ada pemancar di suatu tempat. Kita tidak tahu di mana. Ground Console membantu menemukannya, dari udara." | Di mana pemancarnya? |
| 2 | 12–35 s | Alur sistem | Satu diagram yang tumbuh, tiap bagian muncul saat disebut: drone SIYI dengan RDF-SDR (KrakenSDR, antena melingkar), lalu garis Telemetry LoRa, lalu groundstation (PC dan konsol), lalu Dashboard, lalu tablet. | "RDF-SDR di drone mengukur dari arah mana sinyal datang. Arahnya dikirim lewat Telemetry LoRa ke groundstation. Ground Console menampilkannya di peta, dan tablet di jaringan yang sama bisa ikut melihat." | RDF-SDR → LoRa → Groundstation → Tablet |
| 3 | 35–62 s | Dashboard: arah sinyal | Rekaman Dashboard. Garis bearing di peta, HUD dengan sudut dan umurnya, plot polar, lobe. Perbesar HUD. Sekilas status jujur: label BELUM VALID atau USANG yang redup. | "Dashboard menunjukkan arah sinyal dari utara, umur datanya, dan bentuk pancarannya. Data yang belum valid atau sudah usang tetap terlihat, tapi diredupkan dan diberi label. Operator selalu tahu mana yang bisa dipercaya." | Arah sinyal · umur data · status |
| 4 | 62–100 s | Estimasi posisi | Rekaman simulasi terbang (label SIMULASI terlihat). Garis riwayat sudut menumpuk di sepanjang jalur drone. Kartu estimasi berubah dari PERLU BERGERAK ke KASAR lalu ESTIMASI, dan lingkaran radius mengecil. Lalu kartu Riwayat: Putar ulang (geser waktu), dan file KML terbuka di Google Earth. | "Satu arah belum memberi jarak. Saat drone bergerak, garis-garis arah bersilangan. Dari situ konsol memperkirakan posisi pemancar, mula-mula kasar, lalu makin sempit. Setiap sesi direkam, bisa diputar ulang, dan dibuka di Google Earth." | Perkiraan, bukan titik pasti · radius mengecil |
| 5 | 100–128 s | Receiver HackRF | Rekaman halaman Receiver (Mock SDR) atau dock Spektrum: Dengar dengan panel Filter suara; pindai lebar 300–6000 MHz sekali jalan dengan puncak-puncaknya; penanda di grafik. | "Di groundstation ada penerima kedua, RadioSpectrum. Operator bisa mendengarkan frekuensinya dengan filter suara yang meredam desis, atau memindai 300 sampai 6000 megahertz sekali jalan untuk mencari sinyal yang aktif." | Dengar · Filter suara · Pindai 300–6000 MHz |
| 6 | 128–150 s | Drone dan tablet | Kiri: video kamera drone dengan HUD tinggi, arah dan GPS. Kanan: tablet Samsung membuka aplikasi Groundstation, yang menemukan konsol sendiri dan menampilkan Dashboard, lalu Dengar di tablet dan menggambar area di peta. | "Video dan telemetri drone tampil langsung di konsol. Tablet di lapangan cukup membuka aplikasi Groundstation. Aplikasi menemukan konsol sendiri, lalu tablet bisa melihat, mendengar, dan menandai peta." | Drone langsung · Tablet di lapangan |
| 7 | 150–168 s | Kontrol dan perawatan | Kontrol: ubah frekuensi RDF-SDR, langkah Tinjau, lalu Kirim dan hasilnya. Lalu Konfigurasi, kartu Pembaruan console dengan tombol Perbarui. | "Frekuensi RDF-SDR diubah dari panel Kontrol, dengan tinjauan dan konfirmasi. Konsol diperbarui dengan satu tombol, dan versi lama kembali sendiri bila versi baru gagal." | Kontrol aman · Update satu tombol |
| 8 | 168–180 s | Penutup | Kembali ke peta adegan 1: kini ada garis-garis arah dan lingkaran perkiraan di tempat sinyal tadi. Logo atau nama konsol kecil. | "Dari arah sinyal di udara menjadi perkiraan posisi di peta. Itulah Ground Console." | Ground Console SDR-DoA 3.25.0 |

Bila pemilik memilih penonton yang lebih sempit (lihat "Sebelum mulai"), bobotnya digeser begini:
- **Operator baru:** adegan 2 dipersingkat menjadi 12 s. Adegan 3, 4 dan 5 ditambah cara membaca HUD, label status dan Lapisan. Adegan 7 tetap.
- **Atasan atau klien saja:** adegan 5 dan 7 masing-masing dipersingkat menjadi sekitar 12 s. Adegan 4 (estimasi) dan 6 (lapangan) diperpanjang. Durasi bisa turun ke sekitar 2 menit.
- **Tim teknis:** ini video lain. Isinya arsitektur, kontrak MQTT dan alur data, sebaiknya dibuat terpisah.

## 6. Gaya visual

- Warna dan huruf mengikuti konsol: tema gelap, token dari `frontend/src/console-design.css` (warna bearing, lobe, penanda dan status). Diagram memakai warna yang sama, supaya rekaman dan diagram terasa satu.
- Rekaman layar tampil penuh atau sedikit diperkecil dengan bayangan halus. Detail disorot dengan perbesaran perlahan (*punch-in*) dan satu label dengan garis penunjuk, bukan kotak merah.
- Tidak ada slide berisi poin-poin, ikon dalam lingkaran, atau tiga kartu berjajar.
- Transisi antarbagian memakai diagram dari adegan 2 sebagai benang merah. Bagian yang sedang dibahas menyala di diagram kecil di pojok selama 1 detik di awal tiap bagian.

## 7. Bahan yang perlu direkam atau dikumpulkan

### Dari konsol lokal di Mac (sesi pelaksana yang merekam)

| Bahan | Adegan | Cara |
|---|---|---|
| Dashboard dengan simulasi (bearing, polar, lobe) | 3 | Konsol lokal, halaman Simulasi menyala, tema gelap, 1920×1080 |
| Dashboard dengan data MQTT fixture (status BELUM VALID atau USANG) | 3 | Broker `tools/mqtt_stage4.conf` dan payload `tools/fixtures/rdf-node`, seperti audit 008 |
| Simulasi terbang dengan estimasi (PERLU BERGERAK, KASAR, ESTIMASI) | 4, 8 | Halaman Simulasi, "Simulasi terbang dengan estimasi posisi", jarak pemancar sekitar 3 km. Rekam 2–3 menit lalu percepat. |
| Riwayat estimasi: Putar ulang dan unduh KML | 4 | Perlu sesi tersimpan di `estimates.sqlite3`. Simulasi **tidak** direkam ke sana, jadi sesi diisi lewat broker fixture (DoA LIVE dari beberapa posisi) atau dengan memasukkan perjalanan `tools/fixtures/position-estimate/drive.json`. |
| KML di Google Earth | 4 | Buka KML hasil unduhan di Google Earth Web atau Pro, lalu rekam layar. |
| Receiver: Dengar, panel Filter suara, pindai 300–6000 MHz, penanda | 5 | `/?mock=1#/receiver` di konsol lokal (butuh `vendor/BrowSDR` dan `npm run build:all`). Mock SDR tidak menghasilkan audio VFO di Chromium, jadi suara Dengar diganti sampel suara radio (lihat "Audio"). Screenshot pindai yang sudah ada bisa dipakai bila rekaman sulit. |
| Kontrol: form, Tinjau, Kirim, hasil | 7 | Konsol lokal dan broker fixture. ACK `APPLIED` dikirim manual ke `sdr/v2/uav-01/ack/config` dari payload `tools/fixtures/rdf-node/commands.35984d8.json`. Kalau sulit, cukup rekam form dan langkah Tinjau. |
| Konfigurasi: kartu Pembaruan console | 7 | Konsol lokal. Kartu menulis helper belum terpasang, jadi pakai screenshot dari groundstation (pemilik) atau tampilkan sekilas saja. |
| LAN view di ukuran tablet | 6 | Konsol lokal dengan LAN view dibuka di loopback (cara di `CLAUDE.md`, `server.lan.apply(... allowed=[127.0.0.1/32])`), Chrome 1340×800, `?layout=compact` |

### Dari pemilik (diminta oleh sesi pelaksana)

| Bahan | Adegan | Bila tidak ada |
|---|---|---|
| Rekaman video kamera drone dari konsol groundstation (30–60 s, saat terbang) | 6 | Panel Drone dari konsol lokal tanpa video, ditambah satu foto drone |
| Rekaman layar tablet Samsung yang membuka aplikasi Groundstation (bisa lewat `adb shell screenrecord`; tablet terhubung adb ke Mac ini) | 6 | LAN view di Chrome ukuran tablet, dibingkai sebagai tablet |
| Foto drone SIYI dengan RDF-SDR dan antena, groundstation, antena LoRa | 1, 2 | Gambar garis sederhana di diagram |
| Logo atau nama resmi (Pusjianstra atau tim) untuk penutup | 8 | Teks "Ground Console SDR-DoA" saja |
| Suara pemilik untuk narasi | semua | TTS Damayanti (Enhanced) |

### Bahan yang sudah ada

- Screenshot audit 008 (sebelum dan sesudah) dan screenshot pindai lebar 300–6000 MHz di folder catatan bersama:
  `/Users/mac/Library/Application Support/Claude-Work Rti/side-session-notes/local_16aaf142-d444-4258-8aae-476652e6bbe6/` (`audit-008-sesudah/`, `pindai-lebar-300-6000/`).

## 8. Alat dan cara membuat

- **Perakitan:** HyperFrames (`npx hyperframes`, skill `hyperframes`). Proyek video di **luar repo**: `/Users/mac/Projects/video-ground-console/`. Video, rekaman dan audio tidak pernah di-commit ke repo ini.
- **Konsol untuk merekam:** jalankan konsol sendiri di port yang bebas (misalnya 8795), dengan `--config-path`, `--preferences-path`, `--data-dir` dan `--tile-cache-dir` di folder sementara. Port 8791 dan 8899 milik sesi lain, jangan dipakai atau dihentikan. Build lengkap dulu: `cd frontend && npm ci && npm run build:all`.
- **Rekaman layar:** Chrome yang dikendalikan skrip, lewat Playwright `recordVideo` atau CDP `Page.startScreencast`. Ukuran 1920×1080, skala 1, tema gelap, bahasa ID. Chrome uji pakai `--mute-audio`, karena Mock SDR memainkan desis di speaker Mac. Pergerakan kursor dan klik dibuat lambat dan sengaja. Hasil `.webm` diubah ke `.mp4` dengan `ffmpeg` (sudah ada di `/opt/homebrew/bin/ffmpeg`).
- **Narasi:** naskah final ke TTS (`say -v "Damayanti (Enhanced)" -o naskah.aiff`) per adegan, atau rekaman pemilik. Durasi audio per adegan menjadi jam untuk tiap adegan.
- **Audio Dengar dan filter:** dua klip pendek suara radio FM berdesis, yang satu tanpa filter dan yang satu lewat filter. Kalau ada, rekam dari groundstation (pemilik). Kalau tidak, buat dari sampel bebas lisensi dan lewatkan ke rantai `radioAudioFilter` di Chrome (cara uji di `tools/test_receiver_audio_filter.mjs`). Tandai di video sebagai contoh suara.
- **Takarir:** SRT dari naskah final dengan waktu per kalimat, lalu dibakar ke salah satu versi bila diminta.
- **Musik:** lewat `/media-use` di HyperFrames (bebas lisensi), sekitar −24 LUFS di bawah narasi, dengan *ducking*.

## 9. Langkah pelaksanaan (untuk sesi lain)

1. **Sebelum mulai,** tanya pemilik tiga hal ini, satu per satu, dan sesuaikan bagian 2 dan 5:
   1. Siapa penonton utamanya: atasan atau klien Pusjianstra, operator baru, atau campuran (usulan: campuran)?
   2. Narasi pakai suara pemilik atau suara komputer (Damayanti)?
   3. Bahan apa dari bagian 7 yang bisa pemilik kirim (video drone, rekaman tablet, foto, logo), dan kapan?
2. Baca skill `hyperframes`, bagian explainer dan `story.md`. Tulis `SPEC.md` proyek dari bagian 5 dan 6 ini. Karena alur ceritanya sudah ditetapkan di sini, tidak perlu menawarkan tiga alur cerita lagi kecuali pemilik meminta.
3. Siapkan konsol lokal untuk merekam (bagian 8). Rekam semua bahan bagian 7 yang berasal dari Mac. Periksa setiap klip terhadap bagian 3: label SIMULASI dan atribusi peta terlihat, tidak ada rahasia, IP atau koordinat sungguhan.
4. Finalkan naskah narasi, buat audio narasinya, lalu tetapkan durasi setiap adegan dari audio itu.
5. Rakit di HyperFrames. Jalankan `npx hyperframes check --json`, lalu `snapshot --review`.
6. **Gerbang pemilik:** tunjukkan preview (HyperFrames desktop app atau MP4 draf beresolusi rendah) dan daftar bahan pengganti yang dipakai. Render final baru setelah pemilik setuju.
7. Render final: `video-penjelasan-ground-console-3.25.0.mp4` dan `.srt`, opsional potongan 60 s. Simpan di `/Users/mac/Projects/video-ground-console/out/`, kirim ke pemilik dengan SendUserFile.
8. Catat hasil dan lokasi berkas di folder catatan bersama.

## 10. Keputusan yang diserahkan ke pelaksana

- Musik mana dan berapa keras, asal tidak mengalahkan narasi.
- Pemotongan dan kecepatan rekaman. Rekaman simulasi terbang boleh dipercepat; beri tanda kecil "×8" bila dipercepat.
- Bentuk persis diagram adegan 2, asal bagian-bagiannya muncul saat disebut dan warnanya warna konsol.
- Kata-kata narasi boleh diubah supaya pas dengan durasi audio, asal isinya sama dan "perkiraan" tetap disebut sebagai perkiraan.
