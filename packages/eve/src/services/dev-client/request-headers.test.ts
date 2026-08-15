import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";
import { createFakeVercelOidcToken } from "#internal/testing/vercel-oidc-token.js";
import { readVercelProjectLink } from "#internal/vercel/project-link.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveDevelopmentOidcToken,
  resolveLinkedDevelopmentOidcToken,
} from "./request-headers.js";

vi.mock("#compiled/@vercel/oidc/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#compiled/@vercel/oidc/index.js")>()),
  getVercelOidcToken: vi.fn(),
}));

vi.mock("#internal/vercel/project-link.js", () => ({
  readVercelProjectLink: vi.fn(),
}));

const target = { ownerId: "team_expected", projectId: "prj_expected" } as const;

const token = createFakeVercelOidcToken;

afterEach(() => {
  vi.mocked(getVercelOidcToken).mockReset();
  vi.mocked(readVercelProjectLink).mockReset();
});

describe("resolveDevelopmentOidcToken", () => {
  it("returns a token whose owner and project match the verified target", async () => {
    const expected = token({ owner_id: target.ownerId, project_id: target.projectId });
    vi.mocked(getVercelOidcToken).mockResolvedValue(expected);

    await expect(resolveDevelopmentOidcToken(target)).resolves.toEqual({
      kind: "resolved",
      token: expected,
    });
    expect(getVercelOidcToken).toHaveBeenCalledWith({
      team: target.ownerId,
      project: target.projectId,
    });
  });

  it("forces a refresh for an explicitly selected project", async () => {
    const expected = token({ owner_id: target.ownerId, project_id: target.projectId });
    vi.mocked(getVercelOidcToken).mockResolvedValue(expected);

    await expect(resolveDevelopmentOidcToken({ ...target, forceRefresh: true })).resolves.toEqual({
      kind: "resolved",
      token: expected,
    });
    expect(getVercelOidcToken).toHaveBeenCalledWith({
      team: target.ownerId,
      project: target.projectId,
      expirationBufferMs: Number.MAX_SAFE_INTEGER,
    });
  });

  it("reports a token minted for a different project", async () => {
    vi.mocked(getVercelOidcToken).mockResolvedValue(
      token({ owner_id: target.ownerId, project_id: "prj_other" }),
    );

    await expect(resolveDevelopmentOidcToken(target)).resolves.toEqual({
      kind: "target-mismatch",
      mismatchedClaims: ["project_id"],
    });
  });

  it("reports claims that do not match the Vercel OIDC schema", async () => {
    vi.mocked(getVercelOidcToken).mockResolvedValue(token({ subject: "user" }));

    await expect(resolveDevelopmentOidcToken(target)).resolves.toMatchObject({
      kind: "invalid-claims",
      invalidClaims: expect.arrayContaining([
        expect.stringContaining("owner_id"),
        expect.stringContaining("project_id"),
      ]),
    });
  });

  it("reports a token without a JWT payload", async () => {
    vi.mocked(getVercelOidcToken).mockResolvedValue("not-a-jwt");

    await expect(resolveDevelopmentOidcToken(target)).resolves.toEqual({
      kind: "malformed-token",
      reason: "missing-payload",
    });
  });

  it("reports a JWT payload that is not valid JSON", async () => {
    const payload = Buffer.from("not json").toString("base64url");
    vi.mocked(getVercelOidcToken).mockResolvedValue(`header.${payload}.signature`);

    await expect(resolveDevelopmentOidcToken(target)).resolves.toEqual({
      kind: "malformed-token",
      reason: "invalid-json-payload",
    });
  });

  it("reports why token resolution failed", async () => {
    vi.mocked(getVercelOidcToken).mockRejectedValue(new Error("refresh failed"));

    await expect(resolveDevelopmentOidcToken(target)).resolves.toEqual({
      kind: "resolution-failed",
      message: "refresh failed",
    });
  });
});

describe("resolveLinkedDevelopmentOidcToken", () => {
  it("uses the current local project link to resolve the request bearer", async () => {
    vi.mocked(readVercelProjectLink).mockResolvedValue({
      orgId: target.ownerId,
      projectId: target.projectId,
    });
    const expected = token({
      environment: "development",
      owner_id: target.ownerId,
      project_id: target.projectId,
      user_id: "user_ada",
    });
    vi.mocked(getVercelOidcToken).mockResolvedValue(expected);

    await expect(resolveLinkedDevelopmentOidcToken("/workspace")).resolves.toBe(expected);
    expect(getVercelOidcToken).toHaveBeenCalledWith({
      team: target.ownerId,
      project: target.projectId,
    });
  });

  it("refreshes a stale token after the linked project changes", async () => {
    vi.mocked(readVercelProjectLink).mockResolvedValue({
      orgId: target.ownerId,
      projectId: target.projectId,
    });
    const stale = token({
      environment: "development",
      owner_id: target.ownerId,
      project_id: "prj_previous",
      user_id: "user_ada",
    });
    const refreshed = token({
      environment: "development",
      owner_id: target.ownerId,
      project_id: target.projectId,
      user_id: "user_ada",
    });
    vi.mocked(getVercelOidcToken).mockResolvedValueOnce(stale).mockResolvedValueOnce(refreshed);

    await expect(resolveLinkedDevelopmentOidcToken("/workspace")).resolves.toBe(refreshed);
    expect(getVercelOidcToken).toHaveBeenNthCalledWith(1, {
      team: target.ownerId,
      project: target.projectId,
    });
    expect(getVercelOidcToken).toHaveBeenNthCalledWith(2, {
      team: target.ownerId,
      project: target.projectId,
      expirationBufferMs: Number.MAX_SAFE_INTEGER,
    });
  });

  it("refreshes a matching token that cannot authenticate a local user", async () => {
    vi.mocked(readVercelProjectLink).mockResolvedValue({
      orgId: target.ownerId,
      projectId: target.projectId,
    });
    const deploymentToken = token({
      environment: "preview",
      owner_id: target.ownerId,
      project_id: target.projectId,
    });
    const refreshed = token({
      environment: "development",
      owner_id: target.ownerId,
      project_id: target.projectId,
      user_id: "user_ada",
    });
    vi.mocked(getVercelOidcToken)
      .mockResolvedValueOnce(deploymentToken)
      .mockResolvedValueOnce(refreshed);

    await expect(resolveLinkedDevelopmentOidcToken("/workspace")).resolves.toBe(refreshed);
    expect(getVercelOidcToken).toHaveBeenNthCalledWith(2, {
      team: target.ownerId,
      project: target.projectId,
      expirationBufferMs: Number.MAX_SAFE_INTEGER,
    });
  });

  it("does not send a bearer when the local directory is unlinked", async () => {
    vi.mocked(readVercelProjectLink).mockResolvedValue(undefined);

    await expect(resolveLinkedDevelopmentOidcToken("/workspace")).resolves.toBe("");
    expect(getVercelOidcToken).not.toHaveBeenCalled();
  });

  it("falls back to no bearer when the local OIDC token is unavailable", async () => {
    vi.mocked(readVercelProjectLink).mockResolvedValue({
      orgId: target.ownerId,
      projectId: target.projectId,
    });
    vi.mocked(getVercelOidcToken).mockRejectedValue(new Error("not logged in"));

    await expect(resolveLinkedDevelopmentOidcToken("/workspace")).resolves.toBe("");
  });

  it("reads the current project link for every request", async () => {
    const first = token({
      environment: "development",
      owner_id: "team_first",
      project_id: "prj_first",
      user_id: "user_ada",
    });
    const second = token({
      environment: "development",
      owner_id: "team_second",
      project_id: "prj_second",
      user_id: "user_ada",
    });
    vi.mocked(readVercelProjectLink)
      .mockResolvedValueOnce({ orgId: "team_first", projectId: "prj_first" })
      .mockResolvedValueOnce({ orgId: "team_second", projectId: "prj_second" });
    vi.mocked(getVercelOidcToken).mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    await expect(resolveLinkedDevelopmentOidcToken("/workspace")).resolves.toBe(first);
    await expect(resolveLinkedDevelopmentOidcToken("/workspace")).resolves.toBe(second);
    expect(getVercelOidcToken).toHaveBeenNthCalledWith(1, {
      team: "team_first",
      project: "prj_first",
    });
    expect(getVercelOidcToken).toHaveBeenNthCalledWith(2, {
      team: "team_second",
      project: "prj_second",
    });
  });
});
