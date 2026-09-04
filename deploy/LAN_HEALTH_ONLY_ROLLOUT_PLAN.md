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
- broker staging LAN `192.168.100.173:18885` aktif dan ACL/auth sudah jelas;
- backup/metadata source dan destination dicatat;
- tidak ada proses agent lama dengan client ID yang sama.

## Urutan eksekusi yang direncanakan

1. Re-check host key dan login key-based.
2. Re-check identity `doasdr@doasdr`, hostname, dan CWD.
3. Buat direktori agent terpisah, bukan mengubah source SDR-DoA.
4. Salin hanya `sdr_doa_lan_agent.py`, `sdr_doa_mqtt_stdlib.py`, `sdr_doa_mqtt.py`, dan `sdr_doa_collector.py`.
5. Verifikasi hash dan syntax di Raspberry.
6. Jalankan manual dengan `--doa-rate 0`, tanpa `--enable-config`, dan broker staging.
7. Amati health/state/config-reported, service SDR, port 8080/8081, dan file `_share`.
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
