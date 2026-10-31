# Catatan perubahan

Versi mengikuti `VERSION`. Rilis dibuat oleh CI dari tag `v<VERSION>` (lihat `QUICKSTART.md`, "Rilis di GitHub").

## 3.3.0

Rilis minor: tidak ada yang dihapus. Tablet di tampilan LAN kini bisa menandai spektrum, dan console groundstation punya tombol Mulai ulang dan Matikan. Kanal `3` dan timer update memasang image-nya sendiri. Tombol daya baru aktif setelah langkah host sekali: script `sdr-doa-docker` 3.3.0, `sdr-doa-docker install`, dan `packaging/host-power/install.sh` (lihat poin Docker di bawah).

- **Penanda dari tablet.** Tampilan LAN kini bisa menambah dan menghapus penanda spektrum Receiver groundstation, sementara operator groundstation memperhatikan DoA (keputusan pemilik 2026-10-31). Ini satu-satunya penulisan dari tampilan LAN; tune, gain, pindai, dengar dan pengaturan tetap tertutup.
  - Tombol **Penanda** di dock MIRROR dan di kartu Spektrum rute Receiver tablet. Ketuk grafik untuk menambah penanda, ketuk dekat penanda untuk memilihnya, lalu **Hapus**. Tombol keyboard sama dengan dock groundstation, kecuali panah dan **Tala ke sini**: tablet tidak menala.
  - Penanda masuk daftar **Penanda spektrum** Receiver sendiri, langsung tampil di dock dan halaman Receiver groundstation, dan tersimpan ke marker set yang dipilih di sana. Tanpa login: setiap klien di `allowed_clients` boleh menambah penanda dan menghapus penanda mana pun, termasuk buatan operator. Matikan tampilan LAN atau persempit `allowed_clients` bila itu tidak boleh.
  - Jalurnya: `POST /api/mirror/receiver/markers` di listener LAN (hanya method dan path ini, `Origin` harus halaman tampilan LAN itu sendiri, 512 byte, 4 perintah per detik per tablet, antrean 16, kedaluwarsa 15 detik), lalu halaman console groundstation mengambilnya dari jawaban post mirror-nya, menjalankannya lewat bridge Receiver, dan melaporkan hasilnya. Tablet membaca statusnya di `GET /api/mirror/receiver/markers/<id>`. Setiap perintah tercatat di log console dengan alamat tablet.
  - Menandai dijeda dengan alasannya selama mirror **SUMBER PUTUS** atau `STALE`. Halaman groundstation yang dimuat sebelum update belum menjalankan perintah penanda (perintahnya kedaluwarsa); muat ulang halaman itu sekali setelah update.
- **Heartbeat mirror 500 ms** (sebelumnya 2 detik), supaya perintah penanda diambil cepat juga saat RX berhenti. Post mirror kini juga membawa daftar penanda Receiver (paling banyak 64 terdekat dari tampilan).
- **Mulai ulang dan Matikan PC groundstation dari console.** Bilah atas punya dua tombol setelah EN|ID, hanya di halaman console groundstation sendiri: tablet di tampilan LAN tidak mendapat tombol, `host_power` di `/api/capabilities`, maupun route-nya (`POST` di listener LAN tetap `405 LAN_READ_ONLY`). Klik membuka konfirmasi yang menyebut aksinya, dengan fokus di **Batal** dan Escape untuk batal; konfirmasi memperingatkan bila `/api/health` melaporkan `receiver_busy` (rekaman atau pindai Receiver sedang ditulis). Tanpa admin: keputusan pemilik 2026-10-31.
- **Satu kata, satu direktori.** `POST /api/host/power {action, confirm: true}` hanya dari `Origin` loopback yang sama, body paling besar 256 byte. Console menulis `/run/sdr-doa-host-power/request` berisi tepat `reboot` atau `poweroff`, secara atomik, dan tidak menjalankan apa pun di host. Kode errornya sendiri (`HOST_POWER_*`, di luar daftar kode Kontrol); `503 HOST_POWER_UNAVAILABLE` dengan alasannya bila sisi host belum dipasang.
- **Sisi host baru: `packaging/host-power`** (di tarball console, tidak di image). Aturan tmpfiles.d membuat direktori permintaan untuk uid console, unit `.path` memicu service root oneshot (`PrivateDevices=yes`) yang mengambil permintaan dengan hard link ke direktori milik root sebelum memeriksa atau membacanya, tanpa menunggu (user console tidak bisa menukarnya dengan FIFO atau symlink, menahannya dengan lease, atau membuatnya disalin), hanya menerima dua kata itu, menghapus permintaan sebelum bertindak, menolak permintaan kedua dalam 60 detik pada boot yang sama, mencatat dengan tag `sdr-doa-host-power`, lalu menjalankan `systemctl reboot` atau `systemctl poweroff`. Pasang dengan `sudo sh packaging/host-power/install.sh` (Docker, uid 10001) atau `--console-user <user>` (native); `--helper-dry-run` untuk uji tanpa mematikan PC. Langkahnya di `docs/RUNBOOK_INSTALL_UPDATE.md` 5.5.
- **Docker: satu mount host.** Setiap compose (dan `compose.yml` yang ditulis `sdr-doa-docker`) me-mount `/run/sdr-doa-host-power` ke path yang sama; tetap tanpa socket Docker, D-Bus, capability tambahan, atau port. `sdr-doa-docker update` dan timernya hanya mengganti image dan tidak menulis ulang `compose.yml`, jadi instalasi yang ada tetap tanpa mount setelah update dan tombolnya tampil nonaktif dengan alasan "Direktori permintaan belum di-mount". `update` juga tidak mengganti script `sdr-doa-docker` yang terpasang, dan `install` dari script 3.2.0 itu menulis `compose.yml` tanpa mount. Perbaikannya sekali: pasang dulu script 3.3.0 (`sudo install -m 0755 sdr-doa-docker /usr/local/bin/sdr-doa-docker`), lalu `sudo /usr/local/bin/sdr-doa-docker install --dir /opt/sdr-doa-ground-console`: `.env`, volume `sdr-doa-data` dan timer update tetap, dan `packaging/host-power/install.sh` memperingatkan bila mount itu belum ada. Tanpa sisi host kedua tombol tampil nonaktif dengan alasan "Helper host belum dipasang".

## 3.2.0

Rilis minor: tidak ada yang dihapus. Tampilan LAN kini juga membaca **Rekaman** Receiver, hanya baca, dan mirror Receiver-nya menampilkan gain pindai dan frame pertama mode baru dengan benar. Kanal `3` dan timer update memasangnya sendiri.

- **Rekaman di tablet.** Rute Receiver di tampilan LAN punya tab **Mirror | Rekaman**. Rekaman menampilkan rekaman audio dan pindai groundstation per hari (kalender bertitik, linimasa 24 jam, filter jenis, status, frekuensi dan cari, 50 baris per halaman) atau semua tanggal, memutar audio, menampilkan pratinjau pindai, dan mengunduh satu rekaman per baris (`.webm` atau ZIP pindai). Hapus, ZIP pilihan, Retensi dan Arsip otomatis tetap hanya di groundstation.
- **Ikut terbuka bersama tampilan LAN**, tanpa pengaturan baru: setelah update, setiap klien di `allowed_clients` bisa membaca dan mengunduh rekaman. Matikan tampilan LAN bila rekaman tidak boleh terlihat dari LAN.
- **Hanya route baca yang dibuka** (`GET`, dicocokkan persis dengan UUID rekaman): `archive/facets`, `calendar`, `timeline`, `items`, `scans/<id>/preview`, `audio/<id>/download`, `scans/<id>/download` dan `audio-segments/<id>/audio`. Aturan bacanya sendiri: aturan `Host` tampilan LAN dan `Sec-Fetch-Site` tidak ada, `none` atau `same-origin`. Pengaturan Receiver, set penanda, route pindai mentah, ekspor, hapus, retensi dan setiap penulisan tetap `LAN_READ_ONLY`.
- **Batas beban**, karena setiap bacaan memakai kunci penyimpanan yang sama dengan upload rekaman yang sedang berjalan: satu bacaan daftar per tablet (yang kedua menunggu sampai 5 detik, lalu `429 LAN_RECORDS_BUSY`), paling banyak 50 baris per halaman, 4 unduhan atau pemutaran per tablet, dan satu ZIP pindai untuk seluruh tampilan LAN, terpisah dari dua slot ZIP groundstation. `HEAD` pada unduhan dan pemutaran dijawab `405`, jadi tidak membaca file atau membuat ZIP. Bacaan dari LAN tidak menutup sesi rekaman yang macet; itu tetap terjadi pada bacaan lokal berikutnya.
- **Gain pindai di mirror.** Selama pindai lebar dimulai, berjalan atau berhenti, baris LNA, VGA dan +14 dB di rute Receiver tablet menampilkan gain pindai itu sendiri (`LNA · pindai`), bukan gain RX, dan baris info dock MIRROR di mode Spektrum menampilkannya juga. Halaman groundstation yang dimuat sebelum update belum mengirim gain pindai; mirror tetap berjalan dan baris itu tampil `—` sampai halaman itu dimuat ulang.
- **Frame pertama mode baru tidak lagi hilang di mirror.** Tablet yang dibuka setelah pindai berhenti kini menampilkan trace dan waterfall terakhir pindai itu di bawah SCAN OFF, bukan kanvas kosong, dan frame pertama setelah pindah RX ↔ Spektrum ikut tergambar.

## 3.1.0

Rilis minor: tidak ada yang dihapus. Console kini mengikuti prinsip data di `docs/PRINSIP_DATA.md`: data tetap mengalir, dibaca dengan longgar, diberi label alih-alih ditolak, dan kegagalan tampil dalam bahasa operator. Kanal `3` dan timer update memasangnya sendiri.

### Pembacaan

- **MQTT** (`tools/rdf_node_mqtt_v2.py`):
  - Hanya pesan yang tidak terbaca yang `INVALID`, dengan kodenya: bukan JSON, bukan objek, `sid` kosong atau rusak, `v` lain, terlalu besar, field inti hilang, atau encoding Angular selain `json`.
  - Variasi lain diterima dengan catatan `KODE:field` yang terlihat di Monitor Pesan: angka sebagai teks, boolean `0`/`1`, waktu dalam detik, field opsional yang hilang, QoS atau retain lain, status ACK yang tidak dikenal, bukti Angular yang tidak lengkap, dan penghitung `q` yang mulai ulang.
  - Health, DoA dan Angular di luar jendela waktunya atau tanpa health tetap disimpan sebagai `STALE` atau `INCONSISTENT`. Aturan `LIVE` tidak berubah.
- **Data Out (cadangan)**:
  - status.json cukup punya `timestamp_ms`. Field DAQ yang hilang membuat DAQ `UNKNOWN` (`DAQ_HEALTH_UNKNOWN`), bukan `FAIL`. Overdrive yang tidak dilaporkan di mana pun "tidak diketahui" (`ADC_OVERDRIVE_UNKNOWN`), bukan lolos.
  - CSV dan XML hanya mewajibkan waktu, sudut dan vektor 360 bin. Kolom lain menjadi null.
  - CSV multi-VFO tanpa satu frekuensi XML yang cocok memakai baris VFO 0 (`CSV_VFO_ROW_UNCONFIRMED`).
  - Light read yang gagal tidak menghapus nilai light read baik terakhir selama nilainya masih berlaku (65 detik).

### Tampilan

- **DoA belum valid tetap tampil.** Ini berlaku untuk DoA ok=0, rekaman basi, node macet, dan DAQ yang tidak diketahui.
  - Di HUD, bearing terakhirnya redup dengan label **BELUM VALID** atau **BASI N dtk**.
  - Di peta, garisnya putus-putus abu-abu berlabel BELUM VALID.
  - Konflik CSV/XML, DAQ gagal, dan ADC overdrive tetap disembunyikan.
- **Data Out tanpa doa.xml** menggambar tampilan CSV saja dengan status DoA `PARTIAL` dan label **SEBAGIAN**.
- **Kurva polar** terakhir tetap tampil redup dengan "Belum ada update · terakhir HH.MM.SS".
- **Chip Publikasi** berisi **PERLU DISIAPKAN** bila yang menahan hanya pengaturan, atau **ADA MASALAH** bila datanya bermasalah. Klik chip untuk membuka checklist alasan dan pemeriksaan gate.
- **DoA Diagnostics** menulis "Sumber: MQTT · Data Out (cadangan) tidak dipakai" di kartu DoA MQTT.
- **Banner REFERENSI kompas** di peta menyebut penyebabnya dan punya tombol ke Konfigurasi → GPS & Kompas.

### Kontrol

- **Revisi berubah tidak lagi mengunci Kontrol.** Ini berlaku untuk `CONFIG_REVISION_STALE`, `CONFIG_REVISION_UNKNOWN`, `state.cfg` yang berubah saat meninjau, dan `CONFIG_REVISION_CONFLICT` dari RDF-SDR. Console meminta settings, membaca ulang nilai, dan menampilkan lagi perubahan yang sama di revisi baru. Satu kali Kirim mengonfirmasinya.
- **`config.get` dikirim sendiri** sekali per sesi dan revisi RDF-SDR, juga saat `state.cfg` belum ada.
- **`remote_config_patch false`**: Kirim tetap bisa dipakai setelah peringatan dan konfirmasi kedua.
- **Hasil ACK dalam bahasa operator** (Diterapkan, Tersimpan belum terbukti, Hasil tidak diketahui, Ditolak RDF-SDR, ...), dengan kode mentahnya di baris "Kode: …".
  - `OSERROR`, `FILENOTFOUNDERROR`, `PERMISSIONERROR` dan `TIMEOUTEXPIRED` menyebut helper settings di RDF-SDR sebagai penyebab yang mungkin.
  - `CONNECTION_LOST` menyebut link yang putus.
- **Tidak berubah**: login admin, tinjauan, batas nilai, expiry 15 detik, bind `127.0.0.1`, dan mode LAN lihat-saja.

### Dokumen

- `docs/PRINSIP_DATA.md` (baru).
- Aturan validasi di `docs/MQTT_KONTRAK.md` bagian 3.
- `QUICKSTART.md`.
- Runbook bagian 7.4: langkah sekali untuk merapikan groundstation lama, yaitu mode LAN lihat-saja menggantikan forward `socat`, Data Out langsung ke IP RDF-SDR, kanal `3` dengan auto-update, dan hapus retained `sdr/v2/uav-01/config/reported` yang basi.

### Pindah ke 3.1.0

Update biasa:
- Docker: `sudo /usr/local/bin/sdr-doa-docker update --dir /opt/sdr-doa-ground-console`, atau tunggu timer harian.
- Native: `sdr-doa-console update`.

Data, pengaturan, dan kata sandi tetap. Groundstation yang masih memakai forward sementara: jalankan runbook 7.4 setelah update.

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
