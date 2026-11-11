// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * What crosses from the Worker into a container's environment.
 *
 * NAMES ONLY. No value appears in this repository, in wrangler.toml, or in a
 * log line. Secrets are set with `wrangler secret put <NAME>` and plain
 * settings in `[vars]`; both arrive on `env`, and the ones named here are
 * copied into the container when it starts.
 *
 * An explicit list rather than "everything on env": the Worker's own bindings
 * (the Durable Object namespaces, OPS_TOKEN) have no business inside the
 * application, and a setting that is dangerous in production should have to be
 * added here on purpose before it can reach a process. The list is the
 * application's own inventory — every name `src/` reads — minus the ones that
 * must never be set in production at all.
 */

/** Without these the application refuses to start, so starting it would be noise. */
export const REQUIRED = ['DATABASE_URL', 'AUTH_SECRET'] as const;

export const PASSED_THROUGH = [
  ...REQUIRED,
  // secrets
  'AUTH_SECRET_RETIRED', 'DIMENSION_SECRET', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
  'EMAIL_API_KEY', 'METRICS_TOKEN', 'X402_FACILITATOR_KEY',
  // settings
  'NODE_ENV', 'RATCHET_ENV', 'PORT', 'HOST', 'PUBLIC_URL', 'LOG_LEVEL', 'CORS_ORIGINS',
  'DB_SSL', 'DB_POOL_MAX', 'DB_STATEMENT_TIMEOUT_MS', 'DB_IDLE_IN_TX_TIMEOUT_MS',
  'RATE_LIMIT_PER_MINUTE', 'RATE_LIMIT_SHARED', 'RATE_LIMIT_FLUSH_MS',
  'MAX_REQUEST_BYTES', 'MAX_RESULT_BYTES', 'CONSOLE_SESSION_TTL_HOURS',
  'PROVISION_PER_SOURCE_PER_HOUR', 'PROVISION_GLOBAL_PER_HOUR', 'RECEIPT_RETENTION_DAYS',
  'WEBHOOK_TIMEOUT_MS', 'WEBHOOK_MAX_ATTEMPTS', 'WEBHOOK_MAX_RESPONSE_BYTES',
  'WEBHOOK_HOST_ALLOWLIST',
  'LEASE_SWEEP_INTERVAL_MS', 'WEBHOOK_POLL_INTERVAL_MS', 'GC_INTERVAL_MS',
  'REPLICATION_CHECK_INTERVAL_MS', 'REPLICA_LAG_ALERT_BYTES', 'EXPECTED_REPLICAS',
  'BILLING_PROVIDER', 'STRIPE_AUTOMATIC_TAX',
  'SOLANA_DESTINATION_ADDRESS', 'SOLANA_RPC_URL', 'ETHEREUM_DESTINATION_ADDRESS',
  'ETHEREUM_RPC_URL', 'BITCOIN_DESTINATION_ADDRESS', 'BITCOIN_API_URL',
  'CRYPTO_POLL_INTERVAL_MS', 'CRYPTO_PRICE_SOURCES', 'CRYPTO_MAX_PRICE_DIVERGENCE_BPS',
  'EMAIL_PROVIDER', 'EMAIL_FROM', 'EMAIL_REPLY_TO', 'EMAIL_MAX_ATTEMPTS',
  'EMAIL_POLL_INTERVAL_MS',
  'X402_FACILITATOR_URL', 'X402_PAY_TO', 'X402_NETWORK', 'X402_ASSET', 'X402_ASSET_NAME',
  'X402_ASSET_VERSION', 'X402_AMOUNT', 'X402_CREDIT_MICROS',
  // Which commit is running. Read back by the deploy gate through the
  // authenticated ops route, never served to the public.
  'GIT_COMMIT',
] as const;

/**
 * Deliberately absent, so that setting them on the Worker does nothing:
 *
 *   WEBHOOK_ALLOW_PRIVATE_NETWORK, RATE_LIMIT_OVERRIDE
 *       test-only; production refuses to start with either.
 *   MIGRATE_ON_BOOT
 *       decided per container class in container.ts, not by configuration.
 *   RATCHET_API_KEY
 *       a client-side setting for the stdio MCP bridge.
 */
export const NEVER_PASSED = [
  'WEBHOOK_ALLOW_PRIVATE_NETWORK', 'RATE_LIMIT_OVERRIDE', 'MIGRATE_ON_BOOT', 'RATCHET_API_KEY',
] as const;

export function containerEnv(env: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PASSED_THROUGH) {
    const value = env[name];
    if (typeof value === 'string' && value !== '') out[name] = value;
  }
  return out;
}

export function missingRequired(env: Record<string, unknown>): string[] {
  return REQUIRED.filter((name) => typeof env[name] !== 'string' || env[name] === '');
}
