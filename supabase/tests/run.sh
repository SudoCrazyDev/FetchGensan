#!/usr/bin/env bash
#
# Applies every migration to a throwaway Postgres+PostGIS container and then
# runs the assertions in 01_dispatch_test.sql.
#
# Why this exists alongside `supabase db reset`: it needs only Docker, runs
# in about twenty seconds, and it is what catches the errors that a
# TypeScript typecheck cannot -- a policy that recurses, a function that
# references a table created in a later migration, a transition the guard
# trigger rejects. Worth running before every push that touches SQL.
#
#   ./supabase/tests/run.sh
#
set -euo pipefail

CONTAINER=fetchgensan-sqltest
IMAGE=postgis/postgis:17-3.5
PGPASSWORD=postgres
DB=fetchgensan_test

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
migrations="$here/../migrations"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cleanup

echo "==> starting $IMAGE"
docker run -d --name "$CONTAINER" \
  -e "POSTGRES_PASSWORD=$PGPASSWORD" \
  -e "POSTGRES_DB=$DB" \
  "$IMAGE" >/dev/null

# The postgres image runs a temporary server to execute initdb and its
# init scripts, then shuts it down and starts the real one. pg_isready
# succeeds against that temporary server, so a naive wait races the
# restart and dies with "the database system is shutting down".
#
# Requiring several consecutive successful real queries rides out the
# restart window.
echo -n "==> waiting for postgres"
ready_streak=0
for _ in $(seq 1 90); do
  if docker exec "$CONTAINER" \
       psql -U postgres -d "$DB" -tAc 'select 1' >/dev/null 2>&1; then
    ready_streak=$((ready_streak + 1))
    if [ "$ready_streak" -ge 5 ]; then
      echo " ready"
      break
    fi
  else
    ready_streak=0
  fi
  echo -n "."
  sleep 1
done

if [ "$ready_streak" -lt 5 ]; then
  echo " timed out"
  docker logs "$CONTAINER" | tail -30
  exit 1
fi

run_sql_file() {
  local label="$1" file="$2"
  echo "==> $label"
  # ON_ERROR_STOP makes psql exit non-zero on the first failure, so `set -e`
  # aborts the run at the migration that actually broke.
  docker exec -i "$CONTAINER" \
    psql -v ON_ERROR_STOP=1 -q -U postgres -d "$DB" < "$file"
}

run_sql_file "supabase stubs" "$here/00_supabase_stubs.sql"

for migration in "$migrations"/*.sql; do
  run_sql_file "$(basename "$migration")" "$migration"
done

run_sql_file "seed.sql" "$here/../seed.sql"
run_sql_file "dispatch assertions" "$here/01_dispatch_test.sql"
run_sql_file "privilege assertions" "$here/02_privilege_test.sql"

echo
echo "==> all migrations applied and assertions passed"
