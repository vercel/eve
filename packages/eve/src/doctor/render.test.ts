import { describe, expect, it } from "vitest";

import { renderDoctorHuman, renderDoctorJson } from "./render.js";

const result = {
  summary: { pass: 1, warn: 1, fail: 0, unknown: 0 },
  diagnostics: [
    { id: "runtime.node", status: "pass" as const, summary: "Node is available.", remediation: [] },
    {
      id: "git.remote",
      status: "warn" as const,
      summary: "No remote; local development is unaffected.",
      remediation: [],
    },
  ],
};

describe("doctor rendering", () => {
  it("renders a human checklist and summary", () => {
    expect(renderDoctorHuman(result)).toBe(
      "✓ Node is available.\n! No remote; local development is unaffected.\n\n0 failures, 1 warnings, 0 unknown",
    );
  });

  it("renders only the machine result without a schema version", () => {
    const json = JSON.parse(renderDoctorJson(result)) as Record<string, unknown>;
    expect(json).toEqual(result);
    expect(json).not.toHaveProperty("schemaVersion");
  });
});
