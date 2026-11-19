export type ChatGptEndpointState =
  | "checking"
  | "ready"
  | "signed-out"
  | "reauth-required"
  | "unavailable";

export type ModelEndpointStatus =
  | { kind: "external"; provider: string }
  | {
      kind: "chatgpt";
      state: ChatGptEndpointState;
      accountLabel?: string;
    }
  | { kind: "gateway"; connected: true; credential: "api-key" | "oidc" | "oauth"; team?: string }
  | { kind: "gateway"; connected: false };
