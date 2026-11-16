# Mulai ulang, Matikan dan Update groundstation (sdr-doa-host-power)

Sisi host untuk tombol **Mulai ulang** (Restart) dan **Matikan** (Shutdown) di bilah atas console, tepat setelah EN|ID, dan sejak 3.23.0 untuk tombol **Update** di kartu "Pembaruan console" halaman Konfigurasi (bagian [Update console](#update-console) di bawah). Chrome di groundstation berjalan layar penuh, jadi Ubuntu dimatikan dari console sendiri. Keputusan pemilik pada 2026-10-31: tombol ini hanya memakai konfirmasi di halaman, tanpa admin, karena siapa pun di depan layar groundstation sudah bisa mematikan Ubuntu.

Ini satu-satunya jalur tulis dari console ke host, dan hanya dari halaman console sendiri (loopback). Langkah untuk Mulai ulang dan Matikan:

1. Tombol hanya tampil di halaman console sendiri (`access: "local"`). LAN view (tablet) tidak mendapat tombol, tidak mendapat `host_power` di `/api/capabilities`, dan listener LAN menolak route ini dengan 405 `LAN_READ_ONLY` (satu-satunya POST yang ia terima adalah perintah penanda Receiver, `POST /api/mirror/receiver/markers`).
2. Klik membuka konfirmasi yang menyebut aksinya. Fokus ada di **Batal**, Escape membatalkan. Bila `/api/health` melaporkan `receiver_busy` (Receiver sedang menulis rekaman atau pindaian), konfirmasi memperingatkannya. Hanya tombol aksi di konfirmasi yang mengirim.
3. `POST /api/host/power {action: "reboot"|"poweroff", confirm: true}` butuh `Origin` loopback yang sama (selain itu 403 `ORIGIN_REJECTED`, sebelum body dibaca), body ketat dan paling besar 256 byte. Console menulis `/run/sdr-doa-host-power/request` berisi tepat `reboot` atau `poweroff`, tanpa baris baru: ke nama sementara dulu, lalu di-hard-link ke `request`. Permintaan yang belum diambil host tidak ditimpa (409 `HOST_POWER_PENDING`).
4. `sdr-doa-host-power.path` (`PathExists=`) memulai `sdr-doa-host-power.service` (root, `Type=oneshot`, `PrivateDevices=yes`, batas 30 detik, tanpa batas start: setiap run menghapus permintaannya, juga yang ditolak atau tidak bisa diambil, jadi `PathExists` tidak pernah memulainya berulang-ulang, dan unit `.path` tetap punya batas pemicunya sendiri). Direktori permintaan milik user console, jadi user itu bisa mengganti `request` kapan saja, misalnya dengan FIFO atau symlink, di antara pemeriksaan dan pembukaan. Karena itu helper tidak pernah membuka `request` di sana: hard link (`ln -P`; berbeda dengan `mv`, ia gagal antar-filesystem atau antar-mount alih-alih menyalin) mengambil inode itu apa adanya ke `/run/sdr-doa-host-power.taken`, direktori milik root (dibuat `mkdir -m 0700`, dipakai hanya bila milik root dan tidak bisa ditulis user lain), lalu nama di direktori console dihapus. Pemeriksaan (file biasa, bukan symlink, FIFO atau device), pembacaan (paling banyak 9 byte, tanpa menunggu: lease milik user console tidak bisa menahan root) dan penghapusan terjadi di sana, dan helper bertindak **hanya bila penghapusan berhasil**, jadi permintaan tidak pernah terbawa ke boot berikutnya. Ia hanya menerima dua kata itu, menolak permintaan kedua dalam 60 detik setelah tindakan terakhir pada boot yang sama, lalu menjalankan `systemctl reboot` atau `systemctl poweroff`.

Console tidak mendapat socket Docker, D-Bus, polkit, sudo, capability tambahan, atau port baru. Yang bisa menulis permintaan hanya uid console: 10001 di Docker (hanya proses console), atau user operator pada instalasi native (user itu sudah bisa mematikan PC lewat desktop).

| File | Isi |
|---|---|
| `sdr-doa-host-power` | helper: `handle` (service), `run-update` (service update), `status`, `--dry-run` |
| `sdr-doa-host-power.path.in` | unit `.path` yang mengawasi `/run/sdr-doa-host-power/request` |
| `sdr-doa-host-power.service.in` | service root `Type=oneshot` yang menjalankan helper |
| `sdr-doa-host-power.tmpfiles.in` | aturan tmpfiles.d: direktori permintaan untuk user console dan penanda `helper` |
| `sdr-doa-host-power-update.service.in` | service root `Type=oneshot` yang menjalankan `sdr-doa-docker update` (hanya bila instalasi Docker ditemukan) |
| `install.sh`, `uninstall.sh` | pasang dan hapus |

## Direktori permintaan

`/run/sdr-doa-host-power`, milik user console dengan mode `0700`, dibuat oleh `systemd-tmpfiles` saat install dan di setiap boot (sebelum Docker mulai). Di dalamnya ada `helper` (milik root) yang memberi tahu console bahwa sisi host terpasang. `/run` kosong setelah setiap boot, jadi tidak ada permintaan yang tersisa dari boot sebelumnya.

- **Docker** (`sdr-doa-docker`, `docker-compose*.yml`): compose me-mount `/run/sdr-doa-host-power` dari host ke path yang sama di container. `compose.yml` yang ditulis `sdr-doa-docker` 3.3.0 ke atas sudah memuatnya. `sdr-doa-docker update` dan timer hariannya hanya mengganti image dan **tidak pernah menulis ulang** `compose.yml`, jadi instalasi yang dipasang sebelum 3.3.0 (seperti `/opt/sdr-doa-ground-console` di groundstation) tetap tanpa mount setelah update ke 3.3.0: tombol tampil nonaktif dengan alasan "Direktori permintaan belum di-mount" (`DIR_NOT_MOUNTED`). `update` juga tidak mengganti script yang terpasang di `/usr/local/bin/sdr-doa-docker`, dan `install` dari script 3.2.0 itu menulis `compose.yml` tanpa mount. Perbaikannya sekali, saat tidak ada rekaman: pasang dulu script 3.3.0 (aset `sdr-doa-docker` rilis itu, atau `packaging/docker/sdr-doa-docker` di tarball), lalu jalankan `install`-nya:

  ```sh
  sudo install -m 0755 packaging/docker/sdr-doa-docker /usr/local/bin/sdr-doa-docker
  sudo /usr/local/bin/sdr-doa-docker install --dir /opt/sdr-doa-ground-console
  ```

  `install` menulis ulang `compose.yml` dengan mount dan membuat ulang container, dan mempertahankan `.env` (kanal, port, kata sandi atau seed yang ada di sana), volume `sdr-doa-data` (semua pengaturan dan rekaman) dan timer update. `install.sh` di sini memperingatkan bila `compose.yml` itu (`--docker-dir`) belum memuat mount, lengkap dengan perintahnya. Tanpa sisi host, Docker membuat direktori kosong milik root untuk mount itu; console tidak bisa menulis di sana dan tombol tampil nonaktif dengan alasan "Helper host belum dipasang untuk console ini".
- **Native** (`packaging/console/install.sh`, service systemd user): console membaca `/run/sdr-doa-host-power` langsung (`--host-power-dir`, bawaan path itu; kosong mematikan fitur). Pasang dengan `--console-user` user yang menjalankan console.

Console memeriksa direktori saat membaca `/api/capabilities`, yaitu saat halaman dimuat. Setelah memasang atau menghapus sisi host, muat ulang halaman console (F5).

## Pasang

```sh
sudo sh packaging/host-power/install.sh --dry-run          # lihat dulu file dan perintahnya
sudo sh packaging/host-power/install.sh                    # console di Docker (uid 10001)
sudo sh packaging/host-power/install.sh --console-user rdf # console native milik user rdf
```

Direktori yang sama ada di tarball console (`sdr-doa-ground-console-<V>-linux.tar.gz`, `packaging/host-power/`). Host yang memasang console lewat `sdr-doa-docker` tidak mengunduh tarball itu: ambil tarball dari halaman rilis (cek `SHA256SUMS`) atau pakai clone repository. Butuh `/bin/sh`, systemd (dengan `systemd-tmpfiles`) dan coreutils.

| Opsi | Arti |
|---|---|
| `--console-user NAMA\|UID` | user console yang boleh menulis permintaan (bawaan `10001`, uid image Docker; angka berarti uid dan gid yang sama). Root ditolak |
| `--helper-dry-run`, `--helper-live` | helper hanya mencatat tindakannya, atau menjalankannya (bawaan live). Tanpa opsi ini, install ulang mempertahankan mode sebelumnya |
| `--docker-dir DIR` | instalasi `sdr-doa-docker` yang `compose.yml`-nya harus me-mount direktori permintaan dan yang diperbarui tombol Update (bawaan `/opt/sdr-doa-ground-console`); hanya dipakai bila `DIR/compose.yml` ada, dan tidak pernah diubah |
| `--update-script PATH` | `sdr-doa-docker` yang dijalankan root untuk Update (bawaan `/usr/local/bin/sdr-doa-docker`); file itu dan setiap direktori di atasnya harus milik root dan tidak bisa ditulis user lain, kalau tidak Update tetap mati |
| `--no-update` | tanpa tombol Update (Update juga mati bila `DIR/compose.yml` tidak ada, seperti pada console native) |
| `--prefix DIR` | lokasi program (bawaan `/usr/local`); `sbin`, `share/sdr-doa-host-power` dan setiap direktori di atasnya harus milik root dan tidak bisa ditulis user lain |
| `--dry-run` | tampilkan file dan perintah, tidak mengubah apa pun; berakhir dengan exit 1 bila install akan berhenti |
| `--root DIR` | pasang di bawah DIR tanpa `systemctl` (untuk test) |

Yang dipasang:

```text
/usr/local/sbin/sdr-doa-host-power
/usr/local/share/sdr-doa-host-power/          README.md, uninstall.sh, install-info
/etc/systemd/system/sdr-doa-host-power.path   (enabled)
/etc/systemd/system/sdr-doa-host-power.service
/etc/systemd/system/sdr-doa-host-power-update.service   (hanya dengan Update)
/etc/tmpfiles.d/sdr-doa-host-power.conf
/run/sdr-doa-host-power/                      direktori permintaan, penanda helper dan update-helper (dibuat tmpfiles), update-status
/run/sdr-doa-host-power.taken/                milik root (0700): permintaan diambil ke sini (hard link) sebelum diperiksa
/var/lib/sdr-doa-host-power/                  tindakan terakhir (dibuat saat permintaan pertama)
```

Installer menolak menimpa file dengan nama yang sama yang tidak ia tulis sendiri, dan menolak `--prefix` yang direktorinya (atau direktori di atasnya) bukan milik root atau bisa ditulis user lain, karena service root menjalankan `sbin/sdr-doa-host-power` dari sana. Ia tidak membuka port dan tidak menyentuh firewall, sudoers, polkit, atau unit console.

## Uji tanpa mematikan PC

```sh
sudo sh packaging/host-power/install.sh --helper-dry-run
# muat ulang console (F5), klik Mulai ulang, konfirmasi
journalctl -t sdr-doa-host-power -n 5         # dry-run: would run: systemctl reboot (requested by the console)
sudo sh packaging/host-power/install.sh --helper-live
```

## Status dan log

```sh
sudo sdr-doa-host-power status            # direktori, penanda, permintaan yang menunggu, tindakan terakhir
journalctl -t sdr-doa-host-power -f       # pesan helper dengan tag tetap
systemctl status sdr-doa-host-power.path
```

Contoh baris journal: `running: systemctl reboot (requested by the console)`, `refused poweroff: reboot ran 12 s ago, less than 60 s`, `refused a request: it does not hold exactly reboot or poweroff`, `refused a request: it is not a regular file`, `cannot take /run/sdr-doa-host-power/request (it changed, or is on another file system or mount); refused it and removed it`.

| Console menampilkan | Artinya |
|---|---|
| tombol nonaktif, "Direktori permintaan belum di-mount" (`DIR_NOT_MOUNTED`) | console di Docker dengan `compose.yml` tanpa mount (dipasang sebelum 3.3.0; `update` tidak menulis ulang file itu dan tidak mengganti script yang terpasang): `sudo install -m 0755 packaging/docker/sdr-doa-docker /usr/local/bin/sdr-doa-docker`, lalu `sudo /usr/local/bin/sdr-doa-docker install --dir /opt/sdr-doa-ground-console` sekali, lalu muat ulang halaman. `.env`, volume dan timer tetap |
| tombol nonaktif, "Helper host belum dipasang" (`DIR_MISSING`, `HELPER_MISSING`) atau "... untuk console ini" (`DIR_NOT_WRITABLE`) | `/run/sdr-doa-host-power` tidak ada di host (native), tidak bisa ditulis uid console (sisi host belum dipasang, atau untuk `--console-user` lain), atau tanpa penanda `helper`: pasang sisi host, lalu muat ulang halaman |
| tombol nonaktif, "Dimatikan di console ini" | console dijalankan dengan `--host-power-dir ''` |
| "Host belum mengambil permintaan sebelumnya." (`HOST_POWER_PENDING`) | ada `request` yang belum diambil: `systemctl status sdr-doa-host-power.path` dan journal |
| "Mulai ulang diminta", tetapi PC tetap menyala | helper menolaknya (journal: dalam 60 detik, mode dry run) atau `systemctl` gagal |

## Update console

Keputusan pemilik pada 2026-11-16 ("di menu konfigurasi ditambah tombol update gitu? Biar aku gampang"): console di groundstation diperbarui dari halaman Konfigurasi, tanpa Terminal. Ini jenis tulis kedua dari console ke host, lewat jalur yang sama dengan Mulai ulang dan Matikan.

1. Kartu **Pembaruan console** hanya tampil di halaman console sendiri; LAN view tidak mendapatnya, dan listener LAN menolak `GET` (403) dan `POST` (405) `/api/host/update`. Kartu menunjukkan versi terpasang, rilis terbaru (stabil, major yang sama, seperti kanal `sdr-doa-docker`; dibaca console dari GitHub API tanpa login, disimpan 10 menit), kesiapan helper host dan update terakhir. Tanpa internet kartu menulis "Tanpa internet: GitHub tidak terjangkau"; tombol Update tetap bisa dipakai (update-nya gagal di tahap tarik image, dan versi lama tetap berjalan).
2. **Update** membuka konfirmasi dengan fokus di **Batal**; Escape membatalkan. Bila `/api/health` melaporkan `receiver_busy`, konfirmasi memperingatkan bahwa rekaman atau pindaian berhenti.
3. `POST /api/host/update {confirm: true}` (Origin loopback yang sama, body paling besar 64 byte) menulis `request` berisi tepat `update`. Update yang masih berjalan menolak permintaan baru (409 `HOST_UPDATE_RUNNING`).
4. Helper `handle` mengambil permintaan seperti biasa, lalu hanya bila ada penanda `update-helper` memulai `sdr-doa-host-power-update.service` (`systemctl start --no-block`) dan selesai. Service itu (root, `Type=oneshot`, batas 45 menit) menjalankan `sdr-doa-host-power run-update /usr/local/bin/sdr-doa-docker /opt/sdr-doa-ground-console`, yaitu `sdr-doa-docker update --dir DIR --yes` di luar container console (update memulai ulang container itu). `--yes` karena operator sudah mengonfirmasi di halaman. Script hanya dijalankan bila ia dan direktorinya milik root dan tidak bisa ditulis user lain.
5. Helper menerjemahkan baris `sdr-doa-docker` menjadi `/run/sdr-doa-host-power/update-status` (`STATE` `queued`, `running` dengan `PHASE` `preparing`, `pulling`, `starting`, `rolling_back`, lalu `ok`, `up_to_date`, `not_updated`, `rolled_back`, `failed` atau `dry_run`; `TO` versi baru; `MESSAGE` baris `FAILED` pertama dari `update.log`). File itu milik root: ditulis di `/run/sdr-doa-host-power.taken` lalu di-hard-link ke direktori console, jadi user console bisa membaca atau menghapusnya tetapi tidak mengubahnya atau membelokkan tulisan root ke tempat lain. Setiap baris `sdr-doa-docker` juga masuk journal (`journalctl -t sdr-doa-host-power`).
6. Halaman mengikuti statusnya ("Menunggu helper host…", "Menarik versi baru…", "Console sedang dimulai ulang…"), menunggu `/api/host/update` menjawab lagi setelah container dimulai ulang, lalu memuat ulang dirinya ke versi baru. Bila versi baru gagal health check, `sdr-doa-docker` memasang kembali versi lama dan kartu menulis "Update gagal; versi sebelumnya berjalan lagi" beserta alasannya.

Installer memasang Update hanya bila `--docker-dir`/`compose.yml` ada dan `--update-script` aman dijalankan root; keluarannya menulis `Update:  on: ...` atau alasan mati. **Console native** (`sdr-doa-console`) belum didukung: kartu menulis "Bukan instalasi Docker: perbarui dengan sdr-doa-console update" (`NOT_DOCKER`), karena update native berjalan sebagai user, bukan root.

Pemasangan pertama, sekali dengan sudo di groundstation (console 3.23.0 sudah berjalan, misalnya setelah `sudo /usr/local/bin/sdr-doa-docker update --dir /opt/sdr-doa-ground-console`):

```sh
cd ~/sdr-doa-dl/console-3.23.0                # tarball rilis 3.23.0, dicek dengan SHA256SUMS
sudo sh sdr-doa-ground-console-3.23.0-linux/packaging/host-power/install.sh --dry-run
sudo sh sdr-doa-ground-console-3.23.0-linux/packaging/host-power/install.sh
```

Install ulang mempertahankan mode helper (live atau dry run). Lalu muat ulang halaman console (F5): kartu Pembaruan console menulis helper "Siap". Dengan `--helper-dry-run` service update hanya mencatat perintahnya dan kartu menulis "Helper host dalam mode dry-run".

| Kartu Pembaruan console | Artinya |
|---|---|
| Helper "Helper host belum punya Update" (`UPDATE_HELPER_MISSING`) | sisi host lebih tua dari 3.23.0, atau installer tidak menemukan instalasi `sdr-doa-docker`/script yang aman (lihat baris `Update:` keluarannya): jalankan `install.sh` 3.23.0, lalu muat ulang halaman |
| "Helper host belum mengambil permintaan" | `systemctl status sdr-doa-host-power.path`, `sudo sdr-doa-host-power status` |
| "Update gagal" dengan "FAILED: pull of ...: ... no such host" | groundstation tanpa internet saat menarik image; versi lama tetap berjalan |
| "Image X belum terbit" | rilis sudah ada di GitHub tetapi image GHCR-nya masih dibangun (beberapa menit setelah rilis): coba lagi nanti |
| "Gagal, versi lama kembali" | versi baru tidak sehat; `sdr-doa-docker` mengembalikan versi lama dan mencatat image itu di `.bad-images` (`/opt/sdr-doa-ground-console/update.log`) |

## Hapus

```sh
sudo sh /usr/local/share/sdr-doa-host-power/uninstall.sh            # state tetap
sudo sh /usr/local/share/sdr-doa-host-power/uninstall.sh --purge    # hapus juga state
sudo sh /usr/local/share/sdr-doa-host-power/uninstall.sh --dry-run  # lihat dulu
```

Uninstaller menghentikan unit `.path`, menghapus unit (juga service update), aturan tmpfiles.d, program, penanda `helper` dan `update-helper`, status update, permintaan yang menunggu dan `/run/sdr-doa-host-power.taken`. Direktori di `/run` hilang pada boot berikutnya. Setelah itu tombol console tampil nonaktif (muat ulang halaman).

Test: `tools/test_host_power.py` (route Mulai ulang/Matikan), `tools/test_host_update.py` (route Update, status, cek rilis GitHub dengan GitHub palsu di loopback) dan `tools/test_host_power_kit.py` (helper, update dengan `sdr-doa-docker` palsu, installer dan uninstaller dengan perintah palsu di PATH dan jam tetap).
