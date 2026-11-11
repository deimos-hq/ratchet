// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Ratchet on Cloudflare.
 *
 *   client ──TLS──▶ Cloudflare edge ──▶ this Worker ──▶ ApiContainer ──▶ node dist/api/server.js
 *                                                       WorkerContainer ─▶ node dist/worker/main.js
 *                                              both ──TLS──▶ managed Postgres
 *
 * The Worker is a door, the two Durable Objects are supervisors, and all of
 * the product is still the Node application in the image. See front.ts for
 * what the door does and container.ts for what the supervisors do.
 */
import { handle } from './front.js';
import { Supervised, type ContainerSpec, type Status } from './container.js';
import { unavailable } from './unavailable.js';

export interface Env {
  API: DurableObjectNamespace<ApiContainer>;
  WORKER: DurableObjectNamespace<WorkerContainer>;
  /** "true" only under `wrangler dev` and the test runner. Never set in wrangler.toml. */
  ALLOW_PLAINTEXT?: string;
  /** Guards /__ops/status. Unset means the route does not exist. */
  OPS_TOKEN?: string;
  GIT_COMMIT?: string;
  [name: string]: unknown;
}

export class ApiContainer extends Supervised<Env> {
  protected spec(): ContainerSpec {
    return {
      role: 'api',
      entrypoint: ['/sbin/tini', '--', 'node', 'dist/api/server.js'],
      // 1/4 vCPU, 1 GiB. Fly gave this process a shared CPU and 512 MB; the
      // next size down here is 256 MiB, which is below what it has been run in.
      instance: 'basic',
      env: {},
      port: 8787,
    };
  }
}

export class WorkerContainer extends Supervised<Env> {
  protected spec(): ContainerSpec {
    return {
      role: 'worker',
      entrypoint: ['/sbin/tini', '--', 'node', 'dist/worker/main.js'],
      // 1/16 vCPU, 256 MiB: the memory it had on Fly.
      instance: 'lite',
      // The API migrates on boot; the worker must not race it. Set here and
      // not in configuration, so it cannot be switched off by accident.
      env: { MIGRATE_ON_BOOT: 'false' },
    };
  }
}

/**
 * One of each, addressed by a fixed name.
 *
 * The location hint asks for western North America, next to the database. It
 * is a hint: Cloudflare does not guarantee where a Durable Object runs, says
 * outright that a container may start somewhere other than its Durable Object,
 * and the durable_object scheduling policy rejects placement constraints. Where
 * the containers actually run has to be measured after deploying, not assumed.
 */
const SINGLETON = 'primary';
const LOCATION_HINT: DurableObjectLocationHint = 'wnam';

function api(env: Env) {
  return env.API.get(env.API.idFromName(SINGLETON), { locationHint: LOCATION_HINT });
}
function worker(env: Env) {
  return env.WORKER.get(env.WORKER.idFromName(SINGLETON), { locationHint: LOCATION_HINT });
}

async function sameSecret(given: string, expected: string): Promise<boolean> {
  // Compare digests, so the comparison takes the same time whatever the
  // lengths are and wherever the first difference is.
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/**
 * GET /__ops/status — which commit is running, and whether both containers are up.
 *
 * The deployed commit is deliberately not public (see the Dockerfile): the
 * repository is open, so publishing it tells anyone which fixes an instance is
 * missing. On Fly the deploy gate read it over an authenticated SSH session.
 * There is no equivalent here, so this is the authenticated path: a bearer
 * token, at least 32 characters, compared in constant time. Without the token
 * — or with OPS_TOKEN unset — the request is not answered here at all and
 * falls through to the application like any other unknown path, so the route's
 * existence is not observable from outside.
 */
async function opsStatus(request: Request, env: Env): Promise<Response | null> {
  const token = env.OPS_TOKEN;
  if (typeof token !== 'string' || token.length < 32) return null;
  if (request.method !== 'GET' || new URL(request.url).pathname !== '/__ops/status') return null;
  const given = request.headers.get('authorization') ?? '';
  if (!given.startsWith('Bearer ') || !(await sameSecret(given.slice(7), token))) return null;

  const report = async (stub: { status(): Promise<unknown> }): Promise<unknown> => {
    try { return await stub.status(); } catch { return { problem: 'unreachable' }; }
  };
  const [apiStatus, workerStatus] = await Promise.all([report(api(env)), report(worker(env))]);
  return Response.json(
    { commit: env.GIT_COMMIT ?? null, api: apiStatus, worker: workerStatus },
    { headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
}

export type { Status };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const ops = await opsStatus(request, env);
      if (ops) return ops;
      return await handle(request, api(env), { allowPlaintext: env.ALLOW_PLAINTEXT === 'true' });
    } catch {
      // The last line of defence. An exception escaping a Worker becomes
      // Cloudflare's own error page, which is HTML. A gate answers in its own
      // voice, and closed.
      return unavailable('no_answer', request.method);
    }
  },

  /**
   * Every minute, from outside the Durable Objects.
   *
   * Each object already re-arms its own 60-second alarm. This is the backstop
   * for the alarm chain being lost — an object that was created but never
   * called, a storage reset, six consecutive failed retries — and it is also
   * what starts both containers for the first time after a deploy, without
   * waiting for a request. The worker never receives a request at all.
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(Promise.allSettled([api(env).supervise(), worker(env).supervise()]));
  },
} satisfies ExportedHandler<Env>;
