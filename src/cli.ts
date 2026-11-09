#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseConfig } from "./config";
import { fixturePorts } from "./fixture";
import { Linear } from "./linear";
import { fail, SyncError } from "./model";
import { type Credentials, Slack } from "./slack";
import { MemoryStore, State } from "./state";
import { sync } from "./sync";

const help = `Linear → Slack sections (Bun / TypeScript)

  bun run start --config CONFIG [--dry-run] [--state PATH]
  bun run start --config CONFIG --fixture FILE
  bun run start --config CONFIG --experimental-sidebar [--apply] [--watch]

Default: dry run. Offline fixtures never use credentials or apply writes.
Live reads and writes need --experimental-sidebar because Slack's personal
sidebar API is undocumented. --apply additionally enables configured writes.
--watch reconciles at pollIntervalSeconds (minimum 60); any error stops it.
--state defaults to $XDG_STATE_HOME/linear-slack-sections/bindings.sqlite
(otherwise ~/.local/state/linear-slack-sections/bindings.sqlite).

Secrets are read only from LINEAR_API_KEY, SLACK_XOXC_TOKEN, SLACK_D_COOKIE,
and optional SLACK_BOT_TOKEN. Never pass credentials in arguments or config.
`;

async function json(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fail("INPUT", "Could not read a JSON input file.");
  }
}
function secret(name: string) {
  const value = process.env[name];
  if (!value || /[\r\n]/.test(value))
    fail("CREDENTIALS", "Required environment credentials are absent or malformed.");
  return value;
}
export async function main(argv: string[]): Promise<number> {
  let state: State | undefined;
  try {
    let values: ReturnType<typeof parseArgs>["values"];
    try {
      ({ values } = parseArgs({
        args: argv,
        strict: true,
        allowPositionals: false,
        options: {
          config: { type: "string" },
          state: { type: "string" },
          fixture: { type: "string" },
          apply: { type: "boolean" },
          "dry-run": { type: "boolean" },
          "experimental-sidebar": { type: "boolean" },
          watch: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
      }));
    } catch {
      fail("ARGUMENTS", "Invalid CLI arguments. Use --help.");
    }
    if (values.help) {
      console.log(help);
      return 0;
    }
    if (typeof values.config !== "string")
      fail("ARGUMENTS", "Provide --config PATH or use --help.");
    if (values.apply && values["dry-run"]) fail("ARGUMENTS", "Choose either --apply or --dry-run.");
    if (values.fixture && (values.apply || values.watch))
      fail("ARGUMENTS", "Fixture mode supports a single offline dry run.");
    if (!values.fixture && !values["experimental-sidebar"])
      fail(
        "EXPERIMENTAL_GATE",
        "Live sidebar access requires --experimental-sidebar; read RESEARCH.md first.",
      );
    const config = parseConfig(await json(values.config));
    const apply = values.apply === true;
    const statePath =
      typeof values.state === "string"
        ? values.state
        : join(
            process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
            "linear-slack-sections",
            "bindings.sqlite",
          );
    const ports =
      typeof values.fixture === "string"
        ? fixturePorts(await json(values.fixture), config)
        : (() => {
            const credentials: Credentials = {
              session: secret("SLACK_XOXC_TOKEN"),
              cookie: secret("SLACK_D_COOKIE"),
            };
            if (process.env.SLACK_BOT_TOKEN) credentials.bot = secret("SLACK_BOT_TOKEN");
            return {
              linear: new Linear(secret("LINEAR_API_KEY")),
              slack: new Slack(config, credentials),
            };
          })();
    if (!values.fixture) state = new State(statePath, apply);
    const store = state ?? new MemoryStore();
    let stopped = false;
    let wake: (() => void) | undefined;
    const stop = () => {
      stopped = true;
      wake?.();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      do {
        console.log(
          JSON.stringify(await sync(config, ports.linear, ports.slack, store, apply), null, 2),
        );
        if (!values.watch || stopped) break;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, config.pollIntervalSeconds * 1000);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = undefined;
      } while (!stopped);
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    return 0;
  } catch (error) {
    // No raw exceptions, request headers, API bodies, or filesystem paths are logged.
    console.error(
      JSON.stringify(
        error instanceof SyncError
          ? { error: error.code, message: error.message }
          : {
              error: "INTERNAL",
              message:
                "Sync stopped; no further operations will run. Inspect local configuration and state.",
            },
      ),
    );
    return 1;
  } finally {
    state?.close();
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
