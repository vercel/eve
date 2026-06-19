import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { resolveVersionToken } from "./version-tokens.js";

// These tests always execute from the dev tree (vitest runs over src), so the
// fallback's sources — eve's package.json and the workspace catalog — are the
// live files the assertions read independently.
const EVE_PACKAGE_JSON_URL = new URL("../../../package.json", import.meta.url);
const WORKSPACE_MANIFEST_URL = new URL("../../../../../pnpm-workspace.yaml", import.meta.url);

describe("resolveVersionToken", () => {
  it("returns stamped values untouched", () => {
    expect(resolveVersionToken("connectPackageVersion", "0.2.2")).toBe("0.2.2");
    expect(resolveVersionToken("evePackage.version", "1.0.0-beta.3")).toBe("1.0.0-beta.3");
  });

  it("resolves a catalog token from the dev tree's workspace manifest", () => {
    const resolved = resolveVersionToken("connectPackageVersion", "__VERCEL_CONNECT_VERSION__");

    const manifest = readFileSync(fileURLToPath(WORKSPACE_MANIFEST_URL), "utf8");
    expect(resolved).not.toMatch(/^__/);
    expect(manifest).toContain(`"@vercel/connect": "${resolved}"`);
  });

  it("resolves the eve version token from eve's own package.json", () => {
    const resolved = resolveVersionToken("evePackage.version", "__EVE_PACKAGE_VERSION__");

    const packageJson = JSON.parse(readFileSync(fileURLToPath(EVE_PACKAGE_JSON_URL), "utf8")) as {
      version: string;
    };
    expect(resolved).toBe(packageJson.version);
  });

  it("resolves the node engine token from eve's own package.json engines.node", () => {
    const resolved = resolveVersionToken("nodeEngine", "__NODE_ENGINE__");

    const packageJson = JSON.parse(readFileSync(fileURLToPath(EVE_PACKAGE_JSON_URL), "utf8")) as {
      engines: { node: string };
    };
    expect(resolved).toBe(packageJson.engines.node);
  });

  it("throws the unstamped error for a token with no known source", () => {
    expect(() => resolveVersionToken("somePackageVersion", "__UNKNOWN_VERSION__")).toThrow(
      /unstamped version token \(somePackageVersion=__UNKNOWN_VERSION__\)/,
    );
  });
});
