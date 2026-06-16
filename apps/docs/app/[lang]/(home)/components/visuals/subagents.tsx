"use client";

import { Bot, Code, Database, Search } from "lucide-react";
import { motion, useInView } from "motion/react";
import { useRef } from "react";

const agents = [
  { icon: Search, label: "Researcher", color: "text-purple-600" },
  { icon: Code, label: "Coder", color: "text-blue-600" },
  { icon: Database, label: "Analyst", color: "text-green-600" },
];

export function SubagentsVisual() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, amount: 0.5 });

  return (
    <div ref={ref} className="flex flex-col items-center gap-4 py-2">
      <motion.div
        initial={{ opacity: 0, scale: 0.8 }}
        animate={isInView ? { opacity: 1, scale: 1 } : {}}
        transition={{ duration: 0.4 }}
        className="flex items-center gap-2 rounded-md border border-gray-300 bg-gray-200 px-3 py-2"
      >
        <Bot className="h-4 w-4 text-gray-1000" />
        <span className="font-mono text-xs text-gray-900">Parent Agent</span>
      </motion.div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={isInView ? { opacity: 1 } : {}}
        transition={{ delay: 0.3, duration: 0.3 }}
        className="h-4 w-px bg-gray-300"
      />

      <div className="flex gap-3">
        {agents.map((agent, i) => (
          <motion.div
            key={agent.label}
            initial={{ opacity: 0, y: 12 }}
            animate={isInView ? { opacity: 1, y: 0 } : {}}
            transition={{
              delay: 0.4 + i * 0.12,
              duration: 0.4,
              ease: [0.22, 1, 0.36, 1],
            }}
            className="flex items-center gap-1.5 rounded-md border bg-gray-100 px-2.5 py-1.5"
          >
            <agent.icon className={`h-3.5 w-3.5 ${agent.color}`} />
            <span className="font-mono text-[10px] text-gray-900">{agent.label}</span>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
