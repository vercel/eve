import type { SelectOption } from "../prompter.js";
import type { GatewayKeyValidation } from "../validate-gateway-key.js";

import type { ProviderSelection } from "#setup/provider-settings.js";

export type ProviderConnection = ProviderSelection | "external";

type AcceptedGatewayKeyValidation = Exclude<GatewayKeyValidation, { kind: "invalid" }>;

export type ProviderPickerChoice =
  | { kind: "ai-gateway-project" }
  | { kind: "chatgpt" }
  | { kind: "external" }
  | {
      kind: "ai-gateway-key";
      key: string;
      validation: AcceptedGatewayKeyValidation;
    };

export interface ProviderPickerRequest {
  message: string;
  options: readonly SelectOption<ProviderConnection>[];
  initialValue: ProviderConnection;
  validateInlineKey(key: string, signal: AbortSignal): Promise<GatewayKeyValidation>;
}
