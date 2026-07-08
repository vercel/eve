import { describe, expect, it } from "vitest";
import { ATTRIBUTE_VALUE_MAX_BYTES } from "@workflow/world";

import { EVE_ATTRIBUTE_VALUE_MAX_BYTES } from "#runtime/attributes/emit.js";

/**
 * Guards the {@link EVE_ATTRIBUTE_VALUE_MAX_BYTES} mirror against drift
 * from its source of truth in `@workflow/world`.
 *
 * `emit.ts` cannot import the constant at runtime (it would drag the
 * full zod validator into the workflow-body bundle — see the doc-comment
 * there), so the value is duplicated. This test imports the real
 * `@workflow/world` export — a devDependency, never bundled — and fails
 * if the two ever disagree.
 *
 * If this test fails after a `@workflow/*` bump: update both
 * `EVE_ATTRIBUTE_VALUE_MAX_BYTES` and the `@workflow/world` devDependency
 * version in `package.json` so the mirror tracks whatever
 * `@workflow/core` resolves at runtime.
 */
describe("EVE_ATTRIBUTE_VALUE_MAX_BYTES drift guard", () => {
  it("matches @workflow/world's ATTRIBUTE_VALUE_MAX_BYTES", () => {
    expect(EVE_ATTRIBUTE_VALUE_MAX_BYTES).toBe(ATTRIBUTE_VALUE_MAX_BYTES);
  });
});
