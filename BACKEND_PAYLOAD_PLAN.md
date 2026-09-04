# Backend Payload Plan — SDR-DoA over T900 PPP

## Status dan Sumber

Dokumen ini adalah rancangan backend yang diturunkan dari dokumentasi project dan hasil bench test throughput yang diberikan. Ini belum merupakan implementasi service MQTT/Controller dan belum menjadi validasi runtime baru oleh project agent.

---

## 1. Baseline Jaringan Saat Ini

### Management Raspberry

Konfigurasi terbaru yang diberikan user menjadi baseline aktif project:

```text
Raspberry eth0 : 192.168.100.100/24
Bonjour/mDNS   : doasdr.local
SSH           : ssh doasdr@doasdr.local
```

WiFi tetap berfungsi sebagai connectivity sesuai dokumentasi sebelumnya. Ethernet/LAN dipakai untuk management dan jalur recovery SSH.

> Beberapa arsip dokumentasi lama masih menyebut `192.168.50.100`. Arsip tersebut tidak diubah agar sumber historis tetap utuh; untuk pekerjaan baru, gunakan `192.168.100.100` dan `doasdr.local` sampai ada perubahan baseline resmi.

### Link telemetry

```text
UAV/Raspberry PPP : 10.90.0.2
Ground PPP        : 10.90.0.1
Serial            : 57600 bit/s
Transport         : T900 Transparent → PPP → IP
```

---

## 2. Batas Throughput yang Harus Menjadi Policy

Hasil `iperf3` UDP reverse mode, datagram 256 byte, 30 detik per rate:

| Requested | Receiver | Loss | Jitter | Interpretasi |
|---:|---:|---:|---:|---|
| 10 kbit/s | 10.0 kbit/s | 0% | 11.875 ms | sangat stabil |
| 12 kbit/s | 12.0 kbit/s | 0% | 11.726 ms | sangat stabil |
| 15 kbit/s | 15.0 kbit/s | 0% | 9.199 ms | stabil |
| 18 kbit/s | 18.0 kbit/s | 0% | 9.278 ms | clean ceiling yang diuji |
| 20 kbit/s | 17.6 kbit/s | 11% | 21.278 ms | mulai overload |
| 30 kbit/s | 16.3 kbit/s | 45% | 70.439 ms | overload |
| 40 kbit/s | 14.5 kbit/s | 63% | 90.229 ms | severe overload |

Policy awal:

```text
Total continuous application traffic : 8–10 kbit/s
Short burst                          : 12–15 kbit/s
Maximum tested clean ceiling         : 18 kbit/s
Jangan rancang operasi normal        : >=20 kbit/s
Idle RTT tercatat                    : sekitar 154 ms
```

`18 kbit/s` adalah clean ceiling pada bench test 30 detik, bukan jaminan lapangan dan bukan budget aman untuk MQTT. MQTT berjalan di atas TCP/IP/PPP sehingga header, ACK, retransmission, command, dan degradasi RF harus tetap memiliki ruang.

---

## 3. Data SDR-DoA yang Layak Dikirim

### 3.1 Telemetry cepat — wajib

Kirim hasil olahan, bukan raw data:

```text
Timestamp sumber (UTC epoch ms)
Sequence number
Relative DoA / azimuth
Confidence
RSSI / signal power
Channel frequency (Hz)
Processing latency (ms)
```

### 3.2 Navigasi — penting tetapi tidak perlu diulang pada setiap DoA

```text
Latitude
Longitude
Altitude
Platform heading
Heading source
```

Pisahkan navigation ke topic sendiri agar koordinat dan heading tidak menghabiskan payload pada setiap frame DoA.

### 3.3 State dan health

```text
SDR-DoA running/stopped
Current frequency
Gain
Array type
VFO configuration
T900/PPP link state
CPU temperature/load
Uptime
Queue/drop counters
```

State relatif tetap dikirim saat startup, saat berubah, dan sebagai retained state. Health/heartbeat dikirim periodik dengan rate rendah.

### 3.4 Data opsional

#### Angular/DoA spectrum

Native record dapat memuat 360 power values sudut `0°..359°`. Ini adalah **angular spectrum**, bukan frequency spectrum. Jangan forward 360 nilai pada setiap frame.

Pilihan hemat:

```text
top-N peak angles
90/120/180 bins setelah downsample
uint8 atau int8 setelah normalisasi
```

#### Frequency spectrum

Frequency spectrum berbeda dari angular DoA spectrum dan tidak otomatis merupakan bagian dari standard third-party DoA record. Jika memang diperlukan, ambil dari pipeline internal, lalu:

```text
downsample → quantize → pack → publish on-demand
```

Baseline yang disarankan:

```text
128 atau 256 bins
uint8 power values
0.5–1 Hz
default OFF
```

---

## 4. MQTT Contract yang Disarankan

Namespace dapat memakai versioning sejak awal:

```text
sdr/v1/uav-01/telemetry/doa
sdr/v1/uav-01/telemetry/nav
sdr/v1/uav-01/telemetry/health
sdr/v1/uav-01/state
sdr/v1/uav-01/telemetry/doa360
sdr/v1/uav-01/telemetry/spectrum
sdr/v1/uav-01/cmd/#
sdr/v1/uav-01/ack/#
```

Jika ingin menjaga topic yang sudah ada di dokumentasi, alias tanpa `/v1/uav-01` dapat dipakai selama schema version tetap ada di payload. Jangan mengirim identitas station berulang pada telemetry cepat jika identitas sudah terwakili oleh topic.

### 4.1 DoA compact JSON — default prototype

Gunakan JSON satu baris tanpa whitespace/pretty-print:

```json
{"v":1,"seq":12345,"ts_ms":1788163200123,"az":137.4,"bearing":258.9,"conf":0.923,"rssi":-54.2,"f_hz":433920000,"proc_ms":12}
```

Definisi:

```text
v       : schema version
seq     : monotonic sequence per stream
ts_ms   : timestamp sumber UTC epoch milliseconds
az      : relative DoA dalam derajat 0–360
bearing : optional global bearing 0–360
conf    : konsisten, pilih 0.0–1.0
rssi    : dB sesuai definisi source
f_hz    : frequency dalam Hz
proc_ms : latency processing internal SDR-DoA
```

Tidak boleh ada nilai `NaN`, `Infinity`, field wajib yang hilang, atau confidence dengan campuran skala `0–1` dan `0–100`. `bearing` hanya valid jika heading dan mounting offset sudah diketahui.

### 4.2 Navigation payload

```json
{"v":1,"seq":501,"ts_ms":1788163200123,"lat":-6.9147,"lon":107.6098,"alt_m":120.4,"hdg":121.5,"src":"gps"}
```

### 4.3 State payload — QoS 1 + retain

```json
{"v":1,"ts_ms":1788163200123,"running":true,"f_hz":433920000,"gain":24,"array":"UCA","vfo":1}
```

Kirim pada startup, perubahan konfigurasi, request settings, dan optional refresh periodik lambat. Ground menampilkan state setelah menerima state aktual, bukan langsung setelah operator menekan tombol.

### 4.4 Command dan ACK

Command Ground → UAV memakai QoS 1 dan command ID unik:

```json
{"v":1,"id":"cmd-000127","cmd":"set_frequency","f_hz":433920000}
```

ACK UAV → Ground harus dikirim setelah validasi, eksekusi, dan read-back state:

```json
{"v":1,"id":"cmd-000127","ok":true,"cmd":"set_frequency","f_hz":433920000,"error":null}
```

Jika gagal, `ok:false` dan `error` harus eksplisit. Command tidak boleh mengeksekusi nilai malformed atau out-of-range. Command QoS 1 bukan pengganti idempotency; Controller tetap harus deduplicate berdasarkan `id`.

---

## 5. Jadwal Pengiriman Awal

Mulai dari schedule konservatif berikut, lalu naikkan hanya berdasarkan pengukuran actual MQTT wire traffic:

| Stream | Rate awal | Mode | Catatan |
|---|---:|---|---|
| DoA + confidence + RSSI + frequency | 2 Hz | QoS 0 | data terbaru mengalahkan frame lama |
| GPS/position | 1 Hz | QoS 0 | boleh 0.5 Hz jika posisi tidak cepat berubah |
| Heading | 1 Hz bersama nav | QoS 0 | jangan diulang di setiap DoA |
| Health/heartbeat | 0.5–1 Hz | QoS 0 | termasuk link/process status ringkas |
| State | event/startup + 0.2 Hz optional | QoS 1 + retain | bukan high-rate stream |
| ACK | event-driven | QoS 1 | prioritas setelah command |
| Angular spectrum | OFF; on-demand 0.2–0.5 Hz | QoS 0 | top-N/downsample, bukan 360 raw |
| Frequency spectrum | OFF; on-demand 0.5 Hz | QoS 0 | 128/256 uint8 bins |

Profile adaptif:

```text
LINK GOOD
  DoA 3 Hz; nav 1 Hz; spectrum tetap OFF kecuali diminta

LINK MEDIUM
  DoA 2 Hz; nav 1 Hz; spectrum OFF

LINK POOR
  DoA 1 Hz; nav 0.5–1 Hz; spectrum OFF; kirim state/health/ACK
```

Rate 5 Hz hanya boleh diaktifkan setelah test real-payload membuktikan total traffic tetap di bawah budget dan latency tidak membentuk queue. Jangan menjadikan 5 Hz sebagai default hanya karena 18 kbit/s pernah clean pada UDP bench.

---

## 6. Queue, Drop, dan Reconnect Policy

Realtime telemetry harus memakai **latest-value-wins**:

```text
producer lebih cepat
        ↓
queue dibatasi
        ↓
frame lama dibuang
        ↓
frame terbaru dipertahankan
```

Aturan minimum:

- QoS 0 untuk DoA, RSSI, confidence, nav, health, dan spectrum.
- Tidak melakukan replay burst seluruh history setelah RF/PPP reconnect.
- Setelah reconnect, kirim state retained/terbaru, health, lalu telemetry baru.
- Pisahkan queue command/ACK dari queue telemetry.
- Command menggunakan `id`, timeout, deduplication, dan ACK setelah state read-back.
- Catat `seq`, `ts_ms`, `received_at`, drop count, dan data age di Ground.
- Ground menandai data sebagai `LIVE`, `DELAYED`, atau `STALE`; baseline awal dapat memakai `<1 s`, `1–3 s`, dan `>3 s`, lalu disesuaikan dengan rate final.
- Jika link memburuk, matikan spectrum lebih dahulu, turunkan rate DoA, dan pertahankan command/ACK.

Full native record atau data historis boleh disimpan lokal di Raspberry untuk logging, tetapi tidak boleh otomatis diteruskan seluruhnya melalui T900.

---

## 7. Estimasi Payload dan Budget

Target awal:

```text
compact JSON payload : ideal 80–150 byte/message
absolute target       : <200 byte/message
```

Contoh payload-only, sebelum overhead MQTT/TCP/IP/PPP:

```text
150 byte × 5 Hz = 750 byte/s ≈ 6 kbit/s
300 byte × 1 Hz = 300 byte/s ≈ 2.4 kbit/s
```

Karena itu kombinasi aman awal sebaiknya bukan DoA 150 byte @5 Hz + seluruh stream lain. Mulai dengan DoA 2 Hz, nav 1 Hz, health 0.5–1 Hz, state event-driven, dan spectrum OFF.

Ukuran yang wajib diukur pada tahap berikutnya:

```text
JSON payload bytes
MQTT PUBLISH bytes
TCP/application bytes
actual serial/RF traffic
end-to-end latency
queue depth dan dropped frames
```

Jangan menyimpulkan aman hanya dari ukuran JSON; ukur traffic aktual di link.

---

## 8. Global Bearing

DoA SDR-DoA umumnya relatif terhadap orientasi antenna array. Jika heading platform dan mounting offset sudah tersedia:

```text
global_bearing = normalize(heading + mounting_offset + relative_doa, 0..360)
```

Simpan `relative_doa`, `heading`, dan `mounting_offset` secara terpisah untuk audit. Jika Controller menerbitkan `bearing`, Ground tetap sebaiknya dapat melihat sumber input dan timestamp-nya.

---

## 9. Evolusi Encoding

Tahap pertama gunakan compact JSON agar mudah debug dan inspeksi dengan MQTT CLI.

Setelah schema/reliability stabil:

```text
JSON compact → MessagePack/CBOR → binary struct bila perlu
```

Encoding baru harus mempunyai:

- schema version,
- backward/forward compatibility plan,
- decoder fixture,
- byte-size benchmark,
- malformed-input tests.

Jangan mengirim full JSON pretty-printed melalui link sempit dan jangan melakukan optimasi binary sebelum kontrak data stabil.

---

## 10. Test Gate Sebelum Integrasi SDR-DoA Penuh

1. Jalankan synthetic publisher dengan payload final.
2. Uji `iperf3` application-like pada `8K` dan `10K` selama minimal 60 detik sambil mengamati ping.
3. Uji MQTT dua arah melalui PPP.
4. Ukur end-to-end latency, loss, reconnect, backlog, dan stale-data behavior.
5. Uji malformed command, duplicate command ID, timeout, dan out-of-range frequency/gain.
6. Uji link drop: pastikan tidak ada burst history yang memenuhi queue setelah reconnect.
7. Baru hubungkan output DoA nyata dan validasi unit/arah/bearing.
8. Spectrum tetap menjadi fitur on-demand terakhir.

Perintah baseline dari dokumen throughput:

```bash
iperf3 -c 10.90.0.2 -R -b 8K -t 60
iperf3 -c 10.90.0.2 -R -b 10K -t 60
```

---

## Kesimpulan Operasional

```text
Process locally
  ↓
Select compact fields
  ↓
Publish DoA 2 Hz + nav 1 Hz + health 0.5–1 Hz
  ↓
State event-driven/retained; command/ACK QoS 1
  ↓
Spectrum OFF by default
  ↓
Keep total continuous application traffic ≤8–10 kbit/s
```

Link T900 dapat membawa data SDR-DoA yang sudah diproses—DoA, confidence, RSSI, frequency, position, heading, status, command, ACK, dan spectrum terkompresi—tetapi bukan raw IQ, video, screen mirroring, atau full native record berulang.
