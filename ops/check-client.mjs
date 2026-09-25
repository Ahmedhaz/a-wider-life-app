#!/usr/bin/env node
// web/index.html is hand-edited and has no build step, so a syntax slip in its inline script ships
// straight to readers and to the app bundle. Nothing else in the repo would catch it: the Worker
// serves the file as a static asset and never parses it.
// Run: node ops/check-client.mjs
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
let errors = 0;
const fail = (msg) => { errors++; console.error(`  ${msg}`); };

// ---- the inline script parses
const html = readFileSync(join(ROOT, "web/index.html"), "utf8");
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (blocks.length !== 1) fail(`expected exactly one <script> block, found ${blocks.length}`);
if (blocks.length) {
  const js = blocks[0][1];
  const f = join(mkdtempSync(join(tmpdir(), "awl-")), "client.mjs");
  writeFileSync(f, js);
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
    console.log(`  inline script parses (${js.split("\n").length} lines)`);
  } catch (e) {
    fail(`inline script does not parse:\n${String(e.stderr ?? e).split("\n").slice(0, 6).join("\n")}`);
  }
}

// ---- the notification quotes are readable and shaped as the client expects
try {
  const q = JSON.parse(readFileSync(join(ROOT, "web/quotes.json"), "utf8"));
  if (!Array.isArray(q.quotes) || !q.quotes.length) fail("quotes.json has no quotes array");
  else {
    const bad = q.quotes.filter((x) => typeof x.text !== "string" || !x.text.trim());
    if (bad.length) fail(`${bad.length} quotes have no text`);
    else console.log(`  quotes.json: ${q.quotes.length} quotes`);
  }
} catch (e) { fail(`quotes.json: ${e.message}`); }

// ---- things the client needs from the server, spelled the same on both sides
const worker = readFileSync(join(ROOT, "worker/src/index.ts"), "utf8");
for (const path of [...html.matchAll(/api\(\s*[`"']([^`"'$]+)/g)].map((m) => m[1])) {
  const clean = path.split("?")[0];
  if (!clean.startsWith("/v1/")) continue;
  if (!worker.includes(`"${clean}"`)) fail(`client calls ${clean}, which the Worker does not route`);
}

console.log(errors ? `\n${errors} problem(s)` : "\nclient ok");
process.exit(errors ? 1 : 0);
