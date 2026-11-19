export class CheckpointRefusal extends Error {}

export function refuse(detail: string): never {
  throw new CheckpointRefusal(detail);
}
