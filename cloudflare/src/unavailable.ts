// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The answer when the gate cannot be reached.
 *
 * A gate that is down must fail closed: never 200, never a redirect, never
 * anything a caller could read as permission. The body is Ratchet's own error
 * shape, the same one the maintenance Worker served while the service was
 * offline, so a client that already handles one handles the other.
 *
 * Two messages, because they are two different facts and an agent acts on the
 * difference:
 *
 *   not_forwarded  The request never reached the application. No decision
 *                  exists.
 *   no_answer      The request was handed to the application and no response
 *                  came back. A `begin` may or may not have been recorded.
 *                  Saying "no decision was made" here would be a guess, and
 *                  this product does not guess. The honest instruction is the
 *                  one the gate is built around: do not act, and ask again
 *                  with the same idempotency key.
 */

export type Unavailable = 'not_forwarded' | 'no_answer';

/** Short on purpose: a restart takes seconds, not the hour a maintenance window does. */
export const RETRY_AFTER_SECONDS = 10;

const MESSAGES: Record<Unavailable, string> = {
  not_forwarded:
    'Ratchet is temporarily unavailable. No decision was made for this request: '
    + 'treat it as not permitted and retry later.',
  no_answer:
    'Ratchet did not answer. No decision was returned for this request, and one may or may '
    + 'not have been recorded: treat it as not permitted, and retry with the same '
    + 'idempotency key.',
};

export function unavailable(kind: Unavailable, method = 'GET'): Response {
  const body = JSON.stringify({ error: { code: 'service_unavailable', message: MESSAGES[kind] } });
  return new Response(method === 'HEAD' ? null : body, {
    status: 503,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Retry-After': String(RETRY_AFTER_SECONDS),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex',
    },
  });
}
