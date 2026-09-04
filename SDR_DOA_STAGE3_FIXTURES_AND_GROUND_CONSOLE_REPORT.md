# Laporan Tahap 3 — Fixture, Schema Gate, dan Ground Console

## 1. Status tahap

```text
Tahap       : 3
Scope       : staging lokal
Fixture     : selesai
Schema gate : selesai untuk skenario awal
Ground GUI  : tersedia di localhost
MQTT        : monitor synthetic subscriber-only tersedia
Remote write: tidak ada
Remote POST : tidak ada
Raspberry   : tidak diubah
Broken pipe : ditangani graceful pada disconnect HTTP client
Status      : selesai untuk staging lokal + regression fix console lokal

Ground Console capability terakhir:

```json
{"read_only":true,"mqtt_monitor":true,"mqtt_publish":false,"remote_post":false,"config_apply":false}
```
```

Tahap ini belum merupakan Ground Station production. Ground Console yang dibuat hanya membaca Data Out secara terbatas dan menampilkan preview perubahan settings. Ia belum mengirim telemetry, belum mengubah settings, dan belum menjalankan command pada Raspberry.

---

## 2. Artefak yang dibuat

```text
tools/sdr_doa_collector.py
tools/test_sdr_doa_collector.py
tools/ground_console.py
tools/test_stage3.py
```

Fixture lokal:

```text
tools/fixtures/valid/
tools/fixtures/stale/
tools/fixtures/unhealthy/
tools/fixtures/malformed/
tools/fixtures/nonfinite/
tools/fixtures/missing-status/
tools/fixtures/conflict/
tools/fixtures/partial/
```

Laporan terkait:

```text
SDR_DOA_LIVE_STAGE1_BASELINE.md
SDR_DOA_STAGE2_COLLECTOR_REPORT.md
SDR_DOA_STAGE3_FIXTURES_AND_GROUND_CONSOLE_REPORT.md
```

---

## 3. Skenario fixture

| Fixture | Tujuan | Expected behavior |
|---|---|---|
| `valid` | status, CSV, XML, dan settings valid | data ter-parse; publication tetap diblokir bila authority/angle belum dikonfigurasi |
| `stale` | timestamp DoA lebih lama dari timestamp status node | DoA ditandai stale dan tidak dipublish |
| `unhealthy` | output ada tetapi DAQ gagal | state degraded; publication diblokir |
| `malformed` | JSON/CSV/XML rusak atau field kurang | resource ditolak sebagai invalid |
| `nonfinite` | nilai `NaN`/infinite | angka ditolak; tidak boleh masuk payload |
| `missing-status` | status utama tidak tersedia | health gate unavailable; publication diblokir |
| `conflict` | CSV dan XML memiliki DoA berbeda pada timestamp yang sama | native views di-quarantine sebagai conflict |
| `partial` | isi output terpotong seperti snapshot non-atomic | parser menolak record partial |

Collector juga menguji redaction settings. Field mentah tidak dikembalikan dan nilai sensitif fixture tidak muncul pada hasil collector.

---

## 4. Test yang dijalankan

Perintah:

```bash
cd /Users/mac/Documents/all-code/doa-sdr-telemetry
python3 -m py_compile \
  tools/sdr_doa_collector.py \
  tools/test_sdr_doa_collector.py \
  tools/ground_console.py \
  tools/test_stage3.py
python3 tools/test_sdr_doa_collector.py
python3 tools/test_stage3.py
```

Hasil aktual:

```text
5 collector tests passed
7 stage-3 tests passed
```

Skenario yang lulus antara lain:

```text
valid parsing and gate
stale timestamp against node status
unhealthy DAQ
malformed/nonfinite/partial/missing status
CSV/XML native-view conflict
settings redaction
control dry-run validation
Ground Console HTTP smoke test
base URL allowlist
```

---

## 5. Ground Console

### 5.1 Menjalankan console

```bash
cd /Users/mac/Documents/all-code/doa-sdr-telemetry
python3 tools/ground_console.py \
  --base-url http://doasdr.local:8081 \
  --bind 127.0.0.1 \
  --port 8787
```

URL lokal:

```text
http://127.0.0.1:8787/
```

Console staging saat laporan ini dibuat sedang berjalan di loopback komputer Ground. Ia tidak diekspos ke jaringan lain karena bind address `127.0.0.1`.

### 5.2 Panel display

Console menampilkan:

```text
Overall state
DAQ health
DoA candidate age
Dropped frames
CSV/XML candidate
Publication gate
Gate reasons
Frame sync
Sample-delay sync
IQ sync
Station ID
Software version/hash
GPS status
Uptime
Safe reported settings
```

Raw settings dan angular array penuh tidak ditampilkan oleh console.

### 5.3 Panel control

Panel control saat ini bersifat **dry-run only**. Field yang boleh dipreview:

```text
center_frequency_hz
gain_db
vfo_frequency_hz
vfo_bandwidth_hz
vfo_squelch_db
base_config_rev
```

Endpoint control lokal:

```text
POST /api/dry-run/config-patch
```

Endpoint ini hanya melakukan:

```text
parse JSON
allowlist check
finite-number check
range check
membuat command preview
```

Endpoint ini tidak melakukan:

```text
MQTT publish
HTTP POST ke Raspberry
menulis settings.json
SSH
mengubah service
mengubah DAQ
```

Hasil dry-run yang terverifikasi:

```json
{
  "dry_run": true,
  "transport": "none",
  "applied": false,
  "ok": true,
  "validation": "passed"
}
```

### 5.4 Endpoint console

```text
GET  /
GET  /api/snapshot
GET  /api/capabilities
POST /api/dry-run/config-patch
```

`/api/snapshot` hanya mengakses endpoint Data Out yang sudah diizinkan. Target `base_url` dibatasi ke:

```text
localhost
127.0.0.0/8
10.90.0.0/24
192.168.100.0/24
doasdr.local
```

Console menolak target sembarang agar tidak berubah menjadi open proxy.

---

## 6. Hasil smoke test terhadap node live

Ground Console membaca:

```text
http://doasdr.local:8081
```

Hasil render live:

```text
overall state : DEGRADED
publication   : BLOCKED
DAQ health    : FAIL
```

Gate yang terlihat:

```text
GROUND_CLOCK_UNVERIFIED
DAQ_HEALTH_GATE_FAILED
DOA_CANDIDATES_STALE
CANONICAL_ANGLE_NOT_CONFIGURED
DOA_AUTHORITY_NOT_SELECTED
```

Status DAQ yang ditampilkan:

```text
daq_ok            : false
frame_sync        : true
sample-delay sync : false
IQ sync           : false
```

Console juga berhasil menampilkan:

```text
CSV candidate : parsed
XML candidate : parsed
settings      : redacted safe subset
raw settings  : tidak ditampilkan
```

Output DoA tetap tidak dipromosikan sebagai telemetry valid karena health, freshness, authority, dan canonical angle belum lulus.

---

## 7. Batasan yang masih berlaku

```text
[ ] DAQ diperbaiki sampai daq_ok=true
[ ] output DoA dibuktikan fresh dengan stimulus RF
[ ] authority DoA final dipilih
[ ] canonical angle convention ditetapkan
[✓] MQTT broker/consumer staging dibuat
[✓] synthetic MQTT loopback diuji
[ ] synthetic MQTT melalui PPP/T900 diuji
[ ] edge agent dipasang di Raspberry
[ ] config patch nyata diuji dengan ACK/read-back
```

Ground Console ini adalah alat observasi dan persiapan contract. Ia bukan bukti bahwa node sudah siap menerima command settings dari Ground.

---

## 8. Tahap berikutnya

Synthetic MQTT loopback sudah diselesaikan pada Tahap 4 dan dilaporkan di `SDR_DOA_STAGE4_SYNTHETIC_MQTT_REPORT.md`. Tahap yang masih pending:

```text
[ ] synthetic MQTT melalui PPP/T900
[ ] edge agent MQTT di Raspberry
[ ] collector nyata menjadi publisher setelah gate lulus
[ ] settings command nyata dengan ACK/read-back
```

Data DoA live tidak boleh dipublish selama `daq_ok=false`, output stale, atau authority belum ditetapkan.

Ground Console tetap dapat dijalankan dengan monitor MQTT subscriber-only untuk membantu inspeksi operator:

```bash
/usr/bin/python3 tools/ground_console.py \\
  --base-url http://doasdr.local:8081 \\
  --bind 127.0.0.1 \\
  --port 8787 \\
  --mqtt-host 127.0.0.1 \\
  --mqtt-port 18884
```

Control settings tetap dry-run sampai Tahap 6 disetujui dan diuji terpisah.
