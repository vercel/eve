import type { CatalogEntry } from "./subagents/agent/tools/search_registry.js";

export function classifyCatalogEntry(
  entry: CatalogEntry,
):
  | { readonly kind: "installable" }
  | { readonly kind: "needs-terminal"; readonly reason: string }
  | { readonly kind: "self-modification-mount"; readonly reason: string } {
  if (entry.selfModificationMount === true) {
    return {
      kind: "self-modification-mount",
      reason:
        "Installing a registry item cannot replace the self-modification subagent's own mount. Edit its authored mount directly instead.",
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
