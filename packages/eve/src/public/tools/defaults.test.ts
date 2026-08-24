import { describe, expect, it } from "vitest";

import frameworkBash from "#framework-sources/tools/bash.js";
import frameworkConnectionSearch from "#framework-sources/tools/connection_search.js";
import frameworkLoadSkill from "#framework-sources/tools/load_skill.js";
import frameworkReadFile from "#framework-sources/tools/read_file.js";
import frameworkTodo from "#framework-sources/tools/todo.js";
import frameworkWebFetch from "#framework-sources/tools/web_fetch.js";
import frameworkWebSearch from "#framework-sources/tools/web_search.js";
import frameworkWriteFile from "#framework-sources/tools/write_file.js";
import { bash as canonicalBash } from "#public/tools/bash.js";
import { connectionSearch as canonicalConnectionSearch } from "#public/tools/connection-search.js";
import {
  bash,
  connectionSearch,
  glob,
  grep,
  loadSkill,
  readFile,
  todo,
  webFetch,
  webSearch,
  writeFile,
} from "#public/tools/defaults.js";
import { glob as canonicalGlob } from "#public/tools/glob.js";
import { grep as canonicalGrep } from "#public/tools/grep.js";
import { loadSkill as canonicalLoadSkill } from "#public/tools/load-skill.js";
import { readFile as canonicalReadFile } from "#public/tools/read-file.js";
import { todo as canonicalTodo } from "#public/tools/todo.js";
import { webFetch as canonicalWebFetch } from "#public/tools/web-fetch.js";
import { defaultWebSearch as canonicalWebSearch } from "#public/tools/web-search.js";
import { writeFile as canonicalWriteFile } from "#public/tools/write-file.js";

describe("canonical default tool definitions", () => {
  it("exports each public default from its primitive-owned module", () => {
    expect(bash).toBe(canonicalBash);
    expect(connectionSearch).toBe(canonicalConnectionSearch);
    expect(glob).toBe(canonicalGlob);
    expect(grep).toBe(canonicalGrep);
    expect(loadSkill).toBe(canonicalLoadSkill);
    expect(readFile).toBe(canonicalReadFile);
    expect(todo).toBe(canonicalTodo);
    expect(webFetch).toBe(canonicalWebFetch);
    expect(webSearch).toBe(canonicalWebSearch);
    expect(writeFile).toBe(canonicalWriteFile);
  });

  it("registers the exact same values through framework source modules", () => {
    expect(frameworkBash).toBe(bash);
    expect(frameworkConnectionSearch).toBe(connectionSearch);
    expect(frameworkLoadSkill).toBe(loadSkill);
    expect(frameworkReadFile).toBe(readFile);
    expect(frameworkTodo).toBe(todo);
    expect(frameworkWebFetch).toBe(webFetch);
    expect(frameworkWebSearch).toBe(webSearch);
    expect(frameworkWriteFile).toBe(writeFile);
  });
});
