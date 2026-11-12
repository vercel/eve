import { describe, expect, it } from "vitest";

import { parseWorkflowSourceAst } from "./workflow-source-ast.js";

describe("parseWorkflowSourceAst", () => {
  it("shares one tree per source and parser language", async () => {
    const source = "export const identity = <T,>(value: T) => value;\n";
    const tree = await parseWorkflowSourceAst("/app/agent/tools/a.ts", source);

    await expect(parseWorkflowSourceAst("src/other/b.mts", source)).resolves.toBe(tree);
    await expect(parseWorkflowSourceAst("/app/agent/tools/a.tsx", source)).resolves.not.toBe(tree);
    await expect(parseWorkflowSourceAst("/app/agent/tools/a.ts", source)).resolves.toBe(tree);
  });

  it("evicts older trees once the cache passes 1 MiB of source", async () => {
    const small = "export const evicted = 1;\n";
    const tree = await parseWorkflowSourceAst("small.ts", small);
    const nearlyOneMiB = `//${"-".repeat(1024 * 1024 - 16)}\n`;
    const large = await parseWorkflowSourceAst("large.ts", nearlyOneMiB);

    await expect(parseWorkflowSourceAst("large.ts", nearlyOneMiB)).resolves.toBe(large);
    await expect(parseWorkflowSourceAst("small.ts", small)).resolves.not.toBe(tree);
  });
});
