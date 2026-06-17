import type {
  ActionResultStreamEvent,
  AuthorizationCompletedStreamEvent,
  AuthorizationRequiredStreamEvent,
  HandleMessageStreamEvent,
} from "eve/client";
import { defineEval } from "eve/evals";

const TOOL_NAME = "inline-auth-multi-ticket";
const GITHUB_SCOPE = "inline-auth-multi-ticket__oauth_github-e2e";
const LINEAR_SCOPE = "inline-auth-multi-ticket__oauth_linear-e2e";
const MARKER = "inline-auth-e2e-ok-Q7M2";

export default defineEval({
  description:
    "Inline tool auth e2e: multiple provider prompts complete through real callback routes.",

  async test(t) {
    const turn = await t.authorize(
      [
        `Call the \`${TOOL_NAME}\` tool exactly once with an empty object.`,
        `After it returns, reply with ${MARKER}, github-github-code, and linear-linear-code.`,
      ].join("\n"),
      [
        { name: GITHUB_SCOPE, params: { code: "github-code" } },
        { name: LINEAR_SCOPE, params: { code: "linear-code" } },
      ],
    );
    turn.expectOk();

    const authRequired = authorizationRequiredEvents(t.events);
    if (authRequired.length !== 2) {
      throw new Error(`Expected 2 authorization.required events, got ${authRequired.length}.`);
    }
    assertAuthRequired(
      authRequired,
      GITHUB_SCOPE,
      "GitHub E2E",
      "https://auth.example.test/github",
    );
    assertAuthRequired(
      authRequired,
      LINEAR_SCOPE,
      "Linear E2E",
      "https://auth.example.test/linear",
    );

    const completed = authorizationCompletedEvents(t.events);
    if (completed.length !== 2) {
      throw new Error(`Expected 2 authorization.completed events, got ${completed.length}.`);
    }
    assertAuthorized(completed, GITHUB_SCOPE);
    assertAuthorized(completed, LINEAR_SCOPE);

    const output = inlineAuthOutput(t.events);
    if (
      output.marker !== MARKER ||
      output.github !== "github-github-code" ||
      output.linear !== "linear-linear-code"
    ) {
      throw new Error(`Unexpected inline auth output: ${JSON.stringify(output)}.`);
    }

    t.didNotFail();
    t.completed();
    t.calledTool(TOOL_NAME, {
      isError: false,
      output: {
        github: "github-github-code",
        linear: "linear-linear-code",
        marker: MARKER,
      },
      times: 1,
    });
    t.messageIncludes(MARKER);
    t.messageIncludes("github-github-code");
    t.messageIncludes("linear-linear-code");
  },
});

function authorizationRequiredEvents(
  events: readonly HandleMessageStreamEvent[],
): AuthorizationRequiredStreamEvent[] {
  return events.filter(
    (event): event is AuthorizationRequiredStreamEvent => event.type === "authorization.required",
  );
}

function authorizationCompletedEvents(
  events: readonly HandleMessageStreamEvent[],
): AuthorizationCompletedStreamEvent[] {
  return events.filter(
    (event): event is AuthorizationCompletedStreamEvent => event.type === "authorization.completed",
  );
}

function assertAuthRequired(
  events: readonly AuthorizationRequiredStreamEvent[],
  name: string,
  displayName: string,
  url: string,
): void {
  const event = events.find((candidate) => candidate.data.name === name);
  if (event === undefined) {
    throw new Error(`Missing authorization.required for ${name}.`);
  }
  if (event.data.authorization?.displayName !== displayName) {
    throw new Error(
      `Expected ${name} displayName ${JSON.stringify(displayName)}, got ${JSON.stringify(
        event.data.authorization?.displayName,
      )}.`,
    );
  }
  if (event.data.authorization?.url !== url) {
    throw new Error(
      `Expected ${name} auth URL ${JSON.stringify(url)}, got ${JSON.stringify(
        event.data.authorization?.url,
      )}.`,
    );
  }
  if (!event.data.webhookUrl?.includes(`/eve/v1/connections/${name}/callback/`)) {
    throw new Error(`Expected ${name} webhookUrl to include its provider-scoped callback route.`);
  }
}

function assertAuthorized(
  events: readonly AuthorizationCompletedStreamEvent[],
  name: string,
): void {
  const event = events.find((candidate) => candidate.data.name === name);
  if (event === undefined) {
    throw new Error(`Missing authorization.completed for ${name}.`);
  }
  if (event.data.outcome !== "authorized") {
    throw new Error(`Expected ${name} to authorize, got ${event.data.outcome}.`);
  }
}

function inlineAuthOutput(events: readonly HandleMessageStreamEvent[]): Record<string, unknown> {
  const result = events.find(
    (event): event is ActionResultStreamEvent =>
      event.type === "action.result" &&
      event.data.result.kind === "tool-result" &&
      event.data.result.toolName === TOOL_NAME,
  );
  if (result === undefined || typeof result.data.result.output !== "object") {
    throw new Error(`Missing ${TOOL_NAME} action.result output.`);
  }
  if (result.data.result.output === null || Array.isArray(result.data.result.output)) {
    throw new Error(`Expected object output from ${TOOL_NAME}.`);
  }
  return result.data.result.output as Record<string, unknown>;
}
