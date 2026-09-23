import selfModificationV1 from "./self-modification-v1.mjs";

const profiles = new Map([[selfModificationV1.id, selfModificationV1]]);

export function getProfile(id) {
  const profile = profiles.get(id);
  if (!profile) throw new Error(`Unknown eval experiment profile: ${id}`);
  return profile;
}
