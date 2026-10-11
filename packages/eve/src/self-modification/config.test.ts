import { afterEach, describe, expect, it } from "vitest";

import { DEPLOYED_OPTION_MOVED_MESSAGE, resolveSelfModificationConfig } from "./config.js";
import { isDeployedRuntime, isLocalSelfModificationEnabled } from "./mode.js";

afterEach(() => {
  delete process.env.EVE_DEV;
});

describe("local self-modification configuration", () => {
  it("enables local editing by default", () => {
    expect(resolveSelfModificationConfig()).toEqual({ localEnabled: true });
    expect(resolveSelfModificationConfig({ local: { enabled: false } })).toEqual({
      localEnabled: false,
    });
  });

  it.each([
    [null, "configuration must be an object"],
    [{ local: null }, "local must be an object"],
    [{ local: { enabled: "yes" } }, "local.enabled must be a boolean"],
  ])("rejects malformed configuration", (config, message) => {
    expect(() => resolveSelfModificationConfig(config as never)).toThrow(message);
  });

  it("points the former deployed option at the deployed mount", () => {
    expect(() => resolveSelfModificationConfig({ deployed: {} } as never)).toThrow(
      DEPLOYED_OPTION_MOVED_MESSAGE,
    );
  });

  it("enables local editing only inside eve dev", () => {
    const config = resolveSelfModificationConfig();
    expect(isLocalSelfModificationEnabled(config)).toBe(false);
    expect(isDeployedRuntime()).toBe(true);
    process.env.EVE_DEV = "1";
    expect(isLocalSelfModificationEnabled(config)).toBe(true);
    expect(isLocalSelfModificationEnabled({ localEnabled: false })).toBe(false);
    expect(isDeployedRuntime()).toBe(false);
  });
});
