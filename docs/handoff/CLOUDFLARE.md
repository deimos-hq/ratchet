# Ratchet on Cloudflare — what was built, what was checked, what is not known

*Written 11 November 2026, on branch `infra/cloudflare-containers`. Nothing in
this document has been deployed. No Cloudflare resource, database, bucket, DNS
record or secret was created to write it.*

Owner decision, 11 Nov 2026: move the hosted service off Fly.io onto the
company's Cloudflare account. This is option A of the plan: the existing Docker
image, unchanged, in Cloudflare Containers, behind a small Worker, with an
external managed Postgres. The application code under `src/` is not touched.

The runbook for the move itself is [`CUTOVER_CLOUDFLARE.md`](CUTOVER_CLOUDFLARE.md).

---

## 1. The shape

```
client ──TLS──▶ Cloudflare edge ──▶ front Worker ──▶ ApiContainer (Durable Object)
                                        │                 └─▶ container: node dist/api/server.js  :8787
                                        │ cron, 1/min
                                        └──────────────▶ WorkerContainer (Durable Object)
                                                          └─▶ container: node dist/worker/main.js
                                    both containers ──TLS, verified──▶ managed Postgres 18
```

| piece | file | what it is |
|---|---|---|
| front Worker | `cloudflare/src/front.ts`, `index.ts` | a pass-through; see §2 |
| supervisors | `cloudflare/src/container.ts` | two Durable Objects, one container each; see §4 |
| what reaches a container | `cloudflare/src/env.ts` | an explicit list of names; no values anywhere |
| fail-closed answer | `cloudflare/src/unavailable.ts` | `503` in the API's own error shape |
| configuration | `cloudflare/wrangler.toml` | production at the top level, `[env.staging]` below |
| deploy gates | `scripts/deploy-cf.sh`, `scripts/cf-status.mjs` | the same four gates as `scripts/deploy.sh` |
| backups | `scripts/backup-verify-r2.sh`, `.github/workflows/backup-cf.yml` | direct `pg_dump`, R2; manual-only until cutover |
| parity | `scripts/parity.mjs` | one scenario, two base URLs, a diff |

`cloudflare/` is its own package with its own lockfile. The Worker's tooling
(Wrangler, Vitest) is not a dependency of the application and is excluded from
the image by `.dockerignore`.

---

## 2. The front Worker does four things and nothing else

1. **Says who the caller is.** The application runs Fastify with
   `trustProxy: true`, so `req.ip` is the *leftmost* address in
   `X-Forwarded-For` — and `req.ip` is the bucket for the unauthenticated rate
   limit and the keyless-provisioning ceiling. Cloudflare *appends* to a
   client-supplied `X-Forwarded-For`. Passed through, that would let a caller
   choose a fresh bucket per request and neither limit would ever refuse. The
   Worker deletes every client-supplied proxy header and sets
   `X-Forwarded-For` to `CF-Connecting-IP` alone. If `CF-Connecting-IP` is
   absent the header is removed, so everyone shares one bucket: too strict, not
   too loose.
2. **Refuses plaintext; never redirects it** unless it is a page view. `GET`
   and `HEAD` over http get a `301` to https. Anything else gets
   `400 request_error`. A `301` on a `POST` is replayed as a `GET` by many
   clients, which would turn a `begin` into a page fetch.
3. **Hands the request over untouched.** Same method, path, query and `Host`;
   the body is the original stream, never read or re-encoded (the Stripe
   signature is over the raw bytes); `redirect: 'manual'`, so the application's
   own redirects reach the client. The response is returned as the application
   sent it.
4. **Fails closed.** If the container cannot be reached the answer is `503`
   with `{"error":{"code":"service_unavailable","message":…}}`, `Retry-After`,
   `Cache-Control: no-store`. Never `200`, never a redirect.

   There are two messages, because they are two facts. If the request was
   never forwarded: *no decision was made*. If it was forwarded and no response
   came back: *no decision was returned, one may or may not have been recorded,
   retry with the same idempotency key*. The second case is never retried by
   the Worker — it is sent once.

There is one route the application does not serve: `GET /__ops/status`,
answered only to a bearer token of 32+ characters (`OPS_TOKEN`), compared in
constant time. It reports the running commit and both containers' state, and
replaces `flyctl ssh … printenv GIT_COMMIT` in the deploy gate. Without the
right token — or with `OPS_TOKEN` unset — the request falls through to the
application like any unknown path. **This is new attack surface in front of the
gate and wants a reviewer's eye.**

---

## 3. What was checked against the project contract (CLAUDE.md)

| contract | on Cloudflare | status |
|---|---|---|
| at-most-once is the database unique index | unchanged; Postgres, same schema | holds |
| the worker must be long-running (§10) | a long-running container, restarted by a supervisor | holds, with a gap — §4 |
| Postgres, not SQLite (D4) | external managed Postgres; Hyperdrive is not used (a container cannot use a Worker binding) | holds |
| SSRF: re-resolve DNS and pin the socket (D12, D13) | outbound connections are made by Node inside the container with `enableInternet: true`; nothing is intercepted or proxied on the way out | expected to hold; **not yet observed on Cloudflare** — §6 |
| never log a secret (§5.8) | container stdout is the application's logger; Workers invocation logs are **off** (`invocation_logs = false`), because they record request details on a system that does not have the redaction list | holds only while that setting stays |
| verify payment webhooks over the raw body (§5.10) | body is streamed, not re-encoded; tested incl. 64 KB of non-UTF-8 bytes | holds |
| internal detail never crosses the error boundary (§5.9) | the Worker's `503` carries no error text; tested with a connection string in the thrown error | holds |
| migrations on boot; the worker does not race them | `MIGRATE_ON_BOOT=false` is hard-coded for the worker class, not configurable | holds |
| `assertProductionSafety()` | unchanged; `WEBHOOK_ALLOW_PRIVATE_NETWORK` and `RATE_LIMIT_OVERRIDE` cannot be passed to a container even if set on the Worker | holds |
| "Nothing terminates TLS in front of the gate" (D23) | **false on Cloudflare.** D23 is reversed and the pages are rewritten in this branch | changed, by the owner's decision |
| "All application data is stored in the United States" | the database can be; **where the containers run cannot be pinned** — §5 | wording changed on the privacy page |
| three-node database, automatic failover (§10, KNOWN_LIMITATIONS §4) | describes Fly only | staged as history |
| the container runs as an unprivileged user (`USER app` in the Dockerfile) | Cloudflare's local-development page says that in a deployed `durable_object` container "every process has the same Linux capabilities as `root`, regardless of user" | **weaker than on Fly** — §5 |

Nothing in the product's safety properties had to be weakened, and no test was
changed to make anything fit. Three things are weaker *around* the product and
are listed plainly in §5.

---

## 4. Keeping the worker running

Cloudflare does not promise a container stays up. A host restart can stop one
at any time, and a container whose Durable Object goes quiet is stopped after
an inactivity timeout that cannot be set above six hours. So the supervisor
assumes the container will stop and has three independent ways to bring it
back:

| mechanism | when it acts | covers |
|---|---|---|
| `monitor()` watcher | the moment the container exits, **if** the Durable Object is in memory | a crash, the worker's own watchdog exit, a host restart |
| Durable Object alarm, every 60 s | whether or not anything else is happening; re-arms itself *before* doing anything else | everything the watcher missed; also counts as activity, so the six-hour timeout never elapses |
| Cron Trigger, every minute | from outside the Durable Object | the alarm chain itself being lost; first start after a deploy |

A container that dies within 30 s of starting is treated as crash-looping and
left to the alarm, so a bad configuration restarts once a minute and not in a
tight loop. A container is never started without `DATABASE_URL` and
`AUTH_SECRET`.

**The gap, honestly.** None of the following has been measured, because no
container has been deployed. These are what the mechanisms imply:

- Watcher alive: restart begins at once; the gap is one cold start (Cloudflare
  says "often in the 1-3 second range", depending on the image) plus the
  process's own boot.
- Watcher not alive: up to ~60 s for the alarm, plus the cold start.
- Alarm chain lost: up to ~60–120 s for the cron, plus the cold start. A newly
  deployed Cron Trigger can take up to 15 minutes to start firing.

What a gap costs, by process:

- **worker down:** expired leases are not swept and webhooks are not
  delivered. `beginEffect` still expires a stale lease inline under the same
  row lock, so no decision is wrong; `indeterminate` and its webhook arrive
  late. `/workerz` reports stale heartbeats — that check is the one to alert on.
- **API down:** every request gets the fail-closed `503`. No decision is made.

The worker's own watchdog is unchanged: it still exits on a wedged loop. On
Cloudflare the supervisor is what turns that exit into a restart.

**Deploys restart both containers.** Under the `durable_object` scheduling
policy a running container keeps the image it started with until its Durable
Object replaces it; there are no platform rollouts. The supervisor compares a
fingerprint of (image, command, environment) and, when it differs, sends
`SIGTERM`, waits up to 25 s, and starts the new one. For the API that is a
window of `503`s on every deploy — seconds, unmeasured. Running two API
instances and replacing them one at a time would remove it and is not built.

**To measure before trusting any of this:** the restart drill in
`CUTOVER_CLOUDFLARE.md` §5.

---

## 5. What is weaker, or cannot be made to hold

Listed because the instruction was: if something cannot hold on Containers,
stop and list it. None of these blocked the build; each needs a decision or an
acknowledgement.

1. **Both available scheduling policies have a caveat.** Cloudflare's docs mark
   the `default` policy **deprecated** and the `durable_object` policy **public
   beta**. This build uses `durable_object`, the one that is not being retired.
   A production gate on a beta feature is a risk the owner should accept
   knowingly.
2. **Placement cannot be constrained.** Wrangler rejects placement constraints
   (`constraints.regions`, `jurisdiction`) for the `durable_object` policy, and
   Cloudflare states that a container may start in a different location from
   its Durable Object. The code passes a `locationHint` of `wnam`; it is a hint.
   Consequences: (a) the privacy page can promise where data is *stored*, not
   where it is *processed*; (b) the distance between the API container and the
   database is not under our control, and that distance is the gate's latency.
3. **`USER app` does not confine the process the way it does in Docker.** See
   the table in §3. Ratchet runs no untrusted code and shells out to nothing,
   so this removes a layer of defence in depth and not a control the product
   relies on — but it is a real difference from Fly and from local Docker.
4. **There is no 15-second health check.** Fly restarted an unhealthy machine
   on a failed `/readyz` every 15 s. Here a process that is alive but not
   serving is caught by the worker's watchdog (for the worker) and by nothing
   automatic for the API beyond failing closed. The external uptime probe is
   what notices.
5. **One API instance.** Fly ran one too, but could add machines with a flag.
   Here it means a fixed Durable Object name; adding instances is a code change.
6. **Latency claims are void until re-measured.** Every figure on
   `web/benchmark.html` was taken on Fly in `sjc`. There is now a Worker, a
   Durable Object and a container hop in front of the same code, at a location
   we do not choose.
7. **Cloudflare's edge can answer before the Worker does.** A managed WAF rule
   that dislikes a payload returns Cloudflare's own `403` page, not Ratchet's
   error shape. It fails closed, but an agent branching on `error.code` gets
   HTML. Zone settings that must be off are in `CUTOVER_CLOUDFLARE.md` §3.

---

## 6. Tests

**Worker tests** — `cd cloudflare && npm test`, two files, run inside workerd
with `@cloudflare/vitest-plugin` (the package Cloudflare's testing guide names;
`@cloudflare/vitest-pool-workers` is deprecated in its favour). No Docker and no
Cloudflare credentials are needed, and CI runs them (`edge` job).

- `cloudflare/test/front.test.ts` — the door. The real Worker and the real
  Durable Object `fetch` run; only `reach()` — "something that can take a
  request to the application" — is replaced, because no container exists under
  the test runner. The fail-closed tests replace nothing: the real code finds no
  container and answers.
- `cloudflare/test/supervisor.test.ts` — the supervisor's decisions, driven
  against a stand-in for `ctx.container` that records what it was asked and
  exits when the test says so. It shows the supervisor does the right thing
  *given the platform's documented behaviour*. It cannot show the platform
  behaves as documented.

Every assertion was turned red on purpose before it was trusted. One mutation
at a time, then the suite:

| mutation | red |
|---|---|
| `X-Forwarded-For` appended to, not replaced (what Cloudflare itself does) | 3 |
| plaintext: redirect every method | 4 |
| body re-encoded as text | 1 (the 64 KB non-UTF-8 body) |
| fail-closed answer returns `200` | 8 |
| no container → plain `ok` | 6 |
| failed forward retried once | 1 |
| failed forward claims "no decision was made" | 1 |
| response rebuilt (two `Set-Cookie` folded into one) | 1 |
| ops route without the token comparison | 1 |
| ops token of any length accepted | 1 |
| a test-only switch added to the pass-through list | 1 |
| `Host` replaced, as Cloudflare's sample code does | 1 |
| forwarded with `redirect: 'follow'` | 1 |
| exception text returned to the caller | 1 |
| plaintext allowed everywhere | 5 |
| container started without outbound access | 1 |
| `start()` without checking it is not already running | 2 |
| inactivity timeout never set | 1 |
| alarm does not re-arm | 2 |
| `supervise()` does not arm the alarm | 2 |
| alarm re-arms only after a successful start | 1 |
| an exit is recorded but nothing restarts it | 1 |
| no crash-loop window | 1 |
| the container's error text is stored | 2 |
| a changed image is never rolled out | 2 |
| no `destroy()` when `SIGTERM` is ignored | 1 |
| the container is replaced on every check | 2 |
| destroyed straight away, no `SIGTERM` | 1 |
| the cron handler does nothing | 1 |

Running that table was worth more than the green run before it. It found:

- **A test that could not fail.** "Exception text returned to the caller"
  passed, because nothing exercised the Worker's own `catch`. A test was added.
- **A flaky test.** The alarm test armed the alarm one millisecond out and
  raced the real timer; it failed in about half the mutation runs for reasons
  unrelated to the mutation. It now arms an hour out.
- **Code no test could reach.** A "generation" guard and a "stopping" flag in
  the exit watcher survived their own removal: the shared start promise and
  the crash-loop window already cover the cases they were written for. Both
  were deleted, with the test that pretended to cover them.
- **A config check that matched the wrong line.** Removing the `CUTOVER-TODO`
  deploy gate left the check green, because the pattern also matched the error
  message. Tightened.

**Application suite.** `npm run test:unit` passes in full, with two new files,
each mutated the same way (ten mutations, ten red):
`test/unit/trust-proxy.test.ts` pins the leftmost-`X-Forwarded-For` rule
against real Fastify, so the Worker tests' stand-in cannot drift from it;
`test/unit/cloudflare-config.test.ts` checks `wrangler.toml`, the two container
commands, the withdrawn claim, and the deploy gate.

**Not run locally:** integration and e2e. They need Docker for Postgres and
Docker is not running on the machine this was written on. CI runs them.

**Not tested anywhere, because it needs a deployed container:**

- that `getTcpPort().fetch()` sends the `Host` of the URL it is given (the
  application's canonical-host redirect depends on it);
- that `start()` with an `entrypoint` of `['/sbin/tini','--','node',…]`
  replaces the image's `ENTRYPOINT` + `CMD` as intended;
- that the platform does what the stand-in container does: `monitor()`
  settling on exit, `running` going false, the alarm firing on time, the
  inactivity timeout not elapsing while the alarm keeps the object active;
- outbound TLS to Postgres and SSRF socket pinning from inside a Cloudflare
  container;
- `scripts/backup-verify-r2.sh` end to end (its control flow and quoting were
  exercised against a stub `docker`; no database or bucket exists to run it
  against);
- `scripts/deploy-cf.sh` past its first refusal.

`scripts/parity.mjs` was run against local stand-in servers with planted
differences (a changed header, a changed page, a spoofable rate-limit bucket,
a double `execute`, a different receipt key) and reported each one, exiting
non-zero; it has not been run against a real deployment.

---

## 7. Cloudflare facts this build relies on, and where each was read

All read on 11 Nov 2026 from developers.cloudflare.com.

| fact | source |
|---|---|
| The current API is the Durable Object Container API (`ctx.container`): `start`, `monitor`, `signal`, `destroy`, `getTcpPort`, `setInactivityTimeout`, `images` | /containers/api/durable-object-container/ |
| "The `@cloudflare/containers` package is deprecated." (The page gives no end date; the 31 Dec 2026 date in the plan was **not** found in the pages read.) | /containers/guides/migrate-to-durable-object-container-api/ |
| The `default` scheduling policy is deprecated; `durable_object` is in public beta; the policy is immutable once created | /containers/configuration/scheduling-policy/ |
| `durable_object` entries accept only `images`, `class_name`/`name`, `observability`; Wrangler rejects `image`, `instance_type`, `max_instances`, rollout settings and placement constraints. Images take `dockerfile`, `build_context`, `build_vars` | /workers/wrangler/configuration/#containers |
| `start()` returns before the container is ready; `enableInternet` is required and has no default; `env` and `entrypoint` are start options | /containers/api/durable-object-container/#start |
| The inactivity timeout is at most 6 hours, is per Durable Object instance, and does not survive a Durable Object restart | …#setinactivitytimeout |
| `monitor()` does not carry over a Durable Object restart; a pending one holds the object in memory for up to 15 minutes | …#monitor |
| "Cloudflare does not guarantee that any container instance will run for a set period"; host restarts happen; stop is `SIGTERM`, up to 15 minutes, then `SIGKILL` | /containers/faq/ |
| Disk is ephemeral; an OOM restarts the instance; cold starts "often in the 1-3 second range" | /containers/faq/ |
| A container may start in a different location from its Durable Object | /containers/concepts/architecture/ |
| With `enableInternet: true`, connections other than intercepted HTTP(S) "reach the Internet directly, including connections on other ports" | /containers/configuration/outbound-traffic/ |
| Secrets reach a container through `env` in `start()`, read from Worker secrets in the Durable Object | /containers/examples/env-vars-and-secrets/ |
| Rollouts apply only to the `default` policy; `durable_object` instances are replaced by application code | /containers/configuration/rollouts/ |
| Instance types: `lite` 1/16 vCPU, 256 MiB, 2 GB; `basic` 1/4 vCPU, 1 GiB, 4 GB | /containers/platform/limits/ |
| Pricing on Workers Paid: 25 GiB-hours memory, 375 vCPU-minutes, 200 GB-hours disk included; then $0.0000025/GiB-s, $0.000020/vCPU-s, $0.00000007/GB-s; memory and disk billed as provisioned, CPU as used | /containers/platform/pricing/ |
| In a deployed `durable_object` container every process has root's capabilities regardless of user; the hostname is 64 characters | /containers/guides/local-dev/ |
| `wrangler deploy` needs Docker running to build the image, "even in dry-run mode" — observed from Wrangler 4.160.1, and `--containers-rollout none` skips it | Wrangler output; /containers/get-started/ |
| Alarms: at-least-once, retried up to 6 times with backoff; one alarm per object | /durable-objects/api/alarms/ |
| Cron Triggers run on UTC; a change can take up to 15 minutes to propagate | /workers/configuration/cron-triggers/ |
| Cloudflare appends the connecting address to an existing `X-Forwarded-For`; `CF-Connecting-IP` holds one address | /fundamentals/reference/http-headers/ |
| Workers invocation logs contain "details such as the Request, Response, and related metadata" and are disabled with `invocation_logs = false`; logs are kept 7 days | /workers/observability/logs/workers-logs/ |
| Container logs move to Cloudflare Observability pricing on 1 Dec 2026 | /containers/faq/ |
| R2's S3 API uses region `auto` and the endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` | /r2/api/s3/api/, /r2/get-started/s3/ |
| Tests: `@cloudflare/vitest-plugin` with Vitest 4.1+; `@cloudflare/vitest-pool-workers` is deprecated on npm | /workers/testing/vitest-integration/write-your-first-test/ |

**Cost, estimated from the pricing page, not quoted from a bill.** `basic`
(1 GiB) and `lite` (0.25 GiB) running all month are 912 GiB-hours of memory and
4,380 GB-hours of disk. After the included amounts that is about $8.00 for
memory and $1.05 for disk. CPU is billed on use and both processes are mostly
idle; a few percent of a core is on the order of a dollar or two. So roughly
**$10–12 a month for the containers**, on top of the $5 Workers Paid plan the
account already has, plus Durable Object duration (possibly a few dollars — the
objects stay in memory while they watch a container; not confirmed), plus logs
from 1 Dec, plus the database.

---

## 8. Still unknown

- The Postgres provider, its price, its region, and whether it is single-node
  or HA. Requirements are in `CUTOVER_CLOUDFLARE.md` §1.
- Where Cloudflare will actually place the two containers, and the resulting
  latency to the database.
- The real restart gap (§4), and how long a deploy's `503` window is.
- Whether the Dockerfile's `HEALTHCHECK` is used by Cloudflare at all. Nothing
  here depends on it.
- How `wrangler rollback` interacts with container images under the
  `durable_object` policy. The runbook is roll-forward only for other reasons,
  and does not rely on it.
- Whether attaching `ratchetgate.com` to the new Worker can be done without a
  moment where the hostname is attached to nothing. The maintenance Worker
  holds it today, and its configuration names a different account id from the
  one this build targets.
- What `wrangler secret put` does with a trailing newline on stdin. The `kid`
  check in the runbook is what proves `AUTH_SECRET` arrived intact; nothing
  else should be trusted to.
- Whether Cloudflare's free managed WAF ruleset ever blocks a legitimate
  `begin` payload.
- Real row counts in production, and whether any real top-up exists.
