# Linear → Slack sections

A fresh Bun and TypeScript implementation that creates configured issue/project channels and reconciles them into **one user's native Slack sidebar sections** as Linear statuses change. Zero runtime npm dependencies. Persistent SQLite bindings, dry-run defaults, operation caps, readback verification, and an offline demo are included.

**Channel creation uses Slack's supported Web API. Personal sidebar movement uses undocumented `users.channelSections.*` methods. Live compatibility has not been tested.** This is experimental local software, not a supported OAuth-only integration. Read [RESEARCH.md](RESEARCH.md) and [SECURITY.md](SECURITY.md) before considering live use. Nothing is installed into Slack or Linear by building or testing this repository.

## Try it locally

Requires Bun 1.3 or newer; verified here with Bun 1.4.4. Development dependencies are pinned in `bun.lock`.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run demo
bun run check
bun run start --help
```

The demo reads fictional [config](config.example.json) and [fixture data](fixtures/demo.json), prints six proposed operations, and uses no credentials or network. It keeps `Needs Leon`, `Awaiting`, and `Blocked` separate. Fixture mode refuses `--apply` and `--watch`.

The old executable implementation is replaced on this branch and preserved in Git history at `e611629`. This is a new implementation, not a translation of that code. Old JSON state/config is deliberately not imported automatically.

## Configuration

Copy `config.example.json` to an ignored local `config.json` and edit it. The example IDs are fictional. Only explicitly configured entities are managed, with a limit of 50 per config. There is no account-wide discovery, message scan, or shared-channel issue aggregation.

| Field | Meaning |
| --- | --- |
| `slack.teamId`, `slack.ownerUserId` | Exact workspace and sidebar owner; checked using session `auth.test` |
| `linearWorkspaceId` | Exact Linear organization UUID; checked in every snapshot |
| `maxChanges` | Required cap, 1–200, on planned section creates, channel creates, owner invites, and moves; not an HTTP-request quota |
| `pollIntervalSeconds` | 60–86400; default 300, used only with `--watch` |
| `sections` | Local keys pointing to `{ "id": "..." }` or `{ "name": "Exact name", "create": true }`; creation defaults to false |
| `mappings.issue`, `mappings.project` | Separate, exact case-sensitive Linear status name → section key maps |
| `entities` | `kind` (`issue`/`project`), `ref`, and exactly one channel binding |

Issue references can be identifiers such as `DEMO-1` or UUIDs; projects require UUIDs. Each snapshot is a single parameterized, aliased GraphQL query. Issues use `state.name`; projects use `status.name`. **Needs Leon** means Leon's input/action; **Awaiting** represents a third-party blocker; **Blocked** represents task dependencies. These are explicit workflow statuses configured by you, not inferred from descriptions, labels, or dependency graphs. Rename keys/status mappings to match the actual Linear workflow. Unknown or archived statuses/entities stop the entire preflight.

Channel binding examples:

```json
{ "id": "CEXISTING" }
{ "project": true }
{ "create": { "prefix": "linear", "private": true } }
```

`project:true` is project-only and reads current `Project.slackChannelId`. An absent project channel is an error, not permission to create one. Creation requires an explicit boolean `private`; `false` deliberately requests a public channel. Generated names contain prefix, kind, and a stable 20-hex identity hash; titles/status changes do not rename channels. Name collisions are never adopted automatically.

Multiple aliases resolving to one canonical Linear UUID are rejected before Slack access, even if their statuses agree. Two entities cannot control the same channel. Duplicate section names require an explicit section ID. Only sections used by current statuses can be created. Unmanaged channels remain untouched.

## Live execution interface

No live installation or activation was performed. The following commands describe the interface for a future, separately authorized compatibility test.

Inject secrets from a local password manager into the process environment. Do not put them in config, arguments, shell history, chat, logs, or committed files:

| Variable | Purpose |
| --- | --- |
| `LINEAR_API_KEY` | Read-only Linear API access to configured entities; sent as the raw API key |
| `SLACK_XOXC_TOKEN` | Approved session credential for the sidebar owner |
| `SLACK_D_COOKIE` | Raw matching `d` cookie value, without `d=` or other cookies |
| `SLACK_BOT_TOKEN` | Required whenever a `create` binding exists, including retries of already-created channels |

```sh
# Live read-only plan; requires deliberate acceptance of the internal API boundary
bun run start --config config.json --experimental-sidebar --dry-run

# Apply the configured changes once
bun run start --config config.json --experimental-sidebar --apply

# Continuously reconcile, only when explicitly started
bun run start --config config.json --experimental-sidebar --apply --watch
```

Both `--experimental-sidebar` and `--apply` are required for live mutations. No flags defaults to dry-run, and live sidebar reads also require the experimental flag. Dry runs open existing state read-only and create no state database or lock. `--watch` without apply repeats previews; every error stops watch. SIGINT/SIGTERM stop after the current reconciliation and wake an interval wait. No background service, hosted webhook endpoint, telemetry, or scheduler is installed.

A bot must authenticate to the same workspace; it needs permission to create/read/invite/read members for the requested public/private channel type. Common scopes include `channels:manage`, `channels:read`, `groups:write`, and `groups:read`; consult each method's current documentation and workspace policy. This program does not install an app, grant scopes, acquire credentials, join existing channels, or change Linear data. Existing-channel bindings require the sidebar owner to already be a member. The bot invites the owner only for creation-managed bindings.

## Reconciliation and recovery

Every run fetches fresh statuses and actual memberships. Manual moves of configured channels are deliberately corrected on the next apply, even without a status transition. Remove the binding or stop watch to preserve manual ownership. A move removes every observed source membership and inserts the destination. A fresh readback must show **exactly one destination membership** before `verifiedStatus` is stored. Readback permits three short consistency checks. Previously saved status is the last verified observation, not a promise about current Slack state.

Default database: `$XDG_STATE_HOME/linear-slack-sections/bindings.sqlite`, otherwise `~/.local/state/linear-slack-sections/bindings.sqlite`; override using `--state PATH`. Bindings use Slack workspace + sidebar owner + Linear workspace + kind + canonical UUID. Changing an issue reference from identifier to UUID therefore reuses its binding. SQLite uses full synchronous commits. New database and lock files use mode 0600, and new state directories use 0700. Use a trusted private local directory and a single shared state path for all instances managing the same sidebar. The exclusive adjacent `.lock` coordinates writers on that local filesystem; it is not a distributed lock. A crash leaves a lock: verify the process has stopped before removing it.

Before `conversations.create`, a durable pending intent saves the generated name. After receiving the created ID it is saved immediately, before channel/membership verification or invitation. An invite failure resumes using that ID. A lost/invalid creation response leaves a pending intent and **blocks future creation**, including after restart. Inspect Slack and the saved name; if creation completed, set an explicit `channel.id` to the verified channel and rerun. If it did not complete, a human must clear only that pending record after inspection. A name collision follows the same conservative recovery path.

Missing/inaccessible/archived saved channels, privacy mismatches, a changed native project channel, and a configured ID conflicting with saved state are errors. They never cause silent replacement or reattachment. Stop all writers, make a private backup, inspect the exact row in SQLite's `bindings` table, and reconcile that one row with the verified channel/config before rerunning. Do not delete the whole database to bypass a refusal: losing bindings may lead to collisions or extra channels. There is no archive/delete/uninvite/leave capability or automatic rollback.

There is no transaction spanning Slack and SQLite. Earlier verified moves, created sections, channels or invitations may remain if a later step fails. Preflight validates the whole snapshot, current channel bindings, mappings and budget before remote writes; concurrent Slack/Linear changes can still occur during execution. A newly required move after planning stops with `DRIFT` rather than exceeding the plan. A future poll corrects changes after the snapshot.

## Transport and compatibility

Destinations are fixed to `https://api.linear.app/graphql` and `https://slack.com/api/…`. Redirects are disabled; requests have a 20-second timeout and 8 MiB response limit. Read/idempotent transport failures and 500/502/503/504 retry at most four attempts with bounded backoff. Explicit HTTP 429 honors `Retry-After` up to 60 seconds; longer waits fail for a later run. Channel/section creation retries explicit 429 only; ambiguous network/5xx/invalid-response failures are never replayed automatically. Linear GraphQL errors, even with partial data and HTTP 200, block a snapshot.

Slack channel-member reads use cursor pagination. Internal section pagination has no verified contract: missing membership data, known nonempty cursors, pagination flags, inconsistent counts, or duplicate identities fail closed. Absence of such markers is accepted only for the specific tested shape; it cannot prove that an undocumented server never truncates silently. Enterprise Grid routing, Slack Connect behavior, organization policy, paid-plan eligibility, current session authentication, and actual internal endpoint schemas remain **unverified live**. No bot scope is claimed to grant personal-section writes. Slack may change these methods without notice.

See [docs/VALIDATION.md](docs/VALIDATION.md) for the verified local results and coverage. All tests use in-process fake API responses, fictional credentials and temporary local state. They do not establish live Slack compatibility.
