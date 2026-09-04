# Summary Project `doa-sdr-telemetry`

> **Update throughput/LAN:** `Dokumentasi_Throughput_T900_PPP_dan_Payload_SDR.md` dan `BACKEND_PAYLOAD_PLAN.md` menambahkan hasil bench payload. Baseline management terbaru dari user adalah `eth0 = 192.168.100.100/24` dengan akses `doasdr.local`; referensi lama `192.168.50.100` dipertahankan hanya sebagai histori.

## 1. Identitas Project

Project ini ditujukan untuk membangun sistem telemetry dan remote-control antara **SDR-DoA yang terbang bersama Drone/UAV** dan **Ground Station berbasis Linux**.

Folder project:

```text
/Users/mac/Documents/all-code/doa-sdr-telemetry
```

Summary ini dibuat dari delapan dokumen sumber yang disalin dari `/Users/mac/Downloads`. Dua dokumen T900 versi `v2` dan `v2(1)` mempunyai isi yang sama dan sengaja dipertahankan sebagai salinan dokumentasi asli. `SUMMARY.md`, `BACKEND_PAYLOAD_PLAN.md`, `SDR_DOA_8081_DATA_REFERENCE.md`, `SDR_DOA_UPSTREAM_ARCHITECTURE.md`, dan `SDR_DOA_DATA_ACCESS_AND_GUI_CUSTOMIZATION.md` adalah artefak sintesis project, bukan sumber historis.

Panduan akses data dan kustomisasi GUI:

```text
SDR_DOA_DATA_ACCESS_AND_GUI_CUSTOMIZATION.md
```

Dokumen tersebut memetakan endpoint/path data (`_share`, `:8081`, `:8042`, `:8021`), schema output, cara membaca dari LAN/PPP/SSH, serta file/folder GUI pada `_ui/_web_interface` yang relevan untuk perubahan tampilan, halaman, chart, callback, dan CSS.

Rancangan arsitektur telemetry dan kendali settings:

```text
SDR_DOA_TELEMETRY_ARCHITECTURE_AND_SETTINGS_CONTROL.md
```

Dokumen ini menetapkan edge agent di Raspberry, MQTT broker di Ground, topic/rate/QoS/retain, latest-value-wins, reconnect policy, serta alur `config_patch` Ground → Raspberry dengan allowlist, revision, expiry, ACK, dan read-back.

Baseline live dan collector read-only:

```text
SDR_DOA_LIVE_STAGE1_BASELINE.md
SDR_DOA_STAGE2_COLLECTOR_REPORT.md
tools/sdr_doa_collector.py
tools/test_sdr_doa_collector.py
```

Tahap 1 dan Tahap 2 sudah dijalankan tanpa perubahan remote. Collector membaca resource dengan HTTP `GET`, melakukan parsing terbatas, redaction settings, perbandingan timestamp node, serta publication gate. Hasil live terakhir tetap `DEGRADED/BLOCKED` karena `daq_ok=false`, sinkronisasi IQ/sample-delay gagal, dan output DoA stale.

Tahap 3 staging:

```text
SDR_DOA_STAGE3_FIXTURES_AND_GROUND_CONSOLE_REPORT.md
tools/ground_console.py
tools/test_stage3.py
tools/fixtures/
```

Fixture valid/stale/unhealthy/malformed/nonfinite/missing-status/conflict/partial dan Ground Console lokal sudah dibuat serta diuji. Console hanya read-only untuk data dan dry-run untuk settings; belum ada command nyata ke Raspberry.

Tahap 4 synthetic MQTT:

```text
SDR_DOA_STAGE4_SYNTHETIC_MQTT_REPORT.md
tools/sdr_doa_mqtt.py
tools/test_sdr_doa_mqtt.py
tools/sdr_doa_mqtt_monitor.py
tools/synthetic_mqtt_publisher.py
tools/mqtt_stage4.conf
```

Contract MQTT, broker loopback, QoS/retain, reconnect, latest-value-wins, pengukuran payload, dan panel monitor MQTT di Ground Console sudah diuji hanya dengan data synthetic. Broker produksi, Raspberry, T900, dan PPP tidak disentuh.

Implementasi LAN edge agent staging:

```text
SDR_DOA_LAN_AGENT_IMPLEMENTATION_REPORT.md
tools/sdr_doa_lan_agent.py
tools/sdr_doa_mqtt_stdlib.py
tools/test_sdr_doa_lan_agent.py
tools/test_sdr_doa_config_apply.py
tools/test_sdr_doa_mqtt_stdlib.py
```

Agent kontinu sudah diuji membaca Data Out melalui `192.168.100.100` dan publish ke broker staging loopback. Pada kondisi DAQ unhealthy, agent hanya menerbitkan health/state/config-reported; DoA tetap ditahan.

---

## Status Tahapan Implementasi

```text
[✓] Tahap 1 — live read-only baseline
[✓] Tahap 2 — collector read-only + health/freshness gate
[✓] Tahap 3 — fixtures/schema gate + Ground Console staging
[✓] Tahap 4A–4E — synthetic MQTT + monitor GUI loopback
[blocked] Tahap 4F — synthetic MQTT melalui PPP/T900 (interface/route Ground tidak tersedia)
[ ] Tahap 5 — telemetry nyata setelah authority gate lulus
[ ] Tahap 6 — settings command nyata + ACK/read-back
```

Tahap 4F belum dijalankan karena interface/route PPP `10.90.0.x` tidak tersedia pada probe Ground; ping/TCP ke endpoint PPP timeout. Tidak ada routing atau service yang diubah.

---

## Artefak Staging Ground Console

```text
URL lokal : http://127.0.0.1:8787/
Data Out  : http://doasdr.local:8081
MQTT test : 127.0.0.1:18884
Mode      : read-only + MQTT monitor subscriber-only + settings dry-run
```

Panel menampilkan overall/DAQ health, usia kandidat DoA, dropped frames, gate reasons, kandidat CSV/XML, safe settings, MQTT connection/messages/bytes/latency/topic, serta preview `config_patch` tanpa transport.

---

## 2. Dokumen Sumber yang Sudah Diarsipkan

| Dokumen | Fungsi utama |
|---|---|
| Arsip konfigurasi jaringan Raspberry | Network management Raspberry, Ethernet statis, WiFi DHCP, Avahi/mDNS |
| Arsip implementasi T900/PPP versi v2 | Hasil implementasi aktual T900 Transparent + PPP + ping + SSH |
| Arsip implementasi T900/PPP versi v2 — salinan | Salinan identik dokumen implementasi T900 v2 |
| Arsip instalasi SDR-DoA V1 Raspberry Debian 13 | Instalasi SDR-DoA V1 pada Debian 13 ARM64 |
| Arsip desain T900/PPP/MQTT | Rancangan arsitektur MQTT, Controller/Gateway, telemetry, dan command |
| Arsip service SDR/T900/PPP autostart | Udev alias, PPP systemd, SDR systemd, watchdog, dan boot validation |
| Arsip Raspberry headless remote desktop | Solusi remote desktop headless Raspberry dengan Xorg/RustDesk |
| Arsip throughput T900/PPP dan payload SDR | Hasil throughput aktual, budget bandwidth, format payload, rate, dan prioritas data |

Integritas arsip diverifikasi: seluruh 8 file sumber di project sama byte-per-byte dengan file sumbernya.

---

## 3. Arsitektur Sistem yang Dipilih

```text
                              UAV / DRONE

  Antenna Array
       │
       ▼
  SDR-DoA V1
       │ USB 3
       ▼
  Raspberry Pi ARM64
  ├── Heimdall DAQ
  ├── SDR-DoA/DSP
  ├── UAV Controller/Gateway
  ├── MQTT broker/client
  └── PPP 10.90.0.2
       │ USB serial
       ▼
  T900-UAV
       ))) RF 902–928 MHz (((
  T900-Ground
       │ USB serial
       ▼
  Linux Ground Endpoint
  ├── PPP 10.90.0.1
  ├── MQTT broker/client
  └── Ground Console / GUI / logger
```

Prinsip inti:

- SDR-DoA melakukan pemrosesan DoA di sisi UAV.
- T900 hanya dipakai sebagai **transparent wireless serial transport**.
- PPP membentuk network point-to-point Layer 3 di atas serial T900.
- MQTT membawa telemetry, state, command, dan ACK.
- Ground menggambar data sendiri; targetnya **data/state mirroring**, bukan screen mirroring.
- Raw IQ SDR-DoA tidak dikirim melalui T900.

Baseline bandwidth dari test terbaru: `18 kbit/s` adalah maximum tested clean ceiling pada bench test 30 detik, `20 kbit/s` mulai overload, dan budget continuous aplikasi ditetapkan `8–10 kbit/s`.

---

## 4. Konfigurasi T900 yang Terdokumentasi

Kedua unit T900 menggunakan parameter kompatibel:

```text
Mode/data       : Transparent / Pass-through
Baud rate       : 57600
Transmit power  : 500 mW baseline
ID              : 000000
RSSI            : ON
Frequency range : 902–928 MHz
```

Temuan penting:

- Mode MAVLink tidak meneruskan pengujian ASCII/custom data seperti yang dibutuhkan.
- Setelah dipindah ke Transparent mode, komunikasi serial dua arah berhasil.
- USB Type-C pada unit yang diuji terbukti dapat membawa payload serial; USB-to-TTL tidak wajib selama USB serial stabil.
- Baud UART dan RF transmit power adalah parameter berbeda.

---

## 5. Bukti Keberhasilan yang Tercatat

Dokumen implementasi T900 mencatat hasil bench test berikut:

- T900 pairing berhasil.
- Transparent serial UAV → Ground dan Ground → UAV berhasil.
- T900 terdeteksi sebagai CH341/CH340 USB serial di Raspberry dan macOS.
- `pppd` berhasil berjalan di kedua endpoint.
- Interface `ppp0` terbentuk di kedua sisi.
- IP point-to-point:
  - Ground: `10.90.0.1`
  - UAV/Raspberry: `10.90.0.2`
- Ping dua arah berhasil dengan **0% packet loss pada test awal**.
- Latency awal yang tercatat sekitar `~150 ms`.
- SSH ke Raspberry melalui link PPP berhasil.

Kesimpulan yang boleh diambil dari bukti tersebut:

```text
TCP over IP over PPP over T900 berhasil pada bench test awal.
```

Kesimpulan yang belum boleh dianggap terbukti hanya dari dokumen tersebut:

- kestabilan berjam-jam,
- recovery setelah RF interruption,
- throughput aplikasi aman,
- operasi saat UAV bergerak,
- performa pada jarak operasional,
- kesiapan penerbangan.

---

## 6. Baseline SDR-DoA di Raspberry Pi

Konfigurasi instalasi yang dicatat:

```text
OS              : Debian GNU/Linux 13 Trixie
Architecture    : aarch64 / ARM64
RAM             : sekitar 3.7 GiB
Swap            : 2.0 GiB
Conda env       : sdr
Python          : 3.9.7
SciPy           : 1.9.3
Numba           : 0.56.4
Project root    : /home/doasdr/doasdr
Web UI          : port 8080
Data Out        : port 8081
```

Komponen yang didokumentasikan berhasil dipasang/dibangun:

- SDR-DoA compatible `librtlsdr` fork.
- Blacklist driver DVB `dvb_usb_rtl28xxu`.
- Ne10 DSP untuk ARM64.
- Heimdall DAQ.
- `sdr_doa` V1.
- Dependency UI/DSP SDR-DoA.
- Lima receiver `RTL2838`.
- Tuner `R820T/2`.
- `sdr_test` streaming.
- Web UI `:8080` dan Data Out `:8081`.

Pitfall build penting:

```text
Heimdall DAQ versi tersebut harus dibuild dengan `make` serial.
Jangan menggunakan `make -j$(nproc)` karena dependency ordering Makefile
pernah menyebabkan linker mencari object file yang belum selesai dibuat.
```

Port `8081` adalah Data Out/shared HTTP server. Respons `Not Found` pada root `/` tidak otomatis berarti servicenya gagal; resource spesifik perlu diuji.

---

## 7. Desain Backend Telemetry yang Direncanakan

### UAV Controller/Gateway

Controller di Raspberry menjadi batas antara SDR-DoA dan jaringan telemetry:

```text
SDR-DoA API / output
        │
        ▼
UAV Controller
  ├── validasi command
  ├── timestamp
  ├── gabungkan GPS/heading
  ├── hitung global bearing
  ├── publish telemetry
  └── publish ACK/state
        │
        ▼
      MQTT → PPP → T900
```

Controller sebaiknya mengakses SDR-DoA melalui API lokal, bukan membuat Ground bergantung langsung pada format internalnya.

API SDR-DoA yang terdokumentasikan:

```text
GET  http://SDR_DOA_IP:8042/settings
POST http://SDR_DOA_IP:8042/settings
```

### Data yang dikirim

```text
DoA / bearing
RSSI / signal power
Confidence
Frequency
GPS
Heading
Altitude
SDR-DoA status
T900/link status
Raspberry health
Compact spectrum bila diminta
```

### Data yang tidak dikirim

```text
Raw IQ
Full-resolution waterfall
Video
Screen/RDP stream
Large file transfer
```

---

## 8. MQTT Topic dan QoS yang Direncanakan

Contoh topic UAV → Ground:

```text
sdr/telemetry/doa
sdr/telemetry/rssi
sdr/telemetry/confidence
sdr/telemetry/spectrum
sdr/state/frequency
sdr/state/gain
sdr/state/running
uav/gps
uav/heading
uav/altitude
system/uav/heartbeat
system/sdr/status
system/t900/link
```

Contoh topic Ground → UAV:

```text
sdr/cmd/set_frequency
sdr/cmd/set_gain
sdr/cmd/set_bandwidth
sdr/cmd/start
sdr/cmd/stop
sdr/cmd/restart
sdr/cmd/request_settings
```

ACK:

```text
sdr/ack/set_frequency
sdr/ack/set_gain
sdr/ack/start
sdr/ack/stop
sdr/ack/restart
```

Rekomendasi QoS:

| Kategori | Contoh | QoS |
|---|---|---:|
| Realtime | DoA, RSSI, GPS, heading, heartbeat | 0 |
| Command | frequency, gain, start/stop, restart | 1 |
| State | frequency, running, gain | 1 + retain |

Telemetry realtime perlu mempunyai timestamp dan aturan stale-data di Ground. Spectrum direncanakan compact, misalnya 256 power bins, default **OFF**, lalu diaktifkan on-demand sekitar 1–2 Hz agar tidak menghabiskan bandwidth T900.

Dua broker MQTT merupakan opsi yang direkomendasikan agar sisi UAV tetap dapat memproses dan menyimpan state lokal ketika RF/Ground terputus. Bridge hanya perlu meneruskan topic yang diperlukan, bukan seluruh `#`.

---

## 9. Auto-Start dan Recovery yang Didokumentasikan

Target boot Raspberry:

```text
Power on
  ├── T900 terdeteksi
  ├── /dev/t900 tersedia
  ├── PPP 10.90.0.2 start/retry
  ├── lima SDR terdeteksi
  ├── SDR-DoA start
  ├── UI :8080 dan Data Out :8081 aktif
  └── watchdog health check berjalan
```

Komponen service yang ditulis dalam dokumentasi:

```text
t900-ppp.service
sdr-doa.service
sdr-watchdog.service
sdr-watchdog.timer
```

Alias serial yang ditargetkan:

```text
/dev/t900
```

Udev rule contoh menggunakan VID/PID CH340/CH341:

```text
SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", ATTRS{idProduct}=="7523", ENV{ID_MM_DEVICE_IGNORE}="1", GROUP="dialout", MODE="0660", SYMLINK+="t900"
```

Catatan reliability: rule VID/PID saja perlu diperketat jika terdapat beberapa perangkat CH340/CH341 identik. Prioritas identitas sebaiknya serial unik, `/dev/serial/by-id`, `/dev/serial/by-path`, lalu alias custom yang mengikat port fisik.

Recovery PPP mengandalkan kombinasi:

```text
pppd persist
systemd Restart=always
LCP echo interval/failure
```

Dokumen service menandai komponen auto-start sebagai selesai, tetapi dokumen implementasi T900 v2 sebelumnya masih menandai persistent `/dev/t900` dan auto-start sebagai `NEXT`. Ini adalah **perbedaan status dokumentasi** dan harus divalidasi ulang melalui runtime Raspberry sebelum dianggap baseline final.

---

## 10. Network Management Raspberry

Konfigurasi management terbaru yang diberikan user:

```text
Hostname : doasdr
Username : doasdr

wlan0    : DHCP, connectivity/internet
eth0     : 192.168.100.100/24, management LAN
Gateway  : tidak ada pada eth0
DNS      : tidak ada pada eth0
```

Laptop/PC maintenance dapat memakai:

```text
192.168.100.10/24
```

Akses:

```bash
ssh doasdr@192.168.100.100
ssh doasdr@doasdr.local
```

Avahi/Bonjour/mDNS digunakan agar Raspberry dapat diakses melalui `doasdr.local`. IP statis tetap berguna sebagai jalur maintenance deterministik: `ssh doasdr@192.168.100.100`. Referensi dokumen lama ke `192.168.50.100` adalah baseline historis dan tidak dipakai untuk konfigurasi baru.

---

## 11. Throughput dan Strategi Payload

Bench test aktual menggunakan `iperf3` UDP reverse, payload datagram 256 byte, 30 detik per rate, dengan RTT idle rata-rata sekitar `154 ms`:

```text
10K → 0% loss
12K → 0% loss
15K → 0% loss
18K → 0% loss
20K → 11% loss
30K → 45% loss
40K → 63% loss
```

Karena MQTT berjalan di atas TCP/IP/PPP dan masih membutuhkan ruang untuk ACK, retransmission, command, serta degradasi RF, backend tidak boleh merancang operasi normal di 18K. Gunakan:

```text
continuous application : 8–10 kbit/s
short burst             : 12–15 kbit/s
spectrum                : OFF by default, on-demand
```

Payload awal sebaiknya compact JSON satu baris, ideal `80–150 byte/message` dan absolut `<200 byte/message`, kemudian baru dipertimbangkan MessagePack/CBOR setelah kontrak stabil. Jadwal konservatif:

```text
DoA + confidence + RSSI + frequency : 2 Hz
GPS/heading                          : 1 Hz
health/heartbeat                     : 0.5–1 Hz
state                                : event/startup + retained
ACK                                  : event-driven QoS 1
spectrum                             : OFF; on-demand 0.2–0.5 Hz
```

Realtime memakai QoS 0 dan latest-value-wins bounded queue; command/ACK memakai QoS 1, command ID, deduplication, validation, timeout, dan state read-back. Jangan replay history setelah reconnect. Kirim DoA, RSSI, confidence, frequency, navigation, health, state, command/ACK, dan optional spectrum yang sudah downsample/quantize; jangan kirim raw IQ, video, screen mirroring, atau full native 360-array di setiap frame.

---

## 12. Remote Maintenance Headless

Dokumentasi RustDesk menyimpulkan bahwa masalah `No Display` berasal dari output display headless yang tidak aktif, bukan semata-mata jaringan atau service.

Baseline yang dicatat:

```text
Display manager : LightDM
Display server  : Xorg/X11 :0
RustDesk        : 1.4.9
```

Kernel KMS parameter yang digunakan:

```text
video=HDMI-A-1:1920x1080M@60D
```

Management Ethernet statis tetap menjadi jalur recovery utama jika GUI/RustDesk bermasalah.

---

## 13. Studi Upstream Software SDR-DoA

Studi read-only terhadap source upstream dan instalasi Raspberry sudah dilakukan dan didokumentasikan di:

```text
SDR_DOA_UPSTREAM_ARCHITECTURE.md
```

Snapshot source yang dipelajari:

```text
commit : 2e1c4e6a918f649f62c1b7a5c4c98a8b1bdc7e59
date   : 2025-12-13T04:37:45+01:00
license: GPL-3.0
```

Temuan arsitektur utama:

```text
DAQ native → shared-memory double buffer/FIFO → ReceiverRTLSDR
           → IQ header 1024 byte → SignalProcessor thread
           → spectrum/VFO/squelch → DoA estimator
           → CSV/XML/status/middleware → Controller telemetry
```

Software mendukung dua mode data internal:

- `shmem` lokal pada host yang sama;
- Ethernet IQ streaming/control pada port internal `5000/5001` untuk DAQ remote.

Kemampuan source yang teridentifikasi meliputi spectrum/waterfall, hingga 16 VFO pada object processor, squelch, decimation, Bartlett/Capon/MEM/TNA/MUSIC/ROOT-MUSIC, ULA/UCA/VULA/custom array, decorrelation, GPSD, FM demod, IQ/WAV/data recording lokal, output CSV/XML/JSON, serta middleware HTTP/WebSocket.

Pencocokan runtime Raspberry pada probe read-only terakhir:

```text
Git HEAD remote      : sama dengan commit source yang dipelajari pada probe sebelumnya
software_git field   : 2e1c4e6 pada probe terakhir
runtime data         : data_interface=shmem
UI                   : 0.0.0.0:8080 listen
Data Out              : 0.0.0.0:8081 listen, PHP static server ke _share
middleware           : HTTP :8042 dan WebSocket :8021 listen
processes            : DAQ/UI/PHP/Node terlihat hidup
sdr-doa.service      : inactive saat probe terakhir
sdr-watchdog.timer   : inactive saat probe terakhir
```

Catatan penting: status unit systemd `inactive` tidak otomatis membuktikan semua child process mati, karena launcher menggunakan `Type=oneshot` + `RemainAfterExit`; sebaliknya proses yang terlihat hidup juga tidak membuktikan unit supervision atau DAQ sehat.

Caveat live yang wajib menjadi gate backend:

```text
status.json berubah pada window sampling
DAQ: daq_ok=false; frame_sync=true; sample_delay_sync=false; iq_sync=false
DoA_value.html dan doa.xml tidak berubah pada window sampling
snapshot DoA tertinggal sekitar 58 menit terhadap status timestamp node pada probe terakhir
service/process/HTTP 200 tidak sama dengan DAQ sehat atau DoA fresh
```

Probe collector staging sesudahnya memakai perbandingan timestamp DoA terhadap `status.json` node untuk menghindari bias jam Ground; publication gate tetap BLOCKED.

Output native tidak langsung menjadi kontrak telemetry. Controller UAV tetap harus melakukan source-authority check, freshness/age check, normalisasi unit dan konvensi sudut, redaction, sequence, schema validation, latest-value-wins queue, serta compact encoding sebelum MQTT/PPP/T900.

Dokumen studi tidak menyebut atau mengubah nama arsip sumber historis; delapan arsip lama tetap byte-identik.

---

## 14. Status Keseluruhan Berdasarkan Dokumen

### Sudah tercatat berhasil pada dokumentasi

- T900 pairing dan Transparent mode.
- Serial dua arah.
- PPP dua sisi.
- IP `10.90.0.1 ↔ 10.90.0.2`.
- Ping awal 0% packet loss.
- SSH melalui PPP.
- Instalasi/build SDR-DoA V1 pada Raspberry ARM64.
- Lima receiver RTL2838 terdeteksi.
- SDR-DoA UI/Data Out lokal.
- Konfigurasi network management Raspberry.
- Pola service/watchdog untuk auto-start.
- Solusi RustDesk headless.
- Throughput bench dan payload budget terdokumentasi.

### Masih perlu dianggap belum tervalidasi untuk backend/operasional

- MQTT broker dan transport MQTT melalui PPP.
- UAV Controller/Gateway nyata.
- Publish DoA telemetry.
- Ground subscriber/GUI/logger.
- Command, validation, ACK/NACK, dan state read-back.
- SDR-DoA settings melalui Controller.
- Spectrum compact on-demand.
- GPS/heading fusion dan global bearing pada runtime.
- Persistent serial alias setelah seluruh variasi reconnect/reboot.
- PPP recovery setelah RF interruption.
- Throughput/latency envelope dan queue behavior.
- Long-duration test.
- Static LOS, moving test, dan flight test.
- Security MQTT authentication/ACL dan command authorization.

---

## 15. Urutan Implementasi Backend yang Disarankan

```text
1. Bekukan baseline dan rapikan status dokumentasi
2. Validasi persistent /dev/t900 di runtime
3. Validasi PPP auto-start dan recovery
4. Ulangi test aplikasi-like `8K`/`10K` minimal 60 detik sambil mengamati ping
5. Jalankan MQTT lokal dengan fixture/synthetic telemetry
6. Jalankan MQTT dua arah melalui PPP dan ukur wire bytes aktual
7. Implementasikan UAV Controller dengan schema validation
8. Integrasikan read-only SDR-DoA settings/status
9. Tambahkan command + ACK + state read-back
10. Tambahkan DoA/RSSI/confidence telemetry
11. Tambahkan GPS/heading/global bearing
12. Tambahkan compact spectrum on-demand
13. Buat Ground Console dan data logger
14. Long-duration bench test
15. Static LOS dan moving test
16. Flight test setelah seluruh gate bench terpenuhi
```

Jangan menggabungkan semua subsistem sekaligus. Setiap tahap harus mempunyai health check dan log yang dapat dibaca.

---

## 16. Acceptance Criteria Backend Minimum

Sebelum sistem dianggap siap dipasang untuk penerbangan, minimal harus terbukti:

```text
[ ] T900 transparent serial stabil dua arah
[ ] PPP auto-start tanpa command manual
[ ] PPP reconnect setelah reboot/T900 restart
[ ] PPP recovery setelah RF interruption
[ ] Throughput aplikasi aman dengan headroom
[ ] MQTT QoS 0 telemetry bekerja
[ ] MQTT QoS 1 command bekerja
[ ] Timestamp dan stale-data handling bekerja
[ ] UAV Controller memvalidasi input malformed/out-of-range
[ ] ACK sesuai state aktual SDR-DoA, bukan sekadar publish sukses
[ ] Tidak ada backlog besar setelah link drop
[ ] DoA/RSSI/confidence tampil di Ground
[ ] GPS/heading/global bearing tervalidasi
[ ] Spectrum hanya dikirim on-demand dan compact
[ ] SDR-DoA tetap processing ketika Ground offline
[ ] Logging dan health monitoring tersedia
[ ] Auto-start tervalidasi setelah cold boot
[ ] Long-duration dan RF/moving test lulus
[ ] Flight test disetujui setelah review keselamatan terpisah
```

---

## 17. Kesimpulan

Fondasi sistem sudah kuat pada level hardware/link dan instalasi SDR-DoA lokal:

```text
SDR-DoA V1 → Raspberry Pi → T900 Transparent → PPP
```

sudah terdokumentasi berhasil untuk bench test awal dengan konektivitas IP dan SSH. Backend yang akan dibangun sebaiknya mempertahankan pemrosesan di UAV, mengirim hanya data hasil olahan, dan memakai MQTT sebagai kontrak telemetry/command di atas PPP.

Prioritas berikutnya bukan membuat Ground mengakses seluruh Web UI SDR-DoA, melainkan membangun **UAV Controller + MQTT contract + Ground data consumer** yang hemat bandwidth, dapat reconnect, memiliki timestamp/stale state, memvalidasi command, dan mengonfirmasi perubahan melalui state aktual SDR-DoA. Detail format payload, rate, queue, dan adaptive policy ada di `BACKEND_PAYLOAD_PLAN.md`.

Dokumen ini menggabungkan hasil studi dokumentasi dengan live read-only checks pada Raspberry. Ia bukan bukti bahwa backend MQTT/Controller/Ground Consumer sudah diimplementasikan atau bahwa sistem sudah siap penerbangan.
