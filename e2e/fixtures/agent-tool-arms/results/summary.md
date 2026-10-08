| Model                     | Size     | Arm       | Success | Mean input tokens | Cache read ratio | Mean model calls | Mean latency (s) |
| ------------------------- | -------- | --------- | ------: | ----------------: | ---------------: | ---------------: | ---------------: |
| openai/gpt-6.1-sol        | moderate | direct    |   10/10 |            7012.4 |            93.6% |              2.0 |             6.92 |
| openai/gpt-6.1-sol        | moderate | deferred  |   10/10 |           10374.6 |            91.6% |              3.6 |             9.06 |
| openai/gpt-6.1-sol        | moderate | subagents |   10/10 |           16942.8 |            88.3% |              6.1 |            30.09 |
| openai/gpt-6.1-sol        | large    | direct    |   10/10 |           22124.4 |            94.5% |              2.0 |             7.27 |
| openai/gpt-6.1-sol        | large    | deferred  |   10/10 |           13756.7 |            83.7% |              3.4 |             8.03 |
| openai/gpt-6.1-sol        | large    | subagents |   10/10 |           21120.5 |            88.6% |              6.1 |            23.31 |
| anthropic/claude-opus-5.5 | moderate | direct    |   10/10 |           15264.0 |            93.5% |              2.0 |             4.72 |
| anthropic/claude-opus-5.5 | moderate | deferred  |   10/10 |           17056.8 |            92.4% |              3.1 |             9.34 |
| anthropic/claude-opus-5.5 | moderate | subagents |   10/10 |           33536.7 |            88.1% |              5.9 |            15.36 |
| anthropic/claude-opus-5.5 | large    | direct    |   10/10 |           56554.1 |            94.6% |              2.0 |             5.96 |
| anthropic/claude-opus-5.5 | large    | deferred  |   10/10 |           18054.1 |            90.2% |              3.1 |             9.09 |
| anthropic/claude-opus-5.5 | large    | subagents |   10/10 |           43909.1 |            87.7% |              5.9 |            16.20 |
