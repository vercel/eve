# eve benchmark app

Stock `eve` application benchmarked by [eve-bench](https://github.com/vercel-labs/eve-bench#readme) on the SWE-lean and DeepSWE-lean datasets. It uses stock `HostSandbox` (`eve/sandbox/host`), production HTTP Basic authentication (`verifyHttpBasic`), dynamic task MCP connections (`EVE_BENCH_MCP_SERVERS`), lifecycle observability capture (`EVE_BENCH_O11Y_PATH`), and disabled web tools without additional extensions.

## In CI

The `eve` workflow (`.github/workflows/eve-benchmark.yml`) benchmarks `eve`, `opencode`, `pi`, and [fx](https://fx.sh) together, with one `Benchmark harness (<family>)` job per model family:

| Family      | Model                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| `anthropic` | `EVE_BENCH_MODEL` (or `EVE_CODE_BENCH_MODEL`) repository variable, default `anthropic/claude-sonnet-5.5`      |
| `openai`    | `EVE_BENCH_OPENAI_MODEL` (or `EVE_CODE_BENCH_OPENAI_MODEL`) repository variable, default `openai/gpt-6.2-sol` |

Every trial runs in its own Vercel Sandbox, up to 16 at a time per harness. Each harness is compared with its own latest result from `main` on the same dataset and model, never with another model's results.

| Trigger                                                                          | Dataset      | Models                 | Publishes baselines |
| -------------------------------------------------------------------------------- | ------------ | ---------------------- | ------------------- |
| PR that changes `apps/bench-agent/**`                                            | SWE-lean     | `anthropic`            | No                  |
| `/benchmark` comment on a PR                                                     | chosen       | `anthropic`, or chosen | No                  |
| Push to `main` that changes `apps/bench-agent/**` or `packages/eve/package.json` | SWE-lean     | `anthropic`            | Yes                 |
| Weekly, Monday 06:00 UTC, on `main`                                              | DeepSWE-lean | both, one after other  | Yes                 |
| Manual dispatch                                                                  | chosen       | both, or chosen        | Only on `main`      |

Comment `/benchmark [<dataset>] [model=<family>] [<harness>[,<harness>...]]` to run a benchmark on a PR (for example `/benchmark`, `/benchmark codex,eve`, or `/benchmark deepswe-lean model=openai`). You need write access to the repository.

### Baselines and docs snapshot

- `eve-bench` keys stored results by the agent repository, which only a run including `eve` provides. A run without `eve` (such as `harness=opencode` or `/benchmark opencode`) reports to the job summary only, posts no PR comment, is not compared against stored baselines, and does not publish. To re-baseline a peer harness on `main`, dispatch it alongside `eve` (for example `harness=eve,opencode`).
- `packages/eve/package.json` version bumps on `main` refresh `swe-lean` baselines automatically; for other `packages/eve` changes on `main`, dispatch `swe-lean` manually if you want a fresh baseline.
- `main` accepts changes only through pull requests with passing checks. After weekly or dispatched `deepswe-lean` runs on `main`, the `Refresh docs benchmark results` job resets `bot/eve-benchmark-snapshot` to `main`, commits the updated `apps/docs/lib/evals/eve-benchmark.json`, and opens or updates `chore: refresh eve benchmark results` with auto-merge on. Because it opens with `GITHUB_TOKEN`, a maintainer must select **Approve workflows to run** and approve the PR for auto-merge to squash it. No PR is opened when the snapshot is unchanged.

## Locally

With [eve-bench](https://github.com/vercel-labs/eve-bench#readme) linked (`npm link` in its checkout), commit and push this checkout, then run:

```sh
eve-bench -a eve --agent-dir apps/bench-agent --model openai/gpt-6.2-sol --reasoning low \
  --scope <vercel-team> --execution vercel-sandbox
```

Pass several harnesses to compare them in one run, for example `-a eve,opencode,pi`. Use `--task <name>` to run a single task. Local runs never publish to the result store.

## Investigating a failed trial

```sh
eve-bench trials logs https://github.com/vercel/eve/actions/runs/<id>
eve-bench trials logs https://github.com/vercel/eve/actions/runs/<id> --harness eve --task <task>
```

Each model family uploads its own artifact named `<dataset>-<harnesses>-<family>` (for example `deepswe-lean-eve+opencode+pi-openai`). On runs covering both families, pass `--artifact <name>` so `eve-bench trials logs` reads only that family's trials.
