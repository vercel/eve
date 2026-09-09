export interface ComputeLimits {
  maxCellStateBytes: number;
  maxEffectInputBytes: number;
  maxEventBytes: number;
  maxMessageBytes: number;
  maxPayloadBytes: number;
  maxTransitionEffects: number;
  maxTransitionEvents: number;
  maxTransitionSends: number;
  maxTransitionTimers: number;
  maxUnprocessedMessages: number;
}

export const DEFAULT_COMPUTE_LIMITS: ComputeLimits = {
  maxCellStateBytes: 1024 * 1024,
  maxEffectInputBytes: 16 * 1024 * 1024,
  maxEventBytes: 16 * 1024 * 1024,
  maxMessageBytes: 256 * 1024,
  maxPayloadBytes: 16 * 1024 * 1024,
  maxTransitionEffects: 100,
  maxTransitionEvents: 100,
  maxTransitionSends: 100,
  maxTransitionTimers: 100,
  maxUnprocessedMessages: 10_000,
};

export const DURABLE_ROW_LOGICAL_BYTES = 1024;
