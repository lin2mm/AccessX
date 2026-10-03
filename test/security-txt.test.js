const test = require('node:test');
const assert = require('node:assert/strict');
const { securityTxt } = require('../security-txt');
const { boot } = require('../support/boot');

test('security.txt: only with a real contact; RFC 9116 fields', () => {
  assert.equal(securityTxt({}), null, 'no contact configured: no file');
  assert.equal(securityTxt({ SECURITY_CONTACT: 'security at example' }), null, 'garbage is not published');
  const now = Date.UTC(2026, 8, 27, 15);
  const txt = securityTxt({ SECURITY_CONTACT: 'mailto:security@accessx.example, https://accessx.example/security', SECURITY_POLICY: 'https://accessx.example/disclosure', PUBLIC_URL: 'https://doors.example/' }, now);
  assert.equal(txt, [
    'Contact: mailto:security@accessx.example', 'Contact: https://accessx.example/security', 'Expires: 2027-03-28T00:00:00Z',
    'Policy: https://accessx.example/disclosure', 'Canonical: https://doors.example/.well-known/security.txt', 'Preferred-Languages: en, zh', '',
  ].join('\n'));
  assert.ok(!securityTxt({ SECURITY_CONTACT: 'mailto:a@b.example', PUBLIC_URL: 'http://localhost:3000' }).includes('Canonical'), 'no http canonical');
});

test('security.txt is served by the Node server', async t => {
  const prev = process.env.SECURITY_CONTACT;
  process.env.SECURITY_CONTACT = 'mailto:security@accessx.example';
  t.after(() => { if (prev === undefined) delete process.env.SECURITY_CONTACT; else process.env.SECURITY_CONTACT = prev; });
  const api = await boot({ ADMIN_TOKEN: 'owner-token', RECONCILE_INTERVAL_MIN: '0' });
  t.after(api.close);
  const r = await fetch(`${api.base}/.well-known/security.txt`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/plain; charset=utf-8/);
  assert.match(await r.text(), /^Contact: mailto:security@accessx\.example\nExpires: \d{4}-\d\d-\d\dT00:00:00Z\n/);
});
