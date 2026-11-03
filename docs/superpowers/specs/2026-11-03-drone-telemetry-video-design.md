# Telemetry dan video drone SIYI di Ground Console — Desain

Tanggal: 2026-11-03. Disetujui owner di percakapan ("semua aku approve"); keputusan yang diambil
builder ditandai **[keputusan builder]**.

## Maksud

RDF-SDR (Raspberry + KrakenSDR) terbang di dalam drone SIYI. Di dalam drone, Raspberry lebih sering
kena interferensi, sedangkan flight controller drone punya GPS RTK dan yaw yang lebih bagus. Remote
SIYI MK32 menjalankan SIYI Bridge (`siyi-drone-paket/RANGKUMAN.md`). Bridge ini menerbitkan telemetry
MAVLink di MQTT `:1883` (topic `drone/*` dan `bridge/link`, semua retained) dan me-relay kamera HEVC
720p30 di `rtsp://<remote>:8554/main.264`.

Tujuannya: telemetry dan video drone masuk ke **console groundstation yang sudah ada**. Dashboard SIYI
(Next.js, gateway Node) tidak dipasang; yang diambil adalah datanya.

## Sasaran

1. Console membaca telemetry drone dari broker remote (subscribe saja) dan menampilkannya:
   - di peta Dashboard: marker drone dengan heading dan jejak terbang;
   - di kartu drone: mode, ARMED, baterai, GPS/RTK, ketinggian, kecepatan, attitude;
   - di System Health: kartu "Telemetry drone" dan "Video drone".
2. Video kamera drone tampil di Dashboard dan di LAN view (tablet). Service mediamtx + ffmpeg
   berjalan di host, terpisah dari container console.
3. GPS dan kompas **mengutamakan drone**, dengan RDF-SDR sebagai cadangan. **Kedua sumber tetap
   tampil berdampingan**, termasuk selisih posisi dan heading, supaya operator tahu bila salah satunya
   keliru.
4. IP remote ditemukan otomatis (IP remote bisa berganti karena DHCP), dengan pilihan IP tetap.

## Bukan sasaran (kali ini)

- **Mematikan GPS/kompas Raspberry** dan memintanya hidup lagi saat data drone hilang. Owner menunda
  ini sampai drone terbukti andal. Raspberry tetap mengirim nav seperti sekarang; tidak ada perubahan
  di repo Raspberry.
- Mengirim perintah apa pun ke drone. Aturan ini **tetap**: tidak publish ke `drone/*` dan tidak ada
  MAVLink dari console.
- Perbaikan SIYI Bridge (CRC, Prompt 4) dan aplikasi Android-nya: repo lain, perlu `adb install`.
- Rekam video drone ke disk: lanjutan (lihat "Lanjutan").
- Posisi sampel DoA untuk estimasi posisi tetap dari edge (`lat`/`lon` per sampel), belum diganti
  posisi drone.

## Anti-sasaran

- Bearing DoA yang belok karena yaw drone dari waktu yang salah. Yaw drone **hanya** dipakai bila
  ada sampel yaw dalam ±1 s dari waktu sampel DoA; selain itu bearing kembali ke heading edge dan
  label sumbernya mengatakan begitu.
- GPS remote (bukan drone) terbaca sebagai posisi drone. Posisi drone hanya dari `drone/position`
  dengan `sysid` FC, dan hanya dengan fix GPS ≥ 3D. Selisih yang besar dengan GPS RDF-SDR ditampilkan.
- Console 8787 ikut berubah. Port console **tetap 8787** (keputusan owner).

## Aturan yang dilonggarkan (keputusan owner 2026-11-03)

Sistem ini berjalan peer-to-peer, tanpa internet. Owner melonggarkan aturan loopback untuk sistem ini:

- Console membuka **koneksi keluar kedua**: klien MQTT ke broker remote SIYI. Klien ini hanya
  subscribe. Dengan host `auto`, console memindai subnet IPv4-nya sendiri (TCP 1883).
- Service video membuka WebRTC ke LAN: TCP 8889 (WHEP lewat proxy console, lihat di bawah) dan
  UDP 8189 (media). RTSP lokal 8654 dan API mediamtx 9997 tetap hanya 127.0.0.1.
- LAN view mendapat dua route baru untuk video: `POST /api/drone/video/whep` (tawaran SDP) dan
  `DELETE /api/drone/video/whep/<sesi>`. Keduanya membaca video saja dan tidak mengubah apa pun di
  drone, groundstation, atau RDF-SDR.

## Bagian

### 1. `tools/drone_link.py` (stdlib + paho, pola `ground_gps.py`)

- `DroneLink(host, port=1883)`: klien paho MQTT 3.1.1 sendiri, terpisah dari `MqttMonitor`.
  Subscribe ke daftar topic yang **eksplisit**, bukan `drone/#`, karena bridge menerbitkan ratusan
  topic sampah retained `drone/other/*`:
  `drone/status`, `drone/battery`, `drone/gps`, `drone/position`, `drone/attitude`, `drone/hud`,
  `drone/statustext`, `bridge/link`. Tidak pernah publish. Reconnect 1–10 s.
- Pembacaan longgar (`docs/PRINSIP_DATA.md`): payload > 4096 byte atau bukan objek JSON ditolak dan
  dihitung. Field yang salah tipe atau di luar rentang dibaca null dengan catatan
  `INVALID_FIELD:<nama>`. Nilai "tidak diketahui" MAVLink dibuang: `heading_deg` 655.35 / ≥ 360,
  `hdop` 99.99, `lat`/`lon` 0/0, `alt` di luar −1000..20000 m.
- Waktu: payload tidak membawa timestamp, jadi tiap topic memakai waktu terima console. Basi setelah
  10 s (jeda data asli sampai ~5,5 s).
- Riwayat yaw 60 s (dari `drone/attitude.yaw_deg`, cadangan `drone/position.heading_deg`) untuk
  `heading_at(t_ms)`: interpolasi sudut terpendek antara dua sampel, hanya bila sampel terdekat
  ≤ 1000 ms dari `t_ms`.
- `view(now_ms)` → blok `drone` (bentuk di bawah).

### 2. Penemuan IP remote (`tools/drone_discovery.py`)

- `drone.host` di `console.json`: `"auto"` (default) atau IP literal.
- Auto:
  1. Coba dulu IP terakhir yang berhasil (disimpan di `drone.last_host` pada `console.json`).
  2. Lalu pindai /24 dari setiap alamat IPv4 antarmuka yang aktif (TCP connect 1883, timeout 300 ms,
     maksimal 64 paralel).
  3. Kandidat yang terbuka disambung lewat MQTT dan subscribe `bridge/link`. Kandidat valid hanya
     bila dalam 2 s mengirim `bridge/link` dengan `fc_online` boolean dan `version` string. Broker
     groundstation sendiri dan broker lain tertolak.
  4. Bila ada beberapa: pilih yang `fc_online=true`, lalu IP terkecil.
- Pindai ulang bila MQTT ke remote putus > 15 s. Hasilnya `discovery` di blok `drone`: `mode`,
  `host`, `scanning`, `last_scan_at_ms`, `candidates`.
- Fungsi pemindaian murni dengan injeksi `connect`/`probe`, supaya bisa diuji tanpa jaringan.
  Daftar antarmuka memakai `multicast_interface_addresses()` di Linux; di luar Linux pakai alamat
  dari `socket.getaddrinfo(gethostname())`.

### 3. API console

- `GET /api/drone`: blok `drone` lengkap. Ada di kedua listener; di LAN view memakai aturan baca LAN.
- Setiap `/api/snapshot` mendapat blok `drone` di level atas (`with_drone()`, pola `with_ground_gps`).
  Isinya sama dengan `/api/drone` plus `heading_at_doa`: yaw drone pada waktu sampel DoA MQTT,
  dihitung saat menjawab, `{deg, offset_ms, doa_timestamp_ms}` atau null.
- Konfigurasi `drone` di `console.json`:
  `{enabled: true, host: "auto", port: 1883, array_heading_offset_deg: 0, video: {enabled: true}}`.
  Disimpan lewat `POST /api/console-config`, dengan Origin loopback yang sama seperti field lain.
  `array_heading_offset_deg` (−180..180) adalah sudut antara acuan array dan hidung drone.
- `GET /api/drone/video`: kesehatan service video, dibaca dari API mediamtx `127.0.0.1:9997`
  (`/v3/paths/list`): path `raw` (kamera) dan `drone` (H.264) ready/tidak, jumlah pembaca, byte
  masuk. Hasilnya `{state: OK|NO_CAMERA|NO_ENCODER|DOWN|DISABLED, ...}`.
- Proxy WHEP: `POST /api/drone/video/whep` meneruskan SDP offer (≤ 64 KiB, `application/sdp`) ke
  `http://127.0.0.1:8889/drone/whep` dan mengembalikan answer. `Location` ditulis ulang ke
  `/api/drone/video/whep/<id>`. `DELETE` ke path itu diteruskan juga. Karena lewat console, CSP
  halaman tetap `connect-src 'self'` dan tablet tidak perlu tahu port 8889. Media WebRTC tetap UDP
  8189 langsung ke host.

Bentuk blok `drone` (semua angka null bila tidak diketahui):

```json
{
  "enabled": true,
  "connection": "connected|connecting|disconnected|searching|disabled|error",
  "host": "192.168.1.162", "port": 1883, "last_error": null,
  "discovery": {"mode": "auto", "scanning": false, "last_scan_at_ms": 0, "candidates": []},
  "link": {"present": true, "age_ms": 800, "stale": false, "fc_online": true, "camera_online": true,
           "frames_per_s": 41.0, "version": "0.1.0", "uptime_s": 120},
  "state": "LIVE|STALE|NO_DATA|DISABLED",
  "position": {"lat": -6.9, "lon": 107.6, "alt_msl_m": 712.0, "alt_rel_m": 25.0,
               "speed_ms": 3.1, "heading_deg": 87.0, "age_ms": 300, "stale": false},
  "gps": {"fix": 6, "fix_name": "RTK_FIXED", "rtk": "FIXED|FLOAT|NONE", "satellites": 22,
          "hdop": 0.6, "age_ms": 900, "stale": false},
  "attitude": {"roll_deg": 1.2, "pitch_deg": -0.4, "yaw_deg": 87.3, "age_ms": 200, "stale": false},
  "battery": {"voltage_v": 6.1, "current_a": 0.0, "remaining_pct": null, "age_ms": 900, "stale": false},
  "status": {"armed": false, "mode": 4, "system_status": 3, "age_ms": 900, "stale": false},
  "hud": {"groundspeed_ms": 0.0, "climb_ms": 0.0, "throttle_pct": 0, "age_ms": 900, "stale": false},
  "statustext": {"severity": 6, "text": "…", "age_ms": 5000},
  "heading": {"deg": 87.3, "source": "attitude|position", "age_ms": 200},
  "array_heading_offset_deg": 0,
  "heading_at_doa": {"deg": 87.1, "offset_ms": 120, "doa_timestamp_ms": 0},
  "invalid": 0, "last_invalid": null, "notes": []
}
```

### 4. Service video (`packaging/drone-video/`, pola `packaging/ground-gps/`)

- `drone-video-supervisor` (Python stdlib, `python3 -I`) menjalankan mediamtx sebagai proses anak:
  - Membaca `/etc/drone-video/drone-video.conf`: `CAMERA_URL` (`auto` → host dari console
    `GET http://127.0.0.1:8787/api/drone` + `:8554/main.264`), `ENCODER`
    (`auto|vaapi|x264|nvenc|v4l2m2m|videotoolbox`), `BITRATE`, `WEBRTC_ADDITIONAL_HOSTS`,
    `MEDIAMTX_BIN`, `FFMPEG_BIN`.
  - Menulis konfigurasi mediamtx (JSON = YAML valid): path `raw` (sumber kamera via TCP), path
    `drone` (ffmpeg transcode ke H.264 baseline, `-g 30 -bf 0`), WebRTC `:8889`, ICE UDP `:8189`,
    API `127.0.0.1:9997`, RTSP `127.0.0.1:8654`, HLS/RTMP/SRT mati.
  - Encoder `auto`: VAAPI bila `/dev/dri/renderD128` ada dan ffmpeg punya `h264_vaapi`, selain itu
    libx264 `-preset ultrafast -tune zerolatency`.
  - Bila host kamera berubah: konfigurasi ditulis ulang dan mediamtx dimulai ulang. SIGTERM
    menghentikan mediamtx dengan rapi.
- `drone-video.service`: `DynamicUser`, `SupplementaryGroups=render video` untuk VAAPI, restart
  always.
- `install.sh` / `uninstall.sh` dengan konvensi ground-gps: `--dry-run`, `--prefix`, `--root`,
  marker, `umask 022`. Mediamtx tidak diunduh installer; README menyebut rilis GitHub dan
  `apt install ffmpeg`.
- Ikut di tarball console (`DRONE_VIDEO_FILES`); tidak masuk app tree dan image.

### 5. Browser

- `lib/droneLink.ts`: `normalizeDrone()` (longgar), `droneStation()` (posisi drone yang boleh dipakai:
  LIVE, fix ≥ 3D, tidak basi), `droneHeadingAtDoa()`, selisih posisi/heading dengan RDF-SDR, dan
  label RTK.
- **Sumber GPS**: `GpsConfig.preferDrone` (bawaan nyala). Dengan sumber live, posisi drone dipakai
  dulu (`MapCoordinate.source` `DRONE`), lalu jalur RDF-SDR yang sekarang (Data Out/LoRa nav), lalu
  fallback. MANUAL dan FALLBACK yang dipilih tetap dihormati.
  **[keputusan builder]** dipilih sakelar, bukan mode baru dengan migrasi: pilihan lama yang tersimpan
  tidak punya field ini, jadi terbaca nyala (drone diutamakan, sesuai permintaan owner), dan operator
  bisa mematikannya di Konfigurasi → GPS & Kompas.
- **Sumber kompas**: `CompassConfig.preferDrone` (bawaan nyala): `compassOffset = heading_at_doa.deg +
  offset` (kode `DRONE_YAW`, label "DRONE YAW") bila ada, selain itu `NODE_HEADING` seperti sekarang.
  MANUAL tetap di atas segalanya. Kurva Angular ikut diputar sebesar putaran RDF-SDR antara frame-nya
  dan DoA.
- **[keputusan builder]** Data drone berumur sendiri (`droneCurrent()`, seperti GPS groundstation),
  terpisah dari kesegaran data RDF-SDR, supaya drone tetap di peta walau RDF-SDR atau link-nya mati.
- Peta: marker drone (cincin oranye dengan penunjuk arah hidung) di posisi drone, jejak 2000 titik
  (memori halaman), dan marker RDF-SDR GPS-nya sendiri tetap tampil kecil saat posisi stasiun berasal
  dari drone, dengan garis tipis dan jaraknya bila > 5 m.
- Kartu RDF-SDR (`NodeCard`): baris "GPS drone / GPS RDF-SDR / selisih" dan "Heading drone / heading
  RDF-SDR / selisih".
- Panel **Drone** baru di Dashboard (toggle "Drone" di top bar, preferensi panel):
  - video WHEP dengan overlay kecil (ALT rel, GS, heading, baterai), klik untuk memperbesar;
  - kartu ringkas: ARMED/DISARMED, mode, RTK, satelit, baterai, link bridge;
  - di LAN view sama, karena hanya membaca.
- System Health: kartu "Telemetry drone" (koneksi, host, umur tiap topic, `fc_online`, versi
  bridge, sampah ditolak) dan "Video drone" (state service, kamera, encoder, pembaca).
- i18n EN/ID untuk semuanya. Status code (`LIVE`, `STALE`, `RTK FIXED`) tidak diterjemahkan.

## Pengujian

- `tools/test_drone_link.py` (unittest): parsing setiap topic dengan payload contoh dari bridge
  (fixture `tools/fixtures/drone/`), nilai sampah, basi, `heading_at` (interpolasi, wrap 359→1,
  batas 1 s), view, `with_drone`, klien paho palsu, dan bahwa klien tidak pernah publish.
- `tools/test_drone_discovery.py`: subnet dari antarmuka, broker tanpa `bridge/link` tertolak,
  prioritas `fc_online`, IP terakhir dicoba dulu, pindai ulang setelah 15 s putus (jam palsu).
- `tools/test_drone_video.py`: route `/api/drone`, `/api/drone/video` (API mediamtx palsu di
  loopback), proxy WHEP (upstream palsu: body, content type, Location, DELETE, batas ukuran,
  upstream mati 502), LAN view mengizinkan dua route video dan route baca, konfigurasi `drone` di
  `console-config`, dan snapshot membawa `drone`.
- `tools/test_drone_video_kit.py`: konfigurasi mediamtx per encoder, pemilihan encoder auto, host
  kamera dari console palsu, restart saat host berubah, installer/uninstaller `--root`/`--dry-run`.
- Vitest: `lib/droneLink.test.ts`, sumber GPS/kompas, markup kartu dan panel.

## Lanjutan (bukan PR ini)

- Raspberry berhenti mengirim nav dan diminta hidup lagi saat data drone hilang (repo Raspberry + perintah baru).
- Posisi drone pada waktu sampel DoA untuk estimasi posisi.
- Rekam video + telemetry drone.
- Perbaikan CRC di SIYI Bridge (Prompt 4).
