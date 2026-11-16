import { describe, expect, it } from "vitest";

import {
  deriveAnalystUrl,
  derivedLoginProblem,
  derivePassword,
  isEnabled,
  loginUrl,
  urlUser,
} from "./derived-login";

const OWNER =
  "postgresql://postgres:owner-secret@db.example.com:5432/app?sslmode=require";

describe(derivePassword, () => {
  it.each([
    `${OWNER}&x=1`,
    "postgres://postgres:owner-secret@db.example.com:5432/app",
    "postgresql://postgres:owner-secret@db.example.com:5432/app_preview",
    "postgresql://other:owner-secret@pooler.example.com:6543/app",
  ])("gives the same value for %s, which shares the owner password", (url) => {
    expect(derivePassword(url)).toBe(derivePassword(OWNER));
  });

  it("differs when the owner password differs", () => {
    expect(derivePassword(OWNER.replace("owner-secret", "rotated"))).not.toBe(
      derivePassword(OWNER)
    );
  });

  it("decodes a percent-encoded owner password", () => {
    const encoded = "postgres://u:p%40ss%3Aword@db.example.com/app";
    expect(derivePassword(encoded)).toBe(
      derivePassword("postgres://u:p%40ss%3aword@db.example.com/app")
    );
    expect(derivePassword("postgres://u:p%40ss@db.example.com/app")).toBe(
      derivePassword("postgres://u:p@ss@db.example.com/app")
    );
  });

  it("refuses a URL without a password", () => {
    expect(() => derivePassword("postgres://u@db.example.com/app")).toThrow(
      "DATABASE_URL needs a password"
    );
    expect(() => derivePassword("postgres://u:@db.example.com/app")).toThrow(
      "DATABASE_URL needs a password"
    );
  });

  it("is URL-safe and doesn't contain the owner password", () => {
    expect(derivePassword(OWNER)).toMatch(/^[\w-]{40,}$/u);
    expect(derivePassword(OWNER)).not.toContain("owner-secret");
  });
});

describe(deriveAnalystUrl, () => {
  it("swaps in the read-only login and keeps the host, database, and options", () => {
    const url = new URL(deriveAnalystUrl(OWNER));
    expect(url.username).toBe("eve_analyst");
    expect(url.password).toBe(derivePassword(OWNER));
    expect(url.host).toBe("db.example.com:5432");
    expect(url.pathname).toBe("/app");
    expect(url.searchParams.get("sslmode")).toBe("require");
  });

  it("keeps a pooler's project suffix in the user name", () => {
    const pooled =
      "postgresql://postgres.abcdefgh:secret@pooler.example.com:6543/postgres";
    expect(new URL(deriveAnalystUrl(pooled)).username).toBe(
      "eve_analyst.abcdefgh"
    );
  });

  it("rejects a value that isn't a URL", () => {
    expect(() => deriveAnalystUrl("not a url")).toThrow(TypeError);
  });
});

describe(loginUrl, () => {
  const pooled =
    "postgresql://postgres.abcdefgh:secret@pooler.example.com:6543/postgres";

  it("keeps the user name suffix by default and drops it when asked", () => {
    expect(new URL(loginUrl(pooled, "reader", "pw")).username).toBe(
      "reader.abcdefgh"
    );
    expect(
      new URL(loginUrl(pooled, "reader", "pw", { keepUserSuffix: false }))
        .username
    ).toBe("reader");
    const dotted = "postgres://jane.doe:x@db.example.com/app";
    expect(
      new URL(loginUrl(dotted, "eve_analyst", "pw", { keepUserSuffix: false }))
        .username
    ).toBe("eve_analyst");
  });

  it("reads a percent-encoded user name and encodes the new password", () => {
    const url = new URL(
      loginUrl(
        "postgres://jane%2Edoe:x@db.example.com/app",
        "reader",
        "p@ss:w%rd"
      )
    );
    expect(url.username).toBe("reader.doe");
    expect(decodeURIComponent(url.password)).toBe("p@ss:w%rd");
    expect(url.host).toBe("db.example.com");
  });
});

describe(derivedLoginProblem, () => {
  it("returns null when the login can be derived", () => {
    expect(derivedLoginProblem(OWNER)).toBeNull();
  });

  it.each([
    ["no password", "postgres://u@db.example.com/app", "needs a password"],
    ["an invalid URL", "not a url", "isn't a valid connection string"],
    [
      "malformed encoding",
      "postgres://u:%zz@db.example.com/app",
      "isn't a valid connection string",
    ],
  ])("explains %s without repeating the URL", (_name, url, reason) => {
    const problem = derivedLoginProblem(url);
    expect(problem).toContain(reason);
    expect(problem).not.toContain("db.example.com");
  });
});

describe(urlUser, () => {
  it("decodes the user name", () => {
    expect(urlUser("postgres://jane%2Edoe:x@db.example.com/app")).toBe(
      "jane.doe"
    );
    expect(urlUser("postgres://db.example.com/app")).toBe("");
  });
});

describe(isEnabled, () => {
  it.each([
    ["1", true],
    [" True ", true],
    ["false", false],
    ["", false],
    [undefined, false],
  ])("reads %j as %s", (value, expected) => {
    expect(isEnabled(value)).toBe(expected);
  });
});
