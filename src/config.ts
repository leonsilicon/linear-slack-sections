import {
  array,
  type ChannelBinding,
  type Config,
  channelId,
  type EntityConfig,
  fail,
  type Kind,
  object,
  type SectionTarget,
  string,
  uuid,
} from "./model";

function keys(o: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(o).some((key) => !allowed.includes(key))) {
    fail(
      "CONFIG",
      "Unknown config field. This version does not accept legacy config or credentials.",
    );
  }
}
function id(value: unknown, pattern: RegExp): string {
  const result = string(value);
  if (!pattern.test(result)) fail("CONFIG", "Invalid identifier in config.");
  return result;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail("CONFIG", "Config numeric limit is outside its allowed range.");
  }
  return value;
}
function channel(value: unknown, kind: Kind): ChannelBinding {
  const o = object(value);
  if ("id" in o) {
    keys(o, ["id"]);
    return { id: id(o.id, channelId) };
  }
  if ("project" in o) {
    keys(o, ["project"]);
    if (o.project !== true || kind !== "project")
      fail("CONFIG", "Project channels require a project.");
    return { project: true };
  }
  keys(o, ["create"]);
  const c = object(o.create);
  keys(c, ["prefix", "private"]);
  if (typeof c.private !== "boolean")
    fail("CONFIG", "Channel privacy must be explicitly true or false.");
  return { create: { prefix: id(c.prefix, /^[a-z][a-z0-9_-]{0,30}$/), private: c.private } };
}

export function parseConfig(value: unknown): Config {
  const o = object(value);
  keys(o, [
    "version",
    "slack",
    "linearWorkspaceId",
    "maxChanges",
    "pollIntervalSeconds",
    "sections",
    "mappings",
    "entities",
  ]);
  if (o.version !== 1) fail("CONFIG", "Expected config version 1.");
  const slack = object(o.slack);
  keys(slack, ["teamId", "ownerUserId"]);
  const sections: Record<string, SectionTarget> = Object.create(null);
  for (const [key, value] of Object.entries(object(o.sections))) {
    id(key, /^[a-z][a-z0-9-]{0,60}$/);
    const target = object(value);
    if ("id" in target) {
      keys(target, ["id"]);
      sections[key] = { id: id(target.id, /^[A-Za-z0-9_-]+$/) };
    } else {
      keys(target, ["name", "create"]);
      if (target.create !== undefined && typeof target.create !== "boolean")
        fail("CONFIG", "Invalid section create flag.");
      sections[key] = { name: string(target.name), create: target.create === true };
    }
  }
  if (!Object.keys(sections).length) fail("CONFIG", "At least one section is required.");
  const mappings = {
    issue: Object.create(null),
    project: Object.create(null),
  } as Config["mappings"];
  const m = object(o.mappings);
  keys(m, ["issue", "project"]);
  for (const kind of ["issue", "project"] as const) {
    for (const [status, section] of Object.entries(object(m[kind]))) {
      string(status);
      const key = string(section);
      if (!Object.hasOwn(sections, key)) fail("CONFIG", "Mapping references an undefined section.");
      mappings[kind][status] = key;
    }
  }
  const seen = new Set<string>();
  const entities: EntityConfig[] = array(o.entities).map((value) => {
    const e = object(value);
    keys(e, ["kind", "ref", "channel"]);
    if (e.kind !== "issue" && e.kind !== "project")
      fail("CONFIG", "Entity kind must be issue or project.");
    const ref = id(e.ref, e.kind === "issue" ? /^(?:[A-Z][A-Z0-9]*-\d+|[0-9a-f-]{36})$/i : uuid);
    if (e.kind === "issue" && !uuid.test(ref) && !/^[A-Z][A-Z0-9]*-\d+$/.test(ref))
      fail("CONFIG", "Invalid issue reference.");
    const key = `${e.kind}:${ref.toLowerCase()}`;
    if (seen.has(key)) fail("DUPLICATE_ENTITY", "Duplicate entity reference in config.");
    seen.add(key);
    return { kind: e.kind, ref, channel: channel(e.channel, e.kind) };
  });
  if (!entities.length || entities.length > 50)
    fail("CONFIG", "Configure between 1 and 50 entities.");
  return {
    version: 1,
    slack: {
      teamId: id(slack.teamId, /^T[A-Z0-9]+$/),
      ownerUserId: id(slack.ownerUserId, /^[UW][A-Z0-9]+$/),
    },
    linearWorkspaceId: id(o.linearWorkspaceId, uuid).toLowerCase(),
    maxChanges: integer(o.maxChanges, 1, 200),
    pollIntervalSeconds: integer(o.pollIntervalSeconds ?? 300, 60, 86400),
    sections,
    mappings,
    entities,
  };
}
