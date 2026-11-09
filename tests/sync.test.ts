import { expect, test } from "bun:test";
import { bindingKey, channelName, sync } from "../src/sync";
import { entityId, noWait, setup } from "./helpers";

test("dry run plans creation, invite and move without remote or state writes", async () => {
  const s = setup(true);
  const result = await sync(s.config, s.linear, s.slack, s.state);
  expect(result.mode).toBe("dry-run");
  expect(result.operations.map((op) => op.type)).toEqual([
    "create-channel",
    "invite-owner",
    "move",
  ]);
  expect(result.verified).toEqual([]);
  expect(s.slack.writes).toEqual([]);
  expect(s.state.rows.size).toBe(0);
});

test("apply creates once, verifies and is idempotent; all three blocker statuses stay distinct", async () => {
  const s = setup(true);
  const key = bindingKey(s.config, s.entity);
  await sync(s.config, s.linear, s.slack, s.state, true, noWait);
  expect(s.slack.writes).toEqual(["create-channel", "invite-owner", "move"]);
  expect(s.state.get(key)?.verifiedStatus).toBe("Needs Leon");
  expect((await sync(s.config, s.linear, s.slack, s.state, true, noWait)).operations).toEqual([]);
  for (const [status, id] of [
    ["Awaiting", "SAWAIT"],
    ["Blocked", "SBLOCK"],
    ["Needs Leon", "SNEEDS"],
  ] as const) {
    s.entity.status = status;
    await sync(s.config, s.linear, s.slack, s.state, true, noWait);
    expect(
      s.slack.layout
        .filter((section) => section.channels.includes("CNEW"))
        .map((section) => section.id),
    ).toEqual([id]);
  }
  expect(s.slack.writes.filter((op) => op === "create-channel")).toHaveLength(1);
});

test("manual channel drift is reconciled, leaving unmanaged channels untouched", async () => {
  const s = setup();
  await sync(s.config, s.linear, s.slack, s.state, true, noWait);
  s.slack.layout.find((section) => section.id === "SAWAIT")?.channels.push("CEXISTING");
  await sync(s.config, s.linear, s.slack, s.state, true, noWait);
  expect(
    s.slack.layout
      .filter((section) => section.channels.includes("CEXISTING"))
      .map((section) => section.id),
  ).toEqual(["SNEEDS"]);
  expect(s.slack.layout.find((section) => section.id === "SACTIVE")?.channels).toEqual([
    "CUNMANAGED",
  ]);
});

test("identifier and UUID aliases of one issue fail before any Slack access", async () => {
  const s = setup(true);
  s.config.entities.push({
    kind: "issue",
    ref: entityId,
    channel: { create: { prefix: "linear", private: true } },
  });
  s.entities.push({ ...s.entity });
  await expect(sync(s.config, s.linear, s.slack, s.state, true)).rejects.toMatchObject({
    code: "DUPLICATE_ENTITY",
  });
  expect(s.slack.identities).toBe(0);
  expect(s.slack.writes).toEqual([]);
});

test("distinct issues cannot fight over one channel even if statuses agree", async () => {
  const s = setup();
  s.config.entities.push({ kind: "issue", ref: "DEMO-2", channel: { id: "CEXISTING" } });
  s.entities.push({ ...s.entity, id: "22222222-2222-4222-8222-222222222222" });
  await expect(sync(s.config, s.linear, s.slack, s.state, true)).rejects.toMatchObject({
    code: "DUPLICATE_CHANNEL",
  });
  expect(s.slack.writes).toEqual([]);
});

test("unknown status fails the whole preflight before creating sections", async () => {
  const s = setup(true);
  s.slack.layout = [];
  s.entity.status = "Unknown";
  await expect(sync(s.config, s.linear, s.slack, s.state, true)).rejects.toMatchObject({
    code: "UNMAPPED_STATUS",
  });
  expect(s.slack.writes).toEqual([]);
});

test("operation cap includes section, channel, invite and move before writes", async () => {
  const s = setup(true);
  s.slack.layout = [];
  s.config.maxChanges = 3;
  await expect(sync(s.config, s.linear, s.slack, s.state, true)).rejects.toMatchObject({
    code: "BUDGET",
  });
  expect(s.slack.writes).toEqual([]);
});

test("only currently used sections are created and read back", async () => {
  const s = setup();
  s.slack.layout = [];
  const result = await sync(s.config, s.linear, s.slack, s.state, true, noWait);
  expect(result.operations.map((op) => op.type)).toEqual(["create-section", "move"]);
  expect(s.slack.layout.map((section) => section.name)).toEqual(["Needs Leon"]);
});

test("missing saved channel never triggers replacement creation", async () => {
  const s = setup(true);
  s.state.put(bindingKey(s.config, s.entity), {
    channelId: "CGONE",
    name: "saved-name",
    managed: true,
    verifiedStatus: "Awaiting",
  });
  await expect(sync(s.config, s.linear, s.slack, s.state, true)).rejects.toMatchObject({
    code: "STALE_BINDING",
  });
  expect(s.slack.writes).toEqual([]);
});

test.each(["archived", "privacy"])("saved channel with stale %s is refused", async (reason) => {
  const s = setup(true);
  s.state.put(bindingKey(s.config, s.entity), {
    channelId: "CEXISTING",
    name: null,
    managed: true,
    verifiedStatus: null,
  });
  const channel = s.slack.channels.get("CEXISTING");
  if (!channel) throw Error("test channel");
  if (reason === "archived") channel.archived = true;
  else channel.private = false;
  await expect(sync(s.config, s.linear, s.slack, s.state, true)).rejects.toMatchObject({
    code: "STALE_BINDING",
  });
  expect(s.slack.writes).toEqual([]);
});

test("conflicting explicit ID versus saved binding fails instead of silently rebinding", async () => {
  const s = setup();
  s.state.put(bindingKey(s.config, s.entity), {
    channelId: "COTHER",
    name: null,
    managed: false,
    verifiedStatus: null,
  });
  await expect(sync(s.config, s.linear, s.slack, s.state, true)).rejects.toMatchObject({
    code: "STALE_BINDING",
  });
  expect(s.slack.writes).toEqual([]);
});

test("created ID persists before invite failure; rerun resumes without another creation", async () => {
  const s = setup(true);
  s.slack.failInvite = true;
  await expect(sync(s.config, s.linear, s.slack, s.state, true, noWait)).rejects.toMatchObject({
    code: "SLACK",
  });
  expect(s.state.get(bindingKey(s.config, s.entity))?.channelId).toBe("CNEW");
  expect(s.state.get(bindingKey(s.config, s.entity))?.verifiedStatus).toBeNull();
  s.slack.failInvite = false;
  await sync(s.config, s.linear, s.slack, s.state, true, noWait);
  expect(s.slack.writes.filter((op) => op === "create-channel")).toHaveLength(1);
});

test("ambiguous create is durably marked pending and cannot be replayed", async () => {
  const s = setup(true);
  s.slack.failCreate = true;
  await expect(sync(s.config, s.linear, s.slack, s.state, true)).rejects.toMatchObject({
    code: "UNCERTAIN_CREATE",
  });
  const saved = s.state.get(bindingKey(s.config, s.entity));
  expect(saved?.channelId).toBeNull();
  expect(saved?.name).toBe(channelName(s.config, s.entity, "linear"));
  await expect(sync(s.config, s.linear, s.slack, s.state, true)).rejects.toMatchObject({
    code: "PENDING_CREATE",
  });
  expect(s.slack.writes).toEqual(["create-channel"]);
});

test("explicit verified channel binding resolves an interrupted pending intent", async () => {
  const s = setup();
  const key = bindingKey(s.config, s.entity);
  s.state.put(key, { channelId: null, name: "pending", managed: true, verifiedStatus: null });
  await sync(s.config, s.linear, s.slack, s.state, true, noWait);
  expect(s.state.get(key)?.channelId).toBe("CEXISTING");
  expect(s.slack.writes).toEqual(["move"]);
});

test("identifier to UUID config change reuses the canonical saved binding", async () => {
  const s = setup(true);
  await sync(s.config, s.linear, s.slack, s.state, true, noWait);
  const first = s.config.entities[0];
  if (!first) throw Error("Missing test entity");
  first.ref = entityId;
  expect((await sync(s.config, s.linear, s.slack, s.state, true)).operations).toEqual([]);
  expect(s.state.rows.size).toBe(1);
});

test("success response without actual movement never saves status success", async () => {
  const s = setup();
  s.slack.ignoreMoves = true;
  await expect(sync(s.config, s.linear, s.slack, s.state, true, noWait)).rejects.toMatchObject({
    code: "READBACK",
  });
  expect(s.state.rows.size).toBe(0);
});

test("ambiguous section names require an explicit ID", async () => {
  const s = setup();
  s.slack.layout.push({ id: "SDUP", name: "Needs Leon", channels: [] });
  await expect(sync(s.config, s.linear, s.slack, s.state, true)).rejects.toMatchObject({
    code: "AMBIGUOUS_SECTION",
  });
  s.config.sections["needs-leon"] = { id: "SNEEDS" };
  await sync(s.config, s.linear, s.slack, s.state, true, noWait);
  expect(s.slack.writes).toEqual(["move"]);
});

test("project statuses use project mapping and current native project channel", async () => {
  const s = setup();
  s.config.entities = [{ kind: "project", ref: entityId, channel: { project: true } }];
  s.entity.kind = "project";
  s.entity.projectChannelId = "CEXISTING";
  s.entity.status = "Awaiting";
  await sync(s.config, s.linear, s.slack, s.state, true, noWait);
  expect(s.slack.layout.find((section) => section.id === "SAWAIT")?.channels).toContain(
    "CEXISTING",
  );
  s.entity.projectChannelId = "COTHER";
  await expect(sync(s.config, s.linear, s.slack, s.state, true)).rejects.toMatchObject({
    code: "STALE_BINDING",
  });
});

test("wrong Linear workspace cannot act on Slack", async () => {
  const s = setup();
  s.config.linearWorkspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const linear = {
    snapshot: async () => ({
      workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      entities: [s.entity],
    }),
  };
  await expect(sync(s.config, linear, s.slack, s.state, true)).rejects.toMatchObject({
    code: "IDENTITY",
  });
  expect(s.slack.identities).toBe(0);
});
