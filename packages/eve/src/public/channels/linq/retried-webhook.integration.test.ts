import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createChannelOperations } from "#channel/channel-operations.js";
import { isCompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import type { Delivery } from "#shared/delivery.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { captureTurnEvents } from "#internal/testing/events.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { waitForParkedTurnStep } from "#internal/testing/session-test-helpers.js";
import { getRun, getWorld } from "#internal/workflow/runtime.js";
import { defaultLinqAuth, linqChannel } from "#public/channels/linq/linqChannel.js";
import { defineHook } from "#public/definitions/hook.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";

const SIGNING_KEY = Buffer.from("linq-retry-signing-key");
const BASE_URL = "https://linq-retry.invalid/api/partner";
const CHAT_ID = "linq-retry-chat";
const ALICE = { handle: "+15550100", id: "handle-alice", is_me: false };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Linq webhook retries", () => {
  it.each([
    {
      label: "message",
      payload: {
        data: {
          chat: { id: CHAT_ID, is_group: false },
          direction: "inbound",
          id: "linq-message-1",
          parts: [{ type: "text", value: "Alice asks for the weekly report." }],
          sender_handle: ALICE,
        },
        event_id: "linq-event-message-1",
        event_type: "message.received",
      },
    },
    {
      label: "tapback",
      payload: {
        data: {
          chat_id: CHAT_ID,
          from_handle: ALICE,
          is_from_me: false,
          message_id: "linq-message-1",
          reaction_type: "love",
        },
        event_id: "linq-event-reaction-1",
        event_type: "reaction.added",
      },
    },
  ])(
    "runs one turn when a retried $label webhook reaches a fresh instance",
    async ({ payload }) => {
      vi.stubEnv("VERCEL_DEPLOYMENT_ID", await (await getWorld()).getDeploymentId());
      const realFetch = globalThis.fetch;
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.hostname !== new URL(BASE_URL).hostname) return realFetch(input, init);
        return Response.json({ chat_id: CHAT_ID, id: "linq-out", message: { id: "linq-out" } });
      });
      const createChannel = () =>
        linqChannel({
          baseURL: BASE_URL,
          credentials: {
            apiKey: "linq-retry-api-key",
            signingSecret: `whsec_${SIGNING_KEY.toString("base64")}`,
          },
          onTapback: (_ctx, tapback) => ({ auth: defaultLinqAuth(tapback) }),
        });
      const firstInstance = createChannel();
      let turns = 0;
      const app = await createTestRuntime({
        agent: { name: "linq-retry", limits: { sessionTimeoutMs: false } },
        modules: [
          {
            logicalPath: "channels/linq.ts",
            loadNamespace: async () => ({ default: firstInstance }),
          },
          {
            logicalPath: "hooks/record.ts",
            loadNamespace: async () => ({
              default: defineHook({
                events: {
                  "turn.started"() {
                    turns += 1;
                  },
                },
              }),
            }),
          },
        ],
      });

      await app.run(async () => {
        const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
        const runtime = createWorkflowRuntime({ compiledArtifactsSource });
        const { graph } = await getCompiledRuntimeAgentBundle({ compiledArtifactsSource });
        const adapter = graph.root.channels.find((channel) => channel.name === "linq")?.adapter;
        if (adapter === undefined) throw new Error("Expected the resolved Linq channel.");
        const operations = createChannelOperations({ adapter, channelName: "linq", runtime });
        const deliveries: Delivery[] = [];
        const deliver = async (instance: unknown) => {
          if (!isCompiledChannel(instance)) throw new Error("Expected a compiled Linq channel.");
          const route = instance.routes.find((candidate) => candidate.method === "POST");
          if (route === undefined || !isHttpRouteDefinition(route)) {
            throw new Error("Expected the Linq webhook route.");
          }
          const pending: Promise<unknown>[] = [];
          const response = await route.handler(signedWebhook(payload), {
            ...mockAgentRouteArgs(),
            ...operations,
            from: (address) => {
              const source = operations.from(address);
              return {
                ...source,
                send: async (...args) => {
                  const delivery = await source.send(...args);
                  deliveries.push(delivery);
                  return delivery;
                },
              };
            },
            attachSession: vi.fn() as never,
            params: {},
            requestIp: null,
            to: vi.fn() as never,
            waitUntil: (task) => void pending.push(task),
          });
          expect(response.status).toBe(200);
          await Promise.all(pending);
        };

        await deliver(firstInstance);
        const [first] = deliveries;
        if (first === undefined) throw new Error("Expected the first delivery to reach eve.");
        const stream = captureTurnEvents(getRun(first.sessionId));
        try {
          await stream.nextTurn();
          await waitForParkedTurnStep(first.sessionId);

          await deliver(createChannel());

          expect(deliveries).toHaveLength(2);
          expect(deliveries[1]!.sessionId).toBe(first.sessionId);
          const outcomes = await Promise.all(
            deliveries.map(
              async (delivery) =>
                (await delivery.result({ signal: AbortSignal.timeout(5_000) })).outcome,
            ),
          );
          expect(outcomes).toEqual(["handled", "ignored"]);
          expect(turns).toBe(1);
        } finally {
          stream.dispose();
          await getRun(first.sessionId).cancel();
        }
      });
    },
    60_000,
  );
});

function signedWebhook(payload: unknown): Request {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const id = "linq-webhook-retry";
  const signature = createHmac("sha256", SIGNING_KEY)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return new Request("https://agent.example.com/eve/v1/linq", {
    body,
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-signature": `v1,${signature}`,
      "webhook-timestamp": String(timestamp),
    },
    method: "POST",
  });
}
