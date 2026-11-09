import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MockLanguageModelV4 } from "ai/test";
import { afterAll, describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { eve } from "#definitions/defaults.js";
import { codeAgent } from "#embed/agent.js";
import { createSession } from "#embed/session.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import { codeSandbox, type CodeSandbox } from "#runtime/sandbox/code-sandbox.js";
import { memorySandbox } from "#runtime/sandbox/memory-sandbox.js";
import { JustBashSandbox } from "#sandbox/providers/just-bash.js";
import { defineTool } from "#tools/definition.js";

const appRoot = await mkdtemp(join(tmpdir(), "eve-defaults-"));
afterAll(() => rm(appRoot, { force: true, recursive: true }));

const alice: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "alice",
  principalType: "user",
};

interface Step {
  readonly input: Record<string, unknown>;
  readonly toolName: string;
}

/** Makes `steps`' calls one at a time, then replies with what it was offered and each result. */
function scripted(steps: readonly Step[]) {
  return markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt, tools }) => {
        const results = prompt.flatMap((message) =>
          message.role === "tool"
            ? message.content.flatMap((part) => (part.type === "tool-result" ? [part] : []))
            : [],
        );
        const next = steps[results.length];
        if (next !== undefined) {
          return toolCallsStreamResult([
            {
              input: JSON.stringify(next.input),
              toolCallId: `call-${results.length}`,
              toolName: next.toolName,
            },
          ]);
        }
        const offered = (tools ?? []).map((tool) => tool.name).sort();
        return textStreamResult(JSON.stringify({ offered, results: results.map((r) => r.output) }));
      },
      modelId: "defaults-scripted",
      provider: "eve-test",
    }),
  );
}

interface Reply {
  readonly offered: string[];
  readonly results: { readonly type: string; readonly value: unknown }[];
}

// Writes a file, reads it back with bash, then reads it with read_file.
const noteSteps: Step[] = [
  { input: { content: "hello from eve\n", filePath: "notes.txt" }, toolName: "write_file" },
  { input: { command: "cat notes.txt | tr a-z A-Z && echo $((6 * 7))" }, toolName: "bash" },
  { input: { filePath: "notes.txt" }, toolName: "read_file" },
];

async function takeNote(name: string, sandbox: CodeSandbox): Promise<Reply> {
  const coder = codeAgent({
    definitions: eve.defaults({ sandbox, without: ["web_search"] }),
    model: { model: scripted(noteSteps), modelContextWindowTokens: 200_000 },
    name,
  });
  const session = createSession(coder, { identity: alice });
  try {
    const result = await (await session.send("Take a note, then shout it.")).result();
    expect(result.status).toBe("completed");
    return JSON.parse(result.reply ?? "{}") as Reply;
  } finally {
    await session.close();
  }
}

function expectNoteTaken(reply: Reply): void {
  expect(reply.offered).toEqual(
    expect.arrayContaining(["bash", "read_file", "write_file", "web_fetch"]),
  );
  expect(reply.offered).not.toContain("web_search");
  const [, bash, read] = reply.results;
  // What the model reads of bash: its output.
  expect(bash?.value).toBe("HELLO FROM EVE\n42\n");
  expect(JSON.stringify(read?.value)).toContain("hello from eve");
}

describe("eve.defaults() for an agent defined in code", () => {
  it("runs bash and the file tools in a memory sandbox", async () => {
    expectNoteTaken(await takeNote("memory-coder", memorySandbox()));
  });

  it("runs them in a just-bash sandbox prepared on first use", async () => {
    expectNoteTaken(
      await takeNote("just-bash-coder", codeSandbox(JustBashSandbox.environment({}), { appRoot })),
    );
  });

  it("lets the agent's own tool keep a default's name", async () => {
    const coder = codeAgent({
      definitions: eve.defaults({ sandbox: memorySandbox() }),
      model: {
        model: scripted([{ input: { command: "echo default" }, toolName: "bash" }]),
        modelContextWindowTokens: 200_000,
      },
      name: "own-bash",
      tools: {
        bash: defineTool({
          description: "The agent's own shell.",
          execute: async () => ({ mine: true }),
          inputSchema: {},
        }),
      },
    });
    const session = createSession(coder, { identity: alice });
    try {
      const reply = JSON.parse((await (await session.send("Run it.")).result()).reply ?? "{}");
      expect((reply as Reply).results[0]?.value).toEqual({ mine: true });
    } finally {
      await session.close();
    }
  });

  // A real /bin/bash in a container: opt in where a Docker daemon runs (EVE_TEST_DOCKER=1).
  it.skipIf(process.env.EVE_TEST_DOCKER !== "1")(
    "runs bash in a Docker sandbox",
    async () => {
      const { DockerSandbox } = await import("#sandbox/providers/docker.js");
      const shell = codeAgent({
        definitions: eve.defaults({
          sandbox: codeSandbox(DockerSandbox.environment({}), { appRoot }),
        }),
        model: {
          model: scripted([
            {
              input: { command: "echo $BASH_VERSION | cut -d. -f1 && uname -s" },
              toolName: "bash",
            },
          ]),
          modelContextWindowTokens: 200_000,
        },
        name: "docker-coder",
      });
      const session = createSession(shell, { identity: alice });
      try {
        const result = await (await session.send("Which shell is this?")).result();
        const reply = JSON.parse(result.reply ?? "{}") as Reply;
        expect(reply.results[0]?.value).toMatch(/^\d+\nLinux\n\[exit code: 0\]$/);
      } finally {
        await session.close();
      }
    },
    300_000,
  );
});
