"use client";

import { motion, useInView } from "motion/react";
import { useRef } from "react";

const steps = [
  { id: "fetch", label: "Step 1: Fetch data", width: "60%", color: "bg-green-600" },
  { id: "process-1", label: "Step 2: Process", width: "45%", color: "bg-green-600" },
  { id: "crash", label: "Crash", width: "15%", color: "bg-red-600" },
  { id: "resume", label: "Resume", width: "10%", color: "bg-amber-600" },
  { id: "process-2", label: "Step 2: Process", width: "45%", color: "bg-green-600" },
  { id: "respond", label: "Step 3: Respond", width: "30%", color: "bg-green-600" },
];

export function DurabilityVisual() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, amount: 0.5 });

  return (
    <div ref={ref} className="space-y-2">
      {steps.map((step, i) => (
        <div key={step.id} className="flex items-center gap-2">
          <span className="w-36 shrink-0 truncate font-mono text-[10px] text-gray-600">
            {step.label}
          </span>
          <div className="h-3 flex-1 overflow-hidden rounded-full bg-gray-200">
            <motion.div
              className={`h-full rounded-full ${step.color}`}
              initial={{ width: 0 }}
              animate={isInView ? { width: step.width } : {}}
              transition={{
                delay: i * 0.15,
                duration: 0.6,
                ease: [0.22, 1, 0.36, 1],
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
