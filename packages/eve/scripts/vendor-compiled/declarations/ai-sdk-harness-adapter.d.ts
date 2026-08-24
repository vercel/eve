export interface HarnessAdapterSettings {
  readonly model?: string;
  readonly modelId?: string;
  readonly port?: number;
  readonly portEndpoint?: {
    readonly url: string;
    readonly headers?: Readonly<Record<string, string>>;
  };
}

export declare function createClaudeCode(settings?: HarnessAdapterSettings): unknown;
export declare function createCline(settings?: HarnessAdapterSettings): unknown;
export declare function createCodex(settings?: HarnessAdapterSettings): unknown;
export declare function createDeepAgents(settings?: HarnessAdapterSettings): unknown;
export declare function createGrokBuild(settings?: HarnessAdapterSettings): unknown;
export declare function createOpenCode(settings?: HarnessAdapterSettings): unknown;
export declare function createPi(settings?: HarnessAdapterSettings): unknown;
