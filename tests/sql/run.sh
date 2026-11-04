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

# 운영 설정 SQL(supabase/ops/cron-m2.sql): 확장 대신 stub 을 깔고, 확장 생성 줄만 빼서 두 번 적용(다시 실행해도 되는지)
echo "== ops"
run "$ROOT/tests/sql/10_ops_stub.sql"
OPS_TMP="$(mktemp)"
grep -v '^create extension' "$ROOT/supabase/ops/cron-m2.sql" > "$OPS_TMP"
run "$OPS_TMP"
run "$OPS_TMP"
rm -f "$OPS_TMP"
run "$ROOT/tests/sql/ops.test.sql"

# kv_claim 동시 실행: 두 연결이 같은 키를 거의 동시에 claim → 하나만 true (행이 없을 때·있을 때 둘 다)
echo "== concurrency"
for KEY in conc_new conc_old; do
  if [[ "$KEY" == conc_old ]]; then
    psql "$DATABASE_URL" "${PSQL_OPTS[@]}" -c "insert into sp.server_kv (key, value, updated_at) values ('$KEY', 'x', now() - interval '1 hour')"
  fi
  A_OUT="$(mktemp)"
  psql "$DATABASE_URL" "${PSQL_OPTS[@]}" -At -c "begin" -c "select sp.kv_claim('$KEY', 65000)" -c "select pg_sleep(1.5)" -c "commit" > "$A_OUT" &
  A_PID=$!
  B="$(psql "$DATABASE_URL" "${PSQL_OPTS[@]}" -At -c "select pg_sleep(0.5)" -c "select sp.kv_claim('$KEY', 65000)" | tail -1)"
  wait "$A_PID"
  A="$(grep -E '^[tf]$' "$A_OUT" | head -1)"
  rm -f "$A_OUT"
  echo "$KEY: A=$A B=$B"
  if [[ "$A" != "t" || "$B" != "f" ]]; then
    echo "FAIL kv_claim concurrency ($KEY)"; exit 1
  fi
done
echo "PASS kv_claim concurrency (2)"
