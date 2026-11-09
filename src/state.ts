import { Database } from "bun:sqlite";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { type Binding, type BindingStore, channelId, fail } from "./model";

export class MemoryStore implements BindingStore {
  readonly rows = new Map<string, Binding>();
  get(key: string) {
    return this.rows.get(key);
  }
  put(key: string, value: Binding) {
    this.rows.set(key, { ...value });
  }
}

export class State implements BindingStore {
  private db: Database | undefined;
  private lock: string | undefined;

  constructor(path: string, writable: boolean) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
      fail("STATE", "State path must not be a symbolic link.");
    if (!writable && !existsSync(path)) return;
    try {
      if (writable) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const lock = `${path}.lock`;
        let fd: number;
        try {
          fd = openSync(lock, "wx", 0o600);
        } catch {
          fail(
            "LOCKED",
            "State is locked. Verify the other process stopped before removing its lock file.",
          );
        }
        this.lock = lock;
        try {
          writeSync(fd, `${process.pid}\n`);
        } finally {
          closeSync(fd);
        }
        // Precreate with restricted permissions before SQLite opens it.
        if (!existsSync(path)) closeSync(openSync(path, "wx", 0o600));
      }
      this.db = new Database(path, { readonly: !writable, strict: true });
      if (writable) {
        this.db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
        this.db.exec(`CREATE TABLE IF NOT EXISTS bindings (
          key TEXT PRIMARY KEY, channelId TEXT, name TEXT, managed INTEGER NOT NULL,
          verifiedStatus TEXT
        ); CREATE TABLE IF NOT EXISTS metadata (version INTEGER NOT NULL);`);
        const version = this.db.query("SELECT version FROM metadata").get();
        if (!version) this.db.exec("INSERT INTO metadata VALUES (1)");
      }
      const version = this.db.query("SELECT version FROM metadata").get() as {
        version: number;
      } | null;
      if (version?.version !== 1)
        fail("STATE", "Unsupported state schema; use a separate state path.");
    } catch (error) {
      this.close();
      if (error instanceof Error && error.name === "SyncError") throw error;
      fail("STATE", "Could not open state database. Existing state was not reset.");
    }
  }
  get(key: string): Binding | undefined {
    if (!this.db) return undefined;
    const row = this.db
      .query("SELECT channelId, name, managed, verifiedStatus FROM bindings WHERE key = ?")
      .get(key) as {
      channelId: string | null;
      name: string | null;
      managed: number;
      verifiedStatus: string | null;
    } | null;
    if (!row) return undefined;
    if (
      (row.channelId !== null && !channelId.test(row.channelId)) ||
      (row.managed !== 0 && row.managed !== 1) ||
      (row.channelId === null && !row.name)
    ) {
      fail("STATE", "Saved binding is invalid. Inspect state; automatic replacement is disabled.");
    }
    return { ...row, managed: row.managed === 1 };
  }
  put(key: string, value: Binding) {
    if (!this.lock || !this.db) fail("STATE", "Refused a state write during dry run.");
    this.db
      .query(`INSERT INTO bindings (key, channelId, name, managed, verifiedStatus)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET
      channelId=excluded.channelId, name=excluded.name, managed=excluded.managed,
      verifiedStatus=excluded.verifiedStatus`)
      .run(key, value.channelId, value.name, Number(value.managed), value.verifiedStatus);
  }
  close() {
    this.db?.close();
    this.db = undefined;
    if (this.lock) unlinkSync(this.lock);
    this.lock = undefined;
  }
}
