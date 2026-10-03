const test = require('node:test');
const assert = require('node:assert/strict');
const { createDnsTxtResolver, parseTxtData } = require('../dns-core');

// Shapes as returned by https://cloudflare-dns.com/dns-query (application/dns-json).
const answer = (name, ...data) => ({ Status: 0, Answer: data.map(d => ({ name, type: 16, TTL: 300, data: d })) });

test('DoH TXT: quoted and split records, CNAME answers ignored, NXDOMAIN empty, failures throw', async () => {
  const seen = [];
  const replies = {
    '_accessx.acme.com': answer('_accessx.acme.com', '"accessx-verification=abc123"', '"v=spf1 " "include:_spf.acme.com -all"'),
    '_accessx.alias.com': { Status: 0, Answer: [{ type: 5, data: 'target.example.' }, { type: 16, data: '"accessx-verification=zzz"' }] },
    '_accessx.gone.com': { Status: 3 },
    '_accessx.broken.com': { Status: 2 },
  };
  const fetchFn = async url => {
    const u = new URL(url);
    seen.push(u);
    const name = u.searchParams.get('name');
    if (name === '_accessx.down.com') return { ok: false, status: 503 };
    return { ok: true, status: 200, json: async () => replies[name] };
  };
  const dns = createDnsTxtResolver({ fetchFn });
  assert.deepEqual(await dns.txt('_accessx.ACME.com.'), ['accessx-verification=abc123', 'v=spf1 include:_spf.acme.com -all']);
  assert.equal(seen[0].searchParams.get('type'), 'TXT');
  assert.equal(seen[0].searchParams.get('name'), '_accessx.acme.com', 'lower-cased, trailing dot removed');
  assert.deepEqual(await dns.txt('_accessx.alias.com'), ['accessx-verification=zzz']);
  assert.deepEqual(await dns.txt('_accessx.gone.com'), []);
  await assert.rejects(dns.txt('_accessx.broken.com'), /status 2/);
  await assert.rejects(dns.txt('_accessx.down.com'), /HTTP 503/);
  dns.set('_accessx.test.com', 'accessx-verification=t');
  assert.deepEqual(await dns.txt('_accessx.test.com'), ['accessx-verification=t']);
  assert.equal(parseTxtData('"a\\"b"'), 'a"b');
});
