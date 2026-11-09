import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Fetcher, Http } from "../src/http";
import { Linear } from "../src/linear";
import type { Section } from "../src/model";
import { Slack } from "../src/slack";
import { State } from "../src/state";
import { bindingKey, sync } from "../src/sync";
import { noWait, setup } from "./helpers";

test("real adapters and SQLite reconcile creation, restart and status change through fake HTTP", async () => {
  const s = setup(true);
  const directory = mkdtempSync(join(tmpdir(), "linear-slack-integration-"));
  const path = join(directory, "bindings.sqlite");
  let state: State | undefined;
  const layout: Section[] = [{ id: "SUNMANAGED", name: "Unmanaged", channels: ["CUNMANAGED"] }];
  let owner = false;
  let created = false;
  const remoteWrites: string[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const ok = (data: Record<string, unknown>) =>
      new Response(JSON.stringify({ ok: true, ...data }));
    if (url === "https://api.linear.app/graphql") {
      return ok({
        data: {
          organization: { id: s.config.linearWorkspaceId },
          e0: { id: s.entity.id, archivedAt: null, state: { name: s.entity.status } },
        },
      });
    }
    expect(url.startsWith("https://slack.com/api/")).toBe(true);
    const method = url.split("/").at(-1);
    const params = new URLSearchParams(String(init.body));
    const bot = new Headers(init.headers).has("Authorization");
    if (method === "auth.test")
      return ok(
        bot ? { team_id: "TEXAMPLE", bot_id: "BFAKE" } : { team_id: "TEXAMPLE", user_id: "UOWNER" },
      );
    if (method === "users.channelSections.list")
      return ok({
        channel_sections: layout.map((section) => ({
          channel_section_id: section.id,
          name: section.name,
          channel_ids_page: {
            channel_ids: section.channels,
            count: section.channels.length,
            next_cursor: "",
          },
        })),
      });
    if (method === "users.channelSections.create") {
      remoteWrites.push(method);
      const id = `S${layout.length}`;
      layout.push({ id, name: params.get("name") ?? "", channels: [] });
      return ok({ channel_section_id: id });
    }
    if (method === "conversations.create") {
      remoteWrites.push(method);
      expect(bot).toBe(true);
      expect(params.get("is_private")).toBe("true");
      created = true;
      return ok({ channel: { id: "CNEW" } });
    }
    if (method === "conversations.info") {
      expect(created).toBe(true);
      return ok({
        channel: { id: "CNEW", is_archived: false, is_private: true, is_member: bot || owner },
      });
    }
    if (method === "conversations.invite") {
      remoteWrites.push(method);
      owner = true;
      return ok({});
    }
    if (method === "conversations.members")
      return ok({ members: owner ? ["UOWNER"] : [], response_metadata: { next_cursor: "" } });
    if (method === "users.channelSections.channels.bulkUpdate") {
      remoteWrites.push(method);
      const removals: { channel_section_id: string; channel_ids: string[] }[] = JSON.parse(
        params.get("remove") ?? "[]",
      );
      const inserts: typeof removals = JSON.parse(params.get("insert") ?? "[]");
      for (const removal of removals) {
        const section = layout.find((section) => section.id === removal.channel_section_id);
        if (section)
          section.channels = section.channels.filter((id) => !removal.channel_ids.includes(id));
      }
      for (const insert of inserts)
        layout
          .find((section) => section.id === insert.channel_section_id)
          ?.channels.push(...insert.channel_ids);
      return ok({});
    }
    throw Error("Unexpected simulated request");
  };
  try {
    const http = new Http(fetcher, noWait);
    const linear = new Linear("FICTIONAL-KEY", http);
    const slack = new Slack(
      s.config,
      { session: "xoxc-FICTIONAL", cookie: "FICTIONAL", bot: "xoxb-FICTIONAL" },
      http,
    );
    state = new State(path, true);
    await sync(s.config, linear, slack, state, true, noWait);
    expect(remoteWrites).toEqual([
      "users.channelSections.create",
      "conversations.create",
      "conversations.invite",
      "users.channelSections.channels.bulkUpdate",
    ]);
    expect(state.get(bindingKey(s.config, s.entity))?.verifiedStatus).toBe("Needs Leon");
    state.close();
    state = new State(path, true);
    expect((await sync(s.config, linear, slack, state, true, noWait)).operations).toEqual([]);
    s.entity.status = "Awaiting";
    await sync(s.config, linear, slack, state, true, noWait);
    expect(state.get(bindingKey(s.config, s.entity))?.verifiedStatus).toBe("Awaiting");
    expect(remoteWrites.filter((method) => method === "conversations.create")).toHaveLength(1);
    expect(
      layout.filter((section) => section.channels.includes("CNEW")).map((section) => section.name),
    ).toEqual(["Awaiting"]);
    expect(layout[0]?.channels).toEqual(["CUNMANAGED"]);
  } finally {
    state?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("readback rejects a destination insert that leaves a source membership behind", async () => {
  const s = setup();
  s.slack.move = async (id, destination) => {
    s.slack.writes.push("partial-move");
    s.slack.layout.find((section) => section.id === destination)?.channels.push(id);
  };
  await expect(sync(s.config, s.linear, s.slack, s.state, true, noWait)).rejects.toMatchObject({
    code: "READBACK",
  });
  expect(s.state.rows.size).toBe(0);
});

test("drift requiring a move absent from the plan stops before writing", async () => {
  const s = setup();
  for (const section of s.slack.layout)
    section.channels = section.channels.filter((id) => id !== "CEXISTING");
  s.slack.layout[0]?.channels.push("CEXISTING");
  let reads = 0;
  const original = s.slack.sections.bind(s.slack);
  s.slack.sections = async () => {
    reads++;
    if (reads === 2) {
      for (const section of s.slack.layout)
        section.channels = section.channels.filter((id) => id !== "CEXISTING");
    }
    return original();
  };
  await expect(sync(s.config, s.linear, s.slack, s.state, true, noWait)).rejects.toMatchObject({
    code: "DRIFT",
  });
  expect(s.slack.writes).toEqual([]);
});
