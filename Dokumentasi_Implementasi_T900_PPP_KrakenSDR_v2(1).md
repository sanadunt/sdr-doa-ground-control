# Dokumentasi Implementasi T900 Pro sebagai Wireless IP Link untuk KrakenSDR UAV

## T900-UAV ↔ T900-Ground + Raspberry Pi + macOS/Linux + PPP + Rencana MQTT/KrakenSDR

**Versi:** 2.0 — Hasil Implementasi Aktual  
**Tanggal:** 31 Agustus 2026  
**Status:** Transparent Serial + PPP + Ping + SSH **BERHASIL DIUJI**

---

# 1. Tujuan

Dokumentasi ini mencatat seluruh proses aktual untuk menjadikan sepasang **T900 Pro UAV Telemetry** sebagai jalur data nirkabel point-to-point yang dapat membawa trafik IP melalui PPP.

Target akhir sistem:

```text
Drone Cargo
   │
   ├── KrakenSDR
   │
   ├── Raspberry Pi
   │
   └── T900-UAV
          )))
          ((( RF
       T900-Ground
          │
          └── Ground Console
```

Pada implementasi ini:

- T900 di drone dinamakan **T900-UAV**
- T900 di Ground dinamakan **T900-Ground**
- Raspberry Pi berada di sisi UAV
- macOS digunakan sementara sebagai Ground peer PPP
- Linux dapat menggantikan macOS untuk Ground final
- PPP dipakai untuk membuat link serial T900 menjadi jaringan IP point-to-point
- MQTT direncanakan sebagai protokol utama telemetry/control
- KrakenSDR V1 dipilih untuk integrasi karena lebih mudah dimodifikasi dan API settings-nya sudah jelas

---

# 2. Arsitektur Sistem yang Dipilih

```text
                         UAV / DRONE
┌────────────────────────────────────────────────┐
│  Antenna Array                                 │
│       │                                        │
│       ▼                                        │
│  KrakenSDR                                     │
│       │ USB 3                                  │
│       ▼                                        │
│  Raspberry Pi                                  │
│  ├── KrakenSDR V1                              │
│  ├── DoA Processing                            │
│  ├── Spectrum Processing                       │
│  ├── UAV Controller/Gateway                    │
│  ├── MQTT                                      │
│  └── PPP 10.90.0.2                             │
│       │                                        │
│       ▼ USB Serial                             │
│  T900-UAV                                      │
└───────┬────────────────────────────────────────┘
        )))
        ((( 902–928 MHz
┌───────┴────────────────────────────────────────┐
│  T900-Ground                                   │
│       │ USB Serial                             │
│       ▼                                        │
│  Linux/macOS PPP endpoint                      │
│  PPP 10.90.0.1                                 │
│       │                                        │
│       ▼                                        │
│  Ground Console                                │
│  ├── MQTT                                      │
│  ├── DoA GUI                                   │
│  ├── Spectrum GUI                              │
│  └── Remote Configuration                      │
└────────────────────────────────────────────────┘
```

---

# 3. Konsep Penting

## 3.1 T900 bukan Ethernet radio

T900 pada dasarnya adalah radio serial.

```text
Serial Data
    │
    ▼
T900-UAV
    )))
    ((( RF
T900-Ground
    │
    ▼
Serial Data
```

Namun T900 mempunyai **Transparent/Pass-through mode**, sehingga byte yang masuk dapat diteruskan ke unit peer.

---

# 4. Konfigurasi T900 Pro Assistant

## 4.1 Driver Windows

T900 menggunakan USB serial berbasis CH340/CH341.

Di Device Manager:

```text
Device Manager
→ Ports (COM & LPT)
```

Contoh aktual:

```text
USB-SERIAL CH340 (COM8)
```

Cara menentukan COM dengan aman:

1. Lihat daftar COM
2. Cabut T900
3. Lihat COM yang hilang
4. Colok T900 lagi
5. COM yang muncul kembali adalah T900

---

# 5. Terjemahan T900 Pro Assistant

```text
端口设置        = Port Settings
串口            = Serial Port
波特率          = Baud Rate
加载参数        = Load Parameters
保存参数        = Save Parameters
恢复默认        = Restore Default
参数设置        = Parameter Settings
发射功率        = Transmit Power
数据格式        = Data Format
透明传输        = Transparent Transmission / Pass-through
最小频率        = Minimum Frequency
最大频率        = Maximum Frequency
通信测试        = Communication Test
接收设置        = Receive Settings
发送设置        = Send Settings
清空接收窗口    = Clear Receive Window
清空发送窗口    = Clear Send Window
发送            = Send
版本号          = Version
```

---

# 6. Setting T900 yang Digunakan

Setting aktual yang dipilih:

```text
Baud Rate      : 57600
Transmit Power : 500 mW
Data Format    : Transparent / 透明传输
ID             : 000000
RSSI           : ON
Min Frequency  : 902 MHz
Max Frequency  : 928 MHz
Version        : T900 Pro v1.0
```

Kedua unit harus sama/kompatibel:

```text
                  T900-UAV        T900-Ground
Baud              57600           57600
Data Format       Transparent     Transparent
ID                000000          000000
Min Frequency     902             902
Max Frequency     928             928
```

---

# 7. Temuan Penting: MAVLink vs Transparent

Awalnya T900 terbaca:

```text
Data Format: mavlink
```

Saat masih MAVLink mode:

- text test tidak berjalan benar
- Mac menampilkan karakter binary/garbage
- ASCII biasa tidak diteruskan seperti yang diharapkan

Setelah diubah menjadi:

```text
透明传输
Transparent Transmission
```

serial ASCII langsung bekerja.

Untuk PPP/custom data:

```text
MAVLink Mode      ❌
Transparent Mode  ✅
```

---

# 8. Menyimpan Parameter

Setelah mengubah Data Format, klik:

```text
保存参数
Save Parameters
```

Jika sukses muncul:

```text
保存成功，请重新上电
```

Artinya:

```text
Save successful, please power-cycle/restart the device.
```

Lalu:

1. Matikan/cabut power
2. Tunggu beberapa detik
3. Nyalakan kembali
4. Load Parameters lagi
5. Pastikan Data Format tetap Transparent

---

# 9. Transmit Power 500 mW vs 1 W

Untuk bench test digunakan:

```text
500 mW
```

T900 Pro mendukung hingga sekitar 1 W, tetapi untuk baseline 500 mW dipilih karena:

- sudah cukup untuk jarak dekat
- lebih sedikit panas
- lebih aman untuk pengujian awal
- RF power tidak menentukan baud rate UART

Penting:

```text
UART Baud Rate ≠ RF Transmit Power
```

Naik 500 mW → 1 W sekitar +3 dB RF power, bukan 2× throughput.

---

# 10. Baud Rate

Baseline:

```text
57600 bps
```

UART 8N1 theoretical serial payload:

```text
57600 / 10 ≈ 5760 byte/s ≈ 5.6 kB/s
```

Pilihan seperti 115200/230400 tidak otomatis berarti RF throughput ikut naik. Gunakan 57600 sebagai baseline sampai throughput nyata diukur.

---

# 11. Deteksi T900 di Raspberry Pi

Hasil aktual `dmesg`:

```text
usb 1-1.1: New USB device found, idVendor=1a86, idProduct=7523
usb 1-1.1: Product: USB Serial
ch341 1-1.1:1.0: ch341-uart converter detected
usb 1-1.1: ch341-uart converter now attached to ttyUSB0
```

Artinya:

```text
T900 → CH341 → Linux driver → /dev/ttyUSB0
```

Device aktual:

```text
/dev/ttyUSB0
```

---

# 12. Permission Raspberry Pi

Aktual:

```text
crw-rw---- 1 root dialout ... /dev/ttyUSB0
```

User `doasdr` sudah anggota `dialout`:

```text
doasdr adm dialout cdrom sudo audio video plugdev games users netdev lpadmin gpio i2c spi render input
```

Jadi tidak perlu `chmod 777`.

---

# 13. Deteksi T900 di macOS

Port pernah muncul sebagai:

```text
/dev/cu.usbserial-1410
```

Saat PPP sukses:

```text
/dev/cu.usbserial-1420
```

Cek:

```bash
ls /dev/cu.*
ls /dev/cu.usbserial*
```

Nama port dapat berubah setelah reconnect/restart.

---

# 14. Temuan Penting: USB Type-C Bisa Membawa Payload

Awalnya diduga Type-C hanya untuk konfigurasi. Setelah T900 diubah dari MAVLink ke Transparent, test aktual berhasil:

```text
Raspberry / picocom
        │
        ▼
     T900-UAV
        )))
        ((( RF
   T900-Ground
        │
        ▼
Mac / screen
```

Jadi pada unit yang diuji:

```text
USB Type-C
├── T900 Pro Assistant       ✅
└── Transparent serial data  ✅ TERBUKTI
```

USB-to-TTL/UART converter tidak diperlukan untuk implementasi ini selama USB serial stabil.

---

# 15. Test Transparent Serial

## Raspberry

```bash
sudo apt update
sudo apt install -y picocom
picocom -b 57600 -c /dev/ttyUSB0
```

Keluar:

```text
Ctrl+A
Ctrl+X
```

## macOS

```bash
screen /dev/cu.usbserial-1420 57600
```

Keluar:

```text
Ctrl+A
Ctrl+\
y
```

---

# 16. Hasil Transparent Serial Test

Setelah kedua unit Transparent:

```text
Raspberry → Mac ✅
Mac → Raspberry ✅
```

Text yang diketik di `picocom` muncul realtime di `screen`.

Ini membuktikan:

```text
Bidirectional Transparent Serial Link ✅
```

Ini bukan screen mirroring, tetapi **transparent serial data mirroring/bridge**.

---

# 17. PPP: Membuat Serial T900 Menjadi IP Link

Target:

```text
Mac / Ground                    Raspberry / UAV
10.90.0.1                       10.90.0.2
    │                               │
   ppp0                            ppp0
    │                               │
   pppd                            pppd
    │                               │
T900-Ground  ))) RF (((         T900-UAV
```

---

# 18. Install PPP di Raspberry

```bash
sudo apt update
sudo apt install -y ppp
```

---

# 19. Persiapan PPP di macOS

Cek:

```bash
which pppd
```

Hasil:

```text
/usr/sbin/pppd
```

Awalnya muncul error:

```text
Can't open options file /etc/ppp/options: No such file or directory
```

Solusi:

```bash
sudo mkdir -p /etc/ppp
sudo touch /etc/ppp/options
```

---

# 20. Command PPP Raspberry — BERHASIL

```bash
sudo pppd \
  /dev/ttyUSB0 \
  57600 \
  10.90.0.2:10.90.0.1 \
  local \
  noauth \
  nodetach \
  debug \
  nocrtscts \
  noipdefault
```

---

# 21. Command PPP macOS — BERHASIL

Port aktual saat test:

```text
/dev/cu.usbserial-1420
```

Command:

```bash
sudo /usr/sbin/pppd \
  /dev/cu.usbserial-1420 \
  57600 \
  10.90.0.1:10.90.0.2 \
  local \
  noauth \
  nodetach \
  debug \
  nocrtscts \
  noipdefault
```

---

# 22. PPP Negotiation yang Berhasil

Raspberry:

```text
Using interface ppp0
Connect: ppp0 <--> /dev/ttyUSB0
sent [LCP ConfReq ...]
rcvd [LCP ConfAck ...]
rcvd [LCP ConfReq ...]
sent [LCP ConfAck ...]
```

Kemudian IPCP:

```text
sent [IPCP ConfReq ... <addr 10.90.0.2>]
rcvd [IPCP ConfReq ... <addr 10.90.0.1>]
```

Akhirnya:

```text
local  IP address 10.90.0.2
remote IP address 10.90.0.1
```

---

# 23. Interface PPP Raspberry

```bash
ip addr show ppp0
```

Hasil aktual:

```text
ppp0: <POINTOPOINT,MULTICAST,NOARP,UP,LOWER_UP>
inet 10.90.0.2 peer 10.90.0.1/32 scope global ppp0
```

---

# 24. PPP macOS Berhasil

Log macOS:

```text
Using interface ppp0
Connect: ppp0 <--> /dev/cu.usbserial-1420
local  IP address 10.90.0.1
remote IP address 10.90.0.2
```

---

# 25. Pesan yang Aman Diabaikan

Muncul:

```text
Unsupported protocol 'Apple Client Server Protocol Control'
Protocol-Reject for 'IPv6 Control Protocol'
```

IPv4 PPP tetap berjalan normal.

Di Mac juga muncul:

```text
set_up_tty, can't set controlling terminal: Operation not permitted
```

Namun koneksi tetap berhasil.

---

# 26. Ping Test — BERHASIL

## Raspberry → Mac

```bash
ping 10.90.0.1
```

Aktual:

```text
3 packets transmitted
3 received
0% packet loss
rtt min/avg/max = 145.939/155.015/164.111 ms
```

## Mac → Raspberry

```bash
ping 10.90.0.2
```

Aktual:

```text
3 packets transmitted
3 packets received
0.0% packet loss
round-trip min/avg/max = 136.748/148.098/158.487 ms
```

Initial latency sekitar:

```text
~150 ms
```

---

# 27. SSH Test — BERHASIL

```bash
ssh doasdr@10.90.0.2
```

berhasil.

Ini membuktikan:

```text
TCP over IP over PPP over T900 ✅
```

---

# 28. Status Milestone

| Tahap | Status |
|---|---|
| T900 pairing | ✅ |
| Transparent mode | ✅ |
| USB CH341 Raspberry | ✅ |
| USB serial macOS | ✅ |
| Serial UAV → Ground | ✅ |
| Serial Ground → UAV | ✅ |
| USB Type-C payload | ✅ |
| `pppd` Raspberry | ✅ |
| `pppd` macOS | ✅ |
| `ppp0` kedua sisi | ✅ |
| IP `10.90.0.1 ↔ 10.90.0.2` | ✅ |
| Ping dua arah | ✅ |
| Initial packet loss | 0% |
| SSH | ✅ |
| MQTT | NEXT |
| KrakenSDR V1 | NEXT |
| Spectrum MQTT | NEXT |
| Persistent `/dev/t900` | NEXT |
| Auto-start PPP | NEXT |

---

# 29. Persistent USB Naming

Jangan hard-code `/dev/ttyUSB0` untuk final.

Cek:

```bash
ls -l /dev/serial/by-id/
ls -l /dev/serial/by-path/
udevadm info --query=property --name=/dev/ttyUSB0
```

Target final:

```text
/dev/t900
```

Sehingga `pppd` tidak peduli apakah kernel memberi nama `ttyUSB0`, `ttyUSB1`, atau `ttyUSB2`.

---

# 30. Target PPP Peer File

Raspberry final sebaiknya mempunyai:

```text
/etc/ppp/peers/t900
```

Baseline:

```text
/dev/t900
57600
local
noauth
10.90.0.2:10.90.0.1
persist
maxfail 0
holdoff 3
lcp-echo-interval 5
lcp-echo-failure 3
```

Run:

```bash
sudo pppd call t900
```

---

# 31. KrakenSDR V1

Dipilih:

```text
krakenrf/krakensdr_doa (V1)
```

Alasan:

- matang
- mudah dimodifikasi
- HTML/Web UI relatif mudah diubah
- remote settings sudah terdokumentasi
- cocok untuk controller custom

---

# 32. Processing Kraken di UAV

```text
Antenna Array
    │
KrakenSDR
    │ USB3
Raspberry Pi
    │
    ├── DAQ
    ├── DoA
    ├── Spectrum
    └── Controller
```

Jangan kirim raw IQ melalui T900.

Yang dikirim:

```text
DoA
RSSI
Confidence
Frequency
GPS
Heading
Status
Spectrum compact
Command
ACK
```

---

# 33. MQTT sebagai Protokol Utama

Stack:

```text
MQTT
 ↓
TCP
 ↓
IP
 ↓
PPP
 ↓
T900
```

Alasan:

- Publish/Subscribe
- QoS
- retained state
- reconnect
- pemisahan topic telemetry/command

---

# 34. QoS Recommendation

Realtime:

```text
DoA        → QoS 0
RSSI       → QoS 0
GPS        → QoS 0
Heading    → QoS 0
Spectrum   → QoS 0
Heartbeat  → QoS 0
```

Command:

```text
Set Frequency → QoS 1
Set Gain      → QoS 1
Start/Stop    → QoS 1
Restart       → QoS 1
ACK/NACK      → QoS 1
```

State:

```text
QoS 1 + Retain
```

---

# 35. MQTT Topic Concept

UAV → Ground:

```text
kraken/telemetry/doa
kraken/telemetry/rssi
kraken/telemetry/confidence
kraken/telemetry/spectrum
kraken/state/frequency
kraken/state/gain
kraken/state/running
uav/gps
uav/heading
uav/altitude
system/uav/heartbeat
system/kraken/status
```

Ground → UAV:

```text
kraken/cmd/set_frequency
kraken/cmd/set_gain
kraken/cmd/start
kraken/cmd/stop
kraken/cmd/restart
kraken/cmd/request_settings
```

ACK:

```text
kraken/ack/set_frequency
kraken/ack/set_gain
kraken/ack/start
kraken/ack/stop
```

---

# 36. Kraken Remote Configuration

Kraken V1 menyediakan settings interface:

```text
GET  http://KRAKEN_IP:8042/settings
POST http://KRAKEN_IP:8042/settings
```

Rekomendasi:

```text
Ground GUI
   │ MQTT command
   ▼
UAV Controller
   │ HTTP GET/POST localhost
   ▼
Kraken
```

Jadi Ground tidak bergantung langsung pada API internal Kraken.

---

# 37. Data Mirroring

Target bukan screen mirroring, tetapi:

```text
DATA / STATE MIRRORING
```

Ground menerima:

```text
DoA
RSSI
Confidence
Frequency
GPS
Heading
Spectrum
Status
```

lalu Ground menggambar UI sendiri.

---

# 38. Spectrum KrakenSDR ke Ground

Yang dikirim bukan raw IQ, melainkan hasil FFT/power spectrum.

```text
KrakenSDR
    │
FFT / Spectrum Processing
    │
frequency bins + power bins
    │
UAV Controller
    │
MQTT
    │
T900 PPP
    │
Ground GUI
```

Contoh payload compact:

```json
{
  "center": 433920000,
  "span": 1000000,
  "bins": 256,
  "power": [-93,-92,-91,-88,-70,-54]
}
```

Ground menghitung frequency axis sendiri.

Baseline:

```text
256 bins
1 Hz
```

Jika stabil, naikkan ke 2 Hz.

Waterfall dibangun di Ground dari history spectrum frame, bukan dikirim sebagai gambar.

---

# 39. Spectrum On-Demand

Efisien untuk T900:

```text
Default Spectrum Stream = OFF
```

Ground:

```text
kraken/cmd/spectrum_enable = true
```

UAV mulai mengirim 256 bins @ 1–2 Hz.

Setelah selesai:

```text
kraken/cmd/spectrum_enable = false
```

---

# 40. Bandwidth Awareness

Baseline serial:

```text
57600 baud ≈ 5.6 kB/s theoretical payload
```

Setelah PPP/IP/TCP/MQTT/RF overhead, throughput aplikasi nyata lebih rendah.

Karena itu target awal:

```text
DoA        10 Hz
GPS         5 Hz
Heartbeat   1 Hz
Spectrum    1–2 Hz
```

---

# 41. Global Bearing

Contoh:

```text
Drone Heading = 120°
Kraken DoA    = 40°
Global Bearing = 160°
```

Normalisasi ke 0–360°.

Raspberry nantinya sebaiknya menerima GPS/heading dari Flight Controller/MAVLink untuk mengubah relative DoA menjadi geographic bearing.

---

# 42. Next Step

```text
1. Persistent /dev/t900
        ↓
2. PPP peer file
        ↓
3. Auto-start PPP
        ↓
4. Long ping test
        ↓
5. Throughput test
        ↓
6. Install KrakenSDR V1
        ↓
7. Test Web UI lokal
        ↓
8. Test Kraken settings API
        ↓
9. Install Mosquitto
        ↓
10. MQTT over PPP
        ↓
11. Publish DoA
        ↓
12. Ground subscribe
        ↓
13. UAV Controller
        ↓
14. Remote command
        ↓
15. Spectrum MQTT
        ↓
16. Ground GUI
```

---

# 43. Acceptance Criteria Saat Ini

```text
[✓] T900 Transparent
[✓] USB serial dua arah
[✓] T900-UAV ↔ T900-Ground
[✓] PPP negotiation
[✓] ppp0 kedua sisi
[✓] 10.90.0.1 ↔ 10.90.0.2
[✓] Ping dua arah
[✓] 0% packet loss pada test awal
[✓] SSH
[ ] Persistent /dev/t900
[ ] PPP auto-start
[ ] MQTT
[ ] KrakenSDR V1
[ ] DoA MQTT
[ ] Spectrum MQTT
[ ] Remote config
[ ] Long duration test
[ ] Flight test
```

---

# 44. Quick Recreate

## T900

```text
Kedua unit:
57600
Transparent
ID sama
902–928 MHz
500 mW baseline
Save
Power-cycle
```

## Raspberry

```bash
sudo apt install -y ppp
sudo pppd \
  /dev/ttyUSB0 \
  57600 \
  10.90.0.2:10.90.0.1 \
  local noauth nodetach debug nocrtscts noipdefault
```

## macOS

```bash
sudo mkdir -p /etc/ppp
sudo touch /etc/ppp/options
ls /dev/cu.usbserial*
```

Lalu:

```bash
sudo /usr/sbin/pppd \
  /dev/cu.usbserial-1420 \
  57600 \
  10.90.0.1:10.90.0.2 \
  local noauth nodetach debug nocrtscts noipdefault
```

## Test

Raspberry:

```bash
ping 10.90.0.1
```

Mac:

```bash
ping 10.90.0.2
```

SSH:

```bash
ssh doasdr@10.90.0.2
```

Jika berhasil:

```text
T900 PPP LINK READY ✅
```

---

# 45. Referensi

T900 Pro User Manual:  
https://fw.makeflyeasy.com/T900%20%20Pro/T900%20Pro%E7%94%A8%E6%88%B7%E6%89%8B%E5%86%8C%EF%BC%88T900%20Pro%20User%20Manual%EF%BC%89.pdf

KrakenSDR V1:  
https://github.com/krakenrf/krakensdr_doa

PPP RFC 1662:  
https://www.rfc-editor.org/rfc/rfc1662

Linux pppd:  
https://man7.org/linux/man-pages/man8/pppd.8.html

Eclipse Mosquitto:  
https://mosquitto.org/

---

## Ringkasan Satu Kalimat

> **T900-UAV dan T900-Ground digunakan dalam Transparent mode sebagai wireless serial transport. PPP/pppd membentuk IP point-to-point network 10.90.0.1 ↔ 10.90.0.2 di atas link tersebut. Hasil pengujian aktual menunjukkan ping dua arah dengan 0% packet loss pada test awal dan SSH berhasil, sehingga link siap dilanjutkan untuk MQTT dan integrasi KrakenSDR V1.**

---

**End of Documentation**
