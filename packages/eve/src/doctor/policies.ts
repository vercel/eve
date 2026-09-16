import semver from "#compiled/semver/index.js";
import type { PackageManagerSource } from "#setup/package-manager.js";

import type {
  DependencyFacts,
  Diagnostic,
  DiscoveryFacts,
  GitFacts,
  NodeFacts,
  PackageManagerFacts,
  VercelFacts,
} from "./types.js";

function packageManagerSourceDescription(source: PackageManagerSource): string {
  switch (source) {
    case "package-manager-field":
      return "from the packageManager field in package.json";
    case "lockfile":
      return "from a lockfile";
    case "default":
      return "by default";
  }
}

export function nodeDiagnostic(facts: NodeFacts, nodeEngine: string): Diagnostic {
  if (facts.kind === "unavailable")
    return { id: "runtime.node", status: "fail", summary: facts.message, remediation: [] };
  return semver.intersects(facts.version, nodeEngine)
    ? {
        id: "runtime.node",
        status: "pass",
        summary: `Node.js ${facts.version} is available at ${facts.executable}.`,
        remediation: [],
      }
    : {
        id: "runtime.node",
        status: "fail",
        summary: `Node.js ${facts.version} is unsupported; eve requires Node.js ${nodeEngine}.`,
        remediation: [
          { kind: "message", message: `Install a Node.js version matching ${nodeEngine}.` },
        ],
      };
}

export function discoveryDiagnostic(facts: DiscoveryFacts): Diagnostic {
  return facts.kind === "resolved"
    ? {
        id: "project.discovery",
        status: "pass",
        summary: `Found eve project at ${facts.project.appRoot}.`,
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
  if (facts.kind === "unavailable")
    return { id: "package.manager", status: "unknown", summary: facts.message, remediation: [] };
  if (facts.conflict)
    return {
      id: "package.manager",
      status: "warn",
      summary: `Selected ${facts.manager}, but lockfiles for another package manager are present: ${facts.lockfiles.join(", ")}.`,
      remediation: [
        {
          kind: "message",
          message: "Remove stale lockfiles after confirming the intended package manager.",
        },
      ],
    };
  return {
    id: "package.manager",
    status: "pass",
    summary: `Selected ${facts.manager} as the package manager ${packageManagerSourceDescription(facts.source)}.`,
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
        summary: `Project dependencies are not installed: ${facts.dependencies.join(", ")}.`,
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

export function vercelDiagnostic(facts: VercelFacts): Diagnostic {
  switch (facts.kind) {
    case "authenticated":
      return {
        id: "vercel.authentication",
        status: "pass",
        summary: "Authenticated with Vercel.",
        remediation: [],
      };
    case "logged-out":
      return {
        id: "vercel.authentication",
        status: "warn",
        summary: "Not authenticated with Vercel.",
        remediation: [{ kind: "command", command: "vercel login" }],
      };
    case "cli-missing":
      return {
        id: "vercel.authentication",
        status: "warn",
        summary: "Vercel CLI is not installed.",
        remediation: [{ kind: "command", command: "npm i -g vercel@latest" }],
      };
    case "unavailable":
      return {
        id: "vercel.authentication",
        status: "unknown",
        summary: "Could not verify Vercel authentication. Check your connection and try again.",
        remediation: [],
      };
    case "skipped":
      return {
        id: "vercel.authentication",
        status: "unknown",
        summary: "Skipped Vercel authentication check in offline mode.",
        remediation: [],
      };
  }
}

export function gitDiagnostics(facts: GitFacts): Diagnostic[] {
  if (facts.kind === "unavailable")
    return [
      { id: "git.repository", status: "unknown", summary: facts.message, remediation: [] },
      {
        id: "git.remote",
        status: "unknown",
        summary: "Git remotes could not be inspected.",
        remediation: [],
      },
    ];
  if (facts.kind === "not-repository")
    return [
      {
        id: "git.repository",
        status: "warn",
        summary:
          "This project is not a Git repository. Local development works, but you cannot commit or share changes yet.",
        remediation: [{ kind: "command", command: "git init" }],
      },
      {
        id: "git.remote",
        status: "warn",
        summary:
          "No Git remote is configured. Local development works, but you cannot push or share this repository.",
        remediation: [],
      },
    ];
  return [
    {
      id: "git.repository",
      status: facts.head === "unborn" ? "warn" : "pass",
      summary:
        facts.head === "unborn"
          ? "Git repository has no commits yet; commit the project before sharing it."
          : facts.head === "detached"
            ? `Git repository is at detached revision ${facts.revision}; switch to a branch before committing changes.`
            : `Git repository is on branch ${facts.branch}${facts.dirty ? " with local changes" : ""}.`,
      remediation:
        facts.head === "unborn"
          ? [{ kind: "command", command: 'git add . && git commit -m "Initial commit"' }]
          : facts.head === "detached"
            ? [{ kind: "command", command: "git switch -c <branch>" }]
            : [],
    },
    facts.remotes.length === 0
      ? {
          id: "git.remote",
          status: "warn",
          summary:
            "No Git remote is configured. Local development works, but you cannot push or share this repository.",
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
