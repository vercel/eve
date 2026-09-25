import { describe, expect, it } from "vitest";

import { renderDoctorHuman } from "./render.js";

const escape = String.fromCharCode(27);

describe("renderDoctorHuman", () => {
  it("removes terminal controls from human output without changing JSON facts", () => {
    const output = renderDoctorHuman({
      agents: [],
      diagnostics: [
        {
          id: "project.discovery",
          status: "fail",
          summary: `Invalid project ${escape}]8;;https://example.com${escape}\\name`,
          remediation: [{ kind: "command", command: `eve init ${escape}[31mproject` }],
        },
      ],
      scope: "standalone",
      summary: { pass: 0, warn: 0, fail: 1, unknown: 0 },
      workspaceRoot: null,
    });

    expect(output).not.toContain(escape);
    expect(output).toContain("Invalid project name");
    expect(output).toContain("eve init project");
  });
});
