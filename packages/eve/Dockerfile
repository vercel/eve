# syntax=docker/dockerfile:1.7

# eve pins the image by a hash of this file (scripts/sandbox-image-tag.mjs),
# and a published tag is never rebuilt, so any change here becomes a new image.
# Base and Node are pinned so a change is reviewable; apt packages resolve when
# the tag is first built. After editing, run `pnpm sandbox-image:tag --write`.
FROM ubuntu:26.04@sha256:c098726dd9b9733f3e885f8de0ef375206a311b0a317eadc40d347b1115fb944

ARG DEBIAN_FRONTEND=noninteractive
ARG NODE_VERSION=24.22.1
ARG NODE_SHA256_X64=6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6
ARG NODE_SHA256_ARM64=dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e

LABEL org.opencontainers.image.description="Sandbox base image for eve agents."
LABEL org.opencontainers.image.source="https://github.com/vercel/eve"

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Only tools eve or most agents need belong here: every package adds to the
# image each sandbox pulls. Agents add others in `prepare`, for example
# `npm install -g pnpm` or `sudo apt-get install -y python3-venv`. Ubuntu's
# system pip refuses installs (PEP 668), so pip comes from a venv instead.
RUN set -eux; \
  printf 'APT::Sandbox::User "root";\n' >/etc/apt/apt.conf.d/99eve-sandbox-user; \
  apt-get update; \
  apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    dnsutils \
    gpgv \
    git \
    jq \
    python-is-python3 \
    python3 \
    ripgrep \
    sudo \
    unzip \
    zstd; \
  # Build-only tools, purged at the end of this layer.
  apt-get install -y --no-install-recommends binutils xz-utils; \
  arch="$(dpkg --print-architecture)"; \
  case "${arch}" in \
    amd64) node_arch="x64"; node_sha256="${NODE_SHA256_X64}" ;; \
    arm64) node_arch="arm64"; node_sha256="${NODE_SHA256_ARM64}" ;; \
    *) echo "Unsupported architecture: ${arch}" >&2; exit 1 ;; \
  esac; \
  node_file="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
  curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${node_file}"; \
  echo "${node_sha256}  ${node_file}" | sha256sum -c -; \
  tar -xJf "${node_file}" -C /usr/local --strip-components=1 --no-same-owner; \
  rm "${node_file}"; \
  # Node's release binary keeps about 20 MB of native symbols, used only to name
  # native frames in crash reports and profiles.
  strip --strip-unneeded /usr/local/bin/node; \
  rm -rf /usr/local/include/node /usr/local/share/doc /usr/local/share/man \
    /usr/local/lib/node_modules/npm/docs /usr/local/lib/node_modules/npm/man; \
  apt-get purge -y --auto-remove binutils xz-utils; \
  rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*; \
  node --version; \
  npm --version; \
  python --version; \
  python3 --version; \
  dig -v; \
  gpgv --version | head -1; \
  git --version; \
  jq --version; \
  rg --version | head -1; \
  sudo -V | head -1; \
  unzip -v | head -1; \
  zstd --version

RUN set -eux; \
  if ! id -u vercel-sandbox >/dev/null 2>&1; then \
    useradd --create-home --shell /bin/bash vercel-sandbox; \
  fi; \
  # Ubuntu's skel .bash_logout runs `clear_console` when a login shell exits at
  # SHLVL=1. Backends run every command through `bash -lc` with no TTY, so it
  # prints "TERM environment variable not set." and, under `set -e`, turns a
  # successful `exit 0` into exit 1.
  rm -f /home/vercel-sandbox/.bash_logout; \
  # Keep Node root-owned: recursively changing its ownership copies it into
  # another image layer. A small user-owned prefix retains global installs.
  install -d --owner=vercel-sandbox --group=vercel-sandbox \
    /home/vercel-sandbox/.local \
    /home/vercel-sandbox/.local/bin; \
  mkdir -p /workspace; \
  chown vercel-sandbox:vercel-sandbox /workspace; \
  # !fqdn: sandbox hostnames are not resolvable, so sudo would otherwise warn on stderr.
  printf '%s\n' \
    'Defaults !fqdn' \
    'vercel-sandbox ALL=(ALL) NOPASSWD:ALL' \
    >/etc/sudoers.d/vercel-sandbox; \
  chmod 0440 /etc/sudoers.d/vercel-sandbox; \
  visudo -cf /etc/sudoers.d/vercel-sandbox

ENV NPM_CONFIG_PREFIX=/home/vercel-sandbox/.local
ENV PATH=/home/vercel-sandbox/.local/bin:${PATH}

USER vercel-sandbox
WORKDIR /workspace
