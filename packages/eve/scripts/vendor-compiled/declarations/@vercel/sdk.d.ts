// Minimal declaration for the vendored slice of `@vercel/sdk`: the project
// trusted-sources model helpers. Mirrors upstream's `UpdateProject*` shapes
// for the fields eve reads; widen it if a caller needs more of the policy.

/** System environment slugs (`production`, `preview`) and/or custom environment slugs. */
export type UpdateProjectEnvironmentSet =
  | { slugs: string[]; preset?: "all-custom" | undefined }
  | { slugs?: string[] | undefined; preset: "all-custom" };

export type UpdateProjectCustomAllow = {
  from: UpdateProjectEnvironmentSet;
  to: UpdateProjectEnvironmentSet;
};

export type UpdateProjectTrustedSources = {
  projects?:
    | {
        [projectId: string]: {
          label?: string | undefined;
          customAllow?: UpdateProjectCustomAllow[] | undefined;
        };
      }
    | undefined;
  oidcProviders?:
    | {
        [provider: string]: Array<{
          to: UpdateProjectEnvironmentSet;
          label?: string | undefined;
          claims: { [claim: string]: string[] };
        }>;
      }
    | undefined;
};

export declare function updateProjectTrustedSourcesFromJSON(
  jsonString: string,
):
  | { ok: true; value: UpdateProjectTrustedSources; error?: never }
  | { ok: false; value?: never; error: Error };

export declare function trustedSourcesToJSON(trustedSources: UpdateProjectTrustedSources): string;
