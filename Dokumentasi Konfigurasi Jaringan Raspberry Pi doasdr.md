# Dokumentasi Konfigurasi Jaringan Raspberry Pi `doasdr`

## 1. Tujuan Konfigurasi

Konfigurasi ini dibuat agar Raspberry Pi dapat diakses dengan dua jalur jaringan:

1. **WiFi (`wlan0`)**
   - Menggunakan DHCP.
   - IP dapat berubah mengikuti router/WiFi yang digunakan.
   - Digunakan untuk akses jaringan kantor atau internet.

2. **Ethernet/LAN (`eth0`)**
   - Menggunakan IP statis.
   - Digunakan sebagai jalur management langsung.
   - Tidak bergantung pada router, DHCP, atau internet.
   - Bisa digunakan untuk koneksi langsung dari laptop/PC ke Raspberry Pi.

Konfigurasi akhir:

```text
Hostname Raspberry : doasdr
Username SSH        : doasdr

WiFi wlan0          : DHCP / Dynamic
LAN eth0            : 192.168.50.100/24
```

Contoh laptop/PC yang terhubung langsung:

```text
Laptop/PC Ethernet  : 192.168.50.10/24
Raspberry Pi eth0   : 192.168.50.100/24
```

Akses SSH:

```bash
ssh doasdr@192.168.50.100
```

atau menggunakan Bonjour/mDNS:

```bash
ssh doasdr@doasdr.local
```

---

# 2. Gambaran Topologi

```text
                   WiFi Kantor / Router
                           │
                           │ DHCP
                           ▼
                  wlan0: IP dinamis
                    ┌──────────────┐
                    │ Raspberry Pi │
                    │    doasdr    │
                    └───────┬──────┘
                            │
                            │ eth0
                            │ 192.168.50.100/24
                            │
                       Kabel LAN
                            │
                            ▼
                       Laptop / PC
                     192.168.50.x/24
```

Dengan konfigurasi ini:

- WiFi tetap dapat digunakan untuk internet.
- Ethernet selalu mempunyai alamat tetap.
- Raspberry tetap dapat diakses melalui LAN meskipun tidak ada internet.
- Tidak perlu mencari IP Raspberry setiap pindah lokasi.

---

# 3. Mengecek Interface Raspberry Pi

Login terlebih dahulu ke Raspberry.

Kemudian:

```bash
ip addr
```

Interface yang digunakan:

```text
eth0   = Ethernet / LAN
wlan0  = WiFi
lo     = localhost
```

Contoh kondisi:

```text
2: eth0:
    link/ether e4:5f:01:fc:30:e5

3: wlan0:
    link/ether e4:5f:01:fc:30:e6
    inet 10.x.x.x/24
```

Jika kabel Ethernet belum terpasang, `eth0` dapat terlihat seperti:

```text
NO-CARRIER
state DOWN
```

Ini normal.

`NO-CARRIER` berarti belum ada link fisik dari kabel LAN.

---

# 4. Mengecek NetworkManager

Jalankan:

```bash
nmcli device
```

Contoh:

```text
DEVICE   TYPE      STATE         CONNECTION
wlan0    wifi      connected     WiFi-Kantor
lo       loopback  connected     lo
eth0     ethernet  unavailable   --
```

Kemudian lihat profile jaringan:

```bash
nmcli connection show
```

Pada sistem ini profile Ethernet yang digunakan adalah:

```text
netplan-eth0
```

Profile tersebut yang akan dikonfigurasi sebagai LAN management statis.

---

# 5. Mengatur IP Statis Ethernet

IP management yang digunakan:

```text
192.168.50.100/24
```

Jalankan:

```bash
sudo nmcli connection modify "netplan-eth0" \
  ipv4.method manual \
  ipv4.addresses 192.168.50.100/24 \
  ipv4.gateway "" \
  ipv4.dns "" \
  ipv4.never-default yes \
  connection.autoconnect yes
```

Penjelasan:

```text
ipv4.method manual
```

Menggunakan konfigurasi IPv4 statis.

```text
ipv4.addresses 192.168.50.100/24
```

Menentukan IP statis Raspberry.

```text
ipv4.gateway ""
```

Tidak menggunakan gateway pada interface Ethernet.

Ini memang disengaja karena Ethernet digunakan untuk jaringan lokal/management.

```text
ipv4.dns ""
```

Tidak perlu DNS untuk jaringan management.

```text
ipv4.never-default yes
```

Sangat penting.

Mencegah Ethernet mengambil alih default route Raspberry.

Dengan demikian:

```text
Internet → tetap melalui WiFi
Management LAN → melalui eth0
```

```text
connection.autoconnect yes
```

Membuat profile Ethernet aktif otomatis ketika kabel LAN terhubung.

---

# 6. Mengaktifkan Ulang Interface Ethernet

Jika kabel sudah terpasang:

```bash
sudo nmcli connection down "netplan-eth0"
sudo nmcli connection up "netplan-eth0"
```

Jika connection sebelumnya belum aktif, cukup:

```bash
sudo nmcli connection up "netplan-eth0"
```

Kemudian cek:

```bash
ip addr show eth0
```

Harus terdapat:

```text
inet 192.168.50.100/24
```

Contoh:

```text
2: eth0:
    ...
    inet 192.168.50.100/24
```

Cek NetworkManager:

```bash
nmcli device
```

Idealnya menjadi:

```text
eth0 ethernet connected netplan-eth0
```

---

# 7. Mengecek Konfigurasi NetworkManager

Jalankan:

```bash
nmcli connection show "netplan-eth0"
```

Atau hanya parameter penting:

```bash
nmcli connection show "netplan-eth0" | grep -E \
"ipv4.method|ipv4.addresses|ipv4.gateway|ipv4.never-default|connection.autoconnect"
```

Hasil yang diharapkan:

```text
connection.autoconnect:  yes
ipv4.method:             manual
ipv4.addresses:          192.168.50.100/24
ipv4.gateway:            --
ipv4.never-default:      yes
```

---

# 8. Mengapa LAN Sebaiknya Berbeda Subnet dengan WiFi

Jangan gunakan contoh berikut jika WiFi juga berada pada `192.168.1.x`:

```text
wlan0 = 192.168.1.86/24
eth0  = 192.168.1.100/24
```

Walaupun kedua interface mempunyai IP berbeda, keduanya berada dalam network:

```text
192.168.1.0/24
```

Linux kemudian mempunyai dua interface yang menuju network yang sama.

Ini dapat menyebabkan:

- routing ambigu,
- request masuk melalui Ethernet tetapi reply keluar melalui WiFi,
- SSH tidak konsisten,
- mDNS memilih interface yang tidak diinginkan,
- troubleshooting menjadi lebih sulit.

Karena itu LAN management dipisahkan menjadi:

```text
WiFi:
192.168.1.x
atau
10.x.x.x
atau subnet lain dari DHCP

Ethernet:
192.168.50.100/24
```

---

# 9. Setting Laptop / PC

## MacBook / macOS

Buka:

```text
System Settings
→ Network
→ Ethernet
→ Details
→ TCP/IP
```

Pilih:

```text
Configure IPv4: Manually
```

Isi:

```text
IP Address  : 192.168.50.10
Subnet Mask : 255.255.255.0
Router      : kosong
```

DNS dapat dikosongkan.

Kemudian:

```bash
ping 192.168.50.100
```

Jika berhasil:

```bash
ssh doasdr@192.168.50.100
```

---

## Windows

Buka:

```text
Control Panel
→ Network and Internet
→ Network Connections
→ Ethernet
→ Properties
→ Internet Protocol Version 4 (TCP/IPv4)
```

Gunakan:

```text
IP Address  : 192.168.50.10
Subnet Mask : 255.255.255.0
Gateway     : kosong
DNS         : kosong
```

Kemudian PowerShell:

```powershell
ping 192.168.50.100
```

SSH:

```powershell
ssh doasdr@192.168.50.100
```

---

## Linux

Contoh sementara:

```bash
sudo ip addr add 192.168.50.10/24 dev eth0
sudo ip link set eth0 up
```

Kemudian:

```bash
ping 192.168.50.100
```

dan:

```bash
ssh doasdr@192.168.50.100
```

Jika menggunakan NetworkManager, konfigurasi dapat dibuat permanen melalui `nmcli`.

---

# 10. Tidak Membutuhkan Gateway

Untuk koneksi:

```text
Laptop ↔ Raspberry
```

gateway tidak diperlukan.

Cukup:

```text
Laptop:
192.168.50.10/24

Raspberry:
192.168.50.100/24
```

Keduanya sudah berada dalam:

```text
192.168.50.0/24
```

sehingga dapat berkomunikasi langsung.

---

# 11. Mengaktifkan Bonjour / mDNS

Tujuan Bonjour/mDNS adalah agar Raspberry bisa diakses menggunakan:

```text
doasdr.local
```

tanpa mengingat IP.

Di Linux/Raspberry Pi implementasinya menggunakan Avahi.

Cek daemon:

```bash
systemctl status avahi-daemon
```

Harus:

```text
active (running)
```

Jika belum terinstall:

```bash
sudo apt update
sudo apt install avahi-daemon
```

Aktifkan:

```bash
sudo systemctl enable --now avahi-daemon
```

---

# 12. Menginstall `avahi-browse`

Command:

```bash
avahi-browse
```

berasal dari package:

```text
avahi-utils
```

Jika belum tersedia:

```bash
sudo apt update
sudo apt install avahi-utils
```

Kemudian:

```bash
avahi-browse -art
```

Command ini dapat digunakan untuk melihat service mDNS yang terdeteksi/publish.

---

# 13. Mengecek Hostname Raspberry

Jalankan:

```bash
hostname
```

Harus:

```text
doasdr
```

Atau:

```bash
hostnamectl
```

Karena hostname adalah:

```text
doasdr
```

alamat Bonjour Raspberry menjadi:

```text
doasdr.local
```

Username dan hostname kebetulan sama pada Raspberry ini:

```text
Username : doasdr
Hostname : doasdr
```

Sehingga SSH-nya:

```bash
ssh doasdr@doasdr.local
```

Bagian sebelum `@` adalah username.

Bagian setelah `@` adalah hostname.

---

# 14. Mengecek Bonjour dari Mac

Tes:

```bash
ping doasdr.local
```

Atau menggunakan Bonjour secara langsung:

```bash
dns-sd -G v4 doasdr.local
```

Jika berhasil, akan terlihat salah satu IP Raspberry.

Misalnya:

```text
doasdr.local → 192.168.50.100
```

SSH:

```bash
ssh doasdr@doasdr.local
```

---

# 15. Avahi Hanya Muncul di WiFi tetapi Tidak di LAN

Jika `doasdr.local` hanya muncul melalui `wlan0`, periksa:

```bash
cat /etc/avahi/avahi-daemon.conf
```

Cari:

```ini
[server]
```

Jika terdapat:

```ini
allow-interfaces=wlan0
```

maka Avahi hanya diizinkan menggunakan WiFi.

Edit:

```bash
sudo nano /etc/avahi/avahi-daemon.conf
```

Ubah menjadi:

```ini
allow-interfaces=wlan0,eth0
```

atau hapus/comment restriction `allow-interfaces` agar Avahi dapat berjalan pada seluruh interface yang sesuai.

Kemudian:

```bash
sudo systemctl restart avahi-daemon
```

Cek lagi:

```bash
avahi-browse -art
```

Dari Mac:

```bash
dns-sd -G v4 doasdr.local
```

---

# 16. Jika WiFi dan Ethernet Aktif Bersamaan

Raspberry dapat mempunyai dua IP sekaligus:

```text
wlan0:
IP DHCP dari WiFi

eth0:
192.168.50.100
```

Sebagai contoh:

```text
wlan0 → 10.181.123.86
eth0  → 192.168.50.100
```

Bonjour dapat mengiklankan hostname:

```text
doasdr.local
```

melalui kedua interface.

Akibatnya `doasdr.local` dapat resolve ke lebih dari satu alamat.

Ini normal.

Untuk maintenance melalui kabel LAN, gunakan IP statis secara langsung jika ingin memastikan jalur yang digunakan:

```bash
ssh doasdr@192.168.50.100
```

---

# 17. Angry IP Scanner Tidak Menampilkan Hostname

Angry IP Scanner dapat menemukan:

```text
192.168.50.100
```

tetapi kolom hostname mungkin kosong.

Hal ini tidak selalu berarti Bonjour rusak.

`doasdr.local` bekerja menggunakan:

```text
mDNS / Bonjour / Avahi
```

sedangkan beberapa scanner mendapatkan hostname menggunakan:

```text
DNS / Reverse DNS / PTR lookup
```

Pada jaringan direct LAN:

```text
Laptop ↔ Raspberry
```

biasanya tidak tersedia DNS server lokal dengan PTR record:

```text
192.168.50.100 → doasdr
```

Karena itu kondisi berikut masih dianggap normal:

```text
ping doasdr.local        → berhasil
ssh doasdr@doasdr.local  → berhasil
Angry IP hostname        → kosong
```

---

# 18. Mengecek Routing Raspberry

Jalankan:

```bash
ip route
```

Idealnya ada route LAN:

```text
192.168.50.0/24 dev eth0
```

dan default route tetap berada di WiFi, misalnya:

```text
default via 192.168.1.1 dev wlan0
```

Contoh konfigurasi ideal:

```text
default via 192.168.1.1 dev wlan0
192.168.1.0/24 dev wlan0
192.168.50.0/24 dev eth0
```

Tidak ideal apabila muncul default route Ethernet:

```text
default via ... dev eth0
```

karena Ethernet management tidak membutuhkan gateway.

Pastikan:

```text
ipv4.never-default yes
```

---

# 19. Pemeriksaan Setelah Reboot

Reboot:

```bash
sudo reboot
```

Setelah Raspberry hidup kembali dan kabel LAN terpasang:

```bash
ip addr show eth0
```

Harus tetap:

```text
192.168.50.100/24
```

Cek:

```bash
nmcli device
```

Harus menunjukkan:

```text
eth0 ethernet connected netplan-eth0
```

Tes dari laptop:

```bash
ping 192.168.50.100
```

Kemudian:

```bash
ssh doasdr@192.168.50.100
```

Tes Bonjour:

```bash
ping doasdr.local
```

Kemudian:

```bash
ssh doasdr@doasdr.local
```

---

# 20. Checklist Recreate dari Nol

Jika suatu saat Raspberry diinstall ulang, urutannya:

1. Pastikan hostname:

```bash
hostname
```

Target:

```text
doasdr
```

2. Pastikan username:

```text
doasdr
```

3. Cek interface:

```bash
ip addr
```

4. Cek NetworkManager:

```bash
nmcli device
```

5. Cari connection Ethernet:

```bash
nmcli connection show
```

6. Atur Ethernet:

```bash
sudo nmcli connection modify "netplan-eth0" \
  ipv4.method manual \
  ipv4.addresses 192.168.50.100/24 \
  ipv4.gateway "" \
  ipv4.dns "" \
  ipv4.never-default yes \
  connection.autoconnect yes
```

7. Aktifkan:

```bash
sudo nmcli connection up "netplan-eth0"
```

8. Install Avahi:

```bash
sudo apt update
sudo apt install avahi-daemon avahi-utils
```

9. Aktifkan Bonjour:

```bash
sudo systemctl enable --now avahi-daemon
```

10. Pastikan Avahi menggunakan WiFi dan Ethernet.

```bash
sudo nano /etc/avahi/avahi-daemon.conf
```

Jika diperlukan:

```ini
[server]
allow-interfaces=wlan0,eth0
```

11. Restart Avahi:

```bash
sudo systemctl restart avahi-daemon
```

12. Set laptop Ethernet:

```text
192.168.50.10/24
```

13. Test IP:

```bash
ping 192.168.50.100
```

14. Test SSH:

```bash
ssh doasdr@192.168.50.100
```

15. Test Bonjour:

```bash
ping doasdr.local
```

16. Test SSH menggunakan hostname:

```bash
ssh doasdr@doasdr.local
```

---

# 21. Troubleshooting

## Ethernet `NO-CARRIER`

Jika:

```text
eth0: NO-CARRIER
```

periksa:

- kabel LAN,
- USB-to-Ethernet adapter laptop,
- port switch,
- link LED.

`NO-CARRIER` berarti tidak ada link fisik.

---

## `Destination Host Unreachable`

Pastikan laptop dan Raspberry satu subnet.

Benar:

```text
Laptop    192.168.50.10/24
Raspberry 192.168.50.100/24
```

Salah:

```text
Laptop    192.168.1.10/24
Raspberry 192.168.50.100/24
```

---

## SSH timeout

Tes:

```bash
ping 192.168.50.100
```

Kemudian:

```bash
nc -vz 192.168.50.100 22
```

Di Raspberry cek SSH:

```bash
systemctl status ssh
```

Jika belum aktif:

```bash
sudo systemctl enable --now ssh
```

---

## `doasdr.local` tidak resolve

Cek:

```bash
systemctl status avahi-daemon
```

Restart:

```bash
sudo systemctl restart avahi-daemon
```

Periksa:

```bash
cat /etc/avahi/avahi-daemon.conf
```

Pastikan `eth0` tidak diblok.

Dari Mac:

```bash
dns-sd -G v4 doasdr.local
```

---

## IP statis hilang setelah reboot

Cek:

```bash
nmcli connection show "netplan-eth0"
```

Pastikan:

```text
ipv4.method         manual
ipv4.addresses      192.168.50.100/24
connection.autoconnect yes
```

Juga periksa Netplan:

```bash
ls -l /etc/netplan/
```

dan:

```bash
sudo cat /etc/netplan/*.yaml
```

Karena profile bernama `netplan-eth0`, sistem dapat memiliki konfigurasi yang berasal dari Netplan.

---

# 22. Konfigurasi Akhir yang Direkomendasikan

```text
RASPBERRY PI
────────────────────────────────

Hostname:
doasdr

Username:
doasdr


WiFi
────────────────────────────────

Interface:
wlan0

IPv4:
DHCP / dynamic

Fungsi:
Internet dan jaringan utama


Ethernet
────────────────────────────────

Interface:
eth0

IPv4:
192.168.50.100/24

Gateway:
Tidak ada

DNS:
Tidak ada

Default route:
Tidak

Autoconnect:
Ya

Fungsi:
Management LAN


BONJOUR / mDNS
────────────────────────────────

Hostname:
doasdr.local

Service:
avahi-daemon

Interfaces:
wlan0 dan eth0


AKSES
────────────────────────────────

Via IP:

ssh doasdr@192.168.50.100

Via Bonjour:

ssh doasdr@doasdr.local
```

# 23. Prinsip Utama

Konfigurasi ini sengaja memisahkan fungsi jaringan:

```text
wlan0 = connectivity
eth0  = management
```

WiFi boleh berubah-ubah mengikuti jaringan tempat Raspberry digunakan.

Ethernet tidak berubah.

Dengan demikian, di lokasi mana pun Raspberry berada, selama PC/laptop diset ke:

```text
192.168.50.x/24
```

Raspberry selalu dapat diakses pada:

```text
192.168.50.100
```

tanpa membutuhkan router, DHCP server, WiFi, maupun internet.