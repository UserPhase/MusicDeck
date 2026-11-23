# syntax=docker/dockerfile:1

# ==============================================================================
# Stage 1: Rust Dependency Cache & Release Binary Builder (`rust:1-bookworm`)
# ==============================================================================
FROM rust:1-bookworm AS builder
WORKDIR /build

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    pkg-config \
    libsqlite3-dev \
  && rm -rf /var/lib/apt/lists/*

# Pre-cache Cargo dependencies before copying application source code so code-only
# edits rebuild in seconds without recompiling the Tokio/Axum/SQLx dependency tree.
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src/bin \
  && printf "pub fn dummy() {}\n" > src/lib.rs \
  && printf "fn main() {}\n" > src/main.rs \
  && printf "fn main() {}\n" > src/bin/init_db.rs \
  && printf "fn main() {}\n" > src/bin/shrink_library.rs \
  && cargo build --release --locked \
  && rm -rf src

# Copy actual Rust crate source and compile production binaries (`opt-level = 3`, `lto = "thin"`).
COPY src ./src
COPY tests ./tests
RUN touch src/lib.rs src/main.rs src/bin/init_db.rs src/bin/shrink_library.rs \
  && cargo build --release --locked --bins

# ==============================================================================
# Stage 2: Minimal Production Runtime (`debian:bookworm-slim`)
# ==============================================================================
FROM debian:bookworm-slim AS runtime
WORKDIR /app

# Virtual environment & runtime paths:
# - `/opt/venv` (aliased at `/opt/spotdl`) isolates Python packages (`spotdl`, `mutagen`,
#   `yt-dlp`, `ytmusicapi`) from Debian's PEP 668 system Python.
# - `/opt/venv/bin` is prepended to `PATH` so `ProcessRunner` resolves `spotdl` and `python3`
#   directly without shell wrappers.
ENV VIRTUAL_ENV=/opt/venv
ENV SPOTDL_HOME=/opt/venv
ENV PATH="/opt/venv/bin:/usr/local/bin:${PATH}"
ENV HOME=/app/home
ENV XDG_CACHE_HOME=/app/cache/runtime
ENV MUSICDECK_EXTENSIONS_DIR=/extensions
ENV RUST_LOG=info
ENV RUST_BACKTRACE=1

COPY requirements.txt ./requirements.txt

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3-full \
    python3-venv \
    python3-pip \
    curl \
    gosu \
    ca-certificates \
    libsqlite3-0 \
  && python3 -m venv /opt/venv \
  && ln -s /opt/venv /opt/spotdl \
  && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt \
  && apt-get purge -y --auto-remove python3-pip \
  && rm -rf /var/lib/apt/lists/*

# Create dedicated non-root system user/group (`musicdeck`) and initialize directories.
RUN groupadd --system musicdeck \
  && useradd --system --gid musicdeck --home-dir /app/home musicdeck \
  && mkdir -p /app/home /app/data /app/config /app/cache/runtime /extensions \
  && chown -R musicdeck:musicdeck /app /extensions \
  && chmod 0700 /app/data /app/home /app/cache/runtime

# Put the bundled Deno on PATH so it is available even when Compose mounts an
# existing home volume over /app/home.
RUN gosu musicdeck spotdl --download-deno \
  && deno_path="$(gosu musicdeck python3 -c 'from spotdl.utils.deno import get_local_deno; print(get_local_deno())')" \
  && install -m 0755 "$deno_path" /usr/local/bin/deno \
  && gosu musicdeck deno --version \
  && gosu musicdeck python3 -c "from spotdl.utils.deno import is_deno_installed; assert is_deno_installed()" \
  && ffmpeg -version > /dev/null

# Copy compiled release binaries from the builder stage.
COPY --from=builder /build/target/release/musicdeck-server /usr/local/bin/musicdeck-server
COPY --from=builder /build/target/release/init_db /usr/local/bin/init_db
COPY --from=builder /build/target/release/shrink_library /usr/local/bin/shrink_library

COPY docker-entrypoint.sh /usr/local/bin/musicdeck-entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/musicdeck-entrypoint \
  && chmod 0755 /usr/local/bin/musicdeck-entrypoint \
  && chmod 0755 /usr/local/bin/musicdeck-server /usr/local/bin/init_db /usr/local/bin/shrink_library

EXPOSE 4534
VOLUME ["/app/data", "/app/config", "/app/cache", "/app/home"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD if [ -n "${MUSICDECK_BIND_ADDR:-}" ]; then bind="${MUSICDECK_BIND_ADDR}"; \
      else host="${MUSICDECK_HOST:-${HOST:-0.0.0.0}}"; \
        case "$host" in *:*) host="[$host]";; esac; \
        bind="$host:${MUSICDECK_PORT:-${PORT:-4534}}"; fi; \
      case "$bind" in 0.0.0.0:*) bind="127.0.0.1:${bind##*:}";; "[::]:"*) bind="[::1]:${bind##*:}";; esac; \
      gosu musicdeck curl --noproxy '*' -fsS --max-time 4 "http://$bind/api/health" > /dev/null || exit 1

ENTRYPOINT ["musicdeck-entrypoint"]
CMD ["musicdeck-server"]
