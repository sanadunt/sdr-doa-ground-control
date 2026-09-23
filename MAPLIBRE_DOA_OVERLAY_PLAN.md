# Rencana MapLibre dan Overlay Arah DoA

Tanggal: 21 September 2026
Status: **Implemented in Ground Console frontend; hardening and live validation ongoing**

## 1. Tujuan dan keputusan

Mengubah peta Ground Console menjadi bantuan navigasi arah: pola angular 360°, garis bearing, dan heatmap relatif ter-overlay pada basemap OSM. **Bukan estimasi lokasi pemancar, RF coverage, pengukuran jarak, atau probabilitas keberadaan target.**

Keputusan berdasarkan permintaan pengguna:

- Migrasi renderer peta dari Leaflet ke **MapLibre GL JS**.
- Pertahankan **Plotly** sebagai grafik angular detail, termasuk zoom, rotasi, Head Up, dan min/max dB.
- Adopsi konsep repository `https://gitlab.com/sanadunt/krakendf-web-viewer`, bukan menyalin aplikasi atau mengimpor konfigurasinya.
- Sediakan pengaturan heatmap, jarak proyeksi, lobe, dan garis pembantu.
- Data update tidak boleh mereset interaksi kamera maupun pengaturan operator.
- Simulasi menjadi jalur validasi pertama, kemudian data live dengan gate yang eksplisit.
- Tidak mengubah backend, kontrak MQTT, publication gate, atau kemampuan remote write.

## 2. Baseline yang telah diperiksa

Root proyek: `/Users/mac/Documents/all-code/doa-sdr-telemetry`.

| Bagian | Kondisi sekarang |
|---|---|
| Frontend | React 19, TypeScript, Vite, Vitest |
| Peta | MapLibre GL JS, tile OSM, station marker, bearing/lobe/guides/heatmap overlay |
| Grafik | Plotly, vektor 360 bin, kontrol orientasi/radial |
| Simulasi | Koordinat, angle, lebar lobe, randomize manual/otomatis |
| Overview | Map dan polar berdampingan; mode enlarge grafik |
| Sumber posisi | Data Out, manual, fallback, atau simulasi |
| MapLibre | Implemented; overlay settings persist locally |

File integrasi existing:

- `/Users/mac/Documents/all-code/doa-sdr-telemetry/frontend/src/components/TacticalMap.tsx`
- `/Users/mac/Documents/all-code/doa-sdr-telemetry/frontend/src/components/PolarPanel.tsx`
- `/Users/mac/Documents/all-code/doa-sdr-telemetry/frontend/src/components/PolarPlot.tsx`
- `/Users/mac/Documents/all-code/doa-sdr-telemetry/frontend/src/pages/OverviewPage.tsx`
- `/Users/mac/Documents/all-code/doa-sdr-telemetry/frontend/src/lib/map.ts`
- `/Users/mac/Documents/all-code/doa-sdr-telemetry/frontend/src/lib/polar.ts`
- `/Users/mac/Documents/all-code/doa-sdr-telemetry/frontend/src/lib/simulation.ts`

Working tree sudah memiliki perubahan GUI/Plotly/simulasi sebelum rencana ini; implementasi tidak boleh menimpa perubahan tersebut.

## 3. Pelajaran dari repository referensi

Source yang diperiksa: `src/MapCanvas.jsx`, `src/components/Map/DfMap.jsx`, `src/workers/heatmapWorker.js`, dan `src/lib/geo.js`.

- MapLibre merender source GeoJSON menjadi layer heatmap, garis, dan polygon.
- Jalur `buildSampleVisual()` membentuk titik sepanjang bearing dengan bobot angular dan falloff terhadap jarak.
- Lobe dibentuk dengan memproyeksikan sampel angular ke koordinat geografis; radiusnya adalah skala visual.
- Terdapat heading/angle offset, pengaturan warna, dan history.
- Worker dan renderer aktif memiliki algoritma berbeda; tidak boleh mengasumsikan worker adalah satu-satunya jalur render.
- Normalisasi signed dB, fallback sudut, smoothing, dan heading perlu ditulis ulang sesuai kontrak kita.
- Jangan mengadopsi marker puncak heatmap sebagai posisi target, placeholder konversi sudut, atau konfigurasi koneksi/secret.

Referensi dibaca dari HEAD yang tersedia saat investigasi, belum dipin ke commit. Sebelum mengambil potongan kode: catat commit, periksa LICENSE/atribusi, dan implementasikan mandiri bila izin penyalinan tidak jelas.

## 4. Arsitektur yang diusulkan

```text
Snapshot live atau snapshot simulasi
          ↓
Adapter observasi bersama: validasi + provenance + freshness
          ↓
360 bin sumber + metadata angle/position/orientation
          ├── Plotly: koordinat display + skala grafik
          └── Geographic adapter: bearing North-clockwise
                       ↓
              Generator GeoJSON murni
                       ↓
         Station / bearing / lobe / heat points
                       ↓
              MapLibre persistent map
```

Pisahkan tiga jenis state:

1. **Observasi:** nilai sumber, timestamp/identity, validity, sumber koordinat dan orientasi.
2. **Pengaturan overlay:** opacity, skala, jarak, mode garis, visibility.
3. **Kamera:** center, zoom, bearing, pitch; tidak menjadi dependency generator data.

Usulan modul baru di `/Users/mac/Documents/all-code/doa-sdr-telemetry/frontend/src/`:

| Lokasi relatif terhadap direktori di atas | Tanggung jawab |
|---|---|
| `lib/doaObservation.ts` | Validasi/provenance observasi dan pemisahan angle sumber/display/geografis |
| `lib/doaGeometry.ts` | Proyeksi bearing, polygon lobe, garis, dan titik berbobot |
| `lib/mapOverlaySettings.ts` | Default, validasi, versioning pengaturan lokal |
| `components/MapOverlayControls.tsx` | Kontrol operator dan legend |
| `workers/doaOverlay.worker.ts` | Opsional, setelah profiling menunjukkan manfaat |

Nama modul adalah usulan implementasi, bukan klaim file sudah tersedia.

### Dependency dan deployment

- Kandidat baru: `maplibre-gl`, memakai API langsung agar tidak menambah wrapper React yang tidak diperlukan.
- Pilih versi saat implementasi berdasarkan Node/Vite/TypeScript, browser target, dan kebutuhan WebGL; pin melalui lockfile.
- Import CSS MapLibre secara lokal; lazy-load renderer ketika map dibuka.
- Tahap awal memakai raster OSM dalam style MapLibre minimal; tidak memerlukan Mapbox token atau layanan style berbayar.
- OSM adalah sumber basemap, bukan mesin renderer. Tile tetap memerlukan jaringan kecuali deployment memiliki penyedia offline sendiri.
- Tampilkan atribusi OpenStreetMap beserta tautan lisensinya; patuhi kebijakan tile provider, tanpa prefetch/bulk download.
- Audit CSP/worker/blob URL dan static serving Ground Console. Jangan melonggarkan kebijakan keamanan secara global untuk membuat worker berjalan.
- Bila WebGL gagal/context lost: tampilkan kegagalan dan retry yang jelas; Plotly tetap tersedia. Jangan diam-diam menampilkan data lama sebagai aktif.
- Hapus Leaflet dan typenya hanya setelah semua pemakaian selesai dimigrasikan dan tes lulus.

## 5. Kontrak sudut dan posisi

### Model observasi

Adapter perlu menghasilkan: source `LIVE`/`SIMULATION`, identity/sequence, freshness, 360 nilai signed dB, konvensi bin, canonical angle bila tersedia, posisi dan provenance, orientasi dan provenance, serta alasan overlay ditahan.

Tidak menganggap nomor bin, canonical angle, dan sudut display selalu identik. Gunakan konversi source yang sudah diverifikasi, bukan helper kedua yang membalik sudut ulang.

### Aturan geografis

- Bearing map: **0° utara, 90° timur, searah jarum jam**.
- Bin lokal array membutuhkan orientasi pemasangan/heading yang diketahui untuk menjadi bearing geografis.
- Jika upstream sudah north-referenced, heading tidak ditambahkan lagi.
- Definisikan true north vs magnetic north; bila sumber magnetic belum dikoreksi, tampilkan status itu dan jangan mengklaim true-north verified.
- Head Up Plotly hanya memutar tampilan grafik. Tidak mengubah data atau bearing map.
- Rotasi map hanya memutar kamera. Tidak mengubah geometri observasi.
- Heading manual adalah asumsi operator dengan label `MANUAL ORIENTATION`, bukan sensor heading terverifikasi.
- Heading belum diketahui: tahan overlay geografis live atau izinkan mode referensi manual yang dipilih eksplisit; jangan memakai nol diam-diam.
- Untuk simulasi, kontrak eksplisit menggunakan angle North-clockwise; samakan hasil Plotly dan map melalui adapter, bukan melalui kemiripan tampilan semata.

### Posisi dan gate

- Marker station dapat ditampilkan dari koordinat manual/fallback dengan label sumber.
- Overlay live pada koordinat manual/fallback hanya melalui pilihan eksplisit `Reference preview`; bukan default hasil navigasi live.
- Posisi live, vektor, dan orientasi harus lolos gate relevan sebelum overlay berlabel live dibuat.
- Freshness menggunakan elapsed time lokal seperti pola existing; stale/error/source switch membersihkan overlay aktif.
- Publication readiness berbeda dari display readiness. Publication gate tetap utuh dan tidak otomatis menjadi READY karena overlay tersedia.
- Koordinat geografis valid belum tentu dapat ditampilkan Web Mercator: tangani batas lintang sekitar ±85.0511°, jangan diam-diam menggeser posisi.
- Uji antimeridian dan lon wrapping; jangan membuat polygon melintasi seluruh dunia.

## 6. Layer dan makna visual

Urutan dasar: basemap → heatmap → lobe fill → lobe outline → angle guides → bearing → station/label.

| Layer | Makna | Default awal |
|---|---|---|
| Station | Titik referensi observasi | ON |
| Bearing | Arah pilihan: display peak atau canonical source | ON jika tersedia |
| Lobe | Bentuk relatif 360 bin pada skala geografis | ON |
| Heatmap | Intensitas angular relatif dengan falloff visual | OFF, operator dapat ON |
| Angle guides | Garis navigasi berinterval, bukan pengukuran tambahan | OFF |
| History | Observasi terdahulu berumur terbatas | Di luar MVP |

Bearing canonical yang tidak tersedia tidak diganti peak diam-diam. Label harus mengikuti sumber yang dipilih. Garis manual tambahan selalu diberi label `REFERENCE`, bukan DoA.

### Normalisasi dan proyeksi

Default visual memakai rentang dB tetap yang dinyatakan:

```text
w = clamp((valueDb - minDb) / (maxDb - minDb), 0, 1)
lobeRadius = displayRadiusMeters × w^contrast
heatWeight = w × visualFalloff(distance)
```

- Ini bobot visual, **bukan konversi otomatis ke daya linear fisik**.
- dB asli dipertahankan pada tooltip/metadata. Sampel di luar rentang diberi indikasi clipping.
- Min/max invalid ditolak; jangan clamp input buruk menjadi data yang tampak sehat.
- Min/max Plotly terpisah dari pengaturan overlay. Sediakan `Use plot dB range` bila berguna; zoom grafik tidak mengubah overlay diam-diam.
- Simulasi default −60…0 dB. Live memakai rentang valid eksplisit atau mode auto berlabel; jangan mengklaim kalibrasi absolut.
- Semua nilai flat, NaN, atau vektor tidak lengkap mendapat handling deterministik. Invalid vector tidak menghasilkan kipas fallback sintetis tanpa label.
- Proyeksi memakai perhitungan destination geografis yang diuji; bukan menambah derajat latitude/longitude secara linear.
- Heatmap density dipengaruhi agregasi titik dan zoom. Legend menyatakan intensitas relatif, bukan skala dB per pixel.
- Falloff hanya estetika bantuan arah; tooltip menjelaskan bahwa max distance bukan jarak target.
- Smoothing polygon OFF dahulu agar tidak menambah lobe/peak palsu.

## 7. Kontrol operator

Kontrol diletakkan pada drawer/popover panel map, tidak memenuhi grafik atau menutupi atribusi. Advanced controls terpisah dari kontrol harian.

| Kontrol | Perilaku / batas awal yang diusulkan |
|---|---|
| Layer toggles | Heatmap, lobe, bearing, guides |
| Heatmap intensity | 0–3, default 1; label `Visual intensity` |
| Heatmap opacity | 0–1, default 0.55 |
| Heatmap blur radius | 4–80 px, default 24; perilaku terhadap zoom dinyatakan |
| Max projection distance | 100–20.000 m, default 1.000 m; bukan target range |
| Sampling step | Advanced, 25–1.000 m; adaptive jika budget terlampaui |
| Lobe display radius | 100–20.000 m, default 1.000 m |
| Lobe fill opacity | 0–0.6, default 0.15 |
| dB min/max | Finite, min < max; shared scale heat/lobe |
| Contrast | 0.25–4, default 1; hanya normalisasi visual |
| Noise threshold | -160–20 dB; sampel di bawah ambang tidak dirender sebagai heat |
| Radial samples | 2–32; kepadatan sampel sepanjang setiap bearing |
| Distance falloff | 0–1; pelemahan visual sepanjang proyeksi |
| Visual intensity | 0.25–3; penguat visual heat, bukan gain RF |
| Heat palette | Kraken, Thermal, Viridis, Monochrome |
| Bearing source | Display peak / canonical; opsi unavailable dinonaktifkan dengan alasan |
| Bearing length | Independent, atau link ke projection distance |
| Bearing style | Lebar 1–6 px, solid/dashed, warna yang terbaca |
| Reference angle | Garis manual terpisah 0–359°, toggle eksplisit |
| Guide interval | 15°, 30°, 45°, 90°; default 45° |
| Orientation | Sumber diketahui / manual reference; label provenance |
| Center station | Satu aksi, bukan auto-recenter setiap update |
| North up | Reset bearing/pitch kamera saja |
| Reset overlays | Reset parameter visual saja |

Semua angka di tabel adalah default usulan untuk implementasi, bukan nilai hasil kalibrasi perangkat. Validasi finite/range sebelum alokasi geometri. Debounce slider mahal; number input memakai Apply. Tampilkan satuan pada label.

Simpan preferensi visual menggunakan key versioned di browser dengan validasi saat restore. Jangan persist mode simulasi ON, manual orientation sebagai verified, atau history secara default. Kamera dipertahankan saat update dan navigasi tab dalam sesi; reload boleh memakai view default.

## 8. Lifecycle, performa, dan UX

- Satu instance MapLibre per mount; perubahan koordinat/vector melakukan `setData`, bukan membuat map baru.
- Update source hanya bila observasi/geometri relevan berubah. Polling freshness tidak boleh membangun seluruh geometri tanpa kebutuhan.
- Coalesce pekerjaan, latest-value-wins; worker result memakai sequence ID dan ditolak bila sudah stale/source berbeda.
- Budget awal maksimum 12.000 heat points per frame; sampling harus merata seluruh 360°, bukan memotong bin akhir ketika cap tercapai.
- Zero-weight points dapat dihilangkan; invalid data tidak diubah menjadi nol valid.
- Debounce perubahan slider sekitar 100–150 ms; nilai akhir harus tetap diterapkan.
- Pisahkan paint-property update dari regenerasi GeoJSON.
- Style reload membangun ulang source/layer secara idempotent tanpa kehilangan kamera.
- ResizeObserver memanggil resize saat panel/enlarge berubah.
- Cleanup listener, worker, timeout, ResizeObserver, dan map pada unmount; uji React StrictMode.
- Heatmap stale dibersihkan meski worker masih berjalan; worker lama tidak boleh menghidupkannya lagi.
- Pertahankan layout 50:50 desktop serta enlarge grafik. Kontrol dan legend tetap terbaca pada mobile.
- Hormati reduced motion untuk fly/center; jangan memutar atau mem-pulse heatmap palsu.
- Tooltip mencantumkan sumber, bearing, umur data, dan skala visual. Jangan memakai warna saja untuk membedakan simulasi/live.
- Tile failure berbeda dari data failure: overlay dapat tetap bekerja pada background netral dengan peringatan `Basemap unavailable`.
- Tidak menjanjikan offline OSM; tile provider lokal/offline adalah pekerjaan deployment terpisah.

## 9. Tahapan implementasi

### Tahap 0 — Kontrak dan fixture

- Verifikasi konvensi bin/offset pada fixture existing dan upstream; tulis truth table 0/90/180/270°.
- Definisikan observasi, settings, provenance, serta gate overlay.
- Tambahkan unit test normalisasi signed dB, geodesic, scale, dan sampling budget.
- Periksa versi MapLibre, lisensi referensi, CSP, dan kompatibilitas browser target.

**Selesai bila:** arah dapat diprediksi tanpa renderer dan tidak ada heading ganda.

### Tahap 1 — Migrasi basemap MapLibre

- Pertahankan API komponen sejauh memungkinkan; gantikan lifecycle Leaflet dengan MapLibre.
- Port station marker, source badge, center, atribusi, failure state, resize, dan camera session state.
- Migrasikan ray simulasi existing; jangan menambah heatmap dahulu.
- Hapus dependency Leaflet setelah tidak ada import tersisa.

**Selesai bila:** peta dan ray existing berfungsi tanpa reset kamera saat simulasi update, tab switch, atau perubahan posisi.

### Tahap 2 — Lobe, bearing, guides

- Tambahkan GeoJSON polygon 360°, peak/canonical ray, manual reference, dan guides.
- Tambahkan display radius, opacity, visibility, line controls, dan legend.
- Integrasikan simulasi kemudian live display gate.

**Selesai bila:** peak Plotly dan bearing map konsisten setelah mempertimbangkan referensi koordinat; stale/source switch membersihkan overlay.

### Tahap 3 — Heatmap dan tuning

- Tambahkan GeoJSON points + layer heatmap MapLibre.
- Tambahkan intensity, opacity, blur, max distance, sampling, dB range, contrast, dan reset.
- Profiling; tambahkan worker hanya jika main-thread budget tidak cukup.

**Selesai bila:** randomize 1 Hz mengubah overlay tanpa jump kamera dan controls tetap responsif pada budget titik maksimum.

### Tahap 4 — Hardening dan dokumentasi

- Uji lintas viewport, theme, keyboard, gesture nyata, error/WebGL failure, serta runtime Python.
- Uji stale, invalid, reload, StrictMode, source switch, dan worker out-of-order.
- Update `/Users/mac/Documents/all-code/doa-sdr-telemetry/evaluasi GUI.md` dengan screenshot dan hasil aktual.
- Catat versi dependency dan batas performa pada hardware yang diuji; jangan menyebut target sebagai hasil benchmark.

### Tahap 5 — Opsional setelah MVP

Bounded history, fading, clear history, dan replay fixture. Tidak memasukkan triangulasi/target estimation. History simulasi dan live tidak bercampur; auto-clear saat source berubah.

## 10. Matriks validasi dan acceptance criteria

| Pengujian | Kriteria penerimaan |
|---|---|
| Cardinal angles | 0/90/180/270° menuju N/E/S/W; wrap 359→0 benar |
| Orientation | Offset hanya sekali; Head Up Plotly tidak mengubah bearing geografis |
| Signed dB | Nilai negatif tergambar, label asli dipertahankan, scale invalid ditolak |
| Randomize | Plotly, bearing, lobe, heatmap memakai observasi yang sama |
| Kamera | Drag, zoom, rotate fisik tetap bertahan saat data update |
| Controls | Intensity/opacity/radius berbeda fungsinya; reset overlays tidak reset kamera |
| Freshness | Stale/error menghapus overlay aktif; hasil worker terlambat tidak muncul kembali |
| Posisi | Manual/fallback berlabel; live tidak diproyeksikan di fallback diam-diam |
| Source switch | Simulasi OFF langsung menghapus sumber sintetis, walaupun live belum tersedia |
| Performance | Budget titik dipatuhi, tidak bias ke bin awal, tidak menumpuk pekerjaan |
| Map lifecycle | Style reload, resize, unmount, dan StrictMode tidak menduplikasi layer/listener |
| Error states | Tile unavailable, WebGL failure, vector invalid dibedakan |
| Responsive | 1366×768, 1920×1080, 768 px, 390 px; tidak ada overflow horizontal halaman |
| Aksesibilitas | Keyboard, label/satuan input, focus, reduced motion, dan dua theme |
| Safety | Tidak ada publish/config apply/target marker akibat overlay |

Perintah validasi saat implementasi:

```bash
cd /Users/mac/Documents/all-code/doa-sdr-telemetry/frontend
npm test
npm run check
npm run build
git -C /Users/mac/Documents/all-code/doa-sdr-telemetry diff --check
```

Lakukan browser test pada production build lewat Ground Console Python dengan fixture/local source terkontrol. Preview Vite saja tidak cukup membuktikan CSP/static-serving deployment. Jangan menghubungi atau mengubah Raspberry/MQTT untuk pengujian overlay.

## 11. Batas scope dan keputusan tersisa

Tidak termasuk: tracking target, estimator lokasi, perubahan RF/DSP, telemetry angular tambahan melalui T900, penyimpanan historis server, offline tile pack, atau remote-control UI.

Keputusan teknis yang diselesaikan pada tahap 0, bukan diasumsikan sekarang:

1. Versi MapLibre yang cocok dan hasil pemeriksaan lisensi.
2. Referensi sudut/geographic heading live yang benar-benar tersedia.
3. Nilai rentang visual dB live yang masuk akal pada fixture aktual.
4. Perlu/tidaknya worker berdasarkan profiling target laptop.
5. Kebijakan tile provider untuk deployment operasional/offline.

## Terkait

- [[evaluasi GUI]]
- [[SUMMARY]]
- [[SDR_DOA_FRONTEND_WORKFLOW]]
- Referensi: https://gitlab.com/sanadunt/krakendf-web-viewer
- Dokumentasi library untuk pemeriksaan implementasi: https://maplibre.org/maplibre-gl-js/docs/

Dokumen ini adalah rencana pekerjaan. Tidak menyatakan migrasi, pengujian browser, atau benchmark MapLibre sudah dilakukan.