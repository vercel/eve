"use client";

import { motion, useInView } from "motion/react";
import { useRef } from "react";

const scores = [
  { label: "run.didNotFail", value: 100, color: "bg-green-600" },
  { label: "text.includes", value: 85, color: "bg-green-600" },
  { label: "run.usedTool", value: 92, color: "bg-green-600" },
  { label: "run.maxToolCalls", value: 100, color: "bg-green-600" },
];

export function EvalsVisual() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, amount: 0.5 });

  return (
    <div ref={ref} className="space-y-2.5">
      {scores.map((score, i) => (
        <div key={score.label} className="flex items-center gap-2">
          <span className="w-28 shrink-0 truncate font-mono text-[10px] text-gray-600">
            {score.label}
          </span>
          <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-gray-200">
            <motion.div
              className={`h-full rounded-full ${score.color}`}
              initial={{ width: 0 }}
              animate={isInView ? { width: `${score.value}%` } : {}}
              transition={{
                delay: i * 0.12,
                duration: 0.6,
                ease: [0.22, 1, 0.36, 1],
              }}
            />
          </div>
          <motion.span
            initial={{ opacity: 0 }}
            animate={isInView ? { opacity: 1 } : {}}
            transition={{ delay: i * 0.12 + 0.4, duration: 0.3 }}
            className="w-8 text-right font-mono text-[10px] text-gray-900"
          >
            {score.value}%
          </motion.span>
        </div>
      ))}
    </div>
  );
}
