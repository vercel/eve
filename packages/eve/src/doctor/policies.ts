import type {
  DependencyFacts,
  Diagnostic,
  DiscoveryFacts,
  GitFacts,
  NodeFacts,
  PackageManagerFacts,
} from "./types.js";

export function nodeDiagnostic(facts: NodeFacts): Diagnostic {
  if (facts.kind === "unavailable") {
    return { id: "runtime.node", status: "fail", summary: facts.message, remediation: [] };
  }
  const supported = Number(facts.version.split(".")[0]) >= 24;
  return supported
    ? {
        id: "runtime.node",
        status: "pass",
        summary: `Node.js ${facts.version} is available at ${facts.executable}.`,
        remediation: [],
      }
    : {
        id: "runtime.node",
        status: "fail",
        summary: `Node.js ${facts.version} is unsupported; eve requires Node.js 24 or newer.`,
        remediation: [{ kind: "message", message: "Install Node.js 24 or newer." }],
      };
}

export function discoveryDiagnostic(facts: DiscoveryFacts): Diagnostic {
  return facts.kind === "resolved"
    ? {
        id: "project.discovery",
        status: "pass",
        summary: `Found ${facts.project.layout} eve project at ${facts.project.appRoot}.`,
        remediation: [],
      }
    : {
        id: "project.discovery",
        status: "fail",
        summary: facts.message,
        remediation: [{ kind: "command", command: "eve init <path>" }],
      };
}

export function packageManagerDiagnostic(facts: PackageManagerFacts): Diagnostic {
  if (facts.kind === "unavailable") {
    return { id: "package.manager", status: "unknown", summary: facts.message, remediation: [] };
  }
  if (facts.conflict) {
    return {
      id: "package.manager",
      status: "warn",
      summary: `Selected ${facts.manager}, but multiple package-manager lockfiles are present: ${facts.lockfiles.join(", ")}.`,
      remediation: [
        {
          kind: "message",
          message: "Remove stale lockfiles after confirming the intended package manager.",
        },
      ],
    };
  }
  return {
    id: "package.manager",
    status: "pass",
    summary: `Selected ${facts.manager} from ${facts.source}.`,
    remediation: [],
  };
}

export function dependencyDiagnostic(facts: DependencyFacts, manager: string): Diagnostic {
  switch (facts.kind) {
    case "installed":
      return {
        id: "package.dependencies",
        status: "pass",
        summary: "Project dependencies are installed.",
        remediation: [],
      };
    case "not-applicable":
      return {
        id: "package.dependencies",
        status: "pass",
        summary: "The project declares no dependencies.",
        remediation: [],
      };
    case "missing":
      return {
        id: "package.dependencies",
        status: "fail",
        summary: "Project dependencies are not installed.",
        remediation: [{ kind: "command", command: `${manager} install` }],
      };
    case "unavailable":
      return {
        id: "package.dependencies",
        status: "unknown",
        summary: facts.message,
        remediation: [],
      };
  }
}

export function gitDiagnostics(facts: GitFacts): Diagnostic[] {
  if (facts.kind === "unavailable") {
    return [
      { id: "git.repository", status: "unknown", summary: facts.message, remediation: [] },
      {
        id: "git.remote",
        status: "unknown",
        summary: "Git remotes could not be inspected.",
        remediation: [],
      },
    ];
  }
  if (facts.kind === "not-repository") {
    return [
      {
        id: "git.repository",
        status: "warn",
        summary: "This project is not a Git repository; local development is unaffected.",
        remediation: [{ kind: "command", command: "git init" }],
      },
      {
        id: "git.remote",
        status: "warn",
        summary: "No Git remote is configured; local development is unaffected.",
        remediation: [],
      },
    ];
  }
  return [
    {
      id: "git.repository",
      status: facts.head === "unborn" ? "warn" : "pass",
      summary:
        facts.head === "unborn"
          ? "Git repository has no commits yet."
          : facts.head === "detached"
            ? `Git repository is at detached revision ${facts.revision}.`
            : `Git repository is on branch ${facts.branch}${facts.dirty ? " with local changes" : ""}.`,
      remediation: [],
    },
    facts.remotes.length === 0
      ? {
          id: "git.remote",
          status: "warn",
          summary: "No Git remote is configured; local development is unaffected.",
          remediation: [],
        }
      : {
          id: "git.remote",
          status: "pass",
          summary: `Git remotes: ${facts.remotes.join(", ")}.`,
          remediation: [],
        },
  ];
}
