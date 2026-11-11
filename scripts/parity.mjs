// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Does B behave like A?
 *
 * Runs ONE scenario against two base URLs and compares what a client can
 * observe: status, decision, error code, the shape of the body, and the
 * headers that carry a promise (security headers, redirects, cookies, CORS).
 * Written for the move to Cloudflare — A is whatever is known good, B is the
 * new deployment — but it knows nothing about either platform.
 *
 *   node scripts/parity.mjs <base-A> <base-B> [--writes] [--same-secret] [--json]
 *
 *   --writes       also run the gate lifecycle (keyless provision → begin →
 *                  begin again → report → begin again). This CREATES a
 *                  throwaway workspace on both targets, so it is off by
 *                  default and should not be pointed at production casually.
 *   --same-secret  the two targets are meant to share AUTH_SECRET (old
 *                  production vs new production). Then the receipt-signing
 *                  key id must match, and a mismatch is a failure. Without the
 *                  flag (staging vs production) a match is the failure:
 *                  two environments sharing a secret are one trust domain.
 *   --json         print the full normalised record for both sides.
 *
 * Exit 0: no differences. Exit 1: differences, listed. Exit 2: could not run.
 *
 * What this does NOT prove, so nobody reads a green run as more than it is:
 * concurrency, lease expiry, webhook delivery, anything behind a console
 * session, and anything about data — a parity run on an empty database says
 * the code path matches, not that the rows came across. The integration suite
 * and scripts/verify-restore.mjs cover those.
 */
import { createHash, randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const [A, B] = argv.filter((a) => !a.startsWith('--')).map((u) => u.replace(/\/+$/, ''));
if (!A || !B) {
  console.error('usage: parity.mjs <base-A> <base-B> [--writes] [--same-secret] [--json]');
  process.exit(2);
}
const WRITES = flags.has('--writes');
const SAME_SECRET = flags.has('--same-secret');

/** Headers that are a promise to the client. Compared exactly, after normalising. */
const CONTRACT_HEADERS = [
  'content-type', 'cache-control', 'content-security-policy', 'strict-transport-security',
  'x-content-type-options', 'x-frame-options', 'referrer-policy', 'permissions-policy',
  'cross-origin-opener-policy', 'cross-origin-resource-policy', 'cross-origin-embedder-policy',
  'x-robots-tag', 'location', 'www-authenticate', 'retry-after', 'allow',
  'access-control-allow-origin', 'access-control-allow-credentials',
  'access-control-allow-methods', 'access-control-allow-headers',
];
/**
 * Headers a platform adds or rewrites. Reported, never failed on: a CDN is
 * expected to add its own, and may compress (changing content-encoding, vary
 * and the etag's strength) without changing what the application said.
 */
const PLATFORM_HEADERS = new Set([
  'date', 'server', 'via', 'age', 'alt-svc', 'nel', 'report-to', 'connection', 'keep-alive',
  'transfer-encoding', 'content-length', 'content-encoding', 'vary', 'etag', 'last-modified',
  'accept-ranges', 'cf-ray', 'cf-cache-status', 'server-timing', 'fly-request-id',
  'x-request-id', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset',
  'priority', 'speculation-rules',
]);

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

function normaliseHeader(name, value, base) {
  if (value == null) return null;
  let v = value;
  // A redirect or CORS origin naming the target's own host is "the same
  // answer" on both sides.
  v = v.split(base).join('<base>').split(new URL(base).host).join('<host>');
  if (name === 'retry-after') v = /^\d+$/.test(v) ? '<seconds>' : v;
  return v;
}

/** Set-Cookie: the name and the attributes are the contract; the value is a secret. */
function cookieShapes(headers) {
  return headers.getSetCookie().map((c) => {
    const [pair, ...attrs] = c.split(';').map((p) => p.trim());
    const name = pair.split('=')[0];
    const kept = attrs.map((a) => (/^(expires|max-age)=/i.test(a) ? a.split('=')[0] : a)).sort();
    return `${name}; ${kept.join('; ')}`;
  }).sort();
}

/** Keys only, recursively, so two bodies with different ids still compare equal. */
function shape(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length ? [shape(value[0], depth + 1)] : [];
  if (typeof value === 'object') {
    if (depth > 4) return 'object';
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, shape(value[k], depth + 1)]));
  }
  return typeof value;
}

async function call(base, step) {
  const init = {
    method: step.method ?? 'GET',
    redirect: 'manual',
    headers: { ...(step.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  };
  if (step.body !== undefined) {
    init.body = typeof step.body === 'string' ? step.body : JSON.stringify(step.body);
    init.headers['content-type'] ??= 'application/json';
  }
  let res;
  try {
    res = await fetch(`${base}${step.path}`, init);
  } catch (err) {
    return { record: { unreachable: err.cause?.code ?? err.message }, json: null, headers: new Headers() };
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }

  const record = { status: res.status };
  if (json && typeof json === 'object') {
    if ('decision' in json) record.decision = json.decision;
    if (json.error?.code) record.error_code = json.error.code;
    record.body_shape = shape(json);
  } else if (step.compareBody) {
    record.body_sha256 = sha(text.split(base).join('<base>'));
  } else {
    record.body_kind = text.length ? 'text' : 'empty';
  }
  for (const pick of step.pick ?? []) record[pick] = json?.[pick] ?? null;
  record.headers = {};
  for (const name of CONTRACT_HEADERS) {
    const v = normaliseHeader(name, res.headers.get(name), base);
    if (v !== null) record.headers[name] = v;
  }
  const cookies = cookieShapes(res.headers);
  if (cookies.length) record.headers['set-cookie'] = cookies;
  record.other_headers = [...new Set([...res.headers.keys()])]
    .filter((h) => !CONTRACT_HEADERS.includes(h) && h !== 'set-cookie' && !PLATFORM_HEADERS.has(h)).sort();
  return { record, json, headers: res.headers };
}

function diff(a, b, path = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  const bothObjects = a && b && typeof a === 'object' && typeof b === 'object'
    && !Array.isArray(a) && !Array.isArray(b);
  if (!bothObjects) return [`${path || '(record)'}: A=${JSON.stringify(a)}  B=${JSON.stringify(b)}`];
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
    .flatMap((k) => diff(a[k], b[k], path ? `${path}.${k}` : k));
}

const failures = [];
const notes = [];
const full = [];

async function step(name, def) {
  const forA = typeof def === 'function' ? def('A') : def;
  const forB = typeof def === 'function' ? def('B') : def;
  if (!forA || !forB) { notes.push(`${name}: skipped (an earlier step did not produce what it needs)`); return [null, null]; }
  const [a, b] = await Promise.all([call(A, forA), call(B, forB)]);
  full.push({ step: name, A: a.record, B: b.record });
  const d = diff(a.record, b.record);
  if (d.length) {
    failures.push(...d.map((line) => `${name} — ${line}`));
    console.log(`  DIFF  ${name}`);
  } else {
    const what = a.record.unreachable ? `unreachable (${a.record.unreachable})`
      : [a.record.status, a.record.decision, a.record.error_code].filter(Boolean).join(' ');
    console.log(`  same  ${name}  ${what}`);
    if (a.record.unreachable) failures.push(`${name} — both targets were unreachable; nothing was compared`);
  }
  return [a, b];
}

console.log(`A = ${A}\nB = ${B}\n`);

/* ---- it is up, and says so the same way -------------------------------- */
for (const path of ['/healthz', '/readyz']) await step(`GET ${path}`, { path });
// /workerz describes the deployment (replication, instances), so only its
// status and shape are compared — the default — and never its values.
await step('GET /workerz', { path: '/workerz' });

/* ---- pages: status, security headers, and the bytes -------------------- */
for (const path of ['/', '/docs', '/security', '/privacy', '/status', '/pricing']) {
  await step(`GET ${path}`, { path, headers: { accept: 'text/html' }, compareBody: true });
}
await step('GET /no-such-page', { path: `/no-such-page-${sha(A + B)}`, headers: { accept: 'text/html' } });
await step('HEAD /', { path: '/', method: 'HEAD' });

/* ---- discovery documents: byte-identical once the host is factored out -- */
for (const path of ['/openapi.json', '/llms.txt', '/robots.txt', '/.well-known/security.txt',
  '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource',
  '/.well-known/agent-manifest.json', '/mcp/info', '/sitemap.xml']) {
  await step(`GET ${path}`, { path, compareBody: true });
}

/* ---- the receipt key: who signs, and with what -------------------------- */
const [keyA, keyB] = await step('GET /.well-known/ratchet-receipt-key', { path: '/.well-known/ratchet-receipt-key' });
const kidA = keyA?.json?.current_kid; const kidB = keyB?.json?.current_kid;
if (kidA && kidB) {
  if (SAME_SECRET && kidA !== kidB) {
    failures.push(`receipt key — kid differs (A=${kidA} B=${kidB}): B is NOT running A's AUTH_SECRET. `
      + 'Every API key is dead on B and every per-counterparty ceiling has reset. Do not cut over.');
  } else if (!SAME_SECRET && kidA === kidB) {
    failures.push(`receipt key — kid is identical (${kidA}) on two targets that were not declared `
      + '--same-secret: they share AUTH_SECRET, so a key minted on one works on the other.');
  } else {
    console.log(`  ${SAME_SECRET ? 'same' : 'differ'}  receipt kid  A=${kidA} B=${kidB}  (as declared)`);
  }
} else {
  failures.push('receipt key — current_kid was not readable on both targets');
}

/* ---- refusals: the error contract --------------------------------------- */
await step('GET /v1/effects (no key)', { path: '/v1/effects' });
await step('GET /v1/effects (bad key)', { path: '/v1/effects', headers: { authorization: 'Bearer rk_live_notarealkey' } });
await step('POST /v1/effects/begin (unknown field)', {
  path: '/v1/effects/begin', method: 'POST', headers: { authorization: 'Bearer rk_live_notarealkey' },
  body: { effect_type: 'parity.test', idempotency_key: 'x', estimated_cost: 1 },
});
await step('POST /v1/effects/begin (not JSON)', {
  path: '/v1/effects/begin', method: 'POST', headers: { authorization: 'Bearer rk_live_notarealkey' }, body: '{not json',
});
await step('POST /v1/billing/webhook/stripe (unsigned)', {
  path: '/v1/billing/webhook/stripe', method: 'POST', body: { id: 'evt_parity', type: 'checkout.session.completed' },
});
await step('POST /mcp (initialize)', {
  path: '/mcp', method: 'POST', headers: { accept: 'application/json, text/event-stream' },
  body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'parity', version: '0' } } },
  pick: ['jsonrpc'],
});
await step('OPTIONS /v1/effects (foreign origin)', {
  path: '/v1/effects', method: 'OPTIONS',
  headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
});
await step('GET /metrics (no token)', { path: '/metrics' });
await step('GET /__ops/status (no token)', { path: '/__ops/status' });

/* ---- a body over the limit is refused the same way ---------------------- */
await step('POST 70 KB body', {
  path: '/v1/effects/begin', method: 'POST', headers: { authorization: 'Bearer rk_live_notarealkey' },
  body: JSON.stringify({ effect_type: 'parity.test', idempotency_key: 'x', payload: { pad: 'x'.repeat(70_000) } }),
});

/* ---- can the caller choose its own rate-limit bucket? ------------------- */
// Two unauthenticated requests, each claiming a different client address. If
// the allowance left goes DOWN across them, both landed in one bucket and the
// claim was ignored. If it does not, the header was believed: every request
// gets a fresh bucket and the unauthenticated limit never refuses.
// Reported per target and failed on outright — a difference here is not
// "B behaves unlike A", it is a hole on whichever side has it.
for (const [label, base] of [['A', A], ['B', B]]) {
  const remaining = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await call(base, { path: '/v1/effects', headers: { 'x-forwarded-for': `198.51.100.${10 + i}` } });
    const v = r.headers.get('x-ratelimit-remaining');
    remaining.push(v === null ? null : Number(v));
  }
  if (remaining.some((v) => v === null || Number.isNaN(v))) {
    notes.push(`spoofed X-Forwarded-For on ${label}: not observable (no x-ratelimit-remaining header)`);
  } else if (remaining[2] < remaining[0]) {
    console.log(`  ok    spoofed X-Forwarded-For is ignored on ${label}  (remaining ${remaining.join(' → ')})`);
  } else {
    failures.push(`spoofed X-Forwarded-For on ${label} — the allowance did not fall (${remaining.join(' → ')}): `
      + 'a client-supplied address is choosing the rate-limit bucket');
  }
}

/* ---- the gate actually gates, identically -------------------------------- */
if (WRITES) {
  const idem = `parity:${randomUUID()}`;
  const begin = { effect_type: 'parity.test', idempotency_key: idem, payload: { n: 1 } };
  const [a1, b1] = await step('begin (keyless provision)', { path: '/v1/effects/begin', method: 'POST', body: begin });
  const session = {
    A: { key: a1?.json?.workspace?.api_key, effect: a1?.json?.effect_id, lease: a1?.json?.lease_token },
    B: { key: b1?.json?.workspace?.api_key, effect: b1?.json?.effect_id, lease: b1?.json?.lease_token },
  };
  const auth = (side) => ({ authorization: `Bearer ${session[side].key}` });
  const ready = (side) => session[side].key && session[side].effect;

  const [a2, b2] = await step('begin again (same key)', (s) => ready(s) && {
    path: '/v1/effects/begin', method: 'POST', headers: auth(s), body: begin });
  for (const [label, r, s] of [['A', a2, session.A], ['B', b2, session.B]]) {
    if (r?.json?.decision === 'execute') failures.push(`AT-MOST-ONCE VIOLATED on ${label}: the same key was authorised twice`);
    if (r?.json && r.json.effect_id !== s.effect) failures.push(`identity on ${label}: the same key produced two effect ids`);
  }
  await step('begin, same key, different payload', (s) => ready(s) && {
    path: '/v1/effects/begin', method: 'POST', headers: auth(s), body: { ...begin, payload: { n: 2 } } });
  await step('report with a stale lease token', (s) => ready(s) && {
    path: `/v1/effects/${session[s].effect}/report`, method: 'POST', headers: auth(s),
    body: { lease_token: 'lt_not_the_lease', outcome: 'succeeded', result: {} } });
  await step('report succeeded', (s) => ready(s) && {
    path: `/v1/effects/${session[s].effect}/report`, method: 'POST', headers: auth(s),
    body: { lease_token: session[s].lease, outcome: 'succeeded', result: { parity: true } } });
  await step('begin after report (replay)', (s) => ready(s) && {
    path: '/v1/effects/begin', method: 'POST', headers: auth(s), body: begin });
  await step('GET the effect', (s) => ready(s) && { path: `/v1/effects/${session[s].effect}`, headers: auth(s) });
  await step("GET the effect with the OTHER workspace's key", (s) => ready('A') && ready('B') && {
    path: `/v1/effects/${session[s].effect}`, headers: auth(s === 'A' ? 'B' : 'A') });
  await step('begin from a browser session (no key)', (s) => ready(s) && {
    path: '/v1/effects/begin', method: 'POST', headers: { cookie: 'rk_session=not-a-session', origin: s === 'A' ? A : B },
    body: { effect_type: 'parity.test', idempotency_key: `${idem}:cookie` } });
} else {
  notes.push('the gate lifecycle was not run (pass --writes; it creates a throwaway workspace on both targets)');
}

/* ---- report -------------------------------------------------------------- */
const extra = (side) => [...new Set(full.flatMap((f) => f[side].other_headers ?? []))].sort();
const onlyA = extra('A').filter((h) => !extra('B').includes(h));
const onlyB = extra('B').filter((h) => !extra('A').includes(h));
if (onlyA.length) notes.push(`headers only A sends: ${onlyA.join(', ')}`);
if (onlyB.length) notes.push(`headers only B sends: ${onlyB.join(', ')}`);

if (flags.has('--json')) console.log(JSON.stringify(full, null, 2));
console.log();
for (const n of notes) console.log(`  note  ${n}`);
// other_headers differences are already in `failures` through the record diff:
// an unknown header on one side only is a difference until someone decides it
// is platform noise and adds it to PLATFORM_HEADERS.
if (failures.length) {
  console.error(`\n${failures.length} difference(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\nNo differences across ${full.length} steps.`);
