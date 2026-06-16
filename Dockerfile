# syntax=docker/dockerfile:1.7

FROM ubuntu:26.04

ARG DEBIAN_FRONTEND=noninteractive
ARG NODE_MAJOR=24
ARG PNPM_VERSION=11.5.2

LABEL org.opencontainers.image.description="Sandbox base image for Eve agents."

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8
ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=/usr/local/share/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    cmake \
    curl \
    default-mysql-client \
    dnsutils \
    fd-find \
    ffmpeg \
    file \
    git \
    git-lfs \
    gnupg \
    imagemagick \
    iproute2 \
    iputils-ping \
    jq \
    less \
    locales \
    make \
    nano \
    netcat-openbsd \
    openssh-client \
    pkg-config \
    poppler-utils \
    postgresql-client \
    procps \
    python-is-python3 \
    python3 \
    python3-dev \
    python3-pip \
    python3-venv \
    redis-tools \
    ripgrep \
    rsync \
    sqlite3 \
    sudo \
    tar \
    time \
    tree \
    tzdata \
    unzip \
    vim-tiny \
    wget \
    xz-utils \
    zip \
    zstd \
  && git lfs install --system \
  && locale-gen en_US.UTF-8 \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "${arch}" in \
    amd64) node_arch="x64" ;; \
    arm64) node_arch="arm64" ;; \
    *) echo "Unsupported architecture: ${arch}" >&2; exit 1 ;; \
  esac; \
  base_url="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"; \
  shasums="$(mktemp)"; \
  curl -fsSL "${base_url}/SHASUMS256.txt" -o "${shasums}"; \
  node_file="$(awk -v node_arch="${node_arch}" '$2 ~ "^node-v.*-linux-" node_arch "\\.tar\\.xz$" { print $2; exit }' "${shasums}")"; \
  test -n "${node_file}"; \
  curl -fsSLO "${base_url}/${node_file}"; \
  grep " ${node_file}$" "${shasums}" | sha256sum -c -; \
  tar -xJf "${node_file}" -C /usr/local --strip-components=1; \
  rm "${node_file}" "${shasums}"; \
  mkdir -p "${PNPM_HOME}"; \
  npm install -g "pnpm@${PNPM_VERSION}"; \
  npm cache clean --force; \
  node --version; \
  npm --version; \
  pnpm --version

RUN set -eux; \
  if ! id -u vercel-sandbox >/dev/null 2>&1; then \
    useradd --create-home --shell /bin/bash vercel-sandbox; \
  fi; \
  mkdir -p /workspace; \
  chown vercel-sandbox:vercel-sandbox /workspace; \
  printf 'vercel-sandbox ALL=(ALL) NOPASSWD:ALL\n' >/etc/sudoers.d/vercel-sandbox; \
  chmod 0440 /etc/sudoers.d/vercel-sandbox

WORKDIR /workspace
