import pc from "#compiled/picocolors/index.js";

import { resolveInstalledPackageInfo } from "#internal/application/package.js";

export const EVE_WORDMARK = "eve";

export function eveCliBanner(): string {
  const { version } = resolveInstalledPackageInfo();
  return `${pc.bgBlack(pc.white(`☰${EVE_WORDMARK}`))} ${pc.dim(`v${version}`)}`;
}

export function eveVersionTag(): string {
  const { version } = resolveInstalledPackageInfo();
  return `☰${EVE_WORDMARK} v${version}`;
}
