import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";

import { createEmulator, type Emulator } from "emulate";
import {
  Client,
  type InteractionOpened,
  type InteractionSettled,
  type SessionStreamEvent,
} from "eve/client";

import { startMcpStubServer } from "./lib/mcp-stub-server.ts";
import { runEnvironment } from "./lib/run.ts";
import { theme } from "./lib/theme.ts";

/**
 * End-to-end proof that a user-principal MCP connection drives a
 * real OAuth 2.1 + PKCE flow through eve's
 * `requestAuthorization` / `getAuthorizationResult` API, with an
 * actual token exchange against an external IdP and an authenticated
 * MCP request after the resume.
 *
 *
 * Pieces:
 *
 *   - Microsoft IdP emulator from `@emulators/microsoft` (via the
 *     `emulate` package), exposes a real OAuth 2.1 authorize+token
 *     surface with PKCE verification. The picker page is bypassed by
 *     POSTing the form fields directly to `/authorize/callback`,
 *     mirroring the package's own test pattern.
 *   - `packages/eve/test/tui-client/lib/mcp-stub-server.ts` started with
 *     `requireBearer: true`, proves the OAuth-issued token actually
 *     reaches MCP (otherwise the assistant's tool call would 401).
 *   - `apps/fixtures/agent-tui-client/agent/connections/stub-mcp-user.ts`, the
 *     `defineInteractiveAuthorization` fixture with real OAuth client
 *     logic (PKCE generation, state-as-CSRF, `/token` exchange).
 *   - `apps/fixtures/agent-tui-client/agent/channels/anchored.ts`, the user-principal
 *     channel that opens the session.
 *
 * Pass conditions:
 *
 *   1. `authorization.required` event lands for
 *      `stub-mcp-user` with a populated `webhookUrl` and a
 *      challenge URL pointing at the emulator's `/authorize`.
 *   2. `authorization.completed` carries
 *      `outcome: "authorized"`.
 *   3. After the resume, the marker token surfaces in the stream:
 *      either in the MCP tool's `call.settled`, or echoed verbatim in
 *      the assistant's reply `content.completed`. The marker is random per
 *      run and only ever produced by the bearer-gated MCP stub, so its
 *      presence proves the OAuth token reached MCP.
 *   4. A different user on the same anchored thread cannot reuse the
 *      first user's credential. Their connection call must produce a
 *      fresh `authorization.required` event in the original session.
 *      This distinguishes the active turn's `auth.current` from the
 *      session's original `auth.initiator`.
 *
 * Lifecycle note: `runEnvironment()` keeps the MCP stub and OAuth
 * emulator alive while the agent target runs.
 */

const MARKER_TOKEN = `mcp-user-ok-${randomBytes(4).toString("hex")}`;
const EXPECTED_TOOL_NAME = "connection__stub-mcp-user__echo_marker";
const SEEDED_EMAIL = "alice@example.com";
const THREAD_ID = `auth-user-${randomBytes(4).toString("hex")}`;

/**
 * Asks the OS to pick a free port, then releases it. There is a small
 * race window between release and the emulator rebinding, but in
 * practice (single-host CI) it is enough to avoid the fixed-port
 * collision a hardcoded value would create when the smoke suite
 * eventually runs in parallel.
 */
async function pickFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      server.close(() => resolve(address.port));
    });
  });
}

runEnvironment("tui-connection-auth-user", async ({ cleanup, target: resolveTarget }) => {
  const mcp = await startMcpStubServer({ marker: MARKER_TOKEN, requireBearer: true });
  console.log(theme.muted(`[oauth-user] started stub MCP server at ${mcp.url}`));
  cleanup(() => mcp.stop());

  // Seed only a user; deliberately omit `oauth_clients` so the
  // emulator skips redirect-URI allowlisting and client_secret
  // checks. (The framework callback URL embeds a per-hook token
  // generated at runtime, so we can't pre-register it. Source check:
  // both `/authorize/callback` and `/token` gate client validation on
  // `ms.oauthClients.all().length > 0`.) PKCE verification still runs
  // because the emulator stores the code-challenge regardless.
  const emulatorPort = await pickFreePort();
  const emulator: Emulator = await createEmulator({
    service: "microsoft",
    port: emulatorPort,
    seed: {
      microsoft: {
        users: [{ email: SEEDED_EMAIL, name: "Alice" }],
      },
    },
  });
  console.log(theme.muted(`[oauth-user] started OAuth emulator at ${emulator.url}`));
  cleanup(() => emulator.close());

  const target = await resolveTarget({
    app: "agent-tui-client",
    kind: "local-build",
    startEnv: {
      ...process.env,
      EVE_TEST_MCP_STUB_URL: mcp.url,
      EVE_TEST_MCP_STUB_USER_AUTH: "1",
      EVE_TEST_OAUTH_EMULATOR_URL: emulator.url,
    },
  });

  const startResp = await fetch(`${target.baseUrl}/anchor/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId: THREAD_ID,
      message: [
        "Use the `stub-mcp-user` connection's `echo_marker` tool.",
        "The model-visible tool name is `connection__stub-mcp-user__echo_marker`.",
        'Call it with `note: "smoke"` and reply with the tool\'s returned text verbatim.',
      ].join("\n"),
    }),
  });
  if (!startResp.ok) {
    throw new Error(`POST /anchor/start failed: ${startResp.status} ${await startResp.text()}`);
  }
  const startBody = (await startResp.json()) as { sessionId?: string };
  if (!startBody.sessionId) {
    throw new Error(`POST /anchor/start returned no sessionId: ${JSON.stringify(startBody)}`);
  }
  const sessionId = startBody.sessionId;

  const client = new Client({ host: target.baseUrl });
  const session = client.sessions.attach(sessionId);
  const stream = session.stream();

  let requiredEvent: InteractionOpened | undefined;
  let completedEvent: InteractionSettled | undefined;
  let toolResultMatched = false;
  let markerEchoedInMessage = false;
  const markerCalls = new Set<string>();

  for await (const event of stream as AsyncIterable<SessionStreamEvent>) {
    if (
      event.type === "interaction.opened" &&
      event.data.request.kind === "sign-in" &&
      event.data.request.signIn?.name === "stub-mcp-user"
    ) {
      requiredEvent = event;
      const challengeUrl = event.data.request.signIn.url;
      if (challengeUrl === undefined) {
        throw new Error("The sign-in interaction is missing its challenge URL.");
      }
      const parsed = new URL(challengeUrl);
      const form = new URLSearchParams({
        email: SEEDED_EMAIL,
        client_id: parsed.searchParams.get("client_id") ?? "",
        redirect_uri: parsed.searchParams.get("redirect_uri") ?? "",
        scope: parsed.searchParams.get("scope") ?? "",
        state: parsed.searchParams.get("state") ?? "",
        nonce: "",
        response_mode: "",
        code_challenge: parsed.searchParams.get("code_challenge") ?? "",
        code_challenge_method: parsed.searchParams.get("code_challenge_method") ?? "",
      });
      void (async () => {
        try {
          const resp = await fetch(`${emulator.url}/oauth2/v2.0/authorize/callback`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: form,
            redirect: "manual",
          });
          const loc = resp.headers.get("location");
          if (resp.status !== 302 || loc === null) {
            throw new Error(`picker-bypass POST returned ${resp.status}: ${await resp.text()}`);
          }
          await fetch(loc, { method: "GET" });
        } catch (err: unknown) {
          console.error(theme.danger("[oauth-user] picker-bypass flow failed:"), err);
        }
      })();
    }

    if (
      event.type === "interaction.settled" &&
      event.data.interactionId === requiredEvent?.data.interactionId
    ) {
      completedEvent = event;
    }

    if (event.type === "call.requested" && event.data.capability.name.includes("echo_marker")) {
      markerCalls.add(event.data.callId);
    }
    // Match on the marker as well as the stable tool-name suffix. The marker
    // is random per run and only the bearer-gated MCP stub can emit it.
    if (
      event.type === "call.settled" &&
      markerCalls.has(event.data.callId) &&
      event.data.outcome === "completed"
    ) {
      const output = event.data.output;
      const serialized = typeof output === "string" ? output : JSON.stringify(output ?? "");
      if (serialized.includes(MARKER_TOKEN)) {
        toolResultMatched = true;
      }
    }

    // Fallback proof: the prompt instructs the model to echo the tool's
    // returned text verbatim, so the reply carries the marker even if the
    // result event is unavailable.
    if (
      event.type === "content.completed" &&
      event.data.phase === "reply" &&
      typeof event.data.value === "string" &&
      event.data.value.includes(MARKER_TOKEN)
    ) {
      markerEchoedInMessage = true;
    }

    if (
      (event.type === "turn.settled" && completedEvent !== undefined) ||
      event.type === "session.ended"
    ) {
      break;
    }
  }

  if (requiredEvent === undefined) {
    throw new Error("Did not see a sign-in interaction for stub-mcp-user.");
  }
  const callbackUrl = requiredEvent.data.request.signIn?.callbackUrl;
  if (callbackUrl === undefined || callbackUrl.length === 0) {
    throw new Error("The sign-in's callbackUrl was empty.");
  }
  console.log(theme.muted(`[oauth-user] sign-in observed, callbackUrl ${callbackUrl}`));

  if (completedEvent === undefined) {
    throw new Error("Did not see the sign-in settle for stub-mcp-user.");
  }
  if (completedEvent.data.outcome !== "accepted") {
    throw new Error(
      `Expected outcome=authorized, got ${completedEvent.data.outcome} (reason=${completedEvent.data.reason ?? "n/a"}).`,
    );
  }
  console.log(theme.muted("[oauth-user] sign-in settled with outcome=accepted"));

  if (!toolResultMatched && !markerEchoedInMessage) {
    throw new Error(
      `Did not see marker ${MARKER_TOKEN} in any successful ${EXPECTED_TOOL_NAME} call.settled ` +
        "or the assistant's reply. The OAuth-issued bearer token did not reach MCP, " +
        "or the model didn't call the tool.",
    );
  }
  console.log(
    theme.muted(
      `[oauth-user] bearer token threaded through to MCP (marker via ${
        toolResultMatched ? "call.settled" : "the reply"
      })`,
    ),
  );

  const replyResp = await fetch(`${target.baseUrl}/anchor/reply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId: THREAD_ID,
      message: [
        "Use the `stub-mcp-user` connection's `echo_marker` tool again.",
        `The model-visible tool name is \`${EXPECTED_TOOL_NAME}\`.`,
        'Call it with `note: "cross-principal-smoke"`. Do not answer without calling the tool.',
      ].join("\n"),
    }),
  });
  if (!replyResp.ok) {
    throw new Error(`POST /anchor/reply failed: ${replyResp.status} ${await replyResp.text()}`);
  }
  const replyBody = (await replyResp.json()) as { sessionId?: string };
  if (replyBody.sessionId !== sessionId) {
    throw new Error(
      `Expected follow-up to resume session ${sessionId}, got ${replyBody.sessionId ?? "<none>"}.`,
    );
  }

  let followupAuthRequired = false;
  let followupToolCompleted = false;
  let followupBoundary: SessionStreamEvent["type"] | undefined;
  const followupAbort = new AbortController();
  const followupTimer = setTimeout(() => followupAbort.abort(), 60_000);

  try {
    const followupCalls = new Set<string>();
    for await (const event of session.stream({ signal: followupAbort.signal })) {
      if (
        event.type === "interaction.opened" &&
        event.data.request.kind === "sign-in" &&
        event.data.request.signIn?.name === "stub-mcp-user"
      ) {
        followupAuthRequired = true;
      }

      if (event.type === "call.requested" && event.data.capability.name.includes("echo_marker")) {
        followupCalls.add(event.data.callId);
      }
      if (
        event.type === "call.settled" &&
        event.data.outcome === "completed" &&
        followupCalls.has(event.data.callId)
      ) {
        followupToolCompleted = true;
      }

      if (event.type === "session.ended" && event.data.outcome === "failed") {
        throw new Error(
          `Follow-up session failed: ${event.data.error?.code} ${event.data.error?.message}`,
        );
      }

      // The fresh sign-in pauses the second principal's turn on the person.
      if (
        event.type === "turn.settled" ||
        event.type === "session.ended" ||
        (event.type === "turn.paused" &&
          event.data.awaiting.some((entry) => "interactionId" in entry))
      ) {
        followupBoundary = event.type;
        break;
      }
    }
  } finally {
    clearTimeout(followupTimer);
  }

  if (followupBoundary === undefined) {
    throw new Error("Cross-principal follow-up stream did not reach a session boundary.");
  }
  if (!followupAuthRequired) {
    throw new Error(
      "The second principal did not receive a fresh authorization challenge. " +
        "The connection may have reused the session initiator's OAuth credential.",
    );
  }
  if (followupToolCompleted) {
    throw new Error(
      "The second principal completed the bearer-gated MCP call before authorizing. " +
        "The connection reused another principal's OAuth credential.",
    );
  }

  console.log(
    theme.muted(
      `[oauth-user] second principal received a fresh OAuth challenge in the original session (${followupBoundary})`,
    ),
  );
});
