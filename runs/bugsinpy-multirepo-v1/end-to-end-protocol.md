# Predeclared development end-to-end protocol

This protocol was frozen after offline selection and robustness characterization and before running any end-to-end arm.

## Coverage

- Dataset: exactly the 20 tasks in `dev.jsonl`
- Held-out data: `test.jsonl` remains untouched
- Repetitions: 3 per task
- Schedule seed: 2026
- Required paired coverage: 60 completed runs per arm; comparisons reject incomplete coverage

## Arms

1. S0 (`none`): no selected initial file
2. System One Choice (`jev-1.13.0`), `k=1`
3. Strong S3 listwise (`gpt-5.6-sol`), `k=1`

DeepSeek is excluded because it completed only 6/20 tasks in robustness characterization and failed the full-coverage/no-malformed gate.

## Fixed controls

- Candidate retrieval pool: 1,000
- Candidate kinds: source `file` only
- Candidate envelope: first 100 after filtering
- Selection budget: 1 item / 100,000 approximate tokens
- Presented initial context ceiling: 2,000 tokens
- Dynamic context ceiling: 8,000 tokens
- Coder: `gpt-5.6-sol`
- Router: plugin's unchanged rules-based coding protocol
- Max steps: 30
- Max coder reasoning tokens: 100,000
- Wall-clock cap: 900,000 ms
- Task-specific pinned BugsInPy images, visible tests, evaluator, tools, and snapshots: unchanged

Unknown dollar pricing is not interpreted as zero resource use. Provider usage, selector latency, coder usage, steps, context, wall time, authoritative result, errors, and escapes must be retained. A full launch requires explicit operator approval because 180 coder runs at the 100,000-reasoning-token cap are possible.

## Configurations

- `configs/development/bugsinpy-multirepo-v1-s0-r3.json`
- `configs/development/bugsinpy-multirepo-v1-choice-r3.json`
- `configs/development/bugsinpy-multirepo-v1-strong-s3-r3.json`
