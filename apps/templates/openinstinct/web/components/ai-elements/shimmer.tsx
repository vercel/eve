"use client";

/* oxlint-disable hooks/static-components -- AI Elements supports a caller-selected intrinsic motion element. */

import { cn } from "@web/components/class-names";
import { LazyMotion, domAnimation, m } from "motion/react";
import { type ElementType, memo, useMemo } from "react";

interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
}

const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) => {
  const MotionComponent = m.create(Component);

  const dynamicSpread = useMemo(
    () => children.length * spread,
    [children, spread]
  );

  return (
    <LazyMotion features={domAnimation}>
      <MotionComponent
        animate={{ backgroundPosition: "0% center" }}
        className={cn(
          "relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent w-fit",
          "[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-foreground),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]",
          className
        )}
        initial={{ backgroundPosition: "100% center" }}
        style={{
          "--spread": `${String(dynamicSpread)}px`,
          backgroundImage:
            "var(--bg), linear-gradient(color-mix(in oklab, var(--color-muted-foreground) 60%, transparent), color-mix(in oklab, var(--color-muted-foreground) 60%, transparent))",
        }}
        transition={{
          repeat: Number.POSITIVE_INFINITY,
          duration,
          ease: "linear",
        }}
      >
        {children}
      </MotionComponent>
    </LazyMotion>
  );
};

export const Shimmer = memo(ShimmerComponent);
