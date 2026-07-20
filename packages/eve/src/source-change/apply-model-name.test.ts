import { describe, expect, it } from "vitest";

import { applyModelNameToSource } from "#source-change/apply-model-name.js";

const SCAFFOLD = `import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-5",
});
`;

describe("applyModelNameToSource", () => {
  it("rewrites the model literal in the canonical scaffold", async () => {
    const result = await applyModelNameToSource(SCAFFOLD, "anthropic/claude-opus-4.6");

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.from).toBe("anthropic/claude-sonnet-5");
    expect(result.to).toBe("anthropic/claude-opus-4.6");
    // Only the literal changed; the rest of the file is byte-identical.
    expect(result.nextSource).toBe(
      SCAFFOLD.replace("anthropic/claude-sonnet-5", "anthropic/claude-opus-4.6"),
    );
  });

  it("preserves single-quote style", async () => {
    const result = await applyModelNameToSource(
      `export default defineAgent({ model: 'a/b' });\n`,
      "c/d",
    );

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.nextSource).toContain(`model: 'c/d'`);
  });

  it("preserves comments and sibling properties", async () => {
    const source = `export default defineAgent({
  // primary model
  model: "a/b",
  experimental: { workflow: { world: "@acme/workflow-world" } },
});
`;
    const result = await applyModelNameToSource(source, "c/d");

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.nextSource).toContain("// primary model");
    expect(result.nextSource).toContain(
      'experimental: { workflow: { world: "@acme/workflow-world" } }',
    );
    expect(result.nextSource).toContain(`model: "c/d"`);
  });

  it("unwraps `satisfies` to the inner literal and leaves the annotation", async () => {
    const result = await applyModelNameToSource(
      `export default defineAgent({ model: "a/b" satisfies string });\n`,
      "c/d",
    );

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.nextSource).toContain(`model: "c/d" satisfies string`);
  });

  it("is a no-op when the value is unchanged", async () => {
    const result = await applyModelNameToSource(SCAFFOLD, "anthropic/claude-sonnet-5");

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.nextSource).toBe(SCAFFOLD);
  });

  it("bails when model is an env reference, not a literal", async () => {
    const result = await applyModelNameToSource(
      `export default defineAgent({ model: process.env.MODEL ?? "a/b" });\n`,
      "c/d",
    );

    expect(result.kind).toBe("bail");
  });

  it("bails on a template literal", async () => {
    const result = await applyModelNameToSource(
      "export default defineAgent({ model: `a/${x}` });\n",
      "c/d",
    );

    expect(result.kind).toBe("bail");
  });

  it("bails on a defineDynamic model without touching the fallback literal", async () => {
    const source = `import { defineAgent, defineDynamic } from "eve";

export default defineAgent({
  model: defineDynamic({
    fallback: "anthropic/claude-sonnet-5",
    events: {
      "session.started": () => "anthropic/claude-opus-4.6",
    },
  }),
});
`;
    const result = await applyModelNameToSource(source, "c/d");

    expect(result.kind).toBe("bail");
    if (result.kind !== "bail") return;
    // The fallback string inside defineDynamic must never be rewritten.
    expect(result.reason).toContain("defineDynamic");
  });

  it("bails when there is no defineAgent call", async () => {
    const result = await applyModelNameToSource(`export const x = 1;\n`, "c/d");

    expect(result.kind).toBe("bail");
  });

  it("bails when model is absent", async () => {
    const result = await applyModelNameToSource(
      `export default defineAgent({ experimental: { workflow: {} } });\n`,
      "c/d",
    );

    expect(result.kind).toBe("bail");
  });

  it("reports the source line on a bail", async () => {
    const source = `export default defineAgent({\n  model: someConst,\n});\n`;
    const result = await applyModelNameToSource(source, "c/d");

    expect(result.kind).toBe("bail");
    if (result.kind !== "bail") return;
    expect(result.line).toBeGreaterThanOrEqual(1);
  });
});
