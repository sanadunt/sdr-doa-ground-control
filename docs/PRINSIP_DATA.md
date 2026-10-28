# Prinsip data console

| | |
|---|---|
| Status | Disetujui |
| Tanggal | 2026-10-28 |
| Berlaku sejak | console 3.1.0 |
| Berlaku untuk | SDR-DoA Ground Console (`tools/`, `frontend/`), dengan RDF Node edge di Raspberry sebagai sumber MQTT |

## Ringkasnya

Console dipakai di lapangan lewat link radio yang sering tidak sempurna. Karena itu data harus tetap mengalir dan diberi label kualitas, bukan dibuang. Batas keselamatan untuk perintah ke RDF-SDR tidak dilonggarkan.

## Enam prinsip

1. **Data harus tetap mengalir.** Satu field yang rusak, satu GET yang gagal, atau satu pesan yang terlambat tidak boleh mengosongkan Dashboard. Data terakhir yang terbaca tetap tampil, dengan umur dan alasannya.
2. **Terima dengan longgar, kirim dengan lengkap.** Saat membaca, console menerima variasi yang masih bermakna (angka sebagai teks, `0`/`1` sebagai boolean, waktu dalam detik, field opsional yang hilang). Saat mengirim, console selalu mengirim envelope lengkap dalam format edge.
3. **Beri label, jangan tolak.** Data yang diterima dengan perbaikan diberi catatan, dan data yang belum valid diberi tanda yang jelas. Hanya data yang benar-benar tidak terbaca yang `INVALID`, selalu dengan alasannya: bukan JSON, bukan objek, `sid` kosong atau rusak, versi protokol lain, terlalu besar, atau field inti tidak ada.
4. **Kegagalan terlihat dalam bahasa operator.** Pesan menyebut apa yang terjadi dan apa yang bisa dilakukan, misalnya "helper settings RDF-SDR tidak dapat dijalankan". Kode mentah (`OUTCOME_UNKNOWN · OSERROR`) tetap terlihat di bawahnya, tidak menggantikan kalimatnya.
5. **Satu MQTT.** Root topik `sdr/v2/uav-01` (`docs/KEPUTUSAN_MQTT.md`, kontrak `docs/MQTT_KONTRAK.md`). Istilah di UI dan dokumen hanya "MQTT" dan "Data Out (cadangan)".
6. **Yang tidak dilonggarkan:**
   - console tetap bind `127.0.0.1`;
   - akses LAN hanya lewat mode LAN lihat-saja;
   - login admin dan konfirmasi untuk Kontrol;
   - batas aman nilai settings (rentang frekuensi, tabel gain, dan sebagainya);
   - expiry perintah (15 s);
   - persetujuan untuk reboot, shutdown, dan restart.

   Gate publikasi tetap `BLOCKED` (authority none, jam `remote_unverified`).

## Penerapan

### Pembacaan (3.1.0)

| Sumber | Yang diterima dengan label | Yang tetap ditolak |
|---|---|---|
| MQTT (`tools/rdf_node_mqtt_v2.py`) | Catatan `KODE:field` (`COERCED`, `TIME_SECONDS`, `MISSING_FIELD`, `DEFAULTED`, `DROPPED_ITEMS`, `DROPPED_FIELD`, `UNEXPECTED_VALUE`, `EVIDENCE_INCOMPLETE`, `UNKNOWN_STATUS`, `BROKER_POLICY`, `SEQUENCE_RESET`, `REVISION_MISMATCH`). Health, DoA dan Angular di luar jendela waktunya atau tanpa health tetap disimpan sebagai `STALE` atau `INCONSISTENT`. | JSON rusak, `NaN`/`Infinity`, key ganda, payload kosong atau di atas 8192 byte, `v` lain, `sid` kosong atau rusak, field inti hilang, encoding Angular selain `json` (`ENCODING_UNSUPPORTED`). |
| status.json (`tools/sdr_doa_collector.py`) | Boolean `0`/`1` dan `"true"`/`"false"` (`coerced_fields`), field yang salah tipe ditinggalkan (`partial_fields`). Field DAQ yang hilang membuat DAQ `UNKNOWN` (`DAQ_HEALTH_UNKNOWN`), bukan `FAIL`. Overdrive yang tidak dilaporkan di mana pun dibaca "tidak diketahui" (`ADC_OVERDRIVE_UNKNOWN`), bukan lolos. | Bukan JSON objek, atau `timestamp_ms` tidak ada. Semua aturan freshness dihitung darinya. |
| DOA_value.html, doa.xml | Hanya waktu, sudut dan vektor 360 bin (CSV) yang wajib. Kolom lain menjadi null dan disebut di `missing_fields`. CSV multi-VFO tanpa satu frekuensi XML yang cocok memakai baris VFO 0 (`CSV_VFO_ROW_UNCONFIRMED`). | Tanpa waktu, tanpa sudut, atau vektor yang tidak 360 bin. |
| Light read Data Out (`tools/data_out_reader.py`) | Light read yang gagal tidak menghapus light read baik terakhir. Nilainya tetap dipakai sampai 65 s (`data_out_light.kept_previous`). | — |

### Tampilan (3.1.0)

- **DoA belum valid tetap tampil.** Ini berlaku untuk DoA ok=0, rekaman lama, jendela lokal yang habis, node macet, status DAQ yang tidak diketahui, dan status.json yang tidak terbaca (`provisionalTheta()`, `lib/doaStatus.ts`).
  - Di HUD, bearing terakhirnya tampil redup dengan label BELUM VALID atau "BASI N s".
  - Di peta, garisnya putus-putus abu-abu berlabel BELUM VALID.
  - Konflik CSV/XML, sinkronisasi DAQ gagal, dan ADC overdrive tetap disembunyikan, karena sudutnya tidak bermakna.
  - `overviewDoaStatus().shown` tetap satu-satunya penentu DoA yang valid.
- **Data Out tanpa doa.xml.** Tampilan CSV saja digambar dengan status DoA `PARTIAL` dan label SEBAGIAN.
- **Kurva polar** terakhir tetap tampil redup dengan "Belum ada update · terakhir HH.MM.SS", tanpa batas waktu.
- **Chip Publikasi** berisi PERLU DISIAPKAN bila yang menahan hanya pengaturan: authority, konvensi sudut, jam, pemetaan satuan, dan edge yang masih mengirim ok=0. Isinya ADA MASALAH bila datanya bermasalah. Chip ini membuka checklist alasan dan pemeriksaan gate.
- **Sumber disebut.** Kartu DoA MQTT di DoA Diagnostics menulis "Sumber: MQTT · Data Out (cadangan) tidak dipakai". Banner kompas di peta menyebut penyebabnya dan membuka Konfigurasi → GPS & Kompas.

### Kontrol (3.1.0)

- **Revisi berubah.** `base_rev` yang basi (`CONFIG_REVISION_STALE`), revisi yang belum diketahui (`CONFIG_REVISION_UNKNOWN`), `state.cfg` yang berubah saat meninjau, dan `REJECTED CONFIG_REVISION_CONFLICT` dari edge tidak lagi mengunci Kontrol. Console:
  1. meminta settings (`config.get`);
  2. membaca ulang nilai;
  3. menampilkan lagi perubahan yang sama untuk ditinjau di revisi baru ("rev 42 → 43").

  Satu kali Kirim mengonfirmasinya, dan tanpa Kirim itu tidak ada yang dikirim.
- **Revisi yang belum ada diminta, bukan ditunggu.** `config.get` dikirim sendiri sekali per sesi node dan revisi bila belum ada laporan settings untuknya. Jadi `state.cfg` null langsung diminta.
- **`remote_config_patch` false.** Kirim tetap bisa dipakai setelah peringatan dan konfirmasi kedua yang eksplisit.
- **Hasil ACK dalam bahasa operator**: Diterapkan, Tersimpan belum terbukti, Hasil tidak diketahui, Ditolak RDF-SDR, Kedaluwarsa, Dibatalkan, Gagal. Kode mentah tampil di baris sendiri.
  - Kode exception dari helper edge (`OSERROR`, `FILENOTFOUNDERROR`, `PERMISSIONERROR`, `TIMEOUTEXPIRED`) menyebut penyebab yang mungkin: helper tidak tersedia atau belum disetujui di RDF-SDR.
  - `CONNECTION_LOST` menyebut link yang putus.

## Aturan untuk perubahan berikutnya

- Validator baru menambah catatan, bukan penolakan, kecuali datanya memang tidak bisa dibaca. Setiap penolakan punya kode dan nama field.
- Kondisi tampil baru memisahkan "valid" (`shown`) dari "masih terbaca" (redup dengan label). Data yang belum valid tidak pernah memakai warna atau gaya data yang valid.
- Setiap alasan gate dan kode sumber punya label EN dan ID di `frontend/src/lib/i18n.ts`. Kalimat operator datang lebih dulu, kodenya ikut tampil.
- Perubahan di bagian 6 (bind, LAN, admin, konfirmasi, batas nilai, expiry, persetujuan) butuh keputusan tertulis baru, bukan bagian dari pelonggaran pembacaan.
