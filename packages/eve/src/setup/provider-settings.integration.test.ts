import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  providerSettingsPath,
  providerSettingsMatch,
  readProviderSelection,
  readProviderSelectionSync,
  resolveAvailableProviders,
  writeProviderSelection,
} from "./provider-settings.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("provider settings", () => {
  it("resolves available providers independently from the stored selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-provider-settings-"));
    roots.push(root);
    await writeFile(join(root, ".env.local"), "AI_GATEWAY_API_KEY=key\nVERCEL_OIDC_TOKEN=token\n");

    await expect(resolveAvailableProviders(root, { env: {} })).resolves.toEqual([
      "chatgpt",
      "ai-gateway-key",
      "ai-gateway-project",
    ]);
    await expect(readProviderSelection(root)).resolves.toBeUndefined();

    await writeProviderSelection(root, "chatgpt");

    await expect(resolveAvailableProviders(root, { env: {} })).resolves.toEqual([
      "chatgpt",
      "ai-gateway-key",
      "ai-gateway-project",
    ]);
    await expect(readProviderSelection(root)).resolves.toBe("chatgpt");
  });

  it("stores one normalized provider selection under .eve", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-provider-settings-"));
    roots.push(root);

    await writeProviderSelection(root, "ai-gateway-project");

    await expect(readProviderSelection(root)).resolves.toBe("ai-gateway-project");
    expect(readProviderSelectionSync(root)).toBe("ai-gateway-project");
    expect(providerSettingsPath(root)).toBe(join(root, ".eve", "provider.json"));
  });

  it("treats missing settings as no explicit selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-provider-settings-"));
    roots.push(root);

    await expect(readProviderSelection(root)).resolves.toBeUndefined();
    expect(readProviderSelectionSync(root)).toBeUndefined();
  });
});

it("compares connection, team, and key source before deciding whether activation is needed", async () => {
  const root = await mkdtemp(join(tmpdir(), "eve-provider-settings-"));
  roots.push(root);
  const team = { teamId: "team_a", teamName: "Alice" };
  expect(await providerSettingsMatch(root, { selected: "vercel", ...team })).toBe(false);
  await writeProviderSelection(root, "vercel", team);
  expect(await providerSettingsMatch(root, { selected: "vercel", ...team })).toBe(true);
  expect(await providerSettingsMatch(root, { selected: "vercel", ...team, teamId: "team_b" })).toBe(
    false,
  );
  expect(await providerSettingsMatch(root, { selected: "vercel-cli", ...team })).toBe(false);
  await writeProviderSelection(root, "openai", undefined, "environment");
  expect(await providerSettingsMatch(root, { selected: "openai", keySource: "environment" })).toBe(
    true,
  );
  expect(await providerSettingsMatch(root, { selected: "openai", keySource: "secret" })).toBe(
    false,
  );
});
