#!/usr/bin/env node
// What is written, what is missing, and how far a reader gets before the programme ends.
// The engine serves 13 weeks per arc and rotates through the reader's chosen circle first, so the
// runway is not "how many files exist" but "how many consecutive weeks from week 1 of that circle".
// Run: node content/gaps.mjs [--json]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL(".", import.meta.url).pathname;
const ARCS = ["self", "home", "work", "people"];
const LANGS = ["ar", "en"];
const WEEKS_PER_ARC = 13;                       // must match worker/src/index.ts
const asJson = process.argv.includes("--json");

/** Week numbers present for one lang/arc, as a Set. */
function weeksOf(lang, arc) {
  try {
    return new Set(readdirSync(join(ROOT, lang, arc))
      .filter((n) => /^\d+\.json$/.test(n))
      .map((n) => Number(n.replace(".json", ""))));
  } catch { return new Set(); }
}

/** A unit counts as a draft, not a week a reader can be served, while its body is still sample text. */
function isDraft(lang, arc, week) {
  try {
    const u = JSON.parse(readFileSync(join(ROOT, lang, arc, `${String(week).padStart(2, "0")}.json`), "utf8"));
    return /نص عرض مؤقت|display text/i.test(u.body_md ?? "");
  } catch { return false; }
}

const report = { weeks_per_arc: WEEKS_PER_ARC, designed_weeks: WEEKS_PER_ARC * ARCS.length, langs: {} };

for (const lang of LANGS) {
  const arcs = {};
  for (const arc of ARCS) {
    const have = weeksOf(lang, arc);
    const drafts = [...have].filter((w) => isDraft(lang, arc, w));
    const missing = [];
    for (let w = 1; w <= WEEKS_PER_ARC; w++) if (!have.has(w)) missing.push(w);
    // Consecutive weeks from 1: what a reader in this arc actually gets before it stops.
    let run = 0;
    while (have.has(run + 1) && !drafts.includes(run + 1)) run++;
    arcs[arc] = { written: have.size, drafts: drafts.length, servable_run: run, missing };
  }
  // A reader starting in arc X gets X's run, then the next arc's run only if X was complete, and so on.
  const runway = {};
  for (const start of ARCS) {
    const order = [...ARCS.slice(ARCS.indexOf(start)), ...ARCS.slice(0, ARCS.indexOf(start))]
      .filter((a) => arcs[a].written > 0);                       // the Worker rotates through arcs that exist
    let total = 0;
    for (const a of order) {
      total += arcs[a].servable_run;
      if (arcs[a].servable_run < WEEKS_PER_ARC) break;            // a gap ends the programme there
    }
    runway[start] = total;
  }
  report.langs[lang] = { arcs, runway_weeks: runway, offered: ARCS.filter((a) => arcs[a].written > 0) };
}

if (asJson) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

const bar = (n, max = 52) => "█".repeat(Math.round((n / max) * 24)).padEnd(24, "·");
console.log(`\nDesigned programme: ${report.designed_weeks} weeks (${WEEKS_PER_ARC} per circle × ${ARCS.length} circles)\n`);
for (const [lang, d] of Object.entries(report.langs)) {
  const total = Object.values(d.arcs).reduce((s, a) => s + a.written, 0);
  console.log(`${lang.toUpperCase()}  ${total} units written` + (total ? "" : "  (nothing — this language cannot be served)"));
  for (const arc of ARCS) {
    const a = d.arcs[arc];
    const note = a.written === 0 ? "not started" : a.missing.length ? `missing ${a.missing.join(", ")}` : "complete";
    console.log(`   ${arc.padEnd(7)} ${String(a.written).padStart(2)}/${WEEKS_PER_ARC}  ${a.drafts ? `(${a.drafts} draft) ` : ""}${note}`);
  }
  if (total) {
    console.log("   a reader who starts in:");
    for (const arc of ARCS) {
      if (!d.arcs[arc].written) { console.log(`     ${arc.padEnd(7)} not offered`); continue; }
      const w = d.runway_weeks[arc];
      console.log(`     ${arc.padEnd(7)} ${bar(w)} ${w} week${w === 1 ? "" : "s"} before "done"`);
    }
  }
  console.log("");
}
const ar = report.langs.ar;
const best = Math.max(...Object.values(ar.runway_weeks));
console.log(`Longest runway in Arabic: ${best} of ${report.designed_weeks} designed weeks.`);
console.log(`Remaining to write: ${report.designed_weeks - Object.values(ar.arcs).reduce((s, a) => s + a.written, 0)} Arabic units, ${report.designed_weeks} English units.\n`);
