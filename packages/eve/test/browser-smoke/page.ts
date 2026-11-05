// The browser smoke scenario: an eve session in a page or Web Worker, on a scripted model,
// answering an approval and using the sandbox. `scripts/browser-smoke.mjs` bundles this for the
// browser and runs it in Chromium twice: the second load resumes the session from the page's
// IndexedDB World and reads the file the first load's shell wrote, which the sandbox kept in
// IndexedDB too.
import type { LanguageModelV4Prompt, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

import {
  always,
  createSession,
  defineAgent,
  defineTool,
  eve,
  indexedDbWorld,
  memorySandbox,
} from "#browser/index.js";
import { markMockModel } from "#internal/mock-model-identity.js";

interface SmokeResult {
  ok: boolean;
  phase?: string;
  sessionId?: string;
  steps: string[];
  error?: string;
}

const RESUME_PROMPT = "Still there? What does log.txt say?";

/** The query string the page or Worker was loaded with. */
function pageSearch(): string {
  const search = field(Reflect.get(globalThis, "location"), "search");
  return typeof search === "string" ? search : "";
}

/** `value[key]`, for a tool's JSON output or a global. */
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

// The scripted model's replies: eve's test helpers aren't in the package build, which `--dist`
// bundles, so the page streams its own.
const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 10, total: 10 },
  outputTokens: { reasoning: 0, text: 5, total: 5 },
};

const reply = (chunks: LanguageModelV4StreamPart[]) => ({
  stream: simulateReadableStream({ chunks }),
});

const textStreamResult = (text: string) =>
  reply([
    { type: "stream-start", warnings: [] },
    { id: "t", type: "text-start" },
    { delta: text, id: "t", type: "text-delta" },
    { id: "t", type: "text-end" },
    { finishReason: { raw: undefined, unified: "stop" }, type: "finish", usage },
  ]);

const call = (toolName: string, input: unknown) =>
  reply([
    { type: "stream-start", warnings: [] },
    { input: JSON.stringify(input), toolCallId: `call-${toolName}`, toolName, type: "tool-call" },
    { finishReason: { raw: undefined, unified: "tool-calls" }, type: "finish", usage },
  ]);

/** The tool results since the user last spoke, oldest first: JSON outputs as values, text as strings. */
function resultsSinceLastUser(
  prompt: LanguageModelV4Prompt,
): { toolName: string; output: unknown }[] {
  const lastUser = prompt.findLastIndex((message) => message.role === "user");
  return prompt
    .slice(lastUser + 1)
    .flatMap((message) => (message.role === "tool" ? message.content : []))
    .flatMap((part) =>
      part.type === "tool-result"
        ? [
            {
              output:
                part.output.type === "json" || part.output.type === "text"
                  ? part.output.value
                  : undefined,
              toolName: part.toolName,
            },
          ]
        : [],
    );
}

async function run(): Promise<SmokeResult> {
  const steps: string[] = [];
  const step = (item: string) => {
    console.log(`[smoke] ${item}`);
    steps.push(item);
  };
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        const users = prompt.filter((message) => message.role === "user");
        const results = resultsSinceLastUser(prompt);
        const last = results.at(-1);
        if (JSON.stringify(users.at(-1)).includes("Still there?")) {
          if (last === undefined) return call("read_file", { filePath: "log.txt" });
          return textStreamResult(
            `Still here: I remember ${users.length} messages from you, and log.txt reads ${JSON.stringify(field(last.output, "content") ?? "")}`,
          );
        }
        if (last === undefined) return call("deploy", { env: "prod" });
        if (last.toolName === "deploy") {
          return call("bash", {
            command:
              'echo "deployed prod" > /workspace/log.txt && wc -c < /workspace/log.txt && tr a-z A-Z < /workspace/log.txt',
          });
        }
        if (last.toolName === "bash") return call("read_file", { filePath: "log.txt" });
        const shell = results.find((result) => result.toolName === "bash");
        return textStreamResult(
          `Deployed; bash said ${JSON.stringify(shell?.output ?? "")}, and log.txt reads ${JSON.stringify(field(last.output, "content") ?? "")}`,
        );
      },
      modelId: "browser-scripted",
      provider: "eve-test",
    }),
  );
  const deployed: unknown[] = [];
  const release = defineAgent({
    // eve's own default tools (bash, read_file, write_file) in a just-bash sandbox whose files
    // live in IndexedDB, the browser's default.
    definitions: eve.defaults({ sandbox: memorySandbox(), without: ["web_fetch", "web_search"] }),
    instructions: "You deploy things carefully.",
    model,
    name: "browser-release",
    tools: {
      deploy: defineTool({
        approval: always(),
        description: "Deploy.",
        execute: async (input: Record<string, unknown>) => {
          deployed.push(input);
          return { ok: true, where: input.env };
        },
        inputSchema: { properties: { env: { type: "string" } }, type: "object" },
      }),
    },
  });
  step("agent defined");
  const identity = {
    attributes: {},
    authenticator: "browser",
    principalId: "page-user",
    principalType: "user",
  };
  const world = indexedDbWorld("eve-browser-smoke");
  const params = new URLSearchParams(pageSearch());

  if (params.get("phase") === "resume") {
    // A reloaded page: the session comes back from the page's World and goes on, in a new
    // sandbox interpreter over the files the first load left in IndexedDB.
    const sessionId = params.get("session") ?? "";
    const restored = await createSession(release, { identity, resume: sessionId, world });
    try {
      step(`restored as ${String(restored.id)}; pending: ${(await restored.pending()).length}`);
      const again = await (await restored.send(RESUME_PROMPT)).result();
      step(`reply: ${again.reply}`);
      return {
        ok:
          restored.id === sessionId &&
          again.reply ===
            'Still here: I remember 2 messages from you, and log.txt reads "1: deployed prod"',
        phase: "resume",
        sessionId,
        steps,
      };
    } finally {
      await restored.close();
    }
  }

  // The first load never closes its session: a reload ends a page without asking it, and closing
  // a session ends it, sandbox files and all (the host's dispose finalizes what it serves).
  const session = await createSession(release, { identity, world });
  {
    const asked = await (await session.send("Ship it.")).result();
    step(`asked: ${asked.interactions.map((interaction) => interaction.call?.name).join(",")}`);
    const [approval] = asked.interactions;
    if (approval === undefined || asked.interactions.length !== 1) {
      throw new Error("expected one approval");
    }
    const answered = await (
      await session.respond([{ interactionId: approval.interactionId, optionId: "approve" }])
    ).result();
    step(`reply: ${answered.reply}`);
    step(`deployed: ${JSON.stringify(deployed)}`);
    // Kept on the page's World as it ran: nothing to save.
    await session.checkpoint();
    step(`${String(session.id)} is on the page's World`);
    return {
      ok:
        answered.reply?.includes("DEPLOYED PROD") === true &&
        answered.reply.includes("deployed prod") &&
        deployed.length === 1,
      phase: "first",
      sessionId: session.id,
      steps,
    };
  }
}

// In a Web Worker the page hears the result as a message; in the page it reads a global.
const report = (result: SmokeResult) => {
  const postMessage: unknown = Reflect.get(globalThis, "postMessage");
  if ("WorkerGlobalScope" in globalThis && typeof postMessage === "function") {
    postMessage.call(globalThis, result);
  } else {
    Reflect.set(globalThis, "__eveSmoke", result);
  }
};
run().then(report, (error: unknown) =>
  report({
    error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error),
    ok: false,
    steps: [],
  }),
);
