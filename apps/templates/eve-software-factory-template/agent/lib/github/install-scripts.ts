/** Package-manager defaults, not a security boundary in a shell-capable station. */
export const installScriptsBlocked = (): boolean =>
  process.env.FACTORY_ALLOW_INSTALL_SCRIPTS?.trim() !== "1";

// pnpm 11 uses config.yaml rather than npm's user config.
const PNPM_CONFIG_DIR =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: expanded by the sandbox shell
  '"${XDG_CONFIG_HOME:-$HOME/.config}/pnpm"';

const SETTINGS = [
  { file: '"$HOME/.npmrc"', line: "ignore-scripts=true" },
  { file: `${PNPM_CONFIG_DIR}/config.yaml`, line: "ignoreScripts: true" },
  { file: '"$HOME/.yarnrc"', line: "ignore-scripts true" },
  { file: '"$HOME/.yarnrc.yml"', line: "enableScripts: false" },
];

/** Idempotent across initialization retries; preserve unrelated user settings. */
export const INSTALL_SCRIPTS_OFF_COMMAND = [
  `mkdir -p ${PNPM_CONFIG_DIR}`,
  ...SETTINGS.map(
    ({ file, line }) =>
      `{ grep -qxF -- '${line}' ${file} 2>/dev/null || printf '%s\\n' '${line}' >> ${file}; }`
  ),
].join(" && ");
