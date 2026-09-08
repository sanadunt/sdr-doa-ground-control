# Laporan Tahap 2 — Collector Read-only SDR-DoA

## 1. Status

```text
Tahap       : 2
Scope       : staging lokal + probe HTTP GET ke node
MQTT        : belum digunakan
Remote write: tidak ada
Remote POST : tidak ada
Status      : selesai untuk collector read-only awal
```

Collector ini belum dipasang sebagai service di Raspberry dan belum menjadi edge agent production. Ia hanya membaca resource Data Out yang sudah tersedia, melakukan parsing terbatas, menghitung freshness, dan menghasilkan keputusan gate.

## 2. Artefak

```text
tools/sdr_doa_collector.py
 tools/test_sdr_doa_collector.py
```

Path project:

```text
/Users/mac/Documents/all-code/doa-sdr-telemetry/tools/sdr_doa_collector.py
/Users/mac/Documents/all-code/doa-sdr-telemetry/tools/test_sdr_doa_collector.py
```

## 3. Resource yang dibaca

Collector hanya melakukan HTTP `GET` terhadap path yang sudah diketahui:

```text
/status.json
/settings.json
/DOA_value.html
/doa.xml
```

Contoh penggunaan dari Ground atau staging:

```bash
cd /Users/mac/Documents/all-code/doa-sdr-telemetry
python3 tools/sdr_doa_collector.py \
  --base-url http://doasdr.local:8081
```

Mode default:

```text
authority    : none
clock source : remote_unverified
MQTT publish : false
```

Untuk agent yang nanti berjalan langsung di Raspberry, `--clock-source local` dapat dipakai agar umur `status.json` dibandingkan terhadap jam node. Saat dijalankan dari Ground, jam Ground dan Raspberry harus dianggap belum sinkron; collector membandingkan timestamp DoA terhadap timestamp `status.json` node yang sama, tetapi tidak mengklaim freshness status berdasarkan jam Ground.

## 4. Perlindungan yang sudah ada

Collector:

- hanya memakai HTTP `GET`;
- memiliki timeout dan batas ukuran body;
- memvalidasi JSON, CSV, XML, angka finite, dan field wajib;
- mengharuskan CSV memiliki 377 field;
- mengharuskan 360 angular bins pada CSV;
- memisahkan nilai DoA raw dan canonical;
- belum memilih authority CSV/XML secara default;
- selalu menahan publication jika canonical angle belum dikonfigurasi;
- menghilangkan raw settings dari hasil keluaran;
- hanya mempertahankan safe settings subset;
- menghilangkan raw angular array dari payload edge/MQTT; Ground Console boleh
  memakai vektor CSV dB shifted yang dipertahankan apa adanya untuk plot polar
  lokal saja;
- tidak memiliki MQTT client;
- tidak memiliki jalur write, POST, SSH command, atau settings update.

## 5. Gate yang dihasilkan

Keputusan gate yang mungkin:

```text
READY       semua gate lulus
BLOCKED     ada gate yang belum lulus
DEGRADED    proses/data health bermasalah
STALE       timestamp sumber terlalu lama
INVALID     body tidak sesuai schema
UNAVAILABLE resource tidak dapat dibaca
UNVERIFIED  data ada tetapi authority/konvensi belum terbukti
```

Gate DoA minimal:

```text
status tersedia
status freshness diketahui
DAQ sehat
DoA ter-parse
DoA fresh
authority dipilih
canonical angle siap
```

## 6. Hasil eksekusi live terbaru

Probe dilakukan terhadap:

```text
http://doasdr.local:8081
```

Hasil ringkas:

```text
HTTP resource       : tersedia
status.json         : ter-parse
settings.json       : ter-parse dan redacted
DOA_value.html      : ter-parse, 377 field, 360 angular bins
doa.xml             : ter-parse
```

Status node yang terbaca:

```text
daq_ok              : false
daq health          : FAIL
failed sync flags   : sample_delay_sync, iq_sync
frame_sync          : true
dropped frames      : 0 pada probe terakhir
GPS                 : Disabled
```

Settings safe subset yang terbaca:

```text
data_interface     : shmem
center_freq         : 415.7882 MHz
uniform_gain        : 15.7
array               : UCA
DoA method          : MUSIC
active_vfos         : 1
output_vfo          : 0
remote control      : false
location source     : Static
```

Kandidat DoA:

```text
CSV DoA raw         : 149.0°
XML DoA raw         : 211.0°
CSV fields          : 377
angular bins        : 360
```

Timestamp DoA pada kedua output:

```text
1788265232442
```

Timestamp status node pada probe terakhir:

```text
1788268720483
```

Umur relatif terhadap timestamp status node:

```text
3,488,041 ms ≈ 58 menit 8 detik
```

Kedua output DoA tidak berubah pada window sampling. Karena itu keduanya diperlakukan sebagai kandidat stale, bukan telemetry realtime.

## 7. Keputusan publication

Hasil collector live:

```text
overall state    : DEGRADED
publication      : BLOCKED
```

Alasan:

```text
GROUND_CLOCK_UNVERIFIED
DAQ_HEALTH_GATE_FAILED
DOA_CANDIDATES_STALE
CANONICAL_ANGLE_NOT_CONFIGURED
DOA_AUTHORITY_NOT_SELECTED
```

Walaupun `authority=csv` atau `authority=xml` dipilih secara eksplisit, collector tetap menahan publication karena canonical angle belum ditetapkan. Ini disengaja untuk mencegah data tampak valid hanya karena salah satu file dipilih.

## 8. Test lokal

Syntax check dan test standard-library berhasil:

```text
PASS test_valid_parsing_but_authority_blocked
PASS test_unhealthy_daq_blocks
PASS test_stale_doa_uses_node_status_reference
PASS test_malformed_csv_is_rejected
PASS test_authority_never_bypasses_angle_gate
5 tests passed
```

Test mencakup:

- parsing valid;
- redaction settings;
- DAQ unhealthy;
- DoA stale relatif terhadap timestamp status node;
- CSV malformed;
- authority yang dipilih tetapi canonical angle belum siap.

## 9. Batasan dan langkah berikutnya

Collector ini belum:

```text
[ ] memilih authority DoA final
[ ] menormalkan canonical bearing final
[ ] menerbitkan MQTT
[✓] memiliki fixture file di disk untuk skenario awal
[✓] menguji konflik CSV/XML dengan fixture bersamaan
[✓] menguji file partial/non-atomic dengan fixture terpotong
[ ] menguji reconnect dan queue MQTT
[ ] dipasang ke Raspberry sebagai service
```

Fixture dan schema validation diperluas pada Tahap 3 dan dilaporkan di `SDR_DOA_STAGE3_FIXTURES_AND_GROUND_CONSOLE_REPORT.md`. Tahap berikutnya adalah synthetic MQTT test. Tidak ada data DoA nyata yang boleh dipublish sebelum DAQ, freshness, authority, unit, dan angle convention lulus.
