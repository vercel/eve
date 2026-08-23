export function vercelSessionIdAttribute(
  enabled: boolean,
  rootSessionId: string,
): { readonly "vercel.session_id"?: string } {
  return enabled ? { "vercel.session_id": rootSessionId } : {};
}
