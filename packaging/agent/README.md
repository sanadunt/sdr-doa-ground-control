# SDR-DoA edge agent di RDF-SDR (Raspberry)

Agent membaca Data Out KrakenSDR di Raspberry (`http://127.0.0.1:8081`), lalu publish `health`, `state` dan `config_reported` ke MQTT (`sdr/v1/uav-01/...`). Kontrol di Ground Console butuh agent ini: tanpa `config_reported` rev dasar tidak diketahui dan tombol Kirim nonaktif. Agent hanya memakai standard library Python, jadi tidak perlu `pip`.

Ada dua cara memasang. Keduanya jalan di background, mulai saat boot, dan restart sendiri bila gagal.

## Native (systemd)

```sh
tar -xzf sdr-doa-rdf-sdr-agent-2.0.0.tar.gz
cd sdr-doa-rdf-sdr-agent-2.0.0
sudo sh install.sh                    # lihat dulu: sudo sh install.sh --dry-run
```

Dari repository: `sudo sh packaging/agent/install-agent.sh`.

Yang dipasang:

```text
/opt/sdr-doa-agent/                       program, venv (tanpa pip), bin/run-agent, uninstall.sh
/etc/sdr-doa-agent/agent.env              pengaturan (root:<grup service>, 0640)
/var/lib/sdr-doa-agent/                   state agent (revisi konfigurasi)
/etc/systemd/system/sdr-doa-agent.service service, enabled
```

User service secara default adalah pemilik `settings.json` KrakenSDR, lalu `doasdr` bila ada, selain itu user sistem baru `sdr-doa-agent`. Dengan `--enable-config` user itu harus bisa menulis `settings.json`.

Pengaturan ada di `/etc/sdr-doa-agent/agent.env` (contoh lengkap: `packaging/agent/agent.env.example`):

| Variabel | Default | Arti |
|---|---|---|
| `BASE_URL` | `http://127.0.0.1:8081` | Data Out KrakenSDR |
| `MQTT_HOST`, `MQTT_PORT` | `127.0.0.1`, `1883` | broker; agent memakai MQTT 3.1.1 lewat TCP, bukan WebSocket |
| `MQTT_TLS`, `MQTT_CAFILE`, `MQTT_USERNAME`, `SDR_DOA_MQTT_PASSWORD` | kosong | broker non-loopback wajib TLS dan username |
| `PUBLISH` | `1` | `0` = tanpa MQTT |
| `ENABLE_CONFIG` | `0` | `1` = terapkan patch dari Kontrol ke `SETTINGS_PATH`; `0` = jawab `REMOTE_CONTROL_DISABLED` |
| `SETTINGS_PATH` | `/home/doasdr/doasdr/_share/settings.json` | settings KrakenSDR |
| `STATE_DIR` | `/var/lib/sdr-doa-agent` | state agent |
| `CLOCK_SOURCE`, `AUTHORITY`, `HEALTH_INTERVAL`, `DOA_RATE`, `STATE_INTERVAL`, `POLL_INTERVAL`, `COLLECT_BUDGET` | kosong = default agent | tuning |

Setelah mengubah: `sudo systemctl restart sdr-doa-agent`. Opsi installer (`--mqtt-host`, `--mqtt-port`, `--enable-config`, `--settings-path`, `--user`, `--set NAMA=NILAI` untuk variabel lain seperti `--set DOA_RATE=0`; lihat `--help`) menulis variabel yang sama. Kata sandi broker tidak diberikan sebagai opsi: isi `SDR_DOA_MQTT_PASSWORD` dengan `sudoedit /etc/sdr-doa-agent/agent.env` lalu restart, atau ekspor variabel itu sebelum installer dan jalankan `sudo --preserve-env=SDR_DOA_MQTT_PASSWORD sh install.sh --mqtt-username NAMA ...`, supaya tidak muncul di command line. Menjalankan installer lagi (upgrade) mempertahankan `agent.env` dan state; hanya opsi yang diberikan yang berubah.

```sh
systemctl status sdr-doa-agent
journalctl -u sdr-doa-agent -f
sudo sh /opt/sdr-doa-agent/uninstall.sh            # agent.env dan state tetap
sudo sh /opt/sdr-doa-agent/uninstall.sh --purge    # hapus juga
```

`ENABLE_CONFIG=1` berarti Kontrol di ground bisa mengubah `settings.json` KrakenSDR. Aktifkan hanya di broker dan jaringan yang dipercaya; console publish tanpa TLS atau password. Ubah dengan `sudo sh install.sh --enable-config` (atau `--disable-config`), bukan hanya lewat `agent.env`: service hanya boleh menulis direktori `settings.json` bila installer dijalankan dengan config aktif. Bila `ENABLE_CONFIG=1` tetapi user service tidak bisa menulis `settings.json`, agent berhenti dengan pesan di `journalctl -u sdr-doa-agent` (exit 78) dan tidak di-restart terus-menerus. Console dan agent harus memakai broker yang sama (atau bridge yang meneruskan `sdr/v1/uav-01/#`).

## Docker

```sh
cp packaging/agent/agent.env.example agent.env     # lalu edit
docker compose up -d --build                       # rilis agent
docker compose -f docker-compose.agent.yml up -d --build   # repository
docker compose logs -f agent
```

Butuh Docker Compose v2.24 atau lebih baru (`env_file` dengan `required: false`). Container memakai network host supaya `127.0.0.1` adalah Raspberry itu sendiri (Data Out port 8081 dan broker lokal), dan `restart: unless-stopped` menyalakannya lagi bersama Docker saat boot. State ada di volume `agent-state`. Untuk `ENABLE_CONFIG=1`, mount direktori `_share` KrakenSDR ke `/krakensdr/_share` dan jalankan container sebagai pemiliknya; contohnya ada sebagai komentar di compose file.

`Dockerfile.agent` tidak punya langkah `RUN`, jadi image arm64/armv7 bisa di-build di Raspberry itu sendiri dalam beberapa detik, atau di komputer lain tanpa emulasi:

```sh
# satu platform, lalu kirim ke Raspberry
docker buildx build --platform linux/arm64 -f Dockerfile.agent -t sdr-doa-agent:2.0.0 --load .
docker save sdr-doa-agent:2.0.0 | ssh doasdr@doasdr docker load
# beberapa platform sekaligus butuh builder buildx dan registry
docker buildx create --use
docker buildx build --platform linux/arm64,linux/arm/v7 -f Dockerfile.agent -t REGISTRY/sdr-doa-agent:2.0.0 --push .
```

Pakai `linux/arm/v7` untuk Raspberry Pi OS 32-bit dan `linux/arm64` untuk 64-bit (`uname -m`: `armv7l` atau `aarch64`).
