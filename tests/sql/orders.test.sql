-- M3 주문·체결·수수료 시험(0007). rls.test.sql 다음에 실행(같은 t 스키마·합성 계정 사용). 합성 종목·시세만.
create table t.o_results (seq serial, name text not null, ok boolean not null, detail text);
create function t.ook(c boolean, n text, d text default null) returns void language sql as
$$ insert into t.o_results (name, ok, detail) values (n, coalesce(c, false), d) $$;

-- 주문 접수(시각 지정). 오류는 {"error": "<메시지>"} 로 돌려준다
create function t.po(p_pid smallint, p_m text, p_s text, p_side text, p_type text, p_qty numeric, p_limit numeric,
                     p_now timestamptz, p_dry boolean default false) returns jsonb language plpgsql as $$
begin
  return sp._place_order(p_pid, p_m, p_s, p_side, p_type, p_qty, p_limit, p_dry, 'user', p_now);
exception when others then
  return jsonb_build_object('error', sqlerrm, 'state', sqlstate);
end $$;

create function t.quote(p_m text, p_s text, p_price numeric, p_at timestamptz, p_base numeric default null) returns void language sql as $$
  insert into sp.quotes (market, symbol, price, base_price, mode, quote_at, source)
  values (p_m, p_s, p_price, p_base, 'realtime', p_at, 'test')
  on conflict (market, symbol) do update set price = excluded.price, base_price = excluded.base_price, quote_at = excluded.quote_at, mode = 'realtime'
$$;

create function t.candle(p_m text, p_s text, p_tf text, p_t timestamptz, o numeric, h numeric, l numeric, c numeric) returns void language sql as $$
  insert into sp.candles (market, symbol, tf, t, o, h, l, c, v, source) values (p_m, p_s, p_tf, p_t, o, h, l, c, 1, 'test')
  on conflict (market, symbol, tf, t) do update set o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c
$$;

grant execute on all functions in schema t to public;

-- 준비: 깨끗한 시세, 실시간 모드, 합성 종목
delete from sp.candles where symbol in ('999990','999991','999993','TSTA');
delete from sp.quotes where symbol in ('999990','999991','999993','TSTA');
update sp.app_settings set value = 'realtime' where key = 'kr_quote_mode';
insert into sp.fx_rates (rate_date, usdkrw, source) values ('2026-11-02', 1398.5, 'test') on conflict do nothing;
-- 시험 전용: 실제 시드는 US_BROKER_FEE 를 확인일(2026-11-02)부터만 둔다. TAF 기간 경계(09-30 vs 10-01) 시험을 위해
-- 그 이전 기간 행을 시험 DB 에만 넣는다(운영 데이터 아님).
insert into sp.rate_table (code, market, value, unit, valid_from, valid_to, source_url, checked_on, note)
values ('US_BROKER_FEE', 'US', 0.0025, 'ratio', '2026-09-01', '2026-11-01', 'test:fixture', '2026-11-04', '시험 전용');

-- ═════════ A. 비용 계산(설계서 §4.1 예시 그대로) ═════════
select t.ook(c.broker_fee = 98 and c.reg_fee = 25 and c.tx_tax = 1400 and c.cash_delta = 698477,
            'A1 코스피 70,000×10 매도 → 698,477원(수수료 98·유관 25·세금 1,400)', format('%s/%s/%s/%s', c.broker_fee, c.reg_fee, c.tx_tax, c.cash_delta))
from sp.order_costs('KR', 'KOSPI', 'sell', 70000, 10, '2026-11-04') c;
select t.ook(c.broker_fee = 5.00 and c.reg_fee = 0.05 and c.cash_delta = 1994.95,
            'A2 미국 $200×10 매도(2026-11-02, TAF 0) → $1,994.95', format('%s/%s/%s', c.broker_fee, c.reg_fee, c.cash_delta))
from sp.order_costs('US', 'NASDAQ', 'sell', 200, 10, '2026-11-02') c;
select t.ook(c.reg_fee = 0.06 and c.cash_delta = 1994.94, 'A3 TAF 기간 경계: 2026-09-30 매도는 TAF 0.00195→$0.01 더해 $1,994.94', format('%s/%s', c.reg_fee, c.cash_delta))
from sp.order_costs('US', 'NASDAQ', 'sell', 200, 10, '2026-09-30') c;
select t.ook(c.reg_fee = 0.05, 'A4 TAF 기간 경계: 2026-10-01 매도는 TAF 0', c.reg_fee::text)
from sp.order_costs('US', 'NASDAQ', 'sell', 200, 10, '2026-10-01') c;
select t.ook(c.reg_fee = ceil(100000 * 0.0000206 * 100) / 100 + 9.79, 'A5 TAF 거래당 상한 $9.79(2026-09-30, 100,000주)', c.reg_fee::text)
from sp.order_costs('US', 'NASDAQ', 'sell', 1, 100000, '2026-09-30') c;
select t.ook(c.broker_fee = 98 and c.reg_fee = 25 and c.tx_tax = 0 and c.cash_delta = -700123, 'A6 코스피 70,000×10 매수 → −700,123원(세금 없음)', c.cash_delta::text)
from sp.order_costs('KR', 'KOSPI', 'buy', 70000, 10, '2026-11-04') c;
select t.ook(c.tx_tax = 200 and not exists (select 1 from sp.rate_table r where r.id = any(c.rate_ids) and r.code = 'KR_AGRI_TAX'),
            'A7 코스닥 매도: 거래세 0.20%, 농특세 없음', c.tx_tax::text)
from sp.order_costs('KR', 'KOSDAQ', 'sell', 10000, 10, '2026-11-04') c;
select t.ook(c.tx_tax = 200 and exists (select 1 from sp.rate_table r where r.id = any(c.rate_ids) and r.code = 'KR_AGRI_TAX'),
            'A8 코스피 매도: 거래세 0.05% + 농특세 0.15%', c.tx_tax::text)
from sp.order_costs('KR', 'KOSPI', 'sell', 10000, 10, '2026-11-04') c;
select t.ook(c.broker_fee = round(1.01 * 0.0025, 2), 'A9 미국 위탁 수수료 센트 반올림($1.01 → $0.00)', c.broker_fee::text)
from sp.order_costs('US', 'NASDAQ', 'buy', 1.01, 1, '2026-11-02') c;
select t.ook(l.upper = 12970 and l.lower = 6990, 'A10 상·하한가: 기준 9,980 → 12,970 / 6,990', format('%s/%s', l.upper, l.lower))
from sp.kr_limits(9980, '2026-11-04') l;
select t.ook(sp.next_session_date('US', '2026-11-26') = '2026-11-27' and sp.next_session_date('KR', '2026-11-07') = '2026-11-09',
            'A11 다음 거래일: 추수감사절·주말 건너뜀');

-- ═════════ B. 실시간 즉시 체결·대기·검증 (2026-11-04 수, 한국 10:00 = 01:00Z) ═════════
select t.quote('KR', '999990', 70100, '2026-11-04 00:59:30+00', 69900);

do $$ declare r jsonb; b0 numeric; b1 numeric; begin
  select balance into b0 from sp.accounts where participant_id = 2 and currency = 'KRW';
  r := t.po(2::smallint, 'KR', '999990', 'buy', 'market', 10, null, '2026-11-04 01:00:00+00');
  select balance into b1 from sp.accounts where participant_id = 2 and currency = 'KRW';
  perform t.ook(r->>'status' = 'filled' and (r->>'price')::numeric = 70100 and b0 - b1 = 70100 * 10 + 98 + 25,
               'B1 장중 시장가 매수 즉시 체결(현재가 70,100, 수수료 포함 출금)', r::text);
  perform t.ook((select count(*) from sp.cash_ledger where ref_table = 'fills' and ref_id = (select id from sp.fills where order_id = (r->>'order_id')::bigint)) = 3,
               'B2 원장 3줄(buy·broker_fee·reg_fee)');
  perform t.ook((select qty_open from sp.tax_lots where buy_fill_id = (select id from sp.fills where order_id = (r->>'order_id')::bigint)) = 10, 'B3 매수 묶음 10주');
end $$;

select t.ook(t.po(2::smallint, 'KR', '999990', 'buy', 'market', 1, null, '2026-11-04 01:03:00+00')->>'error' = 'quote_stale', 'B4 시세 2분 넘으면 시장가 거부');
select t.ook(t.po(2::smallint, 'KR', '999990', 'buy', 'limit', 1, 70050, '2026-11-04 01:00:00+00')->>'error' = 'tick_mismatch', 'B5 호가단위 안 맞는 지정가 거부(70,050)');
select t.ook(t.po(2::smallint, 'KR', '999990', 'buy', 'limit', 1, 90900, '2026-11-04 01:00:00+00')->>'error' = 'price_limit', 'B6 상한가(90,800) 밖 지정가 거부');
select t.ook(t.po(2::smallint, 'KR', '999990', 'buy', 'limit', 1, 48900, '2026-11-04 01:00:00+00')->>'error' = 'price_limit', 'B7 하한가(49,000) 밖 지정가 거부');
select t.ook(t.po(2::smallint, 'KR', '999990', 'sell', 'market', 11, null, '2026-11-04 01:00:00+00')->>'error' = 'insufficient_qty', 'B8 보유(10)보다 많이 매도 거부');
select t.ook(t.po(2::smallint, 'KR', '999990', 'buy', 'market', 200, null, '2026-11-04 01:00:00+00')->>'error' = 'insufficient_funds', 'B9 돈 모자라면 매수 거부');
select t.ook(t.po(2::smallint, 'KR', '999990', 'buy', 'market', 1.5, null, '2026-11-04 01:00:00+00')->>'error' = 'invalid_qty', 'B10 소수 수량 거부');
select t.ook(t.po(2::smallint, 'KR', '999990', 'buy', 'limit', 1, 'NaN', '2026-11-04 01:00:00+00')->>'error' = 'invalid_limit', 'B11 NaN 지정가 거부');
select t.ook(t.po(2::smallint, 'KR', '000000', 'buy', 'market', 1, null, '2026-11-04 01:00:00+00')->>'error' = 'unknown_instrument', 'B12 없는 종목 거부');

-- 미리보기(dry_run): 주문을 만들지 않는다
do $$ declare n0 bigint; r jsonb; begin
  select count(*) into n0 from sp.orders;
  r := t.po(2::smallint, 'KR', '999990', 'sell', 'market', 10, null, '2026-11-04 01:00:00+00', true);
  perform t.ook(r->>'dry_run' = 'true' and (r->>'cash_delta')::numeric = 70100 * 10 - 98 - 25 - (floor(701000 * 0.0005) + floor(701000 * 0.0015))
               and (select count(*) from sp.orders) = n0, 'B13 dry_run: 예상 입금 계산, 주문 안 만듦', r::text);
end $$;

-- ═════════ C. 대기 지정가 → 1분봉 체결, 같은 봉 두 사람 같은 가격, 접수한 분의 봉은 안 씀 ═════════
do $$ declare r1 jsonb; r2 jsonb; c0 numeric; a1 numeric; begin
  c0 := sp.available_cash(1::smallint, 'KRW');
  r1 := t.po(1::smallint, 'KR', '999990', 'buy', 'limit', 5, 69000, '2026-11-04 01:00:20+00');
  r2 := t.po(2::smallint, 'KR', '999990', 'buy', 'limit', 5, 69000, '2026-11-04 01:00:40+00');
  a1 := sp.available_cash(1::smallint, 'KRW');
  perform t.ook(r1->>'status' = 'open' and r2->>'status' = 'open', 'C1 현재가보다 낮은 매수 지정가 → 대기(open)');
  perform t.ook(c0 - a1 = 69000 * 5 + floor(345000 * 0.000140527) + floor(345000 * 0.000036396), 'C2 대기 주문 필요금액만큼 가용 잔고 묶임', (c0 - a1)::text);
  -- 접수한 분(10:00)의 봉: 저가가 낮아도 쓰지 않는다
  perform t.candle('KR', '999990', '1m', '2026-11-04 01:00:00+00', 70000, 70100, 68000, 70100);
  perform sp.process_orders('KR', '2026-11-04 01:01:00+00');
  perform t.ook((select status from sp.orders where id = (r1->>'order_id')::bigint) = 'open', 'C3 접수한 분의 봉으로는 체결 안 됨');
  -- 10:01 봉: 시가 68,800(지정가보다 유리, 갭) → 둘 다 68,800
  perform t.candle('KR', '999990', '1m', '2026-11-04 01:01:00+00', 68800, 69100, 68700, 69000);
  perform sp.process_orders('KR', '2026-11-04 01:02:00+00');
  perform t.ook((select price from sp.fills where order_id = (r1->>'order_id')::bigint) = 68800
               and (select price from sp.fills where order_id = (r2->>'order_id')::bigint) = 68800,
               'C4 같은 분봉 두 사람 같은 가격(시가가 유리하면 시가 68,800)');
  perform t.ook(sp.available_cash(1::smallint, 'KRW') = (select balance from sp.accounts where participant_id = 1 and currency = 'KRW'),
               'C5 체결 뒤 묶인 돈 풀림');
end $$;

do $$ declare r jsonb; begin
  r := t.po(2::smallint, 'KR', '999990', 'sell', 'limit', 5, 69500, '2026-11-04 01:02:10+00');
  perform t.ook(r->>'status' = 'open', 'C6 현재가보다 높은 매도 지정가 → 대기');
  perform t.ook(t.po(2::smallint, 'KR', '999990', 'sell', 'limit', 11, 80000, '2026-11-04 01:02:20+00')->>'error' = 'insufficient_qty',
               'C7 대기 매도 수량만큼 매도 가능 수량 줄어듦');
  perform t.candle('KR', '999990', '1m', '2026-11-04 01:03:00+00', 69100, 69600, 69000, 69500);
  perform sp.process_orders('KR', '2026-11-04 01:04:00+00');
  perform t.ook((select price from sp.fills where order_id = (r->>'order_id')::bigint) = 69500, 'C8 고가 ≥ 지정가 → 지정가 69,500 체결');
  -- 선입선출: 첫 묶음(B1, 10주)에서 5주
  perform t.ook((select qty_open from sp.tax_lots l join sp.fills f on f.id = l.buy_fill_id join sp.orders o on o.id = f.order_id
                where o.participant_id = 2 and o.order_type = 'market' and o.side = 'buy' order by f.at limit 1) = 5
               and (select count(*) from sp.lot_sales where sell_fill_id = (select id from sp.fills where order_id = (r->>'order_id')::bigint)) = 1,
               'C9 선입선출: 가장 먼저 산 묶음에서 줄어듦');
end $$;

-- ═════════ D. 예약(장 밖 접수) → 다음 거래일 첫 봉, 만료 ═════════
do $$ declare rm jsonb; rl jsonb; rx jsonb; begin
  -- 11-04 16:00 한국 = 07:00Z (장 마감 뒤) → trade_date 11-05
  rm := t.po(1::smallint, 'KR', '999990', 'buy', 'market', 2, null, '2026-11-04 07:00:00+00');
  rl := t.po(1::smallint, 'KR', '999990', 'buy', 'limit', 2, 69900, '2026-11-04 07:00:00+00');
  rx := t.po(1::smallint, 'KR', '999990', 'buy', 'limit', 1, 60000, '2026-11-04 07:00:00+00');
  perform t.ook(rm->>'status' = 'reserved' and rm->>'trade_date' = '2026-11-05', 'D1 장 마감 뒤 접수 → 예약, 다음 거래일', rm::text);
  perform t.ook((rm->>'reserved_amount')::numeric >= ceil(70100 * 1.3) * 2, 'D2 예약 시장가는 최근가 × 1.3 으로 돈 묶음', rm->>'reserved_amount');
  perform sp.process_orders('KR', '2026-11-04 23:59:00+00');  -- 11-05 08:59 한국: 개장 전
  perform t.ook((select status from sp.orders where id = (rm->>'order_id')::bigint) = 'reserved', 'D3 개장 전에는 그대로');
  perform t.candle('KR', '999990', '1m', '2026-11-05 00:00:00+00', 70200, 70300, 69800, 70000);
  perform sp.process_orders('KR', '2026-11-05 00:01:00+00');
  perform t.ook((select price from sp.fills where order_id = (rm->>'order_id')::bigint) = 70200, 'D4 예약 시장가 = 첫 1분봉 시가 70,200');
  perform t.ook((select price from sp.fills where order_id = (rl->>'order_id')::bigint) = 69900,
               'D5 예약 지정가: 시가에 안 맞아도 첫 봉 저가(69,800) ≤ 지정가 → 69,900 체결');
  perform t.ook((select status from sp.orders where id = (rx->>'order_id')::bigint) = 'open', 'D6 조건 안 맞는 예약 지정가 → 대기');
  perform sp.expire_orders('KR', '2026-11-05 06:29:00+00');
  perform t.ook((select status from sp.orders where id = (rx->>'order_id')::bigint) = 'open', 'D7 마감 전에는 만료 안 됨');
  perform sp.expire_orders('KR', '2026-11-05 06:30:00+00');
  perform t.ook((select status from sp.orders where id = (rx->>'order_id')::bigint) = 'expired'
               and (select reserved_amount from sp.orders where id = (rx->>'order_id')::bigint) = 0, 'D8 15:30 마감에 당일 만료, 묶인 돈 0');
end $$;

-- ═════════ E. 원화 음수 ═════════
do $$ declare acc bigint; begin
  select id into acc from sp.accounts where participant_id = 3 and currency = 'KRW';
  insert into sp.cash_ledger (account_id, kind, amount, memo) select acc, 'adjust', -(balance + 1000), 'test' from sp.accounts where id = acc;
  perform t.quote('KR', '999990', 70000, '2026-11-05 00:59:30+00', 70000);
  perform t.ook(t.po(3::smallint, 'KR', '999990', 'buy', 'limit', 1, 60000, '2026-11-05 01:00:00+00')->>'error' = 'krw_negative', 'E1 원화 음수면 원화 매수 거부');
  perform t.quote('US', 'TSTA', 200, '2026-11-02 15:59:30+00');
  perform t.ook(t.po(3::smallint, 'US', 'TSTA', 'buy', 'market', 1, null, '2026-11-02 16:00:00+00')->>'status' = 'filled', 'E2 원화 음수여도 달러 매수 허용');
  insert into sp.cash_ledger (account_id, kind, amount, memo) values (acc, 'adjust', 1000000, 'test');
end $$;

-- ═════════ F. 미국: 장 시간(겨울)·호가·환율 기록 ═════════
select t.ook(t.po(2::smallint, 'US', 'TSTA', 'buy', 'limit', 1, 0.5, '2026-11-02 16:00:00+00')->>'error' = 'tick_unknown', 'F1 $1 미만 호가단위 미확인 → 거부');
select t.ook(t.po(2::smallint, 'US', 'TSTA', 'buy', 'limit', 1, 199.995, '2026-11-02 16:00:00+00')->>'error' = 'tick_mismatch', 'F2 센트 미만 지정가 거부');
select t.ook(t.po(2::smallint, 'US', 'TSTA', 'buy', 'limit', 1, 190, '2026-11-02 14:00:00+00')->>'status' = 'reserved', 'F3 겨울 09:00 ET(14:00Z) → 개장 전 예약');
select t.ook((select f.fx_rate_trade from sp.fills f join sp.orders o on o.id = f.order_id where o.participant_id = 3 and o.market = 'US' limit 1) = 1398.5,
            'F4 미국 체결에 체결일 매매기준율 기록');
select t.ook((select f.settle_date from sp.fills f join sp.orders o on o.id = f.order_id where o.participant_id = 3 and o.market = 'US' limit 1) = '2026-11-03',
            'F5 미국 결제일 T+1(추정) 기록');

-- ═════════ G. 지연 모드(일봉, 설계서 §3.3 예시) — 2026-11-06 금 ═════════
update sp.app_settings set value = 'delayed' where key = 'kr_quote_mode';
do $$ declare a jsonb; b jsonb; m jsonb; x jsonb; begin
  a := t.po(1::smallint, 'KR', '999990', 'buy', 'limit', 1, 70000, '2026-11-06 01:00:00+00');
  b := t.po(1::smallint, 'KR', '999990', 'buy', 'limit', 1, 71000, '2026-11-06 01:00:00+00');
  m := t.po(1::smallint, 'KR', '999990', 'buy', 'market', 1, null, '2026-11-06 01:00:00+00');
  x := t.po(1::smallint, 'KR', '999990', 'buy', 'limit', 1, 69000, '2026-11-06 01:00:00+00');
  perform t.ook(a->>'status' = 'open' and a->>'fill_basis' = '1d' and m->>'status' = 'open', 'G1 지연 모드: 장중 주문도 대기(일봉 기준)', m::text);
  perform t.candle('KR', '999990', '1d', '2026-11-05 15:00:00+00', 70500, 71800, 69900, 71000);  -- 11-06 00:00 한국
  perform sp.process_orders('KR', '2026-11-06 06:00:00+00');
  perform t.ook((select status from sp.orders where id = (m->>'order_id')::bigint) = 'open', 'G2 장 마감 전에는 일봉으로 처리 안 함');
  perform sp.expire_orders('KR', '2026-11-06 07:00:00+00');
  perform t.ook((select status from sp.orders where id = (m->>'order_id')::bigint) = 'open', 'G3 일봉 주문은 마감 만료 대상 아님(일봉 올 때까지)');
  perform sp.process_orders('KR', '2026-11-06 07:00:00+00');
  perform t.ook((select price from sp.fills where order_id = (a->>'order_id')::bigint) = 70000, 'G4 지정가 70,000 → 70,000 체결');
  perform t.ook((select price from sp.fills where order_id = (b->>'order_id')::bigint) = 70500, 'G5 지정가 71,000 → 시가 70,500 체결');
  perform t.ook((select price from sp.fills where order_id = (m->>'order_id')::bigint) = 71000, 'G6 시장가 → 종가 71,000');
  perform t.ook((select status from sp.orders where id = (x->>'order_id')::bigint) = 'expired', 'G7 조건 안 맞는 지정가(69,000) → 만료');
end $$;
update sp.app_settings set value = 'realtime' where key = 'kr_quote_mode';

-- ═════════ H. 처리 시점 가격제한 재검사·체결 시 돈 재확인 ═════════
do $$ declare r jsonb; acc bigint; begin
  -- 예약 지정가(다음 날 기준가 모름) → 다음 날 기준가로 하한 밖이면 rejected
  r := t.po(2::smallint, 'KR', '999990', 'buy', 'limit', 1, 50000, '2026-11-06 07:30:00+00');
  perform t.ook(r->>'status' = 'reserved' and r->>'trade_date' = '2026-11-09', 'H1 금요일 마감 뒤 → 월요일 예약', r::text);
  perform t.quote('KR', '999990', 71000, '2026-11-09 00:00:10+00', 71000);  -- 하한 49,700
  perform t.candle('KR', '999990', '1m', '2026-11-09 00:00:00+00', 71000, 71000, 71000, 71000);
  perform sp.process_orders('KR', '2026-11-09 00:01:00+00');
  perform t.ook((select status || ':' || coalesce(reject_reason, '') from sp.orders where id = (r->>'order_id')::bigint) = 'open:',
               'H2 하한 49,700 안(50,000)이면 대기 유지');
  r := t.po(2::smallint, 'KR', '999990', 'buy', 'limit', 1, 49800, '2026-11-08 01:00:00+00');  -- 일요일 접수 → 월요일
  perform t.quote('KR', '999990', 72000, '2026-11-09 00:02:10+00', 72000);  -- 하한 50,400
  perform sp.process_orders('KR', '2026-11-09 00:03:00+00');
  perform t.ook((select status || ':' || coalesce(reject_reason, '') from sp.orders where id = (r->>'order_id')::bigint) = 'rejected:price_limit',
               'H3 처리 때 그날 기준가로 하한 밖 → rejected(price_limit)');
  -- 대기 매수 주문이 있는 동안 원장에서 돈이 빠지면 체결 때 rejected
  r := t.po(3::smallint, 'US', 'TSTA', 'buy', 'limit', 10, 150, '2026-11-02 16:01:00+00');
  select id into acc from sp.accounts where participant_id = 3 and currency = 'USD';
  insert into sp.cash_ledger (account_id, kind, amount, memo) select acc, 'adjust', -(balance - 100), 'test' from sp.accounts where id = acc;
  perform t.candle('US', 'TSTA', '1m', '2026-11-02 16:02:00+00', 149, 150, 148, 149);
  perform sp.process_orders('US', '2026-11-02 16:03:00+00');
  perform t.ook((select status || ':' || coalesce(reject_reason, '') from sp.orders where id = (r->>'order_id')::bigint) = 'rejected:insufficient_funds',
               'H4 체결 순간 돈이 모자라면 rejected');
end $$;

-- ═════════ I. 권한 ═════════
select t.ook(t.try('anon', 'select sp.place_order(''KR'', ''999990'', ''buy'', ''market'', 1)') = '42501', 'I1 anon 주문 거부');
select t.ook(t.try('미등록', 'select sp.place_order(''KR'', ''999990'', ''buy'', ''market'', 1)') = '42501', 'I2 미등록 주문 거부');
select t.ook(t.try('민', 'select sp.place_order(''KR'', ''999990'', ''buy'', ''market'', 1, null, true)') <> '42501', 'I3 민 주문 함수 실행 가능(장 상태와 무관하게 권한 오류 아님)');
select t.ook(t.try('민', q) = '42501', format('I4 민 %s 거부', label), t.try('민', q))
from (values
  ('_place_order 직접', 'select sp._place_order(3::smallint, ''KR'', ''999990'', ''buy'', ''market'', 1, null, false, ''bot'', now())'),
  ('_fill 직접', 'select sp._fill(1, 1, now(), ''x'', now())'),
  ('process_orders', 'select sp.process_orders(''KR'')'),
  ('expire_orders', 'select sp.expire_orders(''KR'')'),
  ('place_order_bot', 'select sp.place_order_bot(3::smallint, ''KR'', ''999990'', ''buy'', ''market'', 1)'),
  ('orders insert', 'insert into sp.orders (participant_id, market, symbol, side, order_type, trade_date, fill_basis, qty, status) values (1, ''KR'', ''999990'', ''buy'', ''market'', ''2026-11-04'', ''1m'', 1, ''open'')'),
  ('orders update', 'update sp.orders set status = ''filled'''),
  ('fills insert', 'insert into sp.fills (order_id, at, price, qty, gross, broker_fee, reg_fee, cash_delta, quote_source, quote_at, rate_ids) values (1, now(), 1, 1, 1, 0, 0, 1, ''x'', now(), ''{}'')'),
  ('tax_lots update', 'update sp.tax_lots set qty_open = qty_orig')
) as x(label, q);
select t.ook(t.try('서버', 'select sp.place_order_bot(1::smallint, ''KR'', ''999990'', ''buy'', ''market'', 1)') = '42501', 'I5 봇 주문 함수로 사람 계좌 주문 거부');
select t.ook(t.try('서버', 'select sp.place_order(''KR'', ''999990'', ''buy'', ''market'', 1)') = '42501', 'I6 서버 역할은 사람 주문 함수 실행 불가');
select t.ook(t.count_as('민', 'select count(*) from sp.orders') = (select count(*) from sp.orders), 'I7 민은 세 참가자 주문 모두 읽기(비교)');
select t.ook(t.count_as('미등록', 'select count(*) from sp.positions') = 0, 'I8 미등록은 보유 0행');

-- 취소
do $$ declare r jsonb; v text; begin
  r := t.po(1::smallint, 'KR', '999990', 'buy', 'limit', 1, 60000, '2026-11-09 07:00:00+00');
  v := t.try('뽀', format('select sp.cancel_order(%s)', r->>'order_id'));
  perform t.ook(v = '42501', 'I9 남의 주문 취소 거부', v);
  v := t.try('민', format('select sp.cancel_order(%s)', r->>'order_id'));
  perform t.ook(v = 'ok' and (select status from sp.orders where id = (r->>'order_id')::bigint) = 'cancelled', 'I10 본인 예약 주문 취소', v);
  v := t.try('민', format('select sp.cancel_order(%s)', r->>'order_id'));
  perform t.ook(v = '22023', 'I11 이미 취소된 주문 다시 취소 거부', v);
end $$;

-- ═════════ J. 전체 정합성 ═════════
select t.ook(not exists (
  select 1 from sp.accounts a
   where a.balance <> coalesce((select sum(amount) from sp.cash_ledger c where c.account_id = a.id), 0)),
  'J1 모든 계좌: 원장 합계 = 잔고');
select t.ook(not exists (
  select 1 from sp.fills f
   where f.cash_delta <> coalesce((select sum(amount) from sp.cash_ledger c where c.ref_table = 'fills' and c.ref_id = f.id), 0)),
  'J2 모든 체결: 원장 줄 합계 = cash_delta');
select t.ook(not exists (select 1 from sp.orders where status in ('filled','cancelled','rejected','expired') and reserved_amount <> 0),
  'J3 끝난 주문은 묶인 돈 0');
select t.ook(not exists (
  select 1 from sp.fills f join sp.orders o on o.id = f.order_id where o.side = 'sell'
     and f.qty <> (select sum(qty) from sp.lot_sales s where s.sell_fill_id = f.id)),
  'J4 모든 매도: 선입선출 기록 수량 = 매도 수량');
select t.ook(not exists (select 1 from sp.fills where cardinality(rate_ids) = 0), 'J5 모든 체결에 요율 id 기록');

\pset footer off
select seq, case when ok then 'PASS' else 'FAIL' end as result, name, detail from t.o_results order by seq;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from t.o_results;
do $$ begin
  if exists (select 1 from t.o_results where not ok) then
    raise exception 'order tests failed: %', (select count(*) from t.o_results where not ok);
  end if;
end $$;
