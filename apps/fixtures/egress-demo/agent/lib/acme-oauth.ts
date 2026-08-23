import {
  ConnectionAuthorizationRequiredError,
  defineInteractiveAuthorization,
} from "eve/connections";

/**
 * The bearer the fake Acme API expects. It exists only host-side: the
 * firewall injects it in transit, so nothing inside the sandbox ever
 * holds it.
 */
export const ACME_API_TOKEN = "acme-demo-token-7GK";

/**
 * Stand-in for a real OAuth provider (swap for `connect("...")` from
 * `@vercel/connect/eve` to make the consent a real brokered grant).
 * Consent is one click: the challenge URL is the authorization callback
 * itself, so opening it completes the grant and resumes the parked agent.
 */
const grants = new Map<string, string>();

export const acmeOAuth = defineInteractiveAuthorization<{ principalId: string }>({
  displayName: "Acme API",
  async getToken({ principal }) {
    const principalId = principal.type === "user" ? principal.id : "app";
    const token = grants.get(principalId);
    if (token === undefined) {
      throw new ConnectionAuthorizationRequiredError("acme");
    }
    return { providerSubject: principalId, token };
  },
  async startAuthorization({ callbackUrl, principal }) {
    const principalId = principal.type === "user" ? principal.id : "app";
    const url = new URL(callbackUrl);
    url.searchParams.set("code", "acme-grant");
    return {
      challenge: {
        instructions: "Authorize the agent's sandbox to reach the Acme API.",
        url: url.href,
      },
      resume: { principalId },
    };
  },
  async completeAuthorization({ callback, resume }) {
    if (callback.params.code !== "acme-grant" || resume === undefined) {
      throw new Error("Unexpected Acme authorization callback.");
    }
    grants.set(resume.principalId, ACME_API_TOKEN);
    return { providerSubject: resume.principalId, token: ACME_API_TOKEN };
  },
});
