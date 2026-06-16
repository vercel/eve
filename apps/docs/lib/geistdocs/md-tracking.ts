import type { TrackMarkdownRequestEvent } from "@vercel/geistdocs/proxy";
import { siteId } from "@/geistdocs";

const PLATFORM_URL = "https://geistdocs.com/md-tracking";

/** Track a markdown page request via the Geistdocs platform. */
export async function trackMdRequest(event: TrackMarkdownRequestEvent): Promise<void> {
  try {
    const response = await fetch(PLATFORM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...event,
        siteId: siteId ?? "geistdocs-unknown",
      }),
    });

    if (!response.ok) {
      console.error("MD tracking failed:", response.status, await response.text());
    }
  } catch (error) {
    console.error("MD tracking error:", error);
  }
}
