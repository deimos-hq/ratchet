# Cutover runbook — Fly to Cloudflare

*Written 11 November 2026 from the migration plan. Not executed. Every command
here is for the owner to run; nothing in this branch creates a resource,
touches DNS, or sets a secret.*

Architecture and the list of what is untested: [`CLOUDFLARE.md`](CLOUDFLARE.md).

**State on 11 Nov 2026.** The hosted service is deliberately offline.
`ratchetgate.com` and `www` answer `503` from a small Worker,
`ratchet-maintenance`. Fly's public IPs for the app are released and the app
machine is stopped. **The Fly worker machine and the Fly Postgres are still
running.** A verified copy of `AUTH_SECRET` and a database dump taken at 19:15Z
exist off Fly; this runbook never asks for either to be printed.

---

## The one way this can break at-most-once

**Two live databases.** If the old application ever serves a request against
the old database after the new one has accepted a write, the same
`(workspace, effect_type, idempotency_key)` can be granted `execute` in both.
The unique index that makes at-most-once true is per database. Nothing in the
code can detect it and nothing can undo it.

Three rules follow, and every step below is arranged around them:

1. **Freeze before the final dump.** Every writer on Fly is stopped *before*
   the dump that will be restored — and the worker is a writer.
2. **The old database is never served again** once the new API has booted
   against the new one. The API writes on boot (it registers the receipt key),
   so "has accepted a write" means "has started once".
3. **Roll forward only.** There is no rollback to Fly after step 4.3. If the
   new deployment is wrong, it stays behind the `503` until it is fixed.

---

## 0. Owner decisions that must be made first

| # | decision | why it blocks |
|---|---|---|
| 1 | **Postgres provider, and its cost** | requirements in §1; nothing can be restored anywhere until this is chosen |
| 2 | **Single node or HA** | decides what KNOWN_LIMITATIONS §4 and the site may say; if HA, the failover must be drilled before it is claimed |
| 3 | **Cutover window** | the service is already down, so the cost is not downtime but the moment the old database becomes history; also whether key holders are told |
| 4 | **Stripe live or test at cutover** | `BILLING_PROVIDER` and which `STRIPE_*` secrets are set. Test mode for a week means no real top-up can happen while the new stack is unproven; live means the webhook endpoint resumes receiving Stripe's retries at once |
| 5 | Accept the beta `durable_object` scheduling policy for production | `CLOUDFLARE.md` §5.1 |
| 6 | Accept that container placement cannot be pinned | `CLOUDFLARE.md` §5.2; decides the privacy page's wording |
| 7 | Which Cloudflare account the `ratchetgate.com` zone ends up in | the Worker and the zone must be in the same account. `cloudflare/wrangler.toml` targets `9e323bb9ed90873eb75acb39171cf6dc`; the maintenance Worker's configuration names a different account. If the zone has to move, do it first, as for the other company sites — DNS records, MX, SPF, DKIM and the Resend records all have to come across |
| 8 | What happens to the Fly Postgres and the Tigris backups afterwards, and when | the privacy page has two rows waiting for those dates |

---

## 1. The database (not created by this branch)

Requirements, each for a reason:

- **Postgres 18.** The dump is from 18; a dump cannot be restored into an
  older major. `backup-verify.sh` learned this the hard way.
- **A US region, ideally the west.** The privacy page says stored in the
  United States, and the gate's latency is the round trip from wherever
  Cloudflare puts the API container to this database.
- **A certificate from a public CA, on a hostname.** The application connects
  with `DB_SSL=true`, which is `rejectUnauthorized: true` against Node's public
  roots. A provider that needs its own CA file does not fit without a code
  change. Do not "fix" a certificate error with `sslmode=no-verify`.
- **Point-in-time recovery.** The nightly logical dump is the second backup,
  not the first.
- **A direct endpoint as well as any pooler.** `pg_dump` needs a session; a
  transaction-mode pooler breaks it. The application itself is pooler-safe
  (`src/db/pool.ts`), so it may use either; migrations take an advisory
  *transaction* lock, which also works through a pooler.
- **Reachable from the public internet over TLS.** A Cloudflare container has
  no private network to the provider, and Hyperdrive is a Worker binding a
  container cannot use.
- **Three roles:** an owner for the restore and migrations; the application
  role in `DATABASE_URL`; and a **read-only backup role** (`pg_read_all_data`
  and nothing else) for `BACKUP_DATABASE_URL`. `backup-verify-r2.sh` refuses to
  run if the backup role can write.
- **Staging gets its own database**, with a role that has no rights on
  production's — the property `fly.staging.toml` describes.

Nice to have: visible replica lag (KNOWN_LIMITATIONS §4, the frozen-standby
incident), and `pg_stat_replication` readable if HA is chosen.

---

## 2. Before the day — none of this touches production data

1. **Restore-test the 19:15Z dump.** It has a `PGDMP` header and has never been
   restored. On a machine with Docker:
   `docker run -d --name rt -e POSTGRES_PASSWORD=test -p 127.0.0.1:5456:5432 postgres:18-alpine`,
   `pg_restore --no-owner --no-privileges` into it, and count the six tables in
   `BACKUP_AND_RESTORE.md`. If it does not restore, the only copy of production
   is the Fly Postgres, and that changes the urgency of everything.
2. **Merge this branch only when CI is green** — CI runs the integration and
   e2e suites this branch could not run locally.
3. **Staging, end to end.** Create the staging database. Put the account's
   workers.dev subdomain into `[env.staging.vars] PUBLIC_URL`. Set staging's
   secrets with `wrangler secret put <NAME> --env staging`: `DATABASE_URL`, a
   **fresh** `AUTH_SECRET` (never production's), `OPS_TOKEN`. Then
   `npm run deploy:cf:staging`. It deploys, then waits until the Worker and
   both containers report the commit.
4. **Run the smoke test and parity against staging.**
   `BASE=<staging-url> node scripts/smoke.mjs`, then
   `node scripts/parity.mjs <staging-url> <staging-url> --writes --same-secret`
   as a self-check: a target compared with itself must report no differences.
   There is no live Fly deployment to compare against; the first real
   comparison is §4.5.
5. **The restart drill (§5) on staging.** This is where the numbers that
   `CLOUDFLARE.md` §4 calls "expected" become measured.
6. **Resolve every `CUTOVER-TODO`** in `web/privacy.html` and
   `web/status.html`: the provider's name and region, the PITR window, the
   cutover date, the measured restart gap, and the dates for the Fly and Tigris
   rows. `npm run deploy:cf` refuses while any remain.
7. **Zone settings** (§3).
8. **Record the expected `kid`.** It was read from the live service before it
   went offline: **`ff7bb4e3fb21a0fe`**. It is derived from `AUTH_SECRET`, so
   it is the proof, in §4.4, that the secret arrived byte for byte.

---

## 3. Cloudflare zone settings for `ratchetgate.com`

These are dashboard settings, not code, and each one can silently break a
property the application has a test for.

| setting | value | because |
|---|---|---|
| Bot Fight Mode / Super Bot Fight Mode | **off** | the callers are agents; a challenge page in front of `begin` is an outage |
| Browser Integrity Check, Security Level | off / lowest | same; API clients send unusual or no `User-Agent` |
| Any rule with a Managed Challenge or JS Challenge action | none | same |
| Always Use HTTPS | **off** | the edge would `301` a plaintext `POST`; the Worker refuses it instead (`CLOUDFLARE.md` §2). HSTS is sent by the application |
| Rocket Loader, Email Address Obfuscation, Automatic HTTPS Rewrites | off | they rewrite HTML under a strict CSP, and the pages are checked byte for byte by parity |
| Pseudo IPv4 | off | "Overwrite Headers" replaces `CF-Connecting-IP` with a made-up address |
| Managed Transform "Remove visitor IP headers" | off | removes `CF-Connecting-IP`; every caller would share one rate-limit bucket |
| Cache Rules | none | nothing here is cacheable by an edge that cannot see who is asking |
| Logpush, WAF payload logging | none | a second logger that has never read CLAUDE.md §5.8 |
| WAF managed ruleset | know that it exists | a rule that dislikes a payload answers with Cloudflare's own `403`, not Ratchet's error shape. If it ever fires on a legitimate `begin`, add a skip rule for `/v1/` and `/mcp` |
| Minimum TLS version | 1.2 or higher | — |

---

## 4. The day

### 4.1 Freeze Fly — in this order

```
flyctl machine list -a ratchet-gate            # app machine: stopped. worker machine: started.
flyctl machine stop <worker-machine-id> -a ratchet-gate
flyctl machine list -a ratchet-gate-staging    # stop anything running
flyctl ips list -a ratchet-gate                # must be empty, so auto_start cannot wake the app
```

The worker is stopped **first and on purpose**: it expires leases, delivers
webhooks, prunes receipts and garbage-collects. Each of those is a write, and
a dump taken while it runs is a dump of a moving database.

From here until §4.6, leases that expire are not being marked `indeterminate`
by anyone. That is correct and temporary: the new worker sweeps them on its
first tick, and `begin` expires a stale lease inline regardless.

Confirm nothing is connected but you:

```sql
SELECT pid, usename, application_name, state FROM pg_stat_activity
WHERE datname = 'ratchet_gate' AND pid <> pg_backend_pid();
```

Only replication and monitoring rows may remain; no `application_name = 'ratchet'`.

### 4.2 The final dump, and the counts it must match

Take the dump from the frozen database, with the two `flyctl ssh` commands
under "dumping…" in `scripts/backup-verify.sh`. Do not run the whole script:
its verify step fetches the receipt key from the live service, which is
offline. That check happens in §4.5. Then record, **from Fly**:

```sql
SELECT 'workspaces', count(*) FROM workspaces UNION ALL
SELECT 'api_keys', count(*) FROM api_keys UNION ALL
SELECT 'oauth_clients', count(*) FROM oauth_clients UNION ALL
SELECT 'effects', count(*) FROM effects UNION ALL
SELECT 'receipts', count(*) FROM receipts UNION ALL
SELECT 'audit_events', count(*) FROM audit_events UNION ALL
SELECT 'schema_migrations', count(*) FROM schema_migrations;
SELECT max(name) FROM schema_migrations;
SELECT state, count(*) FROM effects GROUP BY 1 ORDER BY 1;
SELECT coalesce(sum(credit_micros), 0) FROM workspaces;
```

The last recorded figures (1 Sep 2026) were 62 workspaces, 64 keys, 15 OAuth
clients. They are a sanity check, not a target: the real numbers are whatever
this query returns today, and those are the ones the restore must equal.
`schema_migrations` should hold 42 rows, the newest dated on or before 6 Sep.

### 4.3 Restore — the point of no return is at the end of this step

```
pg_restore --no-owner --no-privileges -d "<owner-url-of-the-new-database>" ratchet-<stamp>.dump
```

Run the same queries against the new database. **Every count must be equal**,
including effects by state and the credit total. A difference of one is a stop.

Grant the application role and the backup role their rights. Do not start
anything yet.

### 4.4 Deploy, without the public hostname, and prove the secret

Set production's Worker secrets. `AUTH_SECRET` is piped from its file and never
typed, echoed or pasted:

```
cd cloudflare
npx wrangler secret put AUTH_SECRET --env="" < <path-to-the-secret-file>
npx wrangler secret put DATABASE_URL --env=""        # paste at the prompt
npx wrangler secret put OPS_TOKEN --env=""           # openssl rand -hex 32
# and, per decision 4: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET; EMAIL_API_KEY; METRICS_TOKEN
```

and add to `[vars]`, in a commit, whatever non-secret settings production had
on Fly (`BILLING_PROVIDER`, `EMAIL_PROVIDER`, `EMAIL_FROM`, …; `flyctl secrets
list` shows the names). `AUTH_SECRET_RETIRED` and `DIMENSION_SECRET` were not
set on Fly and must stay unset.

```
PRECUTOVER=1 RATCHET_CF_PROD_URL=https://ratchet-gate.<subdomain>.workers.dev npm run deploy:cf
```

This goes through all four gates, deploys **without** attaching
`ratchetgate.com`, and waits for both containers. The API has now booted
against the new database: migrations found nothing to apply, and the receipt
key was registered. **That was a write. From this line on, the Fly database is
history.**

Now the check that matters more than any other:

```
curl -s https://ratchet-gate.<subdomain>.workers.dev/.well-known/ratchet-receipt-key
```

`current_kid` must be exactly **`ff7bb4e3fb21a0fe`**.

- **It matches:** `AUTH_SECRET` is byte-identical to the one on Fly. Every API
  key still authenticates, every per-counterparty ceiling still addresses the
  same bucket, receipts continue under the same key, MFA and sessions hold.
- **It does not match:** stop. The usual cause is a trailing newline — the
  secret file is 44 bytes and whether `wrangler secret put` keeps a final
  newline from stdin was not verified. With the wrong secret every API key is
  dead and, worse, every per-counterparty ceiling has silently reset to zero
  while still reading as configured. Fix the secret, let the supervisor
  replace the containers (it notices the change within a minute), and check
  again. Do not attach the hostname until it matches.

### 4.5 Verify the data and the behaviour, still off the public hostname

```
node scripts/verify-restore.mjs "<read-only-url-of-the-new-database>" https://ratchet-gate.<subdomain>.workers.dev
```

Every receipt signature and every chain link, verified against the published
key. Zero bad. (The published key list now comes from the new deployment, which
is why the `kid` was pinned to a value recorded *before* the move.)

Then, with a real key if one is to hand, one `begin` for an idempotency key
that already succeeded before the move: it must answer `duplicate` with the
recorded result. That is the migration's whole claim in one request.

```
node scripts/parity.mjs https://ratchet-gate-staging.<subdomain>.workers.dev https://ratchet-gate.<subdomain>.workers.dev
```

Staging against production, read-only. It is the same code on both, so the
only differences that are acceptable are the ones staging is built to have:
`X-Robots-Tag` on every response, a different `/robots.txt`, and anything
derived from `EMAIL_PROVIDER` or `BILLING_PROVIDER`. The receipt keys must
differ, and the script fails if they do not. Read every other line it prints
as a finding.

`/workerz` must show every loop with a fresh heartbeat and `replication:
unobserved`.

### 4.6 Attach the hostname

```
npm run deploy:cf
```

Without `PRECUTOVER`, the same commit is deployed with `--domain
ratchetgate.com --domain www.ratchetgate.com`, and production is verified on
the real hostname. The maintenance Worker has to release the two custom
domains first; whether that can be done with no moment of the hostname being
attached to nothing is **not known** — expect seconds, and do it deliberately.

Then:

- `curl -s https://ratchetgate.com/.well-known/ratchet-receipt-key` — the `kid`
  again, on the real hostname.
- A plaintext `POST` to `http://ratchetgate.com/v1/effects/begin` must be
  `400`, not a redirect.
- `node scripts/parity.mjs <staging> https://ratchetgate.com`.
- The Stripe dashboard: the webhook endpoint is the same URL as before, so no
  change is needed; watch the first retried event verify.

### 4.7 If it is wrong

Detach the hostname by redeploying the maintenance Worker onto it. The service
is then where it was this morning: closed, answering `503`, with the new
database intact. Fix forward. **Do not start anything on Fly.** The only
circumstances in which Fly's database is touched again are reading it, to
compare.

---

## 5. The restart drill (staging first, then once on production)

The figures in `CLOUDFLARE.md` §4 are what the mechanisms imply. These turn
them into measurements. Poll `/__ops/status` once a second throughout and keep
the output; `starts`, `startedAt` and `lastExit` are the record.

| drill | how | what to record |
|---|---|---|
| worker exits | make the worker exit (its watchdog path: `process.exit(1)`), e.g. by `wrangler containers ssh` and killing `node` | seconds until `worker.running` is true again; `/workerz` heartbeats resume |
| API exits | the same, on the API container | seconds of `503`; that every answer in the gap was `503` and none was a `200` or an HTML page |
| a lease expires while the worker is down | `begin` with a short lease, stop the worker, wait past expiry, `begin` again | the second `begin` must not say `in_flight` for ever: it expires the lease inline |
| deploy | `npm run deploy:cf:staging` with a trivial change | seconds of `503` on the API; that both containers end on the new commit |
| secret rotation | `wrangler secret put` any passed-through value | seconds until both containers have been replaced |
| alarm lost | not directly inducible; delete the Durable Object's alarm if tooling allows, else skip | whether the cron restores it within two minutes |

Write the numbers into `CLOUDFLARE.md` §4, `KNOWN_LIMITATIONS.md` §6 and
`web/status.html`, replacing "expected" and "about a minute".

Also measure, and write down before the benchmark page is quoted again: the
`begin` round trip from outside, and where the containers were placed.

---

## 6. Afterwards

1. **Backups.** Create the R2 bucket with a 30-day lifecycle rule and a token
   scoped to it; add the five repository secrets named in
   `.github/workflows/backup-cf.yml`; run that workflow by hand once. When it
   is green, add its nightly `schedule:` and remove the schedule from
   `backup.yml` — in that order. Until then the last verified backup is the
   pre-cutover dump.
2. **Uptime.** `uptime.yml` probes `https://ratchetgate.com` and needs no
   change; it has been failing since the service went offline and should go
   green on its own.
3. **Deploy commands.** `npm run deploy` and `deploy:staging` still point at
   Fly and will keep failing there. Remove them, with `fly.toml`,
   `fly.staging.toml`, `scripts/deploy.sh` and `scripts/backup-verify.sh`, in a
   follow-up once Fly is gone — not in this branch, which was told to keep the
   Fly path working.
4. **Turn off `workers_dev` for production** in `cloudflare/wrangler.toml`, so
   the gate has one hostname.
5. **Fly.** Keep the Postgres stopped-but-present for as long as decision 8
   says, then destroy it and note the date on the privacy page. Delete the
   Tigris bucket when its newest backup is older than the retention promise.
6. **Docs that go stale at this moment:** `README.md` (the Fly deploy section),
   `STAGING.md`, `BACKUP_AND_RESTORE.md`, `RECOVERY.md`, `PROJECT_MAP.md`,
   `WORKER_LIVENESS.md` ("Fly sees a healthy process"), `web/benchmark.html`
   (every figure), CLAUDE.md §10's first three bullets. They are left alone in
   this branch because they are still true of the only deployment that has
   ever run.
7. **Tell key holders**, per decision 3. `ratchet-mcp` on npm points at this
   hostname and needs no change.
