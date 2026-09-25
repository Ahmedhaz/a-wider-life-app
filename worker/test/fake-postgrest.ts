// An in-memory stand-in for PostgREST, good enough for the queries this Worker actually makes.
// Every database call in src/db.ts goes through one fetch to `${url}/rest/v1/${table}?${query}`, so
// stubbing global fetch is all it takes to run the real routes against real data — no new dependency,
// no workerd, and the handlers under test are the ones that ship.
//
// Supported, because that is what the Worker uses: eq, in, gte filters; select= projection; order=
// with .asc/.desc; limit=; POST with return=representation; PATCH; DELETE; and on_conflict upsert.
// Anything else throws loudly rather than quietly returning the wrong rows.

export type Row = Record<string, unknown>;

let tables: Record<string, Row[]> = {};
let seq = 0;

export function reset(seed: Record<string, Row[]> = {}) {
  tables = {};
  seq = 0;
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
}
export const table = (name: string): Row[] => (tables[name] ??= []);
const uid = () => `id-${++seq}`;

/** `col=op.value` → a predicate. PostgREST spells equality `eq.`, membership `in.(a,b)`. */
function predicate(col: string, expr: string): (r: Row) => boolean {
  const dot = expr.indexOf(".");
  const op = expr.slice(0, dot);
  const raw = expr.slice(dot + 1);
  switch (op) {
    case "eq": return (r) => String(r[col] ?? "") === raw;
    case "gte": return (r) => String(r[col] ?? "") >= raw;
    case "in": {
      const set = new Set(raw.replace(/^\(|\)$/g, "").split(",").map((v) => v.replace(/^"|"$/g, "")));
      return (r) => set.has(String(r[col] ?? ""));
    }
    default: throw new Error(`fake-postgrest: unsupported operator "${op}" on ${col}`);
  }
}

function project(rows: Row[], select: string | null): Row[] {
  if (!select || select === "*") return rows;
  const cols = select.split(",").map((c) => c.trim()).filter((c) => c && c !== "*");
  if (!cols.length) return rows;
  return rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
}

function query(name: string, params: URLSearchParams): Row[] {
  let rows = table(name).slice();
  for (const [k, v] of params) {
    if (["select", "order", "limit", "offset", "on_conflict"].includes(k)) continue;
    rows = rows.filter(predicate(k, v));
  }
  const order = params.get("order");
  if (order) {
    const [col, dir] = order.split(".");
    rows.sort((a, b) => (String(a[col] ?? "") < String(b[col] ?? "") ? -1 : 1) * (dir === "desc" ? -1 : 1));
  }
  const limit = params.get("limit");
  if (limit) rows = rows.slice(0, Number(limit));
  return rows;
}

/** Install as globalThis.fetch. Returns the previous value so a test can restore it. */
export function install(base = "https://db.test") {
  const prev = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!url.href.startsWith(base)) throw new Error(`fake-postgrest: unexpected fetch to ${url.href}`);
    const name = url.pathname.replace(/^\/rest\/v1\//, "");
    const params = url.searchParams;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const ok = (data: unknown, status = 200) =>
      new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

    if (method === "GET") return ok(project(query(name, params), params.get("select")));

    if (method === "POST") {
      const incoming: Row[] = (Array.isArray(body) ? body : [body]).map((r: Row) => ({ ...r }));
      const conflict = params.get("on_conflict")?.split(",") ?? null;
      const out: Row[] = [];
      for (const r of incoming) {
        if (conflict) {
          const hit = table(name).find((x) => conflict.every((c) => String(x[c] ?? "") === String(r[c] ?? "")));
          if (hit) { Object.assign(hit, r); out.push(hit); continue; }
        }
        // The real schema defaults id and created_at; tests rely on both existing.
        const row: Row = { id: uid(), created_at: new Date().toISOString(), ...r };
        table(name).push(row);
        out.push(row);
      }
      return ok(out, 201);
    }

    if (method === "PATCH") {
      const hits = query(name, params);
      for (const r of hits) Object.assign(r, body as Row);
      return ok(hits);
    }

    if (method === "DELETE") {
      const hits = new Set(query(name, params));
      tables[name] = table(name).filter((r) => !hits.has(r));
      return ok(null, 204);
    }

    throw new Error(`fake-postgrest: unsupported method ${method}`);
  }) as typeof fetch;
  return prev;
}

export const ENV = {
  SUPABASE_URL: "https://db.test",
  SUPABASE_SERVICE_KEY: "sb_secret_test",
  ADMIN_ENABLED: "true",
  ADMIN_SECRET: "test-admin-secret",
  APPLE_TEAM_ID: "TEAMID",
  IOS_BUNDLE_ID: "com.test.app",
  DEV_OPEN_ALL_COUNTRIES: "true",
  NOTIFY_ENABLED: "false",
  BUILD: "test",
};
