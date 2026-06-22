import { withSpinner } from "./with-spinner.js";

import type { Prompter } from "./prompter.js";

/** Project fields needed by the existing-project picker. */
interface PickableVercelProject {
  readonly id: string;
  readonly name: string;
}

/** Inputs for choosing from recent projects with optional server-side search. */
interface VercelProjectPickerOptions {
  readonly prompter: Prompter;
  readonly team: string;
  readonly projects: readonly PickableVercelProject[];
  search(query: string): Promise<readonly PickableVercelProject[]>;
}

const SEARCH_PROJECT_PREFIX = "\0search-project:";

function searchProjectValue(query: string): string {
  return `${SEARCH_PROJECT_PREFIX}${query}`;
}

function searchProjectQuery(value: string): string | undefined {
  return value.startsWith(SEARCH_PROJECT_PREFIX)
    ? value.slice(SEARCH_PROJECT_PREFIX.length)
    : undefined;
}

/** Keeps visible order, refreshes matching ids, and appends new projects. */
function appendProjects(
  existing: readonly PickableVercelProject[],
  found: readonly PickableVercelProject[],
): PickableVercelProject[] {
  const projects = new Map(existing.map((project) => [project.id, project]));
  for (const project of found) projects.set(project.id, project);
  return [...projects.values()];
}

/** Shows recent projects and searches the full team scope on request. */
export async function pickExistingVercelProject(
  options: VercelProjectPickerOptions,
): Promise<PickableVercelProject> {
  let projects = options.projects;

  while (true) {
    const selected = await options.prompter.select({
      message: "Project to link",
      search: true,
      placeholder: "type to filter projects",
      searchAction: {
        label: (query) => `Search for '${query}'`,
        value: searchProjectValue,
        load: async (query) => {
          const found = await options.search(query);
          projects = appendProjects(projects, found);
          return projects.map((project) => ({ value: project.id, label: project.name }));
        },
      },
      options: projects.map((project) => ({ value: project.id, label: project.name })),
      initialValue: projects[0]?.id,
    });
    const query = searchProjectQuery(selected);
    if (query === undefined) {
      const project = projects.find((candidate) => candidate.id === selected);
      if (project === undefined) throw new Error("Selected Vercel project is not available.");
      return project;
    }

    const found = await withSpinner(
      options.prompter,
      `Searching ${options.team} for "${query}"...`,
      () => options.search(query),
    );
    if (found.length === 0) {
      options.prompter.note(`No projects matched "${query}" in ${options.team}.`);
      continue;
    }
    projects = appendProjects(projects, found);
  }
}
