# Tampilan tablet: layar utama yang bisa ditukar, baris info, panel bertab

Tanggal: 2026-11-04. Disetujui pemilik lewat chat setelah tiga mockup (`.superpowers/brainstorm/…/tablet-v3.html`).

## Maksud

Di tablet (layout compact, `lib/compactLayout.ts`) semua panel melayang di atas peta: HUD, Lapisan, panel Drone, kartu RDF-SDR, pesan kuning. Peta jadi tertutup, panel saling bertumpuk, dan video drone hanya kotak kecil. Pemilik ingin tablet enak dipakai di landscape dan portrait: peta atau video drone mendapat layar penuh dan bisa ditukar dengan satu ketukan, beberapa angka penting selalu terlihat, sisanya di panel bertab, dan pesan kuning di peta bisa disingkirkan.

## Tujuan

- **Layar utama + jendela kecil (PiP).** Area kiri (landscape) atau atas (portrait) menampilkan satu tampilan besar: peta DoA atau video drone. Tampilan lainnya ada di jendela kecil di pojok kanan bawah. Ketuk jendela kecil untuk menukar keduanya. Pilihan ini hanya untuk kunjungan itu (tidak disimpan). Video drone dalam mode besar memakai HUD terbangnya (ALT, GS, HDG, baterai, yang sudah ada).
- **Baris info di bawah layar utama, selalu tampil:** landscape empat kotak, portrait dua kotak.
  1. Bearing dari utara + umurnya. Bearing yang ditahan diberi tanda USANG/NOT VALID dan warna redup, sama aturannya dengan HUD sekarang.
  2. Frekuensi RDF-SDR (frekuensi rekaman DoA, atau yang diset di SDR).
  3. Drone: ketinggian relatif, heading, dan label fix (RTK FIXED dll).
  4. Link: tiga titik status, yaitu RDF-SDR (data segar), telemetri drone (LIVE), dan video (live).

  Portrait hanya menampilkan kotak 1 dan 3. Ketuk sebuah kotak untuk membuka tab yang sesuai: bearing dan frekuensi membuka RDF-SDR, drone dan link membuka Drone.
- **Panel samping bertab:** kanan di landscape (sekitar 28 % lebar), bawah di portrait (sekitar 40 % tinggi). Tab-nya Spektrum, Drone, RDF-SDR, ditambah Kontrol bila bukan LAN view. Tiap tab memberi label status kecil. Isinya:
  - Spektrum: dock spektrum compact yang sekarang, atau MIRROR di LAN view.
  - Drone: baris status Telemetri/Kamera dan semua baris telemetri, tanpa video (video ada di layar utama atau PiP).
  - RDF-SDR: HUD DoA lengkap (alasan ditahan, θ₀, sinyal) dan kartu RDF-SDR yang terbuka.
  - Kontrol: panel Kontrol.
- **Pesan kuning di peta bisa disingkirkan.** Ketuk pesan, ia mengecil jadi tanda kecil "ⓘ". Ketuk tanda itu untuk membuka teks lengkap beserta tautannya bila ada. Pesan dengan teks lain (penyebab baru) muncul utuh lagi. Teks yang sudah disingkirkan tetap tersingkir selama halaman terbuka.
- **Lapisan** tetap dibuka dari tombol top bar, sebagai lembar sementara di atas layar utama, lalu ditutup.

## Bukan tujuan

- Tampilan desktop (PC dengan mouse) tidak berubah sama sekali.
- Polar tetap tidak tampil di compact.
- Tidak ada pengaturan baru yang disimpan. Tab aktif dan tampilan utama berlaku per kunjungan.
- Tidak mengubah data, API, atau aturan DoA.

## Anti-tujuan

- Panel menutupi peta seperti sekarang.
- Video terputus atau peta dimuat ulang (kamera peta hilang) saat ditukar. Peta dan video harus tetap elemen yang sama, hanya ukuran dan posisinya yang berubah.
- Polling drone ganda: satu pembaca `/api/drone` dan `/api/drone/video` untuk halaman.
- Target sentuh di bawah 44 px.

## Batasan

- Semua aturan compact berada di bawah `.console-shell[data-layout^='compact']` di akhir `overview-dashboard.css`/`console-design.css`; `components/compactLayout.test.tsx` memeriksa scope, token warna, dan target 44 px.
- `OverviewPage` di-memo. Prop dari App harus tetap stabil.
- Teks UI EN dan ID di `lib/i18n.ts`.
- Ponsel (360 px) juga memakai compact. Portrait di ponsel memakai susunan yang sama.

## Keputusan pembangun (bisa diubah)

- PiP berukuran sekitar 32 % lebar layar utama (16:9), dengan sudut 8 px dari kanan bawah. Tombol peta (zoom, pusatkan) disembunyikan saat peta ada di PiP.
- PiP ada selama link drone menyala (bukan `DISABLED`) dan video tidak dimatikan atau tidak dikonfigurasi (`videoEnabled` false, `NOT_CONFIGURED`). Bila remote masih dicari atau service video mati, PiP tetap ada dan memuat teks statusnya, seperti kotak video sekarang. Bila PiP hilang saat video sedang jadi tampilan besar, peta kembali ke depan.
- Mode compact tidak membaca dan tidak menulis flag `panels.spectrum`, `panels.drone`, dan `panels.control`. Semua tab selalu ada (Kontrol bukan di LAN view), sehingga preferensi PC tidak berubah. Panel samping tidak bisa disembunyikan.
- Tab tidak aktif: Spektrum, Drone, dan RDF-SDR dilepas (unmount), sehingga mirror dan spektrum berhenti meminta frame. Kontrol tetap terpasang tapi disembunyikan, supaya pengiriman yang sedang berjalan tidak hilang.
- Pesan yang disingkirkan dikenali dari teksnya setelah angka dibuang (jam, umur). Kedipan LIVE→ditahan dengan penyebab yang sama tidak memunculkannya lagi. Mengganti bahasa memunculkannya sekali.
- Ponsel landscape (tinggi di bawah 500 px) memakai susunan landscape dengan baris info dua kotak.
- Tab awal: Spektrum.
- Tombol top bar compact: hanya Lapisan. Spektrum, RDF-SDR, Drone, dan Kontrol kini menjadi tab.
- Video di PiP tetap live (keputusan pemilik, 2026-11-04): pemutar yang sama berjalan baik besar maupun kecil, dan tiap tablet yang membuka Dashboard menarik stream selama halaman terbuka. Aturan on-demand 3.13.4 di groundstation tidak berubah.
