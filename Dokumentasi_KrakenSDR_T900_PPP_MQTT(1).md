# Dokumentasi Arsitektur KrakenSDR UAV Telemetry
## KrakenSDR + Raspberry Pi + T900 Pro + PPP + MQTT

**Status dokumen:** Konsep arsitektur dan rencana implementasi  
**Versi:** 1.0  
**Tanggal:** 29 Agustus 2026

---

## 1. Tujuan Sistem

Sistem ini dirancang untuk menempatkan **KrakenSDR pada Drone Cargo** sebagai sensor Radio Direction Finding (RDF), melakukan pemrosesan DoA (*Direction of Arrival*) di sisi drone menggunakan Raspberry Pi, lalu mengirimkan hasil pengolahan dan menerima perintah konfigurasi dari Ground Control melalui sepasang radio telemetry T900 Pro.

Penamaan yang digunakan dalam dokumen ini:

- **T900-UAV**: T900 Pro yang dipasang di drone.
- **T900-Ground**: T900 Pro yang dipasang di Ground Control.
- **UAV Raspberry**: Raspberry Pi yang terhubung ke KrakenSDR.
- **Ground Console**: PC operator di Ground Control.
- **UAV Controller/Gateway**: software tambahan di Raspberry yang menghubungkan KrakenSDR dengan MQTT/command dari Ground.
- **PPP Link**: jaringan IP point-to-point yang dibentuk melalui serial T900.

Tujuan akhirnya bukan melakukan *screen mirroring* dari Raspberry ke Ground, melainkan melakukan **data/state mirroring dan remote control**.

---

# 2. Kesimpulan Arsitektur yang Dipilih

Arsitektur yang direkomendasikan:

```text
                         DRONE / UAV
┌────────────────────────────────────────────────────┐
│                                                    │
│  Antenna Array                                     │
│       │                                            │
│       ▼                                            │
│  ┌─────────────┐      USB 3.0                     │
│  │ KrakenSDR   │──────────────────┐               │
│  └─────────────┘                  │               │
│                                   ▼               │
│                         ┌──────────────────┐       │
│                         │ Raspberry Pi     │       │
│                         │                  │       │
│                         │ KrakenSDR DoA    │       │
│                         │ UAV Controller   │       │
│                         │ MQTT Broker      │       │
│                         │ ppp0 10.90.0.2   │       │
│                         └────────┬─────────┘       │
│                                  │ USB Serial      │
│                                  ▼                 │
│                            ┌───────────┐           │
│                            │ T900-UAV  │           │
│                            └─────┬─────┘           │
└──────────────────────────────────┼─────────────────┘
                                   )))
                        RF 902–928 MHz
                                   (((
┌──────────────────────────────────┼─────────────────┐
│                            ┌─────▼──────┐          │
│                            │T900-Ground │          │
│                            └─────┬──────┘          │
│                                  │ USB Serial      │
│                                  ▼                 │
│                         ┌──────────────────┐       │
│                         │ Linux Endpoint   │       │
│                         │ ppp0 10.90.0.1   │       │
│                         │ MQTT Broker      │       │
│                         └────────┬─────────┘       │
│                                  │                 │
│                                  ▼                 │
│                             PC Console             │
│                         Windows atau Linux         │
│                                                    │
│                       GROUND CONTROL               │
└────────────────────────────────────────────────────┘
```

Jika Ground Console menggunakan Linux, T900-Ground dapat langsung terhubung ke PC tersebut dan PC menjalankan `pppd`.

Jika Ground Console menggunakan Windows, arsitektur yang lebih mudah dikelola adalah:

```text
T900-Ground
     │ USB Serial
     ▼
Linux Ground Gateway
     │ Ethernet
     ▼
Windows PC Console
```

Linux Ground Gateway dapat berupa Raspberry Pi, mini PC Linux, atau komputer Linux kecil lainnya.

---

# 3. Mengapa Processing KrakenSDR Dilakukan di Drone?

Dua opsi awal yang dipertimbangkan adalah:

### Opsi A — Raw data KrakenSDR dikirim ke Ground

```text
KrakenSDR → radio link → Ground PC → DoA Processing
```

Opsi ini tidak direkomendasikan untuk T900.

KrakenSDR mempunyai lima channel coherent SDR. Pemindahan data IQ/DAQ ke komputer lain membutuhkan bandwidth yang jauh lebih besar dibandingkan kemampuan serial T900.

### Opsi B — Processing dilakukan di UAV

```text
KrakenSDR
   │ USB
   ▼
Raspberry Pi
   │
   ├─ Heimdall/DAQ
   ├─ DoA Processing
   └─ Hasil DoA
         │
         ▼
       T900
```

Ini adalah pilihan yang direkomendasikan.

T900 hanya perlu membawa:

- DoA / bearing.
- Signal power.
- Confidence.
- Frequency.
- GPS.
- Heading.
- Altitude.
- System status.
- Kraken status.
- Command konfigurasi.
- Acknowledgement.

Data tersebut jauh lebih kecil dibanding raw IQ atau spectrum/waterfall penuh.

---

# 4. Peran T900 Pro

T900 Pro bukan Ethernet radio dan bukan Wi-Fi bridge.

Menurut manual resmi MFE, T900 Pro adalah:

- Radio telemetry 902–928 MHz.
- Full-duplex serial link.
- Mendukung MAVLink atau transparent/pass-through mode.
- UART 3.3 V TTL.
- Serial speed 57,600 bps.
- Dua unit dengan parameter yang sama dapat pairing secara otomatis.

Dalam arsitektur ini T900 diperlakukan seperti:

```text
      "KABEL SERIAL NIRKABEL"

T900-UAV  ))))))))))))))  T900-Ground
```

T900 tidak perlu mengetahui apakah data yang dibawanya adalah:

- PPP.
- IP.
- TCP.
- MQTT.
- HTTP.
- SSH.

Dalam transparent mode, T900 cukup meneruskan byte serial.

---

# 5. Mengapa Tidak Menggunakan UART-to-LAN Converter?

Awalnya dipertimbangkan:

```text
Raspberry
   │ Ethernet
UART-to-LAN
   │ UART
T900-UAV
```

dan:

```text
T900-Ground
   │ UART
UART-to-LAN
   │ Ethernet
Ground PC
```

Secara teknis ini bisa, tetapi akan menambah lapisan:

```text
PPP
 ↓
Virtual Serial
 ↓
TCP Ethernet lokal
 ↓
UART-to-LAN
 ↓
UART
 ↓
T900
```

Jika T900 sudah mempunyai USB serial yang dapat digunakan langsung oleh Linux, converter menjadi tidak wajib.

Arsitektur yang lebih sederhana:

```text
Raspberry
   │ USB Serial
T900-UAV
```

dan:

```text
T900-Ground
   │ USB Serial
Linux Ground
```

Keuntungannya:

- Lebih sedikit converter.
- Lebih sedikit kabel.
- Lebih sedikit kebutuhan power.
- Tidak perlu virtual COM/TTY tambahan.
- Tidak ada TCP encapsulation tambahan sebelum PPP.
- Lebih sedikit titik kegagalan.

UART-to-LAN tetap dapat digunakan apabila ada kebutuhan mekanis/instalasi tertentu, tetapi bukan pilihan utama.

---

# 6. Apa Itu PPP?

**PPP — Point-to-Point Protocol** adalah protokol yang dapat membawa paket jaringan, termasuk IP, melalui suatu link point-to-point.

Dalam kasus ini link fisiknya adalah serial T900.

Tanpa PPP:

```text
Raspberry
   │
/dev/ttyUSB0
   │
T900
```

Linux hanya melihat sebuah serial port.

Dengan PPP:

```text
/dev/ttyUSB0
     │
    pppd
     │
    ppp0
     │
10.90.0.2
```

`pppd` bekerja dengan driver PPP pada kernel Linux dan membuat sebuah network interface seperti:

```bash
ppp0
```

Maka dua T900 dapat menjadi jalur IP point-to-point:

```text
UAV Raspberry                         Ground Linux
10.90.0.2                             10.90.0.1
    │                                     │
  ppp0                                  ppp0
    │                                     │
  pppd                                  pppd
    │                                     │
 T900-UAV  )))))))))))))))))))  T900-Ground
```

Dari sisi aplikasi, jaringan ini dapat digunakan seperti koneksi IP biasa:

```bash
ping 10.90.0.1
```

atau:

```bash
ssh user@10.90.0.1
```

MQTT juga dapat berjalan di atasnya.

---

# 7. PPP Bukan Ethernet Layer-2

PPP membuat koneksi **Layer-3 point-to-point**, bukan Ethernet switch.

Ethernet LAN:

```text
192.168.1.0/24
      │
      ├── PC
      ├── Camera
      ├── Raspberry
      └── Sensor
```

PPP:

```text
10.90.0.1  ←────────→  10.90.0.2
 Ground                   UAV
```

Namun Raspberry dapat berfungsi sebagai router.

Contoh:

```text
Ground PC
192.168.50.10
     │
     ▼
Ground Gateway
ppp0: 10.90.0.1
     │
    T900
     │
UAV Raspberry
ppp0: 10.90.0.2
eth0: 192.168.20.1
     │
     ├── Device 192.168.20.10
     ├── Device 192.168.20.11
     └── Device 192.168.20.12
```

Dengan routing yang sesuai, Ground dapat mengakses jaringan UAV.

---

# 8. Apakah PPP Kompatibel dengan T900?

Secara konsep/protokol: **ya, sangat masuk akal untuk diuji**.

RFC 1662 menjelaskan PPP asynchronous dapat bekerja di link:

- 8-bit.
- No parity.
- Full-duplex.
- Point-to-point.

T900 memberikan:

- Full-duplex serial link.
- Transparent/pass-through mode.
- 57,600 bps.

Karena itu karakteristik dasar T900 sesuai dengan kebutuhan PPP asynchronous.

Namun:

> Kombinasi spesifik T900 Pro + PPP belum dianggap tervalidasi untuk sistem operasional sampai dilakukan bench test.

Hal yang perlu diuji:

- Apakah seluruh byte PPP diteruskan secara transparan.
- Packet loss pada kondisi RF lemah.
- Recovery ketika RF terputus.
- Waktu renegosiasi PPP.
- Throughput efektif.
- Latency.
- Stabilitas beberapa jam.
- Stabilitas ketika UAV bergerak.

---

# 9. Peran `pppd`

`pppd` adalah daemon Linux yang:

1. Membuka serial port.
2. Menjalankan negosiasi PPP.
3. Menetapkan IP kedua peer.
4. Membuat interface `ppp0`.
5. Memantau link.
6. Dapat mencoba reconnect apabila koneksi putus.

Contoh konfigurasi konsep UAV:

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

Ground:

```text
/dev/t900
57600
local
noauth
10.90.0.1:10.90.0.2
persist
maxfail 0
holdoff 3
lcp-echo-interval 5
lcp-echo-failure 3
```

**Catatan:** konfigurasi di atas adalah baseline untuk bench test, bukan konfigurasi final penerbangan.

Disarankan disimpan sebagai peer file, misalnya:

```text
/etc/ppp/peers/t900
```

sehingga startup dapat dilakukan dengan:

```bash
sudo pppd call t900
```

---

# 10. Reliability PPP

PPP menyediakan framing dan FCS (*Frame Check Sequence*) untuk mendeteksi frame yang corrupt.

PPP sendiri bukan protokol retransmission aplikasi.

Contoh stack:

```text
MQTT
 ↓
TCP
 ↓
IP
 ↓
PPP
 ↓
Serial
 ↓
T900
```

Apabila terjadi kehilangan packet:

- PPP/FCS membantu mendeteksi frame yang rusak.
- TCP menangani retransmission.
- MQTT dapat memberi level delivery tambahan melalui QoS.

`pppd` juga mempunyai mekanisme LCP Echo untuk mengetahui kondisi peer.

Contoh:

```text
lcp-echo-interval 5
lcp-echo-failure 3
```

Artinya link dapat dikonfigurasi untuk memeriksa peer secara berkala dan mengambil tindakan ketika peer tidak merespons.

---

# 11. Bandwidth T900

Serial speed T900 adalah 57,600 bps.

Pada UART 8N1, satu byte biasanya membutuhkan:

```text
1 start bit
8 data bit
1 stop bit
----------------
10 bit
```

Maka theoretical serial payload:

```text
57,600 / 10
≈ 5,760 byte/s
≈ 5.6 kB/s
```

Throughput aplikasi nyata akan lebih rendah karena terdapat:

- RF overhead.
- PPP framing.
- IP header.
- TCP header.
- MQTT header.
- Retransmission jika packet loss.

Karena itu link ini cocok untuk:

```text
DoA
GPS
Heading
RSSI
Confidence
Status
Small JSON/Binary telemetry
MQTT
Small HTTP request
Configuration command
Acknowledgement
SSH maintenance ringan
```

Tidak cocok sebagai link utama untuk:

```text
Raw IQ KrakenSDR
Full spectrum streaming
High-rate waterfall
Video
VNC / Remote Desktop
Large file transfer
```

---

# 12. KrakenSDR Remote Configuration

Pada software `krakensdr_doa`, Kraken mempunyai Web UI dan mekanisme remote settings.

Web UI dapat diakses pada:

```text
http://KRAKEN_IP:8080/
```

Software juga menyediakan middleware settings API:

```text
GET  http://KRAKEN_IP:8042/settings
POST http://KRAKEN_IP:8042/settings
```

Mekanisme sederhananya:

```text
GET
 ↓
ambil settings.json

ubah setting

POST
 ↓
kirim setting baru
 ↓
Kraken DSP membaca perubahan
 ↓
setting diterapkan
```

Ini berarti Kraken sudah mempunyai kemampuan konfigurasi melalui HTTP.

---

# 13. Apakah Ground Harus Langsung GET/POST Kraken?

Tidak harus.

Ada dua opsi.

## Opsi 1 — Direct HTTP over PPP

Jika PPP sudah up:

```text
Ground 10.90.0.1
      │
      │ HTTP
      ▼
UAV 10.90.0.2:8042
```

Ground dapat secara teoritis langsung:

```text
GET http://10.90.0.2:8042/settings
```

atau POST settings.

Kelebihan:

- Implementasi sederhana.
- Tidak perlu translator tambahan untuk command tertentu.

Kekurangan:

- Ground menjadi lebih tergantung pada format internal Kraken.
- Tidak semua state sistem berasal dari Kraken.
- Lebih sulit membuat protokol sistem yang tetap stabil jika software Kraken berubah.

## Opsi 2 — UAV Controller/Gateway

Ini adalah opsi yang direkomendasikan.

```text
Ground GUI
   │
   │ MQTT command
   ▼
UAV Controller
   │
   │ HTTP GET/POST localhost
   ▼
Kraken Middleware
```

Contoh:

```text
Ground:
kraken/cmd/frequency = 433920000

             ↓ MQTT

UAV Controller

             ↓ HTTP POST

Kraken

             ↓ Applied

UAV Controller

             ↓ MQTT ACK

Ground:
kraken/ack/frequency = OK
```

UAV Controller adalah software tambahan buatan sistem kita, bukan komponen internal Kraken.

---

# 14. Peran UAV Controller/Gateway

UAV Controller mempunyai beberapa fungsi.

## A. Mengambil data Kraken

```text
Kraken
 ↓
DoA / status
 ↓
Controller
 ↓
MQTT
 ↓
Ground
```

## B. Menerima command

```text
Ground
 ↓
MQTT
 ↓
Controller
 ↓
Kraken API
```

## C. Mengirim acknowledgement

```text
Kraken setting applied
 ↓
Controller
 ↓
MQTT ACK
 ↓
Ground GUI
```

## D. Menggabungkan data UAV

Contoh:

```text
Kraken relative DoA
        +
Drone heading
        +
GPS
        ↓
Global bearing
```

Hal ini penting karena DoA Kraken relatif terhadap orientasi antenna array.

Contoh:

```text
Drone heading = 120°
Kraken DoA    = 40°

Global bearing
= 120 + 40
= 160°
```

Normalisasi dilakukan pada range 0–360°.

---

# 15. Mengapa MQTT Cocok?

MQTT cocok karena:

- Payload kecil.
- Pub/sub.
- Mudah dipisahkan antara telemetry dan command.
- Bisa berjalan melalui TCP/IP PPP.
- Mendukung QoS.
- Mendukung retained state.
- Mudah digunakan oleh GUI UAV maupun Ground.

Arsitektur:

```text
KrakenSDR
    │
UAV Controller
    │
MQTT
    │
  PPP
    │
  T900
    │
Ground MQTT
    │
Ground GUI
```

---

# 16. MQTT Topic Design

Contoh desain topic:

## UAV → Ground

```text
kraken/telemetry/doa
kraken/telemetry/rssi
kraken/telemetry/confidence
kraken/telemetry/frequency

kraken/state/running
kraken/state/frequency
kraken/state/gain
kraken/state/bandwidth

uav/gps/latitude
uav/gps/longitude
uav/heading
uav/altitude
uav/battery

system/raspberry/temperature
system/kraken/status
system/t900/link
```

## Ground → UAV

```text
kraken/cmd/set_frequency
kraken/cmd/set_gain
kraken/cmd/set_bandwidth
kraken/cmd/start
kraken/cmd/stop
kraken/cmd/restart
kraken/cmd/request_settings
```

## UAV → Ground ACK

```text
kraken/ack/set_frequency
kraken/ack/set_gain
kraken/ack/set_bandwidth
kraken/ack/start
kraken/ack/stop
kraken/ack/restart
```

---

# 17. MQTT QoS Recommendation

Jangan menggunakan QoS tinggi untuk seluruh telemetry.

Realtime data:

| Data | QoS |
|---|---:|
| DoA | 0 |
| RSSI | 0 |
| GPS | 0 |
| Heading | 0 |
| Altitude | 0 |
| Realtime health | 0 |

Command:

| Data | QoS |
|---|---:|
| Set frequency | 1 |
| Set gain | 1 |
| Start/Stop | 1 |
| Restart | 1 |
| Request settings | 1 |
| ACK | 1 |

Persistent state:

```text
QoS 1 + Retain
```

Contohnya:

```text
kraken/state/frequency
kraken/state/running
```

Alasannya:

Jika salah satu DoA hilang:

```text
137.2°
137.4°   ← lost
137.6°
137.9°
```

tidak perlu melakukan retransmission besar karena data baru akan segera menggantikannya.

Sebaliknya:

```text
SET FREQUENCY 433.920 MHz
```

harus diterima.

---

# 18. Satu Broker vs Dua Broker

Ada dua desain.

## Satu broker di Ground

```text
UAV Client
    │
   T900
    │
Ground Broker
```

Sederhana, tetapi jika RF hilang, aplikasi UAV kehilangan broker.

## Dua broker

Direkomendasikan untuk sistem yang ingin masing-masing sisi tetap berdiri sendiri.

```text
                   UAV

UAV GUI ──────► Mosquitto UAV
                     │
                     │ MQTT Bridge
                     │
                    PPP
                     │
                    T900
                     │
                     ▼
               Mosquitto Ground
                     │
                     ▼
                Ground GUI
```

Mosquitto mendukung broker bridge dan topic dapat ditentukan arahnya sebagai:

```text
in
out
both
```

Keuntungannya:

- UAV GUI tetap bekerja saat RF terputus.
- Ground GUI tetap bekerja dengan state terakhir.
- Broker bridge dapat reconnect.
- Hanya topic penting yang perlu dilewatkan T900.

---

# 19. Contoh MQTT Bridge Concept

Contoh konsep, bukan konfigurasi final:

```text
connection t900-uav
address 10.90.0.2:1883

topic kraken/telemetry/# in 0
topic kraken/state/# in 1
topic uav/# in 0

topic kraken/cmd/# out 1
topic kraken/ack/# in 1
```

Arah aktual harus disesuaikan dengan broker mana yang menjadi sisi lokal.

Jangan bridge seluruh `#` jika tidak diperlukan karena bandwidth T900 terbatas.

---

# 20. Data Mirroring, Bukan Screen Mirroring

Target Ground GUI:

```text
┌──────────────────────────────────────┐
│       KRAKEN UAV RDF CONSOLE         │
│                                      │
│ Link          ● ONLINE               │
│ Kraken        ● RUNNING              │
│                                      │
│ Frequency      433.920 MHz           │
│ Gain            24 dB                │
│ DoA            137.4°                │
│ RSSI           -54.2 dBm             │
│ Confidence       92 %                │
│                                      │
│ Drone Heading   121.5°               │
│ Global Bearing  258.9°               │
│                                      │
│ [433.920 MHz] [ SET ]                │
│ [START]        [STOP]                │
└──────────────────────────────────────┘
```

Ground GUI tidak menerima gambar layar Raspberry.

Ground menerima:

```text
state
telemetry
command response
```

kemudian menggambar UI sendiri.

Ini jauh lebih hemat bandwidth.

---

# 21. Apakah Kraken Web UI Masih Bisa Dibuka?

Jika PPP berhasil dan Kraken service listen pada interface yang dapat dijangkau, secara teori Ground dapat mencoba:

```text
http://10.90.0.2:8080
```

atau API:

```text
http://10.90.0.2:8042/settings
```

Jadi PPP memang membuat Kraken dapat diperlakukan seperti host IP remote.

Namun link T900 hanya 57,600 bps.

Karena itu:

- HTTP GET/POST kecil: masuk akal.
- Settings page sederhana: mungkin.
- Full Kraken Web UI: bisa sangat lambat.
- Spectrum/waterfall live: tidak direkomendasikan.

Web Kraken sebaiknya diperlakukan sebagai:

```text
Maintenance / Debugging Interface
```

bukan Ground Console utama.

---

# 22. Persistent USB Naming T900

Jangan hard-code:

```text
/dev/ttyUSB0
```

karena Linux dapat mengubah nomor berdasarkan urutan enumerasi.

Contoh:

```text
Hari ini:
T900 = /dev/ttyUSB0

Besok:
T900 = /dev/ttyUSB1
```

Gunakan persistent device naming.

## Pilihan 1 — `/dev/serial/by-id`

Cek:

```bash
ls -l /dev/serial/by-id/
```

Jika T900 mempunyai ID yang stabil:

```text
/dev/serial/by-id/usb-xxxxxxxx
```

gunakan path tersebut pada `pppd`.

## Pilihan 2 — `/dev/serial/by-path`

Jika CH340/CH341 tidak mempunyai serial number unik:

```bash
ls -l /dev/serial/by-path/
```

`by-path` mengikat perangkat terhadap port USB fisik.

Selama T900 selalu dipasang pada port yang sama, nama tersebut stabil.

## Pilihan 3 — Custom udev Alias

Target yang direkomendasikan:

```text
/dev/t900
```

UAV:

```text
/dev/t900 → T900-UAV
```

Ground:

```text
/dev/t900 → T900-Ground
```

Sehingga `pppd` selalu menggunakan:

```bash
pppd /dev/t900 57600
```

dan tidak peduli apakah kernel sedang memberi nama `ttyUSB0`, `ttyUSB1`, atau lainnya.

---

# 23. Cara Inspect T900 USB

Setelah T900 terpasang:

```bash
ls -l /dev/serial/by-id/
```

```bash
ls -l /dev/serial/by-path/
```

```bash
udevadm info --query=property --name=/dev/ttyUSB0
```

atau:

```bash
udevadm info -a -n /dev/ttyUSB0
```

Cari:

```text
ID_VENDOR_ID
ID_MODEL_ID
ID_SERIAL
ID_PATH
```

Urutan pemilihan identitas:

```text
Unique serial number
       ↓ jika tidak ada
/dev/serial/by-id
       ↓ jika tidak unik
/dev/serial/by-path
       ↓ jika ingin alias lebih rapi
custom /dev/t900
```

Jangan membuat rule hanya berdasarkan CH340 vendor/product apabila terdapat beberapa perangkat CH340 identik, karena rule dapat menunjuk perangkat yang salah.

---

# 24. Auto Start dan Recovery

Target akhir:

```text
Raspberry boot
     │
     ├─ Kraken service start
     ├─ T900 detected
     ├─ /dev/t900 tersedia
     ├─ pppd start
     ├─ ppp0 = 10.90.0.2
     ├─ Mosquitto start
     └─ UAV Controller start
```

Ground:

```text
Ground boot
     │
     ├─ T900 detected
     ├─ /dev/t900 tersedia
     ├─ pppd start
     ├─ ppp0 = 10.90.0.1
     ├─ Mosquitto start
     └─ Ground GUI start
```

`pppd` dapat menggunakan:

```text
persist
maxfail 0
holdoff
lcp-echo-interval
lcp-echo-failure
```

agar link mencoba pulih setelah gangguan.

---

# 25. Contoh IP Plan

Disarankan memisahkan PPP subnet dari jaringan lokal.

## PPP

```text
Ground : 10.90.0.1
UAV    : 10.90.0.2
```

## Ground LAN

```text
192.168.50.0/24

Ground Gateway : 192.168.50.1
PC Console     : 192.168.50.10
```

## UAV LAN opsional

```text
192.168.20.0/24

Raspberry Pi   : 192.168.20.1
Device A       : 192.168.20.10
Device B       : 192.168.20.11
```

PPP tetap:

```text
10.90.0.1 ↔ 10.90.0.2
```

Jangan menggunakan subnet PPP yang sama dengan jaringan existing.

---

# 26. Linux vs Windows Ground

## Linux Ground

Paling sederhana:

```text
T900-Ground
    │ USB
Linux PC
    │
pppd
    │
ppp0
```

Direkomendasikan untuk prototyping dan sistem final apabila OS bebas dipilih.

## Windows Ground

Lebih mudah menggunakan Linux gateway:

```text
T900-Ground
    │ USB
Linux Gateway
    │ Ethernet
Windows Console
```

Windows tidak perlu menangani serial PPP secara langsung.

Windows cukup menggunakan jaringan Ethernet biasa menuju Ground Gateway.

---

# 27. Parameter Awal T900

Untuk bench test, pertahankan parameter T900 sedekat mungkin dengan factory default:

```text
Mode       : Duplex
Data       : Transparent / Pass-through
Baud       : 57600
```

Kedua unit:

```text
T900-UAV
T900-Ground
```

harus mempunyai parameter RF/link yang kompatibel/sama.

Menurut manual resmi:

- ACT berkedip: pairing sedang dilakukan.
- ACT hijau tetap: pairing berhasil.
- COM berkedip: sedang terjadi transfer data.

Jangan mengubah parameter RF sebelum transparent serial link dasar berhasil diuji.

---

# 28. Istilah T900 Pro Assistant Bahasa China

Beberapa istilah yang berguna:

```text
串口
Serial Port

波特率
Baud Rate

加载参数
Load Parameters

保存参数
Save Parameters

恢复默认
Restore Default

透明传输
Transparent Transmission / Pass-through

发射功率
Transmit Power

最小频率
Minimum Frequency

最大频率
Maximum Frequency
```

Untuk konsep PPP, bagian terpenting adalah:

```text
Transparent mode
57600 baud
Duplex
```

---

# 29. Urutan Implementasi yang Direkomendasikan

Jangan langsung menggabungkan semua sistem.

## Tahap 1 — T900 Transparent Serial

```text
PC A
 │
T900-UAV
 )))
 (((
T900-Ground
 │
PC B
```

Kirim teks:

```text
HELLO T900
```

Pastikan byte sampai dengan benar dua arah.

---

## Tahap 2 — PPP tanpa Kraken

Gunakan dua Linux machine:

```text
Linux A
10.90.0.2
    │
  T900
    │
Linux B
10.90.0.1
```

Target:

```bash
ping 10.90.0.1
```

dan sebaliknya.

Uji:

- Ping 1 jam.
- Ping packet size berbeda.
- Cabut power salah satu T900.
- Nyalakan kembali.
- Lihat apakah PPP recover.
- Ukur reconnect time.

---

## Tahap 3 — TCP/HTTP Test

Setelah PPP stabil:

```bash
python3 -m http.server 8000
```

akses dari peer:

```text
http://10.90.0.2:8000
```

Tujuannya memastikan TCP bekerja melalui PPP/T900.

---

## Tahap 4 — MQTT

Pasang Mosquitto.

Test:

```text
UAV publish
 ↓
T900 PPP
 ↓
Ground subscribe
```

dan arah balik.

Uji QoS 0 dan QoS 1.

---

## Tahap 5 — Kraken API

Dari Ground:

```text
GET 10.90.0.2:8042/settings
```

jika memungkinkan.

Kemudian uji perubahan setting non-kritis melalui POST.

---

## Tahap 6 — UAV Controller

Buat service:

```text
MQTT command
      ↓
UAV Controller
      ↓
Kraken API
      ↓
ACK
```

---

## Tahap 7 — Data DoA

```text
Kraken DoA
    ↓
Controller
    ↓
MQTT QoS 0
    ↓
Ground GUI
```

---

## Tahap 8 — GPS/Heading Fusion

Tambahkan:

```text
Flight Controller
        │ MAVLink
        ▼
Raspberry
        │
        ├─ GPS
        ├─ Heading
        └─ Kraken DoA
              │
              ▼
        Global Bearing
```

---

## Tahap 9 — Long Duration Test

Minimal uji:

```text
2 jam
4 jam
8 jam
```

monitor:

- `ppp0` uptime.
- MQTT disconnect count.
- Packet loss.
- CPU temperature.
- Raspberry load.
- T900 RSSI jika tersedia.
- Kraken status.
- Latency DoA.
- Number of stale messages.

---

## Tahap 10 — RF/Flight Test

Setelah bench test stabil:

```text
static LOS test
       ↓
short range outdoor
       ↓
vehicle movement
       ↓
low-altitude UAV
       ↓
operational range test
```

---

# 30. Parameter yang Harus Diukur Saat Test

## PPP

```text
Ping latency
Packet loss
Reconnect time
PPP uptime
FCS/error counters
```

## MQTT

```text
Messages/s
End-to-end latency
QoS retry
Bridge reconnect
Queue depth
```

## Kraken

```text
DoA update rate
Processing latency
Confidence
Signal level
CPU load
CPU temperature
```

## T900

```text
Link status
RSSI if available
COM activity
Distance
Antenna orientation
Packet stability
```

---

# 31. Risiko Teknis

## Risiko 1 — T900 bandwidth kecil

Mitigasi:

- Kirim data yang sudah diproses.
- Jangan kirim raw IQ.
- Jangan kirim full spectrum.
- Gunakan compact payload.
- QoS 0 untuk realtime telemetry.

## Risiko 2 — TCP retransmission menyebabkan stale telemetry

Mitigasi:

- Realtime DoA QoS 0.
- Berikan timestamp.
- Ground GUI buang data terlalu lama.
- Hindari queue besar.

## Risiko 3 — USB tty berubah

Mitigasi:

```text
/dev/serial/by-id
/dev/serial/by-path
custom /dev/t900
```

## Risiko 4 — RF link hilang

Mitigasi:

- `pppd persist`.
- LCP echo.
- MQTT reconnect.
- Dua MQTT broker.
- UAV tetap processing secara lokal.

## Risiko 5 — Ground kehilangan control

Mitigasi:

UAV Controller tidak boleh bergantung pada Ground untuk tetap menjalankan Kraken.

```text
RF LOST

Kraken      → tetap running
UAV GUI     → tetap running
UAV Broker  → tetap running
DoA         → tetap diproses

Ground      → offline/stale state
```

---

# 32. Recommended Final Software Components

## UAV Raspberry

```text
Linux
KrakenSDR software
pppd
Mosquitto
UAV Controller/Gateway
MAVLink receiver
GPS/heading fusion
System health service
Optional local GUI
```

## Ground

```text
Linux PPP endpoint
Mosquitto Ground
Ground Console GUI
Map visualization
Data logger
Alarm/health monitor
```

Jika Console Windows:

```text
Linux Ground Gateway
       +
Windows Console
```

---

# 33. Recommended Operational Data Flow

## Downlink

```text
KrakenSDR
   │
   ▼
DoA Processing
   │
   ▼
UAV Controller
   │
   ├─ add timestamp
   ├─ add GPS
   ├─ add heading
   ├─ calculate global bearing
   └─ add status
         │
         ▼
      MQTT
         │
        PPP
         │
     T900-UAV
        )))
        (((
    T900-Ground
         │
        PPP
         │
      MQTT
         │
         ▼
   Ground Console
```

## Uplink

```text
Ground Operator
      │
      ▼
Ground GUI
      │
MQTT Command
      │
     PPP
      │
T900-Ground
     )))
     (((
 T900-UAV
      │
     PPP
      │
 UAV Controller
      │
HTTP GET/POST
      │
      ▼
 KrakenSDR
```

---

# 34. Example State Synchronization

Operator mengubah frequency:

```text
433.920 MHz
     ↓
915.000 MHz
```

Ground:

```text
Publish:
kraken/cmd/set_frequency
915000000
```

UAV:

```text
Controller receives command
        ↓
Validate value
        ↓
POST Kraken settings
        ↓
Read current state
        ↓
Publish:
kraken/state/frequency = 915000000
kraken/ack/set_frequency = OK
```

Ground GUI hanya menampilkan:

```text
915.000 MHz
APPLIED ✓
```

setelah acknowledgement/state baru diterima.

Ini mencegah GUI menganggap setting berubah padahal Kraken gagal menerapkannya.

---

# 35. Payload Format

Untuk prototyping, JSON mudah digunakan:

```json
{
  "ts": 1787985600,
  "doa": 137.4,
  "global_bearing": 258.9,
  "rssi": -54.2,
  "confidence": 0.92,
  "frequency": 433920000,
  "lat": -6.9147,
  "lon": 107.6098,
  "heading": 121.5
}
```

Setelah sistem stabil dan bandwidth ingin dioptimalkan, payload dapat dipindah menjadi:

- MessagePack.
- CBOR.
- Protobuf.
- Binary struct.

Jangan optimasi terlalu awal; validasi reliability dahulu.

---

# 36. Timestamp dan Stale Data

Setiap telemetry penting sebaiknya mempunyai timestamp.

Contoh:

```json
{
  "ts_ms": 1787985600123,
  "doa": 137.4
}
```

Ground dapat menandai:

```text
< 1 s   = LIVE
1–3 s   = DELAYED
> 3 s   = STALE
```

Nilai batas final ditentukan berdasarkan update rate sistem.

Ini penting karena TCP dapat melakukan retransmission pada kondisi RF buruk.

---

# 37. Heartbeat

Tambahkan heartbeat ringan:

```text
system/uav/heartbeat
```

misalnya 1 Hz.

Payload:

```json
{
  "uptime": 4821,
  "kraken": "running",
  "ppp": "up",
  "cpu_temp": 54.2
}
```

Ground dapat menampilkan:

```text
UAV LINK    ONLINE
KRAKEN      RUNNING
DATA AGE    0.3 s
```

---

# 38. Security

Untuk bench test tertutup, sistem dapat dimulai sederhana.

Untuk deployment lebih serius pertimbangkan:

- MQTT authentication.
- Topic ACL.
- Firewall.
- Hanya expose port yang diperlukan.
- Tidak expose Kraken Web UI ke jaringan lain secara default.
- Command validation di UAV Controller.
- Range checking pada frequency/gain.
- Unique command ID.
- ACK/NACK.

Contoh command:

```json
{
  "id": "cmd-000127",
  "command": "set_frequency",
  "value": 433920000
}
```

ACK:

```json
{
  "id": "cmd-000127",
  "status": "ok"
}
```

---

# 39. Keputusan Desain Saat Ini

## Dipilih

- KrakenSDR processing di UAV.
- Raspberry Pi pada UAV.
- T900 sebagai transparent wireless serial link.
- Nama: T900-UAV dan T900-Ground.
- PPP untuk membuat IP point-to-point.
- `pppd` pada endpoint Linux.
- MQTT untuk telemetry/control.
- Data/state mirroring.
- UAV Controller untuk menerjemahkan MQTT ↔ Kraken HTTP API.
- Persistent USB naming.
- Dua broker MQTT sebagai opsi yang direkomendasikan.
- Linux Ground Gateway jika Console Windows.

## Tidak dipilih sebagai desain utama

- Raw Kraken IQ melalui T900.
- Full Kraken UI sebagai operator interface.
- Screen mirroring.
- UART-to-LAN converter.
- Hard-code `/dev/ttyUSB0`.
- T900 sebagai Ethernet Layer-2 bridge.

---

# 40. Arsitektur Final Ringkas

```text
                      UAV
                       │
                 Antenna Array
                       │
                   KrakenSDR
                       │ USB3
                       ▼
                Raspberry Pi
          ┌────────────┼────────────┐
          │            │            │
      Kraken DoA   Controller    Mosquitto
          │            │            │
          └────────────┴────────────┘
                       │
                     MQTT
                       │
                      IP
                       │
                     ppp0
                  10.90.0.2
                       │
                    /dev/t900
                       │
                   T900-UAV
                       )))
                       (((
                  T900-Ground
                       │
                    /dev/t900
                       │
                     ppp0
                  10.90.0.1
                       │
                     MQTT
                       │
                Ground Console
```

Satu kalimat untuk menggambarkan sistem:

> **T900 berfungsi sebagai transparent wireless serial transport, PPP mengubah transport tersebut menjadi point-to-point IP network, MQTT membawa telemetry dan command, sedangkan Raspberry Pi memproses KrakenSDR dan menjembatani remote command ke Kraken API.**

---

# 41. Checklist Hardware

## UAV

- [ ] Drone Cargo.
- [ ] KrakenSDR.
- [ ] Antenna array.
- [ ] Raspberry Pi 5.
- [ ] T900-UAV.
- [ ] Power supply KrakenSDR.
- [ ] Power supply Raspberry Pi.
- [ ] Power T900.
- [ ] USB data cable Kraken.
- [ ] USB serial T900.
- [ ] Flight Controller/MAVLink connection jika GPS-heading diambil dari FC.

## Ground

- [ ] T900-Ground.
- [ ] Linux PC atau Linux Ground Gateway.
- [ ] Ground Console PC.
- [ ] Antenna T900 Ground.
- [ ] Power.
- [ ] Ethernet jika menggunakan separate Ground Gateway.

---

# 42. Checklist Software

## UAV

- [ ] KrakenSDR operational.
- [ ] Kraken Web UI accessible locally.
- [ ] Kraken settings API tested.
- [ ] T900 appears as tty device.
- [ ] Persistent `/dev/t900`.
- [ ] `pppd`.
- [ ] PPP IP 10.90.0.2.
- [ ] Mosquitto.
- [ ] UAV Controller.
- [ ] MQTT topics.
- [ ] Heartbeat.
- [ ] GPS/heading integration.

## Ground

- [ ] T900 appears as tty device.
- [ ] Persistent `/dev/t900`.
- [ ] `pppd`.
- [ ] PPP IP 10.90.0.1.
- [ ] Mosquitto.
- [ ] MQTT bridge if used.
- [ ] Ground GUI.
- [ ] Logging.

---

# 43. Acceptance Test Minimum

Sebelum dipasang di UAV, sistem minimal harus memenuhi:

```text
[ ] T900 transparent serial dua arah stabil.
[ ] PPP up tanpa intervensi manual.
[ ] Ping dua arah berhasil.
[ ] PPP recover setelah T900 restart.
[ ] PPP recover setelah RF interruption.
[ ] MQTT QoS 0 bekerja.
[ ] MQTT QoS 1 bekerja.
[ ] UAV → Ground telemetry stabil.
[ ] Ground → UAV command stabil.
[ ] Kraken setting dapat diubah.
[ ] ACK Ground sesuai state aktual Kraken.
[ ] Tidak ada backlog besar setelah RF drop.
[ ] /dev/t900 tetap benar setelah reboot.
[ ] Sistem auto-start setelah power cycle.
[ ] Kraken tetap processing saat Ground offline.
```

---

# 44. Sumber Referensi

1. **Makeflyeasy / MFE — T900 Pro User Manual**  
   https://fw.makeflyeasy.com/T900%20%20Pro/T900%20Pro%E7%94%A8%E6%88%B7%E6%89%8B%E5%86%8C%EF%BC%88T900%20Pro%20User%20Manual%EF%BC%89.pdf

2. **KrakenRF — krakensdr_doa**  
   https://github.com/krakenrf/krakensdr_doa

3. **KrakenRF — KrakenSDR Suite V2**  
   https://github.com/krakenrf/krakensdr_suite

4. **RFC 1662 — PPP in HDLC-like Framing**  
   https://www.rfc-editor.org/rfc/rfc1662

5. **Linux `pppd(8)` Manual**  
   https://man7.org/linux/man-pages/man8/pppd.8.html

6. **Eclipse Mosquitto Configuration / Broker Bridge**  
   https://www.mosquitto.org/man/mosquitto-conf-5.html

7. **systemd/udev Persistent Serial Naming Rules**  
   https://cgit.freedesktop.org/systemd/systemd/commit/src/udev?id=19c5f19d69bb5f520fa7213239490c55de06d99d

---

# 45. Catatan Penting

Dokumentasi ini membedakan antara:

### Sudah didukung/didokumentasikan

- T900 full-duplex serial.
- T900 transparent/pass-through.
- T900 57,600 bps.
- Kraken Web UI.
- Kraken settings via HTTP GET/POST.
- PPP pada asynchronous full-duplex serial.
- `pppd` untuk Linux.
- Mosquitto broker bridge.
- Linux persistent serial naming.

### Masih harus dibuktikan melalui test sistem

- Stabilitas PPP secara spesifik di atas link RF T900 Pro.
- Throughput efektif PPP + T900.
- Packet loss pada range operasi.
- Recovery behavior setelah RF loss.
- Latency MQTT end-to-end.
- Batas update rate DoA yang optimal.
- Kinerja saat UAV bergerak.
- Dampak interferensi dan antenna placement.

**Jangan menjadikan sistem operasional/final sebelum bagian ini tervalidasi melalui bench test dan flight test.**

---

# 46. Next Step

Urutan pekerjaan berikutnya yang paling aman adalah:

```text
1. Siapkan T900-UAV dan T900-Ground
            ↓
2. Test transparent serial
            ↓
3. Identifikasi USB device
            ↓
4. Buat persistent /dev/t900
            ↓
5. Install dan konfigurasi pppd
            ↓
6. Ping 10.90.0.1 ↔ 10.90.0.2
            ↓
7. Stress/reconnect test
            ↓
8. Install MQTT
            ↓
9. Test telemetry dan command
            ↓
10. Hubungkan Kraken API
            ↓
11. Buat UAV Controller
            ↓
12. Buat Ground GUI
            ↓
13. Tambah GPS/heading fusion
            ↓
14. Long-duration test
            ↓
15. Flight test
```

---

**End of Document**
