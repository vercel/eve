import { basename, join, resolve } from "node:path";

import { isEveProject } from "#setup/scaffold/index.js";

import { select, SkippedSignal, text, type Asker } from "../ask.js";
import { pathExists } from "../path-exists.js";
import { parseProjectName, validateProjectName } from "../project-name.js";
import {
  CURRENT_DIRECTORY_PROJECT_NAME,
  type ResolvedProjectPath,
  type SetupState,
} from "../state.js";
import type { SetupBox } from "../step.js";

const DEFAULT_PROJECT_NAME = "my-agent";
const NAME_PROMPT_MESSAGE = "What's your agent's name?";

/** Injected for tests; defaults to the real filesystem probes. */
export interface ResolveTargetDeps {
  pathExists: typeof pathExists;
  isEveProject: typeof isEveProject;
}

export interface ResolveTargetOptions {
  /** Resolves the name and directory questions; the composed stack decides how. */
  asker: Asker;
  /**
   * Interactive-only notice surface for the duplicate-directory re-ask loop.
   * Narrower than the prompter it forwards to; goes away when notices get a
   * channel of their own.
   */
  notify(message: string): void;
  /**
   * Skip the name question and use this value. Stays a factory option (not a
   * `withAnswers` rung) so it keeps short-circuiting before any ask while
   * still being validated, exactly as the dual-face box did.
   */
  presetName?: string;
  /** Parent directory the project folder is created inside. Defaults to cwd. */
  targetDirectory?: string;
  /** Force scaffolding into the target directory instead of a `./<name>` child. */
  inPlace?: boolean;
  /**
   * Treat an existing `./<name>` that is already an eve project as resumable
   * instead of refusing it. Composed on for headless runs so re-runs converge;
   * interactive runs keep refusing so a human notices the collision.
   */
  resumeExisting?: boolean;
  deps?: ResolveTargetDeps;
}

/** The name + directory decision gather produces. */
export interface ResolveTargetInput {
  agentName: string;
  inPlace: boolean;
}

export interface ResolveTargetPayload {
  agentName: string;
  projectPath: Extract<ResolvedProjectPath, { kind: "resolved" }>;
}

/** Validates a preset name; the non-asking half of the name decision. */
function validatePresetName(presetName: string): string {
  return parseProjectName(presetName);
}

/**
 * Asks the agent name through the channel. Pure name resolution: it performs
 * no filesystem checks, so the directory decision can be made separately. The
 * returned string is a single path segment safe to use as both a directory
 * name and a Vercel project slug.
 */
async function askAgentName(asker: Asker, required: boolean): Promise<string> {
  const raw = await asker.ask(
    text({
      key: "name",
      message: NAME_PROMPT_MESSAGE,
      placeholder: DEFAULT_PROJECT_NAME,
      recommended: DEFAULT_PROJECT_NAME,
      validate: (value) => validateProjectName(value.trim() || DEFAULT_PROJECT_NAME) ?? null,
      required,
    }),
  );
  return raw.trim() || DEFAULT_PROJECT_NAME;
}

function deriveInPlaceProjectName(targetDirectory: string | undefined): string {
  const targetRoot = resolve(targetDirectory ?? process.cwd());
  const projectName = basename(targetRoot);
  const validationError = validateProjectName(projectName);
  if (validationError !== undefined) {
    throw new Error(
      `Cannot infer a valid project name from "${targetRoot}". Pass --target-dir with a valid basename, or scaffold into a renamed directory.`,
    );
  }
  return projectName;
}

/**
 * THE TARGET BOX (Q1 + Q2): resolve the agent name (the shared identity for
 * the directory and the Vercel project) and decide whether to scaffold in
 * place or into a new `./<name>` child. The current-vs-new question only fires
 * when the target directory already looks like a project; otherwise creating a
 * new directory is the announced default. A headless re-run resumes an
 * existing eve project directory instead of refusing it (composed via
 * `resumeExisting`), so re-runs converge.
 */
export function resolveTarget(
  options: ResolveTargetOptions,
): SetupBox<SetupState, ResolveTargetInput, ResolveTargetPayload> {
  const deps = options.deps ?? { pathExists, isEveProject };
  const parent = (): string => resolve(options.targetDirectory ?? process.cwd());
  const inPlaceBasename = (): string => basename(parent());

  /**
   * Throws if `./<name>` already exists under `parent`, unless the composition
   * opted into resuming an existing eve project there (headless re-runs). Used
   * for the "create a new directory" branch, where clobbering an existing
   * folder is unsafe.
   */
  async function assertNewDirectoryAvailable(name: string): Promise<void> {
    if (name === CURRENT_DIRECTORY_PROJECT_NAME) return;
    const targetPath = resolve(parent(), name);
    if (!(await deps.pathExists(targetPath))) return;
    if (options.resumeExisting === true && (await deps.isEveProject(targetPath))) return;
    throw new Error(`Directory "${name}" already exists. Choose a different name.`);
  }

  /** A directory the user is already working in looks like a project to scaffold into. */
  async function looksLikeProject(dir: string): Promise<boolean> {
    const [hasPackageJson, hasVercelDir] = await Promise.all([
      deps.pathExists(join(dir, "package.json")),
      deps.pathExists(join(dir, ".vercel")),
    ]);
    return hasPackageJson || hasVercelDir;
  }

  /** Re-asks until `./<name>` is free under `parent`. */
  async function askFreeDirectoryName(initial: string): Promise<string> {
    let candidate = initial;
    while (true) {
      if (candidate === CURRENT_DIRECTORY_PROJECT_NAME) return candidate;
      if (!(await deps.pathExists(resolve(parent(), candidate)))) return candidate;
      options.notify(`Directory "${candidate}" already exists. Choose a different name.`);
      candidate = await askAgentName(options.asker, true);
    }
  }

  function inPlaceInput(): ResolveTargetInput {
    // A passed name is the shared identity even in place; only fall back to the
    // directory basename when no name was given.
    const agentName =
      options.presetName !== undefined
        ? validatePresetName(options.presetName)
        : deriveInPlaceProjectName(options.targetDirectory);
    return { agentName, inPlace: true };
  }

  return {
    id: "resolve-target",

    async gather(): Promise<ResolveTargetInput> {
      if (options.inPlace) {
        // An interactive in-place run can recover from a directory whose
        // basename is not a valid project slug (uppercase, spaces) by asking
        // for the agent identity; the directory itself stays as-is. The
        // question is skippable so a headless stack skips it, and the box
        // falls through to the derive, which reports the invalid basename.
        if (
          options.presetName === undefined &&
          validateProjectName(inPlaceBasename()) !== undefined
        ) {
          try {
            return { agentName: await askAgentName(options.asker, false), inPlace: true };
          } catch (error) {
            if (!(error instanceof SkippedSignal)) throw error;
          }
        }
        return inPlaceInput();
      }

      if (options.presetName !== undefined) {
        // A positionally-supplied name keeps the create-a-new-directory default.
        const agentName = validatePresetName(options.presetName);
        await assertNewDirectoryAvailable(agentName);
        return { agentName, inPlace: false };
      }

      // A headless stack refuses here: the name is unguessable and required.
      const agentName = await askAgentName(options.asker, true);

      if (await looksLikeProject(parent())) {
        const choice = await options.asker.ask(
          select<"current" | "new">({
            key: "target-directory",
            message: "This directory already looks like a project. Where should the agent live?",
            options: [
              { id: "current", label: "Scaffold into this directory", value: "current" },
              { id: "new", label: `Create a new directory ./${agentName}`, value: "new" },
            ],
            recommended: "new",
            // Only reachable after the name question was answered, i.e. in an
            // interactive stack; required keeps any other stack from guessing.
            required: true,
          }),
        );
        if (choice === "current") {
          return { agentName, inPlace: true };
        }
      }

      return { agentName: await askFreeDirectoryName(agentName), inPlace: false };
    },

    async perform({ input }): Promise<ResolveTargetPayload> {
      const projectName = input.inPlace ? CURRENT_DIRECTORY_PROJECT_NAME : input.agentName;
      return {
        agentName: input.agentName,
        projectPath: {
          kind: "resolved",
          inPlace: input.inPlace,
          path: resolve(parent(), projectName),
        },
      };
    },

    apply(state, payload) {
      return { ...state, agentName: payload.agentName, projectPath: payload.projectPath };
    },
  };
}
