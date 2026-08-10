import { join } from "node:path";

import { text } from "../../ask.js";
import { appendEnv } from "../../append-env.js";
import { provisionPhotonConnector } from "./connect.js";
import {
  findDedicatedPhotonLine,
  provisionPhotonProject,
  usePhotonProject,
  validatePhotonPhoneNumber,
  type PhotonManagedProject,
} from "./management.js";
import { openUrl } from "../../primitives/open-url.js";
import { deriveSlackConnectorSlug } from "../../scaffold/index.js";
import { writeTextFile } from "../../scaffold/files.js";
import { WizardCancelledError } from "../../step.js";
import type { IntegrationSetupEnvironment } from "../shared/environment.js";
import type { IntegrationSetupUi } from "../shared/ui.js";
import { ensureVercelProject } from "../../flows/ensure-vercel-project.js";

/** Inputs for Photon project provisioning and channel scaffolding. */
export interface PhotonSetupOptions {
  agentName: string;
  projectPath: string;
  environment: IntegrationSetupEnvironment;
  ui: IntegrationSetupUi;
  signal?: AbortSignal;
  force?: boolean;
  deps?: PhotonSetupDeps;
}

/** Outcome of Photon project provisioning and channel scaffolding. */
export type PhotonSetupResult =
  | { kind: "done"; assignedPhoneNumber?: string; dashboardUrl: string }
  | { kind: "cancelled" };

interface PhotonSetupPlan {
  credentials: "vercel-connect" | "environment";
  photonProject: "create" | { projectId: string; projectSecret: string };
  photonProjectName?: string;
}

export interface PhotonSetupDeps {
  appendEnv: typeof appendEnv;
  deriveConnectorSlug: typeof deriveSlackConnectorSlug;
  ensureVercelProject: typeof ensureVercelProject;
  findDedicatedLine: typeof findDedicatedPhotonLine;
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
  findDedicatedLine: findDedicatedPhotonLine,
  openUrl,
  provisionConnector: provisionPhotonConnector,
  provisionProject: provisionPhotonProject,
  useProject: usePhotonProject,
  writeTextFile,
};

const PORTABLE_TEMPLATE = `import { photonIMessageChannel } from "eve/channels/photon";

async function photonCredentials() {
  const projectId = process.env.IMESSAGE_PROJECT_ID;
  const projectSecret = process.env.IMESSAGE_PROJECT_SECRET;
  if (!projectId || !projectSecret) throw new Error("Photon project credentials are required.");
  return { projectId, projectSecret };
}

export default photonIMessageChannel({
  credentials: photonCredentials,
  webhookSecret: process.env.IMESSAGE_WEBHOOK_SECRET,
});
`;

function connectTemplate(connectorUid: string): string {
  return `import { connectPhotonCredentials } from "@vercel/connect/eve";
import { photonIMessageChannel } from "eve/channels/photon";

export default photonIMessageChannel({
  credentials: connectPhotonCredentials(${JSON.stringify(connectorUid)}),
});
`;
}

async function choosePhotonProject(
  options: PhotonSetupOptions,
): Promise<Pick<PhotonSetupPlan, "photonProject" | "photonProjectName">> {
  const defaultName = `eve · ${options.agentName || "agent"}`;
  const projectOptions = [
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
  const editable = options.ui.prompter.selectEditable
    ? await options.ui.prompter.selectEditable<"create" | "existing">({
        message: "Photon project",
        options: projectOptions,
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
    (await options.ui.prompter.select<"create" | "existing">({
      message: "Photon project",
      options: projectOptions,
      initialValue: "create",
    }));
  if (source === "existing") {
    const projectId = await options.ui.asker.ask(
      text({ key: "photon-project-id", message: "Photon project ID", required: true }),
    );
    const projectSecret = await options.ui.asker.ask(
      text({
        key: "photon-project-secret",
        message: "Photon project secret",
        required: true,
        sensitive: true,
        environment: "IMESSAGE_PROJECT_SECRET",
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
  options: PhotonSetupOptions,
): Promise<PhotonSetupPlan | "cancelled"> {
  try {
    const destination = await options.ui.prompter.select<"vercel" | "portable">({
      message: "How would you like to configure Photon?",
      options: [
        {
          value: "vercel",
          label: "Set up Vercel Connect",
          hint:
            options.environment.vercel.kind === "available"
              ? "Link this project and configure Photon automatically"
              : "Log in to Vercel and link this project",
        },
        {
          value: "portable",
          label: "Use portable credentials",
          hint: "Configure the Photon webhook manually after deployment",
        },
      ],
      initialValue: options.environment.vercel.kind === "available" ? "vercel" : "portable",
    });
    if (destination === "vercel" && options.environment.vercel.kind === "unavailable") {
      throw new Error(
        "Vercel Connect requires an authenticated Vercel CLI. Run `vercel login`, then retry Photon setup.",
      );
    }
    const photon = await choosePhotonProject(options);
    return { credentials: destination === "vercel" ? "vercel-connect" : "environment", ...photon };
  } catch (error) {
    if (error instanceof WizardCancelledError) return "cancelled";
    throw error;
  }
}

async function resolvePhotonProject(
  options: PhotonSetupOptions,
  plan: PhotonSetupPlan,
  phoneNumber: string | undefined,
  dedicatedLine: string | undefined,
  deps: PhotonSetupDeps,
): Promise<PhotonManagedProject> {
  if (plan.photonProject !== "create") {
    return deps.useProject({ ...plan.photonProject, dedicatedLine, phoneNumber });
  }
  if (phoneNumber === undefined) throw new Error("Photon phone number is required.");
  const spinner = options.ui.prompter.log.spinner?.("Waiting for Photon approval…", {
    kind: "external-action",
    emphasis: "browser",
  });
  try {
    return await deps.provisionProject({
      projectName: plan.photonProjectName ?? `eve · ${options.agentName || "agent"}`,
      phoneNumber,
      signal: options.signal,
      onAuthorization(authorization) {
        options.ui.prompter.log.message(`Authorize Photon: ${authorization.verificationUrl}`);
        options.ui.prompter.log.message(`Photon code: ${authorization.userCode}`);
        deps.openUrl(authorization.verificationUrl);
      },
    });
  } finally {
    spinner?.stop();
  }
}

async function scaffoldPhoton(
  options: PhotonSetupOptions,
  plan: PhotonSetupPlan,
  deps: PhotonSetupDeps,
): Promise<{ assignedPhoneNumber?: string; dashboardUrl: string }> {
  const dedicatedLine =
    plan.photonProject === "create" ? undefined : await deps.findDedicatedLine(plan.photonProject);
  const phoneNumber =
    plan.photonProject !== "create" && dedicatedLine !== undefined
      ? undefined
      : await options.ui.asker.ask(
          text({
            key: "photon-phone-number",
            message: "Your iMessage phone number",
            placeholder: "+15551234567",
            required: true,
            validate: validatePhotonPhoneNumber,
          }),
        );
  const projectRoot = options.projectPath;
  const managedProject = await resolvePhotonProject(
    options,
    plan,
    phoneNumber,
    dedicatedLine,
    deps,
  );
  try {
    const channelPath = join(projectRoot, "agent/channels/photon.ts");
    if (plan.credentials === "vercel-connect") {
      const slug = await deps.deriveConnectorSlug(projectRoot, options.agentName);
      const project = await deps.ensureVercelProject({
        appRoot: projectRoot,
        prompter: options.ui.prompter,
        signal: options.signal,
      });
      const connector = await deps.provisionConnector({
        credentials: managedProject,
        log: options.ui.prompter.log,
        project,
        projectRoot,
        slug,
        signal: options.signal,
      });
      await deps.writeTextFile(channelPath, connectTemplate(connector.uid), {
        force: options.force,
      });
    } else {
      await deps.appendEnv(join(projectRoot, ".env.local"), {
        IMESSAGE_PROJECT_ID: managedProject.projectId,
        IMESSAGE_PROJECT_SECRET: managedProject.projectSecret,
      });
      await deps.writeTextFile(channelPath, PORTABLE_TEMPLATE, { force: options.force });
      options.ui.nextSteps([
        "Deploy the agent, then create a Photon webhook pointing to https://<your-host>/eve/v1/photon.",
        "Copy the webhook signing secret into IMESSAGE_WEBHOOK_SECRET, alongside IMESSAGE_PROJECT_ID and IMESSAGE_PROJECT_SECRET, in your host's encrypted environment variables.",
      ]);
    }
    options.ui.prompter.log.success("Scaffolded channel: photon");
    if (managedProject.assignedPhoneNumber !== undefined) {
      options.ui.prompter.note(managedProject.assignedPhoneNumber, "Text your agent", {
        tone: "success",
      });
    }
    const dashboardUrl = `https://app.photon.codes/dashboard/${managedProject.projectId}`;
    options.ui.prompter.note(dashboardUrl, "Photon project", { tone: "success" });
    return managedProject.assignedPhoneNumber === undefined
      ? { dashboardUrl }
      : { assignedPhoneNumber: managedProject.assignedPhoneNumber, dashboardUrl };
  } catch (error) {
    await managedProject.cleanup().catch(() => {});
    throw error;
  }
}

/** Provisions a Photon project and scaffolds its iMessage channel. */
export async function setupPhoton(options: PhotonSetupOptions): Promise<PhotonSetupResult> {
  try {
    const plan = await chooseSetupPlan(options);
    if (plan === "cancelled") return { kind: "cancelled" };
    return { kind: "done", ...(await scaffoldPhoton(options, plan, options.deps ?? defaultDeps)) };
  } catch (error) {
    if (error instanceof WizardCancelledError) return { kind: "cancelled" };
    throw error;
  }
}
