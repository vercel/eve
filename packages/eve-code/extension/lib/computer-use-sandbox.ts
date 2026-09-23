import type { SandboxSession } from "eve/sandbox";

import { commandFailureDetail } from "./command-failure.ts";
import { COMPUTER_USE_DRIVER_SOURCES } from "./computer-use-driver-source.ts";
import {
  computerUseDisplayCommand,
  computerUseDriverStartCommand,
  computerUsePaths,
} from "./computer-use.ts";
import { shellQuote } from "./shell.ts";

type ComputerUseSandbox = Pick<SandboxSession, "resolvePath" | "run" | "writeTextFile">;

const DRIVER_VERSION = "0.12.5";
const DESKTOP_INSTALL_VERSION = "2026-09-17.1";

/** Include this in the consumer sandbox revalidation key so cached templates rebuild when computer use changes. */
export const COMPUTER_USE_REVALIDATION_KEY = `computer-use:${DRIVER_VERSION}:${DESKTOP_INSTALL_VERSION}`;

/** Install the desktop packages and embedded driver required by computer use. */
export async function installComputerUse(sandbox: ComputerUseSandbox): Promise<void> {
  const paths = computerUsePaths(sandbox);
  const installScript = sandbox.resolvePath(".eve-code/install-computer-use.sh");
  await sandbox.run({ command: `mkdir -p ${shellQuote(paths.driverRoot)}` });
  await Promise.all([
    ...Object.entries(COMPUTER_USE_DRIVER_SOURCES).map(([name, content]) =>
      sandbox.writeTextFile({ path: `${paths.driverRoot}/${name}`, content }),
    ),
    sandbox.writeTextFile({ path: installScript, content: computerUseInstallScript(sandbox) }),
  ]);

  const install = await sandbox.run({
    command: [
      "set -e",
      'if [ "$(id -u)" = 0 ]; then',
      `  bash ${shellQuote(installScript)}`,
      "elif command -v sudo >/dev/null 2>&1; then",
      `  sudo -n bash ${shellQuote(installScript)}`,
      "else",
      "  echo 'computer-use requires an apt-based sandbox image with root or passwordless sudo' >&2",
      "  exit 1",
      "fi",
    ].join("\n"),
  });
  if (install.exitCode !== 0) {
    throw new Error(
      `computer-use installation failed (exit ${install.exitCode}): ${commandFailureDetail(install)}`,
    );
  }
}

/** Start the managed display and driver for one consumer sandbox session. */
export async function startComputerUse(
  sandbox: Pick<SandboxSession, "resolvePath" | "run">,
): Promise<void> {
  const env = { TERM: "xterm-256color" };
  const display = await sandbox.run({ command: computerUseDisplayCommand(sandbox), env });
  if (display.exitCode !== 0) {
    throw new Error(
      `computer-use display startup failed (exit ${display.exitCode}): ${commandFailureDetail(display)}`,
    );
  }

  const driver = await sandbox.run({ command: computerUseDriverStartCommand(sandbox), env });
  if (driver.exitCode !== 0) {
    throw new Error(
      `computer-use driver startup failed (exit ${driver.exitCode}): ${commandFailureDetail(driver)}`,
    );
  }
}

function computerUseInstallScript(sandbox: Pick<SandboxSession, "resolvePath">): string {
  const paths = computerUsePaths(sandbox);
  return `#!/usr/bin/env bash
set -euo pipefail

command -v apt-get >/dev/null || {
  echo "computer-use requires an apt-based sandbox image" >&2
  exit 1
}

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl
apt-get clean

install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://packages.mozilla.org/apt/repo-signing-key.gpg \\
  -o /etc/apt/keyrings/packages.mozilla.org.asc
printf '%s\\n' \\
  'Types: deb' \\
  'URIs: https://packages.mozilla.org/apt' \\
  'Suites: mozilla' \\
  'Components: main' \\
  'Architectures: amd64 arm64' \\
  'Signed-By: /etc/apt/keyrings/packages.mozilla.org.asc' \\
  > /etc/apt/sources.list.d/mozilla.sources
printf '%s\\n' \\
  'Package: *' \\
  'Pin: origin packages.mozilla.org' \\
  'Pin-Priority: 1000' \\
  > /etc/apt/preferences.d/mozilla

apt-get update
FIREFOX_ESR_VERSION="$(apt-cache madison firefox-esr | awk '$3 ~ /^140\\./ { print $3; exit }')"
if [[ -z "\${FIREFOX_ESR_VERSION}" ]]; then
  echo "Mozilla's repository does not offer the Firefox ESR 140 line" >&2
  exit 1
fi

DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
  at-spi2-core \\
  ca-certificates \\
  curl \\
  dbus-x11 \\
  ffmpeg \\
  fontconfig \\
  gnome-themes-extra \\
  gtk2-engines-murrine \\
  libxi6 \\
  libxkbcommon0 \\
  sassc \\
  x11-utils \\
  xclip \\
  xdotool \\
  xfce4 \\
  xterm \\
  xvfb \\
  xz-utils
apt-get clean
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
  "firefox-esr=\${FIREFOX_ESR_VERSION}"
apt-get clean

GEIST_MONO_VERSION=3.4.0
GEIST_MONO_SHA256=43ef3d73cadddea5be746e20c9f27fbaa59ceb106b8b26f7245ba2de2e46b1f6
COLLOID_COMMIT=fd805dbeeacb12f7971b98408c415c3f472e5aef
COLLOID_SHA256=0f19442b9bd1\
e08e93a223518ce70cd2e47e05ed530fd3345c7e79ea75ea5f83
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "\${TEMP_DIR}"' EXIT

curl -fsSL \\
  "https://github.com/ryanoasis/nerd-fonts/releases/download/v\${GEIST_MONO_VERSION}/GeistMono.tar.xz" \\
  -o "\${TEMP_DIR}/geist-mono.tar.xz"
echo "\${GEIST_MONO_SHA256}  \${TEMP_DIR}/geist-mono.tar.xz" | sha256sum --check --status
install -d -m 0755 /usr/local/share/fonts/geist-mono
tar -xJf "\${TEMP_DIR}/geist-mono.tar.xz" -C /usr/local/share/fonts/geist-mono \\
  GeistMonoNerdFont-Regular.otf GeistMonoNerdFont-Bold.otf
fc-cache -f

curl -fsSL \\
  "https://github.com/vinceliuice/Colloid-gtk-theme/archive/\${COLLOID_COMMIT}.tar.gz" \\
  -o "\${TEMP_DIR}/colloid.tar.gz"
echo "\${COLLOID_SHA256}  \${TEMP_DIR}/colloid.tar.gz" | sha256sum --check --status
mkdir -p "\${TEMP_DIR}/colloid"
tar -xzf "\${TEMP_DIR}/colloid.tar.gz" -C "\${TEMP_DIR}/colloid" --strip-components=1
(
  cd "\${TEMP_DIR}/colloid"
  ./install.sh -d /usr/share/themes -n Colloid -t default -c dark --tweaks black
  SRC_DIR="$(pwd)/src"
  source ./assets.sh
  blackness=true
  colorscheme=false
  normal=false
  make_assets /usr/share/themes Colloid '' -Dark '' '' ''
  test -f /usr/share/themes/Colloid-Dark/xfwm4/close-active.svg
  test -f /usr/share/themes/Colloid-Dark/xfwm4/hide-active.svg
  test -f /usr/share/themes/Colloid-Dark/xfwm4/maximize-active.svg
)

install -d -m 0755 ${shellQuote(paths.managedBrowserRoot)}
cat >${shellQuote(`${paths.managedBrowserRoot}/xdg-open`)} <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
url="\${1:-}"
[[ "\${url}" =~ ^https?:// ]] || { echo "managed xdg-open accepts HTTP(S) URLs only" >&2; exit 2; }
export DISPLAY=:99
window="$(xdotool search --onlyvisible --class firefox-esr | head -n 1)"
[[ -n "\${window}" ]] || { echo "managed Firefox is not running" >&2; exit 1; }
xdotool windowactivate --sync "\${window}"
xdotool key --clearmodifiers ctrl+l
xdotool type --clearmodifiers --delay 1 "\${url}"
xdotool key --clearmodifiers Return
EOF
chmod 0755 ${shellQuote(`${paths.managedBrowserRoot}/xdg-open`)}
ln -sfn xdg-open ${shellQuote(`${paths.managedBrowserRoot}/x-www-browser`)}
ln -sfn xdg-open ${shellQuote(`${paths.managedBrowserRoot}/sensible-browser`)}

npm install --prefix ${shellQuote(paths.driverRoot)} --ignore-scripts --no-audit --no-fund
apt-get clean
rm -rf /var/lib/apt/lists/*
`;
}
