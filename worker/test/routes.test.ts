// Route-level tests for the behaviour added over the last few builds, none of which had any:
// anonymous sessions, content-aware circles, the end of the programme, recovery codes, the funnel.
// These drive the real fetch handler against a fake PostgREST, so what is under test is what ships.
import { describe, it, expect, beforeEach, afterAll } from "vitest";
// Through the default export, so the error-to-JSON mapping in fetch() is under test too.
import worker from "../src/index";
import { install, reset, table, ENV, type Row } from "./fake-postgrest";

const prevFetch = install();
afterAll(() => { globalThis.fetch = prevFetch; });

const req = (path: string, init: RequestInit & { token?: string; admin?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.admin) headers.set("x-admin-secret", init.admin);
  if (init.body) headers.set("content-type", "application/json");
  return new Request(`https://w.test${path}`, { ...init, headers });
};
const call = async (path: string, init: RequestInit & { token?: string; admin?: string } = {}) => {
  const res = await worker.fetch(req(path, init), ENV as never);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

/** One article, enough for the engine to treat an arc as servable. */
const article = (lang: string, arc: string, week_no: number, extra: Row = {}): Row => ({
  id: `art-${lang}-${arc}-${week_no}`, lang, arc, week_no,
  trait_id: `trait-${arc}-${week_no}`, title: `${arc} week ${week_no}`, body_md: "body",
  act_full: "full", act_half: "half", act_min: "min", sign_hint: "sign",
  question: "q?", options: ["a", "b", "c"], ...extra,
});

let emailSeq = 0;
const register = (email?: string, password = "a-good-long-password") =>
  call("/v1/auth/register", { method: "POST", body: JSON.stringify({ email: email ?? `r${++emailSeq}@x.com`, password, lang: "ar" }) });

const entryBody = (circle: string) => JSON.stringify({
  timezone: "Africa/Cairo", open_day: 5,
  day_names: ["س", "ح", "ن", "ث", "ر", "خ", "ج"], witness_name: "صاحبي", circle,
});

/** self is complete, home has only its first week, work and people have nothing. Mirrors production. */
const seed = () => reset({
  articles: [...Array.from({ length: 13 }, (_, i) => article("ar", "self", i + 1)), article("ar", "home", 1)],
});

beforeEach(seed);

describe("flags: the server offers only what it can serve", () => {
  it("lists the arcs that have articles, and no others", async () => {
    const { body } = await call("/v1/flags?lang=ar");
    expect(body.circles).toEqual(["self", "home"]);
    expect(body.circles).not.toContain("work");
  });
  it("reports no circles for a language with no content", async () => {
    const { body } = await call("/v1/flags?lang=en");
    expect(body.circles).toEqual([]);
    expect(body.langs).toEqual(["ar"]);
  });
});

describe("registration", () => {
  it("mints an account, a copy and a session, and asks the reader to enter", async () => {
    const { status, body } = await register();
    expect(status).toBe(200);
    expect(body.state).toBe("entry");
    expect(body.token).toBeTruthy();
    expect(table("books")).toHaveLength(1);
    expect(table("books")[0].edition).toBe("digital");
    expect(String(table("books")[0].code)).toHaveLength(15);
  });
  it("gives every reader a different copy", async () => {
    const a = await register("a@x.com");
    const b = await register("b@x.com");
    expect(a.body.token).not.toBe(b.body.token);
    expect(table("books")[0].code).not.toBe(table("books")[1].code);
  });
});

describe("a circle with no articles is refused, not silently broken", () => {
  const open = async () => (await register()).body.token;

  it("rejects entry into an empty circle", async () => {
    const token = await open();
    const { status, body } = await call("/v1/entry", { method: "POST", token, body: entryBody("work") });
    expect(status).toBe(400);
    expect(body.code).toBe("circle_unavailable");
    expect(table("users")).toHaveLength(0);   // nothing half-created
  });

  it("accepts a circle that has content, and binds an article to week 1", async () => {
    const token = await open();
    const { status } = await call("/v1/entry", { method: "POST", token, body: entryBody("self") });
    expect(status).toBe(200);
    const week = table("weeks")[0];
    expect(week.article_id).toBe("art-ar-self-1");
    expect(week.trait_id).toBe("trait-self-1");   // without this the sheet can never complete
  });

  it("rotates the programme through arcs that exist only", async () => {
    const token = await open();
    await call("/v1/entry", { method: "POST", token, body: entryBody("home") });
    expect(table("program_state")[0].arc_order).toEqual(["home", "self"]);
  });
});

describe("the end of the programme is a state, not a broken week", () => {
  it("reports kind done once the arc runs out of articles", async () => {
    const token = (await register()).body.token;
    await call("/v1/entry", { method: "POST", token, body: entryBody("home") });
    // home has one article; push the reader to a week beyond it, as the calendar would.
    table("program_state")[0].week_no = 2;
    table("weeks")[0].week_no = 2;
    table("weeks")[0].article_id = null;
    table("weeks")[0].started_on = "2020-01-01";
    const { status, body } = await call("/v1/today", { token });
    expect(status).toBe(200);
    expect(body.kind).toBe("done");
  });
});

describe("recovery: the copy's code brings a reader back", () => {
  it("returns the code to a session that holds the copy, and restores from it", async () => {
    const token = (await register()).body.token;
    await call("/v1/entry", { method: "POST", token, body: entryBody("self") });

    const rec = await call("/v1/account", { method: "POST", token, body: JSON.stringify({ action: "recovery_code" }) });
    expect(rec.status).toBe(200);
    expect(rec.body.code).toHaveLength(15);
    expect(rec.body.printed).toMatch(/^\S{5} \S{5} \S{5}$/);

    // A new device holds nothing but the code.
    const back = await call("/v1/session/open", { method: "POST", body: JSON.stringify({ code: rec.body.code }) });
    expect(back.status).toBe(200);
    expect(back.body.state).toBe("ready");          // the reader already entered; not sent round again
    expect(back.body.token).not.toBe(token);        // a new session, not the old one
  });

  it("refuses an unknown code", async () => {
    const { status, body } = await call("/v1/session/open", { method: "POST", body: JSON.stringify({ code: "222222222222222" }) });
    expect(status).toBe(404);
    expect(body.code).toBe("unknown_code");
  });

  it("will not hand the code to a session that has not entered", async () => {
    const token = (await register()).body.token;
    const { status } = await call("/v1/account", { method: "POST", token, body: JSON.stringify({ action: "recovery_code" }) });
    expect(status).toBe(409);
  });
});

describe("admin", () => {
  it("hides every admin route when the secret is empty, rather than refusing with 401", async () => {
    // This is what an empty `wrangler secret put` produced in production: 404 everywhere, not 401.
    const res = await worker.fetch(req("/v1/admin/funnel", { admin: "anything" }), { ...ENV, ADMIN_SECRET: "" } as never);
    expect(res.status).toBe(404);
  });
  it("refuses a wrong secret with 401", async () => {
    const { status } = await call("/v1/admin/funnel", { admin: "wrong" });
    expect(status).toBe(401);
  });

  it("counts the funnel within one cohort", async () => {
    // Two anonymous readers, one of whom enters; plus a print reader who must not touch the shares.
    const a = (await register()).body.token;
    await register("second@x.com");
    await call("/v1/entry", { method: "POST", token: a, body: entryBody("self") });
    table("books").push({ id: "print-1", code: "PRINT0000000001", edition: "print", lang: "ar", batch: "b", user_id: "ghost" });
    table("users").push({ id: "ghost", lang: "ar" });

    const { body } = await call("/v1/admin/funnel", { admin: ENV.ADMIN_SECRET });
    const step = (n: string) => body.steps.find((s: { step: string }) => s.step === n);
    expect(step("opened_app").n).toBe(2);              // digital only
    expect(step("finished_entry").n).toBe(1);          // the print reader is not in this cohort
    expect(step("finished_entry").of_opened).toBe(50);
    expect(body.total_users_all_editions).toBe(2);
    expect(step("completed_a_sheet").n).toBe(0);       // nothing filled in yet
  });
});

describe("the door: register and log in", () => {
  const login = (email: string, password: string) =>
    call("/v1/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });

  it("refuses a bad address and a short password, creating nothing", async () => {
    expect((await register("not-an-address")).status).toBe(400);
    expect((await register("ok@x.com", "short")).body.code).toBe("password_too_short");
    expect(table("accounts")).toHaveLength(0);
  });

  it("refuses a second account on the same address, whatever its case", async () => {
    expect((await register("Ahmed@Example.com")).status).toBe(200);
    const again = await register("ahmed@example.COM");
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("email_taken");
    expect(table("accounts")).toHaveLength(1);
  });

  it("never stores the password", async () => {
    await register("keep@x.com", "the-actual-password");
    const stored = JSON.stringify(table("accounts")[0]);
    expect(stored).not.toContain("the-actual-password");
    expect(String(table("accounts")[0].password_hash)).toMatch(/^pbkdf2\$\d+\$/);
  });

  it("logs in with the right password and returns the same copy", async () => {
    const reg = await register("me@x.com", "a-good-long-password");
    const ok = await login("ME@x.com", "a-good-long-password");   // case-insensitive
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
    expect(ok.body.token).not.toBe(reg.body.token);               // a new session, not the old one
    expect(table("books")).toHaveLength(1);                       // logging in does not mint a second copy
  });

  it("answers a wrong password and an unknown address identically", async () => {
    await register("real@x.com", "a-good-long-password");
    const wrongPw = await login("real@x.com", "not-the-password");
    const noSuch = await login("ghost@x.com", "not-the-password");
    expect(wrongPw.status).toBe(401);
    expect(noSuch.status).toBe(401);
    expect(wrongPw.body).toEqual(noSuch.body);                    // no account enumeration
  });

  it("locks an account after repeated failures, and a lock outlasts the right password", async () => {
    await register("target@x.com", "a-good-long-password");
    for (let i = 0; i < 8; i++) await login("target@x.com", `guess-${i}`);
    expect(table("accounts")[0].locked_until).toBeTruthy();
    const blocked = await login("target@x.com", "a-good-long-password");
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe("too_many_attempts");
  });

  it("clears the failure count on a correct password", async () => {
    await register("clears@x.com", "a-good-long-password");
    await login("clears@x.com", "wrong");
    expect(table("accounts")[0].failed_attempts).toBe(1);
    await login("clears@x.com", "a-good-long-password");
    expect(table("accounts")[0].failed_attempts).toBe(0);
  });

  it("logs out by destroying the session, and the token stops working", async () => {
    const token = (await register()).body.token;
    expect((await call("/v1/today", { token })).status).toBe(409);   // authenticated, just not entered
    expect((await call("/v1/auth/logout", { method: "POST", token })).status).toBe(204);
    expect((await call("/v1/today", { token })).status).toBe(401);
  });

  it("still lets a recovery code back in, which is the forgotten-password path", async () => {
    const token = (await register("forgot@x.com")).body.token;
    await call("/v1/entry", { method: "POST", token, body: entryBody("self") });
    const code = (await call("/v1/account", { method: "POST", token, body: JSON.stringify({ action: "recovery_code" }) })).body.code;
    const back = await call("/v1/session/open", { method: "POST", body: JSON.stringify({ code }) });
    expect(back.status).toBe(200);
    expect(back.body.state).toBe("ready");
  });

  it("has no anonymous door left", async () => {
    // The path now falls through to the authenticated section, so it answers 401 rather than 404.
    // What matters is the property, not the number: nothing is minted without credentials.
    const { status } = await call("/v1/session/anon", { method: "POST", body: JSON.stringify({ lang: "ar" }) });
    expect(status).not.toBe(200);
    expect(table("sessions")).toHaveLength(0);
    expect(table("books")).toHaveLength(0);
    expect(table("accounts")).toHaveLength(0);
  });
});
