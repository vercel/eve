import { describe, expect, it } from "vitest";

import {
  dependencyDiagnostic,
  discoveryDiagnostic,
  gitDiagnostics,
  nodeDiagnostic,
  packageManagerDiagnostic,
  vercelDiagnostic,
} from "./policies.js";

describe("doctor policies", () => {
  it("uses the supplied eve Node.js engine range", () => {
    expect(
      nodeDiagnostic({ kind: "available", executable: "node", version: "24.5.0" }, ">=24.5.0"),
    ).toMatchObject({ status: "pass" });
    expect(
      nodeDiagnostic({ kind: "available", executable: "node", version: "24.4.0" }, ">=24.5.0"),
    ).toMatchObject({ status: "fail" });
  });

  it("keeps unavailable Vercel evidence distinct from a logged-out account", () => {
    expect(vercelDiagnostic({ kind: "unavailable" })).toMatchObject({ status: "unknown" });
    expect(vercelDiagnostic({ kind: "logged-out" })).toMatchObject({
      status: "warn",
      remediation: [{ kind: "command", command: "vercel login" }],
    });
  });

  it("keeps Git optional for local development", () => {
    expect(gitDiagnostics({ kind: "not-repository" })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "git.repository", status: "warn" })]),
    );
  });

  it("explains the dependency retry command", () => {
    expect(dependencyDiagnostic({ kind: "missing", dependencies: ["eve"] }, "npm")).toMatchObject({
      remediation: [{ kind: "command", command: "npm install" }],
    });
  });

  it("describes package manager selection without its internal source enum", () => {
    expect(
      packageManagerDiagnostic({
        kind: "observed",
        manager: "pnpm",
        source: "package-manager-field",
        lockfiles: [],
        conflict: false,
      }).summary,
    ).toBe("Selected pnpm as the package manager from the packageManager field in package.json.");
  });

  it("does not expose project layout in user-facing discovery output", () => {
    expect(
      discoveryDiagnostic({
        kind: "resolved",
        project: { agentRoot: "/project/agent", appRoot: "/project", layout: "nested" },
      }),
    ).toMatchObject({ summary: "Found eve project at /project." });
  });
});
