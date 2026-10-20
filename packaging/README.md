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

`VERSION` di root repository menentukan nama rilis dan tag image di file compose; ubah keduanya bersamaan (`tools/test_make_release.py` memeriksa tag compose). Tanpa `--allow-dirty`, script menolak input rilis yang belum di-commit. Modul Python yang ikut adalah import closure dari `tools/ground_console.py` dan `tools/sdr_doa_lan_agent.py`, jadi test, fixture, dan tool staging tidak ikut. Arsipnya deterministik: urutan tetap, owner root, mode tetap, dan mtime dari `SOURCE_DATE_EPOCH` atau commit terakhir.

Isi tarball console: `frontend/dist` (termasuk `receiver/`), modul runtime di `tools/`, `install.sh`, `packaging/console`, `packaging/docker` (termasuk `sdr-doa-docker`), `Dockerfile.release`, `docker-compose.yml` (dari `docker-compose.release.yml`), `docker-compose.ghcr.yml`, `.env.example`, `QUICKSTART.md`, manual PDF, lisensi BrowSDR, `wheels/`, dan `MANIFEST.sha256`. Tarball agent: modul agent, `install.sh`, `packaging/agent`, `Dockerfile.agent`, `docker-compose.yml` (dari `docker-compose.agent.yml`), dan `MANIFEST.sha256`.

## File

| File | Isi |
|---|---|
| `Dockerfile`, `docker-compose.yml` | image console dari repository (build stage Node 22, runtime Python 3.12 slim) |
| `Dockerfile.release`, `docker-compose.release.yml` | image console dari rilis yang diekstrak, tanpa Node |
| `Dockerfile.agent`, `docker-compose.agent.yml` | image agent, multi-arch, tanpa langkah `RUN` |
| `docker-compose.ghcr.yml` | console dari image GHCR (`${SDR_DOA_IMAGE_TAG:-2}`), compose yang sama dengan yang ditulis `sdr-doa-docker` |
| `packaging/console/` | `install.sh`, perintah `sdr-doa-console`, template service/desktop, `set_admin_password.py`, `requirements.txt` |
| `packaging/agent/` | `install-agent.sh`, `uninstall-agent.sh`, `run-agent.sh`, template service, `agent.env.example` |
| `packaging/docker/` | entrypoint console, healthcheck, pemeriksaan build context, dan `sdr-doa-docker` (install, update dengan healthcheck dan rollback, timer update harian; `tools/test_docker_update.py`) |
| `tools/make_release.py` | builder rilis; `--stage-console DIR`/`--stage-agent DIR` dipakai Docker dan installer dari repository |

Semua jalur menjalankan console dengan path data yang sama: `--config-path DATA/console.json --branding-path DATA/branding.json --preferences-path DATA/preferences.json --data-dir DATA/receiver --tile-cache-dir DATA/tiles --env-file DATA/.env`, dan `--bind 127.0.0.1`. Tidak ada yang memakai `--base-url`/`--mqtt-*`; nilai awal masuk lewat `SDR_DOA_SEED_*`.
