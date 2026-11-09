import { createHash } from "node:crypto";
import { type Wait, wait } from "./http";
import {
  type Binding,
  type BindingStore,
  type Config,
  channelId,
  type Entity,
  type EntityConfig,
  fail,
  type LinearPort,
  type Operation,
  type Section,
  type SlackPort,
  type SyncResult,
} from "./model";

export function bindingKey(config: Config, entity: Entity) {
  return `${config.slack.teamId}:${config.slack.ownerUserId}:${config.linearWorkspaceId}:${entity.kind}:${entity.id}`;
}
export function channelName(config: Config, entity: Entity, prefix: string) {
  const hash = createHash("sha256")
    .update(`${config.slack.teamId}:${config.linearWorkspaceId}:${entity.kind}:${entity.id}`)
    .digest("hex")
    .slice(0, 20);
  return `${prefix}-${entity.kind}-${hash}`;
}
function memberships(sections: Section[], id: string) {
  return sections.filter((section) => section.channels.includes(id)).map((section) => section.id);
}
type Entry = {
  config: EntityConfig;
  entity: Entity;
  key: string;
  target: string;
  channel: string | undefined;
  binding: Binding | undefined;
  invite: boolean;
};

export async function sync(
  config: Config,
  linear: LinearPort,
  slack: SlackPort,
  state: BindingStore,
  apply = false,
  sleep: Wait = wait,
): Promise<SyncResult> {
  const snapshot = await linear.snapshot(config.entities);
  if (
    snapshot.workspaceId !== config.linearWorkspaceId ||
    snapshot.entities.length !== config.entities.length
  ) {
    fail("IDENTITY", "Linear snapshot does not match the configured workspace or entity set.");
  }
  const canonical = new Set<string>();
  const entries: Entry[] = config.entities.map((c, index) => {
    const e = snapshot.entities[index];
    if (!e || e.kind !== c.kind) fail("SCHEMA", "Linear snapshot order or kind mismatch.");
    const identity = `${e.kind}:${e.id}`;
    if (canonical.has(identity))
      fail(
        "DUPLICATE_ENTITY",
        "Multiple references resolve to the same Linear entity. Use one canonical binding.",
      );
    canonical.add(identity);
    const target = config.mappings[e.kind][e.status];
    if (!target || !Object.hasOwn(config.sections, target))
      fail("UNMAPPED_STATUS", "A Linear status has no explicit mapping. No writes were performed.");
    const key = bindingKey(config, e);
    const saved = state.get(key);
    let channel: string | undefined;
    if ("id" in c.channel) channel = c.channel.id;
    else if ("project" in c.channel) {
      if (!e.projectChannelId || !channelId.test(e.projectChannelId))
        fail("PROJECT_CHANNEL", "Project has no readable connected Slack channel.");
      channel = e.projectChannelId;
    } else channel = saved?.channelId ?? undefined;
    if (saved?.channelId && channel !== saved.channelId)
      fail(
        "STALE_BINDING",
        "Configured channel conflicts with the saved binding. Inspect and explicitly reconcile state before applying.",
      );
    if (!channel && saved)
      fail(
        "PENDING_CREATE",
        "An interrupted channel creation is pending. Inspect Slack by the saved name, then bind its ID explicitly; do not reset state blindly.",
      );
    return { config: c, entity: e, key, target, channel, binding: saved, invite: false };
  });
  const needsBot = entries.some((entry) => "create" in entry.config.channel);
  await slack.identity(needsBot);
  let sections = await slack.sections();
  const targets = new Map<string, { id?: string; name?: string }>();
  const operations: Operation[] = [];
  // Only sections required by the current snapshot are candidates for creation.
  for (const key of new Set(entries.map((entry) => entry.target))) {
    const target = config.sections[key];
    if (!target) fail("CONFIG", "Missing section target.");
    const matches = sections.filter((s) =>
      "id" in target ? s.id === target.id : s.name === target.name,
    );
    if (matches.length > 1)
      fail(
        "AMBIGUOUS_SECTION",
        "Multiple sections have the configured name; use an exact section ID.",
      );
    if (matches[0]) targets.set(key, { id: matches[0].id });
    else if ("name" in target && target.create) {
      // Multiple keys may deliberately identify the same not-yet-created section.
      const prior = [...targets.values()].find((value) => value.name === target.name);
      targets.set(key, prior ?? { name: target.name });
      if (!prior) operations.push({ type: "create-section", section: key, name: target.name });
    } else fail("MISSING_SECTION", "Configured section is absent and creation is not enabled.");
  }
  const channels = new Set<string>();
  for (const entry of entries) {
    if (entry.channel) {
      if (channels.has(entry.channel))
        fail(
          "DUPLICATE_CHANNEL",
          "One Slack channel cannot be controlled by multiple Linear entities.",
        );
      channels.add(entry.channel);
      const managed = "create" in entry.config.channel;
      const info = await slack.channel(entry.channel, managed);
      if (info.archived)
        fail(
          "STALE_BINDING",
          "Configured or saved Slack channel is archived; no replacement was created.",
        );
      if (
        managed &&
        "create" in entry.config.channel &&
        info.private !== entry.config.channel.create.private
      ) {
        fail(
          "STALE_BINDING",
          "Saved channel privacy differs from config; automatic replacement is disabled.",
        );
      }
      if (managed) entry.invite = !(await slack.hasOwner(entry.channel));
      else if (!info.member)
        fail("MEMBERSHIP", "Sidebar owner must already belong to existing configured channels.");
    } else {
      if (!("create" in entry.config.channel)) fail("CONFIG", "Missing channel binding.");
      operations.push({
        type: "create-channel",
        entity: entry.key,
        name: channelName(config, entry.entity, entry.config.channel.create.prefix),
        private: entry.config.channel.create.private,
      });
      entry.invite = true;
    }
    if (entry.invite)
      operations.push({
        type: "invite-owner",
        entity: entry.key,
        ...(entry.channel ? { channel: entry.channel } : {}),
      });
    const desired = targets.get(entry.target)?.id;
    const current = entry.channel ? memberships(sections, entry.channel) : [];
    if (!desired || current.length !== 1 || current[0] !== desired) {
      operations.push({
        type: "move",
        entity: entry.key,
        section: entry.target,
        ...(entry.channel ? { channel: entry.channel } : {}),
      });
    }
  }
  if (operations.length > config.maxChanges)
    fail("BUDGET", "Proposed operations exceed maxChanges; no writes were performed.");
  if (!apply) return { mode: "dry-run", operations, verified: [] };

  for (const target of new Set(targets.values())) {
    if (target.id) continue;
    if (!target.name) fail("SCHEMA", "Missing section creation name.");
    const id = await slack.createSection(target.name);
    sections = await slack.sections();
    const matches = sections.filter((section) => section.name === target.name);
    if (matches.length !== 1 || matches[0]?.id !== id)
      fail("READBACK", "Created section could not be uniquely verified.");
    target.id = id;
  }
  const verified: string[] = [];
  for (const entry of entries) {
    if (!entry.channel) {
      if (!("create" in entry.config.channel)) fail("CONFIG", "Missing channel creation config.");
      const name = channelName(config, entry.entity, entry.config.channel.create.prefix);
      // Durable intent prevents replaying a create whose response is lost across process restarts.
      state.put(entry.key, { channelId: null, name, managed: true, verifiedStatus: null });
      const id = await slack.createChannel(name, entry.config.channel.create.private);
      entry.channel = id;
      entry.binding = { channelId: id, name, managed: true, verifiedStatus: null };
      state.put(entry.key, entry.binding);
      if (channels.has(id))
        fail("READBACK", "Created channel conflicts with another binding; inspect state.");
      channels.add(id);
      const info = await slack.channel(id, true);
      if (info.archived || info.private !== entry.config.channel.create.private)
        fail("READBACK", "Created channel privacy or availability did not verify.");
    }
    const id = entry.channel;
    if (entry.invite) {
      await slack.inviteOwner(id);
      if (!(await slack.hasOwner(id)))
        fail("READBACK", "Sidebar owner membership did not verify after invitation.");
    }
    const info = await slack.channel(id);
    if (info.archived || !info.member)
      fail("READBACK", "Sidebar owner cannot access the active channel.");
    const destination = targets.get(entry.target)?.id;
    if (!destination) fail("READBACK", "Destination section did not verify.");
    sections = await slack.sections();
    if (!sections.some((section) => section.id === destination))
      fail("READBACK", "Destination section disappeared; sync stopped.");
    const sources = memberships(sections, id);
    if (sources.length !== 1 || sources[0] !== destination) {
      // Re-reading before writing preserves unrelated memberships and catches manual drift.
      // A drift requiring an unplanned operation is deferred to the next reviewed plan.
      if (!operations.some((op) => op.type === "move" && op.entity === entry.key))
        fail("DRIFT", "Sidebar changed after planning. Re-run to review a fresh plan.");
      await slack.move(id, destination, sources);
    }
    let matched = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const actual = memberships(await slack.sections(), id);
      if (actual.length === 1 && actual[0] === destination) {
        matched = true;
        break;
      }
      if (attempt < 2) await sleep(250 * (attempt + 1));
    }
    if (!matched)
      fail(
        "READBACK",
        "Move did not verify exactly one destination membership; status was not saved as synced.",
      );
    state.put(entry.key, {
      channelId: id,
      name: entry.binding?.name ?? null,
      managed: "create" in entry.config.channel,
      verifiedStatus: entry.entity.status,
    });
    verified.push(entry.key);
  }
  return { mode: "apply", operations, verified };
}
