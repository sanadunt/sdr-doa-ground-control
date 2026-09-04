# Studi Upstream Software SDR-DoA

## Status Dokumen

Dokumen ini adalah sintesis teknis dari studi read-only terhadap:

1. repository upstream yang dikirim user;
2. checkout lokal sementara di `/tmp/sdr-doa-upstream`;
3. instalasi aktif pada Raspberry `doasdr` di `/home/doasdr/doasdr/`;
4. hasil live check port, proses, service, konfigurasi aman, dan file output.

Dokumen baru project menggunakan istilah **SDR-DoA**, **sdr-doa**, dan **sdr_doa_start.sh**. Arsip dokumentasi historis project tidak diubah.

Snapshot source yang dipelajari:

```text
commit : 2e1c4e6a918f649f62c1b7a5c4c98a8b1bdc7e59
date   : 2025-12-13T04:37:45+01:00
message: sync with dev improvements (#163)
license: GPL-3.0
```

Probe Git read-only yang berhasil pada Raspberry melaporkan source tree deployed berada pada commit yang sama dengan checkout yang dikaji. Worktree remote hanya menunjukkan satu file untracked `mydata.csv`; tidak ada perubahan source yang dilakukan selama studi ini.

Provenance harus dipisahkan menjadi tiga lapisan:

```text
reviewed source       : checkout lokal pada 2e1c4e6...
deployed source tree  : hasil probe Git remote sebelumnya pada 2e1c4e6...
runtime status field  : software_git_short_hash = e5df8c9
```

Nilai `e5df8c9` tidak ditemukan pada checkout yang dikaji. Source `variables.py` memakai nilai fallback tersebut ketika GitPython atau discovery repository gagal. Karena itu `software_git_short_hash` dari `status.json` **belum terverifikasi dan fallback-prone**; ia tidak boleh dipakai sendirian untuk membuktikan provenance proses yang sedang berjalan. Re-check terbaru ke Raspberry gagal karena resolusi hostname dan koneksi LAN timeout, sehingga baris runtime di dokumen ini merujuk pada snapshot sukses terakhir, bukan status live baru.

---

## 1. Kesimpulan Eksekutif

SDR-DoA adalah aplikasi direction finding yang memisahkan dua bidang kerja utama:

```text
DAQ subsystem  : menerima banyak kanal IQ koheren dari receiver
DSP subsystem  : melakukan spectrum, VFO, squelch, DoA, dan output
```

Keduanya dapat berjalan:

- pada satu Raspberry menggunakan shared memory;
- pada dua host terpisah menggunakan Ethernet IQ streaming dan control socket.

Pada mode lokal yang sedang dipakai Raspberry, alur utamanya adalah:

```text
Antenna array
    │
    ▼
DAQ firmware / native DAQ chain
    │  double-buffer shared memory + control FIFO
    ▼
ReceiverRTLSDR
    │  IQ frame + 1024-byte header
    ▼
SignalProcessor
    ├── decimation dan spectrum
    ├── VFO/channelization
    ├── squelch
    ├── estimasi DoA
    ├── confidence, power, SNR, latency
    ├── optional GPS, FM demod, dan recording
    └── output file / middleware
         ├── DOA_value.html  (CSV satu baris)
         ├── doa.xml          (XML ringkas)
         ├── status.json      (health/status)
         └── /doapost         (middleware JSON)
```

Kemampuan aplikasi cukup luas untuk operasi lokal, tetapi output upstream **bukan kontrak telemetry T900 yang siap produksi**. Untuk project ini, SDR-DoA harus diperlakukan sebagai engine pemrosesan lokal. Controller UAV yang terpisah menjadi boundary untuk:

- memilih field output yang aman;
- memvalidasi timestamp, unit, freshness, dan status DAQ;
- mengubah format internal menjadi schema telemetry versioned;
- menghitung global bearing hanya bila heading dan mounting offset tervalidasi;
- menerapkan queue latest-value-wins;
- mengirim payload compact melalui MQTT di atas PPP/T900.

---

## 2. Arsitektur Source

### 2.1 Modul utama

| Area source | Tanggung jawab |
|---|---|
| `_sdr/_receiver/` | menerima frame IQ melalui Ethernet atau shared memory, decode header, mengirim command RF |
| `_sdr/_signal_processing/` | spectrum, decimation, VFO, channelization, squelch, algoritma DoA, GPS, dan output |
| `_ui/_web_interface/` | Dash web UI, konfigurasi, callback, visualisasi DoA/spectrum/waterfall, dan status DAQ |
| `_nodejs/` | middleware Express + WebSocket untuk settings dan distribusi record JSON |
| `util/` | start/stop, inisialisasi, dan sinkronisasi log DAQ |
| `_share/` | file yang dibaca client: settings, status, record DoA, serta log yang dibagikan |

Source Python menggunakan object utama berikut:

```text
WebInterface
  ├── ReceiverRTLSDR
  └── SignalProcessor (thread)
```

`WebInterface` membaca settings, membuat queue receiver dan processor, mengonfigurasi object, lalu menjalankan thread `SignalProcessor`. Callback UI membaca queue secara periodik dan menggambar hasilnya.

### 2.2 Mode data lokal

Mode `shmem` menggunakan interface berikut:

```text
DAQ producer
  ├── shared memory: delay_sync_iq_A
  ├── shared memory: delay_sync_iq_B
  └── FIFO kontrol di _data_control/

DSP consumer
  ├── menunggu buffer A/B siap
  ├── membaca header 1024 byte
  ├── membaca payload complex IQ
  ├── menyalin data ke array NumPy
  └── memberi tanda buffer siap dipakai kembali
```

Interface memakai dua buffer agar producer dan consumer dapat bergantian. Signal kontrol yang digunakan oleh implementasi meliputi:

```text
A_BUFF_READY = 1
B_BUFF_READY = 2
INIT_READY   = 10
TERMINATE    = 255
```

Jika frame tidak tersedia tepat waktu atau pembacaan IQ gagal, receiver dapat mengembalikan frame kosong dan processor menaikkan counter frame yang dibuang. Ini berbeda dari sekadar status HTTP atau status systemd.

### 2.3 Mode data remote

Dalam mode `eth`, receiver DSP menggunakan dua koneksi TCP ke host DAQ:

```text
port 5000 : IQ streaming
port 5001 : control interface
```

Urutan koneksi yang terlihat pada source:

1. connect ke port IQ;
2. kirim perintah `streaming`;
3. baca frame IQ pertama dan tentukan jumlah kanal;
4. connect ke port control;
5. kirim `INIT`;
6. kirim konfigurasi frekuensi dan gain;
7. minta frame berikutnya dengan `IQDownload`.

Mode remote memungkinkan DAQ dan DSP memakai processing unit berbeda untuk throughput/stability yang lebih tinggi. Mode ini tidak sama dengan PPP telemetry; port tersebut adalah interface internal data mentah dan tidak boleh diteruskan melalui T900.

---

## 3. IQ Frame dan Health DAQ

### 3.1 IQ header

Setiap frame mempunyai header tetap 1024 byte. Field penting yang didecode oleh receiver meliputi:

```text
sync_word
frame_type
hardware_id
unit_id
active_ant_chs
rf_center_freq
adc_sampling_freq
sampling_freq
cpi_length
time_stamp
daq_block_index
cpi_index
ext_integration_cntr
data_type
sample_bit_depth
adc_overdrive_flags
if_gains[32]
delay_sync_flag
iq_sync_flag
sync_state
noise_source_state
header_version
```

Jenis frame yang tersedia di source:

```text
DATA      = 0
DUMMY     = 1
RAMP      = 2
CAL       = 3
TRIGW     = 4
EMPTY     = 5
```

Payload IQ dibentuk dari jumlah kanal aktif, `cpi_length`, dua komponen I/Q, dan sample bit depth. Pada mode shared memory, receiver membaca header 1024 byte lalu mem-view payload menjadi array `complex64` berbentuk:

```text
(active_ant_chs, cpi_length)
```

### 3.2 Kondisi frame yang diproses

Loop `SignalProcessor` hanya mengolah frame `DATA` pada jalur normal. Frame kosong atau frame yang gagal diambil tidak menghasilkan DoA baru. Source menyimpan counter `dropped_frames` ketika data frame hilang saat processing aktif.

`daq_ok` pada `status.json` bukan indikator process hidup. Source menetapkannya true hanya jika:

```text
frame bukan EMPTY
frame sync valid
sample-delay sync valid
IQ sync valid
```

Dengan demikian, kombinasi berikut masuk akal dan harus dibedakan:

```text
Web UI HTTP 200       : process/UI dapat merespons
systemd active         : unit start dianggap selesai
status daq_ok=false    : frame/data path belum sehat
DOA file tidak berubah : tidak ada output DoA baru yang lolos pipeline
```

### 3.3 Makna dropped frames

Dropped frame dapat berasal dari beberapa lapisan, antara lain:

- buffer shared memory tidak tersedia tepat waktu;
- USB host atau kabel bermasalah;
- suplai daya tidak memadai;
- CPU Raspberry overload;
- konfigurasi host/DAQ tidak sesuai;
- processing lebih lambat daripada kedatangan frame.

Karena itu counter harus dikirim sebagai health signal, bukan disembunyikan di balik status `running=true`.

---

## 4. Siklus Processing DSP

Siklus utama `SignalProcessor.run()` secara konseptual adalah:

```text
while processing:
    optional GPS update
    acquire IQ frame
    serialize status.json
    validate frame type / data availability
    optional global decimation
    calculate frequency spectrum
    update squelch
    for each active VFO:
        select frequency window
        apply channelization / FIR
        check signal against squelch
        if output VFO and DoA enabled:
            estimate DoA
            calculate confidence
            collect power, SNR, latency
            optional FM demod / IQ buffer
    update UI queue
    write DoA outputs
    optional local record
```

### 4.1 Spectrum dan VFO

Source mendukung:

- spectrum single-channel atau full-channel;
- waterfall UI;
- click-to-tune dari graph/waterfall;
- sampai 16 slot VFO pada object processor;
- `active_vfos` untuk menentukan jumlah VFO aktif;
- `output_vfo` untuk memilih VFO yang menghasilkan output DoA;
- VFO frequency, bandwidth, FIR order factor, demod, IQ, dan squelch;
- mode VFO standard atau auto;
- auto squelch dan auto-channel squelch;
- peak-hold spectrum;
- optional decimation untuk menurunkan bandwidth processing.

Squelch adalah gate penting. DoA tidak dihitung untuk VFO bila level maksimum tidak melewati threshold. Signal yang bursty dapat tampak seperti pipeline berhenti bila threshold terlalu tinggi atau DAQ tidak menghasilkan frame valid.

### 4.2 Channelization

Untuk setiap VFO yang lolos gate, source melakukan channelization menggunakan frekuensi relatif terhadap center frequency, decimation factor, dan FIR order factor. Bila mode demod FM aktif, channel dapat diturunkan ke 48 kHz untuk demodulasi. Hasil FM dan IQ dapat dikumpulkan untuk recording lokal.

### 4.3 Algoritma DoA

Algoritma yang tersedia di source:

```text
Bartlett
Capon
MEM
TNA
MUSIC
ROOT-MUSIC
```

Source menghitung spatial correlation matrix terlebih dahulu. Untuk source yang berkorelasi atau SNR rendah, UI mengekspos opsi decorrelation/averaging berikut:

```text
FBA
TOEP
FBSS
FBTOEP
```

Pada fungsi `estimate_DOA()` yang dipelajari, branch processing eksplisit terlihat untuk FBA, TOEP, dan FBSS; FBTOEP harus divalidasi melalui stimulus dan output runtime sebelum dijadikan baseline produksi. Label UI saja bukan bukti bahwa seluruh opsi dipakai pada jalur processing saat ini.

Nilai diagnostik yang dihitung bersamaan meliputi:

```text
number_of_correlated_sources
SNR
confidence / PAPR-like metric
processing latency
ADC overdrive flag
```

Confidence adalah metrik PAPR-like hasil processing dalam dB, bukan probabilitas kebenaran absolut. Ground harus menampilkan metrik native bersama status freshness, SNR/quality, DAQ health, dan status mapping ke contract MQTT.

### 4.4 Geometri array

Source mendukung beberapa representasi array:

```text
ULA     : uniform linear array
UCA     : uniform circular array
VULA    : virtual ULA melalui phase-mode transformation
Custom  : posisi x/y tiap elemen
```

Untuk UCA dengan ROOT-MUSIC atau decorrelation tertentu, source mengubah jalur internal menjadi VULA, melakukan transformasi phase mode, lalu membuat scanning vector yang sesuai.

`array_offset` dan `compass_offset` memengaruhi interpretasi sudut. Untuk ULA, source dapat membatasi visualisasi ke arah `Forward`, `Backward`, atau `Both`.

#### Caveat nama parameter

Pada konfigurasi saat ini terdapat field bernama `ant_spacing_meters`. Saat array adalah UCA, `WebInterface` memakai nilai tersebut sebagai radius UCA lalu mengonversinya menjadi inter-element spacing berbasis wavelength. Karena itu adapter tidak boleh menyimpulkan makna fisik hanya dari nama key; makna harus ditentukan bersama `ant_arrangement` dan kode konfigurasi.

---

## 5. Konfigurasi dan Perubahan Runtime

### 5.1 Sumber konfigurasi

File utama adalah:

```text
<project-root-sdr-doa>/_share/settings.json
```

Dalam dokumentasi project, file tersebut disebut sebagai `settings.json` pada folder share dan tidak boleh dipublikasikan mentah.

Source memuat sekitar 158 key pada snapshot Raspberry. Kategori aman yang relevan untuk adapter meliputi:

```text
center_freq
uniform_gain
data_interface
default_ip
en_doa
ant_arrangement
ant_spacing_meters
custom_array_x_meters
custom_array_y_meters
array_offset
doa_method
doa_decorrelation_method
expected_num_of_sources
active_vfos
output_vfo
vfo_freq_<n>
vfo_bw_<n>
vfo_squelch_<n>
vfo_demod_<n>
vfo_iq_<n>
station_id
latitude
longitude
heading
location_source
dsp_decimation
logging_level
```

Field yang menyerupai key, token, password, secret, atau credential harus selalu di-redact. Endpoint mapping eksternal juga tidak boleh diaktifkan otomatis oleh collector.

### 5.2 Settings watcher

`settings_change_watcher` memeriksa modification time file secara periodik, sekitar setiap 0,5 detik. Bila file berubah, source memuat ulang parameter DSP dan sebagian parameter DAQ, termasuk:

- frekuensi center;
- gain/AGC;
- metode DoA;
- geometri array;
- decorrelation;
- station/location/heading;
- VFO dan squelch;
- decimation;
- format output.

Flag `ext_upd_flag` digunakan untuk memberi tahu UI agar refresh. Perubahan RF dapat memicu komunikasi control socket dan reconfiguration.

Implikasinya untuk Controller:

```text
jangan menulis sebagian JSON secara race-prone
jangan mengirim file mentah dari Ground
validasi schema/range sebelum write
gunakan temporary file + atomic replace bila nanti membuat adapter
read-back settings setelah perubahan
ACK hanya setelah state aktual terbukti
```

### 5.3 Konfigurasi aktif Raspberry

Safe snapshot yang dibaca secara live menunjukkan:

```text
data_interface          : shmem
center_freq             : 416.588 MHz
uniform_gain            : 15.7 dB
en_doa                  : true
ant_arrangement         : UCA
ant_spacing_meters      : 0.21
doa_method              : MUSIC
doa_decorrelation       : Off
active_vfos             : 1
output_vfo              : 0
vfo_freq_0              : 416588000 Hz
vfo_bw_0                : 12500 Hz
dsp_decimation          : 1
en_remote_control       : false
location_source         : None
station_id              : NOCALL
```

Nilai credential-like tidak dibaca keluar, tidak ditulis ke dokumen, dan tidak dimasukkan ke Brain.

---

## 6. Proses Start, Stop, dan Service

### 6.1 Start sequence upstream

`util` start script upstream melakukan pola berikut:

```text
activate Conda environment
optional clear pycache
stop existing DAQ/DSP
cd heimdall_daq_fw/Firmware
start DAQ shared-memory chain
delay singkat
cd <project-root-sdr-doa>
start script `gui_run.sh`
optional start integration tambahan bila terpasang
```

Versi project memakai wrapper:

```text
/usr/local/sbin/sdr-doa-start
    └── activate env sdr
        └── /home/doasdr/doasdr/sdr_doa_start.sh
```

Stop wrapper memanggil:

```text
/home/doasdr/doasdr/sdr_doa_stop.sh
    ├── DAQ stop
    └── SDR-DoA kill.sh
```

Start script menjalankan beberapa komponen sebagai proses background. Ini penting untuk reliability: status launcher tidak otomatis merepresentasikan health semua child process.

### 6.2 `gui_run.sh`

Secara source, script ini:

1. memakai `0.0.0.0:8081` sebagai Data Out;
2. membuat `_share` dan folder log;
3. menjalankan sinkronisasi log DAQ;
4. menjalankan Python web UI pada port 8080;
5. menjalankan static file server pada port 8081;
6. bila remote-control setting dan tool tersedia, dapat memakai server yang mendukung upload/control;
7. menjalankan Node middleware.

Aplikasi Python bind:

```text
0.0.0.0:8080
```

Node middleware bind:

```text
HTTP      : 0.0.0.0:8042
WebSocket : 0.0.0.0:8021
```

Pada Raspberry saat studi, port 8081 terbukti dilayani oleh PHP built-in server, sehingga mode aktif adalah shared static files. Setting `en_remote_control=false` juga konsisten dengan mode tersebut.

### 6.3 Service live Raspberry

Hasil read-only live check:

```text
t900-ppp.service   : active, enabled
sdr-doa.service    : active, enabled
sdr-watchdog.timer : active, enabled
```

`sdr-doa.service` menggunakan `Type=oneshot` dan `RemainAfterExit=yes`. Unit dapat tetap berstatus active setelah launcher selesai, meskipun salah satu child process berikutnya berhenti. Ini harus dipertimbangkan saat membuat health gate.

Watchdog saat ini:

```text
OnBootSec       : 5 min
OnUnitActiveSec : 2 min
```

Script watchdog hanya melakukan curl ke root UI port 8080 dan me-restart service bila UI tidak merespons. Ia belum memeriksa:

```text
status.json daq_ok
status.json timestamp freshness
dropped-frame slope
freshness DOA_value.html / doa.xml
port 8042 / 8021
DAQ child process
PPP/T900 link
```

Rekomendasi: sebelum penerbangan, watchdog harus dipisah menjadi liveness dan data health. UI hidup tetapi DAQ rusak harus menghasilkan state `DEGRADED`, bukan `ONLINE`.

---

## 7. Output yang Dihasilkan

### 7.1 `status.json`

Source menulis status pada setiap iterasi processing, sebelum processing frame selesai. Schema yang terbukti:

```text
timestamp_ms
station_id
hardware_id
unit_id
host_os_type
host_os_version
host_os_architecture
software_version
software_git_short_hash
uptime_ms
gps_status
daq_status
daq_ok
daq_num_dropped_frames
```

Bila header frame valid, `daq_status` dapat berisi:

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

Bila frame kosong, `daq_status` dapat tetap `{}` dan `daq_ok=false`. Maka `status.json` adalah sumber health/freshness yang penting, tetapi harus dibaca dengan aturan age dan counter.

### 7.2 `DOA_value.html`

Walaupun extension-nya `.html`, source menulis CSV satu baris untuk format aplikasi legacy:

```text
field 1–13  : timestamp, DoA, confidence, power, frequency,
              array, latency, station, lat, lon,
              heading, heading, heading-source
field 14–17 : reserved
field 18–377: 360 angular power values, 0°..359°
```

Source menulis record ini hanya ketika terdapat hasil DoA yang lolos seluruh gate processing. Jika DAQ kosong, signal di bawah squelch, atau output VFO tidak aktif, file dapat tetap berisi snapshot lama.

#### Perbedaan arah dengan XML

Pada jalur CSV, source membentuk DoA output dengan transformasi:

```text
csv_doa = 360 - theta_0
```

Pada jalur XML, source menulis `theta_0` langsung. Ini menjelaskan mengapa dua file dapat berbeda seperti `10°` versus `350°` walaupun berasal dari event yang terkait. Perbedaan ini adalah konvensi orientasi, bukan alasan untuk mengambil nilai yang kebetulan paling baru.

Adapter wajib menetapkan canonical angle convention secara eksplisit dan menyimpan:

```text
relative_doa_raw
relative_doa_canonical
angle_convention
source_format
source_timestamp
```

### 7.3 `doa.xml`

XML ringkas dibangun setiap kali source mempunyai hasil DoA utama. Field yang ditulis:

```text
STATION_ID
TIME
GPS_TIME
FREQUENCY
LOCATION/LATITUDE
LOCATION/LONGITUDE
LOCATION/HEADING
LOCATION/SPEED
DOA
PWR
CONF
LATENCY
PROCESSING_TIME
ADC_OVERDRIVE
NUM_CORRELATED_SOURCES
SNR_DB
```

Normalisasi source:

```text
FREQUENCY : MHz
CONF      : integer percent
PWR       : level yang ditransformasikan dari power dB
DOA       : theta_0, bukan transformasi CSV
```

XML mudah dibaca, tetapi tetap merupakan file snapshot yang ditulis ulang tanpa sequence number eksplisit. Freshness, timestamp correlation, dan source authority tetap harus diperiksa.

### 7.4 Middleware JSON

Pada format output tertentu, processor mengirim JSON ke endpoint lokal `/doapost`. Field internal yang terlihat dari source meliputi:

```text
station_id
tStamp
gps_timestamp
latitude
longitude
gpsBearing
speed
radioBearing
conf
power
freq
antType
latency
processing_time
doaArray
adc_overdrive
num_corr_sources
snr_db
```

`doaArray` adalah representasi string dari seluruh angular result. Ukuran dan frekuensinya tidak cocok untuk telemetry T900 rutin. Middleware JSON hanya boleh dijadikan sumber adapter setelah:

- endpoint lokal dibatasi;
- schema divalidasi;
- array dibuang atau dipadatkan;
- unit dan arah dinormalisasi;
- queue bounded diterapkan.

### 7.5 Recording lokal

Source dapat melakukan:

- recording FM WAV;
- recording channel IQ;
- data record CSV lokal;
- peak hold spectrum.

Fitur ini berguna untuk diagnosis dan post-flight analysis, tetapi file besar tidak boleh masuk queue telemetry atau dikirim melalui T900 secara otomatis.

---

## 8. Endpoint dan Interface

| Interface | Peran | Status live / catatan |
|---|---|---|
| `:8080/` | Dash web UI | HTTP 200 pada check terakhir |
| `:8081/settings.json` | settings snapshot | HTTP 200; jangan publish mentah |
| `:8081/status.json` | health/status snapshot | HTTP 200; sumber health sementara |
| `:8081/DOA_value.html` | CSV DoA + angular array | HTTP 200; freshness harus digate |
| `:8081/doa.xml` | XML DoA ringkas | HTTP 200; freshness/authority belum lulus |
| `:8081/logs/...` | log diagnosis | bukan kontrak telemetry |
| `:8042/settings` GET | membaca settings dari middleware | tersedia; belum ada auth/schema gate |
| `:8042/settings` POST | menulis seluruh settings | state-changing; jangan diekspos tanpa ACL |
| `:8042/doapost` POST | menerima record DoA dari processor | internal middleware path |
| `:8042/prpost` POST | menerima record passive-radar/processing lain | internal middleware path |
| `:8021` WebSocket | client lokal atau remote mode | bukan jalur T900 default |
| `:5000` | remote IQ stream | interface internal raw IQ; tidak terlihat listen pada probe live terakhir |
| `:5001` | remote DAQ control | interface internal control; terlihat listen pada probe live terakhir |

Port `5000/5001` adalah surface mode `eth` pada source. Instalasi Raspberry yang dipelajari menggunakan `shmem`, sehingga keberadaan port remote tersebut bukan syarat jalur data lokal.

### 8.1 Sifat keamanan middleware

Source Node middleware menggunakan CORS dan handler Express langsung. Pada handler settings yang dipelajari tidak terlihat autentikasi, authorization, atau schema/range validation yang memadai. Endpoint POST dapat menulis JSON baru ke file settings dan memberi flag external update.

Implikasi:

```text
port 8042 tidak boleh dianggap API aman hanya karena tersedia
POST settings harus dibatasi ke localhost atau ACL khusus
Controller harus memakai allowlist field dan range validation
credential-like fields tidak boleh masuk log/payload
perubahan harus read-back dan diverifikasi
```

Mode WebSocket remote source juga menggunakan konfigurasi koneksi yang tidak boleh dijadikan baseline security produksi tanpa hardening TLS, authentication, dan certificate verification.

---

## 9. Kemampuan Fungsional

### 9.1 Kemampuan yang terbukti dari source

SDR-DoA dapat:

- menerima IQ koheren dari DAQ lokal atau DAQ remote;
- mengontrol center frequency dan gain/AGC;
- menampilkan frame index, sync, gain, bandwidth, dan status DAQ;
- menghitung frequency spectrum dan waterfall;
- memilih serta men-tune VFO;
- memakai bandwidth dan squelch per VFO;
- menghitung DoA dengan enam estimator utama;
- memakai ULA, UCA, VULA, atau array custom;
- menerapkan metode decorrelation tertentu;
- menghitung confidence, power, SNR, latency, correlated-source count;
- mengubah orientasi visual/compass dengan offset;
- membaca GPS melalui gpsd bila dependency dan hardware tersedia;
- memakai heading tetap atau heading dari gerak GPS sesuai konfigurasi;
- mengeluarkan CSV, XML, dan JSON internal;
- menyimpan FM WAV, IQ, serta data record lokal;
- menerima perubahan settings melalui watcher file;
- menjalankan reconfiguration DAQ dari UI;
- start/stop processing;
- melakukan restart software/system dan clear cache melalui fungsi system-control yang gated UI;
- meneruskan hasil ke client WebSocket atau mapping integration bila fitur tersebut diaktifkan.

### 9.2 Fitur yang bukan prioritas T900

Fitur berikut berguna di LAN atau saat post-processing, tetapi tidak boleh diteruskan rutin melalui link bandwidth rendah:

```text
raw IQ
full waterfall
full frequency spectrum
360 angular values setiap frame
FM audio stream
IQ/WAV recording
screen mirroring
remote desktop
file transfer besar
full settings JSON
```

---

## 10. Perbandingan Upstream dan Runtime Raspberry

| Aspek | Ekspektasi source | Observasi live Raspberry |
|---|---|---|
| Source provenance | repository dapat dijalankan pada commit checkout | Git HEAD remote sama: `2e1c4e6...` |
| Runtime version | source mendeklarasikan `1.8.1` | `status.json` melaporkan `1.8.1` |
| Data interface | `shmem` atau `eth` | `shmem` |
| DAQ chain | native DAQ + rebuffer + decimate | process `_daq_core/rtl_daq.out`, `rebuffer.out`, `decimate.out` terlihat |
| UI | Python Dash pada 8080 | `python3 _ui/_web_interface/app.py`, port 8080 listen |
| Data Out | file share pada 8081 | PHP static server `-t _share`, port 8081 listen |
| Middleware | HTTP 8042 + WS 8021 | Node process terlihat; kedua port listen |
| settings | file dibaca watcher | `/settings` dan `settings.json` HTTP 200 |
| status | file live diperbarui processor | `timestamp_ms` berubah |
| DAQ health | sync/frame gate harus valid | `daq_ok=false`, `daq_status={}` |
| drop counter | counter bertambah bila frame hilang | counter terbaca `3021` pada check terakhir dan sebelumnya meningkat |
| DoA output | ditulis saat hasil DoA valid | file tersedia tetapi mtime/hash tidak berubah pada sampling sebelumnya |
| service | launcher start/stop chain | unit active/enabled, tetapi ini bukan bukti data path sehat |
| remote-control file server | optional dan gated setting/tool | setting `en_remote_control=false`; mode static aktif |

### 10.1 Diagnosis saat studi

Kesimpulan runtime yang didukung bukti:

```text
software dan launcher : hidup
UI/Data Out           : hidup
middleware            : hidup/listen
status producer       : live-updated
DAQ data path         : belum sehat
DoA snapshot          : belum terbukti live/authoritative
```

Jangan mengganti diagnosis tersebut menjadi `ONLINE` hanya karena `curl` memperoleh HTTP 200.

---

## 11. Relevansi terhadap Telemetry T900

### 11.1 Boundary yang disarankan

```text
SDR-DoA local output
        │
        ▼
Read-only adapter / UAV Controller
  ├── parse status
  ├── parse candidate DoA source
  ├── freshness + authority gate
  ├── unit/orientation normalization
  ├── source timestamp + sequence internal
  ├── health classification
  ├── compact schema
  └── latest-value-wins queue
        │
        ▼
MQTT client/broker lokal
        │
        ▼
PPP 10.90.0.2 → T900 → PPP 10.90.0.1
        │
        ▼
Ground consumer/backend
```

Controller tidak boleh membuat Ground bergantung pada extension file atau struktur internal upstream.

### 11.2 Mapping minimal yang disarankan

Setelah sumber DoA authoritative terbukti, payload DoA dapat memuat:

```text
schema_version
sequence
timestamp_ms
relative_doa_canonical
confidence_normalized
power_or_rssi
frequency_hz
processing_latency_ms
source_format
```

Payload health terpisah:

```text
timestamp_ms
daq_ok
frame_sync
iq_sync
sample_delay_sync
dropped_frames
status_age_ms
doA_age_ms
software_version
link_state
```

Navigation terpisah:

```text
latitude
longitude
altitude
heading
heading_source
mounting_offset
```

`bearing` global hanya boleh diisi jika:

```text
heading tervalidasi
mounting offset tervalidasi
konvensi sudut tervalidasi
timestamp nav dan DoA dapat dikorelasikan
```

Simpan relative DoA dan input heading secara terpisah agar hasil dapat diaudit.

### 11.3 Policy bandwidth

Policy project tetap berlaku:

```text
continuous application : 8–10 kbit/s
short burst             : 12–15 kbit/s
clean bench ceiling     : 18 kbit/s, bukan budget operasi
```

Jadwal awal yang sesuai:

```text
DoA compact       : 2 Hz
navigation        : 1 Hz
health            : 0.5–1 Hz
state             : event/startup + retained
spectrum          : OFF, on-demand setelah downsample/quantize
```

Jangan mengirim CSV native 377 field atau JSON internal dengan `doaArray` penuh pada setiap frame.

---

## 12. Gap dan Risiko yang Harus Ditutup

### Data/health

- DAQ saat ini `daq_ok=false`.
- `daq_status` kosong pada snapshot live.
- dropped frames bertambah.
- file DoA tidak terbukti live pada sampling sebelumnya.
- tidak ada sequence number eksplisit pada CSV/XML.
- CSV dan XML mempunyai konvensi sudut berbeda.
- confidence native adalah metrik PAPR-like dB; XML menulis `PAPR_dB * 100`, bukan probabilitas.
- power/RSSI antarformat memakai skala/transformasi berbeda dan belum boleh dipetakan ke contract tanpa kalibrasi.

### API/security

- `settings.json` berisi banyak key dan setidaknya satu field credential-like.
- middleware settings POST menulis full document.
- handler source belum menjadi contract versioned dengan schema validation.
- port internal tidak boleh diekspos langsung ke T900.
- CORS dan remote WebSocket memerlukan hardening.

### Reliability

- `Type=oneshot + RemainAfterExit` dapat menyamarkan child process mati.
- watchdog hanya menguji UI root.
- start script menjalankan child process background.
- belum ada adapter telemetry dengan queue/drop policy.
- belum ada test MQTT wire bytes dan reconnect/backlog.
- belum ada long-duration atau moving/flight validation.

### Operasional

- JIT Numba dapat membuat first start 1–2 menit.
- beban CPU, USB, daya, thermal, dan storage memengaruhi frame loss.
- perubahan frekuensi/gain dapat memicu reconfiguration dan jeda output.
- GPS disabled pada snapshot saat ini.
- `station_id` masih baseline `NOCALL`; identity produksi belum ditetapkan.

---

## 13. Acceptance Gate Sebelum Adapter Live

```text
[ ] Commit/runtime provenance diselesaikan; fallback hash tidak dianggap bukti
[ ] lima kanal receiver/frame DATA valid secara berkelanjutan
[ ] frame sync, IQ sync, dan sample-delay sync true
[ ] daq_ok true selama test durasi target
[ ] dropped-frame slope dipahami dan berada dalam batas
[ ] DoA_value.html berubah mengikuti stimulus RF terkontrol
[ ] doa.xml berubah mengikuti stimulus RF terkontrol
[ ] authority source CSV/XML/middleware ditetapkan
[ ] konvensi sudut canonical ditetapkan
[ ] confidence dan power dinormalisasi
[ ] timestamp dan age check diuji
[ ] settings collector melakukan redaction
[ ] tidak ada raw IQ/array penuh pada payload rutin
[ ] port internal tidak diekspos sebagai API publik T900
[ ] schema adapter memiliki malformed-input tests
[ ] MQTT bytes, latency, loss, reconnect, dan queue diukur
[ ] watchdog mengerti UI liveness versus DAQ data health
[ ] command memakai allowlist, range validation, deduplication, ACK, read-back
[ ] long-duration bench test lulus sebelum moving/flight test
```

---

## 14. Rekomendasi Urutan Implementasi

1. Perbaiki dan validasi DAQ sampai `daq_ok=true`.
2. Ukur perubahan `status.json`, `DOA_value.html`, dan `doa.xml` dengan stimulus RF terkontrol.
3. Tentukan source DoA authoritative dan canonical angle convention.
4. Buat adapter read-only lokal dengan redaction, timeout, age, dan schema validation.
5. Buat fixture dari record valid, stale, malformed, dan conflicting CSV/XML.
6. Uji compact payload synthetic di 8–10 kbit/s selama minimal 60 detik.
7. Implementasikan MQTT lokal dengan bounded latest-value-wins queue.
8. Uji MQTT dua arah melalui PPP/T900 dan ukur wire traffic aktual.
9. Integrasikan DoA nyata setelah authority gate lulus.
10. Tambahkan health dan navigation terpisah.
11. Tambahkan command/ACK hanya setelah settings path diamankan.
12. Tambahkan spectrum on-demand sebagai fitur terakhir.
13. Perbarui watchdog untuk membedakan UI, DAQ, DoA freshness, PPP, dan MQTT.
14. Jalankan long-duration, static LOS, moving, lalu flight gate terpisah.

---

## Kesimpulan

Software upstream yang berjalan di Raspberry adalah pipeline DSP lengkap untuk receiver koheren multi-kanal. Ia memisahkan DAQ dan DSP, mendukung mode lokal shared memory maupun remote Ethernet, menghitung spectrum/VFO/squelch/DoA, menyediakan beberapa algoritma dan geometri array, serta menulis output CSV/XML/JSON dan status runtime.

Instalasi Raspberry cocok dijadikan node UAV karena pemrosesan dapat dilakukan lokal sebelum data melewati T900. Tetapi kondisi live yang terukur sekarang belum memenuhi syarat untuk menerbitkan DoA sebagai telemetry authoritative:

```text
service aktif       ≠ DAQ sehat
HTTP 200             ≠ DoA fresh
file tersedia       ≠ source authoritative
DoA/confidence/PWR  ≠ unit sudah seragam
```

Maka desain backend yang benar adalah **SDR-DoA lokal → adapter tervalidasi → payload compact → MQTT/PPP/T900**, bukan meneruskan port internal, raw IQ, file native, atau seluruh Web UI ke Ground.
