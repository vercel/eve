import type { MemoryByCategory } from "../../shared/types/memory.js";
import type { UserProfile } from "../../shared/types/profile.js";
import { appOrigin, internalHeaders } from "./internal-api.js";

export interface UserContextPayload {
  profile: UserProfile;
  memory: MemoryByCategory;
}

export async function fetchUserContext(userId: string): Promise<UserContextPayload | undefined> {
  const response = await fetch(
    `${appOrigin()}/api/internal/memory?userId=${encodeURIComponent(userId)}`,
    { headers: internalHeaders() },
  );

  if (!response.ok) {
    return undefined;
  }

  return response.json() as Promise<UserContextPayload>;
}

export async function saveMemoryRemote(input: {
  userId: string;
  category: string;
  content: string;
}) {
  const response = await fetch(`${appOrigin()}/api/internal/memory`, {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify({
      userId: input.userId,
      category: input.category,
      content: input.content,
      source: "agent",
    }),
  });

  if (!response.ok) {
    throw new Error("Failed to save memory");
  }

  return response.json() as Promise<{ saved: boolean }>;
}

export function buildUserContextPrompt(context: UserContextPayload) {
  const { profile, memory } = context;
  const parts: string[] = [];

  parts.push("# About this user");
  if (profile.bio) {
    parts.push(profile.bio);
  }
  parts.push(`Timezone: ${profile.timezone}. Preferred language: ${profile.locale}.`);

  const memorySections: string[] = [];
  for (const [category, entries] of Object.entries(memory)) {
    const entry = entries?.[0];
    if (!entry) continue;
    const label = category.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
    memorySections.push(`## ${label}`);
    memorySections.push(entry.content);
  }

  if (memorySections.length) {
    parts.push("# Memory");
    parts.push(memorySections.join("\n\n"));
  }

  return parts.join("\n\n");
}
