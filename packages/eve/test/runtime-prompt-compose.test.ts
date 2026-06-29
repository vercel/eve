import { describe, expect, it } from "vitest";
import { composeRuntimeBasePrompt } from "../src/runtime/prompt/compose.js";

describe("composeRuntimeBasePrompt", () => {
  it("composes the authored instructions prompt into one runtime instruction block", () => {
    expect(
      composeRuntimeBasePrompt({
        instructions: {
          name: "instructions",
          logicalPath: "instructions.md",
          markdown: "You are a weather assistant.\n",
          sourceId: "instructions.md",
          sourceKind: "markdown",
        },
      }),
    ).toEqual(["Instructions (instructions)\nYou are a weather assistant."]);
  });

  it("adds a parallel tool execution instruction when tools are available", () => {
    expect(
      composeRuntimeBasePrompt({
        toolsAvailable: true,
      }),
    ).toEqual([
      [
        "Tool execution",
        "A single tool or subagent call runs as one serial action. If you call multiple independent tools or subagents in one response, eve treats that batch as parallel work. Only batch work that is independent and does not rely on another call in the same response.",
      ].join("\n"),
    ]);
  });

  it("drops the instructions block when the authored markdown normalizes to empty", () => {
    expect(
      composeRuntimeBasePrompt({
        instructions: {
          name: "instructions",
          logicalPath: "instructions.md",
          markdown: "   \n",
          sourceId: "instructions.md",
          sourceKind: "markdown",
        },
      }),
    ).toEqual([]);
  });

  it("adds a shallow workspace awareness section when authored project files are mounted", () => {
    expect(
      composeRuntimeBasePrompt({
        workspaceSpec: { rootEntries: ["skills/"] },
      }),
    ).toEqual([
      [
        "Workspace",
        "- You have access to authored files mounted at the workspace root for this run.",
        "- The live workspace root visible to `bash` in this run is `/workspace`.",
        "- Root entries under /workspace/:",
        "  - skills/",
        "- Treat `/workspace` as the workspace root for this run unless a `bash` call shows otherwise.",
        "- For questions about workspace paths or file availability, verify with `bash` first using commands like `pwd`, `ls`, and `find`.",
        "- If the required `bash` verification fails, report that failure directly instead of answering from this overview.",
        "- Use the `bash` tool with `ls`, `find`, and `rg` to inspect deeper contents when needed.",
        "- Do not claim these files are unavailable unless a workspace or tool call actually fails.",
      ].join("\n"),
    ]);
  });

  it("does not inject runtime-owned delivery or sandbox guidance", () => {
    expect(composeRuntimeBasePrompt({})).toEqual([]);
  });

  it("orders workspace and tool execution sections predictably", () => {
    expect(
      composeRuntimeBasePrompt({
        toolsAvailable: true,
        workspaceSpec: { rootEntries: ["skills/"] },
      }),
    ).toEqual([
      [
        "Workspace",
        "- You have access to authored files mounted at the workspace root for this run.",
        "- The live workspace root visible to `bash` in this run is `/workspace`.",
        "- Root entries under /workspace/:",
        "  - skills/",
        "- Treat `/workspace` as the workspace root for this run unless a `bash` call shows otherwise.",
        "- For questions about workspace paths or file availability, verify with `bash` first using commands like `pwd`, `ls`, and `find`.",
        "- If the required `bash` verification fails, report that failure directly instead of answering from this overview.",
        "- Use the `bash` tool with `ls`, `find`, and `rg` to inspect deeper contents when needed.",
        "- Do not claim these files are unavailable unless a workspace or tool call actually fails.",
      ].join("\n"),
      [
        "Tool execution",
        "A single tool or subagent call runs as one serial action. If you call multiple independent tools or subagents in one response, eve treats that batch as parallel work. Only batch work that is independent and does not rely on another call in the same response.",
      ].join("\n"),
    ]);
  });
});
