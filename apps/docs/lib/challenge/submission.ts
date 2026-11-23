export const challengeHashtag = "#eveAgentShowcase";
export const eveOnX = "https://x.com/eve";
export const descriptionLimit = 100;

type Submission = { repository: string; description: string; video: string };

export interface SubmissionPreview {
  summary: string;
  repository: string;
  video: string;
  media: { kind: "github"; path: string } | { kind: "youtube"; id: string } | null;
}

function httpsUrl(value: string) {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password && !url.port ? url : null;
  } catch {
    return null;
  }
}

function repositoryPath(value: string) {
  const url = httpsUrl(value);
  if (!url || url.hostname !== "github.com") return null;
  const path = url.pathname.replace(/\/$/, "").replace(/\.git$/, "");
  return /^\/[\w-]+\/[\w.-]+$/.test(path) ? path : null;
}

function youtubeId(value: string) {
  const url = httpsUrl(value);
  if (!url) return null;
  let id: string | null | undefined;
  if (url.hostname === "youtu.be") {
    id = /^\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  } else if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname)) {
    id =
      url.pathname === "/watch"
        ? url.searchParams.get("v")
        : /^\/(?:shorts|live)\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

export function buildSubmission({ repository, description, video }: Submission) {
  const repo = repositoryPath(repository);
  const demo = youtubeId(video);
  const summary = description.trim();
  const preview: SubmissionPreview = {
    summary: summary || "What your agent does goes here.",
    repository: repo
      ? `https://github.com${repo}`
      : repository.trim() || "https://github.com/you/your-agent",
    video: demo ? `https://youtu.be/${demo}` : video.trim(),
    media: demo ? { kind: "youtube", id: demo } : repo ? { kind: "github", path: repo } : null,
  };
  const errors: Partial<Record<keyof Submission, string>> = {};
  if (!repo)
    errors.repository = "Enter a GitHub repository URL, such as https://github.com/you/your-agent.";
  if (!summary || summary.length > descriptionLimit)
    errors.description = `Describe your agent in 1–${descriptionLimit} characters.`;
  if (video.trim() && !demo) errors.video = "Enter a YouTube video link or leave this field blank.";

  const text = [
    preview.summary,
    "",
    preview.repository,
    ...(preview.video ? [preview.video] : []),
    "",
    challengeHashtag,
  ].join("\n");
  const intent = Object.keys(errors).length
    ? null
    : `https://x.com/intent/tweet?${new URLSearchParams({ text })}`;
  return { preview, errors, intent };
}
