# Research: Linear status → Slack channels and native sidebar sections

Research conducted 2026-11-09. This report separates provisioning a channel from moving it within a user's actual Slack sidebar. Notifications, visual DOM grouping, and Enterprise workspace moves are not equivalent to native personal section assignment.

## Conclusion

No turnkey, publicly discoverable integration covering both Linear status and automatic native personal-sidebar relocation was found in this multi-pass search. This is not proof that a private, unindexed, or newly released solution cannot exist. Ready-made solutions cover channel creation; several open-source tools already demonstrate native section movement without a Linear status adapter.

## Native and no-code solutions

- **Native Linear:** automatically creates public Slack channels for new projects, invites project members, adds a project bookmark and synchronizes project renames. Its documentation does not describe moving the channel between personal sidebar sections as status changes.[1]
- **Zapier:** an explicit `New Issue → Create Channel` template creates one channel per Linear issue. Channel creation is therefore not a missing capability. No verified native sidebar-move action was found.[8]
- **Make, n8n, Pipedream:** reviewed action catalogs support Slack channel creation and other lifecycle operations, but no arbitrary personal-sidebar movement action was identified. n8n's Slack node and Pipedream's integration catalog are linked for reproducibility.[9][10]
- **Slack shared sections:** `usergroups.update` exposes `enable_section`, an important supported exception. It concerns user-group sections/default channels, not a general personal-sidebar move API. It is not evidence of reliable status-driven migration that overrides a user's existing organization.[7]
- **Slack personal sections:** paid-plan and per-user. Moving a channel in one person's sidebar does not reorganize every coworker's view.[3]
- **Relay.app:** its live homepage reports closure; old tutorial results should not be treated as a currently deployable recommendation.[11]

## Open-source and browser-tool candidates

The research inspected repository metadata, READMEs and selected actual source/license files. Code-level support is not a live compatibility test.

- **fguinez/slack-incident-sections** — MIT. Closest functional architecture: reads incident status and moves channels between active/resolved native sections, with dry runs, state tracking and scheduling. It has no documented Linear adapter. Particularly useful reference for source-removal plus destination-insertion payloads.[4]
- **vendrinc/slack-sections-organizer** — BSD-3-Clause. TypeScript section creation/movement based on user groups; not Linear status. Inspect hardcoded workspace routing and optional join/delete behavior before reuse.[5]
- **ewilderj/slack-sidebar-reorg** — MIT. Playwright/YAML extraction and reorganization. Not a Linear integration; destructive section-rebuild defaults make it a poor unchanged continuous-sync solution.[6]

Additional source-reviewed candidates (direct links below):

- **blwsh/Slack-Workspace-Organiser** — GPL-3.0 extension; YAML import/export of native layouts, no Linear-status loop.
- **unorthodox-digital/slack-auto-sort** — continuous native prefix-to-section organizer; no root license identified in the reviewed material, so not permission-cleared for copying.
- **petehamilton/slack-sidebar-organiser** — rules-based native organizer with dry run; no project license identified in reviewed material.
- **cw-jwright/slack-sync** — browser-local native section transport, rate limits and Grid routing; no project license identified in reviewed material and a handled-once ledger unsuitable for recurring status transitions.
- **some-du6e/slack-user-cli** and **ekroon/slack-channels-optimizer** — useful native section CLI references, not Linear adapters; credential handling and absent identified licenses require attention.
- **Zwyx/chrome-slack-sections-cleaner** — MIT extension for inactivity-based section cleanup, not Linear relocation.
- **yamadashy/slack-channels-grouping** and **takashin198726/tabane** — MIT visual grouping extensions; they do not satisfy actual persistent native section movement.

Candidate links:

- https://github.com/blwsh/Slack-Workspace-Organiser
- https://github.com/unorthodox-digital/slack-auto-sort
- https://github.com/petehamilton/slack-sidebar-organiser
- https://github.com/cw-jwright/slack-sync
- https://github.com/some-du6e/slack-user-cli
- https://github.com/ekroon/slack-channels-optimizer
- https://github.com/Zwyx/chrome-slack-sections-cleaner
- https://github.com/yamadashy/slack-channels-grouping
- https://github.com/takashin198726/tabane

## Adjacent helpdesk vendors

ClearFeed, Thena and Pylon document Linear issue linking, comment/thread synchronization or ticket/status notifications. None of the reviewed primary pages established arbitrary personal-sidebar relocation. Channeled marketing surfaced related channel and Linear features separately, but the exact combined workflow remained unverified; direct retrieval was blocked. These are research gaps, not absolute claims that a vendor could never offer it.

- https://docs.clearfeed.ai/clearfeed-help-center/integrations/linear
- https://docs.thena.ai/platform/apps/linear
- https://docs.usepylon.com/pylon-docs/integrations/ticketing/linear
- https://www.intercom.com/help/en/articles/10551073-channeled-app

## Technical implications

Slack's published methods catalog does not list `users.channelSections.*`. Existing movers use this undocumented internal endpoint family. Do not confuse `admin.conversations.bulkMove` (workspace movement) with sidebar movement.[2][4][5]

The internal move operation observed in source is `users.channelSections.channels.bulkUpdate`, with JSON-encoded `insert` and `remove` form fields containing `{channel_section_id, channel_ids}` arrays. A successful response is not sufficient evidence of a move: read actual membership back. Internal APIs can change without notice.[4][5]

Browser session credentials used by these tools have account-level power, not a narrowly scoped sidebar-write grant. Keep them local, out of chat, commits, logs and hosted automation services. Creating source code does not authorize installing an app or exporting a user's session. A browser extension can avoid exporting cookies but still has sensitive page access and uses unsupported Slack behavior.[4]

## Search coverage and limitations

Searches covered native Linear and Slack documentation, Slack Marketplace results, Zapier/Make/n8n/Pipedream/Relay and adjacent automation listings, GitHub repository search, source files, Chrome extension listings, community/API discussions, and relevant helpdesk vendors. GitHub authenticated code search was unavailable; public repository search and raw source inspection were used instead. No vendor was contacted. No Slack credentials were extracted and no live Slack channels/sections were mutated during research. Search findings cannot establish acceptance in a particular workspace.

## Recommendation

Use native Linear if the need is only a channel per new project. For the combined workflow, use a local-first status reader and narrowly configured native-section mover, with explicit entity/channel mappings, dry-run default, creation opt-in, per-workspace state, a change cap, retry handling and membership readback. A public implementation must disclose its unsupported Slack dependency rather than masquerading as a supported OAuth-only integration.

## Sources

[1] https://linear.app/docs/slack
[2] https://docs.slack.dev/reference/methods
[3] https://slack.com/help/articles/360043207674-Organize-your-sidebar-with-custom-sections
[4] https://github.com/fguinez/slack-incident-sections
[5] https://github.com/vendrinc/slack-sections-organizer
[6] https://github.com/ewilderj/slack-sidebar-reorg
[7] https://docs.slack.dev/reference/methods/usergroups.update
[8] https://zapier.com/apps/linear/integrations/slack/255678655/create-new-slack-channels-for-every-new-issue-in-linear
[9] https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.slack
[10] https://pipedream.com/apps/linear/integrations/slack-v2
[11] https://relay.app
