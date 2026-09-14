import { RETENTION_DEFAULT, RETENTION_ZERO } from "@workflow/world";
import { describe, expect, it } from "vitest";

import { AGENT_WORKFLOW_RETENTION_VALUES } from "#shared/agent-definition.js";

/**
 * Guards eve's authored retention values against drift from the Workflow
 * SDK's `RunRetention`.
 *
 * eve declares its own tuple rather than aliasing the SDK type, so the
 * authored surface stays eve-owned and the same list can drive the zod
 * schema and the normalizer. That independence is the reason this guard
 * exists: nothing else would notice if the SDK grew or renamed a value.
 *
 * The assertion is deliberately a runtime one. `pnpm typecheck` excludes
 * test files, so a type-level `satisfies` here would never be checked.
 *
 * `@workflow/world` encodes retention on the wire as strings, hence the
 * `Number()` around `RETENTION_ZERO`. If this fails after a `@workflow/*`
 * bump, the SDK changed its accepted values: update
 * `AGENT_WORKFLOW_RETENTION_VALUES`, the docs page, and the docstring on
 * `AgentWorkflowDefinition["retention"]` together.
 */
describe("AGENT_WORKFLOW_RETENTION_VALUES drift guard", () => {
  it("matches the values @workflow/world accepts", () => {
    expect([...AGENT_WORKFLOW_RETENTION_VALUES].sort()).toEqual(
      [Number(RETENTION_ZERO), RETENTION_DEFAULT].sort(),
    );
  });
});
