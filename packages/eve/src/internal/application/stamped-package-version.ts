const STAMPED_PACKAGE_VERSION: string = "__EVE_PACKAGE_VERSION__";

export function readStampedPackageVersion(): string | undefined {
  return STAMPED_PACKAGE_VERSION.startsWith("__") ? undefined : STAMPED_PACKAGE_VERSION;
}
