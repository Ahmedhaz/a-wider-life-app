// Thin PostgREST client. The Worker is the only client of the database and uses the service key;
// RLS keeps every other role out. Every call is a plain fetch, no SDK.

export interface Env {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_KEY?: string;
  ADMIN_SECRET?: string;
  BUILD?: string;
  ADMIN_ENABLED?: string;
  DEV_OPEN_ALL_COUNTRIES?: string;
}

export class DbError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export class Db {
  constructor(private url: string, private key: string) {}

  static from(env: Env): Db | null {
    const url = (env.SUPABASE_URL ?? "").trim().replace(/\/$/, "");
    const key = (env.SUPABASE_SERVICE_KEY ?? "").trim();
    if (!url || !key) return null;
    return new Db(url, key);
  }

  /**
   * What health may say about the connection without leaking a secret: the host the Worker talks to,
   * and the shape of the key (a legacy JWT and its role claim, a new sb_secret key, or something else).
   */
  describe(): { host: string; key: string } {
    let host = "invalid-url";
    try { host = new URL(this.url).host; } catch { /* keep the marker */ }
    let key = "unknown";
    if (this.key.startsWith("sb_secret_")) key = "sb_secret";
    else if (this.key.startsWith("sb_publishable_")) key = "sb_publishable";
    else if (this.key.startsWith("eyJ")) {
      try {
        const payload = JSON.parse(atob(this.key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
        key = `jwt:${payload.role ?? "no-role"}`;
      } catch { key = "jwt:unreadable"; }
    }
    return { host, key };
  }

  private async call<T>(method: string, table: string, query: string, body?: unknown, prefer?: string): Promise<T> {
    const res = await fetch(`${this.url}/rest/v1/${table}${query ? "?" + query : ""}`, {
      method,
      headers: {
        apikey: this.key,
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
        Prefer: prefer ?? (method === "GET" ? "" : "return=representation"),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new DbError(res.status, `${method} ${table}: ${res.status} ${text.slice(0, 300)}`);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Rows matching a PostgREST filter string, e.g. `code=eq.ABC&select=*`. */
  select<T>(table: string, query: string): Promise<T[]> { return this.call<T[]>("GET", table, query); }

  async one<T>(table: string, query: string): Promise<T | null> {
    const rows = await this.select<T>(table, query + "&limit=1");
    return rows[0] ?? null;
  }

  async insert<T>(table: string, row: unknown): Promise<T> {
    const rows = await this.call<T[]>("POST", table, "", row);
    return rows[0];
  }

  insertMany<T>(table: string, rows: unknown[]): Promise<T[]> { return this.call<T[]>("POST", table, "", rows); }

  /** Upsert on the table's unique constraint; `on` names the conflict columns. */
  upsert<T>(table: string, rows: unknown[], on: string): Promise<T[]> {
    return this.call<T[]>("POST", table, `on_conflict=${on}`, rows, "resolution=merge-duplicates,return=representation");
  }

  async update<T>(table: string, query: string, patch: unknown): Promise<T[]> {
    return this.call<T[]>("PATCH", table, query, patch);
  }

  del(table: string, query: string): Promise<void> { return this.call<void>("DELETE", table, query, undefined, "return=minimal"); }

  /** A cheap liveness probe: one row from a tiny table. Returns null when it works, else a short reason. */
  async ping(): Promise<string | null> {
    try { await this.select("flags", "select=id&limit=1"); return null; }
    catch (e) {
      if (e instanceof DbError) return `http ${e.status}: ${e.message.slice(0, 160)}`;
      return `fetch: ${String((e as Error)?.message ?? e).slice(0, 160)}`;
    }
  }
}

export const enc = (s: string) => encodeURIComponent(s);
