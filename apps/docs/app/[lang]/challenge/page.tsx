import { ArrowRight, ArrowUpRight, Plus } from "lucide-react";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { eveOnX } from "@/lib/challenge/submission";
import { canonicalAlternates } from "@/lib/geistdocs/canonical";
import { pageTitleMetadata } from "@/lib/geistdocs/metadata-title";
import { templateGalleryUrl } from "@/lib/templates/links";
import styles from "./challenge.module.css";
import {
  challengeDeadline,
  challengeHeadline,
  challengeTitle,
  winnerCount,
} from "./challenge-details";
import { GlyphField } from "./glyph-field";
import { HarnessLoop } from "./harness-loop-view";
import { PostBuilder } from "./post-builder";

const credits = "$100 in Vercel AI Gateway credits";
const swag = "limited-edition eve swag";
const prizes = `${credits} and ${swag}`;
const buildLead = "Build an agent with eve.";
const description = `${buildLead} Submit your project for a chance to win ${prizes}.`;
const title = pageTitleMetadata(challengeTitle);

export const metadata: Metadata = {
  ...title,
  description,
  alternates: canonicalAlternates("/challenge"),
  openGraph: { ...title.openGraph, description, url: "/challenge" },
  twitter: { ...title.twitter, description, card: "summary_large_image" },
};

const briefValue = "text-pretty text-heading-16 text-gray-1000 sm:text-heading-20";
const brief = [
  [
    "Prizes",
    <>
      <span className={briefValue}>{credits}</span>
      <span className="block pt-1 text-copy-14 text-gray-900">Plus {swag}</span>
    </>,
  ],
  ["Winners", <span className={briefValue}>{winnerCount}</span>],
  [
    "Judging",
    <ul className="space-y-1 text-copy-14 text-gray-900 sm:text-copy-16" role="list">
      <li>Technical complexity</li>
      <li>Usefulness</li>
      <li>Creativity</li>
    </ul>,
  ],
  ["Deadline", <span className={briefValue}>{challengeDeadline}</span>],
] as const;

const steps = [
  {
    id: "what-to-build",
    title: "What to build",
    detail:
      "Pick a task and build an agent that can do it. For example, turn Slack threads into a weekly brief or give someone a voice interface to ask questions. You can also build an extension, integration, or app with eve. Publish your code in a public repository.",
  },
  {
    id: "demo",
    title: "Record a demo",
    detail:
      "Optionally showcase your project by recording a quick video. Projects with a video will be prioritized in judging.",
  },
  {
    id: "submit",
    title: "Submit your project",
    detail: (
      <>
        Follow and tag{" "}
        <a className="font-medium text-gray-1000 underline underline-offset-4" href={eveOnX}>
          @eve on X
        </a>
        . Mention the {challengeHeadline} in your public post.
      </>
    ),
  },
];

const templates = [
  {
    title: "Voice Agent",
    description: "Talk to your agent in the browser and follow along with a live transcript.",
    slug: "eve-voice-template",
    image:
      "https://images.ctfassets.net/e5382hct74si/2ooTuMfoAv4ufxRV9i6eL2/b9c363aa8d99f07d4ffd4972b6a61814/eve-voice-agent-3x.png",
  },
  {
    title: "eve Web Chat",
    description:
      "Give your agent a browser chat interface with streaming replies and tool activity.",
    slug: "eve-chat-template",
    image:
      "https://images.ctfassets.net/e5382hct74si/2nvBUG8fflDbjQEc6ZsFS/e0545d7ee60b274a92e4392b4017c06d/eve-chat-template-3x.png",
  },
  {
    title: "eve Coding Agent",
    description:
      "Ask your agent from Slack or GitHub to investigate an issue, review a change, or open a pull request.",
    slug: "eve-coding-agent-template",
    image:
      "https://images.ctfassets.net/e5382hct74si/17McJixTRhRSTxuY608S7W/a999a2326b936e67fdd9e41c81879aa5/eve-coding-agent-3x.png",
  },
] as const;

const faqs = [
  [
    "What counts as an entry?",
    `Any project built with the eve framework counts, including agents, extensions, integrations, and applications. Follow @eve on X, then publish a public post that tags @eve and mentions the ${challengeHeadline}. Include a short description of your project and a link to its public code repository.`,
  ],
  [
    "Do I need to record a video?",
    "No. However, if you include a YouTube demo the eve team can watch, your entry gets priority in review. Show what your project does and how it works.",
  ],
  [
    "How are winners chosen?",
    "The eve team will be reviewing entries and taking into consideration technical complexity, usefulness, and creativity.",
  ],
  [
    "How will winners hear from the eve team?",
    "The eve team will follow up with winners on X with details.",
  ],
  ["What do winners receive?", `Each winner will receive ${prizes}.`],
  [
    "Where can I get help?",
    <>
      The eve team is happy to help. Tag{" "}
      <a className="font-medium text-gray-1000 underline underline-offset-4" href={eveOnX}>
        @eve on X
      </a>
      , or start a discussion in the{" "}
      <a
        className="font-medium text-gray-1000 underline underline-offset-4"
        href="https://github.com/vercel/eve/discussions"
      >
        vercel/eve GitHub repository
      </a>
      .
    </>,
  ],
] as const;

const container = "mx-auto w-full min-w-0 max-w-[80rem] px-4 sm:px-8";
const heading = "text-balance text-heading-32 text-gray-1000 sm:text-heading-40";
const primaryAction =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-gray-1000 px-4 text-label-14 font-medium text-background-100 hover:bg-gray-900";
const secondaryAction =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-gray-400 bg-background-100 px-4 text-label-14 font-medium text-gray-1000 hover:bg-gray-100";

export default function ChallengePage() {
  return (
    <main className="w-full min-w-0 pb-24">
      <section aria-labelledby="challenge-title" className={styles.hero}>
        <GlyphField
          brightness={0.1}
          className={styles.backdrop}
          clearing={{ x: 0.2, y: 0.24, radiusX: 0.34, radiusY: 0.3 }}
          columns={96}
          density={0.16}
          fit="meet"
          rows={90}
          seed={7}
        />
        <div
          className={`${container} relative grid items-center pt-6 pb-10 sm:pt-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-16 lg:pt-28 lg:pb-20`}
        >
          <div className="mx-auto w-full min-w-0 max-w-[36rem] lg:col-start-2 lg:row-start-1 lg:max-w-none">
            <HarnessLoop />
          </div>
          <div className="relative -mt-8 min-w-0 sm:-mt-12 lg:col-start-1 lg:row-start-1 lg:mt-0">
            <h1
              className="max-w-[11ch] text-balance text-heading-48 text-gray-1000 sm:text-heading-56 lg:mt-4 xl:text-heading-64"
              id="challenge-title"
            >
              <span className="sr-only">eve </span>
              {challengeHeadline}
            </h1>
            <p className="mt-5 max-w-[36rem] text-pretty text-copy-18 text-gray-900">
              {buildLead} Give it a real task to do. Agents, extensions, integrations, and apps
              built with eve are all welcome.
            </p>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row">
              <a className={primaryAction} href="#submit">
                Submit your project
              </a>
              <a className={secondaryAction} href="#what-to-build">
                What to build <ArrowRight aria-hidden size={16} />
              </a>
            </div>
          </div>
        </div>
        <div className="relative bg-background-200">
          <dl
            className={`${container} grid divide-y divide-gray-400 border-t border-gray-400 sm:grid-cols-2 sm:gap-x-8 sm:divide-y-0 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,0.5fr)_minmax(0,1fr)_minmax(0,0.9fr)]`}
          >
            {brief.map(([term, value]) => (
              <div
                className="grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] items-baseline gap-x-3 py-4 sm:block sm:py-5 lg:py-7"
                key={term}
              >
                <dt className="text-heading-16 text-gray-1000">{term}</dt>
                <dd className="min-w-0 sm:mt-2">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section aria-labelledby="how-to-enter" className={`${container} py-16 sm:py-24`}>
        <h2 className={heading} id="how-to-enter">
          How to enter
        </h2>
        <p className="mt-3 text-pretty text-copy-16 text-gray-900">
          Submit before {challengeDeadline}. The eve team will monitor public posts on X that tag
          @eve and mention the {challengeHeadline}.
        </p>
        <ol className="mt-10 border-t border-gray-400">
          {steps.map((step, index) => (
            <li
              className="grid scroll-mt-24 gap-x-6 gap-y-3 border-b border-gray-400 py-7 sm:grid-cols-[3rem_minmax(0,1fr)] lg:grid-cols-[3rem_minmax(0,18rem)_minmax(0,1fr)] lg:gap-x-10"
              id={step.id}
              key={step.id}
            >
              <span aria-hidden="true" className="font-mono text-copy-14 text-gray-900">
                {index + 1}
              </span>
              <h3 className="text-heading-24 text-gray-1000">{step.title}</h3>
              <div className="max-w-[62ch] min-w-0 text-pretty text-copy-16 text-gray-900 sm:col-start-2 lg:col-start-3">
                <p>{step.detail}</p>
                {step.id === "what-to-build" && (
                  <p className="mt-3">
                    <a
                      className="font-medium text-gray-1000 underline underline-offset-4"
                      href="#inspiration"
                    >
                      Explore example projects
                    </a>{" "}
                    or{" "}
                    <Link
                      className="font-medium text-gray-1000 underline underline-offset-4"
                      href="/docs/getting-started#create-a-project"
                      prefetch={true}
                    >
                      create your first eve project
                    </Link>
                    .
                  </p>
                )}
              </div>
              {step.id === "submit" && (
                <div className="@container mx-auto mt-6 w-full max-w-[60rem] sm:col-span-full">
                  <PostBuilder />
                </div>
              )}
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="inspiration" className={`${container} pb-16 sm:pb-24`}>
        <h2 className={heading} id="inspiration">
          Looking for inspiration?
        </h2>
        <p className="mt-3 text-pretty text-copy-16 text-gray-900">
          Start with one of these eve templates and make it your own.
        </p>
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {templates.map(({ title, description, slug, image }) => (
            <article
              className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-gray-400 bg-background-100"
              key={title}
            >
              <Image
                alt={`${title} template preview`}
                className="aspect-[1200/630] w-full border-b border-gray-400 object-cover"
                height={630}
                sizes="(min-width: 768px) 33vw, 100vw"
                src={image}
                width={1200}
              />
              <div className="flex flex-1 flex-col p-5 lg:p-6">
                <h3 className="text-heading-20 text-gray-1000">{title}</h3>
                <p className="mt-2 mb-5 text-pretty text-copy-14 text-gray-900">{description}</p>
                <a
                  aria-label={`View the ${title} template`}
                  className="mt-auto inline-flex items-center gap-1.5 self-start text-label-14 font-medium text-gray-1000 underline-offset-4 hover:underline"
                  href={`${templateGalleryUrl}/${slug}`}
                >
                  View template <ArrowUpRight aria-hidden size={14} />
                </a>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section aria-labelledby="faq" className={container}>
        <h2 className={heading} id="faq">
          FAQs
        </h2>
        <div className="mt-8 divide-y divide-gray-400 border-y border-gray-400">
          {faqs.map(([question, answer]) => (
            <details className="group" key={question}>
              <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-3 py-4 text-heading-16 text-gray-1000 [&::-webkit-details-marker]:hidden">
                <span className="min-w-0">{question}</span>
                <Plus
                  aria-hidden
                  className="shrink-0 text-gray-900 group-open:rotate-45"
                  size={18}
                />
              </summary>
              <p className="pb-6 pr-8 text-pretty text-copy-16 text-gray-900">{answer}</p>
            </details>
          ))}
        </div>
      </section>
    </main>
  );
}
