import { describe, expect, it } from "vitest";

import { createChannelOperations } from "#channel/channel-operations.js";
import { isCompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { workflowEntry } from "#execution/session/entry.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { buildWorkflowToolSerializedContext } from "#internal/testing/workflow-tool-run-harness.js";
import { start } from "#internal/workflow/runtime.js";
import { telegramContinuationToken } from "#public/channels/telegram/api.js";
import { telegramChannel } from "#public/channels/telegram/index.js";
import { initialTelegramState } from "#public/channels/telegram/state.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { askQuestion } from "#tools/provided/ask-question.js";

const SECRET = "telegram-secret";
const CHAT_ID = "42";

interface TelegramApiCall {
  readonly body: Record<string, unknown>;
  readonly method: string;
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 15_000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describe("telegram channel", () => {
  it("answers an ask_question question when its inline button is pressed", async () => {
    const calls: TelegramApiCall[] = [];
    const channel = telegramChannel({
      api: {
        fetch: async (input, init) => {
          const method = String(input).split("/").at(-1)!;
          calls.push({ body: JSON.parse(String(init?.body ?? "{}")), method });
          return Response.json({
            ok: true,
            result: { chat: { id: 42, type: "private" }, date: 0, message_id: calls.length },
          });
        },
      },
      credentials: { botToken: "bot-token", webhookSecretToken: SECRET },
    });
    if (!isCompiledChannel(channel)) throw new Error("Expected a compiled Telegram channel.");
    const route = channel.routes.find((candidate) => candidate.method === "POST");
    if (route === undefined || !isHttpRouteDefinition(route)) {
      throw new Error("Expected the Telegram webhook route.");
    }
    const runtime = await createTestRuntime({
      agent: { name: "telegram-ask-question" },
      modules: [
        {
          logicalPath: "tools/ask_question.ts",
          loadNamespace: async () => ({ default: askQuestion() }),
        },
        { logicalPath: "channels/telegram.ts", loadNamespace: async () => ({ default: channel }) },
      ],
    });

    await runtime.run(async () => {
      const bundle = await getCompiledRuntimeAgentBundle({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      });
      const adapter = bundle.graph.root.channels.find(
        (entry) => entry.name === "telegram",
      )?.adapter;
      if (adapter === undefined) throw new Error("Expected the Telegram adapter.");
      // Channel addresses namespace their token with the channel name.
      const continuationToken = `telegram:${telegramContinuationToken({ chatId: CHAT_ID })}`;
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: {
            message:
              'Use ask_question and set question to: "When?" with label "Saturday" and label "Sunday".',
          },
          serializedContext: {
            ...buildWorkflowToolSerializedContext({ continuationToken, requestInput: true }),
            "eve.channel": {
              kind: adapter.kind,
              state: {
                ...initialTelegramState(undefined),
                chatId: CHAT_ID,
                chatType: "private",
                triggeringUserId: CHAT_ID,
              },
            },
          },
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        const asked = await withTimeout(stream.nextTurn(), "the question");
        expect(filterEventsByType(asked, "input.requested")).toHaveLength(1);
        expect(asked.at(-1)?.type).toBe("turn.waiting");

        const question = calls.find(
          (call) => call.method === "sendMessage" && call.body.text === "When?",
        );
        const keyboard = (
          question?.body.reply_markup as
            | { inline_keyboard: { callback_data: string; text: string }[][] }
            | undefined
        )?.inline_keyboard.flat();
        const saturday = keyboard?.find((button) => button.text === "Saturday");
        expect(saturday?.callback_data).toMatch(/^eve:/);

        const operations = createChannelOperations<unknown>({
          adapter,
          channelName: "telegram",
          runtime: createWorkflowRuntime({
            compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
          }),
        });
        const pending: Promise<unknown>[] = [];
        const response = await route.handler(
          new Request("https://agent.example.com/eve/v1/telegram", {
            body: JSON.stringify({
              callback_query: {
                data: saturday!.callback_data,
                from: { id: 42, is_bot: false },
                id: "cb-saturday",
                message: { chat: { id: 42, type: "private" }, date: 0, message_id: 1 },
              },
              update_id: 2,
            }),
            headers: {
              "content-type": "application/json",
              "x-telegram-bot-api-secret-token": SECRET,
            },
            method: "POST",
          }),
          {
            ...operations,
            attachSession: (() => undefined) as never,
            params: {},
            requestIp: null,
            to: (() => undefined) as never,
            waitUntil: (task) => void pending.push(task),
          },
        );
        expect(response.status).toBe(200);
        await Promise.all(pending);

        const answered = await withTimeout(stream.nextTurn(), "the pressed answer");
        const result = filterEventsByType(answered, "action.result").find(
          (event) =>
            event.data.result.kind === "tool-result" &&
            event.data.result.toolName === "ask_question",
        );
        expect(JSON.parse(String(result?.data.result.output))).toMatchObject({
          answer: "Saturday",
          status: "answered",
        });
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 60_000);
});
