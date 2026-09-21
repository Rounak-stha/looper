# BugsInPy Black development configuration decision

Date: 2026-09-21

Only the two development tasks were used for this decision.

| Arm | Tasks passed | Pass rate | Mean reasoning tokens | Mean initial context tokens | Mean dynamic context chars |
|---|---:|---:|---:|---:|---:|
| S0, dynamic retrieval | 2/2 | 1.00 | 62,185 | 0 | 26,669.5 |
| BM25, 6k initial budget | 1/2 | 0.50 | 100,584 | 3,975.5 | 26,922.5 |

The S0 arm is selected because it passed both development tasks while BM25 broke `bugsinpy-black-1`, and it used fewer reasoning tokens and no initial file payload. The protocol and execution configuration is frozen before evaluating `runs/bugsinpy-pilot-tasks/test.jsonl`.

Frozen behavior:

- no selected initial file content;
- all candidate paths remain in the dynamic manifest;
- bounded, line-addressable reads;
- search results include bounded matching-line excerpts;
- exact unique `replace_text` edits with hashed/redacted durable arguments;
- visible-test completion policy;
- 8,000-token dynamic-context ceiling;
- 100,000-token reasoning-session ceiling;
- one repetition per task, seed 7.
