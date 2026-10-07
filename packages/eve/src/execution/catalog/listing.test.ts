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

/** Announces `next` after `previous` was announced; the message the model reads. */
function diff(previous: CatalogState, next: CatalogState): string | undefined {
  const before = announce(previous).catalog!.value;
  return announce(next, { catalog: before }).catalog?.render(before);
}

const deferred = (name: string) => inlineTool(name, { deferred: true });

const BASELINE: CatalogState = {
  connections: [
    { description: "Pet store inventory API", name: "petstore" },
    { description: "", name: "crm" },
    { description: "Linear issues and projects", name: "linear" },
  ],
  skills: [
    { deferred: true, name: "release_notes" },
    { deferred: true, name: "pdf-forms" },
    { name: "house-rules" },
  ],
  tools: [
    deferred("stripe_list_disputes"),
    inlineTool("add"),
    deferred("deploy_service"),
    subagentTool("researcher", { deferred: true }),
    deferred("refund_invoice"),
    subagentTool("billing_specialist", { deferred: true }),
    subagentTool("delegate"),
  ],
};

describe("catalogAnnouncements", () => {
  it("lists deferred entries by name and connections with descriptions, each group sorted", () => {
    expect(announce(BASELINE).catalog?.render(undefined)).toBe(
      [
        "More tools and skills are available than your context shows. Find them with search, call tools with execute({ tool, input }), and load skills with execute({ skill }).",
        "Tools: deploy_service, refund_invoice, stripe_list_disputes",
        "Agents: billing_specialist, researcher",
        "Skills: pdf-forms, release_notes",
        "Connections:",
        "- crm",
        "- linear: Linear issues and projects",
        "- petstore: Pet store inventory API",
      ].join("\n"),
    );
  });

  it("renders the same value for the same catalog, whatever order entries arrive in", () => {
    const reordered = {
      ...BASELINE,
      connections: [...BASELINE.connections!].reverse(),
      tools: [...BASELINE.tools!].reverse(),
    };

    expect(announce(reordered).catalog?.value).toBe(announce(BASELINE).catalog?.value);
  });

  it("announces nothing for a catalog that is empty and was never announced", () => {
    expect(announce({ skills: [{ name: "house-rules" }], tools: [inlineTool("add")] })).toEqual({});
  });

  it("announces only what changed, including what must no longer be called", () => {
    const next: CatalogState = {
      ...BASELINE,
      connections: [
        ...BASELINE.connections!.filter((connection) => connection.name !== "crm"),
        { description: "Caller-specific product catalog.", name: "dynamic-catalog" },
      ],
      skills: [...BASELINE.skills!, { deferred: true, name: "tenant-playbook" }],
      tools: [
        ...BASELINE.tools!.filter((tool) => tool.name !== "researcher"),
        deferred("tenant__sync"),
      ],
    };

    expect(diff(BASELINE, next)).toBe(
      [
        "The catalog changed.",
        "Tools added: tenant__sync",
        "Skills added: tenant-playbook",
        "Connections added or updated:",
        "- dynamic-catalog: Caller-specific product catalog.",
        "No longer available, do not call or load: researcher, crm",
      ].join("\n"),
    );
  });

  it("announces a connection whose description changed", () => {
    const next = {
      ...BASELINE,
      connections: BASELINE.connections!.map((connection) =>
        connection.name === "petstore"
          ? { ...connection, description: "Pet store inventory and orders API" }
          : connection,
      ),
    };

    expect(diff(BASELINE, next)).toBe(
      [
        "The catalog changed.",
        "Connections added or updated:",
        "- petstore: Pet store inventory and orders API",
      ].join("\n"),
    );
  });

  it("replaces the listing when that is shorter than the diff", () => {
    const previous = {
      tools: Array.from({ length: 20 }, (_, index) => deferred(`tenant_action_${index}`)),
    };

    expect(diff(previous, { tools: [deferred("echo")] })).toBe(
      [
        "The catalog changed. This list replaces the previous one.",
        "More tools and skills are available than your context shows. Find them with search, call tools with execute({ tool, input }), and load skills with execute({ skill }).",
        "Tools: echo",
      ].join("\n"),
    );
  });

  it("calls a skill gone only when it can no longer be loaded, not when it stops being deferred", () => {
    const tools = [deferred("tenant__sync")];
    const before = announce({ skills: [{ deferred: true, name: "pdf-forms" }], tools }).catalog!
      .value;

    const listed = announce({ skills: [{ name: "pdf-forms" }], tools }, { catalog: before });
    expect(listed.catalog?.render(before)).not.toContain("No longer available");
    const dropped = announce({ tools }, { catalog: before });
    expect(dropped.catalog?.render(before)).toBe(
      "The catalog changed.\nNo longer available, do not call or load: pdf-forms",
    );
  });

  it("says when an announced catalog becomes empty, and lists it in full when entries return", () => {
    const synced = announce({ tools: [deferred("tenant__sync")] }).catalog!.value;
    const empty = announce({ tools: [inlineTool("add")] }, { catalog: synced }).catalog!;

    expect(empty.render(synced)).toBe(
      "The catalog changed. It is empty now: search finds nothing, and execute has no tools to call.",
    );
    const returned = announce({ tools: [deferred("tenant__export")] }, { catalog: empty.value });
    expect(returned.catalog?.render(empty.value)).toBe(
      [
        "More tools and skills are available than your context shows. Find them with search, call tools with execute({ tool, input }), and load skills with execute({ skill }).",
        "Tools: tenant__export",
      ].join("\n"),
    );
  });
});
