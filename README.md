# Linear → Slack sections

A local-first Python 3.11+ CLI that reconciles **explicitly configured** Linear issues and projects to native, personal Slack sidebar sections. Original MIT implementation; zero runtime dependencies. It can optionally create channels with a bot token and invite the sidebar owner. It never scans all Linear entities or reads Slack messages.

**Experimental: Slack sidebar writes use undocumented `users.channelSections.*` endpoints. Tests are simulated integration/transport tests, not evidence of live Slack compatibility.** Custom sections require an eligible paid Slack plan and affect only the authenticated user's sidebar. Use only with your organization's approval.

## Install and run

From the checkout, no install is necessary:

```sh
python3 -m linear_slack_sections --help
```

Or install locally in your own virtual environment (setuptools is a build-only requirement, not a runtime dependency):

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --no-deps .
linear-slack-sections --help
```

Copy `config.example.json` to `config.json` with your local editor. All IDs in the example are fictional. Replace IDs and exact case-sensitive statuses; remove irrelevant bindings. Do not commit your actual config or credentials. Provide these environment variables through your local password manager or a non-logging secret-injection mechanism:

| Variable | Purpose |
| --- | --- |
| `LINEAR_API_KEY` | Linear read access to the explicitly named entities |
| `SLACK_XOXC_TOKEN` | Your approved Slack user-session `xoxc-…` token |
| `SLACK_D_COOKIE` | Raw value of the matching `d` cookie; **not** `d=…` or a whole Cookie header |
| `SLACK_BOT_TOKEN` | Optional `xoxb-…` bot token, required for `create_channel` and unfinished creation retries |

Do not paste credentials into chat, source files, shell command arguments/history, or public issues. The CLI does not extract credentials from browsers. See [SECURITY.md](SECURITY.md).

```sh
python -m linear_slack_sections --config config.json --dry-run
python -m linear_slack_sections --config config.json --apply
python -m linear_slack_sections --config config.json --watch --interval 60
python -m linear_slack_sections --config config.json --apply --watch --interval 60
```

Default is preview: network reads only, no channel/section creation, invitations, moves, state writes or lock files. Watch without `--apply` repeats previews. JSON output contains the proposed/applied operation list, never credentials or API bodies. Errors exit 1; Ctrl-C exits 0. Invalid arguments use argparse's exit 2. Any sync error stops watch rather than replaying a potentially ambiguous creation.

## Configuration

- `team_id` and `owner_user_id` must match session `auth.test`; an optional bot must belong to the **same** workspace. No cross-workspace routing or arbitrary API host configuration exists.
- `max_changes` is a required positive operation budget checked before writes. A section creation, channel creation (including its initial invite), retry invitation, and move each count as one plan operation. It is not a raw HTTP-request quota. Even unused configured sections may be created, and count toward this budget.
- `sections` maps exact Linear status names to `{"id":"SECTION_ID"}` or `{"name":"Exact section name","create":true}`. Name lookup refuses ambiguity. Without `create:true`, missing sections fail. Multiple statuses can target the same section. Unknown statuses fail the **whole sync** before any writes; no implicit status defaults.
- Each `entities` item has `type` (`issue` or `project`) and `id` (canonical UUID; issues may instead use an exact identifier such as `DEMO-1`). Only these entities are fetched using official `issue(id:)` / `project(id:)` GraphQL queries. Issues use `state.name`; projects use `status.name`.
- Exactly one binding mode: `channel_id`, project-only `use_project_channel:true` (reads `Project.slackChannelId`), or `create_channel:{"private":true,"prefix":"linear"}`. Creation requires an **explicit boolean** privacy choice; the supplied example uses private. Public creation requires deliberately setting `private:false`. Null project channel IDs fail; they do not trigger automatic creation.
- One channel cannot be controlled by multiple configured entities, even if their statuses currently agree. Shared-channel issue aggregation is intentionally unsupported.

### Reconciliation, creation and retries

`--apply` is explicit authorization to reconcile immediately, including the first run. Each poll fetches fresh statuses and section memberships, not a permanent handled-once ledger. **Manual moves of configured channels are deliberately undone on the next apply**, even without a Linear status transition. Remove a binding or stop the poller to preserve manual ownership. Unconfigured channels are untouched.

Moves include insertion into the destination and removal from every source section. After every move a complete membership readback must show the channel in the destination and nowhere else before status success is saved. Partial/paginated membership, nonempty cursors, pagination flags, missing membership data or inconsistent counts fail closed; this version does **not** attempt undocumented pagination. Large workspaces may therefore be unsupported rather than partially modified.

Created channel names are stable `PREFIX-TYPE-16HEX` values derived from team/type/Linear UUID, not mutable titles. Only explicit IDs or IDs already stored locally are reused. A name collision is an error, **never** permission to adopt an existing channel. The created ID is saved immediately before verification/invite, so a failed invite can retry without creating another channel. Readback checks the channel and owner membership (paginated). The bot needs appropriate public/private channel creation/manage and channel-info/member-read permissions; scopes and administrator policy must be confirmed for the target workspace (commonly `channels:manage`, `channels:read`, `groups:write`, `groups:read`). Existing-channel filing requires the session user already have access; the tool does not join channels.

Default state: `~/.local/state/linear-slack-sections/state.json`; override with `--state PATH`. State is namespaced by Slack team and entity type+configured identifier. Writes use same-directory atomic replacement and mode 0600 on POSIX. Apply holds an exclusive adjacent `.lock`; previews do not mutate it. Use one trusted private state path per workspace/owner and all workers. The lock is local-filesystem coordination, not distributed locking. A crash leaves a lock: verify the PID/worker has stopped before manually removing it. Back up state: losing it after channel creation causes a conservative collision refusal. Changing an issue from identifier to UUID changes its state key; migrate trusted state or bind its channel ID explicitly.

There is no transaction across Slack operations. Earlier verified operations/created channels may remain after a later error; retry reconciles actual state. An ambiguous network error during creation is **not automatically retried**: inspect Slack and explicitly bind any created channel before rerunning. A lost section-create response can be resolved by its unique name next run. No archive, delete, leave, read-marking, message access, or Linear writes exist.

## Network and compatibility limits

Only `https://api.linear.app/graphql` and `https://slack.com/api/…` are used. Redirects are refused to protect credentials. Requests time out after 20 seconds. Reads/idempotent operations retry transient network failures and HTTP 500/502/503/504 at most four total attempts. HTTP 429 honors numeric `Retry-After`, up to 120 seconds per wait (longer waits fail). Creation retries only explicit 429 responses, not ambiguous network/5xx failures. Errors omit remote response bodies and secrets. Response size is bounded to 8 MiB.

Enterprise Grid organization-level sessions, alternative Slack routing hosts, Slack Connect edge cases, membership capacity and organization policies are **not live-verified**. The CLI intentionally has no Grid routing workaround; a failed identity/list/readback stops safely. Slack can change undocumented methods or membership schemas at any time; empty cursor + no pagination indication is treated as complete only for the supported response shape. Slack's own auto-organizing preferences or other organizers may conflict. This is not an official Slack/Linear integration and does not link newly created channels back into Linear.

## Development and verification

```sh
python -W error -m unittest discover -s tests -v
```

Tests use in-process fake transports/adapters with fictional data. CLI tests exercise real config parsing, official-client query generation, Slack form encoding, preview/apply/watch, actual temporary state files, and readback; HTTP tests inject an opener to simulate 429/network/redirect behavior. No credentials, live account writes, or external test services are required. GitHub Actions is not configured in this repository: the publishing integration cannot write workflow files. Local execution was verified on Python 3.13 and 3.14; Python 3.11 and 3.12 remain unverified.

Public API-behavior references (not copied source): [Linear GraphQL](https://linear.app/developers/graphql), [Linear schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql), [Slack custom sections](https://slack.com/help/articles/360043207674-Organize-your-sidebar-with-custom-sections), [Slack conversations.create](https://docs.slack.dev/reference/methods/conversations.create/). Section payload behavior was researched in public implementations; undocumented means unsupported, regardless of test coverage.
