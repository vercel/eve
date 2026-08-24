export interface ProductionServerReadyMessage {
  readonly type: "eve:production-server:ready";
  readonly version: 1;
}

export interface ProductionServerErrorMessage {
  readonly message: string;
  readonly type: "eve:production-server:error";
  readonly version: 1;
}

export type ProductionServerMessage = ProductionServerErrorMessage | ProductionServerReadyMessage;

export function isProductionServerMessage(value: unknown): value is ProductionServerMessage {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return false;
  if (record.type === "eve:production-server:ready") return true;
  return record.type === "eve:production-server:error" && typeof record.message === "string";
}
