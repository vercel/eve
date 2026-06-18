import type { Prompter, SearchSelectOptions, SelectNotice } from "./prompter.js";

export interface PickableVercelProject {
  id: string;
  name: string;
  updatedAt: number;
}

export interface VercelProjectPickerOptions {
  prompter: Prompter;
  team: string;
  message: string;
  projects: readonly PickableVercelProject[];
  search(query: string): Promise<readonly PickableVercelProject[]>;
}

const SEARCH_ALL_PROJECTS = "\0search-all-projects";

function newestProjectsFirst(projects: readonly PickableVercelProject[]): PickableVercelProject[] {
  return projects.toSorted((left, right) => right.updatedAt - left.updatedAt);
}

function projectSelectOptions(projects: readonly PickableVercelProject[]) {
  return projects.map((entry) => ({ value: entry.name, label: entry.name }));
}

function mergeProjects(
  current: readonly PickableVercelProject[],
  found: readonly PickableVercelProject[],
): PickableVercelProject[] {
  const projects = new Map(current.map((project) => [project.id, project]));
  for (const project of found) projects.set(project.id, project);
  return newestProjectsFirst([...projects.values()]);
}

async function pickWithSelectFallback(options: VercelProjectPickerOptions): Promise<string> {
  const { message, prompter, team, search } = options;
  let projects = newestProjectsFirst(options.projects);
  while (true) {
    const selected = await prompter.select({
      message,
      search: true,
      placeholder: "type to filter projects",
      options: [
        ...projectSelectOptions(projects),
        { value: SEARCH_ALL_PROJECTS, label: "Search all projects" },
      ],
    });
    if (selected !== SEARCH_ALL_PROJECTS) return selected;

    const query = (
      await prompter.text({
        message: "Project name to search",
        validate: (value) =>
          value.trim().length === 0 ? "Project name cannot be empty." : undefined,
      })
    ).trim();
    const found = await search(query);
    if (found.length === 0) {
      prompter.note(`No projects matched "${query}" in ${team}.`);
      continue;
    }
    projects = mergeProjects(projects, found);
  }
}

/**
 * Shows the first page of projects, then searches the Vercel API when the user
 * selects the query action.
 */
export async function pickExistingVercelProject(
  options: VercelProjectPickerOptions,
): Promise<string> {
  const { message, prompter, team, search } = options;
  const searchSelect = prompter.searchSelect;
  if (searchSelect === undefined) return pickWithSelectFallback(options);

  let projects = newestProjectsFirst(options.projects);
  let initialQuery: string | undefined;
  let notices: readonly SelectNotice[] | undefined;
  while (true) {
    const prompt: SearchSelectOptions<string> = {
      message,
      placeholder: "type to filter projects",
      queryActionLabel: "Search for",
      options: projectSelectOptions(projects),
    };
    if (initialQuery !== undefined) prompt.initialQuery = initialQuery;
    if (notices !== undefined) prompt.notices = notices;

    const result = await searchSelect(prompt);
    if (result.kind === "selected") return result.value;

    const found = await search(result.query);
    initialQuery = result.query;
    if (found.length === 0) {
      notices = [{ tone: "warning", text: `No projects matched "${result.query}" in ${team}.` }];
      continue;
    }
    projects = mergeProjects(projects, found);
    notices = undefined;
  }
}
