-- M4 환전·배당·양도세 시험(0008). orders.test.sql 다음에 실행(t.po·t.quote·t.candle·t.try 사용). 합성 데이터만.
create table t.m4_results (seq serial, name text not null, ok boolean not null, detail text);
create function t.m4(c boolean, n text, d text default null) returns void language sql as
$$ insert into t.m4_results (name, ok, detail) values (n, coalesce(c, false), d) $$;
create function t.fx(p_pid smallint, p_dir text, p_amt numeric, p_now timestamptz, p_dry boolean default false) returns jsonb language plpgsql as $$
begin
  return sp._fx_convert(p_pid, p_dir, p_amt, p_dry, 'user', p_now);
exception when others then
  return jsonb_build_object('error', sqlerrm, 'state', sqlstate);
end $$;
grant execute on all functions in schema t to public;
\o /dev/null
update sp.app_settings set value = 'realtime' where key = 'kr_quote_mode';

-- ═════════ X. 환전(설계서 §4.4) ═════════
-- 2026-11-03 한국 → 그날 기준 1,400 (rls 시험이 넣은 합성 값)
do $$ declare r jsonb; k0 numeric; u0 numeric; begin
  select balance into k0 from sp.accounts where participant_id = 2 and currency = 'KRW';
  select balance into u0 from sp.accounts where participant_id = 2 and currency = 'USD';
  r := t.fx(2::smallint, 'KRW_TO_USD', 1000000, '2026-11-03 03:00:00+00');
  perform t.m4((r->>'usd_amount')::numeric = 713.57 and (r->>'applied_rate')::numeric = 1401.4, 'X1 1,000,000원 @기준 1,400 → 적용 1,401.4 → $713.57', r::text);
  perform t.m4(k0 - (select balance from sp.accounts where participant_id = 2 and currency = 'KRW') = 1000000
               and (select balance from sp.accounts where participant_id = 2 and currency = 'USD') - u0 = 713.57, 'X2 원장: 원화 −1,000,000 / 달러 +713.57');
  r := t.fx(2::smallint, 'USD_TO_KRW', 100, '2026-11-03 03:00:00+00');
  perform t.m4((r->>'krw_amount')::numeric = 139860 and (r->>'applied_rate')::numeric = 1398.6, 'X3 $100 @1,400 → 적용 1,398.6 → 139,860원', r::text);
  r := t.fx(2::smallint, 'KRW_TO_USD', 10000, '2026-11-08 03:00:00+00', true);
  perform t.m4(r->>'base_rate_date' = '2026-11-04', 'X4 그날 고시값이 없으면(일요일) 직전 고시값', r::text);
  perform t.m4(t.fx(2::smallint, 'KRW_TO_USD', 10000, '2026-11-25 03:00:00+00')->>'error' = 'fx_stale', 'X5 고시값이 7일보다 오래되면 거부(fx_max_age_days)');
end $$;
select t.m4(t.fx(2::smallint, 'KRW_TO_USD', v, '2026-11-03 03:00:00+00')->>'error' = e, format('X6 입력 거부: %s → %s', v, e))
from (values (1.5::numeric, 'invalid_amount'), (0, 'invalid_amount'), ('NaN'::numeric, 'invalid_amount'), (1, 'amount_too_small'),
             (1000000000, 'insufficient_funds')) as x(v, e);
select t.m4(t.fx(2::smallint, 'USD_TO_KRW', 1.005, '2026-11-03 03:00:00+00')->>'error' = 'invalid_amount', 'X7 달러 소수 3자리 거부');
select t.m4(t.fx(2::smallint, 'SIDEWAYS', 1, '2026-11-03 03:00:00+00')->>'error' = 'invalid_direction', 'X8 방향 거부');
select t.m4(t.try('anon', 'select sp.fx_convert(''KRW_TO_USD'', 10000, true)') = '42501', 'X9 anon 환전 거부');
select t.m4(t.try('미등록', 'select sp.fx_convert(''KRW_TO_USD'', 10000, true)') = '42501', 'X10 미등록 환전 거부');
select t.m4(t.try('민', 'select sp.fx_convert(''KRW_TO_USD'', 10000, true)') <> '42501', 'X11 민 환전 함수 실행 가능');
select t.m4(t.try('민', 'select sp._fx_convert(3::smallint, ''KRW_TO_USD'', 10000, false, ''bot'', now())') = '42501', 'X12 민이 내부 함수로 봇 계좌 환전 거부');
select t.m4(t.try('서버', 'select sp.fx_convert_bot(1::smallint, ''KRW_TO_USD'', 10000)') = '42501', 'X13 봇 환전 함수로 사람 계좌 거부');
select t.m4(t.try('민', 'insert into sp.fx_conversions (participant_id, direction, base_rate, base_rate_date, applied_rate, krw_amount, usd_amount, rate_ids) values (1, ''KRW_TO_USD'', 1, now(), 1, 1, 1, ''{}'')') = '42501',
            'X14 환전 기록 직접 쓰기 거부');

-- 이후 시험용 고시값(11-11·11-13 만 있음 → 11-12 는 직전 11-11 값)
insert into sp.fx_rates (rate_date, usdkrw, source) values ('2026-11-11', 1400, 'test'), ('2026-11-13', 1450, 'test') on conflict do nothing;

-- ═════════ D. 배당(설계서 §4.3) ═════════
-- 한국 999993: 기준일 2026-11-13(금), 락일 미상 → 직전 거래일 11-12 → 권리 판정 = 11-11(수) 15:30 마감 보유
-- 미국 TSTA: 기준일 11-13, 락일 11-12 → 판정 = 11-11 16:00 ET 보유
do $$ declare r jsonb; begin
  perform t.quote('KR', '999993', 1000, '2026-11-10 00:59:50+00');
  r := t.po(1::smallint, 'KR', '999993', 'buy', 'market', 100, null, '2026-11-10 01:00:00+00');
  perform t.m4(r->>'status' = 'filled', 'D0a 민 999993 100주 매수(락일 전)', r::text);
  r := t.po(3::smallint, 'KR', '999993', 'buy', 'market', 50, null, '2026-11-10 01:00:00+00');
  perform t.m4(r->>'status' = 'filled', 'D0b 봇 50주 매수(락일 전)', r::text);
  perform t.quote('KR', '999993', 1000, '2026-11-12 00:59:50+00');
  r := t.po(2::smallint, 'KR', '999993', 'buy', 'market', 100, null, '2026-11-12 01:00:00+00');
  perform t.m4(r->>'status' = 'filled', 'D0c 뽀 100주 매수(락일 당일)', r::text);
  r := t.po(3::smallint, 'KR', '999993', 'sell', 'market', 50, null, '2026-11-12 01:00:00+00');
  perform t.m4(r->>'status' = 'filled', 'D0d 봇 락일 당일 50주 매도', r::text);
  perform t.quote('US', 'TSTA', 200, '2026-11-10 14:59:50+00');
  r := t.po(1::smallint, 'US', 'TSTA', 'buy', 'market', 10, null, '2026-11-10 15:00:00+00');
  perform t.m4(r->>'status' = 'filled', 'D0e 민 TSTA 10주 매수 $200', r::text);
end $$;

select t.m4(sp.upsert_dividend_events('[
  {"market":"KR","symbol":"999993","ex_date":null,"record_date":"2026-11-13","pay_date":"2026-11-20","cash_per_share":361,"source":"test"},
  {"market":"US","symbol":"TSTA","ex_date":"2026-11-12","record_date":"2026-11-13","pay_date":"2026-11-20","cash_per_share":0.26,"source":"test"},
  {"market":"KR","symbol":"000000","record_date":"2026-11-13","pay_date":"2026-11-20","cash_per_share":1,"source":"test"}
]'::jsonb) = 2, 'D1 배당 일정 2건 저장(없는 종목은 건너뜀)');
select t.m4(sp.dividend_ex_date('KR', '2026-11-13', null) = '2026-11-12', 'D2 락일 미상 → 기준일 직전 거래일');
select t.m4(sp.dividend_cutoff('KR', '2026-11-13', null) = '2026-11-11 06:30:00+00', 'D3 권리 판정 = 락일 전날 15:30 마감');
select t.m4(sp.dividend_cutoff('US', '2026-11-13', '2026-11-12') = '2026-11-11 21:00:00+00', 'D4 미국 판정 = 락일 전날 16:00 ET');

do $$ declare n0 bigint; begin
  perform sp.daily_close('2026-11-11 06:00:00+00');
  perform t.m4((select count(*) from sp.dividend_payouts) = 0, 'D5 판정 시각 전에는 권리 없음');
  perform sp.daily_close('2026-11-11 21:30:00+00');
  perform t.m4((select qty_at_record from sp.dividend_payouts p join sp.dividend_events e on e.id = p.event_id
                 where e.symbol = '999993' and p.participant_id = 1) = 100, 'D6 민 권리 100주');
  perform t.m4(not exists (select 1 from sp.dividend_payouts p join sp.dividend_events e on e.id = p.event_id
                 where e.symbol = '999993' and p.participant_id = 2), 'D7 락일 당일 매수(뽀)는 권리 없음');
  perform t.m4((select qty_at_record from sp.dividend_payouts p join sp.dividend_events e on e.id = p.event_id
                 where e.symbol = '999993' and p.participant_id = 3) = 50, 'D8 락일 당일 매도(봇)도 권리 있음');
  -- 권리가 생긴 뒤에는 일정 금액이 바뀌지 않는다
  perform sp.upsert_dividend_events('[{"market":"KR","symbol":"999993","record_date":"2026-11-13","pay_date":"2026-11-20","cash_per_share":999,"source":"test2"}]'::jsonb);
  perform t.m4((select cash_per_share from sp.dividend_events where symbol = '999993') = 361, 'D9 권리 확정 뒤 일정 덮어쓰기 안 됨');
  perform sp.daily_close('2026-11-19 07:00:00+00');
  perform t.m4((select count(*) from sp.dividend_payouts where status = 'paid') = 0, 'D10 지급일 전에는 입금 없음');
  select count(*) into n0 from sp.cash_ledger;
  perform sp.daily_close('2026-11-20 00:30:00+00');   -- 11-20 09:30 한국 / 미국은 아직 11-19
  perform t.m4((select net from sp.dividend_payouts p join sp.dividend_events e on e.id = p.event_id where e.symbol = '999993' and p.participant_id = 1) = 30541
               and (select withheld from sp.dividend_payouts p join sp.dividend_events e on e.id = p.event_id where e.symbol = '999993' and p.participant_id = 1) = 5559,
               'D11 361원 × 100주 = 36,100 → 소득세 5,054 + 지방세 505 → 30,541원 입금');
  perform t.m4((select net from sp.dividend_payouts p join sp.dividend_events e on e.id = p.event_id where e.symbol = '999993' and p.participant_id = 3) = 15271,
               'D12 봇 50주: 18,050 → 2,527 + 252 → 15,271원');
  perform t.m4((select status from sp.dividend_payouts p join sp.dividend_events e on e.id = p.event_id where e.symbol = 'TSTA' and p.participant_id = 1) = 'entitled',
               'D13 미국 지급일은 미국 날짜 기준(아직 11-19)');
  perform sp.daily_close('2026-11-20 15:00:00+00');
  perform t.m4((select gross || '/' || withheld || '/' || net from sp.dividend_payouts p join sp.dividend_events e on e.id = p.event_id where e.symbol = 'TSTA' and p.participant_id = 1) = '2.60/0.39/2.21',
               'D14 미국 $0.26 × 10주 = $2.60 → 15% 원천 $0.39 → $2.21(달러 입금)');
  perform sp.daily_close('2026-11-21 15:00:00+00');
  perform t.m4((select count(*) from sp.cash_ledger where kind in ('dividend','dividend_tax')) = 2 * (select count(*) from sp.dividend_payouts where status = 'paid'), 'D15 다시 돌려도 두 번 지급 안 됨(지급마다 2줄)');
end $$;

-- ═════════ G. 해외주식 양도세(설계서 §4.2) ═════════
select t.m4(c.tax = 220000 and c.deduction = 2500000, 'G1 손익 합계 3,500,000 → 공제 250만 → 과세 1,000,000 × 22% = 220,000원', c.tax::text)
from sp.cgt_compute(4000000 - 500000, 2026) c;
select t.m4((sp.cgt_compute(2400000, 2026)).tax = 0 and (sp.cgt_compute(-900000, 2026)).tax = 0, 'G2 공제 이하·손실이면 0원');
select t.m4((sp.cgt_compute(2500001, 2026)).tax = 0 and (sp.cgt_compute(2500005, 2026)).tax = 1, 'G3 원 미만 절사(5원 × 22% = 1.1 → 1원)');

-- 결제일 환율 → 실현손익: 민 TSTA 10주 $200 매수(11-10, 결제 11-11) → 11-12 $250 매도(결제 11-13)
do $$ declare r jsonb; sell_fill bigint; begin
  perform t.quote('US', 'TSTA', 250, '2026-11-12 14:59:50+00');
  r := t.po(1::smallint, 'US', 'TSTA', 'sell', 'market', 10, null, '2026-11-12 15:00:00+00');
  perform t.m4(r->>'status' = 'filled', 'G4 TSTA 10주 $250 매도', r::text);
  select id into sell_fill from sp.fills where order_id = (r->>'order_id')::bigint;
  perform t.m4((select fx_rate_trade from sp.fills where id = sell_fill) = 1400 and (select fx_rate_settle from sp.fills where id = sell_fill) is null,
               'G5 체결일 환율(11-12 고시 없음 → 직전 11-11) 저장, 결제일 환율은 아직');
  perform sp.daily_close('2026-11-13 05:00:00+00');   -- 11-13 14:00 한국
  perform t.m4((select fx_rate_settle from sp.fills where id = sell_fill) = 1450, 'G6 결제일(11-13) 매매기준율 1,450 저장');
  perform t.m4((select l.cost_krw from sp.tax_lots l join sp.fills f on f.id = l.buy_fill_id join sp.orders o on o.id = f.order_id
                 where o.participant_id = 1 and o.symbol = 'TSTA' order by l.id limit 1) = 2807000,
               'G7 매수 묶음 원화 취득가 = $2,005 × 결제일(11-11) 1,400 = 2,807,000원');
  perform t.m4((select gain_krw from sp.cgt_realized where sell_fill_id = sell_fill) = 3615850 - 2807000,
               'G8 실현손익 = ($2,500 − $6.25 − $0.06) × 1,450 − 2,807,000 = 808,850원(선입선출 묶음)');
  perform t.m4((select tax_krw || '/' || status from sp.tax_assessments where participant_id = 1 and tax_year = 2026) = '0/estimated',
               'G9 올해 예상 양도세(공제 이하라 0원)');
end $$;

-- 체결일 환율이 너무 오래되면 비워 둔다(R10): 11-30 미국 체결, 마지막 고시 11-13(17일 전)
do $$ declare r jsonb; begin
  perform t.quote('US', 'TSTA', 250, '2026-11-30 14:59:50+00');
  r := t.po(1::smallint, 'US', 'TSTA', 'buy', 'market', 1, null, '2026-11-30 15:00:00+00');
  perform t.m4((select fx_rate_trade from sp.fills where order_id = (r->>'order_id')::bigint) is null, 'G10 고시값이 7일보다 오래되면 체결일 환율 비움(R10)', r::text);
  perform sp.daily_close('2026-12-02 05:00:00+00');
  perform t.m4((select fx_rate_settle from sp.fills where order_id = (r->>'order_id')::bigint) is null, 'G11 결제일 환율도 같은 기준으로 기다림');
end $$;

-- 연간 확정·납부: 손익 원장은 합성 행(시험 전용)으로 뽀 +4,000,000 / −500,000, 봇 +10,000,000
insert into sp.cgt_realized (sell_fill_id, participant_id, tax_year, proceeds_krw, cost_krw, gain_krw, fx_settle)
select id, p, 2026, 0, 0, g, 1 from (
  select (select id from sp.fills order by id offset 0 limit 1) as id, 2::smallint as p, 4000000::numeric as g union all
  select (select id from sp.fills order by id offset 1 limit 1), 2::smallint, -500000 union all
  select (select id from sp.fills order by id offset 2 limit 1), 3::smallint, 10000000
) x;
do $$ declare b0 numeric; v text; begin
  perform sp.tax_annual('2026-12-31 14:00:00+00');   -- 12-31 23:00 한국: 아직 확정 안 함
  perform t.m4(not exists (select 1 from sp.tax_assessments where tax_year = 2026 and status <> 'estimated'), 'G12 해 넘기기 전에는 확정 안 됨');
  perform sp.tax_annual('2026-12-31 15:10:00+00');   -- 2027-01-01 00:10 한국
  perform t.m4((select tax_krw || '/' || status || '/' || due_date from sp.tax_assessments where participant_id = 2 and tax_year = 2026) = '220000/assessed/2027-05-31',
               'G13 1월 1일 확정: 뽀 220,000원, 기한 2027-05-31');
  perform t.m4((select tax_krw from sp.tax_assessments where participant_id = 3 and tax_year = 2026) = 1650000, 'G14 봇 (10,000,000 − 2,500,000) × 22% = 1,650,000원');
  perform t.m4((select count(*) from sp.cash_ledger where kind = 'cgt_payment') = 0, 'G15 확정만으로는 돈이 빠지지 않음');
  -- 본인 납부: 5월 전 거부 → 5월 중 납부
  begin
    perform sp._cgt_pay(2::smallint, 2026, '2027-04-30 03:00:00+00');
    v := 'ok';
  exception when others then v := sqlerrm; end;
  perform t.m4(v = 'not_payment_period', 'G16 4월 30일 본인 납부 거부(5월 1~31일만)', v);
  select balance into b0 from sp.accounts where participant_id = 2 and currency = 'KRW';
  perform sp._cgt_pay(2::smallint, 2026, '2027-05-10 03:00:00+00');
  perform t.m4(b0 - (select balance from sp.accounts where participant_id = 2 and currency = 'KRW') = 220000
               and (select paid_by from sp.tax_assessments where participant_id = 2 and tax_year = 2026) = 'user', 'G17 5월 10일 본인 납부 → 원화 −220,000');
  begin
    perform sp._cgt_pay(2::smallint, 2026, '2027-05-11 03:00:00+00');
    v := 'ok';
  exception when others then v := sqlerrm; end;
  perform t.m4(v = 'nothing_to_pay', 'G18 두 번 납부 거부', v);
  -- 자동 납부: 5/30 은 아직, 5/31(한국) 자동 차감 → 봇 원화 마이너스 허용
  perform sp.tax_annual('2027-05-31 14:00:00+00');   -- 5-31 23:00 한국
  perform t.m4((select status from sp.tax_assessments where participant_id = 3 and tax_year = 2026) = 'assessed', 'G19 5월 31일 23:30(한국) 전에는 자동 차감 안 함');
  select balance into b0 from sp.accounts where participant_id = 3 and currency = 'KRW';
  perform sp.tax_annual('2027-05-31 14:50:00+00');   -- 2027-05-31 23:50 한국
  perform t.m4((select paid_by from sp.tax_assessments where participant_id = 3 and tax_year = 2026) = 'auto'
               and (select balance from sp.accounts where participant_id = 3 and currency = 'KRW') = b0 - 1650000
               and b0 - 1650000 < 0, 'G20 5월 31일 자동 차감 → 봇 원화 잔고 마이너스 허용', (b0 - 1650000)::text);
  perform t.m4((select count(*) from sp.cash_ledger where kind = 'cgt_payment') = 2, 'G21 납부 원장 2줄(뽀 본인·봇 자동), 민은 0원이라 줄 없음');
  perform t.m4((select status from sp.tax_assessments where participant_id = 1 and tax_year = 2026) = 'paid', 'G22 0원 세금도 기한에 납부 처리');
  -- 원화 음수면 원화 매수 금지, 달러→원 환전은 가능
  perform t.quote('KR', '999993', 1000, '2027-06-01 00:59:50+00');
  perform t.m4(t.po(3::smallint, 'KR', '999993', 'buy', 'limit', 1, 900, '2027-06-01 01:00:00+00')->>'error' = 'krw_negative', 'G23 원화 음수 → 원화 매수 거부');
end $$;
select t.m4(t.try('민', 'select sp.cgt_pay(2026)') = '22023', 'G24 민 본인 납부 함수 실행 가능(지금은 납부 기간 아님 → 22023)');
select t.m4(t.try('anon', 'select sp.cgt_pay(2026)') = '42501', 'G25 anon 납부 거부');
select t.m4(t.try('민', q) = '42501', format('G26 민 %s 거부', l), t.try('민', q))
from (values ('tax_annual', 'select sp.tax_annual()'), ('daily_close', 'select sp.daily_close()'),
             ('_cgt_pay(남)', 'select sp._cgt_pay(2::smallint, 2026, now())'),
             ('upsert_dividend_events', 'select sp.upsert_dividend_events(''[]'')'),
             ('tax_assessments update', 'update sp.tax_assessments set tax_krw = 0'),
             ('dividend_payouts insert', 'insert into sp.dividend_payouts (event_id, participant_id, qty_at_record, entitled_at) values (1, 1, 1, now())'),
             ('cgt_realized delete', 'delete from sp.cgt_realized')) as x(l, q);

-- ═════════ R11. 만료가 행을 잠그고 상태 조건을 다시 본다 ═════════
do $$ declare oid bigint; begin
  insert into sp.orders (participant_id, market, symbol, side, order_type, trade_date, fill_basis, qty, limit_price, status, reserved_amount, created_at)
  values (1, 'KR', '999993', 'buy', 'limit', '2026-11-10', '1m', 1, 900, 'open', 1000, '2026-11-10 01:00:00+00') returning id into oid;
  perform t.m4(sp.expire_orders('KR', '2026-11-10 06:31:00+00') >= 1, 'R11a 마감 만료 건수');
  perform t.m4((select status from sp.orders where id = oid) = 'expired', 'R11b 마감 만료(잠금 순서 바꾼 뒤에도 동작)');
end $$;

-- ═════════ 정합성 ═════════
select t.m4(not exists (select 1 from sp.accounts a where a.balance <> coalesce((select sum(amount) from sp.cash_ledger c where c.account_id = a.id), 0)),
            'Z1 모든 계좌: 원장 합계 = 잔고');
select t.m4(not exists (select 1 from sp.dividend_payouts p where p.status = 'paid'
                         and p.net <> coalesce((select sum(amount) from sp.cash_ledger c where c.ref_table = 'dividend_payouts' and c.ref_id = p.id), 0)),
            'Z2 배당 지급마다 원장 합계 = 순입금');
select t.m4(not exists (select 1 from sp.fx_conversions x
                         where (select count(*) from sp.cash_ledger c where c.ref_table = 'fx_conversions' and c.ref_id = x.id) <> 2),
            'Z3 환전마다 원장 2줄');

\o
\pset footer off
select seq, case when ok then 'PASS' else 'FAIL' end as result, name, detail from t.m4_results order by seq;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from t.m4_results;
do $$ begin
  if exists (select 1 from t.m4_results where not ok) then
    raise exception 'm4 tests failed: %', (select count(*) from t.m4_results where not ok);
  end if;
end $$;
