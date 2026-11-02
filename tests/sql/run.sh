#!/usr/bin/env bash
# 로컬 Postgres 에 stub → supabase/migrations/*.sql → rls.test.sql 를 차례로 적용한다.
# - DATABASE_URL 이 있으면 그 DB 를 쓴다(CI 의 postgres 서비스 컨테이너). 빈 DB 여야 한다.
# - 없으면 임시 클러스터를 만들어 쓰고 끝나면 지운다(PG_BIN 으로 initdb 위치 지정 가능).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PSQL_OPTS=(-v ON_ERROR_STOP=1 -X -q)

if [[ -z "${DATABASE_URL:-}" ]]; then
  PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
  TMP="$(mktemp -d)"
  PORT="${PGPORT_TEST:-54329}"
  trap '"$PG_BIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
  if [[ "$(id -u)" == "0" ]]; then
    # root 로는 initdb 가 안 되므로 postgres 사용자로 실행
    chown -R postgres "$TMP"
    RUN=(runuser -u postgres --)
  else
    RUN=()
  fi
  "${RUN[@]}" "$PG_BIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
  "${RUN[@]}" "$PG_BIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null
  DATABASE_URL="postgresql://postgres@/postgres?host=$TMP&port=$PORT"
fi

run() { psql "$DATABASE_URL" "${PSQL_OPTS[@]}" -f "$1"; }

run "$ROOT/tests/sql/00_supabase_stub.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "== migrate $(basename "$f")"
  run "$f"
done
echo "== tests"
run "$ROOT/tests/sql/rls.test.sql"
