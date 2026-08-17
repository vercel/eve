import { existsSync, readFileSync } from "node:fs";

import { expect, test } from "vitest";

const connectionPath = "agent/connections/inventory.ts";

test("creates the filesystem-named OpenAPI connection", () => {
  expect(existsSync(connectionPath)).toBe(true);
  const source = readFileSync(connectionPath, "utf8");
  expect(source).toMatch(/defineOpenAPIConnection\s*\(/);
  expect(source).toMatch(/inventoryOpenApiSpec/);
  expect(source).toContain("https://inventory.example.com");
});

test("keeps credentials out of model control and exposes only getStock", () => {
  const source = readFileSync(connectionPath, "utf8");
  expect(source).toMatch(/getToken/);
  expect(source).toMatch(/process\.env(?:\.INVENTORY_API_TOKEN|\[["']INVENTORY_API_TOKEN["']\])/);
  expect(source).toMatch(/operations\s*:\s*{\s*allow\s*:\s*\[\s*["']getStock["']/s);
  expect(source).not.toMatch(/allow\s*:\s*\[[^\]]*["']reserveStock["']/s);
});
