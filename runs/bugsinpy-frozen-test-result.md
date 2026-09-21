# BugsInPy Black frozen test result

Date: 2026-09-21

Configuration: `configs/bugsinpy-azure-test-frozen-v1.json`
Evidence: `runs/bugsinpy-azure-test-frozen-v1-events.jsonl`

The configuration was selected using only `bugsinpy-black-1` and `bugsinpy-black-2`. The three-task frozen test split was then run once without tuning.

## Result

- authoritative pass rate: 2/3 (66.7%)
- visible pass and safe stop: 2/3
- mean initial context: 0 tokens
- mean reasoning tokens: 60,470.3
- mean dynamic context: 29,736.3 characters
- mean steps: 12.7
- infrastructure errors: 0

Per task:

- `bugsinpy-black-3`: passed, 10 steps, 38,521 reasoning tokens
- `bugsinpy-black-4`: failed by the frozen 100,000-token session budget after 17 steps; no successful edit was made
- `bugsinpy-black-5`: passed, 11 steps, 40,140 reasoning tokens

This is a very small pilot and not a scientific benchmark estimate. The test outcome must not be used to retune this frozen pilot configuration. Subsequent protocol or policy changes require a new version and a new benchmark split.
