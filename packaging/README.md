# Packaging: rilis, installer, dan Docker

Panduan pemakaian ada di [`console/README.md`](console/README.md) (Ground Console, Linux) dan [`agent/README.md`](agent/README.md) (agent di RDF-SDR). Halaman ini untuk yang membuat rilis.

## Membuat rilis

```sh
git submodule update --init --recursive
python3 tools/make_release.py            # npm ci + npm run build:all, lalu tarball
python3 tools/make_release.py --skip-build --with-wheels   # pakai frontend/dist yang ada, sertakan wheels
```

Hasil di `dist/release/` (diabaikan git):

```text
sdr-doa-ground-console-<VERSION>-linux.tar.gz
sdr-doa-rdf-sdr-agent-<VERSION>.tar.gz
sdr-doa-docker                 script host Docker (image GHCR), aset tersendiri
SHA256SUMS                     sha256sum -c SHA256SUMS
```

`VERSION` di root repository menentukan nama rilis dan tag image di file compose; ubah keduanya bersamaan (`tools/test_make_release.py` memeriksa tag compose). Daftar lengkap file yang ikut berubah, termasuk untuk versi mayor baru, ada di `QUICKSTART.md`, "Rilis di GitHub", langkah 1. Tanpa `--allow-dirty`, script menolak input rilis yang belum di-commit. Modul Python yang ikut adalah import closure dari `tools/ground_console.py` dan `tools/sdr_doa_lan_agent.py`, jadi test, fixture, dan tool staging tidak ikut. Arsipnya deterministik: urutan tetap, owner root, mode tetap, dan mtime dari `SOURCE_DATE_EPOCH` atau commit terakhir.

Isi tarball console: `frontend/dist` (termasuk `receiver/`), modul runtime di `tools/`, `install.sh`, `packaging/console`, `packaging/docker` (termasuk `sdr-doa-docker`), `Dockerfile.release`, `docker-compose.yml` (dari `docker-compose.release.yml`), `docker-compose.ghcr.yml`, `.env.example`, `QUICKSTART.md`, manual PDF, lisensi BrowSDR, `wheels/`, dan `MANIFEST.sha256`. Tarball agent: modul agent, `install.sh`, `packaging/agent`, `Dockerfile.agent`, `docker-compose.yml` (dari `docker-compose.agent.yml`), dan `MANIFEST.sha256`. `packaging/receiver-engine/` (kit uji engine Receiver, fase 0 issue #15) tidak ikut tarball, image, atau installer mana pun; lihat [`receiver-engine/README.md`](receiver-engine/README.md).

## Rilis di GitHub dan image GHCR

Rilis untuk operator dibuat GitHub Actions dari `main`, bukan dari build lokal: naikkan `VERSION` bersama tag `image:` di ketiga file compose dan `sdr-doa-agent:<V>` di `Dockerfile.agent` (versi mayor baru: juga `DEFAULT_CHANNEL` di `docker/sdr-doa-docker` dan `${SDR_DOA_IMAGE_TAG:-N}` di `docker-compose.ghcr.yml`), merge ke `main`, lalu push tag `v<VERSION>` (`git tag v2.0.1 && git push origin v2.0.1`) atau jalankan **Actions > Release > Run workflow** di `main` (tag dibuat bila belum ada). `.github/workflows/release.yml` menjalankan `ci.yml`, lalu `make_release.py --with-wheels`, dan `tools/release_check.py` memeriksa tag (harus `v<VERSION>` dari commit di `origin/main`) serta aset (tepat empat file di atas, `SHA256SUMS` mencakup ketiganya, dan `sdr-doa-docker` di tarball sama dengan asetnya). Setelah itu:

- job `release` menerbitkan rilis dengan keempat aset (prerelease bila versi memuat `-`; rilis stabil yang bukan versi tertinggi diberi `--latest=false`; menjalankan ulang rilis yang sama mengganti asetnya, dan tag yang sudah dibuat percobaan pertama di commit yang sama diterima);
- job `images` berjalan setelah `release`, mengekstrak kedua tarball, memeriksa `SHA256SUMS` dan `MANIFEST.sha256`, lalu mem-push `ghcr.io/sanadunt/sdr-doa-ground-console` (`Dockerfile.release`, linux/amd64 dan arm64) dan `ghcr.io/sanadunt/sdr-doa-rdf-sdr-agent` (`Dockerfile.agent`, linux/amd64, arm64 dan arm/v7) dengan tag `<V>` serta label OCI `version`, `revision` dan `source`. Jadi isi image sama dengan isi tarball. Image `<V>` yang sudah ada dari commit yang sama dipakai lagi tanpa build (input `force_images` memaksa build). Terakhir `release_check.py channels` menghitung dari tag rilis saat itu tag kanal `<MAYOR>.<MINOR>`, `<MAYOR>` dan `latest` yang boleh diarahkan ke `<V>` (hanya bila tidak ada rilis stabil lebih tinggi yang dicakupnya; prerelease tidak mendapat satu pun), dan `docker buildx imagetools create` mengarahkannya tanpa mengubah digest. Workflow berjalan dalam satu concurrency group `release`, jadi dua rilis tidak pernah tumpang tindih. QEMU, BuildKit dan base image `python:3.12-slim-bookworm` di-pin ke digest; naikkan digest `PYTHON_IMAGE` setiap rilis.

GHCR bisa membuat package baru sebagai private. Setelah rilis pertama, bila job `images` memberi peringatan tentang pull tanpa login, ubah kedua package ke Public sekali (GitHub > Packages > package > Package settings > Change visibility). Tanpa itu `sdr-doa-docker` di komputer lain tidak bisa mem-pull.

Update otomatis memasang apa pun yang diterbitkan repository ini di setiap host dalam sehari, jadi setiap orang dengan akses write, dan setiap token dengan `contents:write` atau `packages:write`, bisa menjangkau semua host. Pengaturan sekali yang disarankan: akses write hanya untuk maintainer tepercaya dengan 2FA; branch ruleset pada `main` yang mewajibkan pull request yang di-review; tag ruleset pada `refs/tags/v*` yang membatasi create, update dan delete untuk pemilik (`GITHUB_TOKEN` bukan bypass actor, jadi rilis lalu dibuat dengan push tag sendiri, bukan dengan Run workflow); di **Package settings > Manage Actions access** kedua package hanya repository ini, tanpa user lain. Penandatanganan image atau aset (cosign keyless atau `attest-build-provenance`, diverifikasi `sdr-doa-docker`) adalah langkah terpisah untuk nanti.

Update di komputer operator tanpa login GitHub:

- Docker: `packaging/docker/sdr-doa-docker` (aset rilis) mem-pull tag kanal (bawaan versi mayor, `2`), menunggu healthcheck, dan mengembalikan image sebelumnya bila gagal; image yang lebih lama dari yang jalan dilewati update otomatis. `auto-update on` memasang satu timer harian per host (root, untuk direktori milik root) atau mencetak baris crontab (user lain). Lihat `QUICKSTART.md`, "Docker dari image GHCR".
- Native: `sdr-doa-console update` dan `auto-update on` (`packaging/console/update_release.py`) mengambil rilis terbaru dengan versi mayor yang sama dari API GitHub, memeriksa SHA-256 dan `MANIFEST.sha256`, menjalankan `install.sh` rilis itu, dan mengembalikan program lama bila `/api/health` tidak melaporkan versi baru. Lihat `console/README.md`.
- Keduanya menunda update otomatis selama `/api/health` melaporkan `receiver_busy` (Receiver merekam atau mengarsipkan pindai), paling lama 7 hari.

## File

| File | Isi |
|---|---|
| `Dockerfile`, `docker-compose.yml` | image console dari repository (build stage Node 22, runtime Python 3.12 slim) |
| `Dockerfile.release`, `docker-compose.release.yml` | image console dari rilis yang diekstrak, tanpa Node |
| `Dockerfile.agent`, `docker-compose.agent.yml` | image agent, multi-arch, tanpa langkah `RUN` |
| `docker-compose.ghcr.yml` | console dari image GHCR (`${SDR_DOA_IMAGE_TAG:-2}`), compose yang sama dengan yang ditulis `sdr-doa-docker` |
| `packaging/console/` | `install.sh`, perintah `sdr-doa-console`, template service/desktop, `set_admin_password.py`, `update_release.py` (updater `sdr-doa-console update`), `requirements.txt` |
| `packaging/agent/` | `install-agent.sh`, `uninstall-agent.sh`, `run-agent.sh`, template service, `agent.env.example` |
| `packaging/docker/` | entrypoint console, healthcheck, pemeriksaan build context, dan `sdr-doa-docker` (install, update dengan healthcheck dan rollback, timer update harian; `tools/test_docker_update.py`) |
| `tools/make_release.py` | builder rilis; `--stage-console DIR`/`--stage-agent DIR` dipakai Docker dan installer dari repository |
| `.github/workflows/ci.yml`, `release.yml` | CI (pull request dan push ke `main`) dan rilis (tag `v*` atau Run workflow di `main`) |
| `tools/release_check.py` | aturan tag, aset rilis, serta nama, tag dan label image yang dipakai `release.yml` |

Semua jalur menjalankan console dengan path data yang sama: `--config-path DATA/console.json --branding-path DATA/branding.json --preferences-path DATA/preferences.json --data-dir DATA/receiver --tile-cache-dir DATA/tiles --env-file DATA/.env`, dan `--bind 127.0.0.1`. Tidak ada yang memakai `--base-url`/`--mqtt-*`; nilai awal masuk lewat `SDR_DOA_SEED_*`.
