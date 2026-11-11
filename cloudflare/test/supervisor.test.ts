// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The supervisor: what keeps the two containers running.
 *
 * CLAUDE.md §10 calls a worker that is not long-running "the single most
 * damaging mistake available in this codebase". On Cloudflare nothing keeps a
 * container up for us, so this is the code that stands between the project and
 * that mistake — and it cannot be run for real without deploying. These tests
 * drive the real Durable Object class against a stand-in container
 * (test/harness.ts) to check its decisions. Each was turned red by the
 * mutation named above it.
 */
import { env } from 'cloudflare:workers';
import {
  createExecutionContext, createScheduledController, runDurableObjectAlarm, runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker, { type WorkerContainer } from './harness.js';

interface TestEnv { WORKER: DurableObjectNamespace<WorkerContainer>; [name: string]: unknown }
const base = env as unknown as TestEnv;

let n = 0;
/** A fresh Durable Object per test, so no test inherits another's container or alarm. */
const fresh = () => base.WORKER.get(base.WORKER.idFromName(`supervisor-test-${n += 1}`));
const inside = <R>(stub: DurableObjectStub<WorkerContainer>, fn: (o: WorkerContainer, s: DurableObjectState) => R | Promise<R>) =>
  runInDurableObject(stub, fn);
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('starting', () => {
  // Mutation: start with enableInternet: false, or drop MIGRATE_ON_BOOT from the worker's spec.
  it('starts the worker process, from the built image, with what it needs and no more', async () => {
    const stub = fresh();
    const status = await stub.supervise();
    expect(status).toMatchObject({ role: 'worker', running: true, current: true, starts: 1, problem: null });

    const [started] = await inside(stub, (o) => o.fake().started);
    expect(started!.image).toBe('registry.example/ratchet@sha256:one');
    expect(started!.entrypoint).toEqual(['/sbin/tini', '--', 'node', 'dist/worker/main.js']);
    expect(started!.instance).toBe('lite');
    // The database and customers' webhook URLs are both outbound.
    expect(started!.enableInternet).toBe(true);
    expect(started!.env).toMatchObject({
      DATABASE_URL: 'test-only-not-a-database',
      AUTH_SECRET: 'test-only-not-a-secret-0123456789abcdef',
      MIGRATE_ON_BOOT: 'false',
    });
    // Nothing that is the Worker's own business.
    expect(Object.keys(started!.env!).sort()).toEqual(['AUTH_SECRET', 'DATABASE_URL', 'MIGRATE_ON_BOOT']);
  });

  // Mutation: in startOrReplace(), call container.start() without checking `running`.
  it('does not start a second one when asked again', async () => {
    const stub = fresh();
    for (let i = 0; i < 3; i += 1) {
      expect(await stub.supervise()).toMatchObject({ running: true, starts: 1, problem: null });
    }
    expect(await inside(stub, (o) => o.fake().started.length)).toBe(1);
  });

  // Mutation: remove the setInactivityTimeout call.
  it('sets the inactivity timeout to the platform maximum every time, since it does not persist', async () => {
    const stub = fresh();
    await stub.supervise();
    await stub.supervise();
    const calls = await inside(stub, (o) => o.fake().calls);
    expect(calls.filter((c) => c === `inactivity ${6 * 60 * 60 * 1000}`).length).toBe(2);
  });
});

describe('the alarm', () => {
  // Mutation: remove the setAlarm at the top of alarm().
  it('re-arms itself for a minute from now, and starts the container', async () => {
    const stub = fresh();
    // Arm it without starting anything, as a first request would. Far enough
    // out that the real timer cannot fire it before the test does.
    await inside(stub, (_o, state) => state.storage.setAlarm(Date.now() + 3_600_000));
    const before = Date.now();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const next = await inside(stub, (_o, state) => state.storage.getAlarm());
    expect(next).toBeGreaterThanOrEqual(before + 59_000);
    expect(next).toBeLessThanOrEqual(Date.now() + 61_000);
    expect(await inside(stub, (o) => o.fake().running)).toBe(true);
  });

  // Mutation: in supervise(), remove armAlarm().
  it('is armed by supervise() when nothing has armed it — the cron backstop', async () => {
    const stub = fresh();
    expect(await inside(stub, (_o, state) => state.storage.getAlarm())).toBeNull();
    const status = await stub.supervise();
    expect(status.alarmAt).toBeGreaterThan(Date.now());
  });

  // Mutation: in alarm(), let the error from ensureRunning() escape before re-arming.
  it('still re-arms when the container cannot be started', async () => {
    const stub = fresh();
    await inside(stub, (o, state) => {
      o.fake().start = () => { throw new Error('no capacity'); };
      return state.storage.setAlarm(Date.now() + 3_600_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const next = await inside(stub, (_o, state) => state.storage.getAlarm());
    // A minute out, not the hour it was armed for: the handler re-armed it.
    expect(next).toBeGreaterThan(Date.now() + 50_000);
    expect(next).toBeLessThan(Date.now() + 61_000);
    expect(await inside(stub, (o) => o.fake().running)).toBe(false);
  });
});

describe('when the container exits', () => {
  // Mutation: remove the ensureRunning() call in the monitor() handler.
  it('one that had been up for a while is restarted at once, without waiting for the alarm', async () => {
    const stub = fresh();
    await stub.supervise();
    await inside(stub, async (o, state) => {
      await state.storage.put('startedAt', Date.now() - 10 * 60_000);
      o.fake().crash(1);
    });
    await settle();
    const status = await stub.status();
    expect(status).toMatchObject({ running: true, starts: 2 });
    expect(status.lastExit?.detail).toBe('exited with code 1');
  });

  // Mutation: set CRASH_LOOP_WINDOW_MS to 0.
  it('one that dies straight after starting is left for the alarm, so a bad config cannot spin', async () => {
    const stub = fresh();
    await stub.supervise();
    await inside(stub, (o) => o.fake().crash(1));
    await settle();
    expect(await stub.status()).toMatchObject({ running: false, starts: 1 });

    await runDurableObjectAlarm(stub);
    expect(await stub.status()).toMatchObject({ running: true, starts: 2 });
  });

  // Mutation: store the error's message in lastExit instead of the exit code.
  it('only the exit code is recorded — never the error text from inside the container', async () => {
    const stub = fresh();
    await stub.supervise();
    await inside(stub, (o) => o.fake().crash(137));
    await settle();
    const status = await stub.status();
    expect(JSON.stringify(status)).not.toContain('postgres://');
    expect(JSON.stringify(status)).not.toContain('secret@');
    expect(status.lastExit?.detail).toBe('exited with code 137');
  });
});

describe('when a deploy or a rotated secret changes what should be running', () => {
  // Mutation: remove the fingerprint comparison in startOrReplace().
  it('the old container is asked to stop with SIGTERM and the new image is started', async () => {
    const stub = fresh();
    await stub.supervise();
    await inside(stub, (o) => { o.fake().images.base = 'registry.example/ratchet@sha256:two'; });
    expect(await stub.status()).toMatchObject({ running: true, current: false });

    const status = await stub.supervise();
    expect(status).toMatchObject({ running: true, current: true, starts: 2 });
    const fake = await inside(stub, (o) => ({ calls: o.fake().calls, images: o.fake().started.map((s) => s.image) }));
    expect(fake.images).toEqual(['registry.example/ratchet@sha256:one', 'registry.example/ratchet@sha256:two']);
    // Asked politely first, so the worker stops its loops and flushes.
    const stop = fake.calls.indexOf('signal 15');
    expect(stop).toBeGreaterThan(-1);
    expect(fake.calls.indexOf('destroy')).toBe(-1);
    expect(fake.calls.lastIndexOf('start')).toBeGreaterThan(stop);
  });

  // Mutation: remove the destroy() fallback in stop().
  it('a container that ignores SIGTERM is destroyed after the grace period, then replaced', async () => {
    const stub = fresh();
    await stub.supervise();
    await inside(stub, (o) => {
      o.fake().ignoresSigterm = true;
      o.fake().images.base = 'registry.example/ratchet@sha256:two';
    });
    const status = await stub.supervise();
    expect(status).toMatchObject({ running: true, current: true, starts: 2 });
    const calls = await inside(stub, (o) => o.fake().calls);
    expect(calls.indexOf('destroy')).toBeGreaterThan(calls.indexOf('signal 15'));
  });

  // Mutation: restart on every supervise() regardless of the fingerprint.
  it('nothing is replaced when nothing changed', async () => {
    const stub = fresh();
    await stub.supervise();
    await stub.supervise();
    expect(await inside(stub, (o) => o.fake().calls.filter((c) => c.startsWith('signal')))).toEqual([]);
  });
});

describe('the cron backstop', () => {
  // Mutation: make scheduled() a no-op.
  it('every tick supervises the worker, which no request ever reaches', async () => {
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: '* * * * *', scheduledTime: Date.now() }), base as never, ctx);
    await waitOnExecutionContext(ctx);
    const primary = base.WORKER.get(base.WORKER.idFromName('primary'));
    expect(await primary.status()).toMatchObject({ role: 'worker', running: true, starts: 1 });
  });
});
