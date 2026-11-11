// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Ask a Cloudflare deployment which commit it is running, and whether both
 * containers are up and current.
 *
 * On Fly the deploy gate read the commit with `flyctl ssh console -C "printenv
 * GIT_COMMIT"` — authenticated, and never public, because the repository is
 * open and the deployed commit tells a stranger which fixes are missing. This
 * is the same question asked through the Worker's authenticated ops route.
 *
 *   RATCHET_OPS_TOKEN=… node scripts/cf-status.mjs <base-url> [expected-commit] [--wait=seconds]
 *
 * Exit 0 only when the Worker, the API container and the worker container all
 * report the expected commit, running, started from the current image and
 * configuration. The token is read from the environment and never printed.
 *
 * "Worker is on this commit" is not enough, and is the reason this checks
 * three things: under the durable_object scheduling policy a running container
 * keeps the image it was started with until its Durable Object replaces it, so
 * for up to a minute after a deploy the Worker can be new and the application
 * behind it old.
 */
const args = process.argv.slice(2);
const wait = Number((args.find((a) => a.startsWith('--wait=')) ?? '--wait=0').slice(7));
const [BASE_ARG, EXPECTED] = args.filter((a) => !a.startsWith('--'));
const TOKEN = process.env.RATCHET_OPS_TOKEN;

if (!BASE_ARG) { console.error('usage: cf-status.mjs <base-url> [expected-commit] [--wait=seconds]'); process.exit(2); }
if (!TOKEN) { console.error('  RATCHET_OPS_TOKEN is not set (the value of the OPS_TOKEN Worker secret)'); process.exit(2); }
const BASE = BASE_ARG.replace(/\/+$/, '');

async function ask() {
  const res = await fetch(`${BASE}/__ops/status`, {
    headers: { authorization: `Bearer ${TOKEN}` },
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  // The route answers only to the right token; anything else falls through to
  // the application. So "no api/worker in the body" means the token is wrong,
  // OPS_TOKEN is unset, or this is not a Cloudflare deployment at all.
  if (!json || typeof json !== 'object' || !('api' in json) || !('worker' in json)) {
    return { problems: [`no status from ${BASE} (HTTP ${res.status}) — wrong token, OPS_TOKEN unset, or not this Worker`] };
  }
  const problems = [];
  if (EXPECTED && json.commit !== EXPECTED) problems.push(`Worker is on ${String(json.commit).slice(0, 7)}, expected ${EXPECTED.slice(0, 7)}`);
  for (const role of ['api', 'worker']) {
    const s = json[role] ?? {};
    if (s.problem) problems.push(`${role}: ${s.problem}`);
    if (!s.running) problems.push(`${role}: container is not running`);
    else if (!s.current) problems.push(`${role}: container is running an older image or configuration`);
    if (EXPECTED && s.commit !== EXPECTED) problems.push(`${role}: on ${String(s.commit).slice(0, 7)}, expected ${EXPECTED.slice(0, 7)}`);
  }
  return { problems, json };
}

const deadline = Date.now() + wait * 1000;
for (;;) {
  let result;
  try { result = await ask(); } catch (err) { result = { problems: [`could not reach ${BASE}: ${err.message}`] }; }
  if (result.problems.length === 0) {
    const { json } = result;
    console.log(`  commit ${String(json.commit).slice(0, 7)}  api: up, started ${json.api.starts}x  worker: up, started ${json.worker.starts}x`);
    process.exit(0);
  }
  if (Date.now() >= deadline) {
    for (const p of result.problems) console.error(`  ${p}`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 5_000));
}
