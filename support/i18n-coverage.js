#!/usr/bin/env node
/**
 * What is still English when the interface is set to Chinese (R21).
 *
 *   JSDOM=/tmp/jsd/node_modules/jsdom node support/i18n-coverage.js [--json out.json] [--dump zh.txt]
 *
 * Boots the Node server with the demo data, loads each page in jsdom with
 * ?lang=zh (the real HTML and scripts, fetch wired to the server), signs in as
 * the owner, opens every tab and every <details>, and lists the text and
 * attributes that are still English, with the page they were seen on.
 * Strings in KEEP (product names, protocols) are not counted.
 * Needs jsdom (not a dependency): npm i --prefix /tmp/jsd jsdom@24
 */
const path = require('node:path');
const fs = require('node:fs');
if (process.argv.includes('--dump')) globalThis.__i18nDump = new Set(); // every translated string, for proofreading
const { boot } = require('./boot');

const jsdomPath = process.env.JSDOM || 'jsdom';
const { JSDOM, VirtualConsole } = require(jsdomPath);
const OWNER = 'owner-token-for-i18n-coverage-0123456789';
const KEEP = require('./i18n-keep');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function load(base, page, { signIn = false, cookies }) {
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => errors.push(String(e.message || e)));
  vc.on('error', e => errors.push(String(e)));
  const html = await (await fetch(`${base}${page.path}`)).text();
  const install = w => {
    w.fetch = async (u, o = {}) => {
      const url = new URL(String(u), w.location.href);
      const headers = new Headers(o.headers || {});
      if (cookies.size) headers.set('cookie', [...cookies].map(([k, v]) => `${k}=${v}`).join('; '));
      const res = await fetch(url, { method: o.method || 'GET', headers, body: o.body, redirect: 'manual' });
      for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); cookies.set(kv.slice(0, i), kv.slice(i + 1)); }
      const body = await res.text();
      return { ok: res.ok, status: res.status, headers: res.headers, text: async () => body, json: async () => JSON.parse(body) };
    };
    w.scrollTo = () => {};
    w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
    w.HTMLCanvasElement.prototype.getContext = () => null;
    w.Element.prototype.scrollIntoView = () => {};
  };
  // The page's real scripts, fetched from the server and run in order.
  const dom = new JSDOM(html, {
    url: `${base}${page.path}${page.path.includes('?') ? '&' : '?'}lang=zh${page.hash || ''}`,
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc, beforeParse: install,
  });
  const w = dom.window;
  await new Promise(r => { if (w.document.readyState === 'complete') r(); else w.addEventListener('load', r); setTimeout(r, 5000); });
  await sleep(600);
  if (signIn) {
    const tok = w.document.querySelector('#admin-token');
    tok.value = OWNER;
    w.document.querySelector('#admin-form').dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
    await sleep(1500);
  }
  return { w, errors };
}

// Demo data (names of people, doors, groups, sites) is not interface text.
const dataNames = new Set();
(function collect(v) {
  if (Array.isArray(v)) v.forEach(collect);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (typeof x === 'string' && /(name|alias|company|label|title)$/i.test(k)) dataNames.add(x); else collect(x); }
})([require('../data/acl.json'), require('../data/mirror.json'), require('../vendor-demo').DEMO_LOCKS]);
const isData = t => dataNames.has(t) || t.split(/ · |, /).every(p => dataNames.has(p.replace(/^(→ |to )/, '')) || /^\d/.test(p))
  || (/^(.+) \((.+)\)$/.test(t) && t.match(/^(.+) \((.+)\)$/).slice(1).every(p => dataNames.has(p.replace(/^(→ |to )/, ''))))
  || /^[a-z]+(\.[a-zA-Z]+)+$|^[a-z]+_[a-z0-9_]+$|^u\d+$/.test(t) // audit action ids, record ids
  || /^[a-z][\w.]*(, [a-z][\w.]*)*$/.test(t) && /[A-Z.]|, /.test(t) || /^(identity|CC\d+\.\d+|ISO\/IEC 27001:2022|SOC 2 \(TSC 2017\)|Teams（Workflows）)$/.test(t); // evidence control ids
const CJK = /[\u3400-\u9fff]/;

function untranslated(w) {
  const out = [];
  const DUMP = globalThis.__i18nDump;
  const lookup = s => s.replace(/\s+/g, ' ').trim();
  const skip = el => !el || /^(SCRIPT|STYLE|TEXTAREA|CODE|NOSCRIPT)$/.test(el.tagName) || el.closest('[translate="no"]') || el.closest('[hidden]');
  const walker = w.document.createTreeWalker(w.document.body, 4);
  let n;
  let total = 0;
  while ((n = walker.nextNode())) {
    if (skip(n.parentElement)) continue;
    const t = lookup(n.nodeValue);
    if (!t) continue;
    if (CJK.test(t)) { total++; if (DUMP) DUMP.add(t); continue; }
    if (!/[A-Za-z]{2}/.test(t) || KEEP.test(t) || isData(t)) continue;
    total++;
    out.push(t);
  }
  for (const el of w.document.body.querySelectorAll('[placeholder],[title],[aria-label]')) {
    if (skip(el)) continue;
    for (const a of ['placeholder', 'title', 'aria-label']) {
      const v = el.getAttribute(a);
      if (!v) continue;
      if (CJK.test(v)) { total++; continue; }
      if (!/[A-Za-z]{2}/.test(v) || KEEP.test(lookup(v)) || isData(lookup(v))) continue;
      total++;
      out.push(`@${a}: ${lookup(v)}`);
    }
  }
  return { total, out };
}

const pageErrors = [];
process.on('unhandledRejection', e => pageErrors.push(String(e && e.message || e)));

async function main() {
  const s = await boot({ ADMIN_TOKEN: OWNER, ALLOW_HTTP_WEBHOOKS: '1', SIGNUP_ENABLED: '1' });
  const seen = new Map();
  const note = (page, list) => { for (const t of list) { if (!seen.has(t)) seen.set(t, new Set()); seen.get(t).add(page); } };
  let total = 0;
  let english = 0;
  const errors = [];
  try {
    const pages = [
      { name: 'admin', path: '/', signIn: true },
      { name: 'kiosk', path: '/kiosk.html' },
      { name: 'signup', path: '/signup.html' },
      { name: 'invite', path: '/invite.html', hash: '#t=bogus' },
      { name: 'checkout', path: '/checkout.html', hash: '#t=bogus' },
      { name: 'calendar', path: '/calendar.html', hash: '#t=bogus' },
      { name: 'evidence', path: '/evidence.html' },
      { name: 'visitors-print', path: '/visitors-print.html' },
    ];
    for (const page of pages) {
      const cookies = new Map();
      const { w, errors: errs } = await load(s.base, page, { signIn: page.signIn, cookies });
      errors.push(...errs.map(e => `${page.name}: ${e}`));
      const views = page.signIn ? [...w.document.querySelectorAll('nav button')] : [null];
      for (const b of views) {
        if (b) { b.click(); await sleep(900); }
        for (const d of w.document.querySelectorAll('details')) d.open = true;
        await sleep(100);
        const r = untranslated(w);
        total += r.total;
        english += r.out.length;
        note(b ? `${page.name}:${b.dataset.v}` : page.name, r.out);
      }
      w.close();
    }
  } finally { await s.close(); }
  const rows = [...seen].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));
  for (const [t, where] of rows) console.log(`${t}    [${[...where].join(', ')}]`);
  console.log(`\n${rows.length} distinct English strings; ${english} of ${total} visible strings untranslated (${total ? (100 * (1 - english / total)).toFixed(1) : 0}% Chinese)`);
  errors.push(...pageErrors);
  if (errors.length) console.log(`page errors:\n  ${[...new Set(errors)].slice(0, 20).join('\n  ')}`);
  const dump = process.argv.includes('--dump') ? process.argv[process.argv.indexOf('--dump') + 1] : null;
  if (dump) fs.writeFileSync(dump, [...globalThis.__i18nDump].sort().join('\n') + '\n');
  const out = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
  if (out) fs.writeFileSync(out, JSON.stringify({ strings: rows.map(([t, w]) => ({ t, where: [...w] })), total, english }, null, 1));
}

main().catch(e => { console.error(e); process.exit(2); });
