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
