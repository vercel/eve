export interface DerivedSlackEventScope {
  channels: string[];
  timestamps: string[];
  scopes: string[];
}

export const REQUIRED_BOT_SCOPES: Record<string, string[]>;

export function derivePayloadPaths(): Record<string, { channels: string[]; timestamps: string[] }>;

export function deriveSlackEventScopes(): Record<string, DerivedSlackEventScope>;

export function renderSlackEventScopes(scopes: Record<string, DerivedSlackEventScope>): string;
