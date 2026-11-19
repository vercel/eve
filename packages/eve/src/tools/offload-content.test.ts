import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SandboxKey } from "#context/keys.js";
import { toolCallModelOutput } from "#harness/tool-call-io.js";
import { toolModelOutputContext } from "#harness/tool-model-output.js";
import { captureLogRecords } from "#internal/testing/log-records.js";
import type { SandboxAccess } from "#sandbox/state.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import {
  toolOutput,
  toolOutputPart,
  type ToolModelOutput,
  type ToolModelOutputContext,
} from "#tools/model-output.js";
import { offloadContent } from "#tools/offload-content.js";

function fakeSandbox() {
  const { access, files } = mockSandbox();
  return { access, files };
}

function inContext<T>(access: SandboxAccess | undefined, run: () => Promise<T>): Promise<T> {
  const context = new ContextContainer();
  if (access !== undefined) context.setVirtualContext(SandboxKey, access);
  return contextStorage.run(context, run);
}

const issues = Array.from({ length: 50 }, (_, index) => ({
  body: "x".repeat(200),
  number: index,
  state: index % 2 === 0 ? "open" : "closed",
  title: `Issue ${index}`,
}));
const big = JSON.stringify(issues);

describe("offloadContent", () => {
  it("returns the default projection when the result is under the limit", async () => {
    const { access, files } = fakeSandbox();
    const toModelOutput = offloadContent({ maxBytes: 400_000 });
    const result = await inContext(access, () =>
      toModelOutput(issues, toolModelOutputContext("list_issues", "call_1")),
    );
    expect(result).toEqual({ type: "json", value: issues });
    expect(files.size).toBe(0);
  });

  it("writes the raw output to the sandbox and returns a note when over the limit", async () => {
    const { access, files } = fakeSandbox();
    const toModelOutput = offloadContent({ maxBytes: 4_000 });
    const result = await inContext(access, () =>
      toModelOutput(issues, toolModelOutputContext("github__list_issues", "call_abc")),
    );
    const path = "/tmp/.eve/tool-results/github__list_issues-call_abc.json";
    expect(files.get(path)).toBe(big);
    const bytes = Buffer.byteLength(big);
    expect(result).toEqual({
      type: "text",
      value: [
        "The result of github__list_issues was saved to",
        path,
        `(${bytes.toLocaleString("en-US")} bytes).`,
        "It is a JSON array of 50 items. The first item is an object with the keys: body, number, state, title.",
        "Read parts of it with jq, head or read_file.",
      ].join("\n"),
    });
  });

  it("saves a string result as text with its first lines in the note", async () => {
    const { access, files } = fakeSandbox();
    const text = Array.from({ length: 400 }, (_, index) => `line ${index}`).join("\n");
    const result = (await inContext(access, () =>
      offloadContent({ maxBytes: 400 })(text, toolModelOutputContext("web_fetch", "call/1")),
    )) as { value: string };
    expect(files.get("/tmp/.eve/tool-results/web_fetch-call_1.txt")).toBe(text);
    expect(result.value).toContain("line 19\n");
    expect(result.value).not.toContain("line 20\n");
  });

  it("lists object keys and caps the list", async () => {
    const { access } = fakeSandbox();
    const wide = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [`field_number_${index}`, "x".repeat(20)]),
    );
    const result = (await inContext(access, () =>
      offloadContent({ maxBytes: 400 })(wide, toolModelOutputContext("t", "c")),
    )) as { value: string };
    expect(result.value).toContain("It is a JSON object with the keys: field_number_0,");
    expect(result.value).toContain("... (200 keys).");
    expect(result.value.length).toBeLessThan(800);
  });

  it("returns the projection unchanged and warns once per session without a sandbox", async () => {
    const { records } = captureLogRecords();
    const toModelOutput = offloadContent({ maxBytes: 400 });
    await inContext(undefined, async () => {
      expect(await toModelOutput(issues, toolModelOutputContext("t", "call_1"))).toEqual({
        type: "json",
        value: issues,
      });
      expect(await toModelOutput(issues, toolModelOutputContext("t", "call_2"))).toEqual({
        type: "json",
        value: issues,
      });
    });
    expect(records.filter((record) => record.level === "warn")).toHaveLength(1);
  });

  it.each([
    {
      name: "the sandbox fails to open",
      sandbox: {
        getSandbox: async () => {
          throw new Error("cold start failed");
        },
      },
      message: "cold start failed",
    },
    {
      name: "the write fails",
      sandbox: {
        getSandbox: async () => ({
          ...mockSandbox().session,
          writeTextFile: async () => {
            throw new Error("disk full");
          },
        }),
      },
      message: "disk full",
    },
  ])("returns the projection unchanged and warns once when $name", async ({ message, sandbox }) => {
    const { records } = captureLogRecords();
    const toModelOutput = offloadContent({ maxBytes: 400 });
    const ctx = {
      ...toolModelOutputContext("create_issue", "call_1"),
      ...sandbox,
    } satisfies ToolModelOutputContext;
    await inContext(undefined, async () => {
      expect(await toModelOutput(issues, ctx)).toEqual({ type: "json", value: issues });
      expect(await toModelOutput(issues, ctx)).toEqual({ type: "json", value: issues });
    });
    const warnings = records.filter((record) => record.level === "warn");
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings[0])).toContain(message);
  });

  it("applies the inner toModelOutput first and checks the size of its result", async () => {
    const { access, files } = fakeSandbox();
    const summary = vi.fn((output: typeof issues) => toolOutput.text(`${output.length} issues`));
    const small = await inContext(access, () =>
      offloadContent({ maxBytes: 400, toModelOutput: summary })(
        issues,
        toolModelOutputContext("t", "call_1"),
      ),
    );
    expect(small).toEqual({ type: "text", value: "50 issues" });
    expect(files.size).toBe(0);

    const expanded = await inContext(access, () =>
      offloadContent({
        maxBytes: 400,
        toModelOutput: (output: typeof issues) => toolOutput.text(JSON.stringify(output, null, 2)),
      })(issues, toolModelOutputContext("t", "call_2")),
    );
    expect((expanded as { value: string }).value).toContain("/tmp/.eve/tool-results/t-call_2.json");
    expect(files.get("/tmp/.eve/tool-results/t-call_2.json")).toBe(big);
  });

  it("never saves error results or results with file parts", async () => {
    const { access, files } = fakeSandbox();
    const run = (projected: ToolModelOutput) =>
      inContext(access, () =>
        offloadContent({ maxBytes: 40, toModelOutput: () => projected })(
          issues,
          toolModelOutputContext("t", "call_1"),
        ),
      );
    const error = toolOutput.errorText("x".repeat(5_000));
    const image = toolOutput.content([
      toolOutputPart.text("x".repeat(5_000)),
      toolOutputPart.file("AAAA", { mediaType: "image/png" }),
    ]);
    expect(await run(error)).toBe(error);
    expect(await run(image)).toBe(image);
    expect(files.size).toBe(0);
  });

  it("offloads a result over 20,000 bytes by default", async () => {
    const { access, files } = fakeSandbox();
    const toModelOutput = offloadContent();
    const small = "x".repeat(20_000);
    const large = "x".repeat(20_001);
    await inContext(access, async () => {
      expect(await toModelOutput(small, toolModelOutputContext("t", "small"))).toEqual({
        type: "text",
        value: small,
      });
      expect(await toModelOutput(large, toolModelOutputContext("t", "large"))).toMatchObject({
        type: "text",
        value: expect.stringContaining("/tmp/.eve/tool-results/t-large.txt"),
      });
    });
    expect([...files.keys()]).toEqual(["/tmp/.eve/tool-results/t-large.txt"]);
  });

  it("sends only a description when ifNotSaved is description and there is no sandbox", async () => {
    const { records } = captureLogRecords();
    const toModelOutput = offloadContent({ maxBytes: 400, ifNotSaved: "description" });
    const result = (await inContext(undefined, () =>
      toModelOutput(issues, toolModelOutputContext("list_issues", "call_1")),
    )) as { type: string; value: string };
    expect(result.type).toBe("text");
    expect(result.value).toBe(
      [
        `The result of list_issues is ${Buffer.byteLength(big).toLocaleString("en-US")} bytes and could not be saved, so only this description is shown.`,
        "It is a JSON array of 50 items. The first item is an object with the keys: body, number, state, title.",
      ].join("\n"),
    );
    expect(records.filter((record) => record.level === "warn")).toHaveLength(1);
  });

  it("sends only a description when ifNotSaved is description and the write fails", async () => {
    captureLogRecords();
    const ctx = {
      ...toolModelOutputContext("list_issues", "call_1"),
      getSandbox: async () => ({
        ...mockSandbox().session,
        writeTextFile: async () => {
          throw new Error("disk full");
        },
      }),
    } satisfies ToolModelOutputContext;
    const result = (await inContext(undefined, () =>
      offloadContent({ maxBytes: 400, ifNotSaved: "description" })(issues, ctx),
    )) as { value: string };
    expect(result.value).toContain("could not be saved");
    expect(result.value).not.toContain("Issue 1");
  });

  it("rejects a limit that is not a positive integer", () => {
    expect(() => offloadContent({ maxBytes: 0 })).toThrow("positive integer");
    expect(() => offloadContent({ maxBytes: 4.5 })).toThrow("positive integer");
  });
});

describe("toolCallModelOutput with a toModelOutput", () => {
  it("passes the call id, tool name and sandbox", async () => {
    const { access, files } = fakeSandbox();
    const definition = {
      name: "list_issues",
      toModelOutput: offloadContent({ maxBytes: 4_000 }),
    };
    const result = await inContext(access, () => toolCallModelOutput(definition, issues, "call_9"));
    expect(files.has("/tmp/.eve/tool-results/list_issues-call_9.json")).toBe(true);
    expect(result.type).toBe("text");
  });

  it("still runs a toModelOutput that takes only the output", async () => {
    const definition = {
      name: "plain",
      toModelOutput: (output: unknown) => toolOutput.text(`got ${String(output)}`),
    };
    expect(await toolCallModelOutput(definition, 7, "call_1")).toEqual({
      type: "text",
      value: "got 7",
    });
  });
});
