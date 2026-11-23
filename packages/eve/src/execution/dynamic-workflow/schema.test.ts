import { describe, expect, it } from "vitest";

import {
  WORKFLOW_PROGRAM_MAX_SLEEP_SECONDS,
  parseWorkflowProgramOptions,
  readWorkflowProgramAgentCall,
  readWorkflowProgramAskRequest,
  readWorkflowProgramSleepSeconds,
} from "#execution/dynamic-workflow/schema.js";

const options = { maxSubagents: 7 };

describe("workflow program schema", () => {
  it("validates the trusted call budget", () => {
    expect(parseWorkflowProgramOptions(options)).toEqual(options);
    expect(() =>
      parseWorkflowProgramOptions({
        ...options,
        maxSubagents: 129,
      }),
    ).toThrow("between 1 and 128");
  });

  it("validates ctx.agent payloads including optional https files", () => {
    expect(
      readWorkflowProgramAgentCall({
        target: "researcher",
        input: {
          files: [
            {
              filename: "report.pdf",
              mediaType: "application/pdf",
              url: "https://files.example/report.pdf",
            },
          ],
          message: "continue",
          outputSchema: { properties: { ok: { type: "boolean" } }, type: "object" },
        },
      }),
    ).toEqual({
      target: "researcher",
      input: {
        files: [
          {
            filename: "report.pdf",
            mediaType: "application/pdf",
            url: "https://files.example/report.pdf",
          },
        ],
        message: "continue",
        outputSchema: { properties: { ok: { type: "boolean" } }, type: "object" },
      },
    });
    expect(() => readWorkflowProgramAgentCall({ target: "researcher", input: {} })).toThrow(
      'requires a "message" string',
    );
    expect(() =>
      readWorkflowProgramAgentCall({
        target: "researcher",
        input: { message: "hi", model: "openai/gpt-5.4" },
      }),
    ).toThrow('unknown field "model"');
    expect(() =>
      readWorkflowProgramAgentCall({
        target: "researcher",
        input: {
          files: [{ mediaType: "text/plain", url: "http://internal.example/secret.txt" }],
          message: "hi",
        },
      }),
    ).toThrow('https:// "url"');
    expect(() =>
      readWorkflowProgramAgentCall({
        target: "researcher",
        input: {
          files: [{ mediaType: "text/plain", url: "data:text/plain;base64,SGk=" }],
          message: "hi",
        },
      }),
    ).toThrow('https:// "url"');
    expect(() =>
      readWorkflowProgramAgentCall({
        target: "researcher",
        input: { extra: true, message: "hi" },
      }),
    ).toThrow('unknown field "extra"');
  });

  it("validates ctx.ask requests", () => {
    expect(
      readWorkflowProgramAskRequest({
        allowFreeform: false,
        display: "select",
        initialOptionId: "approve",
        options: [
          { description: "Ship now", id: "approve", label: "Deploy", style: "primary" },
          { id: "cancel", label: "Cancel" },
        ],
        prompt: "Deploy to production?",
        title: "Approval",
      }),
    ).toEqual({
      allowFreeform: false,
      display: "select",
      initialOptionId: "approve",
      options: [
        { description: "Ship now", id: "approve", label: "Deploy", style: "primary" },
        { id: "cancel", label: "Cancel" },
      ],
      prompt: "Deploy to production?",
      title: "Approval",
    });
    expect(() => readWorkflowProgramAskRequest({ prompt: "   " })).toThrow(
      'non-empty "prompt" string',
    );
    expect(() =>
      readWorkflowProgramAskRequest({
        display: "select",
        initialOptionId: "missing",
        options: [{ id: "a", label: "A" }],
        prompt: "Pick one",
      }),
    ).toThrow("must match one of the question's option ids");
  });

  it("validates ctx.sleep durations", () => {
    expect(readWorkflowProgramSleepSeconds(0.5)).toBe(0.5);
    expect(readWorkflowProgramSleepSeconds(WORKFLOW_PROGRAM_MAX_SLEEP_SECONDS)).toBe(
      WORKFLOW_PROGRAM_MAX_SLEEP_SECONDS,
    );
    expect(() => readWorkflowProgramSleepSeconds(0)).toThrow("greater than 0");
    expect(() => readWorkflowProgramSleepSeconds(-1)).toThrow("greater than 0");
    expect(() => readWorkflowProgramSleepSeconds(Number.NaN)).toThrow("finite number");
    expect(() => readWorkflowProgramSleepSeconds(WORKFLOW_PROGRAM_MAX_SLEEP_SECONDS + 1)).toThrow(
      String(WORKFLOW_PROGRAM_MAX_SLEEP_SECONDS),
    );
  });
});
