import { stripLogicalPathExtension } from "#discover/filesystem.js";

export function canonicalAgentSourceSlot(logicalPath: string): string {
  const withoutExtension = stripLogicalPathExtension(logicalPath);
  const connectionFolder = withoutExtension.match(/^connections\/([^/]+)\/connection$/);
  if (connectionFolder !== null) return `connections/${connectionFolder[1]}`;
  return withoutExtension === "sandbox/sandbox" ? "sandbox" : withoutExtension;
}
