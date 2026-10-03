import { githubChannel } from "#public/channels/github/index.js";
import { signGitHubWebhookBody } from "#public/channels/github/verify.js";
import {
  type ChannelDriver,
  type PlatformCall,
  type RenderedOption,
  recordingFetch,
} from "#internal/testing/channel-conformance/harness.js";

const SECRET = "github-conformance-secret";
let nextConversation = 0;

/** Drives GitHub issue comments through the signed App webhook route. */
export function githubDriver(): ChannelDriver {
  // Repository and issue identities are the continuation key, so isolate each driver instance.
  nextConversation += 1;
  const repositoryId = 10_000 + nextConversation;
  const issueNumber = 100 + nextConversation;
  let delivery = 0;
  let commentId = 0;

  function message(text: string): Request {
    delivery += 1;
    commentId += 1;
    const payload = {
      action: "created",
      comment: {
        body: `@testbot ${text}`,
        id: commentId,
        user: { id: 1, login: "octocat", type: "User" },
      },
      installation: { id: 55 },
      issue: { number: issueNumber },
      repository: {
        full_name: "vercel/eve",
        id: repositoryId,
        name: "eve",
        owner: { login: "vercel" },
      },
      sender: { id: 1, login: "octocat", type: "User" },
    };
    const body = JSON.stringify(payload);
    return new Request("https://agent.example.com/eve/v1/github", {
      body,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": `github-conformance-${delivery}`,
        "x-github-event": "issue_comment",
        "x-hub-signature-256": signGitHubWebhookBody(body, SECRET),
      },
      method: "POST",
    });
  }

  async function decode(request: Request): Promise<PlatformCall> {
    const bodyText = await request.text();
    return {
      body: bodyText === "" ? {} : JSON.parse(bodyText),
      method: new URL(request.url).pathname,
      response: { id: 50_000 + commentId },
    };
  }

  return {
    name: "github",
    capabilities: ["text-replies"],
    createChannel: (record) =>
      githubChannel({
        api: { fetch: recordingFetch(record, decode) },
        botName: "testbot",
        credentials: { installationToken: "ghs_test", webhookSecret: SECRET },
        progress: { reactions: false },
      }),
    message,
    findOptions(call, prompt) {
      if (!call.method.endsWith(`/issues/${issueNumber}/comments`)) return undefined;
      const body = call.body as { readonly body?: string };
      if (body.body?.includes(prompt) !== true) return undefined;
      return [...(body.body.matchAll(/^\s*(\d+)\.\s*(.+?)\s*$/gmu) ?? [])].map((match) => ({
        handle: match[1],
        label: match[2]!.split(" - ", 1)[0]!,
      })) satisfies RenderedOption[];
    },
    press: () => {
      throw new Error("GitHub does not support pressing rendered options.");
    },
    postedText: (call) => {
      if (!call.method.endsWith(`/issues/${issueNumber}/comments`)) return undefined;
      return (call.body as { readonly body?: string }).body;
    },
  };
}
