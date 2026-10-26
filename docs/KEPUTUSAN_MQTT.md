# Keputusan: satu MQTT untuk Ground Console dan Raspberry

| | |
|---|---|
| Status | Disetujui |
| Tanggal | 2026-10-26 |
| Berlaku untuk | SDR-DoA Ground Console (repo `sanadunt/sdr-doa-ground-control`), RDF Node di Raspberry (edge) dan di groundstation (ground), broker MQTT di groundstation |

## Ringkasnya

Sistem ini hanya memakai **satu MQTT**: kontrak yang dipakai RDF Node di Raspberry. Ground Console menyesuaikan diri dengan kontrak itu. Jalur MQTT lama milik console dihapus. Data Out (HTTP port 8081) tetap ada, tetapi hanya sebagai **cadangan**.

Mulai sekarang, dalam pembahasan, issue, dan UI, hanya ada dua istilah:

| Istilah | Artinya |
|---|---|
| **MQTT** | Pesan antara Raspberry dan groundstation di root topik `sdr/v2/uav-01`, sesuai kontrak RDF Node. Ini jalur utama. |
| **Data Out (cadangan)** | HTTP port 8081 di Raspberry (`/status.json`, `/settings.json`, `/DOA_value.html`, `/doa.xml`). Hanya dipakai saat MQTT tidak memberi data segar. |

Tidak ada lagi pembahasan "v1" atau "v2". Angka `v2` di nama topik dan di nama file kode (misalnya `rdf_node_mqtt_v2.py`) hanyalah nama teknis, bukan pilihan.

## Latar belakang

- Raspberry hanya publish dan menerima perintah di `sdr/v2/uav-01/...` (RDF Node edge, rilis `1.0.0-20261013194717`). Agent RDF-SDR bawaan repo console tidak terpasang di Raspberry.
- Console v2.0.0 memakai dua keluarga topik sekaligus. Monitor, Kontrol, dan agent bawaannya masih memakai topik lama `sdr/v1/uav-01`, yang tidak dipakai Raspberry. Akibatnya:
  - kartu MQTT di Konfigurasi menunjukkan 0 pesan walaupun ribuan pesan masuk;
  - Kontrol mengirim ke topik yang tidak didengar Raspberry, dan tombol Send terkunci ("Send needs a config revision reported over MQTT");
  - Dashboard tidak memakai MQTT sama sekali dan bergantung penuh pada Data Out.
- Pembahasan sebelumnya bercabang ke banyak varian (topik lama, topik baru, akses lewat IP, dan sebagainya), sehingga sulit menentukan mana yang berlaku.

## Keputusan

1. **Satu kontrak.** Acuannya `docs/MQTT_TOPIC_SUMMARY.md` dari rilis RDF Node yang terpasang di Raspberry. Kalau edge berubah, console yang menyesuaikan.
2. **Satu root topik:** `sdr/v2/uav-01`, menjadi default di console dan tidak perlu diatur operator.
3. **MQTT adalah sumber utama** untuk Dashboard, peta, polar, DoA, dan health.
4. **Data Out hanya cadangan.** Console beralih ke Data Out bila MQTT tidak segar, dan menampilkan badge sumber data di UI.
5. **Kontrol memakai format perintah edge**: topik `sdr/v2/uav-01/cmd/...`, envelope `v`, `id`, `sid`, `boot`, `issued_ms`, `expires_ms`, `base_rev`, `op`, dan nama field edge (misalnya `vfo0_frequency_hz`).
6. **Jalur lama dihapus dari console** (lihat daftar di bawah). Karena ini menghapus fitur, console dirilis sebagai **3.0.0**, supaya kanal update `2` tidak memasangnya otomatis.
7. **Alamat diatur di satu tempat**, yaitu halaman Konfigurasi console. Tidak ada aturan host tersembunyi di kode.

## Syarat supaya keputusan ini jalan

- **Broker groundstation memakai TLS untuk koneksi dari Raspberry.** Edge hanya mengirim `settings/reported` lewat broker TLS (dokumen edge: "TLS wajib"). Console tetap tersambung lewat listener loopback biasa di groundstation.
- **Versi RDF Node di groundstation disamakan dengan Raspberry.** Saat ini ground `1.0.0-20261006185856`, edge `1.0.0-20261013194717`.
- **Peran `rdf-ground.service` ditegaskan** (penerima dan receipt), supaya tidak bertabrakan dengan console di broker yang sama.

## Yang dihapus dari console

Daftar ini dari tag `v2.0.0`. Pastikan lagi saat implementasi.

| Bagian | File |
|---|---|
| Monitor topik lama | `tools/sdr_doa_mqtt.py`, `tools/sdr_doa_mqtt_monitor.py` (bagian topik lama), `/api/mqtt` |
| Kontrol ke topik lama | `frontend/src/components/overview/ControlPanel.tsx`, `frontend/src/lib/configForm.ts`, `configPatch.ts`, `controlDraft.ts`, serta handler patch di `tools/ground_console.py` (diganti, bukan dihapus) |
| Tampilan topik lama | `frontend/src/pages/MessageMonitorPage.tsx` (sakelar keluarga topik), `frontend/src/components/page/Segmented.tsx` (pilihan terkait) |
| Agent RDF-SDR bawaan repo | `tools/sdr_doa_lan_agent.py`, `Dockerfile.agent`, `docker-compose.agent.yml`, `packaging/agent/*`, `deploy/sdr-doa-lan-agent.service.example` |
| Penerbit sintetis | `tools/synthetic_mqtt_publisher.py` (diganti fixture sesuai kontrak edge bila masih dibutuhkan untuk test) |
| Dokumentasi | `AGENTS.md`, `CLAUDE.md`, `QUICKSTART.md`, runbook bagian Jalur C dan D, `deploy/mosquitto-sdr-doa-lan.acl.example`, dan dokumen rencana lama yang menyebut topik lama |

## Yang tetap

- Data Out sebagai cadangan, termasuk publication gate dan aturan freshness yang sudah ada.
- Pengaman console: bind `127.0.0.1`, POST same-origin loopback, dan konfirmasi admin untuk Kontrol.
- Aturan tampilan DoA dari kontrak edge: DoA utama hanya ditampilkan bila `ok`, revisi, urutan, timestamp, dan health cocok.

## Urutan transisi

1. Tulis tabel kontrak per topik di `docs/` console, diambil dari dokumen edge, lalu disetujui.
2. Parser console mengikuti kontrak edge.
3. Dashboard memakai MQTT, dengan Data Out sebagai cadangan.
4. Kontrol memakai format perintah edge.
5. Broker groundstation: TLS untuk Raspberry, listener dibatasi, dan akun per peran.
6. Hapus jalur lama, perbarui dokumentasi, lalu rilis 3.0.0.

## Pertanyaan yang masih terbuka

1. Berapa detik MQTT dianggap tidak segar sebelum beralih ke Data Out.
2. Perintah operasi mana yang ikut di Kontrol tahap pertama (restart SDR, restart PPP, reboot, shutdown).
3. Sertifikat TLS broker: CA lokal sendiri atau sertifikat lain. Edge memakai store CA sistem, kecuali `ca_file` diatur.
