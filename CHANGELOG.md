# Catatan perubahan

Versi mengikuti `VERSION`. Rilis dibuat oleh CI dari tag `v<VERSION>` (lihat `QUICKSTART.md`, "Rilis di GitHub").

## 3.14.1

Rilis perbaikan dari uji tablet 3.14.0, ditambah tukar video dan peta di PC.

- **Pesan kuning tidak lagi tertutup Lapisan.** Di tablet, selama panel Lapisan terbuka, pesan peta pindah ke kanan panel di bagian atas peta, tidak lagi turun ke tengah peta di bawah panel. Di ponsel yang sempit pesan tetap di bawah panel, dan selalu disisakan tempat di atas tombol peta.
- **Peta kecil memperlihatkan grafik DoA.** Selama video drone tampil besar, peta di jendela kecil otomatis memusatkan dan men-zoom ke arah grafiknya (garis bearing dan tepi −3 dB, atau beam bila tidak ada bearing). Penanda dibuat lebih kecil, tombol peta dan pesan tidak tampil, dan bingkainya diperbarui setiap data baru. Saat peta kembali besar, posisi kamera peta besar dipulihkan seperti sebelumnya.
- **Tukar video dan peta di PC.** Tombol perbesar di panel Drone sekarang menampilkan video drone besar di belakang panel, dan peta beserta grafik DoA pindah ke jendela kecil di kiri bawah, di samping kolom HUD dan Lapisan. Klik jendela kecil atau tombol yang sama untuk menukar kembali. Fitur ini berlaku mulai lebar 1024 px; tampilan bertumpuk di bawah itu tetap seperti sebelumnya.
- **Bahasa dan tema di bar atas tablet.** Tombol EN/ID dan terang/gelap kini ada langsung di bar atas tablet, juga di LAN view. Pilihan ini berlaku untuk browser itu sendiri. Di ponsel di bawah 480 px keduanya tetap ada di menu ☰.

## 3.14.0

Tampilan tablet dan ponsel (layout compact) disusun ulang. Tampilan PC dengan mouse tidak berubah.

- **Layar utama yang bisa ditukar.** Area besar menampilkan peta DoA, dan video drone ada di jendela kecil 16:9 di pojok kanan bawah. Ketuk jendela kecil untuk menukar: video jadi besar dan peta pindah ke pojok. Peta tidak dimuat ulang dan video tidak terputus saat ditukar, dan video tetap live di jendela kecil. Jendela kecil hanya ada selama link drone menyala dan video drone dikonfigurasi; pilihan ini berlaku per kunjungan.
- **Baris info selalu tampil di bawah layar utama.** Isinya bearing dari utara beserta umurnya (yang ditahan diberi tanda USANG/BELUM VALID dan warna redup), frekuensi RDF-SDR, ketinggian/heading/fix drone, dan tiga titik status link (RDF-SDR, telemetri drone, video). Portrait dan layar pendek hanya menampilkan bearing dan drone. Ketuk kotak untuk membuka tab yang sesuai.
- **Panel samping bertab.** Tab Spektrum, Drone, RDF-SDR, dan Kontrol (Kontrol tidak ada di LAN view) ada di kanan saat landscape dan di bawah saat portrait. Tiap tab memberi label status kecil. Panel tidak lagi menutupi peta. Lapisan tetap dibuka dari tombol top bar.
- **Pesan kuning di peta bisa disingkirkan.** Ketuk pesan, ia mengecil jadi tanda ⓘ, dan tanda itu membuka teks lengkap beserta tautannya. Pesan yang sama tetap tersingkir walaupun jamnya berganti, dan muncul lagi hanya bila penyebabnya berubah.
- Saklar Spektrum/Drone/Kontrol yang tersimpan di PC tidak diubah oleh tablet.

## 3.13.5

Rilis perbaikan: tidak ada yang dihapus.

- **Video drone menunggu remote ditemukan.** Dengan `PULL=on-demand`, selama console belum menemukan remote drone, panel Drone terus mencoba memutar video, sehingga ffmpeg di groundstation dinyalakan dan gagal sekitar 30 kali per menit. Selama kamera belum diketahui, console sekarang melaporkan `NO_CAMERA` dengan alasan `CAMERA_UNKNOWN`. Panel Drone menampilkan "Remote drone belum ditemukan; video menunggu." dan tidak mencoba memutar. Begitu remote ditemukan, status kembali `STANDBY`, dan video dimulai saat ditonton.

## 3.13.4

Rilis perbaikan: tidak ada yang dihapus. Perbaikan drone SIYI 4 November 2026 diterapkan ke console.

- **Heading drone: yaw dulu, lalu VFR_HUD, lalu posisi.** FC drone ini mengirim `VFR_HUD.heading` terbalik arah (220 saat yaw 139,3) dan `GLOBAL_POSITION_INT.hdg` selalu 0. Console sudah memakai yaw `ATTITUDE` (dinormalkan ke 0–360) sebagai sumber pertama; sekarang, selama tidak ada attitude, VFR_HUD dipakai sebelum posisi, sama dengan `pickHeading()` dashboard SIYI. Arah gerak GPS tidak pernah dipakai sebagai arah hidung. Baris Heading di panel Drone, `HDG` di video, panah drone di peta, perbandingan dengan RDF-SDR dan putaran bearing DoA tetap membaca satu heading yang sama.
- **Video drone hanya ditarik saat ditonton.** `packaging/drone-video` punya setelan baru `PULL`, bawaannya `on-demand`: kamera ditarik lewat radio drone hanya selama video diputar, lalu dilepas 10 detik setelah penonton terakhir. Radio drone cuma cukup untuk sekitar dua stream 800 kbps, dan VGCS di remote sudah memakai satu. `PULL=always` mengembalikan perilaku lama. System Health menampilkan `STANDBY` selama belum ada yang menonton; itu normal.
- Pakai satu penarik kamera saja di LAN: service `drone-video` di groundstation atau gateway dashboard SIYI, jangan keduanya.
- Belum diuji dengan drone asli: putar drone searah jarum jam, angka heading harus naik.

## 3.13.3

Rilis perbaikan: tidak ada yang dihapus. Grafik DoA lewat Telemetry LoRa tidak lagi sering hilang.

- **DoA lewat LoRa berlaku 15 detik.** Lewat bridge LoRa, DoA tiba di groundstation 4–8 detik sekali dan sudah berumur 2–4 detik (diukur 2026-11-04). Dengan batas 5 detik, DoA bolak-balik USANG ("Snapshot kedaluwarsa") di antara dua pesan. Lewat LoRa batasnya sekarang 15 detik, untuk DoA `ok=1` maupun `ok=0` (`DOA_LORA_FRESH_MS`); browser mengikuti nilai yang disebut jawaban (`freshness.max_age_ms`). Lewat jaringan IP tetap 5 detik.
- **Grafik DoA terakhir disimpan console.** Console menyimpan jawaban terakhir yang punya grafik DoA live (vektor Angular 360 bin) di memori, dan menyediakannya di `GET /api/doa/last-live` (juga di LAN view). Halaman yang baru dibuka, misalnya tablet atau kiosk setelah reload, langsung menggambar grafik itu sebagai grafik ditahan (USANG + jam data terakhir) di peta dan Polar, tidak kosong sampai frame Angular berikutnya. Sesi RDF-SDR lain atau URL Data Out lain menghapusnya.
- **Grafik ditahan tetap tampil di samping bearing live.** Lewat LoRa garis bearing hampir selalu live, sedangkan frame Angular (bahan beam, lobe dan tepi −3 dB) jarang datang. Peta sekarang tetap menggambar beam, lobe dan tepi yang ditahan di samping bearing live, tanpa garis bearing kedua, dengan catatan "Grafik DoA ditahan · terakhir … · bearing live tanpa kurva Angular". Dock Polar sudah menahan kurvanya seperti ini.
- Frekuensi frame Angular dari RDF-SDR lewat LoRa tidak berubah: itu diatur di sisi edge (repo Raspberry).

## 3.13.2

Rilis perbaikan tampilan Dashboard; tidak ada yang dihapus.

- **Panel Drone selalu menunjukkan status koneksinya.** Dua baris teratas, **Telemetri** dan **Kamera drone**, selalu tampil: memeriksa, mati, mencari remote di LAN, menghubungkan, tidak terhubung (dengan IP remote), atau terhubung (live, data usang, atau belum ada data). Video juga menyebut sebabnya: service tidak jalan, encoder belum jalan, tidak ada gambar kamera, atau mencoba lagi.
- Semua baris telemetri (status, GPS, ketinggian, kecepatan, heading, roll/pitch, baterai, remote) selalu tampil, berisi "—" selama drone belum mengirimnya. Barisnya kini satu kolom (label di kiri, nilai di kanan), jadi lebih banyak nilai yang muat di kolom kanan.
- **Panel Drone tidak lagi menimpa kartu RDF-SDR.** Di layar yang tinggi (misalnya zoom browser 80%), video drone sempat tergambar di atas kartu RDF-SDR yang dibuka. Sekarang keduanya mengecil di dalam kotaknya sendiri: nilai drone dan detail RDF-SDR bisa digulir, dan header, video, serta baris status drone selalu terlihat.
- **Legenda peta tidak tertutup kolom kanan.** Selama panel Drone atau detail kartu RDF-SDR terbuka, legenda pindah ke kiri kolom kanan.

## 3.13.0

Rilis minor: tidak ada yang dihapus. Telemetry dan video drone SIYI (yang membawa RDF-SDR) masuk ke console. GPS dan kompas drone diutamakan, sedangkan GPS dan kompas RDF-SDR tetap tampil di sampingnya.

- **Telemetry drone.** Console berlangganan ke broker MQTT SIYI Bridge di remote MK32 (port 1883), hanya delapan topic yang disebut namanya (`drone/status`, `battery`, `gps`, `position`, `attitude`, `hud`, `statustext`, `bridge/link`). Console tidak pernah publish ke drone.
  - IP remote dicari sendiri di LAN (Konfigurasi → Drone, "Cari di LAN"). Broker tanpa `bridge/link` milik SIYI Bridge, termasuk broker groundstation sendiri, ditolak. Bisa juga diisi IP tetap.
  - Dashboard punya panel **Drone** (toggle baru di top bar): video kamera, ARMED, mode, GPS/RTK, ketinggian, kecepatan, heading, roll/pitch, baterai, dan status remote.
  - Peta menampilkan cincin oranye drone dengan penunjuk arah hidungnya, serta jejak terbangnya. Bila GPS RDF-SDR berbeda lebih dari 5 m, posisinya tampil sebagai cincin ungu kecil dengan garis ke drone.
- **GPS dan kompas mengutamakan drone.**
  - Posisi stasiun diambil dari GPS drone (fix 3D ke atas; RTK tertulis). Bila drone tidak punya fix, kembali ke GPS RDF-SDR seperti sebelumnya.
  - Bearing DoA diputar dengan yaw drone *pada saat sampel DoA diambil* (paling jauh 1 detik dari sampel yaw), ditambah "Putaran array dari hidung drone" di Konfigurasi. Tanpa yaw yang cocok waktunya, heading RDF-SDR dipakai seperti sebelumnya.
  - Kartu RDF-SDR menampilkan selisih GPS dan heading drone dibanding RDF-SDR (peringatan di atas 25 m atau 15°).
  - Konfigurasi → GPS & Kompas punya sakelar "Utamakan GPS drone" dan "Utamakan yaw drone" (bawaannya nyala). Pilihan MANUAL tetap di atas semuanya.
  - Raspberry tetap mengirim GPS dan kompasnya sendiri; belum ada perubahan di sisi RDF-SDR.
- **Video kamera drone.** Service baru di host, `packaging/drone-video/` (di luar Docker, ikut di tarball console):
  - mediamtx dan ffmpeg mengubah HEVC kamera menjadi H.264 untuk browser lewat WebRTC.
  - Encoder dipilih otomatis: VAAPI bila ada GPU Intel/AMD, selain itu libx264.
  - Console membaca kesehatan service dari API mediamtx dan meneruskan WHEP lewat alamatnya sendiri (`/api/drone/video/whep`). Tablet di LAN view juga bisa menonton.
  - Buka TCP 8889 dan UDP 8189 di firewall groundstation.
  - Cara pasang ada di `packaging/drone-video/README.md`.
- **System Health** punya kartu "Telemetri drone" dan "Video drone".
- Port console tetap 8787.
- **Mirror Receiver jalan sendiri setelah boot.** Selama LAN view terbuka, halaman console di groundstation sendiri langsung membuka Receiver. Receiver menyambung ke HackRF yang sudah diizinkan dan langsung menjalankan RX dengan setelan terakhirnya (VFO seperti tersimpan, tidak dibisukan), jadi tablet langsung mendapat spektrum live tanpa ada yang perlu membuka Receiver dulu di groundstation. Tanpa HackRF yang diizinkan, atau bila ada lebih dari satu, RX tidak dimulai dan tablet menampilkan RX OFF. Halaman yang dibuka saat LAN view masih tertutup mengecek lagi tiap 10 detik.

## 3.12.1

Rilis patch: tidak ada yang dihapus. Label bahasa Indonesia untuk posisi RDF-SDR yang ditahan kini sesuai dengan catatan 3.12.0.

- **Posisi stasiun yang ditahan tertulis USANG.** Kartu RDF-SDR dan kotak koordinat di bawah peta kini menulis "POSISI STASIUN TERAKHIR · USANG", bukan "· STALE".
- **Popup stasiun di peta** menulis USANG di baris Sumber dan Heading saat nilainya ditahan, bukan STALE yang tertulis tetap di kode. Dalam bahasa Inggris tetap STALE.

## 3.12.0

Rilis minor: tidak ada yang dihapus. Ada mode baru "Telemetry LoRa saja". Dalam mode ini, setiap data RDF-SDR tampil begitu datang. Data yang tidak datang tetap memakai nilai terakhir, berlabel USANG dengan umurnya, sehingga Dashboard tidak lagi kosong hanya karena satu data basi atau error.

- **Jalur RDF-SDR: Telemetry LoRa | Otomatis** (Konfigurasi → Koneksi, `link_mode` di `console.json`; bawaannya Otomatis, seperti sebelumnya).
  - Pada **Telemetry LoRa**, console hanya memakai apa yang dibawa bridge LoRa ke broker lokal. Data Out tidak dibaca sama sekali, baik baca penuh, baca ringan, maupun dari UI legacy. Pengaturan Data Out tetap tersimpan dan dilipat. Jalur MQTT jaringan dan Data Out tidak dihapus: pilih Otomatis untuk memakainya lagi.
  - Selama ada sesi RDF-SDR, jawabannya selalu dari data LoRa. Health yang basi (`MQTT_HEALTH_STALE`) atau DAQ yang tidak sehat (`MQTT_DAQ_NOT_HEALTHY`) tidak lagi membuat jawaban "none". Keduanya menjadi alasan pada chip Sumber (Telemetry LoRa, warna peringatan) dan status `STALE` atau `DEGRADED`.
  - **Tiap data dengan umurnya sendiri.**
    - Heading kompas dan posisi GPS dari health terakhir tetap di peta. Bila health sudah basi, heading tertulis USANG dan posisi "POSISI STASIUN TERAKHIR · USANG".
    - DoA terakhir ditahan, redup dengan USANG N dtk, dan tidak pernah tampil sebagai DoA valid.
    - Kartu RDF-SDR tetap terisi.
  - Hanya tanpa sesi sama sekali (belum ada yang masuk) jawabannya "none". Itu pun tanpa membaca Data Out.
- **DAQ tidak sehat tidak lagi mengosongkan Dashboard, juga pada mode Otomatis.** Pada 3 November, perubahan frekuensi ke 479,999 MHz membuat DAQ KrakenSDR gagal sinkron (`DAQ_NOT_HEALTHY_AFTER_RESTART`, sample delay dan IQ sync false). Health, kompas dan GPS RDF-SDR tetap masuk lewat LoRa, tetapi console menjawab "none". Akibatnya Dashboard menampilkan "Tidak ada telemetri RDF-SDR terkini", tanpa heading dan dengan posisi USANG, sehingga tampak seperti link LoRa putus.
  - Kini, bila health segar tetapi DAQ tidak sehat dan Data Out tidak bisa menjawab (lewat LoRa, atau tidak terjangkau), jawabannya tetap dari MQTT. Hasilnya:
    - Posisi dan heading RDF-SDR tetap di peta.
    - Kartu RDF-SDR tetap terisi.
    - HUD menulis DAQ gagal sinkron dengan alasan RDF-SDR sendiri.
    - Chip Sumber menunjukkan Telemetry LoRa (atau MQTT) berwarna peringatan, dengan alasan `MQTT_DAQ_NOT_HEALTHY`.
  - DoA tidak ditampilkan selama itu (`DEGRADED`, `DAQ_HEALTH_GATE_FAILED`).
  - Dengan Data Out yang menjawab, jawabannya tetap dari Data Out seperti sebelumnya.
- Sync flag dari `telemetry/health/detail` yang gagal membuat status DAQ `FAIL`, bukan `UNKNOWN`.

## 3.11.0

Rilis minor: tidak ada yang dihapus. Tata letak ringkas untuk perangkat sentuh (HP dan tablet, di tampilan LAN maupun di console sendiri). PC groundstation yang memakai mouse tampil seperti 3.10.0, dengan perbaikan tata letak dari audit UI di bawah. Console juga membaca semua yang dikirim RDF Node Edge 1.10.2 (kontrak 1.10); edge yang lebih lama tetap berjalan seperti di 3.10.0.

- **Kapan dipakai.** Hanya pada perangkat yang input utamanya jari dan tidak punya hover (`(hover: none) and (pointer: coarse)`), di lebar layar berapa pun. Mouse yang dicolokkan ke tablet mengembalikan tata letak biasa. Untuk memeriksa dari PC: `?layout=compact` di URL (misalnya `http://127.0.0.1:8787/?layout=compact#/dashboard`), `?layout=desktop` untuk sebaliknya; hanya berlaku untuk satu kali muat halaman.
- **Top bar satu baris** di semua halaman, tombol 44 px: menu halaman, logo, satu pil status, tombol panel (ikon saja), muat ulang, dan LIHAT SAJA di tampilan LAN.
  - Pil status menampilkan sumber (MQTT, Telemetry LoRa, Data Out) dan nilai DOA, dengan warna status terburuk. Ketukan membuka seluruh strip status, termasuk daftar Publikasi; Escape, ketukan di luar, atau ketukan kedua menutupnya.
  - Interval segarkan, EN|ID, serta Mulai ulang/Matikan pindah ke bagian bawah menu halaman, di sebelah tombol tema.
- **Dashboard tanpa gulir halaman.**
  - **Lanskap:** peta di kiri (55 %) dan Spektrum di kanan (45 %). **Potret:** peta di atas (55 %) dan Spektrum di bawah. Bila Spektrum dimatikan, peta memenuhi layar.
  - **Tanpa Polar.** Arah DoA sudah tergambar di peta; pilihan Polar yang tersimpan tidak berubah dan tetap berlaku di PC.
  - **HUD ringkas** di pojok kiri atas peta: bearing (lebih kecil), sumber dan umur, frekuensi dan dB, θ₀. Tanda BELUM VALID dan USANG tetap ada. Kartu estimasi posisi menjadi dua baris dan hanya tampil setelah estimasi ada (MENUNGGU dan PERLU BERGERAK tidak menutupi peta kecil); ketukan membuka rinciannya.
  - **Kartu RDF-SDR** tersembunyi; tombol antena baru di top bar membukanya di atas peta (kanan atas). Kontrol (hanya di console sendiri) dan Lapisan juga terbuka di atas peta dan bisa digulir di dalamnya. Buka-tutup kartu RDF-SDR tidak disimpan.
  - **Pemberitahuan peta** (REFERENSI offset kompas, BASEMAP UNAVAILABLE, dan lainnya) menjadi satu baris; ketukan membuka teks lengkap beserta tautannya.
  - Legenda dan koordinat di bawah peta disembunyikan; tombol peta (zoom, pusatkan, utara, basemap, atribusi) tetap di kiri bawah.
- **Dock Spektrum ringkas.** Header satu baris: chip dan tag, RX|Spektrum, Penanda, Dengar, Mulai/Berhenti, dan Receiver sebagai ikon. Atur, ikuti frekuensi node, mode dengar dan Kirim tidak tampil di tata letak ringkas. Penanda, penalaan, audio mirror dan semua status tetap bekerja.
- **Spektrum memenuhi panelnya** (trace mendapat bagian tetap, waterfall mengisi sisanya sampai bawah panel), di dock groundstation maupun dock MIRROR tablet.
- **Peta di HP tegak memusatkan RDF-SDR.** HUD dan kartu di atas peta tidak lagi mendorong RDF-SDR ke tepi kanan (labelnya terpotong); di tata letak ringkas peta hanya memberi ruang di atas untuk kartu-kartu itu. PC tidak berubah. Pemberitahuan peta di tata letak ringkas memakai lebar penuh peta, di bawah kartu-kartu itu.
- Halaman lain hanya mendapat top bar satu baris; isinya tidak berubah.
- **Peta menahan grafik DoA terakhir**, seperti grafik Polar. Bila DoA berhenti (USANG, BELUM VALID, konflik, sinkronisasi DAQ gagal, ADC overdrive), beam, lobe, tepi −3 dB dan bearing terakhir tetap tampil di peta, tetap berwarna penuh seperti grafik hidup (warna, opasitas dan pengaturan Lapisan yang sama, garis bearing utuh), sampai DoA baru datang dan menggantikannya. Grafik itu hanya ditandai USANG dan jam data terakhir: di label bearing ("USANG 134.0° · terakhir 20.27.52"), di legenda, di bacaan saat kursor di atas peta, dan di pemberitahuan "DoA ditahan · terakhir 20.27.52 · …". Keputusan pemilik 2026-11-02: grafik abu-abu yang redup sulit dilihat. Grafik itu tetap di titik tempat ia diukur, juga bila RDF-SDR sudah berpindah. Grafik dari simulasi tidak pernah ditahan, dan grafik node lain atau dari sebelum node restart tidak dipakai.
- **Kirim ke RDF-SDR** (dock Spektrum) kini hanya mengisi kolom Kontrol, belum mengirim apa pun.
  - Frekuensi tengah dan VFO diisi dengan frekuensi yang dipilih; gain dan jarak UCA ikut aturan pita, seperti frekuensi yang diketik sendiri.
  - Kontrol tetap di langkah isian, jadi operator bisa memeriksa atau mengubah kolomnya dulu, lalu Tinjau dan Kirim seperti biasa.
  - Hasil perintah sebelumnya yang sudah selesai, termasuk pemeriksaan nilainya yang masih berjalan, diganti oleh permintaan baru ini.
  - Di mode Spektrum, dock kembali ke RX (Listener) pada frekuensi yang dipilih (pindai yang berjalan dihentikan), jadi trace di frekuensi itu langsung terlihat.
  - Selama Kontrol masih mengirim perintah sebelumnya dan menunggu jawaban akhir RDF-SDR, tombolnya mati dengan keterangan "Kontrol masih mengirim perintah terakhir dan menunggu jawaban RDF-SDR; tunggu hasilnya". Isian yang tetap sampai ke Kontrol saat itu (misalnya Kontrol ditutup dan dibuka lagi) menunggu sampai perintah itu selesai; tidak ada yang dikirim sendiri.
- **Kata BASI diganti USANG** di semua label bahasa Indonesia (HUD, peta, legenda, Polar, heading), misalnya "USANG 19 dtk" dan "USANG 134.0° · terakhir 20.27.52". Kode status bahasa Inggris (STALE) tidak berubah.
- **HUD menampilkan setelan RDF-SDR di bawah sinyal:** Gain, VFO dan Squelch (level dalam dB, atau modenya seperti DEFAULT bila otomatis), dari `state.rf` edge 1.7 ke atas.
- **Perintah Kontrol berlaku 30 detik** (sebelumnya 15 detik), batas terpanjang yang diterima RDF-SDR. Lewat Telemetry LoRa perintah menunggu giliran radio dan ACK-nya menunggu giliran RDF-SDR, jadi "Belum ada ACK" baru muncul sekitar 35 detik setelah Kirim (keputusan pemilik 2026-11-02).
- **Baca settings lewat Telemetry LoRa diulang sendiri.** Bila RDF-SDR tidak menjawab sama sekali (NO ACK), Kontrol meminta lagi sampai 3 kali dan menuliskan "tidak dijawab lewat Telemetry LoRa, meminta lagi (2/3)". Baca settings tidak mengubah apa pun di RDF-SDR; perubahan pengaturan (config.patch) tetap tidak pernah dikirim ulang (keputusan pemilik 2026-11-02).
  - Penyebab utamanya ada di bridge LoRa RDF-SDR: jendela giliran bicara groundstation dihitung terlalu awal, sehingga sekitar 62% frame dari groundstation hilang. Perbaikannya ada di RDF Node (`rdf-lora-edge`, jendela diam 0,45 detik dihitung dari saat frame benar-benar terkirim) dan menurunkan kehilangan itu menjadi sekitar 13%.
- **Perbaikan audit UI 007** (tampilan desktop dan sentuh): Lapisan dan kartu estimasi bisa digulir dan tidak menutupi tombol peta di 1024 px; kartu RDF-SDR dan Kontrol berbagi kolom kanan tanpa terpotong; top bar 1024–1300 px memakai dua baris bila chip Sumber dan Telemetry LoRa tampil; chip LIHAT SAJA berikon gembok; tabel MQTT di Diagnostik DoA bertumpuk di layar sempit; tombol Rekaman 44 px; di Receiver, VFO yang dibisukan tetap terbaca ("VFO n (bisu)") dan header panel bisa dibuka dengan keyboard.

**Dengan RDF Node Edge 1.10.2** (kontrak 1.10; field yang tidak dikirim edge lama tidak dipakai):

- **Bearing BELUM VALID memakai heading sampelnya sendiri.** Garis putus-putus di peta dan bearing redup di HUD kini dihitung dari heading yang dikirim bersama sampel `ok=0` itu, bukan dari offset tetap. Sebelumnya, lewat Telemetry LoRa tanpa DoA LIVE, garis itu bisa menunjuk ke arah yang salah.
  - Selama perintah Kontrol berjalan, sampel `ok=0` yang lebih baru menggantikan DoA LIVE yang sudah basi. Umurnya umur sampel itu sendiri, dan label tetap BELUM VALID, bukan USANG.
- **Alasan dari RDF-SDR.** Selama DoA belum ditampilkan, HUD menulis alasan edge, misalnya "RDF-SDR: tidak ada DoA baru" atau "RDF-SDR: jam belum tersinkron". Kodenya ada di tooltip. Monitor Pesan menampilkan `why` dari `telemetry/health`.
- **Kurva Angular lewat Telemetry LoRa.**
  - Frame Angular kini berlaku 45 detik (sebelumnya 10 detik), karena bridge mengirimnya paling cepat tiap 20 detik. Kurva yang lebih tua dari 10 detik digambar redup di peta dan Polar, dengan umurnya ("kurva 25 dtk lalu", "Angular 25 dtk lalu · ditahan").
  - Kurva diputar dengan heading frame-nya sendiri, jadi tetap pas saat RDF-SDR berbelok setelah frame dibuat. Pemeriksaan 3° antara puncak kurva dan DoA ikut dihitung dalam bearing.
  - Detail health berlaku 65 detik lewat LoRa (sebelumnya 15 detik).
- **Kontrol.**
  - **Batas tunggu dari RDF-SDR.** Edge 1.10.2 menyebut paling lama berapa lagi hasilnya datang (`final_within_ms`). Kontrol kini menunggu sampai yang paling akhir dari batas 90/270 detik setelah kirim dan saat ACK itu diterima ditambah `final_within_ms` dan 30 detik (paling lama 15 menit). Selama menunggu, Kontrol menulis sisa batas tunggunya sendiri ("Menunggu hasil paling lama 4 mnt 10 dtk lagi."); saat sisa itu habis, ia menulis "Tidak ada ACK akhir". Baris ini juga muncul untuk edge lama, dengan batas 90 atau 270 detik.
  - Salinan `ACCEPTED` yang terlambat lewat LoRa tidak lagi memendekkan batas 270 detik.
  - Setelah batas waktu habis, Kontrol tetap mendengarkan: jawaban RDF-SDR yang terlambat menggantikan hasil "tidak ada ACK final".
  - Hasil perintah menampilkan pesan RDF-SDR sendiri ("Pesan RDF-SDR: …"), kunci yang diabaikan dan field yang diubah engine saat mulai, juga bila lebih dari satu field.
  - Kode helper Edge 1.10 (`HELPER_UNAVAILABLE`, `HELPER_ACCESS_DENIED`, `INTERNAL_ERROR`, `CONFIG_ADAPTER_NOT_APPROVED` dan lainnya) kini punya teks yang menyebut apa yang perlu diperiksa di RDF-SDR.
  - **Jarak UCA.** Pada frekuensi tengah 30–3000 MHz engine KrakenSDR memasang jarak UCA sendiri (0,3 m di bawah 300 MHz, 0,128 m dari 300 MHz). Kontrol tidak lagi mengirim jarak lain yang pasti ditolak RDF-SDR, dan menulis nilai yang berlaku.
- **Estimasi posisi menyebut yang kurang.** Bila bearing datang tanpa heading atau tanpa posisi GPS RDF-SDR, kartu estimasi menulis sebabnya ("Menunggu bearing: DoA datang tanpa heading", "GPS RDF-SDR belum punya posisi", "nav.gps.publish_position mati di node") dan berapa bearing yang dilewati.
- **Telemetry LoRa.** `GET /api/mqtt` membawa berapa kali bridge di ujung lain mulai ulang (`rx.peer_restarts`, bridge Edge 1.10.2; `null` dari bridge lama). Blok `lora/edge` memang tidak pernah sampai lewat radio; dokumentasinya kini menyebutnya.
- `docs/MQTT_KONTRAK.md` bagian 7e dan 8.3b menjelaskan field baru dan aturan LoRa, termasuk bahwa broker cadangan edge bukan failover console.

## 3.10.0

Rilis minor: tidak ada yang dihapus. Dengan RDF Node Edge 1.10 (kontrak 1.10), bearing di peta ikut heading RDF-SDR yang bergerak, dan groundstation memperkirakan posisi pemancar dari banyak bearing (keputusan pemilik 2026-11-02: prediksi di groundstation, Raspberry hanya mengirim data).

- **Bearing ikut heading RDF-SDR.** Edge 1.10 mengirim heading array (`h`) di setiap DoA. Selama heading itu ada, peta dan polar memakainya sebagai offset kompas (sumber **heading RDF-SDR**), bukan offset tetap dari settings.json. Pilihan kompas MANUAL tetap diutamakan.
- **Estimasi posisi pemancar.** Console menumpuk bearing dari tempat-tempat yang dilewati RDF-SDR ke grid 10 km (sel 100 m), seperti cara aplikasi KrakenSDR, dan menandai tempat bearing-bearing itu berpotongan.
  - Status **PERLU BERGERAK** selama bearing belum datang dari minimal 3 titik yang terpisah 15° atau lebih; dari satu titik saja jarak tidak bisa diketahui.
  - Status **ESTIMASI**: titik kecil, lingkaran radius putus-putus, garis dari RDF-SDR, dan label kecil berisi jarak dan arah.
  - Kartu kecil di bawah HUD bearing berisi jarak, koordinat, jumlah bearing dan titik, serta tombol **Mulai ulang** (hanya di console groundstation, tidak di tampilan LAN).
  - Sengaja ditampilkan kecil dan samar karena ini prediksi, bukan posisi terukur. Lapisan bisa dimatikan di panel Lapisan (**Estimasi posisi**).
  - Estimasi dimulai ulang sendiri saat frekuensi berubah lebih dari 25 kHz.
- **Rute baru `POST /api/position-estimate/reset`** (same-origin loopback). Tidak ada yang dikirim ke node.

## 3.9.0

Rilis minor: tidak ada yang dihapus. Squelch VFO RDF-SDR (RDF Node Edge 1.9) kini bisa diatur dari Kontrol. Kanal `3` dan timer update memasangnya sendiri.

- **Mode squelch.** Kolom baru "Mode squelch" di Kontrol, hanya muncul bila RDF-SDR mendukungnya. Pilihannya:
  - **Manual:** memakai level dB.
  - **Auto:** rata-rata seluruh spektrum + 5 dB.
  - **Auto Channel:** rata-rata noise di sekitar VFO + 3 dB, yaitu squelch otomatis yang mengikuti noise di bawah sinyal.
  - **Default:** mengikuti mode bawaan RDF-SDR.

  Perubahan mode diterapkan langsung tanpa restart SDR. Selama squelch otomatis, level dB dikunci dan Kontrol menampilkan AUTO atau AUTO CHANNEL.
- **Level squelch dalam dB bulat.** RDF-SDR hanya memakai dB bulat. Kontrol membulatkan level yang diketik, jadi form tidak lagi tetap "berubah" setelah perintah diterapkan. Mengirim level saat squelch otomatis mengubah mode ke Manual, dan hasilnya menyebutkan hal itu.
- **Kartu RDF-SDR** menampilkan mode squelch (AUTO / AUTO CHANNEL) atau levelnya, sebagai setelan.
- **Frekuensi di peta.** Label sudut DoA di peta kini menampilkan frekuensi rekaman DoA di atas angkanya, misalnya "481.287 MHz" di atas "134.0°". Untuk DoA yang belum valid, frekuensi ikut tampil redup.

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
