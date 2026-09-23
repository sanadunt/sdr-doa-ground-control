# Evaluasi GUI — Ground Console

Tanggal: 21 September 2026

## Lingkup

Redesign presentasi kelima halaman React: Overview, System Health, DoA Diagnostics,
Configuration, dan Message Monitor. Backend, kontrak MQTT, parsing telemetry,
publication gate, serta batas read-only/dry-run tidak diubah.

## Evaluasi awal

## Implementasi Plotly

### Kontrol Head Up dan skala manual

- Form Head Up 0–<360°, min/max signed dB, Apply view dan Default.
- Head Up hanya orientasi visual; transformasi bin dan source offset tidak berubah.
- Default mereset interaksi, Head Up 0°, skala simulasi −60…0; live kembali auto.
- Data-only frames memakai Plotly.restyle; layout tidak diputar ulang setiap frame.
- Nilai di bawah minimum berada di pusat, di atas maksimum terpotong oleh domain;
  tooltip tetap menyimpan signed dB asli. Batas min harus lebih kecil dari max.
- Validasi: 68 tes lulus; production build dan diff check berhasil.
- Browser preview lokal: randomize otomatis mengubah 361 titik (360 + penutup),
  manual −80…−10 dB diterapkan, Default mengembalikan rotation 90/range 0…60.
- State rotation 217/range 5…45 yang diatur lewat evaluasi browser bertahan
  ketika sampel berubah selama 2,5 detik. Ini tes state, bukan gesture drag fisik.

### Persistensi interaksi saat data diperbarui

- Memindahkan `Plotly.purge()` ke unmount, bukan cleanup setiap frame.
- Menambahkan `layout.uirevision` dan `polar.uirevision` stabil agar zoom dan
  rotasi operator bertahan saat kurva diperbarui.
- Revision berubah hanya ketika sumber simulasi/live, mode Polar/Compass,
  atau offset berubah. Navigasi keluar halaman juga mengakhiri instance plot.
- Pembaruan Plotly diserialkan dan snapshot tertunda yang sudah kedaluwarsa dilewati.
- Validasi: 67 tes lulus, TypeScript/build berhasil, diff check bersih.
  Pengujian gesture browser pada versi ini belum dilakukan.

- Renderer aktif kini Plotly `scatterpolar`, menggantikan SVG manual.
- Dependency lokal `plotly.js-dist-min`, dimuat lazy tanpa CDN.
- Tooltip: sudut display, bin sumber, signed source-shifted dB.
- Radius memakai `nilai - batas bawah`; label tick dan tooltip tetap dB asli,
  bukan abs(), re-log, atau dBm. Transformasi Compass tetap satu kali.
- Skala simulasi tetap −60…0 dB; live memakai domain enclosing otomatis.
- ResizeObserver mengikuti panel 50:50 / enlarge; tema ikut diperbarui.
- Kurva kosong ketika data unavailable; publication/freshness gate tidak diubah.
- Validasi: 65 tes lulus, TypeScript dan production build berhasil.
- Bundle Plotly 4,775 MB minified / 1,472 MB gzip, lazy-loaded dari console lokal.
- Batas: belum dilakukan pemeriksaan visual browser untuk renderer Plotly ini;
  tes yang lulus tidak membuktikan keterbacaan label pada seluruh viewport.

- Warna hijau digunakan pada hampir semua lapisan, sehingga pembeda antara
  permukaan, aksen, dan status sehat kurang tegas.
- Gradient, shadow, dan capsule status berulang mengurangi hierarki.
- Label 7–10 px, tracking lebar, serta uppercase terlalu dominan untuk console operasional.
- Overview dipaksa mengikuti tinggi viewport; layar pendek mengakibatkan ukuran
  informasi turun dan beberapa keterangan disembunyikan.
- Node inspector dan subsystem status menggunakan banyak nested cards dengan bobot serupa.
- Posisi fallback/manual membutuhkan penanda yang lebih jelas agar tidak terlihat
  seperti fix GPS live.

## Arah desain

Console instrumen, bukan landing page atau simulasi radar.

- **ENERGY 2/5:** netral, tenang, dapat digunakan lama.
- **RHYTHM 3/5:** overview spasial, health berbentuk ringkasan dan baris subsistem,
  diagnostics berbentuk ledger, konfigurasi berupa form, monitor berupa tabel.
- **MOTION 2/5:** entrance GSAP singkat saat berpindah halaman; tidak berulang.
- Graphite untuk mode gelap, permukaan terang netral untuk penggunaan di ruang terang.
- Amber sebagai aksen navigasi/aksi. Hijau, amber, merah tetap membawa makna status,
  didampingi teks, bukan warna saja.
- System font lokal, angka tabular, judul lebih besar dan label yang dapat dibaca.
- Penomoran instrumen 01/02 hanya dipakai untuk pasangan map/polar, bukan dekorasi global.

## Perubahan

### MapLibre DoA direction overlay

- Overview memakai MapLibre GL JS untuk basemap OSM dan seluruh overlay arah: station,
  bearing, lobe angular, guide lines, dan heatmap relatif dari vektor 360-bin.
- Kontrol overlay tersedia pada panel peta: visibility tiap layer, jarak proyeksi visual,
  rentang signed dB, contrast, opacity, blur, dan interval garis bantu 15/30/45/90°.
- Toggle sekarang diterapkan ke `layout.visibility` layer MapLibre, sehingga tidak hanya
  mengosongkan GeoJSON source dan tidak meninggalkan layer yang tampak aktif.
- Lifecycle overlay menunggu event `load` MapLibre dan mengulang apply saat data simulasi/live
  berubah; ini mencegah snapshot pertama atau update randomize terlewat karena timing style.
- Legend menjelaskan makna visual: bearing adalah arah utama, lobe adalah respons relatif,
  dan heatmap adalah kekuatan relatif. Tidak satu pun menyatakan lokasi pemancar atau range RF.
- Jarak proyeksi hanya radius visualisasi; data stale, invalid, atau tanpa vektor 360-bin
  menghasilkan overlay kosong. Map failure dipisahkan dari data failure.
- MapLibre menggantikan renderer peta sebelumnya; Plotly tetap dipakai untuk grafik angular
  detail karena kamera/zoom polar dan overlay geografis memiliki kebutuhan berbeda.
- Basemap menggunakan tile OSM publik tanpa API key. `tile.openstreetmap.de` diprioritaskan
  sebagai alternatif gratis ketika jaringan memblokir `tile.openstreetmap.org`; atribusi OSM
  tetap ditampilkan. Kegagalan tile individual tidak lagi mematikan renderer MapLibre/overlay.
- Kontrol Direction overlay kini memiliki mode advanced yang terhubung ke renderer: radius
  proyeksi dan radius lobe terpisah, dB min/max, noise threshold, contrast, radial samples,
  distance falloff, visual intensity, blur, opacity, guide interval, visibility layer, serta
  preset `Kraken`, `Focused`, dan `Wide`. Parameter jarak/falloff adalah proyeksi visual untuk
  navigasi arah—bukan estimasi range atau lokasi target.

### Validasi MapLibre overlay

- 71 unit test lulus, termasuk geometry DoA dan simulation fixtures.
- TypeScript check, production build, dan `git diff --check` berhasil.
- Build mengeluarkan warning ukuran bundle Plotly/MapLibre; ini tidak memblokir fungsi, tetapi
  code-splitting lebih lanjut layak dilakukan sebelum deployment dengan bandwidth rendah.
- Browser smoke test gesture/toggle MapLibre pada perangkat fisik masih perlu dilakukan saat
  Ground Console dijalankan di target Ground Console; validasi saat ini mencakup compile/build
  dan lifecycle code review.

| Area | Implementasi |
|---|---|
| Shell | Navigasi lebih tenang, refresh jelas, switch tema tersimpan lokal, skip link |
| Overview | Map/polar 60/40 di layar lebar; stack pada tablet; tidak memaksa semua data muat setinggi layar |
| Map | Sumber koordinat ditampilkan; FALLBACK/MANUAL diberi keterangan bukan GPS live |
| Polar | Warna mengikuti tema, glow kurva dihapus, metadata lebih terbaca, unavailable tetap eksplisit |
| Health | Ringkasan utama lebih menonjol; subsistem disusun sebagai baris, bukan kartu seragam |
| Diagnostics | Gate rows dan native records diperjelas, unit dan metadata tetap dipertahankan |
| Configuration | Input lebih tinggi, bantuan lebih terbaca, tombol primer/sekunder berbeda |
| Monitor | Counter strip, tabel, dan decoded records dibedakan hierarkinya |
| Motion | GSAP 320 ms dengan stagger 35 ms; cleanup mengikuti route lifecycle |
| Reduced motion | GSAP dilewati, CSS motion dimatikan, recenter map tidak dianimasikan |

Tidak menambahkan Three.js: tidak ada kebutuhan visualisasi 3D untuk keputusan operator
saat ini. GSAP dan Leaflet menggunakan dependency yang sudah ada. Tidak membuat data,
gelombang, radar sweep, angka interpolasi, atau deteksi palsu.

## Validasi yang dilakukan

- `npm test`: **45/45 tes lulus**, 2 file tes existing.
- `npm run build`: TypeScript dan Vite production build berhasil.
- `git diff --check`: tidak ada whitespace error.
- Build produksi dibuka dengan browser automation melalui Python Ground Console
  di `http://127.0.0.1:18765`.
- Sumber pengujian: `http://127.0.0.1:8081` yang tidak aktif; bukan Raspberry.
  Monitor MQTT tidak dihubungkan. Uji browser berfokus pada state tidak tersedia/error.
- Kelima route dapat dibuka, heading dan jumlah panel sesuai.
- Tidak ada overflow horizontal dokumen pada 1440×1000 dan 390×844 mode gelap,
  serta 320×740 mode terang. Navigasi mobile menggunakan scroll lokal.
- Tombol tema bekerja dan pilihan `light` bertahan setelah reload.
- Browser tidak melaporkan error JavaScript pada pemeriksaan tersebut.
- Screenshot diambil ke `/tmp/sdr-gui-dark.png` dan `/tmp/sdr-gui-mobile-light.png`.
  **Screenshot tidak dapat diperiksa secara visual oleh model sesi ini**;
  hasil DOM/geometry bukan pengganti approval visual manusia.

Tes existing memverifikasi kontrak dan runtime helper; bukan suite visual regression.
Tidak ada klaim bahwa seluruh alur autentikasi, penyimpanan konfigurasi, atau hardware
end-to-end telah diuji ulang di browser.

## Batasan dan follow-up

1. Tinjau langsung estetika dan keterbacaan pada monitor Ground Station sesungguhnya.
2. Uji fixture fresh, stale, conflict, dan telemetry live pada seluruh tema sebelum
   acceptance operasional. Tes kontrak existing tetap lulus, tetapi belum ada screenshot
   untuk semua kombinasi state tersebut.
3. Keyboard-only penuh, screen reader, kontras otomatis, dan preferensi reduced motion
   OS belum diaudit end-to-end. Skip link dan focus style tersedia di implementasi.
4. Map tetap memakai tile OpenStreetMap existing; bukan solusi peta offline.
5. CSS baru berada di `frontend/src/console-design.css`, diimpor setelah stylesheet
   existing. Ini membatasi perubahan terhadap struktur lama, tetapi masih menyisakan
   deklarasi lama yang dioverride. Konsolidasi stylesheet layak dikerjakan terpisah
   setelah arah visual disetujui, dengan visual regression coverage.
6. Halaman legacy `--legacy-ui` tidak termasuk redesign.
7. Catatan proyek disimpan di dokumen ini. Salinan ke Brain belum dibuat karena lokasi
   catatan proyek SDR belum ditetapkan; perlu konfirmasi lokasi sebelum penulisan.

## Menjalankan hasil

Build produksi sudah dibuat lokal. Jalankan console biasa tanpa `--legacy-ui`:

```bash
/Users/mac/Documents/all-code/doa-sdr-telemetry/.venv/bin/python /Users/mac/Documents/all-code/doa-sdr-telemetry/tools/ground_console.py
```

Buka URL yang dicetak server. Jika browser masih memakai tampilan lama, lakukan hard
reload. Untuk membangun ulang:

```bash
npm --prefix /Users/mac/Documents/all-code/doa-sdr-telemetry/frontend run build
```

### Dependency MQTT pada Mac

Jika konfigurasi tersimpan memiliki `mqtt_host`, startup memerlukan `paho-mqtt`
versi 2 karena monitor memakai `CallbackAPIVersion.VERSION2`. Python global tanpa
package ini akan gagal dengan `ModuleNotFoundError: No module named 'paho'`.
Setup terisolasi (tidak mengubah Python Homebrew):

```bash
python3 -m venv /Users/mac/Documents/all-code/doa-sdr-telemetry/.venv
/Users/mac/Documents/all-code/doa-sdr-telemetry/.venv/bin/python -m pip install 'paho-mqtt==2.1.0'
```

Pada troubleshooting 21 September 2026, setup ini berhasil dengan Python 3.14.7;
import Ground Console dan instansiasi MQTT monitor berhasil tanpa memulai koneksi
broker. Koneksi broker sebenarnya belum diverifikasi. `.venv/` diabaikan Git.

## Checklist penerimaan manual

### Tambahan: tab Simulasi

- Sidebar memiliki tab Simulasi. Aktifkan checkbox, atur latitude/longitude,
  DoA 0–359°, dan lebar lobe 5–60°, lalu klik Terapkan skenario.
- Buka Overview untuk melihat map dan kurva sintetis 360 bin. Randomize DoA
  tersedia manual atau otomatis setiap satu detik. Menerapkan skenario menghentikan
  randomize otomatis; OFF juga menghentikan timer.
- Banner global menandai mode simulasi. Hanya map/polar Overview memakai data
  sintetis; header runtime, health, diagnostics, dan MQTT tetap sumber nyata.
  Pembacaan live existing tetap berjalan sesuai konfigurasi, terpisah dari generator.
- Generator berjalan di browser, tanpa API write/publish. Publication gate fixture
  selalu BLOCKED; tidak ada authority yang dipilih. Reload mereset simulasi ke OFF.
- Kurva Gaussian −50 sampai −5 dB adalah fixture renderer, bukan model fisika RF.
  Preview statis tidak kedaluwarsa seperti telemetry live. Sumber koordinat berlabel
  SIMULATION dan axis preview memakai Polar tanpa offset, terpisah dari settings live.
- Validasi: 55 tes lulus (10 tes generator baru), build TypeScript/Vite berhasil.
  Browser memverifikasi mode ON, sumber SIMULATION, metadata 45°/−5 dB/360 bins,
  randomize manual/otomatis, OFF menghentikan otomatis, reset setelah reload,
  serta tidak ada overflow pada 390 px untuk tab Simulasi dan Overview aktif.
  Pemeriksaan screenshot visual dan koneksi hardware tidak dilakukan.

- Buka kelima halaman pada 1366×768 dan monitor operator sebenarnya.
- Bandingkan dark/light; pastikan grafik, status, label, dan form nyaman dibaca.
- Gunakan Tab untuk navigasi, ganti tema, refresh, zoom/recenter map.
- Aktifkan reduced motion OS dan pastikan tidak ada entrance/recenter animation.
- Pastikan posisi fallback berlabel bukan GPS live.
- Uji koneksi terputus dan snapshot kedaluwarsa: tidak boleh tampak sebagai data sehat.
- Periksa browser zoom 200% dan peta saat jaringan tile tidak tersedia.

## Revisi simulasi: bearing map dan ruang polar

> Audit lanjutan menunjukkan revisi ukuran di bawah belum cukup untuk keterbacaan.
> Build/test berhasil tidak sama dengan kelayakan visual; lihat audit berikutnya.

- Overview desktop memakai kolom map/polar 50:50; batas lebar canvas polar
  dinaikkan dari 380 menjadi 560 px. Layar ≤980 px tetap bertumpuk.
- Tab Simulasi berada paling akhir setelah Message Monitor.
- Map simulasi memiliki ray putus-putus mengikuti sudut yang sama dengan polar:
  0° utara, bertambah searah jarum jam. Panjang ray 1 km hanya referensi visual,
  bukan estimasi jarak maupun posisi pemancar. Label SIMULATION tetap terlihat.
- Update ray tidak membuat ulang map saat sudut berubah; pan/zoom dipertahankan.
  Ray dibersihkan saat simulasi dimatikan atau komponen dilepas.
- Randomize manual/otomatis kini mengubah sudut 0–359° dan lebar lobe 5–60°;
  koordinat tetap. Bentuk masih Gaussian sintetis, bukan model propagasi RF.
- Validasi revisi: 61 tes lulus, TypeScript/Vite production build berhasil,
  `git diff --check` bersih. Tes mencakup empat arah kardinal dan variasi kurva.
  Pemeriksaan browser visual revisi ini belum dilakukan; perlu cek tampilan ray,
  zoom/pan saat auto-randomize, dan ukuran grafik pada monitor operator.

## Audit lanjutan: keterbacaan polar

Status: audit renderer existing, belum implementasi penggantian library.

### Tindak lanjut implementasi

Renderer Overview kini menggunakan SVG responsif (`PolarPlot.tsx`), bukan canvas
lama. Tidak ada dependency chart baru. Ring memakai 80% lebar viewBox, label
derajat 16 unit dan dB 14 unit (ditingkatkan pada mobile), nilai dB berada pada
ring terkait. Kurva mempertahankan signed source-shifted dB tanpa log/abs ulang.
Simulasi memakai domain tetap −60…0 dB; live memakai enclosing auto-domain
yang ditulis eksplisit. Vektor datar mendapat domain nonzero.

Compass menampilkan kardinal dan offset dengan peringatan bahwa heading belum
terverifikasi; Polar hanya derajat lokal. Transformasi bin existing dipertahankan.
Tombol Enlarge plot memperluas panel satu baris penuh; Restore split view kembali
ke map/polar 50:50. Pada layar sempit polar ditempatkan sebelum map.
Header Overview dan banner simulasi diringkas. Metadata puncak tetap di luar
plot sehingga tidak menabrak ticks. Kurva unavailable/stale tetap dihapus.

Validasi implementasi: 65 tes lulus, termasuk 4 tes domain radial baru;
TypeScript dan production build berhasil, diff whitespace bersih. Build dist
sudah diperbarui untuk server Python. Screenshot visual implementasi SVG,
tooltip interaktif, dan pengujian hardware belum dilakukan; tooltip belum tersedia.

### Bukti dan masalah

- Pada preview simulasi viewport 1366×768, lebar canvas terukur sekitar 502 px,
  tetapi diameter ring terluar sekitar 366 px. Margin internal menghabiskan ruang;
  pembagian kolom 50:50 saja tidak menyelesaikan ukuran plot.
- Posisi canvas mulai sekitar y=469 px ketika simulasi aktif. Header, banner,
  judul, dan header panel mendorong plot ke bawah fold pada layar laptop.
- Renderer memakai lebar frame untuk perhitungan gambar, bukan selalu ukuran
  canvas tampil. Ukuran backing buffer dan ukuran CSS harus diselaraskan.
- Label dB berupa daftar vertikal kanan, bukan label pada ring yang diwakilinya.
  Ini mengaburkan hubungan nilai dengan radius.
- N/E/S/W muncul juga pada mode Polar. Label ini tidak boleh mengimplikasikan
  arah geografis tanpa referensi orientasi/heading yang terverifikasi.
- Domain radial mengikuti min/max tiap frame tanpa indikator autoscale yang jelas.
  Kurva antar-frame dapat terlihat serupa meskipun rentang angkanya berubah.
- Label puncak memakai font 9 px; tidak memadai untuk pembacaan operator.
- Data merupakan source-shifted dB, bukan otomatis dBm atau kekuatan RF terkalibrasi.
  Sign dipertahankan; jangan abs() atau log10() ulang untuk memperindah plot.

### Rekomendasi implementasi berikutnya

- Pertahankan dua kolom sama lebar, kurangi tinggi chrome Overview, dan sediakan
  perluasan plot khusus. Jangan memaksa seluruh halaman muat dengan mengecilkan font.
- Kandidat library: Apache ECharts dengan angleAxis/radiusAxis dan polar line,
  bukan radar chart kategori. Library ini belum terpasang; evaluasi bundle dan
  integrasi diperlukan sebelum adopsi. GSAP/Three.js bukan solusi sumbu ilmiah.
- Derajat pada perimeter, dB pada ring yang sesuai, label minimum 12–14 px,
  peak callout terpisah dari ticks, dan tooltip untuk bin/sudut/nilai aslinya.
- Pisahkan mode/convention Polar dan Compass, tampilkan offset eksplisit,
  jangan mengubah transformasi data sebelum dibandingkan dengan referensi upstream.
- Beri domain radial stabil untuk simulasi; untuk live gunakan domain berlabel
  dengan pilihan fixed/auto yang eksplisit, termasuk indikasi clipping.
- Pertahankan freshness gate, penghapusan kurva stale, dan label SIMULATION.

### Kriteria penerimaan

- Cek screenshot pada 1366×768, 1920×1080, dan mobile; plot utama tidak terpotong
  tanpa petunjuk dan label tidak bertabrakan, termasuk pada peak dekat ticks.
- Uji 0/90/180/270°, offset, wrap 359→0, vektor datar, nilai negatif,
  stale/invalid, dark/light, resize, serta reduced motion.
- Cocokkan peak grafik, metadata, dan ray map simulasi pada konvensi yang sama.
- Pemeriksaan kali ini memakai preview lokal dan data sintetis, bukan hardware.
  Tidak ada klaim validasi RF atau bahwa temuan visual sudah diperbaiki.