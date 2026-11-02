# GPS groundstation (ground-gps-publisher)

Groundstation punya lokasi sendiri, terpisah dari RDF-SDR. GPS USB di groundstation (u-blox 7, `/dev/ttyACM0`) memberi posisi itu ke console: peta menampilkan penanda groundstation (kotak, label GS) dan garis putus-putus ke stasiun RDF-SDR dengan jarak dan arahnya.

`ground-gps-publisher` berjalan di host groundstation, di luar Docker (`packaging/ground-gps`, ikut tarball console seperti `packaging/ground-link` dan `packaging/host-power`). Ia membaca keluaran NMEA 0183 penerima GPS dan menerbitkan statusnya ke broker MQTT lokal; console membacanya lewat koneksi MQTT yang sudah ada, tanpa akses ke perangkat USB.

| File | Isi |
|---|---|
| `ground-gps-publisher` | program (Python 3, hanya pustaka standar): `run` (service), `print` (baca penerima dan cetak status, tanpa menerbitkan), `check-config` |
| `ground-gps.service.in` | service systemd `ground-gps.service` |
| `ground-gps.conf.example` | pengaturan, dipasang sebagai `/etc/ground-gps/ground-gps.conf` |
| `install.sh`, `uninstall.sh` | pasang dan hapus |

## Yang diterbitkan

Topik `sdr/v2/<node>/ground/gps` (node bawaan `uav-01`), QoS 0, **retained**, setiap 2 detik dan segera saat status fix berubah, ke `127.0.0.1:1883` (MQTT 3.1.1 anonim lewat TCP, sama seperti bridge LoRa). Payload JSON ringkas, paling besar 512 byte:

```json
{"v":1,"t":1793595224512,"state":"FIX","device":"usb-u-blox_AG_-_www.u-blox.com_u-blox_7_-_GPS_GNSS_Receiver-if00",
 "fix":3,"sat":4,"lat":-6.9299005,"lon":107.7115572,"alt":697.6,"hdop":1.9,"sog":0.288,"cog":null,
 "gnss_t":1793595224000,"error":null}
```

| `state` | Arti |
|---|---|
| `FIX` | RMC berstatus `A` dan GGA dengan kualitas ≥ 1 dalam 5 detik terakhir. `fix` 3 atau 2 dari GSA (2 bila GSA tidak ada) |
| `NO_FIX` | kalimat NMEA datang tetapi belum ada posisi valid; `lat`/`lon` null, `sat` dan `hdop` tetap dikirim bila ada |
| `NO_DATA` | perangkat terbuka tetapi tidak ada kalimat NMEA valid selama 5 detik |
| `NO_DEVICE` | path perangkat tidak ada (dicabut); dicoba lagi setiap 2 detik |
| `ERROR` | perangkat ada tetapi tidak bisa dibuka; `error` menyebut sebabnya (misalnya izin, user belum di grup `dialout`) |
| `STOPPED` | status terakhir saat service dihentikan dengan bersih |

`t` adalah waktu terbit (jam host); console menganggap status lebih tua dari 10 detik sebagai `STALE`, jadi publisher yang mati tanpa sempat mengirim `STOPPED` tetap terlihat. Hanya kalimat dengan checksum NMEA yang benar yang dihitung. `lat`/`lon` dari GGA (`ddmm.mmmm` dan belahan bumi), `alt` meter di atas permukaan laut, `sog` dari RMC (knot × 0,514444, m/s), `cog` dari RMC bila ada, `gnss_t` waktu fix dari tanggal dan jam RMC (UTC).

## Perangkat: hanya dibaca

- Perangkat dibuka `O_RDONLY | O_NOCTTY | O_NONBLOCK` dan publisher **tidak pernah menulis** ke perangkat. Hanya pada pembukaan pertama sebuah ttyACM baru, kernel bisa memantulkan beberapa byte NMEA yang tiba sebelum ECHO dimatikan, sekali saja; u-blox mengabaikannya. Satu-satunya perubahan pada tty adalah mematikan ECHO (kalau tidak, kernel memantulkan setiap byte yang diterima kembali ke penerima) dan, hanya bila `BAUD` diisi, kecepatan jalur.
- Service berjalan sebagai user sementara miliknya sendiri (`DynamicUser=yes`) di grup `dialout`, bukan root. `DevicePolicy=closed` dengan `DeviceAllow=char-ttyACM r` (nama kelas perangkat di `/proc/devices`): ia hanya boleh membuka tty USB ACM (`ttyACM*`), hanya baca. Adaptor serial bridge LoRa (`/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0`, `ttyUSB0`) **tidak bisa** dibuka olehnya, juga bila `DEVICE` salah diisi.
- Satu tty sebaiknya dibaca satu program: hentikan service sebelum `ground-gps-publisher print`, dan jangan pasang `gpsd` pada penerima yang sama.

## Pasang

```sh
ls -l /dev/serial/by-id/                              # nama penerima GPS
sudo sh packaging/ground-gps/install.sh --dry-run     # lihat dulu file dan perintahnya
sudo sh packaging/ground-gps/install.sh
```

Butuh `/bin/sh`, `python3` (3.7 ke atas; Ubuntu sudah punya), systemd dan broker MQTT di groundstation (mosquitto yang juga dipakai bridge LoRa). Installer menulis `/etc/ground-gps/ground-gps.conf` dari contohnya pada pemasangan pertama dan mempertahankannya sesudahnya, memeriksa pengaturan dengan publisher sendiri (pengaturan yang tidak terbaca menghentikan install), lalu `systemctl enable` dan `restart` `ground-gps.service`. Menjalankannya lagi berarti upgrade.

| Opsi | Arti |
|---|---|
| `--prefix DIR` | lokasi program (bawaan `/usr/local`): `DIR/bin/ground-gps-publisher`, `DIR/share/ground-gps/`; `bin`, `share/ground-gps` dan setiap direktori di atasnya harus milik root dan tidak bisa ditulis user lain |
| `--dry-run` | tampilkan file dan perintah, tidak mengubah apa pun; berakhir dengan exit 1 bila install akan berhenti |
| `--root DIR` | pasang di bawah DIR tanpa `systemctl` (untuk test) |

Installer hanya menulis file miliknya sendiri (bertanda `packaging/ground-gps`) dan menolak mengganti file lain dengan nama yang sama. Ia tidak membuka port dan tidak menyentuh service lain, aturan udev, firewall, broker, atau bridge LoRa.

Yang dipasang:

```text
/usr/local/bin/ground-gps-publisher
/usr/local/share/ground-gps/{README.md,uninstall.sh,ground-gps.conf.example,install-info}
/etc/ground-gps/ground-gps.conf
/etc/systemd/system/ground-gps.service
```

## Pengaturan

`/etc/ground-gps/ground-gps.conf`, baris `NAMA=NILAI` dibaca apa adanya. Nama yang tidak dikenal atau nilai yang salah membuat publisher keluar dengan kode 78, dan systemd tidak mengulangnya (`RestartPreventExitStatus=78`).

| Nama | Bawaan | Arti |
|---|---|---|
| `DEVICE` | `/dev/serial/by-id/usb-u-blox_AG_-_www.u-blox.com_u-blox_7_-_GPS_GNSS_Receiver-if00` | keluaran NMEA penerima; pakai nama `by-id` yang stabil, bukan `ttyACM0` |
| `BAUD` | kosong | kecepatan jalur; kosong membiarkannya (USB ACM tidak memakainya) |
| `BROKER_HOST` | `127.0.0.1` | alamat IP atau `localhost`, tanpa nama DNS |
| `BROKER_PORT` | `1883` | port MQTT TCP |
| `NODE_ID` | `uav-01` | node pada topik `sdr/v2/<NODE_ID>/ground/gps` |
| `INTERVAL` | `2` | detik di antara dua status (1–60) |

Setelah mengubahnya:

```sh
sudoedit /etc/ground-gps/ground-gps.conf
ground-gps-publisher check-config --config /etc/ground-gps/ground-gps.conf
sudo systemctl restart ground-gps
```

Penerima di balik adaptor serial (`ttyUSB*`, bukan `ttyACM*`) butuh drop-in, karena service hanya boleh membuka tty ACM: `sudo systemctl edit ground-gps`, isi `[Service]` dan `DeviceAllow=char-ttyUSB r`, lalu isi `BAUD`. Jangan arahkan `DEVICE` ke adaptor bridge LoRa.

## Periksa

```sh
systemctl status ground-gps
journalctl -u ground-gps -n 50                 # perubahan status, koneksi broker
mosquitto_sub -h 127.0.0.1 -t 'sdr/v2/+/ground/gps' -v -C 1
sudo systemctl stop ground-gps && ground-gps-publisher print --config /etc/ground-gps/ground-gps.conf; sudo systemctl start ground-gps
```

`print` dijalankan sebagai user di grup `dialout` (misalnya `rdf`); ia mencetak lima status lalu berhenti.

| Gejala | Sebab |
|---|---|
| `NO_DEVICE` | penerima dicabut, atau `DEVICE` salah: `ls -l /dev/serial/by-id/` |
| `ERROR` "permission denied" | grup tty bukan `dialout`, atau drop-in mengubah `SupplementaryGroups` |
| `ERROR` lain, atau `NO_DEVICE` padahal path ada | perangkat bukan `ttyACM*` (lihat drop-in di atas) |
| `NO_DATA` | penerima terbuka tetapi diam, atau program lain (`gpsd`) ikut membaca tty yang sama |
| `NO_FIX` lama | antena tidak melihat langit; cold start u-blox 7 bisa beberapa menit |
| journal "broker …: Connection refused" | broker tidak mendengar di `BROKER_HOST:BROKER_PORT`; publisher mencoba lagi (1, 2, 4 … 30 detik) |
| console `STALE` | publisher berhenti atau jam host melompat; lihat `systemctl status ground-gps` |

## Hapus

```sh
sudo sh /usr/local/share/ground-gps/uninstall.sh            # pengaturan tetap ada
sudo sh /usr/local/share/ground-gps/uninstall.sh --purge    # pengaturan ikut dihapus
```

Service dihentikan dulu, jadi status `STOPPED` terakhir tetap tersimpan (retained) di broker dan console menampilkannya. File yang bukan tulisan installer ini dibiarkan.
