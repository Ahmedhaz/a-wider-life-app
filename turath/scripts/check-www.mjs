#!/usr/bin/env node
// Refuses a www/ the app cannot navigate: every relative href/src on every page must name a file
// that exists in the bundle (a folder link would open the home page instead), and no page may
// still reach for Google Fonts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'www');
if (!fs.existsSync(OUT)) { console.error('www/ missing: run npm run build'); process.exit(1); }

const bad = [];
let pages = 0, links = 0;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!e.name.endsWith('.html')) continue;
    pages++;
    const html = fs.readFileSync(p, 'utf8');
    const rel = path.relative(OUT, p);
    if (html.includes('fonts.googleapis.com')) bad.push(`${rel}: still loads Google Fonts`);
    if (!html.includes('app/shim.js')) bad.push(`${rel}: shim not injected`);
    for (const [, u] of html.matchAll(/\b(?:href|src)="([^"]*)"/g)) {
      if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(u) || u === '') continue;
      links++;
      const target = decodeURIComponent(u.split(/[?#]/)[0]);
      if (target === '') continue;
      const f = path.resolve(path.dirname(p), target);
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) bad.push(`${rel}: ${u}`);
    }
  }
})(OUT);

const css = fs.readFileSync(path.join(OUT, 'fonts/fonts.css'), 'utf8');
for (const [, u] of css.matchAll(/url\(([^)]+)\)/g)) {
  if (!fs.existsSync(path.join(OUT, 'fonts', u))) bad.push(`fonts.css: ${u}`);
}

if (bad.length) {
  console.error(bad.slice(0, 40).join('\n') + (bad.length > 40 ? `\n… and ${bad.length - 40} more` : ''));
  process.exit(1);
}
console.log(`www/ ok: ${pages} pages, ${links} local links, all resolve`);
