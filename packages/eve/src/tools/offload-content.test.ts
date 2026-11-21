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

  it("writes the output to the sandbox and returns a note when over the limit", async () => {
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
        `Output of github__list_issues (${bytes.toLocaleString("en-US")} bytes) was saved to ${path}.`,
        "JSON array of 50 objects with keys: body, number, state, title.",
        "Inspect it with bash (for example jq) or read_file instead of loading the entire file.",
      ].join("\n"),
    });
  });

  it("saves a string result as text with its first lines in the note", async () => {
    const { access, files } = fakeSandbox();
    const text = Array.from({ length: 400 }, (_, index) => `line ${index}`).join("\n");
    const result = (await inContext(access, () =>
      offloadContent({ maxBytes: 3_000 })(text, toolModelOutputContext("web_fetch", "call/1")),
    )) as { value: string };
    expect(files.get("/tmp/.eve/tool-results/web_fetch-call_1.txt")).toBe(text);
    expect(result.value).toContain("Text (400 lines). First 20 lines:\nline 0\n");
    expect(result.value).toContain("line 19\n");
    expect(result.value).not.toContain("line 20\n");
    expect(result.value).toContain("read_file or bash (for example head, sed, or grep)");
  });

  it("previews a single long line and counts CRLF lines without carriage returns", async () => {
    const { access } = fakeSandbox();
    const one = (await inContext(access, () =>
      offloadContent({ maxBytes: 4_000 })("y".repeat(5_000), toolModelOutputContext("t", "one")),
    )) as { value: string };
    expect(one.value).toContain(`Text (1 line). Preview:\n${"y".repeat(200)}...\n`);
    const crlf = (await inContext(access, () =>
      offloadContent({ maxBytes: 160 })(
        "a\r\nb\r\n".repeat(30),
        toolModelOutputContext("t", "crlf"),
      ),
    )) as { value: string };
    expect(crlf.value).toContain("Text (60 lines). First 20 lines:\na\nb\n");
    expect(crlf.value).not.toContain("\r");
  });

  it("keeps a text preview inside a small limit", async () => {
    const { access } = fakeSandbox();
    const text = Array.from({ length: 50 }, () => "z".repeat(190)).join("\n");
    const result = (await inContext(access, () =>
      offloadContent({ maxBytes: 1_000 })(text, toolModelOutputContext("t", "small")),
    )) as { value: string };
    expect(Buffer.byteLength(result.value)).toBeLessThan(1_000);
  });

  it("describes arrays nested in a wrapper object", async () => {
    const { access } = fakeSandbox();
    const rows = { rows: Array.from({ length: 400 }, (_, id) => ({ id, label: `row-${id}` })) };
    const result = (await inContext(access, () =>
      offloadContent({ maxBytes: 400 })(rows, toolModelOutputContext("big_report", "call_1")),
    )) as { value: string };
    expect(result.value).toContain(
      "JSON object with keys: rows (array of 400 objects with keys: id, label).",
    );
  });

  it("keeps long tool names and call ids inside a valid file name", async () => {
    const { access, files } = fakeSandbox();
    const toolName = `mcp__${"server".repeat(30)}__tool`;
    const callId = `call_${"0123456789".repeat(30)}`;
    const other = `${toolName}2`;
    await inContext(access, async () => {
      const toModelOutput = offloadContent({ maxBytes: 40 });
      await toModelOutput("x".repeat(100), toolModelOutputContext(toolName, callId));
      await toModelOutput("x".repeat(100), toolModelOutputContext(other, callId));
    });
    const names = [...files.keys()].map((path) => path.split("/").at(-1)!);
    expect(names).toHaveLength(2);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(64 + 1 + 64 + 4);
  });

  it("lists object keys and caps the list", async () => {
    const { access } = fakeSandbox();
    const wide = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [`field_number_${index}`, "x".repeat(20)]),
    );
    const result = (await inContext(access, () =>
      offloadContent({ maxBytes: 400 })(wide, toolModelOutputContext("t", "c")),
    )) as { value: string };
    expect(result.value).toContain("JSON object with keys: field_number_0,");
    expect(result.value).toContain("... (200 total).");
    expect(result.value.length).toBeLessThan(800);
  });

  it("gives the same preview for a text with a million lines", async () => {
    const { access } = fakeSandbox();
    const text = `${Array.from({ length: 1_000_000 }, (_, index) => `row ${index}`).join("\n")}\n`;
    const result = (await inContext(access, () =>
      offloadContent({ fallback: "summary", maxBytes: 4_000 })(
        text,
        toolModelOutputContext("t", "lines"),
      ),
    )) as { value: string };
    expect(result.value).toContain("Text (1,000,000 lines). First 20 lines:\nrow 0\nrow 1\n");
    expect(result.value).toContain("\nrow 19");
    expect(result.value).not.toContain("row 20");
  });

  it("counts carriage-return line endings and a trailing newline as before", async () => {
    const { access } = fakeSandbox();
    const text = `${Array.from({ length: 30 }, (_, index) => `r${index}`).join("\r\n")}\r\n`;
    const result = (await inContext(access, () =>
      offloadContent({ maxBytes: 100 })(text, toolModelOutputContext("t", "crlf")),
    )) as { value: string };
    expect(result.value).toContain("Text (30 lines). First ");
    expect(result.value).toContain(":\nr0\nr1\nr2\n");
    expect(result.value).not.toContain("\r");
  });

  it("keeps the note short when a key is huge", async () => {
    const { access } = fakeSandbox();
    const huge = "k".repeat(100_000);
    const cases: unknown[] = [
      { [huge]: "x".repeat(2_000) },
      [{ [huge]: "x".repeat(2_000) }],
      { rows: [{ [huge]: "x".repeat(2_000) }] },
      { [huge]: [{ [huge]: 1 }] },
    ];
    for (const value of cases) {
      const result = (await inContext(access, () =>
        offloadContent({ maxBytes: 400 })(value, toolModelOutputContext("t", "huge")),
      )) as { value: string };
      expect(result.value.length).toBeLessThan(600);
    }
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
    expect((expanded as { value: string }).value).toContain("/tmp/.eve/tool-results/t-call_2.txt");
    expect(files.get("/tmp/.eve/tool-results/t-call_2.txt")).toBe(JSON.stringify(issues, null, 2));
  });

  describe("with an inner toModelOutput that redacts", () => {
    const secret = "TOP-SECRET-TOKEN";
    const accounts = Array.from({ length: 50 }, (_, id) => ({ id, name: `a${id}`, token: secret }));
    const redactJson = (output: typeof accounts) =>
      toolOutput.json(output.map(({ token: _token, ...rest }) => rest));
    const log = "line with TOP-SECRET-TOKEN in it\n".repeat(100);
    const redactText = (output: string) => toolOutput.text(output.replaceAll(secret, "[redacted]"));
    const unsaved = {
      getSandbox: async () => {
        throw new Error("cold start failed");
      },
    };

    it("writes and previews the projected JSON, never the raw output", async () => {
      const { access, files } = fakeSandbox();
      const result = (await inContext(access, () =>
        offloadContent({ maxBytes: 400, toModelOutput: redactJson })(
          accounts,
          toolModelOutputContext("accounts", "c1"),
        ),
      )) as { value: string };
      const written = files.get("/tmp/.eve/tool-results/accounts-c1.json")!;
      expect(written).toBe(JSON.stringify(accounts.map(({ id, name }) => ({ id, name }))));
      expect(written).not.toContain(secret);
      expect(result.value).not.toContain(secret);
      expect(result.value).toContain("keys: id, name.");
    });

    it("writes and previews the projected text, never the raw output", async () => {
      const { access, files } = fakeSandbox();
      const result = (await inContext(access, () =>
        offloadContent({ maxBytes: 400, toModelOutput: redactText })(
          log,
          toolModelOutputContext("logs", "c1"),
        ),
      )) as { value: string };
      const written = files.get("/tmp/.eve/tool-results/logs-c1.txt")!;
      expect(written).toBe(log.replaceAll(secret, "[redacted]"));
      expect(result.value).not.toContain(secret);
      expect(result.value).toContain("[redacted]");
    });

    it("describes only the projected output when the result cannot be saved", async () => {
      captureLogRecords();
      const run = (output: unknown, toModelOutput: never) =>
        inContext(undefined, () =>
          offloadContent({ fallback: "summary", maxBytes: 400, toModelOutput })(output, {
            ...toolModelOutputContext("t", "c1"),
            ...unsaved,
          }),
        ) as Promise<{ value: string }>;
      for (const result of [
        await run(accounts, redactJson as never),
        await run(log, redactText as never),
      ]) {
        expect(result.value).toContain("could not be saved");
        expect(result.value).not.toContain(secret);
      }
    });
  });

  it("falls back to the default projection when called with only the output", async () => {
    expect(await offloadContent({ maxBytes: 400 })(issues)).toEqual({
      type: "json",
      value: issues,
    });
    expect(await offloadContent({ maxBytes: 400, fallback: "summary" })(issues)).toMatchObject({
      type: "text",
      value: expect.stringContaining("could not be saved"),
    });
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

  it("sends only a description when fallback is summary and there is no sandbox", async () => {
    const { records } = captureLogRecords();
    const toModelOutput = offloadContent({ maxBytes: 400, fallback: "summary" });
    const result = (await inContext(undefined, () =>
      toModelOutput(issues, toolModelOutputContext("list_issues", "call_1")),
    )) as { type: string; value: string };
    expect(result.type).toBe("text");
    expect(result.value).toBe(
      [
        `Output of list_issues (${Buffer.byteLength(big).toLocaleString("en-US")} bytes) exceeded the inline limit and could not be saved to the sandbox. Only a summary is shown below.`,
        "JSON array of 50 objects with keys: body, number, state, title.",
      ].join("\n"),
    );
    expect(records.filter((record) => record.level === "warn")).toHaveLength(1);
  });

  it("sends only a description when fallback is summary and the write fails", async () => {
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
      offloadContent({ maxBytes: 400, fallback: "summary" })(issues, ctx),
    )) as { value: string };
    expect(result.value).toContain("could not be saved");
    expect(result.value).not.toContain("Issue 1");
  });

  it("saves a result of exactly 10 MB and skips one byte more", async () => {
    const limit = 10 * 1024 * 1024;
    const { records } = captureLogRecords();
    const toModelOutput = offloadContent({ maxBytes: 400, fallback: "summary" });
    const { access, files } = fakeSandbox();
    const saved = await inContext(access, () =>
      toModelOutput("a".repeat(limit), toolModelOutputContext("t", "exact")),
    );
    expect([...files.keys()]).toEqual(["/tmp/.eve/tool-results/t-exact.txt"]);
    expect((saved as { value: string }).value).toContain("was saved to");

    const over = fakeSandbox();
    const skipped = (await inContext(over.access, () =>
      toModelOutput("a".repeat(limit + 1), toolModelOutputContext("t", "over")),
    )) as { value: string };
    expect(over.files.size).toBe(0);
    expect(skipped.value).toContain("could not be saved");
    expect(skipped.value).not.toContain("was saved to");
    const warnings = records.filter((record) => record.level === "warn");
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings[0])).toContain("over 10,485,760 bytes");
  });

  it("sends the whole projection above 10 MB when fallback is inline", async () => {
    captureLogRecords();
    const { access, files } = fakeSandbox();
    const text = "a".repeat(10 * 1024 * 1024 + 1);
    const result = await inContext(access, () =>
      offloadContent({ maxBytes: 400 })(text, toolModelOutputContext("t", "big")),
    );
    expect(files.size).toBe(0);
    expect(result).toEqual({ type: "text", value: text });
  });

  it("keeps at most 100 saved results per sandbox and removes the one that goes over", async () => {
    const { records } = captureLogRecords();
    const { access, files } = fakeSandbox();
    const toModelOutput = offloadContent({ maxBytes: 100, fallback: "summary" });
    const results = await inContext(access, async () => {
      const all: ToolModelOutput[] = [];
      for (let index = 0; index < 101; index += 1) {
        all.push(
          await toModelOutput("x".repeat(500), toolModelOutputContext("t", `call_${index}`)),
        );
      }
      return all;
    });
    expect(files.size).toBe(100);
    expect(files.has("/tmp/.eve/tool-results/t-call_100.txt")).toBe(false);
    expect((results[99] as { value: string }).value).toContain("was saved to");
    expect((results[100] as { value: string }).value).toContain("could not be saved");
    const warnings = records.filter((record) => record.level === "warn");
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings[0])).toContain("100 files");
  });

  it("keeps saved results under 100 MB per sandbox", async () => {
    captureLogRecords();
    const { access, files } = fakeSandbox();
    const toModelOutput = offloadContent({ maxBytes: 100, fallback: "summary" });
    const chunk = "a".repeat(10 * 1024 * 1024);
    const results = await inContext(access, async () => {
      const all: ToolModelOutput[] = [];
      for (let index = 0; index < 11; index += 1) {
        all.push(await toModelOutput(chunk, toolModelOutputContext("t", `call_${index}`)));
      }
      return all;
    });
    expect(files.size).toBe(10);
    expect((results[10] as { value: string }).value).toContain("could not be saved");
  });

  it("counts a rewritten call id once", async () => {
    const { access, files } = fakeSandbox();
    const toModelOutput = offloadContent({ maxBytes: 100, fallback: "summary" });
    await inContext(access, async () => {
      for (let index = 0; index < 150; index += 1) {
        await toModelOutput("x".repeat(500), toolModelOutputContext("t", "same"));
      }
    });
    expect(files.size).toBe(1);
  });

  it("sends the fallback and warns when the saved results cannot be measured", async () => {
    const { records } = captureLogRecords();
    const sandbox = mockSandbox({ run: () => ({ exitCode: 1, stderr: "no find", stdout: "" }) });
    const ctx = {
      ...toolModelOutputContext("t", "call_1"),
      getSandbox: async () => sandbox.session,
    } satisfies ToolModelOutputContext;
    const result = await inContext(undefined, () =>
      offloadContent({ maxBytes: 100, fallback: "summary" })("x".repeat(500), ctx),
    );
    expect((result as { value: string }).value).toContain("could not be saved");
    expect(sandbox.files.size).toBe(0);
    expect(JSON.stringify(records.filter((record) => record.level === "warn")[0])).toContain(
      "could not measure",
    );
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
