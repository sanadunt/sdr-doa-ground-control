# Fixture MQTT RDF Node

Payload di folder ini dibuat oleh kode RDF Node sendiri, bukan ditulis tangan. Dipakai `tools/test_rdf_node_mqtt_v2.py`; kontraknya di `docs/MQTT_KONTRAK.md`.

| | |
|---|---|
| Repo edge | `sanadunt/rdf-indicator-raspberry`, folder `rdf-node/` |
| Commit utama | `8691ad000146111cd633e9e4fac600b5da53fd8c` (edge rilis `1.0.0-20261013194717`, yang terpasang di Raspberry) |
| Commit tambahan | `20713ff9f0580386cece39f9b12d1d24e47b9bb6` (HEAD 2026-10-27), hanya untuk `state.ppp-session.json` dan `telemetry-health-detail.ppp.json` |
| Commit edge baru | `35984d8ada106a1bcb4c9a40179bae6198ed2df1` (PR `sanadunt/rdf-indicator-raspberry#5`: `config.get` dijawab lewat broker utama tanpa TLS), hanya untuk `commands.35984d8.json` dan `compat.35984d8.json` |
| Daftar file | `manifest.json`: topik, QoS, retain, dan expiry tiap file persis seperti yang diserahkan agent ke `Agent._offer` |

Setiap file berisi byte payload persis (JSON compact dari `util.compact`), satu topik dan satu varian per file. Semua file commit utama berasal dari satu proses agent, jadi `sid`, `boot`, dan `instance` sama; `generated_at_ms` di `manifest.json` adalah jam saat dibuat. Test menerima pesan pada jam itu, sehingga aturan freshness berlaku seperti pada link sungguhan.

## Cara membuat ulang

Repo edge tidak diubah. Ambil salinan per commit ke folder sementara, lalu jalankan `make_fixtures.py` dengan Python 3 tanpa paket tambahan (PyYAML ada di `vendor/` edge):

```sh
EDGE=/path/ke/rdf-indicator-raspberry
TMP=$(mktemp -d)
mkdir -p "$TMP/a" "$TMP/b" "$TMP/c"
git -C "$EDGE" archive 8691ad0 rdf-node | tar -x -C "$TMP/a"
git -C "$EDGE" archive 20713ff rdf-node | tar -x -C "$TMP/b"
git -C "$EDGE" archive 35984d8 rdf-node | tar -x -C "$TMP/c"
python3 tools/fixtures/rdf-node/make_fixtures.py --edge "$TMP/a/rdf-node" --commit 8691ad0 --set full
python3 tools/fixtures/rdf-node/make_fixtures.py --edge "$TMP/b/rdf-node" --commit 20713ff --set detail-ppp
python3 tools/fixtures/rdf-node/make_fixtures.py --edge "$TMP/a/rdf-node" --commit 8691ad0 --set commands
python3 tools/fixtures/rdf-node/make_fixtures.py --edge "$TMP/c/rdf-node" --commit 35984d8 --set commands
python3 tools/fixtures/rdf-node/make_fixtures.py --edge "$TMP/c/rdf-node" --commit 35984d8 --set compat
```

Script membuat `Agent` di atas folder share KrakenSDR sementara (`settings.json`, `status.json`, `DOA_value.html`, `doa.xml`), menjalankan satu putaran `Agent._schedule()` dan `CommandManager` edge, lalu menyimpan setiap payload yang diserahkan agent. Yang diganti hanya klien MQTT (siap, tanpa socket), monitor host (nilai tetap, jam tersinkron), dan helper root, seperti di test edge sendiri:

- `system.reboot.prepare` memakai `helper.Controller` edge yang asli, jadi ACK-nya membawa `challenge` sekali pakai (untuk test redaksi; challenge itu sudah mati);
- `ppp.restart` memakai jawaban helper `{"requested": true, "service": "t900-ppp.service"}`, satu-satunya jawaban yang diterima `control.py`;
- `service.restart` tanpa socket helper, sehingga hasilnya `OUTCOME_UNKNOWN`.

## Perintah Kontrol (`commands.<commit>.json`)

`--set commands` menulis `commands.<commit>.json`, satu file per commit edge: perintah `config.get` dan `config.patch` yang dibuat oleh `tools/rdf_node_commands.py` milik console (envelope, topik, QoS 1, tidak retained, TTL 15 s), masing-masing diserahkan ke `CommandManager.submit` edge yang asli lewat topik yang dipakai console, dengan `helper.Controller` edge yang asli menulis `settings.json` sementara (`settings_path`, `single_writer_confirmed`). Thread kecil meniru engine KrakenSDR: setelah helper menulis, ia menulis `status.json` dan record DoA baru sesuai `settings.json` lalu memanggil `source.poll`, sehingga field yang punya bukti runtime (centre, VFO0, gain) menjadi `APPLIED`, sedangkan bandwidth dan squelch tetap `PERSISTED_UNVERIFIED`. `verify_seconds` diperpendek menjadi 2 s.

Isinya: `session` (payload `state` dan `telemetry/health` sesi itu) dan `cases`. Tiap case mencatat `changes` yang diberikan ke console, `console` (diterima atau kode penolakannya, topik, dan byte payload persis) dan `edge` (setiap ACK `ack/config` beserta QoS/retain/expiry, dan `settings/reported` untuk `config.get`). Case yang ditolak console dibuat tanpa pemeriksaan console, supaya terlihat edge juga menolaknya dengan aturan yang sama (`CENTER_CHANGE_REQUIRES_VFO0_TARGET`, `MVP_CENTER_MUST_EQUAL_VFO0`, `GAIN_NOT_IN_APPROVED_TABLE`, `INTEGER_OUT_OF_RANGE`, `NUMBER_OUT_OF_RANGE`, `INVALID_PATCH`). `config-get-tls-off` (link edge ke broker utama bukan TLS) membedakan kedua versi: `commands.8691ad0.json`, rilis yang terpasang di Raspberry, menunjukkan `REJECTED TLS_REQUIRED_FOR_SETTINGS_REPORT` tanpa `settings/reported`; `commands.35984d8.json` menunjukkan `APPLIED` dan satu `settings/reported`. Case lainnya sama di kedua file, dan `stale-base-rev` menunjukkan `REJECTED CONFIG_REVISION_CONFLICT`.

`tools/test_rdf_node_commands.py` membangun ulang setiap envelope dari input yang sama dan mewajibkan byte yang sama, jadi perubahan builder console gagal di test sampai edge menilai envelope baru itu lagi (jalankan ulang `--set commands` untuk kedua commit). Console tidak pernah mengimpor kode edge.

## Satu sesi edge baru (`compat.35984d8.json`)

`--set compat` menulis `compat.<commit>.json`: `messages` berisi satu sesi edge itu dalam urutan broker menyerahkannya ke subscriber baru. Konteks retained (`state`, `capabilities`, `availability`) dulu, lalu `telemetry/health`, `telemetry/health/detail` dengan `ppp`, `peer`, `ppp_svc` dan `ppp_restarts`, `telemetry/doa` `ok=1` dengan `a=350`, `telemetry/diagnostic/doa`, `telemetry/angular` (`flags=63`, 360 nilai), `telemetry/diagnostic/angular`, `telemetry/doa` `ok=0` dengan `validation_reasons`, lalu `config.get` lewat broker utama tanpa TLS dengan `ack/config` `APPLIED` dan `settings/reported`-nya. Tiap pesan membawa topik, QoS, retain, expiry dan byte payload persis. `NewerEdgeCompatTests` di `tools/test_rdf_node_mqtt_v2.py` memasukkannya berurutan ke store console dan mewajibkan setiap pesan diterima.

`manifest.json` mencatat file `commands.*` dan `compat.*` di `sets` (file, jenis, commit edge, versi edge); daftar per topik `fixtures` tetap milik commit utama.

## Snapshot console

`api-snapshot.json` bukan payload edge: ini body `GET /api/mqtt/rdf-node` yang dihasilkan `tools/rdf_node_mqtt_v2.py` setelah edge yang sehat mengirim fixture di bawah. `tools/test_rdf_node_mqtt_v2.py` gagal bila body itu tidak sama lagi dengan yang dilayani store, dan Vitest Monitor Pesan membacanya. Setelah bentuknya sengaja diubah, tulis ulang dengan:

```sh
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -c "import tools.test_rdf_node_mqtt_v2 as t; t.write_api_snapshot()"
```

## Isi

| File | Topik | Varian |
|---|---|---|
| `state.json` | `state` | Sesi pertama |
| `capabilities.json` | `capabilities` | Tanpa `maintenance`; `remote_*` sesuai helper default |
| `availability.online.json`, `availability.offline-will.json` | `availability` | Online, dan Last Will tanpa `t` |
| `telemetry-health.json`, `telemetry-health.daq-degraded.json` | `telemetry/health` | `daq=1`, dan `daq=0` |
| `telemetry-health-detail.json` | `telemetry/health/detail` | Field commit utama, tanpa PPP |
| `telemetry-health-detail.ppp.json`, `state.ppp-session.json` | `telemetry/health/detail`, `state` | Edge yang lebih baru: `ppp`, `peer`, `ppp_svc`, `ppp_restarts` (sesi sendiri) |
| `telemetry-doa.ok1.json` | `telemetry/doa` | `ok=1`, sudut relatif `theta_mirror` (160°) |
| `telemetry-doa.ok0.json` | `telemetry/doa` | `ok=0`, sudut RAW 200° (default edge: authority dan sudut belum diverifikasi) |
| `telemetry-diagnostic-doa.json`, `telemetry-diagnostic-doa.degraded.json` | `telemetry/diagnostic/doa` | Gate DoA lolos, dan DAQ tidak sehat |
| `telemetry-angular.live.json` | `telemetry/angular` | `flags=63` |
| `telemetry-angular.unverified.json` | `telemetry/angular` | `flags=23` (trust-only) |
| `telemetry-diagnostic-angular.wait-stable.json` | `telemetry/diagnostic/angular` | Sumber valid, Bulk menunggu link stabil (`flags=63`, tetap UNVERIFIED) |
| `telemetry-diagnostic-angular.json` | `telemetry/diagnostic/angular` | Sumber tidak eligible, bit DAQ hilang (`flags=59`) |
| `settings-reported.json` | `settings/reported` | Jawaban `config.get`; `settings_json` teks persis `settings.json` |
| `ack-config.config-get-applied.json` | `ack/config` | `config.get` APPLIED |
| `ack-config.config-patch-rejected.json` | `ack/config` | `config.patch` REJECTED `CONFIG_REVISION_CONFLICT` |
| `ack-operation.stream-set-accepted.json`, `ack-operation.stream-set-applied.json` | `ack/operation` | `stream.set` ACCEPTED lalu APPLIED |
| `ack-operation.operation-get.json` | `ack/operation` | `operation.get` dengan record publik |
| `ack-operation.service-restart-unknown.json` | `ack/operation` | `OUTCOME_UNKNOWN` |
| `ack-operation.reboot-prepare-applied.json` | `ack/operation` | APPLIED dengan `challenge` |
| `ack-operation.ppp-restart-requested.json` | `ack/operation` | `PPP_RESTART_REQUESTED` |
| `commands.8691ad0.json`, `commands.35984d8.json` | `cmd/config/get`, `cmd/config/patch`, `ack/config`, `settings/reported` | Perintah Kontrol buatan console dan jawaban edge per commit (bagian di atas) |
| `compat.35984d8.json` | semua topik edge → ground kecuali `ack/operation` | Satu sesi edge baru dalam urutan broker (bagian di atas) |
