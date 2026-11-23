import { MessageSquareIcon } from "lucide-react";
import { Suspense, type ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/class-names";
import { Button, buttonVariants } from "@/components/ui/button";
import { env } from "@/lib/environment/env";
import { requirePageScope } from "@/lib/auth/next";
import { formatPhoneNumber } from "@/lib/auth/phone-number";
import { readLinqOnboardingPhoneNumber } from "@/lib/linq/sign-in";

const statusClass = "type-body inline-flex items-center gap-2 font-medium";
const numberClass = "type-product-title mt-3 text-[clamp(1.25rem,10.5cqw,4.5rem)] leading-none";
const descriptionClass = "type-body mt-5 text-lg text-pretty text-muted-foreground";
const readyDescription = "Text what you want to buy to get started.";

export default async function Page() {
  await requirePageScope("/");
  return (
    <div className="flex flex-1 items-center justify-center py-12">
      <Suspense fallback={<ChannelsSkeleton />}>
        <Channels />
      </Suspense>
    </div>
  );
}

async function Channels() {
  const connector = env.LINQ_CONNECTOR;
  const phoneNumber = connector
    ? (env.LINQ_PHONE_NUMBER ?? (await readLinqOnboardingPhoneNumber(connector)))
    : undefined;
  return <ChannelsSection linqConfigured={Boolean(connector)} linqPhoneNumber={phoneNumber} />;
}

export function ChannelsSection({
  linqConfigured,
  linqPhoneNumber,
}: {
  readonly linqConfigured: boolean;
  readonly linqPhoneNumber?: string;
}) {
  const phoneNumber = linqConfigured ? linqPhoneNumber : undefined;

  return (
    <ChannelsFrame
      status={
        <p className={cn(statusClass, phoneNumber ? "text-success" : "text-muted-foreground")}>
          <span
            aria-hidden="true"
            className={cn(
              "size-2.5 rounded-full",
              phoneNumber ? "bg-success" : "bg-muted-foreground/50",
            )}
          />
          {phoneNumber ? "Ready!" : linqConfigured ? "Number unavailable" : "Setup required"}
        </p>
      }
    >
      {phoneNumber ? (
        <>
          <a
            className={cn(
              numberClass,
              "type-numeric w-fit break-all text-foreground underline-offset-8 hover:underline focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            )}
            href={`sms:${phoneNumber}`}
          >
            {formatPhoneNumber(phoneNumber)}
          </a>
          <p className={descriptionClass}>{readyDescription}</p>
          <a
            className={buttonVariants({ className: "mt-8 h-12 px-6 text-base" })}
            href={`sms:${phoneNumber}`}
          >
            <MessageSquareIcon aria-hidden="true" /> Open iMessage
          </a>
        </>
      ) : (
        <>
          <p className={cn(numberClass, "text-muted-foreground")}>Not available yet</p>
          <p className={descriptionClass}>
            {linqConfigured
              ? "We couldn’t load the number from Linq. Try refreshing or check the line in Vercel Connect."
              : "Set up Linq to enable iMessage."}
          </p>
          <Button className="mt-8 h-12 px-6 text-base" disabled>
            <MessageSquareIcon /> Open iMessage
          </Button>
        </>
      )}
    </ChannelsFrame>
  );
}

function ChannelsSkeleton() {
  return (
    <ChannelsFrame
      status={
        <div className={cn(statusClass, "h-[1lh]")}>
          <span className="sr-only" role="status">
            Loading agent number…
          </span>
          <Skeleton aria-hidden="true" className="size-2.5 rounded-full" />
          <Skeleton aria-hidden="true" className="h-3 w-12" />
        </div>
      }
    >
      <div aria-hidden="true" className={cn(numberClass, "flex h-[1lh] w-full items-center")}>
        <Skeleton className="h-[.8em] w-full" />
      </div>
      <div aria-hidden="true" className={cn(descriptionClass, "relative w-full")}>
        <span className="invisible">{readyDescription}</span>
        <Skeleton className="absolute top-1/2 h-3 w-4/5 max-w-xs -translate-y-1/2" />
      </div>
      <Skeleton aria-hidden="true" className="mt-8 h-12 w-42" />
    </ChannelsFrame>
  );
}

function ChannelsFrame({
  status,
  children,
}: {
  readonly status: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section
      aria-labelledby="channels-heading"
      className="@container flex w-full max-w-2xl min-w-0 flex-col items-start"
    >
      {status}
      <h1
        className="type-page-title mt-4 text-3xl text-muted-foreground sm:text-4xl"
        id="channels-heading"
      >
        Your agent’s number
      </h1>
      {children}
    </section>
  );
}
