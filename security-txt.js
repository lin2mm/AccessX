'use strict';
/**
 * /.well-known/security.txt (RFC 9116), built from configuration:
 *   SECURITY_CONTACT  required: one or more of mailto:, https:, tel: URIs, comma-separated
 *   SECURITY_POLICY   optional: https URL of the disclosure policy
 *   PUBLIC_URL        adds the Canonical line
 * Without SECURITY_CONTACT there is no file (404): a made-up contact is
 * worse than none. Expires is always ~6 months ahead (the RFC asks for less
 * than a year), so the file never goes stale while the deployment runs.
 */
const URI = /^(mailto:[^\s@,]+@[^\s@,]+\.[^\s@,]+|https:\/\/[^\s,]+|tel:\+?[0-9-]{5,20})$/i;

function securityTxt(env = {}, now = Date.now()) {
  const contacts = String(env.SECURITY_CONTACT || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!contacts.length || !contacts.every(c => URI.test(c))) return null;
  const expires = new Date(now + 182 * 864e5);
  expires.setUTCHours(0, 0, 0, 0);
  const lines = contacts.map(c => `Contact: ${c}`);
  lines.push(`Expires: ${expires.toISOString().replace('.000Z', 'Z')}`);
  if (/^https:\/\/\S+$/i.test(env.SECURITY_POLICY || '')) lines.push(`Policy: ${env.SECURITY_POLICY}`);
  const base = String(env.PUBLIC_URL || '').replace(/\/+$/, '');
  if (/^https:\/\//i.test(base)) lines.push(`Canonical: ${base}/.well-known/security.txt`);
  lines.push('Preferred-Languages: en, zh');
  return lines.join('\n') + '\n';
}

module.exports = { securityTxt };
