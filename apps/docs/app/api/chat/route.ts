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
    const token = await getVercelOidcToken();
    const response = await fetch("https://help-ash.vercel.sh/eve/v1/session", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-vercel-trusted-oidc-idp-token": token,
      },
      body: JSON.stringify({ message: "debug ping from eve-docs preview" }),
    });
    const body = (await response.text()).slice(0, 500);
    const result = {
      status: response.status,
      body,
      tokenPayload: JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()),
    };
    console.log("[help-eve debug]", JSON.stringify(result));
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log("[help-eve debug] error", message);
    return Response.json({ error: message }, { status: 500 });
  }
};
