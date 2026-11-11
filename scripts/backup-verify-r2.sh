#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Deimos AI LLC
# Take a logical backup of production and PROVE it restores — the Cloudflare
# variant of scripts/backup-verify.sh.
#
# Same promise, same order: dump, restore into a throwaway Postgres of the same
# major version, re-verify every receipt signature and chain link against the
# public key the live service publishes, and only THEN ship the dump off the
# machine. What changed is how the dump is reached and where it goes:
#
#   Fly                               Cloudflare
#   flyctl ssh into the cluster   →   pg_dump straight to the managed database, over TLS
#   the postgres superuser        →   a dedicated, read-only backup role
#   Tigris                        →   R2
#
# scripts/backup-verify.sh is untouched and keeps working until the cutover.
#
#   scripts/backup-verify-r2.sh [outdir]
#
# Environment (values are never printed):
#   BACKUP_DATABASE_URL   postgres://backup_role:…@<direct-host>:5432/<db>
#                         The provider's DIRECT endpoint, not its pooler: pg_dump
#                         needs a session, and a transaction-mode pooler breaks it.
#                         The role needs only: CONNECT, USAGE on the schema, SELECT
#                         on all tables and sequences (the built-in pg_read_all_data
#                         role is exactly that). It must not be the application's role.
#   BASE                  the live service, for its published receipt key
#   R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
#                         optional; without them the dump is verified and kept locally.
#                         The token should be "Object Read & Write" on this one bucket.
set -euo pipefail

BASE=${BASE:-https://ratchetgate.com}
OUT=${1:-./backups}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
CONTAINER=ratchet-restore-$STAMP
PORT=${PORT:-5456}
# The newest client this script knows. A client reads any OLDER server, so this
# is only used to ask the server what it is; the dump and the restore then use
# the server's own major version.
PROBE_IMAGE=${PROBE_IMAGE:-postgres:18-alpine}

mkdir -p "$OUT"

for tool in docker node; do
  command -v "$tool" >/dev/null || { echo "  missing required tool: $tool"; exit 1; }
done
[ -n "${BACKUP_DATABASE_URL:-}" ] || { echo "  BACKUP_DATABASE_URL is not set"; exit 1; }
case "$BACKUP_DATABASE_URL" in
  *sslmode=disable*|*sslmode=allow*|*sslmode=prefer*|*sslmode=require*|*sslmode=no-verify*)
    echo "  BACKUP_DATABASE_URL asks for an unverified or unencrypted connection."
    echo "  Remove the sslmode parameter (this script sets verify-full itself) or set"
    echo "  sslmode=verify-full. sslmode=require encrypts but verifies nothing."
    exit 1 ;;
esac

# Every client call goes through one function, so the TLS settings cannot be
# forgotten on one of them. libpq's default is sslmode=prefer, which encrypts if
# it can and verifies NOTHING — so both are stated: verify the certificate chain
# and the hostname, against the system's public CA bundle.
#
# The URL is handed to the container as an environment variable (`-e NAME`
# copies it from this shell without putting the value on a command line here)
# and expanded only inside the container.
pg() {  # pg <image> <shell command using "$BACKUP_DATABASE_URL">
  local image="$1"; shift
  docker run --rm -i \
    -e BACKUP_DATABASE_URL -e PGSSLMODE=verify-full -e PGSSLROOTCERT=system \
    -e PGCONNECT_TIMEOUT=20 -e PGAPPNAME=ratchet-backup \
    "$image" sh -c "$1"
}

# Pull first and quietly: `docker run` prints pull progress on stderr, and those
# lines (layer digests) would otherwise be read as part of the answer below.
docker pull -q "$PROBE_IMAGE" >/dev/null

# Errors are NOT swallowed. A backup that fails must say why; that is most of
# its job.
PROBE=$(pg "$PROBE_IMAGE" 'psql "$BACKUP_DATABASE_URL" -At -c "SHOW server_version"' 2>&1) || {
  echo "  could not reach the database. Raw output:"
  # libpq puts the host in its errors and never the password, but the URL is
  # the one thing here that must not reach a CI log, so strip anything URL-shaped.
  printf '%s\n' "$PROBE" | sed -E 's#postgres(ql)?://[^[:space:]]+#postgres://[redacted]#g; s/^/    /'
  echo "  Most likely: the backup role's password is wrong, the host is the pooler"
  echo "  and not the direct endpoint, or the provider's certificate is not from a public CA."
  exit 1
}
MAJOR=$(printf '%s\n' "$PROBE" | tr -d '\r' | grep -E '^[0-9]+(\.[0-9]+)+' | tail -1 | grep -oE '^[0-9]+' || true)
if [ -z "$MAJOR" ]; then
  echo "  could not read the server version. Raw output:"
  printf '%s\n' "$PROBE" | sed -E 's#postgres(ql)?://[^[:space:]]+#postgres://[redacted]#g; s/^/    /'
  exit 1
fi
echo "  production server: $MAJOR"
IMAGE="postgres:${MAJOR}-alpine"
docker pull -q "$IMAGE" >/dev/null

# The role must be able to read, and must NOT be able to write. A backup
# credential that can also drop a table is the application credential with a
# different name.
CAN_WRITE=$(pg "$IMAGE" 'psql "$BACKUP_DATABASE_URL" -At -c "SELECT has_table_privilege(current_user, '"'"'effects'"'"', '"'"'INSERT,UPDATE,DELETE,TRUNCATE'"'"') OR (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)"' 2>/dev/null | tr -d '\r' || echo '?')
case "$CAN_WRITE" in
  f) echo "  backup role is read-only" ;;
  t) echo "  the backup role can WRITE to production (or is a superuser)."
     echo "  Give it pg_read_all_data and nothing else. Refusing to continue."
     exit 1 ;;
  *) echo "  could not confirm the backup role is read-only — refusing to continue."; exit 1 ;;
esac

# Check we can actually write to the bucket BEFORE dumping and restoring:
# discovering a credential problem at the last step is the most expensive
# possible moment. scripts/s3-put.mjs is a plain SigV4 PUT and R2 speaks S3
# (region "auto", path-style), so it is reused as it is, under its own names.
R2=0
if [ -n "${R2_ACCESS_KEY_ID:-}" ] && [ -n "${R2_BUCKET:-}" ]; then
  : "${R2_ACCOUNT_ID:?R2_ACCOUNT_ID is not set}" "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY is not set}"
  R2=1
fi
r2_put() {
  TIGRIS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" TIGRIS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
  TIGRIS_BUCKET="$R2_BUCKET" TIGRIS_REGION=auto \
  TIGRIS_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
    node scripts/s3-put.mjs "$1" "$2"
}
if [ "$R2" = 1 ]; then
  echo "  checking write access to the bucket…"
  PROBE_FILE=$(mktemp)
  printf 'ratchet backup preflight' > "$PROBE_FILE"
  if ! r2_put "$PROBE_FILE" "preflight/.write-check" >/dev/null 2>&1; then
    rm -f "$PROBE_FILE"
    echo "  cannot write to R2 bucket \"$R2_BUCKET\". Check, in the Cloudflare dashboard:"
    echo "    - the bucket exists in account R2_ACCOUNT_ID and is spelled exactly that way"
    echo "    - the API token is Object Read & Write and scoped to this bucket"
    echo "    - R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are from the SAME token"
    # Unlike the Tigris script, this never tries to create the bucket: a token
    # that can create buckets is broader than a backup needs.
    exit 1
  fi
  rm -f "$PROBE_FILE"
  echo "  bucket is writable."
fi

echo "  dumping…"
DUMP="$OUT/ratchet-$STAMP.dump"
( umask 077; pg "$IMAGE" 'pg_dump "$BACKUP_DATABASE_URL" -Fc --no-owner --no-privileges' > "$DUMP" )
SIZE=$(wc -c < "$DUMP" | tr -d ' ')
# A custom-format dump starts with the bytes PGDMP. An empty or truncated file
# here would otherwise surface as a confusing pg_restore error further down.
if [ "$SIZE" -lt 1024 ] || [ "$(head -c 5 "$DUMP")" != "PGDMP" ]; then
  echo "  the dump is $SIZE bytes or is not a custom-format archive — backup NOT taken" >&2
  exit 1
fi
echo "  dump: $DUMP ($SIZE bytes)"

echo "  restoring into a throwaway $IMAGE…"
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=test -p "127.0.0.1:$PORT:5432" "$IMAGE" >/dev/null
trap 'docker rm -f "$CONTAINER" >/dev/null 2>&1 || true' EXIT
# Wait for the restore target, carefully: the official image runs initdb against
# a TEMPORARY server and then restarts, so one successful probe can land in the
# gap (1 Sep 2026). A real query, three times in a row, spans the bounce.
ready=0
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" psql -U postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
    ready=$((ready + 1))
    [ "$ready" -ge 3 ] && break
  else
    ready=0
  fi
  sleep 2
done
if [ "$ready" -lt 3 ]; then
  echo "  the throwaway postgres never became ready — backup NOT verified" >&2
  docker logs "$CONTAINER" 2>&1 | tail -20 >&2
  exit 1
fi
docker cp "$DUMP" "$CONTAINER:/tmp/r.dump" >/dev/null
docker exec "$CONTAINER" psql -U postgres -c "CREATE DATABASE restored" >/dev/null
docker exec "$CONTAINER" pg_restore -U postgres -d restored --no-owner --no-privileges /tmp/r.dump

echo "  verifying evidence in the restored copy…"
node scripts/verify-restore.mjs "postgres://postgres:test@127.0.0.1:$PORT/restored" "$BASE"

# Only upload AFTER the restore verified. Shipping an unverified dump off-site
# manufactures confidence in a file nobody has proven can be restored.
if [ "$R2" = 1 ]; then
  echo "  uploading the verified dump to R2…"
  r2_put "$DUMP" "postgres/ratchet-$STAMP.dump"
else
  echo "  (R2_* not set — dump kept locally only)"
fi
