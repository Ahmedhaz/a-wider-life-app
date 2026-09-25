// A Wider Life · the Worker. The server is the product: every rule runs here from stored state and the
// reader's local time. The client renders what this returns and never computes a rule.

import { Db, DbError, Env, enc } from "./db";
import { generateCode, normaliseCode, printedForm, sha256Hex, randomToken } from "./codes";
import {
  localTime, dayIndex, weekStartDate, firstWeekStart, visibility, nextDose, weekStartReset, closeDay, assemblePulse,
  counts, sheetComplete, cleanField, addDays, OPEN_DAY, QUESTION_DAY, ACTING_DAYS, isActingDay,
  type Dose, type Answer, type LocalTime,
} from "./engine";
import { RESOURCES, countryOf } from "./countries";

type Arc = "self" | "home" | "work" | "people";
const ARCS: Arc[] = ["self", "home", "work", "people"];
const WEEKS_PER_ARC = 13;

interface Book { id: string; code: string; edition: string; lang: "ar" | "en"; batch: string; first_scan_at: string | null; user_id: string | null }
interface User { id: string; book_id: string; email: string | null; lang: "ar" | "en"; timezone: string; open_day: number; day_names: string[]; witness_name: string | null; status: string; first_local_date: string; created_at: string }
interface State { user_id: string; arc: Arc; arc_order: Arc[]; week_no: number; dose: Dose; consecutive_empty: number; last_answer_at: string | null; last_closed_date: string | null }
interface Article { id: string; lang: string; arc: Arc; week_no: number; trait_id: string; title: string; body_md: string; act_full: string; act_half: string; act_min: string; sign_hint: string; question: string; options: string[] }
interface Pulse { id: string; article_id: string; day_index: number; observation: string; audio_key: string | null; act_audio_keys: Record<string, string> | null }
interface Week { id: string; user_id: string; week_no: number; article_id: string | null; circle: Arc; trait_id: string | null; anchor_text: string | null; act_full: string | null; act_half: string | null; act_min: string | null; sign_text: string | null; started_on: string; locked_at: string | null }
interface Entry { id: string; user_id: string; week_id: string; local_date: string; day_index: number; answer: Answer; dose_served: Dose | null; option: number | null; responded_at: string }
interface Session { token_hash: string; book_id: string; user_id: string | null }

// ---------- http helpers ----------

class HttpError extends Error { constructor(public status: number, public code: string, message?: string) { super(message ?? code); } }

const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS, ...extra } });

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, idempotency-key, x-admin-secret",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
};

async function body<T = Record<string, unknown>>(req: Request): Promise<T> {
  try { return (await req.json()) as T; } catch { throw new HttpError(400, "bad_json"); }
}

// ---------- context per request ----------

interface Ctx {
  db: Db;
  now: Date;
  session: Session;
  book: Book;
  user: User | null;
}

async function authenticate(db: Db, req: Request): Promise<Session> {
  const h = req.headers.get("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!token) throw new HttpError(401, "no_session");
  const s = await db.one<Session>("sessions", `token_hash=eq.${await sha256Hex(token)}&select=token_hash,book_id,user_id`);
  if (!s) throw new HttpError(401, "no_session");
  return s;
}

async function loadCtx(db: Db, req: Request): Promise<Ctx> {
  const session = await authenticate(db, req);
  const book = (await db.one<Book>("books", `id=eq.${session.book_id}&select=*`))!;
  const user = book.user_id ? await db.one<User>("users", `id=eq.${book.user_id}&select=*`) : null;
  return { db, now: new Date(), session, book, user };
}

function requireUser(ctx: Ctx): User {
  if (!ctx.user) throw new HttpError(409, "entry_incomplete");
  if (ctx.user.status === "left") throw new HttpError(410, "account_left");
  return ctx.user;
}

// ---------- programme helpers ----------

function arcForWeek(order: Arc[], weekNo: number): { arc: Arc; arcWeek: number } {
  const i = Math.min(Math.max(order.length - 1, 0), Math.floor((weekNo - 1) / WEEKS_PER_ARC));
  return { arc: order[i], arcWeek: ((weekNo - 1) % WEEKS_PER_ARC) + 1 };
}

/** The programme order: the chosen circle first, the rest after it, wrapping. */
function rotate(arcs: Arc[], first: Arc): Arc[] {
  const i = arcs.indexOf(first);
  return i < 0 ? arcs : [...arcs.slice(i), ...arcs.slice(0, i)];
}

async function articleFor(db: Db, lang: string, arc: Arc, arcWeek: number): Promise<Article | null> {
  return db.one<Article>("articles", `lang=eq.${lang}&arc=eq.${arc}&week_no=eq.${arcWeek}&select=*`);
}

/** Arcs with at least one article in this language, in programme order. Never offer what cannot be served. */
async function availableArcs(db: Db, lang: string): Promise<Arc[]> {
  const rows = await db.select<{ arc: Arc }>("articles", `lang=eq.${enc(lang)}&select=arc`);
  const have = new Set(rows.map((r) => r.arc));
  return ARCS.filter((a) => have.has(a));
}

/** Languages with at least one article. The UI hides a language it cannot serve. */
async function availableLangs(db: Db): Promise<string[]> {
  const rows = await db.select<{ lang: string }>("articles", `select=lang`);
  return [...new Set(rows.map((r) => r.lang))].sort();
}

/** Load state and the current week; start a new week when the reader's local calendar says so. */
async function currentWeek(ctx: Ctx, user: User, local: LocalTime): Promise<{ state: State; week: Week; article: Article | null }> {
  const { db } = ctx;
  let state = (await db.one<State>("program_state", `user_id=eq.${user.id}&select=*`))!;
  let week = await db.one<Week>("weeks", `user_id=eq.${user.id}&week_no=eq.${state.week_no}&select=*`);
  const startDate = weekStartDate(local, user.open_day);
  if (week && week.started_on < startDate && state.week_no < 52) {
    // the first request on or after the first day of a new local week
    const weekNo = state.week_no + 1;
    const { arc, arcWeek } = arcForWeek(state.arc_order, weekNo);
    const art = await articleFor(db, user.lang, arc, arcWeek);
    const reset = weekStartReset();
    [state] = await db.update<State>("program_state", `user_id=eq.${user.id}`, { week_no: weekNo, arc, dose: reset.dose, consecutive_empty: reset.consecutiveEmpty });
    week = await db.insert<Week>("weeks", { user_id: user.id, week_no: weekNo, article_id: art?.id ?? null, circle: arc, trait_id: art?.trait_id ?? null, started_on: startDate });
  }
  if (!week) throw new HttpError(500, "no_week");
  const article = week.article_id ? await db.one<Article>("articles", `id=eq.${week.article_id}&select=*`) : null;
  return { state, week, article };
}

async function weekEntries(db: Db, user: User, week: Week): Promise<Entry[]> {
  return db.select<Entry>("entries", `user_id=eq.${user.id}&week_id=eq.${week.id}&select=*&order=day_index.asc`);
}

/** The sheet as the engine needs it; only called after sheetComplete(). Missing doses fall back to the full act. */
function acts(week: Week) {
  const full = week.act_full ?? "";
  return { act_full: full, act_half: week.act_half ?? full, act_min: week.act_min ?? week.act_half ?? full, sign_text: week.sign_text ?? "" };
}

/** True until the reader's first day arrives: sheet open, no pulse, no answer, no day-close. */
const beforeStart = (local: LocalTime, week: Week) => local.date < week.started_on;

function strip(week: Week, entries: Entry[], user: User) {
  const byIdx = new Map(entries.map((e) => [e.day_index, e]));
  return Array.from({ length: 7 }, (_, i) => {
    const idx = i + 1;
    const e = byIdx.get(idx);
    return { day_index: idx, name: user.day_names[i], kind: idx === OPEN_DAY ? "open" : idx === QUESTION_DAY ? "question" : "act", answer: e?.answer ?? null };
  });
}

function resourcesFor(user: User, env: Env) {
  const cc = countryOf(user.timezone);
  return cc ? RESOURCES[cc] ?? null : null;
}

function sheetView(week: Week, article: Article | null, locked: boolean) {
  return {
    week_no: week.week_no, circle: week.circle, trait_id: week.trait_id,
    trait_label: article?.title ?? null, done: !article, anchor_text: week.anchor_text,
    act_full: week.act_full, act_half: week.act_half, act_min: week.act_min, sign_text: week.sign_text,
    locked, started_on: week.started_on,
    article: article ? { id: article.id, title: article.title, trait_id: article.trait_id, body_md: article.body_md, act_full: article.act_full, act_half: article.act_half, act_min: article.act_min, sign_hint: article.sign_hint } : null,
  };
}

// ---------- endpoints ----------

async function sessionOpen(db: Db, req: Request): Promise<Response> {
  const b = await body<{ code?: string }>(req);
  const code = normaliseCode(b.code ?? "");
  if (!code) throw new HttpError(404, "unknown_code");
  const book = await db.one<Book>("books", `code=eq.${enc(code)}&select=*`);
  if (!book) throw new HttpError(404, "unknown_code");
  const token = randomToken();
  await db.insert("sessions", { token_hash: await sha256Hex(token), book_id: book.id, user_id: book.user_id });
  if (!book.first_scan_at) await db.update("books", `id=eq.${book.id}`, { first_scan_at: new Date().toISOString() });
  return json({ token, lang: book.lang, state: book.user_id ? "ready" : "entry" });
}

/** No printed copy and no code: mint an anchor row so a session still hangs off a book, the way every
 *  handler downstream expects, and open on it. The code is generated but never shown to anyone. */
async function sessionAnon(db: Db, req: Request): Promise<Response> {
  const b = await body<{ lang?: string }>(req);
  const lang = b.lang === "en" ? "en" : "ar";
  const book = await db.insert<Book>("books", {
    code: generateCode(), lang, edition: "digital", batch: "open", first_scan_at: new Date().toISOString(),
  });
  const token = randomToken();
  await db.insert("sessions", { token_hash: await sha256Hex(token), book_id: book.id, user_id: null });
  return json({ token, lang, state: "entry" });
}

async function entry(ctx: Ctx, req: Request, env: Env): Promise<Response> {
  if (ctx.user) throw new HttpError(409, "already_entered");
  const b = await body<{ timezone?: string; open_day?: number; day_names?: string[]; witness_name?: string; circle?: Arc }>(req);
  const timezone = String(b.timezone ?? "");
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); } catch { throw new HttpError(400, "bad_timezone"); }
  const openDay = Number(b.open_day);
  if (!Number.isInteger(openDay) || openDay < 0 || openDay > 6) throw new HttpError(400, "bad_open_day");
  const names = Array.isArray(b.day_names) ? b.day_names.map((n) => cleanField(n) ?? "") : [];
  if (names.length !== 7 || names.some((n) => !n)) throw new HttpError(400, "bad_day_names");
  const circle = (b.circle ?? "self") as Arc;
  if (!ARCS.includes(circle)) throw new HttpError(400, "bad_circle");
  if (!countryOf(timezone) && env.DEV_OPEN_ALL_COUNTRIES !== "true") throw new HttpError(451, "country_not_open");
  if (!(await availableArcs(ctx.db, ctx.book.lang)).includes(circle)) throw new HttpError(400, "circle_unavailable");

  const local = localTime(ctx.now, timezone);
  // No week starts without a sheet (PRD section 6): the first week begins on the reader's next first day.
  // Entering on the first day itself starts today; any other day, the sheet is open until then and nothing counts.
  const start = firstWeekStart(local, openDay);
  const user = await ctx.db.insert<User>("users", {
    book_id: ctx.book.id, lang: ctx.book.lang, timezone, open_day: openDay, day_names: names,
    witness_name: cleanField(b.witness_name), first_local_date: start,
  });
  const order = rotate(await availableArcs(ctx.db, user.lang), circle);
  await ctx.db.insert("program_state", { user_id: user.id, arc: circle, arc_order: order, week_no: 1 });
  const art = await articleFor(ctx.db, user.lang, circle, 1);
  await ctx.db.insert("weeks", { user_id: user.id, week_no: 1, article_id: art?.id ?? null, circle, trait_id: art?.trait_id ?? null, started_on: start });
  await ctx.db.update("books", `id=eq.${ctx.book.id}`, { user_id: user.id });
  await ctx.db.update("sessions", `book_id=eq.${ctx.book.id}`, { user_id: user.id });
  return json({ ok: true, user: publicUser(user) });
}

function publicUser(u: User) {
  return { lang: u.lang, timezone: u.timezone, open_day: u.open_day, day_names: u.day_names, witness_name: u.witness_name, status: u.status, email_linked: Boolean(u.email) };
}

async function today(ctx: Ctx, env: Env): Promise<Response> {
  const user = requireUser(ctx);
  const local = localTime(ctx.now, user.timezone);
  const { state, week, article } = await currentWeek(ctx, user, local);
  const before = beforeStart(local, week);
  const vis = before ? { today: 1, answerable: false, next: null as number | null, sheetLocked: false } : visibility(local, user.open_day);
  const firstDay = before || vis.today === 1;
  const entries = await weekEntries(ctx.db, user, week);
  const todayEntry = entries.find((e) => e.local_date === local.date) ?? null;
  const pulses = article ? await ctx.db.select<Pulse>("pulses", `article_id=eq.${article.id}&select=*`) : [];
  const pulseFor = (idx: number) => {
    if (!article || !isActingDay(idx) || idx === 1) return null;
    const p = pulses.find((x) => x.day_index === idx - 1); // day 1 is the article; pulses cover days 2..6 as day_index 1..5
    if (!p || !sheetComplete(week)) return null;
    return assemblePulse(p, acts(week), article, state.dose);
  };
  const witnessLine = firstDay && user.witness_name
    ? { open_day: user.day_names[6], witness: user.witness_name } : null;
  return json({
    local: { date: local.date, hour: local.hour },
    week_no: week.week_no, day: vis.today, status: user.status,
    kind: !article && !before ? "done" : before ? "before" : vis.today === OPEN_DAY ? "open" : vis.today === QUESTION_DAY ? "question" : vis.today === 1 ? "first" : "act",
    starts_on: before ? week.started_on : null,
    dose: state.dose, answered: todayEntry?.answer ?? null, answerable: vis.answerable && !todayEntry && user.status === "active",
    sheet_complete: sheetComplete(week), sheet_locked: vis.sheetLocked,
    pulse: pulseFor(vis.today),
    next: vis.next ? { day: vis.next, pulse: pulseFor(vis.next) } : null,
    question: vis.today === QUESTION_DAY && article ? { text: article.question, options: article.options } : null,
    first: firstDay && article ? { title: article.title, act_full: article.act_full, act_half: article.act_half, act_min: article.act_min, sign_hint: article.sign_hint } : null,
    witness: witnessLine,
    strip: strip(week, entries, user),
    resources: resourcesFor(user, env),
  });
}

async function answer(ctx: Ctx, req: Request): Promise<Response> {
  const user = requireUser(ctx);
  if (user.status !== "active") throw new HttpError(409, "paused");
  const b = await body<{ answer?: string }>(req);
  const a = b.answer;
  if (a !== "done" && a !== "smaller") throw new HttpError(400, "bad_answer");
  const local = localTime(ctx.now, user.timezone);
  const { state, week, article } = await currentWeek(ctx, user, local);
  if (beforeStart(local, week)) throw new HttpError(409, "not_started");
  const idx = dayIndex(local.dow, user.open_day);
  if (!isActingDay(idx)) throw new HttpError(409, "not_an_acting_day");
  if (!sheetComplete(week)) throw new HttpError(409, "sheet_incomplete");
  const existing = await ctx.db.one<Entry>("entries", `user_id=eq.${user.id}&local_date=eq.${local.date}&select=id`);
  if (existing) throw new HttpError(409, "already_answered");
  const served = state.dose;
  const dose = nextDose(served, a);
  await ctx.db.insert("entries", { user_id: user.id, week_id: week.id, local_date: local.date, day_index: idx, answer: a, dose_served: served });
  await ctx.db.update("program_state", `user_id=eq.${user.id}`, { dose, consecutive_empty: 0, last_answer_at: ctx.now.toISOString() });
  let smaller = null;
  if (a === "smaller" && article && idx > 1) {
    const p = await ctx.db.one<Pulse>("pulses", `article_id=eq.${article.id}&day_index=eq.${idx - 1}&select=*`);
    if (p) smaller = assemblePulse(p, acts(week), article, dose);
  }
  return json({ ok: true, answer: a, dose, smaller });
}

async function question(ctx: Ctx, req: Request): Promise<Response> {
  const user = requireUser(ctx);
  const b = await body<{ option?: number }>(req);
  const opt = Number(b.option);
  if (![0, 1, 2].includes(opt)) throw new HttpError(400, "bad_option");
  const local = localTime(ctx.now, user.timezone);
  const { week } = await currentWeek(ctx, user, local);
  if (beforeStart(local, week)) throw new HttpError(409, "not_started");
  if (dayIndex(local.dow, user.open_day) !== QUESTION_DAY) throw new HttpError(409, "not_question_day");
  const existing = await ctx.db.one<Entry>("entries", `user_id=eq.${user.id}&local_date=eq.${local.date}&select=id`);
  if (existing) throw new HttpError(409, "already_answered");
  await ctx.db.insert("entries", { user_id: user.id, week_id: week.id, local_date: local.date, day_index: QUESTION_DAY, answer: "question", option: opt });
  return json({ ok: true });
}

async function weekGet(ctx: Ctx): Promise<Response> {
  const user = requireUser(ctx);
  const local = localTime(ctx.now, user.timezone);
  const { week, article } = await currentWeek(ctx, user, local);
  const locked = !beforeStart(local, week) && visibility(local, user.open_day).sheetLocked;
  return json({ ...sheetView(week, article, locked), witness: user.witness_name, open_day_name: user.day_names[6], starts_on: week.started_on });
}

async function weekPut(ctx: Ctx, req: Request): Promise<Response> {
  const user = requireUser(ctx);
  const local = localTime(ctx.now, user.timezone);
  const { state, week, article } = await currentWeek(ctx, user, local);
  const locked = !beforeStart(local, week) && visibility(local, user.open_day).sheetLocked;
  if (locked || week.locked_at) return json({ code: "sheet_locked", message_key: "sheet_locked" }, 423);
  const b = await body(req);
  const patch: Record<string, unknown> = {};
  for (const f of ["anchor_text", "act_full", "act_half", "act_min", "sign_text"]) if (f in b) patch[f] = cleanField(b[f]);
  if ("trait_id" in b) {
    const t = cleanField(b.trait_id);
    if (t !== (article?.trait_id ?? null)) {
      // a different trait of this circle: the week's article changes with it
      const art = await ctx.db.one<Article>("articles", `lang=eq.${user.lang}&arc=eq.${week.circle}&trait_id=eq.${enc(t ?? "")}&select=*`);
      if (!art) throw new HttpError(400, "unknown_trait");
      patch.trait_id = art.trait_id; patch.article_id = art.id;
    }
  }
  if ("circle" in b && b.circle !== week.circle) {
    const c = b.circle as Arc;
    if (!ARCS.includes(c)) throw new HttpError(400, "bad_circle");
    // moving to week 1 of another circle: the programme order rotates to start there
    const avail = await availableArcs(ctx.db, user.lang);
    if (!avail.includes(c)) throw new HttpError(400, "circle_unavailable");
    const order = rotate(avail, c);
    const art = await articleFor(ctx.db, user.lang, c, 1);
    await ctx.db.update("program_state", `user_id=eq.${user.id}`, { arc: c, arc_order: order });
    patch.circle = c; patch.trait_id = art?.trait_id ?? null; patch.article_id = art?.id ?? null;
    void state;
  }
  const [updated] = await ctx.db.update<Week>("weeks", `id=eq.${week.id}`, patch);
  const art = updated.article_id ? await ctx.db.one<Article>("articles", `id=eq.${updated.article_id}&select=*`) : null;
  return json(sheetView(updated, art, false));
}

async function weekPin(ctx: Ctx): Promise<Response> {
  const user = requireUser(ctx);
  const local = localTime(ctx.now, user.timezone);
  const { week, article } = await currentWeek(ctx, user, local);
  const locked = !beforeStart(local, week) && visibility(local, user.open_day).sheetLocked;
  if (locked) return json({ code: "sheet_locked", message_key: "sheet_locked" }, 423);
  if (!article) throw new HttpError(409, "no_article");
  const [updated] = await ctx.db.update<Week>("weeks", `id=eq.${week.id}`, {
    act_full: article.act_full, act_half: article.act_half, act_min: article.act_min, sign_text: article.sign_hint, trait_id: article.trait_id,
  });
  return json(sheetView(updated, article, false));
}

async function notebook(ctx: Ctx, env: Env): Promise<Response> {
  const user = requireUser(ctx);
  const local = localTime(ctx.now, user.timezone);
  const { week } = await currentWeek(ctx, user, local);
  const since = addDays(local.date, -41);
  const entries = await ctx.db.select<Entry>("entries", `user_id=eq.${user.id}&local_date=gte.${since}&select=local_date,day_index,answer&order=local_date.asc`);
  const all = await ctx.db.select<Entry>("entries", `user_id=eq.${user.id}&select=local_date,answer`);
  const c = counts(all, user.first_local_date, local.date, user.open_day);
  const weeks = await ctx.db.select<Week>("weeks", `user_id=eq.${user.id}&select=week_no,circle,trait_id,article_id,started_on&order=week_no.desc`);
  // The reader sees the article's title, never the trait slug.
  const ids = [...new Set(weeks.map((w) => (w as unknown as { article_id: string | null }).article_id).filter(Boolean))] as string[];
  const arts = ids.length ? await ctx.db.select<Article>("articles", `id=in.(${ids.join(",")})&select=id,title`) : [];
  const titleOf = new Map(arts.map((a) => [a.id, a.title]));
  const weekList = weeks.map((w) => {
    const { article_id, ...rest } = w as unknown as { article_id: string | null } & Record<string, unknown>;
    return { ...rest, trait_label: article_id ? titleOf.get(article_id) ?? null : null };
  });
  return json({ count: c, current_week: week.week_no, grid: entries, weeks: weekList, resources: resourcesFor(user, env) });
}

async function weekPast(ctx: Ctx, n: number): Promise<Response> {
  const user = requireUser(ctx);
  const week = await ctx.db.one<Week>("weeks", `user_id=eq.${user.id}&week_no=eq.${n}&select=*`);
  if (!week) throw new HttpError(404, "no_such_week");
  const article = week.article_id ? await ctx.db.one<Article>("articles", `id=eq.${week.article_id}&select=*`) : null;
  const entries = await weekEntries(ctx.db, user, week);
  return json({ ...sheetView(week, article, true), strip: strip(week, entries, user) });
}

/** A native shell registers its push token here. Dormant until NOTIFY_ENABLED is "true"; nothing sends yet. */
async function device(ctx: Ctx, req: Request, env: Env): Promise<Response> {
  if (env.NOTIFY_ENABLED !== "true") throw new HttpError(404, "not_found");
  const user = requireUser(ctx);
  const b = await body<{ platform?: string; token?: string }>(req);
  const platform = b.platform === "ios" || b.platform === "android" ? b.platform : null;
  const token = typeof b.token === "string" ? b.token.trim().slice(0, 512) : "";
  if (!platform || !token) throw new HttpError(400, "bad_device");
  await ctx.db.upsert("devices", [{ user_id: user.id, platform, token, seen_at: ctx.now.toISOString() }], "token");
  return json({ ok: true });
}

async function account(ctx: Ctx, req: Request): Promise<Response> {
  const b = await body<{ action?: string; email?: string }>(req);
  const { db, book } = ctx;
  switch (b.action) {
    case "pause": case "resume": {
      const user = requireUser(ctx);
      const [u] = await db.update<User>("users", `id=eq.${user.id}`, { status: b.action === "pause" ? "paused" : "active" });
      return json({ ok: true, user: publicUser(u) });
    }
    case "link_email": {
      const user = requireUser(ctx);
      const email = String(b.email ?? "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "bad_email");
      const [u] = await db.update<User>("users", `id=eq.${user.id}`, { email });
      return json({ ok: true, user: publicUser(u) });
    }
    case "start_over": case "delete": {
      // Both remove everything bound to this copy in one sweep. start_over returns the code to unscanned;
      // delete does the same and ends this session. Real deletes, no flags.
      if (book.user_id) await db.del("users", `id=eq.${book.user_id}`);           // cascades state, weeks, entries, checkins, flags, sessions
      await db.update("books", `id=eq.${book.id}`, { user_id: null, first_scan_at: b.action === "start_over" ? new Date().toISOString() : null });
      await db.del("sessions", `book_id=eq.${book.id}`);
      return b.action === "delete" ? new Response(null, { status: 204, headers: CORS }) : json({ ok: true, state: "entry" });
    }
    default: throw new HttpError(400, "bad_action");
  }
}

// ---------- admin ----------

function requireAdmin(req: Request, env: Env) {
  if (env.ADMIN_ENABLED !== "true" || !env.ADMIN_SECRET) throw new HttpError(404, "not_found");
  if (req.headers.get("x-admin-secret") !== env.ADMIN_SECRET) throw new HttpError(401, "admin");
}

async function adminBatch(db: Db, req: Request): Promise<Response> {
  const b = await body<{ n?: number; lang?: string; edition?: string; batch?: string }>(req);
  const n = Math.min(5000, Math.max(1, Number(b.n ?? 1)));
  const lang = b.lang === "en" ? "en" : "ar";
  const edition = b.edition === "digital" ? "digital" : "print";
  const batch = cleanField(b.batch) ?? `batch-${new Date().toISOString().slice(0, 10)}`;
  const rows = Array.from({ length: n }, () => ({ code: generateCode(), lang, edition, batch }));
  await db.insertMany("books", rows);
  const csv = ["code,printed,lang,edition,batch", ...rows.map((r) => `${r.code},${printedForm(r.code)},${r.lang},${r.edition},${r.batch}`)].join("\n");
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="codes-${batch}.csv"`, ...CORS } });
}

async function adminContent(db: Db, req: Request): Promise<Response> {
  const unit = await body<any>(req);
  const need = ["lang", "arc", "week_no", "trait_id", "title", "body_md", "act", "sign_hint", "question", "options", "observations", "version"];
  for (const k of need) if (!(k in unit)) throw new HttpError(400, `missing_${k}`);
  if (!Array.isArray(unit.observations) || unit.observations.length !== 5) throw new HttpError(400, "need_five_observations");
  if (!Array.isArray(unit.options) || unit.options.length !== 3) throw new HttpError(400, "need_three_options");
  const [article] = await db.upsert<Article>("articles", [{
    lang: unit.lang, arc: unit.arc, week_no: unit.week_no, trait_id: unit.trait_id, title: unit.title, body_md: unit.body_md,
    act_full: unit.act.full, act_half: unit.act.half, act_min: unit.act.min, sign_hint: unit.sign_hint,
    question: unit.question, options: unit.options, version: unit.version,
  }], "lang,arc,week_no");
  const pulses = unit.observations.map((o: any, i: number) => ({
    article_id: article.id, day_index: i + 1, observation: o.text, audio_key: o.audio ?? null, act_audio_keys: unit.act.audio ?? null,
  }));
  await db.upsert("pulses", pulses, "article_id,day_index");
  return json({ ok: true, article_id: article.id, pulses: pulses.length });
}

async function adminMetric(db: Db): Promise<Response> {
  // The engine metric: of readers whose dose dropped in a week (smaller or empty), the share who answered
  // done or smaller within the next two acting days. Silence counts as stopping until broken.
  const rows = await db.select<Entry>("entries", `select=user_id,local_date,day_index,answer&order=user_id.asc,local_date.asc`);
  let drops = 0, returned = 0;
  const byUser = new Map<string, Entry[]>();
  for (const r of rows) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r]);
  for (const list of byUser.values()) {
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.answer !== "smaller" && e.answer !== "empty") continue;
      drops++;
      const later = list.slice(i + 1).filter((x) => x.day_index !== OPEN_DAY && x.day_index !== QUESTION_DAY).slice(0, 2);
      if (later.some((x) => x.answer === "done" || x.answer === "smaller")) returned++;
    }
  }
  return json({ drops, returned, share: drops ? Math.round((returned / drops) * 1000) / 10 : null, readers: byUser.size });
}

// ---------- the day-close job ----------

async function dayClose(db: Db, now: Date): Promise<{ users: number; closed: number; flags: number }> {
  const users = await db.select<User>("users", `status=eq.active&select=*`);
  let closed = 0, flags = 0;
  for (const user of users) {
    const local = localTime(now, user.timezone);
    const state = await db.one<State>("program_state", `user_id=eq.${user.id}&select=*`);
    if (!state) continue;
    const yesterday = addDays(local.date, -1);
    let cursor = state.last_closed_date ? addDays(state.last_closed_date, 1) : user.first_local_date;
    if (cursor > yesterday) continue;
    let dose = state.dose, empty = state.consecutive_empty;
    while (cursor <= yesterday) {
      const dow = new Date(cursor + "T00:00:00Z").getUTCDay();
      const idx = dayIndex(dow, user.open_day);
      const existing = await db.one<Entry>("entries", `user_id=eq.${user.id}&local_date=eq.${cursor}&select=answer`);
      const r = closeDay({ dayIdx: idx, hadAnswer: existing?.answer ?? null, dose, consecutiveEmpty: empty });
      if (r.writeEmpty) {
        const week = await db.one<Week>("weeks", `user_id=eq.${user.id}&started_on=lte.${cursor}&select=id&order=week_no.desc`);
        if (week) await db.insert("entries", { user_id: user.id, week_id: week.id, local_date: cursor, day_index: idx, answer: "empty", dose_served: dose });
      }
      if (r.raiseFlag) { await db.insert("flags", { user_id: user.id, kind: "three_empty", raised_on: cursor }); flags++; }
      dose = r.dose; empty = r.consecutiveEmpty;
      cursor = addDays(cursor, 1); closed++;
    }
    await db.update("program_state", `user_id=eq.${user.id}`, { dose, consecutive_empty: empty, last_closed_date: yesterday });
  }
  return { users: users.length, closed, flags };
}

// ---------- router ----------

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/$/, "") || "/";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (p === "/__build") return new Response(env.BUILD ?? "dev", { headers: { "content-type": "text/plain", ...CORS } });
  // What the native shell may switch on. Public, no secrets, no database.
  if (p === "/v1/flags") {
    const db0 = Db.from(env);
    const lang = new URL(req.url).searchParams.get("lang") === "en" ? "en" : "ar";
    // No database configured: say so with empty lists rather than 500. The client falls back to asking nothing.
    const [circles, langs] = db0 ? await Promise.all([availableArcs(db0, lang), availableLangs(db0)]) : [[], []];
    return json({ notify: env.NOTIFY_ENABLED === "true", circles, langs });
  }
  // The privacy policy lives in the assets (web/privacy.html); the store listing links to /privacy.
  if (p === "/privacy" && env.ASSETS) return env.ASSETS.fetch(new Request(new URL("/privacy.html", req.url).toString(), { headers: req.headers }));
  // Universal Links: iOS fetches this once per install; /k/<code> then opens the app when it is installed.
  if (p === "/.well-known/apple-app-site-association" || p === "/apple-app-site-association") {
    if (!env.APPLE_TEAM_ID || !env.IOS_BUNDLE_ID) throw new HttpError(404, "not_found");
    const appID = `${env.APPLE_TEAM_ID}.${env.IOS_BUNDLE_ID}`;
    return new Response(JSON.stringify({ applinks: { details: [{ appIDs: [appID], components: [{ "/": "/k/*", comment: "a copy code" }] }] }, webcredentials: { apps: [appID] } }),
      { headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" } });
  }
  // The printed QR is https://<host>/k/<code>. No asset lives there, so hand the client shell back and let it read the code.
  if (req.method === "GET" && /^\/k\/[A-Za-z0-9-]{1,40}$/.test(p) && env.ASSETS) {
    return env.ASSETS.fetch(new Request(new URL("/index.html", req.url).toString(), { headers: req.headers }));
  }

  const db = Db.from(env);
  if (p === "/v1/health") {
    const base = { ok: true, build: env.BUILD ?? "dev", time: new Date().toISOString() };
    if (!db) return json({ ...base, db: "unconfigured" });
    const reason = await db.ping();
    // On failure, say enough to fix it (which host, what shape of key, what came back) and nothing that is a secret.
    return json(reason === null ? { ...base, db: "ok" } : { ...base, db: "error", db_reason: reason, db_target: db.describe() });
  }
  if (!db) throw new HttpError(503, "db_unconfigured");

  if (p === "/v1/session/open" && req.method === "POST") return sessionOpen(db, req);
  if (p === "/v1/session/anon" && req.method === "POST") return sessionAnon(db, req);

  if (p.startsWith("/v1/admin/")) {
    requireAdmin(req, env);
    if (p === "/v1/admin/batch" && req.method === "POST") return adminBatch(db, req);
    if (p === "/v1/admin/content" && req.method === "POST") return adminContent(db, req);
    if (p === "/v1/admin/metric" && req.method === "GET") return adminMetric(db);
    if (p === "/v1/admin/close" && req.method === "POST") return json(await dayClose(db, new Date()));
    throw new HttpError(404, "not_found");
  }

  if (!p.startsWith("/v1/")) throw new HttpError(404, "not_found");
  const ctx = await loadCtx(db, req);
  const m = req.method;
  if (p === "/v1/entry" && m === "POST") return entry(ctx, req, env);
  if (p === "/v1/today" && m === "GET") return today(ctx, env);
  if (p === "/v1/answer" && m === "POST") return answer(ctx, req);
  if (p === "/v1/question" && m === "POST") return question(ctx, req);
  if (p === "/v1/week" && m === "GET") return weekGet(ctx);
  if (p === "/v1/week" && m === "PUT") return weekPut(ctx, req);
  if (p === "/v1/week/pin" && m === "POST") return weekPin(ctx);
  if (p === "/v1/notebook" && m === "GET") return notebook(ctx, env);
  const past = p.match(/^\/v1\/week\/(\d{1,2})$/);
  if (past && m === "GET") return weekPast(ctx, Number(past[1]));
  if (p === "/v1/account" && m === "POST") return account(ctx, req);
  if (p === "/v1/device" && m === "POST") return device(ctx, req, env);
  throw new HttpError(404, "not_found");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ code: e.code, message_key: e.code }, e.status);
      if (e instanceof DbError) return json({ code: "db_error", message_key: "db_error", detail: e.message.slice(0, 200) }, 502);
      return json({ code: "internal", message_key: "internal", detail: String((e as Error)?.message ?? e).slice(0, 200) }, 500);
    }
  },
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const db = Db.from(env);
    if (!db) return;
    const r = await dayClose(db, new Date());
    console.log(JSON.stringify({ event: "day.close", ...r }));
  },
};
