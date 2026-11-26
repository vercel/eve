export interface DerivedWebhookScope {
  repo: boolean;
  numbers: string[];
}

export function deriveWebhookScopes(): Record<string, DerivedWebhookScope>;

export function renderWebhookScopes(scopes: Record<string, DerivedWebhookScope>): string;
