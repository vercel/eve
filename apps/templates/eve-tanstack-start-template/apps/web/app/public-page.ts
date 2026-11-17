import dns from "node:dns";
import type { IncomingMessage } from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import type { LookupFunction } from "node:net";

/** Mirrors eve's shared/network-address reserved ranges, including loopback. */
const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 96],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(address, prefix, "ipv6");
}

const publicLookup: LookupFunction = (hostname, options, complete) => {
  const resolveHost = async () => {
    try {
      const addresses = await dns.promises.lookup(hostname, {
        all: true,
        order: "verbatim",
      });
      if (
        addresses.length === 0 ||
        addresses.some(({ address, family }) =>
          blocked.check(address, family === 4 ? "ipv4" : "ipv6")
        )
      ) {
        complete(new Error("Preview destination is not public."), "", 0);
        return;
      }
      const matches = addresses.filter(
        ({ family }) =>
          options.family === undefined ||
          options.family === 0 ||
          family === options.family
      );
      const [first] = matches;
      if (first === undefined) {
        complete(
          new Error("Preview destination has no matching address."),
          "",
          0
        );
        return;
      }
      if (options.all === true) {
        complete(null, matches);
      } else {
        complete(null, first.address, first.family);
      }
    } catch (error) {
      complete(
        error instanceof Error
          ? error
          : new Error("Preview DNS lookup failed."),
        "",
        0
      );
    }
  };
  void resolveHost();
};

/**
 * Requests HTTPS using the framework's public-destination policy at socket lookup.
 * Each connection uses only the validated DNS answers, without a second lookup.
 *
 * @param url - Page destination.
 * @param signal - Deadline shared across redirects and response-body reads.
 * @param hops - Number of redirects already followed.
 * @returns The final response and URL, or null after too many redirects.
 */
export async function requestPublicPage(
  url: URL,
  signal: AbortSignal,
  hops = 0
): Promise<{ response: IncomingMessage; url: URL } | null> {
  if (
    url.protocol !== "https:" ||
    !url.hostname.includes(".") ||
    url.hostname.endsWith(".local") ||
    url.hostname.endsWith(".internal") ||
    isIP(url.hostname.replaceAll(/^\[|\]$/gu, "")) !== 0 ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("Preview destination must be an HTTPS hostname.");
  }
  const result = Promise.withResolvers<IncomingMessage>();
  const request = https.get(
    url,
    {
      agent: false,
      headers: { accept: "text/html" },
      lookup: publicLookup,
      signal,
    },
    result.resolve
  );
  request.on("error", result.reject);
  const response = await result.promise;
  const status = response.statusCode ?? 500;
  const { location } = response.headers;
  if (status >= 300 && status < 400 && location !== undefined) {
    response.destroy();
    if (hops >= 3 || !URL.canParse(location, url)) {
      return null;
    }
    return await requestPublicPage(new URL(location, url), signal, hops + 1);
  }
  if (status < 200 || status >= 300) {
    response.destroy();
    throw new Error(`Preview page responded with ${status}.`);
  }
  return { response, url };
}
