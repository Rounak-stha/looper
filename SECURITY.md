# Security Policy

## Supported versions

Looper is an experimental alpha. Security fixes are applied to the latest revision; no older release line is currently supported.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting feature for this repository. If it is unavailable, contact the repository owner privately. Do not include live credentials, proprietary model responses, hidden benchmark material, or exploitable third-party repository contents in a public issue.

Include a concise description, affected revision, reproduction steps, impact, and any suggested mitigation. You should receive an acknowledgment within seven days, but this is not a service-level guarantee.

## Security model

Looper executes coding tasks and can invoke external model providers. Treat repositories, patches, model output, and candidate summaries as untrusted.

- Keep credentials in environment variables only. Never store them in JSON configuration, logs, task data, or commits.
- Review generated artifacts before publication. Raw events may contain provider output or task-derived material and are ignored by default.
- The generic Docker/Git adapter disables networking, uses a read-only root, drops capabilities, enables `no-new-privileges`, limits resources, and exposes only the worktree as writable.
- Docker is a shared-kernel boundary, not a complete defense against hostile code. Run untrusted repositories on a disposable VM with platform security policy.
- The local-smoke adapter runs trusted commands directly and is not a production sandbox.
- Official benchmark evaluators may use weaker isolation for compatibility. Their security posture is distinct from Looper's generic Docker adapter.
- Keep snapshot stores and worktrees outside source repositories and do not publish them.

## Out of scope

Provider availability, upstream benchmark infrastructure, and vulnerabilities in intentionally executed third-party projects should generally be reported to their respective maintainers unless Looper makes the issue exploitable across its stated boundary.
