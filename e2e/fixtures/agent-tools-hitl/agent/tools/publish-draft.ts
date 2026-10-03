import {
  ConnectionAuthorizationRequiredError,
  defineInteractiveAuthorization,
} from "eve/connections";
import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";

const publications = defineState("publish-draft.publications", () => 0);

// Shares auth-probe's sign-in (same `authKey`), so a publish asked while an
// auth-probe sign-in is open supersedes that attempt.
const fixtureAuth = defineInteractiveAuthorization<{ marker: string }>({
  async getToken() {
    throw new ConnectionAuthorizationRequiredError("auth-probe");
  },
  async startAuthorization({ callbackUrl }) {
    const url = new URL(callbackUrl);
    url.searchParams.set("code", "fixture-ok");
    return {
      challenge: { displayName: "Fixture Auth", url: url.href },
      resume: { marker: "fixture-resume" },
    };
  },
  async completeAuthorization({ callback, resume }) {
    if (callback.params.code !== "fixture-ok" || resume?.marker !== "fixture-resume") {
      throw new Error("Fixture authorization state mismatch.");
    }
    return { token: "publish-token-Q2W7" };
  },
});

/** Needs approval once, then a sign-in each time it runs. */
export default defineTool({
  description: "Publish the fixture draft. Requires approval and a Fixture Auth sign-in.",
  inputSchema: z.object({}),
  approval: once(),
  async execute(_input, ctx) {
    await ctx.getToken(fixtureAuth, { authKey: "auth-probe", displayName: "Fixture Auth" });
    publications.update((count) => count + 1);
    return {
      actor: ctx.session.auth.current?.principalId ?? "none",
      publications: publications.get(),
    };
  },
});
