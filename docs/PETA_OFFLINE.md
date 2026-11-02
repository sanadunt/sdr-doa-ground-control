# Peta offline

Gaya peta **Offline** (menu peta di Dashboard, dan di tablet lewat tampilan LAN) menggambar peta dari satu file `offline.pmtiles` di console sendiri. Setelah file itu terpasang, peta tampil tanpa internet di area yang dicakup file, tidak perlu dibuka dulu saat online, dan tidak ada permintaan ke penyedia tile.

Gaya lain (Standard, Hot, Light, Dark, Satelit, Topografi) tetap memakai cache tile yang terisi saat dilihat (`QUICKSTART.md`, "Cache tile dan peta offline"). Citra satelit tidak punya versi offline.

## Isi dan batasnya

- Data jalan, bangunan, air, batas wilayah dan nama tempat dari OpenStreetMap, dalam format vektor Protomaps (gaya Terang). Lisensi data ODbL: atribusi "© OpenStreetMap contributors · Protomaps" tampil di peta.
- Cakupan dan zoom paling tinggi ditentukan file. Di atas zoom itu peta diperbesar saja (garis tetap tajam, tapi tanpa detail baru). Di luar cakupan peta kosong (warna dasar console).
- Tanpa ikon POI dan perisai jalan; nama tempat memakai huruf Latin (font Noto Sans di `frontend/public/assets/map-fonts`, kisaran 0–511).

## Membuat file

Alatnya `pmtiles` dari [go-pmtiles](https://github.com/protomaps/go-pmtiles/releases) (satu program, tanpa instalasi). Sumbernya build harian Protomaps (`https://build.protomaps.com/<YYYYMMDD>.pmtiles`, ambil tanggal yang ada). `pmtiles extract` hanya mengunduh bagian yang diminta. Jalankan `--dry-run` dulu: ia melaporkan ukuran tanpa menulis file.

```sh
pmtiles extract https://build.protomaps.com/20261101.pmtiles offline.pmtiles \
  --bbox=94.5,-11.5,141.5,6.5 --maxzoom=12 --dry-run
```

Kotak `--bbox` itu seluruh Indonesia (barat, selatan, timur, utara). Ukuran yang terukur pada build 2026-11-01:

| `--maxzoom` | Ukuran |
|---|---|
| 9 | 18 MB |
| 10 | 41 MB |
| 11 | 84 MB |
| 12 | 216 MB |
| 13 | 454 MB |
| 14 | 942 MB |

Hapus `--dry-run` untuk membuat file. Untuk area yang lebih kecil dengan zoom lebih tinggi, ganti `--bbox` dan `--maxzoom`; Protomaps paling tinggi zoom 15. Periksa hasilnya dengan `pmtiles show offline.pmtiles`.

## Memasang file

Nama file harus tepat `offline.pmtiles`, di folder peta console: `maps` di sebelah `console.json` (`--maps-dir` mengubahnya).

- **Docker:** `/data/maps` di volume `sdr-doa-data`. Dari folder `/opt/sdr-doa-ground-console`:

  ```sh
  sudo docker compose exec console mkdir -p /data/maps
  sudo docker compose cp offline.pmtiles console:/data/maps/offline.pmtiles
  ```

- **Native:** `~/.local/share/sdr-doa-ground-console/maps/offline.pmtiles`.

Console membaca file pada setiap permintaan, jadi mengganti file tidak perlu restart. Pilih gaya **Offline** di menu peta; bila gaya itu menunjukkan BASEMAP UNAVAILABLE · Offline, file belum terpasang atau rusak (log console memuat baris "Offline map" saat start).

## Cara kerjanya

Browser membaca file itu dengan permintaan rentang byte (HTTP `Range`), jadi tidak ada yang mengunduh seluruh file. Console melayaninya di `GET /api/maps/offline.pmtiles` (`tools/map_files.py`): satu nama file tetap, hanya baca, paling banyak 4 MiB per jawaban, dan tampilan LAN boleh membacanya. Tidak ada yang ditulis atau diambil dari jaringan.
