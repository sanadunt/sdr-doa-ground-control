# Arsitektur Telemetry SDR-DoA dan Kendali Settings

## 1. Tujuan dan status

Dokumen ini menetapkan rancangan komunikasi antara node SDR-DoA pada Raspberry dan Ground Station melalui T900 + PPP.

Cakupan:

- arsitektur proses di Raspberry dan Ground Station;
- pemisahan telemetry cepat, health, state, konfigurasi, dan command;
- topic MQTT, QoS, retain, rate, queue, dan reconnect;
- alur aman untuk mengubah settings dari Ground;
- batasan terhadap output dan middleware yang tersedia saat ini.

Status dokumen:

```text
Jenis       : rancangan arsitektur dan contract awal
Implementasi: belum dibuat
Live gate   : belum lulus; DAQ terakhir daq_ok=false
```

Dokumen ini tidak mengaktifkan broker, tidak mengubah Raspberry, tidak mengubah service, dan tidak mengirim command ke node.

---

## 2. Keputusan arsitektur utama

### Rekomendasi tahap pertama

Gunakan MQTT sebagai **application protocol** di atas:

```text
MQTT → TCP/IP → PPP → T900 Transparent
```

Topologi awal yang paling sederhana:

```text
┌──────────────────────────── Raspberry / UAV ────────────────────────────┐
│                                                                         │
│  Antenna Array → DAQ → SDR-DoA / DSP                                   │
│                         │                                               │
│                         ├── _share/status.json                          │
│                         ├── _share/DOA_value.html                      │
│                         ├── _share/doa.xml                             │
│                         └── _share/settings.json                       │
│                                      │                                  │
│                         SDR-DoA Edge Agent                              │
│                         ├── source adapter                              │
│                         ├── health/freshness gate                       │
│                         ├── normalizer                                  │
│                         ├── latest-value queue                          │
│                         ├── command/settings manager                    │
│                         └── MQTT client                                 │
│                                      │                                  │
│                         PPP 10.90.0.2                                    │
└──────────────────────────────────────┼──────────────────────────────────┘
                                       │ T900 RF
┌──────────────────────────────────────┼──────────────────────────────────┐
│                         PPP 10.90.0.1                                    │
│                         Ground MQTT broker                               │
│                                      │                                  │
│                         Ground consumer/controller                      │
│                         ├── telemetry view                              │
│                         ├── state/health store                          │
│                         └── settings command UI                         │
└─────────────────────────────────────────────────────────────────────────┘
```

Ground Station tetap dapat meneruskan data dari broker ke backend atau GUI lain. MQTT broker di Ground dipilih dahulu karena:

- hanya satu broker yang perlu dikelola;
- Ground menjadi titik observasi dan penyimpanan utama;
- Raspberry cukup menjalankan satu edge agent dan satu MQTT client;
- command dan telemetry memiliki satu namespace yang jelas;
- tidak perlu membuka port HTTP file server ke seluruh jalur telemetry.

### Opsi tahap kedua

Jika Raspberry harus melayani beberapa aplikasi lokal ketika Ground offline, dapat ditambahkan broker lokal di Raspberry dan bridge terkontrol ke broker Ground:

```text
SDR-DoA → edge agent → broker lokal UAV
                              │
                        MQTT bridge
                              │ PPP/T900
                              ▼
                       broker Ground
```

Opsi dua broker belum diperlukan untuk prototype pertama. Bridge harus memakai allowlist topic dan tetap tidak boleh meneruskan seluruh topic atau history tanpa batas.

---

## 3. Prinsip penting: MQTT bukan sumber data SDR langsung

MQTT hanya menjadi transport dan contract telemetry. MQTT tidak menggantikan:

- DAQ;
- DSP;
- output writer;
- health gate;
- normalisasi unit dan sudut;
- validasi settings;
- read-back setelah perubahan.

Jalur yang benar:

```text
DAQ/DSP lokal
    ↓
source adapter Raspberry
    ↓
health + freshness + authority gate
    ↓
normalisasi schema/unit/angle
    ↓
MQTT compact payload
    ↓
Ground consumer
```

Jangan membuat Ground Station melakukan polling rutin ke:

```text
http://10.90.0.2:8081
http://10.90.0.2:8042
http://10.90.0.2:8021
```

Port tersebut tetap berguna untuk diagnosis atau integrasi lokal yang dikontrol, tetapi belum merupakan contract telemetry production. Edge agent di Raspberry lebih tepat membaca filesystem lokal:

```text
/home/doasdr/doasdr/_share/status.json
/home/doasdr/doasdr/_share/DOA_value.html
/home/doasdr/doasdr/_share/doa.xml
/home/doasdr/doasdr/_share/settings.json
```

Akses HTTP `:8081` dari Ground dapat dipertahankan sebagai jalur diagnosis read-only melalui LAN management, bukan sebagai jalur publish normal.

---

## 4. Peran komponen

### 4.1 SDR-DoA/DSP

Tugas:

- menerima frame IQ dari DAQ;
- menjalankan decimation, spectrum, VFO, squelch, dan estimasi DoA;
- menulis output dan status lokal;
- menerapkan perubahan settings yang dibaca oleh watcher.

SDR-DoA tidak perlu mengetahui detail MQTT.

### 4.2 SDR-DoA Edge Agent pada Raspberry

Edge agent adalah batas antara aplikasi SDR dan jaringan. Tugasnya:

1. membaca output/status lokal;
2. menangani snapshot parsial atau file yang sedang ditulis;
3. memeriksa health dan freshness;
4. menentukan authority output DoA;
5. menormalisasi field, unit, dan konvensi sudut;
6. membuat payload compact;
7. mempertahankan queue bounded latest-value-wins;
8. mengirim telemetry melalui MQTT;
9. menerima command settings;
10. memvalidasi dan menerapkan patch settings;
11. membaca kembali settings efektif;
12. mengirim ACK dan reported state.

Edge agent tidak boleh meneruskan raw `settings.json`, raw log, raw IQ, atau key-like field.

### 4.3 MQTT broker Ground

Tugas broker:

- menerima publish telemetry dari Raspberry;
- menyampaikan command dari Ground ke Raspberry;
- menerapkan authentication dan ACL;
- menyimpan retained state/config yang memang dipilih;
- tidak menyimpan atau mengantrekan telemetry history tanpa batas.

### 4.4 Ground consumer/controller

Tugas:

- subscribe telemetry, health, state, dan ACK;
- menghitung data age dari timestamp sumber dan waktu terima;
- menampilkan `LIVE`, `DELAYED`, atau `STALE`;
- menyimpan data yang diperlukan;
- mengirim command dengan ID, revision, dan expiry;
- tidak menganggap publish sukses sebagai settings berhasil diterapkan.

---

## 5. Klasifikasi data dan jadwal pengiriman

### 5.1 DoA realtime

"Realtime" di sini berarti hasil terbaru dikirim dengan latency rendah. Bukan berarti seluruh frame IQ atau seluruh history harus dikirim.

Rate awal:

```text
2 Hz
QoS 0
non-retained
latest-value-wins
```

Payload hanya diterbitkan jika semua gate minimum lulus:

```text
DAQ sehat
DoA snapshot fresh
timestamp valid
sequence/frame correlation valid bila tersedia
source authority sudah ditetapkan
unit dan angle convention sudah dinormalisasi
```

Jika gate gagal, jangan menerbitkan DoA lama sebagai hasil baru. Kirim health dengan `doa_valid=false` dan alasan penolakan.

Contoh payload canonical:

```json
{"v":1,"seq":12345,"ts_ms":1788163200123,"valid":true,"relative_doa_deg":137.4,"confidence":0.923,"power_db":-54.2,"snr_db":14.5,"frequency_hz":433920000,"processing_ms":12,"config_rev":7}
```

Aturan field:

| Field | Arti |
|---|---|
| `v` | versi schema |
| `seq` | sequence stream DoA dari edge agent |
| `ts_ms` | timestamp sumber, UTC epoch milliseconds |
| `valid` | hasil melewati gate atau tidak |
| `relative_doa_deg` | DoA relatif dengan convention canonical |
| `confidence` | selalu skala `0.0–1.0` pada contract MQTT |
| `power_db` | power/RSSI setelah definisi unit ditetapkan |
| `snr_db` | SNR bila tersedia dan valid |
| `frequency_hz` | frekuensi channel dalam Hz |
| `processing_ms` | processing time bila tersedia; bukan acquisition latency |
| `config_rev` | revision settings efektif saat hasil dibuat |

CSV dan XML native tidak boleh diperlakukan sebagai format yang identik. CSV menggunakan transformasi arah berbeda dari XML, sehingga adapter harus menyimpan sumber dan konvensi yang dipakai.

### 5.2 Navigation

Navigation dipisahkan dari DoA agar tidak mengulang koordinat di setiap frame:

```text
1 Hz awal
QoS 0
non-retained atau retained hanya bila dipilih sebagai last-known state
```

Contoh:

```json
{"v":1,"seq":501,"ts_ms":1788163200123,"lat":-6.9147,"lon":107.6098,"speed_mps":12.2,"heading_deg":121.5,"source":"gps"}
```

Catatan:

- GPS pada snapshot terakhir berstatus `Disabled`;
- latitude/longitude/heading saat ini belum menjadi navigation live yang tervalidasi;
- altitude tidak diperlakukan sebagai field native yang sudah terbukti pada output DoA saat ini;
- altitude sebaiknya datang dari flight controller atau sumber navigation yang disepakati.

Jika Ground menghitung global bearing, simpan input terpisah:

```text
relative_doa_deg
heading_deg
mounting_offset_deg
global_bearing_deg
```

Jangan hanya menyimpan hasil akhir tanpa provenance.

### 5.3 Health dan heartbeat

Rate awal:

```text
0.5–1 Hz
QoS 0
non-retained; last state juga dikirim pada reconnect
```

Contoh:

```json
{"v":1,"ts_ms":1788163200123,"state":"DEGRADED","daq_ok":false,"frame_sync":null,"sample_delay_sync":null,"iq_sync":null,"dropped_frames":2356,"doa_valid":false,"doa_age_ms":null,"gps_status":"Disabled","uptime_ms":123456}
```

Field yang dapat digunakan:

- `state`: `ONLINE`, `DEGRADED`, `STALE`, atau `OFFLINE` sesuai contract Ground;
- `daq_ok`;
- frame sync, sample-delay sync, IQ sync bila tersedia;
- dropped-frame total dan delta;
- `doa_valid` serta `doa_age_ms`;
- GPS status;
- uptime;
- CPU/thermal/link metrics bila collector sistem menambahkannya.

Nilai `null` lebih aman daripada mengubah field yang tidak tersedia menjadi `false` secara diam-diam.

Pada snapshot terakhir, kondisi harus dipresentasikan sebagai `DEGRADED` karena `daq_ok=false` dan dropped-frame counter meningkat.

### 5.4 Effective state

State berisi parameter operasional yang aman untuk diketahui Ground, bukan seluruh settings:

```text
event-driven saat boot/perubahan
QoS 1
retained
refresh lambat opsional, misalnya 30–60 detik
```

Contoh:

```json
{"v":1,"ts_ms":1788163200123,"config_rev":7,"running":true,"center_frequency_hz":433920000,"gain_db":24,"array":"UCA","doa_method":"MUSIC","active_vfos":1,"output_vfo":0}
```

### 5.5 Reported configuration

Configuration report hanya memuat subset aman dan efektif:

```text
publish saat boot
publish setelah settings applied
publish saat diminta
QoS 1
retained
```

Contoh:

```json
{"v":1,"config_rev":7,"reported_ts_ms":1788163200123,"effective":{"center_frequency_hz":433920000,"gain_db":24,"doa_method":"MUSIC","array":"UCA","active_vfos":1},"redacted":true}
```

Jangan mengirim:

- full native `settings.json`;
- key/token/password/secret;
- endpoint eksternal yang tidak diperlukan;
- parameter internal yang belum disetujui menjadi contract.

### 5.6 Spectrum dan angular array

Default:

```text
OFF
on-demand saja
QoS 0
```

Bila diperlukan:

- kirim top-N peak; atau
- 90/120/180 bin hasil downsample; atau
- packed uint8/int8;
- batasi rate sekitar `0.2–0.5 Hz`.

Jangan mengirim 360 angular values pada setiap frame. Frequency spectrum dan angular DoA spectrum adalah dua jenis data berbeda.

---

## 6. Topic MQTT yang disarankan

Gunakan namespace versioned dan identitas UAV yang stabil:

```text
sdr/v1/uav-01/telemetry/doa
sdr/v1/uav-01/telemetry/nav
sdr/v1/uav-01/telemetry/health
sdr/v1/uav-01/telemetry/angular
sdr/v1/uav-01/telemetry/spectrum
sdr/v1/uav-01/state
sdr/v1/uav-01/config/reported
sdr/v1/uav-01/cmd/config/patch
sdr/v1/uav-01/cmd/config/get
sdr/v1/uav-01/ack/config
sdr/v1/uav-01/ack/request
```

### QoS dan retain

| Topic | QoS | Retain | Keterangan |
|---|---:|---|---|
| `telemetry/doa` | 0 | tidak | latest-value-wins |
| `telemetry/nav` | 0 | tidak | data terbaru |
| `telemetry/health` | 0 | tidak | heartbeat, age dihitung Ground |
| `telemetry/angular` | 0 | tidak | on-demand |
| `telemetry/spectrum` | 0 | tidak | on-demand |
| `state` | 1 | ya | effective state terakhir |
| `config/reported` | 1 | ya | subset settings aman |
| `cmd/config/patch` | 1 | tidak | command tidak boleh replay otomatis |
| `cmd/config/get` | 1 | tidak | request snapshot aman |
| `ack/config` | 1 | tidak | hasil command; state read-back menjadi bukti kedua |

Jangan memakai retained untuk command. Jangan memakai QoS 2 untuk telemetry rutin; overhead dan kompleksitasnya tidak sebanding dengan kebutuhan latest-value-wins.

### Command expiry

Command harus memiliki expiry karena QoS 1 tidak menjamin command lama aman untuk dijalankan setelah link pulih:

```json
{"v":1,"id":"cmd-000127","type":"config_patch","base_config_rev":7,"issued_ts_ms":1788163200123,"expires_ts_ms":1788163210123,"changes":{"center_frequency_hz":433920000,"gain_db":24}}
```

Aturan:

- command tidak retained;
- edge agent menolak command yang melewati `expires_ts_ms`;
- `id` dipakai untuk deduplication;
- `base_config_rev` mencegah patch diterapkan di atas state yang sudah berubah;
- Ground tidak membuat command ID baru secara membabi buta ketika ACK hilang; minta status/read-back terlebih dahulu.

---

## 7. Queue dan reconnect

### Queue telemetry

```text
DoA producer
     ↓
bounded queue per class
     ↓
telemetry sender
```

Policy:

- DoA, nav, health, dan spectrum memakai latest-value-wins;
- frame lama dibuang ketika queue penuh;
- command/ACK memiliki queue terpisah dari telemetry;
- command tidak boleh ikut terbuang hanya karena spectrum burst;
- catat jumlah drop lokal dan kirim pada health.

### Saat PPP/T900 putus

Raspberry tetap menjalankan processing lokal. Edge agent:

1. tidak mengantrekan semua DoA historis;
2. mempertahankan state/config terakhir;
3. mempertahankan command journal terbatas untuk deduplication;
4. mencoba reconnect MQTT dengan backoff;
5. setelah reconnect mengirim state/config terbaru dan health;
6. melanjutkan DoA terbaru tanpa burst history;
7. tidak mengeksekusi command lama yang sudah expired.

### Saat broker atau Ground offline

Status yang benar:

```text
SDR-DoA lokal : tetap processing bila DAQ sehat
telemetry     : dapat hilang sementara
Ground UI     : menampilkan stale/offline
command       : tidak dianggap applied tanpa ACK/read-back
```

---

## 8. Anggaran bandwidth awal

Policy link yang sudah ditetapkan:

```text
continuous application : 8–10 kbit/s
short burst            : 12–15 kbit/s
clean ceiling bench    : 18 kbit/s
operasi normal         : jangan >=20 kbit/s
```

Dengan contoh compact payload dan rate awal:

```text
DoA    2 Hz × sekitar 144 byte
Nav    1 Hz × sekitar 106 byte
Health 1 Hz × sekitar 111 byte
State  0.2 Hz × sekitar 129 byte
```

payload-only sekitar `530.8 byte/s`, atau sekitar `4.25 kbit/s`. Ini belum memasukkan overhead MQTT, TCP, IP, PPP, ACK, retransmission, TLS, command, dan variasi RF. Karena itu rate tersebut adalah starting point, bukan bukti final.

Ukuran yang harus diukur pada implementasi:

```text
JSON payload bytes
MQTT PUBLISH bytes
TCP bytes
PPP/serial wire bytes
end-to-end latency
queue depth
telemetry drop count
command ACK time
```

Spectrum tetap dimatikan dalam kondisi normal.

---

## 9. Alur perubahan settings dari Ground

### 9.1 Jangan lakukan ini

Jangan membuat Ground:

```text
POST langsung full settings ke :8042/settings
menulis /_share/settings.json melalui SSH/SFTP
mengirim full settings mentah melalui MQTT
mengubah field key-like dari UI biasa
menganggap HTTP 200 sebagai settings applied
```

Endpoint settings middleware yang ada saat ini menulis full document dan belum tervalidasi sebagai API authenticated/authorized production. Source watcher membaca file settings secara periodik, sehingga payload malformed atau partial write dapat mengganggu konfigurasi runtime.

### 9.2 Alur yang direkomendasikan

```text
Ground UI
   │
   │ 1. baca config/reported + config_rev
   ▼
Ground Controller
   │
   │ 2. buat config_patch dengan id, base_rev, expiry
   ▼
MQTT broker Ground
   │
   │ 3. QoS 1, non-retained
   ▼
Edge Agent Raspberry
   │
   ├── 4. auth/ACL broker
   ├── 5. schema validation
   ├── 6. allowlist + range validation
   ├── 7. base_rev + dedup + expiry check
   ├── 8. serialize config write
   ├── 9. merge patch ke settings lokal
   ├── 10. set ext_upd_flag untuk watcher
   ├── 11. tunggu reload/reconfigure
   ├── 12. read-back settings/status
   └── 13. publish ACK + config/reported + state
```

### 9.3 Command schema

Gunakan field contract sendiri, bukan nama field internal secara mentah:

```json
{"v":1,"id":"cmd-000127","type":"config_patch","base_config_rev":7,"issued_ts_ms":1788163200123,"expires_ts_ms":1788163210123,"changes":{"center_frequency_hz":433920000,"gain_db":24}}
```

Field wajib:

```text
v
id
type
base_config_rev
issued_ts_ms
expires_ts_ms
changes
```

### 9.4 ACK schema

ACK harus menunjukkan tahap, bukan hanya HTTP/MQTT publish sukses:

```json
{"v":1,"id":"cmd-000127","status":"applied","ts_ms":1788163202123,"config_rev":8,"changes":{"center_frequency_hz":433920000,"gain_db":24},"readback_ok":true,"error":null}
```

Nilai `status` yang disarankan:

```text
received
rejected
expired
conflict
applying
applied
failed
```

Contoh penolakan:

```json
{"v":1,"id":"cmd-000127","status":"rejected","ts_ms":1788163201123,"config_rev":7,"readback_ok":false,"error":{"code":"OUT_OF_RANGE","field":"gain_db"}}
```

Ground baru menampilkan settings sebagai berhasil setelah:

```text
status = applied
readback_ok = true
config/reported menunjukkan nilai efektif
```

### 9.5 Cara edge agent menerapkan patch

Urutan implementasi lokal yang disarankan:

1. ambil lock config;
2. baca settings lokal yang sedang berlaku;
3. parse JSON dan pastikan object valid;
4. tolak field di luar allowlist;
5. validasi tipe, unit, enum, dan range;
6. pastikan `base_config_rev` masih cocok;
7. merge hanya field yang diizinkan, pertahankan field internal lain;
8. jangan pernah memasukkan secret ke ACK/log/payload;
9. tulis file melalui temporary file + flush/fsync + rename atomik bila adapter mengelola file;
10. set penanda update yang diperlukan watcher, termasuk `ext_upd_flag` sesuai perilaku source;
11. tunggu watcher/reconfigure selesai;
12. baca kembali settings dan status;
13. verifikasi nilai efektif;
14. increment `config_rev` hanya setelah read-back berhasil;
15. publish ACK dan reported state.

Karena GUI lokal dan watcher saat ini juga dapat menulis settings, production adapter harus menetapkan **single-writer rule** atau mekanisme lock yang benar. Tanpa itu, perubahan dari GUI dan Ground dapat saling menimpa.

### 9.6 Kelas perubahan settings

| Kelas | Contoh | Perlakuan |
|---|---|---|
| Hot/candidate | center frequency, gain, VFO frequency, VFO bandwidth, squelch | boleh dipertimbangkan setelah range/read-back test; output dapat pause |
| DSP/candidate | DoA method, decorrelation, expected source count, decimation | apply terkontrol; cek DoA freshness dan health setelah perubahan |
| Geometry/candidate | array type, spacing, custom coordinates, array offset | perlu validasi mounting/calibration; jangan diubah sembarang saat flight |
| Navigation/candidate | station ID, static location, heading/offset | pisahkan dari secret; validasi unit dan sumber |
| DAQ/restart | channel count, sample rate, CPI/buffer, calibration chain, data interface | command khusus, maintenance-only, kemungkinan reconfigure/restart |
| Forbidden routine | full settings replace, key/token/password, external endpoint, reboot/shutdown, system-control | tidak melalui command telemetry biasa |

Label `candidate` berarti kemampuan source ada atau terlihat dari settings, bukan jaminan bahwa perubahan telah diuji live pada runtime sekarang.

### 9.7 Command yang harus dipisahkan

Perubahan RF/DSP berbeda dari kontrol sistem. Gunakan topic dan permission terpisah untuk command berisiko tinggi:

```text
cmd/config/patch       → allowlist settings
cmd/processing/start   → bila benar-benar diperlukan
cmd/processing/stop    → maintenance-only
cmd/service/restart    → disabled by default
cmd/system/reboot      → jangan aktifkan pada prototype
```

Untuk tahap awal, implementasikan hanya `cmd/config/patch` dan `cmd/config/get`. Jangan membuka restart, shutdown, atau reboot melalui UI Ground.

---

## 10. Security dan authority boundary

Minimum production gate:

- broker memiliki authentication;
- ACL membatasi topic per UAV dan arah publish/subscribe;
- koneksi MQTT memakai TLS bila deployment mendukungnya;
- broker hanya bind ke interface yang diperlukan;
- command memiliki allowlist dan range validation;
- command tidak retained dan memiliki expiry;
- duplicate command ID dideduplicate;
- ACK tidak menyertakan secret;
- full settings tidak dipublish;
- `settings.json` dan log tidak diteruskan mentah;
- port internal tidak diekspos langsung ke T900;
- semua perubahan settings dicatat dengan ID, operator/source, revision, hasil, dan read-back.

T900/PPP menyediakan konektivitas IP, bukan otomatis authorization aplikasi. Status link tersambung juga bukan bukti bahwa command boleh dijalankan.

---

## 11. Status readiness saat ini

Arsitektur ini belum boleh dianggap live-ready karena:

```text
DAQ terakhir        : daq_ok=false
Dropped frames      : meningkat
DoA file freshness  : belum terbukti live pada sampling terakhir
Authority DoA       : belum ditetapkan final
GPS                 : Disabled pada snapshot terakhir
MQTT agent          : belum diimplementasikan
MQTT broker         : belum diimplementasikan
Settings command    : belum diimplementasikan
ACK/read-back       : belum diuji
```

Urutan gate yang disarankan:

1. perbaiki DAQ sampai `daq_ok=true` dan dropped-frame behavior dipahami;
2. buktikan output DoA berubah mengikuti stimulus RF terkontrol;
3. tetapkan authority dan canonical angle convention;
4. buat edge adapter read-only dengan fixture valid/stale/malformed;
5. implementasikan MQTT synthetic publisher/consumer;
6. ukur wire bytes pada 8–10 kbit/s;
7. implementasikan health/state/config reported;
8. implementasikan `config_patch` untuk subset kecil;
9. uji duplicate, expiry, conflict, malformed, timeout, dan read-back;
10. baru sambungkan DoA nyata;
11. tambahkan spectrum on-demand terakhir.

---

## 12. Ringkasan praktis

```text
Raspberry:
  SDR-DoA + edge agent + MQTT client

Ground:
  MQTT broker + consumer/controller + GUI

DoA:
  QoS 0, 2 Hz awal, latest-value-wins, tidak retained

Nav:
  QoS 0, 1 Hz, topic terpisah

Health:
  QoS 0, 0.5–1 Hz, DAQ/freshness/drop state

State/config reported:
  QoS 1, retained, event-driven + refresh lambat

Settings Ground → Raspberry:
  QoS 1 command, non-retained, id + base_rev + expiry
  allowlist → validate → apply → watcher/reconfigure
  read-back → ACK applied/failed → reported state

Yang tidak dilakukan:
  raw IQ, full settings, raw log, full 360 bin rutin,
  direct POST settings dari Ground, command reboot/shutdown,
  publish DoA saat DAQ/freshness gate gagal
```

Kesimpulan: MQTT adalah pilihan yang tepat sebagai lapisan telemetry dan command, tetapi harus ditempatkan di belakang edge agent. DoA dibuat cepat dan ringan; health/state/config dibuat terpisah dan event-driven/berkala lambat; perubahan settings dilakukan sebagai patch tervalidasi dengan revision, expiry, ACK, dan read-back—bukan dengan mengirim atau menulis full `settings.json` dari Ground.
