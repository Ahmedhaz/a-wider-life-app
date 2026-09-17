// A Wider Life · the engine.
// Pure functions only: state plus the reader's local time in, decisions out. No I/O here.
// Every rule traces to one week of the book (chapters 13 and 14) and to PRD edition 2, section 6.

export type Dose = "full" | "half" | "min";
export type Answer = "done" | "smaller" | "empty" | "question";

export const UNLOCK_HOUR = 20; // tomorrow's pulse opens at 20:00 local. A first number, reviewed after the cohort.
export const ACTING_DAYS = 5;  // day_index 1..5 act, 6 question, 7 open
export const QUESTION_DAY = 6;
export const OPEN_DAY = 7;
export const FLAG_AFTER_EMPTY = 3;

export interface LocalTime {
  date: string;   // YYYY-MM-DD in the reader's zone
  dow: number;    // 0 Sunday .. 6 Saturday, in the reader's zone
  hour: number;   // 0..23
  minute: number;
}

// ---------- local time ----------

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The reader's local date and time for a UTC instant. The client clock is never trusted. */
export function localTime(instant: Date, timeZone: string): LocalTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    dow: WEEKDAY[get("weekday")],
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
  };
}

/** Add days to a YYYY-MM-DD date string (calendar arithmetic, zone-free). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

// ---------- the week shape ----------

/** The first day of the reader's week is the day after the open day. */
export function firstDayOfWeek(openDayDow: number): number {
  return (openDayDow + 1) % 7;
}

/** 1..7 · 1 = first day (article + sheet), 2..5 acting days, 6 question, 7 open. */
export function dayIndex(dow: number, openDayDow: number): number {
  return ((dow - firstDayOfWeek(openDayDow) + 7) % 7) + 1;
}

/** The local date on which the current week started (day_index 1). */
export function weekStartDate(local: LocalTime, openDayDow: number): string {
  return addDays(local.date, -(dayIndex(local.dow, openDayDow) - 1));
}

/**
 * Where a reader's first week begins: today if today is their first day, otherwise the next first day.
 * No week starts without a sheet, so nobody is dropped into the middle of a week with a locked sheet.
 */
export function firstWeekStart(local: LocalTime, openDayDow: number): string {
  const start = weekStartDate(local, openDayDow);
  return dayIndex(local.dow, openDayDow) === 1 ? start : addDays(start, 7);
}

export function isActingDay(idx: number): boolean { return idx >= 1 && idx <= ACTING_DAYS; }

// ---------- the dose ladder · the ten most important lines in the product ----------

const DOWN: Record<Dose, Dose> = { full: "half", half: "min", min: "min" };

/** Done keeps the dose. Smaller and an empty day step it down one, silently. Never below min. */
export function nextDose(dose: Dose, answer: Answer): Dose {
  if (answer === "done" || answer === "question") return dose;
  return DOWN[dose];
}

/** A new week: the dose returns to full and the empty count resets. */
export function weekStartReset(): { dose: Dose; consecutiveEmpty: number } {
  return { dose: "full", consecutiveEmpty: 0 };
}

// ---------- what is visible now ----------

export interface Visibility {
  today: number;          // day_index of the local date
  answerable: boolean;    // today accepts Done / Smaller (acting day) or an option (question day)
  next: number | null;    // tomorrow's day_index when its pulse is already open (from 20:00), listen only
  sheetLocked: boolean;   // the sheet locks when day 2's pulse opens
}

export function visibility(local: LocalTime, openDayDow: number): Visibility {
  const today = dayIndex(local.dow, openDayDow);
  const evening = local.hour >= UNLOCK_HOUR;
  const next = evening && today < OPEN_DAY ? today + 1 : null;
  return {
    today,
    answerable: today !== OPEN_DAY,
    next: next === OPEN_DAY ? null : next,   // the open day has no pulse to open
    sheetLocked: today > 1 || (today === 1 && evening),
  };
}

// ---------- the day-close job ----------

export interface CloseInput {
  dayIdx: number;              // the day that just ended
  hadAnswer: Answer | null;    // what was written for it, or null
  dose: Dose;
  consecutiveEmpty: number;
}
export interface CloseResult {
  writeEmpty: boolean;         // write an entries row with answer = empty
  dose: Dose;
  consecutiveEmpty: number;
  raiseFlag: boolean;          // exactly once, when the count reaches FLAG_AFTER_EMPTY
}

/** Runs once per reader after their local midnight. Open and question days never step the dose. */
export function closeDay(input: CloseInput): CloseResult {
  const { dayIdx, hadAnswer, dose, consecutiveEmpty } = input;
  if (!isActingDay(dayIdx)) return { writeEmpty: false, dose, consecutiveEmpty, raiseFlag: false };
  if (hadAnswer === "done" || hadAnswer === "smaller") {
    return { writeEmpty: false, dose, consecutiveEmpty: 0, raiseFlag: false };
  }
  const count = consecutiveEmpty + 1;
  return {
    writeEmpty: hadAnswer === null,
    dose: nextDose(dose, "empty"),
    consecutiveEmpty: count,
    raiseFlag: count === FLAG_AFTER_EMPTY,
  };
}

// ---------- pulse assembly at serving time ----------

export interface ArticleActs { act_full: string; act_half: string; act_min: string; sign_hint: string }
export interface WeekActs { act_full: string; act_half: string; act_min: string; sign_text: string }
export interface PulseRow { observation: string; audio_key: string | null; act_audio_keys: Partial<Record<Dose, string>> | null }
export interface AssembledPulse {
  observation: string;
  act: string;
  sign: string;
  dose: Dose;
  audio: { observation: string | null; act: string | null };
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ");

/** Observation from the pulse, the act from the reader's own sheet at today's dose, then the sign.
 *  Audio for the act only when the sheet's act is the article's default act at that dose. */
export function assemblePulse(pulse: PulseRow, week: WeekActs, article: ArticleActs, dose: Dose): AssembledPulse {
  const key = `act_${dose}` as const;
  const act = week[key];
  const isDefault = norm(act) === norm(article[key]);
  return {
    observation: pulse.observation,
    act,
    sign: week.sign_text,
    dose,
    audio: {
      observation: pulse.audio_key,
      act: isDefault ? pulse.act_audio_keys?.[dose] ?? null : null,
    },
  };
}

// ---------- counts · a counter, not a chain ----------

export interface EntryLite { local_date: string; answer: Answer }

/** Days passed = acting and question days from the first day to today inclusive. Days moved = done or smaller. */
export function counts(entries: EntryLite[], firstLocalDate: string, todayLocalDate: string, openDayDow: number) {
  let passed = 0;
  const n = daysBetween(firstLocalDate, todayLocalDate);
  for (let i = 0; i <= n; i++) {
    const d = addDays(firstLocalDate, i);
    const dow = (new Date(d + "T00:00:00Z").getUTCDay());
    if (dayIndex(dow, openDayDow) !== OPEN_DAY) passed++;
  }
  const moved = entries.filter((e) => e.answer === "done" || e.answer === "smaller").length;
  return { passed, moved };
}

// ---------- the sheet ----------

export interface SheetInput { circle?: string | null; trait_id?: string | null; anchor_text?: string | null; act_full?: string | null }

/** A week cannot proceed past day 1 without the circle, the trait, the anchor and the full act. */
export function sheetComplete(s: SheetInput): boolean {
  return Boolean(s.circle && s.trait_id && norm(s.anchor_text ?? "") && norm(s.act_full ?? ""));
}

export const FIELD_MAX = 140;

/** Six single-line fields: trimmed, newlines removed, capped. Anything else is rejected upstream. */
export function cleanField(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\r\n\t]+/g, " ").trim().replace(/\s+/g, " ");
  return s.length === 0 ? null : s.slice(0, FIELD_MAX);
}
