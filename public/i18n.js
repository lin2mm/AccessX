/* AccessX interface language (R21; docs/26-I18N.md).
 *
 * Load order on every page: i18n-zh.js (the dictionary), then this file, then
 * the page's own scripts. The pages keep their English text. When the chosen
 * language is Chinese, this file translates what the page shows:
 *   - every text node and the placeholder / title / aria-label / alt attributes,
 *     matched as a whole string (whitespace-normalised) against the dictionary,
 *     then against its patterns (sentences with numbers or names in them);
 *   - everything rendered later too (a MutationObserver), and alert/confirm/prompt;
 *   - never inside translate="no" (names, door codes, tokens), script, style,
 *     textarea or code.
 * Dates: window.axLocale is 'zh-CN' for Chinese, undefined (the browser's
 * default, as before) for English. Pages pass it to toLocaleString & co.
 *
 * Language choice: ?lang=zh|en in the URL (remembered), else the last choice on
 * this device (localStorage), else the browser's language. The switch button
 * goes in #lang-slot if the page has one, else top right.
 */
(function () {
  'use strict';
  var STORE = 'accessx.lang';
  var NAMES = { en: 'English', zh: '中文' };

  function choose() {
    var q = null;
    try { q = new URLSearchParams(location.search).get('lang'); } catch (e) { /* old browser */ }
    if (q && NAMES[q]) { try { localStorage.setItem(STORE, q); } catch (e) { /* private mode */ } return q; }
    try { var saved = localStorage.getItem(STORE); if (saved && NAMES[saved]) return saved; } catch (e) { /* private mode */ }
    var nav = (navigator.languages && navigator.languages[0]) || navigator.language || '';
    return /^zh\b/i.test(nav) ? 'zh' : 'en';
  }

  var lang = choose();
  var dict = lang === 'zh' ? (window.AX_I18N_ZH || { text: {}, patterns: [] }) : null;
  window.axLang = lang;
  window.axLocale = lang === 'zh' ? 'zh-CN' : undefined;

  var misses = new Map(); // string -> null, so a long table does not re-run every pattern
  var has = Object.prototype.hasOwnProperty;
  function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }
  function lookup(s) {
    if (!dict) return null;
    var k = norm(s);
    if (!k || !/[A-Za-z]/.test(k)) return null;
    if (has.call(dict.text, k)) return dict.text[k];
    if (misses.has(k)) return null;
    for (var i = 0; i < dict.patterns.length; i++) {
      var p = dict.patterns[i];
      if (p[0].test(k)) return k.replace(p[0], p[1]);
    }
    if (misses.size > 5000) misses.clear();
    misses.set(k, null);
    return null;
  }
  /** Translate one string (for code that builds messages itself). */
  window.axT = function (s) { var r = lookup(s); return r === null ? String(s) : r; };

  var SKIP = /^(SCRIPT|STYLE|TEXTAREA|CODE|NOSCRIPT)$/;
  var ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  function skipped(el) { return !el || SKIP.test(el.tagName) || (el.closest && el.closest('[translate="no"]')); }

  function text(node) {
    if (skipped(node.parentElement)) return;
    var v = node.nodeValue;
    var r = lookup(v);
    if (r === null) return;
    var lead = v.match(/^\s*/)[0];
    var trail = v.match(/\s*$/)[0];
    node.nodeValue = lead + r + trail;
  }
  function attrs(el) {
    if (skipped(el)) return;
    for (var i = 0; i < ATTRS.length; i++) {
      var v = el.getAttribute(ATTRS[i]);
      if (!v) continue;
      var r = lookup(v);
      if (r !== null) el.setAttribute(ATTRS[i], r);
    }
    if (el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type) && el.value) {
      var rv = lookup(el.value);
      if (rv !== null) el.value = rv;
    }
  }
  function tree(root) {
    if (root.nodeType === 3) { text(root); return; }
    if (root.nodeType !== 1 || skipped(root)) return;
    attrs(root);
    var els = root.querySelectorAll('[placeholder],[title],[aria-label],[alt],input');
    for (var i = 0; i < els.length; i++) attrs(els[i]);
    var walker = document.createTreeWalker(root, 4 /* SHOW_TEXT */);
    var n;
    var nodes = [];
    while ((n = walker.nextNode())) nodes.push(n);
    for (var j = 0; j < nodes.length; j++) text(nodes[j]);
  }

  function switcher() {
    if (document.querySelector('.ax-lang')) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ax-lang';
    b.setAttribute('translate', 'no');
    b.textContent = lang === 'zh' ? NAMES.en : NAMES.zh;
    b.setAttribute('aria-label', lang === 'zh' ? 'Switch to English' : '切换到中文');
    b.addEventListener('click', function () {
      try { localStorage.setItem(STORE, lang === 'zh' ? 'en' : 'zh'); } catch (e) { /* private mode: ?lang below */ }
      var u = new URL(location.href);
      u.searchParams.set('lang', lang === 'zh' ? 'en' : 'zh');
      location.replace(u.toString());
    });
    var slot = document.getElementById('lang-slot');
    if (slot) { b.className += ' btn2 sm'; slot.appendChild(b); return; }
    b.style.cssText = 'position:fixed;top:8px;right:8px;z-index:9999;font:13px/1 system-ui,sans-serif;padding:6px 10px;border-radius:4px;border:1px solid #888;background:rgba(255,255,255,.9);color:#000;cursor:pointer';
    document.body.appendChild(b);
  }

  function start() {
    switcher();
    if (!dict) return;
    document.documentElement.setAttribute('lang', 'zh-CN');
    var t = lookup(document.title);
    if (t !== null) document.title = t;
    tree(document.body);
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'characterData') text(m.target);
        else if (m.type === 'attributes') attrs(m.target);
        else for (var j = 0; j < m.addedNodes.length; j++) tree(m.addedNodes[j]);
      }
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS.concat(['value']) });
    ['alert', 'confirm', 'prompt'].forEach(function (fn) {
      var orig = window[fn];
      if (typeof orig !== 'function') return;
      window[fn] = function (msg) {
        var args = Array.prototype.slice.call(arguments);
        args[0] = window.axT(msg === undefined ? '' : msg);
        return orig.apply(window, args);
      };
    });
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
}());
