# Kontrak mirror Receiver

| | |
|---|---|
| Issue | #15 (Receiver dari host lain dan tablet) |
| Fase 1 (dokumen ini) | Kontrak state, frame, revisi, heartbeat, aturan basi, dan desain perintah |
| Fase 2 (B1) | **Terpasang**: relay di server console dan penampil MIRROR di mode LAN lihat-saja |
| Fase 3 (B2) | **Desain saja, belum diimplementasikan** (bagian 9). Menunggu keputusan HTTPS di LAN |
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
  dock Spektrum (MIRROR) dan rute Receiver (state + spektrum), tanpa audio
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
- Publisher tidak pernah mengirim perintah ke frame. Ia hanya mendengar bridge: state lewat `onState`, frame lewat `onSpectrum`, dengan langganan miliknya sendiri (`subscribe(..., 'mirror')`). Bridge menggabungkan langganan dock dan mirror menjadi satu `console:subscribe` (frame mengalir selama salah satunya meminta; bin dan fps terbesar; span milik dock bila dock meminta). Protokol bridge di `CLAUDE.md` tidak berubah.
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
| `gains` | `{lna_db, vga_db, amp}` | Gain RX (dB atau null, amp boolean). |
| `vfo` | objek atau null | VFO aktif: `index` (0..63), `enabled`, `mode` (`nfm`, `wfm`, `am`, `usb`, `lsb`, `dsb`, `cw`, `raw` atau null), `frequency_hz`, `bandwidth_hz`, `squelch_enabled`, `squelch_db`. |
| `scan` | objek atau null | Pindai lebar: `phase` (`idle`, `starting`, `active`, `stopping`), `start_hz`, `stop_hz`, `resolution_hz`. |
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
            "scan": {"phase": "idle", "start_hz": 400000000, "stop_hz": 500000000, "resolution_hz": 4882.8125},
            "error": null},
  "frame": {"seq": 7, "t_ms": 1761000000007, "kind": "rx", "center_hz": 433920000, "start_hz": 432920000,
            "stop_hz": 434920000, "bin_count": 512, "db_min": -120, "db_max": -20, "bins": "…684 karakter…"}
}
```

`frame` boleh tidak ada atau `null` (post state saja, termasuk heartbeat). Contoh lengkap yang diperiksa kedua sisi: `tools/fixtures/receiver-mirror/publish.json`.

Pemeriksaan, berurutan; yang pertama gagal menentukan jawaban. Semua error berbentuk `{"ok": false, "code": ..., "error": ...}` dan tidak masuk daftar kode Kontrol:

| Urutan | Syarat | Jawaban bila gagal |
|---|---|---|
| 1 | Header `Origin` loopback same-origin, host dan port persis console | `403 ORIGIN_REJECTED` |
| 2 | `Content-Length` paling banyak 8192 byte | `413 MIRROR_TOO_LARGE` |
| 3 | Paling banyak 12 post lolos pemeriksaan laju dalam satu detik mana pun (post yang ditolak karena laju tidak dihitung) | `429 MIRROR_RATE_LIMITED` |
| 4 | Mode LAN lihat-saja terbuka | `409 MIRROR_LAN_CLOSED` |
| 5 | Skema ketat: JSON UTF-8 tanpa NaN/Infinity, field persis seperti bagian 2 dan 3 (field asing, field hilang, tipe salah, boolean sebagai angka, nilai di luar rentang, termasuk bilangan bulat yang melampaui float, ditolak seluruhnya; JSON yang bersarang terlalu dalam juga tidak valid) | `400 MIRROR_INVALID` dengan nama field pertama yang salah |

Berhasil: `200 {"ok": true, "rev": <post ke-n>, "frame_rev": <frame ke-n>}`. Body yang panjangnya dalam batas dibaca dulu sebelum jawaban apa pun, juga penolakan, supaya klien membaca jawabannya, bukan reset koneksi. Listener LAN tidak pernah menerima POST ini (`405 LAN_READ_ONLY`).

Tidak ada yang ditulis ke disk. Post terbaru menggantikan yang sebelumnya; restart console, atau listener LAN yang ditutup, dipindah, atau dimatikan, mengosongkannya. Pengosongan itu dan penolakan post berikutnya satu langkah (`ReceiverMirror.close()` di bawah kunci manajer LAN): post yang sudah lolos pemeriksaan 4 tetapi baru disimpan setelah mode LAN ditutup dijawab `409 MIRROR_LAN_CLOSED` dan tidak disimpan. Jawaban 200 dan 429 tidak dicatat di log console (route ini dipanggil beberapa kali per detik); penolakan lain dicatat.

## 5. `GET /api/mirror/receiver`

Dilayani listener loopback dan listener LAN (masuk daftar route LAN), masing-masing dengan aturan bacanya sendiri. Permintaan yang gagal dijawab `403 ORIGIN_REJECTED`:

- Listener loopback memakai aturan baca Receiver, sama dengan `/api/receiver/*`: `Sec-Fetch-Site` tidak ada, `none`, atau `same-origin`, dan tepat satu `Host` berupa nama loopback (`127.0.0.1`, `localhost`, `[::1]`) di port console. Mirror membawa apa yang ditampilkan Receiver (frekuensi, mode, gain, status rekam, spektrum), jadi situs lain, halaman dari port localhost lain, dan halaman DNS rebinding (yang mengirim nama host-nya sendiri) tidak bisa membacanya.
- Listener LAN memakai aturan `Host`-nya sendiri (alamat IP, atau nama komputer ini, di port LAN) dan hanya menolak `Sec-Fetch-Site: cross-site`, seperti `/api/tiles`.

Route `/api/receiver/*` tetap tertutup dari LAN; prefix `/api/mirror/` dipilih justru supaya daftar route LAN tidak perlu membukanya.

```json
{
  "ok": true, "v": 1,
  "rev": 42, "frame_rev": 40,
  "source": {"id": "kiosk-3k9x0q1m2n4p5r6s", "kind": "kiosk-tab", "visible": true},
  "source_age_ms": 120,
  "state": { … bagian 2 … }, "state_age_ms": 120,
  "frame": { … bagian 3 … }, "frame_age_ms": 180,
  "limits": {"frame_stale_ms": 3000, "source_lost_ms": 10000, "heartbeat_ms": 2000,
             "max_bins": 512, "max_body_bytes": 8192, "max_posts_per_s": 12}
}
```

Umur dihitung dengan jam monotonic server sejak post diterima, jadi jam sumber dan jam penampil tidak berpengaruh. Sebelum ada post, `source`, `state`, `frame` dan umurnya `null`.

## 6. Revisi, heartbeat, dan aturan basi

| Nilai | Pemilik | Arti |
|---|---|---|
| `state.rev` | sumber | Naik setiap state berubah. Fase 3 memakainya sebagai revisi dasar perintah. |
| `frame.seq` | sumber (bridge) | Urutan frame; satu deret untuk RX dan pindai. |
| `rev` | server | Jumlah post yang diterima (termasuk heartbeat). |
| `frame_rev` | server | Jumlah frame yang diterima. Penampil menggambar satu baris waterfall per `frame_rev` baru. |

- **Laju sumber**: paling banyak satu post per 200 ms (5 per detik) dan satu yang sedang berjalan. Post membawa state sekarang dan frame terbaru yang belum terkirim; frame yang lebih tua dibuang, tidak diantre. Post dikirim saat ada frame baru, state berubah, atau heartbeat jatuh tempo.
- **Heartbeat**: state dikirim paling lambat tiap 2 detik walaupun tidak ada perubahan dan tidak ada frame (RX berhenti).
- **Setelah penolakan**: 429, 400, atau gagal jaringan membuat sumber menunggu 1 detik, lalu dua kali lipat sampai 10 detik. `409 MIRROR_LAN_CLOSED` menghentikan post dan langganan frame; sumber lalu menanyakan `/api/health` tiap 10 detik sampai `lan_access.state` kembali `open`.
- **Penampil**: membaca GET tiap 200 ms selama dock MIRROR atau rute Receiver tampil dan halaman terlihat, tiap 1 detik selama sumber putus, dan 1, 2, lalu 5 detik setelah baca gagal. Umur dihitung terus dari jawaban terakhir.

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

RX yang berhenti bukan basi: tidak ada frame yang diharapkan, chip `RX OFF`, dan jejak terakhir tetap tergambar redup. Setelah pindai berhenti, bridge melaporkan `busy: "none"` dan `scan.phase: "idle"`; penampil mengambil mode dari frame terakhir, jadi jejak pindai yang redup tetap di mode Spektrum dengan chip `SCAN OFF`, seperti dock groundstation.

Tombol Mulai/Berhenti dock MIRROR (nonaktif) mengikuti state terakhir seperti dock groundstation, bukan umur frame: Berhenti selama pindai `starting` atau `active` dan selama RX berjalan di luar scan listen, juga saat chip `STALE` atau **SUMBER PUTUS**; kesegaran hanya ditunjukkan chip.

**Frame hanya mengalir selama halaman console groundstation terlihat.** Halaman tersembunyi (tab lain, jendela diminimalkan) tidak meminta frame dan mengirim `source.visible: false`, sehingga penampil menampilkan `STALE` dengan "Halaman groundstation tersembunyi; frame berhenti." Chrome juga bisa memperlambat timer di tab tersembunyi (sampai sekitar sekali per menit setelah beberapa menit tersembunyi), sehingga heartbeat bisa terlambat dan penampil menampilkan **SUMBER PUTUS**. Fase 0 dan 4 (tab engine khusus) dibuat untuk masalah ini.

## 7. Ukuran dan laju

| | Nilai |
|---|---|
| Body post maksimum | 8 KiB (diterima server); body nyata sekitar 2 KiB dengan frame, 0,7 KiB tanpa frame |
| Post | ≤ 5 per detik dari publisher; server menerima ≤ 12 per detik |
| Frame | ≤ 512 bin u8, ≤ 5 per detik |
| Lalu lintas sumber ke server | sekitar 10 KiB/detik (loopback) |
| Lalu lintas per penampil | sekitar 10 KiB/detik selama RX berjalan (5 GET per detik, satu koneksi HTTP/1.0 per GET) |
| Memori server | satu state dan satu frame (beberapa KiB) |

Listener LAN melayani paling banyak 32 permintaan sekaligus; beberapa tablet yang masing-masing membaca 5 kali per detik jauh di bawah batas itu.

## 8. Batas

- Mirror hanya tampilan. Tidak ada perintah ke Receiver, tidak ada audio, tidak ada rekaman, tidak ada penanda dari penampil. Semua kontrol di dock MIRROR terlihat dengan statusnya tetapi nonaktif, dan kanvasnya tidak bisa dipakai untuk tuning, menandai, atau tombol panah.
- Frame Receiver tidak pernah dipasang di mode LAN lihat-saja (RadioSpectrum ada di USB groundstation).
- Tidak ada yang ditulis ke disk, dan tidak ada data rahasia di state.
- Mode LAN tetap read-only: `POST /api/mirror/receiver` hanya lewat loopback, GET-nya satu-satunya route mirror di daftar route LAN.

## 9. Fase 3 (B2): perintah dari tablet. Desain, **belum diimplementasikan**

Belum ada kode untuk bagian ini. Syarat mulai: keputusan HTTPS di LAN (sertifikat: CA lokal sendiri atau lainnya), karena kontrol dari LAN hanya boleh lewat HTTPS dengan login.

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
| `tools/receiver_mirror.py` | Skema, batas, aturan laju, dan penyimpanan memori (stdlib saja) |
| `tools/ground_console.py` | Route `POST`/`GET /api/mirror/receiver`, pengosongan saat listener LAN ditutup |
| `tools/lan_access.py` | `/api/mirror/receiver` di daftar route LAN |
| `frontend/src/lib/receiverMirror.ts` | Salinan batas di browser, pengkodean frame, parser jawaban, aturan basi |
| `frontend/src/lib/receiverMirrorPublisher.ts` | Sumber di halaman groundstation |
| `frontend/src/lib/receiverMirrorFeed.ts` | Pembaca di penampil |
| `frontend/src/components/overview/SpectrumDockMirror.tsx`, `frontend/src/pages/ReceiverMirrorPage.tsx` | Dock MIRROR dan rute Receiver di mode LAN |
| `tools/fixtures/receiver-mirror/publish.json` | Body contoh yang diperiksa Python dan Vitest |
| `tools/test_receiver_mirror.py`, `frontend/src/lib/receiverMirror*.test.ts` | Test kontrak, server, sumber, dan penampil |
