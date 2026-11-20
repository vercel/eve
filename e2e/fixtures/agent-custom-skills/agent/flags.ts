import type { SessionAuthContext } from "eve/context";

/** The fixture's per-user feature flag: people whose ID starts with `no-skills-` don't get custom skills. */
export function customSkillsEnabled(auth: SessionAuthContext | null): boolean {
  return auth !== null && !auth.principalId.startsWith("no-skills-");
}
