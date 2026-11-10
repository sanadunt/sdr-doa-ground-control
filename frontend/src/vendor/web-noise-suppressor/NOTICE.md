# web-noise-suppressor (vendored)

Salinan file `dist/` dari npm `@sapphi-red/web-noise-suppressor@0.4.1`
(https://github.com/sapphi-red/web-noise-suppressor, MIT, lihat `LICENSE`),
tanpa source map dan tanpa RNNoise (tidak dipakai). Disalin dari radio-translate-papua v1.4.1
(`static/vendor/web-noise-suppressor/`). Dipakai `frontend/src/lib/radioAudioFilter.ts` untuk filter
suara radio di halaman konsol (audio mirror tablet) dan, lewat `tools/build_browsdr_receiver.py`,
di frame Receiver. `index.d.ts` ditulis untuk repo ini (deklarasi yang dipakai saja).

Komponen di dalamnya:

| File | Asal | Lisensi |
|---|---|---|
| `gtcrn.wasm`, `gtcrn/` | GTCRN (Xiaobin-Rong/gtcrn) lewat sapphi-red/gtcrn-wasm; FFT pffft | MIT; pffft: FFTPACK/UCAR |
| `speex.wasm`, `speex/` | speexdsp preprocess (xiph/speexdsp) lewat sapphi-red/speex-preprocess-wasm | BSD-3-Clause |
| `noiseGate/` | web-noise-suppressor | MIT |

Pemberitahuan lisensi lengkap tiap komponen ada sebagai komentar lisensi di file
JavaScript/WASM masing-masing. Memperbarui: unduh versi baru paket npm-nya dan
salin ulang `dist/index.js`, `dist/{gtcrn,speex}.wasm` dan
`dist/{gtcrn,speex,noiseGate}/workletProcessor.js`.
