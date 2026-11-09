import { Http } from "./http";
import {
  array,
  type Channel,
  type Config,
  channelId,
  fail,
  object,
  type Section,
  type SlackPort,
  string,
} from "./model";

export type Credentials = { session: string; cookie: string; bot?: string };

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean")
    fail("SCHEMA", "Expected a boolean from Slack; compatibility check failed.");
  return value;
}

// The internal schema has no published pagination contract. Reject evidence of partial results.
function complete(value: Record<string, unknown>) {
  for (const [key, v] of Object.entries(value)) {
    if (
      /^(?:next_cursor|cursor|next_page|next_marker)$/.test(key) &&
      v !== "" &&
      v !== null &&
      v !== undefined &&
      v !== false
    ) {
      fail(
        "PARTIAL_SECTIONS",
        "Incomplete section membership; undocumented pagination is unsupported.",
      );
    }
    if (/^(?:has_more|has_next_page|has_next|is_truncated)$/.test(key) && v !== false) {
      fail(
        "PARTIAL_SECTIONS",
        "Incomplete section membership; undocumented pagination is unsupported.",
      );
    }
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item && typeof item === "object") complete(object(item));
      }
    } else if (v && typeof v === "object") complete(object(v));
  }
}

export function parseSections(response: Record<string, unknown>): Section[] {
  complete(response);
  const seen = new Set<string>();
  const result = array(response.channel_sections).map((value) => {
    const s = object(value);
    const id = string(s.channel_section_id);
    if (seen.has(id)) fail("SCHEMA", "Duplicate section identity in Slack response.");
    seen.add(id);
    const page = object(s.channel_ids_page);
    const channels = array(page.channel_ids).map((id) => {
      const result = string(id);
      if (!channelId.test(result)) fail("SCHEMA", "Invalid channel identity in section response.");
      return result;
    });
    if (new Set(channels).size !== channels.length)
      fail("SCHEMA", "Duplicate section membership in Slack response.");
    for (const container of [s, page]) {
      for (const key of ["count", "total_count", "total", "channel_count"]) {
        if (container[key] !== undefined && container[key] !== channels.length) {
          fail("PARTIAL_SECTIONS", "Section membership count disagrees with returned channels.");
        }
      }
    }
    return { id, name: string(s.name), channels };
  });
  return result;
}

export class Slack implements SlackPort {
  constructor(
    private readonly config: Config,
    private readonly credentials: Credentials,
    private readonly http = new Http(),
  ) {
    if (
      !/^xoxc-[^\s;\r\n]+$/.test(credentials.session) ||
      !credentials.cookie ||
      /[;\s\r\n]/.test(credentials.cookie) ||
      credentials.cookie.startsWith("d=")
    ) {
      fail(
        "CREDENTIALS",
        "Expected approved session credentials injected through environment variables.",
      );
    }
    if (credentials.bot !== undefined && !/^xoxb-[^\s\r\n]+$/.test(credentials.bot))
      fail("CREDENTIALS", "Invalid bot credential format.");
  }

  private async call(
    method: string,
    params: Record<string, string> = {},
    bot = false,
    policy: "read" | "idempotent" | "create" = "read",
  ) {
    const token = bot ? this.credentials.bot : this.credentials.session;
    if (!token) fail("CREDENTIALS", "Channel provisioning requires SLACK_BOT_TOKEN.");
    const body = new URLSearchParams(params);
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
    if (bot) headers.Authorization = `Bearer ${token}`;
    else {
      body.set("token", token);
      headers.Cookie = `d=${this.credentials.cookie}`;
    }
    const response = await this.http.json(
      `https://slack.com/api/${method}`,
      { method: "POST", headers, body: body.toString() },
      policy,
    );
    if (response.ok !== true) {
      const code = response.error;
      if (code === "already_in_channel" && method === "conversations.invite") return response;
      if (code === "name_taken")
        fail(
          "NAME_COLLISION",
          "Channel name already exists. Inspect it and explicitly bind its ID; it was not adopted.",
        );
      if (code === "channel_not_found")
        fail(
          "STALE_BINDING",
          "Channel is missing or inaccessible. Inspect the saved binding and permissions; no replacement was created.",
        );
      fail(
        "SLACK",
        "Slack rejected the operation; check identity, permissions, or undocumented API compatibility.",
      );
    }
    return response;
  }

  async identity(needsBot: boolean) {
    const session = await this.call("auth.test");
    if (
      session.team_id !== this.config.slack.teamId ||
      session.user_id !== this.config.slack.ownerUserId
    ) {
      fail("IDENTITY", "Session must belong to the configured workspace and sidebar owner.");
    }
    if (needsBot) {
      const bot = await this.call("auth.test", {}, true);
      if (bot.team_id !== this.config.slack.teamId || typeof bot.bot_id !== "string") {
        fail("IDENTITY", "Bot must belong to the configured Slack workspace.");
      }
    }
  }
  async sections() {
    return parseSections(await this.call("users.channelSections.list"));
  }
  async createSection(name: string) {
    const response = await this.call(
      "users.channelSections.create",
      { name, emoji: "" },
      false,
      "create",
    );
    return string(response.channel_section_id);
  }
  async channel(id: string, bot = false): Promise<Channel> {
    const c = object((await this.call("conversations.info", { channel: id }, bot)).channel);
    if (c.id !== id || c.is_im === true || c.is_mpim === true)
      fail("SCHEMA", "Slack channel readback identity mismatch or unsupported conversation type.");
    return {
      id,
      archived: boolean(c.is_archived),
      member: boolean(c.is_member),
      private: boolean(c.is_private),
    };
  }
  async createChannel(name: string, isPrivate: boolean) {
    const response = await this.call(
      "conversations.create",
      { name, is_private: String(isPrivate) },
      true,
      "create",
    );
    const id = string(object(response.channel).id);
    if (!channelId.test(id))
      fail(
        "UNCERTAIN_CREATE",
        "Creation returned an invalid channel identity; inspect the pending binding.",
      );
    return id;
  }
  async hasOwner(id: string) {
    let cursor = "";
    const seen = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const response = await this.call(
        "conversations.members",
        { channel: id, limit: "200", cursor },
        true,
      );
      const members = array(response.members).map(string);
      if (members.includes(this.config.slack.ownerUserId)) return true;
      cursor =
        response.response_metadata === undefined
          ? ""
          : String(object(response.response_metadata).next_cursor ?? "");
      if (!cursor) return false;
      if (seen.has(cursor)) fail("PAGINATION", "Repeated Slack membership cursor.");
      seen.add(cursor);
    }
    return fail("PAGINATION", "Slack membership page limit exceeded.");
  }
  async inviteOwner(id: string) {
    await this.call(
      "conversations.invite",
      { channel: id, users: this.config.slack.ownerUserId },
      true,
      "idempotent",
    );
  }
  async move(id: string, destination: string, sources: string[]) {
    const entry = (section: string) => ({ channel_section_id: section, channel_ids: [id] });
    await this.call(
      "users.channelSections.channels.bulkUpdate",
      {
        insert: JSON.stringify([entry(destination)]),
        remove: JSON.stringify(sources.filter((s) => s !== destination).map(entry)),
      },
      false,
      "idempotent",
    );
  }
}
