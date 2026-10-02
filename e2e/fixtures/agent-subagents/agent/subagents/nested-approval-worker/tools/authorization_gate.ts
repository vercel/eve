import {
  ConnectionAuthorizationRequiredError,
  defineInteractiveAuthorization,
} from "eve/connections";
import { defineTool } from "eve/tools";
import { z } from "zod";

const AUTHORIZATION_NAME = "nested-release-authorization";
const AUTHORIZATION_CODE = "nested-release-code";

const authorization = defineInteractiveAuthorization<{ marker: "release" }>({
  async getToken() {
    throw new ConnectionAuthorizationRequiredError(AUTHORIZATION_NAME);
  },
  async startAuthorization() {
    return {
      challenge: { displayName: "Release checklist sign-in", userCode: AUTHORIZATION_CODE },
      resume: { marker: "release" as const },
    };
  },
  async completeAuthorization({ callback, resume }) {
    if (callback.params.code !== AUTHORIZATION_CODE || resume?.marker !== "release") {
      throw new Error("Release checklist authorization failed.");
    }
    return { token: "nested-release-token" };
  },
});

export default defineTool({
  description: "Authorize Alice's release checklist.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const result = await ctx.getToken(authorization, {
      authKey: AUTHORIZATION_NAME,
      displayName: "Release checklist sign-in",
    });
    if (result.token !== "nested-release-token") throw new Error("Unexpected authorization token.");
    return "authorized";
  },
});
