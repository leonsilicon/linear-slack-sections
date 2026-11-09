# Research and compatibility assessment

Rechecked 2026-11-09 for the fresh Bun/TypeScript implementation. The earlier report and implementation remain in repository history at `e611629`; their claims were used as leads, not as live compatibility evidence. No vendor was contacted and no live account was connected or modified.

## What already exists

**Linear's native Slack integration** documents automatic public channels for newly created projects, inviting project members and adding a project bookmark. This covers project-channel provisioning. Its documentation does not establish status-driven movement between a user's personal sidebar sections. [Linear Slack documentation](https://linear.app/docs/slack)

**Zapier** publishes an explicit New Issue → Create Channel template for Linear and Slack, so issue-channel creation is already available. Its current action catalog also shows channel creation. No personal-sidebar move action was verified in that catalog. [Issue-channel template](https://zapier.com/apps/linear/integrations/slack/255678655/create-new-slack-channels-for-every-new-issue-in-linear), [action catalog](https://zapier.com/apps/linear/integrations/slack)

**Slack custom sections** are personal organization on eligible paid plans. Slack documents manual channel movement and section sharing. Sharing a section is not continuous Linear-status reconciliation. The public `usergroups.update` API's `enable_section` concerns group/default-channel sections; it does not establish arbitrary movement within an individual user's existing personal layout. [Custom sections](https://slack.com/help/articles/360043207674-Organize-your-sidebar-with-custom-sections), [shared sections](https://slack.com/help/articles/29873996048019-Share-sidebar-sections-in-Slack), [usergroups.update](https://docs.slack.dev/reference/methods/usergroups.update/)

The recheck found no verified turnkey solution combining Linear status, channel provisioning and native personal-section relocation. This is a bounded finding, not proof that no private/unindexed/new solution exists. An open request in Slack's own skills-plugin repository asks for section listing and movement; a feature request is not an API guarantee. [Slack skills issue 193](https://github.com/slackapi/slack-skills-plugin/issues/193)

## Supported and undocumented APIs

**Supported:** Slack documents `conversations.create` for public/private channels, plus `conversations.info`, `conversations.members`, `conversations.invite` and `auth.test`. Creation is permission/policy dependent. Names accept lowercase letters, digits, hyphens and underscores, within 80 characters; our stable generated names fit. Member pagination and rate-limit handling follow the published interfaces. [Create](https://docs.slack.dev/reference/methods/conversations.create/), [info](https://docs.slack.dev/reference/methods/conversations.info/), [members](https://docs.slack.dev/reference/methods/conversations.members/), [invite](https://docs.slack.dev/reference/methods/conversations.invite/), [rate limits](https://docs.slack.dev/apis/web-api/rate-limits/)

**Undocumented:** The public method catalog has no documented `users.channelSections.*` contract. We independently inspected the primary source of `vendrinc/slack-sections-organizer` at commit `25f53fe456a3b9e66c59f3eb768458ed6a11bb79`: it demonstrates section listing/creation and `users.channelSections.channels.bulkUpdate`, with JSON-encoded insertion/removal arrays in form fields. That is evidence of an observed interface, not evidence that it works today in Leon's workspace. No source code from that project or the rejected implementation was copied. Its user-group routing, join/delete behavior and workspace-specific host were not adopted. [Pinned source](https://github.com/vendrinc/slack-sections-organizer/blob/25f53fe456a3b9e66c59f3eb768458ed6a11bb79/src/index.ts), [Slack method catalog](https://docs.slack.dev/reference/methods/)

The experimental adapter uses an injected approved user session, not a bot-only OAuth grant. It accepts only the explicitly validated membership shape and refuses visible pagination/truncation evidence. There is no verified undocumented pagination or Enterprise Grid routing implementation. Readback checks are essential but simulated tests cannot remove those compatibility limits.

**Linear:** Official GraphQL supports API-key authentication, canonical entity IDs, issue identifiers and partial-error responses. The current primary schema was checked for `Query.organization`, `Project.status`, `Project.slackChannelId` and `archivedAt`; status fetching uses one parameterized aliased query for the configured set, avoiding a per-issue polling request. A watch is a user-started polling fallback, not an installed webhook service. Linear recommends webhooks for production event-driven integration; that can be a later separately scoped design. [GraphQL](https://linear.app/developers/graphql), [schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql), [rate limiting](https://linear.app/developers/rate-limiting), [webhooks](https://linear.app/developers/webhooks)

## Duplication check and limits

Before implementation, the public repository had only `main` at `e611629a3f2b5489b678ef7104f262369aaadc5d`, with no open pull requests. Local checkout/worktree/file inspection found no Bun/TypeScript rewrite under the searched Codex/Developer paths. App task-history lookup did not return, Personal Context reported unavailable, and process inspection was restricted. Therefore an in-flight job elsewhere could not be categorically excluded. Work was isolated on `codex/bun-typescript-rebuild`; nothing was pushed or published.

One CLI's connection lookup failed with `fetch failed`. Public sources were inspected through the GitHub connector and web research. The public clone and pinned development dependency download required sandbox network escalation and succeeded. No auth/account changes were made.

## Acceptance boundary

Local tests establish planner/reconciler behavior, adapter payload generation, guardrails, persistence and recovery against fictional provider responses. They do not establish token acceptance, actual section schema/completeness, paid-plan eligibility, bot scopes, private-channel policy, Grid/Connect semantics or current provider behavior in the target workspace. Installation, credential provisioning and a limited live smoke test remain outside this task's authorization. Do not present this repository as activated or live compatible.
