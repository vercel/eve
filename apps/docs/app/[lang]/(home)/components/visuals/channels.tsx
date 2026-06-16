"use client";

import { Bot, Clock, Globe, MessageSquare, Radio, Terminal } from "lucide-react";
import { motion, useInView } from "motion/react";
import { useRef } from "react";

const targets = [
  { icon: Globe, label: "Web", color: "text-cyan-600" },
  { icon: MessageSquare, label: "Slack", color: "text-purple-600" },
  { icon: Terminal, label: "CLI", color: "text-green-600" },
  { icon: Radio, label: "API", color: "text-blue-600" },
  { icon: Clock, label: "Cron", color: "text-amber-600" },
];

export function ChannelsVisual() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, amount: 0.5 });

  return (
    <div ref={ref} className="flex items-center justify-center gap-6 py-2">
      <motion.div
        initial={{ opacity: 0, scale: 0.8 }}
        animate={isInView ? { opacity: 1, scale: 1 } : {}}
        transition={{ duration: 0.4 }}
        className="flex h-12 w-12 items-center justify-center rounded-md border border-gray-300 bg-gray-200"
      >
        <Bot className="h-6 w-6 text-gray-1000" />
      </motion.div>

      <div className="flex flex-col gap-1.5">
        {targets.map((t, i) => (
          <motion.div
            key={t.label}
            initial={{ opacity: 0, x: -12 }}
            animate={isInView ? { opacity: 1, x: 0 } : {}}
            transition={{
              delay: 0.3 + i * 0.1,
              duration: 0.4,
              ease: [0.22, 1, 0.36, 1],
            }}
            className="flex items-center gap-2"
          >
            <div className="h-px w-6 bg-gray-300" />
            <t.icon className={`h-3.5 w-3.5 ${t.color}`} />
            <span className="font-mono text-[10px] text-gray-900">{t.label}</span>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
