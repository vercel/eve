import { describe, expect, it } from "vitest";

import { displayName, displayProperName, displayTitle } from "#shared/display-name.js";

describe("displayName", () => {
  it.each([
    ["researcher", "researcher", "Researcher"],
    ["create_issue", "create issue", "Create issue"],
    ["code-reviewer", "code reviewer", "Code reviewer"],
    ["code__code_reviewer", "code reviewer", "Code reviewer"],
    ["memory__remove_memory", "remove memory", "Remove memory"],
    ["listPullRequests", "list pull requests", "List pull requests"],
    ["getPRStatus", "get PR status", "Get PR status"],
    ["sync_CRM_accounts", "sync CRM accounts", "Sync CRM accounts"],
    ["s3_upload", "s3 upload", "S3 upload"],
    ["___", "___", "___"],
  ])("renders %s as %s", (identifier, name, title) => {
    expect(displayName(identifier)).toBe(name);
    expect(displayTitle(identifier)).toBe(title);
  });
});

describe("displayProperName", () => {
  it.each([
    ["linear", "Linear"],
    ["GitHub", "GitHub"],
    ["my_crm", "My crm"],
    ["code__github", "Github"],
  ])("renders %s as %s", (identifier, name) => {
    expect(displayProperName(identifier)).toBe(name);
  });
});
