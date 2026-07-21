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
