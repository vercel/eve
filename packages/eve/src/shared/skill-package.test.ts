import { describe, expect, it } from "vitest";

import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import {
  normalizeSkillPackage,
  removeSkillPackageFromSandbox,
  writeSkillPackageToSandbox,
} from "#shared/skill-package.js";

const HOME_PROBE_COMMAND = `printf '%s\\n' "$HOME"`;

describe("normalizeSkillPackage", () => {
  it("generates SKILL.md and sorts package files deterministically", () => {
    const packageDefinition = normalizeSkillPackage({
      name: "research",
      description: "Research unfamiliar topics.",
      markdown: "Use primary sources.\n",
      files: {
        "references/checklist.md": "# Checklist\n",
        "assets/query.json": new Uint8Array([1, 2, 3]),
      },
    });

    expect(packageDefinition.files.map((file) => file.relativePath)).toEqual([
      "SKILL.md",
      "assets/query.json",
      "references/checklist.md",
    ]);
    expect(packageDefinition.files[0]?.content).toEqual(Buffer.from("Use primary sources.\n"));
    expect(packageDefinition.files[1]?.content).toEqual(Buffer.from([1, 2, 3]));
    expect(packageDefinition.files[2]?.content).toEqual(Buffer.from("# Checklist\n"));
  });

  it("rejects unsafe names and package-relative paths", () => {
    for (const name of [
      "",
      " skill",
      "bad skill",
      ".skill",
      "../skill",
      "a/b",
      "a\\b",
      "C:skill",
      "skill;touch-x",
      "$(touch x)",
    ]) {
      expect(() =>
        normalizeSkillPackage({
          name,
          description: "Broken.",
          markdown: "Broken.",
        }),
      ).toThrow("Expected skill name");
    }

    for (const path of ["", "/asset.txt", "references//x.md", "../x.md", "a\\b.md", "SKILL.md"]) {
      expect(() =>
        normalizeSkillPackage({
          name: "safe",
          description: "Broken.",
          markdown: "Broken.",
          files: {
            [path]: "nope",
          },
        }),
      ).toThrow(/skill package/i);
    }
  });
});

describe("writeSkillPackageToSandbox", () => {
  it("writes generated and sibling files into the live skill package directory", async () => {
    const sandbox = mockSandbox({
      commands: {
        [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
      },
    });
    const skill = normalizeSkillPackage({
      name: "tenant",
      description: "Tenant-specific procedures.",
      markdown: "Follow tenant policy.",
      files: {
        "references/policy.md": "Policy body",
      },
    });

    await writeSkillPackageToSandbox({ sandbox: sandbox.session, skill });

    expect(sandbox.files.get("/home/agent/.agents/skills/tenant/SKILL.md")).toBe(
      "Follow tenant policy.",
    );
    expect(sandbox.files.get("/home/agent/.agents/skills/tenant/references/policy.md")).toBe(
      "Policy body",
    );
  });

  it("falls back to the legacy workspace skill directory when HOME is unavailable", async () => {
    const sandbox = mockSandbox();
    const skill = normalizeSkillPackage({
      name: "tenant",
      description: "Tenant-specific procedures.",
      markdown: "Follow tenant policy.",
    });

    await writeSkillPackageToSandbox({ sandbox: sandbox.session, skill });

    expect(sandbox.files.get("/workspace/skills/tenant/SKILL.md")).toBe("Follow tenant policy.");
  });
});

describe("removeSkillPackageFromSandbox", () => {
  it("removes only the resolved HOME package directory", async () => {
    const sandbox = mockSandbox({
      commands: {
        [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
      },
      initialFiles: {
        "/home/agent/.agents/skills/tenant_policy-1/SKILL.md": "Tenant policy",
        "/home/agent/.agents/skills/tenant_policy-1/references/policy.md": "Policy",
        "/workspace/skills/tenant_policy-1/SKILL.md": "Tenant policy",
        "/workspace/skills/tenant_policy-1/references/policy.md": "Policy",
      },
    });

    await removeSkillPackageFromSandbox({ sandbox: sandbox.session, name: "tenant_policy-1" });

    expect(sandbox.removedPaths).toEqual(["/home/agent/.agents/skills/tenant_policy-1"]);
    expect(sandbox.files.has("/home/agent/.agents/skills/tenant_policy-1/SKILL.md")).toBe(false);
    expect(
      sandbox.files.has("/home/agent/.agents/skills/tenant_policy-1/references/policy.md"),
    ).toBe(false);
    expect(sandbox.files.get("/workspace/skills/tenant_policy-1/SKILL.md")).toBe("Tenant policy");
    expect(sandbox.files.get("/workspace/skills/tenant_policy-1/references/policy.md")).toBe(
      "Policy",
    );
  });

  it("removes /workspace/skills only when HOME is unavailable", async () => {
    const sandbox = mockSandbox({
      initialFiles: {
        "/workspace/skills/tenant_policy-1/SKILL.md": "Tenant policy",
        "/workspace/skills/tenant_policy-1/references/policy.md": "Policy",
      },
    });

    await removeSkillPackageFromSandbox({ sandbox: sandbox.session, name: "tenant_policy-1" });

    expect(sandbox.removedPaths).toEqual(["/workspace/skills/tenant_policy-1"]);
    expect(sandbox.files.has("/workspace/skills/tenant_policy-1/SKILL.md")).toBe(false);
    expect(sandbox.files.has("/workspace/skills/tenant_policy-1/references/policy.md")).toBe(false);
  });

  it("rejects names that are unsafe as skill package path segments", async () => {
    const sandbox = mockSandbox();

    await expect(
      removeSkillPackageFromSandbox({ sandbox: sandbox.session, name: "tenant;touch-x" }),
    ).rejects.toThrow("Expected skill name");
    expect(sandbox.removedPaths).toEqual([]);
  });
});
