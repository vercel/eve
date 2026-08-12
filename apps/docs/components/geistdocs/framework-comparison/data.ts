export type FrameworkId = "eve" | "mastra" | "flue" | "cloudflare" | "langgraph" | "hermes";

export type SupportLevel = "native" | "integrated" | "assemble" | "outside";

export interface FrameworkDefinition {
  readonly id: FrameworkId;
  readonly name: string;
  readonly shortName: string;
  readonly category: string;
}

export interface ComparisonCell {
  readonly level: SupportLevel;
  readonly title: string;
  readonly detail: string;
  readonly href: string;
}

export interface ComparisonRow {
  readonly feature: string;
  readonly question: string;
  readonly cells: Readonly<Record<FrameworkId, ComparisonCell>>;
}

export const FRAMEWORKS: readonly FrameworkDefinition[] = [
  {
    id: "eve",
    name: "eve",
    shortName: "eve",
    category: "Filesystem-first framework",
  },
  {
    id: "mastra",
    name: "Mastra",
    shortName: "Mastra",
    category: "TypeScript agent framework",
  },
  {
    id: "flue",
    name: "Flue 2.0",
    shortName: "Flue 2.0",
    category: "TypeScript harness framework",
  },
  {
    id: "cloudflare",
    name: "Cloudflare Agents SDK",
    shortName: "Cloudflare",
    category: "Edge agent runtime",
  },
  {
    id: "langgraph",
    name: "LangGraph",
    shortName: "LangGraph",
    category: "Graph orchestration runtime",
  },
  {
    id: "hermes",
    name: "Hermes Agent",
    shortName: "Hermes",
    category: "Ready-made personal agent",
  },
];

export const SUPPORT_LABELS: Readonly<Record<SupportLevel, string>> = {
  native: "First-class",
  integrated: "Supported",
  assemble: "Assemble",
  outside: "Outside core",
};

export const COMPARISON_ROWS: readonly ComparisonRow[] = [
  {
    feature: "Agent-shaped authoring",
    question: "Does the source tree still describe the agent after it becomes large?",
    cells: {
      eve: {
        level: "native",
        title: "One recursive agent directory",
        detail:
          "Instructions, tools, skills, channels, connections, sandbox, and subagents each have a path-derived home.",
        href: "/docs/project-structure",
      },
      mastra: {
        level: "integrated",
        title: "Experimental file-based agents",
        detail:
          "A partial discovery layer sits beside the established TypeScript object-and-registry surface.",
        href: "https://mastra.ai/docs/getting-started/file-based-agents",
      },
      flue: {
        level: "integrated",
        title: "Agent functions + hooks",
        detail:
          "Capitalized exports become agents; identity comes from the function while hooks compose its capabilities.",
        href: "https://flueframework.com/docs/guide/building-agents/",
      },
      cloudflare: {
        level: "assemble",
        title: "Agent classes + bindings",
        detail:
          "You compose a Durable Object class, routes, bindings, model loop, and platform services in code.",
        href: "https://developers.cloudflare.com/agents/runtime/agents-api/",
      },
      langgraph: {
        level: "assemble",
        title: "Graph or functional API",
        detail:
          "Nodes, edges, state schemas, checkpoints, and deployment configuration define the application.",
        href: "https://docs.langchain.com/oss/javascript/langgraph/overview",
      },
      hermes: {
        level: "outside",
        title: "Configure a finished agent",
        detail:
          "Hermes is an extensible agent you run, not an application framework for authoring many product agents.",
        href: "https://hermes-agent.nousresearch.com/docs/",
      },
    },
  },
  {
    feature: "Crash-safe agent turns",
    question:
      "Can an autonomous turn recover without rebuilding the loop around a workflow engine?",
    cells: {
      eve: {
        level: "native",
        title: "Every turn is durable",
        detail:
          "Model and tool steps checkpoint automatically; interrupted work resumes from the last completed step.",
        href: "/docs/concepts/execution-model-and-durability",
      },
      mastra: {
        level: "integrated",
        title: "Durable workflows + Agents beta",
        detail:
          "Workflows persist suspend/resume state. Long-running autonomous control uses a separate beta surface.",
        href: "https://mastra.ai/docs/long-running-agents/durable-agents",
      },
      flue: {
        level: "native",
        title: "Accepted-work recovery",
        detail:
          "A durable log recovers submissions and child tasks; Node needs a durable database and single owner routing.",
        href: "https://flueframework.com/docs/guide/durability/",
      },
      cloudflare: {
        level: "integrated",
        title: "Fibers and Workflows",
        detail:
          "Recoverable execution is available, while the application chooses fiber or workflow boundaries.",
        href: "https://developers.cloudflare.com/agents/runtime/agents-api/",
      },
      langgraph: {
        level: "integrated",
        title: "Checkpointed graph steps",
        detail:
          "A configured checkpointer saves graph supersteps and enables fault-tolerant replay.",
        href: "https://docs.langchain.com/oss/javascript/langgraph/persistence",
      },
      hermes: {
        level: "assemble",
        title: "Persistent sessions, not a turn SLA",
        detail:
          "History and memory survive restarts, but the product docs do not promise checkpointed mid-turn recovery.",
        href: "https://hermes-agent.nousresearch.com/docs/",
      },
    },
  },
  {
    feature: "Persistent isolated workspace",
    question:
      "Does the agent get real files and commands with a lifecycle tied to its durable session?",
    cells: {
      eve: {
        level: "native",
        title: "Session sandbox by default",
        detail:
          "Built-in file and shell tools target an isolated workspace that persists across turns and redeploys.",
        href: "/docs/sandbox",
      },
      mastra: {
        level: "integrated",
        title: "Workspace + sandbox adapters",
        detail:
          "Files, skills, and compute are supported; multi-user apps resolve a stable workspace per thread.",
        href: "https://mastra.ai/blog/building-multi-user-multi-channel-agents",
      },
      flue: {
        level: "integrated",
        title: "Opt-in sandbox adapters",
        detail:
          "Virtual workspaces are ephemeral, local mode uses the host, and persistent isolation needs a remote adapter.",
        href: "https://flueframework.com/docs/guide/sandboxes/",
      },
      cloudflare: {
        level: "integrated",
        title: "Cloudflare Sandbox service",
        detail:
          "Agents can compose the separate Sandbox product for isolated, persistent container workspaces.",
        href: "https://developers.cloudflare.com/agents/",
      },
      langgraph: {
        level: "assemble",
        title: "Bring a sandbox/runtime",
        detail:
          "Graph persistence covers state; filesystem compute is supplied by an application or another product.",
        href: "https://docs.langchain.com/oss/javascript/langgraph/persistence",
      },
      hermes: {
        level: "native",
        title: "Five execution backends",
        detail:
          "A ready-made Hermes install can run tools locally or through Docker, SSH, Singularity, and Modal.",
        href: "https://hermes-agent.nousresearch.com/docs/user-guide/features/tools/",
      },
    },
  },
  {
    feature: "Identity-aware multiplayer",
    question: "When people share a session, does authorization follow the person speaking now?",
    cells: {
      eve: {
        level: "native",
        title: "Current + initiating principal",
        detail:
          "Every turn records who is speaking now and who opened the session; policy can use either identity.",
        href: "/docs/guides/session-context",
      },
      mastra: {
        level: "integrated",
        title: "Shared channels + signals",
        detail:
          "Participants share a thread and are attributed, while channel resource scope stays bound to its starter.",
        href: "https://mastra.ai/blog/building-multi-user-multi-channel-agents",
      },
      flue: {
        level: "assemble",
        title: "Conversation ID + app auth",
        detail:
          "Anyone allowed to reach an instance URL can contribute; identity and access policy live in app middleware.",
        href: "https://flueframework.com/docs/guide/routing/",
      },
      cloudflare: {
        level: "assemble",
        title: "Many live connections",
        detail:
          "WebSockets broadcast shared state; the application validates tokens and carries user identity.",
        href: "https://developers.cloudflare.com/agents/runtime/operations/cross-domain-authentication/",
      },
      langgraph: {
        level: "assemble",
        title: "Thread + runtime context",
        detail:
          "User identity can be passed in context, but transport, participant semantics, and policy are app-owned.",
        href: "https://docs.langchain.com/oss/javascript/langgraph/persistence",
      },
      hermes: {
        level: "integrated",
        title: "Shared or per-user group sessions",
        detail:
          "Messaging groups can share context or isolate it by sender; product authorization remains gateway and plugin policy.",
        href: "https://hermes-agent.nousresearch.com/docs/user-guide/sessions/",
      },
    },
  },
  {
    feature: "Dynamic capabilities and credentials",
    question:
      "Can each turn receive the right prompt, tools, skills, workspace, and user-owned access?",
    cells: {
      eve: {
        level: "native",
        title: "Resolve at session, turn, or step",
        detail:
          "Models, instructions, skills, tools, headers, and user OAuth can follow the authenticated caller.",
        href: "/docs/guides/dynamic-capabilities",
      },
      mastra: {
        level: "integrated",
        title: "RequestContext resolvers",
        detail:
          "Typed request context can select models, instructions, tools, memory, and workspaces at runtime.",
        href: "https://mastra.ai/docs/server/request-context",
      },
      flue: {
        level: "integrated",
        title: "Agent hooks re-render",
        detail:
          "Functions and hooks rebuild capabilities each turn; trusted caller scope must come from application code.",
        href: "https://flueframework.com/docs/guide/why-flue/",
      },
      cloudflare: {
        level: "assemble",
        title: "Application logic",
        detail:
          "Agent methods can branch on connection and state; there is no framework capability resolver contract.",
        href: "https://developers.cloudflare.com/agents/runtime/communication/websockets/",
      },
      langgraph: {
        level: "assemble",
        title: "Runtime context + graph logic",
        detail:
          "Nodes can branch on context and state, with capability selection expressed in application code.",
        href: "https://docs.langchain.com/oss/javascript/langgraph/persistence",
      },
      hermes: {
        level: "assemble",
        title: "Profiles and toolsets",
        detail:
          "Operators configure an agent's tools, plugins, skills, and model rather than resolve a product surface per caller.",
        href: "https://hermes-agent.nousresearch.com/docs/user-guide/profiles/",
      },
    },
  },
  {
    feature: "Delegation that scales",
    question:
      "Can the model fan out to isolated specialists and keep the work durable and observable?",
    cells: {
      eve: {
        level: "native",
        title: "Parallel, nested, and remote",
        detail:
          "Copies, declared specialists, and remote agents all become tools with durable child sessions and streams.",
        href: "/docs/subagents",
      },
      mastra: {
        level: "integrated",
        title: "Networks + controller subagents",
        detail:
          "Several orchestration surfaces support specialists; file-based nesting is currently capped at three levels.",
        href: "https://mastra.ai/reference/file-based-agents/subagents",
      },
      flue: {
        level: "integrated",
        title: "Durable delegated tasks",
        detail:
          "Named profiles run as child sessions and recover from their own durable transcripts.",
        href: "https://flueframework.com/docs/guide/subagents/",
      },
      cloudflare: {
        level: "integrated",
        title: "Agent routing + workflows",
        detail:
          "Agent instances can call other instances, with coordination expressed through RPC and platform primitives.",
        href: "https://developers.cloudflare.com/agents/runtime/execution/sub-agents/",
      },
      langgraph: {
        level: "integrated",
        title: "Subgraphs and supervisors",
        detail:
          "Multi-agent patterns compose graphs, subgraphs, handoffs, or supervisor libraries.",
        href: "https://docs.langchain.com/oss/javascript/langchain/multi-agent",
      },
      hermes: {
        level: "native",
        title: "Isolated parallel subagents",
        detail:
          "The ready-made agent delegates parallel work into separate conversations and terminals; active children do not resume after restart.",
        href: "https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation/",
      },
    },
  },
  {
    feature: "Human-in-the-loop across downtime",
    question: "Can risky work park for a person without holding compute, then resume safely?",
    cells: {
      eve: {
        level: "native",
        title: "Approval is a durable park",
        detail:
          "Tool, connection, OAuth, and descendant requests surface through the root channel and resume in place.",
        href: "/docs/tools/human-in-the-loop",
      },
      mastra: {
        level: "integrated",
        title: "Approval and suspension",
        detail:
          "Agents and workflows can pause; current AgentController channel approvals do not survive a restart.",
        href: "https://mastra.ai/docs/agent-controller/channels",
      },
      flue: {
        level: "outside",
        title: "Application-owned",
        detail:
          "Current agent, tool, channel, and durability docs do not expose a framework approval or input primitive.",
        href: "https://flueframework.com/docs/guide/tools/",
      },
      cloudflare: {
        level: "integrated",
        title: "Workflow approvals",
        detail:
          "Cloudflare Workflows supplies durable approval waits; the app connects them to the agent experience.",
        href: "https://developers.cloudflare.com/agents/concepts/agentic-patterns/human-in-the-loop/",
      },
      langgraph: {
        level: "integrated",
        title: "Persistent interrupts",
        detail:
          "Interrupts checkpoint graph state and wait indefinitely for a Command that resumes the thread.",
        href: "https://docs.langchain.com/oss/javascript/langgraph/interrupts",
      },
      hermes: {
        level: "integrated",
        title: "Messaging approvals and steering",
        detail:
          "People can clarify, approve, deny, steer, or stop work; the contract belongs to the installed operator runtime.",
        href: "https://hermes-agent.nousresearch.com/docs/user-guide/messaging",
      },
    },
  },
  {
    feature: "Channels and delivery",
    question: "Can one agent meet users on product, API, chat, and event surfaces?",
    cells: {
      eve: {
        level: "native",
        title: "A root-level channel contract",
        detail:
          "HTTP, web, Slack, Discord, Teams, Telegram, GitHub, Linear, Twilio, and custom routes share one runtime.",
        href: "/docs/channels/overview",
      },
      mastra: {
        level: "native",
        title: "Channels via Chat SDK adapters",
        detail:
          "Slack, Discord, Telegram, and other adapters map platform threads into agent memory and signals.",
        href: "https://mastra.ai/docs/capabilities/channels/overview",
      },
      flue: {
        level: "integrated",
        title: "Discovered provider ingress",
        detail:
          "Channel modules verify provider events and dispatch them into agent instances; outbound behavior is authored.",
        href: "https://flueframework.com/docs/guide/channels/",
      },
      cloudflare: {
        level: "integrated",
        title: "Chat, email, voice, Slack, webhooks",
        detail:
          "The platform ships primitives and examples for several surfaces around a shared Agent class.",
        href: "https://developers.cloudflare.com/agents/",
      },
      langgraph: {
        level: "outside",
        title: "Bring the transport",
        detail:
          "Agent Server exposes runs and streams; messaging-platform channel adapters are outside LangGraph core.",
        href: "https://docs.langchain.com/langsmith/deployment-quickstart",
      },
      hermes: {
        level: "native",
        title: "Many personal-agent gateways",
        detail:
          "One Hermes install connects to Telegram, Discord, Slack, WhatsApp, Signal, email, and CLI.",
        href: "https://hermes-agent.nousresearch.com/docs/user-guide/messaging",
      },
    },
  },
  {
    feature: "Connected services and user OAuth",
    question:
      "Can tools reach external systems without exposing credentials to the model or sandbox?",
    cells: {
      eve: {
        level: "native",
        title: "MCP + OpenAPI connections",
        detail:
          "Per-user credentials follow the current principal; interactive OAuth parks and resumes the same turn.",
        href: "/docs/connections",
      },
      mastra: {
        level: "integrated",
        title: "MCP and application tools",
        detail:
          "MCP clients and servers are native; end-user credential scope and OAuth UX are application concerns.",
        href: "https://mastra.ai/docs/mcp/overview",
      },
      flue: {
        level: "integrated",
        title: "MCP tools with trusted headers",
        detail:
          "Remote tools are imported into agent code; the application owns credentials and authorization boundaries.",
        href: "https://flueframework.com/docs/guide/tools/",
      },
      cloudflare: {
        level: "integrated",
        title: "MCP client + OAuth flow",
        detail:
          "Agents connect remote MCP servers and receive an authorization URL when a server requires OAuth.",
        href: "https://developers.cloudflare.com/agents/tools/mcp/",
      },
      langgraph: {
        level: "assemble",
        title: "Use LangChain integrations",
        detail:
          "MCP adapters and tools compose into the graph; application code owns auth and credential lifecycle.",
        href: "https://docs.langchain.com/oss/javascript/langchain/mcp",
      },
      hermes: {
        level: "integrated",
        title: "Configurable MCP servers",
        detail:
          "Operators add MCP servers and plugins to the installed agent's global or profile configuration.",
        href: "https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp",
      },
    },
  },
  {
    feature: "Schedules, evals, and observability",
    question: "Are ongoing operation and improvement part of the same framework story?",
    cells: {
      eve: {
        level: "native",
        title: "All three are authored surfaces",
        detail:
          "Path-derived schedules, executable evals, local logs, workflow metadata, and OpenTelemetry ship together.",
        href: "/docs/evals/overview",
      },
      mastra: {
        level: "native",
        title: "Broad production toolchain",
        detail:
          "Workflows, scorers, datasets, experiments, tracing, and deployment are mature strengths; scheduling depends on runtime.",
        href: "https://mastra.ai/docs/observability/overview",
      },
      flue: {
        level: "assemble",
        title: "External scheduler and eval tooling",
        detail:
          "Flue 2.0 delegates scheduling to the host and recommends a vitest-evals recipe instead of a built-in runner.",
        href: "https://flueframework.com/docs/guide/schedules/",
      },
      cloudflare: {
        level: "integrated",
        title: "Schedules + platform telemetry",
        detail:
          "Durable scheduling and platform observability are built in; agent evaluation is assembled separately.",
        href: "https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/",
      },
      langgraph: {
        level: "integrated",
        title: "LangSmith platform",
        detail:
          "Tracing, evaluation, deployment, and cron jobs are available through the adjacent LangSmith product.",
        href: "https://docs.langchain.com/langsmith/observability-concepts",
      },
      hermes: {
        level: "integrated",
        title: "Cron + trajectory export",
        detail:
          "The installed agent schedules unattended work and exports research trajectories; it is not a product eval framework.",
        href: "https://hermes-agent.nousresearch.com/docs/user-guide/features/cron",
      },
    },
  },
];
