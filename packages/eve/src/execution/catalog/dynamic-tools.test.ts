import { describe, expect, it } from "vitest";

import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { inlineTool } from "#internal/testing/catalog-fixtures.js";

import { dynamicToolAnnouncements } from "./dynamic-tools.js";

const KEY = "dynamic-tools";
const hint = (...names: string[]) =>
  `New in your catalog: ${names.join(", ")}. Search an exact name with eve__search for its description and signature.`;

const tool = (name: string, description = `${name} description`) =>
  inlineTool(name, { deferred: true, description });

interface CatalogState {
  readonly dynamic?: readonly HarnessToolDefinition[];
  readonly direct?: readonly HarnessToolDefinition[];
  readonly staticDeferred?: readonly HarnessToolDefinition[];
}

function announce(state: CatalogState, announced?: Readonly<Record<string, string>>) {
  const dynamic = state.dynamic ?? [];
  const direct = state.direct ?? [];
  return dynamicToolAnnouncements(
    {
      deferred: new Map([...(state.staticDeferred ?? []), ...dynamic].map((t) => [t.name, t])),
      dynamic: new Set([...dynamic, ...direct].map(({ name }) => name)),
    },
    announced,
  );
}

/**
 * What the harness appends when the catalog goes from `previous` to `next`,
 * after `previous` was recorded as the session's baseline.
 */
function appended(previous: CatalogState, next: CatalogState): string | undefined {
  const before = announce(previous, undefined)[KEY]!.value;
  const after = announce(next, { [KEY]: before })[KEY];
  return after === undefined || after.value === before ? undefined : after.render(before);
}

describe("dynamicToolAnnouncements", () => {
  it("records the first step as a silent baseline, even with no dynamic entries", () => {
    for (const state of [{}, { dynamic: [tool("a")] }]) {
      const baseline = announce(state)[KEY]!;
      expect(baseline.render(undefined)).toBeUndefined();
    }
    expect(announce({})[KEY]!.value).toBe("[]");
    expect(announce({ dynamic: [tool("a")] })[KEY]!.value).toBe('["a"]');
  });

  it("names each dynamic deferred tool added after the baseline, without its description", () => {
    expect(
      appended(
        {},
        {
          dynamic: [tool("tenant__sync", "Sync the tenant."), tool("export_report", "Export it.")],
        },
      ),
    ).toBe(hint("export_report", "tenant__sync"));
  });

  it("never names static deferred tools or dynamic tools that aren't deferred", () => {
    expect(appended({}, { staticDeferred: [tool("refund_invoice")] })).toBeUndefined();
    // A dynamic tool that isn't deferred is already in the tool list.
    expect(appended({}, { direct: [inlineTool("lookup")] })).toBeUndefined();
    expect(
      appended(
        { staticDeferred: [tool("refund_invoice")] },
        { dynamic: [tool("tenant__sync")], staticDeferred: [tool("refund_invoice")] },
      ),
    ).toBe(hint("tenant__sync"));
  });

  it("appends nothing when the set is unchanged", () => {
    const state = { dynamic: [tool("a"), tool("b")] };

    expect(appended(state, state)).toBeUndefined();
  });

  it("appends only the tool that is new", () => {
    expect(appended({ dynamic: [tool("a")] }, { dynamic: [tool("a"), tool("b")] })).toBe(hint("b"));
  });

  it("appends nothing when a tool is removed or returns", () => {
    const both = { dynamic: [tool("a"), tool("b")] };
    const one = { dynamic: [tool("a")] };
    const recorded = announce(both)[KEY]!.value;

    expect(appended(both, one)).toBeUndefined();
    expect(announce({}, { [KEY]: recorded })).toEqual({});
    expect(announce(one, { [KEY]: recorded })[KEY]!.value).toBe(recorded);
    expect(announce(both, { [KEY]: recorded })[KEY]!.value).toBe(recorded);
  });

  it("names 20 tools, then how many more", () => {
    const names = Array.from(
      { length: 25 },
      (_, index) => `tool_${String(index + 1).padStart(2, "0")}`,
    );
    const many = names.map((name) => tool(name));

    expect(appended({}, { dynamic: many })).toBe(hint(...names.slice(0, 20), "and 5 more"));
    // The unlisted ones count as announced, so a later addition names only itself.
    expect(appended({ dynamic: many }, { dynamic: [...many, tool("tool_26")] })).toBe(
      hint("tool_26"),
    );
  });

  it("treats an unreadable record as knowing no names, and a reordered one as knowing them all", () => {
    const current = announce({ dynamic: [tool("a")] }, { [KEY]: "x" })[KEY]!;

    expect(current.value).toBe('["a"]');
    expect(current.render("x")).toBe(hint("a"));
    // A reordered list still knows every name, so nothing is new.
    expect(
      announce({ dynamic: [tool("a"), tool("b")] }, { [KEY]: '["b","a"]' })[KEY]!.render(
        '["b","a"]',
      ),
    ).toBeUndefined();
  });
});
