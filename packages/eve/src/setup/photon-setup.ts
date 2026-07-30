import { join } from "node:path";

import { text } from "./ask.js";
import { appendEnv } from "./append-env.js";
import type { PhotonSetupIntegration } from "./photon-setup-integration.js";
import { provisionPhotonConnector } from "./photon-connect.js";
import {
  provisionPhotonProject,
  usePhotonProject,
  validatePhotonPhoneNumber,
  type PhotonManagedProject,
} from "./photon-management.js";
import { openUrl } from "./primitives/open-url.js";
import { deriveSlackConnectorSlug } from "./scaffold/index.js";
import { writeTextFile } from "./scaffold/files.js";
import { WizardCancelledError } from "./step.js";
import { ensureVercelProject } from "./flows/ensure-vercel-project.js";

interface PhotonSetupPlan {
  credentials: "vercel-connect" | "environment";
  photonProject: "create" | { projectId: string; projectSecret: string };
  photonProjectName?: string;
}

export interface PhotonSetupDeps {
  appendEnv: typeof appendEnv;
  deriveConnectorSlug: typeof deriveSlackConnectorSlug;
  ensureVercelProject: typeof ensureVercelProject;
  openUrl: typeof openUrl;
  provisionConnector: typeof provisionPhotonConnector;
  provisionProject: typeof provisionPhotonProject;
  useProject: typeof usePhotonProject;
  writeTextFile: typeof writeTextFile;
}

const defaultDeps: PhotonSetupDeps = {
  appendEnv,
  deriveConnectorSlug: deriveSlackConnectorSlug,
  ensureVercelProject,
  openUrl,
  provisionConnector: provisionPhotonConnector,
  provisionProject: provisionPhotonProject,
  useProject: usePhotonProject,
  writeTextFile,
};

const PORTABLE_TEMPLATE = `import { photonChannel } from "eve/channels/photon";

async function photonCredentials() {
  const projectId = process.env.IMESSAGE_PROJECT_ID;
  const projectSecret = process.env.IMESSAGE_PROJECT_SECRET;
  if (!projectId || !projectSecret) throw new Error("Photon project credentials are required.");
  return { projectId, projectSecret };
}

export default photonChannel({
  credentials: photonCredentials,
  webhookSecret: process.env.IMESSAGE_WEBHOOK_SECRET,
});
`;

function connectTemplate(connectorUid: string): string {
  return `import { connectPhotonCredentials } from "@vercel/connect/eve";
import { photonChannel } from "eve/channels/photon";

export default photonChannel({
  credentials: connectPhotonCredentials(${JSON.stringify(connectorUid)}),
});
`;
}

async function choosePhotonProject(
  context: Parameters<PhotonSetupIntegration["setup"]>[0],
): Promise<Pick<PhotonSetupPlan, "photonProject" | "photonProjectName">> {
  const defaultName = `eve · ${context.state.agentName || "agent"}`;
  const options = [
    {
      value: "create" as const,
      label: "Create a new Photon project",
      hint: `Name: ${defaultName}`,
    },
    {
      value: "existing" as const,
      label: "Use an existing Photon project",
      hint: "Enter its project credentials",
    },
  ];
  const editable = context.ui.prompter.selectEditable
    ? await context.ui.prompter.selectEditable<"create" | "existing">({
        message: "Photon project",
        options,
        initialValue: "create",
        editable: {
          value: "create",
          defaultValue: defaultName,
          formatHint: (value) => `Name: ${value}`,
          validate: (value) =>
            value.trim().length === 0 ? "Project name cannot be empty." : undefined,
        },
      })
    : undefined;
  const source =
    editable?.value ??
    (await context.ui.prompter.select<"create" | "existing">({
      message: "Photon project",
      options,
      initialValue: "create",
    }));
  if (source === "existing") {
    const projectId = await context.ui.asker.ask(
      text({ key: "photon-project-id", message: "Photon project ID", required: true }),
    );
    const projectSecret = await context.ui.asker.ask(
      text({
        key: "photon-project-secret",
        message: "Photon project secret",
        required: true,
        sensitive: true,
      }),
    );
    return { photonProject: { projectId: projectId.trim(), projectSecret: projectSecret.trim() } };
  }

  return {
    photonProject: "create",
    photonProjectName: editable?.kind === "edited" ? editable.text.trim() : defaultName,
  };
}

async function chooseSetupPlan(
  context: Parameters<PhotonSetupIntegration["setup"]>[0],
): Promise<PhotonSetupPlan | "cancelled"> {
  try {
    const destination = await context.ui.prompter.select<"vercel" | "portable">({
      message: "How would you like to configure Photon?",
      options: [
        {
          value: "vercel",
          label: "Set up Vercel Connect",
          hint:
            context.environment.vercel.kind === "available"
              ? "Link this project and configure Photon automatically"
              : "Log in to Vercel and link this project",
        },
        {
          value: "portable",
          label: "Use portable credentials",
          hint: "Configure the Photon webhook manually after deployment",
        },
      ],
      initialValue: context.environment.vercel.kind === "available" ? "vercel" : "portable",
    });
    if (destination === "vercel" && context.environment.vercel.kind === "unavailable") {
      throw new Error(
        "Vercel Connect requires an authenticated Vercel CLI. Run `vercel login`, then retry Photon setup.",
      );
    }
    const photon = await choosePhotonProject(context);
    return { credentials: destination === "vercel" ? "vercel-connect" : "environment", ...photon };
  } catch (error) {
    if (error instanceof WizardCancelledError) return "cancelled";
    throw error;
  }
}

async function resolvePhotonProject(
  context: Parameters<PhotonSetupIntegration["setup"]>[0],
  plan: PhotonSetupPlan,
  phoneNumber: string,
  deps: PhotonSetupDeps,
): Promise<PhotonManagedProject> {
  if (plan.photonProject !== "create") {
    return deps.useProject({ ...plan.photonProject, phoneNumber });
  }
  const spinner = context.ui.prompter.log.spinner?.("Waiting for Photon approval…", {
    kind: "external-action",
    emphasis: "browser",
  });
  try {
    return await deps.provisionProject({
      projectName: plan.photonProjectName ?? `eve · ${context.state.agentName || "agent"}`,
      phoneNumber,
      signal: context.signal,
      onAuthorization(authorization) {
        context.ui.prompter.log.message(`Authorize Photon: ${authorization.verificationUrl}`);
        context.ui.prompter.log.message(`Photon code: ${authorization.userCode}`);
        deps.openUrl(authorization.verificationUrl);
      },
    });
  } finally {
    spinner?.stop();
  }
}

async function setupPhoton(
  context: Parameters<PhotonSetupIntegration["setup"]>[0],
  plan: PhotonSetupPlan,
  deps: PhotonSetupDeps,
): Promise<{ assignedPhoneNumber?: string; dashboardUrl: string }> {
  const phoneNumber = await context.ui.asker.ask(
    text({
      key: "photon-phone-number",
      message: "Your iMessage phone number",
      placeholder: "+15551234567",
      required: true,
      validate: validatePhotonPhoneNumber,
    }),
  );
  const projectRoot = context.state.projectPath;
  const managedProject = await resolvePhotonProject(context, plan, phoneNumber, deps);
  try {
    const channelPath = join(projectRoot, "agent/channels/photon.ts");
    if (plan.credentials === "vercel-connect") {
      const slug = await deps.deriveConnectorSlug(projectRoot, context.state.agentName);
      const project = await deps.ensureVercelProject({
        appRoot: projectRoot,
        prompter: context.ui.prompter,
        signal: context.signal,
      });
      const connector = await deps.provisionConnector({
        credentials: managedProject,
        log: context.ui.prompter.log,
        project,
        projectRoot,
        slug,
        signal: context.signal,
      });
      await deps.writeTextFile(channelPath, connectTemplate(connector.uid), {
        force: context.force,
      });
    } else {
      await deps.appendEnv(join(projectRoot, ".env.local"), {
        IMESSAGE_PROJECT_ID: managedProject.projectId,
        IMESSAGE_PROJECT_SECRET: managedProject.projectSecret,
      });
      await deps.writeTextFile(channelPath, PORTABLE_TEMPLATE, { force: context.force });
      context.ui.nextSteps([
        "Deploy the agent, then create a Photon webhook pointing to https://<your-host>/eve/v1/photon.",
        "Copy the webhook signing secret into IMESSAGE_WEBHOOK_SECRET, alongside IMESSAGE_PROJECT_ID and IMESSAGE_PROJECT_SECRET, in your host's encrypted environment variables.",
      ]);
    }
    context.ui.prompter.log.success("Scaffolded channel: photon");
    if (managedProject.assignedPhoneNumber !== undefined) {
      context.ui.prompter.note(managedProject.assignedPhoneNumber, "Text your agent", {
        tone: "success",
      });
    }
    const dashboardUrl = `https://app.photon.codes/dashboard/${managedProject.projectId}`;
    context.ui.prompter.note(dashboardUrl, "Photon project", { tone: "success" });
    return managedProject.assignedPhoneNumber === undefined
      ? { dashboardUrl }
      : { assignedPhoneNumber: managedProject.assignedPhoneNumber, dashboardUrl };
  } catch (error) {
    await managedProject.cleanup().catch(() => {});
    throw error;
  }
}

/** Photon-managed project provisioning and channel scaffolding. */
export const PHOTON_CHANNEL_SETUP: PhotonSetupIntegration = {
  kind: "photon",
  label: "Photon",
  hint: "Messages through Photon",
  async setup(context) {
    try {
      const plan = await chooseSetupPlan(context);
      if (plan === "cancelled") return { kind: "cancelled" };
      const result = await setupPhoton(context, plan, context.photonDeps ?? defaultDeps);
      return {
        kind: "done",
        state: context.state,
        ...result,
      };
    } catch (error) {
      if (error instanceof WizardCancelledError) return { kind: "cancelled" };
      throw error;
    }
  },
};
