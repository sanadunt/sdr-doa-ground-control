# Runbook instalasi dan update: SDR-DoA Ground Console dan agent RDF-SDR

Runbook ini memasang dan meng-update dua program di host baru:

- **SDR-DoA Ground Console** di komputer ground station (Linux): lewat Docker dari image GHCR, atau native dari rilis tar dengan `install.sh` dan systemd user service.
- **Agent RDF-SDR** (edge agent) di Raspberry yang menjalankan KrakenSDR: lewat Docker dari image GHCR, atau native dengan systemd service.

Ditulis untuk dijalankan langkah demi langkah oleh AI agent yang punya shell di host itu, dan tetap bisa dibaca manusia.

| | |
|---|---|
| Diperiksa terhadap | rilis `v2.0.0` (terbit 2026-10-20), commit `main` 773d5fb |
| Rilis berikutnya | perintahnya sama; hanya nomor versi di nama tarball yang berubah (lihat langkah 5.1) |
| URL tetap file ini | `https://raw.githubusercontent.com/sanadunt/sdr-doa-ground-control/main/docs/RUNBOOK_INSTALL_UPDATE.md` (berlaku setelah file ini masuk `main`; sebelum itu pakai salinan yang diberikan manusia) |
| Repository | `https://github.com/sanadunt/sdr-doa-ground-control` (publik, tanpa login) |

Konvensi:

- Teks di dalam `kode` ditulis persis seperti dipakai program: perintah, flag, path, pesan.
- Nilai bertanda **(contoh)** harus diganti dengan nilai dari manusia (bagian 2).
- Setiap langkah punya **Periksa**. Jangan lanjut ke langkah berikutnya sebelum hasilnya sesuai.
- `sudo` dipakai di instalasi Docker di `/opt` dan agent native. Console native dipasang **tanpa** root.
- Setelah instalasi, script Docker dipanggil dengan path lengkap `/usr/local/bin/sdr-doa-docker`, karena `secure_path` milik `sudo` di sebagian distro (misalnya RHEL/Fedora) tidak memuat `/usr/local/bin`.

---

## 1. Aturan untuk agent

### 1.1 Dilarang

1. Membuat console bisa dijangkau dari jaringan dengan cara apa pun selain mode LAN lihat-saja (6.2). Console hanya bind `127.0.0.1`. Jangan pakai `--bind 0.0.0.0` atau alamat non-loopback, jangan pasang reverse proxy, `socat`, atau port-forward yang membuka port console ke LAN; forward `socat 0.0.0.0:8788 → 127.0.0.1:8787` yang lama diganti mode 6.2. Mode LAN lihat-saja adalah satu-satunya pengecualian: listener kedua di proses console, mati secara default, yang hanya melayani halaman baca-saja ke alamat klien yang diizinkan. Menyalakannya keputusan manusia, dilakukan manusia sendiri di halaman Konfigurasi dengan sesi admin.
2. Mengubah Docker console ke network bridge, menambah `ports:`, atau mengedit `compose.yml` yang ditulis `sdr-doa-docker` (`install` menulisnya ulang). Semua compose memakai `network_mode: host`.
3. Menjalankan `install.sh` console sebagai root. Installer menolak (`run install.sh as the desktop user, not root; the console runs as a user service`). Jangan akali dengan `sudo -u` tanpa sesi login user itu.
4. Menaruh kata sandi admin atau kata sandi MQTT di command line, di riwayat shell, di log, atau di pesan chat. Jadi **jangan** pakai `install.sh --password NILAI`, `echo "SDR_DOA_ADMIN_PASSWORD=..."`, atau `export SDR_DOA_MQTT_PASSWORD=...`. Jangan `cat` file `.env`, `agent.env`, atau variabel proxy yang mungkin memuat kredensial. Jangan juga jalankan perintah yang mencetak environment container atau compose yang sudah diinterpolasi: `docker inspect` tanpa `--format` yang memilih field tertentu (bukan `.Config.Env`), `docker compose config`, `docker compose exec ... env`/`printenv`, `cat /proc/*/environ`. Di agent Docker, `SDR_DOA_MQTT_PASSWORD` ada di environment container; di console Docker, `SDR_DOA_ADMIN_PASSWORD` juga ada di sana bila ditaruh di `DIR/.env` (misalnya setelah 5.6 E1).
5. Meng-commit, mengunggah, atau menyalin `.env` / `agent.env` ke tempat lain selain yang disebut runbook ini.
6. Menghapus data tanpa konfirmasi eksplisit manusia untuk perintah itu: `sdr-doa-console uninstall --purge`, `uninstall.sh --purge`, `docker compose down -v`, `docker volume rm`, menghapus direktori data atau `/data/console.json`.
7. Mengaktifkan remote config di Raspberry tanpa keputusan manusia: `--enable-config`/`ENABLE_CONFIG=1` di agent bawaan repo ini (patch di topik lama `sdr/v1/uav-01/cmd/config/patch` lalu bisa mengubah `settings.json` KrakenSDR), atau gate RDF Node (`sudo rdf-node controls approve --settings` dan sejenisnya, di luar repository ini), yang membuat Kontrol console bisa mengubah `settings.json` lewat `sdr/v2/uav-01/cmd/config/patch`.
8. Memakai opsi yang melewati pengaman tanpa persetujuan manusia: `--force`, `--allow-major`, `--yes` saat Receiver sedang merekam, `install --channel` ke versi lain, `rollback`.
9. Menjalankan dua console di port yang sama, atau agent native dan agent Docker bersamaan (keduanya akan publish dan menjawab patch).
10. Memberi `--base-url` atau `--mqtt-*` ke service, unit, atau entrypoint. Flag itu menimpa pengaturan tersimpan setiap start.
11. Mengisi `SDR_DOA_UPDATE_API`, `SDR_DOA_UPDATE_REPO`, `SDR_DOA_ROOT_UID` (khusus test), atau mematikan verifikasi TLS.
12. Mematikan proses dengan `pkill`/`killall`. Hentikan service lewat perintahnya (`sdr-doa-console stop`, `docker compose stop`, `systemctl stop`).

### 1.2 Berhenti dan tanya manusia bila

- Input di bagian 2 belum lengkap, atau nilainya di luar yang diterima kode (misalnya host base URL Data Out tidak ada di daftar host Data Out (cadangan) yang dipilih manusia, atau port selain 8081).
- Preflight (bagian 4) gagal: arsitektur tidak didukung, Docker atau plugin `docker compose` (v2 atau lebih baru) tidak ada, Python < 3.9, disk tidak cukup, port 8787 dipakai, akses HTTPS ke GitHub/GHCR tertutup.
- `sudo -n true` gagal (sudo butuh kata sandi) untuk Jalur A, C atau D (4.9). Jangan pernah meminta, menerima, atau mengetik kata sandi sudo.
- Perlu memasang paket sistem (Docker Engine, `python3-venv`) atau mengubah proxy Docker daemon.
- Langkah A0/B0/C0/D0 menemukan instalasi yang sudah ada, padahal manusia meminta instalasi baru. Lanjut ke bagian 7 (update) atau 5.6 (migrasi) hanya bila manusia meminta update atau migrasi. Jangan memasang ulang di atas instalasi yang ada.
- Sebuah perintah keluar dengan kode bukan 0, kecuali langkah itu sendiri menyebut hasil itu sebagai yang diharapkan (4.5 `rc=7`, 5.6 E2 `rc=64`, 6.2 `rc=7` atau `rc=28` dari komputer lain, baris `test`/`grep -c` yang mencetak hasil sendiri, B5 tanpa systemd user session: exit 1 dengan baris cron); atau output berisi `FAILED`, `error:`, `rollback FAILED`, `not updated`.
- Kata sandi harus dimasukkan (bagian 5.2 A4, 5.3 B3, 5.4 C4, 5.5 D4).
- `/api/health` melaporkan `"receiver_busy": true` sebelum update manual.

Saat berhenti, laporkan: perintah yang dijalankan, kode keluar, 20 baris terakhir output (tanpa rahasia), dan langkah runbook-nya.

### 1.3 Cara kerja

- Satu langkah, lalu periksa. Kode keluar 0 saja belum cukup; cocokkan juga output yang disebut di **Periksa**.
- Jalankan setiap blok kode dalam satu panggilan shell, dari baris pertama sampai terakhir. Jangan anggap `cd` atau variabel (`V`, `F`, `OLD`, `U`) dari blok sebelumnya masih berlaku: blok yang membutuhkannya mengisinya sendiri. Versi rilis yang dipasang dibaca dari `~/sdr-doa-dl/release-version` (ditulis di 5.1).
- Unduhan masuk direktori baru yang kosong. Jangan jalankan isi unduhan sebelum `sha256sum -c` berhasil.
- Perintah panjang: `sdr-doa-docker install|update|rollback` (pull, lalu menunggu healthy sampai 180 detik), `install.sh` console (pip), dan `sdr-doa-console update` (install.sh sampai 30 menit, lalu 60 detik menunggu health). Beri batas waktu perintah minimal 20 menit (update native: 45 menit) dan jangan hentikan di tengah jalan: SIGKILL di tengah update meninggalkan `app.previous` (native, update berikutnya lalu menolak dengan `... is left from an interrupted update ...`) atau container setengah diganti (Docker). Bila shell Anda memotong perintah lebih cepat, jalankan perintah itu di latar dan pantau file output-nya:

  ```sh
  nohup setsid sh -c 'PERINTAH; echo "rc=$?"' >~/sdr-doa-dl/run.log 2>&1 </dev/null &
  tail -n 20 ~/sdr-doa-dl/run.log      # ulangi sampai ada baris rc=
  ```

  `PERINTAH` adalah blok runbook persis, termasuk `cd` dan `sudo`-nya (tanpa kutip tunggal di dalamnya; `sudo` di sini butuh `sudo ok` dari 4.9). Update juga bisa lewat timer yang sudah aktif: Docker `sudo systemctl start --no-block sdr-doa-docker-update.service` (sama dengan `update --auto`; pantau `sudo tail -n 20 DIR/update.log` sampai `systemctl is-active sdr-doa-docker-update.service` bukan `activating`), native `systemctl --user start --no-block sdr-doa-console-update.service` (pantau `journalctl --user -u sdr-doa-console-update -n 30 --no-pager`).
- Bila 4.9 menunjukkan `id -u` = `0` (shell root), Jalur A, C dan D tidak butuh `sudo ok`, dan awalan `sudo` boleh dibuang (wajib dibuang bila `sudo` tidak terpasang). Jalur B tetap butuh shell user biasa (2.2).
- Shell agent biasanya tanpa terminal (TTY). Pengaruhnya: `sdr-doa-docker update` tanpa TTY **tidak bertanya** dan langsung memasang image yang lebih lama atau yang pernah gagal; `sdr-doa-console update` tanpa TTY berhenti dengan `there is no terminal to ask; confirm with --yes`. Karena itu runbook ini memakai `--check` dulu, lalu `--auto` (lihat bagian 7).
- Untuk `curl` ke console lokal selalu pakai `--noproxy '*'`, supaya permintaan ke `127.0.0.1` tidak lewat proxy.
- Di akhir, beri manusia laporan singkat (bagian 8.5).

---

## 2. Input yang harus ditanyakan ke manusia

Tanyakan semua yang relevan sebelum mulai. Kolom "Default" adalah nilai dari kode bila tidak diisi.

### 2.1 Umum

| Input | Pilihan / format | Default | Catatan |
|---|---|---|---|
| Peran host ini | `console` (ground station) atau `rdf-sdr` (Raspberry) | — | Satu peran per host di runbook ini. |
| Cara pasang | `docker` atau `native` | — | Docker disarankan untuk console (update dengan healthcheck dan rollback). |
| Update otomatis | ya / tidak | tidak | Docker: timer harian, default `03:30`. Native console: default `03:45`. Jam di zona waktu host (4.1), ditambah acak sampai 15 menit. Bila zona host bukan zona manusia (misalnya `UTC` vs WIB), konversikan jam pilihan manusia dan sebutkan keduanya di laporan 8.5. |
| Jam update otomatis | `HH:MM` (24 jam) | lihat di atas | |
| Kanal image (Docker) | `2`, `2.0`, `2.0.0`, `latest` | `2` | `2` = setiap rilis 2.x.y. `latest` ikut versi mayor baru juga. |
| Proxy keluar | ada / tidak | tidak | Bila ada: siapa yang mengatur proxy Docker daemon dan service user. |

### 2.2 Console (peran `console`)

| Input | Format yang diterima kode | Default | Catatan |
|---|---|---|---|
| User Linux console native (Jalur B) | nama user biasa yang memakai browser di host ini | — | Agent butuh shell login langsung sebagai user ini (SSH sebagai user itu). Bila agent hanya punya shell root: berhenti dan minta akses SSH sebagai user itu. |
| Port console | 1–65535 | `8787` | Selalu di `127.0.0.1`. Mode LAN lihat-saja (6.2) memakai port lain. |
| Kata sandi admin | 1 baris, maks. 256 karakter | `123456` (diberi peringatan) | **Manusia sendiri** yang mengetiknya (A4/B3). Membuka branding dan Kontrol. |
| Host Data Out (cadangan) | daftar 1–16 host, dipisah koma: nama DNS (huruf kecil, huruf/angka/`-`) atau IPv4/IPv6; tanpa skema, port, path, atau wildcard; bukan IPv4-mapped `::ffff:…` (pakai alamat IPv4-nya) | `doasdr.local,192.168.100.100,127.0.0.1,localhost` | Disimpan di `console.json` (`data_out_hosts`), diubah di Konfigurasi → Koneksi & refresh. Start pertama: `SDR_DOA_SEED_DATA_OUT_HOSTS` (Jalur A, di `.env`) atau `--data-out-hosts` (Jalur B). Wajib memuat host base URL. |
| Data Out base URL | `http://<host>:8081` dengan `<host>` dari daftar host Data Out | `http://doasdr.local:8081` | Host di luar daftar ditolak dengan pesan yang menyebut daftar host dan port 8081. Host baru (misalnya `rdf.local`): masukkan juga ke daftar host. Jalur A: nama `.local` dicoba lewat resolver sistem container, lalu lewat satu query mDNS dari console sendiri (container tidak punya nss-mdns); bila keduanya gagal, pakai IP (`http://192.168.100.100:8081`). Periksa di 8.1 langkah 6. |
| MQTT host | literal IPv4/IPv6 atau `localhost` (bukan nama DNS) | `10.90.0.1` | Console tidak punya TLS atau username/password MQTT. |
| MQTT port | 1–65535 | `9001` | |
| MQTT transport | `websockets` atau `tcp` | `websockets` | |
| MQTT WebSocket path | diawali `/`, huruf, angka, `._~/-` | `/mqtt` | Hanya untuk `websockets`. |
| Interval refresh | `0` (manual), `1`, `2`, `5`, `10`, `30` detik | `2` | |
| Akses UI dari komputer lain? | tidak / SSH tunnel / LAN lihat-saja | — | SSH tunnel (6.1): console penuh di browser komputer itu. LAN lihat-saja (6.2): tablet atau komputer di LAN hanya melihat. |
| Mode LAN lihat-saja (bila dipilih) | port 1024–65535, bukan port console; bind `0.0.0.0`, `::` atau IP antarmuka LAN host ini; klien yang diizinkan: alamat atau jaringan IPv4/IPv6, maks. 32, tidak lebih luas dari /16 (IPv4) atau /48 (IPv6), bukan loopback | mati; port `8788`, bind `0.0.0.0`, klien kosong (tidak ada yang diizinkan) | Butuh kata sandi admin sendiri (A4/B3). **Manusia sendiri** yang menyalakannya (6.2). Tanyakan juga alamat LAN host console dan siapa yang mengatur firewall. |
| Basemap online? | ya / tidak | — | Butuh HTTPS ke host tile (4.6). |

Nilai koneksi (Data Out, MQTT, refresh) hanya dipakai saat start pertama. Setelah itu diubah di halaman **Konfigurasi** di UI.

### 2.3 Agent (peran `rdf-sdr`)

| Input | Variabel `agent.env` / flag | Default | Catatan |
|---|---|---|---|
| Data Out di Raspberry | `BASE_URL` / `--base-url` | `http://127.0.0.1:8081` | |
| Broker MQTT | `MQTT_HOST`, `MQTT_PORT` / `--mqtt-host`, `--mqtt-port` | `127.0.0.1`, `1883` | Agent memakai MQTT 3.1.1 lewat **TCP**, bukan WebSocket. Console dan agent harus memakai broker yang sama (atau bridge `sdr/v1/uav-01/#`). |
| TLS dan username | `MQTT_TLS`, `MQTT_CAFILE`, `MQTT_USERNAME` / `--mqtt-tls`, `--mqtt-cafile`, `--mqtt-username` | kosong | Broker di luar loopback **wajib** TLS dan username. Docker (Jalur C): hanya `MQTT_TLS=1` dengan CA publik dari store sistem image; file `MQTT_CAFILE` (CA privat) di host tidak bisa dibaca container. Untuk CA privat pakai Jalur D, atau berhenti dan tanya. |
| Kata sandi MQTT | `SDR_DOA_MQTT_PASSWORD` | kosong | **Manusia sendiri** yang mengisinya (C4/D4). |
| Remote config | `ENABLE_CONFIG` / `--enable-config`, `--disable-config` | `0` (patch dijawab `REMOTE_CONTROL_DISABLED`) | Keputusan manusia (aturan 1.1.7). |
| `settings.json` KrakenSDR | `SETTINGS_PATH` / `--settings-path` | `/home/doasdr/doasdr/_share/settings.json` | Docker memakai direktori `_share`: `--share-dir`, default `/home/doasdr/doasdr/_share`. |
| User service | `--user` | native: pemilik `settings.json`, lalu `doasdr`, lalu user baru `sdr-doa-agent`; Docker: pemilik `--share-dir` | Tidak boleh root. |
| Publish MQTT | `PUBLISH` / `--no-publish` | `1` | Telemetry agent bawaan di topik lama. Kontrol tidak memakai agent ini; yang menjawab Kontrol adalah RDF Node di RDF-SDR. |

Broker MQTT itu sendiri (misalnya mosquitto dengan listener TCP untuk agent dan WebSocket untuk console) tidak dipasang oleh repository ini. Tanyakan ke manusia di mana broker berjalan dan apakah ia menerima console tanpa TLS dan tanpa password.

Untuk Kontrol, broker juga harus (keputusan manusia, di luar repository ini):

- mengizinkan console (anonim, tanpa TLS) publish ke `sdr/v2/uav-01/cmd/config/patch` dan `sdr/v2/uav-01/cmd/config/get`;
- punya listener TLS untuk koneksi RDF Node dari Raspberry. RDF Node mengirim `settings/reported` (jawaban `config.get`) hanya lewat koneksi TLS-nya sendiri ke broker; tanpa itu jawabannya `TLS_REQUIRED_FOR_SETTINGS_REPORT`, Kontrol memakai nilai Data Out (cadangan), dan patch tetap bisa dikirim. Console tetap memakai listener biasa.

`rdf-ground.service` (RDF Node di groundstation) juga bisa mengirim perintah ke RDF-SDR. RDF-SDR mengerjakan satu perubahan sekaligus (`BUSY`), dan perubahan dari pengirim lain membuat rev dasar Kontrol usang. Tanyakan ke manusia siapa pengendalinya: satu console dengan Kontrol terbuka, atau `rdf-ground.service`, tidak keduanya sekaligus.

---

## 3. Pohon keputusan

```text
Peran host?
├── console (ground station, Linux)
│   ├── Docker Engine + plugin compose (v2+) ada, server linux/amd64 atau linux/arm64?
│   │   └── ya ──> Jalur A: console Docker dari GHCR (disarankan)        [5.2]
│   └── tidak, atau server linux/arm (armv7), atau manusia memilih native
│       └── Python 3.9+ dengan venv, systemd user session?
│           └── ya ──> Jalur B: console native (tarball + install.sh)    [5.3]
│
└── rdf-sdr (Raspberry dengan KrakenSDR)
    ├── Docker Engine + plugin compose (v2+) ada? (linux/amd64, arm64, arm)
    │   └── ya ──> Jalur C: agent Docker dari GHCR                       [5.4]
    └── tidak, atau manusia memilih native
        └── Python 3.9+, systemd? ──> Jalur D: agent native (install.sh) [5.5]

Sudah ada instalasi lama?
├── console Docker dari compose manual (build lokal, atau
│   docker-compose.ghcr.yml tanpa script)                      ──> 5.6 E1
├── console native tanpa perintah "update"                      ──> 5.6 E2
├── agent native, mau pindah ke Docker                          ──> 5.6 E3
└── agent Docker dari compose manual                            ──> berhenti dan tanya
```

Hanya Jalur A dan C yang di-update lewat image. Jalur B di-update dari GitHub Releases (`sdr-doa-console update`). Jalur D tidak punya updater: jalankan installer rilis baru.

---

## 4. Pemeriksaan awal (preflight)

Jalankan semua yang relevan untuk jalur yang dipilih. Catat hasilnya untuk laporan akhir. Mulai dengan 4.9 (alat dan `sudo`), karena langkah lain memakainya.

### 4.1 OS dan arsitektur

```sh
. /etc/os-release && echo "$PRETTY_NAME"
uname -m
dpkg --print-architecture 2>/dev/null || true
timedatectl show -p Timezone --value 2>/dev/null || date +%Z
```

**Periksa**: OS adalah Linux. Baris terakhir adalah zona waktu host; jam update otomatis memakai zona ini (2.1). Petakan arsitektur (pakai `dpkg --print-architecture` bila ada, karena Raspberry Pi OS 32-bit bisa memakai kernel 64-bit):

| `uname -m` | `dpkg` | Console Docker | Agent Docker | Console native | Agent native |
|---|---|---|---|---|---|
| `x86_64` | `amd64` | ya | ya | ya | ya |
| `aarch64` | `arm64` | ya | ya | ya | ya |
| `armv7l` | `armhf` | **tidak** (tidak ada image arm/v7) | ya (`linux/arm/v7`) | tidak diuji | ya |
| lainnya | | tidak | tidak | tidak diuji | tidak diuji |

Docker hanya untuk Linux (`network_mode: host`). Docker Desktop di macOS/Windows tidak didukung.

### 4.2 Docker dan Compose (Jalur A dan C)

```sh
sudo docker version --format '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}'
sudo docker compose version
systemctl is-enabled docker
```

**Periksa**:
- `docker version` mencetak versi server dan platform-nya (bukan error): `linux/amd64` atau `linux/arm64` untuk console dan agent; `linux/arm` hanya untuk agent (image `arm/v7`), console lewat Jalur B. Platform ini yang menentukan image yang di-pull, bukan `uname -m`: Raspberry Pi OS 32-bit dengan kernel 64-bit mencetak `aarch64` di `uname -m` tetapi `linux/arm` di sini.
- `docker compose version` mencetak `Docker Compose version v2.x` atau lebih baru (misalnya `v5.6.0`). Yang ditolak hanya `docker-compose` 1.x yang berdiri sendiri (`docker-compose 1.x is not supported; install Compose v2 (the docker compose plugin)`).
- `systemctl is-enabled docker` → `enabled` (container ikut start saat boot).
- Opsional: `docker buildx version`. Tanpa buildx, `update --check` mem-pull image untuk membandingkan (di belakang proxy juga dengan buildx, lihat 4.7).

Bila Docker atau plugin `docker compose` belum ada: berhenti. Pemasangan Docker Engine mengikuti dokumentasi Docker dan butuh keputusan manusia.

### 4.3 systemd

```sh
test -d /run/systemd/system && echo systemd || echo "no systemd"
```

**Periksa**: `systemd`. Tanpa systemd: timer update Docker diganti baris cron (Jalur A dan C tetap bisa); Jalur B dan D butuh systemd (console native tidak start saat boot, agent native tidak jalan sebagai service), jadi berhenti dan tanya.

Console native juga butuh **systemd user session** untuk user yang memasang. Jalankan di sesi login user itu (SSH sebagai user tersebut, bukan `sudo -u`):

```sh
id -un; id -u
systemctl --user show-environment >/dev/null && echo "user session ok"
loginctl show-user "$USER" -p Linger
```

**Periksa**: `id -un` adalah user dari 2.2 dan `id -u` bukan `0`; lalu `user session ok`. `Linger=yes` atau `Linger=no` (installer mencoba mengaktifkannya; lihat B4).

### 4.4 Ruang disk

```sh
df -h /opt /var/lib/docker 2>/dev/null   # Docker
df -h "$HOME"                            # native console
```

**Periksa** (perkiraan, bukan angka dari kode):
- Docker: image console sekitar 62 MB terkompresi, agent sekitar 42–48 MB; script menyimpan image sekarang dan sebelumnya. Sediakan minimal 2 GB bebas di direktori data Docker.
- Native console: tarball 17 MB. Updater mengunduh dan mengekstrak di direktori data (batas tarball 200 MiB, ekstrak 1024 MiB) dan menyalin program ke `app.previous`. Sediakan minimal 1 GB bebas di `$HOME`.
- Tambahkan cache tile (default paling banyak 512 MB) dan rekaman Receiver.

### 4.5 Port console bebas (peran `console`)

```sh
P=8787
ss -ltn "sport = :$P" 2>/dev/null || cat /proc/net/tcp /proc/net/tcp6 2>/dev/null \
  | awk -v p=":$(printf '%04X' "$P")" 'NR>1 && $4=="0A" && substr($2, length($2)-4)==p {print $2}'
curl -s --noproxy '*' --max-time 3 "http://127.0.0.1:$P/api/health"; echo "rc=$?"
```

Ganti `P=8787` dengan port pilihan manusia bila bukan default. Bila `ss` (paket iproute2) tidak ada, baris kedua membaca `/proc/net/tcp` dan mencetak alamat dalam hex (`0100007F:2253` = `127.0.0.1:8787`).

**Periksa**: `ss` hanya mencetak baris judul (atau, tanpa `ss`, tidak ada output sama sekali), dan `curl` berakhir dengan `rc=7` (connection refused). Bila ada yang mendengarkan atau menjawab: sudah ada console atau program lain. Berhenti dan tanya.

### 4.6 Akses jaringan keluar

```sh
for u in \
  https://api.github.com/repos/sanadunt/sdr-doa-ground-control/releases/latest \
  https://github.com/sanadunt/sdr-doa-ground-control/releases/latest/download/SHA256SUMS \
  https://ghcr.io/v2/ \
  https://pkg-containers.githubusercontent.com/ ; do
  printf '%s %s\n' "$(curl -sS -o /dev/null --max-time 15 -w '%{http_code}' "$u")" "$u"
done
```

**Periksa**: `200` untuk `api.github.com`, `302` untuk unduhan rilis, `401` untuk `ghcr.io/v2/` (artinya terjangkau; image tetap bisa di-pull tanpa login), dan kode apa pun selain `000` untuk `pkg-containers.githubusercontent.com` (host blob GHCR; tanpa host ini pull gagal walaupun `ghcr.io` terjangkau). `000` berarti tidak terjangkau; `curl: (56) CONNECT tunnel failed, response 403` berarti proxy menolak host itu. Untuk Jalur A dan C, cek ini memakai proxy shell, sedangkan Docker daemon memakai konfigurasinya sendiri (4.7), jadi pull bisa tetap gagal walaupun cek ini lolos.

Host yang dipakai (untuk admin jaringan atau proxy):

| Untuk | Host (HTTPS 443) |
|---|---|
| Unduh aset rilis | `github.com`, lalu redirect ke `objects.githubusercontent.com` (GitHub juga bisa memakai `release-assets.githubusercontent.com`) |
| Updater native (`sdr-doa-console update`) | `api.github.com` + host unduhan di atas |
| Pull image (Jalur A, C) | `ghcr.io`, lalu blob dari `pkg-containers.githubusercontent.com` |
| Install native console | `pypi.org`/`files.pythonhosted.org` hanya bila wheel di folder `wheels/` tarball tidak cukup |
| Basemap (opsional, dari host console) | `tile.openstreetmap.de`, `tile.openstreetmap.org`, `a.tile.openstreetmap.fr`, `b.tile.openstreetmap.fr`, `server.arcgisonline.com`, `services.arcgisonline.com`, `a.tile.opentopomap.org`, `b.tile.opentopomap.org` |

Daftar host tile tetap di `TILE_SOURCES` (`tools/tile_cache.py`) dan di Lampiran F manual (`docs/manual/Panduan_Penggunaan_SDR-DoA_Ground_Console.pdf`, ikut di tarball console). Browser tidak menghubungi host tile; console yang mengambil tile.

Cek host tile (opsional; kode HTTP apa pun selain `000` berarti terjangkau):

```sh
curl -sS -o /dev/null --max-time 10 -w '%{http_code}\n' https://tile.openstreetmap.org/0/0/0.png
```

### 4.7 Proxy

```sh
env | grep -io '^[a-z_]*proxy=' || echo "no proxy variables"
```

Ini hanya mencetak **nama** variabel, bukan nilainya (nilai proxy bisa memuat kredensial).

- `curl`, updater native, dan pengambil tile console **native** memakai `HTTPS_PROXY`/`NO_PROXY` dari environment. Console native juga membaca Data Out (`http://`) lewat `HTTP_PROXY` bila variabel itu di-set: `NO_PROXY` lalu harus memuat host Data Out dan loopback (misalnya `NO_PROXY=192.168.100.100,doasdr.local,127.0.0.1,localhost`), kalau tidak 8.1 langkah 6 menjawab `UNAVAILABLE`.
- `sudo` biasanya membuang variabel proxy dari shell (`env_reset`). Akibatnya `sudo /usr/local/bin/sdr-doa-docker update --check` di belakang proxy tidak bisa memakai buildx dan mem-pull image lewat daemon (butuh proxy daemon, lihat butir berikut); hasil `--check` tetap benar.
- Docker daemon **tidak** memakai proxy dari shell; ia memakai konfigurasi service Docker. Itu diatur di luar repository ini: tanya manusia.
- Console Docker tidak mendapat proxy: `compose.yml` dari `sdr-doa-docker` tidak meneruskan variabel proxy dan tidak boleh diedit (1.1.2). Bila host keluar hanya lewat proxy dan basemap dibutuhkan, 8.1 langkah 7 menjawab 504; laporkan ke manusia (atau pilih Jalur B).
- systemd user service (console native dan timer update-nya) tidak membaca `~/.profile`. Manusia menulis variabel proxy di `~/.config/environment.d/proxy.conf` (berlaku pada login atau reboot berikutnya). Untuk sesi sekarang, bila shell agent sudah punya variabelnya, salin tanpa mencetak nilainya, lalu restart console:

  ```sh
  systemctl --user import-environment HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy
  ~/.local/bin/sdr-doa-console restart
  ```

  Variabel yang tidak di-set dilewati. Jangan pakai `systemctl --user set-environment NAMA=nilai`: nilainya masuk command line dan riwayat shell (aturan 1.1.4).

### 4.8 Python (Jalur B dan D)

```sh
python3 -c 'import sys; print(sys.version.split()[0]); sys.exit(0 if sys.version_info >= (3, 9) else 1)'
python3 -c 'import venv, ensurepip' && echo "venv ok"     # hanya Jalur B
```

**Periksa**: versi 3.9 atau lebih baru dan kode keluar 0. Jalur B juga `venv ok`. Bila tidak: Debian/Ubuntu memakai `sudo apt install python3 python3-venv` (pesan dari installer); minta persetujuan manusia.

### 4.9 Alat lain

```sh
for c in curl sha256sum tar python3 sudo; do command -v "$c" >/dev/null && echo "ok $c" || echo "MISSING $c"; done
id -un; id -u
sudo -n true 2>/dev/null && echo "sudo ok" || echo "SUDO NEEDS PASSWORD"
```

**Periksa**:
- `curl`, `sha256sum`, `tar`: `ok`. Tanpa `curl`, `wget` dengan URL yang sama juga bisa untuk unduhan pertama.
- `python3`: wajib untuk Jalur B dan D (4.8). Di host Docker tanpa `python3`, ganti `python3 -c` di 8.1 dan 8.4 dengan `sudo docker compose -f /opt/sdr-doa-ground-console/compose.yml exec -T console python -c` (argumen sama; stdin dari `curl` tetap disalurkan).
- `sudo`: Jalur A, C dan D butuh `sudo ok`, atau `id -u` = `0` (1.3). Jalur B tidak memakai `sudo` dan tidak boleh root. `SUDO NEEDS PASSWORD`: berhenti dan minta manusia memilih (a) sudo tanpa kata sandi untuk sesi ini, atau (b) manusia menjalankan sendiri setiap perintah `sudo` yang Anda tunjukkan. Jangan pernah meminta, menerima, atau mengetik kata sandi sudo.

### 4.10 Data Out dan broker MQTT

Dua titik yang dipakai program setelah terpasang. Dashboard console memakai MQTT bila segar dan Data Out sebagai cadangan, jadi keduanya perlu diperiksa. Masalah di sini bukan kegagalan instalasi, tetapi lebih mudah dibedakan sebelum instalasi daripada di 8.1/8.4.

```sh
curl -s --noproxy '*' --max-time 5 -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8081/status.json
python3 -c 'import socket,sys; socket.create_connection((sys.argv[1], int(sys.argv[2])), 5); print("broker ok")' 127.0.0.1 1883
```

Nilai **(contoh)**. Di `rdf-sdr`: Data Out `http://127.0.0.1:8081` dan broker `MQTT_HOST`/`MQTT_PORT` dari 2.3. Di `console`: base URL Data Out dan broker (host, port) dari 2.2, misalnya `http://192.168.100.100:8081/status.json` dan `10.90.0.1 9001`. Tanpa `python3` lewati baris broker; 8.1 langkah 5 memeriksanya nanti.

**Periksa**: `200` dan `broker ok`. Gagal (`000`, `ConnectionRefusedError`, `timed out`): laporkan ke manusia dan lanjut hanya bila ia setuju.

---

## 5. Instalasi

### 5.1 Versi terbaru, unduhan, dan verifikasi (dipakai semua jalur)

Versi rilis terbaru (tanpa login, tanpa `jq`), disimpan untuk langkah berikutnya:

```sh
mkdir -p ~/sdr-doa-dl
V=$(curl -fsSI https://github.com/sanadunt/sdr-doa-ground-control/releases/latest \
  | sed -n 's|^[Ll]ocation: .*/tag/v\([^[:space:]]*\).*|\1|p')
[ -n "$V" ] && printf '%s\n' "$V" >~/sdr-doa-dl/release-version && cat ~/sdr-doa-dl/release-version
```

**Periksa**: mencetak versi, misalnya `2.0.0`. Kosong: ulangi 4.6. Hanya bila manusia meminta versi tertentu: `printf '%s\n' X.Y.Z >~/sdr-doa-dl/release-version`.

Setiap blok yang memakai versi membacanya lagi dengan `V=$(cat ~/sdr-doa-dl/release-version)`, jadi semua jalur memasang versi yang sama walaupun rilis baru terbit di tengah instalasi. Untuk update di kemudian hari, jalankan blok ini lagi.

Aset rilis (semua bisa diunduh tanpa login):

| Aset | Untuk |
|---|---|
| `sdr-doa-docker` | Jalur A dan C (nama sama di setiap rilis; runbook mengambilnya dari rilis `<V>`) |
| `sdr-doa-ground-console-<V>-linux.tar.gz` | Jalur B (juga memuat `packaging/docker/sdr-doa-docker`) |
| `sdr-doa-rdf-sdr-agent-<V>.tar.gz` | Jalur D |
| `SHA256SUMS` | hash ketiga file di atas |

Pola URL:
- `https://github.com/sanadunt/sdr-doa-ground-control/releases/latest/download/<aset>`
- `https://github.com/sanadunt/sdr-doa-ground-control/releases/download/v<V>/<aset>`

Selalu unduh ke direktori baru yang kosong (`~/sdr-doa-dl/<jalur>-<V>`; bila sudah ada dari percobaan sebelumnya, langkah unduhan menghapusnya dulu: isinya hanya unduhan runbook ini), lalu periksa hash:

```sh
sha256sum -c --ignore-missing SHA256SUMS
```

**Periksa**: satu baris `<nama file>: OK` untuk setiap file yang diunduh, kode keluar 0. `sha256sum: SHA256SUMS: no file was verified` berarti file belum ada di direktori ini. `FAILED` berarti unduhan rusak atau bukan dari rilis: hapus, unduh ulang, dan bila tetap gagal berhenti.

Bila `sha256sum` versi lama tidak mengenal `--ignore-missing`, periksa satu file:

```sh
grep '  sdr-doa-docker$' SHA256SUMS | sha256sum -c -
```

### 5.2 Jalur A: console dengan Docker dari GHCR (disarankan)

Hasil: `/opt/sdr-doa-ground-console` berisi `compose.yml` dan `.env`, container `console` dari `ghcr.io/sanadunt/sdr-doa-ground-console:<kanal>`, data di volume `sdr-doa-ground-console_sdr-doa-data` (`/data`), script di `/usr/local/bin/sdr-doa-docker`.

**A0. Pastikan belum ada instalasi**

```sh
sudo test -e /opt/sdr-doa-ground-console/compose.yml && echo "ADA INSTALL" || echo "kosong"
sudo docker ps -a --filter label=com.docker.compose.project=sdr-doa-ground-console --format '{{.Names}} {{.Image}} {{.Status}}'
```

**Periksa**: `kosong` dan tidak ada container.
- Ada container (image apa pun) tetapi `/opt/sdr-doa-ground-console/compose.yml` tidak ada: instalasi compose manual (build lokal, atau `docker-compose.ghcr.yml` tanpa script). Ikuti 5.6 E1; A3 tanpa E1 akan mengambil alih container itu dan pengaturan di `.env` lamanya hilang.
- Ada `compose.yml`: instalasi yang sudah ada (aturan 1.2; update ada di bagian 7).
- Pengecualian: `compose.yml` dan `.env` itu ditulis oleh A2/A3 yang gagal di sesi ini (belum pernah ada baris `OK: console runs ... and is healthy`). Perbaiki penyebabnya (bagian 9), lewati A2, lalu ulangi A3: `install` aman diulang dan mempertahankan `.env`. Jangan pindah ke bagian 7 untuk instalasi yang belum pernah `OK`; `update --auto` hanya mencatat `skipped: no console container ...` atau `skipped: the console container is ...`.

**A1. Unduh dan verifikasi script**

```sh
V=$(cat ~/sdr-doa-dl/release-version) && [ -n "$V" ] && D=~/sdr-doa-dl/docker-$V &&
rm -rf "$D" && mkdir -p "$D" && cd "$D" &&
curl -fsSLO "https://github.com/sanadunt/sdr-doa-ground-control/releases/download/v$V/sdr-doa-docker" &&
curl -fsSLO "https://github.com/sanadunt/sdr-doa-ground-control/releases/download/v$V/SHA256SUMS" &&
sha256sum -c --ignore-missing SHA256SUMS &&
sh sdr-doa-docker help | head -n 3 || echo "STOP: langkah gagal (versi dari 5.1, unduhan, atau hash)"
```

**Periksa**: `sdr-doa-docker: OK`, lalu awal teks bantuan script, dan tidak ada baris `STOP:`. Direktori ini (`~/sdr-doa-dl/docker-<V>`) dipakai lagi di A3 dan C2.

**A2. Nilai awal koneksi (opsional, hanya sebelum start pertama)**

Console menulis `/data/console.json` pada start pertama. `SDR_DOA_SEED_*` di `/opt/sdr-doa-ground-console/.env` hanya berlaku bila sudah ada **sebelum** `install`, karena `install` langsung menjalankan container. `install` mempertahankan `.env` yang sudah ada dan hanya menambah `SDR_DOA_IMAGE`, `SDR_DOA_IMAGE_TAG` dan `SDR_DOA_PORT`.

```sh
sudo install -d -m 0755 -o root -g root /opt/sdr-doa-ground-console
sudo test -e /opt/sdr-doa-ground-console/.env && echo "STOP: .env sudah ada" || \
sudo sh -c 'umask 077 && cat > /opt/sdr-doa-ground-console/.env' <<'EOF'
SDR_DOA_SEED_BASE_URL=http://192.168.100.100:8081
SDR_DOA_SEED_MQTT_HOST=10.90.0.1
SDR_DOA_SEED_MQTT_PORT=9001
SDR_DOA_SEED_MQTT_TRANSPORT=websockets
SDR_DOA_SEED_MQTT_WS_PATH=/mqtt
SDR_DOA_SEED_REFRESH_SECONDS=2
EOF
sudo stat -c '%a %U %n' /opt/sdr-doa-ground-console/.env
```

Semua nilai di atas **(contoh)**. Buang baris yang tidak diisi manusia (default kode berlaku). Untuk host Data Out di luar daftar default (2.2), tambahkan `SDR_DOA_SEED_DATA_OUT_HOSTS=rdf.local,192.168.100.100` **(contoh)** dan pakai salah satu host itu di `SDR_DOA_SEED_BASE_URL`; daftar yang tidak memuat host base URL diabaikan (log: `SDR_DOA_SEED_DATA_OUT_HOSTS does not include the host of the Data Out URL; ignored`). Nilai yang memuat `$` harus dalam kutip tunggal (`NAMA='nilai'`), karena docker compose mengganti `$nama` di nilai tanpa kutip atau berkutip ganda.

**Periksa**: `600 root /opt/sdr-doa-ground-console/.env`. Jangan tulis `SDR_DOA_ADMIN_PASSWORD` di sini; kata sandi diatur di A4.

**A3. Pasang**

Perintah panjang (pull lalu menunggu `healthy`, paling lama 180 detik): lihat 1.3 soal batas waktu. Pilih **satu** perintah. Tanpa update otomatis:

```sh
cd ~/sdr-doa-dl/docker-"$(cat ~/sdr-doa-dl/release-version)" && sudo sh sdr-doa-docker install
```

Dengan update otomatis (bila manusia memilihnya):

```sh
cd ~/sdr-doa-dl/docker-"$(cat ~/sdr-doa-dl/release-version)" && sudo sh sdr-doa-docker install --auto-update --time 03:30     # jam: (contoh), default 03:30
```

Opsi lain bila diminta manusia: `--port N` (default `8787`), `--channel TAG` (default `2`), `--dir DIR` (default `/opt/sdr-doa-ground-console` untuk root).

**Periksa**:
- kode keluar 0;
- baris `install: wrote /opt/sdr-doa-ground-console/compose.yml and /opt/sdr-doa-ground-console/.env (channel 2)`;
- baris `install: installed /usr/local/bin/sdr-doa-docker`;
- baris `install: OK: console runs 2.0.0 (<id 12 hex>) and is healthy`;
- teks `The Ground Console runs from ghcr.io/sanadunt/sdr-doa-ground-console:2.`;
- dengan `--auto-update`: `auto-update on: daily at 03:30 (local time, up to 15 min later) for /opt/sdr-doa-ground-console`.

Baris `note: /usr/local/bin is not on PATH; run /usr/local/bin/sdr-doa-docker` tidak masalah: runbook selalu memakai path lengkap.

Tidak boleh ada baris `warning: ... has a $ outside single quotes`. Bila ada: perbaiki kutip di `.env` (A2), lalu `cd /opt/sdr-doa-ground-console && sudo docker compose up -d`.

Gagal: `The install did not finish. Look at: cd /opt/sdr-doa-ground-console && docker compose logs console`. Ke bagian 9 (misalnya `FAILED: pull of ...: ... Forbidden` berarti proxy atau firewall menolak host blob GHCR). Setelah penyebabnya diperbaiki, ulangi A3 (lihat pengecualian di A0).

**A4. Kata sandi admin (dikerjakan manusia)**

Minta manusia menjalankan sendiri di terminal interaktif (ada prompt tersembunyi dan konfirmasi):

```sh
cd /opt/sdr-doa-ground-console
sudo docker compose exec console sdr-doa-set-admin-password
sudo docker compose restart console
```

Prompt menerima kata sandi, `random` (dibuatkan dan dicetak sekali), atau Enter (tetap default `123456`). Kata sandi disimpan di `/data/.env` di volume (mode 0600).

Agent lalu memeriksa tanpa melihat nilainya:

```sh
cd /opt/sdr-doa-ground-console && sudo docker compose exec -T console sdr-doa-set-admin-password --status
```

**Periksa**: `set`. `default` berarti belum diatur; `disabled` berarti nilai kosong (login admin mati). Setelah restart, cek juga 8.1 langkah 3.

`--status` hanya membaca `/data/.env`. Bila `SDR_DOA_ADMIN_PASSWORD` ada di `/opt/sdr-doa-ground-console/.env` (misalnya setelah 5.6 E1), `--status` tetap mencetak `default`; yang menentukan adalah 8.1 langkah 3 (`admin_default_password=False`).

Jangan masukkan kata sandi ke `/opt/sdr-doa-ground-console/.env`. Bila tetap di sana, nilai itu menang atas `/data/.env`.

**A5. Update otomatis (bila belum di A3)**

```sh
sudo /usr/local/bin/sdr-doa-docker auto-update on --dir /opt/sdr-doa-ground-console --time 03:30   # jam: (contoh)
sudo /usr/local/bin/sdr-doa-docker auto-update status
```

**Periksa**: `auto-update: on: daily at 03:30 (up to 15 min later) for /opt/sdr-doa-ground-console, timer enabled, active`. Tanpa systemd: perintah pertama mencetak satu baris cron untuk crontab root (exit 0); tambahkan dengan `sudo crontab -e` bila manusia setuju.

Satu host hanya punya satu timer `sdr-doa-docker-update`. Timer root hanya mau menjalankan salinan root di `/usr/local/bin` untuk direktori milik root yang tidak bisa ditulis user lain.

**A6. Verifikasi**: jalankan 8.1 dan 8.2.

**Varian tanpa root** (user di grup `docker`; hanya bila manusia memintanya): `sh sdr-doa-docker install` memakai `~/sdr-doa-ground-console` dan menyalin script ke `~/.local/bin/sdr-doa-docker`; pakai path itu sebagai ganti `/usr/local/bin/sdr-doa-docker` dan tanpa `sudo`. `sdr-doa-docker auto-update on` lalu mencetak satu baris crontab untuk ditambahkan dengan `crontab -e`. Grup `docker` setara root. Rootless Docker tidak dipakai: network `host`-nya ada di namespace RootlessKit, jadi `127.0.0.1:8787` di container bukan loopback host (healthcheck lolos, tetapi 8.1 gagal). Pakai Docker root atau Jalur B.

### 5.3 Jalur B: console native (tarball, `install.sh`, systemd user service)

Hasil: program dan venv di `~/.local/share/sdr-doa-ground-console/app`, data di `~/.local/share/sdr-doa-ground-console`, user service `sdr-doa-ground-console.service`, perintah `~/.local/bin/sdr-doa-console`.

Jalankan semua langkah sebagai user desktop biasa dari 2.2, di sesi login user itu (4.3). Bukan root.

**B0. Pastikan belum ada instalasi**

```sh
command -v sdr-doa-console || ls ~/.local/bin/sdr-doa-console 2>/dev/null || echo "kosong"
```

**Periksa**: `kosong`. Bila ada: instalasi yang sudah ada (aturan 1.2; update di bagian 7, instalasi lama tanpa `update` di 5.6 E2).

**B1. Unduh, verifikasi, ekstrak**

```sh
V=$(cat ~/sdr-doa-dl/release-version) && [ -n "$V" ] && D=~/sdr-doa-dl/console-$V &&
rm -rf "$D" && mkdir -p "$D" && cd "$D" &&
curl -fsSLO "https://github.com/sanadunt/sdr-doa-ground-control/releases/download/v$V/sdr-doa-ground-console-$V-linux.tar.gz" &&
curl -fsSLO "https://github.com/sanadunt/sdr-doa-ground-control/releases/download/v$V/SHA256SUMS" &&
sha256sum -c --ignore-missing SHA256SUMS &&
tar -xzf "sdr-doa-ground-console-$V-linux.tar.gz" &&
ls "sdr-doa-ground-console-$V-linux/install.sh" "sdr-doa-ground-console-$V-linux/MANIFEST.sha256" ||
echo "STOP: langkah gagal (versi dari 5.1, unduhan, hash, atau ekstrak)"
```

**Periksa**: `sdr-doa-ground-console-<V>-linux.tar.gz: OK`, lalu path `install.sh` dan `MANIFEST.sha256` di direktori ekstrak, dan tidak ada baris `STOP:`.

**B2. Pasang**

`--yes` membuat installer tidak bertanya (shell agent tanpa TTY). Kata sandi tetap default `123456` sampai B3. Perintah ini memasang paket Python dengan pip (dari folder `wheels/` di tarball, juga tanpa internet); beri batas waktu yang cukup (1.3).

```sh
V=$(cat ~/sdr-doa-dl/release-version) &&
cd ~/sdr-doa-dl/console-"$V"/sdr-doa-ground-console-"$V"-linux &&
sh install.sh --yes \
  --base-url http://192.168.100.100:8081 \
  --mqtt-host 10.90.0.1 --mqtt-port 9001 \
  --mqtt-transport websockets --mqtt-ws-path /mqtt \
  --refresh-seconds 2
```

Nilai koneksi **(contoh)**; buang flag yang tidak diisi manusia. Nilai tidak boleh memuat spasi atau kutip. Host Data Out di luar daftar default (2.2): tambahkan `--data-out-hosts rdf.local,192.168.100.100` **(contoh)** dan pakai salah satunya di `--base-url`. Opsi lain: `--port N`, `--no-desktop` (server tanpa desktop), `--no-service` (tanpa start saat boot; tidak disarankan), `--prefix DIR`, `--data-dir DIR`, `--bin-dir DIR`. Jangan pakai `--password`.

**Periksa**:
- kode keluar 0;
- `Checking the release files` (cocok dengan `MANIFEST.sha256`);
- `Installing the SDR-DoA Ground Console 2.0.0 into /home/<user>/.local/share/sdr-doa-ground-console/app`;
- `Installing paho-mqtt and tzdata`;
- `warning: the admin password is the default 123456; set your own with: sdr-doa-console password` (wajar sampai B3);
- `The console runs in the background and starts at boot: http://127.0.0.1:8787/`.

Peringatan yang harus ditindaklanjuti:
- `could not enable lingering; ...` → B4.
- `no systemd user session here, so the console will not start at boot` → berhenti; installer harus dijalankan di sesi login (4.3).
- `port 8787 is already in use (another console?)` → berhenti (4.5).
- `warning: /home/<user>/.local/bin is not on PATH; log in again or use /home/<user>/.local/bin/sdr-doa-console` → pakai path lengkap `~/.local/bin/sdr-doa-console` di langkah berikut (runbook sudah melakukannya).

**B3. Kata sandi admin (dikerjakan manusia)**

Manusia menjalankan sendiri di terminal interaktif:

```sh
~/.local/bin/sdr-doa-console password
```

Perintah ini menanyakan kata sandi (atau `random`), menyimpannya di `~/.local/share/sdr-doa-ground-console/.env` (0600), lalu me-restart console.

Agent memeriksa:

```sh
~/.local/bin/sdr-doa-console password --status
```

**Periksa**: `set`.

**B4. Start saat boot tanpa login (lingering)**

```sh
loginctl show-user "$USER" -p Linger
```

**Periksa**: `Linger=yes`. Bila `Linger=no`: minta manusia (butuh sudo) menjalankan `sudo loginctl enable-linger <user>`, lalu cek lagi.

**B5. Update otomatis (bila dipilih)**

```sh
~/.local/bin/sdr-doa-console auto-update on --time 03:45    # jam: (contoh), default 03:45
~/.local/bin/sdr-doa-console auto-update status
```

**Periksa**: `Auto-update on: daily at 03:45 local time (up to 15 min later; a missed run follows the next start)`, lalu status `Auto-update: on, daily at 03:45 local time` dan `Timer:       enabled, active; next run ...`.

Butuh service console (tanpa `--no-service`) dan user session. Tanpa itu perintah keluar dengan kode 1 dan mencetak di stderr `sdr-doa-console: no systemd user session here, so no timer was set up. ...` (atau `... needs the systemd user service of the console ...`) dan satu baris crontab seperti `45 3 * * * /home/<user>/.local/bin/sdr-doa-console update --auto >>/home/<user>/.local/share/sdr-doa-ground-console/update.log 2>&1`; itu bukan kegagalan instalasi. Tambahkan baris itu dengan `crontab -e` bila manusia setuju. Di belakang proxy, cron juga tidak membaca `~/.profile`: manusia menulis baris `HTTPS_PROXY=...` (dan `NO_PROXY=...`) sendiri di atas baris itu di crontab. Peringatan `lingering is off` → B4. Proxy untuk timer systemd: 4.7.

**B6. Verifikasi**: jalankan 8.1 dan 8.3.

### 5.4 Jalur C: agent RDF-SDR dengan Docker dari GHCR

Hasil: `/opt/sdr-doa-agent` berisi `compose.yml`, `.env`, `agent.env`; container `agent` dari `ghcr.io/sanadunt/sdr-doa-rdf-sdr-agent:<kanal>`; state di volume `sdr-doa-agent_agent-state` (atau `/opt/sdr-doa-agent/state` dengan `--enable-config`).

**C0. Pastikan agent native atau agent Docker lain tidak terpasang**

```sh
test -f /opt/sdr-doa-agent/install-info && echo "NATIVE ADA"
test -f /etc/systemd/system/sdr-doa-agent.service && echo "NATIVE ADA"
sudo test -e /opt/sdr-doa-agent/compose.yml && echo "DOCKER ADA"
sudo docker ps -a --filter label=com.docker.compose.project=sdr-doa-agent --format 'CONTAINER {{.Names}} {{.Image}} {{.Status}}'
echo selesai
```

**Periksa**: hanya `selesai`.
- `NATIVE ADA` → 5.6 E3 (script menolak memasang selama service native ada), hanya bila manusia meminta pindah ke Docker.
- `DOCKER ADA`: instalasi yang sudah ada (aturan 1.2; update di bagian 7). Pengecualian: `compose.yml` itu ditulis oleh C2 yang gagal di sesi ini (belum pernah ada baris `OK: agent runs ... and is healthy`): perbaiki penyebabnya (bagian 9), lalu ulangi C2; `install` aman diulang dan mempertahankan `.env` dan `agent.env`.
- Baris `CONTAINER ...` tanpa `DOCKER ADA`: agent dari compose manual (misalnya `docker-compose.agent.yml`). Berhenti dan tanya; C2 akan mengambil alih container itu.

**C1. Unduh dan verifikasi script**: seperti A1 (`sdr-doa-docker: OK`, direktori `~/sdr-doa-dl/docker-<V>`).

**C2. Pasang**

Perintah panjang (pull lalu menunggu 20 detik tanpa restart): lihat 1.3. Pilih **satu** perintah. Tanpa update otomatis (remote config mengikuti `ENABLE_CONFIG` di `agent.env`; `0` pada instalasi baru):

```sh
cd ~/sdr-doa-dl/docker-"$(cat ~/sdr-doa-dl/release-version)" && sudo sh sdr-doa-docker install --agent
```

Dengan update otomatis (jam: contoh, default 03:30):

```sh
cd ~/sdr-doa-dl/docker-"$(cat ~/sdr-doa-dl/release-version)" && sudo sh sdr-doa-docker install --agent --auto-update --time 03:30
```

Hanya bila manusia memutuskan remote config aktif (aturan 1.1.7):

```sh
cd ~/sdr-doa-dl/docker-"$(cat ~/sdr-doa-dl/release-version)" && sudo sh sdr-doa-docker install --agent --enable-config --share-dir /home/doasdr/doasdr/_share   # path: (contoh), ini juga default
```

`--enable-config` me-mount direktori `_share`, menjalankan agent sebagai pemiliknya (`--user UID:GID` bila perlu; tidak boleh root), menyimpan state di `/opt/sdr-doa-agent/state`, dan menulis `ENABLE_CONFIG=1` dan `PUBLISH=1` ke `agent.env`. `--disable-config` menulis `ENABLE_CONFIG=0`. Tambahkan `--auto-update --time HH:MM` ke perintah ini bila update otomatis juga dipilih.

**Periksa**:
- kode keluar 0;
- `install: wrote /opt/sdr-doa-agent/agent.env with the defaults; edit it, then run 'docker compose up -d' in /opt/sdr-doa-agent` (hanya bila `agent.env` belum ada; di jalur 5.6 E3 baris ini tidak muncul dan container memakai nilai dari `agent.env` yang disalin);
- `install: OK: agent runs 2.0.0 (<id>) and is healthy` (image agent tidak punya healthcheck: "healthy" berarti container jalan 20 detik tanpa restart);
- `The RDF-SDR agent runs from ghcr.io/sanadunt/sdr-doa-rdf-sdr-agent:2; settings in /opt/sdr-doa-agent/agent.env.`;
- dengan `--enable-config`: `config patches on: <share> mounted, agent runs as <uid:gid>, state in /opt/sdr-doa-agent/state`.

Pada instalasi baru, container pertama berjalan dengan default (`MQTT_HOST=127.0.0.1`, `MQTT_PORT=1883`, `ENABLE_CONFIG=0`). Itu aman; C3 mengubahnya.

Gagal dengan `the container restarted (exit code 78)`: `run-agent` menolak sebuah nilai `agent.env` (lihat `cd /opt/sdr-doa-agent && sudo docker compose logs --tail 30 agent`, baris `run-agent:`), atau `ENABLE_CONFIG=1` tanpa `--enable-config` (5.6 E3). Bagian 9.

**C3. Atur `agent.env` (nilai bukan rahasia)**

Ubah satu variabel per perintah; nilai dari manusia **(contoh)**:

```sh
F=/opt/sdr-doa-agent/agent.env
sudo sed -i 's|^MQTT_HOST=.*|MQTT_HOST=127.0.0.1|' "$F"
sudo sed -i 's|^MQTT_PORT=.*|MQTT_PORT=1883|' "$F"
# hanya untuk broker di luar loopback:
# sudo sed -i 's|^MQTT_TLS=.*|MQTT_TLS=1|' "$F"
# sudo sed -i 's|^MQTT_USERNAME=.*|MQTT_USERNAME=agent|' "$F"
sudo stat -c '%a %U %n' "$F"
sudo grep -E '^(BASE_URL|MQTT_HOST|MQTT_PORT|MQTT_TLS|MQTT_CAFILE|MQTT_USERNAME|PUBLISH|ENABLE_CONFIG)=' "$F"
sudo grep -c '^[[:space:]]*\(export[[:space:]]*\)\{0,1\}SDR_DOA_MQTT_PASSWORD=.' "$F"
```

**Periksa**: `600 root /opt/sdr-doa-agent/agent.env`, baris variabel berisi nilai yang diminta, dan hitungan kata sandi `0` (kosong) atau `1` (terisi, C4). Nilai kata sandi tidak pernah ditampilkan. `STATE_DIR` dan `SETTINGS_PATH` diatur oleh `compose.yml`; jangan diubah di sini. `ENABLE_CONFIG` diubah hanya lewat `install --agent --enable-config` / `--disable-config`. `MQTT_CAFILE` harus kosong di Docker (2.3).

**C4. Kata sandi MQTT (dikerjakan manusia, hanya bila broker memakai username)**

Manusia menjalankan `sudoedit /opt/sdr-doa-agent/agent.env` dan mengisi `SDR_DOA_MQTT_PASSWORD='...'` (kutip tunggal bila ada `$`). Agent memeriksa dengan baris `grep -c` terakhir di C3 (`1`).

**C5. Terapkan**

```sh
cd /opt/sdr-doa-agent && sudo docker compose up -d && sudo docker compose ps && sudo docker compose logs --tail 30 agent
```

**Periksa**: container `agent` berstatus `Up`, tanpa restart berulang. Log tidak berulang-ulang menampilkan `{"event": "agent_error", ...}` dan tidak memuat `run-agent:`. `sdr-doa-docker update` hanya mengganti image; setiap perubahan `agent.env` harus diterapkan dengan `docker compose up -d` ini.

**C6. Verifikasi**: 8.4. Update otomatis bila belum di C2: `sudo /usr/local/bin/sdr-doa-docker auto-update on --dir /opt/sdr-doa-agent --time 03:30` (jam: contoh). Bila console Docker di host yang sama sudah memakai timer, perintah ini ditolak (satu timer per host); `--force` memindahkannya, hanya dengan izin manusia.

### 5.5 Jalur D: agent RDF-SDR native (systemd service)

Hasil: `/opt/sdr-doa-agent` (program, `bin/run-agent`, `uninstall.sh`), `/etc/sdr-doa-agent/agent.env` (root:<grup service>, 0640), `/var/lib/sdr-doa-agent` (state), `/etc/systemd/system/sdr-doa-agent.service`.

**D0. Pastikan agent Docker tidak jalan**

```sh
sudo docker ps -a --filter label=com.docker.compose.project=sdr-doa-agent --format 'CONTAINER {{.Names}} {{.Status}}' 2>/dev/null
test -f /opt/sdr-doa-agent/install-info && echo "NATIVE SUDAH ADA"
echo selesai
```

**Periksa**: hanya `selesai`. Ada baris `CONTAINER`: berhenti dan tanya (dua agent tidak boleh jalan bersamaan). `NATIVE SUDAH ADA`: instalasi yang sudah ada (aturan 1.2; upgrade di 7.4).

**D1. Unduh, verifikasi, ekstrak**

```sh
V=$(cat ~/sdr-doa-dl/release-version) && [ -n "$V" ] && D=~/sdr-doa-dl/agent-$V &&
rm -rf "$D" && mkdir -p "$D" && cd "$D" &&
curl -fsSLO "https://github.com/sanadunt/sdr-doa-ground-control/releases/download/v$V/sdr-doa-rdf-sdr-agent-$V.tar.gz" &&
curl -fsSLO "https://github.com/sanadunt/sdr-doa-ground-control/releases/download/v$V/SHA256SUMS" &&
sha256sum -c --ignore-missing SHA256SUMS &&
tar -xzf "sdr-doa-rdf-sdr-agent-$V.tar.gz" &&
ls "sdr-doa-rdf-sdr-agent-$V/install.sh" ||
echo "STOP: langkah gagal (versi dari 5.1, unduhan, hash, atau ekstrak)"
```

**Periksa**: `sdr-doa-rdf-sdr-agent-<V>.tar.gz: OK`, path `install.sh` di direktori ekstrak, dan tidak ada baris `STOP:`.

**D2. Coba tanpa mengubah apa pun**

```sh
V=$(cat ~/sdr-doa-dl/release-version) &&
cd ~/sdr-doa-dl/agent-"$V"/sdr-doa-rdf-sdr-agent-"$V" &&
sudo sh install.sh --dry-run --mqtt-host 127.0.0.1 --mqtt-port 1883     # nilai: (contoh)
```

**Periksa**: output memuat `Dry run of the SDR-DoA agent <V> install into /opt/sdr-doa-agent (service user <user>)`, menampilkan isi `agent.env` (kata sandi tampil `<hidden>` bila diisi; kosong tampil `SDR_DOA_MQTT_PASSWORD=`), unit service, perintah agent, dan diakhiri `Dry run: nothing was changed.` Baris `would run: useradd ...`, `would run: chown ...` atau `would run: systemctl ...` dengan path di bawah `/tmp/tmp.*/root` itu wajar. Cocokkan nilai dengan input manusia.

**D3. Pasang**

```sh
V=$(cat ~/sdr-doa-dl/release-version) &&
cd ~/sdr-doa-dl/agent-"$V"/sdr-doa-rdf-sdr-agent-"$V" &&
sudo sh install.sh --mqtt-host 127.0.0.1 --mqtt-port 1883     # nilai: (contoh)
```

Flag tambahan sesuai input (bagian 2.3): `--base-url URL`, `--mqtt-tls` atau `--mqtt-cafile FILE`, `--mqtt-username NAME`, `--settings-path PATH`, `--user NAME`, `--set NAMA=NILAI` (misalnya `--set DOA_RATE=0`). Nilai flag tidak boleh memuat spasi, kutip, backslash, `$` atau backtick. `--enable-config` hanya dengan keputusan manusia. Pakai flag yang sama di D2 dan D3.

**Periksa**:
- kode keluar 0;
- `Installing the SDR-DoA agent 2.0.0 into /opt/sdr-doa-agent (service user <user>)`; catat `<user>` untuk laporan dan 7.4;
- `The sdr-doa-agent service is running and starts at boot.`;
- tidak ada `warning: the sdr-doa-agent service is not running; see: journalctl -u sdr-doa-agent -n 50` (bila ada: `sudo journalctl -u sdr-doa-agent -n 50 --no-pager` dan bagian 9);
- `warning: <path> does not exist yet; set SETTINGS_PATH in agent.env if KrakenSDR keeps it elsewhere` → tanyakan path `settings.json` yang benar ke manusia, lalu jalankan ulang D3 dengan `--settings-path`.

Tanpa systemd muncul `warning: systemd is not running; start the agent with: ...`: service tidak berjalan dan tidak start saat boot. Laporkan; menjalankan agent manual di luar systemd di luar runbook ini.

**D4. Kata sandi MQTT (dikerjakan manusia, hanya bila broker memakai username)**

Manusia menjalankan `sudoedit /etc/sdr-doa-agent/agent.env`, mengisi `SDR_DOA_MQTT_PASSWORD='nilai'` (kutip tunggal; nilai tanpa `'`), lalu `sudo systemctl restart sdr-doa-agent`. systemd membuang kutip itu. Tanpa kutip, nilai dengan spasi, `;`, `&`, `$(` atau backtick dijalankan shell saat `install.sh --dry-run` (D2 dan upgrade 7.4 membaca file ini dengan `.`). Agent memeriksa tanpa melihat nilainya:

```sh
sudo grep -c '^SDR_DOA_MQTT_PASSWORD=.' /etc/sdr-doa-agent/agent.env
```

**Periksa**: `1`.

**D5. Verifikasi**: 8.4.

### 5.6 Migrasi dari instalasi lama

**E1. Console Docker dari compose manual (build lokal, atau `docker-compose.ghcr.yml` tanpa script) → `sdr-doa-docker`**

Nama project compose (`sdr-doa-ground-console`) dan volume (`sdr-doa-data`) sama, jadi data tetap. Pengaturan di `.env` lama (di sebelah file compose lama) **tidak** ikut otomatis. Cari direktori lama dari label container:

```sh
OLD=$(sudo docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' \
  "$(sudo docker ps -aq --filter label=com.docker.compose.project=sdr-doa-ground-console | head -n 1)")
echo "OLD=$OLD"
[ -n "$OLD" ] && { sudo test -f "$OLD/.env" && sudo sed -n 's/^[[:space:]]*\(SDR_DOA_[A-Z_]*\)=.*/\1/p' "$OLD/.env" || echo "tidak ada .env lama"; }
```

**Periksa**: `OLD=` berisi path direktori lama (bukan `/opt/sdr-doa-ground-console`), lalu hanya nama variabel di `.env` lama, atau `tidak ada .env lama`. `OLD=` kosong: berhenti dan tanya.

1. Bila ada `.env` lama: salin baris yang perlu ke `.env` baru **sebelum** install, tanpa menampilkan nilainya (tanpa `.env` lama, lewati langkah ini):

   ```sh
   OLD=/path/dari/langkah/di/atas        # path yang dicetak sebagai OLD=
   sudo install -d -m 0755 -o root -g root /opt/sdr-doa-ground-console
   sudo test -e /opt/sdr-doa-ground-console/.env && echo "STOP: .env sudah ada" || \
   sudo sh -c "umask 077 && grep -E '^(SDR_DOA_ADMIN_PASSWORD|SDR_DOA_PORT|SDR_DOA_SEED_[A-Z_]+)=' '$OLD/.env' > /opt/sdr-doa-ground-console/.env"
   sudo sed -n 's/^\([A-Z_]*\)=.*/\1/p' /opt/sdr-doa-ground-console/.env
   ```

   **Periksa**: nama variabel yang tersalin. `SDR_DOA_IMAGE_TAG` tidak disalin: kanal mulai dari default (`2`) kecuali manusia memilih lain (`--channel` di A3).
2. Pasang seperti A1 dan A3. Container lama diganti container dari image GHCR dengan volume yang sama.
3. **Periksa**: 8.1 dan 8.2, lalu buka UI: pengaturan dan rekaman lama masih ada.
4. Jangan jalankan `docker compose` lagi di `$OLD`: project-nya sama, jadi `docker compose up -d` di sana (dengan atau tanpa `--build`) mengambil alih container lagi.
5. Opsional, setelah manusia setuju: pindahkan `SDR_DOA_ADMIN_PASSWORD` dari `.env` ke volume dengan A4, lalu hapus barisnya dari `/opt/sdr-doa-ground-console/.env` dan `cd /opt/sdr-doa-ground-console && sudo docker compose up -d`. Sampai saat itu `--status` di A4 mencetak `default`; lihat 8.1 langkah 3.

**E2. Console native yang dipasang sebelum perintah `update` ada**

```sh
~/.local/bin/sdr-doa-console update --check; echo "rc=$?"
~/.local/bin/sdr-doa-console info
```

`rc=64` dengan teks bantuan tanpa `update` berarti instalasi lama. `info` menampilkan `Program:`, `Data:` dan `URL:` (port).

1. Jalankan 5.1, lalu unduh dan ekstrak rilis baru (B1).
2. Jalankan sekali installer rilis baru dengan lokasi yang sama seperti instalasi lama:

   ```sh
   V=$(cat ~/sdr-doa-dl/release-version) &&
   cd ~/sdr-doa-dl/console-"$V"/sdr-doa-ground-console-"$V"-linux &&
   sh install.sh --yes
   ```

   Tambahkan `--prefix`, `--data-dir`, `--bin-dir`, `--port`, `--no-service`, `--no-desktop` hanya bila `info` menunjukkan nilai selain default (instalasi lama ini belum punya `install-options`). `--yes` mempertahankan kata sandi tersimpan. Installer menyalin `console.json` dan `branding.json` lama dari `~/.config/sdr-doa-ground-console/` bila belum ada di direktori data, dan memindahkan rekaman Receiver lama ke `receiver/`.
3. **Periksa**: `~/.local/bin/sdr-doa-console update --check` sekarang mencetak `<V> is installed and current` (atau versi yang lebih baru tersedia). Lalu 8.1 dan 8.3.

**E3. Agent native → agent Docker (hanya bila manusia memintanya)**

1. Periksa dulu nilai native yang tidak bisa dibawa apa adanya, tanpa menampilkan kata sandi:

   ```sh
   sudo grep -E '^(ENABLE_CONFIG|MQTT_CAFILE|SETTINGS_PATH)=' /etc/sdr-doa-agent/agent.env
   ```

   - `MQTT_CAFILE=` berisi path: berhenti di sini. File itu tidak ada di dalam container dan `compose.yml` tidak boleh diedit; agent tetap native (Jalur D).
   - `ENABLE_CONFIG=1`: remote config aktif di agent native. Tanyakan manusia, lalu di C2 pakai **tepat satu** dari: `--enable-config --share-dir <direktori dari SETTINGS_PATH>` (tetap aktif; nama file harus `settings.json`, karena `compose.yml` memakai `/krakensdr/_share/settings.json`) atau `--disable-config` (dimatikan). Jangan jalankan C2 tanpa salah satunya: container berhenti dengan exit 78 (`run-agent: ENABLE_CONFIG=1, but uid ... cannot write ...`), restart terus, `install` berakhir dengan `the container restarted (exit code 78)` dan `no previous image to go back to`, dan Raspberry tidak punya agent sama sekali.
   - `ENABLE_CONFIG=0` atau kosong, dan `MQTT_CAFILE=` kosong: C2 biasa.
2. Hentikan dan hapus service native **tanpa** `--purge`: `sudo sh /opt/sdr-doa-agent/uninstall.sh`. **Periksa**: `Removed the agent from /opt/sdr-doa-agent` dan `Kept /etc/sdr-doa-agent/agent.env and /var/lib/sdr-doa-agent (remove them with --purge)`. `/opt/sdr-doa-agent` (dengan `uninstall.sh`) ikut hilang.
3. Salin pengaturan sebelum install (script mempertahankan `agent.env` yang sudah ada):

   ```sh
   sudo install -d -m 0755 -o root -g root /opt/sdr-doa-agent
   sudo test -e /opt/sdr-doa-agent/agent.env && echo "STOP: agent.env sudah ada" || \
   sudo sh -c 'umask 077 && cp /etc/sdr-doa-agent/agent.env /opt/sdr-doa-agent/agent.env'
   sudo stat -c '%a %U %n' /opt/sdr-doa-agent/agent.env
   ```

   **Periksa**: `600 root /opt/sdr-doa-agent/agent.env` dan tidak ada `STOP:`. `STATE_DIR` dan `SETTINGS_PATH` di file itu dikalahkan `compose.yml`. State native di `/var/lib/sdr-doa-agent` tidak dipindah oleh langkah ini.
4. Jalur C mulai dari C1 (C0 sekarang harus lolos), dengan flag C2 dari langkah 1.

---

## 6. Membuka UI dari komputer lain

Console mendengarkan `127.0.0.1:<port>` di host console. Ada dua cara dari komputer lain:

- **SSH tunnel (6.1)**: console penuh (admin, Kontrol, Receiver dengan RadioSpectrum di komputer itu) di browser komputer yang punya akses SSH.
- **Mode LAN lihat-saja (6.2)**: tablet atau komputer di LAN membuka console di port LAN dan hanya melihat. Pengganti forward `socat` lama.

### 6.1 SSH tunnel

Pakai SSH tunnel dengan **nomor port yang sama** di kedua sisi:

```sh
ssh -N -L 127.0.0.1:8787:127.0.0.1:8787 operator@192.0.2.10     # user dan alamat host console: (contoh)
```

Jangan pakai `-g` atau bind address selain `127.0.0.1` di sisi lokal: itu membuka console (login admin, Kontrol) ke LAN komputer operator (aturan 1.1.1).

**Periksa** (di komputer itu, terminal lain): `curl -s --noproxy '*' http://127.0.0.1:8787/api/health` menjawab `"ok": true` dengan versi yang dipasang.

Lalu buka `http://127.0.0.1:8787/` di Chromium, Chrome, atau Edge di komputer itu.

Kenapa port harus sama (diperiksa di `tools/ground_console.py`):
- Setiap GET `/api/receiver/*` (termasuk Rekaman) butuh tepat satu header `Host` berupa nama loopback **dengan port console itu sendiri** (`_receiver_read_is_allowed()`). Dengan `ssh -L 9000:127.0.0.1:8787`, browser mengirim `Host: 127.0.0.1:9000`, dan console menjawab 403 `{"code": "ORIGIN_REJECTED", "error": "Receiver data is served to this console's own pages only", "ok": false}`. UI menampilkan "Open the Receiver from this console."
- POST yang mengubah sesuatu (login admin, Konfigurasi, preferensi, Kontrol, Rekaman) butuh header `Origin` loopback yang host dan port-nya sama persis dengan console. Dengan port lain, login admin juga ditolak: `/api/admin/login requires a same-origin loopback request`.

Bila port 8787 di komputer lokal sudah dipakai: ubah port console di host (`--port N` saat install), lalu tunnel `N:127.0.0.1:N`.

Catatan:
- `localhost:8787` dan `127.0.0.1:8787` adalah origin berbeda untuk izin WebUSB browser. Pakai satu alamat secara konsisten.
- Receiver memakai WebUSB di browser yang membuka halaman, jadi RadioSpectrum (HackRF) dicolokkan ke komputer yang menjalankan browser itu. Firefox tidak mendukung WebUSB.
- Jangan membuka port console ke LAN sebagai pengganti tunnel (aturan 1.1.1). Untuk melihat saja dari LAN, pakai 6.2.

### 6.2 Mode LAN lihat-saja

Belum ada di `v2.0.0`: kartu **Akses LAN** di Konfigurasi dan `GET /api/lan-access` hanya ada di rilis yang membawanya. Pada rilis lama, berhenti dan tanya manusia.

Listener kedua di proses console yang sama, mati secara default. Pengaturannya blok `lan_access` di `console.json` (`enabled`, `port`, `bind`, `allowed_clients`). Port console tetap hanya `127.0.0.1`. Listener LAN:

- hanya menerima alamat klien di `allowed_clients`; klien lain langsung mendapat `403` tanpa isi (permintaannya tidak dibaca), dan log console mencatat `LAN view refused <ip>: not in lan_access.allowed_clients ...` paling banyak sekali per menit per alamat;
- hanya `GET` dan `HEAD` untuk UI dan API baca-saja (`/api/health`, `/api/capabilities`, `/api/snapshot`, `/api/console-config`, `/api/mqtt`, `/api/mqtt/rdf-node`, `/api/preferences` (hanya pilihan tampilan, tanpa pengaturan dan bookmark Receiver), `/api/branding`, `/api/tiles/...`, `/api/admin/status`, `/api/mirror/receiver`). Selain itu `403` atau `405` dengan `{"code": "LAN_READ_ONLY", ...}`: login admin, Kontrol, Konfigurasi, preferensi, Receiver (`/receiver/`) dan Rekaman (`/api/receiver/*`) tidak bisa dari LAN, dan cookie admin tidak pernah dipakai;
- menolak `Host` yang bukan alamat IP, nama host komputer ini, atau `<nama host>.local` (nama `.local` lain ditolak), dan permintaan `Sec-Fetch-Site: cross-site` (`403 ORIGIN_REJECTED`);
- menjalankan paling banyak 32 permintaan sekaligus (selebihnya `503` tanpa isi, log `LAN view busy: ...` sekali per menit), dan tiap permintaan harus terkirim dalam 10 detik;
- tidak terbuka selama kata sandi admin masih `123456` atau login admin mati. Saat start, pengaturan yang menyala dibiarkan tertutup dengan alasan di log (`warning: lan_access is enabled but the LAN view stays closed: ...`), di `/api/health` dan di `/api/capabilities`.

Di tablet, top bar menampilkan chip **LIHAT SAJA** (EN: **VIEW ONLY**); Kontrol, buka kunci admin dan Simpan di Konfigurasi tidak ada. Pilihan tampilan di tablet (tema, bahasa, panel) disimpan di browser tablet saja.

Receiver di tablet adalah **mirror** dari Receiver groundstation (kontrak: `docs/RECEIVER_MIRROR.md`). RadioSpectrum tetap terpasang di USB groundstation dan hanya halaman console di groundstation yang membukanya. Selama mode LAN terbuka, halaman itu mengirim status Receiver dan frame spektrum ke `POST /api/mirror/receiver` (hanya dari loopback, disimpan di memori saja), dan tablet membacanya lewat `GET /api/mirror/receiver`:

- Panel Spektrum di tablet menampilkan tag `MIRROR`, umur frame, spektrum dan waterfall; tombol RX/Spektrum, Dengar dan Mulai terlihat tetapi nonaktif, dan tidak ada audio. Rute Receiver menampilkan spektrum yang sama dan status Receiver.
- Chip `STALE`: RX berjalan tetapi frame terakhir lebih tua dari 3 detik. Chip **SUMBER PUTUS** (EN: **SOURCE LOST**): groundstation tidak mengirim apa pun selama 10 detik, atau belum pernah.
- Mirror hanya mengalir selama halaman console groundstation **memasang Receiver** (rute Receiver pernah dibuka, atau Mulai di panel Spektrum) dan **terlihat** di layar. Halaman yang tersembunyi atau diminimalkan berhenti mengirim frame (tablet: `STALE`), dan tab yang lama tersembunyi bisa berhenti mengirim sama sekali (tablet: **SUMBER PUTUS**). Biarkan halaman console groundstation terbuka di depan.
- Kontrol Receiver dari tablet belum ada (fase 3 issue #15, menunggu keputusan HTTPS).

**Menyalakan** (oleh manusia, di browser groundstation, setelah A4/B3 memasang kata sandi admin sendiri):

1. Bila forward lama masih jalan (unit `sdr-doa-console-lan` atau `socat` ke `127.0.0.1:8787`), manusia menghentikan dan menonaktifkannya dulu lewat `systemctl` (bukan `pkill`, aturan 1.1.12). Forward itu meneruskan semua permintaan, termasuk login dan Kontrol, dan memakai port yang sama. Periksa: `ss -ltnp 'sport = :8788'` tidak menampilkan `socat`.
2. Konfigurasi → **Branding & admin** → isi kata sandi → **Buka kunci**.
3. Kartu **Akses LAN**: nyalakan **Lihat dari LAN**, isi **Port** (`8788`), **Alamat bind** (`0.0.0.0`, atau IP antarmuka LAN host ini), dan **Klien yang diizinkan**, misalnya `192.168.1.20, 192.168.1.0/24` **(contoh)**, lalu **Simpan**. Listener langsung terbuka, pindah, atau tertutup; tidak perlu restart.

**Periksa**: kartu menampilkan chip `OPEN` dan alamat `http://0.0.0.0:8788/`. `CLOSED` dengan alasan: lihat bagian 9.

**Firewall**: buka port LAN hanya untuk jaringan LAN, port console (`8787`) tidak pernah. Contoh untuk ufw dan firewalld **(contoh)**, hanya dengan izin manusia:

```sh
sudo ufw allow from 192.168.1.0/24 to any port 8788 proto tcp
sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="192.168.1.0/24" port port="8788" protocol="tcp" accept' && sudo firewall-cmd --reload
```

Docker (Jalur A) memakai `network_mode: host`, jadi listener LAN langsung ada di host; jangan tambah `ports:` (aturan 1.1.2).

**Verifikasi di host console**:

```sh
curl -s --noproxy '*' http://127.0.0.1:8787/api/health; echo
curl -s --noproxy '*' http://127.0.0.1:8787/api/lan-access; echo
ss -ltn 'sport = :8788'
curl -s --noproxy '*' http://127.0.0.1:8787/api/mirror/receiver | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["ok"], d["source_age_ms"], d["frame_age_ms"])'
```

**Hasil**: health berisi `"lan_access": {"enabled": true, "reason": null, "state": "open"}`. `lan-access` berisi `"config"` dengan pengaturan yang disimpan dan `"status"` dengan `"state": "open"` dan `"address": "0.0.0.0:8788"`. `ss`: satu baris `LISTEN` di `0.0.0.0:8788` (atau alamat bind yang dipilih). 8.1 langkah 2 tetap: port console hanya `127.0.0.1`. Mirror: `True` dengan umur sumber di bawah `10000` selama halaman console groundstation memasang Receiver dan terlihat (umur frame di bawah `3000` selama RX berjalan); `True None None` bila Receiver belum dibuka di groundstation, dan itu bukan kesalahan.

**Verifikasi dari komputer lain di LAN** yang alamatnya diizinkan (`H` = alamat LAN host console **(contoh)**):

```sh
H=192.168.1.10
curl -s --noproxy '*' "http://$H:8788/api/health"; echo
curl -s --noproxy '*' "http://$H:8788/api/capabilities" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["access"], d["read_only"], d["admin_enabled"])'
curl -s --noproxy '*' -o /dev/null -w '%{http_code}\n' "http://$H:8788/api/receiver/settings"
curl -s --noproxy '*' -o /dev/null -w '%{http_code}\n' -X POST -d '{}' "http://$H:8788/api/admin/login"
curl -s --noproxy '*' -o /dev/null -w '%{http_code}\n' "http://$H:8788/api/mirror/receiver"
curl -s --noproxy '*' -o /dev/null -w '%{http_code}\n' -X POST -d '{}' "http://$H:8788/api/mirror/receiver"
curl -s --noproxy '*' --max-time 3 -o /dev/null "http://$H:8787/api/health"; echo "rc=$?"
```

**Hasil**: `{"lan_access": ..., "ok": true, ...}`; `lan-view True False`; `403`; `405`; `200`; `405` (mirror hanya dibaca dari LAN); `rc=7` (connection refused) atau `rc=28` (timeout, bila firewall host membuang paket ke port itu, seperti `ufw` dengan kebijakan bawaannya `deny incoming` dan aturan di atas): keduanya berarti port console tertutup dari LAN. Jawaban HTTP apa pun dari port 8787 berarti port console terbuka ke LAN: berhenti dan tanya manusia. Dari komputer yang **tidak** diizinkan, `curl -s -o /dev/null -w '%{http_code}\n' "http://$H:8788/"` mencetak `403`, dan log console mencatat alamatnya.

**Mematikan**: kartu **Akses LAN** → matikan **Lihat dari LAN** → **Simpan**. Chip `CLOSED`, `ss -ltn 'sport = :8788'` kosong. Tutup lagi port firewall-nya.

---

## 7. Update

### 7.1 Console Docker (`sdr-doa-docker`)

Semua perintah untuk instalasi di `/opt` pakai `sudo` (`.env` milik root, 0600). Tambahkan `--dir /opt/sdr-doa-ground-console` agar tidak tertukar dengan instalasi agent.

**Langkah update manual yang aman untuk agent (tanpa TTY):**

```sh
curl -s --noproxy '*' http://127.0.0.1:8787/api/health; echo
sudo /usr/local/bin/sdr-doa-docker update --check --dir /opt/sdr-doa-ground-console
sudo /usr/local/bin/sdr-doa-docker update --auto --dir /opt/sdr-doa-ground-console
sudo /usr/local/bin/sdr-doa-docker status --dir /opt/sdr-doa-ground-console
```

**Periksa**:
- `/api/health` berisi `"receiver_busy": false`. Bila `true`: Receiver sedang merekam atau mengarsipkan pindai; tanya manusia dulu.
- `--check` mencetak `up to date: console runs 2.0.0 (<id>), the image of ghcr.io/sanadunt/sdr-doa-ground-console:2` (tidak ada yang perlu dilakukan) atau `update available: ...`.
- `update --auto` tanpa pertanyaan: melewati image yang lebih lama dari yang jalan atau yang pernah gagal, dan menunda selama Receiver sibuk. Setiap baris diawali waktu UTC. Hasil yang diharapkan salah satu dari:
  - `update --auto: up to date: console runs ...`;
  - `update --auto: new image: <baru>, running <lama>`, `starting <baru>`, `OK: console runs <baru> and is healthy`;
  - `update --auto: deferred: Receiver recording or scan active; the next run tries <baru> again` (exit 0; tanya manusia apakah update dipaksa dengan `--yes`);
  - `skipped: ...` (exit 0; laporkan ke manusia alasannya).
- `status`: `container:   running, health healthy, restarts 0, image <versi> (<id>)`.

Perintah lain:

| Perintah | Arti |
|---|---|
| `sudo /usr/local/bin/sdr-doa-docker update --dir DIR` | Update interaktif. Di terminal bertanya untuk image lama, image yang pernah gagal, dan Receiver yang sibuk. **Tanpa TTY: image lama atau yang pernah gagal langsung dipasang**, dan Receiver sibuk ditolak (`not updated: ... run 'sdr-doa-docker update --yes' to update anyway`, exit 1). Juga menyalakan container yang di-stop manual. |
| `sudo /usr/local/bin/sdr-doa-docker update --yes --dir DIR` | Tanpa pertanyaan, juga di atas rekaman yang berjalan. Hanya dengan persetujuan manusia. `--yes` dan `--auto` tidak bisa bersamaan. |
| `sudo /usr/local/bin/sdr-doa-docker rollback --dir DIR` | Kembali ke image `sdr-doa-previous` dan menunggu healthy. Image yang ditinggalkan dicatat di `.bad-images`, jadi update otomatis melewatinya sampai ada image lain. Butuh satu update yang berhasil sebelumnya (`FAILED: no previous image ...`). |
| `sudo /usr/local/bin/sdr-doa-docker status --dir DIR` | Image, container dan health, image sebelumnya, image yang dilewati, penundaan, timer, baris terakhir `update.log`, URL. |
| `sudo /usr/local/bin/sdr-doa-docker auto-update on\|off\|status` | Timer harian `sdr-doa-docker-update.timer` (default `03:30`, `--time HH:MM`; `--force` memindahkan timer dari instalasi lain). |

Apa yang terjadi saat `update`:
1. Pull tag kanal (`SDR_DOA_IMAGE_TAG` di `.env`, default `2`).
2. Image sama dan container sehat: tidak ada perubahan.
3. Image baru: image yang jalan diberi tag `sdr-doa-previous`, container dibuat ulang, lalu ditunggu `healthy` paling lama 180 detik (`SDR_DOA_HEALTH_TIMEOUT`).
4. Gagal: image sebelumnya dipasang lagi (`rolling back to ...`, `rolled back: console runs ... again`), exit 1. Bila image itu sendiri gagal (unhealthy, berhenti, restart terus) ID-nya dicatat di `.bad-images`. Gagal karena hal lain (error compose, waktu habis) tidak dicatat dan dicoba lagi pada run berikutnya.
5. Setiap langkah tercatat di `DIR/update.log` (500 baris terakhir).

File di `DIR`: `update.log`, `.bad-images` (image yang gagal healthcheck), `.deferred-since` (waktu penundaan pertama karena Receiver sibuk, dalam detik epoch).

`update` hanya mengganti image. Perubahan `.env` (port, nilai awal) diterapkan dengan `cd DIR && sudo docker compose up -d`, atau dengan menjalankan `install` lagi.

**Update script `sdr-doa-docker` sendiri dan ganti kanal** (re-run `install`): script tidak meng-update dirinya. Menjalankan `install` lagi lebih sedikit pengamannya daripada `update --auto`: ia tidak menunda dan tidak bertanya. Bila kanal menunjuk image lain, ia langsung me-restart console, juga untuk image yang lebih lama atau yang pernah gagal (hanya mencatat `warning: the Receiver records or archives a scan; the restart interrupts it` bila Receiver sibuk). Karena itu:

1. Cek dulu: `curl -s --noproxy '*' http://127.0.0.1:8787/api/health; echo`. Bila `"receiver_busy": true`: tanya manusia dulu.
2. Jalankan 5.1 lalu A1 (script dari rilis terbaru di direktori baru).
3. Jalankan `install` **tanpa** `--auto-update`. Timer yang ada menjalankan `/usr/local/bin/sdr-doa-docker`, yang diganti oleh `install`; `--auto-update` tanpa `--time` mengembalikan jam timer ke 03:30.

```sh
cd ~/sdr-doa-dl/docker-"$(cat ~/sdr-doa-dl/release-version)" && sudo sh sdr-doa-docker install --dir /opt/sdr-doa-ground-console
```

Pengaturan di `.env` tetap; `install` juga mem-pull image kanal dan menerapkan `compose.yml`. **Periksa**: seperti A3.

**Kanal dan versi mayor baru** (keputusan manusia): kanal `2` tidak pernah pindah ke 3.x. Untuk pindah, jalankan langkah 1 dan 2 di atas, lalu:

```sh
cd ~/sdr-doa-dl/docker-"$(cat ~/sdr-doa-dl/release-version)" && sudo sh sdr-doa-docker install --channel 3 --dir /opt/sdr-doa-ground-console     # 3: (contoh)
```

`install` ulang mempertahankan `.env`; hanya opsi yang diberikan yang berubah. `--channel 2.0.0` mengunci di satu rilis. Image yang lebih lama dari yang jalan dipasang oleh `install --channel` (pilihan operator).

### 7.2 Console native (`sdr-doa-console update`)

Jalankan sebagai user yang memasang. Tidak butuh akun atau token GitHub.

**Langkah update manual yang aman untuk agent (tanpa TTY):**

```sh
curl -s --noproxy '*' http://127.0.0.1:8787/api/health; echo
~/.local/bin/sdr-doa-console update --check
~/.local/bin/sdr-doa-console update --auto
~/.local/bin/sdr-doa-console auto-update status
```

**Periksa**:
- `--check` mencetak `2.0.0 is installed and current`, atau `<terpasang> is installed; <baru> (<tanggal>) is available: <url>` dan `Update with: sdr-doa-console update`.
- `update --auto` tanpa rilis baru mencetak `2.0.0 is installed and current` (exit 0).
- `update --auto` dengan rilis baru (tanpa pertanyaan; perintah panjang, 1.3) mencetak `Installed: ...`, `Release: ...`, `Checked <tarball> against SHA256SUMS`, `Unpacked and checked against MANIFEST.sha256`, `Saved the current program as .../app.previous`, `Running install.sh --yes --prefix=... --data-dir=... --bin-dir=... --port=...`, `Waiting for <baru> to answer on http://127.0.0.1:8787/ (up to 60 s)`, dan diakhiri `Updated the Ground Console from <lama> to <baru>.`, exit 0.
- Receiver sibuk: `deferred: Receiver recording or scan active; <baru> is installed on a later run` (exit 0). Tanya manusia.
- `auto-update status` menampilkan `Last update run: <waktu>: <hasil>`.

Opsi:

| Perintah | Arti |
|---|---|
| `sdr-doa-console update --check` | Hanya membandingkan versi. Tidak boleh digabung dengan `--auto`. |
| `sdr-doa-console update` | Bertanya `Update the Ground Console to X? It restarts once. [y/N]`. Tanpa TTY: `there is no terminal to ask; confirm with --yes`. |
| `sdr-doa-console update --yes` | Tanpa pertanyaan; saat Receiver sibuk hanya memberi peringatan lalu tetap update. Hanya dengan persetujuan manusia bila sibuk. |
| `sdr-doa-console update --auto` | Seperti timer: tanpa pertanyaan, menunda selama Receiver sibuk (paling lama 7 hari). |
| `sdr-doa-console update --to X.Y.Z` | Rilis tertentu: juga untuk kembali ke versi lama (downgrade), mencoba prerelease, atau mencoba lagi rilis yang pernah gagal. |
| `sdr-doa-console update --allow-major` | Izinkan versi mayor lain. Keputusan manusia setelah membaca catatan rilis. |
| `sdr-doa-console auto-update on [--time HH:MM]\|off\|status` | User timer `sdr-doa-console-update.timer`, default `03:45` lokal; menjalankan `sdr-doa-console update --auto`. Log: `journalctl --user -u sdr-doa-console-update`. |

Aturan updater (dari `packaging/console/update_release.py`):
- Membaca rilis terbaru dari `https://api.github.com/repos/sanadunt/sdr-doa-ground-control/releases/latest` secara anonim lewat proxy environment. Prerelease tidak pernah dipilih otomatis. Versi mayor lain hanya dengan `--allow-major`.
- Hash tarball dicocokkan dengan `SHA256SUMS` sebelum apa pun diekstrak, lalu `MANIFEST.sha256` dan `VERSION` diperiksa.
- Program sekarang disalin ke `~/.local/share/sdr-doa-ground-console/app.previous`, lalu `install.sh --yes` rilis baru dijalankan dengan opsi dari `app/install-options`. Data dan kata sandi tidak disentuh.
- Bila `/api/health` tidak melaporkan versi baru dalam 60 detik: salinan dikembalikan, console lama dijalankan lagi, exit 1 dengan `the update to X failed (...); Y was restored`. Rilis itu dilewati update berikutnya sampai ada rilis yang lebih baru (`X did not start here before and was rolled back; to try it again run: sdr-doa-console update --to X`).
- Satu update pada satu waktu (`.update.lock`; `another update is running`). Hasil terakhir di `~/.local/share/sdr-doa-ground-console/update-state.json`.
- Tidak ada perintah `rollback` native. Kembali ke versi lama: `sdr-doa-console update --to <versi-lama> --yes` (dengan persetujuan manusia).
- Unit update yang dihentikan di tengah jalan (shutdown, logout) mengembalikan instalasi lama; sinyal kedua tidak memotong pengembalian.

Upgrade manual tetap bisa: jalankan 5.1 dan B1 (rilis baru), lalu installer dengan opsi yang tercatat. `install.sh` tidak membaca `install-options` sendiri; hanya updater yang meneruskannya.

```sh
V=$(cat ~/sdr-doa-dl/release-version) &&
OPTS=$(grep -v '^#' ~/.local/share/sdr-doa-ground-console/app/install-options) &&
cd ~/sdr-doa-dl/console-"$V"/sdr-doa-ground-console-"$V"-linux &&
sh install.sh --yes $OPTS
```

Path `install-options` ada di bawah `Program:` dari `sdr-doa-console info` (default seperti di atas; isinya path tanpa spasi, jadi `$OPTS` tanpa kutip memang disengaja). File itu tidak ada: instalasi lama, ikuti 5.6 E2. Tanpa opsi itu port, direktori data, prefix, `--no-service` dan `--no-desktop` kembali ke default dan ditulis ulang ke `install-options`. Program dan venv diganti; data dan kata sandi di direktori data yang sama tetap.

### 7.3 Agent Docker

```sh
sudo /usr/local/bin/sdr-doa-docker update --check --dir /opt/sdr-doa-agent
sudo /usr/local/bin/sdr-doa-docker update --auto --dir /opt/sdr-doa-agent
sudo /usr/local/bin/sdr-doa-docker status --dir /opt/sdr-doa-agent
```

Sama seperti 7.1, dengan dua perbedaan: image agent tidak punya healthcheck (image baru dianggap gagal bila container berhenti atau restart dalam 20 detik pertama, `SDR_DOA_AGENT_SETTLE`), dan agent tidak pernah ditunda karena Receiver. Rollback: `sudo /usr/local/bin/sdr-doa-docker rollback --dir /opt/sdr-doa-agent`. Perubahan `agent.env`: `cd /opt/sdr-doa-agent && sudo docker compose up -d`.

### 7.4 Agent native

Tidak ada updater. Jalankan 5.1 dan D1 (rilis baru), lalu installer dari tarball itu. User service tidak diingat installer: tanpa `--user` ia memilih lagi (pemilik `settings.json`, lalu `doasdr`, lalu user baru `sdr-doa-agent`), jadi berikan user yang tercatat:

```sh
V=$(cat ~/sdr-doa-dl/release-version) &&
U=$(sed -n 's/^AGENT_USER=//p' /opt/sdr-doa-agent/install-info) && [ -n "$U" ] && echo "AGENT_USER=$U" &&
cd ~/sdr-doa-dl/agent-"$V"/sdr-doa-rdf-sdr-agent-"$V" &&
sudo sh install.sh --dry-run --user "$U"
```

**Periksa** seperti D2, dengan `(service user <U>)` sama dengan `AGENT_USER=` yang dicetak. Lalu pasang:

```sh
V=$(cat ~/sdr-doa-dl/release-version) &&
U=$(sed -n 's/^AGENT_USER=//p' /opt/sdr-doa-agent/install-info) && [ -n "$U" ] &&
cd ~/sdr-doa-dl/agent-"$V"/sdr-doa-rdf-sdr-agent-"$V" &&
sudo sh install.sh --user "$U"
```

Tanpa flag lain, `agent.env` (termasuk `ENABLE_CONFIG`) dan state dipertahankan; hanya flag yang diberikan yang berubah. Installer me-restart service.

**Periksa**: `Installing the SDR-DoA agent <V> into /opt/sdr-doa-agent (service user <U>)` dengan user yang sama seperti `AGENT_USER=` yang dicetak, `The sdr-doa-agent service is running and starts at boot.`, dan `grep '^VERSION=' /opt/sdr-doa-agent/install-info` menunjukkan versi baru.

### 7.5 Rekaman, pindai, dan RX selama update

- `/api/health` melaporkan `receiver_busy: true` selama Receiver merekam audio atau mengarsipkan pindai: 30 detik setelah setiap tulis, atau selama sesi audio atau pindai terbuka dengan tulis dalam 120 detik terakhir.
- Update otomatis (Docker `--auto` dan native `--auto`) menunda selama itu, dicoba lagi pada jadwal berikutnya, dan tetap jalan setelah 7 hari tertunda terus (`the Receiver was busy at every run for 7 days; updating anyway` / `The Receiver was busy at every update run for 7 days; updating anyway`).
- Update manual: Docker bertanya di terminal atau butuh `--yes`; native memberi peringatan `The update restarts the console, which interrupts it (the recording goes on in a new segment).`
- Update me-restart console satu kali. Sesi Receiver yang tertinggal terbuka ditutup setelah 2 menit tanpa aktivitas dan tampil `INTERRUPTED` di Rekaman.
- Muat ulang halaman console di browser setelah update agar memakai frontend baru. RX, pindai dan rekaman di frame Receiver berjalan sampai halaman console dimuat ulang, jadi reload juga menghentikannya; tekan Mulai lagi sesudahnya.
- Saran untuk agent: update manual hanya saat `receiver_busy` bernilai `false`, atau setelah manusia setuju.

---

## 8. Checklist verifikasi

Jalankan setelah setiap instalasi dan setiap update. Ganti port bila bukan `8787`. Host tanpa `python3`: lihat 4.9.

### 8.1 Console (Docker dan native)

```sh
# 1. health
curl -s --noproxy '*' http://127.0.0.1:8787/api/health; echo
```
**Hasil**: `{"ok": true, "receiver_busy": false, "version": "2.0.0"}` (versi sesuai yang dipasang). Rilis dengan mode LAN (6.2) menambah `"lan_access": {"enabled": false, "reason": "DISABLED", "state": "closed"}`; `"state": "open"` hanya bila manusia menyalakannya.

```sh
# 2. hanya loopback
P=8787
ss -ltn "sport = :$P" 2>/dev/null || cat /proc/net/tcp /proc/net/tcp6 2>/dev/null \
  | awk -v p=":$(printf '%04X' "$P")" 'NR>1 && $4=="0A" && substr($2, length($2)-4)==p {print $2}'
```
**Hasil** dengan `ss`: satu baris `LISTEN` dengan kolom Local Address `127.0.0.1:8787` (kolom Peer `0.0.0.0:*` itu wajar). Tanpa `ss`: satu baris `0100007F:2253` (= `127.0.0.1:8787`). Alamat lain (`0.0.0.0:8787`, `*:8787`, IP LAN; tanpa `ss` misalnya `00000000:2253`): berhenti, ini pelanggaran aturan 1.1.1. Listener mode LAN (6.2) memakai port lain dan tidak muncul di sini; port itu hanya boleh ada bila manusia menyalakannya.

```sh
# 3. admin dan versi
curl -s --noproxy '*' http://127.0.0.1:8787/api/capabilities \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["version"], "admin_enabled=%s" % d["admin_enabled"], "admin_default_password=%s" % d["admin_default_password"])'
```
**Hasil**: `2.0.0 admin_enabled=True admin_default_password=False`. `admin_default_password=True` berarti kata sandi masih `123456` (A4/B3 belum). `admin_enabled=False` berarti login admin mati (nilai kosong atau `.env` tidak terbaca).

```sh
# 4. pengaturan koneksi tersimpan
curl -s --noproxy '*' http://127.0.0.1:8787/api/console-config; echo
```
**Hasil**: JSON dengan `base_url`, `mqtt_host`, `mqtt_port`, `mqtt_transport`, `mqtt_ws_path`, `refresh_seconds` sesuai input manusia.

```sh
# 5. MQTT (bila broker diisi)
curl -s --noproxy '*' http://127.0.0.1:8787/api/mqtt | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("connection"), d.get("last_error"))'
```
**Hasil**: `connected None`. `connecting`/`error` dengan pesan: broker tidak terjangkau atau menolak. Laporkan; console tetap jalan tanpa MQTT.

```sh
# 6. Sumber data Dashboard dan Data Out (butuh sampai 4 detik; jalankan dua kali)
curl -s --noproxy '*' --max-time 10 http://127.0.0.1:8787/api/snapshot | python3 -c 'import json,sys; d=json.load(sys.stdin); s=d.get("source") or {}; print(s.get("kind"), s.get("reason"), (s.get("data_out") or {}).get("available"), d.get("overall_state"))'
```
**Hasil**: empat nilai: sumber, alasannya, apakah `status.json` Data Out terbaca, dan state. Console memang tidak pernah melaporkan `LIVE`.

- `mqtt MQTT_FRESH True UNVERIFIED`: MQTT segar (health RDF Node `daq=1` dalam 8 detik terakhir) dan Data Out terjangkau. Selama MQTT segar Data Out hanya dibaca ringan tiap 30 detik di latar belakang, jadi percobaan pertama setelah start bisa `False`; ulangi perintahnya. `INCOMPLETE` atau `STALE` di sini: DoA LIVE dari RDF-SDR belum ada atau sudah tua (konfigurasi edge, `QUICKSTART.md` "Sumber data Dashboard"); laporkan.
- `data_out MQTT_... True UNVERIFIED`: MQTT tidak segar, Dashboard memakai Data Out (cadangan). Alasannya: `MQTT_DISABLED` (broker belum diisi atau monitor mati), `MQTT_NO_SESSION`/`MQTT_NO_HEALTH`/`MQTT_HEALTH_STALE` (belum atau tidak lagi ada pesan RDF Node; cek langkah 5 dan Monitor Pesan), `MQTT_DAQ_NOT_HEALTHY` (DAQ node tidak sehat). Bukan kegagalan instalasi bila manusia memang belum memakai MQTT.
- `none ... False UNAVAILABLE`: MQTT tidak segar dan Data Out tidak terjangkau dari host ini (cek 4.10; console native di belakang proxy: `NO_PROXY`, 4.7).
- `STALE`, `DEGRADED`, dan seterusnya dengan `data_out`: data terbaca tetapi ada masalah di node. Ini bukan kegagalan instalasi; laporkan.

Nama `.local` di Docker: resolver sistem container tidak bisa meresolusi mDNS (tidak ada nss-mdns), jadi console mengirim sendiri query mDNS, sekali lewat setiap interface jaringan yang aktif dan punya alamat IPv4 (juga di LAN tanpa default route; paling lama sekitar 1 detik), lalu menyambung ke alamat itu dengan header `Host` tetap nama aslinya. Lihat bagaimana host teresolusi:

```sh
curl -s --noproxy '*' --max-time 10 http://127.0.0.1:8787/api/snapshot | python3 -c 'import json,sys; d=json.load(sys.stdin); r=d["collection"].get("host_resolution") or {}; print(r.get("method"), r.get("address"), (d.get("resources") or {}).get("/status.json", {}).get("error"))'
```
Saat sumbernya MQTT, nilai ini dari pembacaan ringan Data Out terakhir; `None None None` berarti pembacaan itu belum selesai, ulangi beberapa detik kemudian.

**Hasil**: `mdns <IP> None` (lewat fallback mDNS), `system <IP> None` (resolver sistem), `literal <IP> None` (base URL berisi IP), atau `proxy None None` (dibaca lewat proxy lingkungan, jadi alamat node tidak diketahui console; agar dibaca langsung, isi `NO_PROXY`, 4.7). `None None doasdr.local could not be resolved (system and mDNS); use an IP address`: nama itu tidak teresolusi, juga lewat mDNS (node mati, beda segmen jaringan, multicast diblok, atau firewall host membuang jawabannya; bagian 9). Minta manusia memilih IP Data Out, lalu ubah base URL (dan daftar host bila IP itu belum ada) di halaman Konfigurasi.

```sh
# 7. tile (opsional, bila basemap dipakai)
curl -s --noproxy '*' -D - -o /dev/null http://127.0.0.1:8787/api/tiles/osm/0/0/0 | grep -i '^x-tile-cache\|^HTTP'
```
**Hasil**: `HTTP/1.0 200 OK` dengan `X-Tile-Cache: miss` (pertama) atau `hit`. `504` berarti tile belum tersimpan dan upstream tidak terjangkau (4.6, 4.7).

### 8.2 Tambahan untuk console Docker

```sh
sudo /usr/local/bin/sdr-doa-docker status --dir /opt/sdr-doa-ground-console
cd /opt/sdr-doa-ground-console && sudo docker compose ps
S=$(sudo docker inspect --format '{{.State.StartedAt}}' "$(sudo docker compose ps -q console)")
sudo docker compose logs --no-log-prefix --since "$S" console
sudo docker compose exec -T console sdr-doa-set-admin-password --status
sudo docker volume inspect sdr-doa-ground-console_sdr-doa-data --format '{{.Mountpoint}}'
```

Log hanya dari start terakhir container: `docker compose restart` (A4) mempertahankan log start sebelumnya, dan peringatan dari start sebelum A4 tidak dihitung.

**Hasil**:
- `status`: `container:   running, health healthy, restarts 0, image 2.0.0 (<id>)`, `image:       ghcr.io/sanadunt/sdr-doa-ground-console:2`, `URL:         http://127.0.0.1:8787/`, dan `auto-update:` sesuai pilihan.
- `compose ps`: status `Up ... (healthy)`.
- log memuat `Ground Console: http://127.0.0.1:8787/`, `Version: 2.0.0`, `Saved settings: /data/console.json, /data/branding.json, /data/preferences.json`, `Tile cache: /data/tiles (at most 512 MB)`, `Read-only Data Out: <base_url>`. Start pertama juga `[ground-console] saved the initial console config to /data/console.json`. Tidak boleh ada `MQTT monitor unavailable` dan tidak boleh ada `Warning: the default admin password is in use` setelah A4.
- `--status`: `set` (setelah 5.6 E1 dengan kata sandi di `/opt/sdr-doa-ground-console/.env`: `default`, lihat A4; yang menentukan 8.1 langkah 3).
- volume ada (path di bawah direktori data Docker).

Setelah reboot (bila manusia mengizinkan reboot): container start sendiri (`restart: unless-stopped`, Docker `enabled`).

### 8.3 Tambahan untuk console native

```sh
~/.local/bin/sdr-doa-console status
~/.local/bin/sdr-doa-console info
~/.local/bin/sdr-doa-console password --status
systemctl --user is-enabled sdr-doa-ground-console.service
loginctl show-user "$USER" -p Linger
journalctl --user -u sdr-doa-ground-console.service --no-pager \
  --since "$(systemctl --user show -p ActiveEnterTimestamp --value sdr-doa-ground-console.service)"
```

Journal hanya dari start terakhir: `sdr-doa-console password` (B3) me-restart service, dan peringatan dari start sebelum B3 tidak dihitung.

**Hasil**:
- `status`: blok systemd dengan `Active: active (running)`, lalu `answering on http://127.0.0.1:8787/`.
- `info`: `SDR-DoA Ground Console 2.0.0`, `URL:      http://127.0.0.1:8787/`, `Program:  .../app`, `Data:     ...`, `Service:  .../sdr-doa-ground-console.service (systemd user service)`, `Updates:` sesuai pilihan.
- `password --status`: `set`.
- `enabled` dan `Linger=yes`.
- journal memuat baris start seperti 8.2 dengan path di `~/.local/share/sdr-doa-ground-console/`, tanpa `MQTT monitor unavailable` dan tanpa `Warning: the default admin password is in use`. `-- No entries --` atau journal kosong berarti pemeriksaan ini belum bisa dilakukan (journal user tidak tersimpan di host ini); laporkan, jangan dihitung lolos.

### 8.4 Agent

Native:

```sh
systemctl is-active sdr-doa-agent; systemctl is-enabled sdr-doa-agent
sudo journalctl -u sdr-doa-agent -n 50 --no-pager
sudo stat -c '%a %U:%G %n' /etc/sdr-doa-agent/agent.env
```

**Hasil**: `active`, `enabled`; journal memuat baris start service (`Started sdr-doa-agent.service - SDR-DoA edge agent ...` atau `Started SDR-DoA edge agent ...`), tanpa baris `run-agent:` dan tanpa `agent_error` yang berulang; `640 root:<grup service> /etc/sdr-doa-agent/agent.env`. `-- No entries --` atau `Hint: You are currently not seeing messages ...` berarti pemeriksaan belum dilakukan (jalankan dengan `sudo`), bukan lolos.

Docker:

```sh
sudo /usr/local/bin/sdr-doa-docker status --dir /opt/sdr-doa-agent
cd /opt/sdr-doa-agent && sudo docker compose ps && sudo docker compose logs --tail 50 agent
```

**Hasil**: `container:   running, health none, restarts 0, image 2.0.0 (<id>)`; container `Up`; log tanpa baris `run-agent:` dan tanpa `agent_error` yang berulang.

Ujung ke ujung untuk Kontrol (di host console). Yang menjawab Kontrol adalah RDF Node di RDF-SDR (topik `sdr/v2/uav-01`), bukan agent bawaan di atas:

```sh
curl -s --noproxy '*' http://127.0.0.1:8787/api/mqtt/config-reported \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); n=d.get("node") or {}; s=d.get("settings") or {}; print(d["broker"]["connection"], n.get("sid"), d["base_rev"], n.get("health_fresh"), s.get("matches_state_cfg"), d["code"])'
```

**Hasil**: `connected <8 digit hex> <angka> True <True atau None> None`. `sid` `None` berarti belum ada `state` RDF Node di broker yang sama; `base_rev` `None` berarti `state.cfg` RDF-SDR masih kosong; `health_fresh` `False` berarti `telemetry/health` lebih tua dari 8 detik. Kontrol baru bisa Kirim bila ketiganya terisi dan health segar. Kolom kelima `True` berarti `settings/reported` revisi sekarang sudah diterima (setelah **Baca settings** di Kontrol); `None` tidak menghalangi patch, tetapi tanpa listener TLS untuk RDF-SDR (2.3) nilainya tetap dari Data Out (cadangan).

Opsional di Raspberry, bila `mosquitto-clients` ada: `mosquitto_sub -h 127.0.0.1 -p 1883 -t 'sdr/v1/uav-01/#' -v -C 3 -W 30` menampilkan pesan dari `sdr/v1/uav-01/telemetry/health`, `state` atau `config/reported`.

### 8.5 Laporan akhir ke manusia

Satu blok singkat berisi:
- peran host, jalur (A/B/C/D), versi terpasang;
- direktori instalasi dan data;
- kanal image (Docker) dan status update otomatis (jam di zona host dan di zona manusia bila berbeda, timer aktif atau baris cron yang harus ditambah);
- agent: user service (`install-info` `AGENT_USER` atau `agent runs as`), `ENABLE_CONFIG`, status kata sandi MQTT (terisi/kosong, tanpa nilainya);
- status kata sandi admin (`set`/`default`/`disabled`), tanpa nilainya;
- mode LAN lihat-saja (6.2): mati, atau terbuka di alamat mana dan untuk klien mana, dan siapa yang mengatur firewall-nya;
- sumber data Dashboard dari 8.1 langkah 6 (`mqtt` atau `data_out`, dengan alasannya);
- hasil 8.1–8.4 (yang lolos, yang tidak, dan yang belum bisa diperiksa);
- sisa pekerjaan untuk manusia: kata sandi, lingering, proxy, keputusan `ENABLE_CONFIG`, tunnel SSH, baris crontab.

---

## 9. Troubleshooting

| Gejala | Penyebab | Tindakan |
|---|---|---|
| `sha256sum: ... FAILED` atau `no file was verified` | Unduhan rusak, file salah, atau file tidak di direktori yang sama | Unduh ulang ke direktori kosong; masih gagal: berhenti. |
| `docker was not found (docker); install Docker Engine first` | Docker tidak terpasang | Berhenti; pemasangan Docker butuh keputusan manusia. |
| `sudo: a terminal is required to read the password` / `sudo: a password is required` | `sudo` butuh kata sandi | Berhenti (4.9). Jangan pernah mengetik kata sandi sudo. |
| `sudo: sdr-doa-docker: command not found` | `secure_path` sudo tanpa `/usr/local/bin` | Pakai path lengkap `sudo /usr/local/bin/sdr-doa-docker ...`. |
| `cannot reach the Docker daemon: is it running, and may this user use it (root, or the docker group)?` | Daemon mati atau user tanpa izin | `sudo systemctl status docker`; jalankan dengan `sudo`. |
| `docker-compose 1.x is not supported; install Compose v2 (the docker compose plugin)` / `Docker Compose was not found: ...` | Plugin `docker compose` (v2 atau lebih baru) tidak ada; hanya `docker-compose` 1.x | Berhenti; pasang plugin compose (keputusan manusia). |
| `error: cannot read /opt/.../.env (mode 0600); run with sudo` | Instalasi root dijalankan tanpa sudo | Ulangi dengan `sudo`. |
| `... compose.yml was not written by sdr-doa-docker; move it away or pass --force` | Ada compose lain di DIR | Berhenti dan tanya; jangan `--force` tanpa izin. |
| `... holds the agent install; pick another --dir or pass --force` | Console dan agent di DIR yang sama | Pakai DIR default masing-masing. |
| `another sdr-doa-docker run (pid N) is working on DIR` | Update lain (mis. timer) sedang jalan | Tunggu, lalu ulangi. Tanpa pid: hapus `DIR/.sdr-doa-docker.lock` hanya bila pasti tidak ada run. |
| `FAILED: pull of ghcr.io/...: ... denied` / `unauthorized` | Package GHCR private, atau login `ghcr.io` lama yang kedaluwarsa | `sudo docker logout ghcr.io`, ulangi. Image publik tidak butuh login. |
| `FAILED: pull of ghcr.io/...: error pulling image configuration: download failed after attempts=6: Forbidden`, atau pull lambat / timeout | Proxy atau firewall menolak host blob GHCR `pkg-containers.githubusercontent.com` (`ghcr.io` sendiri bisa tetap terjangkau), atau Docker daemon tidak memakai proxy yang wajib | Cek 4.6 (baris `pkg-containers`). Host itu dibuka di proxy/firewall, atau proxy Docker daemon diatur, oleh manusia (4.7). Lalu ulangi A3/C2 (pengecualian di A0/C0). |
| `update` exit 1, `FAILED: ...: the health check reports unhealthy`, lalu `rolled back: ...` | Image baru tidak sehat; image lama jalan lagi | Baca baris `FAILED` di `DIR/update.log` dan `docker compose logs console`. Image dicatat di `.bad-images`; `--auto` melewatinya. Laporkan. |
| `rollback FAILED: ...` | Image lama juga tidak bisa start | Berhenti; `cd DIR && sudo docker compose logs console`; laporkan. |
| `deferred: Receiver recording or scan active` setiap malam | `receiver_busy` true (rekaman atau arsip pindai berjalan) | Normal; update jalan sendiri setelah 7 hari. Sekarang: `sudo /usr/local/bin/sdr-doa-docker update --yes` / `sdr-doa-console update --yes`, hanya dengan izin manusia. |
| `skipped: <ref> points to older <v> than the running <v>` | Tag kanal menunjuk versi lebih lama | Laporkan. `sudo /usr/local/bin/sdr-doa-docker update` di terminal menawarkannya. |
| `skipped: the console container is exited (stopped by hand?)` | Container di-stop manual | `--auto` tidak menyalakannya. Tanya manusia; `sudo /usr/local/bin/sdr-doa-docker update` menyalakannya. |
| `error: <path> is not owned by root or is writable by another user, so root's timer must not update DIR` | DIR atau script tidak root-only | Pasang di `/opt` sebagai root, atau pakai baris crontab user. |
| `error: the timer updates <dir> (one auto-update install per host)` | Timer sudah dipakai instalasi lain | Satu timer per host. `--force` memindahkannya (izin manusia). |
| Container keluar dengan kode 73, `/data is not writable by uid 10001` | Bind mount `/data` milik user lain | Pakai volume bawaan, atau `chown 10001:10001` direktori itu (izin manusia). |
| `warning: X in FILE has a $ outside single quotes` | Nilai dengan `$` tanpa kutip tunggal | Ubah jadi `X='...'`, lalu `docker compose up -d` di DIR. |
| `run install.sh as the desktop user, not root; ...` | `install.sh` console dijalankan sebagai root | Jalankan sebagai user biasa di sesi login user itu. |
| `Python 3.9 or newer is required, found ...` / `the Python venv module is missing (...)` | Python terlalu lama atau tanpa venv | `sudo apt install python3 python3-venv` (Debian/Ubuntu), izin manusia. |
| `pip could not install packaging/console/requirements.txt (network or proxy?)` | pip tidak bisa mengambil paket | Periksa proxy (4.7); tarball rilis membawa wheel di `wheels/`. |
| `the release files do not match MANIFEST.sha256; unpack the tarball again` | Ekstraksi rusak atau file diubah | Hapus direktori ekstrak, ekstrak ulang dari tarball yang lolos `sha256sum`. |
| `warning: port 8787 is already in use (another console?)` / `something else already answers on http://127.0.0.1:8787/` | Console lain (repo, native, Docker) jalan | Berhenti; jangan dua console di satu port. |
| Akses LAN `CLOSED` dengan `ADMIN_PASSWORD_DEFAULT`, log `lan_access is enabled but the LAN view stays closed: the default admin password is in use` | Kata sandi admin masih `123456` | A4/B3 (manusia mengetik kata sandi), lalu restart console; listener terbuka saat start. |
| Akses LAN `CLOSED` dengan `ADMIN_DISABLED` | `SDR_DOA_ADMIN_PASSWORD` kosong atau `.env` tidak terbaca | Pasang kata sandi admin (A4/B3). |
| Akses LAN `CLOSED` dengan `BIND_FAILED` (`EADDRINUSE`), log `the LAN view could not bind ...` | Port LAN dipakai program lain, misalnya forward `socat` lama | Hentikan forward lama (6.2 langkah 1); console mencoba bind lagi sendiri (paling lama tiap 60 detik). Atau pilih port lain, lalu Simpan lagi. |
| Akses LAN `CLOSED` dengan `BIND_FAILED` (`EADDRNOTAVAIL`) | Alamat bind bukan alamat host ini, atau antarmukanya belum mendapat alamat itu (setelah boot) | Bila IP itu memang milik antarmuka LAN host ini, tunggu: console mencoba bind lagi sendiri (paling lama tiap 60 detik) dan log mencatat `after a failed bind` saat terbuka. Bila bukan, pakai `0.0.0.0` atau IP antarmuka LAN host ini, lalu Simpan lagi. |
| Tablet mendapat `403` tanpa isi; log `LAN view refused <ip>: ...` | Alamat tablet tidak ada di Klien yang diizinkan | Tambahkan alamat atau jaringannya di kartu Akses LAN (keputusan manusia). |
| Tablet mendapat `403` `ORIGIN_REJECTED` | Dibuka lewat nama DNS biasa, proxy, atau nama `.local` yang bukan `<nama host>.local` (misalnya `<nama host>-2.local` setelah avahi mengganti nama) | Buka `http://<IP LAN>:8788/`. |
| Tablet kadang mendapat `503` tanpa isi; log `LAN view busy: 32 requests open ...` | 32 permintaan LAN berjalan sekaligus (banyak tablet atau tab) | Tutup tab yang tidak dipakai; console menjawab lagi begitu permintaan selesai. |
| Panel Spektrum atau rute Receiver di tablet menampilkan **SUMBER PUTUS** (`SOURCE LOST`) | Tidak ada post ke `/api/mirror/receiver` selama 10 detik: halaman console groundstation belum memasang Receiver, sudah ditutup atau dimuat ulang, atau lama tersembunyi; mode LAN baru dinyalakan (halaman groundstation memeriksanya tiap 10 detik) | Di groundstation buka console di `http://127.0.0.1:8787/`, buka rute Receiver sekali (atau Mulai di panel Spektrum), biarkan halaman di depan. Periksa dengan `curl` mirror di 6.2. |
| Tablet menampilkan `STALE` padahal RX berjalan | Halaman console groundstation tersembunyi atau diminimalkan (frame hanya dikirim selama halaman terlihat) | Tampilkan lagi halaman console di groundstation. |
| `no systemd user session here, so the console will not start at boot` | Installer tidak dijalankan di sesi login | Login sebagai user itu (SSH), ulangi B2. |
| Console native tidak jalan setelah reboot | Lingering mati | `loginctl show-user $USER -p Linger`; `sudo loginctl enable-linger $USER`. |
| `sdr-doa-console update ...` mencetak teks bantuan tanpa baris `update` dan keluar 64 | Instalasi lama tanpa updater | 5.6 E2. |
| `sdr-doa-console update: there is no terminal to ask; confirm with --yes` | Update tanpa TTY | Pakai `--auto` (7.2) atau `--yes` dengan izin. |
| `sdr-doa-console update: GitHub rate limit reached (HTTP 403); try again after ...` | Batas API anonim GitHub | Tunggu sampai waktu yang disebut. |
| `sdr-doa-console update: cannot reach api.github.com: ...` | Jaringan atau proxy | 4.6 dan 4.7 (user service: `environment.d`). |
| `sdr-doa-console update: ... belongs to another user; run the update as the user who installed it` | Updater dijalankan user lain atau root | Jalankan sebagai pemilik instalasi. |
| `sdr-doa-console update: another update is running` | Timer update sedang jalan | Tunggu; cek `journalctl --user -u sdr-doa-console-update -n 30 --no-pager`. |
| `... is left from an interrupted update and ... does not answer as ...` | Update terputus, `app.previous` tertinggal | Pesan itu memuat perintah pemulihan persisnya; jalankan hanya dengan izin manusia. |
| `X did not start here before and was rolled back; to try it again run: sdr-doa-console update --to X` | Rilis itu gagal di host ini | Laporkan; `--to X` mencoba lagi. |
| `<lama> is installed; <baru> changes the major version. ...` | Versi mayor baru | Keputusan manusia (`--allow-major`). |
| `run as root: sudo sh install.sh` (agent) | Installer agent tanpa sudo | Ulangi dengan `sudo`. |
| `the agent must not run as root; pick the owner of settings.json with --user` | Native: `--user` menunjuk root (uid 0). Docker `--enable-config`: direktori `_share` milik root, atau `--user 0:...` | Tanyakan user service yang benar (Docker: `--user UID:GID` bukan root). |
| `user X does not exist; create it or pick another with --user` | User service tidak ada | Tanyakan ke manusia. |
| `... must not contain spaces, quotes, backslashes, $ or backticks` | Nilai flag installer agent tidak diterima | Pakai nilai tanpa karakter itu, atau minta manusia mengisi lewat `sudoedit`. |
| Service agent berhenti dengan exit 78, `run-agent: ENABLE_CONFIG=1, but uid N cannot write ...` | Remote config aktif tetapi user tidak bisa menulis `settings.json` | Native: `sudo sh install.sh --enable-config --user <pemilik>` atau `--disable-config` (keputusan manusia). |
| Agent Docker: `the container restarted (exit code 78)`, log `run-agent: ENABLE_CONFIG=1, but uid ... cannot write ...` | `agent.env` berisi `ENABLE_CONFIG=1` (misalnya disalin dari native di 5.6 E3) tanpa mount `_share` | Ulangi C2 dengan `--enable-config --share-dir DIR` atau `--disable-config` (keputusan manusia). |
| Agent Docker restart terus, log `--mqtt-cafile could not be loaded: ...` | `MQTT_CAFILE` menunjuk file di host, yang tidak ada di container | Hanya bila broker memakai sertifikat dari CA publik (manusia memutuskan): `MQTT_TLS=1` dan `MQTT_CAFILE=` kosong, lalu `docker compose up -d` di DIR. CA privat: Jalur D (2.3). |
| `run-agent: NAME must be 0 or 1, got '...'` | Nilai `agent.env` salah | Perbaiki variabel itu, lalu native `sudo systemctl restart sdr-doa-agent`, Docker `cd /opt/sdr-doa-agent && sudo docker compose up -d`. |
| `the native RDF-SDR agent service (install-agent.sh) is installed, and two agents must not run at once; ...` | Agent native masih ada | 5.6 E3. |
| Monitor MQTT `ERROR` `MQTT monitor dependency paho-mqtt is not installed` | venv console native rusak | Pasang ulang rilis yang sama: tulis versi terpasang (`sdr-doa-console info`) ke `~/sdr-doa-dl/release-version`, lalu B1 dan blok "Upgrade manual" di 7.2 (dengan opsi yang tercatat). |
| Konfigurasi: `Pakai http://<host>:8081 dengan host dari daftar: ...` (`DATA_OUT_URL_NOT_ALLOWED`), atau console menolak start dengan `--base-url: the Data Out URL must be http://HOST:8081 with HOST in the Data Out host list (...)` | Host base URL tidak ada di daftar host Data Out (cadangan) | Tambahkan host di Konfigurasi → Koneksi & refresh, lalu Simpan bersama base URL. Docker sebelum start pertama: `SDR_DOA_SEED_DATA_OUT_HOSTS` (A2). |
| Kesehatan Sistem: "`<nama>.local` tidak bisa di-resolve, juga lewat mDNS" (`... could not be resolved (system and mDNS); use an IP address`) | Resolver sistem dan satu query mDNS tidak menemukan nama itu | Node mati, beda segmen jaringan, atau multicast diblok. Firewall host (misalnya ufw) juga bisa membuang jawaban node: jawaban itu datang lewat unicast dari UDP port 5353 ke port acak console, dan firewall tidak menganggapnya balasan. Membukanya hanya dengan izin manusia, misalnya ufw: `sudo ufw allow proto udp from 192.168.100.0/24 port 5353` **(contoh)**. Tanpa itu, pakai IP node di base URL (8.1 langkah 6). |
| Kontrol: Kirim nonaktif, `NODE_SESSION_UNAVAILABLE`, `NODE_NOT_FRESH`, `CONFIG_REVISION_UNKNOWN` | Belum ada `state` RDF Node, `telemetry/health` tidak segar, atau `state.cfg` kosong | 8.4 ujung ke ujung; RDF Node di RDF-SDR harus berjalan dan memakai broker yang sama (Monitor Pesan, tampilan RDF Node). |
| Kontrol: "Belum ada ACK" (`no_ack`) sekitar 20 detik setelah Kirim | Tidak ada jawaban di `sdr/v2/uav-01/ack/config` | RDF Node mati, broker lain. Agent bawaan repo ini tidak menjawab Kontrol. |
| Kontrol: `TLS_REQUIRED_FOR_SETTINGS_REPORT`, nilai "Data Out (cadangan)" | Koneksi RDF-SDR ke broker tanpa TLS | Listener TLS broker untuk RDF-SDR (2.3; keputusan manusia). Patch tetap bisa dikirim. |
| Kontrol: `Ditolak · REJECTED · CONFIG_REVISION_CONFLICT` atau `BUSY` | Settings berubah oleh pengirim lain, atau RDF-SDR masih mengerjakan perintah lain (misalnya dari `rdf-ground.service`) | Baca ulang nilai, tinjau, kirim lagi. Satu pengendali sekaligus (2.3). |
| Kontrol: `Ditolak · REJECTED · EXPIRED_OR_INVALID_DEADLINE` | Jam host console lebih dari 1 detik di depan jam RDF-SDR, atau perintah tiba setelah 15 detik | Periksa NTP di kedua host (laporkan ke manusia). |
| Kontrol: `FAILED · CONFIG_TARGET_NOT_READY` | RDF Node belum punya target settings yang disetujui | Keputusan manusia (aturan 1.1.7): `sudo rdf-node controls approve --settings` di RDF-SDR. |
| Kontrol: `publish_failed`, PUBACK ≥ 128 (135 "Not authorized") | ACL broker tidak mengizinkan console publish ke `sdr/v2/uav-01/cmd/config/patch` atau `cmd/config/get` | Konfigurasi broker (di luar repository ini). |
| Rekaman: "Open the Receiver from this console." (403 `ORIGIN_REJECTED`) | Dibuka lewat port-forward yang mengubah host atau port | Tunnel dengan port yang sama (6.1). Dari mode LAN (6.2) Rekaman memang tidak tersedia. |
| Basemap `BASEMAP UNAVAILABLE` / `BASEMAP PARTIAL` | Host tile tidak terjangkau dari host console | Log console `tiles <source>: upstream unavailable (...)`; 4.6, 4.7; cek `X-Tile-Cache` (8.1 langkah 7). Console Docker di jaringan yang keluar hanya lewat proxy tidak bisa mengambil tile (4.7): laporkan. |
| Chip SUMBER di strip status `Data Out (cadangan)` walaupun monitor MQTT `connected` | MQTT tidak segar; tooltip chip dan `source.reason` di `/api/snapshot` (8.1 langkah 6) menyebut sebabnya | `MQTT_NO_SESSION`: belum ada `state` RDF Node di broker ini (edge belum publish, atau broker lain). `MQTT_NO_HEALTH`/`MQTT_HEALTH_STALE`: tidak ada `telemetry/health` dalam 8 detik (edge berhenti, link putus, atau health ditolak; lihat tabel topik di Monitor Pesan). `MQTT_DAQ_NOT_HEALTHY`: DAQ node tidak sehat, detailnya di Data Out. Laporkan; Dashboard tetap jalan dari Data Out. |
| Chip SUMBER `MQTT`, chip DOA `UNVERIFIED`, tanpa bearing | RDF-SDR hanya mengirim DoA `ok=0` dan Angular `flags` selain 63 (konfigurasi edge default: authority dan sudut belum diverifikasi) | Sesuai desain: nilai yang belum diverifikasi hanya tampil di Diagnostik DoA dan Monitor Pesan. Verifikasi di edge keputusan manusia; laporkan. DOA `INCOMPLETE` dengan `MQTT_ANGULAR_UNAVAILABLE`: profile stream edge `control` (tanpa Angular). |
| Pengaturan tampak tidak tersimpan setelah restart | Console dijalankan dengan `--base-url`/`--mqtt-*` | Hapus flag itu dari perintah; ubah di Konfigurasi. |
| Data Out tidak terjangkau dan MQTT tanpa pesan dari RDF-SDR; journal `t900-ground-ppp.service` berisi `LCP: timeout` | Link PPP lewat T900 ke RDF-SDR putus (di luar console) | Bila `packaging/ground-link` terpasang: `sudo t900-ground-diag -o /tmp` dan `t900-link status`, lalu laporkan. Prosedur insiden di `packaging/ground-link/README.md` (restart, usbreset, cabut-colok) hanya dengan izin manusia. |
| UI lama setelah update | Halaman lama masih di browser | Muat ulang halaman. |

---

## 10. Uninstall

Semua uninstall di bawah **mempertahankan data**, kecuali perintah yang ditandai PURGE. PURGE hanya dengan konfirmasi eksplisit manusia untuk perintah itu (aturan 1.1.6). Sarankan backup dulu. Untuk console native dan agent native, PURGE **menggantikan** uninstall biasa, bukan langkah sesudahnya (uninstall biasa menghapus alat yang dipakai PURGE): tentukan dengan manusia sebelum menjalankan salah satunya.

### 10.1 Console Docker

```sh
sudo /usr/local/bin/sdr-doa-docker auto-update off
cd /opt/sdr-doa-ground-console && sudo docker compose stop console
```

**Periksa**: `auto-update off` (atau `auto-update is already off`; hanya bila timer milik instalasi ini), lalu container berhenti.

Backup volume (data, termasuk `/data/.env` dengan kata sandi; simpan privat). Memakai image console yang sudah ada di host, jadi tidak perlu Docker Hub; jalankan sebelum image dihapus:

```sh
mkdir -p ~/sdr-doa-backup &&
IMG=$(sudo sed -n 's/^SDR_DOA_IMAGE=//p' /opt/sdr-doa-ground-console/.env | tail -n 1) &&
T=$(sudo sed -n 's/^SDR_DOA_IMAGE_TAG=//p' /opt/sdr-doa-ground-console/.env | tail -n 1) &&
sudo docker run --rm --user 0 --entrypoint tar \
  -v sdr-doa-ground-console_sdr-doa-data:/data:ro -v "$HOME/sdr-doa-backup":/backup \
  "${IMG:-ghcr.io/sanadunt/sdr-doa-ground-console}:${T:-2}" -C /data -czf /backup/sdr-doa-data.tar.gz . &&
sudo chown "$(id -u):$(id -g)" ~/sdr-doa-backup/sdr-doa-data.tar.gz &&
chmod 600 ~/sdr-doa-backup/sdr-doa-data.tar.gz &&
tar -tzf ~/sdr-doa-backup/sdr-doa-data.tar.gz | grep -c '^\./console\.json$'
```

**Periksa**: `1`. Bila console tidak di-uninstall: `cd /opt/sdr-doa-ground-console && sudo docker compose start console`.

Uninstall (hapus container; volume tetap):

```sh
cd /opt/sdr-doa-ground-console && sudo docker compose down
```

**Periksa**: `sudo docker ps -a --filter label=com.docker.compose.project=sdr-doa-ground-console` kosong; `sudo docker volume ls | grep sdr-doa-data` masih ada.

Membersihkan program (data tetap di volume): `sudo docker image rm ghcr.io/sanadunt/sdr-doa-ground-console:2 ghcr.io/sanadunt/sdr-doa-ground-console:sdr-doa-previous` (tag yang ada saja), lalu hapus `/opt/sdr-doa-ground-console` dan `/usr/local/bin/sdr-doa-docker` bila manusia setuju (script itu juga dipakai agent Docker di host yang sama).

PURGE (menghapus semua pengaturan, rekaman, dan cache tile; jalan juga setelah `down` biasa, tetapi sebelum `/opt/sdr-doa-ground-console` dihapus, karena butuh `compose.yml` di sana):

```sh
cd /opt/sdr-doa-ground-console && sudo docker compose down -v
```

### 10.2 Console native

Backup (console berhenti sebentar agar `receiver.sqlite3` tersalin utuh; direktori data lain: lihat `Data:` dari `sdr-doa-console info`):

```sh
~/.local/bin/sdr-doa-console stop &&
mkdir -p ~/sdr-doa-backup &&
tar -C ~/.local/share -czf ~/sdr-doa-backup/sdr-doa-data.tar.gz \
  --exclude=sdr-doa-ground-console/app --exclude=sdr-doa-ground-console/app.previous sdr-doa-ground-console &&
chmod 600 ~/sdr-doa-backup/sdr-doa-data.tar.gz &&
tar -tzf ~/sdr-doa-backup/sdr-doa-data.tar.gz | grep -c '^sdr-doa-ground-console/console\.json$'
```

**Periksa**: `Ground Console stopped`, lalu `1`. Bila console tidak di-uninstall: `~/.local/bin/sdr-doa-console start`.

Uninstall biasa:

```sh
~/.local/bin/sdr-doa-console uninstall
```

**Periksa**: `Removed the console; saved data stays in /home/<user>/.local/share/sdr-doa-ground-console`. Program, service, timer update, `app.previous`, menu dan perintah `sdr-doa-console` terhapus.

PURGE, **sebagai pengganti** uninstall biasa (tanpa TTY butuh `--yes`; dengan TTY bertanya `Delete all saved settings, Receiver records and cached map tiles in ...? [y/N]`):

```sh
~/.local/bin/sdr-doa-console uninstall --purge --yes
```

**Periksa**: `Removed the console and its data`. Bila uninstall biasa sudah dijalankan dan manusia kemudian meminta data dihapus, perintah di atas tidak ada lagi (`No such file or directory`); hapus direktori data langsung: `rm -rf ~/.local/share/sdr-doa-ground-console` (atau direktori `Data:` yang tercatat).

### 10.3 Agent Docker

```sh
sudo /usr/local/bin/sdr-doa-docker auto-update off       # hanya bila timer milik instalasi ini
cd /opt/sdr-doa-agent && sudo docker compose down
```

PURGE: `cd /opt/sdr-doa-agent && sudo docker compose down -v` (volume `sdr-doa-agent_agent-state`; jalan juga setelah `down` biasa), lalu hapus `/opt/sdr-doa-agent` (berisi `agent.env` dan, dengan `--enable-config`, `state/`).

### 10.4 Agent native

Catat dulu user service (untuk laporan, dan untuk PURGE yang mungkin diminta kemudian):

```sh
grep -E '^(AGENT_USER|CREATED_USER)=' /opt/sdr-doa-agent/install-info
```

Uninstall biasa:

```sh
sudo sh /opt/sdr-doa-agent/uninstall.sh
```

**Periksa**: `Removed the agent from /opt/sdr-doa-agent` dan `Kept /etc/sdr-doa-agent/agent.env and /var/lib/sdr-doa-agent (remove them with --purge)`. `/opt/sdr-doa-agent` (dengan `uninstall.sh` dan `install-info`) ikut hilang.

PURGE, **sebagai pengganti** uninstall biasa (juga menghapus user service bila installer yang membuatnya, `CREATED_USER=1`):

```sh
sudo sh /opt/sdr-doa-agent/uninstall.sh --purge
```

Bila uninstall biasa sudah dijalankan dan manusia kemudian meminta data dihapus: `sudo rm -rf /etc/sdr-doa-agent /var/lib/sdr-doa-agent`, lalu `sudo userdel sdr-doa-agent` hanya bila catatan di atas berisi `AGENT_USER=sdr-doa-agent` dan `CREATED_USER=1`. Tanpa catatan itu: tanya manusia sebelum menghapus user apa pun.

---

## 11. Referensi cepat

### 11.1 Jalur dan file

| | A: Console Docker | B: Console native | C: Agent Docker | D: Agent native |
|---|---|---|---|---|
| Install | `sudo sh sdr-doa-docker install [--auto-update]` | `sh install.sh --yes ...` (user biasa) | `sudo sh sdr-doa-docker install --agent [--auto-update]` | `sudo sh install.sh ...` |
| Direktori | `/opt/sdr-doa-ground-console` (non-root: `~/sdr-doa-ground-console`) | program `~/.local/share/sdr-doa-ground-console/app` | `/opt/sdr-doa-agent` (non-root: `~/sdr-doa-agent`) | `/opt/sdr-doa-agent` |
| File pengaturan | `DIR/compose.yml` (jangan diedit), `DIR/.env` (0600: `SDR_DOA_IMAGE`, `SDR_DOA_IMAGE_TAG`, `SDR_DOA_PORT`, opsional `SDR_DOA_SEED_*`) | `app/install-options` | `DIR/compose.yml`, `DIR/.env`, `DIR/agent.env` (0600) | `/etc/sdr-doa-agent/agent.env` (0640) |
| Data | volume `sdr-doa-ground-console_sdr-doa-data` di `/data` | `~/.local/share/sdr-doa-ground-console` | volume `sdr-doa-agent_agent-state` atau `DIR/state` | `/var/lib/sdr-doa-agent` |
| Kata sandi admin | `/data/.env` lewat `docker compose exec console sdr-doa-set-admin-password` | `DATA/.env` lewat `sdr-doa-console password` | — | — |
| Isi direktori data console | `console.json`, `branding.json`, `preferences.json`, `receiver/`, `tiles/`, `.env` | sama, ditambah `seed.env` (sampai start pertama), `update-state.json`, `.update.lock`, `console.log`/`console.pid` (tanpa systemd), `update.log` (hanya cron) | | |
| Service | container `console`, `restart: unless-stopped`, uid 10001 | `~/.config/systemd/user/sdr-doa-ground-console.service` | container `agent`, uid 10001 atau pemilik `_share` | `/etc/systemd/system/sdr-doa-agent.service` |
| Perintah | `/usr/local/bin/sdr-doa-docker` (non-root `~/.local/bin/sdr-doa-docker`) | `~/.local/bin/sdr-doa-console` | `/usr/local/bin/sdr-doa-docker` | `/opt/sdr-doa-agent/bin/run-agent`, `/opt/sdr-doa-agent/uninstall.sh` |
| Log | `cd DIR && sudo docker compose logs --tail 50 console`; `DIR/update.log` | `journalctl --user -u sdr-doa-ground-console.service -n 50 --no-pager` (`sdr-doa-console logs` mengikuti log terus dan tidak selesai); `journalctl --user -u sdr-doa-console-update -n 30 --no-pager` | `cd DIR && sudo docker compose logs --tail 50 agent`; `DIR/update.log` | `sudo journalctl -u sdr-doa-agent -n 50 --no-pager` |
| Update | `sudo /usr/local/bin/sdr-doa-docker update --dir /opt/sdr-doa-ground-console [--check\|--auto\|--yes]` | `sdr-doa-console update [--check\|--auto\|--yes\|--to X.Y.Z\|--allow-major]` | `sudo /usr/local/bin/sdr-doa-docker update --dir /opt/sdr-doa-agent [--check\|--auto\|--yes]` | installer rilis baru dengan `--user` tercatat (7.4) |
| Rollback | `sudo /usr/local/bin/sdr-doa-docker rollback --dir /opt/sdr-doa-ground-console` | otomatis bila gagal; `update --to <lama>` | `sudo /usr/local/bin/sdr-doa-docker rollback --dir /opt/sdr-doa-agent` | installer rilis lama |
| Timer update | `/etc/systemd/system/sdr-doa-docker-update.{service,timer}`, default 03:30 | `~/.config/systemd/user/sdr-doa-console-update.{service,timer}`, default 03:45 | sama dengan A (satu per host) | — |
| Status | `sudo /usr/local/bin/sdr-doa-docker status --dir /opt/sdr-doa-ground-console` | `sdr-doa-console status`, `info`, `auto-update status` | `sudo /usr/local/bin/sdr-doa-docker status --dir /opt/sdr-doa-agent` | `systemctl status sdr-doa-agent --no-pager` |
| File lain di DIR | `update.log`, `.bad-images`, `.deferred-since`, `.sdr-doa-docker.lock/` (selama run) | `app.previous` (selama update) | `update.log`, `.bad-images` | `install-info` |

### 11.2 Port dan alamat

| | Nilai |
|---|---|
| Console | `127.0.0.1:8787` (hanya loopback) |
| Mode LAN lihat-saja | mati secara default; bila dinyalakan manusia (6.2): `<bind>:8788` (default), hanya untuk klien yang diizinkan, baca-saja |
| Health | `GET http://127.0.0.1:8787/api/health` → `{"ok": true, "receiver_busy": false, "version": "<V>"}` (rilis dengan mode LAN: juga `"lan_access"`) |
| Data Out (dibaca console) | `http://<host>:8081`, `<host>` dari daftar `data_out_hosts` di `console.json` (default `doasdr.local`, `192.168.100.100`, `127.0.0.1`, `localhost`; paling banyak 16); default `http://doasdr.local:8081`. Nama `.local` yang tidak bisa diresolusi resolver sistem dicoba lewat satu query mDNS. |
| MQTT console | default `10.90.0.1:9001`, `websockets`, path `/mqtt`; tanpa TLS dan kredensial |
| MQTT agent | default `127.0.0.1:1883`, TCP, MQTT 3.1.1 |
| Topik | RDF Node `sdr/v2/uav-01/...`: Kontrol ke `sdr/v2/uav-01/cmd/config/patch` dan `cmd/config/get` (QoS 1, 15 detik), ACK di `sdr/v2/uav-01/ack/config`, settings di `sdr/v2/uav-01/settings/reported`; agent bawaan di topik lama `sdr/v1/uav-01/...` |

### 11.3 URL, image, dan tag

| | |
|---|---|
| Rilis terbaru | `https://github.com/sanadunt/sdr-doa-ground-control/releases/latest` |
| Aset (nama tetap) | `https://github.com/sanadunt/sdr-doa-ground-control/releases/latest/download/sdr-doa-docker`, `.../SHA256SUMS` |
| Aset (versi) | `https://github.com/sanadunt/sdr-doa-ground-control/releases/download/v<V>/sdr-doa-ground-console-<V>-linux.tar.gz`, `.../sdr-doa-rdf-sdr-agent-<V>.tar.gz` |
| API rilis (updater native) | `https://api.github.com/repos/sanadunt/sdr-doa-ground-control/releases/latest` |
| Image console | `ghcr.io/sanadunt/sdr-doa-ground-console` (`linux/amd64`, `linux/arm64`) |
| Image agent | `ghcr.io/sanadunt/sdr-doa-rdf-sdr-agent` (`linux/amd64`, `linux/arm64`, `linux/arm/v7`) |
| Tag | `<V>` (mis. `2.0.0`), `<MAJOR>.<MINOR>` (`2.0`), `<MAJOR>` (`2`, kanal default), `latest`; prerelease hanya `<V>` |
| Tag lokal image sebelumnya | `sdr-doa-previous` |
| Label versi image | `org.opencontainers.image.version` |
| Manual (di tarball console) | `docs/manual/Panduan_Penggunaan_SDR-DoA_Ground_Console.pdf` (Lampiran F: host tile) |

### 11.4 Variabel environment

| Variabel | Di mana | Arti |
|---|---|---|
| `SDR_DOA_ADMIN_PASSWORD` | `/data/.env` atau `DATA/.env` (lewat alat kata sandi) | kosong = login admin mati; tidak ada = `123456` |
| `SDR_DOA_SEED_DATA_OUT_HOSTS` (dipisah koma), `SDR_DOA_SEED_BASE_URL`, `_MQTT_HOST`, `_MQTT_PORT`, `_MQTT_TRANSPORT`, `_MQTT_WS_PATH`, `_REFRESH_SECONDS` | Docker: `DIR/.env` sebelum start pertama; native: flag `install.sh` (`--data-out-hosts`, `--base-url`, ...) → `seed.env` | hanya bila `console.json` belum ada |
| `SDR_DOA_IMAGE`, `SDR_DOA_IMAGE_TAG`, `SDR_DOA_PORT` | `DIR/.env` (Docker) | image, kanal, port; ditulis `install` |
| `SDR_DOA_HEALTH_TIMEOUT` (180), `SDR_DOA_HEALTH_INTERVAL` (2), `SDR_DOA_AGENT_SETTLE` (20) | environment saat menjalankan `sdr-doa-docker` | khusus kasus tertentu; jangan diubah tanpa alasan |
| `BASE_URL`, `MQTT_HOST`, `MQTT_PORT`, `MQTT_TLS`, `MQTT_CAFILE`, `MQTT_USERNAME`, `SDR_DOA_MQTT_PASSWORD`, `PUBLISH`, `ENABLE_CONFIG`, `SETTINGS_PATH`, `STATE_DIR`, `CLOCK_SOURCE`, `AUTHORITY`, `HEALTH_INTERVAL`, `DOA_RATE`, `STATE_INTERVAL`, `POLL_INTERVAL`, `COLLECT_BUDGET` | `agent.env` | pengaturan agent (lihat `packaging/agent/agent.env.example`) |
