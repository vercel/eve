import { describe, expect, it } from "vitest";

import { parseExtensionMountSpecifier } from "#discover/extension-specifier.js";

describe("parseExtensionMountSpecifier", () => {
  it("reads a bare default re-export", () => {
    expect(parseExtensionMountSpecifier('export { default } from "@acme/crm";')).toBe("@acme/crm");
  });

  it("reads the factory form with a named import", () => {
    const source = [
      'import { crm } from "@acme/crm";',
      "export default crm({ apiKey: process.env.CRM_API_KEY });",
    ].join("\n");
    expect(parseExtensionMountSpecifier(source)).toBe("@acme/crm");
  });

  it("reads the factory form with a default import", () => {
    const source = ['import crm from "@acme/crm";', "export default crm();"].join("\n");
    expect(parseExtensionMountSpecifier(source)).toBe("@acme/crm");
  });

  it("resolves the aliased named import that binds the exported value", () => {
    const source = [
      'import { search } from "eve/tools";',
      'import { crm as mount } from "@acme/crm";',
      "export default mount({});",
    ].join("\n");
    expect(parseExtensionMountSpecifier(source)).toBe("@acme/crm");
  });

  it("does not confuse an unrelated import with the mounted one", () => {
    const source = [
      'import { z } from "zod";',
      'import { crm } from "@acme/crm";',
      "export default crm();",
    ].join("\n");
    expect(parseExtensionMountSpecifier(source)).toBe("@acme/crm");
  });

  it("preserves a specifier that contains slashes", () => {
    expect(parseExtensionMountSpecifier('export { default } from "@acme/crm/mount";')).toBe(
      "@acme/crm/mount",
    );
  });

  it("returns null when no mount shape is present", () => {
    expect(parseExtensionMountSpecifier("export const value = 1;")).toBeNull();
  });
});
