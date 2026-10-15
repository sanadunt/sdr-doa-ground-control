# SDR-DoA Ground Console image, built from a repository checkout. Linux hosts.
#
#   git submodule update --init --recursive   # vendor/BrowSDR, for the Receiver
#   docker compose up -d --build              # see docker-compose.yml
#
# Build from a regular clone: the Receiver builder checks the pinned BrowSDR
# commit through the submodule's git directory (.git/modules/vendor/BrowSDR,
# which .dockerignore keeps). To build without Node.js, unpack a release
# tarball and use its Dockerfile.release instead.
#
# Run it only with the host network (network_mode: host): the console binds
# 127.0.0.1 and refuses any other address.

ARG NODE_IMAGE=node:22-bookworm
ARG PYTHON_IMAGE=python:3.12-slim-bookworm

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json frontend/
RUN cd frontend && npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN sh packaging/docker/check-build-context.sh
# build:all = tsc + vite build, then tools/build_browsdr_receiver.py (dist/receiver).
RUN cd frontend && npm run build:all
RUN python3 tools/make_release.py --stage-console /stage

FROM ${PYTHON_IMAGE}
LABEL org.opencontainers.image.title="SDR-DoA Ground Console" \
      org.opencontainers.image.description="Loopback-only SDR-DoA Ground Console; run with the host network" \
      org.opencontainers.image.source="https://github.com/sanadunt/sdr-doa-ground-control"
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/venv/bin:$PATH \
    SDR_DOA_PORT=8787 \
    SDR_DOA_DATA_DIR=/data \
    SDR_DOA_ENV_FILE=/data/.env
COPY packaging/console/requirements.txt /tmp/requirements.txt
RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir --disable-pip-version-check -r /tmp/requirements.txt \
 && rm /tmp/requirements.txt \
 && useradd --system --uid 10001 --user-group --home-dir /data --no-create-home --shell /usr/sbin/nologin sdr-doa \
 && mkdir -p /data/receiver \
 && chown -R 10001:10001 /data \
 && chmod 0750 /data \
 && ln -s /opt/sdr-doa-ground-console/packaging/console/set_admin_password.py /usr/local/bin/sdr-doa-set-admin-password
COPY --from=build /stage/ /opt/sdr-doa-ground-console/
USER 10001:10001
WORKDIR /data
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=6s --start-period=20s --retries=3 \
  CMD ["python", "/opt/sdr-doa-ground-console/packaging/docker/healthcheck.py"]
ENTRYPOINT ["/opt/sdr-doa-ground-console/packaging/docker/console-entrypoint.sh"]
