# Looper

Looper is an experimental, provider-neutral evaluation harness for testing whether typed decision models improve coding-agent context selection, routing, repair accuracy, latency, token use, and exploration.

It is research infrastructure—not a production coding agent and not a claim of benchmark superiority.

## What it provides

- Provider-neutral contracts for decision models, reasoning models, selectors, routers, workspaces, tools, snapshots, and evaluators.
- Deterministic experiment scheduling, canonical manifests, JSONL evidence, bounded retries, usage accounting, replay, and paired reports.
- A closed coding loop with bounded `read_file`, `write_file`, exact `replace_text`, `search`, and `run_tests` tools.
- Strict separation between visible stopping signals and authoritative evaluation.
- Optional local, Docker/Git, BugsInPy, SWE-bench, TypeSafe System One, OpenAI, Azure OpenAI, and OpenAI-compatible adapters.
- Transactional selection artifacts and retained malformed, failed, repaired, and over-budget attempts.

The core does not prescribe Git, a parser, an index, search, a sandbox, a model provider, repository tooling, or hidden-test execution. Those concerns live behind injected plugin interfaces.

## Status

**Experimental alpha.** The current pilot is small and unevenly distributed across four repositories. Results are mixed and do not demonstrate statistical significance, broad generalization, production readiness, or better benchmark performance.

### Current multi-repository pilot

Twenty-six BugsInPy `T-fix` tasks qualified with fail-before/pass-after evidence: 20 development tasks and six initially held-out tasks.

#### End-to-end development runs

Each of the 20 development tasks was run three times. Values below are per-run means except wall time, which uses the median because seven retained Choice runs experienced host/provider stalls.

| Arm | Repairs | Coder tokens | Steps | Tool calls | Dynamic context | Median wall time |
|---|---:|---:|---:|---:|---:|---:|
| S0, no initial selection | 44/60 | 39,161 | 10.13 | 9.12 | 17,388 chars | 28.3 s |
| System One Choice | 45/60 | 36,989 | 7.52 | 6.52 | 16,174 chars | 32.5 s |
| Strong generative S3 | 46/60 | 44,292 | 8.45 | 7.43 | 16,120 chars | 34.5 s |

Relative to S0, Choice used 5.5% fewer coder tokens, 25.8% fewer steps, 28.5% fewer tool calls, and 7.0% less dynamically loaded context. The repair difference was not conclusive: paired uncertainty intervals overlapped zero. Seven Choice runs that crossed the wall-time budget after host/provider stalls remain counted as failures and were not rerun.

#### Final evaluation on six separately held tasks

These tasks were opened once after the configurations and interpretation were frozen.

| Arm | Repairs | Coder tokens | Steps | Tool calls | Dynamic context | Mean wall time |
|---|---:|---:|---:|---:|---:|---:|
| S0, no initial selection | 6/6 | 16,962 | 9.33 | 8.33 | 12,990 chars | 32.49 s |
| System One Choice | 6/6 | 25,145 | 6.67 | 5.67 | 11,431 chars | 31.88 s |
| Strong generative S3 | 6/6 | 25,760 | 6.83 | 5.83 | 11,137 chars | 34.07 s |

Accuracy saturated at 6/6 for every arm. Choice used fewer steps, tools, and dynamic context than S0, but 48.2% more coder tokens. Six tasks are too few to establish an accuracy, latency, or token winner.

#### File-selection checkpoint

When selecting one relevant file from 100 candidates, Choice and the strong generative selector each selected a gold file on 16/20 development tasks. Choice took a mean 486 ms per selection versus 3,095 ms for the strong selector—about 6.4× lower selector latency. This is selection latency, not end-to-end agent speed.

Provider-reported token counts are not necessarily comparable across providers. Selector usage must also be included in any total-token analysis, and incomplete pricing prevents a defensible dollar-cost comparison.

Read the full limitations and protocols:

- [`runs/bugsinpy-multirepo-v1/README.md`](runs/bugsinpy-multirepo-v1/README.md)
- [`selection-checkpoint.md`](runs/bugsinpy-multirepo-v1/selection-checkpoint.md)
- [`robustness-checkpoint.md`](runs/bugsinpy-multirepo-v1/robustness-checkpoint.md)
- [`end-to-end-development-result.md`](runs/bugsinpy-multirepo-v1/end-to-end-development-result.md)
- [`heldout-result.md`](runs/bugsinpy-multirepo-v1/heldout-result.md)

Raw events, model responses, snapshots, task patches, and machine-specific datasets are intentionally not published by default. Reports include hashes of retained experimental artifacts.

## Requirements

- Node.js 20 or newer
- npm
- Docker only for Docker-backed repository or benchmark adapters
- No credentials for the local smoke

## Install and verify

```sh
git clone <repository-url> looper
cd looper
npm ci
npm run check
npm test
npm run build
```

## Zero-credential smoke

```sh
npm run smoke:local
```

The smoke qualifies a synthetic `T-fix` task, runs four offline selection arms, executes one scripted repair, performs authoritative evaluation, builds routing replay cases, and prints reports. It writes generated artifacts under ignored `runs/` paths.

The local adapter executes trusted command arrays directly. It demonstrates orchestration, not hostile-code isolation or model quality.

## CLI examples

```sh
# Mine candidates with the default optional Git adapter
npm run cli -- tasks mine /path/to/repository 100

# Run local selection baselines
npm run cli -- eval selection tasks/dev.jsonl bm25
npm run cli -- eval selection-sweep tasks/dev.jsonl configs/selection-sweep.example.json

# Summarize and compare complete event logs
npm run cli -- report summary runs/arm.jsonl
npm run cli -- report compare runs/baseline.jsonl runs/arm.jsonl

# Build and evaluate objective routing replay cases
HARNESS_PLUGIN=examples/local-smoke-plugin.ts \
  npm run cli -- replay build runs/local-smoke-events.jsonl runs/local-smoke-tasks/validated.jsonl
HARNESS_PLUGIN=examples/local-smoke-plugin.ts \
  npm run cli -- replay evaluate runs/routing-cases.jsonl rules
```

Run `npm run cli -- help` for the complete command list.

## Plugins

Set `HARNESS_PLUGIN` to a module exporting a `HarnessPlugin`. See:

- [`src/core/plugins.ts`](src/core/plugins.ts) for contracts.
- [`examples/plugin.ts`](examples/plugin.ts) for a skeleton.
- [`examples/local-smoke-plugin.ts`](examples/local-smoke-plugin.ts) for the credential-free fixture.
- [`examples/docker-git-plugin.ts`](examples/docker-git-plugin.ts) for isolated Git worktrees.
- [`examples/bugsinpy-plugin.ts`](examples/bugsinpy-plugin.ts) and [`examples/swebench-plugin.ts`](examples/swebench-plugin.ts) for benchmark adapters.

Evaluation code receives capabilities by dependency injection. Candidate and snapshot IDs are opaque. Only privileged workspace, qualification, snapshot-scoring, and evaluator capabilities receive complete task records; model-visible components receive sanitized tasks without gold patches or hidden-test provenance.

## Provider setup

Credentials are accepted only through environment variables. Inline API keys are rejected. Copy `.env.example` to `.env` if desired; `.env` is ignored. The CLI loads an existing root `.env` without overriding already-exported values.

```sh
cp .env.example .env
# Edit locally; never commit this file.
```

Provider examples:

- [`configs/openai-agent.example.json`](configs/openai-agent.example.json)
- [`configs/azure-openai-agent.example.json`](configs/azure-openai-agent.example.json)
- [`configs/openai-compatible-agent.example.json`](configs/openai-compatible-agent.example.json)

Replace placeholder endpoints and prices, then export the configured credential variable:

```sh
export OPENAI_API_KEY=...
HARNESS_PLUGIN=examples/docker-git-plugin.ts \
  npm run cli -- eval agent tasks/dev.jsonl configs/my-agent.json
```

Unknown pricing is not treated as free usage. Token usage is still recorded; configure pricing and spend caps before substantial online experiments.

### TypeSafe System One

The TypeSafe adapter reads `TYPESAFE_API_KEY` and defaults to the configured model ID `jev-1.13.0`. Models and providers are configuration, not architectural concepts. Live characterization commands consume provider capacity:

```sh
export TYPESAFE_API_KEY=...
npm run cli -- characterize smoke
```

## Repository execution

The generic Docker/Git adapter requires a full digest-pinned image reference. It runs command arrays without a shell, disables networking, uses a read-only container root, drops capabilities, enables `no-new-privileges`, limits CPU/memory/PIDs, bounds output, and exposes only the worktree as writable.

Docker is still a shared-kernel boundary. Execute actively hostile repositories on a disposable VM with platform-specific policy. Snapshot stores and worktrees must remain outside source repositories and must not be published.

See [`configs/docker-git-repository.example.json`](configs/docker-git-repository.example.json) and [`configs/docker-git-agent.example.json`](configs/docker-git-agent.example.json).

## Task semantics and evidence

- `T-fix`: the agent sees a failing test; clean visible tests permit stopping.
- `T-issue`: the agent sees an issue; a successful edit permits submission, while an injected evaluator determines success.
- Future task types must be reported separately.

Qualification occurs before deterministic splitting and requires fail-before/pass-after evidence. Gold files, reference patches, hidden tests, and authoritative outcomes are privileged and never enter live model context. Scientific paired comparisons require identical task and repetition coverage.

The current BugsInPy corpus metadata and raw event files are not tracked because generated records include privileged patches, copyrighted test content, provider responses, or machine-specific paths. Sanitized aggregate reports and hashes are tracked instead.

## Architecture and design

- [`DESIGN.md`](DESIGN.md): original build specification and architectural rationale.
- [`docs/decision-log.md`](docs/decision-log.md): implementation decisions.
- [`CONTRIBUTING.md`](CONTRIBUTING.md): contribution and evidence rules.
- [`SECURITY.md`](SECURITY.md): security model and vulnerability reporting.

## Known limitations

- The corpus is small, unbalanced, and limited to four repositories.
- The six-task held-out split contains no TheFuck task and saturated at 6/6 in all arms.
- Provider token accounting is not necessarily comparable across providers.
- Dollar comparisons are unavailable where prices are unknown.
- Routing has not advanced to online System One evaluation.
- The included official SWE-bench integration has only been smoke-tested with a gold patch; it is not an agent benchmark result.
- Process-level resumability and partial-failure exit behavior need additional hardening.

## License

[MIT](LICENSE)
