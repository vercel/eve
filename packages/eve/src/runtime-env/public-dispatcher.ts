import { lookup } from "node:dns";
import type { LookupFunction } from "node:net";

import type { Dispatcher1Wrapper } from "undici";

export interface AddressGuard {
  isBlocked(address: string): boolean;
  blocked(): Error;
}

export async function loadAddressGuardedDispatcher(
  guard: AddressGuard,
): Promise<(() => Dispatcher1Wrapper) | undefined> {
  const undici = await import("undici").catch(() => undefined);
  if (undici === undefined) return undefined;
  const { Agent, Dispatcher1Wrapper } = undici;
  return () =>
    new Dispatcher1Wrapper(new Agent({ connect: { lookup: createGuardedLookup(guard) } }));
}

function createGuardedLookup(guard: AddressGuard): LookupFunction {
  return (hostname, lookupOptions, callback) => {
    lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error !== null) {
        callback(error, "", 0);
        return;
      }

      if (addresses.some(({ address }) => guard.isBlocked(address))) {
        callback(guard.blocked(), "", 0);
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
