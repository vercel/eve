import { describe, expect, it } from "vitest";

import { moduleStepScope } from "./module-step-scope.js";

describe("moduleStepScope", () => {
  it("is stable for the same normalized path", () => {
    expect(moduleStepScope("agent/tools/search.ts")).toBe(moduleStepScope("agent/tools/search.ts"));
  });

  it("differs across distinct modules", () => {
    expect(moduleStepScope("agent/tools/search.ts")).not.toBe(
      moduleStepScope("agent/tools/tokenize.ts"),
    );
  });

  it("strips the cwd prefix for absolute local paths", () => {
    const absolute = `${process.cwd()}/agent/tools/search.ts`;
    expect(moduleStepScope(absolute)).toBe(moduleStepScope("agent/tools/search.ts"));
  });

  it("collapses pnpm nested node_modules paths to the package path", () => {
    const nested = "/app/node_modules/.pnpm/evlog@1.0.0/node_modules/evlog/dist/tools/search.js";
    const plain = "/app/node_modules/evlog/dist/tools/search.js";
    expect(moduleStepScope(nested)).toBe(moduleStepScope(plain));
  });

  it("keeps distinct packages distinct after pnpm collapsing", () => {
    expect(moduleStepScope("/app/node_modules/.pnpm/foo@1/node_modules/foo/tools/a.js")).not.toBe(
      moduleStepScope("/app/node_modules/.pnpm/bar@1/node_modules/bar/tools/a.js"),
    );
  });
});
