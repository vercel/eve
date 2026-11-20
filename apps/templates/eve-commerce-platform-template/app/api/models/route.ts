import { requireRequestScope, UnauthenticatedError } from "@/lib/auth/next";
import { readModelCatalog } from "@/lib/models/gateway";

export async function GET() {
  try {
    await requireRequestScope();
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return new Response(null, { status: 401 });
    }
    throw error;
  }

  return Response.json(await readModelCatalog());
}
