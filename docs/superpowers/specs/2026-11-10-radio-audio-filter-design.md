# Filter suara radio untuk audio yang didengar operator

Tanggal: 2026-11-10. Permintaan pemilik: spesifikasi "FILTER SUARA RADIO" (ditulis untuk radio-translate-papua v1.4.1), dipetakan ke Ground Console ini. Status: disetujui 2026-11-10. Pemilik memilih panel di tab Dengar **dan** di dock Dashboard. Dua pilihan lain tidak dijawab dan diambil sebagai panggilan pembangun: tombol Filter di samping Dengar di tablet (usulan), dan bawaan Standar (sesuai spesifikasi).

## Tujuan dan alasan

Suara NFM dari RadioSpectrum (HackRF) berdesis lebar. Operator di groundstation dan orang yang memegang tablet ingin suara yang lebih bersih dan rata: pita suara saja, desis diredam, kata lebih jelas, suara pelan dinaikkan tanpa pecah. Filter bisa dinyalakan, dimatikan dan diatur, dan setelannya diingat.

Filter hanya untuk yang **didengar**. Rekaman Records, Whisper (ASR) di Receiver dan audio mirror yang dikirim ke tablet tetap memakai audio asli.

## Dua tempat audio didengar (temuan di kode)

1. **Groundstation, Receiver BrowSDR di frame `/receiver/`.** Worker mengirim audio 48 kHz mono (campuran VFO yang tidak bisu) ke `connection.ts`, yang memanggil `playAudio()` (vendor `audio.ts`). `playAudio()` menjadwalkan `AudioBufferSourceNode` ke `app.gainNode`, dan `_initAudioCtx()` (vendor `ui-helpers.ts`) membuat `new AudioContext({ sampleRate: 48000 })` dengan `gainNode -> destination`. Dock Spektrum di Dashboard hanya mengirim perintah ke frame; suaranya tetap keluar dari frame.
   - Jalur lain dari audio yang sama, yang **tidak** boleh lewat filter dan memang tidak lewat `gainNode`: `consoleBridge.audio()` (sumber audio mirror, diambil sebelum `playAudio()`), `recordVfoAudio()` (rekaman per VFO) dan `_feedWhisperVfo()` (Whisper per VFO).
2. **Tablet LAN view, audio mirror.** `mirrorAudioPlayer()` (`frontend/src/lib/receiverMirrorAudio.ts`) membaca PCM 16 kHz per 200 ms dari `GET /api/mirror/receiver/audio`, membuat `AudioBuffer` 16 kHz per potongan, dan menjadwalkannya ke `context.destination` 250 ms di depan (`TARGET_BUFFER_S`), membuang potongan saat lebih dari 600 ms antre (`CATCH_UP_S`). AudioContext-nya dibuat tanpa `sampleRate` (jadi 44,1 atau 48 kHz tergantung perangkat). Tombol `MirrorListenButton` ada di dock MIRROR (`SpectrumDockMirror`) dan kartu Spectrum di rute Receiver (`ReceiverMirrorPage`). Aplikasi Android hanya membungkus halaman ini dalam WebView, jadi Web Audio tetap berlaku.

Tidak ada audio monitor yang diputar di luar browser, jadi worklet WASM bisa dipakai di kedua tempat.

## Yang dibangun

### Modul filter (satu sumber untuk konsol dan frame)

- `frontend/src/lib/radioAudioFilter.ts`: `RadioAudioFilter` dan `FILTER_PRESETS`, salinan dari `static/radio-audio-filter.js` acuan v1.4.1, diubah ke TypeScript dengan perilaku, rantai dan nilai yang sama persis:
  `input -> high-pass x2 -> low-pass x2 -> peredam noise AI -> perjelas suara -> gerbang noise -> AGC -> penguat -> limiter -> volume -> output`
  - high-pass dan low-pass: masing-masing 2 `BiquadFilter` Q 0,707 di `lowHz`/`highHz`, low-pass dibatasi `sampleRate/2 - 100`;
  - peredam: GTCRN (bawaan) atau Speex, AudioWorklet + WASM; hanya di AudioContext 48 kHz, selain itu status `error` dengan teksnya (tidak diam-diam dilewati);
  - perjelas: peaking 2000 Hz, Q 0,9, +5 dB; gerbang: `NoiseGateWorkletNode` open −50, close −58, hold 300 ms; AGC: compressor −40/12/6/0,005/0,3; penguat `boostDb` 0–18 dB hanya saat AGC nyala; limiter −2/0/20/0,001/0,1; volume `setTargetAtTime(volume, now, 0.02)`;
  - node yang belum termuat dilewati, rantai disambung ulang begitu siap; selama modul belum termuat suara tetap lewat bagian rantai yang sudah ada.
  - Satu tambahan dari acuan: `destroy()` (lepas semua node, panggil `destroy()` worklet), dan pemuatan worklet hanya sekali per AudioContext.
- Preset persis acuan: Mati, Ringan, Standar (bawaan), Kuat; mengubah satu kontrol membuat preset `custom`. Setelan disimpan sebagai JSON `{preset, bandpass, lowHz, highHz, denoise, clarity, agc, gate, boostDb}`, dibaca ulang dengan validasi (nilai di luar batas kembali ke Standar).
- Vendor: `frontend/src/vendor/web-noise-suppressor/` = salinan acuan (dist npm `@sapphi-red/web-noise-suppressor@0.4.1`, tanpa RNNoise) dengan `LICENSE` dan `NOTICE.md`, plus `index.d.ts` kecil untuk TypeScript. Dimuat lewat Vite: `index.js` dengan `import()` (chunk terpisah, hanya saat filter dipakai), `gtcrn.wasm`, `speex.wasm` dan ketiga `workletProcessor.js` lewat `?url`, sehingga semuanya di-serve same-origin dari `assets/`.
- Frame memakai **file yang sama**: builder (`tools/build_browsdr_receiver.py`) menyalin `radioAudioFilter.ts` dan folder vendor ke salinan sementara BrowSDR, seperti overlay. Tidak ada salinan kedua yang bisa menyimpang. (Panggilan saya.)

### Groundstation: filter di dalam frame Receiver

Padanan "host:output-mute" kit di sini: filter dipasang **di dalam frame**, di antara `gainNode` dan speaker. AudioContext frame sudah 48 kHz, jadi GTCRN langsung jalan, tidak ada jalur audio kedua di halaman konsol, tidak ada suara dobel, dan tidak ada delay tambahan selain filter itu sendiri. Memutar audio di halaman konsol (frame dibisukan, `receiver:audio` diputar di halaman) ditolak: menambah antrean, AudioContext kedua, dan harus dijaga saat frame reload.

- Overlay `audio-filter.ts` (baru): `applyAudioFilter(app)` dipanggil setelah `_initAudioCtx()` membuat AudioContext (hook lewat satu anchor builder di vendor `ui-helpers.ts`, `this.gainNode.connect(this.audioCtx.destination);`). Preset bukan Mati: `gainNode -> filter.input`, `filter.output -> destination`. Mati: `gainNode -> destination` persis seperti sekarang, filter dilepas (tidak memuat WASM sama sekali). Ganti preset memutus dan menyambung ulang, jadi nyala → mati → nyala tanpa reload dan tanpa jalur ganda. Saat AudioContext ditutup (`connect()`/stop di `connection.ts` menutupnya) filter dibuang; AudioContext berikutnya mendapat filter baru dengan setelan yang sama.
- Volume: volume per VFO tetap di Receiver (diterapkan di worker); `filter.output` tetap 1. (Panggilan saya: tidak ada slider volume utama di frame.)
- Ganti preset dan kontrol di dalam klik operator juga memanggil `audioCtx.resume()`; bila AudioContext tetap `suspended`, status menulis petunjuknya.
- Setelan: kunci localStorage frame `ReceiverAudioFilter`, ditambahkan ke `PREFERENCE_KEYS` (kedua salinan), sehingga ikut disimpan di console host seperti `SDRSetting` dan bertahan setelah reload, browser lain dan rebuild container. Tidak masuk `LAN_VIEW_PREFERENCE_KEYS`. (Panggilan saya.)

### Tablet: filter di pemutar audio mirror

- `mirrorAudioPlayer()` membuat AudioContext dengan `{ sampleRate: 48000, latencyHint: 'interactive' }`. Potongan 16 kHz tetap dibuat sebagai `AudioBuffer` 16 kHz; `AudioBufferSourceNode` me-resample ke 48 kHz sendiri, jadi tidak perlu resampler buatan sendiri. Sumber disambung ke `filter.input` (bukan `destination`), `filter.output -> destination`. Mati: sumber langsung ke `destination` seperti sekarang.
- Penjadwalan yang ada tetap (`TARGET_BUFFER_S` 250 ms, `CATCH_UP_S` 600 ms, gap mulai ulang). Aturan acuan "antrian > 0,4 s, mulai lagi dari sekarang + 0,08 s" **tidak** dipakai: pemutar mirror sudah punya aturan sendiri yang diukur untuk Wi-Fi. (Panggilan saya.)
- Perkiraan latensi di samping tombol Dengar ditambah delay filter yang diukur (konstanta dari uji, lihat di bawah).
- Setelan: localStorage tablet saja, kunci `sdr-console-mirror-audio-filter`, tidak masuk `PREFERENCE_KEYS` (LAN view tidak menulis ke server). Tidak ada jalur tulis baru.

### CSP dan MIME

- Halaman konsol (kedua listener): `script-src 'self' 'wasm-unsafe-eval'` (WASM dikompilasi di AudioWorkletGlobalScope, yang mewarisi CSP halaman) dan `.wasm` -> `application/wasm` di MIME allowlist `assets/`. Tidak ada `unsafe-eval`, tidak ada host luar.
- Frame `/receiver/`: tidak berubah (sudah punya `'wasm-unsafe-eval'` dan `.wasm`).

### UI

- Panel "Filter suara"/"Voice filter": chip Mati / Ringan / Standar / Kuat, lalu kontrol kustom: pita suara (nyala/mati), peredam (GTCRN / Speex / Mati), perjelas, AGC + slider penguat 0–18 dB, gerbang noise. Status di judul panel: mati / memuat AI… / AI aktif / AI gagal / aktif. Teks EN dan ID (`lib/i18n.ts` di konsol, `i18n.ts` overlay di frame).
- Tempatnya: lihat pertanyaan 1 dan 2.

## Bukan tujuan

- Tidak mengubah `vendor/BrowSDR`, worker, perekam, Whisper, atau publisher audio mirror.
- Tidak ada filter di server, tidak ada jalur tulis baru, tidak ada RNNoise.
- Tidak mengatur filter tablet dari groundstation atau sebaliknya.

## Anti-tujuan (gagal walau "jalan")

- Suara dobel (jalur asli dan jalur filter sama-sama ke speaker).
- Rekaman, Whisper atau audio yang dikirim ke tablet ikut terfilter.
- Filter Standar gagal memuat tanpa terlihat (status harus menulis "AI gagal" dengan alasannya).
- Delay yang menumpuk.

## Uji

- Vitest `lib/radioAudioFilter.test.ts`: preset, `custom`, simpan/baca setelan dan validasinya, urutan rantai dengan AudioContext palsu (node yang belum siap dilewati, disambung ulang saat siap, Mati = bypass), status 48 kHz.
- `receiverMirrorAudio.test.ts`: sumber ke `filter.input` saat filter nyala dan ke `destination` saat Mati, ganti preset saat memutar tanpa sumber ganda, AudioContext 48 kHz.
- `tools/test_radio_audio_filter.mjs` (node, Chrome headless lewat CDP seperti `tests/listener_e2e.mjs` acuan, dilewati dengan peringatan bila Chrome tidak ada): halaman uji same-origin dari server loopback kecil, `OfflineAudioContext` 48 kHz, noise acak 0,06 selama 2 detik: Standar harus ≥ 15 dB di bawah Mati (acuan ~29 dB), rantai memuat `GtcrnWorkletNode`. Juga mengukur delay filter (impuls), yang dilaporkan dan dipakai di perkiraan latensi tablet.
- Node test overlay: anchor builder, hook di `_initAudioCtx`, nyala → mati → nyala menyambung satu jalur, `consoleBridge.audio()`/rekaman tidak menyentuh filter.
- Python: CSP dan MIME `.wasm` di `test_ground_console_static`, kunci preferensi baru di `test_preferences_store`.
- Urutan verifikasi `CLAUDE.md`; pemeriksaan browser dengan Mock SDR (frame) dan audio mirror yang disuntik (tablet), karena Mock SDR tidak menghasilkan audio VFO di Chromium.

Yang belum bisa diuji di sini: suara radio sungguhan dari HackRF, dan tablet Samsung yang sebenarnya (WebView). Itu dilaporkan sebagai belum diuji.

## Keputusan

1. **UI di groundstation (pemilik):** panel "Filter suara" di tab Dengar halaman Receiver **dan** di kolom Atur dock Spektrum (mode RX). Dock mengatur filter frame lewat perintah bridge baru `console:audio-filter {settings}` (antrean perintah biasa, 8 s, tidak pernah ditolak karena pindai), dan `receiver:status` membawa `audioFilter {settings, state, error}`; kedua salinan protokol berubah. Dock tidak menyimpan setelan sendiri: frame pemiliknya, seperti skala dB.
2. **UI di tablet (panggilan pembangun):** tombol "Filter" di samping Dengar (dock MIRROR dan kartu Spectrum rute Receiver) membuka panel yang sama sebagai popover.
3. **Bawaan (panggilan pembangun, sesuai spesifikasi):** Standar, di frame dan di tablet.
