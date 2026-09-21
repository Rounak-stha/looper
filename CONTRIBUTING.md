# Contributing to Looper

Looper is experimental evaluation infrastructure. Contributions that improve reproducibility, provider neutrality, safety, adapters, tests, or honest reporting are welcome.

## Development

Requirements: Node.js 20 or newer.

```sh
npm ci
npm run check
npm test
npm run build
npm run smoke:local
```

The local smoke requires no credentials and must remain offline and deterministic.

## Design constraints

Please preserve these boundaries:

- Core code depends on interfaces, not Git, parser, index, sandbox, benchmark, or model implementations.
- Credentials come only from named environment variables. Never put keys, authorization headers, or tokens in configuration or logs.
- Agents must not receive gold files, patches, hidden tests, authoritative outcomes, or privileged provenance.
- Candidate and snapshot IDs are opaque; do not infer paths from IDs.
- Visible tests govern safe stopping; injected evaluators determine authoritative success.
- Keep `T-fix`, `T-issue`, and future task types separate in reports.
- Retain malformed, failed, repaired, and over-budget calls as evidence. Do not silently fall back or discard unfavorable runs.
- Require identical task/repetition coverage for scientific paired comparisons.

See [`DESIGN.md`](DESIGN.md) and [`docs/decision-log.md`](docs/decision-log.md).

## Pull requests

1. Keep changes focused and add regression tests for behavioral changes.
2. Run the verification commands above.
3. Explain any protocol, schema, security-boundary, or reproducibility impact.
4. Do not include generated runs, repository checkouts, snapshots, caches, provider responses, or `.env` files.
5. Add only sanitized aggregate evidence after checking redistribution rights and removing machine-specific paths.

## Experimental results

Separate implementation fixes from result-driven tuning. Freeze protocols before held-out evaluation. Never rewrite or remove negative evidence to improve a claim. Claims should identify the task type, dataset, model IDs, coverage, repetitions, and limitations.

By contributing, you agree that your contributions are licensed under the MIT License in this repository.
