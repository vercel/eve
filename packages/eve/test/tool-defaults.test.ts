import { describe, expect, it } from "vitest";

import {
  bash,
  glob,
  grep,
  loadSkill,
  readFile,
  todo,
  webFetch,
  webSearch,
  writeFile,
} from "../src/public/tools/defaults.js";

/**
 * Smoke tests for the `eve/tools/defaults` barrel exports.
 *
 * These verify that every re-exported default carries its expected shape
 * so wiring breakage in the barrel re-export chain surfaces immediately.
 */
describe("tool defaults barrel exports", () => {
  it("bash has description and execute", () => {
    expect(bash.description).toBeTypeOf("string");
    expect(bash.execute).toBeTypeOf("function");
  });

  it("glob has description, execute, and inputSchema", () => {
    expect(glob.description).toBeTypeOf("string");
    expect(glob.execute).toBeTypeOf("function");
    expect(glob.inputSchema).toBeDefined();
  });

  it("grep has description, execute, and inputSchema", () => {
    expect(grep.description).toBeTypeOf("string");
    expect(grep.execute).toBeTypeOf("function");
    expect(grep.inputSchema).toBeDefined();
  });

  it("readFile has description, execute, and inputSchema", () => {
    expect(readFile.description).toBeTypeOf("string");
    expect(readFile.execute).toBeTypeOf("function");
    expect(readFile.inputSchema).toBeDefined();
  });

  it("writeFile has description and execute", () => {
    expect(writeFile.description).toBeTypeOf("string");
    expect(writeFile.execute).toBeTypeOf("function");
  });

  it("todo has description and execute", () => {
    expect(todo.description).toBeTypeOf("string");
    expect(todo.execute).toBeTypeOf("function");
  });

  it("webFetch has description and execute", () => {
    expect(webFetch.description).toBeTypeOf("string");
    expect(webFetch.execute).toBeTypeOf("function");
  });

  it("webSearch has description and execute", () => {
    expect(webSearch.description).toBeTypeOf("string");
    expect(webSearch.execute).toBeTypeOf("function");
  });

  it("loadSkill has description and execute", () => {
    expect(loadSkill.description).toBeTypeOf("string");
    expect(loadSkill.execute).toBeTypeOf("function");
  });
});
