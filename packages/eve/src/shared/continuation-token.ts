/** Removes the runtime-owned channel namespace from a continuation token. */
export function toChannelLocalContinuationToken(namespacedToken: string): string {
  const separatorIndex = namespacedToken.indexOf(":");
  return separatorIndex < 0 ? namespacedToken : namespacedToken.slice(separatorIndex + 1);
}
