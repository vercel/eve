const STAMPED_PACKAGE_VERSION: string = "__EVE_PACKAGE_VERSION__";
const STAMPED_SESSION_CODE_HASH: string = "__EVE_SESSION_CODE_HASH__";

export function readStampedPackageVersion(): string | undefined {
  return STAMPED_PACKAGE_VERSION.startsWith("__") ? undefined : STAMPED_PACKAGE_VERSION;
}

export function readStampedSessionCodeHash(): string | undefined {
  return STAMPED_SESSION_CODE_HASH.startsWith("__") ? undefined : STAMPED_SESSION_CODE_HASH;
}
