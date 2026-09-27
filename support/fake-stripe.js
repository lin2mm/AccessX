'use strict';
// Minimal Stripe stand-in for tests: records requests, answers the three
// endpoints AccessX uses, replays by Idempotency-Key, can fail on demand.
const http = require('node:http');

function createFakeStripe() {
  const calls = [];
  const byKey = new Map();
  let failNext = 0;
  let n = 0;
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => {
      const params = Object.fromEntries(new URLSearchParams(data));
      const call = { method: req.method, path: req.url, headers: req.headers, params };
      calls.push(call);
      const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (!/^Bearer sk_test_/.test(req.headers.authorization || '')) return send(401, { error: { message: 'Invalid API Key provided' } });
      if (failNext > 0) { failNext--; return send(500, { error: { message: 'simulated outage' } }); }
      const key = req.headers['idempotency-key'];
      if (key && byKey.has(key)) return send(200, byKey.get(key));
      let body;
      if (req.url === '/v1/checkout/sessions') { n++; body = { id: `cs_test_${n}`, object: 'checkout.session', url: `https://checkout.stripe.test/c/cs_test_${n}` }; }
      else if (req.url === '/v1/billing_portal/sessions') body = { id: 'bps_test_1', url: 'https://billing.stripe.test/p/session_1' };
      else if (req.url === '/v1/billing/meter_events') body = { object: 'billing.meter_event', event_name: params.event_name, identifier: params.identifier };
      else return send(404, { error: { message: `Unrecognized request URL (${req.method}: ${req.url})` } });
      if (key) byKey.set(key, body);
      send(200, body);
    });
  });
  return {
    calls,
    callsTo: p => calls.filter(c => c.path === p),
    failNext: k => { failNext = k; },
    listen: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise(r => server.close(r)),
  };
}

module.exports = { createFakeStripe };
