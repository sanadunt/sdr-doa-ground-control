# Audit UI 008: halaman selain Dashboard (Ground Console 3.23.0)

- Tanggal: 2026-11-16
- Permintaan pemilik: "aku pengen kamu audit GUI selain dashboard dehhh, pada berantakan semua".
- Mode antislop: 2 (audit setelah jadi). `antislop.md` dan `skills/antislop-*` tidak ada di repo ini; aturannya dibaca dari skill `antislop` yang terpasang di mesin ini.
- Cakupan: Receiver (halaman konsol dan frame BrowSDR: Spektrum, Dengar, Rekaman), Kesehatan Sistem, Diagnostik DoA, Konfigurasi (termasuk Pembaruan), Monitor Pesan, Simulasi, dan versi LAN view (Receiver mirror, Rekaman read-only, Konfigurasi read-only).

## Metode

- Konsol lokal dari worktree (build lengkap dengan Receiver), Data Out tiruan dari `tools/fixtures/valid` dengan waktu segar, lalu broker sendiri (`tools/mqtt_stage4.conf`) dengan payload edge dari `tools/fixtures/rdf-node` (sumber MQTT_FRESH). LAN view dibuka di loopback lewat `server.lan.apply(..., allowed=[127.0.0.1/32])`.
- Chrome headless lewat CDP: 6 halaman x lebar 2400 (kiosk 1920 px dengan skala 0,8), 1440, 1280, 1024, 800 dan 375 px; gelap/ID dan terang/EN; layout compact tablet 1340x800 dan 800x1340 dengan sentuh. Ditambah LAN view dan isi frame Receiver per tab. Total sekitar 110 screenshot.
- Tiap screenshot diukur dari DOM: overflow horizontal, elemen keluar layar, teks terpotong, target sentuh di bawah 44 px pada layout compact.

## Sudah diperbaiki (perbaikan kecil yang jelas)

| No | Halaman | Masalah | Aturan |
|---|---|---|---|
| 1 | Diagnostik DoA (sumber MQTT) | Baris "Sumber" dan "Mode sudut" di kartu DoA MQTT menempel ke tepi kartu tanpa padding. | R-03 |
| 2 | Kesehatan Sistem | Kartu Video drone menempelkan error Python mentah ke kalimat operator: "(<urlopen error [Errno 61] Connection refused>)". Kini kalimat operator dulu, error mentah di baris sendiri (mono, redup). | R-27 |
| 3 | Kesehatan Sistem | Kolom kiri 2 kartu pendek, kanan 6 kartu: separuh layar kosong. Kini kiri RDF-SDR, Tampilan DoA, Data Out, MQTT; kanan LoRa, GPS groundstation, telemetri drone, video drone. | R-05 |
| 4 | Konfigurasi | Kolom kiri 5 kartu, kanan 2: kolom kanan kosong panjang. Akses LAN dan Pembaruan pindah ke kanan di bawah Branding & admin (yang kuncinya dibutuhkan Akses LAN); indeks seksi mengikuti urutan baru. | R-05 |
| 5 | Diagnostik DoA (sumber MQTT) | Kolom kanan hanya satu kartu pendek. Kartu Kolektor pindah ke bawah DoA MQTT saat sumbernya MQTT/LoRa. | R-05 |
| 6 | Konfigurasi, Monitor Pesan, Diagnostik | Teks Inggris di halaman ID: tombol "Update" (kini "Perbarui"), tile "Subscription" ("Langganan"), judul "Collector" ("Kolektor"). | R-38/konsistensi bahasa |
| 7 | Monitor Pesan | Kolom pertama tabel Node terlalu sempit, kata terpotong di tengah ("Ketersedia / an"). | R-03 |
| 8 | Rekaman (frame Receiver) | Header tabel memakai dua ukuran huruf: MULAI, SELESAI, FREKUENSI, DURASI, UKURAN 12,5 px; JENIS, MODE, STATUS, AKSI 10,5 px. Aturan angka kini hanya untuk sel isi. | R-20 |
| 9 | Konfigurasi (Pembaruan) | Tautan rilis memakai warna bawaan browser (ungu visited), dan targetnya 19 px di tablet. Kini warna token `--blue`, 44 px di layout compact. | R-29, R-03 |
| 10 | Semua kartu key/value | Placeholder "—" tampil lebih panjang di baris non-mono (Penerima, Sumber) dan merah di "Data terakhir" mirror. Kini selalu mono, tanpa warna nada. | R-20 |

## Disetujui pemilik ("Kerjakan semua") dan dikerjakan di 3.23.1

Hasil per nomor: 11, 12, 13, 14, 15, 18, 19 dan 20 ("Semua tanggal") diperbaiki. 16 dibiarkan: Mulai ulang dan Matikan sengaja turun ke baris kedua di bawah 600 px (keputusan yang tertulis di `console-design.css`), dan HP serta tablet memakai layout compact. 17 dibiarkan: field angka memakai format desimal locale perangkat (koma di perangkat berbahasa Indonesia) dan menerima koma saat diketik; mengganti jadi field teks berisiko membuat input koordinat salah. Bagian kedua 20 dibiarkan: tombol utama yang nonaktif tampil pudar dengan warna utamanya di seluruh konsol (Buka kunci, Validasi), jadi "Unduh ZIP" mengikuti aturan yang sama.


| No | Prioritas | Halaman | Masalah | Aturan |
|---|---|---|---|---|
| 11 | SEDANG | Receiver mirror (LAN view), tanpa data | "Belum ada data Receiver dari groundstation" muncul tiga kali (chip, notice, di dalam grafik), ada baris "frame —", sumbu "– – – –", dan kotak waterfall hitam kosong setinggi 330 px. Di tablet potret, bingkai grafik menempel ke tepi kartu. | R-27, R-03 |
| 12 | SEDANG | Rekaman (LAN view) | Baris filter berantakan: "Hasil: 0" tidak sejajar dengan field Urutkan, Urutkan turun sendirian ke baris kedua. | R-05 |
| 13 | SEDANG | Receiver Spektrum (frame) | Kotak centang Penguat RF dan Koreksi IQ tidak sejajar dengan field di sebelahnya; baris status "0 sweep ·..." berada di luar kartu tanpa padding; di kiosk satu field "Urutkan sinyal" sendirian di baris kedua; tabel riwayat puncak: "SNR" menempel ke "PERTAMA TERLIHAT" dan ada kolom kosong di kanan; di 800 px tombol ikon terdampar di baris kedua. Perubahan lewat overlay dan builder, bukan `vendor/BrowSDR`. | R-05, R-03 |
| 14 | RENDAH | Konfigurasi di HP (375 px) | Label "Putaran array dari hidung drone" terpotong. | R-03 |
| 15 | RENDAH | Monitor Pesan | Kolom RETAINED memakai chip "LIVE" untuk pesan biasa, sama dengan status LIVE di kolom sebelahnya. Usul: "—" untuk pesan yang tidak retained. | R-31 |
| 16 | RENDAH | Semua halaman, jendela sempit tanpa sentuh (600 px ke bawah) | Top bar menjadi dua baris tombol dan logo terpisah dari judul. HP dan tablet memakai layout compact, jadi ini hanya terlihat di jendela PC yang sempit. | R-03 |
| 17 | RENDAH | Konfigurasi, Simulasi | Field Latitude/Longitude memakai koma (format angka browser), sedangkan teks koordinat di sebelahnya memakai titik. | konsistensi |
| 18 | RENDAH | Simulasi | Tiga kartu (Kontrol, Skenario, Pratinjau) tingginya berbeda-beda di 1280 px ke atas. | R-05 |
| 19 | RENDAH | Receiver Dengar (frame) | Sebelum radio tersambung, area spektrum dan waterfall hitam kosong tanpa keterangan. | R-27 |
| 20 | RENDAH | Rekaman (frame) | "Semua tanggal" pecah dua baris di tombol segmen; "Unduh ZIP" yang nonaktif tetap tampil seperti tombol utama. | R-20 |

## Bukan temuan

- Input 42 px yang terukur di layout compact adalah isi kotak 44 px (border 1 px di dalam kotak), jadi targetnya tetap 44 px.
- Kode status tidak diterjemahkan, "—" sebagai placeholder, dan label kunci mentah di Konfigurasi efektif adalah keputusan yang sudah ada.
- Di kiosk (2400 px CSS) halaman selain Dashboard dan Receiver sengaja dibatasi 1600 px di tengah (`--pg-max-w`).
