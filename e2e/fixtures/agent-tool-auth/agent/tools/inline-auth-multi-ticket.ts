import {
  ConnectionAuthorizationRequiredError,
  type AuthorizationDefinition,
  type TokenResult,
} from "eve/connections";
import { defineTool } from "eve/tools";
import { z } from "zod";

const INLINE_AUTH_MARKER = "inline-auth-e2e-ok-Q7M2";

const githubAuth = buildAuthProvider({
  connector: "oauth/github-e2e",
  provider: "github",
  url: "https://auth.example.test/github",
});

const linearAuth = buildAuthProvider({
  connector: "oauth/linear-e2e",
  provider: "linear",
  url: "https://auth.example.test/linear",
});

export default defineTool({
  description: "Return a deterministic marker after resolving GitHub and Linear inline auth.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const tokens = await ctx.getTokens({
      github: [githubAuth, { displayName: "GitHub E2E" }],
      linear: [linearAuth, { displayName: "Linear E2E" }],
    });

    return {
      marker: INLINE_AUTH_MARKER,
      github: tokens.github.token,
      linear: tokens.linear.token,
    };
  },
});

function buildAuthProvider(input: {
  readonly connector: string;
  readonly provider: string;
  readonly url: string;
}): AuthorizationDefinition {
  return {
    principalType: "user",
    vercelConnect: { connector: input.connector },
    async getToken(): Promise<TokenResult> {
      throw new ConnectionAuthorizationRequiredError(input.connector);
    },
    async startAuthorization() {
      return {
        challenge: {
          instructions: `Authorize ${input.provider}`,
          url: input.url,
        },
      };
    },
    async completeAuthorization({ callback }): Promise<TokenResult> {
      return { token: `${input.provider}-${callback.params.code ?? "missing-code"}` };
    },
  };
}
