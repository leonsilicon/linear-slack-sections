# Local validation

Verified on 2026-11-09 on macOS arm64 using Bun 1.4.4 (`38afee6c8`), TypeScript 5.9.3 and Biome 2.3.5. Runtime code is all TypeScript and Bun built-ins. No live Slack/Linear credentials or account changes were used.

| Check | Result |
| --- | --- |
| `bun run typecheck` | Passed with strict, unchecked-index and exact-optional checks |
| `bun run lint` | Passed, no errors or warnings |
| `bun test` | 65 passed, 0 failed, 213 assertions across 4 test files |
| `bun run build` | Passed; 9 modules bundled into `dist/cli.js` for Bun |
| Built CLI + offline demo fixture | Passed; 6 proposed operations, no state writes |
| `bun run start --help` | Passed |
| `git diff --check` | Passed |

The checked-in [offline plan](../artifacts/demo-plan.json) shows separate moves into `Needs Leon`, `Awaiting` and `Blocked`, plus a private channel creation, its owner invitation, and one missing section creation. Every ID is fictional. Build output is ignored and reproducible with `bun run build`.

Tests cover:

- Exact duplicate config refs and identifier/UUID aliases of one canonical issue; no writes or Slack access on canonical duplicates.
- Shared-channel conflicts, unmapped status, operation caps, ambiguous section names and project status/channel bindings.
- Repeated status transitions and manual drift; unmanaged channels remain unchanged.
- Missing, archived, privacy-mismatched and conflicting saved bindings; no silent channel replacement.
- Creation intent persisted before request, created ID persisted before invite, invite retry without duplicate creation, pending intent blocking replay after restart, and explicit recovery binding.
- SQLite persistence, writer exclusion, read-only previews with no database/lock creation, restricted new-file permissions, namespace separation and state symlink refusal.
- Supported bot channel payloads versus internal user-session section payloads; all observed source removals plus destination insertion.
- Membership cursor pagination and loop rejection, incomplete internal membership response rejection, body limits, no redirects, bounded retries, Retry-After, and ambiguous-create refusal.
- Actual provider adapters through injected fake HTTP plus actual SQLite: create, invite, move, restart, idempotent repeat and a new status/section.
- A successful move response with no real move, and a partial move retaining a source membership, both fail readback without saving status success.
- A concurrent sidebar change requiring an operation absent from the plan stops with `DRIFT`.
- CLI experimental/apply gates, argument errors without input echo, offline mode and no credential dependency.

The first test pass detected a pagination-flag traversal defect in arrays; it was fixed and regression cases now pass. Typechecking also caught two test-table typing mistakes before final verification. No failing checks remain.

These are simulated provider/integration tests. They do **not** verify current Slack session acceptance, private endpoint availability, membership schema completeness, provider policy, workspace permissions, paid-plan eligibility, Enterprise Grid/Connect behavior, or live Linear access. No service was installed or started; no push, merge, publish or deployment occurred. See [RESEARCH.md](../RESEARCH.md) for current primary-source evidence and the limited in-flight-job lookup.
