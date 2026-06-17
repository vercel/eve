import pc from "picocolors";

import { resolveInstalledPackageInfo } from "#internal/application/package.js";

export const EVE_WORDMARK = "eve";
export const EVE_BETA_TERMS_URL = "https://vercel.com/docs/release-phases/public-beta-agreement";
export const EVE_PREVIEW_NOTICE =
  "eve is currently a preview and subject to the Vercel beta terms; the framework, APIs, documentation, and behavior may change before general availability.";

/**
 * The boot banner shared by every CLI command that announces itself: the eve
 * badge plus the installed version, followed by the preview notice. Printed
 * only by the CLI program's pre-action hook so commands never compose their
 * own variant.
 */
export function eveCliBanner(): string {
  const { version } = resolveInstalledPackageInfo();
  return `${pc.bgBlack(pc.white(` ${EVE_WORDMARK} `))} ${pc.dim(`v${version}`)}\n${pc.dim(
    EVE_PREVIEW_NOTICE,
  )}`;
}
