/** Per-token USD rates used for best-effort model cost estimates. */
export interface ModelCostEstimate {
  readonly inputUsdPerToken: number;
  readonly outputUsdPerToken: number;
  readonly cacheReadUsdPerToken?: number;
  readonly cacheWriteUsdPerToken?: number;
}

export type ModelCostSource = "estimated" | "gateway";
