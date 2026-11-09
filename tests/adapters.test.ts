import { expect, test } from "bun:test";
import { type Fetcher, Http } from "../src/http";
import { Linear } from "../src/linear";
import { parseSections, Slack } from "../src/slack";
import { entityId, example } from "./helpers";

const response = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers });
const credentials = {
  session: "xoxc-FICTIONAL",
  cookie: "FICTIONAL-COOKIE",
  bot: "xoxb-FICTIONAL",
};
const url = "https://slack.com/api/auth.test";

test("HTTP 429 honors Retry-After with bounded attempts", async () => {
  let calls = 0;
  const waits: number[] = [];
  const http = new Http(
    async () => (++calls < 3 ? response({}, 429, { "retry-after": "2" }) : response({ ok: true })),
    async (ms) => {
      waits.push(ms);
    },
  );
  expect(await http.json(url, { method: "POST" }, "create")).toEqual({ ok: true });
  expect(calls).toBe(3);
  expect(waits).toEqual([2000, 2000]);
});

test("long Retry-After stops without sleeping or ignoring the server", async () => {
  const waits: number[] = [];
  const http = new Http(
    async () => response({}, 429, { "retry-after": "120" }),
    async (ms) => {
      waits.push(ms);
    },
  );
  await expect(http.json(url, {}, "read")).rejects.toMatchObject({ code: "RATE_LIMIT" });
  expect(waits).toEqual([]);
});

test.each([500, 502, 503, 504])("reads retry HTTP %i with bounded backoff", async (status) => {
  let calls = 0;
  const waits: number[] = [];
  const http = new Http(
    async () => (++calls === 4 ? response({ ok: true }) : response({}, status)),
    async (ms) => {
      waits.push(ms);
    },
  );
  await http.json(url, {}, "read");
  expect(waits).toEqual([500, 1000, 2000]);
  expect(calls).toBe(4);
});

test.each(["network", "server", "invalid-json"])(
  "ambiguous %s creation is never automatically replayed",
  async (mode) => {
    let calls = 0;
    const http = new Http(
      async () => {
        calls++;
        if (mode === "network") throw Error("FICTIONAL-SECRET");
        if (mode === "server") return response({ secret: "FICTIONAL-SECRET" }, 503);
        return new Response("FICTIONAL-SECRET");
      },
      async () => {},
    );
    await expect(http.json(url, {}, "create")).rejects.toMatchObject({ code: "UNCERTAIN_CREATE" });
    expect(calls).toBe(1);
  },
);

test("read network failures retry at most four times and omit underlying exception text", async () => {
  let calls = 0;
  const http = new Http(
    async () => {
      calls++;
      throw Error("FICTIONAL-SECRET");
    },
    async () => {},
  );
  try {
    await http.json(url, {}, "read");
    throw Error("unreachable");
  } catch (error) {
    expect(String(error)).not.toContain("FICTIONAL-SECRET");
  }
  expect(calls).toBe(4);
});

test("redirects are disabled, request has a timeout, and destinations are fixed", async () => {
  let calls = 0;
  const http = new Http(async (_url, init) => {
    calls++;
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    return response({ ok: true });
  });
  await http.json(url, {}, "read");
  await expect(http.json("https://example.com/api/auth.test", {}, "read")).rejects.toMatchObject({
    code: "DESTINATION",
  });
  expect(calls).toBe(1);
});

test("oversized response bodies fail closed", async () => {
  const http = new Http(async () => new Response(" ".repeat(8 * 1024 * 1024 + 1)));
  await expect(http.json(url, {}, "read")).rejects.toMatchObject({ code: "SCHEMA" });
});

test("Linear retries GraphQL RATELIMITED responses and rejects all partial GraphQL errors", async () => {
  let calls = 0;
  const http = new Http(
    async () => {
      calls++;
      return calls === 1
        ? response({ errors: [{ extensions: { code: "RATELIMITED" } }] })
        : response({
            errors: [{ message: "FICTIONAL-SECRET" }],
            data: { organization: { id: "ignored" } },
          });
    },
    async () => {},
  );
  const linear = new Linear("FICTIONAL-KEY", http);
  await expect(linear.snapshot(example().entities)).rejects.toMatchObject({ code: "LINEAR" });
  expect(calls).toBe(2);
});

test("Linear batches parameterized issue/project reads and returns canonical IDs/statuses", async () => {
  const config = example();
  const data = {
    organization: { id: config.linearWorkspaceId },
    e0: { id: entityId.toUpperCase(), archivedAt: null, state: { name: "Needs Leon" } },
    e1: {
      id: "22222222-2222-4222-8222-222222222222",
      archivedAt: null,
      status: { name: "Awaiting" },
      slackChannelId: "CPROJECT",
    },
    e2: {
      id: "33333333-3333-4333-8333-333333333333",
      archivedAt: null,
      state: { name: "Blocked" },
    },
  };
  let calls = 0;
  const http = new Http(async (url, init) => {
    calls++;
    expect(url).toBe("https://api.linear.app/graphql");
    expect(new Headers(init.headers).get("Authorization")).toBe("FICTIONAL-KEY");
    const body = JSON.parse(String(init.body));
    expect(body.query).toContain("e0: issue(id: $id0)");
    expect(body.query).toContain("e1: project(id: $id1)");
    expect(body.query).toContain("slackChannelId");
    expect(body.query).not.toContain("DEMO-1");
    expect(body.variables.id0).toBe("DEMO-1");
    return response({ data });
  });
  const result = await new Linear("FICTIONAL-KEY", http).snapshot(config.entities);
  expect(result.entities.map((entity) => entity.status)).toEqual([
    "Needs Leon",
    "Awaiting",
    "Blocked",
  ]);
  expect(result.entities[1]?.projectChannelId).toBe("CPROJECT");
  expect(calls).toBe(1);
});

test("Linear archived entity prevents a usable snapshot", async () => {
  const config = example();
  const http = new Http(async () =>
    response({
      data: {
        organization: { id: config.linearWorkspaceId },
        e0: { id: entityId, archivedAt: "2026-01-01", state: { name: "Needs Leon" } },
      },
    }),
  );
  await expect(new Linear("KEY", http).snapshot(config.entities.slice(0, 1))).rejects.toMatchObject(
    { code: "ARCHIVED_ENTITY" },
  );
});

function sectionResponse() {
  return {
    ok: true,
    channel_sections: [
      {
        channel_section_id: "S1",
        name: "Needs Leon",
        channel_ids_page: { channel_ids: ["CONE"], next_cursor: "", count: 1 },
      },
    ],
  };
}
test("internal sections accept the explicitly supported complete shape", () => {
  expect(parseSections(sectionResponse())).toEqual([
    { id: "S1", name: "Needs Leon", channels: ["CONE"] },
  ]);
});
test.each(["next_cursor", "has_more", "total_count", "missing-membership"])(
  "internal sections reject partial or missing %s",
  (key) => {
    const value = sectionResponse();
    const s = value.channel_sections[0];
    if (!s) throw Error("Missing test section");
    if (key === "missing-membership") Object.assign(s, { channel_ids_page: {} });
    else
      Object.assign(s.channel_ids_page, {
        [key]: key === "has_more" ? true : key === "total_count" ? 5 : "NEXT",
      });
    expect(() => parseSections(value)).toThrow();
  },
);

test("Slack separates bot and session credentials and removes all source memberships", async () => {
  const calls: { method: string; body: URLSearchParams; headers: Headers }[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const method = url.split("/").at(-1) ?? "";
    calls.push({
      method,
      body: new URLSearchParams(String(init.body)),
      headers: new Headers(init.headers),
    });
    if (method === "conversations.create") return response({ ok: true, channel: { id: "CNEW" } });
    return response({ ok: true });
  };
  const slack = new Slack(example(), credentials, new Http(fetcher));
  await slack.createChannel("linear-example", true);
  await slack.move("CNEW", "SDEST", ["SOLD", "SOTHER", "SDEST"]);
  expect(calls[0]?.body.get("is_private")).toBe("true");
  expect(calls[0]?.headers.get("Authorization")).toBe("Bearer xoxb-FICTIONAL");
  expect(calls[0]?.headers.has("cookie")).toBe(false);
  expect(calls[1]?.method).toBe("users.channelSections.channels.bulkUpdate");
  expect(calls[1]?.body.get("token")).toBe("xoxc-FICTIONAL");
  expect(calls[1]?.headers.get("Cookie")).toBe("d=FICTIONAL-COOKIE");
  expect(JSON.parse(calls[1]?.body.get("remove") ?? "null")).toEqual([
    { channel_section_id: "SOLD", channel_ids: ["CNEW"] },
    { channel_section_id: "SOTHER", channel_ids: ["CNEW"] },
  ]);
});

test("Slack identity guards owner and bot workspace before use", async () => {
  for (const mode of ["wrong-owner", "wrong-team", "wrong-bot"]) {
    let calls = 0;
    const http = new Http(async () => {
      calls++;
      return response(
        calls === 1
          ? {
              ok: true,
              team_id: mode === "wrong-team" ? "TOTHER" : "TEXAMPLE",
              user_id: mode === "wrong-owner" ? "UOTHER" : "UOWNER",
            }
          : { ok: true, team_id: "TOTHER", bot_id: "BFAKE" },
      );
    });
    await expect(new Slack(example(), credentials, http).identity(true)).rejects.toMatchObject({
      code: "IDENTITY",
    });
  }
});

test("Slack membership pagination finds owner on the second page", async () => {
  let calls = 0;
  const http = new Http(async (_url, init) => {
    calls++;
    expect(new URLSearchParams(String(init.body)).get("cursor")).toBe(calls === 1 ? "" : "NEXT");
    return response({
      ok: true,
      members: calls === 1 ? ["UOTHER"] : ["UOWNER"],
      response_metadata: { next_cursor: calls === 1 ? "NEXT" : "" },
    });
  });
  expect(await new Slack(example(), credentials, http).hasOwner("CONE")).toBe(true);
  expect(calls).toBe(2);
});

test("Slack pagination loops fail instead of silently losing membership", async () => {
  const http = new Http(async () =>
    response({ ok: true, members: [], response_metadata: { next_cursor: "LOOP" } }),
  );
  await expect(new Slack(example(), credentials, http).hasOwner("CONE")).rejects.toMatchObject({
    code: "PAGINATION",
  });
});

test("Slack name collision is refused and remote response text never escapes", async () => {
  const http = new Http(async () =>
    response({ ok: false, error: "name_taken", detail: "FICTIONAL-SECRET" }),
  );
  const slack = new Slack(example(), credentials, http);
  await expect(slack.createChannel("linear-example", true)).rejects.toMatchObject({
    code: "NAME_COLLISION",
  });
  const badHttp = new Http(async () => response({ ok: false, error: "FICTIONAL-SECRET" }));
  try {
    await new Slack(example(), credentials, badHttp).sections();
    throw Error("unreachable");
  } catch (error) {
    expect(String(error)).not.toContain("FICTIONAL-SECRET");
  }
});

test("Slack rejects full Cookie headers and mismatched channel readback", async () => {
  expect(() => new Slack(example(), { ...credentials, cookie: "d=FICTIONAL" })).toThrow();
  expect(() => new Slack(example(), { ...credentials, cookie: "FAKE; other=FAKE" })).toThrow();
  const http = new Http(async () =>
    response({
      ok: true,
      channel: { id: "COTHER", is_archived: false, is_member: true, is_private: true },
    }),
  );
  await expect(new Slack(example(), credentials, http).channel("CONE")).rejects.toMatchObject({
    code: "SCHEMA",
  });
});
