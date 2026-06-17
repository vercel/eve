// Minimal declaration for the vendored slice of `@vercel/detect-agent`.
// eve only asks "was this launch agent-driven?", so the per-agent name
// union upstream declares is collapsed to `string`; widen this if a
// future caller branches on specific agents.

export type AgentResult =
  | {
      isAgent: true;
      agent: { name: string };
    }
  | {
      isAgent: false;
      agent: undefined;
    };

/**
 * Detects whether the current process was launched by a known AI coding
 * agent, from environment markers (and a Devin filesystem probe).
 */
export declare function determineAgent(): Promise<AgentResult>;
