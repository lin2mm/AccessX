// R21 interface language: dictionary integrity, engine behaviour, static pages (docs/26-I18N.md).
// Runs without a browser: public/i18n.js is evaluated in a vm with a stub window.
// The full rendered-page check (dynamic strings) is support/i18n-coverage.js, run by hand.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const KEEP = require('../support/i18n-keep');

const PUB = path.join(__dirname, '..', 'public');
const src = f => fs.readFileSync(path.join(PUB, f), 'utf8');

/** Evaluate the dictionary and the engine the way a page does; returns the window. */
function engine({ search = '', saved = null, nav = 'en-US' } = {}) {
  const store = new Map(saved ? [['accessx.lang', saved]] : []);
  const win = {
    location: { search, href: `https://x.example/${search}` },
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    navigator: { languages: [nav], language: nav },
    document: { body: null, addEventListener() {} }, // start() waits for DOMContentLoaded, which never comes
    URLSearchParams,
  };
  win.window = win;
  const ctx = vm.createContext(win);
  vm.runInContext(src('i18n-zh.js'), ctx, { filename: 'i18n-zh.js' });
  vm.runInContext(src('i18n.js'), ctx, { filename: 'i18n.js' });
  win.store = store;
  return win;
}

const zh = engine({ search: '?lang=zh' });
const DICT = zh.AX_I18N_ZH;
const CJK = /[\u3400-\u9fff\uff00-\uffef]/;

test('language choice: URL beats saved beats browser; zh sets the date locale', () => {
  assert.equal(engine().axLang, 'en');
  assert.equal(engine().axLocale, undefined);
  assert.equal(engine({ nav: 'zh-CN' }).axLang, 'zh');
  assert.equal(engine({ nav: 'zh-TW' }).axLocale, 'zh-CN');
  assert.equal(engine({ nav: 'zh-CN', saved: 'en' }).axLang, 'en');
  const w = engine({ search: '?lang=zh', saved: 'en' });
  assert.equal(w.axLang, 'zh');
  assert.equal(w.store.get('accessx.lang'), 'zh', 'the URL choice is remembered');
  assert.equal(engine({ search: '?lang=fr', nav: 'en-GB' }).axLang, 'en', 'unknown languages are ignored');
});

test('English is untouched', () => {
  const en = engine({ search: '?lang=en' });
  for (const k of Object.keys(DICT.text).slice(0, 50)) assert.equal(en.axT(k), k);
  assert.equal(en.axT('Days 1,2,3,4,5 · 08:00–18:30'), 'Days 1,2,3,4,5 · 08:00–18:30');
});

test('dictionary: keys are whitespace-normalised, values are Chinese', () => {
  const keys = Object.keys(DICT.text);
  assert.ok(keys.length > 400, `only ${keys.length} entries`);
  for (const k of keys) {
    assert.equal(k, k.replace(/\s+/g, ' ').trim(), `key not normalised (the engine would never find it): ${JSON.stringify(k)}`);
    assert.match(k, /[A-Za-z]/, `key without letters is never looked up: ${k}`);
    const v = DICT.text[k];
    assert.equal(typeof v, 'string');
    assert.ok(CJK.test(v), `not translated: ${k} -> ${v}`);
  }
});

test('patterns: anchored, no g/y flag (lastIndex would make .test() alternate)', () => {
  assert.ok(DICT.patterns.length > 10);
  for (const [re, rep] of DICT.patterns) {
    assert.ok(re instanceof RegExp || Object.prototype.toString.call(re) === '[object RegExp]');
    assert.ok(re.source.startsWith('^') && re.source.endsWith('$'), `unanchored pattern translates parts of user text: ${re}`);
    assert.doesNotMatch(re.flags, /[gy]/, `${re}`);
    assert.ok(typeof rep === 'string' || typeof rep === 'function');
  }
});

test('translations are fixed points (else the MutationObserver would loop on its own writes)', () => {
  for (const [k, v] of Object.entries(DICT.text)) {
    assert.equal(zh.axT(v), v, `translating "${k}" twice changes it again`);
  }
  const samples = [
    '42% battery', 'Days 1,2,3,4,5 · 08:00–18:30', 'Days 1,3,5 · 18:00–21:00', 'Days 1,2,3,4,5,6,7 · 22:00–06:00',
    'Owner (ADMIN_TOKEN) · Account Owner · all sites', 'Office Hours · 2 people', '120 days', 'Head #17',
    'until 2026-11-18', 'compiled lock slots (5)', '3 (2 delivered)',
  ];
  for (const s of samples) {
    const once = zh.axT(s);
    assert.notEqual(once, s, `pattern sample not translated: ${s}`);
    assert.ok(CJK.test(once), once);
    assert.equal(zh.axT(once), once, `not a fixed point: ${s} -> ${once}`);
  }
});

test('engine: whitespace is normalised, sub-parts are translated, user text is not', () => {
  const k = Object.keys(DICT.text).find(x => x.includes(' '));
  assert.equal(zh.axT(`\n   ${k.replace(/ /g, '  \n ')}  `), DICT.text[k]);
  assert.equal(zh.axT('Days 1,2,3,4,5 · 08:00–18:30'), '周一至周五 · 08:00–18:30');
  assert.equal(zh.axT('Days 6,7 · 09:00–12:00'), '周六、周日 · 09:00–12:00');
  assert.equal(zh.axT('Owner (ADMIN_TOKEN) · Account Owner · all sites'), '所有者（ADMIN_TOKEN） · 账号所有者 · 所有站点');
  // Names, codes and free text that are not UI phrases come back unchanged.
  for (const s of ['Sarah Kim', 'Riverside Office', 'to Operations', 'Move Main Entrance', 'lock 9002 user u2', '482913']) {
    assert.equal(zh.axT(s), s);
  }
});

/** Visible text and translatable attributes of a static page, roughly as a browser sees them. */
function staticStrings(html) {
  const ent = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', rarr: '→', larr: '←', mdash: '—', ndash: '–', hellip: '…', times: '×', copy: '©' };
  const decode = s => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ent[e] ?? m));
  const body = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|textarea|code|noscript)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<(\w+)\b[^>]*translate="no"[^>]*>[\s\S]*?<\/\1>/gi, '') // no nesting of the same tag inside these
    .replace(/<head\b[\s\S]*?<\/head>/i, m => (m.match(/<title>[\s\S]*?<\/title>/i) || [''])[0]);
  const out = [];
  for (const m of body.matchAll(/\s(placeholder|title|aria-label|alt)="([^"]*)"/g)) out.push(decode(m[2]));
  for (const m of body.matchAll(/<input\b[^>]*type="(?:button|submit|reset)"[^>]*value="([^"]*)"/gi)) out.push(decode(m[1]));
  for (const t of body.replace(/<[^>]+>/g, '\u0000').split('\u0000')) out.push(decode(t));
  return out.map(s => s.replace(/\s+/g, ' ').trim()).filter(s => s && /[A-Za-z]{2}/.test(s) && !KEEP.test(s));
}

test('every string on every static page has a Chinese translation', () => {
  const pages = fs.readdirSync(PUB).filter(f => f.endsWith('.html'));
  assert.ok(pages.length >= 8);
  const missing = [];
  let n = 0;
  for (const p of pages) {
    for (const s of staticStrings(src(p))) {
      n++;
      if (zh.axT(s) === s) missing.push(`${p}: ${s}`);
    }
  }
  assert.ok(n > 200, `only ${n} strings found; is the extraction broken?`);
  assert.deepEqual(missing, [], `add these to public/i18n-zh.js:\n${missing.join('\n')}`);
});

test('every page loads the dictionary, then the engine, before its own scripts; the service worker caches both', () => {
  for (const p of fs.readdirSync(PUB).filter(f => f.endsWith('.html'))) {
    const scripts = [...src(p).matchAll(/<script\b[^>]*src="([^"]+)"/g)].map(m => m[1].replace(/^\.?\//, '').replace(/\?.*$/, ''));
    assert.deepEqual(scripts.slice(0, 2), ['i18n-zh.js', 'i18n.js'], `${p}: ${scripts.join(', ')}`);
  }
  const sw = src('sw.js');
  assert.match(sw, /['"]\.\/i18n-zh\.js['"]/);
  assert.match(sw, /['"]\.\/i18n\.js['"]/);
  assert.match(src('index.html'), /id="lang-slot"/);
});
