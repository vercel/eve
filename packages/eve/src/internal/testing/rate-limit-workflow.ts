import { rateLimit, RateLimitMaxWaitError } from "#public/experimental/workflow/index.js";

export interface RateLimitProbeResult {
  readonly acquiredFirst: boolean;
  readonly secondMaxWaitRejected: boolean;
  readonly errorKey?: string;
  readonly wouldAcquireAt?: Date;
}

export async function rateLimitWorkflow(key: string): Promise<RateLimitProbeResult> {
  "use workflow";
  await rateLimit({ key, limit: 1, period: "1h" });
  try {
    await rateLimit({ key, limit: 1, period: "1h", maxWait: "1ms" });
    return { acquiredFirst: true, secondMaxWaitRejected: false };
  } catch (error) {
    if (!RateLimitMaxWaitError.is(error)) throw error;
    return {
      acquiredFirst: true,
      secondMaxWaitRejected: true,
      errorKey: error.key,
      wouldAcquireAt: error.wouldAcquireAt,
    };
  }
}
