import { describe, expect, it } from "vitest";

import { dependencyDiagnostic, gitDiagnostics, nodeDiagnostic } from "./policies.js";

describe("doctor policies", () => {
  it("never presents unavailable evidence as a pass", () => {
    expect(nodeDiagnostic({ kind: "unavailable", message: "missing" }).status).toBe("fail");
    expect(
      gitDiagnostics({ kind: "unavailable", message: "git failed" }).every(
        (diagnostic) => diagnostic.status === "unknown",
      ),
    ).toBe(true);
  });

  it("keeps Git optional for local development", () => {
    expect(gitDiagnostics({ kind: "not-repository" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "git.repository", status: "warn" }),
        expect.objectContaining({ id: "git.remote", status: "warn" }),
      ]),
    );
  });

  it("gives the exact dependency retry command", () => {
    expect(dependencyDiagnostic({ kind: "missing" }, "npm")).toMatchObject({
      id: "package.dependencies",
      status: "fail",
      remediation: [{ kind: "command", command: "npm install" }],
    });
  });
});
