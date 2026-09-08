# Referensi Data HTTP `sdr-doa` — Port 8081

## 1. Status Dokumen

Dokumen ini berisi hasil **live read-only check** pada Raspberry Pi `doasdr` melalui:

```text
http://doasdr.local:8081
```

Waktu pemeriksaan terakhir:

```text
2026-09-01 sekitar 15:55 WIB
```

Tidak ada konfigurasi yang diubah, tidak ada `POST`, dan isi log mentah maupun nilai key/credential tidak disalin.

Terminologi project:

```text
sdr-doa
SDR-DoA
sdr_doa_start.sh
```

---

## 2. Perilaku Root dan Directory

| Request | Hasil |
|---|---|
| `/` | `HTTP 404` |
| `/logs/` | `HTTP 404` |
| `/logs/<subdirectory>/` | `HTTP 404` |
| file yang path-nya diketahui | dapat `HTTP 200` |

Port ini tidak memberikan directory listing. Root `404` bukan bukti service mati; resource harus dipanggil menggunakan nama file langsung.

Port 8081 terkonfirmasi dilayani oleh HTTP static file server yang mengambil file dari folder share runtime.

---

## 3. Resource yang Terbukti Dapat Dibaca

| Path | HTTP | Content-Type aktual | Ukuran snapshot | Peran |
|---|---:|---|---:|---|
| `/settings.json` | 200 | `application/json` | 4.497 byte | konfigurasi runtime |
| `/status.json` | 200 | `application/json` | 372 byte | status host, software, DAQ, uptime |
| `/DOA_value.html` | 200 | `text/html` | 2.286 byte | CSV satu baris berisi DoA + 360 angular bins |
| `/doa.xml` | 200 | `application/xml` | 455 byte | record DoA/XML ringkas |
| `/logs/.../ui.log` | 200 | `text/plain` | berubah | log UI; bukan kontrak telemetry |
| `/logs/.../node.log` | 200 | `text/plain` | besar/berubah | log node; bukan kontrak telemetry |

Path kandidat seperti `/doa.json`, `/data.json`, `/telemetry.json`, `/config.json`, `/health.json`, `/api/status`, dan `/api/settings` menghasilkan `HTTP 404` pada pemeriksaan ini.

> Daftar di atas adalah hasil probe path yang diketahui, bukan klaim bahwa tidak ada endpoint lain di luar scope pemeriksaan.

---

## 4. `/settings.json`

### Hasil

```text
HTTP       : 200
Format     : JSON
Key        : 158 key
Snapshot   : 4.497 byte
```

### Kategori data yang tersedia

#### Core DoA dan antenna

```text
center_freq
uniform_gain
data_interface
en_doa
doa_method
doa_decorrelation_method
doa_fig_type
expected_num_of_sources
ant_arrangement
ant_spacing_meters
custom_array_x_meters
custom_array_y_meters
array_offset
ula_direction
compass_offset
```

Snapshot aktual menunjukkan konfigurasi seperti:

```text
ant_arrangement          : UCA
doa_method               : MUSIC
ant_spacing_meters       : 0.21
en_doa                   : true
expected_num_of_sources : 1
```

#### Runtime control

```text
en_remote_control
en_system_control
en_beta_features
en_hw_check
en_peak_hold
en_optimize_short_bursts
logging_level
```

Snapshot aktual:

```text
en_remote_control : false
en_system_control : false
en_doa            : true
```

Artinya settings dapat dibaca, tetapi jangan menyimpulkan bahwa perubahan remote dapat dilakukan. Feature control harus diperlakukan sebagai read-only sampai ada validasi terpisah dan otorisasi eksplisit.

#### VFO/channel

Tersedia keluarga key untuk index `0..15`, antara lain:

```text
vfo_freq_<n>
vfo_bw_<n>
vfo_demod_<n>
vfo_iq_<n>
vfo_squelch_<n>
vfo_squelch_mode_<n>
vfo_fir_order_factor_<n>
```

Juga tersedia:

```text
active_vfos
output_vfo
vfo_mode
spectrum_calculation
```

Snapshot aktual:

```text
active_vfos : 1
output_vfo  : 0
vfo_mode    : Standard
```

Walaupun keluarga field sampai index 15 tersedia, backend harus memakai `active_vfos` dan `output_vfo` untuk menentukan channel yang benar-benar aktif. Jangan mengirim seluruh keluarga VFO pada telemetry cepat.

#### Navigasi dan station

```text
station_id
latitude
longitude
heading
location_source
gps_fixed_heading
gps_min_speed
gps_min_speed_duration
```

Snapshot aktual:

```text
station_id     : NOCALL
latitude       : 0.0
longitude      : 0.0
heading        : 0.0
location_source: None
```

#### Integrasi eksternal dan metadata

Settings juga memiliki field untuk mapping/RDF endpoint, software behavior, dan metadata runtime. Field endpoint eksternal tidak boleh langsung diaktifkan atau dipanggil oleh backend tanpa desain security, allowlist, dan persetujuan terpisah.

#### Field sensitif

Ditemukan satu field yang terlihat seperti key/credential. Nilai field tersebut **sengaja tidak ditampilkan, tidak disalin ke project, dan tidak dimasukkan ke Brain**.

Aturan collector:

```text
GET settings boleh untuk snapshot terkontrol
Jangan log seluruh settings tanpa redaction
Jangan publish settings mentah ke MQTT
Redact field key/token/password/secret
Pisahkan config snapshot dari telemetry realtime
```

---

## 5. `/status.json`

### Schema yang terbaca

`status.json` memiliki 14 key:

| Field | Tipe | Fungsi |
|---|---|---|
| `timestamp_ms` | integer | waktu pembuatan status |
| `station_id` | string | identitas station |
| `hardware_id` | string | identitas hardware bila tersedia |
| `unit_id` | integer | nomor unit |
| `host_os_type` | string | tipe OS |
| `host_os_version` | string | versi kernel/OS yang dilaporkan |
| `host_os_architecture` | string | arsitektur host |
| `software_version` | string | versi aplikasi |
| `software_git_short_hash` | string | short hash build/source |
| `uptime_ms` | integer | uptime proses/system yang dilaporkan |
| `gps_status` | string | status GPS |
| `daq_status` | object | detail DAQ bila tersedia |
| `daq_ok` | boolean | indikator DAQ |
| `daq_num_dropped_frames` | integer | jumlah frame DAQ yang ter-drop |

### Snapshot aktual

```text
station_id             : NOCALL
hardware_id            : kosong
unit_id                : 0
host_os_type           : Linux
host_os_architecture   : aarch64
software_version       : 1.8.1
software_git_short_hash: e5df8c9
gps_status             : Disabled
daq_status             : {}
daq_ok                 : false
daq_num_dropped_frames : 2.3K dan bertambah pada pembacaan berulang
```

Versi kernel yang dilaporkan pada snapshot:

```text
6.18.39+rpt-rpi-v8
```

### Freshness dan interpretasi

`status.json` terbukti **live-updated**: `timestamp_ms`, modification time, dan dropped-frame counter berubah selama pembacaan berulang.

Namun status saat pemeriksaan belum hijau:

```text
daq_ok = false
daq_status = {}
dropped frames terus bertambah
```

Maka kesimpulannya:

```text
Service/process HTTP : hidup
Status host           : dapat dibaca
DAQ/data path         : belum boleh dianggap healthy
```

Backend harus meneruskan health state secara eksplisit dan tidak mengubah `daq_ok=false` menjadi `ONLINE` hanya karena port 8081 merespons `HTTP 200`.

---

## 6. `/DOA_value.html`

### Format aktual

Walaupun extension dan content type menunjukkan HTML, isi snapshot sebenarnya adalah:

```text
CSV satu baris
377 field total
```

Parser harus memperlakukannya sebagai CSV/plain record, bukan sebagai DOM HTML.

### Susunan field

| Posisi | Nama internal adapter | Isi snapshot | Makna |
|---:|---|---|---|
| 1 | `timestamp_ms` | integer 13 digit | timestamp record |
| 2 | `doa_deg` | `10.0` | estimasi DoA relatif |
| 3 | `confidence` | metrik PAPR-like dB | bukan probabilitas `0..1`; mapping contract belum diverifikasi |
| 4 | `rssi_db` | `-90.1689...` | power/RSSI pada format ini |
| 5 | `frequency_hz` | `416588000` | frekuensi dalam Hz |
| 6 | `array_type` | `UCA` | tipe antenna array |
| 7 | `processing_latency_ms` | `436` | latency processing yang dilaporkan |
| 8 | `station_id` | `NOCALL` | identitas station |
| 9 | `latitude` | `0.0` | latitude |
| 10 | `longitude` | `0.0` | longitude |
| 11 | `gps_heading` | `0.0` | heading GPS |
| 12 | `compass_heading` | `0.0` | heading compass |
| 13 | `main_heading_sensor` | `GPS` | sumber heading utama |
| 14–17 | `reserved_14..17` | `R` | reserved; jangan dipakai sebagai telemetry |
| 18–377 | `angular_power[0..359]` | float | power DoA per sudut 0..359° |

Snapshot yang dibaca memiliki:

```text
angular_power count : 360
minimum             : 0.00
maximum             : 1.46
peak index          : 350
peak value          : 1.46
```

Ground Console memakai 360 nilai ini hanya untuk observability lokal. Nilai CSV
sudah berupa vektor dB relatif yang digeser oleh source; adapter mempertahankan
angka dan tanda aslinya, lalu hanya memilih peak signed dengan nilai terbesar.
Tidak ada `abs()` atau `log10()` kedua. Kurva polar 0°–359° (0° di atas, arah
clockwise) tetap lokal, tidak masuk payload MQTT, tidak diteruskan oleh LAN edge
agent, dan tidak mengubah status authority atau publication gate.

### Perhatian freshness

Pada repeated read, file ini **tidak berubah** selama interval pemeriksaan. Modification time-nya juga lebih lama dibandingkan `status.json`.

Jangan langsung memakai record ini sebagai telemetry realtime sebelum collector memeriksa:

```text
age = now_ms - timestamp_ms
```

Jika age melewati threshold, tandai `STALE` dan jangan publish sebagai `LIVE`.

---

## 7. `/doa.xml`

### Hasil

```text
HTTP       : 200
Format     : XML
Leaf field : 16
Ukuran     : 455 byte
```

### Schema

```xml
<DATA>
  <STATION_ID>...</STATION_ID>
  <TIME>...</TIME>
  <GPS_TIME>...</GPS_TIME>
  <FREQUENCY>...</FREQUENCY>
  <LOCATION>
    <LATITUDE>...</LATITUDE>
    <LONGITUDE>...</LONGITUDE>
    <HEADING>...</HEADING>
    <SPEED>...</SPEED>
  </LOCATION>
  <DOA>...</DOA>
  <PWR>...</PWR>
  <CONF>...</CONF>
  <LATENCY>...</LATENCY>
  <PROCESSING_TIME>...</PROCESSING_TIME>
  <ADC_OVERDRIVE>...</ADC_OVERDRIVE>
  <NUM_CORRELATED_SOURCES>...</NUM_CORRELATED_SOURCES>
  <SNR_DB>...</SNR_DB>
</DATA>
```

### Field mapping

| Field | Isi snapshot | Makna |
|---|---|---|
| `STATION_ID` | `NOCALL` | identitas station |
| `TIME` | integer 13 digit | timestamp record |
| `GPS_TIME` | `0` | timestamp GPS; belum aktif pada snapshot |
| `FREQUENCY` | `416.588` | frekuensi dalam format MHz pada snapshot |
| `LOCATION/LATITUDE` | `0.0` | latitude |
| `LOCATION/LONGITUDE` | `0.0` | longitude |
| `LOCATION/HEADING` | `0.0` | heading |
| `LOCATION/SPEED` | `0.0` | speed |
| `DOA` | `350.0` | DoA relatif pada format XML |
| `PWR` | `9.8` | power pada skala XML |
| `CONF` | `77` | confidence pada skala XML |
| `LATENCY` | `436` | latency record |
| `PROCESSING_TIME` | `169` | waktu processing |
| `ADC_OVERDRIVE` | `0` | indikator overdrive |
| `NUM_CORRELATED_SOURCES` | `0` | jumlah sumber ter-korelasi |
| `SNR_DB` | `14.5238...` | SNR dalam dB |

### Perhatian kesetaraan format

Snapshot yang dibaca dari XML tidak identik secara nilai dengan snapshot CSV:

```text
CSV DoA        : 10.0
XML DoA        : 350.0
CSV confidence : metrik PAPR-like dalam dB
XML CONF       : integer `PAPR_dB * 100`
MQTT confidence: baru boleh `0..1` setelah mapping/kalibrasi disetujui
CSV RSSI       : -90.1689...
XML PWR        : 9.8
```

Selain timestamp kedua file tampak lebih lama dan tidak berubah pada repeated read. Jangan menggabungkan kedua format dalam satu record tanpa:

1. validasi apakah keduanya berasal dari producer yang sama,
2. aturan pemilihan authoritative source,
3. normalisasi unit/skala,
4. freshness check,
5. sequence/correlation check.

---

## 8. Rekomendasi Sumber untuk Backend

Tahap awal backend sebaiknya memakai adapter read-only dengan tiga keluaran internal:

```text
sdr_status_snapshot
sdr_doa_snapshot
sdr_settings_snapshot
```

Aturan:

```text
status.json  → health, uptime, DAQ state, dropped frames
DOA CSV/XML  → jangan publish sebelum freshness/authority gate lulus
settings     → startup/change/request, redacted, bukan high-rate
logs         → local diagnostics saja, bukan MQTT telemetry
```

Sebelum memilih CSV atau XML sebagai sumber DoA final, lakukan test terkontrol yang mengubah kondisi signal lalu cocokkan:

```text
source timestamp
DoA angle
confidence
power/RSSI
processing latency
```

Jika salah satu format tidak berubah saat DAQ aktif, anggap sebagai snapshot stale atau output legacy sampai terbukti sebaliknya.

---

## 9. Mapping ke MQTT yang Hemat Bandwidth

Setelah adapter tervalidasi, mapping awal yang sesuai budget T900:

```text
sdr/v1/uav-01/telemetry/doa
sdr/v1/uav-01/telemetry/health
sdr/v1/uav-01/state
```

Jangan publish seluruh settings JSON atau seluruh 360 angular values pada setiap frame.

Contoh DoA compact setelah sumber authoritative terbukti:

```json
{"v":1,"seq":1,"ts_ms":1788238776131,"az":350.0,"conf":0.77,"rssi_db":-90.17,"f_hz":416588000,"proc_ms":436}
```

Contoh health:

```json
{"v":1,"ts_ms":1788252859587,"daq_ok":false,"dropped":2356,"gps":"Disabled","age_ms":0}
```

Nilai contoh di atas adalah snapshot hasil pemeriksaan dan bukan kontrak final sampai unit/skala/authority sudah dikonfirmasi.

---

## 10. Acceptance Gate Sebelum Collector Live

```text
[ ] GET settings berhasil tanpa membocorkan key/token/secret
[ ] status.json timestamp berubah saat runtime berjalan
[ ] daq_ok dan dropped-frame behavior dipahami
[ ] CSV/XML source authoritative ditetapkan
[ ] timestamp dan age check bekerja
[ ] DoA/confidence/power unit dinormalisasi
[ ] malformed CSV/XML/JSON ditolak dengan aman
[ ] settings tidak dipublish mentah
[ ] 360 angular array tidak dikirim high-rate tanpa budget
[ ] MQTT payload bytes diukur pada PPP
[ ] stale data ditandai dan tidak dianggap LIVE
```

## Kesimpulan

Port 8081 menyediakan empat resource data utama yang dapat dibaca:

```text
settings.json → konfigurasi
status.json   → health/status
DOA_value.html→ CSV DoA + 360 angular values
doa.xml       → record DoA XML ringkas
```

Namun hasil live menunjukkan dua hal yang harus menjadi guardrail backend:

```text
1. status.json live-updated tetapi daq_ok=false dan dropped frames bertambah.
2. DOA_value.html dan doa.xml tersedia tetapi snapshot-nya stale/tidak berubah
   dan nilai DoA/confidence/power antar-format tidak sama.
```

Karena itu langkah berikutnya adalah membuat collector **read-only, redacted, freshness-aware, dan source-authority-aware** sebelum data diteruskan melalui MQTT/T900.
