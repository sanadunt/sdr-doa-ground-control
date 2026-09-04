# Dokumentasi Service Otomatis SDR + T900 PPP pada Raspberry Pi

## Auto-Start, Persistent Link, Recovery, Watchdog, dan Boot Validation

**Platform:** Raspberry Pi ARM64  
**OS:** Debian GNU/Linux 13 (Trixie)  
**User:** `doasdr`  
**Project root:** `/home/doasdr/doasdr`  
**Conda environment:** `sdr`  
**T900 UAV PPP IP:** `10.90.0.2`  
**T900 Ground PPP IP:** `10.90.0.1`  
**SDR Web UI:** port `8080`  
**SDR Data Out:** port `8081`

---

# 1. Tujuan

Dokumentasi ini menjelaskan konfigurasi agar Raspberry Pi dapat bekerja otomatis setelah power-on tanpa perlu menjalankan command manual satu per satu.

Target:

```text
POWER ON
   │
   ├── T900 terdeteksi
   │      ↓
   │   /dev/t900
   │      ↓
   │   PPP auto-start
   │      ↓
   │   10.90.0.2
   │
   └── SDR terdeteksi
          ↓
       sdr-doa.service
          ↓
       Web UI :8080
       Data Out :8081
          ↓
       watchdog
```

Dengan konfigurasi ini tidak perlu menjalankan `pppd`, aktivasi Conda, atau script SDR secara manual setiap boot.

---

# 2. Service yang Digunakan

```text
t900-ppp.service
sdr-doa.service
sdr-watchdog.service
sdr-watchdog.timer
```

Fungsi:

```text
t900-ppp.service
→ menjalankan link PPP T900 secara persistent

sdr-doa.service
→ menjalankan sistem SDR Direction Finder

sdr-watchdog.service
→ melakukan health check Web UI SDR

sdr-watchdog.timer
→ menjalankan health check secara periodik
```

---

# 3. Persistent USB Alias T900

Linux dapat memberikan nama serial yang berubah-ubah:

```text
/dev/ttyUSB0
/dev/ttyUSB1
/dev/ttyUSB2
```

Karena itu konfigurasi PPP menggunakan alias:

```text
/dev/t900
```

T900 yang digunakan terdeteksi sebagai CH340/CH341:

```text
Vendor ID  : 1a86
Product ID : 7523
```

Cek:

```bash
lsusb | grep 1a86
```

---

# 4. Udev Rule `/dev/t900`

Buat file:

```bash
sudo nano /etc/udev/rules.d/99-t900.rules
```

Isi:

```text
SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", ATTRS{idProduct}=="7523", ENV{ID_MM_DEVICE_IGNORE}="1", GROUP="dialout", MODE="0660", SYMLINK+="t900"
```

Reload:

```bash
sudo udevadm control --reload-rules
sudo udevadm trigger
```

Cabut dan pasang ulang T900, lalu cek:

```bash
ls -l /dev/t900
readlink -f /dev/t900
```

Contoh:

```text
/dev/t900 -> ttyUSB0
/dev/ttyUSB0
```

Jika setelah reboot kernel mengubah device menjadi `/dev/ttyUSB2`, alias `/dev/t900` tetap dapat menunjuk ke device tersebut.

Catatan: jika suatu saat ada beberapa perangkat CH340/CH341 dengan VID/PID yang sama, rule perlu diperketat menggunakan `ID_PATH`, USB physical port, atau serial number.

Cek detail:

```bash
udevadm info --query=property --name=/dev/ttyUSB0
```

---

# 5. PPP Peer Configuration

File:

```text
/etc/ppp/peers/t900-uav
```

Buat:

```bash
sudo nano /etc/ppp/peers/t900-uav
```

Isi:

```text
/dev/t900
57600

10.90.0.2:10.90.0.1

local
noauth
nocrtscts
noipdefault

persist
maxfail 0
holdoff 3

lcp-echo-interval 5
lcp-echo-failure 3
```

Arti:

```text
/dev/t900
→ serial T900 persistent alias

57600
→ baud rate

10.90.0.2
→ IP Raspberry/UAV

10.90.0.1
→ IP Ground

local
→ tanpa modem carrier control

noauth
→ PPP authentication dimatikan

nocrtscts
→ tanpa hardware RTS/CTS

noipdefault
→ gunakan IP yang ditentukan

persist
→ coba bangun link kembali jika putus

maxfail 0
→ retry tanpa batas

holdoff 3
→ jeda 3 detik sebelum retry

lcp-echo-interval 5
→ health check peer setiap 5 detik

lcp-echo-failure 3
→ 3 kali gagal dianggap link terputus
```

---

# 6. Test PPP Manual

Stop proses lama:

```bash
sudo pkill pppd
```

Jalankan:

```bash
sudo pppd call t900-uav nodetach debug
```

Jika sisi Ground aktif:

```text
Using interface ppp0
Connect: ppp0 <--> /dev/t900
local IP address 10.90.0.2
remote IP address 10.90.0.1
```

Stop dengan:

```text
Ctrl+C
```

---

# 7. PPP Systemd Service

Buat:

```bash
sudo nano /etc/systemd/system/t900-ppp.service
```

Isi:

```ini
[Unit]
Description=T900 UAV Persistent PPP Link
After=systemd-udevd.service
Wants=systemd-udevd.service

[Service]
Type=simple

ExecStartPre=/bin/sh -c 'for i in $(seq 1 60); do [ -e /dev/t900 ] && exit 0; sleep 1; done; exit 1'

ExecStart=/usr/sbin/pppd call t900-uav nodetach

Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Aktifkan:

```bash
sudo systemctl daemon-reload
sudo systemctl enable t900-ppp.service
sudo systemctl start t900-ppp.service
```

Cek:

```bash
systemctl status t900-ppp.service --no-pager -l
```

Target:

```text
Active: active (running)
```

---

# 8. Cara Kerja Recovery PPP

Terdapat dua lapisan recovery:

```text
pppd persist
+
systemd Restart=always
```

Alur:

```text
T900 Ground mati
      ↓
PPP peer hilang
      ↓
LCP echo gagal
      ↓
pppd mencoba reconnect
      ↓
jika pppd berhenti, systemd menjalankannya lagi
      ↓
Ground hidup
      ↓
PPP negotiate kembali otomatis
```

---

# 9. Cek PPP

Interface:

```bash
ip addr show ppp0
```

Target:

```text
inet 10.90.0.2 peer 10.90.0.1/32
```

Ringkas:

```bash
ip -br addr
```

Proses:

```bash
pgrep -a pppd
```

Port serial:

```bash
sudo lsof /dev/t900
```

atau:

```bash
sudo fuser -v /dev/t900
```

Idealnya `pppd` menjadi proses yang memegang serial tersebut.

---

# 10. Log PPP

Log terakhir:

```bash
journalctl -u t900-ppp.service -n 100 --no-pager
```

Realtime:

```bash
journalctl -u t900-ppp.service -f
```

Jika hanya terlihat:

```text
sent [LCP ConfReq ...]
```

berulang tanpa:

```text
rcvd [LCP ConfAck ...]
```

maka sisi UAV sudah mengirim PPP tetapi Ground belum menjawab.

Penyebab umum:

```text
PPP Ground belum hidup
port serial Ground salah
baud berbeda
T900 tidak paired
mode serial bukan Transparent
serial sedang dipakai aplikasi lain
```

Pada pengujian aktual, kondisi ini pernah terjadi karena sisi Mac/Ground belum tersambung. Setelah PPP Ground aktif, link kembali normal.

---

# 11. PPP Ground macOS

Contoh:

```bash
sudo /usr/sbin/pppd \
  /dev/cu.usbserial-XXXX \
  57600 \
  10.90.0.1:10.90.0.2 \
  local \
  noauth \
  nodetach \
  debug \
  nocrtscts \
  noipdefault
```

Cari port:

```bash
ls /dev/cu.usbserial*
```

---

# 12. Wrapper SDR Start

Buat:

```bash
sudo nano /usr/local/sbin/sdr-doa-start
```

Isi:

```bash
#!/bin/bash

set -e

export HOME=/home/doasdr

source /home/doasdr/miniforge3/etc/profile.d/conda.sh

conda activate sdr

cd /home/doasdr/doasdr

./sdr_doa_start.sh
```

Executable:

```bash
sudo chmod +x /usr/local/sbin/sdr-doa-start
```

---

# 13. Wrapper SDR Stop

Buat:

```bash
sudo nano /usr/local/sbin/sdr-doa-stop
```

Isi:

```bash
#!/bin/bash

export HOME=/home/doasdr

source /home/doasdr/miniforge3/etc/profile.d/conda.sh

conda activate sdr

cd /home/doasdr/doasdr

./sdr_doa_stop.sh
```

Executable:

```bash
sudo chmod +x /usr/local/sbin/sdr-doa-stop
```

---

# 14. Script Lokal SDR

Project root:

```text
/home/doasdr/doasdr
```

Script:

```text
sdr_doa_start.sh
sdr_doa_stop.sh
```

Pastikan executable:

```bash
chmod +x ~/doasdr/sdr_doa_start.sh
chmod +x ~/doasdr/sdr_doa_stop.sh
```

---

# 15. SDR Systemd Service

Buat:

```bash
sudo nano /etc/systemd/system/sdr-doa.service
```

Isi:

```ini
[Unit]
Description=SDR Direction Finder
After=network.target
Wants=network.target

[Service]
Type=oneshot
RemainAfterExit=yes

WorkingDirectory=/home/doasdr/doasdr
Environment=HOME=/home/doasdr

ExecStartPre=/bin/sh -c 'for i in $(seq 1 60); do COUNT=$(/usr/bin/lsusb -d 0bda:2838 2>/dev/null | /usr/bin/wc -l); [ "$COUNT" -ge 5 ] && exit 0; sleep 1; done; exit 1'

ExecStart=/usr/local/sbin/sdr-doa-start
ExecStop=/usr/local/sbin/sdr-doa-stop

TimeoutStartSec=180
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

Aktifkan:

```bash
sudo systemctl daemon-reload
sudo systemctl enable sdr-doa.service
sudo systemctl start sdr-doa.service
```

Cek:

```bash
sudo systemctl status sdr-doa.service
```

---

# 16. Mengapa Menunggu 5 RTL2838

Saat boot, USB dapat muncul bertahap.

Service menunggu sampai:

```bash
lsusb -d 0bda:2838
```

menghasilkan minimal:

```text
5 device
```

Baru sistem SDR dimulai.

Ini mencegah DAQ start terlalu cepat saat semua receiver belum selesai enumerate.

---

# 17. `active (exited)` pada SDR Service

Service menggunakan:

```text
Type=oneshot
RemainAfterExit=yes
```

Start script menjalankan beberapa child process di background lalu script utama selesai.

Karena itu status:

```text
Active: active (exited)
```

adalah normal selama child process dan port aplikasi tetap aktif.

Pada pengujian aktual terlihat child process DAQ, rebuffer, decimator, controller, Web UI, PHP Data Out, dan Node tetap berjalan.

---

# 18. Verifikasi Web UI dan Data Out

Cek:

```bash
sudo ss -ltnp | grep -E ':8080|:8081'
```

Target:

```text
0.0.0.0:8080 LISTEN
0.0.0.0:8081 LISTEN
```

Test:

```bash
curl -I http://127.0.0.1:8080
```

Target:

```text
HTTP/1.1 200
```

Port:

```text
8080 → Web UI
8081 → Data Out / shared HTTP server
```

Jika membuka root port `8081` dan mendapat `Not Found`, itu normal.

---

# 19. SDR Watchdog

Buat:

```bash
sudo nano /usr/local/sbin/sdr-watchdog
```

Isi:

```bash
#!/bin/bash

if ! curl -fsS --max-time 5 http://127.0.0.1:8080/ >/dev/null 2>&1; then
    logger -t sdr-watchdog "SDR Web UI down, restarting..."
    systemctl restart sdr-doa.service
fi
```

Executable:

```bash
sudo chmod +x /usr/local/sbin/sdr-watchdog
```

---

# 20. Watchdog Service

Buat:

```bash
sudo nano /etc/systemd/system/sdr-watchdog.service
```

Isi:

```ini
[Unit]
Description=SDR Health Check

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/sdr-watchdog
```

---

# 21. Watchdog Timer

Buat:

```bash
sudo nano /etc/systemd/system/sdr-watchdog.timer
```

Isi:

```ini
[Unit]
Description=Periodic SDR Health Check

[Timer]
OnBootSec=5min
OnUnitActiveSec=2min
AccuracySec=10s

[Install]
WantedBy=timers.target
```

Aktifkan:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now sdr-watchdog.timer
```

Cek:

```bash
systemctl list-timers | grep sdr
```

---

# 22. Cara Kerja Watchdog

```text
setiap 2 menit
      ↓
HTTP GET localhost:8080
      ↓
berhasil?
 ├── ya → tidak ada aksi
 └── tidak
       ↓
systemctl restart sdr-doa.service
```

Health check pertama ditunda 5 menit setelah boot agar proses initialization memiliki cukup waktu.

---

# 23. Cek Semua Service

```bash
systemctl status \
  t900-ppp.service \
  sdr-doa.service \
  sdr-watchdog.timer \
  --no-pager
```

Cek enabled:

```bash
systemctl is-enabled t900-ppp.service
systemctl is-enabled sdr-doa.service
systemctl is-enabled sdr-watchdog.timer
```

Target:

```text
enabled
enabled
enabled
```

---

# 24. Quick Health Check

```bash
echo "=== T900 ==="
ls -l /dev/t900

echo
echo "=== PPP ==="
ip -br addr show ppp0

echo
echo "=== SERVICES ==="
systemctl is-active t900-ppp.service
systemctl is-active sdr-doa.service

echo
echo "=== SDR PORTS ==="
sudo ss -ltnp | grep -E ':8080|:8081'

echo
echo "=== WATCHDOG ==="
systemctl list-timers | grep sdr
```

---

# 25. Cold Boot Validation

Reboot:

```bash
sudo reboot
```

Setelah Raspberry hidup, jangan menjalankan PPP atau SDR manual.

Tunggu 2–5 menit lalu cek:

```bash
systemctl status t900-ppp.service --no-pager
systemctl status sdr-doa.service --no-pager
ip addr show ppp0
sudo ss -ltnp | grep -E ':8080|:8081'
systemctl list-timers | grep sdr
```

Target:

```text
/dev/t900        ✅
PPP service      ✅
ppp0             ✅
10.90.0.2        ✅
SDR service      ✅
8080             ✅
8081             ✅
Watchdog timer   ✅
```

---

# 26. Test Link Setelah Boot

Jika Ground aktif:

```bash
ping -c 5 10.90.0.1
```

Dari Ground:

```bash
ping -c 5 10.90.0.2
```

Web UI lewat link point-to-point:

```text
http://10.90.0.2:8080
```

---

# 27. Troubleshooting `/dev/t900`

Jika alias hilang:

```bash
lsusb | grep 1a86
```

Reload:

```bash
sudo udevadm control --reload-rules
sudo udevadm trigger
```

Lalu cabut-colok T900.

---

# 28. Troubleshooting PPP

Status:

```bash
systemctl status t900-ppp.service --no-pager -l
```

Log:

```bash
journalctl -u t900-ppp.service -n 100 --no-pager
```

Realtime:

```bash
journalctl -u t900-ppp.service -f
```

Manual debug:

```bash
sudo systemctl stop t900-ppp.service
sudo pppd call t900-uav nodetach debug
```

Setelah selesai:

```text
Ctrl+C
```

Start kembali:

```bash
sudo systemctl start t900-ppp.service
```

---

# 29. Troubleshooting SDR

Status:

```bash
systemctl status sdr-doa.service --no-pager -l
```

Cek HTTP:

```bash
curl -I http://127.0.0.1:8080
```

Cek port:

```bash
sudo ss -ltnp | grep -E ':8080|:8081'
```

Restart:

```bash
sudo systemctl restart sdr-doa.service
```

Log:

```bash
journalctl -u sdr-doa.service -f
```

---

# 30. Troubleshooting Watchdog

Status:

```bash
systemctl status sdr-watchdog.timer
```

Timer:

```bash
systemctl list-timers | grep sdr
```

Log:

```bash
journalctl -u sdr-watchdog.service -n 50 --no-pager
```

Manual check:

```bash
sudo /usr/local/sbin/sdr-watchdog
```

---

# 31. Stop Semua

```bash
sudo systemctl stop t900-ppp.service
sudo systemctl stop sdr-doa.service
sudo systemctl stop sdr-watchdog.timer
```

---

# 32. Start Semua

```bash
sudo systemctl start t900-ppp.service
sudo systemctl start sdr-doa.service
sudo systemctl start sdr-watchdog.timer
```

---

# 33. Restart

```bash
sudo systemctl restart t900-ppp.service
sudo systemctl restart sdr-doa.service
```

---

# 34. Disable Auto-Start

```bash
sudo systemctl disable t900-ppp.service
sudo systemctl disable sdr-doa.service
sudo systemctl disable sdr-watchdog.timer
```

Aktifkan kembali:

```bash
sudo systemctl enable t900-ppp.service
sudo systemctl enable sdr-doa.service
sudo systemctl enable sdr-watchdog.timer
```

---

# 35. Arsitektur Boot dan Recovery

```text
                    POWER ON
                       │
           ┌───────────┴───────────┐
           │                       │
           ▼                       ▼
     USB T900 Detect          5 SDR Detect
           │                       │
           ▼                       ▼
       /dev/t900             sdr-doa.service
           │                       │
           ▼                       ▼
      t900-ppp.service          DAQ + UI
           │                       │
           ▼                       ▼
          pppd                :8080 / :8081
           │                       │
    persist + restart          watchdog
           │                       │
           ▼                       ▼
     auto reconnect          auto restart
```

---

# 36. Perilaku Operasional

Jika Ground belum aktif:

```text
PPP service tetap hidup
      ↓
pppd terus menunggu/retry
```

Saat Ground aktif:

```text
PPP negotiation
      ↓
10.90.0.1 ↔ 10.90.0.2
```

Jika link RF hilang sementara:

```text
LCP health check gagal
      ↓
PPP reconnect
```

Jika proses PPP mati:

```text
systemd restart
```

Jika Web UI SDR mati:

```text
watchdog
      ↓
restart sdr-doa.service
```

---

# 37. Acceptance Checklist

```text
[✓] Persistent `/dev/t900`
[✓] PPP peer file
[✓] PPP persistent retry
[✓] PPP systemd service
[✓] PPP auto-start
[✓] PPP tested with Ground
[✓] Conda wrapper
[✓] SDR start wrapper
[✓] SDR stop wrapper
[✓] SDR systemd service
[✓] 5-device startup check
[✓] SDR auto-start
[✓] Web UI :8080
[✓] Data Out :8081
[✓] Watchdog script
[✓] Watchdog systemd service
[✓] Watchdog timer
[✓] HTTP health check
[✓] Services enabled at boot
```

---

# 38. Command Referensi Cepat

Semua status:

```bash
systemctl status t900-ppp.service sdr-doa.service sdr-watchdog.timer --no-pager
```

T900:

```bash
ls -l /dev/t900
```

PPP:

```bash
ip addr show ppp0
```

SDR:

```bash
curl -I http://127.0.0.1:8080
```

Ports:

```bash
sudo ss -ltnp | grep -E ':8080|:8081'
```

PPP log:

```bash
journalctl -u t900-ppp.service -f
```

SDR log:

```bash
journalctl -u sdr-doa.service -f
```

Watchdog:

```bash
systemctl list-timers | grep sdr
```

---

# 39. Next Step

Setelah service stabil:

```text
PPP throughput test
      ↓
iperf3
      ↓
safe application bandwidth
      ↓
MQTT
      ↓
DoA telemetry
      ↓
state + command
      ↓
compact spectrum
      ↓
Ground Console
```

Tujuan pengujian throughput bukan menggunakan seluruh kapasitas link, tetapi menentukan bandwidth operasi yang mempunyai headroom untuk menjaga latency, command response, retry, dan kestabilan saat kualitas RF menurun.

---

# 40. Kesimpulan

Raspberry sekarang dapat dikonfigurasi menjadi autonomous node:

```text
Power On
  ↓
T900 USB alias
  ↓
PPP auto-start
  ↓
SDR auto-start
  ↓
HTTP health watchdog
```

Konfigurasi utama:

```text
T900 alias : /dev/t900

PPP:
UAV        : 10.90.0.2
Ground     : 10.90.0.1

SDR:
Web UI     : 8080
Data Out   : 8081

Services:
t900-ppp.service
sdr-doa.service
sdr-watchdog.timer
```

Dengan setup ini, operasi normal tidak memerlukan startup manual dari terminal.

---

**End of Documentation**
