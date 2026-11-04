import { lookup } from "node:dns";
import type { LookupFunction } from "node:net";

import type { Dispatcher1Wrapper } from "undici";

import {
  UnsafeDestinationError,
  type PublicDestinationPolicy,
} from "#execution/public-destination.js";
import { isBlockedDestinationHost } from "#shared/network-address.js";

// Node's guard for framework requests to untrusted URLs: an undici dispatcher whose socket lookup
// applies the `PublicDestinationPolicy` to every resolved address. `#platform/public-fetch` is how
// the rest of eve reaches it.

type DispatcherRequestInit = Omit<RequestInit, "dispatcher"> & {
  readonly dispatcher: Dispatcher1Wrapper;
};

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
        callback(new UnsafeDestinationError(), "", 0);
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
