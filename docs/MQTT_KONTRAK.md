# Kontrak MQTT RDF Node untuk Ground Console

| | |
|---|---|
| Status | Menunggu persetujuan |
| Issue | #7 (parser console mengikuti kontrak edge) |
| Keputusan | `docs/KEPUTUSAN_MQTT.md`: satu MQTT, root `sdr/v2/uav-01`, Data Out hanya cadangan |
| Kode console | `tools/rdf_node_mqtt_v2.py` (parser dan store), `tools/sdr_doa_mqtt_monitor.py` (koneksi), `GET /api/mqtt/rdf-node` |
| Fixture | `tools/fixtures/rdf-node/`, dibuat oleh kode edge sendiri |

Sumber: repo `sanadunt/rdf-indicator-raspberry`, folder `rdf-node/`: `docs/MQTT_TOPIC_SUMMARY.md`, `docs/PROTOCOL.md`, `docs/CONTROL.md`, `docs/MQTT_GROUND.md`, dan kode `src/rdf_node/ground.py`, `codec.py`, `control.py`, `agent.py`, `journal.py`, `source.py`. Acuan wajib: commit `8691ad000146111cd633e9e4fac600b5da53fd8c` (edge rilis `1.0.0-20261013194717`, yang terpasang di Raspberry). Tambahan dari HEAD `20713ff9f0580386cece39f9b12d1d24e47b9bb6` (2026-10-27) ada di bagian 7 dan bersifat opsional.

## 1. Ringkas

- Semua topik di bawah `sdr/v2/uav-01/`. MQTT 5, Clean Start, Session Expiry 0. Edge mengirim satu objek JSON compact UTF-8 per PUBLISH, termasuk Angular (360 nilai, tanpa RDF2, chunk, atau Base64).
- Console subscribe ke 12 topik edge → ground dengan QoS 1, Retain As Published, Retain Handling 0, client id `groundconsole<hex>`. Console tidak memakai client id `uav-01-ground` milik `rdf-ground.service` dan tidak bergantung padanya.
- `config/reported` bukan bagian kontrak. Console tidak subscribe, jadi nilai retained sisa di broker tidak dibaca dan tidak memberi revisi.
- Console belum mengirim perintah ke `sdr/v2` (#9). Bagian 5 dan 6 mencatat kontraknya.

## 2. Topik edge → ground

| Topik | QoS | Retained | Interval / expiry | Contoh | Field wajib (8691ad0) |
|---|---:|---|---|---:|---|
| `state` | 1 | ya | saat berubah, paling lambat 60 s | 211 B | `v`=2, `sid`, `boot`, `instance`, `t`, `run` (`RUNNING`, `STOPPED`, `STARTING`, `STOPPING`, `ERROR`, `UNKNOWN`), `daq` (bool), `cfg` (int ≥ 0 atau null), `profile`, `clock` (`SYNCED`, `UNTRUSTED`, `DEMO`) |
| `capabilities` | 1 | ya | saat koneksi Control baru | 593 B | `v`, `sid`, `boot`, `instance`, `version`, `mode`, `codecs` (list teks), `angle`, `native_axis` (int), `count` (int), `profiles` (list teks), `scope`, dan bool `helper_available`, `remote_commands`, `remote_config_patch`, `remote_processing`, `remote_restart`, `remote_reboot`, `remote_shutdown`, `remote_ppp_restart`, `config_patch`, `processing`, `restart`, `reboot`, `shutdown`, `ppp_restart`. Tanpa `t`, tanpa `maintenance`. |
| `availability` | 1 | ya | online saat Control siap; Last Will saat koneksi putus | 56 / 66 B | `v`, `sid`, `online` (bool); `t` wajib saat online; `reason` (teks) saat offline |
| `telemetry/health` | 0 | tidak | 1 s; expiry 5 s | 109 B | `v`, `sid`, `q`, `t`, `run` (0 stop, 1 jalan, 2 mulai, 3 berhenti, 4 error, 255 tidak diketahui), `daq` (0 turun, 1 sehat, 2 tidak diketahui), `clk` (0, 1), `drop`, `age` (int ≥ 0 atau null), `temp` (angka atau null), `rev` (int atau null) |
| `telemetry/health/detail` | 0 | tidak | 10 s; expiry 15 s | 178 B | `v`, `sid`, `t`, `usb` (int atau null), `sync` (3 × bool atau null), `cpu`, `mem`, `disk_free` (0..100 atau null), `throt`, `uv` (bool atau null), `tx`, `rx` (kbit/s ≥ 0 atau null), `adrop`, `parse` (int ≥ 0) |
| `telemetry/doa` | 0 | tidak | maks. 1/s; expiry 3 s | 106 / 213 B | `v`, `sid`, `q`, `t` (waktu sumber), `f` (Hz), `a` (0..360), `c` (dB native, ±327,67), `p` (±1e6), `rev` (int atau null), `ok` (0, 1). Bila `ok=0` juga `trust`=`UNVERIFIED`, `angle_reference`=`RAW`, `validation_reasons` (1–2 dari `SOURCE_UNVERIFIED`, `ANGLE_UNVERIFIED`); `a` adalah sudut RAW. |
| `telemetry/diagnostic/doa` | 0 | tidak | 3 s selama `doa.xml` ada; expiry 3 s | 234 B | `v`, `sid`, `q`, `source`=`doa.xml`, `source_timestamp_ms`, `observed_timestamp_ms`, `raw_doa_deg` (0..360), `frequency_mhz` (0,001..5000), `trust`=`UNVERIFIED`, `validation_reasons` (1–32 kode `[A-Z0-9_:-]{1,64}`, termasuk `DIAGNOSTIC_UNVERIFIED`) |
| `telemetry/angular` | 0 | tidak | `balanced` ≥ 4 s, `graph_u8` ≥ 2 s, `control` tidak dikirim; expiry 3 s | 2,4–2,9 kB | `v`=2, `encoding`=`json`, `sid`, `q`, `timestamp_ms`, `frequency_hz` (1..2³²−1), `revision` (null atau 0..2³²−2), `vfo` (0..15), `convention` (0, 1), `flags` (0..63), `raw_doa_deg` (null atau 0..360), `confidence_native_db` (null atau ±327,67), `values` (tepat 360 angka, masing-masing ±1e8, urutan index native) |
| `telemetry/diagnostic/angular` | 0 | tidak | ≥ 6 s saat sumber gagal gate, ≥ 30 s saat Bulk terblokir; expiry 3 s | 2,4–2,9 kB | sama dengan `telemetry/angular` |
| `settings/reported` | 1 | tidak | hanya setelah `cmd/config/get`, hanya lewat broker TLS; expiry 30 s | ≤ 8192 B | tepat `v`, `sid`, `boot`, `id`, `rev` (int ≥ 0), `t`, `settings_json` (teks UTF-8 persis `settings.json`) |
| `ack/config` | 1 | tidak | progres dan hasil `config.*`; expiry 30 s | 140–150 B | `v`, `sid`, `id`, `status`, `t`, `rev` (int atau null), `result` (objek) |
| `ack/operation` | 1 | tidak | progres dan hasil operasi lain; expiry 30 s | 106–270 B | sama dengan `ack/config` |

Tipe umum: `sid` 8 digit hex huruf kecil; `q` integer 1..2³²−1, berurutan per jenis data; `t`, `timestamp_ms`, `source_timestamp_ms`, `observed_timestamp_ms` integer ms Unix 13 digit; `boot` dan `instance` teks token (UUID di edge). Field yang tidak dikenal diabaikan, supaya edge yang lebih baru boleh menambah field, kecuali di `settings/reported` yang harus tepat tujuh field.

## 3. Aturan validasi console

Status yang dipakai console per topik: `LIVE`, `UNVERIFIED`, `FRESH`, `CONTEXT`, `STALE`, `INCONSISTENT`, `IGNORED`, `INVALID`, `UNAVAILABLE` (retained yang dihapus: `CLEARED`). Hanya `INVALID` yang menaikkan hitungan invalid.

Untuk semua topik:

- Payload paling besar 8192 byte (edge menolak publish di atas itu di `Client.offer`; `settings/reported` punya batas yang sama). Selebihnya `INVALID PAYLOAD_TOO_LARGE`.
- JSON ketat: objek, UTF-8, tanpa `NaN`/`Infinity`, tanpa key ganda; integer harus integer JSON dan bukan `true`/`false`. Selebihnya `INVALID` dengan kode dan nama field. Kasus yang tidak bernama di validator tetap satu pesan `INVALID MALFORMED_PAYLOAD`, tidak pernah pesan yang tidak terhitung.
- QoS dan retain harus sama dengan tabel bagian 2; selebihnya `INVALID BROKER_POLICY`. Payload kosong yang retained menghapus nilai retained (`CLEARED`) beserta nilai yang dibawa topik itu.
- Sesi: `state` menentukan `sid`, `boot`, `instance`, `cfg`. Telemetry, `settings/reported`, dan ACK sebelum ada `state` → `IGNORED NO_SESSION`; dari `sid` lain → `INCONSISTENT SESSION_MISMATCH`. `state` dengan `sid` baru membuang cache sesi lama (health, detail, DoA, diagnostik, Angular, settings, urutan `q`). `sid` lama dengan `boot` atau `instance` lain → `INCONSISTENT SESSION_ALIAS_COLLISION`.
- `q` harus maju per jenis data: health, DoA `ok=1`, DoA `ok=0`, diagnostic DoA, Angular LIVE, Angular trust-only, diagnostic Angular. Yang tidak maju → `IGNORED SEQUENCE_NOT_ADVANCING`.
- `rev`/`revision` adalah metadata dan bukan syarat kesamaan, kecuali untuk DoA `ok=0`.

| Topik | Diterima sebagai | Ditolak atau ditahan |
|---|---|---|
| `state`, `capabilities`, `availability` | `CONTEXT`; bukan heartbeat | `capabilities` dan `availability` dari `sid` lain → `INCONSISTENT SESSION_MISMATCH` |
| `telemetry/health` | `FRESH`, segar 8 s sejak diterima | `t` lebih dari 8 s lalu atau lebih dari 1 s di depan → `STALE` |
| `telemetry/health/detail` | `FRESH` 15 s sejak diterima; tidak pernah menjadi gate | — |
| `telemetry/doa` `ok=1` | `LIVE` bila `t` ≤ 5 s lalu dan ≤ 1 s di depan, dan health segar dengan `daq=1`. Tetap `LIVE` selama DoA ≤ 5 s sejak diterima, `t` ≤ 5 s, dan health segar dengan `daq=1`. | `t` di luar jendela → `STALE`; tanpa health segar `daq=1` → `INCONSISTENT DOA_WITHOUT_HEALTH` |
| `telemetry/doa` `ok=0` | `UNVERIFIED`, tidak pernah `LIVE`, tidak mengisi deteksi; basi 5 s sejak diterima | `rev` ≠ `state.cfg` (bila `cfg` diketahui) → `INCONSISTENT REVISION_MISMATCH`; tanpa health segar `daq=1` → `INCONSISTENT DOA_WITHOUT_HEALTH` |
| `telemetry/diagnostic/doa` | `UNVERIFIED`, terpisah dari deteksi; basi 5 s sejak diterima | `source_timestamp_ms` mundur → `INCONSISTENT SOURCE_TIME_REGRESSED` |
| `telemetry/angular` | `flags = 63`: `LIVE`. `flags & 23 = 23` tetapi bukan 63: `UNVERIFIED`, disimpan di jalur diagnostik; baris topiknya `STALE` bila umur sumbernya > 10 s. `LIVE` bertahan selama umur sumber ≤ 10 s, health segar, `daq=1`, dan `run=1`. | `flags & 23 ≠ 23` → `INVALID ANGULAR_EVIDENCE_INCOMPLETE`; `timestamp_ms` lebih dari 10 s lalu atau lebih dari 1 s di depan → `STALE`; tanpa health segar `daq=1` → `INCONSISTENT ANGULAR_WITHOUT_HEALTH` |
| `telemetry/diagnostic/angular` | Selalu `UNVERIFIED`, disimpan walau basi, tidak pernah mengisi Angular LIVE; `STALE` bila umur sumber > 10 s. Kedua topik Angular berbagi satu kandidat diagnostik (seperti Ground edge), tetapi baris tiap topik menjadi `STALE` menurut frame terakhirnya sendiri, juga setelah kandidat diganti topik lain. Alasan dari bit flags yang hilang, umur, health, dan revisi (`PREVIOUS_CONFIG`). | — |
| `settings/reported` | `FRESH` bila `id` cocok dengan permintaan `config.get` yang tertunda, `sid` dan `boot` sama dengan `state`, `t` ≤ 30 s lalu dan ≤ 1 s di depan, dan `settings_json` adalah teks UTF-8 berisi objek JSON dengan sarang paling dalam 16 tingkat (`settings.json` KrakenSDR satu objek datar). Teks disimpan persis di server; field aman diturunkan seperti `source.safe_settings` edge dan hanya diberikan, di tampilan node maupun di `settings_report()` server, selama `rev` = `state.cfg` (`matches_state_cfg`). | Tanpa permintaan yang cocok → `IGNORED UNREQUESTED_SETTINGS_REPORT`; field kurang atau lebih → `INVALID BAD_SETTINGS_REPORT`; `settings_json` bukan objek, bukan UTF-8 (surrogate tunggal `\ud800`) atau terlalu dalam → `INVALID BAD_SETTINGS_JSON` |
| `ack/config`, `ack/operation` | `FRESH` 30 s sejak diterima; disimpan per `id` (32 terakhir). `challenge` di `result` tidak pernah disimpan. | `status` di luar 14 status jurnal → `INVALID UNKNOWN_ACK_STATUS`; ACK belum final setelah ACK final dengan `id` sama → `IGNORED ACK_AFTER_FINAL` |

## 4. Angka freshness

| Data | Batas |
|---|---|
| Health | Segar sampai 8 s sejak diterima, `t` saat diterima ≤ 8 s lalu dan ≤ 1 s di depan, `q` maju. MQTT tersambung atau `state.daq` bukan pengganti health. |
| DoA (`telemetry/doa`) | `t` ≤ 5 s lalu dan ≤ 1 s di depan |
| Angular | Umur sumber `timestamp_ms` ≤ 10 s dan ≤ 1 s di depan |
| Flags Angular | Bit 0 parsed (1), bit 1 jam dan sumber segar (2), bit 2 DAQ sehat (4), bit 3 konvensi sudut (8), bit 4 atribusi config (16), bit 5 authority sumber (32). Mask integritas 23, LIVE hanya 63. |
| `settings/reported` | `t` ≤ 30 s lalu; permintaan tertunda berlaku 60 s (TTL perintah maks. 30 s + expiry 30 s) |
| ACK | Expiry 30 s |

## 5. Perintah ground → edge (untuk #9)

QoS 1, tidak retained, satu objek JSON per topik. Envelope:

| Field | Aturan edge |
|---|---|
| `v` | 2 |
| `id` | `[A-Za-z0-9_.:-]{1,80}`. `id` sama dengan payload sama mengembalikan hasil jurnal; payload lain → `COMMAND_ID_CONFLICT`. |
| `sid`, `boot` | Dari `state` terakhir; selain itu `SESSION_MISMATCH` |
| `issued_ms`, `expires_ms` | `expires_ms` > sekarang, `issued_ms` ≤ sekarang + 1 s, 0 < `expires_ms` − `issued_ms` ≤ 30000 (default 15000) |
| `base_rev` | `state.cfg`; untuk mutasi harus sama dengan revisi edge (`CONFIG_REVISION_CONFLICT`) |
| `op` | Harus cocok dengan topik |
| field operasi | `changes`, `desired`, `profile`, `target_id`, `prepare_id`, `challenge` sesuai `op`; field lain ditolak |

| Topik | `op` | Field tambahan |
|---|---|---|
| `cmd/config/get` | `config.get` | — (jawaban di `settings/reported`; perlu MQTT siap dan sesi, bukan health segar; maks. 1/s) |
| `cmd/config/patch` | `config.patch` | `changes`: `center_frequency_hz` dan `vfo0_frequency_hz` (24 000 000..1 766 000 000 Hz, keduanya sama), `vfo0_bandwidth_hz` (100..2 400 000), `gain_db` (−10..100, nilai tabel gain), `vfo0_squelch_db` (−200..50) |
| `cmd/processing/set` | `processing.set` | `desired`: `RUNNING` atau `STOPPED` |
| `cmd/service/restart` | `service.restart` | — |
| `cmd/service/ppp/restart` | `ppp.restart` | — |
| `cmd/system/reboot/prepare`, `cmd/system/shutdown/prepare` | `system.reboot.prepare`, `system.shutdown.prepare` | — (ACK membawa `prepare_id`, `challenge`, `valid_seconds` 30) |
| `cmd/system/reboot/execute`, `cmd/system/shutdown/execute` | `system.reboot.execute`, `system.shutdown.execute` | `prepare_id`, `challenge` |
| `cmd/operation/get` | `operation.get` | `target_id` (maks. 1/s) |
| `cmd/stream/set` | `stream.set` | `profile`: `control`, `balanced`, `graph_u8` |

Semua operasi selain `config.get` memerlukan health segar di sisi ground. Edge menolak perintah retained.

## 6. ACK

Field: `v`, `sid`, `id`, `status`, `t`, `rev`, `result`. `config.*` dijawab di `ack/config`, operasi lain di `ack/operation`. Satu perintah dapat menghasilkan beberapa ACK.

| Status | Final |
|---|---|
| `ACCEPTED`, `APPLYING`, `VERIFYING`, `REBOOT_SCHEDULED`, `SHUTDOWN_SCHEDULED`, `PPP_RESTART_REQUESTED` | tidak |
| `APPLIED`, `FAILED`, `REJECTED`, `EXPIRED`, `CONFLICT`, `PERSISTED_UNVERIFIED`, `OUTCOME_UNKNOWN`, `CANCELLED` | ya |

`PERSISTED_UNVERIFIED` (tersimpan, bukti runtime belum lengkap) dan `OUTCOME_UNKNOWN` (hasil tidak diketahui) bukan berhasil dan bukan gagal. `SHUTDOWN_SCHEDULED` bukan bukti host mati. `PPP_RESTART_REQUESTED` hanya bukti systemd menerima permintaan. Penolakan berisi `result.error`. `result.challenge` dari `prepare` tidak pernah dicatat atau ditampilkan.

## 7. Tambahan di HEAD (20713ff), opsional di console

- `telemetry/health/detail`: `ppp` (`UP`, `DOWN`), `peer` (`REPLY`, `NO_REPLY`, `NO_INTERFACE`, `ERROR`, `UNKNOWN`), `ppp_svc` (`ActiveState` `t900-ppp.service` huruf besar, `NOT_LOADED`, atau `UNKNOWN`), `ppp_restarts` (int atau null). Edge 8691ad0 tidak mengirimnya.
- `ppp.restart`: setelah `PPP_RESTART_REQUESTED` edge mengirim ACK akhir `APPLIED` (`proof` `{ppp, peer, mqtt, cycled}`, `elapsed_ms`) atau `OUTCOME_UNKNOWN` (`phase`, `steps`, `elapsed_ms`, `reason`). Penolakan baru: `PPP_RESTART_IN_PROGRESS`, `PPP_RESTART_TOO_SOON`.
- Record `operation.get` menambah `origin`, `summary`, `reason`.
- Wire tidak berubah; hanya reconnect dan keepalive client edge.
