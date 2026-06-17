import {
  isEveProject,
  scaffoldBaseProject,
  type EvePackageContract,
} from "#setup/scaffold/index.js";

import type { Prompter } from "../prompter.js";
import { CURRENT_DIRECTORY_PROJECT_NAME, requireProjectPath, type SetupState } from "../state.js";
import type { SetupBox } from "../step.js";

/** Injected for tests; defaults to the real eve-scaffold helpers. */
export interface ScaffoldDeps {
  scaffoldBaseProject: typeof scaffoldBaseProject;
  isEveProject: typeof isEveProject;
}

export interface ScaffoldOptions {
  /** Reports scaffold progress and overwrite warnings. The box never prompts. */
  prompter: Prompter;
  evePackage?: EvePackageContract;
  /** Parent directory the project folder is created inside. Defaults to cwd. */
  targetDirectory?: string;
  /** Allow the in-place scaffold to replace eve scaffold files that already exist. */
  overwriteExisting?: boolean;
  /**
   * Headless mode: a headless re-run over an existing eve project skips
   * scaffolding (idempotent re-entry); an interactive run always scaffolds and
   * lets `scaffoldBaseProject` own the in-place conflict rules. The box prompts
   * for nothing, so this dispatch comes from the composition site.
   */
  headless?: boolean;
  deps?: ScaffoldDeps;
}

/**
 * Whether the run is headless. A headless re-run over an existing eve project
 * skips scaffolding (idempotent re-entry); an interactive run always scaffolds.
 */
export interface ScaffoldInput {
  headless: boolean;
}

/**
 * THE SCAFFOLD BOX: writes the base agent template into the path resolved by
 * the target box. It prompts for nothing; the gather only records which mode
 * ran, because a headless re-run on an already-scaffolded eve project skips the
 * write and continues setup instead of failing.
 */
export function scaffold(options: ScaffoldOptions): SetupBox<SetupState, ScaffoldInput, string> {
  const deps = options.deps ?? { scaffoldBaseProject, isEveProject };

  return {
    id: "scaffold",

    async gather(): Promise<ScaffoldInput> {
      // No questions: the only difference between modes is whether a re-run over
      // an existing eve project skips the write, a composition-time fact.
      return { headless: options.headless ?? false };
    },

    async perform({ state, input }): Promise<string> {
      const { prompter } = options;
      const scaffoldProjectName = state.projectPath.inPlace
        ? CURRENT_DIRECTORY_PROJECT_NAME
        : state.agentName;
      const projectPath = requireProjectPath(state);
      if (input.headless && !options.overwriteExisting && (await deps.isEveProject(projectPath))) {
        prompter.log.message("Existing eve project detected; continuing setup...");
        return projectPath;
      }

      prompter.log.message("Scaffolding project files...");
      const scaffoldedPath = await deps.scaffoldBaseProject({
        projectName: scaffoldProjectName,
        model: state.modelId,
        byokProvider: state.modelWiring === "self",
        targetDirectory: options.targetDirectory,
        overwriteExisting: options.overwriteExisting,
        onOverwriteFile: (filePath) => prompter.log.warning(`Overwrote ${filePath}`),
        evePackage: options.evePackage,
      });
      prompter.log.success(`Scaffolded project at ${scaffoldedPath}`);
      return scaffoldedPath;
    },

    apply(state, projectPath) {
      return {
        ...state,
        projectPath: { kind: "resolved", inPlace: state.projectPath.inPlace, path: projectPath },
      };
    },
  };
}
