# Rencana Rollout LAN Health-only Agent

## Status

```text
Status : PLAN ONLY / NOT EXECUTED
Target : Raspberry doasdr melalui LAN
PPP    : tidak termasuk
DoA    : disabled (--doa-rate 0)
Config : disabled (tanpa --enable-config)
```

## Prasyarat sebelum eksekusi

- independent reviewer mengembalikan verdict terminal;
- user menyetujui remote mutation terpisah;
- broker staging LAN `192.168.100.173:18885` aktif dengan `tools/mqtt_lan_stage.conf` (mosquitto 2.0 atau lebih baru): TLS, password file, dan ACL dari `deploy/mosquitto-sdr-doa-lan.acl.example`;
- sertifikat broker memuat `IP:192.168.100.173` di subjectAltName, dan file CA-nya sudah disalin ke Raspberry (`/etc/sdr-doa-edge/sdr-doa-lan-ca.crt`);
- password akun agent hanya ada di `/etc/sdr-doa-edge/agent.env` sebagai `SDR_DOA_MQTT_PASSWORD=...` (owner root, group doasdr, mode 0640), tidak di command line atau repository;
- backup/metadata source dan destination dicatat;
- tidak ada proses agent lama dengan client ID yang sama.

## Urutan eksekusi yang direncanakan

1. Re-check host key dan login key-based.
2. Re-check identity `doasdr@doasdr`, hostname, dan CWD.
3. Buat direktori agent terpisah, bukan mengubah source SDR-DoA.
4. Salin hanya `sdr_doa_lan_agent.py`, `sdr_doa_mqtt_stdlib.py`, `sdr_doa_mqtt.py`, dan `sdr_doa_collector.py`.
5. Verifikasi hash dan syntax di Raspberry.
6. Jalankan manual dengan `--doa-rate 0`, tanpa `--enable-config`, dan broker staging. Agent menolak broker non-loopback tanpa TLS dan username, jadi sertakan opsi berikut:

   ```sh
   set -a; . /etc/sdr-doa-edge/agent.env; set +a
   python3 sdr_doa_lan_agent.py --base-url http://127.0.0.1:8081 --clock-source local \
     --mqtt-host 192.168.100.173 --mqtt-port 18885 \
     --mqtt-cafile /etc/sdr-doa-edge/sdr-doa-lan-ca.crt --mqtt-username sdr-doa-agent \
     --publish --doa-rate 0 --once
   ```

   `--once` mencetak `published_kinds` dan `last_error`, dan exit code 1 bila tidak ada pesan yang sampai ke broker. Setelah itu jalankan tanpa `--once` dengan `--duration` terbatas.
7. Amati health/state/config-reported dan topic `availability`, service SDR, port 8080/8081, dan file `_share`. `health.state` bernilai `ONLINE`, `STALE`, `DEGRADED`, atau `UNAVAILABLE` dengan kode di `health.reasons`; `doa_valid` tetap `false` karena DoA dinonaktifkan. Agent membaca Data Out sesuai jadwal health (sekitar 2 GET/s dengan `--health-interval 1` dan tanpa authority), dan satu koleksi dibatasi `--collect-budget`.
8. Hentikan proses manual dan pastikan proses/file SDR-DoA tidak berubah.
9. Hanya setelah hasil health-only lulus, pertimbangkan unit systemd terpisah.

## Rollback

- hentikan proses agent berdasarkan PID yang dicatat;
- jangan menjalankan `sdr_doa_stop.sh` atau restart service SDR;
- hapus hanya direktori agent baru jika user menyetujui cleanup;
- verifikasi port/proses/output SDR-DoA tetap seperti sebelum rollout;
- broker staging dapat dihentikan terpisah di Ground.

## Larangan pada rollout awal

```text
--enable-config
--authority csv/xml
--doa-rate > 0
POST /settings
mengubah _share/settings.json
restart sdr-doa.service
mengubah PPP/T900
menggunakan broker production tanpa auth/ACL/TLS
```
