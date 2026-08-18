import { describe, expect, it } from "vitest";

import { createCliTheme } from "#cli/ui/output.js";

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
    expect(renderDoctorHuman(result, createCliTheme({ color: false }))).toBe(
      "eve Doctor\n==========\nLocal environment and project checks. No network calls or changes.\n\nEnvironment\n✓ Node is available.\n\nGit\n! No remote; local development is unaffected.\n\n0 failures, 1 warnings, 0 unknown",
    );
  });

  it("colors status symbols and command remediation in a terminal", () => {
    const colored = renderDoctorHuman(
      {
        summary: { pass: 0, warn: 0, fail: 1, unknown: 0 },
        diagnostics: [
          {
            id: "package.dependencies",
            status: "fail",
            summary: "Dependencies are missing.",
            remediation: [{ kind: "command", command: "pnpm install" }],
          },
        ],
      },
      createCliTheme({ color: true }),
    );

    expect(colored).toContain("\u001B[36mPackages\u001B[39m");
    expect(colored).toContain("\u001B[31m✗\u001B[39m");
    expect(colored).toContain("\u001B[34mpnpm install\u001B[39m");
  });

  it("renders only the machine result without a schema version", () => {
    const json = JSON.parse(renderDoctorJson(result)) as Record<string, unknown>;
    expect(json).toEqual(result);
    expect(json).not.toHaveProperty("schemaVersion");
  });
});
