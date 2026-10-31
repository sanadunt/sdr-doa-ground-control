# Mulai ulang dan Matikan PC groundstation (sdr-doa-host-power)

Sisi host untuk tombol **Mulai ulang** (Restart) dan **Matikan** (Shutdown) di bilah atas console, tepat setelah EN|ID. Chrome di groundstation berjalan layar penuh, jadi Ubuntu dimatikan dari console sendiri. Keputusan pemilik pada 2026-10-31: tombol ini hanya memakai konfirmasi di halaman, tanpa admin, karena siapa pun di depan layar groundstation sudah bisa mematikan Ubuntu.

Ini satu-satunya jalur tulis dari console ke host, dan hanya dari halaman console sendiri (loopback):

1. Tombol hanya tampil di halaman console sendiri (`access: "local"`). LAN view (tablet) tidak mendapat tombol, tidak mendapat `host_power` di `/api/capabilities`, dan listener LAN menolak setiap POST dengan 405 `LAN_READ_ONLY`.
2. Klik membuka konfirmasi yang menyebut aksinya. Fokus ada di **Batal**, Escape membatalkan. Bila `/api/health` melaporkan `receiver_busy` (Receiver sedang menulis rekaman atau pindaian), konfirmasi memperingatkannya. Hanya tombol aksi di konfirmasi yang mengirim.
3. `POST /api/host/power {action: "reboot"|"poweroff", confirm: true}` butuh `Origin` loopback yang sama (selain itu 403 `ORIGIN_REJECTED`, sebelum body dibaca), body ketat dan paling besar 256 byte. Console menulis `/run/sdr-doa-host-power/request` berisi tepat `reboot` atau `poweroff`, tanpa baris baru: ke nama sementara dulu, lalu di-hard-link ke `request`. Permintaan yang belum diambil host tidak ditimpa (409 `HOST_POWER_PENDING`).
4. `sdr-doa-host-power.path` (`PathExists=`) memulai `sdr-doa-host-power.service` (root, `Type=oneshot`). Helper membaca paling banyak 16 byte dari file biasa (bukan symlink, FIFO atau device), menghapus permintaan, dan bertindak **hanya bila penghapusan berhasil**, jadi permintaan tidak pernah terbawa ke boot berikutnya. Ia hanya menerima dua kata itu, menolak permintaan kedua dalam 60 detik setelah tindakan terakhir pada boot yang sama, lalu menjalankan `systemctl reboot` atau `systemctl poweroff`.

Console tidak mendapat socket Docker, D-Bus, polkit, sudo, capability tambahan, atau port baru. Yang bisa menulis permintaan hanya uid console: 10001 di Docker (hanya proses console), atau user operator pada instalasi native (user itu sudah bisa mematikan PC lewat desktop).

| File | Isi |
|---|---|
| `sdr-doa-host-power` | helper: `handle` (service), `status`, `--dry-run` |
| `sdr-doa-host-power.path.in` | unit `.path` yang mengawasi `/run/sdr-doa-host-power/request` |
| `sdr-doa-host-power.service.in` | service root `Type=oneshot` yang menjalankan helper |
| `sdr-doa-host-power.tmpfiles.in` | aturan tmpfiles.d: direktori permintaan untuk user console dan penanda `helper` |
| `install.sh`, `uninstall.sh` | pasang dan hapus |

## Direktori permintaan

`/run/sdr-doa-host-power`, milik user console dengan mode `0700`, dibuat oleh `systemd-tmpfiles` saat install dan di setiap boot (sebelum Docker mulai). Di dalamnya ada `helper` (milik root) yang memberi tahu console bahwa sisi host terpasang. `/run` kosong setelah setiap boot, jadi tidak ada permintaan yang tersisa dari boot sebelumnya.

- **Docker** (`sdr-doa-docker`, `docker-compose*.yml`): compose me-mount `/run/sdr-doa-host-power` dari host ke path yang sama di container. `compose.yml` yang ditulis `sdr-doa-docker` 3.3.0 ke atas sudah memuatnya; instalasi yang lebih lama perlu `sudo sdr-doa-docker install` dari script 3.3.0 (langkah di `docs/RUNBOOK_INSTALL_UPDATE.md`). Tanpa sisi host, Docker membuat direktori kosong milik root untuk mount itu; console tidak bisa menulis di sana dan tombol tampil nonaktif dengan alasan "Helper host belum dipasang".
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
| `--prefix DIR` | lokasi program (bawaan `/usr/local`); `sbin`, `share/sdr-doa-host-power` dan setiap direktori di atasnya harus milik root dan tidak bisa ditulis user lain |
| `--dry-run` | tampilkan file dan perintah, tidak mengubah apa pun; berakhir dengan exit 1 bila install akan berhenti |
| `--root DIR` | pasang di bawah DIR tanpa `systemctl` (untuk test) |

Yang dipasang:

```text
/usr/local/sbin/sdr-doa-host-power
/usr/local/share/sdr-doa-host-power/          README.md, uninstall.sh, install-info
/etc/systemd/system/sdr-doa-host-power.path   (enabled)
/etc/systemd/system/sdr-doa-host-power.service
/etc/tmpfiles.d/sdr-doa-host-power.conf
/run/sdr-doa-host-power/                      direktori permintaan dan penanda helper (dibuat tmpfiles)
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

Contoh baris journal: `running: systemctl reboot (requested by the console)`, `refused poweroff: reboot ran 12 s ago, less than 60 s`, `refused a request: it does not hold exactly reboot or poweroff`, `cannot delete /run/sdr-doa-host-power/request; nothing done`.

| Console menampilkan | Artinya |
|---|---|
| tombol nonaktif, "Helper host belum dipasang" | `/run/sdr-doa-host-power` tidak ada, tidak bisa ditulis uid console, atau tanpa penanda `helper`: pasang sisi host, lalu muat ulang halaman |
| tombol nonaktif, "Dimatikan di console ini" | console dijalankan dengan `--host-power-dir ''` |
| "Host belum mengambil permintaan sebelumnya." (`HOST_POWER_PENDING`) | ada `request` yang belum diambil: `systemctl status sdr-doa-host-power.path` dan journal |
| "Mulai ulang diminta", tetapi PC tetap menyala | helper menolaknya (journal: dalam 60 detik, mode dry run) atau `systemctl` gagal |

## Hapus

```sh
sudo sh /usr/local/share/sdr-doa-host-power/uninstall.sh            # state tetap
sudo sh /usr/local/share/sdr-doa-host-power/uninstall.sh --purge    # hapus juga state
sudo sh /usr/local/share/sdr-doa-host-power/uninstall.sh --dry-run  # lihat dulu
```

Uninstaller menghentikan unit `.path`, menghapus unit, aturan tmpfiles.d, program, penanda `helper` dan permintaan yang menunggu. Direktori di `/run` hilang pada boot berikutnya. Setelah itu tombol console tampil nonaktif (muat ulang halaman).

Test: `tools/test_host_power.py` (route console) dan `tools/test_host_power_kit.py` (helper, installer dan uninstaller dengan perintah palsu di PATH dan jam tetap).
