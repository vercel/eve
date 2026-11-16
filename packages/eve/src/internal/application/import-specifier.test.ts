import { describe, expect, it } from "vitest";

import { normalizeEsmImportSpecifier, stringifyEsmImportSpecifier } from "./import-specifier.js";

describe("normalizeEsmImportSpecifier", () => {
  it("converts Windows drive-letter paths to file URLs", () => {
    expect(
      normalizeEsmImportSpecifier("G:\\projects\\test eve\\node_modules\\pkg\\dist\\route.js"),
    ).toBe("file:///G:/projects/test%20eve/node_modules/pkg/dist/route.js");
    expect(normalizeEsmImportSpecifier("G:/projects/test-eve/route.js")).toBe(
      "file:///G:/projects/test-eve/route.js",
    );
    expect(normalizeEsmImportSpecifier("/G:/projects/test-eve/route.js")).toBe(
      "file:///G:/projects/test-eve/route.js",
    );
    expect(normalizeEsmImportSpecifier("G:\\projects\\test-eve\\route.js?meta")).toBe(
      "file:///G:/projects/test-eve/route.js?meta",
    );
  });

  it("converts Windows UNC paths to file URLs", () => {
    expect(normalizeEsmImportSpecifier("\\\\server\\share\\test eve\\route.js")).toBe(
      "file://server/share/test%20eve/route.js",
    );
  });

  it("leaves POSIX absolute paths as path specifiers", () => {
    expect(normalizeEsmImportSpecifier("/tmp/test eve/route.js")).toBe("/tmp/test eve/route.js");
  });

  it("leaves existing file URLs and package specifiers intact", () => {
    expect(normalizeEsmImportSpecifier("file:///G:/projects/test-eve/route.js")).toBe(
      "file:///G:/projects/test-eve/route.js",
    );
    expect(normalizeEsmImportSpecifier("workflow/api")).toBe("workflow/api");
  });

  it("normalizes relative specifier separators", () => {
    expect(normalizeEsmImportSpecifier(".\\routes\\handler.js")).toBe("./routes/handler.js");
  });
});

describe("stringifyEsmImportSpecifier", () => {
  it("serializes normalized specifiers for generated source", () => {
    expect(stringifyEsmImportSpecifier("G:\\projects\\test-eve\\route.js")).toBe(
      JSON.stringify("file:///G:/projects/test-eve/route.js"),
    );
  });
});
