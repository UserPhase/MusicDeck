# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS production
ENV NODE_ENV=production
WORKDIR /app

# Runtime dependencies for the acquisition/downloader pipeline.
#
# The image ships everything MusicDeck's downloaders need so operators never
# install Python, FFmpeg, or spotDL on the Docker host:
#   - python3 + pip: spotDL runtime
#   - ffmpeg: audio conversion/tagging performed by spotDL
#   - ca-certificates: TLS for provider/API/download requests
#
# spotDL is installed into a dedicated virtualenv at /opt/spotdl so it cannot
# conflict with Debian's system Python packages (PEP 668 externally-managed
# environment), and that venv's bin directory is placed on PATH so the
# adapter's bare "spotdl"/"ffmpeg" spawns resolve without extra config.
ENV SPOTDL_HOME=/opt/spotdl
ENV PATH="${SPOTDL_HOME}/bin:${PATH}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    python3-pip \
    ffmpeg \
    gosu \
    ca-certificates \
  && python3 -m venv "${SPOTDL_HOME}" \
  && "${SPOTDL_HOME}/bin/pip" install --no-cache-dir --upgrade pip \
  && "${SPOTDL_HOME}/bin/pip" install --no-cache-dir spotdl \
  && apt-get purge -y --auto-remove python3-pip \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --system musicdeck \
  && useradd --system --gid musicdeck --home-dir /app musicdeck \
  && mkdir -p /app/data /app/config /app/cache \
  && chown -R musicdeck:musicdeck /app

COPY package*.json ./
COPY --from=deps /app/node_modules ./node_modules
RUN npm prune --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/musicdeck-entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/musicdeck-entrypoint \
  && chmod 0755 /usr/local/bin/musicdeck-entrypoint

EXPOSE 4534
VOLUME ["/app/data", "/app/config", "/app/cache"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4534/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["musicdeck-entrypoint"]
CMD ["node", "dist/main.js"]
