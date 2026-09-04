# Laporan Tahap 4 — Synthetic MQTT dan Monitor Ground Console

## 1. Status dan batasan

```text
Tahap          : 4A–4E staging lokal
Broker         : Mosquitto loopback 127.0.0.1:18884
Broker produksi: tidak disentuh
Raspberry      : tidak dihubungkan ke MQTT
T900/PPP       : belum dipakai pada tahap ini
Data           : synthetic only
Ground Console : monitor subscribe-only + settings dry-run
Remote write   : tidak ada
Status         : 4A–4E selesai; 4F PPP/T900 masih pending

Ground Console staging tetap berjalan di `http://127.0.0.1:8787/` dengan monitor ke broker loopback.
```

Tahap ini memverifikasi contract dan transport MQTT menggunakan payload sintetis. Ini bukan bukti bahwa telemetry nyata sudah boleh dipublish; gate live Raspberry tetap gagal karena `daq_ok=false`, output DoA stale, dan authority belum ditetapkan.

## 2. Artefak

```text
tools/sdr_doa_mqtt.py
 tools/test_sdr_doa_mqtt.py
 tools/sdr_doa_mqtt_monitor.py
 tools/synthetic_mqtt_publisher.py
 tools/mqtt_stage4.conf
```

`tools/sdr_doa_mqtt.py` berisi topic contract, builder/validator payload, compact JSON, dan latest-value-wins queue. `tools/sdr_doa_mqtt_monitor.py` hanya subscribe dan mengumpulkan metrik; tidak memiliki fungsi publish.

## 3. Topic yang diuji

```text
sdr/v1/uav-01/telemetry/doa
sdr/v1/uav-01/telemetry/nav
sdr/v1/uav-01/telemetry/health
sdr/v1/uav-01/state
sdr/v1/uav-01/config/reported
sdr/v1/uav-01/cmd/config/patch
```

Policy yang diuji:

```text
DoA/nav/health       : QoS 0, tidak retained
state/config reported: QoS 1, retained
config patch         : QoS 1, tidak retained
```

Command tidak diproses oleh synthetic test sebagai command nyata; ia hanya dipublish ke broker staging untuk memverifikasi flag transport.

## 4. Hasil test contract

```text
PASS test_payload_contracts_and_sizes
PASS test_invalid_contract_values_are_rejected
PASS test_latest_value_wins
PASS test_json_rejects_nonfinite
4 MQTT tests passed
```

Validasi mencakup:

- field wajib dan schema version;
- confidence, angle, frequency, dan range numeric;
- penolakan nilai non-finite;
- penolakan command field di luar allowlist;
- compact JSON;
- queue satu-slot latest-value-wins.

## 5. Hasil broker/QoS/reconnect

Broker staging dijalankan dengan:

```text
listener 18884 127.0.0.1
persistence false
```

Hasil integrasi:

```text
PASS test_local_broker_publish_subscribe_and_flags
5 MQTT tests passed
```

Yang terbukti:

- subscriber menerima DoA QoS 0;
- state diterima QoS 1;
- config patch diterima QoS 1 dan tidak retained;
- state retained diterima oleh subscriber baru setelah reconnect;
- command tidak muncul sebagai retained message;
- semua publish return code `0` pada broker staging.

## 6. Pengukuran payload realistis

Publisher reproducible:

```bash
cd /Users/mac/Documents/all-code/doa-sdr-telemetry
/usr/bin/python3 tools/synthetic_mqtt_publisher.py \
  --host 127.0.0.1 \
  --port 18884 \
  --duration 5 \
  --doa-rate 2 \
  --nav-rate 1 \
  --health-rate 1
```

Hasil aktual:

```text
messages             : 22
DoA                   : 10 messages / 1,900 bytes
navigation            : 5 messages / 635 bytes
health                : 5 messages / 1,010 bytes
state                 : 1 message  / 161 bytes
config/reported       : 1 message  / 153 bytes
payload total         : 3,859 bytes
payload total         : 30,872 bits
elapsed               : 5.000878 s
payload-only rate     : 6,173.316 bit/s
publish return codes  : [0]
state mode            : startup_once
```

Angka tersebut adalah payload-only. MQTT/TCP/IP/PPP/T900 overhead, retransmission, TLS, dan traffic lain belum masuk. Jadi ia tidak menggantikan pengukuran wire-rate.

Sebagai pembanding, ketika state dan config dikirim setiap siklus, pengukuran sebelumnya mencapai sekitar `16.5 kbit/s payload-only`. Ini mendukung keputusan bahwa state/config harus event-driven atau retained, bukan dikirim pada setiap frame DoA.

## 7. Monitor Ground Console

Ground Console berjalan lokal dengan:

```bash
/usr/bin/python3 tools/ground_console.py \
  --base-url http://doasdr.local:8081 \
  --bind 127.0.0.1 \
  --port 8787 \
  --mqtt-host 127.0.0.1 \
  --mqtt-port 18884
```

URL:

```text
http://127.0.0.1:8787/
```

Monitor MQTT pada console:

```text
subscriber-only : true
publish_enabled : false
```

Panel menampilkan:

- connection state;
- message count;
- valid/invalid count;
- total payload bytes;
- last topic;
- last latency berdasarkan `ts_ms`;
- age pesan terakhir;
- payload ringkas per kind;
- status retained dan QoS.

Smoke test browser berhasil menampilkan:

```text
MQTT             : CONNECTED
valid/received   : 2/2 sebelum batch baru
publish enabled  : false
```

Setelah batch realistis, endpoint monitor membaca semua lima kind sebagai payload valid. Timestamp synthetic dan receive timestamp pada batch yang sama menghasilkan latency monitor sekitar `2–4 ms` di loopback.

Panel Data Out tetap menampilkan kondisi node nyata secara terpisah:

```text
overall : DEGRADED atau UNAVAILABLE tergantung window HTTP
DAQ     : FAIL/UNKNOWN
DoA     : BLOCKED
```

Synthetic MQTT tidak boleh menutupi kondisi live node.

## 8. Batasan yang masih berlaku

```text
[ ] broker Ground production dengan authentication/ACL/TLS
[ ] synthetic MQTT melalui PPP/T900
[ ] edge agent MQTT di Raspberry
[ ] collector nyata menjadi publisher
[ ] wire-rate actual di PPP/T900
[ ] long-duration/reconnect RF test
[ ] DoA authority final
[ ] DAQ daq_ok=true
[ ] settings command nyata
```

### Hasil cek jalur PPP/T900

Cek read-only pada Ground Station saat ini menunjukkan:

```text
interface/route 10.90.0.x : tidak tersedia
ping 10.90.0.1         : timeout / 100% loss
TCP 10.90.0.1:1883     : timeout
TCP 10.90.0.1:18884    : timeout
```

Karena endpoint PPP Ground belum tersedia, synthetic MQTT melalui PPP/T900 **blocked**, bukan dianggap lulus. Tidak ada route, service, atau konfigurasi yang diubah.

Tahap berikutnya setelah endpoint PPP tersedia adalah mengulangi publisher synthetic dengan broker yang memang dapat dijangkau melalui `10.90.0.1`, lalu mengukur wire-rate, latency, loss, reconnect, dan queue. Setelah itu barulah collector nyata dapat dipertimbangkan sebagai publisher, tetap dengan health/freshness/authority gate.

Ground Console staging saat ini tetap dapat dipakai untuk inspeksi:

```text
http://127.0.0.1:8787/
```
