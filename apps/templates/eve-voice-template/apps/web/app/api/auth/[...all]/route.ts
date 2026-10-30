import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSetupStatus } from "@/lib/setup";

export async function GET(request: Request) {
  return handleAuth(request);
}

export async function POST(request: Request) {
  return handleAuth(request);
}

async function handleAuth(request: Request) {
  const setupStatus = await getSetupStatus();

  if (setupStatus.authMode !== "vercel") {
    return NextResponse.json({ error: "Sign in with Vercel is not configured." }, { status: 409 });
  }

  if (setupStatus.missing.includes("database migrations")) {
    return NextResponse.json(
      { error: "Run `pnpm db:migrate` to create the Better Auth tables." },
      { status: 503 },
    );
  }

  return auth.handler(request);
}
