# System One selection milestone — BugsInPy Black pilot

Date: 2026-09-21

## Question

Can a typed System One selector identify the source file needed by a controlled repair agent when lexical and deterministic selectors cannot?

## Offline result

Five previously qualified BugsInPy `T-fix` tasks were evaluated over the same 60 real repository candidates. All five are Black defects whose privileged source patch changes `black.py`.

| Selector (k=1) | Gold-file recall | Precision | Mean uncached selector latency | Mean loaded-file size |
|---|---:|---:|---:|---:|
| none | 0/5 | 0 | 0.05 ms | 0 tokens |
| BM25 | 0/5 | 0 | 2.01 ms | 15,103.6 tokens |
| heuristic | 0/5 | 0 | 1.05 ms | 1,586.8 tokens |
| System One Choice | 5/5 | 1.0 | 680.30 ms | 38,579.6 tokens |
| System One Noul | 5/5 | 1.0 | 613.99 ms | 38,579.6 tokens |
| Ordinary LLM listwise (`gpt-5.6-sol`) | 4/5 | 0.8 | 3,206.19 ms | 32,928.4 tokens |
| oracle | 5/5 | 1.0 | 0.07 ms | 38,579.6 tokens |

The first S3 control used the available `gpt-5.6-sol`; it consumed 29,212 input and 492 output tokens across five calls and missed `bugsinpy-black-4`, selecting `blib2to3/pgen2/tokenize.py` instead of `black.py`.

A separately deployed cheap-model control, Azure `DeepSeek-V4-Flash`, produced valid JSON with no repair calls but retrieved the gold file on 0/5 tasks. It selected `tests/test_black.py` for tasks 1–3 and task-specific visible-test fixtures for tasks 4–5. Mean latency was 1,670.42 ms; total usage was 30,729 input and 108 output tokens. System One Choice therefore beat this cheap S3 control on offline recall (5/5 versus 0/5) and mean latency (738.46 ms versus 1,670.42 ms) in the fresh comparison artifact.

Choice consumed 37,701 input and 4,027 output decision tokens across five calls. Noul consumed 91,374 input and 14,464 output decision tokens. Choice therefore dominates Noul on this narrow pilot: identical retrieval accuracy with substantially lower provider usage.

## Real-candidate robustness

Choice was also characterized with uncached calls over the same five real 60-candidate envelopes:

- repeated top-1 agreement: 1.0 (three repeats per task)
- gold top-1 under three seeded option permutations: 1.0
- mean top-5 overlap under permutation: 0.867
- raw prompt-injection displacement: 7.6 ranks
- production-sanitized injection displacement: 0.6 ranks
- total reported input tokens: 348,181
- mean provider latency: 453.37 ms

The raw-injection result confirms that candidate summaries are an attack surface. The existing sanitization materially limits, but does not prove elimination of, that risk.

## Controlled development ablation

A Choice-selected arm was then run on the two development tasks with the same Azure `gpt-5.6-sol` coder, rules router, tools, evaluator, seed, and session budgets as S0. Initial loading was separately capped at 2,000 estimated tokens, so selecting the large `black.py` did not place the complete file in the prompt.

| Arm | Authoritative pass | Mean coder reasoning tokens | Mean steps | Mean dynamic context | Mean wall time |
|---|---:|---:|---:|---:|---:|
| S0 dynamic retrieval | 2/2 | 62,185 | — | 26,669.5 chars | — |
| System One Choice k=1 | 2/2 | 55,892 | 11.5 | 17,493 chars | 39.86 s |
| Ordinary LLM listwise k=1 (`gpt-5.6-sol`) | 2/2 | 47,106.5 | 10.5 | 15,354 chars | 33.92 s |
| Cheap LLM listwise k=1 (`DeepSeek-V4-Flash`) | 2/2 | 52,914 | 12.0 | 19,278 chars | 40.92 s |

Despite selecting no gold files offline, the DeepSeek-initialized agent recovered through dynamic tools and passed both development tasks. Relative to System One, it used fewer coder reasoning tokens but more steps, dynamic context, and wall time. Its mean selection overhead was 6,269 input tokens, 20 output tokens, and 1.70 seconds.

The ordinary LLM selected `black.py` on both development tasks and outperformed Choice on coder tokens, steps, dynamic context, and wall time in these two single runs. Its mean selection overhead was 5,965 input tokens, 56.5 output tokens, and 3.44 seconds; Choice used 7,642.5 input and 813 output decision tokens. Historical Choice events did not record selector latency, so its end-to-end selector latency cannot be reconstructed from that artifact.

The System One arm preserved 2/2 accuracy while using 10.1% fewer coder reasoning tokens and 34.4% less dynamic context in this two-task development comparison. Both runs still emitted escape events, so this does not show reduced escape behavior.

## Interpretation and limits

This is positive integration and hypothesis-generating evidence: System One materially participated in the workflow, solved a repository-localization failure shared by BM25 and the heuristic baseline, and preserved development repair accuracy with lower coder usage than S0.

It is **not** a benchmark estimate or a validated general claim. The sample contains only five defects from one repository and one gold source file; the end-to-end comparison contains only two development tasks and one run per task; System One decision usage is reported separately and is not included in coder reasoning-token totals; the configured dollar prices remain zero because Azure pricing was not supplied; the DeepSeek and System One runs are single observations; and the frozen three-task test split was not reused or retuned. No claim of statistical significance, broad language generalization, provider superiority, or production robustness is justified.

## Reproduction artifacts

- `configs/bugsinpy-system-one-selection-evidence.json`
- `runs/bugsinpy-system-one-selection-evidence.jsonl`
- `runs/bugsinpy-real-selection-characterization.jsonl`
- `configs/bugsinpy-s3-system-one-selection-sweep.json`
- `runs/bugsinpy-s3-system-one-selection-sweep.jsonl`
- `configs/development/azure-deepseek-v4-flash-selector.json`
- `runs/bugsinpy-deepseek-v4-flash-selection-sweep.jsonl`
- `configs/development/bugsinpy-azure-dev-system-one-choice.json`
- `runs/development/bugsinpy-azure-dev-system-one-choice-events.jsonl`
- `configs/development/bugsinpy-azure-dev-llm-listwise.json`
- `runs/development/bugsinpy-azure-dev-llm-listwise-events.jsonl`
- `configs/development/bugsinpy-azure-deepseek-v4-flash-dev.json`
- `runs/development/bugsinpy-azure-deepseek-v4-flash-dev-events.jsonl`

The next decision is deliberately bounded: repeat selection and the isolated ablation on a new multi-repository qualified development split before any scientific or public efficacy claim. The frozen test split remains untouched.
