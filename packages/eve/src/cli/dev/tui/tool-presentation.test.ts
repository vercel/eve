import { describe, expect, it } from "vitest";

import { getAllFrameworkToolNames } from "#runtime/framework-tools/index.js";

import { presentPreparingTool, presentTool } from "./tool-presentation.js";

describe("presentPreparingTool", () => {
  it("leads with the activity verb while the input still streams", () => {
    expect(presentPreparingTool("web_fetch").title).toBe("Fetch …");
    expect(presentPreparingTool("bash").title).toBe("Run …");
    expect(presentPreparingTool("write_file").title).toBe("Write …");
    expect(presentPreparingTool("eve.web_search").title).toBe("Search …");
    expect(presentPreparingTool("final_output").title).toBe("Return final output");
  });

  it("keeps unknown tools on their name with a quiet hint", () => {
    const presentation = presentPreparingTool("linear__list_issues");
    expect(presentation.title).toBe("linear__list_issues");
    expect(presentation.subtitle).toBe("preparing…");
  });
});

describe("presentTool", () => {
  it("renders web_fetch as a semantic URL activity", () => {
    const presentation = presentTool("web_fetch", {
      format: "markdown",
      url: "https://github.com/vercel/eve/issues/648",
    });

    expect(presentation.title).toBe("Fetch https://github.com/vercel/eve/issues/648");
    expect(presentation.subtitle).toBe("");
    expect(presentation.summarizeResult({ content: "large page" })).toBeUndefined();
    expect(presentation.doneTitle).toBe("Fetched https://github.com/vercel/eve/issues/648");
    expect(presentation.group).toEqual({
      verb: "Fetch",
      pastVerb: "Fetched",
      singularNoun: "URL",
      pluralNoun: "URLs",
      item: "https://github.com/vercel/eve/issues/648",
    });
  });

  it("recognizes namespaced web_fetch tools", () => {
    expect(presentTool("eve.web_fetch", { url: "https://example.com" }).title).toBe(
      "Fetch https://example.com",
    );
  });

  it("neutralizes terminal controls in a model-controlled URL", () => {
    const presentation = presentTool("web_fetch", {
      url: "https://example.com/\u001b[2J\u0007path",
    });

    // Control code points are removed; printable remnants are harmless.
    expect(presentation.title).toBe("Fetch https://example.com/[2Jpath");
    expect(presentation.group?.item).toBe("https://example.com/[2Jpath");
    expect(presentation.group?.item).not.toContain("\u001b");
    expect(presentation.group?.item).not.toContain("\u0007");
  });

  it("maps every single-argument builtin through the shared copy table", () => {
    expect(presentTool("bash", { command: "pnpm test" }).title).toBe("Run pnpm test");
    expect(presentTool("glob", { pattern: "**/*.ts" }).title).toBe("Glob **/*.ts");
    expect(presentTool("grep", { pattern: "useEve" }).title).toBe("Grep useEve");
    expect(presentTool("load_skill", { skill: "commit" }).title).toBe("Load commit");
    expect(presentTool("read_file", { filePath: "/workspace/agent.ts" })).toMatchObject({
      title: "Read /workspace/agent.ts",
      group: { verb: "Read", singularNoun: "file", pluralNoun: "files" },
    });
    expect(presentTool("write_file", { content: "x", filePath: "/workspace/a.ts" }).title).toBe(
      "Write /workspace/a.ts",
    );
  });

  it("keeps a write un-aggregated with its content as persistent rail detail", () => {
    const presentation = presentTool("write_file", {
      filePath: "/workspace/a.ts",
      content: "const a = 1;\nconst b = 2;",
    });

    expect(presentation.title).toBe("Write /workspace/a.ts");
    expect(presentation.doneTitle).toBe("Wrote /workspace/a.ts");
    expect(presentation.group).toBeUndefined();
    expect(presentation.detail).toEqual([{ text: "const a = 1;" }, { text: "const b = 2;" }]);
    expect(presentation.keepDetailWhenDone).toBe(true);
  });

  it("diffs a write against the prior content the renderer provides", () => {
    const created = presentTool(
      "write_file",
      { filePath: "/workspace/a.txt", content: "knicks\n" },
      { existed: false },
    );
    expect(created.detail).toEqual([{ text: "knicks", kind: "added" }]);

    const overwritten = presentTool(
      "write_file",
      { filePath: "/workspace/a.txt", content: "knicks\nnets\n" },
      { previousContent: "knicks\n" },
    );
    expect(overwritten.detail).toEqual([{ text: "knicks" }, { text: "nets", kind: "added" }]);
  });

  it("collapses a multiline salient argument to its first non-empty line", () => {
    const presentation = presentTool("bash", { command: "\n  pnpm build\npnpm test" });

    expect(presentation.title).toBe("Run pnpm build");
    expect(presentation.group?.item).toBe("pnpm build");
  });

  it("renders web_search across both provider input shapes", () => {
    // Anthropic's provider-managed tool sends a top-level query.
    expect(presentTool("web_search", { query: "eve framework" })).toMatchObject({
      title: "Search eve framework",
      group: { verb: "Search", singularNoun: "query", pluralNoun: "queries" },
    });

    // Provider-managed variants send an objective/search_query pair.
    expect(
      presentTool("web_search", {
        objective: "Find confirmed public events",
        search_query: "public events 2026",
      }).title,
    ).toBe("Search Find confirmed public events");
    expect(presentTool("web_search", { search_query: "public events 2026" }).title).toBe(
      "Search public events 2026",
    );

    // OpenAI nests the argument under `action`.
    expect(
      presentTool("web_search", { action: { type: "search", queries: ["smoke"] } }).title,
    ).toBe("Search smoke");
    expect(presentTool("web_search", { action: { queries: ["alpha", "beta"] } }).title).toBe(
      "Search alpha, beta",
    );
    expect(
      presentTool("web_search", { action: { type: "openPage", url: "https://example.com" } }).title,
    ).toBe("Search https://example.com");
    expect(
      presentTool("web_search", { action: { type: "findInPage", pattern: "pricing" } }).title,
    ).toBe("Search pricing");
  });

  it("renders todo maintenance without dumping the list", () => {
    const update = presentTool("todo", {
      todos: [
        { content: "a", status: "completed", priority: "high" },
        { content: "b", status: "in_progress", priority: "low" },
      ],
    });
    expect(update.title).toBe("Update todo list");
    expect(update.subtitle).toBe("2 tasks");
    expect(update.summarizeResult({ counts: { total: 2 } })).toBeUndefined();

    expect(presentTool("todo", {}).title).toBe("Read todo list");
    expect(presentTool("todo", undefined).title).toBe("Read todo list");
  });

  it("renders the remaining structured builtins semantically", () => {
    expect(presentTool("ask_question", { prompt: "Which environment?" }).title).toBe(
      "Ask Which environment?",
    );
    expect(presentTool("agent", { message: "Audit the auth flow.\nDetails…" }).title).toBe(
      "Delegate Audit the auth flow.",
    );
    expect(presentTool("connection_search", { keywords: "linear issues" }).title).toBe(
      "Discover linear issues",
    );
    expect(presentTool("final_output", { anything: true }).title).toBe("Return final output");
  });

  it("covers every framework builtin with semantic copy", () => {
    const representativeInputs: Record<string, unknown> = {
      agent: { message: "audit the auth flow" },
      ask_question: { prompt: "Which environment?" },
      bash: { command: "ls" },
      glob: { pattern: "**/*.ts" },
      grep: { pattern: "useEve" },
      load_skill: { skill: "commit" },
      read_file: { filePath: "/workspace/a.ts" },
      todo: { todos: [] },
      web_fetch: { url: "https://example.com" },
      web_search: { query: "eve framework" },
      write_file: { filePath: "/workspace/a.ts", content: "x" },
    };

    for (const name of getAllFrameworkToolNames()) {
      const input = representativeInputs[name];
      expect(
        input,
        `framework tool "${name}" has no representative input — add semantic copy for it in tool-presentation.ts and cover it here`,
      ).toBeDefined();
      expect(presentTool(name, input).title, name).not.toBe(name);
    }
  });

  it("falls back to the generic formatter for malformed input", () => {
    const presentation = presentTool("web_fetch", { format: "markdown" });

    expect(presentation.title).toBe("web_fetch");
    expect(presentation.subtitle).toContain('format="markdown"');
  });

  it("presents a named subagent dispatch as a delegation", () => {
    const parsed = presentTool(
      "stock-price",
      { message: "Look up GOOG.\nDetails…" },
      { isSubagent: true },
    );
    expect(parsed.title).toBe("Delegate stock-price");
    expect(parsed.doneTitle).toBe("Delegated stock-price");
    expect(parsed.subtitle).toBe("Look up GOOG.");

    // The tool's name carries the target, so it shows before args parse.
    expect(presentPreparingTool("stock-price", { isSubagent: true }).title).toBe(
      "Delegate stock-price …",
    );
    // Without roster knowledge the generic formatter keeps its shape.
    expect(presentTool("stock-price", { message: "x" }).title).toBe("stock-price");
  });

  it("keeps unknown tools on the generic formatter", () => {
    const presentation = presentTool("linear__list_issues", { teamId: "T1" });

    expect(presentation.title).toBe("linear__list_issues");
    expect(presentation.subtitle).toContain('teamId="T1"');
    expect(presentation.group).toBeUndefined();
  });
});
