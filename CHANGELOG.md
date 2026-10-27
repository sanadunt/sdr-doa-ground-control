# Catatan perubahan

Versi mengikuti `VERSION`. Rilis dibuat oleh CI dari tag `v<VERSION>` (lihat `QUICKSTART.md`, "Rilis di GitHub").

## 3.0.0

Rilis mayor karena fitur dihapus: sistem kini memakai satu MQTT, yaitu kontrak RDF Node edge (keputusan di `docs/KEPUTUSAN_MQTT.md`, kontrak di `docs/MQTT_KONTRAK.md`). Kanal update `2` tidak memasang rilis ini sendiri; cara pindah ada di bagian terakhir.

### Yang berubah

- **Satu MQTT.** Console hanya berlangganan topik RDF Node di root `sdr/v2/uav-01`. Dashboard, peta, polar, DoA, dan health memakai MQTT; Data Out (cadangan) di HTTP port 8081 hanya dibaca saat MQTT tidak segar (8 detik setelah `telemetry/health` terakhir yang `daq=1`), dan UI menampilkan sumber datanya (#7, #8).
- **Kontrol** mengirim `config.get` dan `config.patch` dengan envelope edge ke `sdr/v2/uav-01/cmd/config/get|patch` (QoS 1, tidak retained) dan membaca `ack/config` serta `settings/reported` (#9).
- **Baca settings tanpa TLS.** RDF Node commit `35984d8` (PR `sanadunt/rdf-indicator-raspberry#5`) menjawab `config.get` lewat broker utama juga bila koneksinya tanpa TLS (PPP/T900 privat), jadi nilai Kontrol datang dari `settings/reported` lewat MQTT. RDF Node `8691ad0` yang terpasang sekarang tetap menolaknya dengan `TLS_REQUIRED_FOR_SETTINGS_REPORT`, dan Kontrol memakai Data Out (cadangan); pesan Kontrol untuk kode itu kini menyebut kedua kasus (broker cadangan, atau RDF-SDR versi lama). Fixture perintah kini per commit edge (`commands.8691ad0.json`, `commands.35984d8.json`), ditambah `compat.35984d8.json` (#9).
- **`GET /api/mqtt` adalah status MQTT tunggal**: broker, transport, koneksi, `node_id`, `root` (`sdr/v2/uav-01`) dan jumlah pesan semua topik RDF Node yang dilanggan (`received`, `valid`, `invalid`, `cleared`, `last_received_at_ms`, `last_age_ms`), sama dengan hitungan `GET /api/mqtt/rdf-node`. Field per jenis pesan topik lama (`last_by_kind`, `kind_counts`, `topic_counts`, `last_topic`, `total_bytes`, `last_latency_ms`) tidak ada lagi.
- **Monitor Pesan** tanpa sakelar keluarga topik: langsung menampilkan state node, ACK, dan status tiap topik RDF Node, dengan kartu Koneksi (broker, transport, root topik, mode publish).
- **Konfigurasi**: kartu MQTT menampilkan jumlah pesan MQTT dan umur pesan terakhir. Kartu itu dan kartu di System Health kini berjudul "MQTT".
- **`sdr-doa-docker`**: kanal default `3`, hanya untuk console. `SDR_DOA_AGENT_SETTLE` menjadi `SDR_DOA_SETTLE` (detik yang harus dilewati image tanpa healthcheck). Instalasi agent yang ditulis versi 2 disebut dengan jelas dan tidak dikelola lagi.
- **CI** menguji monitor lewat broker sungguhan (`tools/test_rdf_node_broker.py`, mosquitto loopback) dengan payload buatan kode edge di `tools/fixtures/rdf-node`.

### Yang dihapus

- Monitor dan kontrak topik lama `sdr/v1/uav-01`: `tools/sdr_doa_mqtt.py` dan bagian topik lama di `tools/sdr_doa_mqtt_monitor.py`. Koneksi paho bersama tetap, dipakai topik RDF Node dan Kontrol.
- Agent RDF-SDR bawaan repo, yang tidak terpasang di Raspberry: `tools/sdr_doa_lan_agent.py`, klien MQTT stdlib `tools/sdr_doa_mqtt_stdlib.py`, `packaging/agent/`, `Dockerfile.agent`, `docker-compose.agent.yml`, `deploy/sdr-doa-lan-agent.service.example`, `deploy/mosquitto-sdr-doa-lan.acl.example`, dan broker staging TLS-nya `tools/mqtt_lan_stage.conf`. Raspberry menjalankan RDF Node edge dari repo `sanadunt/rdf-indicator-raspberry`.
- Aset rilis `sdr-doa-rdf-sdr-agent-<V>.tar.gz` dan image `ghcr.io/sanadunt/sdr-doa-rdf-sdr-agent`. Rilis kini berisi `sdr-doa-ground-console-<V>-linux.tar.gz`, `sdr-doa-docker`, dan `SHA256SUMS`; tag image agent 2.x yang sudah ada tidak diperbarui lagi.
- Opsi `sdr-doa-docker install --agent`, `--enable-config`, `--disable-config`, `--share-dir`, dan `--user` (ditolak dengan pesan).
- Penerbit sintetis `tools/synthetic_mqtt_publisher.py` dan test topik lama; test memakai fixture kontrak edge.

### Pindah ke 3.0.0

Data di direktori data (Docker: volume `sdr-doa-data`; native: `~/.local/share/sdr-doa-ground-console`) tetap, termasuk `console.json` dengan pengaturan broker MQTT, Rekaman Receiver, dan kata sandi admin. Sebelum pindah, pastikan `curl -s --noproxy '*' http://127.0.0.1:8787/api/health` berisi `"receiver_busy": false` (update me-restart console sekali).

**Console Docker (`sdr-doa-docker`).** Kanal `2` tidak pernah pindah ke 3.x, dan `sdr-doa-docker` 2 tidak meng-update dirinya. Ambil `sdr-doa-docker` dari rilis 3.0.0, lalu jalankan `install` dengan kanal baru (runbook `docs/RUNBOOK_INSTALL_UPDATE.md` bagian 7.1, langkah unduh di 5.1 dan A1):

```sh
sudo sh sdr-doa-docker install --channel 3 --dir /opt/sdr-doa-ground-console
```

`install` mempertahankan `.env` (hanya kanal yang berubah), memasang `/usr/local/bin/sdr-doa-docker` versi 3, mem-pull `ghcr.io/sanadunt/sdr-doa-ground-console:3`, dan menunggu healthy. Timer harian yang sudah ada tetap jalan dan sejak itu mengikuti kanal `3`.

**Console native (`sdr-doa-console`).** Updater native tetap di dalam satu versi mayor: `sdr-doa-console update --check` dan timer harian (`update --auto`) hanya melaporkan `2.x is installed; 3.0.0 changes the major version ...` dan tidak memasang apa pun. Setelah membaca catatan ini:

```sh
sdr-doa-console update --allow-major          # bertanya dulu; tanpa terminal tambahkan --yes
```

Sesudahnya timer harian mengikuti rilis 3.x.

**Instalasi agent RDF-SDR dari versi 2.** Console 3 tidak mengelolanya lagi. Hentikan supaya tidak ada dua penerbit di broker: instalasi Docker dengan `cd /opt/sdr-doa-agent && sudo docker compose down` (`sdr-doa-docker` 3 menolak direktori itu dan menyebut perintah ini), instalasi native dengan uninstaller dari tarball agent 2.x (`sudo sh /opt/sdr-doa-agent/uninstall.sh`).

**Broker.** Console membaca topik `sdr/v2/uav-01/...` yang dikirim RDF Node edge. Pakai broker groundstation yang dipakai edge, lewat listener yang menerima console tanpa TLS dan kredensial (lihat `QUICKSTART.md`, bagian MQTT); tidak ada pengaturan baru di Konfigurasi.
