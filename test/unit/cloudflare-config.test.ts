// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The Cloudflare deployment's configuration, held to the things the
 * application already promises.
 *
 * cloudflare/wrangler.toml is not code and has no types, so a line removed
 * from it removes a property without anything failing. Each test here stands
 * in front of one such line. They read the files as text on purpose: this
 * suite has no TOML parser and should not grow one for a config check.
 *
 * The last block is the other half of DECISIONS D23. The claim "nothing
 * terminates TLS in front of the gate" was withdrawn on 11 Nov 2026; these
 * make sure it stays withdrawn everywhere a reader could meet it, and that the
 * pages which replaced it cannot ship with their blanks unfilled.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = new URL('../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), 'utf8');

const wrangler = read('cloudflare/wrangler.toml');
/** Comments explain, and may quote the very thing a test forbids. Settings are what count. */
const settings = wrangler.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
const count = (re: RegExp) => (settings.match(re) ?? []).length;

describe('cloudflare/wrangler.toml', () => {
  test('per-request platform logs are off, in production and in staging', () => {
    // CLAUDE.md §5.8: never log a secret. An invocation log records request
    // details on a system that has never seen the redaction list.
    assert.equal(count(/^invocation_logs = false$/gm), 2,
      'invocation_logs = false must be set under [observability.logs] AND [env.staging.observability.logs]');
    assert.equal(count(/^invocation_logs = true$/gm), 0);
  });

  test('no secret has a value in the file', () => {
    for (const name of ['DATABASE_URL', 'AUTH_SECRET', 'AUTH_SECRET_RETIRED', 'DIMENSION_SECRET',
      'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'EMAIL_API_KEY', 'METRICS_TOKEN',
      'X402_FACILITATOR_KEY', 'OPS_TOKEN']) {
      assert.doesNotMatch(settings, new RegExp(`^\\s*${name}\\s*=`, 'm'), `${name} is assigned in wrangler.toml`);
    }
    assert.doesNotMatch(settings, /postgres(ql)?:\/\//i);
    assert.doesNotMatch(settings, /\b(sk|rk|whsec)_(live|test)_/);
  });

  test('settings that are unsafe in production cannot be configured here', () => {
    for (const name of ['WEBHOOK_ALLOW_PRIVATE_NETWORK', 'RATE_LIMIT_OVERRIDE', 'ALLOW_PLAINTEXT',
      'MIGRATE_ON_BOOT', 'CORS_ORIGINS']) {
      assert.doesNotMatch(settings, new RegExp(`^\\s*${name}\\s*=`, 'm'), `${name} is set in wrangler.toml`);
    }
  });

  test('the database connection is verified TLS in both environments', () => {
    assert.equal(count(/^DB_SSL = "true"$/gm), 2);
    assert.match(read('src/db/pool.ts'), /ssl: config\.dbSsl \? \{ rejectUnauthorized: true \}/,
      'pool.ts no longer verifies the certificate when DB_SSL is on');
  });

  test('both environments are production builds, and staging says it is staging', () => {
    assert.equal(count(/^NODE_ENV = "production"$/gm), 2);
    assert.equal(count(/^RATCHET_ENV = "staging"$/gm), 1);
    // The three properties fly.staging.toml was written to keep.
    const staging = settings.slice(settings.indexOf('[env.staging]'));
    assert.match(staging, /^EMAIL_PROVIDER = "log"$/m);
    assert.match(staging, /^BILLING_PROVIDER = "test"$/m);
  });

  test('two containers per environment, on the scheduling policy that is not deprecated', () => {
    assert.equal(count(/^class_name = "ApiContainer"$/gm), 4, 'one container entry and one binding, twice');
    assert.equal(count(/^class_name = "WorkerContainer"$/gm), 4);
    assert.equal(count(/^scheduling_policy = "durable_object"$/gm), 4);
    assert.equal(count(/^scheduling_policy = "default"$/gm), 0);
  });

  test('the cron backstop runs every minute in both environments', () => {
    assert.equal(count(/^crons = \["\* \* \* \* \*"\]$/gm), 2);
  });

  test('the public hostname is attached by the deploy script, never by the file', () => {
    // So the first production deploy can be checked before the hostname moves.
    assert.doesNotMatch(settings, /custom_domain|^\s*routes?\s*=|\[\[routes\]\]/m);
    assert.match(read('scripts/deploy-cf.sh'), /--domain "\$\{DOMAINS\[0\]\}" --domain "\$\{DOMAINS\[1\]\}"/);
  });
});

describe('the two container classes', () => {
  const index = read('cloudflare/src/index.ts');

  test('the worker never migrates, and that is not configurable', () => {
    assert.match(index, /node', 'dist\/worker\/main\.js'\],[\s\S]{0,400}env: \{ MIGRATE_ON_BOOT: 'false' \}/);
    assert.match(read('cloudflare/src/env.ts'), /NEVER_PASSED = \[[\s\S]*'MIGRATE_ON_BOOT'/);
  });

  test('both run the commands the Dockerfile and fly.toml run, under tini', () => {
    assert.match(index, /\['\/sbin\/tini', '--', 'node', 'dist\/api\/server\.js'\]/);
    assert.match(index, /\['\/sbin\/tini', '--', 'node', 'dist\/worker\/main\.js'\]/);
    assert.match(read('Dockerfile'), /ENTRYPOINT \["\/sbin\/tini", "--"\]/);
  });

  test('the legacy Container class is not used', () => {
    assert.doesNotMatch(read('cloudflare/package.json'), /@cloudflare\/containers/);
    assert.match(read('cloudflare/src/container.ts'), /extends DurableObject</);
  });

  test('the image does not carry the Worker or its tooling', () => {
    assert.match(read('.dockerignore'), /^cloudflare$/m);
  });
});

describe('the withdrawn claim stays withdrawn (DECISIONS D23, reversed 11 Nov 2026)', () => {
  const pages = readdirSync(new URL('web/', ROOT)).filter((f) => f.endsWith('.html'));

  test('no page says nothing terminates TLS in front of the gate', () => {
    for (const page of pages) {
      const html = read(`web/${page}`).replace(/<!--[\s\S]*?-->/g, '');
      assert.doesNotMatch(html, /nothing terminates TLS/i, `web/${page}`);
      assert.doesNotMatch(html, /no reverse proxy, CDN or WAF in\s+the path/i, `web/${page}`);
      assert.doesNotMatch(html, /Your connection to Ratchet ends at Ratchet/i, `web/${page}`);
    }
  });

  test('the security page says who does, and the decision log records the reversal', () => {
    assert.match(read('web/security.html'), /Cloudflare terminates TLS in front of the gate/);
    assert.match(read('docs/handoff/DECISIONS.md'), /^## D23 — .*REVERSED 11 Nov 2026$/m);
  });

  test('the privacy page names Cloudflare as the host and no longer names Fly as one', () => {
    const privacy = read('web/privacy.html').replace(/<!--[\s\S]*?-->/g, '');
    assert.match(privacy, /<td>Cloudflare<\/td><td>Application hosting/);
    assert.doesNotMatch(privacy, /<td>Fly\.io<\/td><td>Application hosting/);
    assert.doesNotMatch(privacy, /region <code>sjc<\/code>/);
  });

  test('a page with an unfilled blank cannot reach production', () => {
    // The staged pages carry CUTOVER-TODO markers where a fact is not decided
    // yet (the database provider, the dates). The deploy gate is what stops
    // them shipping; this checks the gate is still there and still looks in web/.
    const deploy = read('scripts/deploy-cf.sh');
    assert.match(deploy,
      /\nif grep -rl 'CUTOVER-TODO' web >\/dev\/null 2>&1; then\n  refuse "pages still carry CUTOVER-TODO markers"/,
      'the production deploy no longer refuses while a page carries a CUTOVER-TODO marker');
    // And it comes before the deploy, not after it.
    assert.ok(deploy.indexOf("if grep -rl 'CUTOVER-TODO' web") < deploy.indexOf('step "Deploying $SHORT to production"'));
    const marked = pages.filter((p) => read(`web/${p}`).includes('CUTOVER-TODO'));
    for (const page of marked) {
      assert.match(read(`web/${page}`), /STAGED FOR THE CLOUDFLARE CUTOVER/,
        `web/${page} has a CUTOVER-TODO but does not say it is staged`);
    }
  });
});
