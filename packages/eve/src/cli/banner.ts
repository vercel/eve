import pc from "picocolors";

import { resolveInstalledPackageInfo } from "#internal/application/package.js";

export const EVE_WORDMARK = "eve";

/**
 * The one-line boot banner shared by every CLI command that announces itself:
 * the eve badge plus the installed version, dimmed. Printed only by the CLI
 * program's pre-action hook so commands never compose their own variant.
 */
export function eveCliBanner(): string {
  const { version } = resolveInstalledPackageInfo();
  return `${pc.bgBlack(pc.white(` ${EVE_WORDMARK} `))} ${pc.dim(`v${version}`)}`;
}
