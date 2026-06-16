"use client";

import { motion, useInView } from "motion/react";
import { useRef } from "react";

const steps = [
  { label: "Tool called", status: "done" as const },
  { label: "Approval required", status: "waiting" as const },
  { label: "User approved", status: "done" as const },
  { label: "Execution resumed", status: "done" as const },
];

export function HITLVisual() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, amount: 0.5 });

  return (
    <div ref={ref} className="space-y-3">
      {steps.map((step, i) => (
        <motion.div
          key={step.label}
          initial={{ opacity: 0, x: -12 }}
          animate={isInView ? { opacity: 1, x: 0 } : {}}
          transition={{
            delay: i * 0.2,
            duration: 0.4,
            ease: [0.22, 1, 0.36, 1],
          }}
          className="flex items-center gap-3"
        >
          <div
            className={`h-2.5 w-2.5 rounded-full ${
              step.status === "waiting"
                ? "bg-amber-600 shadow-[0_0_8px_rgba(234,179,8,0.4)]"
                : "bg-green-600"
            }`}
          />
          <span className="font-mono text-xs text-gray-900">{step.label}</span>
          {step.status === "waiting" && (
            <motion.span
              initial={{ opacity: 0 }}
              animate={isInView ? { opacity: 1 } : {}}
              transition={{ delay: i * 0.2 + 0.3, duration: 0.3 }}
              className="rounded border border-yellow-500/30 bg-amber-600/10 px-2 py-0.5 font-mono text-[10px] text-amber-600"
            >
              parked
            </motion.span>
          )}
        </motion.div>
      ))}
    </div>
  );
}
