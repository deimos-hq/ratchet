// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * What `req.ip` is, and therefore what the proxy in front must send.
 *
 * `req.ip` is the bucket for the unauthenticated rate limit
 * (src/api/rate-limit.ts) and for the keyless-provisioning ceiling
 * (src/api/plugins/auth.ts). The application sets `trustProxy: true`, which
 * makes it the LEFTMOST address in X-Forwarded-For — the one furthest from the
 * server, and the one a client can write itself unless the proxy replaces the
 * header instead of appending to it.
 *
 * Cloudflare appends. So the front Worker (cloudflare/src/front.ts) overwrites
 * the header with CF-Connecting-IP, and its tests assert that under workerd.
 * Those tests restate this rule in a stand-in application; this file pins the
 * rule against real Fastify, so the two cannot drift apart unnoticed. If
 * `trustProxy` ever changes, the first test here fails and says where to look.
 */
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

const ROOT = new URL('../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), 'utf8');

async function ipSeen(headers: Record<string, string>): Promise<string> {
  const app = Fastify({ trustProxy: true });
  app.get('/', async (req) => ({ ip: req.ip }));
  const res = await app.inject({ method: 'GET', url: '/', headers, remoteAddress: '10.0.0.2' });
  await app.close();
  return (res.json() as { ip: string }).ip;
}

describe('the address the application limits by', () => {
  test('the application trusts the proxy in front of it', () => {
    assert.match(read('src/api/app.ts'), /trustProxy: true/,
      'app.ts no longer sets trustProxy: true — re-read cloudflare/src/front.ts, '
      + 'which overwrites X-Forwarded-For on that assumption');
  });

  test('a single address in X-Forwarded-For is the address seen', async () => {
    assert.equal(await ipSeen({ 'x-forwarded-for': '203.0.113.9' }), '203.0.113.9');
  });

  test('with two addresses the LEFTMOST wins — which is why appending is not enough', async () => {
    // What reaches the origin when a client sends its own header and the proxy
    // appends the real address: the client's choice is believed.
    assert.equal(await ipSeen({ 'x-forwarded-for': '198.51.100.77, 203.0.113.9' }), '198.51.100.77');
  });

  test('with no header it is the socket peer: one bucket for everyone, never none', async () => {
    assert.equal(await ipSeen({}), '10.0.0.2');
  });

  test('the Worker replaces the header and does not append to it', () => {
    const front = read('cloudflare/src/front.ts');
    assert.match(front, /headers\.delete\(name\)/);
    assert.match(front, /headers\.set\('x-forwarded-for', clientIp\)/);
    assert.doesNotMatch(front, /headers\.append\('x-forwarded-for'/);
  });
});
