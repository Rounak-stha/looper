# Multi-repository selection checkpoint v1

## Scope

Development-only BugsInPy `T-fix` evidence. The corpus contains 20 development tasks from FastAPI (2), TheFuck (2), Tornado (5), and youtube-dl (11). The six held-out tasks were not evaluated.

Candidate construction uses the language-neutral filesystem provider with bounded full-text retrieval, a 1,000-item retrieval pool, and an explicit `candidateKinds: ["file"]` filter. This is appropriate for this localization endpoint because BugsInPy `goldFiles` excludes test paths. Selection is fixed at `k=1`.

## Candidate gate and local baselines

| Candidates | Candidate recall | BM25 top-1 gold | Heuristic top-1 gold |
|---:|---:|---:|---:|
| 10 | 77.5% | 7/20 | 5/20 |
| 30 | 90.0% | 1/20 | 0/20 |
| 100 | 95.0% | 0/20 | 0/20 |
| 255 (mean available 209.85) | 100% | 0/20 | 0/20 |

The non-monotonic local-selector result is retained: truncation changes which low-quality candidate wins. It is not evidence that fewer candidates improve localization generally.

## Equal 100-candidate online comparison

| Selector | Candidate recall | Any gold selected | Recall | All gold selected | Mean latency | Input tokens | Output tokens |
|---|---:|---:|---:|---:|---:|---:|---:|
| DeepSeek-V4-Flash listwise | 95% | 15/20 | 72.5% | 70% | 1,464.7 ms | 175,706 | 432 |
| gpt-5.6-sol listwise | 95% | 16/20 | 77.5% | 75% | 3,094.6 ms | 156,778 | 2,233 |
| System One Choice | 95% | 16/20 | 77.5% | 75% | 486.3 ms | 171,605 | 29,502 |

All 60 calls completed without decode repair. Exact resolved identities were `DeepSeek-V4-Flash`, `gpt-5.6-sol-2026-07-09`, and `jev-1.13.0`.

At this envelope, System One Choice matched the strong generative control's top-1 result and was approximately 6.4 times faster by observed selector latency. It selected one more gold file than the cheap generative control. Token counts are provider-reported and are not directly interchangeable across providers; dollar cost remains unknown.

## System One envelope and Noul feasibility

Choice selected any gold file on:

- 15/20 at 10 candidates
- 16/20 at 30 candidates
- 16/20 at 100 candidates
- 17/20 at up to 255 candidates (100% candidate recall)

At 30 candidates, Noul selected a gold file on 15/20 and combined Choice+Noul on 16/20. Noul and combined were not run at 100 candidates: request validation estimated 45,988 tokens, exceeding the hard 30,000-token decision limit. The failed sweep committed no partial result, and the safety limit was not raised.

## Interpretation

This checkpoint passes the offline gate for further development work:

- complete paired coverage at the equal 100-candidate envelope;
- high candidate recall (95%), with 100% available at the 255 source-only envelope;
- no malformed responses or silent fallbacks;
- Choice matched the strong S3 control and exceeded the cheap S3 control;
- Choice had substantially lower observed latency than both S3 controls.

It does **not** establish benchmark-level efficacy. Repository representation is uneven, only four repositories are present, and no held-out task has been inspected through selector evaluation.

The planned robustness characterization is complete; see `robustness-checkpoint.md`. Choice and the strong S3 control advanced, while DeepSeek failed the complete-coverage gate.
