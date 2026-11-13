import { BrowserHandoffError, resolveBrowserHandoffLiveViewUrl } from "../../../../server/browser/handoff";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  try {
    const liveViewUrl = await resolveBrowserHandoffLiveViewUrl(token);
    return new Response(null, {
      status: 307,
      headers: {
        "cache-control": "no-store, private, max-age=0",
        location: liveViewUrl,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    const status =
      error instanceof BrowserHandoffError && error.code === "expired"
        ? 410
        : error instanceof BrowserHandoffError && error.code === "configuration"
          ? 503
          : error instanceof BrowserHandoffError && error.code === "unavailable"
            ? 503
            : 404;
    return Response.json(
      {
        error:
          status === 410
            ? "This handoff link expired. Ask Bell for a new link."
            : "The live browser is not available.",
      },
      {
        status,
        headers: {
          "cache-control": "no-store, private, max-age=0",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        },
      },
    );
  }
}
