import { readFileSync } from "node:fs";
import { parseConfig } from "../src/config";
import {
  type Channel,
  type Config,
  type Entity,
  fail,
  type LinearPort,
  type Section,
  type SlackPort,
} from "../src/model";
import { MemoryStore } from "../src/state";

export function example(): Config {
  return parseConfig(
    JSON.parse(readFileSync(new URL("../config.example.json", import.meta.url), "utf8")),
  );
}
export const entityId = "11111111-1111-4111-8111-111111111111";
export const noWait = async (_ms: number) => {};

export class FakeSlack implements SlackPort {
  readonly writes: string[] = [];
  readonly channels = new Map<string, Channel>([
    ["CEXISTING", { id: "CEXISTING", archived: false, member: true, private: true }],
  ]);
  layout: Section[] = [
    { id: "SNEEDS", name: "Needs Leon", channels: [] },
    { id: "SAWAIT", name: "Awaiting", channels: [] },
    { id: "SBLOCK", name: "Blocked", channels: [] },
    { id: "SACTIVE", name: "In Progress", channels: ["CEXISTING", "CUNMANAGED"] },
  ];
  ignoreMoves = false;
  failInvite = false;
  failCreate = false;
  identities = 0;
  async identity() {
    this.identities++;
  }
  async sections() {
    return structuredClone(this.layout);
  }
  async createSection(name: string) {
    this.writes.push("create-section");
    const id = `SNEW${this.layout.length}`;
    this.layout.push({ id, name, channels: [] });
    return id;
  }
  async channel(id: string, bot = false) {
    const value = this.channels.get(id);
    if (!value) fail("STALE_BINDING", "Missing fake channel.");
    return { ...value, member: bot || value.member };
  }
  async createChannel(_name: string, isPrivate: boolean) {
    this.writes.push("create-channel");
    if (this.failCreate) fail("UNCERTAIN_CREATE", "Simulated ambiguous creation response.");
    this.channels.set("CNEW", { id: "CNEW", archived: false, member: false, private: isPrivate });
    return "CNEW";
  }
  async hasOwner(id: string) {
    return this.channels.get(id)?.member === true;
  }
  async inviteOwner(id: string) {
    this.writes.push("invite-owner");
    if (this.failInvite) fail("SLACK", "Simulated invite failure.");
    const channel = this.channels.get(id);
    if (channel) channel.member = true;
  }
  async move(id: string, destination: string, _sources: string[]) {
    this.writes.push("move");
    if (this.ignoreMoves) return;
    for (const section of this.layout)
      section.channels = section.channels.filter((channel) => channel !== id);
    this.layout.find((section) => section.id === destination)?.channels.push(id);
  }
}

export function setup(create = false) {
  const config = example();
  config.entities = [
    {
      kind: "issue",
      ref: "DEMO-1",
      channel: create ? { create: { prefix: "linear", private: true } } : { id: "CEXISTING" },
    },
  ];
  const entity: Entity = { kind: "issue", id: entityId, status: "Needs Leon" };
  const entities = [entity];
  const linear: LinearPort = {
    snapshot: async () => ({
      workspaceId: config.linearWorkspaceId,
      entities: structuredClone(entities),
    }),
  };
  return { config, entity, entities, linear, slack: new FakeSlack(), state: new MemoryStore() };
}
