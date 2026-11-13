import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hash, linkConfig, LinkSetupError, seal, unseal } from "../server/link/config";
import { linkOwner, safeLinkCall } from "../server/link/oauth";
import { linkAuth } from "../agent/lib/link-auth";

afterEach(() => vi.unstubAllEnvs());

describe("Link credential boundary", () => {
  it("encrypts with fresh nonces and authenticates the owner and payload", () => {
    const key = randomBytes(32);
    const first = seal({ token: "private-token" }, key, "owner-a");
    expect(first).not.toContain("private-token");
    expect(first).not.toBe(seal({ token: "private-token" }, key, "owner-a"));
    expect(unseal(first, key, "owner-a")).toEqual({ token: "private-token" });
    expect(() => unseal(first, key, "owner-b")).toThrow("could not be decrypted");
    expect(() => unseal(first, randomBytes(32), "owner-a")).toThrow("could not be decrypted");
    const parts = first.split(".");
    parts[3] = `${parts[3][0] === "A" ? "B" : "A"}${parts[3].slice(1)}`;
    expect(() => unseal(parts.join("."), key, "owner-a")).toThrow("could not be decrypted");
  });

  it("rejects web, service, and malformed identities before loading any secrets", async () => {
    vi.stubEnv("DATABASE_URL", "");
    for (const principal of [
      { type: "app" as const },
      { type: "user" as const, id: "local-dev" },
      { type: "user" as const, id: "linq:person", issuer: "web" },
      { type: "user" as const, id: "", issuer: "linq" },
    ]) {
      expect(() => linkOwner(principal)).toThrow();
      await expect(linkAuth.getToken({ principal, connection: { url: "" } })).rejects.toMatchObject({ reason: "principal_required" });
    }
    expect(linkOwner({ type: "user", issuer: "linq", id: "linq:sender" })).toEqual({ issuer: "linq", id: "linq:sender" });
  });

  it("does not expose arbitrary database or transport errors", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const call = safeLinkCall(async () => { throw new Error("postgres://user:secret@host"); });
    await expect(call).rejects.toMatchObject({ reason: "link_unavailable", retryable: false });
    await expect(call).rejects.not.toThrow("secret");
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "link.error", reason: "unexpected_error" }));
  });

  it.each([
    [new LinkSetupError("missing_configuration", "DATABASE_URL"), "missing_configuration", "DATABASE_URL"],
    [new LinkSetupError("credentials_unreadable", "LINK_TOKEN_ENCRYPTION_KEY"), "credentials_unreadable", "LINK_TOKEN_ENCRYPTION_KEY"],
    [Object.assign(new Error("private SQL content"), { code: "42P01" }), "database_migration_required", undefined],
    [Object.assign(new Error("postgres://user:secret@host"), { code: "ECONNREFUSED" }), "database_unavailable", undefined],
  ])("reports only safe operator diagnostics", async (error, reason, setting) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(safeLinkCall(async () => { throw error; })).rejects.toMatchObject({ reason: "link_unavailable" });
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "link.error", reason, ...(setting ? { setting } : {}) }));
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|private SQL/);
  });

  it("requires an exact public origin and a 256-bit server key", () => {
    for (const name of ["DATABASE_URL", "LINK_CLIENT_ID", "LINK_CLIENT_SECRET", "STRIPE_PUBLISHABLE_KEY"])
      vi.stubEnv(name, "test-value");
    vi.stubEnv("BELL_PUBLIC_URL", "http://127.0.0.1:4320");
    vi.stubEnv("LINK_TOKEN_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    expect(linkConfig().redirectUri).toBe("http://127.0.0.1:4320/api/link/oauth/callback");
    for (const value of ["http://bell.example", "https://bell.example/path", "https://user:pass@bell.example"] ) {
      vi.stubEnv("BELL_PUBLIC_URL", value);
      expect(() => linkConfig()).toThrow();
    }
    vi.stubEnv("BELL_PUBLIC_URL", "https://bell.example");
    vi.stubEnv("LINK_TOKEN_ENCRYPTION_KEY", "not-a-key");
    expect(() => linkConfig()).toThrow("LINK_TOKEN_ENCRYPTION_KEY");
    expect(hash("verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
