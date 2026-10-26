import { describe, expect, it } from "vitest";

import {
  callbackUrlForProtocol,
  readCallbackProtocol,
  REMOTE_AGENT_PROTOCOL_VERSION,
} from "#protocol/remote-agent-protocol.js";

describe("the callback URL a parent gives a remote child", () => {
  const base = "https://parent.example.com/eve/v1/callback/eve%3Aparent";

  it("names the earlier protocol, alongside the query it already has", () => {
    const marked = callbackUrlForProtocol(`${base}?x-vercel-protection-bypass=secret`, 2);
    expect(new URL(marked).pathname).toBe("/eve/v1/callback/eve%3Aparent");
    expect(new URL(marked).searchParams.get("x-vercel-protection-bypass")).toBe("secret");
    expect(readCallbackProtocol(marked)).toBe(2);
  });

  it("names this protocol too, so every callback says what was agreed", () => {
    const marked = callbackUrlForProtocol(base, REMOTE_AGENT_PROTOCOL_VERSION);
    expect(readCallbackProtocol(marked)).toBe(REMOTE_AGENT_PROTOCOL_VERSION);
    // A URL a parent run from before v27 minted names none.
    expect(readCallbackProtocol(base)).toBeUndefined();
  });

  it("reads no protocol from a value that is not a version", () => {
    for (const value of ["", "two", "2.0", "-2", "02"]) {
      expect(readCallbackProtocol(`${base}?eveRemoteProtocol=${value}`)).toBeUndefined();
    }
    expect(readCallbackProtocol("not a url")).toBeUndefined();
  });
});
