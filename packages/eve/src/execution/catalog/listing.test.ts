import { describe, expect, it } from "vitest";

import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import {
  catalogContext,
  fakeConnection,
  inlineTool,
  subagentTool,
  type CatalogSkillSource,
} from "#internal/testing/catalog-fixtures.js";

import { catalogAnnouncements } from "./listing.js";

interface CatalogState {
  readonly connections?: readonly { readonly description?: string; readonly name: string }[];
  readonly skills?: readonly CatalogSkillSource[];
  readonly tools?: readonly HarnessToolDefinition[];
}

function announce(state: CatalogState, announced?: Readonly<Record<string, string>>) {
  const { catalog } = catalogContext({
    connections: (state.connections ?? []).map((connection) =>
      fakeConnection({ ...connection, tools: [] }),
    ),
    skills: state.skills,
    tools: state.tools,
  });
  return catalogAnnouncements(catalog, announced);
}

/** The listing a session's first step appends. */
function baseline(state: CatalogState): string | undefined {
  return announce(state).catalog?.render(undefined);
}

/**
 * What the model reads when the catalog goes from `previous` to `next`. Like
 * the harness, nothing is appended while the recorded value stays the same.
 */
function appended(previous: CatalogState, next: CatalogState): string | undefined {
  const before = announce(previous).catalog!.value;
  const after = announce(next, { catalog: before }).catalog;
  return after === undefined || after.value === before ? undefined : after.render(before);
}

const deferred = (name: string) => inlineTool(name, { deferred: true });

/** `count` deferred tools under `namespace`. */
const namespace = (name: string, count: number) =>
  Array.from({ length: count }, (_, index) => deferred(`${name}__tool_${index}`));

const HEADER_GUIDANCE =
  "than are loaded here. Before saying you have no tool for a task, look for one with eve__search, which searches your own catalog, not the web.";
const NAMESPACES =
  'Namespaces, whose entries are named <namespace>__<name>; search one with "<namespace>__":';
const CONNECTIONS =
  'Connections, whose tools are named <connection>__<tool>; search one connection\'s tools with "<connection>__":';

/** A catalog shaped like a real agent's: vendored namespaces, loose entries, and connections. */
const INK: CatalogState = {
  connections: [
    { description: "Pet store inventory API", name: "petstore" },
    { description: "Linear issues and projects", name: "linear" },
  ],
  skills: [
    { deferred: true, name: "sre__incident-runbook" },
    { deferred: true, name: "support__refund-policy" },
    { name: "house-rules" },
  ],
  tools: [
    inlineTool("add"),
    deferred("sre__list_alerts"),
    deferred("sre__page_oncall"),
    deferred("d0__deploy_preview"),
    deferred("index__search_docs"),
    deferred("support__open_ticket"),
    deferred("summarize_usage"),
    subagentTool("billing_specialist", { deferred: true }),
  ],
};

describe("catalogAnnouncements", () => {
  it("names the kinds, namespaces, and connections, but no deferred entry", () => {
    const listing = baseline(INK);

    expect(listing).toBe(
      [
        `You have more tools, agents, and skills ${HEADER_GUIDANCE} Call tools with eve__tool({ name, input }) and load skills with eve__skill({ name }).`,
        `${NAMESPACES} d0, index, sre, support`,
        CONNECTIONS,
        "- linear: Linear issues and projects",
        "- petstore: Pet store inventory API",
      ].join("\n"),
    );
    const deferredNames = [
      ...INK.tools!.filter((tool) => tool.deferred === true).map((tool) => tool.name),
      ...INK.skills!.filter((skill) => skill.deferred === true).map((skill) => skill.name),
    ];
    for (const name of deferredNames) expect(listing).not.toContain(name);
  });

  it.each([
    [
      "tools",
      { tools: [deferred("export_ledger")] },
      `You have more tools ${HEADER_GUIDANCE} Call them with eve__tool({ name, input }).`,
    ],
    [
      "agents",
      { tools: [subagentTool("billing_specialist", { deferred: true })] },
      `You have more agents ${HEADER_GUIDANCE} Call them with eve__tool({ name, input }).`,
    ],
    [
      "skills",
      { skills: [{ deferred: true, name: "pdf-forms" }] },
      `You have more skills ${HEADER_GUIDANCE} Load them with eve__skill({ name }).`,
    ],
    [
      "tools and agents, but no deferred skill",
      {
        skills: [{ name: "house-rules" }],
        tools: [deferred("export_ledger"), subagentTool("researcher", { deferred: true })],
      },
      `You have more tools and agents ${HEADER_GUIDANCE} Call them with eve__tool({ name, input }).`,
    ],
    [
      "skills beside a connection, whose tools eve__tool calls",
      {
        connections: [{ description: "Linear issues", name: "linear" }],
        skills: [{ deferred: true, name: "pdf-forms" }],
      },
      `You have more skills ${HEADER_GUIDANCE} Call tools with eve__tool({ name, input }) and load skills with eve__skill({ name }).`,
    ],
    [
      "only connections",
      { connections: [{ description: "Linear issues", name: "linear" }] },
      `Your connections have more tools ${HEADER_GUIDANCE} Call them with eve__tool({ name, input }).`,
    ],
  ])("names only the kinds present: %s", (_case, state: CatalogState, header) => {
    expect(baseline(state)?.split("\n")[0]).toBe(header);
  });

  it("lists the 20 largest namespaces by name, then 'and more', and a connection's namespace only as the connection", () => {
    const large = Array.from(
      { length: 20 },
      (_, index) => `ns${String(index + 1).padStart(2, "0")}`,
    );
    const listing = baseline({
      connections: [{ description: "Linear issues", name: "linear" }],
      tools: [
        // Smaller than every listed namespace, though first by name.
        ...namespace("aa", 1),
        ...namespace("ab", 1),
        ...large.flatMap((name, index) => namespace(name, 2 + (index % 3))),
        ...namespace("linear", 5),
      ],
    });

    expect(listing?.split("\n")[1]).toBe(`${NAMESPACES} ${large.join(", ")}, and more`);
    expect(listing).toContain("- linear: Linear issues");
  });

  it("caps connections at 20 by name, then 'and more'", () => {
    const connections = Array.from({ length: 21 }, (_, index) => ({
      name: `svc${String(index + 1).padStart(2, "0")}`,
    }));

    const lines = baseline({ connections })!.split("\n");

    expect(lines.slice(2)).toEqual([
      ...connections.slice(0, 20).map(({ name }) => `- ${name}: ${name} service`),
      "- and more",
    ]);
  });

  it("renders the same value for the same catalog, whatever order entries arrive in", () => {
    const reordered = {
      ...INK,
      connections: [...INK.connections!].reverse(),
      tools: [...INK.tools!].reverse(),
    };

    expect(announce(reordered).catalog?.value).toBe(announce(INK).catalog?.value);
  });

  it("announces nothing for a catalog that is empty and was never announced", () => {
    expect(announce({ skills: [{ name: "house-rules" }], tools: [inlineTool("add")] })).toEqual({});
  });

  describe("changes", () => {
    it("appends nothing when an entry joins a listed namespace or has no namespace", () => {
      expect(
        appended(INK, {
          ...INK,
          skills: [...INK.skills!, { deferred: true, name: "sre__postmortem" }],
          tools: [...INK.tools!, deferred("sre__ack_alert"), deferred("export_ledger")],
        }),
      ).toBeUndefined();
    });

    it.each([
      ["a namespace", { ...INK, tools: [...INK.tools!, deferred("billing__refund")] }],
      [
        "a connection",
        { ...INK, connections: [...INK.connections!, { description: "CRM", name: "crm" }] },
      ],
    ])("appends the full listing again when %s appears", (_case, next: CatalogState) => {
      const message = appended(INK, next);

      expect(message).toBe(`The catalog changed.\n${baseline(next)}`);
    });

    it("names a namespace or connection that is gone", () => {
      const next: CatalogState = {
        ...INK,
        connections: INK.connections!.filter(({ name }) => name !== "linear"),
        tools: INK.tools!.filter(({ name }) => !name.startsWith("d0__")),
      };

      expect(appended(INK, next)).toBe(
        `The catalog changed.\n${baseline(next)}\nNo longer available: d0, linear`,
      );
    });

    it("does not call a namespace or connection gone when it only falls past the cap", () => {
      const twenty = Array.from(
        { length: 20 },
        (_, index) => `ns${String(index + 1).padStart(2, "0")}`,
      );
      const previous: CatalogState = {
        connections: twenty.map((name) => ({ name: `svc_${name}` })),
        tools: twenty.flatMap((name) => namespace(name, 2)),
      };
      // A larger namespace and an earlier connection push ns20 and svc_ns20 past their caps.
      const next: CatalogState = {
        connections: [{ name: "svc_ns00" }, ...previous.connections!],
        tools: [...namespace("top", 3), ...previous.tools!],
      };

      const message = appended(previous, next);

      expect(message).toContain(", and more");
      expect(message).toContain("- and more");
      expect(message).not.toContain("No longer available");
    });

    it("says when an announced catalog becomes empty, and lists it in full when entries return", () => {
      const synced = announce({ tools: [deferred("tenant__sync")] }).catalog!.value;
      const empty = announce({ tools: [inlineTool("add")] }, { catalog: synced }).catalog!;

      expect(empty.render(synced)).toBe(
        "The catalog changed. It is empty now: eve__search finds nothing.",
      );
      const returned = { tools: [deferred("tenant__export")] };
      expect(announce(returned, { catalog: empty.value }).catalog?.render(empty.value)).toBe(
        baseline(returned),
      );
    });

    it("treats an unreadable recorded value as a fresh baseline", () => {
      const recorded = "not json";

      expect(announce(INK, { catalog: recorded }).catalog?.render(recorded)).toBe(baseline(INK));
    });
  });
});
