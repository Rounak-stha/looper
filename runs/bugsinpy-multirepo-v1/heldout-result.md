# Multi-repository held-out result v1

## Scope

The six tasks in `test.jsonl` were opened once after the development protocol and interpretation were frozen. Each of S0, System One Choice, and strong S3 ran once per task with identical coder, router, evaluator, tools, candidate policy, context controls, and budgets. All arms completed 6/6 scheduled runs without protocol errors. The prior frozen Black split was not rerun.

## Results

| Arm | Authoritative pass | Mean coder tokens | Mean steps | Mean tool calls | Initial context | Dynamic context | Selector input/output | Selector latency | Mean wall time |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| S0 | 6/6 | 16,962 | 9.33 | 8.33 | 0 | 12,990 chars | 0 / 0 | 0 ms | 32.49 s |
| System One Choice | 6/6 | 25,145 | 6.67 | 5.67 | 2,000 tokens | 11,431 chars | 8,829 / 1,467 | 1,818 ms | 31.88 s |
| strong S3 | 6/6 | 25,760 | 6.83 | 5.83 | 2,000 tokens | 11,137 chars | 8,096 / 135 | 5,062 ms | 34.07 s |

All six tasks passed in all three arms, so this split cannot distinguish repair accuracy. The paired pass-rate difference is zero for both selectors versus S0.

Choice reduced steps by 28.6%, tool calls by 32.0%, and dynamic context by 12.0% versus S0, while preserving 6/6 accuracy and slightly reducing observed total wall time. However, Choice used 48.2% more coder reasoning tokens than S0 before adding selector tokens. Strong S3 showed a similar tradeoff and had higher selection latency.

Provider token counts are not directly interchangeable. Unknown configured prices yield zero recorded dollar cost and are not evidence of free usage.

## Interpretation

This is mixed, small-sample evidence:

- Initial selection was unnecessary for held-out repair accuracy because S0 also passed every task through dynamic retrieval.
- Both selection arms reduced interaction steps, tool use, and dynamically loaded context.
- Neither selection arm reduced coder reasoning tokens on this held-out sample.
- Choice was materially faster than strong S3 at selection and had the lowest observed total wall time, but only by 0.61 seconds versus S0.
- Six tasks, no TheFuck representation, and saturated outcomes do not support broad generalization or significance claims.

The result supports Looper's ability to run complete provider-neutral paired experiments and retain mixed findings. It does not establish that typed System One selection improves coding-agent repair accuracy or total token efficiency.

## Immutable evidence

Event SHA-256 hashes:

- Choice: `178d9d9ce0197668b2bd077ce6a41f93293356c171e193a487257c44dc61340b`
- S0: `8ed394230426bbde95366b22143889dae6ff86fa20c69891837442e8f9877684`
- strong S3: `9266173b70943c61479ea816ba83a2ba27051ee213e27dbb638bbba7fe775997`

Frozen held-out configuration SHA-256 hashes:

- Choice: `221b74ab76f9ddc3599b349ce5b87e5ea1fd0662545f600849981b7f945f2ba0`
- S0: `f403b2f18bb7260bf9ddbc1689eabbe0772f3380e6ecc5d5d0a705801a660bde`
- strong S3: `6dc67a0f325708a463e3c14b01e4f52bf34284116ee7ce5c8606c989329a00fa`
