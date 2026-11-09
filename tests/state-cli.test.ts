import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config";
import { State } from "../src/state";
import { bindingKey, sync } from "../src/sync";
import { example, noWait, setup } from "./helpers";

const directories: string[] = [];
function temporary() {
  const dir = mkdtempSync(join(tmpdir(), "linear-slack-test-"));
  directories.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("readonly state with missing file creates no path or lock", () => {
  const dir = temporary();
  const state = new State(join(dir, "missing", "bindings.sqlite"), false);
  expect(state.get("key")).toBeUndefined();
  expect(() =>
    state.put("key", { channelId: "CONE", name: null, managed: false, verifiedStatus: null }),
  ).toThrow();
  state.close();
  expect(readdirSync(dir)).toEqual([]);
});

test("SQLite persists pending intents across reopen, locks writers, allows readonly access", () => {
  const path = join(temporary(), "bindings.sqlite");
  const state = new State(path, true);
  state.put("key", { channelId: null, name: "linear-stable", managed: true, verifiedStatus: null });
  expect(() => new State(path, true)).toThrow("locked");
  const readonly = new State(path, false);
  expect(readonly.get("key")?.name).toBe("linear-stable");
  readonly.close();
  expect(statSync(path).mode & 0o777).toBe(0o600);
  state.close();
  const reopened = new State(path, true);
  expect(reopened.get("key")?.channelId).toBeNull();
  reopened.close();
  expect(readdirSync(join(path, "..")).sort()).toEqual(["bindings.sqlite"]);
});

test("failed creation persists pending binding and blocks replay after process restart", async () => {
  const s = setup(true);
  const path = join(temporary(), "bindings.sqlite");
  let state = new State(path, true);
  s.slack.failCreate = true;
  await expect(sync(s.config, s.linear, s.slack, state, true)).rejects.toMatchObject({
    code: "UNCERTAIN_CREATE",
  });
  state.close();
  state = new State(path, true);
  expect(state.get(bindingKey(s.config, s.entity))?.name).toContain("linear-issue-");
  await expect(sync(s.config, s.linear, s.slack, state, true)).rejects.toMatchObject({
    code: "PENDING_CREATE",
  });
  state.close();
  expect(s.slack.writes).toEqual(["create-channel"]);
});

test("durable bindings make a second process reconciliation idempotent", async () => {
  const s = setup(true);
  const path = join(temporary(), "bindings.sqlite");
  const state = new State(path, true);
  await sync(s.config, s.linear, s.slack, state, true, noWait);
  state.close();
  const second = new State(path, true);
  const result = await sync(s.config, s.linear, s.slack, second, true, noWait);
  second.close();
  expect(result.operations).toEqual([]);
  expect(s.slack.writes.filter((op) => op === "create-channel")).toHaveLength(1);
});

test("state namespaces isolate different owners and Linear workspaces", () => {
  const s = setup();
  const original = bindingKey(s.config, s.entity);
  s.config.slack.ownerUserId = "UOTHER";
  expect(bindingKey(s.config, s.entity)).not.toBe(original);
  s.config.slack.ownerUserId = "UOWNER";
  s.config.linearWorkspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  expect(bindingKey(s.config, s.entity)).not.toBe(original);
});

test("state refuses symbolic links", () => {
  const dir = temporary();
  const target = join(dir, "target.sqlite");
  const state = new State(target, true);
  state.close();
  const link = join(dir, "link.sqlite");
  symlinkSync(target, link);
  expect(() => new State(link, true)).toThrow("symbolic link");
});

test.each(["duplicate", "unknown-field", "privacy", "mapping", "interval"])(
  "strict config rejects invalid %s",
  (mode) => {
    const config = example();
    const first = config.entities[0];
    const third = config.entities[2];
    if (!first || !third) throw Error("Missing test entities");
    if (mode === "duplicate") config.entities.push({ ...first });
    if (mode === "unknown-field") Object.assign(config, { token: "FICTIONAL-SECRET" });
    if (mode === "privacy") Object.assign(third.channel, { create: { prefix: "linear" } });
    if (mode === "mapping") config.mappings.issue.Unknown = "undefined-section";
    if (mode === "interval") config.pollIntervalSeconds = 1;
    expect(() => parseConfig(config)).toThrow();
  },
);

test("real CLI offline preview has no credentials, network dependency or state writes", () => {
  const dir = temporary();
  const result = Bun.spawnSync(
    [
      process.execPath,
      "src/cli.ts",
      "--config",
      "config.example.json",
      "--fixture",
      "fixtures/demo.json",
      "--state",
      join(dir, "bindings.sqlite"),
    ],
    { env: { PATH: process.env.PATH ?? "" } },
  );
  expect(result.exitCode).toBe(0);
  const output = JSON.parse(result.stdout.toString());
  expect(output.mode).toBe("dry-run");
  expect(output.operations).toHaveLength(6);
  expect(
    output.operations
      .filter((op: { type: string }) => op.type === "move")
      .map((op: { section: string }) => op.section),
  ).toEqual(["needs-leon", "awaiting", "blocked"]);
  expect(readdirSync(dir)).toEqual([]);
  expect(result.stderr.toString()).toBe("");
});

test.each([
  { flags: ["--apply"], code: "EXPERIMENTAL_GATE" },
  { flags: ["--apply", "--dry-run"], code: "ARGUMENTS" },
  { flags: ["--fixture", "fixtures/demo.json", "--apply"], code: "ARGUMENTS" },
  { flags: ["--unknown", "FICTIONAL-SECRET"], code: "ARGUMENTS" },
])("CLI refuses unsafe or invalid flag combinations %j without state writes", ({ flags, code }) => {
  const dir = temporary();
  const result = Bun.spawnSync(
    [
      process.execPath,
      "src/cli.ts",
      "--config",
      "config.example.json",
      "--state",
      join(dir, "bindings.sqlite"),
      ...flags,
    ],
    { env: { PATH: process.env.PATH ?? "" } },
  );
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stderr.toString()).error).toBe(code);
  expect(result.stderr.toString()).not.toContain("FICTIONAL-SECRET");
  expect(readdirSync(dir)).toEqual([]);
});
