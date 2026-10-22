import { templatePath } from "./canonical";
import { templateManifest, type TemplateManifestEntry } from "../templates/manifest";

export type UseCaseId = "business" | "service";

export type CapabilityIcon =
  | "approval"
  | "channels"
  | "connections"
  | "durability"
  | "dynamic"
  | "evals"
  | "identity"
  | "memory"
  | "models"
  | "observability"
  | "sandbox"
  | "schedules"
  | "tenancy"
  | "tools";

export type ChannelLogo =
  | "discord"
  | "github"
  | "imessage"
  | "linear"
  | "slack"
  | "teams"
  | "telegram"
  | "web"
  | "whatsapp";

interface Pattern {
  title: string;
  description: string;
  template: string;
  /** Shorter card label for templates whose gallery title is long. */
  templateLabel?: string;
}

interface Capability {
  icon: CapabilityIcon;
  need: string;
  title: string;
  description: string;
  href: string;
}

interface UseCase {
  title: string;
  audience: string;
  anchor: string;
  summary: string;
  channels: readonly { logo: ChannelLogo; label: string }[];
  patterns: readonly Pattern[];
  capabilities: readonly Capability[];
}

export const useCases: Record<UseCaseId, UseCase> = {
  business: {
    title: "Business agents",
    audience: "For your team",
    anchor: "business-agents",
    summary:
      "Automate a company function, like analytics, a software factory, marketing, or finance.",
    channels: [
      { logo: "slack", label: "Slack" },
      { logo: "teams", label: "Microsoft Teams" },
      { logo: "github", label: "GitHub" },
      { logo: "linear", label: "Linear" },
      { logo: "web", label: "Web" },
    ],
    patterns: [
      {
        title: "Software factory",
        description:
          "Agents plan features, open pull requests, review code, and respond to incidents alongside an engineering team.",
        template: "eve-software-factory-template",
      },
      {
        title: "Company brain",
        description:
          "One agent holds the company's skills, tools, and approved connections, reachable where employees work, with each employee's own identity and connections.",
        template: "eve-company-brain-template",
      },
      {
        title: "Marketing team",
        description:
          "A lead agent routes work to specialists for positioning, long-form content, social, SEO, and email, then publishes through Notion, Typefully, and Resend.",
        template: "marketing-team-eve-template",
        templateLabel: "Marketing team",
      },
    ],
    capabilities: [
      {
        icon: "channels",
        need: "Meet employees where they work",
        title: "Channels",
        description:
          "One agent serves Slack, Microsoft Teams, GitHub, Linear, and your own web apps, with a session for every conversation.",
        href: "/docs/channels/overview",
      },
      {
        icon: "observability",
        need: "Govern and audit every run",
        title: "Observability",
        description:
          "OpenTelemetry traces and Agent Runs record every session, model call, and tool call, so you can see what an agent did and why.",
        href: "/docs/observability/instrumentation",
      },
      {
        icon: "identity",
        need: "Use your identity provider",
        title: "Identity and access",
        description:
          "Verify callers with any OIDC issuer, JWTs, or your own authenticator. Each connection then acts as the agent itself or on behalf of the signed-in user.",
        href: "/docs/guides/auth-and-route-protection",
      },
      {
        icon: "models",
        need: "Switch models without a code rewrite",
        title: "Models",
        description:
          "Changing models is a one-line edit in agent.ts, and requests can fall back to another provider on failure.",
        href: "/docs/agent-config",
      },
      {
        icon: "connections",
        need: "Connect to approved services",
        title: "Connections",
        description:
          "Expose the MCP and OpenAPI services your IT team approves. Credentials stay in the runtime, and the model never sees them.",
        href: "/docs/connections",
      },
      {
        icon: "evals",
        need: "Evaluate agent responses",
        title: "Evals",
        description:
          "Evals are automated tests that run the agent through real turns and score the result with code checks or a model judge, so you catch regressions when a prompt, tool, or model changes.",
        href: "/docs/evals/overview",
      },
      {
        icon: "tools",
        need: "Put deterministic steps in the loop",
        title: "Workflow tools",
        description:
          "Tools are typed TypeScript functions the model chooses when to call. When a process must run the same way every time, use a workflow tool instead. Its code fixes the order of steps, calls subagents exactly where you say, and waits durably for approvals or webhooks between steps.",
        href: "/docs/tools/workflows",
      },
      {
        icon: "sandbox",
        need: "Run commands in sandboxed compute",
        title: "Sandbox",
        description:
          "Each session gets an isolated filesystem and shell for scripts, repositories, and generated files.",
        href: "/docs/sandbox",
      },
      {
        icon: "approval",
        need: "Keep a human in the loop",
        title: "Human-in-the-loop",
        description:
          "Sessions pause while an approval is pending and resume durably when it resolves. A decision model can auto-approve routine tool calls.",
        href: "/docs/human-in-the-loop",
      },
    ],
  },
  service: {
    title: "Agent as a Service (AaaS)",
    audience: "For your customers",
    anchor: "agent-as-a-service-aaas",
    summary: "Build multi-tenant agentic applications that scale as you grow.",
    channels: [
      { logo: "imessage", label: "iMessage" },
      { logo: "whatsapp", label: "WhatsApp" },
      { logo: "telegram", label: "Telegram" },
      { logo: "discord", label: "Discord" },
      { logo: "web", label: "Web" },
    ],
    patterns: [
      {
        title: "Web chat",
        description:
          "A Next.js chat app with sign-in, persisted conversations, and long-term memory for each user.",
        template: "eve-chat-template",
      },
      {
        title: "iMessage agent",
        description:
          "A multi-tenant iMessage service with user accounts, scoped memory, an encrypted vault, and cloud browser automation.",
        template: "openinstinct-eve-template",
        templateLabel: "iMessage",
      },
      {
        title: "Voice agent",
        description:
          "Users talk to the agent in the browser while it runs tools, asks for approvals, and keeps durable state.",
        template: "eve-voice-template",
      },
    ],
    capabilities: [
      {
        icon: "tenancy",
        need: "Isolate every tenant",
        title: "Multi-tenancy",
        description:
          "Bind memory, connection credentials, and approval policy to the authenticated tenant and user, so one customer's data and access never reach another.",
        href: "/docs/patterns/multi-tenant-auth",
      },
      {
        icon: "dynamic",
        need: "Customize the agent per tenant",
        title: "Dynamic capabilities",
        description:
          "Resolve the model, tools, connections, skills, and instructions at runtime from the caller, their tenant, or a feature flag, all from one deployment.",
        href: "/docs/guides/dynamic-capabilities",
      },
      {
        icon: "schedules",
        need: "Run work on fixed and dynamic schedules",
        title: "Schedules",
        description:
          "Fixed cron schedules power digests and monitors with no user present. Experimental dynamic schedules let users and agents create their own recurring or one-time runs at runtime.",
        href: "/docs/schedules",
      },
      {
        icon: "observability",
        need: "Trace latency and every tool call",
        title: "Observability",
        description:
          "Traces and Agent Runs show per-turn latency and the tool calls behind each response.",
        href: "/docs/observability/agent-runs",
      },
      {
        icon: "models",
        need: "Route each request to the right model",
        title: "Model selection",
        description:
          "Pick models per user, tenant, or feature, or let a decision model choose from your allowlist automatically, to balance cost, latency, and quality.",
        href: "/docs/guides/decide",
      },
      {
        icon: "durability",
        need: "Keep long-running sessions durable",
        title: "Durable sessions",
        description:
          "Each user's session checkpoints every step, parks while it waits, and resumes on the next message, even days later.",
        href: "/docs/concepts/execution-model-and-durability",
      },
      {
        icon: "memory",
        need: "Keep long-term memory for each user",
        title: "Memory",
        description:
          "Each user gets their own long-term memory of preferences and facts. It carries across sessions, stays isolated from other users, and lives in the provider you choose.",
        href: "/docs/memory",
      },
      {
        icon: "identity",
        need: "Act on behalf of each user",
        title: "User-scoped connections",
        description:
          "Connections authenticate to services like GitHub and Linear with each user's own grant, so tools call them without managing tokens.",
        href: "/docs/connections",
      },
      {
        icon: "sandbox",
        need: "Run untrusted input in isolation",
        title: "Sandbox and subagents",
        description:
          "Each session processes user data in its own sandbox. Subagents take work that needs its own prompt, tools, or sandbox.",
        href: "/docs/sandbox",
      },
    ],
  },
};

export const resolveTemplateLink = (
  pattern: Pattern,
): { label: string; href: string; template: TemplateManifestEntry } => {
  const template = templateManifest.find((entry) => entry.slug === pattern.template);
  if (!template) throw new Error(`Unknown template "${pattern.template}" on the use cases page.`);
  return {
    label: `${pattern.templateLabel ?? template.title} template`,
    href: templatePath(template.slug),
    template,
  };
};

export const isUseCaseId = (value: unknown): value is UseCaseId =>
  value === "business" || value === "service";

const channelList = new Intl.ListFormat("en", { type: "disjunction" });

export function renderUseCaseOverviewMarkdown(): string {
  return Object.values(useCases)
    .map(
      (useCase) =>
        `- **[${useCase.title}](#${useCase.anchor})** (${useCase.audience.toLowerCase()}): ${useCase.summary} It usually runs in ${channelList.format(useCase.channels.map((channel) => channel.label))}.`,
    )
    .join("\n");
}

export function renderUseCasePatternsMarkdown(id: UseCaseId): string {
  return useCases[id].patterns
    .map((pattern) => {
      const link = resolveTemplateLink(pattern);
      return `- **${pattern.title}**: ${pattern.description} See the [${link.label}](${link.href}).`;
    })
    .join("\n");
}

export function renderUseCaseCapabilitiesMarkdown(id: UseCaseId): string {
  return [
    "| What the use case needs | How eve supports it |",
    "| --- | --- |",
    ...useCases[id].capabilities.map(
      (capability) =>
        `| ${capability.need} | [${capability.title}](${capability.href}): ${capability.description} |`,
    ),
  ].join("\n");
}
