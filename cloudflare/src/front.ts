// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The front door: every request for ratchetgate.com passes through here on its
 * way to the API container.
 *
 * It is deliberately not clever. The application already decides everything
 * that matters — auth, limits, redirects, headers, error shape — and each of
 * those is covered by a test over there. Anything this file "helpfully" did to
 * a request would be behaviour with no test behind it, in front of a product
 * whose claim is that it behaves exactly as tested. So it does four things:
 *
 *   1. Says who the caller is, truthfully (see `forwardedHeaders`).
 *   2. Refuses plaintext instead of redirecting it, for anything but a page view.
 *   3. Hands the request over untouched: same method, same path, same bytes.
 *   4. Fails closed when there is nobody to hand it to.
 */
import { unavailable } from './unavailable.js';

/** The one thing this module needs from the outside: something that can reach the API. */
export interface Upstream {
  fetch(request: Request): Promise<Response>;
}

/**
 * Headers a client could use to lie about where it is, or how it arrived.
 *
 * The application runs Fastify with `trustProxy: true`, so `req.ip` is the
 * LEFTMOST address in X-Forwarded-For. `req.ip` is the bucket for the
 * unauthenticated rate limit and for the keyless-provisioning ceiling — the
 * only two things a stranger gets for free. Cloudflare APPENDS to a
 * client-supplied X-Forwarded-For rather than replacing it, so passing the
 * header through would let anyone pick their own bucket, a new one per
 * request, and neither limit would ever refuse.
 *
 * CF-Connecting-IP is set by Cloudflare's edge and cannot be supplied by the
 * client, so it becomes the whole of X-Forwarded-For. If it is somehow absent,
 * the header is removed and not guessed at: the application then sees one
 * shared address for everybody, which limits too much rather than too little.
 */
const CLIENT_SUPPLIED_PROXY_HEADERS = [
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port',
  'forwarded', 'x-real-ip', 'x-client-ip', 'true-client-ip',
];

export function forwardedHeaders(incoming: Headers, scheme: 'http' | 'https'): Headers {
  const headers = new Headers(incoming);
  const clientIp = incoming.get('cf-connecting-ip');
  for (const name of CLIENT_SUPPLIED_PROXY_HEADERS) headers.delete(name);
  if (clientIp) headers.set('x-forwarded-for', clientIp);
  headers.set('x-forwarded-proto', scheme);
  return headers;
}

/**
 * Plaintext.
 *
 * A page view is sent to https, as it always was. Anything else is refused
 * and NOT redirected: a 301 on a POST is replayed as a GET by many clients,
 * which would turn a gated `begin` into a page fetch and leave the caller
 * reading a decision that was never made. `request_error` is the application's
 * existing code for a malformed request; this adds no new one to the contract.
 */
function refusePlaintext(request: Request, url: URL): Response {
  if (request.method === 'GET' || request.method === 'HEAD') {
    const to = new URL(url);
    to.protocol = 'https:';
    return new Response(null, {
      status: 301,
      headers: { Location: to.toString(), 'Cache-Control': 'no-store' },
    });
  }
  return new Response(JSON.stringify({
    error: {
      code: 'request_error',
      message: 'HTTPS is required. This request arrived over plain HTTP and was not processed.',
    },
  }), {
    status: 400,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export interface FrontOptions {
  /** Local development and tests speak http to the Worker; production never does. */
  allowPlaintext?: boolean;
}

export async function handle(
  request: Request, upstream: Upstream, options: FrontOptions = {},
): Promise<Response> {
  const url = new URL(request.url);
  const scheme = url.protocol === 'https:' ? 'https' : 'http';
  if (scheme === 'http' && !options.allowPlaintext) return refusePlaintext(request, url);

  // The path and query are forwarded as received, and so is the Host: the
  // application sends page views on a non-canonical hostname to the canonical
  // one, and it can only do that if it is told which hostname was asked for.
  // The scheme is http because TLS ended at Cloudflare's edge; what the client
  // used travels in X-Forwarded-Proto.
  const target = new URL(url);
  target.protocol = 'http:';

  const forwarded = new Request(target, {
    method: request.method,
    headers: forwardedHeaders(request.headers, scheme),
    // The stream itself, not a copy of its contents: a payment webhook is
    // verified over the exact bytes that were signed, and re-encoding them
    // here would make every signature fail — or worse, some of them.
    body: request.body,
    // A 3xx from the application is the client's to follow, not ours.
    redirect: 'manual',
    signal: request.signal,
  });

  try {
    return await upstream.fetch(forwarded);
  } catch {
    // Nothing about the failure reaches the caller: internal detail never
    // crosses the error boundary. Whether the application saw the request is
    // not knowable from here, so the answer does not pretend to know.
    return unavailable('no_answer', request.method);
  }
}
