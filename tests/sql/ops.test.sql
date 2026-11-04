-- supabase/ops/cron-m2.sql 시험(10_ops_stub.sql 위에서). run.sh 가 확장 생성 줄을 빼고 적용한 뒤 실행한다.
create table t.ops_results (seq serial, name text, ok boolean, detail text);
create function t.ok(c boolean, n text, d text default null) returns void language sql as
$$ insert into t.ops_results (name, ok, detail) values (n, coalesce(c, false), d) $$;

select t.ok((select count(*) from cron.job where jobname like 'sp-%') = 7, 'O1 작업 7개 등록(M2 4 + M4 3)');
select t.ok((select schedule from cron.job where jobname = 'sp-tick-kr') = '* 0-6 * * 1-5', 'O2 tick-kr 일정(UTC 0-6 = 한국 9-15시)');
select t.ok((select schedule from cron.job where jobname = 'sp-tick-us') = '* 13-21 * * 1-5', 'O3 tick-us 일정');
select t.ok((select schedule from cron.job where jobname = 'sp-tax-annual') = '50 14 * * *', 'O3b tax-annual 일정(UTC 14:50 = 한국 23:50, 5/31 23:30 이후 자동 차감)');
select t.ok(length((select value from sp.server_kv where key = 'cron_token')) = 64
            and (select value from sp.server_kv where key = 'cron_token') ~ '^[0-9a-f]{64}$', 'O4 cron 토큰 64자 16진수');

-- 다시 실행해도 토큰·작업 수 그대로(아래 run.sh 가 ops 파일을 두 번 적용)
select t.ok((select count(*) from vault.secrets where name in ('project_url','publishable_key')) = 2, 'O5 Vault 값 2개(중복 없음)');

-- 작업 명령을 postgres 로 실제 실행 → net.http_post 호출 내용 확인(0002 전역 revoke 뒤에도 실행됨)
do $$ declare c text; begin
  for c in select command from cron.job where jobname like 'sp-%' order by jobname loop
    execute c;
  end loop;
end $$;
select t.ok((select count(*) from net.calls) = 7, 'O6 작업 명령 7개 실행 → http_post 7번');
select t.ok((select array_agg(url order by url) from net.calls) = array[
  'https://cypwcghsxzrnjwtcrbzc.supabase.co/functions/v1/daily-close',
  'https://cypwcghsxzrnjwtcrbzc.supabase.co/functions/v1/daily-close',
  'https://cypwcghsxzrnjwtcrbzc.supabase.co/functions/v1/fx-sync',
  'https://cypwcghsxzrnjwtcrbzc.supabase.co/functions/v1/ref-sync',
  'https://cypwcghsxzrnjwtcrbzc.supabase.co/functions/v1/tax-annual',
  'https://cypwcghsxzrnjwtcrbzc.supabase.co/functions/v1/tick-kr',
  'https://cypwcghsxzrnjwtcrbzc.supabase.co/functions/v1/tick-us'], 'O7 호출 주소');
select t.ok(not exists (select 1 from net.calls where headers->>'x-cron-token' is distinct from (select value from sp.server_kv where key = 'cron_token')),
            'O8 모든 호출에 cron 토큰 헤더');
select t.ok(not exists (select 1 from net.calls where headers->>'apikey' not like 'sb_publishable_%'), 'O9 apikey 는 publishable 키');
select t.ok(not exists (select 1 from net.calls where headers ? 'Authorization'), 'O10 Authorization 헤더 없음(비밀 키를 보내지 않음)');
select t.ok(has_function_privilege('postgres', 'net.http_post(text,jsonb,jsonb,jsonb,integer)', 'EXECUTE')
            and has_function_privilege('postgres', 'cron.schedule(text,text,text)', 'EXECUTE'),
            'O11 전역 revoke(for role postgres) 뒤에도 postgres 가 확장 함수 실행 가능(주인이 다른 역할)');
select t.ok(t.try('민', 'select value from sp.server_kv where key = ''cron_token''') = '42501', 'O12 브라우저 사용자는 cron 토큰을 못 읽음');

\pset footer off
select seq, case when ok then 'PASS' else 'FAIL' end as result, name, detail from t.ops_results order by seq;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from t.ops_results;
do $$ begin
  if exists (select 1 from t.ops_results where not ok) then
    raise exception 'ops tests failed: %', (select count(*) from t.ops_results where not ok);
  end if;
end $$;
