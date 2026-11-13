/**
 * Defaults for every profile, so the first page the agent opens isn't covered by Firefox's terms
 * of use, welcome, or default-browser prompts.
 */
const FIRST_RUN_PREFS = [
  'pref("termsofuse.bypassNotification", true);',
  'pref("browser.aboutwelcome.enabled", false);',
  'pref("browser.shell.checkDefaultBrowser", false);',
  'pref("browser.startup.homepage_override.mstone", "ignore");',
  'pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);',
  'pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
].join("\n");

/**
 * Ubuntu's `firefox` package only installs the snap, which a sandbox can't run, so Firefox ESR
 * comes from Mozilla's own apt repository instead.
 */
const INSTALL_FIREFOX = String.raw`set -euo pipefail
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://packages.mozilla.org/apt/repo-signing-key.gpg -o /etc/apt/keyrings/packages.mozilla.org.asc
printf '%s\n' 'Types: deb' 'URIs: https://packages.mozilla.org/apt' 'Suites: mozilla' 'Components: main' \
  'Signed-By: /etc/apt/keyrings/packages.mozilla.org.asc' > /etc/apt/sources.list.d/mozilla.sources
printf '%s\n' 'Package: *' 'Pin: origin packages.mozilla.org' 'Pin-Priority: 1000' > /etc/apt/preferences.d/mozilla
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends firefox-esr
apt-get clean
cat > /usr/lib/firefox-esr/defaults/pref/eve-desktop.js <<'PREFS'
${FIRST_RUN_PREFS}
PREFS`;

const SCRIPT_PATH = "/tmp/install-firefox.sh";

interface PrepareSandbox {
  writeTextFile(options: { path: string; content: string }): PromiseLike<unknown>;
  run(options: { command: string }): PromiseLike<{ exitCode: number; stderr: string }>;
}

export async function installFirefox(sandbox: PrepareSandbox): Promise<void> {
  await sandbox.writeTextFile({ path: SCRIPT_PATH, content: INSTALL_FIREFOX });
  const result = await sandbox.run({ command: `sudo -n bash ${SCRIPT_PATH}` });
  if (result.exitCode !== 0)
    throw new Error(`Installing Firefox ESR failed: ${result.stderr.slice(-1000)}`);
}
