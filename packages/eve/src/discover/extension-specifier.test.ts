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

  it.each(["const", "let", "var"])("reads a %s mount with an emitted default export", (kind) => {
    const source = `import{config}from"./config.js";import code from"eve/extensions/code";${kind} code_default=code({github:config()});export{code_default as default};`;
    expect(parseExtensionMountSpecifier(source)).toBe("eve/extensions/code");
  });

  it("resolves an emitted factory's aliased named import", () => {
    const source =
      'import{crm as mount}from"@acme/crm";const crm_default=mount({});export{crm_default as default};';
    expect(parseExtensionMountSpecifier(source)).toBe("@acme/crm");
  });

  it("does not use an unrelated factory for an emitted default export", () => {
    const source =
      'import crm from"@acme/crm";const other=crm({});const exported={};export{exported as default};';
    expect(parseExtensionMountSpecifier(source)).toBeNull();
  });

  it("returns null when no mount shape is present", () => {
    expect(parseExtensionMountSpecifier("export const value = 1;")).toBeNull();
  });
});
