// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The two containers, and what keeps them running.
 *
 * One image, two processes, exactly as on every platform this has run on:
 *
 *   ApiContainer     node dist/api/server.js    serves HTTP on 8787, migrates on boot
 *   WorkerContainer  node dist/worker/main.js   no inbound surface, MIGRATE_ON_BOOT=false
 *
 * Each is a Durable Object that owns one container through `ctx.container`
 * (the Durable Object Container API — the `Container` class from
 * `@cloudflare/containers` is deprecated and is not used here).
 *
 * WHY THIS FILE EXISTS AT ALL. CLAUDE.md §10: the worker must be long-running,
 * and treating it as something that can be woken by a request is "the single
 * most damaging mistake available in this codebase". Cloudflare does not
 * promise that a container stays up: a host restart can stop one at any time,
 * and a container whose Durable Object goes quiet is stopped after an
 * inactivity timeout that cannot be set above six hours. So nothing here
 * relies on the container staying up. Three independent things bring it back:
 *
 *   1. While the Durable Object is in memory it is watching `monitor()`, and
 *      restarts the container the moment it exits.
 *   2. An alarm fires every 60 seconds, whether or not anything else is
 *      happening, and starts the container if it is not running. The alarm
 *      also counts as activity, so the inactivity timeout never elapses.
 *   3. A Cron Trigger calls `supervise()` every minute from outside the
 *      Durable Object. It exists for the one failure the alarm cannot see:
 *      the alarm chain itself being lost.
 *
 * None of this makes the worker's absence unsafe — `beginEffect` expires a
 * stale lease inline, under the same row lock — it makes it short. See
 * docs/handoff/CLOUDFLARE.md for the expected gap and why it is "expected"
 * and not yet "measured".
 */
import { DurableObject } from 'cloudflare:workers';
import { containerEnv, missingRequired } from './env.js';
import type { Upstream } from './front.js';
import { unavailable } from './unavailable.js';

export const SUPERVISE_EVERY_MS = 60_000;
/** The platform's ceiling. The alarm keeps the object active, so this should never elapse. */
const INACTIVITY_TIMEOUT_MS = 6 * 60 * 60 * 1000;
/** A container that dies this soon after starting is crash-looping; let the alarm pace it. */
const CRASH_LOOP_WINDOW_MS = 30_000;
const STOP_GRACE_MS = 25_000;
const READY_BUDGET_MS = 20_000;
/** Until the response HEADERS arrive. A stream that has started is left alone. */
const ANSWER_DEADLINE_MS = 30_000;
const SIGTERM = 15;

export interface ContainerSpec {
  role: 'api' | 'worker';
  entrypoint: string[];
  instance: 'lite' | 'basic' | 'standard-1';
  /** Added to the pass-through environment, and winning over it. */
  env: Record<string, string>;
  /** The HTTP port to wait for and forward to. The worker has none. */
  port?: number;
}

export interface Status {
  role: string;
  commit: string | null;
  running: boolean;
  /** True when the running container was started with the current image and configuration. */
  current: boolean;
  startedAt: number | null;
  starts: number;
  lastExit: { at: number; detail: string } | null;
  alarmAt: number | null;
  problem: string | null;
}

export interface SupervisedEnv {
  GIT_COMMIT?: string;
  [name: string]: unknown;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export abstract class Supervised<E extends SupervisedEnv> extends DurableObject<E> {
  protected abstract spec(): ContainerSpec;

  private starting: Promise<void> | undefined;
  private watching: Promise<void> | undefined;
  private ready = false;

  /**
   * The container this object owns. Every use goes through here, so the tests
   * can put a stand-in where the platform's container would be and exercise
   * the supervisor's decisions — when to start, when to replace, when to leave
   * alone — without one. What the stand-in cannot show is that the platform
   * behaves as documented; only a deployed container can.
   */
  protected box(): Container | undefined {
    return this.ctx.container;
  }

  /** How long a container gets to stop on SIGTERM before it is destroyed. */
  protected stopGraceMs(): number {
    return STOP_GRACE_MS;
  }

  constructor(ctx: DurableObjectState, env: E) {
    super(ctx, env);
    const container = this.box();
    if (container?.running) {
      // A Durable Object that restarts (a deploy, an eviction) starts without
      // a timeout and without a monitor; neither carries over.
      void ctx.blockConcurrencyWhile(async () => {
        await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS).catch(() => {});
      });
      this.watch();
    }
  }

  // ------------------------------------------------------------- lifecycle

  private async wanted(): Promise<{ fingerprint: string; env: Record<string, string> }> {
    const spec = this.spec();
    const env = { ...containerEnv(this.env), ...spec.env };
    const image = this.box()?.images?.base ?? '';
    // What "the same container" means: same image, same command, same
    // environment. Stored in the object's own storage and nowhere else — it is
    // derived from secrets, and although a SHA-256 over a 32-byte random
    // AUTH_SECRET is not reversible, a label or a log line is still the wrong
    // place for it.
    const fingerprint = await sha256Hex(JSON.stringify([
      image, spec.entrypoint, spec.instance, Object.entries(env).sort(([a], [b]) => a.localeCompare(b)),
    ]));
    return { fingerprint, env };
  }

  private watch(): void {
    if (this.watching) return;
    const container = this.box();
    if (!container) return;
    let exit: Promise<void>;
    try {
      exit = container.monitor();
    } catch {
      // monitor() throws when this instance has no container yet. The alarm
      // will come round again; there is nothing to watch until then.
      return;
    }
    this.watching = exit
      .then(() => 'exited cleanly', (err: unknown) => {
        const code = (err as { exitCode?: number } | null)?.exitCode;
        // The exit code and nothing else: an error message from inside the
        // container could carry a connection string.
        return typeof code === 'number' ? `exited with code ${code}` : 'stopped with an error';
      })
      .then(async (detail) => {
        await this.ctx.storage.put('lastExit', { at: Date.now(), detail });
        console.log(JSON.stringify({ svc: 'supervisor', role: this.spec().role, msg: 'container stopped', detail }));
        this.watching = undefined;
        this.ready = false;
        const startedAt = (await this.ctx.storage.get<number>('startedAt')) ?? 0;
        if (Date.now() - startedAt < CRASH_LOOP_WINDOW_MS) return;
        // It had been up for a while, so this is a crash or a host restart and
        // not a boot loop: bring it straight back instead of waiting for the alarm.
        // (When the exit is our own doing — stop() during a replacement — this
        // joins the replacement already in flight; ensureRunning() is shared.)
        await this.ensureRunning().catch(() => {});
      });
    this.ctx.waitUntil(this.watching);
  }

  private async stop(): Promise<void> {
    const container = this.box();
    if (!container?.running) return;
    try {
      // SIGTERM first: both processes drain on it — the API finishes in-flight
      // requests, the worker stops its loops and flushes — and tini forwards it.
      container.signal(SIGTERM);
      const exited = container.monitor().then(() => true, () => true);
      const timedOut = scheduler.wait(this.stopGraceMs()).then(() => false);
      if (!(await Promise.race([exited, timedOut]))) await container.destroy('did not stop on SIGTERM');
    } finally {
      this.ready = false;
    }
  }

  /** Start the container if it is not running, or replace it if it is out of date. */
  private ensureRunning(): Promise<void> {
    this.starting ??= this.startOrReplace().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async startOrReplace(): Promise<void> {
    const container = this.box();
    if (!container) throw new Error('no container is bound to this Durable Object');
    const missing = missingRequired(this.env);
    if (missing.length > 0) {
      // Names only. And do not start: the application would refuse to boot,
      // exit, and be restarted every minute for ever.
      throw new Error(`required secrets are not set: ${missing.join(', ')}`);
    }

    const { fingerprint, env } = await this.wanted();
    if (container.running && (await this.ctx.storage.get<string>('fingerprint')) !== fingerprint) {
      // A deploy changed the image, or a secret was rotated. A running
      // container keeps what it was started with until somebody restarts it,
      // and under the durable_object scheduling policy that somebody is us.
      await this.stop();
    }
    if (!container.running) {
      const spec = this.spec();
      container.start({
        image: container.images.base,
        instance: spec.instance,
        entrypoint: spec.entrypoint,
        env,
        // The application needs the database, and the worker delivers webhooks
        // to customer URLs. Both are ordinary outbound connections made by
        // Node from inside the container, so the SSRF guard's DNS re-resolution
        // and socket pinning (DECISIONS D12/D13) run unchanged. Nothing is
        // intercepted or proxied on the way out.
        enableInternet: true,
        labels: { role: spec.role },
      });
      const starts = ((await this.ctx.storage.get<number>('starts')) ?? 0) + 1;
      await this.ctx.storage.put({ fingerprint, startedAt: Date.now(), starts });
      this.ready = false;
      // A new container: whatever was being watched before is the old one, so
      // watch() below must not be skipped on its account.
      this.watching = undefined;
    }
    this.watch();
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
  }

  private async armAlarm(): Promise<void> {
    const at = await this.ctx.storage.getAlarm();
    if (at === null || at < Date.now() - SUPERVISE_EVERY_MS) {
      await this.ctx.storage.setAlarm(Date.now() + SUPERVISE_EVERY_MS);
    }
  }

  override async alarm(): Promise<void> {
    // Re-arm FIRST. A failed alarm is retried only six times; an alarm that
    // re-arms before doing anything else cannot be lost to a failure below.
    await this.ctx.storage.setAlarm(Date.now() + SUPERVISE_EVERY_MS);
    await this.ensureRunning().catch((err: unknown) => this.report(err));
  }

  /** Called by the Cron Trigger, and by the ops route. Safe to call at any time. */
  async supervise(): Promise<Status> {
    let problem: string | null = null;
    await this.armAlarm();
    await this.ensureRunning().catch((err: unknown) => { problem = this.report(err); });
    return this.status(problem);
  }

  private report(err: unknown): string {
    const message = err instanceof Error ? err.message : 'unknown error';
    console.error(JSON.stringify({ svc: 'supervisor', role: this.spec().role, msg: 'could not ensure the container', err: message }));
    return message;
  }

  async status(problem: string | null = null): Promise<Status> {
    const stored = await this.ctx.storage.get<number | string | { at: number; detail: string }>(
      ['fingerprint', 'startedAt', 'starts', 'lastExit']);
    const running = this.box()?.running ?? false;
    const wanted = this.box() ? (await this.wanted()).fingerprint : null;
    return {
      role: this.spec().role,
      commit: typeof this.env.GIT_COMMIT === 'string' ? this.env.GIT_COMMIT : null,
      running,
      current: running && stored.get('fingerprint') === wanted,
      startedAt: (stored.get('startedAt') as number | undefined) ?? null,
      starts: (stored.get('starts') as number | undefined) ?? 0,
      lastExit: (stored.get('lastExit') as { at: number; detail: string } | undefined) ?? null,
      alarmAt: await this.ctx.storage.getAlarm(),
      problem,
    };
  }

  // ----------------------------------------------------------------- HTTP

  private async waitUntilListening(port: number): Promise<boolean> {
    const deadline = Date.now() + READY_BUDGET_MS;
    while (Date.now() < deadline) {
      const container = this.box();
      if (container?.running) {
        try {
          // /healthz, not /readyz: "the process is listening" is what decides
          // whether a request can be handed over. If the database is down the
          // application says so itself, in its own words, and that answer is
          // more useful to a caller than ours.
          const res = await container.getTcpPort(port)
            .fetch('http://container/healthz', { signal: AbortSignal.timeout(1000) });
          await res.body?.cancel();
          if (res.ok) return true;
        } catch { /* not listening yet */ }
      }
      await scheduler.wait(250);
    }
    return false;
  }

  /**
   * Something that can take a request to the application, or null if nothing
   * can. Starts the container if it has to. The one seam the tests replace:
   * no container exists under the test runner, so a test that wants an
   * application behind the door supplies one here, and a test that wants the
   * door with nobody behind it leaves this alone.
   */
  protected async reach(port: number): Promise<Upstream | null> {
    const container = this.box();
    if (!container) return null;
    if (!this.ready) {
      await this.armAlarm();
      await this.ensureRunning();
      if (!(await this.waitUntilListening(port))) return null;
      this.ready = true;
    }
    return container.running ? container.getTcpPort(port) : null;
  }

  override async fetch(request: Request): Promise<Response> {
    const { port } = this.spec();
    if (port === undefined) return unavailable('not_forwarded', request.method);

    // Everything up to here has left the request untouched, so every failure
    // up to here can truthfully say that no decision was made.
    let upstream: Upstream | null = null;
    try {
      upstream = await this.reach(port);
    } catch (err) {
      this.report(err);
    }
    if (!upstream) {
      this.ready = false;
      return unavailable('not_forwarded', request.method);
    }

    // From here the application may have seen the request. It is sent ONCE.
    // Retrying a `begin` on the caller's behalf is exactly the thing this
    // product exists to stop other software doing.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), ANSWER_DEADLINE_MS);
    request.signal.addEventListener('abort', () => deadline.abort(), { once: true });
    try {
      return await upstream.fetch(new Request(request, { signal: deadline.signal, redirect: 'manual' }));
    } catch {
      this.ready = false;
      return unavailable('no_answer', request.method);
    } finally {
      clearTimeout(timer);
    }
  }
}
