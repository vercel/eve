import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  gatewayCredentialPreferencePath,
  readGatewayCredentialPreference,
  writeGatewayCredentialPreference,
} from "./gateway-credential-preference.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Gateway credential preference", () => {
  it("persists only the preferred Gateway credential under .eve", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-gateway-credential-"));
    roots.push(root);

    await writeGatewayCredentialPreference(root, "project");

    await expect(readGatewayCredentialPreference(root)).resolves.toBe("project");
    expect(gatewayCredentialPreferencePath(root)).toBe(
      join(root, ".eve", "gateway-credential.json"),
    );
  });

  it("treats missing settings as no explicit preference", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-gateway-credential-"));
    roots.push(root);

    await expect(readGatewayCredentialPreference(root)).resolves.toBeUndefined();
  });
});
