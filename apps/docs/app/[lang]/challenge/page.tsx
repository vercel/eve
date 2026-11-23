import { ArrowUpRight, Plus } from "lucide-react";
import type { Metadata } from "next";
import { challengeHashtag, eveOnX } from "@/lib/challenge/submission";
import { canonicalAlternates } from "@/lib/geistdocs/canonical";
import { pageTitleMetadata } from "@/lib/geistdocs/metadata-title";
import { templateGalleryUrl } from "@/lib/templates/links";
import { PostBuilder } from "./post-builder";
import poster from "./poster.module.css";
import { TitleGlyphs } from "./title-glyphs";
import { challengeTitle } from "./title-stencils";

const title = pageTitleMetadata(challengeTitle);
const introduction = [
  "Are you looking to learn more about the eve framework, or do you already have an exciting project to showcase?",
  "Showcase what you've built for the chance to win limited edition eve-branded swag.",
];
const description = introduction.join(" ");

export const metadata: Metadata = {
  ...title,
  description,
  alternates: canonicalAlternates("/challenge"),
  openGraph: { ...title.openGraph, description, url: "/challenge" },
  twitter: {
    ...title.twitter,
    description,
    card: "summary_large_image",
  },
};

const steps = [
  [
    "Build an agent",
    "Build an agent with the eve framework and publish it to a public code repository.",
  ],
  [
    "Record a demo",
    "Optionally showcase your agent by recording a quick video. Projects with a video will be prioritized in judging.",
  ],
  [
    "Follow and post on X",
    <>
      <a className="font-medium text-gray-1000 underline underline-offset-4" href={eveOnX}>
        Follow @eve
      </a>
      , and then share your project with the world!
    </>,
  ],
] as const;

const templates = [
  {
    title: "Voice Agent",
    description: "Talk to your agent in the browser and follow along with a live transcript.",
    slug: "eve-voice-template",
  },
  {
    title: "eve Web Chat",
    description:
      "Give your agent a browser chat interface with streaming replies and tool activity.",
    slug: "eve-chat-template",
  },
  {
    title: "eve Coding Agent",
    description:
      "Ask your agent from Slack or GitHub to investigate an issue, review a change, or open a pull request.",
    slug: "eve-coding-agent-template",
  },
] as const;

const faqs = [
  [
    "What counts as an entry?",
    `Follow @eve on X and publish a public post with ${challengeHashtag}, a short description of your eve agent, and a GitHub repository link the eve team can open.`,
  ],
  [
    "Do I need to record a video?",
    "No. However, if you include a YouTube demo the eve team can watch, your entry gets priority in review. Show what you ask the agent to do and what it produces.",
  ],
  [
    "How are winners chosen?",
    "The eve team will be reviewing entries and taking into consideration technical complexity, usefulness, social media engagement, and creativity.",
  ],
  [
    "How will winners hear from the eve team?",
    "The eve team will follow up with winners on X with details.",
  ],
  [
    "What do winners receive?",
    "Each winner will receive limited-edition eve and Vercel branded swag.",
  ],
];

const heading = "text-balance text-heading-32 text-gray-1000 sm:text-heading-40";
const subheading = "text-heading-24 text-gray-1000";

export default function ChallengePage() {
  return (
    <main className={`${poster.technical} w-full min-w-0 pb-24`}>
      <TitleGlyphs />

      <div className="mx-auto w-full min-w-0 max-w-[80rem] px-4 sm:px-8">
        <section aria-labelledby="challenge" className="py-12 sm:py-16">
          <h2 className={heading} id="challenge">
            eve Builder Challenge
          </h2>
          <div className="mt-3 grid gap-3 text-pretty text-copy-16 text-gray-900">
            {introduction.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>

          <div className="mt-8 grid gap-8 sm:mt-10 sm:gap-10">
            <section aria-labelledby="how-to-enter" className="min-w-0">
              <h3 className={subheading} id="how-to-enter">
                How to enter
              </h3>
              <ol
                className="mt-4 grid list-none divide-y divide-gray-400 border-y border-gray-400 md:grid-cols-3 md:divide-x md:divide-y-0 md:rounded-xl md:border"
                role="list"
              >
                {steps.map(([name, detail], index) => (
                  <li
                    className="grid grid-cols-[2ch_minmax(0,1fr)] items-baseline gap-x-3 py-4 md:px-4 lg:px-5"
                    key={name}
                  >
                    <span aria-hidden="true" className="text-copy-14 text-gray-900 tabular-nums">
                      {index + 1}.
                    </span>
                    <div>
                      <h4 className="text-heading-20 text-gray-1000">{name}</h4>
                      <p className="mt-1 max-w-[54ch] text-copy-14 text-gray-900">{detail}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </section>

            <section aria-labelledby="submit" className="min-w-0">
              <h3 className={subheading} id="submit">
                Submit your agent
              </h3>
              <div className="@container mt-4">
                <PostBuilder />
              </div>
            </section>
          </div>
        </section>

        <section aria-labelledby="inspiration" className="border-t border-gray-400 py-12 sm:py-16">
          <h2 className={heading} id="inspiration">
            Looking for inspiration?
          </h2>
          <p className="mt-3 text-copy-16 text-gray-900">
            Start with one of these eve templates and make it your own.
          </p>
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            {templates.map(({ title, description, slug }) => (
              <article
                className="flex min-w-0 flex-col rounded-xl border border-gray-400 bg-background-100 p-4 lg:p-6"
                key={title}
              >
                <h3 className="text-heading-20 text-gray-1000">{title}</h3>
                <p className="mt-2 mb-5 text-copy-14 text-gray-900">{description}</p>
                <a
                  aria-label={`View the ${title} template`}
                  className="mt-auto inline-flex items-center gap-1.5 self-start text-label-14 font-medium text-gray-1000 underline-offset-4 hover:underline"
                  href={`${templateGalleryUrl}/${slug}`}
                >
                  View template <ArrowUpRight aria-hidden size={14} />
                </a>
              </article>
            ))}
          </div>
        </section>

        <section aria-labelledby="faq" className="border-t border-gray-400 pt-12 sm:pt-16">
          <h2 className={heading} id="faq">
            FAQs
          </h2>
          <div className="mt-6 divide-y divide-gray-400 rounded-xl border border-gray-400 bg-background-100">
            {faqs.map(([question, answer]) => (
              <details className="group px-4 sm:px-6" key={question}>
                <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-2 py-3 text-label-16 font-medium text-gray-1000 sm:gap-3 [&::-webkit-details-marker]:hidden">
                  <span className="min-w-0">{question}</span>
                  <Plus
                    className="shrink-0 text-gray-900 group-open:rotate-45"
                    aria-hidden
                    size={18}
                  />
                </summary>
                <p className="pb-5 text-copy-14 leading-relaxed text-gray-900">{answer}</p>
              </details>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
