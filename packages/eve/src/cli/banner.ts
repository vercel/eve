import pc from "picocolors";

import { resolveInstalledPackageInfo } from "#internal/application/package.js";

export const EVE_WORDMARK = "eve";

/**
 * The boot banner shared by every CLI command that announces itself: the eve
 * badge plus the installed version. Printed only by the CLI program's
 * pre-action hook so commands never compose their own variant.
 */
export function eveCliBanner(): string {
  const { version } = resolveInstalledPackageInfo();
  return `${pc.bgBlack(pc.white(`☰${EVE_WORDMARK} `))} ${pc.dim(`v${version}`)}`;
}

/**
 * The unstyled wordmark-and-version tag (`☰eve  v0.24.5`) — the boot banner's
 * plain-text form. The dev TUI dims it as its parting line on teardown.
 */
export function eveVersionTag(): string {
  const { version } = resolveInstalledPackageInfo();
  return `☰${EVE_WORDMARK}  v${version}`;
}
