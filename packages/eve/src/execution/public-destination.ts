import { lookup } from "node:dns";
import type { LookupFunction } from "node:net";

import type { Dispatcher1Wrapper } from "undici";

import { isBlockedDestinationHost } from "#shared/network-address.js";

export const UNSAFE_DESTINATION_ERROR =
  "URL must not target localhost, private, link-local, or reserved IP addresses.";

/** Destination policy for a framework request to an untrusted URL. */
export interface PublicDestinationPolicy {
  /** Permits loopback destinations, such as callbacks between local development servers. */
  readonly allowLoopback: boolean;
}

type DispatcherRequestInit = Omit<RequestInit, "dispatcher"> & {
  readonly dispatcher: Dispatcher1Wrapper;
};

/**
 * Rejects IP-literal and `localhost` hostnames the policy blocks. Socket
 * lookups never run for IP literals, so this check must precede the request.
 */
export function assertPublicHostname(hostname: string, policy: PublicDestinationPolicy): void {
  if (isBlockedDestinationHost(hostname, policy)) {
    throw new Error(UNSAFE_DESTINATION_ERROR);
  }
}

/**
 * Creates a dispatcher whose socket lookup rejects a hostname when any
 * resolved address is blocked, then connects using those exact results so DNS
 * cannot change between validation and connection.
 */
export async function createPublicDispatcher(
  policy: PublicDestinationPolicy,
): Promise<Dispatcher1Wrapper> {
  const { Agent, Dispatcher1Wrapper } = await import("undici");
  return new Dispatcher1Wrapper(new Agent({ connect: { lookup: createPublicLookup(policy) } }));
}

export function fetchWithDispatcher(url: string | URL, init: DispatcherRequestInit) {
  // Node's fetch types describe its bundled undici version, while the wrapper
  // adapts the installed undici dispatcher to that runtime protocol.
  const fetchWithUndici = fetch as typeof fetch &
    ((input: string | URL, init: DispatcherRequestInit) => Promise<Response>);
  return fetchWithUndici(url, init);
}

function createPublicLookup(policy: PublicDestinationPolicy): LookupFunction {
  return (hostname, lookupOptions, callback) => {
    lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error !== null) {
        callback(error, "", 0);
        return;
      }

      if (addresses.some(({ address }) => isBlockedDestinationHost(address, policy))) {
        callback(new Error(UNSAFE_DESTINATION_ERROR), "", 0);
        return;
      }

      const matchingAddresses =
        lookupOptions.family === undefined || lookupOptions.family === 0
          ? addresses
          : addresses.filter(({ family }) => family === lookupOptions.family);

      if (matchingAddresses.length === 0) {
        const error = new Error(
          `Unable to resolve URL hostname "${hostname}" in the requested IP family.`,
        );
        Object.assign(error, { code: "ENOTFOUND" });
        callback(error, "", 0);
        return;
      }

      if (lookupOptions.all === true) {
        callback(null, matchingAddresses);
        return;
      }

      const selected = matchingAddresses[0]!;
      callback(null, selected.address, selected.family);
    });
  };
}
