# syntax=docker/dockerfile:1.7

FROM ubuntu:26.04

ARG DEBIAN_FRONTEND=noninteractive
ARG NODE_MAJOR=24
ARG PNPM_VERSION=11.5.2

LABEL org.opencontainers.image.description="Sandbox base image for eve agents."
LABEL org.opencontainers.image.source="https://github.com/vercel/eve"

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

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
    xz-utils \
    zstd; \
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
  rm -rf /usr/local/include/node /usr/local/share/doc /usr/local/share/man; \
  npm install -g "pnpm@${PNPM_VERSION}"; \
  apt-get purge -y --auto-remove xz-utils; \
  rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*; \
  npm cache clean --force; \
  node --version; \
  npm --version; \
  pnpm --version; \
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
  npm_prefix="$(npm prefix -g)"; \
  mkdir -p "${npm_prefix}/bin" "${npm_prefix}/lib/node_modules" "${npm_prefix}/share"; \
  chown -R vercel-sandbox:vercel-sandbox \
    "${npm_prefix}/bin" \
    "${npm_prefix}/lib/node_modules" \
    "${npm_prefix}/share"; \
  mkdir -p /workspace; \
  chown vercel-sandbox:vercel-sandbox /workspace; \
  printf 'vercel-sandbox ALL=(ALL) NOPASSWD:ALL\n' >/etc/sudoers.d/vercel-sandbox; \
  chmod 0440 /etc/sudoers.d/vercel-sandbox

WORKDIR /workspace
