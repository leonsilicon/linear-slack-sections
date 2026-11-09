export class SyncError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SyncError";
  }
}

export function fail(code: string, message: string): never {
  throw new SyncError(code, message);
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("SCHEMA", "Expected an object; check config or API compatibility.");
  }
  return value as Record<string, unknown>;
}

export function string(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    fail("SCHEMA", "Expected a nonempty string of at most 200 characters.");
  }
  return value;
}

export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) fail("SCHEMA", "Expected an array; API schema may have changed.");
  return value;
}

export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const channelId = /^[CG][A-Z0-9]+$/;
export type Kind = "issue" | "project";
export type ChannelBinding =
  | { id: string }
  | { project: true }
  | { create: { prefix: string; private: boolean } };
export type EntityConfig = { kind: Kind; ref: string; channel: ChannelBinding };
export type SectionTarget = { id: string } | { name: string; create: boolean };
export type Config = {
  version: 1;
  slack: { teamId: string; ownerUserId: string };
  linearWorkspaceId: string;
  maxChanges: number;
  pollIntervalSeconds: number;
  sections: Record<string, SectionTarget>;
  mappings: Record<Kind, Record<string, string>>;
  entities: EntityConfig[];
};
export type Entity = {
  kind: Kind;
  id: string;
  status: string;
  projectChannelId?: string;
};
export type Snapshot = { workspaceId: string; entities: Entity[] };
export type Section = { id: string; name: string; channels: string[] };
export type Channel = { id: string; archived: boolean; member: boolean; private: boolean };
export type Binding = {
  channelId: string | null;
  name: string | null;
  managed: boolean;
  verifiedStatus: string | null;
};
export interface LinearPort {
  snapshot(entities: EntityConfig[]): Promise<Snapshot>;
}
export interface SlackPort {
  identity(needsBot: boolean): Promise<void>;
  sections(): Promise<Section[]>;
  createSection(name: string): Promise<string>;
  channel(id: string, bot?: boolean): Promise<Channel>;
  createChannel(name: string, isPrivate: boolean): Promise<string>;
  hasOwner(id: string): Promise<boolean>;
  inviteOwner(id: string): Promise<void>;
  move(id: string, destination: string, sources: string[]): Promise<void>;
}
export interface BindingStore {
  get(key: string): Binding | undefined;
  put(key: string, value: Binding): void;
}
export type Operation = {
  type: "create-section" | "create-channel" | "invite-owner" | "move";
  entity?: string;
  channel?: string;
  section?: string;
  name?: string;
  private?: boolean;
};
export type SyncResult = {
  mode: "dry-run" | "apply";
  operations: Operation[];
  verified: string[];
};
