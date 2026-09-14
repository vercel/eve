import { describe, expect, it } from "vitest";

import { applyModelSelectionToSource } from "./apply-model-selection.js";

const SCAFFOLD = `import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-5",
});
`;

describe("applyModelSelectionToSource", () => {
  it("switches a Gateway string to chatgpt() and adds its import", async () => {
    const source = `import { defineAgent } from "eve";\n\nexport default defineAgent({\n  model: "openai/gpt-5.5",\n});\n`;

    const result = await applyModelSelectionToSource(source, "chatgpt/gpt-5.6-sol");

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.nextSource).toContain('import { chatgpt } from "eve/models/openai";');
    expect(result.nextSource).toContain('model: chatgpt("gpt-5.6-sol")');
  });

  it("switches chatgpt() back to a Gateway string and removes its sole import", async () => {
    const source = `import { defineAgent } from "eve";\nimport { chatgpt } from "eve/models/openai";\n\nexport default defineAgent({\n  model: chatgpt("gpt-5.6-sol"),\n});\n`;

    const result = await applyModelSelectionToSource(source, "anthropic/claude-sonnet-5");

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.nextSource).not.toContain("eve/models/openai");
    expect(result.nextSource).toContain('model: "anthropic/claude-sonnet-5"');
  });

  it("switches the documented no-argument chatgpt() call back to Gateway", async () => {
    const source = `import { defineAgent } from "eve";\nimport { chatgpt } from "eve/models/openai";\n\nexport default defineAgent({ model: chatgpt() });\n`;

    const result = await applyModelSelectionToSource(source, "openai/gpt-5.5");

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.from).toBe("chatgpt/gpt-5.6-sol");
    expect(result.nextSource).not.toContain("eve/models/openai");
    expect(result.nextSource).toContain('model: "openai/gpt-5.5"');
  });

  it("normalizes an openai-prefixed chatgpt() argument when changing models", async () => {
    const source = `import { chatgpt } from "eve/models/openai";\nexport default defineAgent({ model: chatgpt("openai/gpt-5.5") });\n`;

    const result = await applyModelSelectionToSource(source, "chatgpt/gpt-5.6-sol");

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.from).toBe("chatgpt/gpt-5.5");
    expect(result.nextSource).toContain('model: chatgpt("gpt-5.6-sol")');
  });

  it("preserves other imports from eve/models/openai", async () => {
    const source = `import { defineAgent } from "eve";\nimport { chatgpt, other } from "eve/models/openai";\nexport default defineAgent({ model: chatgpt("gpt-5.6-sol") });\n`;

    const result = await applyModelSelectionToSource(source, "openai/gpt-5.5");

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.nextSource).toContain('import { other } from "eve/models/openai";');
  });

  it("keeps the chatgpt import when another call still uses it", async () => {
    const source = `import { chatgpt } from "eve/models/openai";\nconst fallback = chatgpt("gpt-5.5");\nexport default defineAgent({ model: chatgpt() });\n`;

    const result = await applyModelSelectionToSource(source, "openai/gpt-5.5");

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.nextSource).toContain('import { chatgpt } from "eve/models/openai";');
  });

  it("rewrites Gateway strings without changing surrounding source", async () => {
    const result = await applyModelSelectionToSource(SCAFFOLD, "anthropic/claude-opus-4.6");

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.nextSource).toBe(
      SCAFFOLD.replace("anthropic/claude-sonnet-5", "anthropic/claude-opus-4.6"),
    );
  });

  it("preserves single-quote style", async () => {
    const result = await applyModelSelectionToSource(
      `export default defineAgent({ model: 'a/b' });\n`,
      "c/d",
    );

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.nextSource).toContain(`model: 'c/d'`);
  });

  it("unwraps satisfies while leaving the annotation", async () => {
    const result = await applyModelSelectionToSource(
      `export default defineAgent({ model: "a/b" satisfies string });\n`,
      "c/d",
    );

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.nextSource).toContain(`model: "c/d" satisfies string`);
  });

  it("is a no-op when the Gateway value is unchanged", async () => {
    const result = await applyModelSelectionToSource(SCAFFOLD, "anthropic/claude-sonnet-5");

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.nextSource).toBe(SCAFFOLD);
  });

  it.each([
    `export default defineAgent({ model: process.env.MODEL ?? "a/b" });\n`,
    "export default defineAgent({ model: `a/${x}` });\n",
    `export default defineAgent({ model: defineDynamic({ events: {} }) });\n`,
    `export default defineAgent({ instructions: "hello" });\n`,
    `export const x = 1;\n`,
  ])("bails rather than rewriting a non-static model", async (source) => {
    await expect(applyModelSelectionToSource(source, "c/d")).resolves.toMatchObject({
      kind: "bail",
    });
  });
});
