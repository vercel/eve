import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { declaredNow, nativeInstructions } from "./agent.js";

const facts = { finalReplyOnly: false, offersTasks: false };

function instructionsFile(logicalPath: string, name: string, content: string, role = "system") {
  return {
    content,
    logicalPath,
    name,
    owner: { kind: "application" },
    role,
    sourceId: logicalPath,
    sourceKind: "markdown",
  };
}

/** A session whose bundle declares `agent` and `turnAgent` as given. */
function sessionOf(input: {
  readonly instructions?: readonly ReturnType<typeof instructionsFile>[];
  readonly skills?: readonly { name: string; description: string; deferred?: boolean }[];
  readonly tools?: readonly { name: string; description: string }[];
  readonly workspaceSpec?: { readonly rootEntries: readonly string[] };
}): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(BundleKey, {
    resolvedAgent: {
      instructions: input.instructions ?? [],
      skills: (input.skills ?? []).map((skill) => ({ content: "", ...skill })),
    },
    subagentRegistry: { dynamicResolvers: [], entries: [] },
    turnAgent: { tools: input.tools ?? [], workspaceSpec: input.workspaceSpec },
  } as never);
  return ctx;
}

const WORKSPACE = [
  "Workspace",
  "- You have access to authored files mounted at the workspace root for this run.",
  "- The workspace root is the directory where `bash` commands start; `pwd` prints its absolute path.",
  "- Root entries under the workspace root:",
  "  - skills/",
  "- For questions about workspace paths or file availability, verify with `bash` first using commands like `pwd`, `ls`, and `find`.",
  "- If the required `bash` verification fails, report that failure directly instead of answering from this overview.",
  "- Use the `bash` tool with `ls`, `find`, and `rg` to inspect deeper contents when needed.",
  "- Do not claim these files are unavailable unless a workspace or tool call actually fails.",
].join("\n");

const TOOL_EXECUTION = [
  "Tool execution",
  "Tool calls in one response run in parallel, so batch only calls that don't depend on each other.",
].join("\n");

describe("eve's own prompt", () => {
  it("renders the agent's instructions, its workspace, the tools note, and its skills, in order", () => {
    const prompt = nativeInstructions(
      sessionOf({
        instructions: [instructionsFile("instructions.md", "instructions", "You help Alice.\n")],
        skills: [
          { description: "Research topics.", name: "research" },
          { deferred: true, description: "Rarely needed.", name: "archive" },
        ],
        tools: [{ description: "Look up a report.", name: "lookup" }],
        workspaceSpec: { rootEntries: ["skills/"] },
      }),
      facts,
    );

    expect(typeof prompt).toBe("string");
    const parts = (prompt as string).split("\n\n");
    expect(parts.slice(0, 3)).toEqual([
      "Instructions (instructions)\nYou help Alice.",
      WORKSPACE,
      TOOL_EXECUTION,
    ]);
    expect(prompt).toContain("`$HOME/.agents/skills/<skill>/`");
    expect(prompt).toContain("`skills/<skill>/` under the workspace root as the fallback");
    expect(prompt).toContain(
      "- research: Research topics. (path: $HOME/.agents/skills/research/SKILL.md)",
    );
    expect(prompt).not.toContain("archive");
  });

  it("joins the agent's system files into one block, keeping their bytes and leaving user ones out", () => {
    const prompt = nativeInstructions(
      sessionOf({
        instructions: [
          instructionsFile("instructions/a.md", "instructions/a", "  First system block.  "),
          instructionsFile("instructions/b.md", "instructions/b", "Durable user context.", "user"),
          instructionsFile("instructions/c.md", "instructions/c", "\tSecond system block.\n"),
        ],
      }),
      facts,
    );

    expect(prompt).toBe(
      "Instructions (instructions)\nFirst system block.  \n\n\tSecond system block.",
    );
  });

  it("renders nothing for an agent that declares nothing", () => {
    expect(nativeInstructions(sessionOf({}), facts)).toBe("");
  });

  it("declares each instructions file by its slug, and the agent's own as `agent`", () => {
    const files = declaredNow(
      sessionOf({
        instructions: [
          instructionsFile("instructions.md", "instructions", "You help Alice."),
          instructionsFile("instructions/house-style.md", "instructions/house-style", "Be brief."),
        ],
      }),
    );

    expect(Object.keys(files.instructions)).toEqual(["agent", "house-style"]);
    expect(files.instructions["house-style"]).toMatchObject({
      content: "Be brief.",
      role: "system",
    });
  });
});
