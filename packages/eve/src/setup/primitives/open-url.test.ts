import { describe, expect, it, vi } from "vitest";

import { spawn } from "node:child_process";

import { openUrl, parseWebUrl } from "./open-url.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}));

const mockedSpawn = vi.mocked(spawn);

describe("parseWebUrl", () => {
  it("normalizes valid http(s) URLs and trims surrounding whitespace", () => {
    expect(parseWebUrl("  https://slack.com/app_redirect?app=A0&team=T0  ")).toBe(
      "https://slack.com/app_redirect?app=A0&team=T0",
    );
    expect(parseWebUrl("http://example.com")).toBe("http://example.com/");
  });

  it("rejects non-web schemes and unparseable input", () => {
    expect(parseWebUrl("javascript:alert(1)")).toBeUndefined();
    expect(parseWebUrl("file:///etc/passwd")).toBeUndefined();
    expect(parseWebUrl("slack.com/no-scheme")).toBeUndefined();
    expect(parseWebUrl("not a url")).toBeUndefined();
  });
});

describe("openUrl", () => {
  it("launches the OS opener for an http(s) URL", () => {
    mockedSpawn.mockClear();
    openUrl("https://slack.com/app_redirect?app=A0&team=T0&tab=messages");
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    const [, args] = mockedSpawn.mock.calls[0]!;
    expect(args).toContain("https://slack.com/app_redirect?app=A0&team=T0&tab=messages");
  });

  it("refuses any non-web scheme rather than handing it to the opener", () => {
    mockedSpawn.mockClear();
    openUrl("javascript:alert(1)");
    openUrl("file:///etc/passwd");
    openUrl("slack.com/no-scheme");
    expect(mockedSpawn).not.toHaveBeenCalled();
  });
});
