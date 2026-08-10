import { phoneNumberOnlyUser } from "../user-simulator.js";
import type { AuthoringCase, GradeCheck } from "../types.js";
import { createPhotonWorld } from "../world/photon-world.js";

const PHONE_NUMBER = "+15551234567";

export const photonImessageCase: AuthoringCase = {
  id: "photon-imessage",
  prompt: "Let me talk to this agent via iMessage.",
  instructions: [
    "Work autonomously in the existing eve project.",
    "Use the installed, version-matched eve documentation and registry commands.",
    "Prefer non-interactive CLI commands intended for coding agents.",
    "Ask the user only for information that genuinely belongs to them.",
    "Do not invent credentials or claim an external action completed before the command confirms it.",
    "When finished, verify the project and give a concise deployment handoff.",
  ].join(" "),
  maximumUserTurns: 1,
  createUser: () => phoneNumberOnlyUser(PHONE_NUMBER),
  createWorld: () =>
    createPhotonWorld({
      phoneNumber: PHONE_NUMBER,
      assignedPhoneNumber: "+15550000000",
      projectId: "photon-project-id",
      projectSecret: "photon-project-secret",
    }),
  async grade({ sandbox, workspace, transcript, toolCalls, toolResults, worldEvents }) {
    const [channel, packageJson, typecheck] = await Promise.all([
      sandbox.readTextFile({ path: `${workspace}/agent/channels/photon.ts` }),
      sandbox.readTextFile({ path: `${workspace}/package.json` }),
      sandbox.run({
        command: "pnpm --config.minimumReleaseAge=0 typecheck",
        workingDirectory: workspace,
      }),
    ]);
    const bashCommands = toolCalls
      .filter((call) => call.name === "bash" || call.name.endsWith(":bash"))
      .map((call) =>
        typeof call.input === "object" && call.input !== null && "command" in call.input
          ? String(call.input.command)
          : "",
      )
      .join("\n");
    const event = (type: string) => worldEvents.some((candidate) => candidate.type === type);
    const addFailed = toolResults.some(
      (result) =>
        (result.name === "bash" || result.name.endsWith(":bash")) &&
        /Setup skipped|unknown option|non-interactive|requires eve|Try again|exited with code/i.test(
          stringify(result.output),
        ),
    );
    const checks: GradeCheck[] = [
      check(
        "channel-scaffolded",
        channel?.includes("photonIMessageChannel") === true,
        channel === null ? "agent/channels/photon.ts is missing" : "Photon channel source exists",
      ),
      check(
        "registry-item-installed",
        packageJson?.includes("@vercel/connect") === true,
        "package.json includes the Photon registry dependency",
      ),
      check(
        "non-interactive-path",
        /eve\s+add\s+channel\/photon-imessage[^\n]*(--non-interactive|--json)/i.test(bashCommands),
        "subject used the coding-agent setup path",
      ),
      check(
        "minimal-user-interaction",
        transcript.filter((turn) => turn.role === "user").length <= 2,
        "at most one simulated follow-up was needed",
      ),
      check(
        "photon-authorization",
        addFailed || (event("photon.authorization.requested") && event("browser.open")),
        addFailed
          ? "not reached because the setup command failed (reported separately)"
          : "Photon device authorization was surfaced through the browser boundary",
      ),
      check(
        "photon-provisioned",
        addFailed || (event("photon.project.created") && event("photon.phone.registered")),
        addFailed
          ? "not reached because the setup command failed (reported separately)"
          : "Photon project and phone registration completed",
      ),
      check(
        "vercel-connect-provisioned",
        addFailed ||
          worldEvents.some(
            (candidate) =>
              candidate.type === "vercel.command" &&
              Array.isArray(candidate.data?.args) &&
              candidate.data.args[0] === "connect",
          ),
        addFailed
          ? "not reached because the setup command failed (reported separately)"
          : "Vercel Connect provisioning was attempted",
      ),
      check(
        "setup-command-succeeded",
        !addFailed,
        addFailed
          ? "eve add did not complete; inspect the recorded bash tool result"
          : "eve add completed without a recognized setup failure",
      ),
      check(
        "typecheck",
        typecheck.exitCode === 0,
        typecheck.exitCode === 0 ? "pnpm typecheck passed" : typecheck.stderr || typecheck.stdout,
      ),
      check(
        "deployment-handoff",
        /deploy|deployment|vercel/i.test(transcript.at(-1)?.text ?? ""),
        "final response recommends the next deployment step",
      ),
    ];
    return { passed: checks.every((candidate) => candidate.passed), checks };
  },
};

function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function check(id: string, passed: boolean, detail: string): GradeCheck {
  return { id, passed, detail };
}
