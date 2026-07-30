import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readVercelProjectLink } from "./project-link.js";

const roots: string[] = [];

async function createRepoRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eve-project-link-"));
  roots.push(root);
  return root;
}

async function writeVercelFile(root: string, name: string, contents: unknown): Promise<void> {
  await mkdir(join(root, ".vercel"), { recursive: true });
  await writeFile(
    join(root, ".vercel", name),
    typeof contents === "string" ? contents : JSON.stringify(contents),
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("readVercelProjectLink", () => {
  it("reads a folder-level project.json", async () => {
    const root = await createRepoRoot();
    await writeVercelFile(root, "project.json", { projectId: "prj_a", orgId: "team_a" });

    expect(await readVercelProjectLink(root)).toEqual({ projectId: "prj_a", orgId: "team_a" });
  });

  it("prefers project.json when a repo.json also exists", async () => {
    const root = await createRepoRoot();
    await writeVercelFile(root, "project.json", { projectId: "prj_folder", orgId: "team_folder" });
    await writeVercelFile(root, "repo.json", {
      orgId: "team_repo",
      projects: [{ id: "prj_repo", directory: "." }],
    });

    expect(await readVercelProjectLink(root)).toEqual({
      projectId: "prj_folder",
      orgId: "team_folder",
    });
  });

  it("falls back to a repo.json in the same directory", async () => {
    const root = await createRepoRoot();
    await writeVercelFile(root, "repo.json", {
      orgId: "team_repo",
      remoteName: "origin",
      projects: [{ id: "prj_repo", name: "my-agent", directory: "." }],
    });

    expect(await readVercelProjectLink(root)).toEqual({
      projectId: "prj_repo",
      orgId: "team_repo",
      projectName: "my-agent",
    });
  });

  it("resolves a subdirectory project from an ancestor repo.json", async () => {
    const root = await createRepoRoot();
    await writeVercelFile(root, "repo.json", {
      projects: [
        { id: "prj_root", directory: ".", orgId: "team_a" },
        { id: "prj_agent", directory: "apps/agent", orgId: "team_a" },
      ],
    });
    const projectPath = join(root, "apps", "agent");
    await mkdir(projectPath, { recursive: true });

    expect(await readVercelProjectLink(projectPath)).toEqual({
      projectId: "prj_agent",
      orgId: "team_a",
    });
  });

  it("does not fall back to repo.json when project.json is invalid", async () => {
    const root = await createRepoRoot();
    await writeVercelFile(root, "project.json", "{ not json");
    await writeVercelFile(root, "repo.json", {
      orgId: "team_repo",
      projects: [{ id: "prj_repo", directory: "." }],
    });

    expect(await readVercelProjectLink(root)).toBeUndefined();
  });

  it("returns undefined for a malformed repo.json", async () => {
    const root = await createRepoRoot();
    await writeVercelFile(root, "repo.json", { projects: "nope" });

    expect(await readVercelProjectLink(root)).toBeUndefined();
  });

  it("does not skip a malformed repo.json for an ancestor link", async () => {
    const root = await createRepoRoot();
    await writeVercelFile(root, "repo.json", {
      orgId: "team_parent",
      projects: [{ id: "prj_parent", directory: "." }],
    });
    const projectPath = join(root, "apps", "agent");
    await writeVercelFile(projectPath, "repo.json", "{ not json");

    expect(await readVercelProjectLink(projectPath)).toBeUndefined();
  });

  it("returns undefined when the directory has no link at all", async () => {
    const root = await createRepoRoot();

    expect(await readVercelProjectLink(root)).toBeUndefined();
  });
});
