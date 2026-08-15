import { describe, expect, it } from "vitest";

import {
  isLoopbackHostname,
  isLoopbackServerUrl,
  isPrivateOrReservedIpAddress,
  isReservedIpAddress,
} from "#shared/network-address.js";

describe("isLoopbackHostname", () => {
  it("accepts the IPv4 loopback block, IPv6 loopback, and the localhost namespace", () => {
    for (const host of [
      "localhost",
      "localhost.",
      "app.localhost",
      "app.localhost.",
      "127.0.0.1",
      "127.1.2.3",
      "::1",
      "[::1]",
      "::ffff:7f00:1",
    ]) {
      expect(isLoopbackHostname(host), host).toBe(true);
    }
  });

  it("rejects wildcard binds, public hosts, and non-loopback IPs", () => {
    for (const host of ["0.0.0.0", "::", "8.8.8.8", "example.com", "10.0.0.1"]) {
      expect(isLoopbackHostname(host), host).toBe(false);
    }
  });
});

describe("isLoopbackServerUrl", () => {
  it("accepts http(s) URLs on loopback hosts", () => {
    for (const url of ["http://127.0.0.1:2000/", "http://localhost:3000", "https://[::1]:8080/x"]) {
      expect(isLoopbackServerUrl(url), url).toBe(true);
    }
  });

  it("rejects non-loopback hosts, non-http schemes, and junk", () => {
    for (const url of [
      "ws://localhost:2000/",
      "http://evil.example/",
      "http://0.0.0.0:2000/",
      "ftp://127.0.0.1/",
      "nope",
    ]) {
      expect(isLoopbackServerUrl(url), url).toBe(false);
    }
  });
});

describe("isReservedIpAddress", () => {
  it("blocks non-public IPv4 and IPv6 address ranges", () => {
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
      "::ffff:a9fe:a9fe", // hexadecimal IPv4-mapped form
      "64:ff9b::a9fe:a9fe", // NAT64 must not translate to cloud metadata
      "192.0.2.1", // documentation
      "224.0.0.1", // multicast
      "2001:db8::1", // documentation
      "ff02::1", // multicast
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

describe("isPrivateOrReservedIpAddress", () => {
  it("also blocks the IPv4 and IPv6 loopback ranges", () => {
    for (const host of ["127.0.0.1", "127.200.1.2", "::1", "[::1]", "::ffff:7f00:1"]) {
      expect(isPrivateOrReservedIpAddress(host), host).toBe(true);
    }
  });

  it("allows public addresses", () => {
    for (const host of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
      expect(isPrivateOrReservedIpAddress(host), host).toBe(false);
    }
  });
});
