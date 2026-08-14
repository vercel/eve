import {
  ConnectionAuthorizationRequiredError,
  defineInteractiveAuthorization,
} from "eve/connections";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

const tokens = new Map<string, string>();
const fakeOAuth = defineInteractiveAuthorization<{ principalId: string }>({
  displayName: "Fixture OAuth",
  async getToken({ principal }) {
    if (principal.type !== "user") throw new Error("Expected a user principal.");
    const token = tokens.get(principal.id);
    if (token === undefined) throw new ConnectionAuthorizationRequiredError("fixture-oauth");
    return { providerSubject: principal.id, token };
  },
  async startAuthorization({ callbackUrl, principal }) {
    if (principal.type !== "user") throw new Error("Expected a user principal.");
    const url = new URL(callbackUrl);
    url.searchParams.set("code", "fake-oauth-code");
    return {
      challenge: { instructions: "Complete fixture OAuth.", url: url.href },
      resume: { principalId: principal.id },
    };
  },
  async completeAuthorization({ callback, resume }) {
    if (callback.params.code !== "fake-oauth-code" || resume === undefined) {
      throw new Error("Unexpected fixture OAuth callback.");
    }
    tokens.set(resume.principalId, "fake-oauth-token");
    return { providerSubject: resume.principalId, token: "fake-oauth-token" };
  },
});

export default defineTool({
  description: "PROOF-ONLY: executes after a fake responder OAuth flow.",
  inputSchema: z.object({ marker: z.string() }),
  approval: {
    request: always(),
    async response({ auth, responder }) {
      const credential = await auth.getToken(fakeOAuth, { authKey: "fixture-oauth" });
      return credential.providerSubject === responder.principalId
        ? { status: "allowed" }
        : { status: "rejected", reason: "Fixture OAuth identity mismatch." };
    },
  },
  async execute({ marker }) {
    return { executed: true, marker };
  },
});
