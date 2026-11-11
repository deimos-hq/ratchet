// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The Worker under test, with something standing where the container would be.
 *
 * Everything from the public `fetch` handler down to the moment a request is
 * handed to the application is the real code: src/index.ts, src/front.ts and
 * the `fetch` of the real Durable Object class. Only `reach()` is replaced —
 * the method that returns "something that can take a request to the
 * application" — because no container exists under the test runner.
 *
 * Three modes:
 *
 *   app      a stand-in application that reports exactly what it received
 *   broken   an application that takes the request and then fails
 *   down     nothing is replaced: the real `reach()` runs, finds no container,
 *            and the real fail-closed path answers
 */
import { ApiContainer as RealApiContainer, WorkerContainer as RealWorkerContainer } from '../src/index.js';
import type { Upstream } from '../src/front.js';

export { default } from '../src/index.js';

export type Mode = 'app' | 'broken' | 'down';

/**
 * How Fastify decides `req.ip` with `trustProxy: true`: the leftmost address
 * in X-Forwarded-For, or the socket's peer when there is none. Restated here
 * so a test can say "the IP the application sees"; the rule itself is pinned
 * against real Fastify in test/unit/trust-proxy.test.ts at the repository root.
 */
const SOCKET_PEER = '10.0.0.2';
function ipTheApplicationSees(headers: Headers): string {
  const xff = headers.get('x-forwarded-for');
  return xff ? xff.split(',')[0]!.trim() : SOCKET_PEER;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function application(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === '/page-on-another-host') {
    // What the real application does for a page view on a non-canonical host.
    return new Response(null, { status: 301, headers: { Location: 'https://ratchetgate.com/pricing' } });
  }
  if (url.pathname === '/login') {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    headers.append('Set-Cookie', 'rk_session=abc; Path=/; HttpOnly; Secure; SameSite=Strict');
    headers.append('Set-Cookie', 'rk_csrf=def; Path=/; Secure; SameSite=Strict');
    headers.set('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'");
    headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    return new Response('{"ok":true}', { status: 200, headers });
  }
  if (url.pathname === '/echo-bytes') {
    // The bytes that arrived, sent straight back.
    return new Response(await request.arrayBuffer(), { headers: { 'Content-Type': 'application/octet-stream' } });
  }

  const body = await request.arrayBuffer();
  return Response.json({
    method: request.method,
    url: request.url,
    host: request.headers.get('host') ?? url.host,
    path: url.pathname + url.search,
    ip: ipTheApplicationSees(request.headers),
    headers: [...request.headers.entries()],
    bodyLength: body.byteLength,
    bodySha256: await sha256Hex(body),
  });
}

export class ApiContainer extends RealApiContainer {
  private mode: Mode = 'app';
  private received = 0;

  setMode(mode: Mode): void { this.mode = mode; this.received = 0; }
  requestsReceived(): number { return this.received; }

  protected override async reach(port: number): Promise<Upstream | null> {
    if (this.mode === 'down') return super.reach(port);
    return {
      fetch: async (request: Request) => {
        this.received += 1;
        if (this.mode === 'broken') {
          await request.arrayBuffer();
          throw new Error('connection reset by peer: postgres://user:secret@db.internal/ratchet');
        }
        return application(request);
      },
    };
  }
}

// ------------------------------------------------------------- supervisor
/**
 * A stand-in for `ctx.container`, for the supervisor's tests.
 *
 * It records what the supervisor asked for and lets a test decide when the
 * "container" exits. It implements only what container.ts calls. It proves the
 * supervisor makes the right decisions given the documented behaviour of the
 * platform; it cannot prove the platform behaves as documented.
 */
export interface StartOptions {
  image: string; instance?: string; entrypoint?: string[];
  env?: Record<string, string>; enableInternet: boolean; labels?: Record<string, string>;
}

export class FakeContainer {
  running = false;
  images = { base: 'registry.example/ratchet@sha256:one' };
  /** When true, SIGTERM is ignored, as a wedged process would. */
  ignoresSigterm = false;
  readonly calls: string[] = [];
  readonly started: StartOptions[] = [];
  private exit: { resolve: () => void; reject: (reason: unknown) => void } | undefined;
  private exited: Promise<void> | undefined;

  start(options: StartOptions): void {
    if (this.running) throw new Error('container is already running');
    this.running = true;
    this.started.push(options);
    this.calls.push('start');
    this.exited = new Promise<void>((resolve, reject) => { this.exit = { resolve, reject }; });
    this.exited.catch(() => {});
  }
  monitor(): Promise<void> {
    if (!this.exited) throw new Error('this Durable Object instance has no container');
    return this.exited;
  }
  signal(signo: number): void {
    this.calls.push(`signal ${signo}`);
    if (!this.ignoresSigterm) this.stopped();
  }
  async destroy(reason?: unknown): Promise<void> {
    this.calls.push('destroy');
    this.stopped(reason);
  }
  async setInactivityTimeout(ms: number): Promise<void> { this.calls.push(`inactivity ${ms}`); }
  getTcpPort(): never { throw new Error('Container is not listening'); }

  /** The process dies on its own: the worker's watchdog, an OOM, a host restart. */
  crash(exitCode: number): void {
    this.calls.push(`crash ${exitCode}`);
    this.stopped(Object.assign(
      new Error('exited: could not connect to postgres://user:secret@db.internal/ratchet'), { exitCode }));
  }
  private stopped(reason?: unknown): void {
    if (!this.running) return;
    this.running = false;
    if (reason === undefined) this.exit?.resolve(); else this.exit?.reject(reason);
  }
}

const fakes = new Map<string, FakeContainer>();

export class WorkerContainer extends RealWorkerContainer {
  fake(): FakeContainer {
    const id = this.ctx.id.toString();
    let fake = fakes.get(id);
    if (!fake) { fake = new FakeContainer(); fakes.set(id, fake); }
    return fake;
  }
  protected override box(): Container | undefined {
    return this.fake() as unknown as Container;
  }
  protected override stopGraceMs(): number { return 50; }
}
