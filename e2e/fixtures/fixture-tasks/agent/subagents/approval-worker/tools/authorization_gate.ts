import {
  ConnectionAuthorizationRequiredError,
  defineInteractiveAuthorization,
} from "eve/connections";
import { defineTool } from "eve/tools";
import { z } from "zod";

const AUTHORIZATION_NAME = "c7-task-authorization";
const AUTHORIZATION_CODE = "c7-deterministic-code";
const AUTHORIZATION_TOKEN = "c7-deterministic-token";

const authorization = defineInteractiveAuthorization<{ marker: "C7" }>({
  async getToken() {
    throw new ConnectionAuthorizationRequiredError(AUTHORIZATION_NAME);
  },
  async startAuthorization() {
    return {
      challenge: {
        displayName: "C7 deterministic authorization",
        userCode: AUTHORIZATION_CODE,
      },
      resume: { marker: "C7" },
    };
  },
  async completeAuthorization({ callback, resume }) {
    if (callback.params.code !== AUTHORIZATION_CODE || resume?.marker !== "C7") {
      throw new Error("C7 authorization callback did not preserve its deterministic state.");
    }
    return { token: AUTHORIZATION_TOKEN };
  },
});

export default defineTool({
  description: "Exercises deterministic interactive authorization for a task-owned child.",
  inputSchema: z.object({ marker: z.literal("C7") }),
  async execute({ marker }, ctx) {
    const result = await ctx.getToken(authorization, {
      authKey: AUTHORIZATION_NAME,
      displayName: "C7 deterministic authorization",
    });
    if (result.token !== AUTHORIZATION_TOKEN)
      throw new Error("C7 authorization returned bad token.");
    return { marker: `${marker}-AUTHORIZED` };
  },
});
