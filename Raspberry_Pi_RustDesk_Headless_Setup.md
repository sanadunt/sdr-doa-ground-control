# Dokumentasi Konfigurasi RustDesk Headless pada Raspberry Pi

## 1. Tujuan

Dokumentasi ini menjelaskan cara mengatasi kondisi **RustDesk dapat terhubung ke Raspberry Pi tetapi menampilkan `No Display` / layar kosong saat Raspberry berjalan headless tanpa monitor HDMI**.

Konfigurasi ini dibuat berdasarkan sistem berikut:

- Hostname: `doasdr`
- Username: `doasdr`
- OS: Debian GNU/Linux 13 (Trixie)
- Display Manager: LightDM
- Display Server: Xorg / X11
- RustDesk: 1.4.9
- Mode penggunaan: headless / tanpa monitor HDMI
- Management LAN Raspberry: `192.168.50.100/24`

Solusi final adalah membuat kernel KMS Raspberry Pi tetap menganggap HDMI pertama sebagai display aktif meskipun tidak ada monitor yang terpasang.

---

# 2. Gejala Awal

RustDesk dapat:

- online,
- menerima koneksi,
- service aktif,
- autentikasi berhasil,

tetapi remote client menampilkan:

```text
No Display
```

atau kondisi sejenis:

```text
Waiting for image
```

Sementara remote desktop lain seperti AnyDesk masih dapat menampilkan desktop.

Ini menunjukkan bahwa:

```text
Network      = OK
RustDesk     = OK
SSH          = OK
Desktop      = kemungkinan OK
Display capture = bermasalah
```

Masalah utama ternyata bukan jaringan maupun service RustDesk, melainkan **tidak adanya output display aktif yang dapat dicapture oleh RustDesk**.

---

# 3. Pemeriksaan Awal Sistem

Untuk melakukan diagnosis, jalankan melalui SSH:

```bash
echo "=== OS ==="
cat /etc/os-release | grep -E "PRETTY_NAME|VERSION="

echo "=== SESSION ==="
echo $XDG_SESSION_TYPE

echo "=== DISPLAY MANAGER ==="
systemctl status display-manager --no-pager

echo "=== GRAPHICAL PROCESS ==="
ps -ef | grep -E "Xorg|X11|wayfire|labwc|wayland|lightdm|gdm" | grep -v grep

echo "=== RUSTDESK ==="
rustdesk --version
systemctl status rustdesk --no-pager

echo "=== HDMI ==="
cat /sys/class/drm/*HDMI*/status 2>/dev/null

echo "=== DRM ==="
ls -l /sys/class/drm/
```

---

# 4. Hasil Diagnosis Sistem

Pada Raspberry yang digunakan, hasil pentingnya adalah:

```text
PRETTY_NAME="Debian GNU/Linux 13 (trixie)"
VERSION="13 (trixie)"
```

Display manager:

```text
lightdm.service
Active: active (running)
```

Xorg:

```text
/usr/lib/xorg/Xorg :0
```

RustDesk:

```text
RustDesk 1.4.9
Active: active (running)
```

DRM HDMI:

```text
HDMI-A-1 → disconnected
HDMI-A-2 → disconnected
```

Ini merupakan indikasi utama masalah.

---

# 5. Tentang `XDG_SESSION_TYPE=tty`

Saat command berikut dijalankan melalui SSH:

```bash
echo $XDG_SESSION_TYPE
```

hasilnya dapat berupa:

```text
tty
```

Ini **bukan berarti desktop Raspberry tidak menggunakan X11**.

Karena command dijalankan dari sesi SSH, shell tersebut memang dianggap sebagai sesi terminal.

Untuk memastikan desktop sesungguhnya menggunakan Xorg, lihat proses:

```bash
ps -ef | grep Xorg
```

Jika terdapat:

```text
/usr/lib/xorg/Xorg :0
```

maka graphical desktop berjalan menggunakan:

```text
X11 / Xorg
```

Pada kasus ini:

```text
LightDM → Xorg :0 → Desktop doasdr
```

---

# 6. Mengecek Display yang Dilihat Xorg

Gunakan:

```bash
sudo -u doasdr \
  env DISPLAY=:0 XAUTHORITY=/home/doasdr/.Xauthority \
  xrandr --query
```

Hasil awal:

```text
Screen 0: minimum 320 x 200, current 1024 x 768, maximum 7680 x 7680
HDMI-1 disconnected primary (normal left inverted right x axis y axis)
HDMI-2 disconnected (normal left inverted right x axis y axis)
```

Ini adalah konfirmasi penting.

Xorg memang membuat logical screen:

```text
1024 x 768
```

tetapi:

```text
HDMI-1 = disconnected
HDMI-2 = disconnected
```

Artinya tidak ada connector display yang benar-benar aktif.

---

# 7. Mengapa AnyDesk Bisa tetapi RustDesk `No Display`

Aplikasi remote desktop dapat menggunakan mekanisme capture yang berbeda.

Dalam kondisi headless:

```text
Raspberry hidup
Xorg hidup
Desktop hidup
Tidak ada monitor
HDMI disconnected
```

sebagian aplikasi masih dapat melakukan capture logical desktop.

Namun RustDesk dapat membutuhkan output display/CRTC yang benar-benar aktif pada graphics stack.

Akibatnya kondisi berikut dapat terjadi:

```text
AnyDesk  → tampil
RustDesk → No Display
```

Jadi kondisi tersebut tidak otomatis berarti RustDesk rusak atau jaringan bermasalah.

---

# 8. Error RustDesk yang Bukan Penyebab Utama

Beberapa log RustDesk dapat menunjukkan:

```text
Failed to load ayatana-appindicator3
```

atau:

```text
libayatana-appindicator3.so.1: cannot open shared object file
```

Ini lebih berhubungan dengan system tray / app indicator.

Bukan penyebab utama `No Display`.

Begitu juga:

```text
Cannot load libcuda.so.1
```

Raspberry Pi tidak menggunakan NVIDIA CUDA.

Pesan tersebut juga bukan akar masalah display.

Masalah utama pada kasus ini tetap:

```text
HDMI-A-1 disconnected
HDMI-A-2 disconnected
```

---

# 9. Solusi: Force HDMI Menggunakan Kernel KMS

Pada Raspberry Pi modern, graphics stack menggunakan DRM/KMS.

Daripada menggunakan metode lama seperti:

```text
hdmi_force_hotplug=1
```

solusi yang digunakan adalah kernel parameter:

```text
video=HDMI-A-1:1920x1080M@60D
```

Parameter ini membuat HDMI pertama diperlakukan sebagai display digital aktif meskipun monitor tidak terpasang.

---

# 10. Backup Konfigurasi Boot

Sebelum mengubah kernel command line, backup file:

```bash
sudo cp /boot/firmware/cmdline.txt \
        /boot/firmware/cmdline.txt.backup
```

Verifikasi:

```bash
ls -l /boot/firmware/cmdline.txt*
```

Harus terdapat:

```text
cmdline.txt
cmdline.txt.backup
```

---

# 11. Melihat Konfigurasi Saat Ini

Jalankan:

```bash
cat /boot/firmware/cmdline.txt
```

Contoh isi:

```text
console=serial0,115200 console=tty1 root=PARTUUID=xxxx rootfstype=ext4 fsck.repair=yes rootwait quiet splash
```

## Sangat penting

File:

```text
/boot/firmware/cmdline.txt
```

harus tetap berupa **satu baris**.

Jangan menambahkan parameter kernel pada baris baru.

---

# 12. Mengaktifkan HDMI Virtual / Forced HDMI

Edit:

```bash
sudo nano /boot/firmware/cmdline.txt
```

Tambahkan di bagian akhir baris:

```text
video=HDMI-A-1:1920x1080M@60D
```

Contoh:

```text
console=serial0,115200 console=tty1 root=PARTUUID=xxxx rootfstype=ext4 fsck.repair=yes rootwait quiet splash video=HDMI-A-1:1920x1080M@60D
```

Bukan:

```text
console=serial0,115200 ...
video=HDMI-A-1:1920x1080M@60D
```

Karena `cmdline.txt` harus satu baris.

---

# 13. Arti Parameter

Parameter:

```text
video=HDMI-A-1:1920x1080M@60D
```

dapat dibaca sebagai:

```text
HDMI-A-1
│
├── 1920x1080
├── M
├── @60
└── D
```

Penjelasan:

### `HDMI-A-1`

Connector HDMI pertama pada DRM/KMS.

Biasanya akan tampil sebagai:

```text
HDMI-1
```

di Xorg / `xrandr`.

Mapping sederhananya:

```text
DRM / Kernel    Xorg / xrandr
--------------------------------
HDMI-A-1        HDMI-1
HDMI-A-2        HDMI-2
```

### `1920x1080`

Resolusi display virtual.

### `@60`

Refresh rate:

```text
60 Hz
```

### `M`

Meminta kernel menghasilkan timing video yang sesuai.

### `D`

Force digital connector dalam kondisi aktif.

Bagian ini sangat penting untuk sistem headless.

Tanpa monitor:

```text
HDMI-A-1 = disconnected
```

Dengan force mode:

```text
HDMI-A-1 = diperlakukan sebagai display aktif
```

---

# 14. Reboot Raspberry

Setelah konfigurasi disimpan:

```bash
sudo reboot
```

Karena sistem memiliki management LAN statis, setelah Raspberry boot kembali dapat diakses melalui:

```bash
ssh doasdr@192.168.50.100
```

atau jika mDNS aktif:

```bash
ssh doasdr@doasdr.local
```

---

# 15. Verifikasi Setelah Reboot

## 15.1. Cek DRM HDMI

Jalankan:

```bash
cat /sys/class/drm/card1-HDMI-A-1/status
```

atau:

```bash
cat /sys/class/drm/*HDMI*/status
```

Sebelum konfigurasi:

```text
disconnected
disconnected
```

Setelah konfigurasi force HDMI, connector pertama diharapkan menjadi aktif atau setidaknya dapat digunakan oleh Xorg/KMS.

---

## 15.2. Cek Xorg

Jalankan:

```bash
sudo -u doasdr \
  env DISPLAY=:0 XAUTHORITY=/home/doasdr/.Xauthority \
  xrandr --query
```

Sebelumnya:

```text
Screen 0: current 1024 x 768
HDMI-1 disconnected primary
HDMI-2 disconnected
```

Targetnya menjadi kira-kira:

```text
Screen 0: current 1920 x 1080
HDMI-1 connected primary 1920x1080+0+0
   1920x1080     60.00*
HDMI-2 disconnected
```

Yang penting adalah:

```text
HDMI-1 connected
```

dan terdapat mode:

```text
1920x1080
```

---

# 16. Restart RustDesk

Biasanya setelah reboot service RustDesk sudah otomatis aktif.

Tetapi jika diperlukan:

```bash
sudo systemctl restart rustdesk
```

Cek:

```bash
systemctl status rustdesk --no-pager
```

Harus menunjukkan:

```text
Active: active (running)
```

Kemudian coba remote kembali.

Pada sistem yang digunakan, setelah HDMI dipaksa aktif, RustDesk berhasil menampilkan desktop secara normal.

---

# 17. Mengecek RustDesk Service

Gunakan:

```bash
systemctl status rustdesk --no-pager
```

Contoh proses yang normal:

```text
/usr/bin/rustdesk --service
```

dan server user:

```text
/usr/share/rustdesk/rustdesk --server
```

Jika service tidak aktif:

```bash
sudo systemctl enable --now rustdesk
```

Restart:

```bash
sudo systemctl restart rustdesk
```

---

# 18. Mengecek LightDM

RustDesk headless membutuhkan graphical session yang benar-benar hidup.

Cek:

```bash
systemctl status lightdm --no-pager
```

atau:

```bash
systemctl status display-manager --no-pager
```

Harus:

```text
Active: active (running)
```

Jika LightDM tidak hidup:

```bash
sudo systemctl restart lightdm
```

---

# 19. Mengecek Xorg

Cek:

```bash
ps -ef | grep Xorg | grep -v grep
```

Harus terdapat:

```text
/usr/lib/xorg/Xorg :0
```

Jika tidak ada Xorg, RustDesk tidak memiliki desktop X11 untuk dicapture.

---

# 20. Mengecek Autologin

Pada sistem ini LightDM melakukan autologin sebagai:

```text
doasdr
```

Log menunjukkan:

```text
pam_unix(lightdm-autologin:session): session opened for user doasdr
```

Autologin membantu memastikan desktop session sudah tersedia setelah boot tanpa membutuhkan monitor/keyboard.

---

# 21. Diagram Sistem Setelah Konfigurasi

```text
                    Raspberry Pi
                        doasdr
                          │
              ┌───────────┴───────────┐
              │                       │
           Network                  Display
              │                       │
     ┌────────┴────────┐         DRM / KMS
     │                 │              │
   wlan0              eth0       HDMI-A-1
   DHCP          192.168.50.100       │
     │                 │          Forced ON
 Internet         Management          │
                                      ▼
                                1920x1080@60
                                      │
                                      ▼
                                   Xorg :0
                                      │
                                      ▼
                                   LightDM
                                      │
                              Desktop user doasdr
                                      │
                        ┌─────────────┴─────────────┐
                        │                           │
                     AnyDesk                    RustDesk
```

---

# 22. Konfigurasi Final

## Network

```text
Hostname : doasdr
Username : doasdr
```

WiFi:

```text
wlan0
DHCP
```

Management Ethernet:

```text
eth0
192.168.50.100/24
```

SSH:

```bash
ssh doasdr@192.168.50.100
```

atau:

```bash
ssh doasdr@doasdr.local
```

---

## Desktop

```text
Display Manager : LightDM
Display Server  : Xorg / X11
Display         : :0
```

---

## Headless Display

Kernel parameter:

```text
video=HDMI-A-1:1920x1080M@60D
```

File:

```text
/boot/firmware/cmdline.txt
```

---

## Remote Desktop

```text
AnyDesk  : working
RustDesk : working
```

RustDesk service:

```bash
sudo systemctl enable --now rustdesk
```

---

# 23. Checklist Recreate dari Nol

Jika Raspberry diinstall ulang atau konfigurasi harus dibuat kembali:

## Step 1 - Pastikan desktop tersedia

```bash
systemctl status lightdm
```

Harus:

```text
active (running)
```

---

## Step 2 - Pastikan Xorg hidup

```bash
ps -ef | grep Xorg | grep -v grep
```

Harus ada:

```text
Xorg :0
```

---

## Step 3 - Pastikan RustDesk hidup

```bash
rustdesk --version
systemctl status rustdesk
```

---

## Step 4 - Cek HDMI

```bash
cat /sys/class/drm/*HDMI*/status
```

Jika:

```text
disconnected
disconnected
```

lanjutkan konfigurasi forced HDMI.

---

## Step 5 - Cek xrandr

```bash
sudo -u doasdr \
  env DISPLAY=:0 XAUTHORITY=/home/doasdr/.Xauthority \
  xrandr --query
```

Jika:

```text
HDMI-1 disconnected
HDMI-2 disconnected
```

lanjutkan.

---

## Step 6 - Backup cmdline

```bash
sudo cp /boot/firmware/cmdline.txt \
        /boot/firmware/cmdline.txt.backup
```

---

## Step 7 - Edit

```bash
sudo nano /boot/firmware/cmdline.txt
```

Tambahkan:

```text
video=HDMI-A-1:1920x1080M@60D
```

di akhir **baris yang sama**.

---

## Step 8 - Reboot

```bash
sudo reboot
```

---

## Step 9 - SSH kembali

```bash
ssh doasdr@192.168.50.100
```

---

## Step 10 - Cek display

```bash
sudo -u doasdr \
  env DISPLAY=:0 XAUTHORITY=/home/doasdr/.Xauthority \
  xrandr --query
```

Pastikan:

```text
HDMI-1 connected
```

dan resolusi:

```text
1920x1080
```

---

## Step 11 - Restart RustDesk jika diperlukan

```bash
sudo systemctl restart rustdesk
```

---

## Step 12 - Test remote

Connect menggunakan RustDesk.

Jika desktop muncul:

```text
SUCCESS
```

---

# 24. Troubleshooting

## 24.1. RustDesk Online tetapi `No Display`

Cek:

```bash
xrandr
```

menggunakan display user:

```bash
sudo -u doasdr \
  env DISPLAY=:0 XAUTHORITY=/home/doasdr/.Xauthority \
  xrandr --query
```

Jika semua HDMI:

```text
disconnected
```

pastikan parameter:

```text
video=HDMI-A-1:1920x1080M@60D
```

ada di:

```text
/boot/firmware/cmdline.txt
```

---

## 24.2. `Can't open display :0`

Periksa:

```bash
ls -la /home/doasdr/.Xauthority
```

Kemudian gunakan:

```bash
sudo -u doasdr \
  env DISPLAY=:0 XAUTHORITY=/home/doasdr/.Xauthority \
  xrandr --query
```

Jika masih gagal, cek proses Xorg:

```bash
ps -ef | grep Xorg
```

---

## 24.3. Xorg tidak hidup

Cek:

```bash
systemctl status lightdm
```

Restart:

```bash
sudo systemctl restart lightdm
```

---

## 24.4. RustDesk service mati

Cek:

```bash
systemctl status rustdesk
```

Aktifkan:

```bash
sudo systemctl enable --now rustdesk
```

---

## 24.5. Resolusi tetap 1024x768

Pastikan parameter benar:

```bash
cat /boot/firmware/cmdline.txt
```

Harus ada:

```text
video=HDMI-A-1:1920x1080M@60D
```

dan seluruh file harus satu baris.

Kemudian:

```bash
sudo reboot
```

---

## 24.6. Salah connector

Cek:

```bash
ls -l /sys/class/drm/
```

Umumnya Raspberry memiliki:

```text
card1-HDMI-A-1
card1-HDMI-A-2
```

Untuk HDMI pertama:

```text
HDMI-A-1
```

Jika menggunakan HDMI kedua, parameter dapat diubah menjadi:

```text
video=HDMI-A-2:1920x1080M@60D
```

---

# 25. Rollback

Jika setelah konfigurasi display terjadi masalah, masuk melalui SSH dan restore backup:

```bash
sudo cp /boot/firmware/cmdline.txt.backup \
        /boot/firmware/cmdline.txt
```

Kemudian:

```bash
sudo reboot
```

Setelah reboot, kernel command line kembali ke kondisi sebelum forced HDMI.

---

# 26. Memeriksa Parameter Kernel Aktif

Setelah boot:

```bash
cat /proc/cmdline
```

Pastikan terdapat:

```text
video=HDMI-A-1:1920x1080M@60D
```

Jika tidak ada, kemungkinan:

- file yang diedit salah,
- boot partition berbeda,
- perubahan tidak tersimpan.

---

# 27. Pemeriksaan Cepat Setelah Maintenance

Untuk pengecekan cepat:

```bash
echo "=== LIGHTDM ==="
systemctl is-active lightdm

echo "=== XORG ==="
ps -ef | grep Xorg | grep -v grep

echo "=== HDMI ==="
cat /sys/class/drm/*HDMI*/status 2>/dev/null

echo "=== XRANDR ==="
sudo -u doasdr \
  env DISPLAY=:0 XAUTHORITY=/home/doasdr/.Xauthority \
  xrandr --query

echo "=== RUSTDESK ==="
systemctl is-active rustdesk
```

Target:

```text
lightdm  = active
Xorg :0  = running
HDMI-1   = connected
Resolution = 1920x1080
rustdesk = active
```

---

# 28. Command Ringkas

## Diagnosis

```bash
systemctl status lightdm
systemctl status rustdesk
ps -ef | grep Xorg
cat /sys/class/drm/*HDMI*/status
```

## Xrandr

```bash
sudo -u doasdr \
  env DISPLAY=:0 XAUTHORITY=/home/doasdr/.Xauthority \
  xrandr --query
```

## Backup

```bash
sudo cp /boot/firmware/cmdline.txt \
        /boot/firmware/cmdline.txt.backup
```

## Forced HDMI

Tambahkan ke:

```text
/boot/firmware/cmdline.txt
```

parameter:

```text
video=HDMI-A-1:1920x1080M@60D
```

## Reboot

```bash
sudo reboot
```

## Restart RustDesk

```bash
sudo systemctl restart rustdesk
```

---

# 29. Kesimpulan

Masalah RustDesk `No Display` pada Raspberry Pi headless ini bukan disebabkan oleh jaringan maupun RustDesk service.

Diagnosis menunjukkan:

```text
LightDM           = aktif
Xorg :0           = aktif
RustDesk          = aktif
Desktop session   = tersedia
HDMI-A-1          = disconnected
HDMI-A-2          = disconnected
```

Karena tidak terdapat output display aktif, RustDesk tidak dapat menangkap layar dengan benar.

Solusinya adalah memaksa HDMI pertama tetap aktif menggunakan kernel KMS:

```text
video=HDMI-A-1:1920x1080M@60D
```

Setelah reboot:

```text
Xorg memiliki HDMI aktif
Desktop menjadi 1920x1080
RustDesk dapat melakukan display capture
Remote headless berjalan normal
```

Konfigurasi ini cocok digunakan untuk Raspberry Pi yang:

- dijalankan tanpa monitor,
- harus dapat diremote setelah boot,
- menggunakan LightDM,
- menggunakan Xorg/X11,
- menggunakan RustDesk sebagai remote desktop,
- memiliki management LAN/SSH sebagai jalur recovery.

---

# 30. Recovery Strategy yang Direkomendasikan

Karena konfigurasi display dapat mempengaruhi graphical session, selalu pertahankan jalur SSH terpisah.

Pada sistem ini:

```text
Raspberry Management IP:
192.168.50.100/24
```

Sehingga walaupun GUI/RustDesk bermasalah, Raspberry tetap dapat diperbaiki melalui:

```bash
ssh doasdr@192.168.50.100
```

Ini merupakan alasan penting mengapa management Ethernet statis sebaiknya dipertahankan.

