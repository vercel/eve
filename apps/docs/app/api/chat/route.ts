import { createChatRoute } from "@vercel/geistdocs/routes/chat";
import { getVercelOidcToken } from "@vercel/oidc";
import { config } from "@/lib/geistdocs/config";
import { geistdocsSource } from "@/lib/geistdocs/source";

export const maxDuration = 800;

const chatRoute = createChatRoute({
  config,
  sources: [geistdocsSource],
  eveAgent: {
    // help-eve sits behind Vercel Deployment Protection with this project
    // as a Trusted Source, which reads the OIDC token from this header.
    // TODO: remove once @vercel/geistdocs sends it by default (>1.15.0);
    // the package keeps setting the Authorization bearer for channel auth.
    headers: async () => ({
      "x-vercel-trusted-oidc-idp-token": await getVercelOidcToken(),
    }),
  },
});

export const POST = chatRoute.POST;

// TEMPORARY debug probe (preview only) — remove before merge. Open
// /api/chat in the browser to see help-eve's exact response to an
// authenticated session create from this deployment.
export const GET = async () => {
  if (process.env.VERCEL_ENV === "production") {
    return new Response("Not found", { status: 404 });
  }

  try {
    const started = Date.now();
    const token = await getVercelOidcToken();
    const authHeaders = {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "x-vercel-trusted-oidc-idp-token": token,
    };
    const createResponse = await fetch("https://help-ash.vercel.sh/eve/v1/session", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ message: "In two sentences, what is an eve channel?" }),
    });

    if (!createResponse.ok) {
      return Response.json({
        status: createResponse.status,
        body: (await createResponse.text()).slice(0, 500),
      });
    }

    const { sessionId } = (await createResponse.json()) as { sessionId: string };
    // Time each NDJSON event to see whether eve streams incrementally or
    // delivers events in a burst at the end.
    const streamResponse = await fetch(
      `https://help-ash.vercel.sh/eve/v1/session/${sessionId}/stream`,
      { headers: authHeaders },
    );
    const reader = streamResponse.body?.getReader();
    const decoder = new TextDecoder();
    const timeline: { ms: number; type: string }[] = [];
    let buffer = "";
    let done = false;

    while (reader && !done && Date.now() - started < 90_000) {
      const { done: streamDone, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !streamDone });
      let index = buffer.indexOf("\n");

      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);

        if (line) {
          const type = (JSON.parse(line) as { type: string }).type;
          timeline.push({ ms: Date.now() - started, type });

          if (type === "session.waiting" || type === "session.failed") {
            done = true;
          }
        }

        index = buffer.indexOf("\n");
      }

      if (streamDone) {
        done = true;
      }
    }

    await reader?.cancel().catch(() => undefined);

    const result = { sessionId, streamStatus: streamResponse.status, timeline };
    console.log("[help-eve debug]", JSON.stringify(result));
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log("[help-eve debug] error", message);
    return Response.json({ error: message }, { status: 500 });
  }
};
