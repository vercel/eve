"use client";

import { ArrowUpRight } from "lucide-react";
import { type FormEvent, useState } from "react";
import { buildSubmission, challengeHashtag, descriptionLimit } from "@/lib/challenge/submission";
import { PostPreview } from "./post-preview";

const field =
  "mt-2 w-full rounded-lg border border-gray-400 bg-background-100 px-3 py-2.5 text-base text-gray-1000 outline-none placeholder:text-gray-700 focus:border-gray-900 focus:ring-1 focus:ring-gray-900 aria-invalid:border-red-800";

export function PostBuilder() {
  const [repository, setRepository] = useState("");
  const [description, setDescription] = useState("");
  const [video, setVideo] = useState("");
  const [attempted, setAttempted] = useState(false);
  const { preview, errors, intent } = buildSubmission({ repository, description, video });
  const repoError = attempted && errors.repository;
  const descriptionError = attempted && errors.description;
  const videoError = attempted && errors.video;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (intent) {
      window.open(intent, "_blank", "noopener,noreferrer");
      return;
    }
    setAttempted(true);
    const firstInvalidField = Object.keys(errors)[0];
    if (firstInvalidField) document.getElementById(`challenge-${firstInvalidField}`)?.focus();
  }

  return (
    <div className="overflow-hidden rounded-xl border border-gray-400 bg-background-100 @min-[41rem]:grid @min-[41rem]:grid-cols-[1.1fr_1fr]">
      <form className="flex min-w-0 flex-col gap-5 p-5 sm:p-6" noValidate onSubmit={submit}>
        <div>
          <label
            className="text-label-14 font-medium text-gray-1000"
            htmlFor="challenge-repository"
          >
            Code Repository URL
          </label>
          <input
            aria-describedby={repoError ? "challenge-repository-error" : undefined}
            aria-invalid={Boolean(repoError)}
            className={field}
            id="challenge-repository"
            maxLength={512}
            onChange={(event) => setRepository(event.target.value)}
            placeholder="https://github.com/you/your-agent"
            required
            type="url"
            value={repository}
          />
          {repoError && <FieldError id="challenge-repository-error">{repoError}</FieldError>}
        </div>
        <div>
          <div className="flex flex-wrap items-baseline justify-between gap-x-2">
            <label
              className="text-label-14 font-medium text-gray-1000"
              htmlFor="challenge-description"
            >
              Description
            </label>
            <span
              className="text-copy-13 text-gray-900 tabular-nums"
              id="challenge-description-count"
            >
              {description.length} / {descriptionLimit}
            </span>
          </div>
          <textarea
            aria-describedby={`challenge-description-count${descriptionError ? " challenge-description-error" : ""}`}
            aria-invalid={Boolean(descriptionError)}
            className={`${field} block min-h-24 resize-y`}
            id="challenge-description"
            maxLength={descriptionLimit}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="I built an eve extension that turns Slack threads into weekly team updates."
            required
            rows={3}
            value={description}
          />
          {descriptionError && (
            <FieldError id="challenge-description-error">{descriptionError}</FieldError>
          )}
        </div>
        <div>
          <label className="text-label-14 font-medium text-gray-1000" htmlFor="challenge-video">
            YouTube Video <span className="ml-1 font-normal text-gray-900">(optional)</span>
          </label>
          <input
            aria-describedby={videoError ? "challenge-video-error" : "challenge-video-tip"}
            aria-invalid={Boolean(videoError)}
            className={field}
            id="challenge-video"
            maxLength={512}
            onChange={(event) => setVideo(event.target.value)}
            placeholder="https://youtu.be/…"
            type="url"
            value={video}
          />
          {videoError ? (
            <FieldError id="challenge-video-error">{videoError}</FieldError>
          ) : (
            <p className="mt-2 text-copy-13 text-gray-900" id="challenge-video-tip">
              Entries with a demo video get priority in review.
            </p>
          )}
        </div>
        <button
          className="inline-flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-gray-1000 px-4 text-label-14 font-medium text-background-100 hover:bg-gray-900 sm:w-fit"
          type="submit"
        >
          Open Draft <span className="sr-only">on X (opens in a new tab)</span>
          <ArrowUpRight aria-hidden size={16} />
        </button>
        <noscript>
          Enable JavaScript to open a draft, or write a post directly on X with {challengeHashtag}.
        </noscript>
      </form>
      <div className="flex min-w-0 flex-col gap-4 border-t border-gray-400 bg-background-200 p-5 @min-[41rem]:border-t-0 @min-[41rem]:border-l sm:p-6">
        <h4 className="text-heading-16 text-gray-1000">Post preview</h4>
        <PostPreview preview={preview} />
        {preview.media && (
          <p className="text-copy-13 text-gray-900">
            X may show a different link card on your published post.
          </p>
        )}
      </div>
    </div>
  );
}

function FieldError({ children, id }: { children: string; id: string }) {
  return (
    <p className="mt-2 text-copy-13 text-red-900" id={id} role="alert">
      {children}
    </p>
  );
}
