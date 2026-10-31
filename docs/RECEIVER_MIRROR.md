# Kontrak mirror Receiver

| | |
|---|---|
| Issue | #15 (Receiver dari host lain dan tablet) |
| Fase 1 (dokumen ini) | Kontrak state, frame, revisi, heartbeat, aturan basi, dan desain perintah |
| Fase 2 (B1) | **Terpasang**: relay di server console dan penampil MIRROR di mode LAN lihat-saja |
| Penanda dari tablet | **Terpasang** (keputusan pemilik 2026-10-31, bagian 8a): tambah dan hapus penanda Receiver lewat listener LAN HTTP, tanpa login. Satu-satunya penulisan dari mode LAN |
| Fase 3 (B2) | **Desain saja, belum diimplementasikan** (bagian 9) untuk semua perintah lain. Menunggu keputusan HTTPS di LAN |
| Fase 0 | Kit uji C-lite di `packaging/receiver-engine/` (belum dijalankan, tidak dipasang installer mana pun) |
| Fase 4 dan 5 | Belum dikerjakan (bagian 10) |

## Ringkasnya

RadioSpectrum (HackRF) hanya bisa dibuka satu proses. Di v2 yang membukanya adalah frame Receiver di halaman console groundstation (WebUSB). Mirror memindahkan **apa yang ditampilkan** Receiver itu ke host lain, tanpa memindahkan radionya:

```text
halaman console groundstation (sumber, kind "kiosk-tab")
  frame Receiver ── receiverBridge (postMessage) ── lib/receiverMirrorPublisher.ts
      │  POST /api/mirror/receiver   (loopback, same-origin, ≤ 8 KiB, ≤ 12/detik)
      ▼
server console: tools/receiver_mirror.py  (memori saja, yang terbaru menang)
      │  GET /api/mirror/receiver    (listener loopback dan listener LAN)
      ▼
penampil di mode LAN lihat-saja: lib/receiverMirrorFeed.ts
  dock Spektrum (MIRROR) dan rute Receiver (state + spektrum + penanda), tanpa audio

penanda dari tablet (bagian 8a):
  tablet ── POST /api/mirror/receiver/markers ──▶ antrean server (≤ 16, 15 detik)
  antrean ── jawaban POST /api/mirror/receiver ──▶ publisher ── console:marker-add|remove ──▶ frame Receiver
  publisher ── hasil di POST berikutnya ──▶ server ◀── GET /api/mirror/receiver/markers/<id> ── tablet
```

Kontraknya tidak bergantung pada sumber: tab engine khusus (fase 4) atau proses server (varian C penuh) cukup mengirim body yang sama dengan `source.kind` lain. Penampil dan server tidak berubah.

Istilah:

| Istilah | Artinya |
|---|---|
| **Sumber** | Satu halaman yang memegang RadioSpectrum dan mengirim state serta frame. Fase 2: halaman console di groundstation (`kiosk-tab`). |
| **Server** | Proses console (`tools/ground_console.py`). Menyimpan post terakhir di memori dan melayani pembacanya. |
| **Penampil** | Halaman console di mode LAN lihat-saja (tablet, komputer lain). Hanya membaca. |

## 1. Sumber

- Sumber fase 2 adalah halaman console yang memasang frame Receiver (rute Receiver dibuka, atau Mulai/Dengar di dock Spektrum). Publisher berjalan selama frame itu terpasang, dan hanya mengirim selama **mode LAN lihat-saja terbuka** (`lan_access` dengan `state: "open"`).
- Publisher mendengar bridge: state lewat `onState`, daftar penanda dari `BridgeState.markers`, frame lewat `onSpectrum`, dengan langganan miliknya sendiri (`subscribe(..., 'mirror')`). Bridge menggabungkan langganan dock dan mirror menjadi satu `console:subscribe` (frame mengalir selama salah satunya meminta; bin dan fps terbesar; span milik dock bila dock meminta). Satu-satunya perintah yang dikirim publisher ke frame adalah `console:marker-add` dan `console:marker-remove`, untuk perintah penanda tablet yang diserahkan server (bagian 8a); tune, gain, pindai, dengar dan pengaturan tidak pernah. Protokol bridge di `CLAUDE.md` tidak berubah.
- Identitas sumber dikirim di setiap post sebagai `source`:

| Field | Tipe | Arti |
|---|---|---|
| `id` | string `^[A-Za-z0-9_-]{8,64}$` | Acak per pemuatan halaman (`kiosk-` + 16 karakter). Halaman yang dimuat ulang adalah sumber baru. |
| `kind` | `"kiosk-tab"` atau `"engine-tab"` | `engine-tab` dicadangkan untuk fase 4. |
| `visible` | boolean | Halaman sumber terlihat. Halaman tersembunyi tidak mengirim frame. |

- Satu sumber pada satu waktu. Post terbaru menang; post dari `id` lain membuang frame sumber sebelumnya. Dua halaman console yang sama-sama memasang Receiver akan bergantian menjadi sumber, jadi buka Receiver di satu halaman groundstation saja.
- Tanpa bridge yang siap (frame belum menjawab `hello`) tidak ada state, jadi tidak ada post. Penampil lalu melihat sumber putus setelah 10 detik.

## 2. State

Semua frekuensi dalam Hz integer **frekuensi tampilan** (Freq Shift sudah ditambahkan), sama dengan bridge. Nama field snake_case.

| Field | Tipe | Arti |
|---|---|---|
| `rev` | integer ≥ 0 | Revisi state milik sumber. Naik setiap ada perubahan selain `rev` dan `t_ms` (termasuk `source.visible`). |
| `t_ms` | integer | Waktu status di jam sumber (`Date.now()`); hanya informasi, umur dihitung server. |
| `connected` | boolean | RadioSpectrum tersambung. |
| `running` | boolean | RX berjalan. |
| `recording` | boolean | Rekaman audio VFO aktif. |
| `mock` | boolean | Mock SDR (bukan radio). |
| `busy` | `none`, `sweep`, `scan-listen` | Pindai lebar berjalan, atau Receiver mendengarkan kandidat pindai. |
| `center_hz` | integer atau null | Frekuensi tengah RX. |
| `sample_rate_hz` | integer 1..100 000 000 atau null | Sample rate RX. |
| `span_hz` | integer atau null | Lebar frame RX: min(2 MHz, sample rate). |
| `frequency_shift_hz` | integer | Freq Shift (upconverter); bisa negatif. |
| `gains` | `{lna_db, vga_db, amp}` | Gain RX (dB atau null, amp boolean). Pindai lebar memakai gain-nya sendiri, `scan.gains`. |
| `vfo` | objek atau null | VFO aktif: `index` (0..63), `enabled`, `mode` (`nfm`, `wfm`, `am`, `usb`, `lsb`, `dsb`, `cw`, `raw` atau null), `frequency_hz`, `bandwidth_hz`, `squelch_enabled`, `squelch_db`. |
| `scan` | objek atau null | Pindai lebar: `phase` (`idle`, `starting`, `active`, `stopping`), `start_hz`, `stop_hz`, `resolution_hz`, dan `gains` (`{lna_db, vga_db, amp}` seperti gain RX, atau null): LNA, VGA dan +14 dB milik pindai sendiri. `gains` boleh tidak ada (halaman groundstation yang dimuat sebelum field ini ada) dan disimpan sebagai null, supaya halaman itu tetap mengirim sampai dimuat ulang. |
| `error` | `USB_LOST`, `RX_ERROR`, `NO_WEBUSB` atau null | Kode error status Receiver. |

Tidak ada nama perangkat, teks notice, atau teks bebas lain di state.

## 3. Frame spektrum

| Field | Tipe | Arti |
|---|---|---|
| `seq` | integer ≥ 0 | `seq` frame bridge (dipakai bersama RX dan pindai). |
| `t_ms` | integer | Waktu frame di jam sumber. |
| `kind` | `rx` atau `sweep` | Frame RX (2 MHz di sekitar tengah) atau frame pindai lebar. |
| `center_hz` | integer | Tengah frame; untuk `sweep` titik tengah rentang. Harus di antara `start_hz` dan `stop_hz`. |
| `start_hz`, `stop_hz` | integer | Tepi bawah dan tepi atas (eksklusif), `stop_hz > start_hz`. |
| `bin_count` | integer 16..512 | Jumlah bin. |
| `db_min`, `db_max` | angka -200..100 | Rentang dB yang dinyatakan frame, `db_max - db_min ≥ 1`. |
| `bins` | string base64 | Tepat `bin_count` byte. |

Pengkodean (`lib/receiverMirror.ts`):

1. Frame bridge (bin `Float32Array` dB, sampai 2048) dikecilkan dengan **max-hold** ke paling banyak 512 bin: tiap bin keluaran adalah bin terkuat dari kelompoknya.
2. Rentang dB per frame: dB bulat di bawah bin terlemah dan di atas bin terkuat yang punya daya (level lantai -200 dB tidak dihitung), minimal 10 dB, dijepit ke -200..100.
3. Tiap bin menjadi satu byte `v = round((dB - db_min) / (db_max - db_min) × 255)`, dijepit 0..255; nilai tak hingga menjadi 0.
4. Penampil membaca kembali `dB = db_min + v / 255 × (db_max - db_min)`. Galat paling besar setengah langkah, misalnya 0,2 dB untuk rentang 100 dB.

512 byte menjadi 684 karakter base64; satu body lengkap (state + frame) sekitar 2 KiB.

## 4. `POST /api/mirror/receiver`

Hanya dari halaman console sendiri. Body:

```json
{
  "v": 1,
  "source": {"id": "kiosk-3k9x0q1m2n4p5r6s", "kind": "kiosk-tab", "visible": true},
  "state": {"rev": 7, "t_ms": 1761000000000, "connected": true, "running": true, "recording": false, "mock": false,
            "busy": "none", "center_hz": 433920000, "sample_rate_hz": 10000000, "span_hz": 2000000,
            "frequency_shift_hz": 0, "gains": {"lna_db": 16, "vga_db": 20, "amp": false},
            "vfo": {"index": 0, "enabled": true, "mode": "nfm", "frequency_hz": 433925000, "bandwidth_hz": 12500,
                    "squelch_enabled": false, "squelch_db": -60.5},
            "scan": {"phase": "idle", "start_hz": 400000000, "stop_hz": 500000000, "resolution_hz": 4882.8125,
                     "gains": {"lna_db": 24, "vga_db": 30, "amp": true}},
            "error": null},
  "frame": {"seq": 7, "t_ms": 1761000000007, "kind": "rx", "center_hz": 433920000, "start_hz": 432920000,
            "stop_hz": 434920000, "bin_count": 512, "db_min": -120, "db_max": -20, "bins": "…684 karakter…"}
}
```

`frame` boleh tidak ada atau `null` (post state saja, termasuk heartbeat). Dua bagian lain juga opsional (bagian 8a): `markers`, daftar penanda Receiver (tidak ada: daftar tersimpan tetap; `null`: dikosongkan), dan `results`, hasil perintah penanda yang sudah dijalankan halaman ini. Contoh lengkap yang diperiksa kedua sisi: `tools/fixtures/receiver-mirror/publish.json`.

Pemeriksaan, berurutan; yang pertama gagal menentukan jawaban. Semua error berbentuk `{"ok": false, "code": ..., "error": ...}` dan tidak masuk daftar kode Kontrol:

| Urutan | Syarat | Jawaban bila gagal |
|---|---|---|
| 1 | Header `Origin` loopback same-origin, host dan port persis console | `403 ORIGIN_REJECTED` |
| 2 | `Content-Length` paling banyak 8192 byte | `413 MIRROR_TOO_LARGE` |
| 3 | Paling banyak 12 post lolos pemeriksaan laju dalam satu detik mana pun (post yang ditolak karena laju tidak dihitung) | `429 MIRROR_RATE_LIMITED` |
| 4 | Mode LAN lihat-saja terbuka | `409 MIRROR_LAN_CLOSED` |
| 5 | Skema ketat: JSON UTF-8 tanpa NaN/Infinity, field persis seperti bagian 2 dan 3 (field asing, field hilang, tipe salah, boolean sebagai angka, nilai di luar rentang, termasuk bilangan bulat yang melampaui float, ditolak seluruhnya; JSON yang bersarang terlalu dalam juga tidak valid) | `400 MIRROR_INVALID` dengan nama field pertama yang salah |

Berhasil: `200 {"ok": true, "rev": <post ke-n>, "frame_rev": <frame ke-n>, "commands": [...]}`. `commands` berisi perintah penanda tablet yang menunggu, masing-masing diserahkan sekali (bagian 8a); biasanya kosong. Body yang panjangnya dalam batas dibaca dulu sebelum jawaban apa pun, juga penolakan, supaya klien membaca jawabannya, bukan reset koneksi. Listener LAN tidak pernah menerima POST ini (`405 LAN_READ_ONLY`).

Tidak ada yang ditulis ke disk. Post terbaru menggantikan yang sebelumnya; restart console, atau listener LAN yang ditutup, dipindah, atau dimatikan, mengosongkannya. Pengosongan itu dan penolakan post berikutnya satu langkah (`ReceiverMirror.close()` di bawah kunci manajer LAN): post yang sudah lolos pemeriksaan 4 tetapi baru disimpan setelah mode LAN ditutup dijawab `409 MIRROR_LAN_CLOSED` dan tidak disimpan. Jawaban 200 dan 429 tidak dicatat di log console (route ini dipanggil beberapa kali per detik); penolakan lain dicatat.

## 5. `GET /api/mirror/receiver`

Dilayani listener loopback dan listener LAN (masuk daftar route LAN), masing-masing dengan aturan bacanya sendiri. Permintaan yang gagal dijawab `403 ORIGIN_REJECTED`:

- Listener loopback memakai aturan baca Receiver, sama dengan `/api/receiver/*`: `Sec-Fetch-Site` tidak ada, `none`, atau `same-origin`, dan tepat satu `Host` berupa nama loopback (`127.0.0.1`, `localhost`, `[::1]`) di port console. Mirror membawa apa yang ditampilkan Receiver (frekuensi, mode, gain, status rekam, spektrum), jadi situs lain, halaman dari port localhost lain, dan halaman DNS rebinding (yang mengirim nama host-nya sendiri) tidak bisa membacanya.
- Listener LAN memakai aturan `Host`-nya sendiri (alamat IP, atau nama komputer ini, di port LAN) dan hanya menolak `Sec-Fetch-Site: cross-site`, seperti `/api/tiles`.

Route `/api/receiver/*` tetap tertutup dari LAN kecuali route baca Rekaman (tab Rekaman di tablet, lihat bagian 8); prefix `/api/mirror/` dipilih justru supaya daftar route LAN tidak perlu membuka route Receiver lain.

```json
{
  "ok": true, "v": 1,
  "rev": 42, "frame_rev": 40,
  "source": {"id": "kiosk-3k9x0q1m2n4p5r6s", "kind": "kiosk-tab", "visible": true},
  "source_age_ms": 120,
  "state": { … bagian 2 … }, "state_age_ms": 120,
  "frame": { … bagian 3 … }, "frame_age_ms": 180,
  "markers": { … bagian 8a … },
  "limits": {"frame_stale_ms": 3000, "source_lost_ms": 10000, "heartbeat_ms": 500,
             "max_bins": 512, "max_body_bytes": 8192, "max_posts_per_s": 12}
}
```

Umur dihitung dengan jam monotonic server sejak post diterima, jadi jam sumber dan jam penampil tidak berpengaruh. Sebelum ada post, `source`, `state`, `frame`, `markers` dan umurnya `null`.

## 6. Revisi, heartbeat, dan aturan basi

| Nilai | Pemilik | Arti |
|---|---|---|
| `state.rev` | sumber | Naik setiap state berubah. Fase 3 memakainya sebagai revisi dasar perintah. |
| `frame.seq` | sumber (bridge) | Urutan frame; satu deret untuk RX dan pindai. |
| `rev` | server | Jumlah post yang diterima (termasuk heartbeat). |
| `frame_rev` | server | Jumlah frame yang diterima. Penampil menggambar satu baris waterfall per `frame_rev` baru. |

- **Laju sumber**: paling banyak satu post per 200 ms (5 per detik) dan satu yang sedang berjalan. Post membawa state sekarang dan frame terbaru yang belum terkirim; frame yang lebih tua dibuang, tidak diantre. Post dikirim saat ada frame baru, state berubah, atau heartbeat jatuh tempo.
- **Heartbeat**: state dikirim paling lambat tiap 500 ms walaupun tidak ada perubahan dan tidak ada frame (RX berhenti). Perintah penanda tablet diserahkan di jawaban post, jadi heartbeat ini juga batas tunggu perintah itu saat RX berhenti (sampai 3.2.0 heartbeat 2 detik). Hasil perintah penanda dikirim pada slot post berikutnya (200 ms), tanpa menunggu heartbeat.
- **Setelah penolakan**: 429, 400, atau gagal jaringan membuat sumber menunggu 1 detik, lalu dua kali lipat sampai 10 detik. `409 MIRROR_LAN_CLOSED` menghentikan post dan langganan frame; sumber lalu menanyakan `/api/health` tiap 10 detik sampai `lan_access.state` kembali `open`.
- **Penampil**: membaca GET tiap 200 ms selama dock MIRROR, atau tab **Mirror** di rute Receiver (tab **Rekaman** tidak membacanya), tampil dan halaman terlihat, tiap 1 detik selama sumber putus, dan 1, 2, lalu 5 detik setelah baca gagal. Umur dihitung terus dari jawaban terakhir.

Aturan basi (`mirrorView()` di `lib/receiverMirror.ts`, berurutan):

| Keadaan | Syarat | Chip dock |
|---|---|---|
| Belum ada jawaban | — | `…` |
| Tidak ada sumber | `source` atau `state` null | **SUMBER PUTUS** (EN: SOURCE LOST) |
| Sumber putus | tidak ada post lebih dari 10 detik (juga bila console tidak menjawab) | **SUMBER PUTUS** |
| Basi | frame diharapkan (RX berjalan, atau pindai `active`) tetapi frame lebih tua dari 3 detik, tidak ada, atau jenisnya lain | `STALE` |
| Live | frame diharapkan dan umurnya paling lama 3 detik | `RX`, `SCAN`, atau `BUSY` (scan listen) |
| Pindai mulai atau berhenti | `scan.phase` `starting` atau `stopping` | `…` |
| Berhenti | RX tidak berjalan dan tidak memindai | `SCAN OFF` (mode Spektrum) bila frame terakhir dari pindai, selain itu `RX OFF` |

RX yang berhenti bukan basi: tidak ada frame yang diharapkan, chip `RX OFF`, dan jejak terakhir tetap tergambar redup. Setelah pindai berhenti, bridge melaporkan `busy: "none"` dan `scan.phase: "idle"`; penampil mengambil mode dari frame terakhir, jadi jejak pindai yang redup tetap di mode Spektrum dengan chip `SCAN OFF`, seperti dock groundstation. Penampil yang baru dibuka setelah pindai berhenti juga menggambar frame pindai terakhir itu: canvas menahan frame mode lain sampai render berikutnya (`createFrameGate()` di `lib/spectrumView.ts`) dan menggambarnya bila render itu sudah di mode frame tersebut, jadi frame pertama mode baru tidak hilang.

Selama pindai `starting`, `active` atau `stopping`, baris LNA, VGA dan +14 dB di rute Receiver menampilkan gain pindai (`scan.gains`, berlabel "· pindai"), dan baris info dock di mode Spektrum menampilkan gain yang sama seperti dock groundstation; gain RX tidak pernah ditampilkan sebagai gain pindai. Bila halaman groundstation tidak mengirim `scan.gains`, nilainya `—`.

Tombol Mulai/Berhenti dock MIRROR (nonaktif) mengikuti state terakhir seperti dock groundstation, bukan umur frame: Berhenti selama pindai `starting` atau `active` dan selama RX berjalan di luar scan listen, juga saat chip `STALE` atau **SUMBER PUTUS**; kesegaran hanya ditunjukkan chip.

**Frame hanya mengalir selama halaman console groundstation terlihat.** Halaman tersembunyi (tab lain, jendela diminimalkan) tidak meminta frame dan mengirim `source.visible: false`, sehingga penampil menampilkan `STALE` dengan "Halaman groundstation tersembunyi; frame berhenti." Chrome juga bisa memperlambat timer di tab tersembunyi (sampai sekitar sekali per menit setelah beberapa menit tersembunyi), sehingga heartbeat bisa terlambat dan penampil menampilkan **SUMBER PUTUS**. Fase 0 dan 4 (tab engine khusus) dibuat untuk masalah ini.

## 7. Ukuran dan laju

| | Nilai |
|---|---|
| Body post maksimum | 8 KiB (diterima server); body nyata sekitar 2 KiB dengan frame, 0,7 KiB tanpa frame, ditambah sekitar 70 byte per penanda |
| Post | ≤ 5 per detik dari publisher, paling sedikit 2 per detik (heartbeat 500 ms); server menerima ≤ 12 per detik |
| Frame | ≤ 512 bin u8, ≤ 5 per detik |
| Lalu lintas sumber ke server | sekitar 10 KiB/detik (loopback) |
| Lalu lintas per penampil | sekitar 10 KiB/detik selama RX berjalan (5 GET per detik, satu koneksi HTTP/1.0 per GET) |
| Memori server | satu state dan satu frame (beberapa KiB) |

Listener LAN melayani paling banyak 32 permintaan sekaligus; beberapa tablet yang masing-masing membaca 5 kali per detik jauh di bawah batas itu.

## 8. Batas

- Mirror adalah tampilan, kecuali penanda (bagian 8a). Tidak ada perintah lain ke Receiver, tidak ada audio langsung, tidak ada rekaman. Semua kontrol radio di dock MIRROR terlihat dengan statusnya tetapi nonaktif, dan kanvasnya tidak pernah menala atau menerima tombol panah; hanya tombol **Penanda** yang bekerja.
- Frame Receiver tidak pernah dipasang di mode LAN lihat-saja (RadioSpectrum ada di USB groundstation).
- Tidak ada yang ditulis ke disk oleh server, dan tidak ada data rahasia di state. Penanda dari tablet masuk daftar Receiver dan disimpan ke set penanda yang dipilih oleh halaman groundstation sendiri, seperti penanda dari dock groundstation.
- Satu-satunya penulisan dari mode LAN adalah `POST /api/mirror/receiver/markers` (bagian 8a). `POST /api/mirror/receiver` hanya lewat loopback; dari LAN hanya GET-nya dan GET status perintah penanda.
- Rekaman yang sudah tersimpan dibaca terpisah dari mirror, lewat tab **Rekaman** di rute Receiver tablet: hanya `GET` `/api/receiver/archive/{facets,calendar,timeline,items}`, `archive/scans/<id>/preview`, `archive/audio/<id>/download`, `archive/scans/<id>/download` dan `audio-segments/<id>/audio` (putar, dengan Range), dicocokkan persis dengan UUID rekaman (`lan_access.records_route()`). Aturan bacanya: aturan `Host` LAN dan `Sec-Fetch-Site` tidak ada, `none` atau `same-origin` (lebih ketat dari route LAN lain). Batasnya: satu bacaan daftar per klien (yang kedua menunggu sampai 5 detik, lalu `429 LAN_RECORDS_BUSY`), paling banyak 50 baris per halaman, 4 unduhan atau pemutaran per klien, satu ZIP pindai untuk seluruh LAN di luar dua slot groundstation, dan `HEAD` pada unduhan dan pemutaran dijawab `405`. Setiap penolakan atas `GET` berbentuk `{ok: false, code, error}` dan tidak ada yang menyebut path (hanya Range yang tidak bisa dipenuhi file dijawab `416` tanpa isi dengan `Content-Range`, sama seperti di loopback). Jawaban `HEAD` dari route Rekaman tidak punya isi: `HEAD` pada unduhan dan pemutaran mendapat `405` polos dengan `Allow: GET` (isi `LAN_READ_ONLY`-nya dibuang), dan `HEAD` yang ditolak `403` atau `429` hanya membawa statusnya. Kode LAN memakai kode dan teksnya sendiri: `403 LAN_READ_ONLY` untuk path di luar daftar, `429 LAN_RECORDS_BUSY` (teksnya berbeda untuk bacaan daftar dan untuk unduhan atau pemutaran) dan `403 ORIGIN_REJECTED` dengan teks mode LAN, bukan teks loopback: `Host` di luar aturan LAN atau permintaan cross-site ditolak sebelum route dengan teks umum mode LAN, dan hanya permintaan `same-site` yang sampai ke aturan baca Rekaman dan mendapat teks Rekaman. Route-nya menjawab dengan kode arsip: `ARCHIVE_INVALID_REQUEST` dengan teks kesalahan parameternya atau batas halaman, jadi teksnya berbeda-beda, dan `ARCHIVE_NOT_FOUND`, `ARCHIVE_FILE_MISSING`, `ARCHIVE_EXPORT_BUSY` dan `ARCHIVE_STORAGE_ERROR` dengan teks tetap. Pemutaran juga memakai kode arsip: segmen yang tidak ada, belum selesai atau gagal, dan file yang gagal dibuka (hilang, izin, I/O) dijawab `404 ARCHIVE_FILE_MISSING`; kesalahan database atau nama file tersimpan yang tidak sah dijawab `500 ARCHIVE_STORAGE_ERROR`. Bacaan dari LAN tidak menutup sesi rekaman yang macet. Pengaturan, set penanda, route pindai mentah, ekspor ZIP pilihan, hapus, retensi dan setiap penulisan tetap `LAN_READ_ONLY`.

## 8a. Penanda dari tablet

Keputusan pemilik 2026-10-31: orang di tablet boleh menambah dan menghapus penanda spektrum sementara operator groundstation memperhatikan DoA. Pengecualian ini sengaja sempit:

- **Hanya tambah dan hapus penanda**, ke daftar **Penanda spektrum** Receiver sendiri (`records.markers` di frame), bukan lapisan terpisah. Penanda tablet langsung tampil di dock Spektrum dan halaman Receiver groundstation, dan disimpan ke set penanda yang dipilih seperti biasa. Tune, gain, pindai, dengar dan pengaturan tetap tertutup dari LAN (fase 3).
- **Tanpa login**, seperti mirror: setiap klien di `allowed_clients` boleh menambah penanda dan menghapus penanda mana pun, termasuk buatan operator. Cookie tidak dibaca.
- **Lewat listener LAN HTTP yang sudah ada**, bukan listener HTTPS fase 3.

### 8a.1 `POST /api/mirror/receiver/markers`

Body, paling banyak 512 byte:

```json
{"v": 1, "id": "tab-k3m9x0q1n2p4r5s6", "op": "add", "frequency_hz": 433920000}
{"v": 1, "id": "tab-k3m9x0q1n2p4r5s7", "op": "remove", "marker_id": "m-12"}
```

`id` dipilih penampil secara acak (`^[A-Za-z0-9_-]{8,64}$`). `frequency_hz` adalah frekuensi tampilan dalam Hz integer (Freq Shift termasuk); jangkauan penanda (1–7250 MHz frekuensi perangkat) diperiksa frame Receiver, yang menjawab `OUT_OF_RANGE`. `marker_id` adalah id penanda dari daftar mirror (`^[A-Za-z0-9_-]{1,64}$`).

Pemeriksaan, berurutan; yang pertama gagal menentukan jawaban (`{"ok": false, "code", "error"}`):

| Urutan | Syarat | Jawaban bila gagal |
|---|---|---|
| 1 | Listener LAN: tepat satu `Origin`, yaitu `http://` dan `Host` permintaan itu (halaman LAN itu sendiri; `Host` dan `Sec-Fetch-Site` sudah diperiksa aturan LAN). Listener loopback (untuk test dan kesetaraan): `Origin` loopback same-origin | `403 ORIGIN_REJECTED` |
| 2 | `Content-Length` paling banyak 512 byte | `413 MIRROR_TOO_LARGE` |
| 3 | Paling banyak 4 perintah dari satu alamat klien dalam satu detik mana pun | `429 MIRROR_RATE_LIMITED` |
| 4 | Mode LAN terbuka | `409 MIRROR_LAN_CLOSED` |
| 5 | Skema ketat: field persis seperti di atas, `add` dengan `frequency_hz` saja, `remove` dengan `marker_id` saja | `400 MIRROR_INVALID` |
| 5a | Dari listener LAN: listener yang menerima klien ini masih listener yang terbuka sekarang. Setiap simpan (`allowed_clients`, port, bind) mengganti listener; permintaan yang body-nya tiba setelah itu, juga dari klien yang tidak diizinkan lagi, tidak diantrekan. Diperiksa di bawah kunci pengelola LAN, jadi tidak ada simpan di antara pemeriksaan dan antrean | `409 MIRROR_LAN_CLOSED` |
| 6 | Ada halaman groundstation yang mem-post dalam 10 detik terakhir | `409 MIRROR_NO_SOURCE` |
| 7 | `id` belum pernah dipakai | `409 MIRROR_DUPLICATE_ID` |
| 8 | Kurang dari 16 perintah menunggu atau sudah diserahkan tanpa hasil | `429 MIRROR_MARKER_BUSY` |

Berhasil: `202` dengan status perintah (bagian 8a.3). Listener LAN membuka **hanya** method dan path ini (`lan_access.WRITE_ROUTES`); `PUT`, `DELETE`, path lain, dan `POST` ke route mirror atau Receiver lain tetap `405 LAN_READ_ONLY`. Setiap perintah dicatat di log console dengan alamat klien (`lan 192.168.1.20 "POST /api/mirror/receiver/markers HTTP/1.1" 202`).

### 8a.2 Antrean, penyerahan, dan hasil

- Server menyimpan perintah di memori (`ReceiverMirror`), paling banyak 16 yang belum selesai. Setiap perintah kedaluwarsa 15 detik setelah diterima (`expired`); perintah yang kedaluwarsa sebelum diserahkan tidak pernah diserahkan, jadi tidak pernah dijalankan. Perintah yang sudah diserahkan lalu kedaluwarsa masih bisa dijalankan halaman itu (misalnya hasilnya tertahan karena post-nya ditolak dan menunggu backoff).
- Jawaban `200` dari `POST /api/mirror/receiver` berikutnya membawa perintah yang menunggu di `commands` (`{"id", "op": "add", "frequency_hz"}` atau `{"id", "op": "remove", "marker_id"}`), masing-masing **sekali**. Halaman mana pun yang mem-post boleh mengambilnya; jawaban yang hilang di jalan membuat perintahnya kedaluwarsa, tidak diserahkan lagi.
- Publisher menjalankan setiap perintah sekali lewat bridge (`console:marker-add {frequencyHz}`, `console:marker-remove {markerId}`), dengan aturan, antrean dan kode bridge yang sama dengan dock groundstation (`OK`, `OUT_OF_RANGE`, `MARKER_LIMIT`, `MARKER_NOT_FOUND`, `MARKER_SAVE_FAILED`, `NOT_READY`, `INVALID_COMMAND`, `TIMEOUT`; kode lain dilaporkan `NOT_READY`).
- Hasilnya dikirim di post berikutnya sebagai `results: [{"id", "code", "marker_id"}]` (paling banyak 16; `marker_id` adalah id penanda baru dari `add`, juga setelah `MARKER_SAVE_FAILED`, selain itu `null`). Hasil dari post yang ditolak dikirim lagi. Server hanya menerima hasil untuk perintah yang sudah diserahkan; hasil yang datang setelah kedaluwarsa tetap menyelesaikannya.
- Menutup, memindah atau mematikan mode LAN (`ReceiverMirror.close()`) mengosongkan antrean, status perintah dan daftar penanda sekaligus dengan mirror.

### 8a.3 `GET /api/mirror/receiver/markers/<id>`

Dilayani kedua listener dengan aturan baca mirror (bagian 5). Jawaban:

```json
{"ok": true, "id": "tab-k3m9x0q1n2p4r5s6", "op": "add", "frequency_hz": 433920000,
 "marker_id": "m-13", "status": "done", "code": "OK", "handed": true, "age_ms": 640}
```

`status`: `queued` (menunggu halaman groundstation), `sent` (diserahkan), `done` (ada hasil; `code` kode bridge) atau `expired`. `handed` berarti sebuah halaman sudah menerimanya: `expired` dengan `handed: false` tidak pernah dijalankan (penanda tidak dipasang), sedangkan `expired` dengan `handed: true` masih bisa selesai terlambat (`done`). Untuk `remove`, `marker_id` adalah penanda yang dihapus. Server menyimpan 64 perintah terakhir; id lain dijawab `404 MIRROR_UNKNOWN_COMMAND`. Jawaban `200` tidak dicatat di log.

### 8a.4 Daftar penanda di mirror

Publisher mengirim daftar penanda Receiver di **setiap** post (restart console tidak menghilangkan apa pun), sebagai `markers`:

```json
{"rev": 4, "saved": true, "total": 2,
 "markers": [{"id": "m-1", "frequency_hz": 433500000, "power_db": null, "label": "M1"}, … ]}
```

- Paling banyak **64 penanda terdekat dari tampilan** (tengah RX, atau titik tengah pindai yang berjalan), urut frekuensi; `total` adalah jumlah penanda di daftar Receiver, jadi `total` lebih besar dari jumlah yang dikirim berarti daftar dipotong. Bila post akan melewati 8 KiB, publisher membuang penanda terjauh dulu, lalu frame.
- `label` paling banyak 32 karakter tanpa karakter kontrol (publisher memotong dan mengganti karakter kontrol dengan spasi). `id` `null` untuk penanda yang tidak bisa dialamatkan console (tampil, tidak bisa dihapus dari tablet). `power_db` `null` atau -200..100. `saved` berarti daftar tersimpan ke set penanda yang dipilih di halaman Receiver groundstation; nama set tidak dikirim.
- `GET /api/mirror/receiver` menjawab daftar ini sebagai `markers`. Bila halaman lain mengambil alih sebagai sumber, daftar halaman sebelumnya dibuang sampai halaman baru mengirim daftarnya.

### 8a.5 Di tablet

- Dock MIRROR dan tab Mirror rute Receiver punya tombol **Penanda** (setelah sakelar RX | Spektrum di dock, di kepala kartu Spektrum di rute Receiver) dengan jumlah penanda daftar Receiver. Mode menandai mati setiap kali halaman dimuat dan tidak disimpan.
- Saat menandai, klik trace atau waterfall menambah penanda (dibulatkan ke 1 kHz; di pindai, bin terkuat di dekat klik), klik dekat penanda memilihnya, dan baris di atas grafik menampilkan penanda terpilih dengan **Hapus** (tanpa **Tala ke sini**: tablet tidak menala), **Belum disimpan**, "Mengirim ke groundstation…" selama perintah berjalan, dan kegagalan terakhir dalam bahasa operator. Tombol keyboard pada grafik yang difokuskan: Enter menandai VFO, `[` `]` memilih, Delete menghapus pilihan, `Ctrl+Z` menghapus tanda terakhir tablet ini, Esc melepas pilihan; panah tidak menala.
- Menandai dijeda dengan alasannya selama mirror **SUMBER PUTUS** (juga sebelum ada data) atau **STALE**: kanvas kembali menjadi gambar dan baris penanda menampilkan "Penanda butuh data langsung dari groundstation." atau "Penanda dijeda: frame dari groundstation basi."
- `lib/receiverMirrorMarks.ts`: klien perintah (POST lalu GET status tiap 250 ms, paling lama 20 detik) dan pengendali menandai; `SpectrumCanvas` dengan `readOnly` dan `marking` menandai tanpa pernah menala. Klien berhenti pada `done` (kode Receiver) atau `expired` tanpa `handed` ("Halaman groundstation tidak mengambil penanda tepat waktu; penanda tidak dipasang."). Perintah yang sudah diserahkan terus dibaca sampai 20 detik, karena hasil terlambat masih mungkin; bila tetap tanpa hasil, atau server tidak lagi menyimpannya (`404`), tablet menampilkan "Belum dikonfirmasi groundstation; periksa daftar penanda sebelum memasangnya lagi.", bukan "tidak dipasang", supaya tidak ada penanda ganda.

## 9. Fase 3 (B2): perintah dari tablet. Desain, **belum diimplementasikan**

Belum ada kode untuk bagian ini, kecuali penanda (bagian 8a), yang dipasang lebih dulu atas keputusan pemilik tanpa HTTPS dan login. Syarat mulai: keputusan HTTPS di LAN (sertifikat: CA lokal sendiri atau lainnya), karena kontrol dari LAN hanya boleh lewat HTTPS dengan login.

### 9.1 Login dan transport

- Listener LAN kedua dengan TLS (atau listener LAN yang sama dengan TLS), mati secara default. Listener HTTP lihat-saja yang sekarang tetap read-only.
- Login operator per orang (bukan kata sandi admin bersama), sesi cookie `HttpOnly; Secure; SameSite=Strict`, umur terbatas. Kata sandi admin `123456` atau login mati membuat kontrol LAN tertutup, seperti mode lihat-saja sekarang.
- Setiap permintaan tulis dari LAN memeriksa `Origin` sama dengan origin HTTPS listener itu.

### 9.2 Kunci kontrol

- Satu pemegang kunci pada satu waktu: `{holder, session, acquired_ms, expires_ms}` di memori server.
- Kunci adalah lease (misalnya 30 detik) yang diperpanjang selama penampil pemegang masih membaca; tanpa perpanjangan kunci lepas sendiri.
- Tablet meminta kunci; ditolak `409 CONTROL_LOCKED` bila dipegang orang lain.
- **Groundstation selalu bisa mengambil alih**: permintaan dari halaman loopback mengambil kunci tanpa menunggu, dan pemegang lama langsung kehilangan haknya. Selama kunci dipegang tablet, dock di groundstation menampilkan siapa pemegangnya.

### 9.3 Perintah, revisi, dan ACK

- `POST /api/mirror/receiver/commands` (HTTPS, login, pemegang kunci): `{"id", "base_rev", "op", "fields", "expires_ms"}`. `op` dipetakan ke perintah bridge yang sudah ada (`console:tune`, `console:vfo`, `console:listen`, `console:display`, `console:gains`, `console:radio`, `console:sweep-*`), dengan aturan, batas, dan kode hasilnya (`SWEEP_BUSY`, `OUT_OF_RANGE`, `RECORDING_ACTIVE`, ...).
- `base_rev` adalah `state.rev` yang dilihat pengirim. Sumber menolak perintah yang `base_rev`-nya lebih tua dari state yang menyentuh field yang sama (`STALE_REV`), supaya perintah tidak menimpa perubahan yang belum dilihat pengirimnya.
- Server mengantre perintah (terbatas, misalnya 8) dan menyerahkannya ke sumber di jawaban post berikutnya; sumber menjalankannya lewat bridge dan mengirim ACK di post berikutnya: `{"id", "result": "applied" | "rejected" | "stale_rev" | "expired" | "failed", "code", "state_rev"}`.
- Perintah yang tidak dijawab sebelum `expires_ms` menjadi `expired`. Perintah yang butuh konfirmasi di halaman groundstation (misalnya mengganti sample rate saat merekam) ditolak dari tablet kecuali kontraknya menambah konfirmasi eksplisit.
- Status perintah dibaca lewat `GET /api/mirror/receiver/commands/<id>`.

### 9.4 Audit

Setiap perintah dicatat append-only di direktori data (JSONL, dirotasi): siapa, kapan, field, nilai lama, nilai baru, hasil ACK. Tanpa kata sandi, cookie, atau token.

## 10. Fase 4 dan 5

- **Fase 4**: sumber pindah ke tab engine khusus (Chromium tanpa interaksi yang membuka RadioSpectrum lewat `WebUsbAllowDevicesForUrls`, dikelola sebagai service, health di console). Tab engine mengirim body yang sama dengan `source.kind: "engine-tab"`; halaman kiosk menjadi penampil dan tidak boleh menekan Connect Device. Uji kelayakannya di `packaging/receiver-engine/README.md` (fase 0).
- **Fase 5** (opsional): audio ke penampil. Sampai fase itu audio hanya keluar di speaker groundstation.

## 11. Berkas

| Berkas | Isi |
|---|---|
| `tools/receiver_mirror.py` | Skema, batas, aturan laju, penyimpanan memori, dan antrean perintah penanda (stdlib saja) |
| `tools/ground_console.py` | Route `POST`/`GET /api/mirror/receiver` dan `.../markers`, pengosongan saat listener LAN ditutup |
| `tools/lan_access.py` | `/api/mirror/receiver` dan status perintah penanda di daftar route LAN; `WRITE_ROUTES` dan `origin_matches_host()` untuk satu-satunya penulisan |
| `frontend/src/lib/receiverMirror.ts` | Salinan batas di browser, pengkodean frame, parser jawaban, aturan basi |
| `frontend/src/lib/receiverMirrorPublisher.ts` | Sumber di halaman groundstation, juga pelaksana perintah penanda |
| `frontend/src/lib/receiverMirrorFeed.ts` | Pembaca di penampil |
| `frontend/src/lib/receiverMirrorMarks.ts` | Klien perintah penanda dan pengendali menandai di penampil |
| `frontend/src/components/overview/SpectrumDockMirror.tsx`, `frontend/src/pages/ReceiverMirrorPage.tsx` | Dock MIRROR dan rute Receiver di mode LAN |
| `tools/fixtures/receiver-mirror/publish.json` | Body contoh yang diperiksa Python dan Vitest |
| `tools/test_receiver_mirror.py`, `frontend/src/lib/receiverMirror*.test.ts`, `frontend/src/lib/lanView.test.tsx` | Test kontrak, server, sumber, penampil, dan penanda dari tablet |
