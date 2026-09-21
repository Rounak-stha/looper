# Multi-repository selector robustness checkpoint

## Protocol

Development-only characterization on the 20 tasks in `dev.jsonl`; the six held-out tasks were not read by the evaluator. Each selector received the same first 100 source-file candidates after retrieval with a 1,000-item pool. `k=5`, seed 2026, three clean repetitions, and three deterministic shuffles were used per task. Each task also received clean/raw, raw-injected, and production-sanitized injected probes. Candidate summaries—not file contents—were supplied.

Injection displacement assigns an unselected target the censored rank 101. Positive values mean injection promoted the target. Token counts are provider-reported and are not directly interchangeable.

## Results

| Selector | Completed tasks | Failed calls | Repaired successful calls | Repeated top-1 agreement | Mean top-5 shuffle overlap | Clean gold top-1 | Shuffled gold top-1 | Raw displacement | Sanitized displacement | Mean call latency |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| System One Choice (`jev-1.13.0`) | 20/20 | 0 | 0 | 95.0% | 49.9% | 75.0% | 71.7% | 58.95 | 0.10 | 459 ms |
| strong listwise (`gpt-5.6-sol-2026-07-09`) | 20/20 | 0 | 0 | 96.7% | 91.3% | 85.0% | 85.0% | 0.00 | 0.00 | 6,958 ms |
| cheap listwise (`DeepSeek-V4-Flash`) | 6/20 | 14 | 1 | 94.4%* | 66.9%* | 16.7%* | 50.0%* | 0.00* | 0.00* | 2,908 ms* |

`*` DeepSeek metrics are descriptive only for the six completed tasks and are not paired 20-task estimates. Fourteen tasks terminated after bounded decode repair, usually because the model emitted unknown candidate IDs; two emitted the wrong ranking length. Failed attempts consumed 123,383 input and 2,281 output tokens in addition to completed-task usage.

Choice used 1,543,799 input and 265,534 output tokens across 180 calls. The strong listwise control used 1,410,476 input and 46,404 output tokens. Choice was about 15.2 times faster by observed per-call latency. The raw injection probe substantially promoted Choice's target, while the production sanitizer reduced mean displacement to 0.1 ranks. The strong control did not promote the injected target in this run. Choice lower-rank order stability was materially weaker than the strong control despite similar top-1 repeatability.

## Gate decision

- **System One Choice advances**, with its lower-rank order sensitivity and raw-summary vulnerability explicitly retained.
- **The strong generative control advances** and is the best S3 comparator.
- **DeepSeek does not advance**: 6/20 complete coverage fails the predeclared no-malformed/full-coverage gate. No fallback was used and prompts were not retuned.

The next experiment is a matched repeated development-only comparison of S0, System One Choice, and the strong listwise selector. End-to-end execution must preserve the 1,000-pool/source-only/100-candidate policy, coder, router, evaluator, budgets, seed, and repetition schedule. An explicit spend/admission plan is required before launching all 180 runs.

## Artifacts

- `characterize-choice-c100.jsonl`
- `characterize-strong-llm-c100.jsonl`
- `characterize-deepseek-c100.jsonl`
