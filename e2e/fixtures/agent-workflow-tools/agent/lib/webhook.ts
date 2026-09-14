export async function postWorkflowCallback(url: string, service: string): Promise<void> {
  "use step";

  const headers: Record<string, string> = { "content-type": "application/json" };
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypass) headers["x-vercel-protection-bypass"] = bypass;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ service }),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 202 || (await response.text()) !== "callback accepted") {
    throw new Error(`Workflow callback returned an unexpected response (${response.status}).`);
  }
}
