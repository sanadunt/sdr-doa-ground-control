# Dokumentasi Lengkap Instalasi KrakenSDR DoA V1 pada Raspberry Pi
## Debian 13 Trixie ARM64 + Heimdall DAQ + Conda `sdr`

**Status implementasi:** BERHASIL  
**Platform aktual:** Raspberry Pi ARM64  
**OS aktual:** Debian GNU/Linux 13 (Trixie)  
**Arsitektur:** aarch64 / 64-bit  
**Environment Conda:** `sdr`  
**Root project:** `/home/doasdr/doasdr`  
**Web UI:** `http://<IP-RASPBERRY>:8080`  
**Data Out Server:** `http://<IP-RASPBERRY>:8081`

---

# 1. Tujuan

Dokumentasi ini menjelaskan proses instalasi manual **KrakenSDR Direction Finding V1 (`krakensdr_doa`)** pada Raspberry Pi berbasis Debian 13 Trixie ARM64.

Instalasi dilakukan manual agar:

- mudah di-debug,
- mudah dimodifikasi,
- HTML/UI KrakenSDR V1 dapat diubah,
- setiap dependency diketahui,
- Heimdall DAQ dapat dikompilasi secara terkontrol,
- struktur folder dapat disesuaikan,
- nantinya dapat diintegrasikan dengan T900 Pro + PPP + MQTT.

Target akhir:

```text
KrakenSDR
    │ USB
    ▼
Raspberry Pi
    │
    ├── Heimdall DAQ
    ├── KrakenSDR DoA V1
    ├── Web UI :8080
    ├── Data Out :8081
    └── MQTT Gateway (tahap berikutnya)
```

---

# 2. Konfigurasi Aktual Raspberry Pi

Hasil pengecekan sistem:

```bash
uname -m
getconf LONG_BIT
cat /etc/os-release
```

Hasil:

```text
aarch64
64
PRETTY_NAME="Debian GNU/Linux 13 (trixie)"
VERSION_ID="13"
VERSION="13 (trixie)"
VERSION_CODENAME=trixie
```

RAM:

```text
Total RAM : ~3.7 GiB
Swap      : 2.0 GiB
```

Storage:

```text
Root filesystem : ~58 GB
Available       : ~48 GB
```

Artinya sistem memenuhi requirement dasar:

```text
ARM64         ✅
64-bit        ✅
RAM cukup     ✅
Swap ada      ✅
Storage cukup ✅
Internet      ✅
```

---

# 3. Struktur Folder yang Digunakan

Dokumentasi resmi Kraken biasanya menggunakan root seperti:

```text
~/krakensdr
```

Namun implementasi ini menggunakan:

```text
/home/doasdr/doasdr
```

atau:

```bash
~/doasdr
```

Struktur akhir:

```text
/home/doasdr/doasdr/
│
├── heimdall_daq_fw/
│
├── krakensdr_doa/
│
├── kraken_doa_start.sh
└── kraken_doa_stop.sh
```

Selain itu:

```text
/home/doasdr/librtlsdr/
/home/doasdr/Ne10/
/home/doasdr/miniforge3/
```

Nama folder **tidak harus** `krakensdr` selama path dalam start script konsisten.

---

# 4. Dependency Build Dasar

Update package:

```bash
sudo apt update
```

Install dependency:

```bash
sudo apt install -y \
  build-essential \
  git \
  cmake \
  libusb-1.0-0-dev \
  lsof \
  libzmq3-dev \
  clang \
  php-cli \
  nodejs \
  gpsd \
  libfftw3-bin \
  libfftw3-dev
```

Dependency tersebut digunakan untuk:

```text
build-essential → compiler/build tools
git             → clone source
cmake           → configure librtlsdr/Ne10
libusb          → akses RTL-SDR
libzmq3-dev     → IPC/data transport Heimdall
php-cli         → Data Out Server Kraken
gpsd            → optional GPS
FFTW            → FFT/DSP support
```

---

# 5. Install KrakenRF Fork `librtlsdr`

KrakenSDR membutuhkan fork `librtlsdr` milik KrakenRF.

Jangan mengandalkan stock distro `librtlsdr` untuk sistem coherent Kraken.

Clone:

```bash
cd ~
git clone https://github.com/krakenrf/librtlsdr
cd ~/librtlsdr
```

Copy udev rule:

```bash
sudo cp rtl-sdr.rules /etc/udev/rules.d/rtl-sdr.rules
```

Build:

```bash
mkdir build
cd build
cmake ../ -DINSTALL_UDEV_RULES=ON
make -j$(nproc)
```

Setelah sukses, buat executable test:

```bash
sudo ln -s ~/librtlsdr/build/src/rtl_test /usr/local/bin/kraken_test
```

Cek:

```bash
ls -l /usr/local/bin/kraken_test
```

---

# 6. Blacklist Driver DVB Kernel

RTL2838 biasanya otomatis diambil driver DVB Linux:

```text
dvb_usb_rtl28xxu
```

Driver ini harus diblacklist agar KrakenRF librtlsdr dapat mengakses SDR secara langsung.

Jalankan:

```bash
echo 'blacklist dvb_usb_rtl28xxu' | \
sudo tee /etc/modprobe.d/blacklist-dvb_usb_rtl28xxu.conf
```

Cek:

```bash
cat /etc/modprobe.d/blacklist-dvb_usb_rtl28xxu.conf
```

Target:

```text
blacklist dvb_usb_rtl28xxu
```

Reboot:

```bash
sudo reboot
```

Setelah Raspberry hidup kembali, login lagi.

---

# 7. Install Ne10 DSP Library untuk ARM64

Clone:

```bash
cd ~
git clone https://github.com/krakenrf/Ne10
```

Build:

```bash
cd ~/Ne10
mkdir build
cd build
```

Configure ARM64:

```bash
cmake \
  -DNE10_LINUX_TARGET_ARCH=aarch64 \
  -DGNULINUX_PLATFORM=ON \
  -DCMAKE_C_FLAGS="-mcpu=native -Ofast -funsafe-math-optimizations" \
  ..
```

Compile:

```bash
make -j$(nproc)
```

Cek library:

```bash
find ~/Ne10/build -name 'libNE10.a' -ls
```

Hasil aktual:

```text
/home/doasdr/Ne10/build/modules/libNE10.a
```

Jika file tersebut ada:

```text
Ne10 ✅
```

---

# 8. Install Miniforge

Download installer ARM64:

```bash
cd ~
wget https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-aarch64.sh
```

Jadikan executable:

```bash
chmod +x Miniforge3-Linux-aarch64.sh
```

Install:

```bash
./Miniforge3-Linux-aarch64.sh
```

Saat diminta:

```text
Do you accept the license terms?
```

jawab:

```text
yes
```

Lokasi default:

```text
/home/doasdr/miniforge3
```

Setujui shell initialization.

Reload shell:

```bash
source ~/.bashrc
```

Cek:

```bash
which conda
conda --version
```

Hasil aktual:

```text
/home/doasdr/miniforge3/bin/conda
conda 26.5.3
```

Optional:

```bash
conda config --set auto_activate_base false
```

Jika prompt masih:

```text
(base)
```

keluar dengan:

```bash
conda deactivate
```

---

# 9. Buat Conda Environment `sdr`

Dokumentasi resmi biasanya menggunakan nama:

```text
kraken
```

Namun implementasi ini menggunakan:

```text
sdr
```

Nama environment bebas.

Buat:

```bash
conda create -y -n sdr python=3.9.7
```

Aktifkan:

```bash
conda activate sdr
```

Prompt:

```text
(sdr) doasdr@doasdr:~ $
```

Cek:

```bash
python --version
which python
```

Target:

```text
Python 3.9.7
/home/doasdr/miniforge3/envs/sdr/bin/python
```

---

# 10. Install Dependency DSP Kraken

Install versi yang kompatibel dengan Kraken V1:

```bash
conda install -y scipy==1.9.3
```

```bash
conda install -y numba==0.56.4
```

Install dependency lain:

```bash
conda install -y \
  configparser \
  pyzmq \
  scikit-rf \
  scikit-image \
  gitpython
```

Verifikasi:

```bash
python -c "
import scipy, numba, zmq, skrf
print('Python OK')
print('scipy:', scipy.__version__)
print('numba:', numba.__version__)
"
```

Hasil aktual:

```text
Python OK
scipy: 1.9.3
numba: 0.56.4
```

---

# 11. Clone Heimdall DAQ

Buat project root:

```bash
mkdir -p ~/doasdr
cd ~/doasdr
```

Clone:

```bash
git clone https://github.com/krakenrf/heimdall_daq_fw
```

Masuk DAQ core:

```bash
cd ~/doasdr/heimdall_daq_fw/Firmware/_daq_core
```

---

# 12. Copy Library ke Heimdall `_daq_core`

Copy Ne10:

```bash
cp ~/Ne10/build/modules/libNE10.a .
```

Copy KrakenRF librtlsdr:

```bash
cp ~/librtlsdr/build/src/librtlsdr.a .
```

Copy header:

```bash
cp ~/librtlsdr/include/rtl-sdr.h .
cp ~/librtlsdr/include/rtl-sdr_export.h .
```

Cek:

```bash
ls -lh \
  libNE10.a \
  librtlsdr.a \
  rtl-sdr.h \
  rtl-sdr_export.h
```

Keempat file harus ada.

---

# 13. Compile Heimdall DAQ

## PENTING: Jangan Pakai Parallel Build

Awalnya dicoba:

```bash
make -j$(nproc)
```

dan gagal dengan error:

```text
/usr/bin/ld: cannot find sh_mem_util.o
/usr/bin/ld: cannot find log.o
/usr/bin/ld: cannot find iq_header.o
collect2: error: ld returned 1 exit status
```

Penyebab:

```text
Makefile Heimdall memiliki dependency ordering yang tidak aman
untuk parallel build.
```

Beberapa target mulai linking sebelum object file selesai dibuat.

### Solusi

Bersihkan:

```bash
cd ~/doasdr/heimdall_daq_fw/Firmware/_daq_core
make clean
```

Compile serial:

```bash
make
```

JANGAN gunakan:

```text
make -j4
make -j$(nproc)
```

untuk Heimdall DAQ versi ini.

---

# 14. Hasil Compile Heimdall yang Benar

Build sukses menghasilkan:

```text
rtl_daq.out
rebuffer.out
iq_server.out
decimate.out
```

Cek:

```bash
ls -lh *.out
```

Artinya:

```text
Heimdall DAQ compile ✅
```

---

# 15. Install Dependency UI KrakenSDR V1

Aktifkan environment:

```bash
conda activate sdr
```

Install Conda package:

```bash
conda install -y \
  pandas \
  orjson \
  matplotlib \
  requests
```

Install pinned package dengan pip:

```bash
pip install dash_bootstrap_components==1.1.0
pip install quart_compress==0.2.1
pip install quart==0.17.0
pip install dash_devices==0.1.3
pip install pyargus
pip install gpsd-py3
```

Install pinned UI dependency:

```bash
conda install -y dash==1.20.0
conda install -y werkzeug==2.0.2
conda install -y plotly==5.23.0
```

---

# 16. Masalah Dependency `orjson`

Saat dilakukan check:

```bash
python -c "
import pandas
import orjson
import matplotlib
import requests
import dash
import werkzeug
import plotly
import quart
import pyargus
print('Kraken UI dependencies OK')
"
```

sempat muncul:

```text
ModuleNotFoundError: No module named 'orjson'
```

Solusi:

```bash
conda activate sdr
conda install -y orjson
```

Ulangi check.

Hasil aktual:

```text
Kraken UI dependencies OK
```

---

# 17. Warning `pkg_resources`

Saat import `dash`, muncul warning:

```text
pkg_resources is deprecated as an API
```

Ini:

```text
WARNING ✅
ERROR   ❌
```

Artinya instalasi tetap berhasil.

Penyebabnya adalah stack Dash lama pada KrakenSDR V1 masih menggunakan API tersebut.

Selama output akhirnya:

```text
Kraken UI dependencies OK
```

warning dapat diabaikan.

---

# 18. Clone KrakenSDR DoA V1

Masuk root:

```bash
cd ~/doasdr
```

Clone:

```bash
git clone https://github.com/krakenrf/krakensdr_doa
```

Struktur:

```text
~/doasdr/
├── heimdall_daq_fw/
└── krakensdr_doa/
```

---

# 19. Copy Start/Stop Script

```bash
cd ~/doasdr
```

Copy:

```bash
cp krakensdr_doa/util/kraken_doa_start.sh .
cp krakensdr_doa/util/kraken_doa_stop.sh .
```

Cek:

```bash
ls -lh ~/doasdr
```

Target:

```text
heimdall_daq_fw/
krakensdr_doa/
kraken_doa_start.sh
kraken_doa_stop.sh
```

---

# 20. Ubah Conda Environment pada Start Script

Script resmi mengasumsikan:

```bash
conda activate kraken
```

Karena environment aktual:

```text
sdr
```

ubah dengan:

```bash
sed -i 's/conda activate kraken/conda activate sdr/' \
~/doasdr/kraken_doa_start.sh
```

Cek:

```bash
grep -n "conda activate" ~/doasdr/kraken_doa_start.sh
```

Target:

```text
conda activate sdr
```

Pastikan executable:

```bash
chmod +x ~/doasdr/kraken_doa_start.sh
chmod +x ~/doasdr/kraken_doa_stop.sh
```

---

# 21. Hubungkan KrakenSDR ke Raspberry Pi

Colok KrakenSDR ke USB Raspberry.

Cek:

```bash
lsusb
```

Hasil aktual menunjukkan 5 perangkat:

```text
ID 0bda:2838 Realtek Semiconductor Corp. RTL2838 DVB-T
```

sebanyak lima kali.

Artinya:

```text
5 x RTL2838 detected ✅
```

---

# 22. Test Hardware dengan `kraken_test`

Jalankan:

```bash
kraken_test
```

Hasil aktual:

```text
Found 5 device(s):
  0: Realtek, RTL2838UHIDIR, SN: 1004
  1: Realtek, RTL2838UHIDIR, SN: 1000
  2: Realtek, RTL2838UHIDIR, SN: 1001
  3: Realtek, RTL2838UHIDIR, SN: 1002
  4: Realtek, RTL2838UHIDIR, SN: 1003
```

Kemudian:

```text
Using device 0: Generic RTL2832U OEM
Found Rafael Micro R820T/2 tuner
Sampling at 2048000 S/s.
Reading samples in async mode...
```

Jika setelah:

```text
Reading samples in async mode...
```

tidak ada error/lost sample, itu normal.

Stop test:

```text
Ctrl+C
```

PENTING:

Jangan menjalankan `kraken_test` bersamaan dengan Heimdall karena device RTL-SDR hanya dapat dibuka oleh satu proses.

---

# 23. Start KrakenSDR DoA

Masuk:

```bash
cd ~/doasdr
```

Aktifkan environment:

```bash
conda activate sdr
```

Start:

```bash
./kraken_doa_start.sh
```

Jangan gunakan:

```bash
sudo ./kraken_doa_start.sh
```

Script akan menjalankan komponen yang memang membutuhkan `sudo` secara internal.

---

# 24. Output Start yang Berhasil

Hasil aktual:

```text
Starting KrakenSDR Direction Finder
Web Interface Running at 0.0.0.0:8080
Data Out Server Running at 0.0.0.0:8081
TAK Server NOT Installed
```

Artinya:

```text
KrakenSDR V1 startup ✅
Web UI configured   ✅
Data Out configured ✅
```

TAK Server tidak wajib untuk penggunaan DoA biasa.

---

# 25. Akses Web UI

Cari IP Raspberry:

```bash
hostname -I
```

atau:

```bash
ip -4 addr show wlan0
```

Pada implementasi awal Raspberry memiliki:

```text
192.168.1.52
```

Buka dari browser:

```text
http://192.168.1.52:8080
```

Port:

```text
8080 = KrakenSDR Web UI
```

Jika UI terbuka:

```text
Kraken Web Interface ✅
```

---

# 26. Port 8081 Bukan Web UI

Jika membuka:

```text
http://192.168.1.52:8081/
```

dan muncul:

```text
Not Found
The requested resource `/` was not found on this server.
```

itu NORMAL.

Port:

```text
8081
```

adalah Data Out / shared file HTTP server.

Root `/` tidak harus mempunyai index file.

Jadi:

```text
8080 → Web GUI
8081 → Data/file server
```

---

# 27. Test Data Out Server

Contoh:

```bash
curl http://127.0.0.1:8081/settings.json
```

atau browser:

```text
http://192.168.1.52:8081/settings.json
```

Untuk DoA output, tergantung runtime/config software, file seperti:

```text
DOA_value.html
```

dapat tersedia di shared directory.

Cek isi share:

```bash
ls -lah ~/doasdr/krakensdr_doa/_share
```

Lebih lengkap:

```bash
find ~/doasdr/krakensdr_doa/_share \
  -maxdepth 2 \
  -type f \
  -printf '%P\n'
```

---

# 28. Cek Listening Port

Jika Web UI tidak bisa dibuka:

```bash
sudo ss -ltnp | grep -E ':8080|:8081'
```

Target:

```text
0.0.0.0:8080
0.0.0.0:8081
```

Test lokal:

```bash
curl -I http://127.0.0.1:8080
```

Jika localhost bisa tapi komputer lain tidak bisa, baru cek:

```text
IP
routing
firewall
Wi-Fi isolation
```

---

# 29. Log Kraken UI

Jika start script mengatakan UI hidup tetapi browser gagal:

```bash
tail -n 100 \
~/doasdr/krakensdr_doa/_share/logs/krakensdr_doa/ui.log
```

atau:

```bash
cat \
~/doasdr/krakensdr_doa/_share/logs/krakensdr_doa/ui.log
```

Ini penting untuk mengetahui:

```text
missing Python module
Dash incompatibility
Werkzeug error
Quart error
Python traceback
```

---

# 30. Cek Process Kraken

```bash
ps aux | grep -E \
'app.py|php.*8081|rtl_daq|rebuffer|decimate|iq_server' \
| grep -v grep
```

Komponen yang umum:

```text
rtl_daq.out
rebuffer.out
iq_server.out
decimate.out
Python Kraken app.py
PHP :8081 server
```

---

# 31. Stop KrakenSDR

Masuk root:

```bash
cd ~/doasdr
```

Stop:

```bash
./kraken_doa_stop.sh
```

Jika ingin memastikan:

```bash
ps aux | grep -E \
'app.py|rtl_daq|rebuffer|decimate|iq_server' \
| grep -v grep
```

---

# 32. Start Ulang

```bash
cd ~/doasdr
conda activate sdr
./kraken_doa_start.sh
```

First run dapat lebih lambat karena Numba JIT.

Run berikutnya biasanya lebih cepat karena cache sudah terbentuk.

---

# 33. Troubleshooting Ringkas

## 33.1 `kraken_test` tidak ditemukan

Cek:

```bash
ls -l /usr/local/bin/kraken_test
```

Jika belum:

```bash
sudo ln -s \
~/librtlsdr/build/src/rtl_test \
/usr/local/bin/kraken_test
```

## 33.2 Hanya beberapa RTL2838 terdeteksi

Cek:

```bash
lsusb
```

Harus ada 5 perangkat:

```text
0bda:2838
```

Coba:

- reconnect USB,
- cek power,
- reboot,
- cek hub internal Kraken,
- cek kernel log:

```bash
dmesg | tail -n 100
```

## 33.3 `kraken_test` busy

Pastikan Kraken/Heimdall tidak sedang berjalan.

Stop:

```bash
cd ~/doasdr
./kraken_doa_stop.sh
```

## 33.4 `make -j$(nproc)` gagal

Error:

```text
cannot find sh_mem_util.o
cannot find log.o
cannot find iq_header.o
```

Solusi:

```bash
make clean
make
```

## 33.5 `ModuleNotFoundError: orjson`

```bash
conda activate sdr
conda install -y orjson
```

## 33.6 `pkg_resources is deprecated`

Jika Kraken tetap menulis:

```text
Kraken UI dependencies OK
```

abaikan warning.

## 33.7 Browser `:8080` tidak bisa dibuka

Cek:

```bash
sudo ss -ltnp | grep :8080
```

```bash
curl -I http://127.0.0.1:8080
```

```bash
tail -n 100 \
~/doasdr/krakensdr_doa/_share/logs/krakensdr_doa/ui.log
```

## 33.8 `:8081/` menampilkan Not Found

Normal.

Gunakan resource spesifik:

```text
/settings.json
/DOA_value.html
```

atau cek folder `_share`.

---

# 34. Status Implementasi Aktual

| Komponen | Status |
|---|---|
| Debian 13 ARM64 | ✅ |
| Miniforge | ✅ |
| Conda env `sdr` | ✅ |
| Python 3.9.7 | ✅ |
| SciPy 1.9.3 | ✅ |
| Numba 0.56.4 | ✅ |
| KrakenRF librtlsdr | ✅ |
| Ne10 | ✅ |
| Heimdall DAQ compile | ✅ |
| UI dependencies | ✅ |
| `orjson` | ✅ |
| krakensdr_doa V1 | ✅ |
| 5 RTL2838 detected | ✅ |
| R820T/2 tuner | ✅ |
| `kraken_test` streaming | ✅ |
| Web UI :8080 | ✅ |
| Data Out :8081 | ✅ |
| T900 access | NEXT |
| MQTT | NEXT |
| Spectrum MQTT | NEXT |
| Remote settings MQTT | NEXT |

---

# 35. Quick Recreate dari Nol

## 35.1 Build dependencies

```bash
sudo apt update

sudo apt install -y \
  build-essential git cmake \
  libusb-1.0-0-dev \
  lsof libzmq3-dev clang \
  php-cli nodejs gpsd \
  libfftw3-bin libfftw3-dev
```

## 35.2 librtlsdr

```bash
cd ~
git clone https://github.com/krakenrf/librtlsdr
cd librtlsdr

sudo cp rtl-sdr.rules /etc/udev/rules.d/rtl-sdr.rules

mkdir build
cd build

cmake ../ -DINSTALL_UDEV_RULES=ON
make -j$(nproc)

sudo ln -s \
~/librtlsdr/build/src/rtl_test \
/usr/local/bin/kraken_test
```

Blacklist:

```bash
echo 'blacklist dvb_usb_rtl28xxu' | \
sudo tee /etc/modprobe.d/blacklist-dvb_usb_rtl28xxu.conf

sudo reboot
```

## 35.3 Ne10

```bash
cd ~
git clone https://github.com/krakenrf/Ne10

cd ~/Ne10
mkdir build
cd build

cmake \
  -DNE10_LINUX_TARGET_ARCH=aarch64 \
  -DGNULINUX_PLATFORM=ON \
  -DCMAKE_C_FLAGS="-mcpu=native -Ofast -funsafe-math-optimizations" \
  ..

make -j$(nproc)
```

## 35.4 Miniforge

```bash
cd ~

wget \
https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-aarch64.sh

chmod +x Miniforge3-Linux-aarch64.sh
./Miniforge3-Linux-aarch64.sh

source ~/.bashrc
```

## 35.5 Conda

```bash
conda create -y -n sdr python=3.9.7
conda activate sdr
```

```bash
conda install -y scipy==1.9.3
conda install -y numba==0.56.4
```

```bash
conda install -y \
  configparser \
  pyzmq \
  scikit-rf \
  scikit-image \
  gitpython
```

## 35.6 Heimdall

```bash
mkdir -p ~/doasdr
cd ~/doasdr

git clone https://github.com/krakenrf/heimdall_daq_fw

cd ~/doasdr/heimdall_daq_fw/Firmware/_daq_core

cp ~/Ne10/build/modules/libNE10.a .
cp ~/librtlsdr/build/src/librtlsdr.a .
cp ~/librtlsdr/include/rtl-sdr.h .
cp ~/librtlsdr/include/rtl-sdr_export.h .

make clean
make
```

## 35.7 UI dependency

```bash
conda activate sdr

conda install -y \
  pandas \
  orjson \
  matplotlib \
  requests
```

```bash
pip install dash_bootstrap_components==1.1.0
pip install quart_compress==0.2.1
pip install quart==0.17.0
pip install dash_devices==0.1.3
pip install pyargus
pip install gpsd-py3
```

```bash
conda install -y dash==1.20.0
conda install -y werkzeug==2.0.2
conda install -y plotly==5.23.0
```

## 35.8 Kraken DoA

```bash
cd ~/doasdr

git clone https://github.com/krakenrf/krakensdr_doa

cp krakensdr_doa/util/kraken_doa_start.sh .
cp krakensdr_doa/util/kraken_doa_stop.sh .
```

Change env:

```bash
sed -i \
's/conda activate kraken/conda activate sdr/' \
~/doasdr/kraken_doa_start.sh
```

## 35.9 Hardware test

```bash
lsusb
kraken_test
```

Harus:

```text
Found 5 device(s)
```

Stop:

```text
Ctrl+C
```

## 35.10 Run

```bash
cd ~/doasdr
conda activate sdr
./kraken_doa_start.sh
```

Buka:

```text
http://RASPBERRY_IP:8080
```

---

# 36. Integrasi Selanjutnya dengan T900

Saat Kraken lokal sudah berhasil, sistem akan diuji melalui link PPP T900.

Arsitektur:

```text
GROUND
10.90.0.1
    │
   PPP
    │
T900-Ground
   )))
   ((( RF
T900-UAV
    │
   PPP
    │
10.90.0.2
Raspberry
    │
Kraken :8080
```

Test berikutnya:

```text
http://10.90.0.2:8080
```

Namun penggunaan Web UI penuh melalui T900 hanya untuk:

```text
debugging
maintenance
test
```

bukan untuk operasi rutin karena bandwidth T900 terbatas.

---

# 37. Arsitektur Operasional yang Direncanakan

```text
KrakenSDR
   │
   ▼
Heimdall
   │
   ▼
Kraken DoA DSP
   │
   ├── DoA
   ├── RSSI
   ├── Confidence
   ├── Spectrum
   └── Settings
          │
          ▼
    UAV Controller
          │
         MQTT
          │
         PPP
          │
         T900
          │
          ▼
     Ground Console
```

---

# 38. Prinsip Pengiriman Data

Jangan kirim raw IQ melalui T900.

Kirim:

```text
DoA
RSSI
Confidence
Frequency
GPS
Heading
System State
Compact Spectrum
Command
ACK
```

Spectrum sebaiknya:

```text
256 bins
1–2 Hz
QoS 0
```

Ground menggambar spectrum/waterfall sendiri.

---

# 39. Referensi

KrakenSDR DoA V1:

https://github.com/krakenrf/krakensdr_doa

Heimdall DAQ:

https://github.com/krakenrf/heimdall_daq_fw

KrakenRF librtlsdr:

https://github.com/krakenrf/librtlsdr

KrakenRF Ne10:

https://github.com/krakenrf/Ne10

KrakenSDR Documentation:

https://github.com/krakenrf/krakensdr_docs

Miniforge:

https://github.com/conda-forge/miniforge

---

# 40. Kesimpulan

Instalasi aktual membuktikan bahwa KrakenSDR DoA V1 dapat dijalankan pada:

```text
Debian 13 Trixie
ARM64
Python 3.9.7
Conda environment `sdr`
Raspberry Pi
```

dengan hasil:

```text
5 receiver RTL2838 detected ✅
R820T/2 tuner detected      ✅
Heimdall DAQ compiled       ✅
KrakenSDR DSP running       ✅
Web UI :8080                ✅
Data Out :8081              ✅
```

Catatan terpenting untuk recreate:

```text
1. Gunakan KrakenRF fork librtlsdr
2. Blacklist dvb_usb_rtl28xxu
3. Build Ne10 untuk aarch64
4. Gunakan Python 3.9.7
5. Pin SciPy 1.9.3 dan Numba 0.56.4
6. Pin Dash/Werkzeug sesuai Kraken V1
7. Install orjson
8. Heimdall: gunakan `make`, BUKAN `make -j`
9. Ubah start script dari env `kraken` menjadi `sdr`
10. Port 8081 root Not Found adalah normal
```

Dengan kondisi ini, Raspberry sudah siap untuk tahap berikutnya:

```text
KrakenSDR
   ↓
T900 PPP
   ↓
MQTT
   ↓
Ground Console
```

---

**End of Documentation**
