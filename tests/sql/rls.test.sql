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
  if who = '서버' then
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    perform set_config('role', 'service_role', true);
    return;
  end if;
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
                  'accounts','cash_ledger','fund_grants',
                  'instruments','market_calendar','quotes','candles','fx_rates','watchlist','drawings','server_kv']) as tbl;
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

-- ═════════ I. M2 시세·차트 (0004) ═════════
-- 합성 종목·시세(실제 종목 아님)
insert into sp.instruments (market, symbol, name, exchange, currency) values
  ('KR', '999990', '시험종목가', 'KOSPI', 'KRW'),
  ('KR', '999991', '시험종목나', 'KOSDAQ', 'KRW'),
  ('US', 'TSTA', 'Test Alpha', 'NASDAQ', 'USD');
insert into sp.quotes (market, symbol, price, mode, quote_at, source) values ('KR', '999990', 70000, 'realtime', now(), 'test');
insert into sp.candles (market, symbol, tf, t, o, h, l, c, v, source) values
  ('KR', '999990', '1m', '2026-11-04 00:01:00+00', 70000, 70100, 69900, 70050, 10, 'test');
insert into sp.fx_rates (rate_date, usdkrw, source) values ('2026-11-03', 1400, 'test');

select t.check(t.count_as(who, format('select count(*) from sp.%I', tbl)) = 1,
               format('I1 %s 가 sp.%s 읽기(1행)', who, tbl))
from (values ('민'), ('뽀')) as w(who)
cross join unnest(array['quotes','candles','fx_rates']) as tbl;
select t.check(t.count_as('민', 'select count(*) from sp.instruments') = 3, 'I2 민 instruments 3행');
select t.check(t.count_as('미등록', format('select count(*) from sp.%I', tbl)) = 0, format('I3 미등록 sp.%s 0행', tbl))
from unnest(array['instruments','quotes','candles','fx_rates','market_calendar','drawings']) as tbl;

-- 관심 종목: 본인 것만 쓰고 본인 것만 보임
select t.check(t.try('민', 'insert into sp.watchlist (participant_id, market, symbol) values (1, ''KR'', ''999990'')') = 'ok', 'I4 민 관심 종목 추가(본인)');
select t.check(t.try('뽀', 'insert into sp.watchlist (participant_id, market, symbol) values (2, ''US'', ''TSTA'')') = 'ok', 'I5 뽀 관심 종목 추가(본인)');
select t.check(t.try('민', 'insert into sp.watchlist (participant_id, market, symbol) values (2, ''KR'', ''999991'')') = '42501', 'I6 민이 뽀 관심 종목 추가 거부');
select t.check(t.count_as('뽀', 'select count(*) from sp.watchlist') = 1, 'I7 뽀는 본인 관심 종목만 보임');
select t.check(t.try('뽀', 'delete from sp.watchlist where participant_id = 1') = 'ok', 'I8a 뽀의 민 관심 종목 delete 문 실행(오류 없이 0행)');
select t.check((select count(*) from sp.watchlist where participant_id = 1) = 1, 'I8 뽀가 민 관심 종목 삭제 못 함');

-- 그림
select t.check(t.try('민', 'insert into sp.drawings (participant_id, market, symbol, tf, tool, points) values (1, ''KR'', ''999990'', ''1d'', ''trendline'', ''[{"t":"2026-11-02T00:00:00Z","p":70000},{"t":"2026-11-03T00:00:00Z","p":71000}]'')') = 'ok',
               'I9 민 그림 저장(본인)');
select t.check(t.try('민', 'insert into sp.drawings (participant_id, market, symbol, tf, tool, points) values (2, ''KR'', ''999990'', ''1d'', ''hline'', ''[{"p":1}]'')') = '42501',
               'I10 민이 뽀 이름으로 그림 저장 거부');
select t.check(t.count_as('뽀', 'select count(*) from sp.drawings') = 1, 'I11 뽀도 민 그림을 볼 수 있음');
select t.check(t.try('뽀', 'update sp.drawings set label = ''x'' where participant_id = 1') = 'ok', 'I12a 뽀의 민 그림 update 문 실행(오류 없이 0행)');
select t.check((select label from sp.drawings where participant_id = 1) is null, 'I12 뽀가 민 그림 수정 못 함');
select t.check(t.try('뽀', 'delete from sp.drawings where participant_id = 1') = 'ok', 'I13a 뽀의 민 그림 delete 문 실행(오류 없이 0행)');
select t.check((select count(*) from sp.drawings) = 1, 'I13 뽀가 민 그림 삭제 못 함');
do $$ declare before timestamptz; v text; begin
  select updated_at into before from sp.drawings where participant_id = 1;
  perform pg_sleep(0.01);
  v := t.try('민', 'update sp.drawings set label = ''추세선'' where participant_id = 1');
  perform t.check(v = 'ok' and (select updated_at from sp.drawings where participant_id = 1) > before
                  and (select label from sp.drawings where participant_id = 1) = '추세선',
                  'I14 민 본인 그림 수정 + updated_at 트리거 동작(실행 권한 없이)', v);
end $$;
select t.check(t.try('민', 'update sp.drawings set participant_id = 2 where participant_id = 1') = '42501', 'I15 그림 주인 바꾸기 거부(열 권한)');
select t.check(t.try('민', 'insert into sp.drawings (participant_id, market, symbol, tf, tool, points) values (1, ''KR'', ''999990'', ''1d'', ''ray'', (select jsonb_agg(jsonb_build_object(''p'', g)) from generate_series(1, 11) g))') = '23514',
               'I16 그림 점 11개 거부(check)');
select t.check(t.try('민', 'delete from sp.drawings where participant_id = 1') = 'ok', 'I17a 민 본인 그림 delete');
select t.check((select count(*) from sp.drawings) = 0, 'I17 민 본인 그림 삭제됨');

-- 시세 테이블 브라우저 쓰기 거부
select t.check(t.try('민', q) = '42501', format('I18 민 %s 거부', label), t.try('민', q))
from (values
  ('quotes update', 'update sp.quotes set price = 1'),
  ('candles insert', 'insert into sp.candles (market, symbol, tf, t, o, h, l, c, source) values (''KR'',''999990'',''1d'',now(),1,1,1,1,''x'')'),
  ('instruments insert', 'insert into sp.instruments (market, symbol, name, exchange, currency) values (''KR'',''999992'',''x'',''KOSPI'',''KRW'')'),
  ('fx_rates insert', 'insert into sp.fx_rates (rate_date, usdkrw, source) values (''2026-11-04'', 1, ''x'')'),
  ('market_calendar update', 'update sp.market_calendar set is_open = true'),
  ('server_kv select', 'select count(*) from sp.server_kv')
) as x(label, q);

-- 서버(service_role): 시세 쓰기·server_kv 만, 돈 테이블·함수는 없음
select t.check(t.try('서버', q) = 'ok', format('I19 서버 %s 허용', label), t.try('서버', q))
from (values
  ('quotes upsert', 'insert into sp.quotes (market, symbol, price, mode, quote_at, source) values (''US'',''TSTA'',200,''realtime'',now(),''test'') on conflict (market, symbol) do update set price = excluded.price'),
  ('candles insert', 'insert into sp.candles (market, symbol, tf, t, o, h, l, c, source) values (''US'',''TSTA'',''1m'',now(),1,2,1,2,''test'')'),
  ('instruments insert', 'insert into sp.instruments (market, symbol, name, exchange, currency) values (''KR'',''999993'',''시험종목다'',''KOSPI'',''KRW'')'),
  ('fx_rates insert', 'insert into sp.fx_rates (rate_date, usdkrw, source) values (''2026-11-04'', 1401.5, ''test'')'),
  ('server_kv upsert', 'insert into sp.server_kv (key, value) values (''kis_token'', ''x'') on conflict (key) do update set value = excluded.value'),
  ('watchlist select', 'select count(*) from sp.watchlist'),
  ('app_settings select', 'select count(*) from sp.app_settings')
) as x(label, q);
select t.check(t.try('서버', q) = '42501', format('I20 서버 %s 거부', label), t.try('서버', q))
from (values
  ('accounts select', 'select count(*) from sp.accounts'),
  ('cash_ledger insert', 'insert into sp.cash_ledger (account_id, kind, amount) values (1, ''adjust'', 1)'),
  ('fund_grants select', 'select count(*) from sp.fund_grants'),
  ('allowed_users select', 'select count(*) from sp.allowed_users'),
  ('sp.grant 실행', 'select sp.grant(1::smallint, ''KRW'', 1, ''add_fund'', 1::smallint)'),
  ('sp.request_fund 실행', 'select sp.request_fund(1::smallint, ''KRW'', 1)'),
  ('watchlist insert', 'insert into sp.watchlist (participant_id, market, symbol) values (3, ''KR'', ''999990'')'),
  ('drawings insert', 'insert into sp.drawings (participant_id, market, symbol, tf, tool, points) values (3, ''KR'', ''999990'', ''1d'', ''hline'', ''[{"p":1}]'')')
) as x(label, q);

-- 제약
select t.check(t.try('서버', 'insert into sp.candles (market, symbol, tf, t, o, h, l, c, source) values (''US'',''TSTA'',''1d'',now(),5,4,6,5,''x'')') = '23514', 'I21 고가<저가 봉 거부(check)');
select t.check(t.try('서버', 'insert into sp.instruments (market, symbol, name, exchange, currency) values (''KR'',''ABC'',''x'',''KOSPI'',''KRW'')') = '23514', 'I22 KR 종목코드 형식 거부');
select t.check(t.try('서버', 'insert into sp.quotes (market, symbol, price, mode, quote_at, source) values (''KR'',''000000'',1,''realtime'',now(),''x'')') = '23503', 'I23 없는 종목 시세 거부(FK)');

-- 달력·설정
select t.check((select count(*) from sp.market_calendar where market = 'US' and not is_open) = 20, 'I24 NYSE 휴장일 2026·2027 20일');
select t.check((select close_at from sp.market_calendar where market = 'US' and trade_date = '2026-11-27') = '2026-11-27 18:00:00+00',
               'I25 2026-11-27 조기폐장 13:00 ET = 18:00 UTC');
select t.check((select close_at from sp.market_calendar where market = 'US' and trade_date = '2026-12-24') = '2026-12-24 18:00:00+00',
               'I26 2026-12-24 조기폐장 13:00 ET');
select t.check((select value from sp.app_settings where key = 'kr_quote_mode') = 'delayed', 'I27 0004 뒤에도 kr_quote_mode 값 그대로');
select t.check((select count(*) from sp.app_settings where key in ('tick_max_symbols_kr','tick_max_symbols_us','tick_time_budget_ms','kis_call_gap_ms','backfill_days_1d')) = 5,
               'I28 M2 설정값 5개');
select t.check(not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                            where n.nspname = 'public' and c.relkind in ('r','v','m','S','f','p'))
               and not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace),
               'I29 public 스키마에 만든 것 없음');

-- ═════════ J. sp.kv_claim (0005, KIS 토큰 발급 간격 원자화) ═════════
delete from sp.server_kv where key = 'kis_token_issue_at';
select t.check(t.count_as('서버', 'select count(*) from (select sp.kv_claim(''kis_token_issue_at'', 65000) as ok) x where ok') = 1, 'J1 처음 claim 성공(행 생성)');
select t.check(t.count_as('서버', 'select count(*) from (select sp.kv_claim(''kis_token_issue_at'', 65000) as ok) x where ok') = 0, 'J2 간격 안 두 번째 claim 실패');
select t.check(t.count_as('서버', 'select count(*) from (select sp.kv_claim(''kis_token_issue_at'', 0) as ok) x where ok') = 1, 'J3 간격 0 이면 다시 성공');
update sp.server_kv set updated_at = now() - interval '66 seconds' where key = 'kis_token_issue_at';
select t.check(t.count_as('서버', 'select count(*) from (select sp.kv_claim(''kis_token_issue_at'', 65000) as ok) x where ok') = 1, 'J4 66초 지나면 성공');
select t.check(t.count_as('서버', 'select count(*) from (select sp.kv_claim(''kis_token_issue_at'', 65000) as ok) x where ok') = 0, 'J5 바로 다시 하면 실패');
-- 한 문장 안에서 두 번 claim(같은 스냅샷이라도 두 번째는 실패해야 함)
delete from sp.server_kv where key = 'kis_token_issue_at';
select t.check(t.count_as('서버', 'select count(*) from (select sp.kv_claim(''kis_token_issue_at'', 65000) as a, sp.kv_claim(''kis_token_issue_at'', 65000) as b) x where a and not b') = 1,
               'J6 같은 문장의 두 번째 claim 실패');
select t.check(t.try('민', 'select sp.kv_claim(''kis_token_issue_at'', 1)') = '42501', 'J7 브라우저 사용자 실행 거부');
select t.check(t.try('anon', 'select sp.kv_claim(''kis_token_issue_at'', 1)') = '42501', 'J8 anon 실행 거부');
select t.check(t.try('서버', 'select sp.kv_claim(''kis_token_issue_at'', -1)') = '22023', 'J9 음수 간격 거부');
-- 0006: 허용 키 하나만(cron_token·kis_token 등 다른 행 덮어쓰기 금지)
insert into sp.server_kv (key, value) values ('cron_token', repeat('a', 64)) on conflict (key) do update set value = excluded.value;
select t.check(t.try('서버', q) = '22023', format('J10 다른 키 claim 거부: %s', k), t.try('서버', q))
from (values ('cron_token'), ('kis_token'), ('kis_token_bad_until'), ('claim_test'), ('')) as v(k)
cross join lateral (select format('select sp.kv_claim(%L, 0)', k) as q) x;
select t.check(t.try('서버', 'select sp.kv_claim(null, 0)') = '22023', 'J11 null 키 거부');
select t.check((select value from sp.server_kv where key = 'cron_token') = repeat('a', 64), 'J12 cron_token 값 그대로');
delete from sp.server_kv where key = 'cron_token';  -- 뒤 ops 시험이 새로 만든다

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
    and has_function_privilege('service_role', p.oid, 'EXECUTE') = (p.proname in ('kv_claim', 'process_orders', 'expire_orders', 'place_order_bot'))
    and has_function_privilege('authenticated', p.oid, 'EXECUTE') = (p.proname in ('me', 'request_fund', 'place_order', 'cancel_order')),
  format('H4 sp.%s(%s) 실행 권한: PUBLIC·anon 없음, authenticated %s, service_role %s', p.proname, pg_get_function_identity_arguments(p.oid),
         case when p.proname in ('me', 'request_fund', 'place_order', 'cancel_order') then '허용' else '없음' end,
         case when p.proname in ('kv_claim', 'process_orders', 'expire_orders', 'place_order_bot') then '허용' else '없음' end),
  coalesce(p.proacl::text, 'proacl null(기본 권한 = PUBLIC)'))
from pg_proc p
where p.pronamespace = 'sp'::regnamespace
order by p.proname;
select t.check((select count(*) from pg_proc where pronamespace = 'sp'::regnamespace) >= 8, 'H5 sp 함수 검사 대상 8개 이상',
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
