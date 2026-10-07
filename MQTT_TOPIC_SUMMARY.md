# RDF Node MQTT topic summary

Ringkasan ini mengikuti materi RDF Node MQTT v2 dan ditujukan sebagai referensi saat memperbarui receiver Ground. Contoh payload di bawah bersifat sintetis, bukan capture dari Raspberry atau broker produksi; dokumen ini tidak menyatakan kompatibilitas perangkat atau broker.

## Namespace dan identitas

Namespace v2 memakai pola `sdr/v2/{node_id}`. Contoh guide memakai `uav-01`, sehingga contoh topic lengkapnya `sdr/v2/uav-01/...`. Ground Console dalam repository ini juga memakai default lokal `rdf_node_id=uav-01`; operator dapat mengubahnya melalui **Configuration → Connection**. Perubahan ID hanya mengubah prefix v2; filter legacy v1 tetap `sdr/v1/uav-01/#`. Prefix demo internal adalah `sdr/demo/v2/{node_id}`.

Semua topic di tabel berikut adalah suffix setelah prefix tersebut. Topic bersifat case-sensitive.

| Field | Makna |
|---|---|
| `v` | Versi protokol, saat ini `2`. |
| `sid` | Alias sesi proses, 8 digit hex; berubah ketika proses Agent dimulai ulang. |
| `boot` | ID boot OS. |
| `instance` | UUID instance Agent. Kombinasi `sid`, `boot`, dan `instance` mengaitkan data dengan satu sesi. |
| `t` | Unix timestamp dalam milidetik, kecuali disebut lain. |
| `q` | Urutan sampel untuk jenis datanya. Bukan satu counter global dan bukan nomor frame DAQ. |
| `rev` | Revision konfigurasi aman yang dikorelasikan dengan data; dapat `null` bila belum diketahui. |

Payload JSON adalah object v2 langsung, tanpa wrapper tambahan. `telemetry/angular` adalah payload binary, bukan JSON atau Base64. MQTT tidak mengirim raw IQ, raw CSV, koordinat GPS, kredensial broker, atau PIN admin.

## Koneksi dan pemisahan kanal

Edge membuka dua MQTT client:

| Kanal | Client ID | Hak data |
|---|---|---|
| Control | `{client_id}-control` | Publish telemetry JSON, state, capabilities, config report, availability, ACK; subscribe command dan receipt. |
| Bulk | `{client_id}-bulk` | Publish `telemetry/angular` saja. Tidak subscribe command dan tidak memiliki hak command. |
| Ground | `{node_id}-ground` | Subscribe data operasional/ACK; publish command dan receipt. |

Kredensial Control dan Bulk terpisah bila digunakan. Jika file kredensial untuk kanal tidak dikonfigurasi, client dapat memakai anonymous CONNECT; ACL broker tetap harus membatasi hak berdasarkan deployment. MQTT memakai Clean Start dan Session Expiry 0. Koneksi ulang membuat sesi baru dan subscribe ulang, tanpa replay history offline. QoS 2 dan persistent broker session tidak didukung.

## Daftar lengkap topic

QoS dan expiry berikut adalah setting publish dari implementasi saat ini. `Retained` berarti broker menyimpan nilai terakhir untuk subscriber baru.

| Topic suffix | Arah | Kanal | QoS | Retained | Interval / expiry | Isi |
|---|---|---|---:|---|---|---|
| `telemetry/doa` | Edge -> Ground | Control | 0 | Tidak | Umumnya tiap 1 s bila DoA valid; expiry 3 s | Ringkasan DoA, frekuensi, confidence, power, revision. |
| `telemetry/diagnostic/doa` | Edge -> Ground | Control | 0 | Tidak | Tidak ditentukan | Kandidat DoA diagnostik dengan sudut/frekuensi mentah dan alasan validasi. |
| `telemetry/diagnostic/angular` | Edge -> Ground | Bulk | 0 | Tidak | Tidak ditentukan | Kandidat frame RDF2 diagnostik lengkap; flags subset dan trust `UNVERIFIED`. |
| `telemetry/health` | Edge -> Ground | Control | 0 | Tidak | Tiap 1 s; expiry 5 s | Status run, DAQ, clock, umur sumber, temperatur, dropped frames. |
| `telemetry/health/detail` | Edge -> Ground | Control | 0 | Tidak | Tiap 10 s; expiry 15 s | Detail host, USB, sync DAQ, trafik, parse dan abort counter. |
| `telemetry/angular` | Edge -> Ground | Bulk | 0 | Tidak | Profile-dependent; expiry 3 s | Frame 360 sampel dalam satu atau lebih payload binary. |
| `state` | Edge -> Ground | Control | 1 | Ya | Saat state berubah dan paling lambat tiap 60 s | Status run/DAQ, profile, clock dan identitas boot. Jangan dipakai sebagai heartbeat. |
| `capabilities` | Edge -> Ground | Control | 1 | Ya | Saat generation koneksi Control berubah | Versi, identitas, codec, profile dan capability yang diizinkan. |
| `config/reported` | Edge -> Ground | Control | 1 | Ya | Saat startup/reconnect atau report diminta/perubahan revision | Safe settings, revision, digest dan tingkat proof. Tidak berisi secret. |
| `availability` | Edge -> Ground | Control | 1 | Ya | Online saat koneksi siap; Last Will saat koneksi hilang | Ketersediaan Control, bukan bukti DAQ sehat. |
| `ack/config` | Edge -> Ground | Control | 1 | Tidak | Saat progress/hasil command `config.*`; expiry 30 s | ACK command konfigurasi. |
| `ack/operation` | Edge -> Ground | Control | 1 | Tidak | Saat progress/hasil command selain `config.*`; expiry 30 s | ACK command operation. |
| `ground/receipt` | Ground -> Edge | Control | 0 | Tidak | Sekitar tiap 5 s bila health Ground masih fresh; expiry 5 s | Bukti aplikasi Ground menerima/memproses sequence tertentu. |
| `cmd/config/get` | Ground -> Edge | Control | 1 | Tidak | Command TTL default 15 s, maksimum 30 s | Minta config report terbaru. |
| `cmd/config/patch` | Ground -> Edge | Control | 1 | Tidak | Command TTL default 15 s, maksimum 30 s | Intent perubahan field safe yang diizinkan. |
| `cmd/processing/set` | Ground -> Edge | Control | 1 | Tidak | Command TTL default 15 s, maksimum 30 s | Intent `RUNNING` atau `STOPPED` untuk SDR stack yang di-approve. |
| `cmd/service/restart` | Ground -> Edge | Control | 1 | Tidak | Command TTL default 15 s, maksimum 30 s | Restart SDR stack yang di-approve. Bukan restart PPP atau bridge. |
| `cmd/system/reboot/prepare` | Ground -> Edge | Control | 1 | Tidak | Command TTL default 15 s, maksimum 30 s | Meminta challenge reboot sekali pakai. |
| `cmd/system/reboot/execute` | Ground -> Edge | Control | 1 | Tidak | Command TTL default 15 s, maksimum 30 s | Eksekusi reboot dengan `prepare_id` dan `challenge` yang masih valid. |
| `cmd/operation/get` | Ground -> Edge | Control | 1 | Tidak | Command TTL default 15 s, maksimum 30 s | Query hasil/progress operation berdasarkan ID. |
| `cmd/stream/set` | Ground -> Edge | Control | 1 | Tidak | Command TTL default 15 s, maksimum 30 s | Ganti profile telemetry. |

### Peran setiap topic di Ground

| Topic | Yang dilakukan Ground |
|---|---|
| `telemetry/doa` | Tampilkan DoA terbaru hanya jika `ok`, revision, sequence, timestamp dan health cocok; jangan anggap `c` sebagai probabilitas. |
| `telemetry/diagnostic/doa` | Tampilkan raw DoA dan alasan sumber secara terpisah; freshness bukan verifikasi dan tidak memengaruhi DoA canonical atau readiness. |
| `telemetry/diagnostic/angular` | Tampilkan metadata, flags dan alasan untuk kandidat lengkap; tetap `UNVERIFIED`, bukan live plot, gate, atau receipt state. |
| `telemetry/health` | Gunakan sebagai sumber utama freshness dan status DAQ; pisahkan MQTT tersambung dari `daq=1`. |
| `telemetry/health/detail` | Pakai untuk diagnosis host, USB, sync, trafik dan error; jangan jadikan pengganti gate health. |
| `telemetry/angular` | Rakit semua chunk sebelum menggambar kurva; receipt `aq` baru maju setelah frame lolos gate. |
| `state` | Bootstrap identitas boot/sesi dan profile; saat `sid` berubah, buang cache telemetry sesi lama. Retained state bukan heartbeat. |
| `capabilities` | Tampilkan operasi sesuai capability node; tetap tegakkan ACL dan policy Ground. |
| `config/reported` | Simpan safe settings, revision dan proof. Jika revision berubah, buang DoA/Angular dari revision sebelumnya. |
| `availability` | Tampilkan status koneksi Control sebagai petunjuk saja; cek health untuk mengetahui kondisi DAQ. |
| `ack/config` | Cocokkan `id` dengan journal command konfigurasi; tampilkan progress dan hasil tanpa menganggap ACK broker sebagai hasil operasi. |
| `ack/operation` | Cocokkan `id` untuk lifecycle, stream dan reboot; tunggu bukti akhir yang sesuai operation. |
| `ground/receipt` | Kirim sequence health/DoA/Angular yang benar-benar sudah diproses; jangan kirim hanya karena broker mengirim PUBLISH. |
| `cmd/config/get` | Minta safe config terbaru; proses ACK `revision`/`proof` dan report terpisah di `config/reported`. |
| `cmd/config/patch` | Kirim hanya field allowlist dengan `base_rev` terkini; bedakan `APPLIED` dari `PERSISTED_UNVERIFIED`. |
| `cmd/processing/set` | Minta start/stop SDR stack hanya jika capability tersedia; verifikasi hasil dari ACK dan telemetry baru. |
| `cmd/service/restart` | Minta restart SDR stack yang di-approve; tunggu ACK final dengan proof operasi dan telemetry health fresh sebelum menyatakan pulih. |
| `cmd/system/reboot/prepare` | Minta challenge reboot setelah policy/approval terpenuhi; jangan log challenge. |
| `cmd/system/reboot/execute` | Kirim challenge satu kali sebelum kedaluwarsa; tunggu boot ID baru dan health fresh untuk rekonsiliasi. |
| `cmd/operation/get` | Query journal dengan `target_id` jika ACK hilang atau Ground reconnect. |
| `cmd/stream/set` | Ganti profile, lalu baca profile aktif dari `state` sebelum memperbarui ekspektasi rate Angular. |

Telemetri tidak retained supaya subscriber tidak menganggap data lama sebagai data live. `state`, `capabilities`, `config/reported`, dan `availability` retained untuk bootstrap, tetapi nilai retained tetap harus diuji freshness dan session-nya. ACK tidak retained dan punya expiry terbatas; Ground perlu menyimpan ID operation dan query ulang bila reconnect melewatkan ACK.

Subscription command memakai Retain Handling 2. Edge menolak command yang diterima dengan retain flag, termasuk retained command yang broker kirim sebagai publish live. Jangan publish command dengan `retain=true`.

## Ground Console diagnostic ingress in this repository

Ground Console subscribes to the twelve Edge-to-Ground suffixes in the table and does not publish MQTT. Its local `rdf_node_id` defaults to `uav-01`; **Configuration → Connection** changes only the `sdr/v2/{rdf_node_id}/` prefix. The legacy v1 root remains `sdr/v1/uav-01/#`.

Suffix set yang dibaca: `telemetry/doa`, `telemetry/diagnostic/doa`, `telemetry/diagnostic/angular`, `telemetry/health`, `telemetry/health/detail`, `telemetry/angular`, `state`, `capabilities`, `config/reported`, `availability`, `ack/config`, dan `ack/operation`.

`GET /api/mqtt/rdf-node` exposes the bounded DoA and Angular diagnostic observations in the same typed snapshot as the other v2 topics. Their trust is always `UNVERIFIED`, separate from freshness; neither diagnostic can update canonical live DoA/Angular, readiness, or System Health history. Ground does not plot a diagnostic Angular frame as live telemetry.

`GET /api/v2/angular/diagnostic/latest` is a read-only, same-origin projection with `enabled`, `connection`, `node_id`, `status`, `stale`, `trust`, `encoding`, `source_timestamp_ms`, `source_age_ms`, `received_age_ms`, `flags`, `validation_reasons`, `values`, and sanitized `error`. `status` is `UNAVAILABLE`, `FRESH`, `STALE`, or `INVALID`; an absent complete candidate has null candidate fields and `values: null`, while a stale complete candidate retains its metadata and exactly 360 decoded values. It adds no MQTT publish path.

Invalid v2 messages remain `INVALID` with canonical `payload: null`. When a bounded JSON object can be decoded, the snapshot exposes a display-only `candidate_payload` projected through the topic field allowlist; ACK `result` and `error` retain the existing credential redaction. System Health and Message Monitor can inspect that candidate without using it for canonical readings or readiness. Malformed, oversized, non-object, and binary messages expose receive time and parser error only. Broker connection remains independent; receive timestamps and orange `UNVERIFIED` labels do not establish authenticity.

Freshness does not establish trust. Diagnostic DoA is display-fresh only at receive age ≤ 3 s and source age ≤ 5 s. Diagnostic Angular is display-fresh only at receive age ≤ 3 s, source age ≤ 10 s, and with flag bit 1 set; a complete frame missing evidence remains visible as stale. DoA reasons are source-supplied; Angular reasons are Ground-derived evidence labels. These examples and synthetic fixtures do not establish Raspberry or broker compatibility.


## Estimasi bandwidth untuk 15 kbit/s

Asumsi di sini `15 Kbps` berarti 15.000 bit/s atau 1.875 byte/s, dan targetnya adalah trafik MQTT Edge rata-rata. Nilai default `config/example.yaml` memberi:

| Bucket | Budget default | Bit rate ekuivalen |
|---|---:|---:|
| Control | 850 byte/s | 6,8 kbit/s |
| Bulk | 350 byte/s | 2,8 kbit/s |
| Total dua bucket | 1.200 byte/s | 9,6 kbit/s |

Angka 9,6 kbit/s adalah budget biaya publish yang dihitung aplikasi, sekitar 64% dari 15 kbit/s dengan margin nominal 5,4 kbit/s. Ini mendukung trafik rata-rata pada konfigurasi default, bukan jaminan batas fisik.

Setiap client punya bucket terpisah dengan kredit awal 1.400 cost-byte untuk Control dan 650 cost-byte untuk Bulk. Satu publish bootstrap yang biayanya melebihi kapasitas tetap dapat dikirim saat bucket penuh, lalu membuat token berutang sampai terisi lagi. Karena itu burst singkat dapat melewati 15 kbit/s walaupun rata-ratanya dibatasi.

Untuk setiap outgoing PUBLISH, kode menghitung `len(MQTT packet) + 142`, lalu menambah 144 lagi untuk QoS 1. Nilai tetap itu adalah perkiraan overhead, bukan pengukuran byte aktual di T900. Kedua bucket juga tidak membatasi satu aggregate link: packet MQTT kontrol lain, trafik dari Ground, TLS/TCP/PPP, retransmission, dan proses lain dapat menambah trafik interface.

Kesimpulan: bila Raspberry memakai budget default dan tidak ada trafik PPP lain yang berarti, rata-rata MQTT Edge diperkirakan muat di bawah 15 kbit/s. Jangan klaim hard cap 15 kbit/s dari limiter ini saja. Untuk batas fisik yang tegas diperlukan shaper bersama pada interface/link dan pengukuran aktual. `telemetry/health/detail.tx` dan `.rx` menunjukkan rate interface dalam kbit/s untuk acceptance, tetapi belum ada pengukuran T900 nyata pada penilaian ini.

Jika perangkat memakai nilai MQTT budget berbeda dari `config/example.yaml`, hitung ulang dari konfigurasi aktual. Untuk limit agregat yang ketat, sisakan margin untuk overhead dan trafik non-MQTT.


## Ukuran payload dan laju aktual

Angka berikut diukur dari serializer JSON compact (`util.compact`) dan paket MQTT v5 yang dibuat `publish_packet`, memakai prefix contoh `sdr/v2/uav-01`. `Payload` adalah byte JSON UTF-8 atau binary saja. `PUBLISH` mencakup topic, framing MQTT, field properti (termasuk expiry bila disetel), dan packet ID untuk QoS 1; tidak mencakup TCP/TLS/WebSocket/IP/PPP. Ukuran JSON adalah ukuran fixture di bawah, bukan ukuran maksimum; digit timestamp, ID, nilai opsional, dan field command dapat mengubahnya.

### Telemetri berkala Edge → Ground

| Topic / profile | Interval saat syarat lolos | Payload contoh | MQTT PUBLISH |
|---|---|---:|---:|
| `telemetry/doa` | Maks. 1/s; hanya DoA valid dengan sequence baru | 109 B | 147 B |
| `telemetry/health` | 1/s | 113 B | 154 B |
| `telemetry/health/detail` | 1/10 s | 179 B | 227 B |
| `telemetry/angular` (`balanced`, Q16) | 2 chunk/4 s; tiap chunk | 396 B | 438 B |
| `telemetry/angular` (`graph_u8`, U8) | 1 chunk/2 s | 420 B | 462 B |
| `telemetry/angular` (`control`) | Tidak dipublish | — | — |

Satu frame Q16 berarti total 792 B payload dan 876 B dalam dua PUBLISH. Angular adalah binary, bukan JSON. DoA, health, dan detail adalah satu-satunya JSON telemetri periodik; hanya DoA dan health berjalan tiap detik.

### Topic event-driven dan command

Ukuran event memakai contoh JSON yang dicantumkan di bawah. State dapat dipublish saat berubah dan paling lambat tiap 60 s; capabilities/config/availability dikirim saat startup atau koneksi/event terkait, bukan tiap detik. ACK muncul saat progress/hasil command, dan satu command dapat memicu beberapa ACK.

| Topic / fixture | Kapan dikirim | Payload contoh | MQTT PUBLISH |
|---|---|---:|---:|
| `state` | Perubahan / maks. 60 s | 211 B | 238 B |
| `capabilities` | Generation koneksi Control berubah | 434 B | 468 B |
| `config/reported` | Startup/reconnect, diminta, atau revision berubah | 364 B | 401 B |
| `availability` online | Control siap | 56 B | 89 B |
| Last Will `availability` offline | Broker saat koneksi hilang; payload disertakan di CONNECT | 66 B | Bukan PUBLISH Edge |
| `ack/config` | Progress/hasil `config.*` | 226 B* | 263 B* |
| `ack/operation` | Progress/hasil operation lain | 226 B* | 266 B* |
| `ground/receipt` (Ground → Edge) | Sekitar 1/5 s selama health Ground fresh | 60 B | 98 B |

`*` Kedua baris ACK memakai JSON fixture `ack/config` di bawah hanya untuk mengukur ukuran paket; payload ACK aktual berubah mengikuti status dan `result` operation.

Ukuran command adalah fixture dengan envelope dan nilai umum yang sama seperti contoh `config.patch`; `system.reboot.execute` memakai placeholder challenge 32 karakter. Nilai aktual bergantung ID, timestamp, operation field, dan isi `changes`.

| Topic command (Ground → Edge) | Payload fixture | MQTT PUBLISH |
|---|---:|---:|
| `cmd/config/get` | 174 B | 215 B |
| `cmd/config/patch` | 250 B | 293 B |
| `cmd/processing/set` | 198 B | 243 B |
| `cmd/service/restart` | 179 B | 225 B |
| `cmd/system/reboot/prepare` | 185 B | 237 B |
| `cmd/system/reboot/execute` | 260 B | 312 B |
| `cmd/operation/get` | 204 B | 248 B |
| `cmd/stream/set` | 195 B | 236 B |

### Rata-rata periodik per profile

Asumsi: contoh payload di atas, source valid, DoA baru setiap detik, detail tiap 10 s, dan semua gate publish lolos. Nilai belum memasukkan topic retained/event, command/ACK, receipt Ground, MQTT control packets, atau overhead transport.

| Profile | Payload JSON/binary | MQTT PUBLISH | Biaya limiter |
|---|---:|---:|---:|
| `control` | 239.9 B/s | 323.7 B/s (2.59 kbit/s) | 621.9 cost-B/s (4.98 kbit/s) |
| `balanced` | 437.9 B/s | 542.7 B/s (4.34 kbit/s) | 911.9 cost-B/s (7.30 kbit/s) |
| `graph_u8` | 449.9 B/s | 554.7 B/s (4.44 kbit/s) | 923.9 cost-B/s (7.39 kbit/s) |

Biaya limiter memakai `PUBLISH bytes + 142`, ditambah 144 untuk QoS 1; bukan ukuran wire aktual. `state` pada jadwal 60 s menambah sekitar 4 PUBLISH B/s. Receipt Ground sekitar 19.6 PUBLISH B/s pada arah balik. Angka profile ini masih jauh di bawah budget default 1,200 cost-B/s gabungan (9.6 kbit/s), tetapi bukan batas fisik link.

Jadi, bukan semua JSON dikirim per detik: health dan DoA saja yang dijadwalkan 1/s; detail 10 s, state berubah/60 s, capability/config saat event, dan command/ACK saat diminta atau ada progress. Angular punya jadwal sendiri dan bisa tertahan oleh receipt, command, freshness, atau koneksi Bulk. QoS 0 dan expiry singkat membuat data lama kedaluwarsa/digantikan, bukan menumpuk untuk replay saat link pulih; karena itu profile tidak menjamin full-speed pada koneksi buruk.


## Payload yang dipublish Edge

### `telemetry/doa`

```json
{"v":2,"sid":"7a8b9c0d","q":1245,"t":1790668800123,"f":433920000,"a":137.4,"c":8.27,"p":-54.2,"rev":7,"ok":1}
```

| Field | Makna |
|---|---|
| `q` | Urutan record DoA adapter. |
| `t` | Timestamp native source, bukan waktu publish MQTT. |
| `f` | Frekuensi VFO output dalam Hz. |
| `a` | Sudut DoA relatif menurut konfigurasi konvensi angle. Bukan otomatis true north. |
| `c` | Confidence/PAPR native dB, bukan probabilitas atau persen. |
| `p` | Power native bertanda, bukan level absolut terkalibrasi. |
| `rev` | Revision konfigurasi aman saat sampel dibaca. |
| `ok` | `1` menandakan DoA lolos gate source Edge. |

Ground menolak DoA yang retained, lebih lama dari 5 s, sequence tidak maju, `ok` bukan `1`, revision tidak cocok, atau tidak didukung health DAQ fresh dengan `daq=1`.

### `telemetry/health`

```json
{"v":2,"sid":"7a8b9c0d","q":86,"t":1790668800123,"run":1,"daq":1,"drop":12,"age":280,"temp":61.4,"clk":1,"rev":7}
```

| Field | Makna |
|---|---|
| `q` | Counter health Edge yang maju tiap publish interval. |
| `run` | `0` stopped, `1` running, `2` starting, `3` stopping, `4` error, `255` unknown. |
| `daq` | `0` degraded, `1` healthy, `2` unknown. |
| `drop` | Dropped-frame count dari status DAQ; dapat `null` bila tidak tersedia. |
| `age` | Umur DoA pada source dalam ms, bukan end-to-end latency; dapat `null`. |
| `temp` | Temperatur host dalam derajat C; dapat `null`. |
| `clk` | `0` clock tidak dipercaya, `1` tersinkronisasi. |
| `rev` | Revision konfigurasi aman; dapat `null`. |

Ground memperlakukan health fresh sampai 8 s dan memerlukan `q` yang maju. Health tetap dipublish saat SDR berhenti; service aktif atau MQTT tersambung bukan bukti `daq=1`.

### `telemetry/health/detail`

```json
{"v":2,"sid":"7a8b9c0d","t":1790668800000,"usb":2,"sync":[true,true,true],"cpu":22.1,"mem":41.7,"disk_free":83.2,"throt":false,"uv":false,"tx":12.34,"rx":8.21,"adrop":0,"parse":0}
```

- `usb`: jumlah device USB yang terhitung, dapat `null`.
- `sync`: nilai DAQ untuk urutan `[frame, sample_delay, iq]`; tiap nilai dapat boolean atau `null`.
- `cpu`, `mem`, `disk_free`: persentase.
- `throt`, `uv`: flag throttling dan undervoltage, dapat `null` bila tidak terbaca.
- `tx`, `rx`: trafik interface dalam kbit/s, dapat `null`.
- `adrop`: jumlah frame angular yang dibatalkan Edge.
- `parse`: jumlah error parse source.

Detail tidak menggantikan gate health utama. Ground saat ini menyimpan detail terpisah dari validasi DoA/Angular.

### `state`

```json
{"v":2,"sid":"7a8b9c0d","boot":"10aa2345-6789-4abc-9def-1234567890ab","instance":"8a5bb269-73fd-4cbb-9c6b-a3327f679221","t":1790668800123,"run":"RUNNING","daq":true,"cfg":7,"profile":"balanced","clock":"SYNCED"}
```

`run` adalah state processing berupa string; `daq` adalah boolean ringkas; `cfg` revision konfigurasi; `profile` profile saat ini; `clock` state clock. `state.daq=false` tidak membedakan degraded dan unknown. Gunakan `telemetry/health.daq` untuk enum health dan freshness. Ground memakai `sid` bersama `boot` dan `instance` untuk memeriksa identitas sesi.

### `capabilities`

```json
{"v":2,"sid":"7a8b9c0d","boot":"10aa2345-6789-4abc-9def-1234567890ab","instance":"8a5bb269-73fd-4cbb-9c6b-a3327f679221","version":"1.0.0","mode":"read_only","codecs":["q16","u8"],"angle":"theta_mirror","native_axis":1,"count":360,"profiles":["control","balanced","graph_u8"],"scope":"SDR_STACK","helper_available":true,"maintenance":false,"remote_commands":false,"config_patch":false,"processing":false,"restart":false,"reboot":false}
```

Capability boolean (`remote_commands`, `config_patch`, `processing`, `restart`, `reboot`) adalah izin/runtime availability yang dilaporkan node, bukan otorisasi broker. Ground harus cek capability sebelum menampilkan atau mengirim mutation. Nilainya dapat berbeda antar perangkat karena approval lokal. Profile yang didukung saat ini:

| Profile | DoA | Angular |
|---|---|---|
| `control` | sekitar 1 s | tidak dipublish |
| `balanced` | sekitar 1 s | Q16 sekitar 4 s |
| `graph_u8` | sekitar 1 s | U8 sekitar 2 s |

Interval hanya berlaku saat data valid, client siap, scheduler stabil, dan gate receipt/command mengizinkan bulk. Ini bukan jaminan rate aktual.

### `config/reported`

```json
{"v":2,"sid":"7a8b9c0d","rev":7,"t":1790668800123,"proof":"source_correlated","digest":"<safe-settings-digest>","effective":{"center_frequency_hz":433920000,"gain_db":20.7,"vfo0_frequency_hz":433920000,"vfo0_bandwidth_hz":125000,"vfo0_squelch_db":-20.0,"ant_arrangement":"<native-value>","doa_method":"<native-value>","active_vfos":1,"output_vfo":0,"en_doa":true}}
```

`effective` hanya berisi field safe yang tersedia dari source. Nama yang dapat muncul: `center_frequency_hz`, `gain_db`, `vfo0_frequency_hz`, `vfo0_bandwidth_hz`, `vfo0_squelch_db`, `ant_arrangement`, `doa_method`, `active_vfos`, `output_vfo`, `en_doa`. Field dapat tidak ada bila source tidak menyediakannya. Tidak ada secret atau dump semua native settings.

`proof` melaporkan `unverified`, `source_correlated`, `runtime`, atau `persisted_unverified` sesuai bukti yang tersedia. `digest` mengidentifikasi safe settings, bukan bukti semua parameter sudah diterapkan runtime. `config.get` meminta report baru. Perubahan `rev` membuat Ground membuang DoA/Angular lama sebelum menerima data dari revision baru.

### `availability`

Saat Control siap, retained publish:

```json
{"v":2,"sid":"7a8b9c0d","online":true,"t":1790668800123}
```

Last Will saat koneksi MQTT hilang:

```json
{"v":2,"sid":"7a8b9c0d","online":false,"reason":"CONNECTION_LOST"}
```

Availability adalah nilai terakhir, bukan heartbeat dan bukan bukti DAQ sehat. Tetap cek `state`, `health`, timestamp, dan receipt.

### `telemetry/angular` (binary)

Setiap message membawa satu chunk binary little-endian. Envelope 12 byte memakai format `<IIBBH`:

| Bagian | Tipe | Makna |
|---|---|---|
| `sid` | `u32` | Alias session yang sama dengan `sid` JSON. |
| `q` | `u32` | Sequence record angular. |
| `index` | `u8` | Index chunk, mulai dari 0. |
| `count` | `u8` | Jumlah chunk frame. |
| `total` | `u16` | Panjang frame sebelum dipecah. |
| body | bytes | Potongan frame RDF2. |

Setelah semua chunk terkumpul, frame dimulai dengan header 48 byte `<4sBBHIIQIIBBHffHh`, lalu 360 sampel:

| Field header | Makna |
|---|---|
| magic, version, encoding | `RDF2`, versi `2`, encoding `1` Q16 atau `2` U8. |
| flags | Bit parsed/fresh/DAQ/convention/config; nilai live yang diterima Ground saat ini harus `31`. |
| sid, q, timestamp | Identitas sesi, sequence dan source timestamp. |
| frequency, revision, vfo | Frekuensi Hz, revision (`0xffffffff` berarti unknown), dan index VFO. |
| convention, count | Konvensi angle dan jumlah sampel, wajib `360`. |
| scale, offset | Parameter decode sampel. |
| raw DoA, confidence | Derajat x100 (`65535` berarti unknown), confidence dB x100 (`-32768` berarti unknown). |

Ukuran dan encoding:

- Q16: Frame 768 byte. Sample signed `int16` little-endian, scale `0.01`, offset `0`, range `-327.67` sampai `327.67`; sample `-32768` invalid dan overflow ditolak tanpa clipping. Dua chunk, masing-masing 396 byte termasuk envelope, total 792 byte.
- U8: Frame 408 byte dengan 360 unsigned byte dan scale/offset per frame. Satu chunk berukuran 420 byte termasuk envelope. Array konstan memakai scale `0` dan nilai setiap sampel sama dengan offset.
- Array hasil decode adalah 360 nilai kuantisasi, bukan CSV lossless. Konvensi native index tidak otomatis dikonversi ke true north.

Contoh decode di Ground:

```python
from rdf_node.codec import Assembler

assembler = Assembler()
for payload in mqtt_payloads:  # payload adalah bytes dari telemetry/angular
    frame = assembler.add(payload)
    if frame is None:  # frame belum lengkap
        continue
    assert len(frame['values']) == 360
    print({key: frame[key] for key in (
        'encoding', 'sid', 'q', 'timestamp_ms', 'frequency_hz', 'revision',
        'raw_doa_deg', 'confidence_native_db', 'peak_index',
    )})
```

Ground menunggu seluruh frame, memeriksa `sid`, `flags==31`, revision, source age maksimum 10 s, health fresh dengan `daq=1`, dan sequence yang maju. Fragment parsial tidak boleh ditampilkan. Assembler menerima maksimal dua frame incomplete dan membuang frame setelah deadline 3 s.

## Payload Ground -> Edge

### `ground/receipt`

```json
{"v":2,"sid":"7a8b9c0d","dq":1245,"hq":86,"aq":1238,"rev":7}
```

- `hq`: sequence health terakhir yang diterima.
- `dq`: sequence DoA terakhir yang diterima, `0` bila belum ada.
- `aq`: sequence angular terakhir yang selesai dirakit dan lolos gate, `0` bila belum ada.
- `rev`: revision config report yang digunakan Ground; dapat `null` sebelum report diterima.

Ground mengirim receipt sekitar tiap 5 s selama health-nya masih fresh (<8 s). Edge menolak retained receipt, `sid` berbeda, sequence yang tidak pernah dikirim, dan `hq` yang mundur. Saat `require_ground_receipt_for_bulk` aktif (default), Edge menahan Angular sampai receipt baru diterima. Receipt membuktikan pemrosesan aplikasi Ground, bukan MQTT PUBACK dan bukan bukti operator melihat dashboard.

### Command envelope

Semua command memakai envelope v2 berikut. Ground harus mengisi identitas dan revision yang benar-benar terakhir diterima; contoh ini fixture dan jangan dikirim mentah.

```json
{"v":2,"id":"g01-00001234","sid":"7a8b9c0d","boot":"10aa2345-6789-4abc-9def-1234567890ab","issued_ms":1790668800123,"expires_ms":1790668815123,"base_rev":7,"op":"config.patch","changes":{"center_frequency_hz":433920000,"vfo0_frequency_hz":433920000}}
```

| Field | Makna |
|---|---|
| `id` | ID unik, dipakai ulang tanpa perubahan payload untuk retry intent yang sama. |
| `sid`, `boot` | Identitas sesi dan boot yang terakhir diterima dari `state`. |
| `issued_ms`, `expires_ms` | Deadline epoch ms. TTL harus positif dan maksimum 30 s; Ground default 15 s. |
| `base_rev` | Revision safe config yang diamati Ground; wajib cocok untuk mutation. |
| `op` | Nama operation. Topic command wajib cocok dengan mapping di bawah. |
| operation field | Salah satu `changes`, `desired`, `profile`, `target_id`, `prepare_id`, `challenge`, sesuai operation. Unknown field ditolak. |

| Topic suffix | `op` | Field tambahan |
|---|---|---|
| `cmd/config/get` | `config.get` | Tidak ada. Read-only; meminta report config baru. |
| `cmd/config/patch` | `config.patch` | `changes`: object tidak kosong dengan subset `center_frequency_hz`, `gain_db`, `vfo0_frequency_hz`, `vfo0_bandwidth_hz`, `vfo0_squelch_db`. |
| `cmd/processing/set` | `processing.set` | `desired`: `RUNNING` atau `STOPPED`. |
| `cmd/service/restart` | `service.restart` | Tidak ada. Hanya unit SDR stack yang di-approve. |
| `cmd/system/reboot/prepare` | `system.reboot.prepare` | Tidak ada. ACK mengembalikan `prepare_id`, `challenge`, `valid_seconds` (30). |
| `cmd/system/reboot/execute` | `system.reboot.execute` | `prepare_id` dan `challenge` dari ACK prepare yang masih berlaku. Challenge sekali pakai; jangan log atau simpan sebagai credential permanen. |
| `cmd/operation/get` | `operation.get` | `target_id`: ID operation yang ditanya. Read-only. |
| `cmd/stream/set` | `stream.set` | `profile`: `control`, `balanced`, atau `graph_u8`. |

Command selain `config.get` dan `operation.get` subject ke identity, boot, deadline, clock trusted, revision dan capability/policy lokal. Perintah mutation tidak diaktifkan hanya karena topic dapat dipublish. Konfigurasi default bersifat read-only. Retained command ditolak. Jika `id` sama dan payload sama, Edge mengembalikan progress/hasil jurnal tanpa menjalankan ulang; `id` sama dengan payload berbeda adalah conflict.
`config.patch` hanya menerima field safe pada tabel. Saat mengganti `center_frequency_hz`, sertakan `vfo0_frequency_hz` dengan target yang sama; batas frekuensi, bandwidth dan gain berasal dari policy helper lokal.

## ACK command dari Edge

`config.*` dibalas di `ack/config`; operation lain di `ack/operation`. ACK QoS 1, tidak retained, expiry 30 s.

```json
{"v":2,"sid":"7a8b9c0d","id":"g01-00001234","status":"APPLIED","t":1790668804123,"rev":8,"result":{"revision":8,"proof":{"center_frequency_hz":"FRESH_DAQ_RF_CENTER","vfo0_frequency_hz":"FRESH_DOA_FREQUENCY"},"persisted":true}}
```

`result` bergantung pada operation. `config.get` mengembalikan `revision` dan `proof`, serta memicu report terbaru ke `config/reported`. `operation.get` mengembalikan `operation` berupa record operation publik atau `null`. Error biasanya berisi `{"error":"ERROR_CODE"}`.
Status yang dikenal jurnal mencakup `ACCEPTED`, `APPLYING`, `VERIFYING`, `REBOOT_SCHEDULED`, `APPLIED`, `FAILED`, `REJECTED`, `EXPIRED`, `CONFLICT`, `PERSISTED_UNVERIFIED`, `OUTCOME_UNKNOWN`, dan `CANCELLED`.

`PERSISTED_UNVERIFIED` berarti perubahan tersimpan tetapi bukti runtime belum lengkap. `OUTCOME_UNKNOWN` berarti hasil side effect belum diketahui, bukan bukti gagal atau berhasil. Ground tidak boleh mengubah dua status ini menjadi sukses/gagal pasti atau mengulang mutation dengan ID baru tanpa rekonsiliasi.

## ACL minimum Ground

| Credential / role | Hak topic minimum |
|---|---|
| Edge Control | Publish topic operasional, ACK dan availability milik node sendiri; subscribe `sdr/v2/{node_id}/cmd/#` dan `sdr/v2/{node_id}/ground/receipt`. |
| Edge Bulk | Publish hanya `sdr/v2/{node_id}/telemetry/angular`. |
| Ground controller | Subscribe topic operasional/ACK node; publish `sdr/v2/{node_id}/cmd/#` dan `sdr/v2/{node_id}/ground/receipt`. |
| Ground viewer | Subscribe saja; tanpa hak publish command dan tanpa credential controller. |

Prefix, `node_id`, ACL, broker, credential dan konfigurasi Edge/Ground harus cocok. Jangan memberi hak wildcard lintas node bila Ground hanya mengelola satu node. Pada broker yang mengizinkan anonymous CONNECT, ACL tetap wajib membatasi operasi yang dapat dilakukan client.

## Referensi implementasi

- `src/rdf_node/agent.py`: topic Edge, payload JSON, jadwal publish, receipt dan capability.
- `src/rdf_node/ground.py`: subscription, validasi telemetry, assembly Angular, receipt dan command publish.
- `src/rdf_node/control.py`: daftar operasi, envelope validation, idempotency dan ACK.
- `src/rdf_node/codec.py`: format binary RDF2 dan chunk Angular.
- `docs/PROTOCOL.md`: kontrak wire dan batas freshness.
- `docs/MQTT_GROUND.md`: transport, provisioning dan ACL Ground.
