# Uji coba engine Receiver (fase 0, issue #15)

| | |
|---|---|
| Status | Kit percobaan. **Belum dijalankan.** Tidak dipasang installer mana pun, tidak ikut tarball rilis atau image Docker. |
| Untuk | Groundstation Linux dengan console di `127.0.0.1:8787` dan RadioSpectrum (HackRF) di USB |
| Kontrak terkait | [`docs/RECEIVER_MIRROR.md`](../../docs/RECEIVER_MIRROR.md) |

## Tujuan

Fase 4 issue #15 memindahkan pemilik RadioSpectrum dari halaman console kiosk ke tab engine khusus yang selalu hidup (C-lite). Sebelum itu dibangun, fase 0 menjawab empat pertanyaan:

1. **Auto-connect**: apakah Chromium tanpa interaksi bisa membuka RadioSpectrum lewat `navigator.usb.getDevices()` (fungsi `autoConnectAuthorizedHackRF` di overlay Receiver), bila kebijakan `WebUsbAllowDevicesForUrls` memberi izin tanpa chooser USB.
2. **Beban**: berapa CPU dan memori tab itu selama RX dan selama pindai lebar.
3. **Throttling**: apa yang terjadi bila jendelanya tersembunyi, diminimalkan, tertutup jendela lain, atau berjalan dengan `--headless=new`.
4. **Cabut-pasang**: apakah RX pulih setelah RadioSpectrum dicabut lalu dicolok lagi.

## Isi

| Berkas | Isi |
|---|---|
| `sdr-doa-receiver-engine.json` | Usulan kebijakan Chrome: `WebUsbAllowDevicesForUrls` untuk `http://127.0.0.1:8787` dan RadioSpectrum (vendor `0x1d50` = 7504, produk `0x6089` = 24713) |
| `trial-receiver-engine.sh` | Menjalankan Chromium terpisah dengan profil sementara di halaman Receiver console, jendela biasa atau `--headless=new`, dan mencatat CPU, memori, USB, dan mirror Receiver tiap beberapa detik |

## Syarat

- Console berjalan dan menjawab `curl -s --noproxy '*' http://127.0.0.1:8787/api/health`, dengan build Receiver (`/receiver/` tidak 404).
- Chromium atau Chrome di groundstation, dijalankan sebagai user desktop (bukan root). Firefox tidak punya WebUSB.
- RadioSpectrum tercolok. `lsusb -d 1d50:6089` menampilkannya (bila `lsusb` ada).
- **Tidak ada halaman lain yang memegang RadioSpectrum.** Hanya satu proses yang bisa membukanya: muat ulang halaman console kiosk tanpa membuka Receiver (atau tutup browser kiosk) selama uji.
- Untuk mengukur aliran frame: mode LAN lihat-saja terbuka (runbook 6.2). Tanpa itu kolom `mirror_*` di log tetap `None`, karena halaman console hanya mengirim mirror selama mode LAN terbuka.
- `curl`, `ps`, `awk`, dan `/proc` (Linux). `python3` dipakai untuk membaca mirror; `lsusb` opsional.
- Izin manusia untuk langkah 1: memasang kebijakan butuh `sudo`.

## Langkah 1: pasang kebijakan (sudo, dengan izin manusia)

Kebijakan memberi origin `http://127.0.0.1:8787` izin ke RadioSpectrum **tanpa chooser**, di semua profil browser itu di host ini, termasuk browser kiosk. `http://localhost:8787` adalah origin lain dan tidak ikut. Bila console memakai port lain, ganti port di `urls` dulu.

Chrome:

```sh
sudo install -D -m 0644 packaging/receiver-engine/sdr-doa-receiver-engine.json \
  /etc/opt/chrome/policies/managed/sdr-doa-receiver-engine.json
```

Chromium dari paket Debian/Ubuntu: direktori `/etc/chromium/policies/managed/` (beberapa distro: `/etc/chromium-browser/policies/managed/`). Chromium dari snap atau flatpak membaca kebijakan dari tempat lain; pakai Chrome atau Chromium paket biasa untuk uji ini.

**Periksa**: buka `chrome://policy` di browser itu, tekan **Reload policies**. `WebUsbAllowDevicesForUrls` muncul dengan status **OK**. Script juga mencetak `policy: <file>` saat start, atau peringatan bila tidak menemukannya.

## Langkah 2: jalankan

```sh
sh packaging/receiver-engine/trial-receiver-engine.sh --duration 600
```

| Opsi | Arti |
|---|---|
| `--port N` | Port console di `127.0.0.1` (bawaan `8787`) |
| `--url URL` | Halaman yang dibuka (bawaan `http://127.0.0.1:PORT/#/receiver`); harus di origin yang dinamai kebijakan |
| `--browser PATH` | Bawaan: `chromium`, `chromium-browser`, `google-chrome-stable` atau `google-chrome` dari `PATH` |
| `--headless` | Tanpa jendela (`--headless=new`) |
| `--no-throttle` | Tambah `--disable-background-timer-throttling`, `--disable-renderer-backgrounding`, `--disable-backgrounding-occluded-windows` untuk dibandingkan dengan run tanpa itu |
| `--duration SEC` | Berhenti setelah SEC detik (bawaan 600; `0` = sampai Ctrl+C) |
| `--sample SEC` | Jarak antarbaris log (bawaan 5) |
| `--log FILE` | Berkas log (bawaan `./receiver-engine-trial-<waktu>.log`) |
| `--keep-profile` | Profil sementara tidak dihapus di akhir (untuk melihat `browser.log`) |
| `--dry-run` | Cetak perintah browser lalu keluar |

Script menolak root (Chromium sebagai root butuh `--no-sandbox`) dan tidak pernah membuka `--remote-debugging-port` (port itu membuat proses lokal mana pun bisa mengendalikan browser). Profil sementara (`/tmp/sdr-doa-receiver-engine.XXXXXX`) dihapus saat script selesai, juga setelah Ctrl+C; browser dihentikan dengan TERM, sisa prosesnya dengan KILL setelah 5 detik.

Satu baris log tiap sampel:

```text
2026-10-26T10:00:05Z t=5s cpu=23.4% rss=612MiB procs=9 usb=present mirror_source_age_ms=180 mirror_frame_age_ms=210 visible=True running=True connected=True
```

`cpu` adalah persen satu core untuk seluruh proses browser sejak sampel sebelumnya, `rss` jumlah memori residen proses-proses itu, `usb` hasil `lsusb -d 1d50:6089`, kolom `mirror_*` dari `GET /api/mirror/receiver` (umur dalam ms menurut server). Baris terakhir: `summary: samples=… cpu_avg=… cpu_max=… rss_max=…`.

## Langkah 3: prosedur ukur

Jalankan tiap uji dengan log sendiri (`--log`), lalu isi tabel hasil di bawah.

### A. Auto-connect lewat `getDevices`

1. Jendela biasa: jalankan script. Tanpa klik apa pun, halaman Receiver menampilkan `Reconnecting to previously authorized RadioSpectrum...` lalu tersambung. Catat detik sampai `connected=True` di log.
2. Tekan **Start** di halaman Receiver jendela uji (fase 0 boleh satu klik ini; engine fase 4 harus memulai RX sendiri). Log: `running=True`, `mirror_frame_age_ms` di bawah 1000.
3. Ulangi dengan `--headless`. Tidak ada yang bisa diklik: catat apakah `connected=True` muncul.
4. Ulangi tanpa kebijakan (lepas dulu, lihat **Melepas**): hasil yang diharapkan `connected` tetap `False`, karena `getDevices()` kosong tanpa izin.

### B. CPU dan memori

1. RX berjalan 10 menit pada 10 MSPS, lalu 10 menit pada 20 MSPS (ganti di halaman Receiver), dock Spektrum tidak dibuka di jendela uji. Catat `cpu_avg`, `cpu_max`, `rss_max`.
2. Pindai lebar 10 menit (tab Spektrum, rentang bawaan). Catat yang sama.
3. Bandingkan dengan beban halaman kiosk biasa (console dengan Receiver dibuka di browser kiosk) bila perlu.

### C. Throttling

Mode LAN terbuka dan RX berjalan. Untuk tiap keadaan, 5 menit, catat apakah `running` tetap `True`, berapa `mirror_frame_age_ms` dan `mirror_source_age_ms` (batas: frame basi lewat 3000, sumber putus lewat 10000), dan CPU:

1. Jendela di depan (acuan).
2. Tab lain di depan dalam jendela yang sama.
3. Jendela diminimalkan.
4. Jendela tertutup penuh jendela lain.
5. `--headless`.

Ulangi 2 sampai 5 dengan `--no-throttle`. Catatan: halaman console sengaja berhenti meminta frame mirror saat tersembunyi (`visible=False`), jadi `mirror_frame_age_ms` naik di keadaan 2 dan 3 apa pun flag-nya. Yang diukur di sana adalah apakah RX Receiver tetap berjalan, apakah heartbeat (`mirror_source_age_ms`) tetap di bawah 10 detik, dan apakah CPU turun karena throttling. Engine fase 4 harus tetap mengirim frame walaupun tidak terlihat.

### D. Cabut dan colok lagi

1. RX berjalan. Cabut RadioSpectrum 10 detik, lalu colok lagi.
2. Log: `usb=absent` lalu `usb=present`; `connected` dan `running` menjadi `False`.
3. Catat apakah Receiver tersambung lagi sendiri, setelah muat ulang halaman (auto-connect hanya berjalan saat frame dipasang), atau baru setelah klik.

### Tabel hasil

| Uji | Mode | Hasil | Angka (cpu_avg / cpu_max / rss_max, umur) | Catatan |
|---|---|---|---|---|
| A1 auto-connect | jendela | | | |
| A3 auto-connect | headless | | | |
| A4 tanpa kebijakan | jendela | | | |
| B1 RX 10 MSPS | jendela | | | |
| B1 RX 20 MSPS | jendela | | | |
| B2 pindai | jendela | | | |
| C2–C5 | tanpa `--no-throttle` | | | |
| C2–C5 | dengan `--no-throttle` | | | |
| D cabut-colok | jendela | | | |

Lampirkan log-nya ke issue #15 (log tidak memuat kata sandi atau token).

## Melepas

1. Hentikan script (selesai sendiri, atau Ctrl+C). Profil sementara terhapus; dengan `--keep-profile` hapus direktori yang dicetaknya: `rm -rf /tmp/sdr-doa-receiver-engine.XXXXXX` (nama persis dari output).
2. Lepas kebijakan (sudo, dengan izin manusia):

   ```sh
   sudo rm -f /etc/opt/chrome/policies/managed/sdr-doa-receiver-engine.json
   sudo rm -f /etc/chromium/policies/managed/sdr-doa-receiver-engine.json /etc/chromium-browser/policies/managed/sdr-doa-receiver-engine.json
   ```

   **Periksa**: `chrome://policy` → **Reload policies**: `WebUsbAllowDevicesForUrls` tidak ada lagi. Izin WebUSB yang pernah diberikan lewat chooser di profil kiosk tidak terpengaruh.
3. Hapus berkas `receiver-engine-trial-*.log` bila tidak diperlukan.

Tidak ada yang lain yang dipasang: tidak ada service, unit systemd, perubahan `console.json`, atau paket.
