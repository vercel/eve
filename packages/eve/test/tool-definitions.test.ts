import { describe, expect, it } from "vitest";

import bash from "../src/public/tools/bash.js";
import glob from "../src/public/tools/glob.js";
import grep from "../src/public/tools/grep.js";
import loadSkill from "../src/public/tools/load-skill.js";
import readFile from "../src/public/tools/read-file.js";
import todo from "../src/public/tools/todo.js";
import webFetch from "../src/public/tools/web-fetch.js";
import writeFile from "../src/public/tools/write-file.js";

/**
 * Smoke tests for the per-tool `eve/tools/<name>` default exports.
 *
 * These verify that every canonical public tool definition carries its
 * expected shape so wiring breakage surfaces immediately.
 */
describe("public tool definition exports", () => {
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

  it("loadSkill has description and execute", () => {
    expect(loadSkill.description).toBeTypeOf("string");
    expect(loadSkill.execute).toBeTypeOf("function");
  });
});
