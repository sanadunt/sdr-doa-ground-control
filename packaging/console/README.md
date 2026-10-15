# SDR-DoA Ground Console: instalasi Linux

Ground Console bisa dipasang dengan dua cara di komputer Linux ground station. Keduanya berjalan di background, hidup lagi setelah reboot, dan menyimpan semua pengaturan di satu direktori data.

| | Native (`install.sh`) | Docker (`docker compose`) |
|---|---|---|
| Butuh | Python 3.9+ dengan `venv`, systemd user session | Docker Engine dan Compose v2 |
| Jalan di background | systemd user service + lingering | `restart: unless-stopped` |
| Data | `~/.local/share/sdr-doa-ground-console` | volume `sdr-doa-data` (`/data`) |
| Kontrol | `sdr-doa-console start|stop|restart|status|logs|open` | `docker compose ...` |

Console selalu bind ke `127.0.0.1:8787`, jadi hanya bisa dibuka dari komputer itu sendiri: `http://127.0.0.1:8787/`. Pakai Chromium atau Chrome; Receiver (HackRF lewat WebUSB) tidak jalan di Firefox.

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
tar -xzf sdr-doa-ground-console-2.0.0-linux.tar.gz
cd sdr-doa-ground-console-2.0.0-linux
sh install.sh
```

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
sdr-doa-console run         jalankan di foreground (perintah yang sama dengan service)
sdr-doa-console info        versi dan path
sdr-doa-console uninstall [--purge]
```

### Upgrade dan uninstall

Upgrade: ekstrak rilis baru dan jalankan `sh install.sh` lagi. Program dan venv diganti, direktori data tetap. `sdr-doa-console uninstall` menghapus program, service, menu, dan perintahnya; data tetap di tempatnya. `sdr-doa-console uninstall --purge` juga menghapus data (dengan konfirmasi).

## Docker

Hanya Linux, karena memakai `network_mode: host`. Console bind ke `127.0.0.1` dan menolak alamat lain. Dengan network host, loopback itu adalah loopback komputer ini, jadi `http://127.0.0.1:8787/` bisa dibuka di sini dan tidak terbuka ke LAN. Network bridge dengan `ports:` tidak dipakai: di dalam container console harus bind ke alamat non-loopback (ditolak console), dan admin serta patch konfigurasi akan terbuka ke LAN. Docker Desktop di macOS/Windows tidak meneruskan network host ke komputer.

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

# atau lewat environment: shell atau file .env di sebelah docker-compose.yml
echo 'SDR_DOA_ADMIN_PASSWORD=rahasia-anda' >> .env
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
