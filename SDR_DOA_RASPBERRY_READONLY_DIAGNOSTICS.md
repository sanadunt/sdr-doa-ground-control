# SDR-DoA Raspberry Read-Only Diagnostics

Panduan ini berisi pemeriksaan **read-only** untuk mencari sumber gangguan pada Raspberry, USB hub, dongle RTL-SDR, DAQ subsystem, service `sdr-doa`, KrakenSDR, Data Out, dan koneksi jaringan.

Dokumen ini tidak melakukan recovery otomatis dan tidak mengubah Raspberry.

## 1. Batasan keselamatan

Semua command pada panduan ini dimaksudkan untuk membaca keadaan sistem saja.

Jangan menjalankan command berikut selama prosedur read-only:

```text
systemctl restart/stop/start sdr-doa.service
systemctl restart/stop/start t900-ppp.service
daq_stop.sh
sdr_doa_start.sh
kill, pkill, killall
usbreset
uhubctl
modprobe -r
tee, rm, mv, cp ke filesystem Raspberry
POST, PUT, PATCH, DELETE
MQTT publish
```

Jangan menjalankan `rtl_test` ketika DAQ sedang aktif. Tool itu dapat berebut akses dengan proses DAQ dan mengubah hasil diagnosis. Pengujian `rtl_test` per dongle harus dilakukan pada maintenance window terpisah, setelah ada persetujuan untuk menghentikan DAQ secara terkontrol.

Jangan mengirimkan ke chat:

```text
password
private key
API key
access token
credential
isi penuh .env
isi penuh settings.json
connection string
```

Jika suatu output berisi nilai sensitif, ganti nilainya dengan `[REDACTED]` sebelum dibagikan.

## 2. Masuk ke Raspberry

Hostname yang digunakan pada pemeriksaan sebelumnya:

```bash
ssh -o ConnectTimeout=8 -o ConnectionAttempts=1 doasdr@doasdr.local
```

Fallback menggunakan alamat LAN:

```bash
ssh -o ConnectTimeout=8 -o ConnectionAttempts=1 doasdr@192.168.100.100
```

Password SSH atau sudo hanya dimasukkan langsung pada Terminal. Jangan menaruh password di command line atau mengirimkannya melalui chat.

Semua command berikut dijalankan di Raspberry, kecuali bagian yang diberi keterangan **dari Ground**.

## 3. Identitas dan kesehatan dasar board

```bash
date -Is
hostname
id -un
uname -a
cat /etc/os-release
uptime
free -h
df -hT
lsblk -o NAME,MODEL,SIZE,TYPE,FSTYPE,MOUNTPOINTS
```

Model board, arsitektur, temperatur, dan throttling:

```bash
printf 'model: '
tr -d '\0' < /proc/device-tree/model
printf '\narch: '
uname -m
printf 'bits: '
getconf LONG_BIT

for z in /sys/class/thermal/thermal_zone*/temp; do
    [ -r "$z" ] || continue
    printf '%s: ' "$z"
    awk '{printf "%.1f C\n", $1/1000}' "$z"
done

command -v vcgencmd >/dev/null && vcgencmd measure_temp
command -v vcgencmd >/dev/null && vcgencmd get_throttled
```

Hal yang dicatat:

```text
temperatur tinggi
throttling atau undervoltage
filesystem hampir penuh
uptime dan waktu boot
```

## 4. Inventaris semua perangkat USB

Daftar semua device dan topology hub:

```bash
lsusb
lsusb -t
usb-devices
```

Daftar khusus dongle RTL-SDR Kraken:

```bash
lsusb -d 0bda:2838
```

Konfigurasi yang diharapkan pada node ini adalah lima RTL2838. Namun jumlah lima pada `lsusb` hanya membuktikan **enumeration**, bukan bahwa kelima dongle dapat dipakai oleh `libusb` atau DAQ.

Detail setiap RTL-SDR dari sysfs:

```bash
for d in /sys/bus/usb/devices/*; do
    [ -f "$d/idVendor" ] || continue
    [ "$(cat "$d/idVendor" 2>/dev/null)" = "0bda" ] || continue
    [ "$(cat "$d/idProduct" 2>/dev/null)" = "2838" ] || continue

    printf '\n=== %s ===\n' "$d"
    for f in idVendor idProduct manufacturer product serial busnum devnum speed authorized; do
        if [ -r "$d/$f" ]; then
            printf '%-14s: %s\n' "$f" "$(tr -d '\0' < "$d/$f")"
        fi
    done
    printf 'driver         : '
    readlink -f "$d/driver" 2>/dev/null || true
done
```

Yang perlu dibandingkan antar-pengujian:

```text
jumlah device
serial dongle
bus/path USB
speed
authorized
perubahan topology
```

Pada pemeriksaan sebelumnya, serial yang terlihat adalah `1000` sampai `1004`. Gunakan hasil aktual dari node sebagai sumber kebenaran, bukan daftar di dokumen ini.

## 5. Riwayat disconnect, reset, dan error USB

Kernel log 24 jam terakhir:

```bash
sudo journalctl -k --since "24 hours ago" --no-pager \
  | grep -Ei 'usb|rtl|xhci|disconnect|reset|i2c|error|fail'
```

Alternatif:

```bash
sudo dmesg -T \
  | grep -Ei 'usb|rtl|xhci|disconnect|reset|i2c|error|fail' \
  | tail -n 200
```

Filter event enumeration dan disconnect:

```bash
sudo journalctl -k --since "24 hours ago" --no-pager \
  | grep -Ei 'USB disconnect|new USB device|reset|device descriptor|rtl2838|Realtek|hub'
```

Interpretasi awal:

```text
lima dongle disconnect bersamaan  -> curiga hub, power, kabel, atau upstream USB
satu serial sering hilang          -> curiga dongle/port tertentu
USB kembali tetapi DAQ tetap fail  -> enumeration berhasil, tetapi handle/transfer tidak usable
```

## 6. Versi software dan tool

```bash
python3 --version
node --version 2>/dev/null || true
php --version 2>/dev/null | sed -n '1,2p' || true
command -v rtl_test || true
command -v rtl_sdr || true
command -v lsusb || true
command -v ss || true
dpkg -l 2>/dev/null | grep -Ei 'rtl|sdr|usb|libusb|python|node|php'
```

Mount, disk, dan filesystem:

```bash
mount | grep -Ei 'home|ext4|usb|mmc'
findmnt
```

## 7. Lifecycle service `sdr-doa`

Status service:

```bash
systemctl status sdr-doa.service --no-pager --full
```

Field lifecycle penting:

```bash
systemctl show sdr-doa.service --no-pager \
  -p Id \
  -p LoadState \
  -p ActiveState \
  -p SubState \
  -p Result \
  -p MainPID \
  -p ExecMainStatus \
  -p ExecMainStartTimestamp \
  -p NRestarts \
  -p Type \
  -p RemainAfterExit \
  -p Restart \
  -p RestartSec \
  -p KillMode \
  -p ControlGroup
```

Unit dan service terkait:

```bash
systemctl cat sdr-doa.service
systemctl list-units --all --type=service --no-pager \
  | grep -Ei 'sdr|kraken|daq|watch|usb|t900'

systemctl list-timers --all --no-pager \
  | grep -Ei 'sdr|kraken|daq|watch|usb'
```

Status PPP untuk pembanding, tanpa mengubah apa pun:

```bash
systemctl is-active t900-ppp.service
systemctl is-enabled t900-ppp.service
```

### Cara membaca `active (exited)`

Jika hasilnya seperti berikut:

```text
Type=oneshot
RemainAfterExit=yes
ActiveState=active
SubState=exited
```

itu hanya membuktikan launcher selesai. Itu bukan bukti bahwa child DAQ masih menghasilkan frame. Status service harus selalu dibandingkan dengan proses DAQ, `daq_ok`, frame index, dropped frames, dan freshness output.

## 8. Proses Kraken dan DAQ

```bash
ps -eo pid,ppid,stat,lstart,etime,%cpu,%mem,args --forest \
  | grep -E 'rtl_daq|rebuffer|decimate|delay_sync|hw_controller|app.py|php -S|node _nodejs' \
  | grep -v grep
```

Alternatif:

```bash
pgrep -af 'rtl_daq|rebuffer|decimate|delay_sync|hw_controller|app.py|php -S|node _nodejs'
```

Hitung proses utama agar duplicate mudah terlihat:

```bash
for name in rtl_daq.out rebuffer.out decimate.out delay_sync.py hw_controller.py; do
    printf '%-18s: ' "$name"
    pgrep -fc "$name"
done
```

Detail state proses:

```bash
for pid in $(pgrep -f 'rtl_daq.out|rebuffer.out|decimate.out|delay_sync.py|hw_controller.py'); do
    [ -r "/proc/$pid/status" ] || continue
    printf '\n=== PID %s ===\n' "$pid"
    grep -E '^(Name|State|PPid|Threads):' "/proc/$pid/status"
    printf 'cwd: '
    readlink -f "/proc/$pid/cwd"
done
```

Proses yang biasanya diharapkan:

```text
rtl_daq.out
rebuffer.out
decimate.out
delay_sync.py
hw_controller.py
_ui/_web_interface/app.py
php -S ...:8081
node _nodejs/index.js
```

Proses hidup tidak otomatis berarti proses sehat.

## 9. Listener dan interface internal

```bash
sudo ss -lntup
```

Fokus pada port Kraken:

```bash
for port in 5000 5001 8080 8081; do
    printf '\n=== PORT %s ===\n' "$port"
    ss -lntup | grep -E ":${port}\\b" || true
done
```

Alternatif pemilik listener:

```bash
sudo lsof -nP -iTCP -sTCP:LISTEN
```

Port yang perlu diamati:

```text
5000 : interface internal DAQ/IQ
5001 : hardware controller
8080 : web UI Kraken
8081 : Data Out
```

## 10. Koneksi jaringan dan endpoint Data Out

```bash
ip -br link
ip -br addr
ip route
getent hosts doasdr.local
getent hosts doasdr
```

Tes endpoint dari Raspberry sendiri:

```bash
curl -fsS --max-time 5 -w '\nHTTP=%{http_code}\n' \
  http://127.0.0.1:8081/status.json

curl -I --max-time 5 http://127.0.0.1:8080/doa
```

Baca resource yang sudah diketahui:

```bash
for path in /status.json /DOA_value.html /doa.xml; do
    printf '\n=== %s ===\n' "$path"
    curl -sS --max-time 5 \
      -w '\nHTTP=%{http_code} BYTES=%{size_download}\n' \
      "http://127.0.0.1:8081$path" \
      | sed -n '1,4p'
done
```

Dari Ground, endpoint LAN dapat dibaca dengan:

```bash
curl -fsS --max-time 5 \
  http://192.168.100.100:8081/status.json
```

Semua request dalam bagian ini adalah GET/read-only.

## 11. Status DAQ aktual

```bash
python3 - <<'PY'
import json
from pathlib import Path

p = Path('/home/doasdr/doasdr/krakensdr_doa/_share/status.json')
data = json.loads(p.read_text())
daq_status = data.get('daq_status')
if not isinstance(daq_status, dict):
    daq_status = {}

for key in (
    'timestamp_ms',
    'daq_ok',
    'daq_status',
    'daq_num_dropped_frames',
    'hardware_id',
    'software_version',
    'software_git_short_hash',
    'gps_status',
):
    print(f'{key}: {data.get(key)}')

for key in (
    'data_frame_index',
    'frame_sync',
    'sample_delay_sync',
    'iq_sync',
    'adc_overdrive',
    'sampling_frequency_hz',
):
    print(f'daq_status.{key}: {daq_status.get(key)}')
PY
```

Kondisi DAQ sehat minimal:

```text
daq_ok                 = true
daq_status             = object terisi
data_frame_index       = tersedia dan bertambah
frame_sync             = true
sample_delay_sync      = true
iq_sync                = true
dropped frames         = tidak terus meningkat
```

Kondisi yang harus ditandai sebagai degraded/failure:

```text
daq_ok=false
daq_status={}
dropped frames terus bertambah
frame index berhenti
```

`status.json` yang timestamp-nya berubah belum cukup membuktikan DAQ sehat. Heartbeat status dapat tetap berjalan sementara frame IQ dan output DoA berhenti.

## 12. Ukuran, mtime, dan isi ringkas output

```bash
SHARE=/home/doasdr/doasdr/krakensdr_doa/_share

stat -c '%y size=%s %n' \
  "$SHARE/status.json" \
  "$SHARE/DOA_value.html" \
  "$SHARE/doa.xml"

wc -c \
  "$SHARE/status.json" \
  "$SHARE/DOA_value.html" \
  "$SHARE/doa.xml"
```

Parsing ringkas CSV/XML:

```bash
python3 - <<'PY'
import re
from pathlib import Path

share = Path('/home/doasdr/doasdr/krakensdr_doa/_share')
csv_text = (share / 'DOA_value.html').read_text(errors='replace').strip()
xml_text = (share / 'doa.xml').read_text(errors='replace')

parts = [x.strip() for x in csv_text.split(',')] if csv_text else []
print('CSV bytes:', len(csv_text.encode()))
print('CSV fields:', len(parts))
print('CSV timestamp:', parts[0] if len(parts) > 0 else None)
print('CSV raw DoA:', parts[1] if len(parts) > 1 else None)
print('CSV angular bins:', len(parts[17:]) if len(parts) >= 17 else 0)

for name in ('TIME', 'DOA', 'PWR', 'CONF', 'SNR_DB'):
    match = re.search(rf'<{name}>(.*?)</{name}>', xml_text)
    print(f'XML {name}:', match.group(1) if match else None)
PY
```

Format yang diharapkan pada CSV saat vector tersedia:

```text
17 field metadata + 360 angular bins = 377 fields
```

Jumlah field bukan satu-satunya validasi; timestamp, freshness, dan `daq_ok` juga harus lulus.

## 13. Polling tiga sample untuk membuktikan data bergerak

Command ini hanya membaca file lokal yang sudah dibuat oleh Kraken:

```bash
python3 - <<'PY'
import json
import re
import time
from pathlib import Path

share = Path('/home/doasdr/doasdr/krakensdr_doa/_share')
status_path = share / 'status.json'
csv_path = share / 'DOA_value.html'
xml_path = share / 'doa.xml'

def xml_field(text, name):
    match = re.search(rf'<{name}>(.*?)</{name}>', text)
    return match.group(1) if match else None

def mtime_ns(path):
    try:
        return path.stat().st_mtime_ns
    except OSError:
        return None

for sample in range(1, 4):
    status = json.loads(status_path.read_text())
    csv_text = csv_path.read_text(errors='replace').strip()
    xml_text = xml_path.read_text(errors='replace')
    parts = [x.strip() for x in csv_text.split(',')] if csv_text else []
    daq_status = status.get('daq_status')
    if not isinstance(daq_status, dict):
        daq_status = {}

    print({
        'sample': sample,
        'status_timestamp_ms': status.get('timestamp_ms'),
        'daq_ok': status.get('daq_ok'),
        'data_frame_index': daq_status.get('data_frame_index'),
        'frame_sync': daq_status.get('frame_sync'),
        'sample_delay_sync': daq_status.get('sample_delay_sync'),
        'iq_sync': daq_status.get('iq_sync'),
        'dropped_frames': status.get('daq_num_dropped_frames'),
        'status_mtime_ns': mtime_ns(status_path),
        'csv_bytes': len(csv_text.encode()),
        'csv_timestamp_ms': parts[0] if len(parts) > 0 else None,
        'csv_doa_deg': parts[1] if len(parts) > 1 else None,
        'csv_angular_bins': len(parts[17:]) if len(parts) >= 17 else 0,
        'csv_mtime_ns': mtime_ns(csv_path),
        'xml_time': xml_field(xml_text, 'TIME'),
        'xml_doa_deg': xml_field(xml_text, 'DOA'),
        'xml_mtime_ns': mtime_ns(xml_path),
    })

    if sample < 3:
        time.sleep(5)
PY
```

Bukti data benar-benar bergerak harus memperlihatkan beberapa hal sekaligus:

```text
frame index naik
CSV tidak kosong
CSV timestamp atau mtime maju
XML TIME atau mtime maju
daq_ok=true
sync flags true
dropped frames tidak terus naik
```

Status timestamp yang naik sendiri tidak cukup.

## 14. Log DAQ, service, dan shared memory

Log service:

```bash
sudo journalctl -u sdr-doa.service --since "2 hours ago" \
  --no-pager -o short-iso
```

Log kernel USB:

```bash
sudo journalctl -k --since "2 hours ago" \
  --no-pager -o short-iso \
  | grep -Ei 'usb|rtl|xhci|disconnect|reset|i2c|error|fail'
```

Metadata file log DAQ:

```bash
cd /home/doasdr/doasdr/heimdall_daq_fw/Firmware/_logs
find . -maxdepth 1 -type f \
  -printf '%TY-%Tm-%Td %TH:%TM:%TS size=%s %p\n' \
  | sort
```

Ringkasan error:

```bash
cd /home/doasdr/doasdr/heimdall_daq_fw/Firmware/_logs

for f in *.log; do
    [ -f "$f" ] || continue
    printf '\n=== %s ===\n' "$f"
    printf 'lines='
    wc -l < "$f"
    printf 'bytes='
    wc -c < "$f"
    grep -Ei 'error|failed|cancel|callback|rtl|i2c|shared memory|warning' "$f" \
      | tail -n 50
done
```

Log paling penting:

```text
rtl_daq.log
rebuffer.log
decimator.log
delay_sync.log
hwc.log
```

Error yang perlu dikelompokkan:

```text
rtlsdr read/write failed
I2C register failed
callback/transfer failed
shared memory not exist
FIFO atau internal port tidak tersedia
```

Jangan menghapus log untuk mengulangi pengujian. Script startup node yang melakukan `rm _logs/*.log` akan menghilangkan bukti historis dan perlu diperhitungkan saat merancang recovery.

Shared memory dan FIFO:

```bash
find /dev/shm -maxdepth 1 -type f \
  -printf '%M %u:%g size=%s %TY-%Tm-%Td %TH:%TM:%TS %p\n' \
  | sort

find /home/doasdr/doasdr/heimdall_daq_fw/Firmware/_data_control \
  -maxdepth 1 \
  -printf '%M %u:%g size=%s %TY-%Tm-%Td %TH:%TM:%TS %p\n' \
  | sort
```

## 15. Pemeriksaan konfigurasi tanpa menulis

```bash
cd /home/doasdr/doasdr/heimdall_daq_fw/Firmware

grep -nE 'out_data_iface_type|shmem|eth|5000|5001|sample|buffer' \
  daq_chain_config.ini
```

Baca field settings yang relevan saja:

```bash
python3 - <<'PY'
import json
from pathlib import Path

p = Path('/home/doasdr/doasdr/krakensdr_doa/_share/settings.json')
data = json.loads(p.read_text())

for key in (
    'data_interface',
    'doa_data_format',
    'doa_fig_type',
    'doa_method',
    'ant_arrangement',
    'center_freq',
    'dsp_decimation',
    'active_vfos',
    'output_vfo',
    'en_doa',
    'station_id',
):
    print(f'{key}={data.get(key)!r}')
PY
```

Jangan membagikan seluruh `settings.json`.

## 16. Pemeriksaan dari Ground

Dari Mac/Ground, cek koneksi dan endpoint tanpa POST:

```bash
ping -c 4 -W 2 192.168.100.100

curl -fsS --max-time 5 \
  http://192.168.100.100:8081/status.json

for path in /DOA_value.html /doa.xml; do
    printf '\n=== %s ===\n' "$path"
    curl -sS --max-time 5 \
      -w '\nHTTP=%{http_code} BYTES=%{size_download}\n' \
      "http://192.168.100.100:8081$path" \
      | sed -n '1,4p'
done
```

Jika HTTP `200` tetapi CSV kosong, XML tidak berubah, atau `daq_ok=false`, masalahnya berada sebelum Ground Console: pada DAQ/USB/RTL-SDR/shared-memory/runtime Kraken.

## 17. Matriks interpretasi

| Temuan | Interpretasi awal |
|---|---|
| 5 RTL2838 terlihat, `daq_ok=true`, frame naik, CSV/XML maju | DAQ sehat pada window pengujian |
| 5 RTL2838 terlihat, `daq_ok=false`, `daq_status={}`, drop naik | device ter-enumerasi tetapi DAQ tidak menerima frame valid |
| `status.json` berubah, CSV/XML membeku | heartbeat/status hidup, pipeline DoA tidak sehat |
| semua dongle disconnect bersamaan | curiga power, hub, kabel, atau upstream USB |
| satu serial hilang berulang | curiga dongle atau port tertentu |
| `active (exited)` tetapi child fail | lifecycle systemd tidak mengawasi kesehatan child |
| `rtl_sdr` read/write atau I2C error berulang | masalah komunikasi device/driver/DAQ runtime |
| `Shared memory not exist` | chain DAQ tidak menghasilkan atau tidak membagi data ke tahap berikutnya |
| restart memulihkan sebentar lalu fail lagi | reopen handle membantu sementara; akar USB/driver/power atau recovery runtime belum selesai |

## 18. Bukti yang perlu dikumpulkan

Untuk satu laporan diagnosis, kumpulkan hasil ringkas berikut:

```text
1. lsusb -t
2. lsusb -d 0bda:2838
3. detail sysfs serial/path/speed/authorized
4. systemctl show sdr-doa.service ...
5. status.json yang sudah diringkas
6. polling tiga sample
7. tail error rtl_daq.log dan delay_sync.log
8. kernel USB log
9. proses dan listener
10. status t900-ppp.service tanpa tindakan terhadap unit tersebut
```

Laporan sebaiknya mencatat:

```text
waktu dan timezone
hostname
jumlah USB dan serial
daq_ok
daq_status
frame index
dropped frames
CSV/XML size dan timestamp
error group
```

## 19. Prosedur operasional sementara — di luar scope read-only

Bagian ini **bukan prosedur read-only**. Menghubungkan perangkat secara fisik dan menjalankan service dapat mengubah runtime. Lakukan hanya dalam maintenance window dengan persetujuan operator yang terpisah. Jangan mengeksekusi langkah-langkah ini hanya karena panduan ini sedang digunakan untuk diagnosis read-only.

Sebelum supervisor otomatis tersedia:

```text
1. Pastikan power Kraken/USB hub stabil.
2. Hubungkan seluruh dongle sebelum menjalankan service.
3. Pastikan lima RTL2838 terenumerasi stabil.
4. Jalankan service sesuai prosedur operator yang disetujui.
5. Verifikasi DAQ nyata, bukan hanya status systemd.
6. Pantau frame index, dropped frames, CSV, dan XML.
7. Jika status berubah Unknown/degraded, kumpulkan bukti dan hentikan tindakan lanjutan.
8. Jangan melakukan restart berulang-ulang tanpa diagnosis dan persetujuan baru.
```

Urutan Kraken lebih dulu lalu Raspberry/service adalah workaround untuk lifecycle saat ini, bukan syarat arsitektur yang ideal. Sistem target seharusnya dapat masuk `WAITING_FOR_USB`, mendeteksi device yang datang terlambat, lalu memulai DAQ setelah lima device stabil.

## 20. Arah perbaikan yang direncanakan

Perbaikan robust sebaiknya dilakukan bertahap dan diuji di staging:

```text
1. Health model: WAITING_FOR_USB, STARTING, HEALTHY, DEGRADED,
   USB_UNSTABLE, RECOVERING, FAILED_NEEDS_OPERATOR.
2. Supervisor foreground untuk memantau USB, frame, sync, drop,
   freshness output, dan error rate.
3. Hotplug event sebagai pemicu cepat, periodic health check sebagai sumber kebenaran.
4. Close/reopen DAQ terkontrol, bukan callback yang mempertahankan handle rusak.
5. Cooldown, exponential backoff, dan batas percobaan recovery.
6. Pisahkan lifecycle DAQ dari UI/Data Out jika memungkinkan.
7. Gunakan systemd supervision terhadap proses foreground/cgroup yang jelas.
8. Simpan dan rotate log; jangan menghapus seluruh log saat startup.
9. Berhenti pada FAILED_NEEDS_OPERATOR dan jangan reboot Raspberry otomatis.
```

Callback/error signal hanya mendeteksi kegagalan. Recovery yang aman harus menutup handle lama, menunggu enumeration stabil, membuka ulang chain, lalu memverifikasi frame nyata.

## 21. Acceptance criteria diagnosis

Satu node dianggap sehat pada window observasi jika semua kondisi berikut terpenuhi secara berulang:

```text
- lima RTL2838 hadir dan topology stabil;
- daq_ok=true;
- daq_status terisi;
- frame_sync=true;
- sample_delay_sync=true;
- iq_sync=true;
- frame index bertambah;
- dropped frames tidak terus meningkat;
- CSV tidak kosong dan timestamp/mtime maju;
- CSV memiliki 360 angular bins saat vector tersedia;
- XML timestamp/mtime maju;
- tidak ada error RTL-SDR/USB baru yang berulang;
- proses tidak duplicate;
- service dan child process sama-sama terpantau;
- t900-ppp.service tidak disentuh oleh prosedur ini.
```

Satu kondisi `lsusb=5` saja tidak cukup untuk menyatakan KrakenSDR sehat.
