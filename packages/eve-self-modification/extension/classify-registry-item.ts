import type { CatalogEntry } from "./tools/search_registry.js";

/**
 * An official item address is a relative path of lowercase slugs.
 *
 * v1 installs official items only. Namespaced (`@acme/...`), URL, `@skills`,
 * and malformed addresses are handed back for manual installation without
 * rendering the untrusted address into a command.
 */
const OFFICIAL_ADDRESS_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/u;

/** Whether an address names an official registry item this tool can install. */
export function isOfficialAddress(address: string): boolean {
  return OFFICIAL_ADDRESS_PATTERN.test(address);
}

/**
 * The split rule.
 *
 * An item that declares no setup and no components is installed by the tool. An
 * item that declares either is handed to the terminal whole, before anything is
 * installed — every question a setup flow asks, and every browser
 * authorization or secret it needs, belongs to the surface built to ask.
 *
 * The rule reads catalog metadata only. It never predicts whether a particular
 * setup would in fact ask something, because a wrong prediction installs half
 * an item and reports success.
 */
export function classifyCatalogEntry(
  entry: CatalogEntry,
): { readonly kind: "installable" } | { readonly kind: "needs-terminal"; readonly reason: string } {
  if (entry.components !== undefined && entry.components.length > 0) {
    return {
      kind: "needs-terminal",
      reason: `${entry.address} is a bundle of ${entry.components.join(", ")}. Choosing which components to install is a question, so the whole bundle goes to the terminal.`,
    };
  }
  if (entry.declaresSetup === true) {
    return {
      kind: "needs-terminal",
      reason: `${entry.address} declares a setup flow, which can ask for credentials or open a browser authorization. Neither can be answered from a chat turn.`,
    };
  }
  return { kind: "installable" };
}
