import { afterEach, describe, expect, it, vi } from "vitest";

import type { BootstrapGenerateResult } from "#runtime/agent/bootstrap-model-utils.js";
import {
  createMockAuthoredRuntimeModel,
  shouldMockAuthoredRuntimeModels,
} from "#runtime/agent/mock-model-adapter.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

async function generateWithPrompt(
  prompt: unknown,
  tools: readonly unknown[] = [],
  options: Record<string, unknown> = {},
) {
  const model = createMockAuthoredRuntimeModel({
    id: "mock-model-adapter-test",
  } as never);
  const generate = model as unknown as {
    doGenerate(input: { prompt: unknown; tools: readonly unknown[] }): Promise<unknown>;
  };

  return (await generate.doGenerate({
    prompt,
    tools,
    ...options,
  })) as BootstrapGenerateResult;
}

describe("createMockAuthoredRuntimeModel", () => {
  it("activates for the explicit spawned-server test seam", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EVE_MOCK_AUTHORED_MODELS", "1");

    expect(shouldMockAuthoredRuntimeModels()).toBe(true);
  });

  it("emits a message-only input for delegated agent calls", async () => {
    const result = await generateWithPrompt(
      [
        {
          content: "Delegate to a subagent: use the wait_for_cancel tool.",
          role: "user",
        },
      ],
      [
        {
          inputSchema: {
            additionalProperties: false,
            properties: {
              message: { type: "string" },
            },
            required: ["message"],
            type: "object",
          },
          name: "agent",
          type: "function",
        },
      ],
    );

    expect(result.content).toEqual([
      {
        input: JSON.stringify({
          message: "use the wait_for_cancel tool.",
        }),
        toolCallId: "call_agent",
        toolName: "agent",
        type: "tool-call",
      },
    ]);
  });

  it("activates a matching skill when the available skill line includes a skill path", async () => {
    const result = await generateWithPrompt([
      {
        content: [
          "Available skills\n",
          "Listed skills are available in this run.\n",
          "- weather-skill: Use the weather tool before answering forecast or temperature questions. (path: /home/agent/.agents/skills/weather-skill/SKILL.md)",
        ].join(""),
        role: "system",
      },
      {
        content: "What is the weather in Brooklyn?",
        role: "user",
      },
    ]);

    expect(result.finishReason).toEqual({ raw: undefined, unified: "tool-calls" });
    expect(result.content).toEqual([
      {
        input: JSON.stringify({ skill: "weather-skill" }),
        toolCallId: "call_load_skill",
        toolName: "load_skill",
        type: "tool-call",
      },
    ]);
  });

  it("does not treat the available skills menu as a prompt-layer label", async () => {
    const result = await generateWithPrompt([
      {
        content: [
          "Available skills\n",
          "Listed skills are available in this run.\n",
          "- research: Research unfamiliar topics before answering with confidence. (path: /home/agent/.agents/skills/research/SKILL.md)",
        ].join(""),
        role: "system",
      },
      {
        content: "Hello there",
        role: "user",
      },
    ]);

    expect(result.finishReason).toEqual({ raw: undefined, unified: "stop" });
    expect(result.content).toEqual([
      {
        text: "Bootstrap reply: Hello there",
        type: "text",
      },
    ]);
  });

  it("discovers skills announced in later system history messages", async () => {
    const result = await generateWithPrompt([
      {
        content: [
          "Available skills\n",
          "Listed skills are available in this run.\n",
          "- release: Use for release checklist requests. (path: /home/agent/.agents/skills/release/SKILL.md)",
        ].join(""),
        role: "system",
      },
      {
        content: [
          "Available skills\n",
          "Listed skills are available in this run.\n",
          "- tenant-weather: Use tenant weather policy before answering forecast questions. (path: /home/agent/.agents/skills/tenant-weather/SKILL.md)",
        ].join(""),
        role: "system",
      },
      {
        content: "What is the weather in Brooklyn?",
        role: "user",
      },
    ]);

    expect(result.finishReason).toEqual({ raw: undefined, unified: "tool-calls" });
    expect(result.content).toEqual([
      {
        input: JSON.stringify({ skill: "tenant-weather" }),
        toolCallId: "call_load_skill",
        toolName: "load_skill",
        type: "tool-call",
      },
    ]);
  });

  it("discovers skills advertised inside larger static instruction text", async () => {
    const result = await generateWithPrompt([
      {
        content: [
          "# Identity",
          "",
          "You are a helpful assistant.",
          "",
          "Available skills",
          "Listed skills are available in this run.",
          "- echo-marker: Use when the user asks for the echo marker. (path: /home/agent/.agents/skills/echo-marker/SKILL.md)",
          "",
          "Another section that must not be parsed as skills.",
        ].join("\n"),
        role: "system",
      },
      {
        content: "Please use the echo marker skill and follow its instructions exactly.",
        role: "user",
      },
    ]);

    expect(result.finishReason).toEqual({ raw: undefined, unified: "tool-calls" });
    expect(result.content).toEqual([
      {
        input: JSON.stringify({ skill: "echo-marker" }),
        toolCallId: "call_load_skill",
        toolName: "load_skill",
        type: "tool-call",
      },
    ]);
  });

  it("does not reload a skill already loaded earlier in the session", async () => {
    const result = await generateWithPrompt([
      {
        content: [
          "Available skills",
          "Listed skills are available in this run.",
          "- echo-marker: Use when the user asks for the echo marker. (path: /home/agent/.agents/skills/echo-marker/SKILL.md)",
        ].join("\n"),
        role: "system",
      },
      {
        content: "Please use the echo marker skill and follow its instructions exactly.",
        role: "user",
      },
      {
        content: [
          {
            input: JSON.stringify({ skill: "echo-marker" }),
            toolCallId: "call_load_skill",
            toolName: "load_skill",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            output: {
              type: "json",
              value: "Reply with exactly the following text and nothing else:\nskill-echo-ok-V1",
            },
            toolCallId: "call_load_skill",
            toolName: "load_skill",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ]);

    expect(result.finishReason).toEqual({ raw: undefined, unified: "stop" });
    expect(result.content).toEqual([
      {
        text: "skill-echo-ok-V1",
        type: "text",
      },
    ]);
  });

  it("never matches load_skill by explicit name in the user message", async () => {
    const result = await generateWithPrompt(
      [
        {
          content: 'Call the load_skill tool with skill "echo-marker".',
          role: "user",
        },
      ],
      [
        {
          inputSchema: {
            properties: { skill: { type: "string" } },
            required: ["skill"],
            type: "object",
          },
          name: "load_skill",
          type: "function",
        },
      ],
    );

    expect(result.finishReason).toEqual({ raw: undefined, unified: "stop" });
    expect(result.content).toEqual([
      {
        text: 'Bootstrap reply: Call the load_skill tool with skill "echo-marker".',
        type: "text",
      },
    ]);
  });

  it("builds ask_question input from question text and option labels", async () => {
    const result = await generateWithPrompt(
      [
        {
          content: [
            "Use the ask_question tool exactly once.",
            "Set question to: 'Pick a color.'",
            'Provide exactly two options: label "Red" and label "Blue".',
          ].join("\n"),
          role: "user",
        },
      ],
      [
        {
          inputSchema: {
            properties: {
              options: { type: "array" },
              question: { type: "string" },
            },
            type: "object",
          },
          name: "ask_question",
          type: "function",
        },
      ],
    );

    expect(result.finishReason).toEqual({ raw: undefined, unified: "tool-calls" });
    expect(result.content).toEqual([
      {
        input: JSON.stringify({
          question: "Pick a color.",
          options: [
            { description: "Choose Red.", label: "Red" },
            { description: "Choose Blue.", label: "Blue" },
          ],
        }),
        toolCallId: "call_ask_question",
        toolName: "ask_question",
        type: "tool-call",
      },
    ]);
  });

  it("builds bash command input from a backticked command", async () => {
    const result = await generateWithPrompt(
      [
        {
          content: "Run the bash command `cat /workspace/smoke-marker.txt`.",
          role: "user",
        },
      ],
      [
        {
          inputSchema: {
            properties: {
              command: { type: "string" },
            },
            type: "object",
          },
          name: "bash",
          type: "function",
        },
      ],
    );

    expect(result.finishReason).toEqual({ raw: undefined, unified: "tool-calls" });
    expect(result.content).toEqual([
      {
        input: JSON.stringify({ command: "cat /workspace/smoke-marker.txt" }),
        toolCallId: "call_bash",
        toolName: "bash",
        type: "tool-call",
      },
    ]);
  });

  it("builds anchored string inputs from quoted spans following the property name", async () => {
    const result = await generateWithPrompt(
      [
        {
          content:
            "Call the `structured-echo` tool exactly once with label `schedule-markdown-ok-Q7M3`.",
          role: "user",
        },
      ],
      [
        {
          inputSchema: {
            properties: {
              label: { type: "string" },
            },
            type: "object",
          },
          name: "structured-echo",
          type: "function",
        },
      ],
    );

    expect(result.finishReason).toEqual({ raw: undefined, unified: "tool-calls" });
    expect(result.content).toEqual([
      {
        input: JSON.stringify({ label: "schedule-markdown-ok-Q7M3" }),
        toolCallId: "call_structured_echo",
        toolName: "structured-echo",
        type: "tool-call",
      },
    ]);
  });

  it("anchors multiple quoted properties and ignores unquoted ones", async () => {
    const result = await generateWithPrompt(
      [
        {
          content: `Use the always-throws tool with reason 'smoke' and note: "extra".`,
          role: "user",
        },
      ],
      [
        {
          inputSchema: {
            properties: {
              note: { type: "string" },
              reason: { type: "string" },
            },
            type: "object",
          },
          name: "always-throws",
          type: "function",
        },
      ],
    );

    expect(result.content).toEqual([
      {
        input: JSON.stringify({ note: "extra", reason: "smoke" }),
        toolCallId: "call_always_throws",
        toolName: "always-throws",
        type: "tool-call",
      },
    ]);
  });

  it("keeps the city heuristic when no anchored property matches", async () => {
    const result = await generateWithPrompt(
      [
        {
          content: "Use the get_weather tool to check the weather in Lisbon.",
          role: "user",
        },
      ],
      [
        {
          inputSchema: {
            properties: {
              city: { type: "string" },
            },
            type: "object",
          },
          name: "get_weather",
          type: "function",
        },
      ],
    );

    expect(result.content).toEqual([
      {
        input: JSON.stringify({ city: "Lisbon" }),
        toolCallId: "call_get_weather",
        toolName: "get_weather",
        type: "tool-call",
      },
    ]);
  });

  it("builds empty input for an explicitly empty object schema", async () => {
    const result = await generateWithPrompt(
      [
        {
          content: "Use the wait_for_cancel tool.",
          role: "user",
        },
      ],
      [
        {
          inputSchema: {
            additionalProperties: false,
            properties: {},
            type: "object",
          },
          name: "wait_for_cancel",
          type: "function",
        },
      ],
    );

    expect(result.content).toEqual([
      {
        input: JSON.stringify({}),
        toolCallId: "call_wait_for_cancel",
        toolName: "wait_for_cancel",
        type: "tool-call",
      },
    ]);
  });

  it("replies with exact fixture text from system context", async () => {
    const result = await generateWithPrompt([
      {
        content:
          "When you reply to the next user message, include the exact token ambient-ok-M3K8 verbatim.",
        role: "system",
      },
      {
        content: [
          "Skill (dynamic-tenant-policy)",
          "Reply with exactly the following text and nothing else:",
          "skill-policy-ok-P4K9",
        ].join("\n"),
        role: "system",
      },
      {
        content: "Please use the dynamic tenant policy skill.",
        role: "user",
      },
    ]);

    expect(result.finishReason).toEqual({ raw: undefined, unified: "stop" });
    expect(result.content).toEqual([
      {
        text: "skill-policy-ok-P4K9",
        type: "text",
      },
    ]);
  });

  it("prefers loaded skill exact text over ambient instruction tokens", async () => {
    const result = await generateWithPrompt([
      {
        content:
          "When you reply to the next user message, include the exact token ambient-ok-M3K8 verbatim.",
        role: "system",
      },
      {
        content: [
          {
            output: {
              type: "text",
              value: [
                "Skill (dynamic-tenant-policy)",
                "Reply with exactly the following text and nothing else:",
                "loaded-skill-ok-P4K9",
              ].join("\n"),
            },
            toolCallId: "call_load_skill",
            toolName: "load_skill",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
      {
        content: "Please use the dynamic tenant policy skill.",
        role: "user",
      },
    ]);

    expect(result.finishReason).toEqual({ raw: undefined, unified: "stop" });
    expect(result.content).toEqual([
      {
        text: "loaded-skill-ok-P4K9",
        type: "text",
      },
    ]);
  });

  it("honors exact-token directives delivered as trailing user context", async () => {
    const result = await generateWithPrompt([
      {
        content: "include the exact token clientctx-ok-W7R2 verbatim",
        role: "user",
      },
      {
        content: "Say hello.",
        role: "user",
      },
    ]);

    expect(result.content).toEqual([
      {
        text: "clientctx-ok-W7R2",
        type: "text",
      },
    ]);
  });

  it("does not leak exact-token directives from earlier turns", async () => {
    const result = await generateWithPrompt([
      {
        content: "include the exact token stale-ok-Q9Z1 verbatim",
        role: "user",
      },
      {
        content: "stale-ok-Q9Z1",
        role: "assistant",
      },
      {
        content: "Say hello again.",
        role: "user",
      },
    ]);

    expect(result.content).toEqual([
      {
        text: "Bootstrap reply: Say hello again.",
        type: "text",
      },
    ]);
  });

  it("replies with exact string instructions from system context", async () => {
    const result = await generateWithPrompt([
      {
        content:
          "You are a fixture. Reply with the exact string `system-exact-ok-Q8V3` and nothing else.",
        role: "system",
      },
      {
        content: "Please follow the system instruction.",
        role: "user",
      },
    ]);

    expect(result.finishReason).toEqual({ raw: undefined, unified: "stop" });
    expect(result.content).toEqual([
      {
        text: "system-exact-ok-Q8V3",
        type: "text",
      },
    ]);
  });

  it("replies with exact token instructions from system context", async () => {
    const result = await generateWithPrompt([
      {
        content:
          "When you reply to the next user message, include the exact token ambient-only-ok-J5W1 verbatim somewhere in your response.",
        role: "system",
      },
      {
        content: "Please follow the system instruction.",
        role: "user",
      },
    ]);

    expect(result.finishReason).toEqual({ raw: undefined, unified: "stop" });
    expect(result.content).toEqual([
      {
        text: "ambient-only-ok-J5W1",
        type: "text",
      },
    ]);
  });

  it("chains the smoke-test lookup tool pair under the authored-model mock", async () => {
    const tools = [
      {
        description: "Returns a deterministic stepKey.",
        name: "lookup-step-a",
        type: "function",
      },
      {
        description: "Returns the final value for a stepKey.",
        name: "lookup-step-b",
        type: "function",
      },
    ];
    const prompt = [
      {
        content:
          "Call lookup-step-a with topic instrumentation, then call lookup-step-b with the returned stepKey.",
        role: "user",
      },
    ];

    const firstResult = await generateWithPrompt(prompt, tools);
    expect(firstResult.finishReason).toEqual({ raw: undefined, unified: "tool-calls" });
    expect(firstResult.content).toEqual([
      {
        input: JSON.stringify({ topic: "instrumentation" }),
        toolCallId: "call_lookup_step_a",
        toolName: "lookup-step-a",
        type: "tool-call",
      },
    ]);

    const secondResult = await generateWithPrompt(
      [
        ...prompt,
        {
          content: [
            {
              output: { type: "json", value: { stepKey: "K-9F2X" } },
              toolCallId: "call_lookup_step_a",
              toolName: "lookup-step-a",
              type: "tool-result",
            },
          ],
          role: "tool",
        },
      ],
      tools,
    );
    expect(secondResult.finishReason).toEqual({ raw: undefined, unified: "tool-calls" });
    expect(secondResult.content).toEqual([
      {
        input: JSON.stringify({ stepKey: "K-9F2X" }),
        toolCallId: "call_lookup_step_b",
        toolName: "lookup-step-b",
        type: "tool-call",
      },
    ]);
  });

  // Regression: the [Tasks] note is user-role scaffolding injected
  // after a subagent settles. Treating it as a turn boundary masked the tool
  // result, and the adapter re-issued the same deterministic tool call — a
  // duplicate start operation that fatally failed the parent session in the
  // mock world suites.
  it("replies to a tool result behind a framework [Tasks] note instead of re-calling", async () => {
    const result = await generateWithPrompt(
      [
        {
          content: "Call conditional-marker exactly once.",
          role: "user",
        },
        {
          content: [
            {
              input: JSON.stringify({ message: "run" }),
              toolCallId: "call_conditional_marker",
              toolName: "conditional-marker",
              type: "tool-call",
            },
          ],
          role: "assistant",
        },
        {
          content: [
            {
              output: { type: "json", value: "DYNAMIC_SUBAGENT_ENABLED" },
              toolCallId: "call_conditional_marker",
              toolName: "conditional-marker",
              type: "tool-result",
            },
          ],
          role: "tool",
        },
        {
          content:
            '[Tasks]\n<tasks>\n</tasks>\n<idle_agents>\n<agent id="conditional-marker-5ae9bf" name="conditional-marker">DYNAMIC_SUBAGENT_ENABLED</agent>\n</idle_agents>',
          role: "user",
        },
      ],
      [
        {
          inputSchema: {
            properties: { message: { type: "string" } },
            required: ["message"],
            type: "object",
          },
          name: "conditional-marker",
          type: "function",
        },
      ],
    );

    expect(result.finishReason).toEqual({ raw: undefined, unified: "stop" });
    expect(result.content).toEqual([
      {
        text: 'Used conditional-marker for "Call conditional-marker exactly once.": DYNAMIC_SUBAGENT_ENABLED',
        type: "text",
      },
    ]);
  });

  it("waits on every receipt of the last step with one task_wait each", async () => {
    const receipt = (callId: string, taskId: string) => ({
      output: { type: "text", value: `Started task ${taskId}. Use task_wait for its result.` },
      toolCallId: callId,
      toolName: "deploy_service",
      type: "tool-result",
    });
    const result = await generateWithPrompt(
      [
        { content: "Run deploy_service twice.", role: "user" },
        {
          content: [
            receipt("call_a", "deploy_service-a1b2c3"),
            receipt("call_b", "deploy_service-d4e5f6"),
          ],
          role: "tool",
        },
      ],
      [
        { inputSchema: { type: "object" }, name: "deploy_service", type: "function" },
        { inputSchema: { type: "object" }, name: "task_wait", type: "function" },
      ],
    );

    expect(result.content).toEqual([
      {
        input: JSON.stringify({ taskId: "deploy_service-a1b2c3" }),
        toolCallId: "call_task_wait_call_a",
        toolName: "task_wait",
        type: "tool-call",
      },
      {
        input: JSON.stringify({ taskId: "deploy_service-d4e5f6" }),
        toolCallId: "call_task_wait_call_b",
        toolName: "task_wait",
        type: "tool-call",
      },
    ]);
  });

  it("gives a wait on a resumed agent a call ID of its own", async () => {
    // Alice's researcher answered once; she asked it again, so the new receipt keeps its task ID.
    const researcher = "researcher-7k2m9q";
    const result = await generateWithPrompt(
      [
        { content: "Ask the researcher about pricing.", role: "user" },
        {
          content: [
            {
              output: {
                type: "text",
                value: `Started task ${researcher}. Use task_wait for its result.`,
              },
              toolCallId: "call_first",
              toolName: "researcher",
              type: "tool-result",
            },
          ],
          role: "tool",
        },
        {
          content: [
            {
              output: {
                type: "text",
                value: `<task_result id="${researcher}" name="researcher" status="completed">\nPricing notes.\n</task_result>`,
              },
              toolCallId: "call_task_wait_call_first",
              toolName: "task_wait",
              type: "tool-result",
            },
          ],
          role: "tool",
        },
        { content: "Now ask it about packaging.", role: "user" },
        {
          content: [
            {
              output: {
                type: "text",
                value: `Started task ${researcher}. Use task_wait for its result.`,
              },
              toolCallId: "call_second",
              toolName: "researcher",
              type: "tool-result",
            },
          ],
          role: "tool",
        },
      ],
      [
        { inputSchema: { type: "object" }, name: "researcher", type: "function" },
        { inputSchema: { type: "object" }, name: "task_wait", type: "function" },
      ],
    );

    expect(result.content).toEqual([
      {
        input: JSON.stringify({ taskId: researcher }),
        toolCallId: "call_task_wait_call_second",
        toolName: "task_wait",
        type: "tool-call",
      },
    ]);
  });

  it("replies to a settled task_wait as the result of the call that started the task", async () => {
    const result = await generateWithPrompt([
      { content: "Run deploy_service.", role: "user" },
      {
        content: [
          {
            output: {
              type: "text",
              value: [
                '<task_result id="deploy_service-a1b2c3" name="deploy_service" status="completed">',
                '{\n  "service": "api"\n}',
                "</task_result>",
              ].join("\n"),
            },
            toolCallId: "call_task_wait",
            toolName: "task_wait",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ]);

    expect(result.content).toEqual([
      { text: 'Used deploy_service for "Run deploy_service.": {"service":"api"}', type: "text" },
    ]);
  });

  it("reads a result that arrived in a task.result message instead of waiting again", async () => {
    const result = await generateWithPrompt(
      [
        { content: "Run deploy_service.", role: "user" },
        {
          content: [
            {
              output: {
                type: "text",
                value: "Started task deploy_service-a1b2c3. Use task_wait for its result.",
              },
              toolCallId: "call_deploy_service",
              toolName: "deploy_service",
              type: "tool-result",
            },
          ],
          role: "tool",
        },
        {
          content: [
            '<task_result id="deploy_service-a1b2c3" name="deploy_service" status="completed">',
            "ready",
            "</task_result>",
          ].join("\n"),
          role: "user",
        },
      ],
      [
        { inputSchema: { type: "object" }, name: "deploy_service", type: "function" },
        { inputSchema: { type: "object" }, name: "task_wait", type: "function" },
      ],
    );

    expect(result.content).toEqual([
      { text: 'Used deploy_service for "Run deploy_service.": ready', type: "text" },
    ]);
  });

  it("does not reuse a prior turn's tool result after a later user message", async () => {
    const result = await generateWithPrompt([
      {
        content: [
          {
            output: { type: "json", value: { ok: true, value: "prior" } },
            toolCallId: "call_lookup_step_b",
            toolName: "lookup-step-b",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
      {
        content: "Acknowledge the current turn.",
        role: "user",
      },
    ]);

    expect(result.finishReason).toEqual({ raw: undefined, unified: "stop" });
    expect(result.content).toEqual([
      {
        text: "Bootstrap reply: Acknowledge the current turn.",
        type: "text",
      },
    ]);
  });

  it("calls an explicit list of authored tools in parallel", async () => {
    const result = await generateWithPrompt(
      [
        {
          content: [
            "Call tools in parallel: local-sleeper, remote-sleeper",
            'message: "Use wait-for-cancel."',
          ].join("\n"),
          role: "user",
        },
      ],
      ["local-sleeper", "remote-sleeper"].map((name) => ({
        inputSchema: {
          properties: { message: { type: "string" } },
          required: ["message"],
          type: "object",
        },
        name,
        type: "function",
      })),
    );

    expect(result.finishReason).toEqual({ raw: undefined, unified: "tool-calls" });
    expect(result.content).toEqual(
      ["local-sleeper", "remote-sleeper"].map((name) => ({
        input: JSON.stringify({ message: "Use wait-for-cancel." }),
        toolCallId: `call_${name.replaceAll("-", "_")}`,
        toolName: name,
        type: "tool-call",
      })),
    );
  });

  it("calls final_output with a schema-shaped sample when the tool is offered", async () => {
    const result = await generateWithPrompt(
      [{ content: "Summarize this", role: "user" }],
      [
        {
          name: "final_output",
          type: "function",
          description: "Deliver your final answer.",
          inputSchema: {
            properties: {
              count: { type: "integer" },
              title: { type: "string" },
            },
            required: ["title", "count"],
            type: "object",
          },
        },
      ],
    );

    expect(result.finishReason).toEqual({ raw: undefined, unified: "tool-calls" });
    expect(result.content).toEqual([
      {
        input: JSON.stringify({ title: "structured-output", count: 1 }),
        toolCallId: expect.any(String),
        toolName: "final_output",
        type: "tool-call",
      },
    ]);
  });
});
