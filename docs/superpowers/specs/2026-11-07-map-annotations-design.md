# Tanda peta: ukur jarak, area (geofence) dan marker

Tanggal: 2026-11-07. Keputusan pemilik: 2026-11-06 (jalur tulis baru dari tablet) dan 2026-11-07 (geofence dengan peringatan, pilihan warna, langsung dikerjakan).

## Tujuan dan alasan

Operator groundstation fokus ke data drone dan RDF-SDR. Orang yang memegang tablet (LAN view) menandai peta: tempat yang dicurigai, area yang tidak boleh dilewati, area aman, catatan. Tanda itu disimpan di groundstation, jadi tetap ada setelah restart dan terlihat sama di groundstation dan semua tablet. Alat ukur jarak membantu membaca peta tanpa menyimpan apa pun.

## Yang dibangun

1. **Ukur jarak** (tidak disimpan): klik beberapa titik di peta. Panel menulis jarak tiap ruas, total jarak, dan arah ruas terakhir. Hanya di browser itu.
2. **Area / geofence**: poligon 3 sampai 200 titik, dengan nama, catatan, jenis dan warna. Panel menulis luas dan keliling.
3. **Marker titik**: satu titik dengan nama, catatan, jenis dan warna.
4. **Jenis**: Curiga (oranye), Dilarang lewat (merah), Aman (hijau), Info (biru). Warna bawaannya mengikuti jenis, dan bisa diganti dengan salah satu dari 8 warna palet.
5. **Ubah dan hapus** dari groundstation maupun tablet, siapa saja (keputusan pemilik). Ubah: nama, catatan, jenis, warna. Bentuk area tidak diedit per titik di versi ini; untuk mengubah bentuk, hapus lalu gambar ulang.
6. **Daftar tanda**: semua tanda dengan jenisnya; klik untuk memilih dan memusatkan peta.
7. **Peringatan geofence**: selama posisi drone (atau posisi RDF-SDR yang live, juga di simulasi) berada di dalam area jenis Dilarang lewat, peta menampilkan peringatan "Drone di area Dilarang lewat: <nama>" dan garis area itu menebal. Tidak ada suara.
8. **Lapisan**: sakelar "Tanda peta" (bawaan menyala) menyembunyikan semua tanda.

## Bukan tujuan

- Bukan posisi terukur; tanda adalah catatan operator.
- Tidak ada login, riwayat, atau undo di server. Hapus bersifat langsung (dengan konfirmasi di halaman).
- Tidak ada impor/ekspor file (KML, GPX) di versi ini.
- Tidak ada pengiriman tanda ke RDF-SDR atau ke broker drone.

## Penyimpanan dan API (server)

- Modul baru `tools/map_annotations.py` (stdlib saja): `AnnotationStore`, satu file JSON `map-annotations.json` di samping `console.json` (di Docker `/data`, native di folder data), ditulis atomik dengan mode 0600. File rusak disimpan sebagai `.invalid.bak` dan toko mulai kosong, seperti preferences.
- Batas: 500 tanda, nama ≤ 64 karakter, catatan ≤ 500 karakter, area 3..200 titik, badan permintaan ≤ 16 KiB, 5 tulisan per detik per alamat klien.
- `GET /api/map/annotations` (kedua listener): `{ok, rev, items, limits}`; `?since=<rev>` menjawab `{ok, rev, unchanged: true}` bila tidak ada perubahan, supaya polling 2 detik dari beberapa tablet tetap ringan. Aturan baca: di loopback aturan baca Receiver, di LAN view aturan Host LAN.
- `POST /api/map/annotations` dengan `{v: 1, op: "create"|"update"|"delete", id?, rev?, item?}`. Server membuat `id` (32 hex), `rev` per tanda, waktu (`created_ms`, `updated_ms`) dari jam server, dan `by` (`groundstation`, atau `tablet <alamat>`). `update` dan `delete` wajib membawa `rev` tanda itu; bila berbeda, 409 `ANNOTATION_CONFLICT` dengan tanda yang sekarang, sehingga perubahan orang lain tidak tertimpa diam-diam.
- Urutan pemeriksaan POST: Origin (loopback: Origin loopback yang sama; LAN: Origin halaman LAN itu sendiri, `lan.origin_matches_host()`) 403, panjang badan 413, laju per klien 429, skema 400, di LAN listener yang menerima klien masih yang terbuka 409 `MIRROR_LAN_CLOSED`, lalu tidak ditemukan 404, konflik 409, batas jumlah 409 `ANNOTATION_LIMIT`, gagal tulis 500. Kode dikirim lewat helper sendiri, di luar daftar kode Kontrol.
- LAN view: rute GET masuk `API_ROUTES`, POST tepat di path itu masuk `WRITE_ROUTES`. Capabilities LAN menulis `map_annotations: true`. Setiap tulisan tercatat di log console dengan alamat klien (log permintaan biasa).
- Ini tulisan keempat console (selain perintah Kontrol, Restart/Shutdown, dan penanda spektrum dari LAN); AGENTS.md dan CLAUDE.md diperbarui.

## Browser

- `lib/mapAnnotations.ts`: tipe, normalisasi jawaban, batas (salinan angka server, dicek oleh tes Python), jenis dan palet, klien (polling 2 detik dengan `since` selama Dashboard tampil, tulis dengan pesan bahasa operator untuk tiap kode), dan hitungan: panjang lintasan, luas dan keliling poligon (radius lokal elipsoid WGS84), titik di dalam poligon.
- `TacticalMap`: sumber `map-annotations` (isian area, garis, titik, label nama dengan font lokal) dan `map-annotation-draft` (garis dan titik yang sedang digambar), di atas peta dasar dan di bawah garis DoA. Tombol di baris kontrol peta: Ukur, Area, Titik, Daftar. Selama menggambar, klik menambah titik dan zoom dobel-klik dimatikan; klik pada tanda saat tidak menggambar memilih tanda itu.
- Panel "Tanda peta" di kolom kiri (juga di tata letak tablet): petunjuk menggambar, Urungkan titik, Batal, Selesai, lalu formulir (nama, jenis, warna, catatan) untuk area dan titik; hasil ukur; detail tanda terpilih dengan Ubah dan Hapus (konfirmasi di panel, fokus di Batal); daftar tanda.
- Semua teks lewat `lib/i18n.ts` (EN dan ID). Target sentuh 44 px.

## Keputusan pembangun (bukan dari pemilik)

- Satu rute POST dengan `op`, supaya LAN view tetap hanya membuka satu metode di satu path baru.
- Polling 2 detik, bukan stream; jumlah tanda kecil dan `since` membuat jawaban kosong saat tidak berubah.
- Edit bentuk per titik ditunda; hapus dan gambar ulang cukup untuk versi pertama.
- Peringatan geofence hanya untuk jenis Dilarang lewat, hanya di peta (notice dan garis tebal), tanpa suara.
