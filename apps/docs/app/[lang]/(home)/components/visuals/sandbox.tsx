"use client";

import { motion, useInView } from "motion/react";
import { useRef } from "react";

const lines = [
  { id: "cmd", prompt: "$ ", text: "sandbox.run('npm test')", color: "text-blue-600" },
  { id: "pass", prompt: "", text: "PASS  src/agent.test.ts", color: "text-green-600" },
  {
    id: "t1",
    prompt: "",
    text: "  \u2713 handles weather query (42ms)",
    color: "text-gray-900",
  },
  { id: "t2", prompt: "", text: "  \u2713 retries on failure (118ms)", color: "text-gray-900" },
  { id: "total", prompt: "", text: "Tests: 2 passed, 2 total", color: "text-green-600" },
];

export function SandboxVisual() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, amount: 0.5 });

  return (
    <div ref={ref} className="font-mono text-xs">
      {lines.map((line, i) => (
        <motion.div
          key={line.id}
          initial={{ opacity: 0 }}
          animate={isInView ? { opacity: 1 } : {}}
          transition={{ delay: i * 0.2, duration: 0.3 }}
          className="leading-6"
        >
          {line.prompt && <span className="text-gray-600">{line.prompt}</span>}
          <span className={line.color}>{line.text}</span>
        </motion.div>
      ))}
    </div>
  );
}
