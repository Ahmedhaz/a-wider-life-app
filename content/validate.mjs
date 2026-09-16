#!/usr/bin/env node
// Validates every content unit: content/<lang>/<arc>/<week>.json
// Refuses a unit missing any part, with five observations not present, an observation over 60 words,
// or a body outside the locked range once it is a real article (sample bodies are allowed while tagged).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL(".", import.meta.url).pathname;
const ARCS = ["self", "home", "work", "people"];
let files = 0, errors = 0;
const fail = (f, msg) => { errors++; console.error(`  ${f}: ${msg}`); };
const words = (s) => s.trim().split(/\s+/).filter(Boolean).length;

for (const lang of ["ar", "en"]) {
  for (const arc of ARCS) {
    const dir = join(ROOT, lang, arc);
    let names = [];
    try { names = readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { continue; }
    for (const n of names) {
      const f = `${lang}/${arc}/${n}`; files++;
      let u;
      try { u = JSON.parse(readFileSync(join(dir, n), "utf8")); } catch (e) { fail(f, "not JSON"); continue; }
      for (const k of ["lang", "arc", "week_no", "trait_id", "title", "body_md", "act", "sign_hint", "question", "options", "observations", "version"])
        if (!(k in u)) fail(f, `missing ${k}`);
      if (u.lang !== lang || u.arc !== arc) fail(f, "lang or arc does not match its folder");
      if (Number(n.replace(".json", "")) !== u.week_no) fail(f, "week_no does not match the file name");
      if (!u.act || !u.act.full || !u.act.half || !u.act.min) fail(f, "act needs full, half and min");
      if (!Array.isArray(u.options) || u.options.length !== 3) fail(f, "three options required");
      if (!Array.isArray(u.observations) || u.observations.length !== 5) fail(f, "five observations required");
      else u.observations.forEach((o, i) => { if (!o.text) fail(f, `observation ${i + 1} empty`); else if (words(o.text) > 60) fail(f, `observation ${i + 1} over 60 words (${words(o.text)})`); });
      const sample = /نص عرض مؤقت|display text/i.test(u.body_md);
      const w = words(u.body_md);
      if (!sample && (w < 700 || w > 900)) fail(f, `body ${w} words, locked range is 700 to 900`);
      for (const s of [u.body_md, u.title, u.sign_hint, u.question, ...(u.options ?? [])]) if (/[—–]/.test(String(s))) fail(f, "em or en dash in text");
    }
  }
}
console.log(`${files} units checked, ${errors} errors`);
process.exit(errors ? 1 : 0);
