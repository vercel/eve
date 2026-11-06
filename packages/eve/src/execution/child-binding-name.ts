// Kept apart from `child-binding.ts`, which reads Workflow's runs: an in-process host, which runs
// in a browser too, names the bindings it keeps without it.

/** The name a World-backed session keeps a remote child's binding under (`EntityHandle.keep`). */
export function remoteChildBindingName(childSessionId: string): string {
  return `eve.child.${childSessionId}`;
}
