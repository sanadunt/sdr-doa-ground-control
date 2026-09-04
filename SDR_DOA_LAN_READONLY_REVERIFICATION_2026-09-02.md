# Verifikasi Ulang Read-only LAN SDR-DoA — 2026-09-02

## Status

```text
Scope             : read-only LAN verification
Target hostname   : doasdr.local
Target address    : 192.168.100.100
Data Out          : HTTP :8081
Remote mutation   : none
PPP/T900          : tidak diuji pada verifikasi ini
Deployment agent  : tidak dilakukan
```

## 1. Identitas dan jalur LAN

Probe DNS mengembalikan:

```text
('doasdr.local', [], ['192.168.100.100'])
```

Probe SSH key-based read-only mengembalikan:

```text
hostname : doasdr
eth0     : 192.168.100.100/24
```

Raspberry dapat membuka koneksi TCP ke broker Ground yang terdeteksi pada:

```text
192.168.100.173:1883 : open
```

Keterjangkauan port tersebut **bukan** bukti broker production aman. Authentication, ACL, TLS, dan topic isolation tetap belum terbukti.

## 2. Resource Data Out

Semua resource berikut merespons `HTTP 200` pada kedua alamat:

| Resource | `doasdr.local` | `192.168.100.100` | Kesimpulan |
|---|---:|---:|---|
| `/status.json` | 200 | 200 | tersedia |
| `/settings.json` | 200 | 200 | tersedia; tetap hanya dibaca dan tidak dipublish mentah |
| `/DOA_value.html` | 200 | 200 | tersedia sebagai kandidat |
| `/doa.xml` | 200 | 200 | tersedia sebagai kandidat |

Snapshot pengukuran:

```text
/status.json
  doasdr.local    : 654 bytes, sha256 prefix 765815afab8825be
  192.168.100.100 : 654 bytes, sha256 prefix 966fd70076841f70

/settings.json
  kedua alamat    : 4511 bytes, sha256 prefix 07d1ed0d077f6e6a

/DOA_value.html
  kedua alamat    : 2297 bytes, sha256 prefix 4ab674a6f94a55c2

/doa.xml
  kedua alamat    : 470 bytes, sha256 prefix 778d3bb509816128
```

Perbedaan hash `status.json` antar-request hostname/IP diharapkan karena timestamp status berubah. Settings dan dua kandidat DoA identik antar jalur.

## 3. Health dan timestamp

Dari `status.json`:

```text
timestamp_ms       : 1788286104270 / 1788286109187
 daq_ok            : false
gps_status          : Disabled
daq_num_dropped_frames : 0
frame_sync         : true
sample_delay_sync  : false
iq_sync            : false
```

Kandidat DoA masih menunjuk record:

```text
DoA timestamp_ms    : 1788274094142
CSV value           : 123.0 derajat (native candidate)
XML value           : dibaca dari record yang sama (native candidate)
```

Dengan referensi `status.json` `1788286109187`, umur record DoA terukur:

```text
age_ms      : 12015045
age_seconds : 12015.045
age_minutes : 200.25075
age_hours   : 3.3375125
```

Sampling ulang setelah sekitar dua detik menunjukkan hash berikut:

```text
status.json      : berubah
DOA_value.html   : 4ab674a6f94a55c2 (tidak berubah)
doa.xml          : 778d3bb509816128 (tidak berubah)
```

Keputusan:

```text
overall state : DEGRADED
DoA publish   : BLOCKED
```

`HTTP 200`, proses hidup, dan timestamp status yang berubah tidak boleh diperlakukan sebagai bukti DoA live atau DAQ sehat.

## 4. Proses, service, dan listener

Probe read-only terbaru menunjukkan service:

```text
sdr-doa.service    : active
sdr-watchdog.timer : active
t900-ppp.service    : active
```

Proses utama yang terlihat:

```text
_daq_core/rtl_daq.out
_daq_core/rebuffer.out
_daq_core/decimate.out
python3 _ui/_web_interface/app.py
php -S 0.0.0.0:8081 -t _share
```

Listener yang terlihat:

```text
0.0.0.0:8080
0.0.0.0:8081
*:8021
*:8042
```

Status service/process tetap bukan pengganti pemeriksaan `daq_ok`, sync flags, freshness, authority, dan convention gate.

## 5. Dampak ke implementasi LAN

Agent LAN lokal harus:

1. memakai `GET` bounded dengan URL host allowlist dan tanpa mengikuti redirect;
2. retry ketika membaca file non-atomic/partial;
3. menerbitkan health dan state yang mencerminkan DAQ computed health;
4. tidak menerbitkan settings mentah atau array angular;
5. tidak menerbitkan DoA numerik selama `daq_ok=false`, DoA stale, authority belum dipilih, atau canonical unit belum siap;
6. tidak menerima command retained atau command dengan QoS yang salah;
7. memakai TLS/auth/ACL untuk broker non-loopback;
8. menyimpan outbox dan command journal secara bounded serta fail-closed;
9. tetap mempertahankan config apply disabled sampai single-writer, watcher confirmation, read-back, rollback, dan operator authorization terbukti.

## 6. Review gate

Review independen untuk candidate sebelumnya menghasilkan:

```text
BLOCK
```

Temuan mencakup E2E Raspberry→Ground MQTT yang belum benar-benar diuji, transaction settings tanpa rollback/watcher confirmation, command injection protection yang belum cukup, normalisasi DoA/unit yang salah, queue/reconnect semantics, dan keamanan broker.

Karena candidate sedang diremediasi, verdict tersebut tetap menjadi alasan untuk **tidak melakukan remote mutation**. Candidate terbaru harus diuji dan direview ulang sebelum deployment.
