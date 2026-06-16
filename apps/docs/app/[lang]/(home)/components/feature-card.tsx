import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

export function FeatureCard({
  title,
  description,
  icon,
  visual,
  href,
}: {
  title: string;
  description: string;
  icon: ReactNode;
  visual: ReactNode;
  href: string;
}) {
  return (
    <div className="group flex flex-col rounded-md border p-6 transition-colors hover:border-gray-300">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-gray-100">
          {icon}
        </div>
        <div>
          <h3 className="font-semibold text-gray-1000">{title}</h3>
          <p className="mt-1 text-sm text-gray-900">{description}</p>
        </div>
      </div>
      <div className="mt-6 overflow-hidden rounded-md border bg-gray-100/50 p-4">{visual}</div>
      <div className="mt-4 flex flex-1 items-end justify-end">
        <Link
          href={href}
          className="flex items-center gap-1 text-sm text-gray-600 transition-colors hover:text-gray-1000"
        >
          Learn more
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </div>
  );
}
