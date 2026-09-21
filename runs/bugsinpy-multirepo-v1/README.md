# BugsInPy multi-repository checkpoint v1

Qualified at BugsInPy metadata revision `11c5f1eea954a42132cfd06bf257766a7963e0fd`.

## Protocol

- Task type: `T-fix`
- Qualification: visible test fails before and passes after the official source patch
- Consolidated split: SHA-256 deterministic splitter, seed `2026`, test fraction `0.25`
- The per-batch provisional splits were discarded before consolidation.
- The six-task test file was held out through development, then opened once under the frozen protocol documented in `heldout-result.md`.
- Held-out outcomes must not be used for selector or prompt tuning.
- This checkpoint is small-sample experimental evidence, not a scientific benchmark estimate.

## Counts

| Repository | Valid | Development | Held out |
|---|---:|---:|---:|
| fastapi | 3 | 2 | 1 |
| thefuck | 2 | 2 | 0 |
| tornado | 7 | 5 | 2 |
| youtube-dl | 14 | 11 | 3 |
| **Total** | **26** | **20** | **6** |

The absence of TheFuck tasks from the held-out partition is an explicit limitation of this small deterministic checkpoint.

## Artifact hashes

- `validated.jsonl`: `9f0c35b7f2d4d787370dec9ed4a2d8e0e6ea95c017b4c3bc747b55a39fa06d92`
- `dev.jsonl`: `a568ad170044a73333f98aeee8c1c755e0dc2f30a45f30e7d0bedce1f025b3db`
- `test.jsonl`: `dfe88e0b3b8209fb6666b6369a6a1bc2445e04101c8e40e96f71d45b1cddff24`

## Qualification batches

Raw fail-before/pass-after evidence is retained in:

- `runs/bugsinpy-multirepo-20-validation.jsonl`
- `runs/bugsinpy-stdlib-11-validation.jsonl`
- `runs/bugsinpy-compatible-expansion-24-validation.jsonl`
- `runs/bugsinpy-thefuck-8-validation.jsonl`

The pinned execution images are recorded in each task's opaque source metadata. No Black task from the prior pilot or frozen split is included.

## Evidence

- `selection-checkpoint.md`: equal-envelope offline localization results.
- `robustness-checkpoint.md`: repeated/order/injection characterization. Choice and the strong generative control advanced; DeepSeek failed complete coverage.
- `end-to-end-protocol.md`: frozen matched three-arm protocol.
- `end-to-end-development-result.md`: 180-run development result. S0 passed 44/60, Choice 45/60, and strong S3 46/60; uncertainty intervals overlapped zero.
- `heldout-result.md`: one-shot six-task held-out result. All three arms passed 6/6, so accuracy saturated; selectors reduced steps and tool use but increased coder tokens.

No selector characterization used `test.jsonl`. The held-out file was opened only after development interpretation and held-out configurations were frozen.
