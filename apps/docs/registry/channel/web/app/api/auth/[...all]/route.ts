import { auth } from "@/lib/auth";

async function handler(request: Request): Promise<Response> {
  if (!auth) {
    return Response.json(
      {
        error: "Web Chat authentication requires EVE_ACCESS_PASSWORD and BETTER_AUTH_SECRET.",
      },
      { status: 503 },
    );
  }
  return auth.handler(request);
}

export { handler as GET, handler as POST };
