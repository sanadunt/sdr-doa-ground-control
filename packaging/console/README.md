# SDR-DoA Ground Console: instalasi Linux

Ground Console bisa dipasang dengan dua cara di komputer Linux ground station. Keduanya berjalan di background, hidup lagi setelah reboot, dan menyimpan semua pengaturan di satu direktori data.

| | Native (`install.sh`) | Docker (`docker compose`) |
|---|---|---|
| Butuh | Python 3.9+ dengan `venv`, systemd user session | Docker Engine dan Compose v2 |
| Jalan di background | systemd user service + lingering | `restart: unless-stopped` |
| Data | `~/.local/share/sdr-doa-ground-console` | volume `sdr-doa-data` (`/data`) |
| Kontrol | `sdr-doa-console start|stop|restart|status|logs|open` | `docker compose ...` |
| Update tanpa login GitHub | `sdr-doa-console update`, `auto-update on` | `sdr-doa-docker update`, `auto-update on` (image GHCR) |

Console selalu bind ke `127.0.0.1:8787`, jadi hanya bisa dibuka dari komputer itu sendiri: `http://127.0.0.1:8787/`. Pakai Chromium atau Chrome; Receiver (HackRF lewat WebUSB) tidak jalan di Firefox. Tablet atau komputer lain di LAN hanya bisa melihat, lewat tampilan LAN yang dinyalakan admin di **Konfigurasi → Akses LAN** (listener kedua, mati secara default; lihat `QUICKSTART.md`, "Tampilan LAN (lihat saja)").

## Yang tersimpan otomatis

Semua yang diubah lewat UI disimpan di server console, bukan hanya di browser, sehingga tetap ada saat browser lain dipakai, cache dibersihkan, console di-restart, atau komputer reboot:

- `console.json`: koneksi Data Out, MQTT (host, port, transport, path WebSocket) dan interval refresh;
- `branding.json`: nama aplikasi dan logo;
- `preferences.json`: tampilan (tema, bahasa, panel Overview, node card, peta dasar, Lapisan/overlay, polar, sumber kompas dan offset, sumber GPS, mode dengar, follow-node);
- `receiver/`: rekaman dan scan Receiver (`receiver.sqlite3`, `audio/`);
- `tiles/`: cache tile peta dasar (paling banyak 512 MB, area yang pernah tampil tetap terlihat saat offline; boleh dihapus);
- `.env`: kata sandi admin (`SDR_DOA_ADMIN_PASSWORD`, mode 0600).

Data realtime (snapshot DoA, MQTT, spektrum) tidak disimpan; itu diperbarui terus.

## Native

```sh
curl -fLO https://github.com/sanadunt/sdr-doa-ground-control/releases/download/v2.0.0/sdr-doa-ground-console-2.0.0-linux.tar.gz
curl -fLO https://github.com/sanadunt/sdr-doa-ground-control/releases/download/v2.0.0/SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS
tar -xzf sdr-doa-ground-console-2.0.0-linux.tar.gz
cd sdr-doa-ground-console-2.0.0-linux
sh install.sh
```

Ganti `2.0.0` dengan versi di halaman Releases. Setelah terpasang, versi berikutnya datang lewat `sdr-doa-console update` (bagian "Update dari GitHub Releases").

Installer memeriksa file rilis terhadap `MANIFEST.sha256`, membuat venv berisi `paho-mqtt` dan `tzdata` (dari folder `wheels/` bila ada, selain itu dari PyPI), lalu menanyakan kata sandi admin: ketik sendiri, ketik `random` untuk dibuatkan, atau tekan Enter untuk memakai default `123456` (akan muncul peringatan). Setelah itu console langsung jalan dan dibuka dengan `sdr-doa-console open` atau menu **SDR-DoA Ground Console**.

Di Debian/Ubuntu, bila venv gagal dibuat, pasang dulu `sudo apt install python3-venv`.

Yang dipasang:

```text
~/.local/share/sdr-doa-ground-console/app/          program, venv, README
~/.local/share/sdr-doa-ground-console/              data (lihat di atas)
~/.config/systemd/user/sdr-doa-ground-console.service
~/.local/bin/sdr-doa-console                        perintah kontrol
~/.local/share/applications/sdr-doa-ground-console.desktop
```

Agar console jalan saat boot tanpa login, installer menjalankan `loginctl enable-linger $USER`. Bila distro menolaknya, jalankan sekali `sudo loginctl enable-linger $USER`.

Opsi tanpa pertanyaan, misalnya untuk skrip:

```sh
sh install.sh --yes --generate-password \
  --base-url http://192.168.100.100:8081 --mqtt-host 10.90.0.1 --mqtt-port 9001
```

| Opsi | Arti |
|---|---|
| `--yes` | tanpa pertanyaan; kata sandi tersimpan dipertahankan, selain itu default `123456` |
| `--password NILAI` / `--generate-password` | set kata sandi admin |
| `--prefix DIR`, `--data-dir DIR`, `--bin-dir DIR` | lokasi program, data, dan perintah |
| `--port PORT` | port di 127.0.0.1 (default 8787) |
| `--no-service` | tanpa systemd service; jalankan dengan `sdr-doa-console start` (tidak hidup lagi setelah reboot) |
| `--no-desktop` | tanpa entri menu |
| `--base-url`, `--mqtt-host`, `--mqtt-port`, `--mqtt-transport`, `--mqtt-ws-path`, `--refresh-seconds` | nilai awal untuk start pertama |

Nilai awal ditulis ke `seed.env` di direktori data sebagai `SDR_DOA_SEED_*`. Console memakainya hanya saat `console.json` belum ada, lalu menulis `console.json`; sesudah itu `seed.env` dihapus dan perubahan dilakukan di halaman **Konfigurasi**. Service sengaja tidak memakai `--base-url`/`--mqtt-*`, karena flag itu menimpa pengaturan tersimpan di setiap start dan perubahan dari UI akan tampak tidak tersimpan.

Bila console pernah dijalankan dari repository dengan path default, installer menyalin `~/.config/sdr-doa-ground-console/console.json` dan `branding.json` ke direktori data (hanya bila belum ada dan tanpa opsi nilai awal), dan memindahkan rekaman Receiver lama dari `~/.local/share/sdr-doa-ground-console/` ke `receiver/` (dilewati selama console lama masih jalan di port yang sama).

### Perintah `sdr-doa-console`

```text
sdr-doa-console open        start bila perlu, lalu buka di Chromium/Chrome (mode app)
sdr-doa-console start|stop|restart|status
sdr-doa-console logs        ikuti log (journalctl --user)
sdr-doa-console password    ganti kata sandi admin, lalu restart console
sdr-doa-console update      pasang rilis terbaru dari GitHub (lihat di bawah)
sdr-doa-console auto-update on [--time HH:MM] | off | status
sdr-doa-console run         jalankan di foreground (perintah yang sama dengan service)
sdr-doa-console info        versi dan path
sdr-doa-console uninstall [--purge]
```

### Update dari GitHub Releases

```text
sdr-doa-console update --check       versi terpasang dan rilis terbaru, tanpa mengubah apa pun
sdr-doa-console update               unduh, periksa, pasang (bertanya dulu)
sdr-doa-console update --yes         tanpa pertanyaan
sdr-doa-console update --auto        seperti timer: tanpa pertanyaan, dan menunggu selama Receiver merekam atau memindai
sdr-doa-console update --to 2.0.1    rilis tertentu, juga untuk kembali ke versi lama atau mencoba prerelease
sdr-doa-console update --allow-major izinkan versi mayor baru (baca catatan rilisnya dulu)
```

Tidak perlu akun atau token GitHub: repository publik, jadi daftar rilis dan file rilis bisa diambil tanpa login. Token di environment (`GITHUB_TOKEN`) tidak pernah dikirim. Updater memakai proxy dari environment (`HTTPS_PROXY`, `NO_PROXY`). Urutannya:

1. baca rilis terbaru; prerelease tidak pernah dipilih, dan versi mayor lain (misalnya 3.x saat 2.x terpasang) hanya dengan `--allow-major`;
2. unduh `SHA256SUMS` dan `sdr-doa-ground-console-<versi>-linux.tar.gz`, cocokkan SHA-256, ekstrak hanya file dan folder di dalam folder rilis, lalu cocokkan `MANIFEST.sha256`. Tidak ada isi unduhan yang dijalankan sebelum hash cocok;
3. salin program sekarang (dengan venv, perintah `sdr-doa-console`, service, dan menu) ke `app.previous`;
4. jalankan `install.sh` rilis baru dengan opsi instalasi sekarang. `install.sh` mencatat opsinya di `app/install-options` (`--prefix`, `--data-dir`, `--bin-dir`, `--port`, `--no-service`, `--no-desktop`); kata sandi dan nilai awal tidak pernah dicatat;
5. tunggu sampai `/api/health` melaporkan versi baru, paling lama 60 detik. Bila gagal, `app.previous` dikembalikan, console lama dijalankan lagi, dan perintah keluar dengan kode 1. Rilis itu dilewati oleh update berikutnya sampai ada rilis yang lebih baru; `--to <versi>` mencobanya lagi.

Data dan kata sandi tidak disentuh. Hanya satu update berjalan pada satu waktu. Selama `/api/health` melaporkan `receiver_busy` (Receiver merekam audio atau mengarsipkan pindai), update otomatis (`--auto`) ditunda ke jadwal berikutnya dan mencatat `deferred: Receiver recording or scan active`; setelah 7 hari tertunda terus, update tetap dijalankan. Update manual memberi peringatan, lalu bertanya atau butuh `--yes`. Bila unit update di-stop selama update berjalan (shutdown, logout), instalasi dikembalikan sampai selesai; sinyal kedua tidak memotong pengembalian itu. Hasil terakhir terlihat di `sdr-doa-console auto-update status` (tersimpan di `update-state.json` di direktori data).

Update otomatis: `sdr-doa-console auto-update on` memasang systemd user timer `sdr-doa-console-update.timer` di sebelah service console. Timer berjalan setiap hari pukul 03.45 waktu lokal (`--time 04:30` untuk jam lain), diacak sampai 15 menit, dan menyusul saat komputer menyala lagi bila jadwal terlewat; isinya `sdr-doa-console update --auto` (tanpa pertanyaan, dan menunggu selama Receiver sibuk). Butuh service console (instalasi tanpa `--no-service`) dan lingering; tanpa systemd user session perintah menampilkan baris cron sebagai gantinya. Log: `journalctl --user -u sdr-doa-console-update`. User service tidak membaca `~/.profile`, jadi bila perlu proxy, tulis `HTTPS_PROXY=...` di `~/.config/environment.d/proxy.conf` (berlaku setelah reboot) dan untuk sekarang `systemctl --user set-environment HTTPS_PROXY=...`. Matikan dengan `sdr-doa-console auto-update off`.

Instalasi dari tarball yang belum punya perintah `update` dipasang ulang sekali dengan `sh install.sh` dari rilis baru; setelah itu `update` tersedia.

### Upgrade manual dan uninstall

Upgrade manual: ekstrak rilis baru dan jalankan `sh install.sh` lagi. Program dan venv diganti, direktori data tetap. `sdr-doa-console uninstall` menghapus program, service, timer update, salinan `app.previous`, menu, dan perintahnya; data tetap di tempatnya. `sdr-doa-console uninstall --purge` juga menghapus data (dengan konfirmasi).

## Docker

Hanya Linux, karena memakai `network_mode: host`. Console bind ke `127.0.0.1` dan menolak alamat lain. Dengan network host, loopback itu adalah loopback komputer ini, jadi `http://127.0.0.1:8787/` bisa dibuka di sini dan tidak terbuka ke LAN. Network bridge dengan `ports:` tidak dipakai: di dalam container console harus bind ke alamat non-loopback (ditolak console), dan admin serta patch konfigurasi akan terbuka ke LAN. Tampilan LAN lihat-saja, bila dinyalakan, juga langsung memakai network host, tanpa `ports:`. Docker Desktop di macOS/Windows tidak meneruskan network host ke komputer.

### Dari image GHCR, dengan update otomatis

Tanpa build dan tanpa login GitHub: image `ghcr.io/sanadunt/sdr-doa-ground-console` publik. `sdr-doa-docker` (aset rilis, juga `packaging/docker/sdr-doa-docker` di tarball) menulis `compose.yml` dan `.env` di direktori install, mem-pull image, lalu menunggu healthcheck. Update hanya butuh Docker Engine dengan Compose v2; unduhan pertama butuh `curl` atau `wget` (URL yang sama).

```sh
curl -fLO https://github.com/sanadunt/sdr-doa-ground-control/releases/latest/download/sdr-doa-docker
curl -fLO https://github.com/sanadunt/sdr-doa-ground-control/releases/latest/download/SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS
sudo sh sdr-doa-docker install --auto-update     # /opt/sdr-doa-ground-console, timer harian 03:30
sudo sdr-doa-docker status
sudo sdr-doa-docker update                       # sekarang; --check hanya melihat
sudo sdr-doa-docker rollback                     # kembali ke image sebelumnya
sudo sdr-doa-docker auto-update off
cd /opt/sdr-doa-ground-console && sudo docker compose exec console sdr-doa-set-admin-password && sudo docker compose restart console
```

Semua perintah untuk instalasi di `/opt` pakai `sudo`, karena `.env` di sana milik root (0600). Kanal update adalah `SDR_DOA_IMAGE_TAG` di `/opt/sdr-doa-ground-console/.env` (bawaan `2`: setiap rilis 2.x.y; `2.0` hanya 2.0.z; versi mayor baru hanya dengan `install --channel 3`). Image baru yang tidak `healthy` dalam 180 detik diganti lagi dengan image sebelumnya (tag `sdr-doa-previous`); bila image itu sendiri gagal (unhealthy, berhenti, restart terus) ia dicatat di `.bad-images` dan update otomatis melewatinya. Image yang lebih lama dari yang jalan juga dilewati update otomatis, dan selama Receiver merekam atau mengarsipkan pindai update otomatis ditunda (paling lama 7 hari). Tanpa plugin `docker buildx`, `update --check` mem-pull image untuk membandingkannya (container dan tag yang jalan tetap). Setiap langkah tercatat di `update.log`. Satu host punya satu timer update (`auto-update on --force` memindahkannya), dan timer root hanya untuk direktori milik root; instalasi milik user mendapat baris crontab dari `sdr-doa-docker auto-update on` tanpa sudo.

`update` hanya mengganti image: perubahan `.env` (port, kata sandi, nilai awal) diterapkan dengan `cd /opt/sdr-doa-ground-console && sudo docker compose up -d` atau `sudo sdr-doa-docker install` lagi. Nilai `SDR_DOA_ADMIN_PASSWORD` atau `SDR_DOA_SEED_*` yang memuat `$` ditulis dalam kutip tunggal (`SDR_DOA_ADMIN_PASSWORD='Xk9$q2!aB'`), karena docker compose mengganti `$nama` di nilai tanpa kutip atau berkutip ganda; script memberi peringatan bila tidak.

Pindah dari image yang di-build sendiri: nama project compose dan volume sama dengan compose di bawah, jadi datanya tetap. Pengaturan di `.env` lama tidak ikut: salin baris `SDR_DOA_ADMIN_PASSWORD`, `SDR_DOA_PORT` dan `SDR_DOA_SEED_*` dari `.env` di sebelah `docker-compose.yml` ke `/opt/sdr-doa-ground-console/.env` (atau pakai `--port`), jalankan `cd /opt/sdr-doa-ground-console && sudo docker compose up -d`, lalu jangan pakai `docker compose` di direktori lama lagi (project yang sama; `up -d --build` di sana mengembalikan build lokal). Rincian di `QUICKSTART.md`, "Docker dari image GHCR".

### Di-build dari rilis atau repository

Dari rilis (tidak perlu Node.js):

```sh
tar -xzf sdr-doa-ground-console-2.0.0-linux.tar.gz
cd sdr-doa-ground-console-2.0.0-linux
docker compose up -d --build
```

Dari repository (butuh submodule, build frontend di dalam image):

```sh
git submodule update --init --recursive
docker compose up -d --build
```

Build dari repository harus dari clone biasa: builder Receiver memeriksa commit BrowSDR lewat `.git/modules/vendor/BrowSDR`. Di git worktree atau export tanpa `.git`, build berhenti dengan pesan yang menjelaskan ini; pakai `python3 tools/make_release.py` lalu image dari rilis.

Container berjalan sebagai uid 10001, mulai lagi bersama Docker saat boot, dan punya healthcheck ke `/api/health`. Semua data ada di volume `sdr-doa-ground-console_sdr-doa-data` (`/data`). Compose dari repository dan dari rilis memakai nama project yang sama, jadi volume yang sama.

Kata sandi admin, pilih salah satu:

```sh
# disimpan di volume (/data/.env)
docker compose exec console sdr-doa-set-admin-password
docker compose restart console

# atau lewat environment: shell atau file .env di sebelah docker-compose.yml;
# kutip tunggal, karena docker compose mengganti $nama di nilai lain
echo "SDR_DOA_ADMIN_PASSWORD='rahasia-anda'" >> .env
docker compose up -d
```

Environment menang atas `/data/.env`. Bila tidak di-set di keduanya, default `123456` berlaku dan UI memberi peringatan; `SDR_DOA_ADMIN_PASSWORD=` (kosong) mematikan login admin.

Nilai awal start pertama dan port juga dibaca dari environment atau `.env` di sebelah compose: `SDR_DOA_SEED_BASE_URL`, `SDR_DOA_SEED_MQTT_HOST`, `SDR_DOA_SEED_MQTT_PORT`, `SDR_DOA_SEED_MQTT_TRANSPORT`, `SDR_DOA_SEED_MQTT_WS_PATH`, `SDR_DOA_SEED_REFRESH_SECONDS`, `SDR_DOA_PORT`. Variabel yang tidak di-set tidak diteruskan ke container.

Perintah berguna:

```sh
docker compose ps                    # status dan health
docker compose logs -f console
docker compose up -d --build         # upgrade setelah ekstrak rilis baru; volume tetap
docker run --rm -v sdr-doa-ground-console_sdr-doa-data:/data -v "$PWD":/backup \
  python:3.12-slim-bookworm tar -C /data -czf /backup/sdr-doa-data.tar.gz .   # backup
docker compose down                  # stop; volume tetap (hapus dengan down -v)
```

WebUSB untuk Receiver berjalan di browser komputer ini, jadi HackRF tidak perlu diteruskan ke container.

## Masalah umum

- **Port 8787 sudah dipakai**: console lain (dari repository, native, atau Docker) masih jalan. Hentikan dulu, lalu `sdr-doa-console start` atau `docker compose up -d`.
- **Tidak jalan setelah reboot (native)**: cek `loginctl show-user $USER -p Linger`; harus `Linger=yes`.
- **Tidak ada systemd user session** (container, WSL tanpa systemd): installer menjalankan console di background sampai reboot berikutnya; jalankan `sdr-doa-console start` setelah login.
- **MQTT monitor ERROR atau Kontrol nonaktif**: lihat bagian Kontrol di `QUICKSTART.md`; console butuh broker tanpa TLS/password yang bisa dijangkau dari komputer ini.
