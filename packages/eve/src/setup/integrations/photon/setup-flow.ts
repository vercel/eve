import { join } from "node:path";

import { select, text } from "../../ask.js";
import { appendEnv } from "../../append-env.js";
import { readProjectLink, type VercelProjectReference } from "../../project-resolution.js";
import { openUrl } from "../../primitives/open-url.js";
import { deriveSlackConnectorSlug } from "../../scaffold/index.js";
import { writeTextFile } from "../../scaffold/files.js";
import { resolveIntegrationVercelProject } from "../shared/vercel-project.js";
import type { SetupApplyContext, SetupPrepareContext } from "../types.js";
import { provisionPhotonConnector } from "./connect.js";
import {
  findDedicatedPhotonLine,
  provisionPhotonProject,
  usePhotonProject,
  validatePhotonPhoneNumber,
  type PhotonManagedProject,
} from "./management.js";

export interface PhotonSetupPlan {
  agentName: string;
  credentials: "vercel-connect" | "environment";
  photonProject: "create" | { projectId: string; projectSecret: string };
  photonProjectName?: string;
  dedicatedLine?: string;
  phoneNumber?: string;
  vercelProject?: VercelProjectReference;
}

export interface PhotonSetupDeps {
  appendEnv: typeof appendEnv;
  deriveConnectorSlug: typeof deriveSlackConnectorSlug;
  findDedicatedLine: typeof findDedicatedPhotonLine;
  readProjectLink: typeof readProjectLink;
  openUrl: typeof openUrl;
  provisionConnector: typeof provisionPhotonConnector;
  provisionProject: typeof provisionPhotonProject;
  useProject: typeof usePhotonProject;
  writeTextFile: typeof writeTextFile;
}

const defaultDeps: PhotonSetupDeps = {
  appendEnv,
  deriveConnectorSlug: deriveSlackConnectorSlug,
  findDedicatedLine: findDedicatedPhotonLine,
  readProjectLink,
  openUrl,
  provisionConnector: provisionPhotonConnector,
  provisionProject: provisionPhotonProject,
  useProject: usePhotonProject,
  writeTextFile,
};

const PORTABLE_TEMPLATE = `import { photonIMessageChannel } from "eve/channels/photon";\n\nasync function photonCredentials() {\n  const projectId = process.env.IMESSAGE_PROJECT_ID;\n  const projectSecret = process.env.IMESSAGE_PROJECT_SECRET;\n  if (!projectId || !projectSecret) throw new Error("Photon project credentials are required.");\n  return { projectId, projectSecret };\n}\n\nexport default photonIMessageChannel({\n  credentials: photonCredentials,\n  webhookSecret: process.env.IMESSAGE_WEBHOOK_SECRET,\n});\n`;

function connectTemplate(connectorUid: string): string {
  return `import { connectPhotonCredentials } from "@vercel/connect/eve";\nimport { photonIMessageChannel } from "eve/channels/photon";\n\nexport default photonIMessageChannel({\n  credentials: connectPhotonCredentials(${JSON.stringify(connectorUid)}),\n});\n`;
}

export async function preparePhotonSetup(
  context: SetupPrepareContext,
  agentName: string,
  deps: PhotonSetupDeps = defaultDeps,
): Promise<PhotonSetupPlan> {
  const credentials = await context.asker.ask(
    select({
      key: "photon-credentials",
      message: "How would you like to configure Photon?",
      options: [
        {
          id: "vercel",
          value: "vercel-connect" as const,
          label: "Set up Vercel Connect",
          hint: "Use a linked Vercel project",
        },
        {
          id: "portable",
          value: "environment" as const,
          label: "Use portable credentials",
          hint: "Configure the Photon webhook manually after deployment",
        },
      ],
      recommended:
        context.environment.vercel.kind === "available"
          ? ("vercel-connect" as const)
          : ("environment" as const),
      required: true,
    }),
  );
  if (credentials === "vercel-connect" && context.environment.vercel.kind === "unavailable") {
    throw new Error(
      "Vercel Connect requires an authenticated Vercel CLI. Run `vercel login`, then retry Photon setup.",
    );
  }
  const defaultName = `eve · ${agentName || "agent"}`;
  const project = await context.asker.askEditable({
    key: "photon-project-source",
    message: "Photon project",
    options: [
      {
        id: "create",
        value: "create" as const,
        label: "Create a new Photon project",
        hint: `Name: ${defaultName}`,
      },
      {
        id: "existing",
        value: "existing" as const,
        label: "Use an existing Photon project",
        hint: "Enter its project credentials",
      },
    ],
    recommended: "create" as const,
    required: true,
    editable: {
      key: "photon-project-name",
      value: "create" as const,
      label: "Name",
      recommended: defaultName,
      validate: (value) => (value.trim().length === 0 ? "Project name cannot be empty." : null),
    },
  });
  let photonProject: PhotonSetupPlan["photonProject"] = "create";
  if (project.value === "existing") {
    const projectId = await context.asker.ask(
      text({ key: "photon-project-id", message: "Photon project ID", required: true }),
    );
    const projectSecret = await context.asker.ask(
      text({
        key: "photon-project-secret",
        message: "Photon project secret",
        required: true,
        sensitive: true,
        environment: "IMESSAGE_PROJECT_SECRET",
      }),
    );
    photonProject = { projectId: projectId.trim(), projectSecret: projectSecret.trim() };
  }
  const dedicatedLine =
    photonProject === "create" ? undefined : await deps.findDedicatedLine(photonProject);
  const phoneNumber =
    dedicatedLine === undefined
      ? await context.asker.ask(
          text({
            key: "photon-phone-number",
            message: "Your iMessage phone number",
            placeholder: "+15551234567",
            required: true,
            validate: validatePhotonPhoneNumber,
          }),
        )
      : undefined;
  const vercelProject =
    credentials === "vercel-connect"
      ? await resolveIntegrationVercelProject({
          appRoot: context.appRoot,
          integration: "Photon",
          signal: context.signal,
          deps,
        })
      : undefined;
  const plan: PhotonSetupPlan = {
    agentName,
    credentials,
    photonProject,
    dedicatedLine,
    phoneNumber,
  };
  if (project.value === "create") plan.photonProjectName = project.text ?? defaultName;
  if (vercelProject !== undefined) plan.vercelProject = vercelProject;
  return plan;
}

async function resolvePhotonProject(
  plan: PhotonSetupPlan,
  context: SetupApplyContext,
  deps: PhotonSetupDeps,
): Promise<PhotonManagedProject> {
  if (plan.photonProject !== "create")
    return deps.useProject({
      ...plan.photonProject,
      dedicatedLine: plan.dedicatedLine,
      phoneNumber: plan.phoneNumber,
    });
  if (plan.phoneNumber === undefined) throw new Error("Photon phone number is required.");
  const spinner = context.presentation.log.spinner?.("Waiting for Photon approval…", {
    kind: "external-action",
    emphasis: "browser",
  });
  try {
    return await deps.provisionProject({
      projectName: plan.photonProjectName ?? `eve · ${plan.agentName || "agent"}`,
      phoneNumber: plan.phoneNumber,
      signal: context.signal,
      onAuthorization(authorization) {
        context.presentation.externalAction({
          message: "Authorize Photon",
          url: authorization.verificationUrl,
          userCode: authorization.userCode,
        });
        deps.openUrl(authorization.verificationUrl);
      },
    });
  } finally {
    spinner?.stop();
  }
}

export async function applyPhotonSetup(
  plan: PhotonSetupPlan,
  context: SetupApplyContext,
  deps: PhotonSetupDeps = defaultDeps,
) {
  const managedProject = await resolvePhotonProject(plan, context, deps);
  try {
    const channelPath = join(context.appRoot, "agent/channels/photon.ts");
    if (plan.credentials === "vercel-connect") {
      const slug = await deps.deriveConnectorSlug(context.appRoot, plan.agentName);
      const connector = await deps.provisionConnector({
        credentials: managedProject,
        log: context.presentation.log,
        project: plan.vercelProject!,
        projectRoot: context.appRoot,
        slug,
        signal: context.signal,
      });
      await deps.writeTextFile(channelPath, connectTemplate(connector.uid), {
        force: context.force,
      });
    } else {
      await deps.appendEnv(join(context.appRoot, ".env.local"), {
        IMESSAGE_PROJECT_ID: managedProject.projectId,
        IMESSAGE_PROJECT_SECRET: managedProject.projectSecret,
      });
      await deps.writeTextFile(channelPath, PORTABLE_TEMPLATE, { force: context.force });
      context.presentation.nextSteps([
        "Deploy the agent, then create a Photon webhook pointing to https://<your-host>/eve/v1/photon.",
        "Copy the webhook signing secret into IMESSAGE_WEBHOOK_SECRET, alongside IMESSAGE_PROJECT_ID and IMESSAGE_PROJECT_SECRET, in your host's encrypted environment variables.",
      ]);
    }
    context.presentation.log.success("Scaffolded channel: photon");
    if (managedProject.assignedPhoneNumber !== undefined)
      context.presentation.note(managedProject.assignedPhoneNumber, "Text your agent", {
        tone: "success",
      });
    const dashboardUrl = `https://app.photon.codes/dashboard/${managedProject.projectId}`;
    context.presentation.note(dashboardUrl, "Photon project", { tone: "success" });
    return {
      facts: [
        { label: "Photon project", value: dashboardUrl, kind: "url" as const },
        ...(managedProject.assignedPhoneNumber === undefined
          ? []
          : [
              {
                label: "Phone number",
                value: managedProject.assignedPhoneNumber,
                kind: "phone" as const,
              },
            ]),
      ],
      deploymentRequired: true as const,
    };
  } catch (error) {
    await managedProject.cleanup().catch(() => {});
    throw error;
  }
}
