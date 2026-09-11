// Keep in sync with shared/types/memory.ts — duplicated here because Eve
// cannot resolve Nuxt's #shared alias at runtime.
export const MEMORY_CATEGORIES = [
  "work_context",
  "personal_context",
  "active_focus",
  "instructions_preferences",
  "project_history",
] as const;

export type AgentMemoryCategory = (typeof MEMORY_CATEGORIES)[number];
