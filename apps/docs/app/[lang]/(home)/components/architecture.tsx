"use client";

import { motion, useInView } from "motion/react";
import { useRef } from "react";

export function ArchitectureDiagram() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, amount: 0.2 });

  return (
    <section className="px-4 py-24 sm:px-12" ref={ref}>
      <div className="mx-auto max-w-5xl">
        <h2 className="text-center text-3xl font-bold tracking-tighter text-gray-1000 sm:text-4xl">
          Three layers, cleanly separated
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-center text-gray-900">
          The <span className="font-semibold text-gray-1000">runtime</span> owns durability and
          state. The <span className="font-semibold text-gray-1000">harness</span> executes AI work.
          The <span className="font-semibold text-gray-1000">channel</span> is where your agent gets
          surfaced.
        </p>

        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="mt-16 flex flex-col gap-4 md:flex-row"
        >
          {/* Left column: Harness above Runtime */}
          <div className="flex flex-1 flex-col gap-4">
            {/* Harness */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={isInView ? { opacity: 1 } : {}}
              transition={{ delay: 0.1, duration: 0.4 }}
              className="rounded-md border-2 border-dashed border-purple-800 dark:border-purple-600 bg-background px-5 py-4"
            >
              <div className="flex items-center gap-2">
                <div className="h-2.5 w-2.5 rounded-full bg-purple-700 dark:bg-purple-500" />
                <div className="text-sm font-bold uppercase tracking-widest text-purple-800 dark:text-purple-500">
                  Harness
                </div>
              </div>
              <div className="mt-1 text-sm text-gray-900">
                Executes one unit of AI work per workflow step
              </div>
            </motion.div>

            {/* Runtime (contains workflow + primitives) */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={isInView ? { opacity: 1 } : {}}
              transition={{ delay: 0.2, duration: 0.4 }}
              className="flex flex-1 flex-col rounded-md border-2 border-dashed border-green-800 dark:border-green-600 bg-background p-5"
            >
              <div className="mb-1 flex items-center gap-2">
                <div className="h-2.5 w-2.5 rounded-full bg-green-700 dark:bg-green-500" />
                <div className="text-sm font-bold uppercase tracking-widest text-green-800 dark:text-green-500">
                  Runtime
                </div>
              </div>
              <div className="mb-5 text-sm text-gray-900">
                Durable execution, state persistence, event streaming
              </div>

              {/* Durable Workflow */}
              <div className="mb-4 flex items-center gap-3 rounded-md border bg-gray-100 px-4 py-3">
                <span className="text-xl text-green-700 dark:text-green-500">&#x21bb;</span>
                <div>
                  <div className="text-sm font-semibold text-gray-1000">Durable Workflow</div>
                  <div className="text-sm text-gray-900">
                    Checkpointed steps, park between messages, resume on delivery
                  </div>
                </div>
              </div>

              {/* Primitives (inside runtime) */}
              <div className="grid flex-1 grid-cols-2 gap-3 md:grid-cols-4">
                <div className="rounded-md border bg-gray-100 px-4 py-3">
                  <div className="text-sm font-semibold text-blue-800 dark:text-blue-500">
                    AI SDK
                  </div>
                  <div className="text-sm text-gray-900">Model calls, streaming</div>
                </div>
                <div className="rounded-md border bg-gray-100 px-4 py-3">
                  <div className="text-sm font-semibold text-amber-800 dark:text-amber-500">
                    Sandbox SDK
                  </div>
                  <div className="text-sm text-gray-900">Isolated execution</div>
                </div>
                <div className="rounded-md border bg-gray-100 px-4 py-3">
                  <div className="text-sm font-semibold text-pink-800 dark:text-pink-600">
                    Connection SDK
                  </div>
                  <div className="text-sm text-gray-900">MCP/HTTP endpoints</div>
                </div>
                <div className="rounded-md border bg-gray-100 px-4 py-3">
                  <div className="text-sm font-semibold text-gray-1000">Tools & Subagents</div>
                  <div className="text-sm text-gray-900">Functions, child agents</div>
                </div>
              </div>
            </motion.div>
          </div>

          {/* Channel (right side, stretches full height) */}
          <motion.div
            initial={{ opacity: 0, x: 16 }}
            animate={isInView ? { opacity: 1, x: 0 } : {}}
            transition={{ delay: 0.5, duration: 0.5 }}
            className="flex w-full flex-col rounded-md border-2 border-dashed border-cyan-800 dark:border-cyan-600 bg-background p-5 md:w-[180px]"
          >
            <div className="mb-1 flex items-center gap-2">
              <div className="h-2.5 w-2.5 rounded-full bg-cyan-700 dark:bg-cyan-500" />
              <div className="text-sm font-bold uppercase tracking-widest text-cyan-800 dark:text-cyan-500">
                Channel
              </div>
            </div>
            <div className="mb-5 text-sm text-gray-900">Where your agent gets surfaced</div>
            <div className="space-y-2">
              {["Slack", "Web Chat", "API", "Cron"].map((ch) => (
                <div
                  key={ch}
                  className="rounded-md border bg-gray-100 px-4 py-2 text-sm text-gray-1000"
                >
                  {ch}
                </div>
              ))}
              <div className="rounded-md border border-dashed px-4 py-2 text-sm text-gray-500">
                other channels
              </div>
            </div>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}
