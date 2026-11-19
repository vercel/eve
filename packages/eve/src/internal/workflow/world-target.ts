export function resolveWorkflowWorldImport(targetWorld: string): string {
  if (targetWorld === "local") return "@workflow/world-local";
  if (targetWorld === "vercel") return "@workflow/world-vercel";
  return targetWorld;
}
