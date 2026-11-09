import {
  array,
  type Channel,
  type Config,
  fail,
  type LinearPort,
  object,
  type Section,
  type SlackPort,
  type Snapshot,
  string,
} from "./model";

// Offline input is deliberately separate from the live HTTP adapters.
export function fixturePorts(
  value: unknown,
  config: Config,
): { linear: LinearPort; slack: SlackPort } {
  const fixture = object(value);
  const snapshot = object(fixture.snapshot);
  const entities: Snapshot["entities"] = array(snapshot.entities).map((value) => {
    const e = object(value);
    if (e.kind !== "issue" && e.kind !== "project") fail("FIXTURE", "Invalid fixture entity kind.");
    const base: Snapshot["entities"][number] = {
      kind: e.kind,
      id: string(e.id),
      status: string(e.status),
    };
    return e.projectChannelId ? { ...base, projectChannelId: string(e.projectChannelId) } : base;
  });
  const sections: Section[] = array(fixture.sections).map((value) => {
    const s = object(value);
    return { id: string(s.id), name: string(s.name), channels: array(s.channels).map(string) };
  });
  const channels = object(fixture.channels);
  const offlineWrite = async (): Promise<never> =>
    fail("FIXTURE", "Offline fixture CLI cannot apply changes.");
  return {
    linear: { snapshot: async () => ({ workspaceId: string(snapshot.workspaceId), entities }) },
    slack: {
      identity: async () => {
        if (
          fixture.teamId !== config.slack.teamId ||
          fixture.ownerUserId !== config.slack.ownerUserId
        )
          fail("FIXTURE", "Fixture identity differs from config.");
      },
      sections: async () => structuredClone(sections),
      channel: async (id): Promise<Channel> => {
        const c = object(channels[id]);
        if (
          typeof c.archived !== "boolean" ||
          typeof c.member !== "boolean" ||
          typeof c.private !== "boolean"
        )
          fail("FIXTURE", "Invalid fixture channel.");
        return { id, archived: c.archived, member: c.member, private: c.private };
      },
      hasOwner: async () => true,
      createSection: offlineWrite,
      createChannel: offlineWrite,
      inviteOwner: offlineWrite,
      move: offlineWrite,
    },
  };
}
