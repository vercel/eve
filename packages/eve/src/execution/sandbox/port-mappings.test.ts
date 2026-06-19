import { describe, expect, it } from "vitest";

import {
  getLoopbackPortUrl,
  normalizeSandboxPortMappings,
} from "#execution/sandbox/port-mappings.js";

describe("sandbox port mappings", () => {
  it("copies and resolves valid loopback mappings", () => {
    const input = [{ hostPort: 43_000, sandboxPort: 3000 }];
    const mappings = normalizeSandboxPortMappings(input);

    expect(mappings).toEqual(input);
    expect(mappings).not.toBe(input);
    expect(getLoopbackPortUrl(mappings, 3000)).toBe("http://127.0.0.1:43000");
  });

  it.each([
    [{ hostPort: 0, sandboxPort: 3000 }, "hostPort"],
    [{ hostPort: 43_000, sandboxPort: 65_536 }, "sandboxPort"],
    [{ hostPort: 43_000.5, sandboxPort: 3000 }, "hostPort"],
  ] as const)("rejects invalid mappings %#", (mapping, field) => {
    expect(() => normalizeSandboxPortMappings([mapping])).toThrow(
      `${field} must be an integer between 1 and 65535`,
    );
  });

  it("rejects duplicate host and sandbox ports", () => {
    expect(() =>
      normalizeSandboxPortMappings([
        { hostPort: 43_000, sandboxPort: 3000 },
        { hostPort: 43_000, sandboxPort: 3001 },
      ]),
    ).toThrow("Duplicate sandbox hostPort: 43000");
    expect(() =>
      normalizeSandboxPortMappings([
        { hostPort: 43_000, sandboxPort: 3000 },
        { hostPort: 43_001, sandboxPort: 3000 },
      ]),
    ).toThrow("Duplicate sandboxPort: 3000");
  });

  it("rejects ports that were not published", () => {
    expect(() => getLoopbackPortUrl([], 3000)).toThrow("Sandbox port 3000 is not published");
  });
});
