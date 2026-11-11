// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The front door, tested in the runtime it is deployed on.
 *
 * Each block stands in front of one way this Worker could quietly break a
 * property the application has already paid for. Every assertion here was
 * turned red on purpose before it was trusted — the mutation that does it is
 * named above the test, and docs/handoff/CLOUDFLARE.md records the runs.
 */
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import worker, { type ApiContainer, type Mode } from './harness.js';
import { containerEnv, missingRequired, NEVER_PASSED } from '../src/env.js';
import { handle } from '../src/front.js';

interface TestEnv {
  API: DurableObjectNamespace<ApiContainer>;
  WORKER: DurableObjectNamespace;
  [name: string]: unknown;
}
const base = env as unknown as TestEnv;
const apiStub = () => base.API.get(base.API.idFromName('primary'));

interface Seen {
  method: string; url: string; host: string; path: string; ip: string;
  headers: Array<[string, string]>; bodyLength: number; bodySha256: string;
}

function send(url: string, init: RequestInit = {}, overrides: Record<string, unknown> = {}): Promise<Response> {
  return worker.fetch(new Request(url, init), { ...base, ...overrides } as never);
}
const header = (seen: Seen, name: string) => seen.headers.filter(([k]) => k === name).map(([, v]) => v);

async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

let mode: (m: Mode) => Promise<void>;
beforeEach(async () => {
  mode = async (m) => { await apiStub().setMode(m); };
  await mode('app');
});

// Mutation: in forwardedHeaders(), stop deleting x-forwarded-for (or append
// CF-Connecting-IP to it, which is what Cloudflare itself does).
describe('the caller cannot choose the IP the application sees', () => {
  it('a spoofed X-Forwarded-For is replaced by the address Cloudflare observed', async () => {
    const res = await send('https://ratchetgate.com/v1/provision', {
      method: 'POST',
      headers: { 'X-Forwarded-For': '198.51.100.77', 'CF-Connecting-IP': '203.0.113.9' },
      body: '{}',
    });
    const seen = await res.json<Seen>();
    expect(seen.ip).toBe('203.0.113.9');
    expect(header(seen, 'x-forwarded-for')).toEqual(['203.0.113.9']);
  });

  it('changing the spoofed value does not change the bucket', async () => {
    const ips = new Set<string>();
    for (const spoof of ['1.1.1.1', '2.2.2.2, 3.3.3.3', '::1', 'unknown', '']) {
      const res = await send('https://ratchetgate.com/v1/provision', {
        method: 'POST',
        headers: { 'X-Forwarded-For': spoof, 'CF-Connecting-IP': '203.0.113.9' },
      });
      ips.add((await res.json<Seen>()).ip);
    }
    expect([...ips]).toEqual(['203.0.113.9']);
  });

  it('every other header that claims an origin is dropped', async () => {
    const res = await send('https://ratchetgate.com/', {
      headers: {
        'CF-Connecting-IP': '203.0.113.9',
        Forwarded: 'for=198.51.100.77;proto=http;host=evil.example',
        'X-Real-IP': '198.51.100.77',
        'X-Client-IP': '198.51.100.77',
        'True-Client-IP': '198.51.100.77',
        'X-Forwarded-Host': 'evil.example',
        'X-Forwarded-Proto': 'http',
        'X-Forwarded-Port': '80',
      },
    });
    const seen = await res.json<Seen>();
    for (const name of ['forwarded', 'x-real-ip', 'x-client-ip', 'true-client-ip', 'x-forwarded-host', 'x-forwarded-port']) {
      expect(header(seen, name), name).toEqual([]);
    }
    // What the client used, as observed here — not as the client described it.
    expect(header(seen, 'x-forwarded-proto')).toEqual(['https']);
    expect(JSON.stringify(seen.headers)).not.toContain('198.51.100.77');
    expect(JSON.stringify(seen.headers)).not.toContain('evil.example');
  });

  it('with no CF-Connecting-IP the header is removed, never guessed', async () => {
    const res = await send('https://ratchetgate.com/', { headers: { 'X-Forwarded-For': '198.51.100.77' } });
    const seen = await res.json<Seen>();
    expect(header(seen, 'x-forwarded-for')).toEqual([]);
    // One shared address for everybody: limits too much, not too little.
    expect(seen.ip).toBe('10.0.0.2');
  });
});

// Mutation: in refusePlaintext(), redirect every method (drop the GET/HEAD
// test) — or in handle(), build the forwarded Request with redirect: 'follow'.
describe('a request that is not a page view is never redirected', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    it(`${method} over plain http is refused, not redirected`, async () => {
      const res = await send('http://ratchetgate.com/v1/effects/begin', { method, body: '{}' });
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
      expect(await res.json()).toMatchObject({ error: { code: 'request_error' } });
      expect(await apiStub().requestsReceived()).toBe(0);
    });
  }

  it('a GET over plain http is sent to https on the same host and path', async () => {
    const res = await send('http://www.ratchetgate.com/pricing?x=1');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://www.ratchetgate.com/pricing?x=1');
    expect(await apiStub().requestsReceived()).toBe(0);
  });

  it('a POST to the www host is forwarded, with the host it was sent to', async () => {
    const res = await send('https://www.ratchetgate.com/v1/effects/begin', { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    const seen = await res.json<Seen>();
    expect(seen.method).toBe('POST');
    expect(seen.host).toBe('www.ratchetgate.com');
  });

  it("the application's own redirect reaches the client; the Worker does not follow it", async () => {
    const res = await send('https://www.ratchetgate.com/page-on-another-host');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://ratchetgate.com/pricing');
  });

  it('no method is answered with a 3xx the application did not send', async () => {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const res = await send('https://ratchetgate.com/v1/effects', { method });
      expect(res.status, method).toBe(200);
    }
  });
});

// Mutation: in handle(), replace `body: request.body` with
// `body: await request.text()` (re-encodes), or parse and re-serialise JSON.
describe('the body arrives byte for byte', () => {
  it('64 KB of every byte value, including bytes that are not valid UTF-8', async () => {
    const body = new Uint8Array(65_536);
    for (let i = 0; i < body.length; i += 1) body[i] = (i * 31 + (i >> 8)) & 0xff;
    const res = await send('https://ratchetgate.com/echo-bytes', { method: 'POST', body });
    const back = new Uint8Array(await res.arrayBuffer());
    expect(back.byteLength).toBe(65_536);
    expect(await sha256Hex(back)).toBe(await sha256Hex(body));
  });

  it('a signed webhook body keeps its exact whitespace, escapes and key order', async () => {
    // Semantically equal JSON with different bytes fails an HMAC. These are
    // the differences a parse-and-reserialise would erase.
    const raw = '{ "id":"evt_1",\r\n  "amount": 1.0,\t"note":"caf\\u00e9 é \\/ ",  "b":1,"a":2 }\n';
    const res = await send('https://ratchetgate.com/v1/billing/webhook/stripe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=1,v1=abc' },
      body: raw,
    });
    const seen = await res.json<Seen>();
    const bytes = new TextEncoder().encode(raw);
    expect(seen.bodyLength).toBe(bytes.byteLength);
    expect(seen.bodySha256).toBe(await sha256Hex(bytes));
    expect(header(seen, 'stripe-signature')).toEqual(['t=1,v1=abc']);
  });

  it('the path and query are forwarded exactly as sent', async () => {
    const res = await send('https://ratchetgate.com/v1/effects?state=indeterminate&q=a%2Fb+c&empty=');
    expect((await res.json<Seen>()).path).toBe('/v1/effects?state=indeterminate&q=a%2Fb+c&empty=');
  });

  it('credentials are forwarded untouched', async () => {
    const res = await send('https://ratchetgate.com/v1/effects', {
      headers: { Authorization: 'Bearer rk_test_abc', 'X-Api-Key': 'rk_test_def', Cookie: 'rk_session=xyz' },
    });
    const seen = await res.json<Seen>();
    expect(header(seen, 'authorization')).toEqual(['Bearer rk_test_abc']);
    expect(header(seen, 'x-api-key')).toEqual(['rk_test_def']);
    expect(header(seen, 'cookie')).toEqual(['rk_session=xyz']);
  });
});

// Mutation: in unavailable(), return status 200 — or in Supervised.fetch(),
// when reach() returns null, return `new Response('ok')`.
describe('with no container behind it, the door stays shut', () => {
  for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
    it(`${method} is answered 503 in Ratchet's error shape`, async () => {
      await mode('down');
      const res = await send('https://ratchetgate.com/v1/effects/begin', {
        method, body: method === 'GET' ? undefined : '{"effect_type":"payment"}',
      });
      expect(res.status).toBe(503);
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(Object.keys(body)).toEqual(['error']);
      expect(Object.keys(body.error).sort()).toEqual(['code', 'message']);
      expect(body.error.code).toBe('service_unavailable');
      // Nothing was forwarded, so this much can be said for certain.
      expect(body.error.message).toContain('No decision was made');
    });
  }

  it('HEAD is 503 with no body', async () => {
    await mode('down');
    const res = await send('https://ratchetgate.com/healthz', { method: 'HEAD' });
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('');
  });

  it('a browser asking for a page gets 503 too, never a cached-looking 200', async () => {
    await mode('down');
    const res = await send('https://ratchetgate.com/', { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(503);
  });
});

// Mutation: in Supervised.fetch(), retry `upstream.fetch` once in the catch —
// or return unavailable('not_forwarded') there, which claims a certainty that
// does not exist.
describe('when the application takes the request and then fails', () => {
  it('the answer is 503, the request was sent once, and nothing internal leaks', async () => {
    await mode('broken');
    const res = await send('https://ratchetgate.com/v1/effects/begin', {
      method: 'POST', body: '{"effect_type":"payment","idempotency_key":"k1"}',
    });
    expect(res.status).toBe(503);
    const text = await res.text();
    const body = JSON.parse(text) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('service_unavailable');
    // It may have been recorded. Saying otherwise would be a guess.
    expect(body.error.message).not.toContain('No decision was made');
    expect(body.error.message).toContain('same idempotency key');
    expect(text).not.toContain('postgres://');
    expect(text).not.toContain('connection reset');
    // Never retried on the caller's behalf.
    expect(await apiStub().requestsReceived()).toBe(1);
  });
});

// Mutation: in handle(), rebuild the response as
// `new Response(res.body, { status: res.status, headers: Object.fromEntries(res.headers) })`,
// which folds two Set-Cookie headers into one unusable line.
describe('the response is the application\'s, untouched', () => {
  it('both Set-Cookie headers, the CSP and HSTS arrive as sent', async () => {
    const res = await send('https://ratchetgate.com/login', { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([
      'rk_session=abc; Path=/; HttpOnly; Secure; SameSite=Strict',
      'rk_csrf=def; Path=/; Secure; SameSite=Strict',
    ]);
    expect(res.headers.get('content-security-policy')).toBe("default-src 'self'; frame-ancestors 'none'");
    expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
    expect(await res.text()).toBe('{"ok":true}');
  });
});

// Mutation: in opsStatus(), drop the bearer comparison.
describe('the ops route does not exist for anyone without the token', () => {
  const TOKEN = 'test-ops-token-0123456789abcdef0123456789';

  it('with OPS_TOKEN unset the path goes to the application like any other', async () => {
    const res = await send('https://ratchetgate.com/__ops/status', { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect((await res.json<Seen>()).path).toBe('/__ops/status');
  });

  it('a wrong or missing token is indistinguishable from the route not existing', async () => {
    for (const authorization of [undefined, 'Bearer wrong', `Bearer ${TOKEN}x`, TOKEN]) {
      const res = await send('https://ratchetgate.com/__ops/status',
        { headers: authorization ? { Authorization: authorization } : {} }, { OPS_TOKEN: TOKEN });
      expect((await res.json<Seen>()).path, String(authorization)).toBe('/__ops/status');
    }
  });

  it('a token too short to be a credential switches the route off', async () => {
    const res = await send('https://ratchetgate.com/__ops/status',
      { headers: { Authorization: 'Bearer short' } }, { OPS_TOKEN: 'short' });
    expect((await res.json<Seen>()).path).toBe('/__ops/status');
  });

  it('the right token gets the commit and both container states', async () => {
    const res = await send('https://ratchetgate.com/__ops/status',
      { headers: { Authorization: `Bearer ${TOKEN}` } }, { OPS_TOKEN: TOKEN, GIT_COMMIT: 'a'.repeat(40) });
    expect(res.status).toBe(200);
    const body = await res.json<{ commit: string; api: { running: boolean }; worker: { running: boolean } }>();
    expect(body.commit).toBe('a'.repeat(40));
    // No container exists under the test runner, and the report says so.
    expect(body.api.running).toBe(false);
    expect(body.worker.running).toBe(false);
  });
});

// Mutation: add 'WEBHOOK_ALLOW_PRIVATE_NETWORK' to PASSED_THROUGH in env.ts.
describe('what reaches a container', () => {
  it('test-only switches set on the Worker never reach the application', () => {
    const everything = Object.fromEntries(NEVER_PASSED.map((n) => [n, 'true']));
    const passed = containerEnv({ ...everything, DATABASE_URL: 'x', AUTH_SECRET: 'y' });
    expect(Object.keys(passed).sort()).toEqual(['AUTH_SECRET', 'DATABASE_URL']);
  });

  it('bindings and the ops token are not copied in', () => {
    const passed = containerEnv({ API: {}, WORKER: {}, OPS_TOKEN: 'secret', ALLOW_PLAINTEXT: 'true', PORT: '8787' });
    expect(passed).toEqual({ PORT: '8787' });
  });

  it('a missing required secret is named, so the container is not started to crash', () => {
    expect(missingRequired({ DATABASE_URL: 'x' })).toEqual(['AUTH_SECRET']);
    expect(missingRequired({ DATABASE_URL: '', AUTH_SECRET: 'y' })).toEqual(['DATABASE_URL']);
  });
});

// Mutation: in handle(), return the caught error's text in the 503.
describe('when the Durable Object itself cannot be reached', () => {
  it('the door answers closed, and says nothing about why', async () => {
    const failing = {
      fetch: async (): Promise<Response> => {
        throw new Error('Durable Object reset: postgres://user:secret@db.internal/ratchet');
      },
    };
    const res = await handle(new Request('https://ratchetgate.com/v1/effects/begin', { method: 'POST', body: '{}' }), failing);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'service_unavailable' } });
    expect(text).not.toContain('secret');
    expect(text).not.toContain('Durable Object');
  });

  it('plain http is forwarded only where it has been switched on, and is reported as http', async () => {
    const res = await send('http://localhost/v1/effects', { method: 'POST', body: '{}' }, { ALLOW_PLAINTEXT: 'true' });
    expect(res.status).toBe(200);
    expect(header(await res.json<Seen>(), 'x-forwarded-proto')).toEqual(['http']);
  });
});
