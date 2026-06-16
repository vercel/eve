import { describe, expect, it } from "vitest";

import { isReservedIpAddress } from "#shared/network-address.js";

describe("isReservedIpAddress", () => {
  it("blocks link-local (cloud metadata), private, CGNAT, ULA, and unspecified addresses", () => {
    for (const host of [
      "169.254.169.254", // cloud metadata (link-local)
      "10.0.0.1",
      "172.16.5.4",
      "192.168.1.1",
      "100.64.0.1", // CGNAT
      "0.0.0.0",
      "[fe80::1]", // IPv6 link-local (URL.hostname keeps brackets)
      "[fc00::1]", // IPv6 ULA
      "[::]",
      "::ffff:169.254.169.254", // IPv4-mapped IPv6 must not bypass the IPv4 ranges
    ]) {
      expect(isReservedIpAddress(host), host).toBe(true);
    }
  });

  it("allows public addresses, loopback, and plain hostnames", () => {
    for (const host of [
      "8.8.8.8",
      "127.0.0.1", // loopback is intentionally allowed (local-dev self-callbacks)
      "[::1]",
      "caller.example.com",
      "localhost",
    ]) {
      expect(isReservedIpAddress(host), host).toBe(false);
    }
  });
});
