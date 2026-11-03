# Video drone (drone-video-supervisor)

Kamera SIYI di drone mengirim HEVC 1280×720 30 fps lewat RTSP (`rtsp://<drone>:8554/main.264`). Browser tidak bisa memutar HEVC lewat WebRTC dengan andal, jadi groundstation mengubahnya menjadi H.264 dan menyajikannya lewat WebRTC (WHEP). Panel Drone di Dashboard console memutarnya.

`drone-video-supervisor` berjalan di host groundstation, di luar Docker (`packaging/drone-video`, ikut tarball console seperti `packaging/ground-gps`). Ia menjalankan [mediamtx](https://github.com/bluenviron/mediamtx) sebagai proses anak:

- path `raw`: mediamtx menarik kamera, selalu lewat TCP;
- path `drone`: ffmpeg yang dijalankan mediamtx membaca `raw`, meng-encode ke H.264 baseline (`-g 30 -bf 0`, tanpa audio) dan menerbitkannya kembali ke mediamtx;
- browser membaca `drone` lewat WebRTC.

| File | Isi |
|---|---|
| `drone-video-supervisor` | program (Python 3.9+, hanya pustaka standar): `run` (service), `check-config`, `print-config` (konfigurasi mediamtx yang akan ditulis) |
| `drone-video.service.in` | service systemd `drone-video.service` |
| `drone-video.conf.example` | pengaturan, dipasang sebagai `/etc/drone-video/drone-video.conf` |
| `install.sh`, `uninstall.sh` | pasang dan hapus |

## Cara kerjanya

- Dengan `CAMERA_URL=auto` (bawaan) supervisor bertanya ke console setiap 5 detik (`GET http://127.0.0.1:8787/api/drone`, tanpa proxy) dan memakai `host` drone yang ditemukan console sebagai `rtsp://<host>:8554/main.264`. Hanya alamat IP yang dipakai. Selama console belum tahu host drone, path `raw` tidak punya sumber dan path `drone` menunggu.
- Konfigurasi mediamtx ditulis (JSON, yang juga YAML valid) ke `/run/drone-video/mediamtx.yml` secara atomik, lalu mediamtx dijalankan dengan file itu.
- Host kamera berubah: konfigurasi ditulis ulang dan mediamtx dimulai ulang. mediamtx berhenti sendiri: dijalankan lagi setelah 2 detik, berlipat sampai 30 detik (kembali ke 2 detik setelah berjalan 60 detik).
- `SIGTERM` (`systemctl stop`) menghentikan mediamtx dengan rapi (SIGTERM, tunggu 5 detik, lalu kill) dan supervisor keluar dengan 0.
- Setiap perubahan (encoder, kamera, start, exit) tercatat satu baris di journal. User dan password di `CAMERA_URL` tidak pernah dicatat.

## Port

| Port | Alamat | Untuk |
|---|---|---|
| TCP 8889 | semua antarmuka | WebRTC/WHEP (signalling); console mem-proxy-nya, jadi Dashboard tidak memakainya langsung |
| UDP 8189 | semua antarmuka | media WebRTC, langsung dari browser ke host ini |
| TCP 8654 | `127.0.0.1` | RTSP lokal (`raw` dan `drone`) |
| TCP 9997 | `127.0.0.1` | API mediamtx, dibaca console |

Tablet di LAN butuh UDP 8189 terbuka di firewall host, dan TCP 8889 bila sebuah pemutar menghubungi mediamtx langsung (misalnya `sudo ufw allow 8189/udp && sudo ufw allow 8889/tcp`). Installer tidak mengubah firewall.

## Console

Dashboard tidak pernah berbicara ke port 8889. Console membaca keadaan video dari API mediamtx (`127.0.0.1:9997/v3/paths/list`) lewat `GET /api/drone/video`, dan mem-proxy WHEP di `POST /api/drone/video/whep` (dan `DELETE /api/drone/video/whep/<sesi>`) ke `http://127.0.0.1:8889/drone/whep`. Yang langsung ke host hanya media WebRTC lewat UDP 8189.

## Pasang mediamtx dan ffmpeg (Ubuntu 24.04)

Installer tidak mengunduh apa pun; pasang keduanya dulu:

```sh
sudo apt install ffmpeg
# mediamtx: tarball linux_amd64 (atau linux_arm64v8) dari https://github.com/bluenviron/mediamtx/releases
tar -xzf mediamtx_v*_linux_amd64.tar.gz mediamtx
sudo install -m 0755 mediamtx /usr/local/bin/mediamtx
mediamtx --version
ffmpeg -hide_banner -encoders | grep -E 'h264_(vaapi|nvenc|v4l2m2m)|libx264'
```

Untuk VAAPI di GPU Intel: `sudo apt install intel-media-va-driver vainfo` dan periksa dengan `vainfo --display drm --device /dev/dri/renderD128`.

## Pasang

```sh
sudo sh packaging/drone-video/install.sh --dry-run     # lihat dulu file dan perintahnya
sudo sh packaging/drone-video/install.sh
```

Butuh `/bin/sh`, `python3`, systemd, serta grup `render` dan `video` (Ubuntu sudah punya keduanya). Installer menulis `/etc/drone-video/drone-video.conf` dari contohnya pada pemasangan pertama dan mempertahankannya sesudahnya, memeriksa pengaturan dengan supervisor sendiri (pengaturan yang tidak terbaca menghentikan install), memperingatkan (tidak berhenti) bila `mediamtx` atau `ffmpeg` tidak ditemukan, lalu `systemctl daemon-reload`, `enable` dan `restart` `drone-video.service`. Menjalankannya lagi berarti upgrade.

| Opsi | Arti |
|---|---|
| `--prefix DIR` | lokasi program (bawaan `/usr/local`): `DIR/bin/drone-video-supervisor`, `DIR/share/drone-video/`; `bin`, `share/drone-video` dan setiap direktori di atasnya harus milik root dan tidak bisa ditulis user lain |
| `--dry-run` | tampilkan file dan perintah, tidak mengubah apa pun; berakhir dengan exit 1 bila install akan berhenti |
| `--root DIR` | pasang di bawah DIR tanpa `systemctl` (untuk test) |

Installer hanya menulis file miliknya sendiri (bertanda `packaging/drone-video`) dan menolak mengganti file lain dengan nama yang sama. Ia tidak menyentuh service lain, aturan udev, firewall, mediamtx atau ffmpeg.

Yang dipasang:

```text
/usr/local/bin/drone-video-supervisor
/usr/local/share/drone-video/{README.md,uninstall.sh,drone-video.conf.example,install-info}
/etc/drone-video/drone-video.conf
/etc/systemd/system/drone-video.service
```

Service berjalan sebagai user sementara miliknya sendiri (`DynamicUser=yes`) di grup `render` dan `video` (untuk `/dev/dri/renderD128` dan encoder V4L2), bukan root, dengan `ProtectSystem=strict` dan `ProtectHome=yes`; satu-satunya direktori yang bisa ia tulis adalah `/run/drone-video`.

## Pengaturan

`/etc/drone-video/drone-video.conf`, baris `NAMA=NILAI` dibaca apa adanya (tanpa ekspansi `$`). Nama yang tidak dikenal atau nilai yang salah membuat supervisor keluar dengan kode 78, dan systemd tidak mengulangnya (`RestartPreventExitStatus=78`).

| Nama | Bawaan | Arti |
|---|---|---|
| `CAMERA_URL` | `auto` | `auto` (host drone dari console) atau URL `rtsp://` sendiri |
| `CONSOLE_URL` | `http://127.0.0.1:8787` | console yang ditanya host drone, `http://HOST[:PORT]` |
| `ENCODER` | `auto` | `auto`, `vaapi`, `x264`, `nvenc`, `v4l2m2m` atau `videotoolbox` |
| `BITRATE` | `2500k` | bit rate H.264, angka dengan `k` atau `M` |
| `WEBRTC_ADDITIONAL_HOSTS` | kosong | alamat IP atau nama host tambahan yang ditawarkan WebRTC ke browser, dipisah koma |
| `MEDIAMTX_BIN` | `mediamtx` | nama di PATH atau path absolut |
| `FFMPEG_BIN` | `ffmpeg` | nama di PATH atau path absolut |
| `RUNTIME_DIR` | kosong | direktori `mediamtx.yml`; kosong berarti `$RUNTIME_DIRECTORY` service (`/run/drone-video`) |

Setelah mengubahnya:

```sh
sudoedit /etc/drone-video/drone-video.conf
drone-video-supervisor check-config --config /etc/drone-video/drone-video.conf
sudo systemctl restart drone-video
```

### Encoder

- `auto`: VideoToolbox di macOS; VAAPI bila `/dev/dri/renderD128` ada dan ffmpeg punya `h264_vaapi`; selain itu libx264. Pilihannya tercatat di journal saat service mulai.
- `vaapi`: GPU Intel/AMD lewat grup `render`; hampir tanpa beban CPU.
- `x264`: libx264 `-preset ultrafast -tune zerolatency`, kira-kira satu core untuk 720p30. Pilihan aman bila VAAPI bermasalah.
- `nvenc`: GPU NVIDIA (ffmpeg dengan `h264_nvenc` dan driver NVIDIA).
- `v4l2m2m`: encoder V4L2 (misalnya Raspberry Pi), lewat grup `video`.

Bila VAAPI gagal (journal mediamtx menyebut ffmpeg keluar terus), set `ENCODER=x264`.

`WEBRTC_ADDITIONAL_HOSTS` hanya perlu bila tablet tidak mendapat video padahal signalling berhasil: isi alamat LAN host ini yang dicapai tablet.

## Periksa

```sh
systemctl status drone-video
journalctl -u drone-video -n 50                         # encoder, kamera, start dan exit mediamtx
curl -s http://127.0.0.1:9997/v3/paths/list             # raw dan drone: ready, readers, bytes
ffprobe -rtsp_transport tcp rtsp://127.0.0.1:8654/drone # harus h264, 1280x720
drone-video-supervisor print-config                     # konfigurasi mediamtx yang akan ditulis
```

| Gejala | Sebab |
|---|---|
| `raw` tidak ready | drone belum ditemukan console (lihat System Health), kamera mati, atau RTSP 8554 tidak tercapai |
| `raw` ready, `drone` tidak | ffmpeg gagal: encoder tidak tersedia, driver VAAPI, atau `FFMPEG_BIN` salah; coba `ENCODER=x264` |
| service tidak mau mulai, journal menyebut grup | grup `render` atau `video` tidak ada; `sudo systemctl edit drone-video` dan isi `SupplementaryGroups=` dengan grup yang ada |
| exit 78 | pengaturan salah; `drone-video-supervisor check-config` menyebut barisnya |
| Dashboard: signalling OK tapi gambar hitam | UDP 8189 tertutup di firewall host, atau tablet tidak mencapai alamat yang ditawarkan (isi `WEBRTC_ADDITIONAL_HOSTS`) |

## Hapus

```sh
sudo sh /usr/local/share/drone-video/uninstall.sh            # pengaturan tetap ada
sudo sh /usr/local/share/drone-video/uninstall.sh --purge    # pengaturan ikut dihapus
```

Service dihentikan dulu (mediamtx dan ffmpeg ikut berhenti). File yang bukan tulisan installer ini dibiarkan; mediamtx dan ffmpeg tetap terpasang.
