# Dokumentasi Throughput T900 + PPP dan Perencanaan Payload SDR

## Hasil Bench Test Aktual, Batas Bandwidth, dan Desain Data MQTT

Platform link: T900-UAV ↔ T900-Ground  
Transport: Transparent Serial → PPP → IP  
Baud serial: 57,600 bit/s  
IP UAV/Raspberry: `10.90.0.2`  
IP Ground: `10.90.0.1`  
Metode uji: `iperf3` UDP reverse mode  
Arah uji utama: UAV/Raspberry → Ground  
UDP datagram payload: 256 byte  
Durasi tiap pengujian: 30 detik  
Baseline RTT idle: sekitar 154 ms rata-rata

---

# 1. Tujuan

Dokumentasi ini mencatat hasil pengujian throughput aktual link T900 + PPP dan menentukan batas bandwidth yang aman untuk aplikasi SDR melalui MQTT.

Target:

```text
SDR Processing
      │
      ▼
UAV Controller
      │
     MQTT
      │
     TCP
      │
      IP
      │
     PPP
      │
  T900-UAV
     )))
     ((( RF
 T900-Ground
      │
      ▼
 Ground Console
```

Fokus utama bukan throughput maksimum sesaat, tetapi:
- Maximum Clean Throughput
- Recommended Continuous Throughput
- Overload Threshold
- MQTT Payload Budget
- Data Priority

# 2. Baseline Latency PPP

Hasil ping idle:

```text
2 packets transmitted
2 packets received
0.0% packet loss

round-trip:
min = 144.473 ms
avg = 153.763 ms
max = 163.053 ms
stddev = 9.290 ms
```

Baseline:

```text
Average RTT ≈ 154 ms
Packet loss = 0%
```

# 3. Metode Throughput Test

Server berada pada Raspberry/UAV:

```text
10.90.0.2:5201
```

Ground melakukan reverse UDP test:

```bash
iperf3 -c 10.90.0.2 -u -R -b RATE -l 256 -t 30
```

Parameter:
- `-u` = UDP
- `-R` = Raspberry/UAV mengirim ke Ground
- `-b` = requested bitrate
- `-l 256` = UDP payload 256 byte
- `-t 30` = 30 detik

# 4. Ringkasan Hasil Aktual

| Requested Rate | Receiver Rate | Packet Loss | Jitter | Status |
|---:|---:|---:|---:|---|
| 10 kbit/s | 10.0 kbit/s | 0% | 11.875 ms | Sangat stabil |
| 12 kbit/s | 12.0 kbit/s | 0% | 11.726 ms | Sangat stabil |
| 15 kbit/s | 15.0 kbit/s | 0% | 9.199 ms | Stabil |
| 18 kbit/s | 18.0 kbit/s | 0% | 9.278 ms | Maximum tested clean |
| 20 kbit/s | 17.6 kbit/s | 11% | 21.278 ms | Mulai overload |
| 30 kbit/s | 16.3 kbit/s | 45% | 70.439 ms | Overload |
| 40 kbit/s | 14.5 kbit/s | 63% | 90.229 ms | Severe overload |

Pola yang terlihat:

```text
18K → 0% loss
20K → 11% loss
30K → 45% loss
40K → 63% loss
```

# 5. Batas Bandwidth Sistem

Berdasarkan bench test:

```text
Maximum Tested Clean Rate
≈ 18 kbit/s

Overload Threshold
≈ 20 kbit/s

Severe Overload
≥ 30 kbit/s
```

Penting: `18 kbit/s` adalah clean ceiling pada bench test, bukan continuous application budget.

# 6. Recommended Operating Budget

Untuk operasi realtime:

```text
Continuous Application Traffic : 8–10 kbit/s
Temporary Burst                : 12–15 kbit/s
Maximum Clean Tested Ceiling   : 18 kbit/s
Overload                        : ≥20 kbit/s
```

Konversi:

```text
8 kbit/s  ≈ 1.00 kB/s
10 kbit/s ≈ 1.25 kB/s
12 kbit/s ≈ 1.50 kB/s
15 kbit/s ≈ 1.875 kB/s
18 kbit/s ≈ 2.25 kB/s
```

# 7. Mengapa Tidak Menggunakan 18 kbit/s Terus-Menerus

MQTT nantinya berada di atas:

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

Masih ada overhead:
- MQTT header
- TCP header
- TCP ACK
- IP header
- PPP framing/control
- retransmission
- radio framing
- command Ground → UAV
- link degradation

Jika producer lebih cepat daripada kapasitas link:

```text
queue menumpuk
 ↓
latency meningkat
 ↓
data realtime menjadi basi
```

Untuk realtime, frame terbaru lebih penting daripada menunggu semua frame lama.

# 8. Data Native yang Tersedia dari SDR

Satu record per VFO/channel dapat berisi:

1. Timestamp UNIX Epoch
2. Maximum DoA angle
3. Confidence
4. RSSI power
5. Channel frequency
6. Antenna array arrangement
7. Processing latency
8. Station ID
9. Latitude
10. Longitude
11. GPS heading
12. Compass heading
13. Main heading sensor
14–17. Reserved
18–377. Full 360-degree DoA power array

Jika beberapa VFO digunakan, tiap VFO menghasilkan record terpisah.

# 9. Penjelasan Data Utama

## Timestamp
Digunakan untuk sinkronisasi, logging, filtering data lama, dan latency analysis.

## Maximum DoA Angle
Estimasi arah utama signal, umumnya 0–359°. Ini merupakan field utama untuk Ground Console.

## Confidence
Metrik kualitas hasil estimasi. Peak DoA yang lebih tajam dan lebih dominan menghasilkan confidence lebih tinggi.

## RSSI Power
Power signal relatif dalam dB. Berguna untuk signal-strength indication, squelch, filtering, dan trend signal.

## Channel Frequency
Frekuensi VFO/channel aktif dalam Hz.

## Antenna Array Arrangement
Contoh:
```text
UCA
ULA
Custom
```
Biasanya cukup dikirim saat startup atau configuration change.

## Processing Latency
Latency internal dari signal arrival sampai hasil DoA. Nilai ini tidak termasuk network latency T900/PPP.

## Station ID
Identitas node/station. Dapat dihilangkan dari high-rate payload jika identitas sudah diketahui dari MQTT topic.

## Latitude / Longitude
Digunakan untuk mapping, geolocation, dan plotting bearing.

## GPS Heading / Compass Heading
Heading platform dari sumber GPS atau compass.

## Main Heading Sensor
Menunjukkan heading source yang sedang digunakan.

# 10. Full 360-Degree DoA Power Array

Native record juga dapat membawa 360 power values:

```text
0°
1°
2°
...
359°
```

Data ini adalah angular/spatial spectrum:

```text
Angle → DoA Power
```

Bukan frequency spectrum.

# 11. Angular Spectrum vs Frequency Spectrum

Angular DoA array:

```text
Axis  : Angle 0–359°
Value : DoA power
```

Digunakan untuk polar plot, heatmap arah, peak direction, dan confidence.

Frequency spectrum:

```text
Axis  : Frequency
Value : Signal power
```

Digunakan untuk spectrum display, waterfall, VFO selection, dan signal monitoring.

Frequency spectrum tampil pada Web UI SDR, tetapi bukan bagian dari standard third-party DoA record. Untuk dikirim ke Ground, spectrum perlu diambil dari internal processing/UI pipeline, kemudian downsample, quantize, pack, dan publish via MQTT.

# 12. Native Full Record Terlalu Berat untuk Link

Upstream documentation menyebut local logging dengan 1 VFO dan interval 1 detik dapat tumbuh sekitar 100 kB/menit.

Kira-kira:

```text
~1.67 kB/s
~13.3 kbit/s
```

sebelum overhead MQTT/TCP/PPP.

Karena recommended continuous application budget hanya sekitar:

```text
8–10 kbit/s
```

maka jangan forward full native 377-field record terus-menerus tanpa optimasi.

# 13. Data yang Sebaiknya Dikirim via MQTT

Realtime compact payload:
- Timestamp
- Max DoA
- Confidence
- RSSI
- Frequency
- Processing latency
- Latitude
- Longitude
- Heading
- Heading source
- System state

Configuration yang relatif tetap cukup dikirim saat startup/change/request:
- Station ID
- Array type
- gain/config
- VFO configuration

# 14. Rekomendasi MQTT Topics

```text
sdr/telemetry/doa
```

Isi:
```text
timestamp
doa
confidence
rssi
frequency
processing_latency
```

```text
sdr/telemetry/nav
```

Isi:
```text
latitude
longitude
heading
heading_source
```

```text
sdr/state
```

Isi:
```text
running
frequency
gain
array_type
VFO configuration
```

Optional:

```text
sdr/telemetry/doa360
sdr/telemetry/spectrum
```

# 15. QoS Recommendation

Gunakan QoS 0 untuk data cepat yang terus berubah:
- DoA
- RSSI
- confidence
- navigation
- angular spectrum
- frequency spectrum

Gunakan QoS 1 untuk:
- command
- ACK
- configuration change
- start/stop
- set frequency
- set gain
- critical state

Retained state cocok untuk:
- current frequency
- gain
- array type
- mode
- running state

# 16. Recommended Telemetry Rate

Baseline:

```text
DoA + RSSI + confidence : 2–5 Hz
GPS                     : 1 Hz
Heading                 : 2–5 Hz
System state            : 0.2–1 Hz / event-driven
Heartbeat               : 0.2–1 Hz
```

Actual rate harus disesuaikan berdasarkan ukuran MQTT packet nyata.

# 17. Payload Size Target

Target compact telemetry:

```text
< 200 byte/message
```

Ideal:

```text
80–150 byte/message
```

Contoh compact JSON:

```json
{
  "ts": 1788163200123,
  "az": 137.4,
  "rssi": -54.2,
  "conf": 92.3,
  "f": 433920000
}
```

Jika 150 byte dikirim 5 kali/detik:

```text
750 byte/s
≈ 6 kbit/s
```

masih di bawah continuous budget 8–10 kbit/s sebelum overhead tambahan.

# 18. Optional Angular Spectrum

Tidak selalu perlu mengirim semua 360 values.

Alternatif:
- downsample 360 → 180 bins
- downsample 360 → 120 bins
- downsample 360 → 90 bins
- kirim top-N peaks saja

Contoh top peaks:

```text
angle1 + power1
angle2 + power2
angle3 + power3
```

# 19. Optional Frequency Spectrum

Rekomendasi awal:

```text
128 bins atau 256 bins
quantization uint8
```

Contoh:

```text
256 bins × 1 byte
= 256 byte
```

Tambah metadata sekitar beberapa puluh byte, sehingga target frame dapat dijaga sekitar 300 byte.

Pada 1 Hz:

```text
~300 byte/s
≈ 2.4 kbit/s
```

# 20. Spectrum On-Demand

Desain terbaik:

```text
default:
Spectrum OFF
```

Ground meminta spectrum melalui command, lalu UAV mulai publish. Saat tidak diperlukan, stream dimatikan kembali.

Dengan begitu bandwidth utama tetap tersedia untuk DoA, command, navigation, dan status.

# 21. Suggested Bandwidth Allocation

Dengan continuous budget 8–10 kbit/s:

```text
DoA + signal telemetry : ~4–5 kbit/s
GPS/Heading            : ~0.5–1 kbit/s
Heartbeat/state        : ~0.2–0.5 kbit/s
Optional spectrum      : ~2–3 kbit/s
Reserve/headroom       : sisa kapasitas
```

# 22. Priority

Prioritas:

```text
1. Command / ACK
2. Current DoA
3. Current frequency
4. Navigation / heading
5. RSSI / confidence
6. System health
7. Angular spectrum
8. Frequency spectrum
```

Jika link memburuk:
- turunkan spectrum rate
- kurangi DoA rate sedikit
- command tetap diprioritaskan

# 23. Adaptive Rate Concept

```text
LINK GOOD
DoA 5 Hz
Spectrum 1 Hz

LINK MEDIUM
DoA 3 Hz
Spectrum 0.5 Hz

LINK POOR
DoA 1–2 Hz
Spectrum OFF
```

# 24. Pengaruh Jarak

Jarak RF sendiri bukan sumber delay utama. Yang lebih penting:

```text
distance ↑
 ↓
SNR ↓
 ↓
error/retry ↑
 ↓
effective throughput ↓
 ↓
queue ↑
 ↓
latency/jitter ↑
```

Jadi efek "semakin jauh semakin buffering" lebih banyak berasal dari penurunan kualitas link dan throughput efektif.

# 25. Operational Limits

Gunakan baseline:

```text
Normal continuous target : ≤10 kbit/s
Short burst              : ≤15 kbit/s
Clean bench ceiling      : 18 kbit/s
Do not plan normal use   : ≥20 kbit/s
```

# 26. Important Qualification

Hasil 18 kbit/s dengan 0% loss berasal dari bench test 30 detik pada kondisi RF saat pengujian.

Ini bukan jaminan bahwa 18 kbit/s tetap clean pada jarak jauh, interferensi tinggi, perubahan orientasi antena, perubahan polarisasi, atau shielding airframe.

Karena itu 18 kbit/s adalah maximum tested clean ceiling, bukan guaranteed field throughput.

# 27. Field Test Recommendation

Ulangi pengujian pada jarak operasional, misalnya:

```text
100 m
500 m
1 km
2 km
3 km
```

Catat:
- packet loss
- jitter
- RTT
- radio RSSI jika tersedia
- altitude
- line of sight
- antenna orientation

# 28. Next Tests

Karena MQTT memakai TCP, lanjutkan test aplikasi-like:

```bash
iperf3 -c 10.90.0.2 -R -b 8K -t 60
iperf3 -c 10.90.0.2 -R -b 10K -t 60
```

Sambil:

```bash
ping 10.90.0.2
```

Setelah broker tersedia, lakukan MQTT real-payload test dan ukur:
- actual payload bytes
- publish frequency
- end-to-end latency
- backlog
- reconnection behavior

# 29. Final Data Strategy

Jangan kirim:
- raw IQ
- full high-rate UI data
- full native 360-value record setiap update
- image/video waterfall

Kirim:
- compact DoA
- RSSI
- confidence
- frequency
- navigation
- heading
- processing latency
- system state
- command/ACK
- optional downsampled angular spectrum
- optional compact frequency spectrum

# 30. Kesimpulan

Hasil bench test:

```text
10 kbit/s → 0% loss
12 kbit/s → 0% loss
15 kbit/s → 0% loss
18 kbit/s → 0% loss
20 kbit/s → 11% loss
30 kbit/s → 45% loss
40 kbit/s → 63% loss
```

Sehingga:

```text
18 kbit/s = maximum tested clean ceiling
20 kbit/s = overload threshold
8–10 kbit/s = recommended continuous application budget
```

Data native SDR menyediakan:
- DoA
- confidence
- RSSI
- frequency
- processing latency
- position
- heading
- full 360-degree angular DoA power

Strategi final:

```text
Process locally
 ↓
Select important fields
 ↓
Compress/quantize optional arrays
 ↓
Publish compact MQTT
 ↓
Keep continuous traffic ≤8–10 kbit/s
```

---

## Referensi Dasar

Dokumentasi ini menggabungkan:
1. Hasil `iperf3` dan ping aktual pada link T900 + PPP.
2. Dokumentasi upstream SDR DoA mengenai third-party output, Web Interface Controls, Data Out format, dan local data recording behavior.

**End of Documentation**
