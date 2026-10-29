export async function deleteProject(input: { orgId: string; projectId: string }) {
  return { deleted: input.projectId };
}
