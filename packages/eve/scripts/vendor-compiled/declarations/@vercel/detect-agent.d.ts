export type AgentResult =
  | {
      isAgent: true;
      agent: { name: string };
    }
  | {
      isAgent: false;
      agent: undefined;
    };

export declare function determineAgent(): Promise<AgentResult>;
