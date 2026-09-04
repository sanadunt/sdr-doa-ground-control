# Baseline Live Tahap 1 — Node SDR-DoA

## 1. Scope dan waktu

Pemeriksaan ini dilakukan secara **read-only** melalui SSH key-based dan HTTP localhost pada Raspberry. Tidak ada file remote yang ditulis, tidak ada settings yang diubah, tidak ada `POST`, dan tidak ada service yang di-restart.

```text
Waktu probe : 2026-09-01 sekitar 19:51 WIB
Node        : doasdr
User        : doasdr
Root        : /home/doasdr/doasdr
```

Hasil ini adalah baseline live pada waktu probe, bukan jaminan status untuk waktu berikutnya.

## 2. Identitas dan konektivitas

```text
SSH key-based login : berhasil
User                : doasdr
Hostname            : doasdr
Home                : /home/doasdr
Project root        : /home/doasdr/doasdr
```

Endpoint HTTP `127.0.0.1:8081` pada Raspberry dapat dibaca untuk resource yang diketahui:

```text
/status.json       : HTTP 200
/settings.json     : HTTP 200
/DOA_value.html    : HTTP 200
/doa.xml           : HTTP 200
```

## 3. Status service

| Unit | Active saat probe | Enabled | Interpretasi |
|---|---|---|---|
| `t900-ppp.service` | `active` | `enabled` | link PPP service hidup |
| `sdr-doa.service` | `inactive (dead)` | `enabled` | unit launcher tidak sedang aktif |
| `sdr-watchdog.service` | `inactive` | `static` | unit oneshot tidak sedang berjalan |
| `sdr-watchdog.timer` | `inactive (dead)` | `enabled` | timer tidak sedang menjadwalkan check |

` sdr-doa.service` memakai `Type=oneshot` dan `RemainAfterExit=yes` pada konfigurasi yang diperiksa. Pada probe ini, proses aplikasi masih terlihat walaupun unit service sudah `inactive`. Karena itu status proses dan status systemd harus dipantau terpisah.

Tidak ada restart otomatis yang dilakukan karena itu merupakan perubahan runtime di luar scope read-only.

## 4. Proses dan listener yang terlihat

Proses yang terlihat pada saat probe:

```text
_daq_core/rtl_daq.out
_daq_core/rebuffer.out 0
_daq_core/decimate.out
python3 _ui/_web_interface/app.py
php -S 0.0.0.0:8081 -t _share
node _nodejs/index.js
```

Listener yang terlihat:

```text
0.0.0.0:5001  internal DAQ control
0.0.0.0:8080  GUI
0.0.0.0:8081  shared Data Out
*:8042        HTTP middleware
*:8021        WebSocket middleware
```

Port `5000` tidak terlihat listen pada probe ini. Ia tetap diperlakukan sebagai interface internal yang didefinisikan source, bukan kontrak telemetry.

## 5. `status.json` live

Field aman yang terbaca:

```json
{
  "timestamp_ms": 1788267385845,
  "station_id": "NOCALL",
  "unit_id": 0,
  "host_os_type": "Linux",
  "host_os_architecture": "aarch64",
  "software_version": "1.8.1",
  "software_git_short_hash": "2e1c4e6",
  "gps_status": "Disabled",
  "daq_ok": false,
  "daq_num_dropped_frames": 0,
  "daq_status": {
    "data_frame_index": 19379,
    "frame_sync": true,
    "sample_delay_sync": false,
    "iq_sync": false,
    "noise_source_enabled": true,
    "adc_overdrive": false,
    "sampling_frequency_hz": 2400000,
    "bandwidth_hz": 2400000,
    "decimated_bandwidth_hz": 2400000,
    "buffer_size_ms": 0.0
  }
}
```

Interpretasi:

```text
status endpoint        : reachable
status timestamp       : berubah selama sampling sekitar 6 detik
DAQ health             : FAIL / DEGRADED
frame_sync             : true
sample_delay_sync      : false
iq_sync                : false
dropped-frame delta    : 0 pada window sampling ini
GPS                    : Disabled
```

`daq_ok=false` disebabkan syarat sinkronisasi DAQ belum seluruhnya terpenuhi. Nilai dropped-frame `0` pada window pendek ini tidak cukup untuk menyimpulkan kestabilan jangka panjang.

## 6. Settings aman yang terbaca

Hanya subset non-sensitif yang dicatat:

```json
{
  "center_freq": 415.7882,
  "uniform_gain": 15.7,
  "data_interface": "shmem",
  "en_doa": true,
  "doa_method": "MUSIC",
  "doa_decorrelation_method": "Off",
  "ant_arrangement": "UCA",
  "ant_spacing_meters": 0.21,
  "active_vfos": 1,
  "output_vfo": 0,
  "vfo_mode": "Standard",
  "location_source": "Static",
  "gps_fixed_heading": true,
  "en_remote_control": false
}
```

Raw `settings.json` tidak disalin atau dipublikasikan karena dapat memuat endpoint integrasi dan field credential-like.

## 7. Output DoA

### CSV `/DOA_value.html`

```text
HTTP             : 200
Format           : CSV satu baris
Jumlah field     : 377
Metadata         : 17 field
Angular bins     : 360 field, sudut 0–359°
Timestamp record : 1788265232442
DoA CSV          : 149.0
Confidence CSV   : 1.3494130969047546
Power CSV        : -77.7934341430664
Frequency        : 416588000 Hz
Frame latency    : 436 ms
```

### XML `/doa.xml`

```text
HTTP              : 200
Root              : DATA
Timestamp record  : 1788265232442
DoA XML           : 211.0
CONF              : 135 percent-style value
PWR               : 22.2 transformed scale
FREQUENCY         : 416.588 MHz
LATENCY           : 436 ms
PROCESSING_TIME   : 1106 ms
SNR_DB            : 10.683474170895641
GPS_TIME          : 0
```

Perbedaan `149.0` versus `211.0` konsisten dengan perbedaan konvensi source:

```text
CSV : 360 - theta
XML : theta langsung
```

Confidence dan power juga tidak boleh dianggap satuan yang sama antarformat.

## 8. Freshness window

Status dibaca dua kali dengan jarak sekitar 6 detik:

```text
status timestamp delta : 5841 ms
status berubah         : ya
status drop delta      : 0
CSV berubah            : tidak
XML berubah            : tidak
```

Timestamp DoA pada record (`1788265232442`) lebih tua sekitar:

```text
2,153,403 ms ≈ 35 menit 53 detik
```

Maka pada probe ini:

```text
status.json       : live-changing
DOA_value.html    : STALE candidate
 doa.xml          : STALE candidate
DoA publish       : BLOCKED
```

## 9. Tahap 1 gate

| Gate | Hasil |
|---|---|
| SSH/read-only reachability | PASS |
| HTTP resource availability | PASS |
| DAQ/UI/Data Out processes visible | PASS pada saat probe |
| `t900-ppp.service` | PASS: active/enabled |
| `sdr-doa.service` supervision | BLOCKED: inactive walau proses masih terlihat |
| watchdog timer | BLOCKED: inactive |
| `status.json` freshness | PASS pada window pendek |
| DAQ health | FAIL: `daq_ok=false`, IQ/sample-delay sync false |
| DoA freshness | FAIL: snapshot sekitar 35 menit 53 detik |
| DoA authority untuk telemetry | BLOCKED |

## 10. Kesimpulan dan langkah aman berikutnya

Node dapat diakses dan resource Data Out merespons. Namun kondisi belum layak untuk menerbitkan DoA realtime:

```text
service unit inactive + proses masih hidup
DAQ sync belum sehat
DoA output stale
```

Langkah berikutnya yang aman tanpa mengubah Raspberry adalah membuat dan menguji **collector read-only di staging lokal**. Collector harus membaca endpoint, melakukan parsing, menghitung age, memberi status `DEGRADED/STALE`, dan menolak publish DoA. Perbaikan service atau pemasangan agent di Raspberry merupakan perubahan runtime terpisah dan belum dilakukan.
