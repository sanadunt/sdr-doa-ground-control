# Aplikasi tablet Groundstation (Android)

Aplikasi kecil yang mencari LAN view Ground Console di jaringan tablet lalu membukanya layar penuh. Operator tidak perlu mengetik IP. Chrome di Android tidak bisa membuka `groundstation.local`, jadi aplikasi mencari sendiri.

Aplikasi ini hanya mencari dan membuka. Apa yang boleh dilakukan tablet tetap diatur konsol: LAN view hanya bisa dibaca, kecuali menambah dan menghapus penanda Receiver. Tidak ada jalur tulis baru.

## Cara mencari

1. Alamat terakhir yang berhasil dicoba dulu (satu pertanyaan, sekitar 1 detik).
2. Kalau gagal, dua cara berjalan bersamaan:
   - mDNS: pertanyaan A untuk `groundstation.local` ke 224.0.0.251:5353 dari port sementara. Avahi menjawab langsung ke tablet, dengan aturan yang sama seperti `tools/mdns_resolver.py`.
   - Scan subnet: setiap alamat di subnet Wi-Fi/LAN tablet ditanya `GET /api/capabilities` di port 8788. Subnet yang lebih lebar dari /22 discan sebagai /24 di sekitar alamat tablet. Pada /24 scan selesai sekitar 2,5 detik.
3. Yang dihitung hanya jawaban `"access": "lan-view"`.
   - Satu groundstation: langsung dibuka.
   - Lebih dari satu: operator memilih.
   - 403 kosong: LAN view menolak alamat tablet. Aplikasi menyebut IP tablet dan menyuruh menambahkannya di Konfigurasi → Akses LAN.
4. "Masukkan alamat" menerima IP, `IP:port` atau URL `http://…` kalau pencarian tidak menemukan apa-apa.

Tombol Kembali di konsol: mundur satu halaman, lalu ada pilihan "Cari groundstation lain" atau "Keluar".

## Syarat di tablet

- Android 8.0 (API 26) atau lebih baru.
- Android System WebView (atau Chrome) versi 107 atau lebih baru. Konsol dibangun Vite 7 untuk Chromium 107. Kalau WebView lebih tua, aplikasi menyebut versinya dan menawarkan "Tetap buka".
- Tablet di jaringan yang sama dengan groundstation. Alamatnya harus termasuk `allowed_clients` LAN view.

## Memasang

1. Salin `groundstation-tablet-<versi>.apk` ke tablet (USB, Drive, atau `adb install`).
2. Buka file itu. Android akan meminta izin "Instal aplikasi tak dikenal" untuk aplikasi yang membukanya (Files, Chrome). Izinkan.
3. Pembaruan terpasang di atas versi lama hanya kalau APK ditandatangani kunci yang sama (lihat di bawah). Kalau kuncinya lain, hapus aplikasi lama dulu.

## Membangun

Tidak memakai Gradle. Cukup Android SDK (build-tools 34+, platform android-34) dan JDK 17:

```sh
sh packaging/android-tablet/build.sh
```

Skrip ini menjalankan tes JVM untuk kode pencarian (`test/…/CoreTest.java`, juga dijalankan CI), lalu `aapt2`, `javac`, `d8`, `zipalign` dan `apksigner`. Hasilnya `packaging/android-tablet/build/groundstation-tablet-<versi>.apk`.

- `ANDROID_HOME` default: `/opt/homebrew/share/android-commandlinetools`. `JAVA_HOME` default: `/opt/homebrew/opt/openjdk@17`.
- Kunci tanda tangan: `KEYSTORE` (default `~/.android/groundstation-tablet.keystore`), dengan kata sandinya di `KEYSTORE.pass`. Keduanya dibuat sekali saat build pertama. Simpan baik-baik: APK berikutnya harus ditandatangani kunci yang sama supaya bisa memperbarui aplikasi yang sudah terpasang. Kunci ini tidak pernah masuk repo.
- Versi aplikasi: `APP_VERSION_NAME` dan `APP_VERSION_CODE` di `build.sh`. Naikkan `APP_VERSION_CODE` setiap rilis baru.

## Isi

- `java/com/sanadunt/groundview/core/`: pencarian dalam Java biasa, tanpa API Android, supaya bisa dites di JVM.
  - `Probe`: tanya satu alamat, baca alamat yang diketik.
  - `Mdns`: pertanyaan mDNS satu kali.
  - `Discovery`: alamat tablet, daftar scan, dan penggabungannya.
- `java/com/sanadunt/groundview/MainActivity.java`: layar pencarian dan WebView layar penuh. Isinya: layar tetap menyala, audio mirror tanpa ketukan tambahan, video drone layar penuh, unduhan Records ke `Download/`, dan tautan luar dibuka di browser.
- `res/`: teks EN dan ID (`values-in`) serta ikon (gambar `frontend/public/favicon.svg`).

## Batas

- HTTP biasa di LAN, sama seperti LAN view. Tidak ada login.
- mDNS hanya mencari nama `groundstation.local`. Groundstation dengan nama host lain tetap ditemukan lewat scan subnet.
- Belum diuji otomatis di perangkat Android. Tes CI hanya mencakup kode pencarian.
