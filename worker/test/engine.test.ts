import { describe, it, expect } from "vitest";
import {
  localTime, dayIndex, firstDayOfWeek, weekStartDate, nextDose, weekStartReset, visibility,
  closeDay, assemblePulse, counts, sheetComplete, cleanField, addDays, OPEN_DAY, QUESTION_DAY,
} from "../src/engine";

const FRI = 5, SUN = 0;

describe("local time", () => {
  it("computes the reader's date and hour in Cairo from a UTC instant", () => {
    const t = localTime(new Date("2026-09-19T21:30:00Z"), "Africa/Cairo"); // UTC+3
    expect(t.date).toBe("2026-09-20");
    expect(t.hour).toBe(0);
    expect(t.dow).toBe(0); // Sunday
  });
  it("a reader whose local midnight is UTC noon", () => {
    const t = localTime(new Date("2026-09-19T12:00:00Z"), "Pacific/Auckland"); // UTC+12
    expect(t.date).toBe("2026-09-20");
    expect(t.hour).toBe(0);
  });
  it("never trusts a client clock: only the instant and the zone matter", () => {
    const a = localTime(new Date("2026-09-19T19:59:00Z"), "Africa/Cairo");
    expect(a.hour).toBe(22);
  });
});

describe("the week shape", () => {
  it("the first day is the day after the open day", () => {
    expect(firstDayOfWeek(FRI)).toBe(6); // Saturday
    expect(firstDayOfWeek(SUN)).toBe(1); // Monday
  });
  it("day_index runs 1..7 with the open day always 7 and the question day 6", () => {
    expect(dayIndex(6, FRI)).toBe(1);  // Sat
    expect(dayIndex(4, FRI)).toBe(QUESTION_DAY); // Thu
    expect(dayIndex(5, FRI)).toBe(OPEN_DAY);     // Fri
    expect(dayIndex(1, SUN)).toBe(1);  // Mon for an English reader
    expect(dayIndex(0, SUN)).toBe(OPEN_DAY);
  });
  it("finds the week start date", () => {
    const wed = localTime(new Date("2026-09-23T10:00:00Z"), "Africa/Cairo"); // Wed 23 Sep
    expect(weekStartDate(wed, FRI)).toBe("2026-09-19"); // Saturday
  });
});

describe("the dose ladder", () => {
  it("Done keeps the dose", () => {
    expect(nextDose("full", "done")).toBe("full");
    expect(nextDose("min", "done")).toBe("min");
  });
  it("Smaller steps down one", () => {
    expect(nextDose("full", "smaller")).toBe("half");
    expect(nextDose("half", "smaller")).toBe("min");
  });
  it("an empty day steps down one, silently, and never below min", () => {
    expect(nextDose("full", "empty")).toBe("half");
    expect(nextDose("min", "empty")).toBe("min");
  });
  it("a question answer never moves the dose", () => {
    expect(nextDose("half", "question")).toBe("half");
  });
  it("week start returns to full and resets the empty count", () => {
    expect(weekStartReset()).toEqual({ dose: "full", consecutiveEmpty: 0 });
  });
});

describe("visibility", () => {
  it("before 20:00 only today is open and the sheet is unlocked on day 1", () => {
    const v = visibility({ date: "2026-09-19", dow: 6, hour: 9, minute: 0 }, FRI);
    expect(v).toEqual({ today: 1, answerable: true, next: null, sheetLocked: false });
  });
  it("at 20:00 on day 1 tomorrow opens and the sheet locks", () => {
    const v = visibility({ date: "2026-09-19", dow: 6, hour: 20, minute: 0 }, FRI);
    expect(v.next).toBe(2);
    expect(v.sheetLocked).toBe(true);
  });
  it("19:59 does not open tomorrow", () => {
    const v = visibility({ date: "2026-09-21", dow: 1, hour: 19, minute: 59 }, FRI);
    expect(v.next).toBeNull();
    expect(v.sheetLocked).toBe(true);
  });
  it("the evening before the open day opens nothing, and the open day answers nothing", () => {
    expect(visibility({ date: "2026-09-24", dow: 4, hour: 21, minute: 0 }, FRI).next).toBeNull();
    const open = visibility({ date: "2026-09-25", dow: 5, hour: 12, minute: 0 }, FRI);
    expect(open.today).toBe(OPEN_DAY);
    expect(open.answerable).toBe(false);
  });
});

describe("the day-close job", () => {
  it("writes an empty row and steps the dose down for an unanswered acting day", () => {
    const r = closeDay({ dayIdx: 3, hadAnswer: null, dose: "full", consecutiveEmpty: 0 });
    expect(r).toEqual({ writeEmpty: true, dose: "half", consecutiveEmpty: 1, raiseFlag: false });
  });
  it("resets the empty count on Done or Smaller", () => {
    expect(closeDay({ dayIdx: 2, hadAnswer: "smaller", dose: "half", consecutiveEmpty: 2 }).consecutiveEmpty).toBe(0);
  });
  it("raises the flag exactly once, at the third consecutive empty day", () => {
    const second = closeDay({ dayIdx: 2, hadAnswer: null, dose: "half", consecutiveEmpty: 1 });
    expect(second.raiseFlag).toBe(false);
    const third = closeDay({ dayIdx: 3, hadAnswer: null, dose: "min", consecutiveEmpty: 2 });
    expect(third.raiseFlag).toBe(true);
    const fourth = closeDay({ dayIdx: 4, hadAnswer: null, dose: "min", consecutiveEmpty: 3 });
    expect(fourth.raiseFlag).toBe(false);
  });
  it("the open day and the question day write nothing and never step the dose", () => {
    expect(closeDay({ dayIdx: OPEN_DAY, hadAnswer: null, dose: "full", consecutiveEmpty: 2 }))
      .toEqual({ writeEmpty: false, dose: "full", consecutiveEmpty: 2, raiseFlag: false });
    expect(closeDay({ dayIdx: QUESTION_DAY, hadAnswer: null, dose: "half", consecutiveEmpty: 0 }).dose).toBe("half");
  });
});

describe("pulse assembly", () => {
  const article = { act_full: "one silent minute, no phone", act_half: "thirty seconds", act_min: "one breath before I stand up", sign_hint: "" };
  const pulse = { observation: "The fastest decision you make in a day…", audio_key: "audio/en/self-01/2.m4a",
    act_audio_keys: { full: "a/f.m4a", half: "a/h.m4a", min: "a/m.m4a" } };
  it("speaks the reader's own act and gives act audio only when it equals the default", () => {
    const week = { act_full: "one silent minute, no phone", act_half: "thirty seconds ", act_min: "one breath  before I stand up", sign_text: "I can name one thing" };
    const p = assemblePulse(pulse, week, article, "half");
    expect(p.act).toBe("thirty seconds ");
    expect(p.audio.act).toBe("a/h.m4a");     // equal after trimming
    expect(p.audio.observation).toBe("audio/en/self-01/2.m4a");
  });
  it("a custom act is text only, the observation always has audio", () => {
    const week = { act_full: "walk to the corner", act_half: "walk to the door", act_min: "stand up", sign_text: "s" };
    const p = assemblePulse(pulse, week, article, "min");
    expect(p.act).toBe("stand up");
    expect(p.audio.act).toBeNull();
    expect(p.audio.observation).not.toBeNull();
  });
});

describe("counts · a counter, not a chain", () => {
  it("counts acting and question days, never open days, and moved = done or smaller", () => {
    // Sat 19 Sep (day 1) to Sat 26 Sep: 8 days, one Friday open day inside
    const entries = [
      { local_date: "2026-09-19", answer: "done" as const },
      { local_date: "2026-09-20", answer: "smaller" as const },
      { local_date: "2026-09-21", answer: "empty" as const },
      { local_date: "2026-09-24", answer: "question" as const },
    ];
    const c = counts(entries, "2026-09-19", "2026-09-26", FRI);
    expect(c.passed).toBe(7);
    expect(c.moved).toBe(2);
  });
  it("addDays crosses a month boundary", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
  });
});

describe("the sheet", () => {
  it("cannot proceed without circle, trait, anchor and the full act", () => {
    expect(sheetComplete({ circle: "self", trait_id: "anchor", anchor_text: "keys on the table", act_full: "one minute" })).toBe(true);
    expect(sheetComplete({ circle: "self", trait_id: "anchor", anchor_text: "  ", act_full: "one minute" })).toBe(false);
  });
  it("fields are single line, trimmed and capped at 140", () => {
    expect(cleanField("  one\nminute \t here ")).toBe("one minute here");
    expect(cleanField("x".repeat(200))?.length).toBe(140);
    expect(cleanField(42)).toBeNull();
    expect(cleanField("   ")).toBeNull();
  });
});
