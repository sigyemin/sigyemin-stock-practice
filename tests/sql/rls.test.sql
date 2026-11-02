-- M1 마이그레이션·RLS 시험 (합성 데이터만). tests/sql/run.sh 가 stub → migrations → 이 파일 순서로 실행.
-- 결과는 t.results 에 쌓고, 마지막에 실패가 하나라도 있으면 오류로 끝난다.

create schema t;
grant usage on schema t to public;
create table t.results (seq serial, name text not null, ok boolean not null, detail text);

-- 합성 계정(실제 계정 아님)
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', null),  -- 민 역할
  ('00000000-0000-4000-8000-000000000002', null),  -- 뽀 역할
  ('00000000-0000-4000-8000-000000000009', null);  -- 미등록
-- 허용 계정 등록(운영에서는 사용자가 대시보드 SQL 로 하는 일)
insert into sp.allowed_users (auth_user_id, participant_id, can_fund_bot) values
  ('00000000-0000-4000-8000-000000000001', 1, true),
  ('00000000-0000-4000-8000-000000000002', 2, false);

create function t.act(who text) returns void language plpgsql as $$
declare v_sub text;
begin
  perform set_config('role', 'none', true);
  if who = 'anon' then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('role', 'anon', true);
    return;
  end if;
  v_sub := case who
    when '민' then '00000000-0000-4000-8000-000000000001'
    when '뽀' then '00000000-0000-4000-8000-000000000002'
    when '미등록' then '00000000-0000-4000-8000-000000000009' end;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_sub, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create function t.reset() returns void language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

create function t.check(ok boolean, name text, detail text default null) returns void
language sql as $$ insert into t.results (name, ok, detail) values (name, coalesce(ok, false), detail) $$;

-- 주어진 SQL 을 who 로 실행하고 SQLSTATE 를 돌려준다(성공이면 'ok')
create function t.try(who text, q text) returns text language plpgsql as $$
declare v text;
begin
  perform t.act(who);
  begin
    execute q;
    v := 'ok';
  exception when others then
    v := sqlstate;
  end;
  perform t.reset();
  return v;
end $$;

-- who 로 실행한 count 결과(오류면 -1)
create function t.count_as(who text, q text) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform t.act(who);
  begin
    execute q into n;
  exception when others then
    n := -1;
  end;
  perform t.reset();
  return n;
end $$;

-- 마이그레이션이 함수 기본 PUBLIC 실행 권한을 없앴으므로 시험 도우미는 명시적으로 허용
grant execute on all functions in schema t to public;

-- ═════════ A. 시드·구조 ═════════
select t.check((select count(*) from sp.participants) = 3, 'A1 참가자 3명');
select t.check((select count(*) from sp.accounts) = 6, 'A2 계좌 6개');
select t.check((select count(*) from sp.fund_grants where kind = 'seed') = 6, 'A3 시드 fund_grants 6행');
select t.check((select count(*) from sp.cash_ledger where kind = 'seed') = 6, 'A4 시드 원장 6줄');

select t.check(
  l.total = a.balance and a.balance = case a.currency when 'KRW' then 10000000 else 10000 end,
  format('A5 시드 후 원장 합계 = 잔고 (참가자 %s %s)', a.participant_id, a.currency),
  format('ledger=%s balance=%s', l.total, a.balance))
from sp.accounts a
cross join lateral (select coalesce(sum(amount), 0) as total from sp.cash_ledger c where c.account_id = a.id) l
order by a.participant_id, a.currency;

select t.check((select count(*) from sp.rate_table) >= 20, 'A6 요율표 첫 데이터 입력',
               (select count(*)::text from sp.rate_table));
select t.check(not exists (select 1 from sp.rate_table where source_url = '' or checked_on is null),
               'A7 요율표 모든 행에 근거·확인일');
select t.check(exists (select 1 from sp.rate_bands where code = 'KR_TICK'), 'A8 KR_TICK 구간표');
select t.check((select value from sp.app_settings where key = 'kr_quote_mode') = 'delayed', 'A9 kr_quote_mode=delayed');
select t.check(not exists (select 1 from sp.rate_table r
                            where r.code = 'KR_SEC_TX_TAX' and r.segment = 'KOSPI'
                              and daterange(r.valid_from, r.valid_to, '[]') && daterange('2026-11-02','2026-11-02','[]')
                            group by r.code having count(*) > 1),
               'A10 같은 날 같은 코드 요율 1행(코스피 거래세)');

-- ═════════ B. 익명(anon) ═════════
select t.check(t.try('anon', format('select count(*) from sp.%I', tbl)) = '42501',
               format('B1 anon select sp.%s 거부', tbl), t.try('anon', format('select count(*) from sp.%I', tbl)))
from unnest(array['participants','allowed_users','app_settings','rate_table','rate_bands',
                  'accounts','cash_ledger','fund_grants']) as tbl;
select t.check(t.try('anon', 'select sp.request_fund(1::smallint, ''KRW'', 1)') = '42501', 'B2 anon request_fund 실행 거부');
select t.check(t.try('anon', 'select sp.me()') = '42501', 'B3 anon sp.me() 실행 거부');

-- ═════════ C. 미등록 로그인 계정 ═════════
select t.check(t.count_as('미등록', 'select count(*) from sp.accounts') = 0, 'C1 미등록 accounts 0행');
select t.check(t.count_as('미등록', 'select count(*) from sp.allowed_users') = 0, 'C2 미등록 allowed_users 0행');
select t.check(t.count_as('미등록', 'select count(*) from sp.rate_table') = 0, 'C3 미등록 rate_table 0행');
select t.check(t.count_as('미등록', 'select count(*) from (select sp.me() as m) x where m is null') = 1, 'C4 미등록 sp.me() = null');
select t.check(t.try('미등록', 'select sp.request_fund(1::smallint, ''KRW'', 1000)') = '42501', 'C5 미등록 request_fund 거부');

-- ═════════ D. 민·뽀 읽기 ═════════
select t.check(t.count_as('민', 'select count(*) from sp.accounts') = 6, 'D1 민 accounts 6행(세 참가자 모두)');
select t.check(t.count_as('뽀', 'select count(*) from sp.accounts') = 6, 'D2 뽀 accounts 6행');
select t.check(t.count_as('민', 'select count(*) from sp.participants') = 3, 'D3 민 participants 3행');
select t.check(t.count_as('민', 'select count(*) from sp.allowed_users') = 1, 'D4 민 allowed_users 본인 1행만');
select t.check(t.count_as('민', 'select count(*) from (select sp.me() as m) x where m = 1') = 1, 'D5 민 sp.me() = 1');
select t.check(t.count_as('뽀', 'select count(*) from (select sp.me() as m) x where m = 2') = 1, 'D6 뽀 sp.me() = 2');
select t.check(t.count_as('민', 'select count(*) from sp.rate_table') >= 20, 'D7 민 rate_table 읽기');

-- ═════════ E. 브라우저 직접 쓰기 거부 ═════════
select t.check(t.try(who, q) = '42501', format('E %s: %s 거부', who, label), t.try(who, q))
from (values
  ('뽀', 'fund_grants insert(to=봇)',
   'insert into sp.fund_grants (participant_id, granted_by, currency, amount, kind) values (3, 2, ''KRW'', 1000, ''add_fund'')'),
  ('민', 'fund_grants insert(to=본인)',
   'insert into sp.fund_grants (participant_id, granted_by, currency, amount, kind) values (1, 1, ''KRW'', 1000, ''add_fund'')'),
  ('민', 'cash_ledger insert',
   'insert into sp.cash_ledger (account_id, kind, amount) select id, ''adjust'', 1000 from sp.accounts where participant_id = 1 and currency = ''KRW'''),
  ('뽀', 'cash_ledger insert',
   'insert into sp.cash_ledger (account_id, kind, amount) select id, ''adjust'', 1000 from sp.accounts where participant_id = 2 and currency = ''KRW'''),
  ('민', 'accounts update', 'update sp.accounts set balance = balance + 1 where participant_id = 1'),
  ('뽀', 'accounts update', 'update sp.accounts set balance = balance + 1 where participant_id = 2'),
  ('민', 'accounts insert', 'insert into sp.accounts (participant_id, currency) values (1, ''KRW'')'),
  ('뽀', 'accounts delete', 'delete from sp.accounts where participant_id = 2'),
  ('뽀', 'cash_ledger delete', 'delete from sp.cash_ledger'),
  ('뽀', 'allowed_users 자기 권한 올리기', 'update sp.allowed_users set can_fund_bot = true'),
  ('미등록', 'allowed_users 자기 등록',
   'insert into sp.allowed_users (auth_user_id, participant_id) values (''00000000-0000-4000-8000-000000000009'', 3)'),
  ('민', 'app_settings update', 'update sp.app_settings set value = ''realtime'' where key = ''kr_quote_mode'''),
  ('민', 'rate_table insert',
   'insert into sp.rate_table (code, market, value, unit, valid_from, source_url, checked_on) values (''X'', ''KR'', 0, ''ratio'', ''2026-01-01'', ''x'', ''2026-01-01'')'),
  ('민', 'sp.grant 직접 실행', 'select sp.grant(1::smallint, ''KRW'', 1000, ''add_fund'', 1::smallint)'),
  ('뽀', 'sp.grant 직접 실행(봇)', 'select sp.grant(3::smallint, ''KRW'', 1000, ''add_fund'', 1::smallint)')
) as x(who, label, q);

-- 위 거부 시험들로 잔고가 바뀌지 않았는지
select t.check((select sum(balance) from sp.accounts where currency = 'KRW') = 30000000, 'E99 거부 시험 뒤 원화 잔고 변화 없음');

-- ═════════ F. 추가 자금 sp.request_fund(사용자 JWT) ═════════
select t.check(t.try('민', 'select sp.request_fund(3::smallint, ''KRW'', 1000000)') = 'ok', 'F1 민→봇 KRW 1,000,000 성공');
select t.check((select balance from sp.accounts where participant_id = 3 and currency = 'KRW') = 11000000, 'F2 봇 KRW 잔고 11,000,000');
select t.check((select granted_by from sp.fund_grants where kind = 'add_fund' and participant_id = 3 order by id desc limit 1) = 1,
               'F3 봇 지급 기록 granted_by = 민');
select t.check(t.try('뽀', 'select sp.request_fund(3::smallint, ''KRW'', 1000)') = '42501', 'F4 뽀→봇 거부');
select t.check(t.try('뽀', 'select sp.request_fund(2::smallint, ''USD'', 500.25)') = 'ok', 'F5 뽀→뽀 USD 500.25 성공');
select t.check((select balance from sp.accounts where participant_id = 2 and currency = 'USD') = 10500.25, 'F6 뽀 USD 잔고 10,500.25');
select t.check(t.try('뽀', 'select sp.request_fund(1::smallint, ''KRW'', 1000)') = '42501', 'F7 뽀→민 거부');
select t.check(t.try('민', 'select sp.request_fund(2::smallint, ''KRW'', 1000)') = '42501', 'F8 민→뽀 거부');
select t.check(t.try('민', 'select sp.request_fund(1::smallint, ''KRW'', 2000)') = 'ok', 'F9 민→민 성공');

select t.check(t.try('민', format('select sp.request_fund(%s::smallint, %L, %s)', p, c, a)) = '22023',
               format('F10 잘못된 입력 거부: %s', label),
               t.try('민', format('select sp.request_fund(%s::smallint, %L, %s)', p, c, a)))
from (values
  ('음수 원', 1, 'KRW', '-1000'),
  ('0원', 1, 'KRW', '0'),
  ('소수 원', 1, 'KRW', '1.5'),
  ('달러 소수 3자리', 1, 'USD', '1.005'),
  ('원화 1회 상한 초과', 1, 'KRW', '100000001'),
  ('달러 1회 상한 초과', 1, 'USD', '100000.01'),
  ('없는 통화', 1, 'EUR', '1000'),
  ('없는 참가자', 9, 'KRW', '1000')
) as x(label, p, c, a);

select t.check(
  l.total = a.balance,
  format('F11 추가 자금 뒤 원장 합계 = 잔고 (참가자 %s %s)', a.participant_id, a.currency),
  format('ledger=%s balance=%s', l.total, a.balance))
from sp.accounts a
cross join lateral (select coalesce(sum(amount), 0) as total from sp.cash_ledger c where c.account_id = a.id) l
order by a.participant_id, a.currency;

-- ═════════ G. 제약·트리거(서버 쪽 쓰기) ═════════
do $$ declare v text; begin
  begin
    insert into sp.cash_ledger (account_id, kind, amount)
    select id, 'adjust', -20000 from sp.accounts where participant_id = 1 and currency = 'USD';
    v := 'ok';
  exception when others then v := sqlstate; end;
  perform t.check(v = '23514', 'G1 USD 계좌를 음수로 만드는 원장 insert 실패(check)', v);
end $$;

do $$ declare v text; b numeric; begin
  begin
    insert into sp.cash_ledger (account_id, kind, amount)
    select id, 'adjust', -20000000 from sp.accounts where participant_id = 1 and currency = 'KRW';
    select balance into b from sp.accounts where participant_id = 1 and currency = 'KRW';
    raise exception 'rollback' using errcode = 'P0099';
  exception when sqlstate 'P0099' then v := 'ok';
            when others then v := sqlstate; end;
  perform t.check(v = 'ok' and b < 0, 'G2 KRW 계좌는 음수 허용', format('%s balance=%s', v, b));
end $$;

do $$ declare v text; begin
  begin
    update sp.cash_ledger set amount = amount + 1 where id = (select min(id) from sp.cash_ledger);
    v := 'ok';
  exception when others then v := sqlstate; end;
  perform t.check(v = '42501', 'G3 원장 update 금지(append-only)', v);
  begin
    delete from sp.cash_ledger where id = (select min(id) from sp.cash_ledger);
    v := 'ok';
  exception when others then v := sqlstate; end;
  perform t.check(v = '42501', 'G4 원장 delete 금지(append-only)', v);
end $$;

do $$ declare v text; begin
  begin
    truncate sp.cash_ledger cascade;
    v := 'ok';
  exception when others then v := sqlstate; end;
  perform t.check(v = '42501', 'G5 원장 truncate 금지(소유자도)', v);
end $$;
select t.check((select count(*) from sp.cash_ledger) > 0, 'G6 truncate 시도 뒤 원장 그대로');

-- ═════════ H. 함수 실행 권한 ═════════
-- 앞으로 만들 함수: 기본 권한으로 PUBLIC EXECUTE 가 붙지 않아야 한다(리뷰 M1 재현)
create function sp.future_fn() returns int language sql security definer set search_path = '' as $$ select 1 $$;
select t.check(t.try('미등록', 'select sp.future_fn()') = '42501', 'H1 새로 만든 sp 함수: 미등록 authenticated 실행 거부',
               t.try('미등록', 'select sp.future_fn()'));
select t.check(t.try('anon', 'select sp.future_fn()') = '42501', 'H2 새로 만든 sp 함수: anon 실행 거부');
select t.check(exists (select 1 from pg_default_acl d where d.defaclobjtype = 'f' and d.defaclnamespace = 0
                         and d.defaclrole = 'postgres'::regrole),
               'H3 pg_default_acl 에 함수 전역 기본 권한 항목 있음');
drop function sp.future_fn();

-- sp 의 모든 함수: PUBLIC·anon EXECUTE 없음, authenticated 는 허용 목록만
-- (함수가 늘면 아래 허용 목록만 갱신)
select t.check(
  not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')
    and p.proacl is not null
    and not has_function_privilege('anon', p.oid, 'EXECUTE')
    and has_function_privilege('authenticated', p.oid, 'EXECUTE') = (p.proname in ('me', 'request_fund')),
  format('H4 sp.%s(%s) 실행 권한: PUBLIC·anon 없음, authenticated %s', p.proname, pg_get_function_identity_arguments(p.oid),
         case when p.proname in ('me', 'request_fund') then '허용' else '없음' end),
  coalesce(p.proacl::text, 'proacl null(기본 권한 = PUBLIC)'))
from pg_proc p
where p.pronamespace = 'sp'::regnamespace
order by p.proname;
select t.check((select count(*) from pg_proc where pronamespace = 'sp'::regnamespace) >= 5, 'H5 sp 함수 검사 대상 5개 이상',
               (select count(*)::text from pg_proc where pronamespace = 'sp'::regnamespace));

-- ═════════ 결과 ═════════
\pset footer off
select seq, case when ok then 'PASS' else 'FAIL' end as result, name, detail from t.results order by seq;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from t.results;

do $$ begin
  if exists (select 1 from t.results where not ok) then
    raise exception 'SQL tests failed: %', (select count(*) from t.results where not ok);
  end if;
end $$;
