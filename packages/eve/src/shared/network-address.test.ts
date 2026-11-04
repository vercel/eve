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

describe("the pure IP matcher, against node:net", () => {
  it("classifies addresses as BlockList does", async () => {
    const { BlockList, isIP } = await import("node:net");
    const reserved = new BlockList();
    for (const [cidr] of [
      ["0.0.0.0/8"],
      ["10.0.0.0/8"],
      ["100.64.0.0/10"],
      ["169.254.0.0/16"],
      ["172.16.0.0/12"],
      ["192.0.0.0/24"],
      ["192.0.2.0/24"],
      ["192.88.99.0/24"],
      ["192.168.0.0/16"],
      ["198.18.0.0/15"],
      ["198.51.100.0/24"],
      ["203.0.113.0/24"],
      ["224.0.0.0/4"],
      ["240.0.0.0/4"],
      ["::/128"],
      ["::/96"],
      ["64:ff9b::/96"],
      ["64:ff9b:1::/48"],
      ["100::/64"],
      ["2001::/23"],
      ["2001:db8::/32"],
      ["2002::/16"],
      ["fc00::/7"],
      ["fe80::/10"],
      ["ff00::/8"],
    ] as const) {
      const [base, prefix] = cidr.split("/");
      reserved.addSubnet(base!, Number(prefix), base!.includes(":") ? "ipv6" : "ipv4");
    }
    const loopback = (address: string) =>
      address.startsWith("127.") || address === "::1" || address === "0:0:0:0:0:0:0:1";
    const addresses = [
      "0.0.0.0",
      "1.1.1.1",
      "8.8.8.8",
      "9.255.255.255",
      "10.0.0.1",
      "11.0.0.0",
      "100.63.255.255",
      "100.64.0.0",
      "100.127.255.255",
      "100.128.0.0",
      "169.254.169.254",
      "172.15.255.255",
      "172.16.0.0",
      "172.31.255.255",
      "172.32.0.0",
      "192.0.0.8",
      "192.0.2.1",
      "192.88.99.1",
      "192.168.1.1",
      "198.17.255.255",
      "198.18.0.0",
      "198.19.255.255",
      "198.20.0.0",
      "203.0.113.9",
      "223.255.255.255",
      "224.0.0.1",
      "239.255.255.255",
      "240.0.0.1",
      "255.255.255.255",
      "127.0.0.1",
      "::",
      "::1",
      "::2",
      "::ffff:1.2.3.4",
      "::ffff:10.0.0.1",
      "::ffff:a9fe:a9fe",
      "::ffff:808:808",
      "0:0:0:0:0:ffff:192.168.0.1",
      "::1.2.3.4",
      "64:ff9b::1",
      "64:ff9b:1::1",
      "64:ff9b:2::1",
      "100::1",
      "100:0:0:1::",
      "2001::1",
      "2001:1ff::1",
      "2001:200::1",
      "2001:db8::1",
      "2001:db9::1",
      "2002::1",
      "2003::1",
      "fbff::1",
      "fc00::1",
      "fdff::1",
      "fe00::1",
      "fe80::1",
      "febf::1",
      "fec0::1",
      "ff02::1",
      "2606:4700::1111",
      "1:2:3:4:5:6:7:8",
      "01.1.1.1",
      "1.1.1",
      "1:2:3:4:5:6:7:8:9",
      "::g",
      "1::2::3",
      "example.com",
      "",
    ];
    for (const address of addresses) {
      const family = isIP(address);
      const expected =
        family !== 0 &&
        !loopback(address) &&
        reserved.check(address, family === 4 ? "ipv4" : "ipv6");
      expect([address, isReservedIpAddress(address)]).toEqual([address, expected]);
    }
  });
});
