/** State a checkpoint holds that this build cannot continue; the owner that wrote it keeps the session. */
export class CheckpointRefusal extends Error {}

export function refuse(detail: string): never {
  throw new CheckpointRefusal(detail);
}
