import MemoryClient from "mem0ai";

// The Mem0 Vercel integration injects MEM0_API_KEY, scoped to your org and project.
// Created lazily so this module can be imported during build without the key present.
let client: MemoryClient | undefined;

export function getMem0(): MemoryClient {
  if (!client) {
    const apiKey = process.env.MEM0_API_KEY;
    if (!apiKey) {
      throw new Error(
        "MEM0_API_KEY is not set. Install the Mem0 integration from the Vercel Marketplace, " +
          "or run `vercel env pull` for local development.",
      );
    }
    client = new MemoryClient({ apiKey });
  }
  return client;
}

// Memory is scoped per authenticated caller. Unprotected sessions share one id so the
// demo remembers across sessions; add real auth and this becomes per-user automatically.
export function memoryUserId(principalId: string | null | undefined): string {
  return principalId ?? "default-user";
}
