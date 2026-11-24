"use client";

import { ArrowUpRight, Play, UserRound } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { type SubmissionPreview, showcasePostLine } from "@/lib/challenge/submission";

export function PostPreview({ preview }: { preview: SubmissionPreview }) {
  const { summary, repository, video, media } = preview;

  return (
    <article
      aria-label="X post preview"
      className="min-w-0 rounded-2xl border border-gray-400 bg-background-100 p-4 text-gray-1000 sm:p-5"
    >
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="grid size-10 shrink-0 place-items-center rounded-full bg-gray-200 text-gray-900"
        >
          <UserRound size={20} />
        </span>
        <div className="min-w-0 text-copy-14">
          <div className="font-semibold">Your name</div>
          <div className="text-gray-900">@yourhandle</div>
        </div>
        <span aria-hidden className="ml-auto self-start text-xl">
          𝕏
        </span>
      </div>
      <div className="mt-3 text-[15px] leading-5 [overflow-wrap:anywhere]">
        <p className="whitespace-pre-wrap">{summary}</p>
        <p className="mt-5">{showcasePostLine}</p>
        <div className="mt-5 text-blue-900">
          <p>{repository}</p>
          {video && <p>{video}</p>}
        </div>
      </div>
      {media?.kind === "youtube" && <VideoCard id={media.id} key={media.id} />}
      {media?.kind === "github" && <RepositoryCard path={media.path} key={media.path} />}
    </article>
  );
}

function VideoCard({ id }: { id: string }) {
  const [playing, setPlaying] = useState(false);
  const player = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    if (playing) player.current?.focus();
  }, [playing]);
  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-gray-400">
      <div className="relative aspect-video min-h-[200px] bg-[#101010]">
        {playing ? (
          <iframe
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
            className="absolute inset-0 size-full border-0"
            ref={player}
            referrerPolicy="strict-origin-when-cross-origin"
            src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1`}
            title="Submitted YouTube demo"
          />
        ) : (
          <button
            aria-label="Play YouTube demo"
            className="group absolute inset-0 grid size-full cursor-pointer place-items-center focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-white"
            onClick={() => setPlaying(true)}
            type="button"
          >
            <PreviewImage
              className="absolute inset-0 size-full object-cover"
              src={`https://i.ytimg.com/vi/${id}/hqdefault.jpg`}
            />
            <span className="relative grid size-12 place-items-center rounded-full bg-black/80 text-white group-hover:bg-black">
              <Play aria-hidden fill="currentColor" size={20} />
            </span>
          </button>
        )}
      </div>
      <CardLink href={`https://youtu.be/${id}`}>Watch on YouTube</CardLink>
    </div>
  );
}

function RepositoryCard({ path }: { path: string }) {
  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-gray-400">
      <PreviewImage className="h-auto w-full" src={`https://opengraph.githubassets.com/0${path}`} />
      <CardLink href={`https://github.com${path}`}>{path.slice(1)}</CardLink>
    </div>
  );
}

function PreviewImage({ className, src }: { className: string; src: string }) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setReady(true), 300);
    return () => window.clearTimeout(timer);
  }, []);

  if (!ready || failed) return null;
  return (
    <Image
      alt=""
      className={className}
      height={630}
      onError={() => setFailed(true)}
      referrerPolicy="no-referrer"
      src={src}
      unoptimized
      width={1200}
    />
  );
}

function CardLink({ children, href }: { children: string; href: string }) {
  return (
    <a
      className="flex items-center justify-between gap-2 px-3 py-2.5 text-copy-13 text-gray-900 underline-offset-4 hover:underline"
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      <span className="[overflow-wrap:anywhere]">
        {children}
        <span className="sr-only"> (opens in a new tab)</span>
      </span>
      <ArrowUpRight aria-hidden className="shrink-0" size={14} />
    </a>
  );
}
