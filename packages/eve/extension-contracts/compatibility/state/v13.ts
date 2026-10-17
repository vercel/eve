import { defineState } from "#public/context/index.js";

export const labels = defineState("compatibility.labels", () => [] as readonly string[]);
export function rememberLabel(label: string): readonly string[] {
  labels.update((current) => [...current, label]);
  return labels.get();
}
