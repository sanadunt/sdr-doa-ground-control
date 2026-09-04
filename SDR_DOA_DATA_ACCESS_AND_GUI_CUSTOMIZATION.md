# Panduan Akses Data dan Kustomisasi GUI SDR-DoA

## 1. Tujuan dan status dokumen

Dokumen ini memetakan:

1. data yang dapat dibaca dari node SDR-DoA;
2. path filesystem dan endpoint jaringan untuk mengambilnya;
3. data internal yang hanya tersedia di pipeline Python/GUI;
4. aturan interpretasi, freshness, health, dan keamanan;
5. file/folder yang perlu diubah ketika GUI ingin diganti.

Baseline runtime yang menjadi referensi:

```text
Raspberry hostname : doasdr
User               : doasdr
Project root       : /home/doasdr/doasdr
SDR_ROOT           : /home/doasdr/doasdr
Management LAN     : 192.168.100.100
UAV PPP            : 10.90.0.2
Ground PPP         : 10.90.0.1
Web UI             : 8080
Data Out           : 8081
HTTP middleware    : 8042
WebSocket          : 8021
DAQ control       : 5001 (internal)
DAQ IQ            : 5000 (internal/source interface)
```

Bukti runtime pada dokumen ini berasal dari pemeriksaan read-only sebelumnya. Pemeriksaan terbaru tidak dapat dilakukan karena hostname tidak ter-resolve dan koneksi LAN mengalami timeout. Karena itu contoh nilai live harus dianggap sebagai **snapshot pemeriksaan terakhir**, bukan jaminan status saat ini.

Tidak ada password, token, private key, credential, atau nilai secret yang dicantumkan di sini.

---

## 2. Peta akses tingkat tinggi

```text
Raspberry filesystem
        │
        ├── /home/doasdr/doasdr/_share/settings.json
        ├── /home/doasdr/doasdr/_share/status.json
        ├── /home/doasdr/doasdr/_share/DOA_value.html
        ├── /home/doasdr/doasdr/_share/doa.xml
        ├── /home/doasdr/doasdr/_share/logs/...
        └── /home/doasdr/doasdr/_share/records/...

HTTP :8081
        └── menyajikan file di /home/doasdr/doasdr/_share

GUI :8080
        └── membaca pipeline Python dan menampilkan status/spectrum/DoA

Middleware HTTP :8042
        ├── GET  /settings
        ├── POST /settings       (menulis full settings; berisiko)
        ├── POST /doapost        (producer DoA → WebSocket clients)
        └── POST /prpost         (producer data lain → WebSocket clients)

Middleware WebSocket :8021
        └── event/data internal; bukan kontrak telemetry production
```

Port `8081` tidak memberikan directory listing. Root `/` dapat mengembalikan `404` walaupun server hidup. Resource harus dipanggil dengan nama file yang diketahui.

---

## 3. Cara mengakses dari komputer Ground atau laptop

### 3.1 Melalui management LAN

Jika komputer berada di LAN management:

```bash
BASE='http://192.168.100.100:8081'

curl --fail --silent --show-error --max-time 5 "$BASE/status.json"
curl --fail --silent --show-error --max-time 5 "$BASE/settings.json"
curl --fail --silent --show-error --max-time 5 "$BASE/DOA_value.html"
curl --fail --silent --show-error --max-time 5 "$BASE/doa.xml"
```

Nama host mDNS yang dipakai sebagai alternatif:

```bash
BASE='http://doasdr.local:8081'
```

Pada snapshot pemeriksaan sebelumnya, path `doasdr.local` berhasil digunakan. Jika mDNS tidak tersedia, gunakan alamat LAN langsung atau periksa konfigurasi jaringan terlebih dahulu.

### 3.2 Melalui PPP/T900

Jika route PPP dari Ground ke Raspberry sedang aktif, target jaringan dapat dicoba melalui:

```bash
BASE='http://10.90.0.2:8081'
curl --fail --silent --show-error --max-time 5 "$BASE/status.json"
```

Ini adalah jalur kandidat untuk telemetry/diagnosis melalui link T900. Keberhasilan akses pada suatu waktu harus diuji kembali setelah PPP aktif; dokumen ini tidak menganggapnya sebagai bukti koneksi live terbaru.

### 3.3 Membuka GUI

```text
http://192.168.100.100:8080/
http://doasdr.local:8080/
```

GUI adalah antarmuka operasi dan visualisasi. Ia bukan pengganti adapter telemetry karena status browser, queue GUI, dan output file dapat memiliki freshness yang berbeda.

### 3.4 Membaca file langsung di Raspberry

Dengan akses SSH yang sudah dikonfigurasi secara aman:

```bash
ssh doasdr@192.168.100.100
cd /home/doasdr/doasdr

python3 -m json.tool _share/status.json
python3 -m json.tool _share/settings.json
python3 -c 'import pathlib; print(pathlib.Path("_share/DOA_value.html").read_text())'
python3 -c 'import pathlib; print(pathlib.Path("_share/doa.xml").read_text())'
```

Akses langsung filesystem lebih cocok untuk diagnosis lokal. Untuk aplikasi Ground, gunakan HTTP dengan timeout, parser, age check, dan validasi schema.

---

## 4. Resource port 8081

### 4.1 Ringkasan resource yang terbukti

| URL relatif | Format aktual | Fungsi | Boleh menjadi telemetry? |
|---|---|---|---|
| `/settings.json` | JSON | konfigurasi runtime | hanya snapshot terpilih dan sudah di-redact |
| `/status.json` | JSON | host, uptime, DAQ, drop counter | ya, sebagai health setelah age check |
| `/DOA_value.html` | CSV satu baris walaupun extension HTML | DoA dan angular spectrum | hanya setelah freshness/authority gate |
| `/doa.xml` | XML | record DoA ringkas | hanya setelah freshness/authority gate |
| `/logs/.../ui.log` | teks | diagnosis UI | tidak |
| `/logs/.../node.log` | teks | diagnosis middleware | tidak |

Pada pemeriksaan sebelumnya, ukuran snapshot adalah:

```text
settings.json   : 4.497 byte
status.json     : 372 byte
DOA_value.html  : 2.286 byte
doa.xml         : 455 byte
```

Ukuran dapat berubah. Jangan menjadikan ukuran snapshot sebagai kontrak tetap.

### 4.2 Aturan umum pembacaan

Collector harus:

1. memakai timeout jaringan;
2. memeriksa HTTP status dan content length yang wajar;
3. membaca response secara utuh sebelum parsing;
4. menolak JSON/XML/CSV yang malformed;
5. menangani file yang sedang ditulis karena output tidak dijamin atomic;
6. menghitung `age_ms` dari timestamp sumber;
7. membandingkan timestamp/sequence/frame index jika tersedia;
8. tidak menggabungkan CSV dan XML tanpa aturan authority;
9. tidak menerbitkan DoA ketika health DAQ gagal;
10. mencatat `received_at`, source format, dan alasan penolakan.

---

## 5. Data `/status.json`

### 5.1 Field utama

| Field | Makna |
|---|---|
| `timestamp_ms` | waktu status atau timestamp frame yang sedang diproses |
| `station_id` | identitas station |
| `hardware_id` | identitas hardware dari header bila tersedia |
| `unit_id` | nomor unit |
| `host_os_type` | tipe OS |
| `host_os_version` | versi OS/kernel yang dilaporkan |
| `host_os_architecture` | arsitektur host, misalnya `aarch64` |
| `software_version` | versi aplikasi |
| `software_git_short_hash` | short hash yang dilaporkan aplikasi |
| `uptime_ms` | uptime yang dilaporkan |
| `gps_status` | status koneksi/fungsi GPS |
| `daq_status` | detail sinkronisasi dan parameter DAQ |
| `daq_ok` | hasil health gate DAQ internal |
| `daq_num_dropped_frames` | total frame yang ter-drop |

### 5.2 Detail `daq_status` bila header valid

Field yang dapat muncul:

```text
data_frame_index
frame_sync
sample_delay_sync
iq_sync
noise_source_enabled
adc_overdrive
sampling_frequency_hz
bandwidth_hz
decimated_bandwidth_hz
buffer_size_ms
```

Interpretasi penting:

```text
HTTP 200          : file dapat dibaca
service active    : launcher/unit masih dianggap hidup
daq_ok=true       : syarat DAQ tertentu terpenuhi
```

Ketiganya bukan hal yang sama.

Snapshot terakhir yang tercatat:

```text
gps_status             : Disabled
daq_status             : {}
daq_ok                 : false
daq_num_dropped_frames : meningkat saat sampling
```

Maka status yang tepat untuk backend adalah `DEGRADED` atau status setara, bukan `ONLINE`.

### 5.3 Catatan provenance

Field `software_git_short_hash` tidak boleh menjadi satu-satunya bukti versi runtime. Source memiliki fallback hash ketika discovery repository atau modul Git gagal. Provenance harus dipisahkan menjadi:

```text
reviewed source revision
remote deployed source revision dari probe Git
runtime status field
```

Jika ketiga lapisan tidak cocok atau tidak dapat diverifikasi, beri status `UNVERIFIED`.

---

## 6. Data `/DOA_value.html`

### 6.1 Format

Walaupun extension dan content type dapat menunjukkan HTML, isi yang terbukti adalah:

```text
CSV satu baris
377 field total
```

Susunan field berbasis posisi manusia:

| Posisi | Nama adapter | Makna |
|---:|---|---|
| 1 | `timestamp_ms` | timestamp hasil DoA |
| 2 | `doa_raw_deg` | DoA relatif dari jalur CSV |
| 3 | `confidence_raw` | metrik PAPR-like dalam dB; bukan probabilitas `0..1` |
| 4 | `power_raw_db` | level/power pada skala CSV |
| 5 | `frequency_hz` | frekuensi dalam Hz |
| 6 | `array_type` | geometri array |
| 7 | `acquisition_or_frame_latency_ms` | latency acquisition/frame yang dilaporkan jalur CSV |
| 8 | `station_id` | identitas station |
| 9 | `latitude` | latitude |
| 10 | `longitude` | longitude |
| 11 | `gps_heading` | heading GPS/track field |
| 12 | `compass_heading` | heading compass field |
| 13 | `main_heading_sensor` | sumber heading utama |
| 14–17 | `reserved_14..17` | reserved; jangan dipakai |
| 18–377 | `angular_power[0..359]` | power angular untuk sudut `0..359°` |

### 6.2 Data yang bisa dihitung

Dari 360 angular values, adapter dapat menghitung:

```text
peak_index
peak_angle
peak_value
min_value
max_value
jumlah peak setelah threshold
```

Angular spectrum bukan frequency spectrum. Ia adalah power terhadap arah.

### 6.3 Perbedaan arah dan freshness

Jalur CSV membentuk nilai arah dengan transformasi source:

```text
csv_doa = 360 - theta_0
```

Karena itu nilai CSV tidak boleh langsung dibandingkan dengan `DOA` pada XML tanpa normalisasi.

File ini hanya ditulis ketika hasil DoA melewati gate processing. Jika frame kosong, signal di bawah squelch, atau output VFO tidak aktif, file dapat tetap berisi snapshot lama.

Pada sampling sebelumnya, file tidak berubah walaupun `status.json` berubah. Sebelum dipakai:

```text
age_ms = now_ms - timestamp_ms
```

Jika terlalu tua atau tidak berubah mengikuti stimulus RF terkontrol, tandai `STALE` dan jangan publish sebagai `LIVE`.

---

## 7. Data `/doa.xml`

### 7.1 Schema

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

### 7.2 Makna dan unit

| Field | Makna/normalisasi |
|---|---|
| `STATION_ID` | identitas station |
| `TIME` | timestamp record |
| `GPS_TIME` | timestamp GPS; dapat `0` jika GPS tidak aktif |
| `FREQUENCY` | MHz pada output XML |
| `LATITUDE`, `LONGITUDE` | koordinat |
| `HEADING` | heading yang digunakan source |
| `SPEED` | kecepatan |
| `DOA` | `theta_0` langsung pada XML |
| `PWR` | power yang telah ditransformasikan oleh source |
| `CONF` | integer serialisasi `PAPR_dB * 100`; bukan probabilitas |
| `LATENCY` | acquisition/frame-to-output latency |
| `PROCESSING_TIME` | waktu processing internal |
| `ADC_OVERDRIVE` | indikator overdrive |
| `NUM_CORRELATED_SOURCES` | jumlah sumber berkorelasi |
| `SNR_DB` | SNR dalam dB |

XML hanya memiliki snapshot terakhir dan tidak memiliki sequence number eksplisit. Ia juga ditulis ulang secara non-atomic. Parser harus siap menghadapi XML parsial.

### 7.3 Jangan menyamakan XML dan CSV

Perbedaan yang wajib dinormalisasi:

```text
CSV DoA        : 360 - theta_0
XML DoA        : theta_0
CSV confidence : PAPR-like dB dari `10*log10(max/mean)`
XML CONF       : integer hasil serialisasi `PAPR_dB * 100`
MQTT confidence: tetap `0..1` hanya setelah mapping/kalibrasi disetujui
CSV power      : skala power/RSSI CSV
XML PWR        : power yang ditransformasikan
CSV            : dapat memuat beberapa VFO
XML            : dibangun dari record VFO utama/pertama
```

---

## 8. Data `/settings.json`

### 8.1 Kelompok data

Konfigurasi yang dapat dibaca mencakup:

```text
RF/DAQ
  center frequency
  uniform gain atau AGC
  data interface
  remote-control flag

Antenna/DoA
  array type
  inter-element spacing
  UCA radius
  custom X/Y coordinates
  array offset
  ULA direction
  DoA method
  decorrelation method
  expected source count
  DoA figure type

VFO
  active VFO count
  output VFO
  VFO frequency
  bandwidth
  FIR order factor
  squelch mode/level
  demodulation mode
  IQ channel flag
  DSP decimation
  VFO mode

Station/GPS
  station ID
  location source
  latitude/longitude
  heading
  fixed heading
  minimum GPS speed
  minimum heading duration

Runtime/UI
  peak hold
  beta feature flag
  system-control flag
  logging level
  hardware-check flag
```

### 8.2 Aturan keamanan

`settings.json` bukan payload telemetry mentah. Ia dapat memuat endpoint integrasi dan field yang menyerupai key/token/secret.

Aturan collector:

```text
boleh GET untuk snapshot terkontrol
wajib redact key/token/password/secret
jangan log raw response
jangan publish full settings ke MQTT
jangan POST tanpa allowlist, range validation, auth, dan read-back
```

Subset aman yang dapat dikirim saat startup atau perubahan konfigurasi, setelah disetujui:

```json
{
  "frequency_hz": 433920000,
  "gain": 24,
  "array_type": "UCA",
  "doa_method": "MUSIC",
  "active_vfos": 1,
  "gps_enabled": false
}
```

---

## 9. Data middleware dan data internal GUI

### 9.1 Middleware HTTP `:8042`

Endpoint yang terlihat dari source:

```text
GET  /settings
POST /settings
POST /doapost
POST /prpost
```

`GET /settings` mengembalikan settings yang sedang dimuat middleware. `POST /settings` menulis full document ke `_share/settings.json`; ini bukan endpoint read-only dan belum memiliki kontrak security production yang tervalidasi.

`POST /doapost` dipakai processor untuk meneruskan hasil DoA ke WebSocket client lokal atau remote. Ia bukan endpoint yang sebaiknya dipoll oleh Ground.

### 9.2 WebSocket `:8021`

WebSocket dapat:

- menerima koneksi client lokal;
- menerima event hasil DoA dari `/doapost`;
- meneruskan data ke server remote ketika mode remote diaktifkan;
- mengirim ping dan settings pada mode remote.

Authentication, authorization, TLS, certificate verification, dan schema versioning belum tervalidasi sebagai kontrak production. Jangan membuka port ini langsung ke T900 tanpa hardening.

### 9.3 Event internal yang diterima GUI

Queue antara signal processor dan GUI dapat membawa event seperti:

```text
iq_header
update_rate
latency
max_amplitude
avg_powers
spectrum
doa_thetas
DoA Result
DoA Max
DoA Confidence
DoA Max List
DoA Squelch
VFO-0 Frequency
```

`iq_header` dapat memuat frame index, frame type, sync flags, center frequency, sampling frequency, bandwidth, CPI, IF gains, overdrive, dan noise-source state.

Event queue ini berguna untuk membuat panel GUI baru, tetapi **bukan kontrak API stabil**. Queue UI berkapasitas satu dan dapat membuang frame perantara. GUI baru harus menampilkan drop/stale state secara eksplisit.

---

## 10. Prioritas data untuk telemetry

### Kirim setelah gate lulus

```text
DoA relatif canonical
confidence normalized
power/RSSI
SNR
frequency
timestamp
sequence atau frame index
processing time
health/DAQ state
GPS/heading bila valid
```

### Simpan lokal atau kirim on-demand

```text
360 angular values
frequency spectrum
waterfall
raw IQ
FM audio
IQ/WAV recording
full settings snapshot
raw log
```

Target operasi continuous tetap sekitar `8–10 kbit/s`. JSON payload kecil belum membuktikan wire traffic kecil karena MQTT/TCP/PPP/retry tetap memiliki overhead.

---

## 11. Peta folder dan file GUI

### 11.1 Root GUI

```text
/home/doasdr/doasdr/_ui/_web_interface/
├── app.py
├── maindash.py
├── variables.py
├── waterfall.py
├── assets/
├── views/
└── callbacks/
```

Entry point pada deployment saat ini dijalankan dari project root:

```bash
python3 _ui/_web_interface/app.py
```

Server GUI mendengarkan pada:

```text
0.0.0.0:8080
```

### 11.2 File berdasarkan jenis perubahan

| Tujuan perubahan | Lokasi/file | Catatan |
|---|---|---|
| Judul aplikasi, inisialisasi Dash, pendaftaran layout | `_ui/_web_interface/maindash.py` | membuat app, singleton interface, figure awal |
| Entry point server dan port GUI | `_ui/_web_interface/app.py` | menghubungkan layout dan callback; ubah port hanya bila benar-benar perlu |
| Header, menu Configuration/Spectrum/DoA, struktur root | `_ui/_web_interface/views/main.py` | tempat utama mengganti branding/layout navigasi |
| Halaman DoA | `_ui/_web_interface/views/generate_doa_page.py` | komponen field DoA dan graph container |
| Halaman spectrum/waterfall | `_ui/_web_interface/views/spectrum_page.py` | ukuran dan susunan dua graph |
| Card status DAQ | `_ui/_web_interface/views/daq_status_card.py` | label dan field status DAQ |
| Card RF/DAQ configuration | `_ui/_web_interface/views/daq_config_card.py` | frequency, gain, preconfig, parameter DAQ |
| Card konfigurasi DoA/DSP | `_ui/_web_interface/views/dsp_config_card.py` | array, metode, decorrelation, offset, source count |
| Card global VFO | `_ui/_web_interface/views/vfo_config_card.py` | active VFO, output VFO, demod, decimation |
| Card tiap VFO | `_ui/_web_interface/views/vfo_card.py` | frequency, bandwidth, squelch, demod, IQ |
| Card station/GPS | `_ui/_web_interface/views/station_config_card.py` | station ID, lokasi, heading, GPS |
| Card display | `_ui/_web_interface/views/display_options_card.py` | Linear/Polar/Compass, offset, peak hold |
| Card recording lokal | `_ui/_web_interface/views/recording_config_card.py` | filename, interval, enable recording |
| Card system control | `_ui/_web_interface/views/system_control_card.py` | reset/restart/shutdown; jangan aktifkan tanpa safety gate |
| Tooltip/panduan field | `_ui/_web_interface/views/tooltips.py` | teks bantuan |
| Routing URL `/config`, `/spectrum`, `/doa` | `_ui/_web_interface/callbacks/display_page.py` | setiap route harus mengembalikan layout dan class header yang sesuai |
| Interaksi form, update graph, settings, GPS, VFO | `_ui/_web_interface/callbacks/main.py` | perubahan component ID harus diikuti perubahan callback |
| Update frequency/gain DAQ | `_ui/_web_interface/callbacks/update_daq_params.py` | menyentuh receiver dan konfigurasi DSP; risiko lebih tinggi |
| Warna, ukuran, figure layout, daftar pilihan | `_ui/_web_interface/variables.py` | constants dan konfigurasi presentasi |
| CSS global, responsive layout, warna card/button | `_ui/_web_interface/assets/style.css` | titik paling aman untuk perubahan visual |
| Logo/icon/static assets | `_ui/_web_interface/assets/` | ganti asset visual, jangan menaruh credential di dalamnya |
| Renderer chart DoA | modul di folder `_ui/_web_interface/` yang memiliki fungsi `plot_doa` | ubah chart/transformasi display dengan hati-hati; jangan mengubah data source tanpa uji konvensi sudut |
| Renderer spectrum/waterfall | modul di folder `_ui/_web_interface/` yang memiliki fungsi `init_spectrum_fig` dan `plot_spectrum` | mengubah tampilan graph, bukan format telemetry |
| Generator halaman configuration | modul di folder `_ui/_web_interface/` yang memiliki fungsi `generate_config_page_layout` | tempat merakit semua card configuration |

### 11.3 Peta fungsi GUI

```text
app.py
  └── views.main.layout
        ├── navigation/header
        ├── page-content
        └── callbacks

callbacks/display_page.py
  ├── /config  → generator configuration page
  ├── /spectrum → spectrum_page.layout
  └── /doa → generate_doa_page.layout

callbacks/main.py
  ├── membaca queue receiver/signal processor
  ├── memperbarui status DAQ
  ├── memperbarui spectrum/waterfall
  ├── memperbarui chart DoA
  ├── menyimpan settings
  └── mengubah parameter VFO/GPS/recording
```

---

## 12. Perubahan GUI yang relatif aman

### 12.1 Branding dan visual

Mulai dari:

```text
assets/style.css
views/main.py
assets/ image/icon files
```

Contoh perubahan yang relatif terisolasi:

- warna background/card/button;
- ukuran dan spacing;
- responsive breakpoint;
- teks menu dan label;
- urutan card di halaman configuration;
- logo dan favicon;
- tinggi graph;
- warna trace Plotly.

### 12.2 Menambah panel telemetry read-only

Pola yang disarankan:

1. buat file view baru di `views/`, misalnya `telemetry_card.py`;
2. gunakan component ID baru yang tidak bentrok;
3. daftarkan card pada generator configuration atau page yang sesuai;
4. tambahkan callback read-only pada `callbacks/main.py` atau file callback baru;
5. baca data dari object interface/queue yang sudah ada;
6. tampilkan `LIVE`, `DEGRADED`, `STALE`, atau `UNAVAILABLE`;
7. jangan membuat panel baru membaca secret dari settings;
8. uji ketika browser ditutup karena queue UI tetap harus diperlakukan sebagai best-effort.

### 12.3 Mengubah chart DoA

Bedakan tiga hal:

```text
source theta          : hasil estimator
CSV output direction  : transformasi source untuk format CSV
Compass display       : transformasi visual dengan offset dan arah clockwise
```

Jika hanya ingin mengubah tampilan, ubah renderer chart atau CSS. Jangan mengubah nilai canonical yang dikirim ke backend secara diam-diam.

---

## 13. File yang jangan diubah untuk sekadar mengganti GUI

Jangan mulai dari file berikut bila tujuannya hanya mengganti tampilan:

```text
_sdr/                         receiver dan signal processor
sibling DAQ firmware tree    konfigurasi dan binary DAQ
_share/settings.json          state konfigurasi runtime
_share/status.json            output status runtime
_share/DOA_value.html         output DoA
_share/doa.xml                output XML
systemd unit                  lifecycle service
T900/PPP configuration        link transport
```

Mengubah `_sdr` atau konfigurasi DAQ dapat mengubah hasil DoA, timing, frame health, dan penggunaan CPU. Mengubah `_share` secara manual saat proses berjalan dapat bertabrakan dengan writer/watcher dan menghasilkan snapshot parsial.

---

## 14. Risiko callback dan component ID

GUI memakai callback berbasis ID. Bila ID diubah pada view tetapi tidak diubah pada callback, halaman dapat gagal saat load atau interaksi.

Setiap perubahan component harus memeriksa:

```text
id component
property yang dibaca callback
property yang ditulis callback
route yang memuat component
initial layout ketika callback dipanggil
```

Contoh dependency yang harus tetap konsisten:

```text
url → page-content
btn-update_rx_param → frequency/gain update
loc_src_dropdown → GPS/location/heading visibility
active_vfos → VFO card visibility
vfo_* → VFO processing settings
doa_fig_type → chart mode
```

Jangan menambahkan command restart/shutdown ke GUI baru tanpa confirmation, authorization, audit log, dan rollback plan.

---

## 15. Workflow kustomisasi GUI yang disarankan

### Tahap A — backup dan branch

```text
1. Simpan backup folder _ui/_web_interface.
2. Kerjakan pada checkout lokal/branch terpisah.
3. Jangan mengedit arsip dokumentasi historis.
4. Simpan daftar file yang berubah.
```

### Tahap B — ubah visual dahulu

```text
1. assets/style.css
2. views/main.py
3. views/<card>.py
4. asset image/icon
```

### Tahap C — validasi static

Dari project root:

```bash
python3 -m compileall -q _ui/_web_interface
```

Jika environment dependency belum lengkap, catat error import sebagai environment issue dan tetap lakukan parse/syntax check terhadap file yang diubah.

### Tahap D — validasi runtime GUI

```text
1. start pada environment test;
2. buka /config;
3. buka /spectrum;
4. buka /doa;
5. periksa browser console dan log UI;
6. uji refresh dan reconnect browser;
7. pastikan status DAQ yang rusak tetap terlihat DEGRADED;
8. cek endpoint 8081 tidak berubah format;
9. baru rencanakan deployment Raspberry.
```

Tidak ada deployment atau restart Raspberry yang dilakukan oleh dokumen ini.

---

## 16. Rekomendasi desain GUI baru untuk node UAV

GUI baru sebaiknya dipisahkan secara visual menjadi:

```text
1. System health
   DAQ sync, dropped frames, process liveness, link state

2. DoA live
   relative DoA, canonical bearing, confidence, SNR, power, age

3. Navigation
   latitude, longitude, altitude dari sumber navigasi yang disetujui, heading/source

4. RF/DSP state
   frequency, gain, array, algorithm, active VFO

5. Diagnostics
   raw format, timestamps, parser errors, stale reason
```

Indikator warna yang disarankan:

```text
LIVE       : data fresh dan semua gate lulus
DEGRADED   : service hidup tetapi DAQ/health bermasalah
STALE      : timestamp/output terlalu lama
UNAVAILABLE: endpoint atau sumber tidak dapat dibaca
UNVERIFIED : data ada tetapi authority/unit belum dibuktikan
```

GUI tidak boleh menyembunyikan `daq_ok=false`, dropped frames, atau stale output hanya agar tampilan terlihat normal.

---

## 17. Checklist implementasi data collector dan GUI

```text
[ ] HTTP timeout dan error handling
[ ] Parsing JSON status/settings
[ ] Parsing CSV 377 field
[ ] Parsing XML dan validasi leaf field
[ ] Atomic/partial-file handling
[ ] Timestamp age check
[ ] CSV/XML angle normalization
[ ] Confidence/power unit normalization
[ ] Authority source ditetapkan
[ ] settings redaction
[ ] No raw IQ/full array pada telemetry rutin
[ ] Queue/drop state terlihat di GUI
[ ] DAQ health berbeda dari UI liveness
[ ] Component ID callback sudah konsisten
[ ] Route /config /spectrum /doa tetap bekerja
[ ] Syntax check dan runtime smoke test
[ ] Tidak ada credential di source, asset, log, atau payload
[ ] Tidak ada perubahan runtime Raspberry tanpa approval terpisah
```

## Kesimpulan

Data paling mudah diakses dari node adalah:

```text
/home/doasdr/doasdr/_share/status.json
/home/doasdr/doasdr/_share/settings.json
/home/doasdr/doasdr/_share/DOA_value.html
/home/doasdr/doasdr/_share/doa.xml
```

melalui filesystem lokal atau endpoint HTTP port `8081`. GUI berada di:

```text
/home/doasdr/doasdr/_ui/_web_interface/
```

Untuk mengganti tampilan, mulai dari `assets/style.css`, `views/`, dan routing/callback yang relevan. Jangan mengubah receiver, DSP, DAQ, atau output `_share` bila tujuan hanya mengganti GUI. Semua output DoA tetap harus melewati health, freshness, unit, dan authority gate sebelum diteruskan sebagai telemetry.
