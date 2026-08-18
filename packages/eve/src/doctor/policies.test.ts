import { describe, expect, it } from "vitest";

import {
  dependencyDiagnostic,
  discoveryDiagnostic,
  gitDiagnostics,
  nodeDiagnostic,
} from "./policies.js";

describe("doctor policies", () => {
  it("never presents unavailable evidence as a pass", () => {
    expect(nodeDiagnostic({ kind: "unavailable", message: "missing" }, ">=24").status).toBe("fail");
    expect(
      gitDiagnostics({ kind: "unavailable", message: "git failed" }).every(
        (diagnostic) => diagnostic.status === "unknown",
      ),
    ).toBe(true);
  });

  it("uses the supplied eve Node.js engine range", () => {
    expect(
      nodeDiagnostic({ kind: "available", executable: "node", version: "24.5.0" }, ">=24.5.0"),
    ).toMatchObject({
      status: "pass",
    });
    expect(
      nodeDiagnostic({ kind: "available", executable: "node", version: "24.4.0" }, ">=24.5.0"),
    ).toMatchObject({
      status: "fail",
      summary: "Node.js 24.4.0 is unsupported; eve requires Node.js >=24.5.0.",
    });
  });

  it("keeps Git optional for local development", () => {
    expect(gitDiagnostics({ kind: "not-repository" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "git.repository", status: "warn" }),
        expect.objectContaining({ id: "git.remote", status: "warn" }),
      ]),
    );
  });

  it("explains the impact and gives the dependency retry command", () => {
    expect(dependencyDiagnostic({ kind: "missing" }, "npm")).toMatchObject({
      id: "package.dependencies",
      status: "fail",
      summary: "Project dependencies are not installed; commands that load project code may fail.",
      remediation: [{ kind: "command", command: "npm install" }],
    });
  });

  it("does not expose project layout in user-facing discovery output", () => {
    expect(
      discoveryDiagnostic({
        kind: "resolved",
        project: { agentRoot: "/project/agent", appRoot: "/project", layout: "nested" },
      }),
    ).toMatchObject({ summary: "Found eve project at /project." });
  });

  it("explains why optional Git setup may still matter", () => {
    expect(gitDiagnostics({ kind: "not-repository" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "git.repository",
          summary: expect.stringContaining("cannot commit or share changes"),
        }),
        expect.objectContaining({
          id: "git.remote",
          summary: expect.stringContaining("cannot push or share this repository"),
        }),
      ]),
    );
  });
});
