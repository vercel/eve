import { recordBrowserTraceDomains } from "@db/services/browser-traces";
import type { AccessScope } from "@shared/identity/access-scope";
import { kernel } from "@agent/subagents/browser-agent/lib/kernel";

const maximumTelemetryEvents = 5000;

export function domainFromUrl(url: string) {
  try {
    const { hostname, protocol } = new URL(url);
    if (protocol !== "http:" && protocol !== "https:") return undefined;
    return hostname || undefined;
  } catch {
    return undefined;
  }
}

async function collectNavigationDomains(
  browser: { createdAt: string; sessionId: string },
  signal?: AbortSignal
) {
  const domains = new Set<string>();
  let seen = 0;
  for await (const { event } of kernel.browsers.telemetry.events(
    browser.sessionId,
    { category: ["page"], limit: 1000, since: browser.createdAt },
    { signal }
  )) {
    if (seen >= maximumTelemetryEvents) break;
    seen += 1;
    if (event.type !== "page_navigation") continue;
    const data = event.data;
    if (!data?.url || data.parent_frame_id) continue;
    if (data.target_type && data.target_type !== "page") continue;
    const domain = domainFromUrl(data.url);
    if (domain) domains.add(domain);
  }
  return domains;
}

export async function harvestBrowserTraceDomains(
  scope: AccessScope,
  traceSessionId: string,
  browser: { createdAt: string; sessionId: string },
  signal?: AbortSignal
) {
  try {
    const domains = await collectNavigationDomains(browser, signal);
    await recordBrowserTraceDomains(scope, traceSessionId, [...domains]);
  } catch (error) {
    console.warn("[browser-trace] domain harvest failed", {
      browserSessionId: browser.sessionId,
      error,
      traceSessionId,
    });
  }
}
