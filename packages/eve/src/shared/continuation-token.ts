export function toChannelLocalContinuationToken(namespacedToken: string): string {
  const separatorIndex = namespacedToken.indexOf(":");
  return separatorIndex < 0 ? namespacedToken : namespacedToken.slice(separatorIndex + 1);
}
