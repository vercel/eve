/** Build metadata identifies a package artifact, not a separately published release. */
export function stripVersionBuildMetadata(version: string): string {
  return version.split("+", 1)[0]!;
}
