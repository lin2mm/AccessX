#!/usr/bin/env node
/**
 * Generate the Ed25519 key that signs audit anchors.
 *   node scripts/audit-keygen.js
 * Put AUDIT_SIGNING_KEY in the server env / `wrangler secret put AUDIT_SIGNING_KEY`.
 * Publish the public key (it is also served at GET /api/audit/anchors and
 * embedded in exports) and ask auditors to pin it.
 */
const { generateSigningKey } = require('../audit-anchor-core');

generateSigningKey().then(k => {
  console.log(`# key id ${k.keyId}`);
  console.log(`AUDIT_SIGNING_KEY='${JSON.stringify(k.private)}'`);
  console.log(`# public key (safe to publish): ${JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: k.private.x, kid: k.keyId, alg: 'EdDSA', use: 'sig' })}`);
});
