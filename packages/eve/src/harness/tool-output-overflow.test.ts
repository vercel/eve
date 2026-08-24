import { Buffer } from "node:buffer";

import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  projectOversizedToolResults,
  type ToolOutputSpill,
  TOOL_OUTPUT_FILE_REFERENCE_KIND,
  TOOL_OUTPUT_FILES_ROOT,
} from "#harness/tool-output-overflow.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import type { AgentToolOutputDefinition } from "#shared/agent-definition.js";

const POLICY: AgentToolOutputDefinition = {
  maxInlineBytes: 32,
  overflow: "sandbox",
};

describe("projectOversizedToolResults", () => {
  it("preserves current behavior when the policy is absent", async () => {
    const sandbox = mockSandbox();
    const messages: ModelMessage[] = [
      {
        content: [
          {
            output: { type: "text", value: "x".repeat(100) },
            toolCallId: "call-large",
            toolName: "fetch",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];

    const projected = await projectOversizedToolResults({
      messages,
      policy: undefined,
      sandboxAccess: sandbox.access,
    });

    expect(projected).toBe(messages);
    expect(sandbox.writes).toEqual([]);
  });

  it("keeps small outputs inline without opening the sandbox", async () => {
    const sandbox = mockSandbox();
    const messages: ModelMessage[] = [
      {
        content: [
          {
            output: { type: "text", value: "small" },
            toolCallId: "call-small",
            toolName: "fetch",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];

    const projected = await projectOversizedToolResults({
      messages,
      policy: POLICY,
      sandboxAccess: sandbox.access,
    });

    expect(projected).toBe(messages);
    expect(sandbox.writes).toEqual([]);
  });

  it("keeps execution denials inline regardless of the byte threshold", async () => {
    const sandbox = mockSandbox();
    const messages: ModelMessage[] = [
      {
        content: [
          {
            output: {
              type: "execution-denied",
              reason: "Tool execution was denied.",
            },
            toolCallId: "call-denied",
            toolName: "bash",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];

    const projected = await projectOversizedToolResults({
      messages,
      policy: { maxInlineBytes: 1, overflow: "sandbox" },
      sandboxAccess: sandbox.access,
    });

    expect(projected).toBe(messages);
    expect(sandbox.writes).toEqual([]);
  });

  it("writes oversized discovered MCP JSON and replaces only the model-facing output", async () => {
    const sandbox = mockSandbox();
    const output = {
      content: [{ text: "x".repeat(80), type: "text" }],
      structuredContent: { result: "x".repeat(80) },
    };
    const messages: ModelMessage[] = [
      {
        content: [
          {
            output: { type: "json", value: output },
            toolCallId: "call-mcp",
            toolName: "herd__contractMetadataTool",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];

    const spills: ToolOutputSpill[] = [];
    const projected = await projectOversizedToolResults({
      messages,
      policy: POLICY,
      sandboxAccess: sandbox.access,
      onSpill: (spill) => {
        spills.push(spill);
      },
    });

    expect(sandbox.writes).toHaveLength(1);
    expect(sandbox.writes[0]?.content).toBe(JSON.stringify(output, null, 2));
    expect(sandbox.writes[0]?.path).toMatch(
      new RegExp(`^${TOOL_OUTPUT_FILES_ROOT}/[a-f0-9]{64}\\.json$`),
    );
    expect(projected).toEqual([
      {
        content: [
          {
            output: {
              type: "json",
              value: {
                bytes: Buffer.byteLength(JSON.stringify(output), "utf8"),
                kind: TOOL_OUTPUT_FILE_REFERENCE_KIND,
                path: sandbox.writes[0]?.path,
                toolName: "herd__contractMetadataTool",
              },
            },
            toolCallId: "call-mcp",
            toolName: "herd__contractMetadataTool",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ]);
    expect(spills).toEqual([
      {
        bytes: Buffer.byteLength(JSON.stringify(output), "utf8"),
        callId: "call-mcp",
        maxInlineBytes: POLICY.maxInlineBytes,
        path: sandbox.writes[0]?.path,
        spillId: sandbox.writes[0]?.path.match(/([a-f0-9]{64})\.json$/u)?.[1],
        toolName: "herd__contractMetadataTool",
      },
    ]);
  });

  it("uses one deterministic text path for replayed call ids", async () => {
    const sandbox = mockSandbox();
    const messages: ModelMessage[] = [
      {
        content: [
          {
            output: { type: "text", value: "full text ".repeat(20) },
            toolCallId: "call-replayed",
            toolName: "report",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];

    const first = await projectOversizedToolResults({
      messages,
      policy: POLICY,
      sandboxAccess: sandbox.access,
    });
    await projectOversizedToolResults({
      messages,
      policy: POLICY,
      sandboxAccess: sandbox.access,
    });
    const replayedReference = first[0]?.role === "tool" ? first[0].content[0] : undefined;

    expect(sandbox.writes).toHaveLength(2);
    expect(sandbox.writes[0]?.path).toBe(sandbox.writes[1]?.path);
    expect(sandbox.writes[0]?.path).toMatch(/\.txt$/);
    expect(sandbox.writes[0]?.content).toBe("full text ".repeat(20));
    expect(replayedReference?.type).toBe("tool-result");
  });

  it("does not overwrite a prior result when a call id is reused", async () => {
    const sandbox = mockSandbox();
    const message = (value: string): ModelMessage => ({
      content: [
        {
          output: { type: "text", value },
          toolCallId: "call-reused",
          toolName: "report",
          type: "tool-result",
        },
      ],
      role: "tool",
    });

    await projectOversizedToolResults({
      messages: [message("first ".repeat(20))],
      policy: POLICY,
      sandboxAccess: sandbox.access,
    });
    await projectOversizedToolResults({
      messages: [message("second ".repeat(20))],
      policy: POLICY,
      sandboxAccess: sandbox.access,
    });

    expect(sandbox.writes).toHaveLength(2);
    expect(sandbox.writes[0]?.path).not.toBe(sandbox.writes[1]?.path);
  });

  it("spills lookalike references with additional payload fields", async () => {
    const sandbox = mockSandbox();
    const messages: ModelMessage[] = [
      {
        content: [
          {
            output: {
              type: "json",
              value: {
                bytes: 1000,
                extra: "x".repeat(100),
                kind: TOOL_OUTPUT_FILE_REFERENCE_KIND,
                path: "/workspace/.eve/tool-results/existing.json",
                toolName: "fetch",
              },
            },
            toolCallId: "call-lookalike",
            toolName: "fetch",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];

    const projected = await projectOversizedToolResults({
      messages,
      policy: POLICY,
      sandboxAccess: sandbox.access,
    });

    expect(sandbox.writes).toHaveLength(1);
    expect(projected).not.toBe(messages);
  });

  it("keeps connection_search results inline for later dynamic-tool reconstruction", async () => {
    const sandbox = mockSandbox();
    const messages: ModelMessage[] = [
      {
        content: [
          {
            output: { type: "json", value: [{ description: "x".repeat(100) }] },
            toolCallId: "call-search",
            toolName: "connection_search",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];

    const projected = await projectOversizedToolResults({
      messages,
      policy: POLICY,
      sandboxAccess: sandbox.access,
    });

    expect(projected).toBe(messages);
    expect(sandbox.writes).toEqual([]);
  });

  it("preserves tool error semantics on an oversized error payload", async () => {
    const sandbox = mockSandbox();
    const messages: ModelMessage[] = [
      {
        content: [
          {
            output: { type: "error-text", value: "upstream failure ".repeat(20) },
            toolCallId: "call-error",
            toolName: "fetch",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];

    const projected = await projectOversizedToolResults({
      messages,
      policy: POLICY,
      sandboxAccess: sandbox.access,
    });
    const part = projected[0]?.role === "tool" ? projected[0].content[0] : undefined;

    expect(part).toMatchObject({
      output: {
        type: "error-json",
        value: { kind: TOOL_OUTPUT_FILE_REFERENCE_KIND },
      },
    });
  });

  it("does not spill an existing eve file reference again", async () => {
    const sandbox = mockSandbox();
    const messages: ModelMessage[] = [
      {
        content: [
          {
            output: {
              type: "json",
              value: {
                bytes: 1000,
                kind: TOOL_OUTPUT_FILE_REFERENCE_KIND,
                path: `/workspace/.eve/tool-results/${"a".repeat(64)}.json`,
                toolName: "fetch",
              },
            },
            toolCallId: "call-existing",
            toolName: "fetch",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];

    const projected = await projectOversizedToolResults({
      messages,
      policy: { maxInlineBytes: 1, overflow: "sandbox" },
      sandboxAccess: sandbox.access,
    });

    expect(projected).toBe(messages);
    expect(sandbox.writes).toEqual([]);
  });
});
