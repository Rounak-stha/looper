# Decision log

## 2026-09-21 — BugsInPy visible-test pilot

- Added a BugsInPy importer that maps public bug metadata to `T-fix` while reusing the hardened Docker/Git execution boundary.
- Visible tests are the benchmark-provided relevant tests. Test changes and fixtures from the fixed revision are applied at the buggy revision before fail-before/pass-after qualification.
- Historical dependency environments are represented by project/pilot-specific digest-pinned images rather than guessed by core code or installed at test time.
- The first frozen pilot contains Black bugs 1–5. All five demonstrated fail-before/pass-after under the pinned Python 3.8 image; this is integration evidence, not yet the 80-task scientific pool.

## 2026-09-21 — Language-neutral repository intelligence and separate SWE-bench track

- `T-fix` describes the information available to the agent (a visible failing test), not a programming language.
- Added a parser-free filesystem context provider covering common Python, Rust, Go, Java, C/C++, Ruby, PHP, and JS/TS source formats; specialized language indexes remain optional plugins.
- SWE-bench Verified records are represented as `T-issue`, because the issue is visible while deciding tests are hidden. Their pass rates must remain separate from `T-fix` results.
- Official SWE-bench scoring is delegated to the upstream containerized evaluator. Local approximations must not be described as official results.
- Online `T-issue` execution remains gated on an explicit completion policy rather than weakening the visible-test stop invariant used by `T-fix`.

## 2026-09-19 — Build started

- Adopted `DESIGN.md` Build Spec v0.2.
- Runtime: TypeScript on Node.js 20+ using direct HTTP `fetch` for TypeSafe's System One API, avoiding known SDK validation gaps.
- The typed decision-model abstraction is provider/model neutral. The TypeSafe provider is configured with the pinned model `jev-1.13.0`; the local default estimated input limit is 30,000 tokens.
- Gates G0–G4 retain the proposed values in the design and are not yet frozen.

## 2026-09-19 — Initial live System One characterization

- T1 passed: Noul, Choice, and Score response shapes matched the expected API shape and the resolved model was `jev-1.13.0`.
- T3, 20 uncached concurrent repetitions: outputs were not byte-identical. Maximum observed spreads were Noul 0.01, Choice option probability 0.04, and Score 0.03. Threshold stability still needs evaluation on task-like questions.
- T4, five order shuffles at N=50: mean top-5 overlap was 1.0, passing the proposed ≥0.8 condition on synthetic candidates.
- T4 latency was 356–427 ms (p50 392 ms). The concurrent T3 batch showed 1.22–2.45 s per request, so concurrency/load materially affects observed latency.
- The chars/4 estimator predicted 1,438 tokens where the provider reported 2,034 (29% low). Added a temporary 1.6 safety factor, yielding a conservative estimate, pending T2 calibration.
- T5 synthetic scaling at N={10,30,100,255}: the same four genuinely authentication-related candidates occupied the first four ranks at every N; latency was 412–464 ms and reported input grew from 634 to 9,674 tokens. The synthetic fixture contains a fifth broadly related user-model candidate that did not enter top-5, so measured relevant recall@5 was 0.8 at every N.
- T6 raw, unsanitized injection targeted an irrelevant candidate at N=50. It remained rank 49 with probability 0, for zero upward displacement. Production summaries additionally sanitize control-like phrases.
- The estimator safety factor now predicts 2,301 tokens for the N=50 request versus 2,034 reported (13% conservative).
- Synthetic G0 conditions pass: N=50 format works, order overlap is 1.0, and injection displacement is zero. Keep G0 provisional until these checks are repeated on mined repository candidates.

## 2026-09-19 — Decision-model abstraction correction

- Removed the model-specific `src/jev` architectural boundary.
- Added the provider-neutral `DecisionModel` interface and shared typed question/result contracts under `src/decisions`.
- TypeSafe System One is now an adapter at `src/decisions/providers/typesafe-system-one.ts`.
- `jev-1.13.0` exists only as a configured model id; callers and characterization code depend on `DecisionModel`, not Jev.

## 2026-09-19 — Phase 1/2 foundation

- Added a local Git commit miner for TS/JS commits that modify 1–5 source files, modify/add tests, and stay under the changed-line cap.
- Mined task text intentionally excludes commit messages and patch content. Source and test patches remain ground-truth fields only.
- Added deterministic dev/test splitting and JSONL output. Containerized fail-before/pass-after validation remains outstanding.
- Added pre-patch context indexing, BM25 and heuristic selectors, oracle selection, decision-model Choice/Noul selection, token caps, and offline selection metrics.
- Offline evaluation always indexes `baseSha`, not the fix commit.

## 2026-09-19 — Repository intelligence boundary correction

- Removed the custom Git-backed context provider and hand-written BM25/tokenizer.
- Repository checkout/worktree lifecycle now belongs to `tasks/RepositorySnapshots` and delegates Git operations to `simple-git`.
- Context retrieval is a thin `ContextProvider` adapter over `MiniSearch`; BM25 selection also delegates scoring to MiniSearch.
- Deterministic TS/JS summaries delegate parsing and AST traversal to `ts-morph`.
- Context code receives a materialized pre-patch workspace and has no knowledge of Git commits.

## 2026-09-19 — Fully pluggable repository capabilities

- Harness core now defines `TaskSource`, `WorkspaceProvider`, and `ContextProviderFactory`; evaluation receives a `HarnessPlugin` by dependency injection.
- Task source provenance is opaque `{kind, data}`. Only privileged workspace, validation, snapshot-scoring, and authoritative-evaluation capabilities receive full task records. Context, selector, tool, and agent-controller factories receive a sanitized `AgentTask` without source, gold files, test files, or gold artifacts.
- Git, MiniSearch, and ts-morph integrations moved under `src/plugins/default` and are optional CLI fallbacks, not harness policy.
- External plugins are dynamically loadable through `HARNESS_PLUGIN`; `examples/plugin.ts` documents the contract.
- Selector factories are also optional plugin capabilities. The evaluator does not import or enumerate BM25, heuristic, parser, index, or VCS implementations. Only the oracle selector remains intrinsic because it is an evaluation control over gold labels.
- Validation and agent tool execution are capabilities too. Plugins own isolation, commands, files, searching, and snapshots; core consumes structured results.
- Dynamic read/search results are exposed through a separate context channel with a configured conservative token allowance. Full tool output is not copied into event logs; logs retain SHA-256, original size, retained-context size, and truncation status.

## 2026-09-19 — Phase 3 core foundations

- Added provider-neutral reasoning-model and static role-to-tier interfaces.
- Added append-only spend ledger, required token prices, pre-call cap checks, and serialized writes.
- Added common JSONL run-event envelope and logger.
- Added session step/token/wall-clock budget enforcement.
- Added deterministic feasible-action rules and a decision-model router. Stop requires both passed-clean tests and a thresholded completion Noul; errors and low-confidence decisions fall back to reasoning.
- Added a minimal agent loop and one-task runner composed entirely from injected workspace, context, selector, router, reasoner, action-planner, tool-runtime, and event-sink capabilities.
- Routed retrieval/read actions use a closed `ActionPlanner`; they cannot silently become arbitrary reasoner tool calls. A reasoner's `done` hint cannot bypass the router stop gate.
- Added provider-neutral run aggregation and objective routing replay metrics for false-stop, false-continue, missed-retrieval, invalid-decision, and fallback rates. Snapshot evaluation and replay-router construction are optional plugin capabilities, keeping hidden execution and provider setup outside core.
- Separated agent termination (`agent_end`, based on visible state) from authoritative task scoring (`run_end`, supplied by a plugin `TaskEvaluator`). Hidden evaluation rather than the agent's own completion signal now owns recorded pass/fail.
- The loop independently rejects router actions outside its code-computed feasible set and records snapshots after direct test actions.
- Added a metered `ReasoningModel` to `CodingReasoner` bridge with an injected request/response codec. The default codec accepts only validated JSON decisions and the closed coding tool set; model usage feeds both the spend ledger and session token budget.
- Added deterministic experiment scheduling and run IDs, repeated runs, admission checks, per-run dollar caps, pre-run affordability planning, and paired bootstrap/fixed-broke reporting.
- Added explicit G0–G4 predicates, baseline-repeat noise-floor estimation, calibration reliability/risk-coverage analysis, offline selection summaries, and task-level reporting dimensions.
- Added provider-neutral decision-model metering into the shared spend ledger. Budget exceptions propagate through decision routing and are recorded as budget terminations rather than silently falling back.
- Candidate IDs remain opaque through selection and metrics; gold-file scoring resolves IDs through candidate paths, and only concrete file paths enter the agent's escape manifest.
