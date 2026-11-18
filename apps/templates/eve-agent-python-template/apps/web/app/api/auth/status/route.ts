/**
 * Reports whether this browser has access. The password gate in `proxy.ts`
 * answers `401` before this runs when the access cookie is missing or invalid.
 */
export function GET() {
  return Response.json({ ok: true });
}
