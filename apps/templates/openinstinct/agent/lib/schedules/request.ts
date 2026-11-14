import { readFile } from "node:fs/promises";
import { getVercelOidcToken } from "@vercel/oidc";
import { z } from "zod";
import { env } from "@shared/environment";
import { applicationOrigin } from "@shared/environment/origin";

const eveDevServerSchema = z.object({
  appRoot: z.string(),
  origin: z.url(),
});

interface ScheduledRunRequestBodies {
  "/internal/scheduled-run/report": { runId: string };
  "/internal/scheduled-run/respond": {
    answer: string;
    leaseToken: string;
    runId: string;
  };
}

export async function postScheduledRunRoute<
  Route extends keyof ScheduledRunRequestBodies,
>(route: Route, body: ScheduledRunRequestBodies[Route]) {
  const token = env.VERCEL_ENV ? await getVercelOidcToken() : undefined;
  const headers = new Headers({ "content-type": "application/json" });
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
    headers.set("x-vercel-trusted-oidc-idp-token", token);
  }
  const origin = await scheduledRunOrigin();
  return fetch(new URL(route, origin), {
    body: JSON.stringify(body),
    headers,
    method: "POST",
    redirect: "error",
  });
}

async function scheduledRunOrigin() {
  if (env.VERCEL_ENV && env.VERCEL_URL) {
    return `https://${env.VERCEL_URL}`;
  }
  if (env.NODE_ENV === "development") {
    try {
      const registry = eveDevServerSchema.parse(
        JSON.parse(await readFile(".eve/next-dev-server.json", "utf8"))
      );
      if (registry.appRoot === process.cwd()) {
        return new URL(registry.origin).origin;
      }
    } catch {
      // Standalone development does not create the Next.js server registry.
    }
  }
  return applicationOrigin();
}

export async function postScheduledReport(runId: string) {
  const response = await postScheduledRunRoute(
    "/internal/scheduled-run/report",
    { runId }
  );
  if (response.status !== 202) {
    throw new Error(
      `Scheduled report callback failed (${String(response.status)}).`
    );
  }
}
