# Multi-repository end-to-end development result

## Protocol

The frozen protocol in `end-to-end-protocol.md` was run on all 20 development tasks with three repetitions per task. All three arms completed 60/60 scheduled runs with no harness-level missing coverage. The six held-out tasks were not used for this analysis.

An initial S0 launch encountered a missing Docker repository-digest alias. Its events are retained separately as `e2e-s0-r3-infrastructure-failed-events.jsonl` and excluded from comparison. The exact qualified image content still existed locally under its immutable image ID. The Docker adapter was fixed to retry a missing `repository@sha256:...` alias only by that exact local `sha256:...` image ID, never by a mutable tag. All three arms were then run from clean event files.

## Aggregate results

| Arm | Authoritative pass | Mean coder tokens | Mean steps | Mean tool calls | Initial context | Dynamic context | Selector input/output | Selector latency | Mean wall time |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| S0 | 44/60 (73.3%) | 39,161 | 10.13 | 9.12 | 0 | 17,388 chars | 0 / 0 | 0 ms | 51.9 s |
| System One Choice | 45/60 (75.0%) | 36,989 | 7.52 | 6.52 | 1,843 tokens | 16,174 chars | 8,580 / 1,475 | 1,815 ms | 191.5 s* |
| strong S3 | 46/60 (76.7%) | 44,292 | 8.45 | 7.43 | 1,848 tokens | 16,120 chars | 7,839 / 146 | 7,338 ms | 45.0 s |

Provider token counts are not directly interchangeable across model providers. Configured prices were unknown, so recorded dollar cost is zero and must not be interpreted as free usage.

Compared with S0, Choice had +1 pass, about 5.5% fewer coder tokens, 25.8% fewer steps, 28.5% fewer tool calls, and 7.0% less dynamic context. Strong S3 had +2 passes but about 13.1% more coder tokens than S0. Choice selection was about four times faster than strong-S3 selection in these end-to-end calls.

## Paired outcomes

Strict task and repetition coverage matched for every comparison.

- Choice minus S0 pass-rate estimate: +1.67 percentage points; bootstrap 95% interval [-5.0, +8.33].
- Strong S3 minus S0: +3.33 points; interval [-5.0, +13.33].
- Strong S3 minus Choice: +1.67 points; interval [-8.33, +11.67].

These intervals overlap zero. This small development experiment does not establish an accuracy winner.

Per-repository pass counts:

| Arm | FastAPI | TheFuck | Tornado | youtube-dl |
|---|---:|---:|---:|---:|
| S0 | 5/6 | 6/6 | 8/15 | 25/33 |
| Choice | 4/6 | 6/6 | 11/15 | 24/33 |
| strong S3 | 5/6 | 6/6 | 10/15 | 25/33 |

The repository mix is uneven, so pooled results are strongly influenced by youtube-dl.

## Wall-clock anomaly

`*` Seven Choice runs crossed the configured 900-second wall-clock cap. They were retained as budget failures. Event logs show 15–28 minute gaps between routing and model-call completion, consistent with host/provider suspension or stalls. The budget check prevented further agent work after delayed calls returned, but JavaScript timers cannot preempt while the host runtime itself is suspended. These runs heavily inflate Choice mean wall time and conservatively reduce its pass result. They are not selectively rerun.

Median wall time was 28.3 s for S0, 32.5 s for Choice, and 34.5 s for strong S3. The primary mean wall-time comparison is therefore environmentally confounded; both mean and distribution must be reported.

## Development decision

There is no demonstrated accuracy winner. System One Choice advances as the primary experimental selector because it preserved observed accuracy while reducing coder tokens, steps, tools, and dynamic context relative to S0. Strong S3 remains a secondary comparator because it achieved the highest raw development pass count, at higher coder-token and selector-latency cost. S0 remains the baseline.

The held-out protocol is frozen before evaluation: one run for each of S0, Choice, and strong S3 on exactly the six tasks in `test.jsonl`, with the same source-only 100-candidate/1,000-pool policy, coder, router, evaluator, and budgets. Held-out outcomes will not trigger prompt or policy tuning.
