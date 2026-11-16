export async function handleExpiredLegacyAuthorization(): Promise<Response> {
  return Response.json(
    {
      ok: false,
      error: "This authorization link predates the session upgrade. Request authorization again.",
    },
    { status: 410 },
  );
}
