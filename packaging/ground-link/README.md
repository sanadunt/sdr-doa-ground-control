# Link T900/PPP di groundstation (t900-ground-link)

Alat host untuk link PPP lewat radio T900 antara groundstation dan RDF-SDR (Raspberry). Semuanya jalan di host groundstation, di luar Docker: console tetap di container sebagai uid 10001 tanpa kendali atas host.

| File | Isi |
|---|---|
| `t900-ground-diag` | laporan diagnosis read-only, satu file bertanda waktu; juga untuk sisi Raspberry (`--raspberry`) |
| `t900-ground-watchdog` | watchdog: deteksi, eskalasi bertahap dengan backoff, batas per jam, status "remote unreachable" |
| `t900-link` | perintah operator: `status`, `restart`, `usb-reset`, `diag`, `log` |
| `t900-ground-watchdog.service.in`, `t900-ground-watchdog.timer` | service root (`Type=oneshot`) dan timer tiap 30 detik |
| `t900-ground-usbreset.service.in` | enumerasi ulang USB lalu restart service PPP, dijalankan atas permintaan operator |
| `50-t900-ground-link.rules.in` | aturan polkit untuk user operator |
| `link.conf.example` | pengaturan dengan nilai default yang terdokumentasi |
| `install.sh`, `uninstall.sh` | pasang dan hapus |

Yang sudah ada di groundstation dan **tidak pernah diubah** oleh alat ini:

- `t900-ground-ppp.service`: `pppd call t900-ground nodetach`, `Restart=always`, `RestartSec=3`, `ExecStartPre` menunggu `/dev/t900-ground` sampai 60 detik;
- `/etc/ppp/peers/t900-ground`: `persist`, `maxfail 0`, `holdoff 3`, `lcp-echo-interval 5`, `lcp-echo-failure 3`;
- `/etc/udev/rules.d/99-t900-ground.rules`: CH340 `1a86:7523` menjadi `/dev/t900-ground`.

Installer tidak membuka port dan tidak menyentuh firewall. Watchdog hanya memakai `systemctl`, `ip`, `ping`, `usbreset` atau sysfs, dan (bila diatur) `uhubctl` atau perintah relay.

## Pasang

```sh
sudo sh packaging/ground-link/install.sh --dry-run            # lihat dulu file dan perintahnya
sudo sh packaging/ground-link/install.sh                      # operator: user rdf
sudo sh packaging/ground-link/install.sh --user NAMA          # operator lain
sudo sh packaging/ground-link/install.sh --watchdog-dry-run   # watchdog hanya mencatat tindakannya
sudo sh packaging/ground-link/install.sh --watchdog-live      # watchdog menjalankan tindakannya
```

Direktori yang sama ada di tarball console (`sdr-doa-ground-console-<V>-linux.tar.gz`, `packaging/ground-link/`). Host yang memasang console lewat `sdr-doa-docker` tidak mengunduh tarball itu: ambil tarball dari halaman rilis (cek `SHA256SUMS`) atau pakai clone repository. Butuh `/bin/sh`, systemd, `iproute2` (`ip`), `iputils-ping`, `usbutils` (`lsusb`, `usbreset`) dan, untuk aturan operator, polkit 0.106 atau lebih baru.

| Opsi | Arti |
|---|---|
| `--user NAMA` | operator yang boleh restart service PPP dan menjalankan `t900-ground-usbreset.service` tanpa password (bawaan `rdf`; harus ada) |
| `--no-polkit` | tanpa aturan polkit; operator memakai `sudo` |
| `--prefix DIR` | lokasi program (bawaan `/usr/local`) |
| `--watchdog-dry-run`, `--watchdog-live` | tulis `DRY_RUN=1` atau `0` di `link.conf` |
| `--no-watchdog` | pasang watchdog tetapi matikan timernya |
| `--dry-run` | tampilkan file dan perintah, tidak mengubah apa pun |
| `--root DIR` | pasang di bawah DIR tanpa `systemctl` (untuk test) |

Yang dipasang:

```text
/usr/local/bin/t900-link, /usr/local/bin/t900-ground-diag
/usr/local/sbin/t900-ground-watchdog
/usr/local/share/t900-ground-link/          README.md, link.conf.example, uninstall.sh, install-info
/etc/t900-ground-link/link.conf             pengaturan (root, 0644); ditulis sekali, dipertahankan saat upgrade
/etc/systemd/system/t900-ground-watchdog.service, t900-ground-watchdog.timer (enabled)
/etc/systemd/system/t900-ground-usbreset.service
/etc/polkit-1/rules.d/50-t900-ground-link.rules
/var/lib/t900-ground-link/                  state watchdog (dibuat saat pemeriksaan pertama)
```

Menjalankan installer lagi memperbarui program, unit dan aturan polkit, dan mempertahankan `link.conf`. Installer menolak menimpa file dengan nama yang sama yang tidak ia tulis sendiri. Setelah mengubah `PPP_SERVICE` di `link.conf`, jalankan installer lagi supaya aturan polkit dan unit memakai nama baru.

## Diagnosis: `t900-ground-diag`

```sh
t900-ground-diag                      # tanpa root; laporan di direktori saat ini
sudo t900-ground-diag -o /root/t900   # lengkap, dengan journal dan log kernel
t900-ground-diag -o -                 # cetak ke layar, tanpa file
t900-link diag                        # sama, lewat perintah operator
```

Satu laporan `t900-diag-<host>-<waktu UTC>.txt` berisi ringkasan, lalu: status `t900-ground-ppp.service`, 50 baris journal terakhir service itu (pppd), `ip addr` dari `ppp0` dan rute ke peer, node `/dev/t900-ground` dan targetnya, `lsusb -d 1a86:7523` beserta lokasi sysfs dan driver (`3-2`, `ch341 on 3-2:1.0`), 30 baris kernel terakhir tentang `usb`, `ch341` dan `ttyUSB` (boot ini), tiga ping ke `10.90.0.2` lewat `ppp0`, `udevadm info` dari node itu, dan status watchdog. Skrip tidak mengubah apa pun.

Tanpa root (atau grup `systemd-journal`/`adm`) bagian journal pppd dan log kernel dilewati; laporan dan output menyebut bagian mana, dan `sudo` memberi laporan lengkap. Bagian lain tidak butuh root.

Nilai bawaan untuk groundstation: service `t900-ground-ppp.service`, device `/dev/t900-ground`, interface `ppp0`, peer `10.90.0.2`, USB `1a86:7523`, atau nilai di `/etc/t900-ground-link/link.conf` bila ada. Opsi `--service`, `--device`, `--iface`, `--peer`, `--usb-id` dan `--config` mengubahnya. Di Raspberry, `--raspberry` memakai `t900-ppp.service`, `/dev/t900` dan peer `10.90.0.1` tanpa file config. Skrip ini berdiri sendiri, jadi cukup salin satu file:

```sh
scp packaging/ground-link/t900-ground-diag USER@RDF-SDR:/tmp/
ssh USER@RDF-SDR 'sudo sh /tmp/t900-ground-diag --raspberry -o /tmp'
```

## Prosedur insiden

Jalankan bila link putus dan watchdog sudah berstatus "remote unreachable" (`t900-link status`), atau watchdog belum dipasang. Selama watchdog masih bertindak sendiri, tunggu sampai ia berhenti, atau hentikan dulu timernya (`sudo systemctl stop t900-ground-watchdog.timer`) supaya langkah manual dan otomatis tidak bercampur.

1. Diagnosis awal: `sudo t900-ground-diag -o ~/t900` (satu file per langkah, nama bertanda waktu).
2. **Langkah 1, restart service:** `t900-link restart`. Tunggu 30–60 detik, lalu `sudo t900-ground-diag -o ~/t900`.
3. **Langkah 2, usbreset lalu restart:** `t900-link usb-reset` (`usbreset` adapter `1a86:7523`, tunggu 5 detik, restart service). Tunggu 30–60 detik, lalu diag lagi.
4. **Langkah 3, cabut-colok USB T900:** baru sekarang, karena ini satu-satunya langkah yang memutus daya T900. Tunggu 30–60 detik (`ExecStartPre` menunggu device sampai 60 detik), lalu diag lagi.
5. Simpan semua laporan dan catat langkah yang memulihkan link. Bila timer dihentikan: `sudo systemctl start t900-ground-watchdog.timer`.

Langkah yang memulihkan menunjukkan lapisan yang macet:

| Pulih setelah | Kemungkinan lapisan yang macet | Tindak lanjut |
|---|---|---|
| langkah 1, restart | pppd atau state sesi PPP di ground | cukup tahap restart watchdog |
| langkah 2, usbreset + restart | driver `ch341`/CH340 atau state USB di ground; radio T900 masih hidup | tahap USB watchdog menangani ini |
| langkah 3, cabut-colok | radio T900 ground yang perlu kehilangan daya (`usbreset` hanya mengenumerasi ulang, tidak memutus daya) | pasang hub `uhubctl` atau relay, lalu `POWER_METHOD` (bagian Daya) |
| tidak pulih | link RF atau sisi Raspberry (T900 UAV, pppd di Raspberry) | `t900-ground-diag --raspberry` di Raspberry bila bisa dijangkau |

Membaca laporan:

| Tanda | Artinya |
|---|---|
| `usb: 1a86:7523 not found`, device hilang | adapter tidak terenumerasi: kabel, hub, daya, atau CH340 |
| USB ada, `/dev/t900-ground` hilang | udev rule atau driver `ch341` |
| device ada, journal berisi `LCP: timeout` berulang, `ppp0` tanpa alamat | pppd mengirim tetapi tidak ada jawaban LCP: radio T900 (ground atau UAV), link RF, atau pppd di Raspberry |
| `No response to 3 echo-requests` | sesi sempat terbentuk lalu putus: link RF atau sisi remote |
| `ppp0` punya alamat, ping `0/3` | LCP jalan, tetapi IP di Raspberry tidak menjawab |
| angka `automatic restarts` naik terus | pppd keluar berulang; lihat journal |

## Watchdog

Timer menjalankan `t900-ground-watchdog check` tiap 30 detik (pertama 2 menit setelah boot). Link dianggap putus bila `ppp0` tidak ada, tidak punya alamat IPv4, atau `10.90.0.2` tidak menjawab satu pun dari tiga ping lewat `ppp0`. Setelah `FAIL_AFTER` detik putus, setiap pemeriksaan boleh mengambil satu tindakan, dengan jarak `BACKOFF_BASE` detik yang berlipat dua sampai `BACKOFF_MAX`:

1. restart `t900-ground-ppp.service` (`systemctl reset-failed`, lalu `restart`);
2. enumerasi ulang USB (`usbreset BUS/DEV` dari adapter di balik `/dev/t900-ground`, atau unbind/bind `ch341` lewat sysfs), tunggu `USB_SETTLE`, restart service;
3. hanya bila `POWER_METHOD` diatur: putus-sambung daya T900 (`uhubctl` atau perintah relay), tunggu `POWER_SETTLE`, restart service;
4. lalu dari langkah 1 lagi.

Dengan nilai bawaan dan tanpa pengatur daya: putus di detik 0, restart di 180, USB di 300, restart di 540, USB di 1020. Bila `MAX_ACTIONS_PER_HOUR` (4) tindakan dalam satu jam terakhir tidak memulihkan link, watchdog masuk status **remote unreachable** dan tidak bertindak lagi sampai sesi PPP baru terbentuk (`ppp0` mendapat alamat dengan ifindex baru) atau peer menjawab lagi. Restart oleh operator yang menghasilkan sesi baru juga mengakhiri status itu; `sudo t900-ground-watchdog reset` menghapus status, riwayat tindakan, dan hitungan per jam.

Watchdog tidak bertindak bila `t900-ground-ppp.service` dihentikan atau dinonaktifkan operator (`systemctl stop` atau `disable`), dan mulai mengawasi lagi saat service jalan. Satu run pada satu waktu: pemeriksaan yang bertemu `usb-reset` operator yang sedang jalan dilewati. Setelah `usb-reset` operator, watchdog menunggu `BACKOFF_BASE` detik sebelum bertindak sendiri.

Semua pesan masuk journal dengan tag tetap `t900-ground-watchdog`:

```sh
journalctl -t t900-ground-watchdog -f        # atau: t900-link log 50
t900-link status                             # tanpa root: kondisi dan tindakan terakhir
sudo t900-ground-watchdog --dry-run check    # apa yang akan dilakukan sekarang, tanpa menjalankannya
sudo t900-ground-watchdog check-config       # periksa link.conf, tampilkan nilai yang dipakai
sudo systemctl stop t900-ground-watchdog.timer      # jeda sampai boot berikutnya
sudo systemctl disable --now t900-ground-watchdog.timer   # matikan
```

Contoh baris journal: `link down: ppp0 has no IPv4 address`, `link down 180 s (ppp0 has no IPv4 address): action 1, 1 of 4 this hour: restart t900-ground-ppp.service`, `ran: usbreset 003/005`, `remote unreachable: 4 recovery actions in the last hour did not bring the link back (...)`, `new PPP session on ppp0 (...): remote unreachable hold cleared`, `link up: 10.90.0.2 answers on ppp0 (...)`.

Mode dry run (`DRY_RUN=1`, `--watchdog-dry-run`, atau `--dry-run` pada satu perintah) mencatat setiap tindakan sebagai `dry-run: would run: ...` tanpa menjalankannya, memakai state terpisah (`state.dry-run`), jadi beralih ke mode live mulai bersih. Cara aman memasang pertama kali: `--watchdog-dry-run`, amati journal sehari, lalu `--watchdog-live`.

### Pengaturan (`/etc/t900-ground-link/link.conf`)

Format `NAMA=NILAI`, dibaca apa adanya (tanpa ekspansi `$`); nilai dengan spasi diberi kutip. Baris yang tidak ada memakai nilai bawaan. File harus milik root dan hanya bisa ditulis pemiliknya, karena watchdog menjalankan perintah relay dari file ini sebagai root; nama yang tidak dikenal atau nilai yang salah menghentikan watchdog dengan exit 78 dan pesan di journal. Periksa dengan `t900-ground-watchdog check-config`.

| Nama | Bawaan | Arti |
|---|---|---|
| `PPP_SERVICE` | `t900-ground-ppp.service` | service PPP |
| `PPP_DEVICE` | `/dev/t900-ground` | node device T900 dari udev |
| `PPP_IFACE` | `ppp0` | interface PPP |
| `PEER` | `10.90.0.2` | alamat ujung lain (Raspberry) |
| `USB_ID` | `1a86:7523` | id USB adapter CH340 |
| `DRY_RUN` | `0` | `1`: catat tindakan, jangan jalankan |
| `FAIL_AFTER` | `180` | detik putus sebelum tindakan pertama (30–86400) |
| `PING_COUNT`, `PING_TIMEOUT` | `3`, `2` | jumlah ping dan batas waktu tiap ping (detik) |
| `BACKOFF_BASE`, `BACKOFF_MAX` | `120`, `900` | jarak antar tindakan: awal, berlipat dua sampai batas ini |
| `MAX_ACTIONS_PER_HOUR` | `4` | batas tindakan per jam sebelum status remote unreachable (1–60) |
| `USB_RESET_METHOD` | `auto` | `auto` (`usbreset` bila terpasang, selain itu `unbind`), `usbreset`, `unbind` (unbind/bind `ch341`), `none` |
| `USB_SETTLE` | `5` | detik menunggu setelah enumerasi ulang |
| `POWER_METHOD` | `none` | `none`, `uhubctl`, `relay` |
| `UHUBCTL_LOCATION`, `UHUBCTL_PORT` | kosong | lokasi hub dan port untuk `uhubctl -l LOKASI -p PORT -a cycle` |
| `RELAY_OFF_COMMAND`, `RELAY_ON_COMMAND` | kosong | perintah relay (dijalankan `sh -c` sebagai root); "on" selalu dijalankan, juga setelah "off" gagal |
| `POWER_OFF_SECONDS` | `5` | lama daya diputus |
| `POWER_SETTLE` | `10` | detik menunggu setelah daya kembali |

## Pemicu operator: `t900-link`

```sh
t900-link status       # service PPP, ppp0, status watchdog, jadwal timer
t900-link restart      # restart t900-ground-ppp.service
t900-link usb-reset    # systemctl start t900-ground-usbreset.service: usbreset, lalu restart service
t900-link diag         # laporan t900-ground-diag (opsi sama)
t900-link log 50       # 50 baris journal watchdog
```

Aturan polkit `50-t900-ground-link.rules` mengizinkan user operator (bawaan `rdf`) menjalankan tepat dua hal tanpa password: `restart` untuk `t900-ground-ppp.service` dan `start` untuk `t900-ground-usbreset.service`. Tindakan systemd lain, dan user lain, tetap meminta autentikasi. Aturan JavaScript butuh polkit 0.106 atau lebih baru (Debian 12, Ubuntu 23.10 ke atas); di Ubuntu 22.04 (polkit 0.105) installer memberi peringatan dan operator memakai `sudo systemctl restart t900-ground-ppp.service` atau `sudo systemctl start t900-ground-usbreset.service`. Membaca journal (`t900-link log`, bagian journal di diag) butuh grup `systemd-journal`: `sudo usermod -aG systemd-journal rdf` (berlaku setelah login ulang).

## Usulan: tombol di console (belum dibuat)

Console berjalan di Docker sebagai uid 10001 dan tidak boleh mendapat kendali host: tanpa socket Docker, D-Bus, polkit, capability tambahan, atau port baru. Karena itu belum ada tombol. Rancangan bila nanti dibutuhkan:

1. **Tampil saja.** Watchdog menulis ringkasan statusnya (kondisi link, sejak kapan, tindakan terakhir, remote unreachable) ke satu file JSON di direktori host yang di-mount read-only ke container. System Health menampilkan chip link T900 dari file itu. Tidak ada jalur tulis.
2. **Tombol.** Console (admin, dengan langkah konfirmasi seperti Kontrol) menulis file permintaan berisi tepat `restart` atau `usb-reset` ke direktori khusus di volumenya. Unit `.path` di host memicu service root oneshot yang hanya menerima dua kata itu, menghapus permintaan, memakai lock dan batas per jam watchdog, dan mencatat dengan tag yang sama. Ini menambah jalur tulis dari console ke host, jadi perlu keputusan pemilik sebelum dibuat (aturan di `AGENTS.md`: hanya satu jalur tulis).

## Daya: bila hanya cabut-colok yang menolong

`usbreset` dan unbind/bind tidak memutus daya T900. Bila prosedur insiden menunjukkan hanya cabut-colok yang memulihkan, tambahkan salah satu:

- hub USB dengan per-port power switching yang didukung `uhubctl` (daftar di proyek uhubctl). Pasang `uhubctl`, jalankan `sudo uhubctl` untuk melihat lokasi hub dan port T900, lalu isi `POWER_METHOD=uhubctl`, `UHUBCTL_LOCATION` dan `UHUBCTL_PORT`. Banyak hub dan port root tidak benar-benar memutus VBUS; uji dulu dengan `sudo uhubctl -l LOKASI -p PORT -a cycle` sambil melihat lampu T900;
- relay di jalur daya T900, dengan `POWER_METHOD=relay`, `RELAY_OFF_COMMAND` dan `RELAY_ON_COMMAND`.

Lalu `sudo t900-ground-watchdog --dry-run check` saat link putus memperlihatkan perintahnya tanpa menjalankannya.

## Sisi Raspberry

Watchdog ini hanya untuk ground. Edge RDF Node mengiklankan perintah `cmd/service/ppp/restart`, tetapi perintah itu hanya sampai ke Raspberry bila MQTT punya jalur selain PPP yang putus, misalnya broker cadangan edge (`mqtt.backup`) yang perlu diatur di edge. Untuk diagnosis di Raspberry pakai `t900-ground-diag --raspberry`.

## Hapus

```sh
sudo sh /usr/local/share/t900-ground-link/uninstall.sh            # link.conf dan state tetap
sudo sh /usr/local/share/t900-ground-link/uninstall.sh --purge    # hapus juga
sudo sh /usr/local/share/t900-ground-link/uninstall.sh --dry-run  # lihat dulu
```

Uninstaller menghentikan timer, menghapus unit, aturan polkit dan program, dan hanya file yang ditulis installer. Service PPP, file peer dan udev rule tetap.

Test: `tools/test_ground_link.py` menjalankan semua skrip dengan perintah palsu di PATH, sysfs palsu dan jam tetap.
