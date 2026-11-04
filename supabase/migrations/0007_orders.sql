-- 0007_orders: 주문·체결·수수료(M3). 돈은 원장(cash_ledger)으로만, 주문 접수·체결은 security definer 함수로만.
--   브라우저(authenticated): sp.place_order(본인), sp.cancel_order(본인) 실행 + 주문·체결·보유 읽기
--   서버(service_role): sp.process_orders / sp.expire_orders(tick), sp.place_order_bot(봇 함수, M6)
--   숫자(세율·수수료·호가·가격제한)는 요율표에서만 읽는다.
-- 체결 규칙 요지(설계서 §3)
--   * 가격은 서버 시세(quotes·candles)만. 브라우저 가격은 지정가 한도로만.
--   * 실시간(1m): 장중 시장가·즉시 가능 지정가는 접수 즉시 현재가. 대기 지정가는 이후 1분봉 저·고가로, 체결가는 지정가(시가가 더 유리하면 시가).
--     예약(장 밖 접수)은 trade_date 첫 1분봉 시가로 판단.
--   * 지연(1d, 한국 지연 모드): trade_date 일봉으로 — 시장가 종가, 지정가 위와 같은 규칙, 안 맞으면 만료.
--   * 당일 유효(1m 은 trade_date 마감에 만료). 전량 체결. 정규장만.
--   * 나중 체결 주문은 필요금액을 묶는다(orders.reserved_amount). 원장은 움직이지 않고 "가용 잔고" 계산에서 뺀다.

-- ───────── 테이블 ─────────
create table sp.orders (
  id              bigserial primary key,
  participant_id  smallint not null references sp.participants(id),
  market          text not null check (market in ('KR','US')),
  symbol          text not null,
  side            text not null check (side in ('buy','sell')),
  order_type      text not null check (order_type in ('market','limit')),
  is_reserved     boolean not null default false,
  trade_date      date not null,
  fill_basis      text not null check (fill_basis in ('1m','1d')),
  qty             numeric not null check (qty > 0 and qty = trunc(qty)),
  limit_price     numeric check (limit_price is null or limit_price > 0),
  status          text not null check (status in ('reserved','open','filled','cancelled','rejected','expired')),
  reject_reason   text,
  reserved_amount numeric not null default 0 check (reserved_amount >= 0),
  checked_until   timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      text not null default 'user' check (created_by in ('user','bot')),
  bot_decision_id bigint,
  foreign key (market, symbol) references sp.instruments(market, symbol),
  check ((order_type = 'limit') = (limit_price is not null))
);
create index on sp.orders (market, status);
create index on sp.orders (participant_id, created_at desc);

create table sp.fills (
  id             bigserial primary key,
  order_id       bigint not null unique references sp.orders(id),
  at             timestamptz not null,
  price          numeric not null check (price > 0),
  qty            numeric not null check (qty > 0),
  gross          numeric not null,
  broker_fee     numeric not null,
  reg_fee        numeric not null,
  tx_tax         numeric not null default 0,
  cash_delta     numeric not null,                -- 이 체결로 계좌가 바뀐 금액(+입금 / −출금)
  settle_date    date,
  fx_rate_trade  numeric,
  fx_rate_settle numeric,
  quote_source   text not null,
  quote_at       timestamptz not null,
  rate_ids       bigint[] not null
);

create table sp.tax_lots (
  id             bigserial primary key,
  participant_id smallint not null references sp.participants(id),
  market         text not null,
  symbol         text not null,
  buy_fill_id    bigint not null references sp.fills(id),
  qty_orig       numeric not null check (qty_orig > 0),
  qty_open       numeric not null check (qty_open >= 0 and qty_open <= qty_orig),
  cost_local     numeric not null,               -- 수수료 포함 취득가(현지 통화)
  cost_krw       numeric                         -- US: 결제일 환율 환산(M4)
);
create index on sp.tax_lots (participant_id, market, symbol);

create table sp.lot_sales (                      -- 매도가 어떤 매수 묶음을 얼마나 썼는지(선입선출, 양도세 M4)
  sell_fill_id bigint not null references sp.fills(id),
  lot_id       bigint not null references sp.tax_lots(id),
  qty          numeric not null check (qty > 0),
  cost_local   numeric not null,
  primary key (sell_fill_id, lot_id)
);

create view sp.positions with (security_invoker = true) as
  select participant_id, market, symbol,
         sum(qty_open) as qty,
         sum(cost_local * qty_open / qty_orig) as cost_local_open
    from sp.tax_lots where qty_open > 0
   group by participant_id, market, symbol;

-- ───────── 장 시간·거래일 ─────────
create function sp.market_tz(p_market text) returns text
language sql immutable set search_path = '' as $$
  select case p_market when 'KR' then 'Asia/Seoul' when 'US' then 'America/New_York' end
$$;

create function sp.local_date(p_market text, p_ts timestamptz) returns date
language sql stable set search_path = '' as $$
  select (p_ts at time zone sp.market_tz(p_market))::date
$$;

-- 그날 정규장: market_calendar 행이 있으면 따르고, 없으면 평일 개장(KR 09:00~15:30, US 09:30~16:00)
create function sp.session(p_market text, p_date date, out is_open boolean, out open_at timestamptz, out close_at timestamptz)
language plpgsql stable set search_path = '' as $$
declare
  r record;
  tz text := sp.market_tz(p_market);
  o time := case p_market when 'KR' then time '09:00' else time '09:30' end;
  c time := case p_market when 'KR' then time '15:30' else time '16:00' end;
begin
  select * into r from sp.market_calendar m where m.market = p_market and m.trade_date = p_date;
  if found then
    is_open := r.is_open;
  else
    is_open := extract(isodow from p_date) < 6;
  end if;
  open_at := coalesce(r.open_at, (p_date + o) at time zone tz);
  close_at := coalesce(r.close_at, (p_date + c) at time zone tz);
end $$;

create function sp.next_session_date(p_market text, p_from date) returns date
language plpgsql stable set search_path = '' as $$
declare d date := p_from;
begin
  for i in 1..30 loop
    if (sp.session(p_market, d)).is_open then return d; end if;
    d := d + 1;
  end loop;
  raise exception 'no session within 30 days' using errcode = '22023';
end $$;

-- n 거래일 뒤(결제일 추정용, 결제 주기 근거는 확인 안 함 — 설계서)
create function sp.add_sessions(p_market text, p_date date, p_n integer) returns date
language plpgsql stable set search_path = '' as $$
declare d date := p_date;
begin
  for i in 1..p_n loop
    d := sp.next_session_date(p_market, d + 1);
  end loop;
  return d;
end $$;

-- ───────── 요율 ─────────
-- 그날 유효한 요율 1행. 시장 구분(segment)이 같은 행을 먼저, 없으면 segment 가 비어 있는 행.
create function sp.rate_on(p_code text, p_segment text, p_date date, p_required boolean default true,
                           out id bigint, out value numeric)
language plpgsql stable set search_path = '' as $$
begin
  select r.id, r.value into id, value
    from sp.rate_table r
   where r.code = p_code
     and (r.segment is not distinct from p_segment or r.segment is null)
     and r.valid_from <= p_date and (r.valid_to is null or r.valid_to >= p_date)
   order by (r.segment is not null) desc, r.valid_from desc
   limit 1;
  if id is null and p_required then
    raise exception 'rate_missing:%', p_code using errcode = '22023';
  end if;
end $$;

-- 호가단위(구간표). 모르는 구간이면 null
create function sp.tick_for(p_code text, p_price numeric, p_date date) returns numeric
language plpgsql stable set search_path = '' as $$
declare
  b jsonb;
  e jsonb;
begin
  select rb.bands into b from sp.rate_bands rb
   where rb.code = p_code and rb.valid_from <= p_date and (rb.valid_to is null or rb.valid_to >= p_date)
   order by rb.valid_from desc limit 1;
  if b is null then return null; end if;
  for e in select * from jsonb_array_elements(b) loop
    if e->'lt' = 'null'::jsonb or p_price < (e->>'lt')::numeric then
      return nullif(e->>'tick', '')::numeric;
    end if;
  end loop;
  return null;
end $$;

-- KRX 상·하한가(요율표 §1.1): 기준가 × 비율 → 기준가 호가단위 미만 절사 → ± → 그 가격의 호가단위 미만 절사
create function sp.kr_limits(p_base numeric, p_date date, out upper numeric, out lower numeric)
language plpgsql stable set search_path = '' as $$
declare
  ratio numeric := (sp.rate_on('KR_PRICE_LIMIT', null, p_date)).value;
  t numeric := sp.tick_for('KR_TICK', p_base, p_date);
  rng numeric;
begin
  rng := floor(p_base * ratio / t) * t;
  upper := floor((p_base + rng) / sp.tick_for('KR_TICK', p_base + rng, p_date)) * sp.tick_for('KR_TICK', p_base + rng, p_date);
  lower := floor((p_base - rng) / sp.tick_for('KR_TICK', p_base - rng, p_date)) * sp.tick_for('KR_TICK', p_base - rng, p_date);
end $$;

-- 체결 비용(설계서 §4.1). 끝자리: 원 미만 절사 / SEC31·TAF 센트 올림 / 위탁 수수료(US) 센트 반올림 [결정 Q-R3]
create function sp.order_costs(p_market text, p_exchange text, p_side text, p_price numeric, p_qty numeric, p_date date,
                               out gross numeric, out broker_fee numeric, out reg_fee numeric, out tx_tax numeric,
                               out cash_delta numeric, out rate_ids bigint[])
language plpgsql stable set search_path = '' as $$
declare
  r1 record; r2 record; r3 record; r4 record;
  taf numeric;
begin
  gross := p_price * p_qty;
  tx_tax := 0;
  rate_ids := '{}';
  if p_market = 'KR' then
    r1 := sp.rate_on('KR_BROKER_FEE', null, p_date);
    r2 := sp.rate_on('KR_REG_FEE', null, p_date);
    broker_fee := floor(gross * r1.value);
    reg_fee := floor(gross * r2.value);
    rate_ids := array[r1.id, r2.id];
    if p_side = 'sell' then
      r3 := sp.rate_on('KR_SEC_TX_TAX', p_exchange, p_date);
      r4 := sp.rate_on('KR_AGRI_TAX', p_exchange, p_date, false);  -- 코스닥에는 없음
      tx_tax := floor(gross * r3.value) + coalesce(floor(gross * r4.value), 0);
      rate_ids := rate_ids || r3.id || r4.id;
    end if;
  else
    r1 := sp.rate_on('US_BROKER_FEE', null, p_date);
    broker_fee := round(gross * r1.value, 2);
    reg_fee := 0;
    rate_ids := array[r1.id];
    if p_side = 'sell' then
      r2 := sp.rate_on('US_SEC31', null, p_date);
      r3 := sp.rate_on('US_FINRA_TAF', null, p_date);
      r4 := sp.rate_on('US_FINRA_TAF_CAP', null, p_date, false);
      taf := p_qty * r3.value;
      if r4.id is not null then taf := least(taf, r4.value); end if;
      reg_fee := ceil(gross * r2.value * 100) / 100 + ceil(taf * 100) / 100;
      rate_ids := rate_ids || r2.id || r3.id || r4.id;
    end if;
  end if;
  rate_ids := array_remove(rate_ids, null);
  cash_delta := case when p_side = 'buy' then -(gross + broker_fee + reg_fee) else gross - broker_fee - reg_fee - tx_tax end;
end $$;

-- ───────── 가용 잔고·수량 ─────────
create function sp.available_cash(p_participant smallint, p_currency text, p_exclude_order bigint default null) returns numeric
language sql stable set search_path = '' as $$
  select a.balance - coalesce((
           select sum(o.reserved_amount) from sp.orders o
            where o.participant_id = p_participant and o.status in ('reserved','open') and o.side = 'buy'
              and (case o.market when 'KR' then 'KRW' else 'USD' end) = p_currency
              and o.id is distinct from p_exclude_order), 0)
    from sp.accounts a where a.participant_id = p_participant and a.currency = p_currency
$$;

create function sp.available_qty(p_participant smallint, p_market text, p_symbol text, p_exclude_order bigint default null) returns numeric
language sql stable set search_path = '' as $$
  select coalesce((select sum(l.qty_open) from sp.tax_lots l
                    where l.participant_id = p_participant and l.market = p_market and l.symbol = p_symbol), 0)
       - coalesce((select sum(o.qty) from sp.orders o
                    where o.participant_id = p_participant and o.market = p_market and o.symbol = p_symbol
                      and o.side = 'sell' and o.status in ('reserved','open') and o.id is distinct from p_exclude_order), 0)
$$;

-- ───────── 체결(내부) ─────────
-- 돈·수량을 다시 확인하고 fills·원장·매수 묶음을 한 번에. 모자라면 rejected.
create function sp._fill(p_order bigint, p_price numeric, p_at timestamptz, p_source text, p_quote_at timestamptz)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  o sp.orders;
  ex text;
  cur text;
  c record;
  acc bigint;
  bal numeric;
  f_id bigint;
  remaining numeric;
  l record;
  take numeric;
  fx numeric;
begin
  select * into o from sp.orders where id = p_order for update;
  if o.status not in ('reserved','open') then return o.status; end if;
  cur := case o.market when 'KR' then 'KRW' else 'USD' end;
  select a.id, a.balance into acc, bal from sp.accounts a where a.participant_id = o.participant_id and a.currency = cur for update;
  select i.exchange into ex from sp.instruments i where i.market = o.market and i.symbol = o.symbol;
  c := sp.order_costs(o.market, ex, o.side, p_price, o.qty, o.trade_date);

  if o.side = 'buy' then
    if o.market = 'KR' and bal < 0 then
      update sp.orders set status = 'rejected', reject_reason = 'krw_negative', reserved_amount = 0, updated_at = now() where id = o.id;
      return 'rejected';
    end if;
    if sp.available_cash(o.participant_id, cur, o.id) < -c.cash_delta then
      update sp.orders set status = 'rejected', reject_reason = 'insufficient_funds', reserved_amount = 0, updated_at = now() where id = o.id;
      return 'rejected';
    end if;
  else
    if sp.available_qty(o.participant_id, o.market, o.symbol, o.id) < o.qty then
      update sp.orders set status = 'rejected', reject_reason = 'insufficient_qty', reserved_amount = 0, updated_at = now() where id = o.id;
      return 'rejected';
    end if;
  end if;

  if o.market = 'US' then
    select r.usdkrw into fx from sp.fx_rates r where r.rate_date <= o.trade_date order by r.rate_date desc limit 1;
  end if;

  insert into sp.fills (order_id, at, price, qty, gross, broker_fee, reg_fee, tx_tax, cash_delta, settle_date, fx_rate_trade,
                        quote_source, quote_at, rate_ids)
  values (o.id, p_at, p_price, o.qty, c.gross, c.broker_fee, c.reg_fee, c.tx_tax, c.cash_delta,
          sp.add_sessions(o.market, o.trade_date, case o.market when 'KR' then 2 else 1 end), fx,
          p_source, p_quote_at, c.rate_ids)
  returning id into f_id;

  -- 원장(0원 줄은 남기지 않음)
  insert into sp.cash_ledger (account_id, kind, amount, ref_table, ref_id)
  select acc, k, amt, 'fills', f_id from (values
    (case o.side when 'buy' then 'buy' else 'sell' end, case o.side when 'buy' then -c.gross else c.gross end),
    ('broker_fee', -c.broker_fee),
    ('reg_fee', -c.reg_fee),
    ('tx_tax', -c.tx_tax)
  ) as v(k, amt) where amt <> 0;

  if o.side = 'buy' then
    insert into sp.tax_lots (participant_id, market, symbol, buy_fill_id, qty_orig, qty_open, cost_local)
    values (o.participant_id, o.market, o.symbol, f_id, o.qty, o.qty, c.gross + c.broker_fee + c.reg_fee);
  else
    remaining := o.qty;
    for l in select t.* from sp.tax_lots t join sp.fills bf on bf.id = t.buy_fill_id
              where t.participant_id = o.participant_id and t.market = o.market and t.symbol = o.symbol and t.qty_open > 0
              order by bf.at, t.id for update of t loop
      exit when remaining <= 0;
      take := least(remaining, l.qty_open);
      update sp.tax_lots set qty_open = qty_open - take where id = l.id;
      insert into sp.lot_sales (sell_fill_id, lot_id, qty, cost_local) values (f_id, l.id, take, l.cost_local * take / l.qty_orig);
      remaining := remaining - take;
    end loop;
  end if;

  update sp.orders set status = 'filled', reserved_amount = 0, updated_at = now() where id = o.id;
  return 'filled';
end $$;

-- ───────── 주문 접수(내부) ─────────
create function sp._place_order(p_participant smallint, p_market text, p_symbol text, p_side text, p_type text,
                                p_qty numeric, p_limit numeric, p_dry_run boolean, p_created_by text, p_now timestamptz,
                                p_bot_decision bigint default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  inst record;
  q record;
  mode text;
  basis text;
  today date;
  s record;
  tdate date;
  in_session boolean;
  status text;
  cur text;
  bal numeric;
  max_age integer;
  fresh boolean;
  est numeric;
  c record;
  t numeric;
  lim record;
  reserve numeric := 0;
  oid bigint;
  res text;
begin
  -- 입력
  if p_side not in ('buy','sell') then raise exception 'invalid_side' using errcode = '22023'; end if;
  if p_type not in ('market','limit') then raise exception 'invalid_type' using errcode = '22023'; end if;
  if p_qty is null or p_qty = 'NaN'::numeric or p_qty < 1 or p_qty > 1000000 or p_qty <> trunc(p_qty) then raise exception 'invalid_qty' using errcode = '22023'; end if;
  if (p_type = 'limit') <> (p_limit is not null) then raise exception 'invalid_limit' using errcode = '22023'; end if;
  if p_limit is not null and (p_limit = 'NaN'::numeric or p_limit <= 0 or p_limit >= 1000000000) then raise exception 'invalid_limit' using errcode = '22023'; end if;

  select * into inst from sp.instruments i where i.market = p_market and i.symbol = p_symbol and i.active;
  if not found then raise exception 'unknown_instrument' using errcode = '22023'; end if;
  cur := case p_market when 'KR' then 'KRW' else 'USD' end;

  -- 시세 모드 → 체결 기준
  select value into mode from sp.app_settings where key = 'kr_quote_mode';
  basis := case when p_market = 'KR' and mode is distinct from 'realtime' then '1d' else '1m' end;
  -- 지연 모드(일봉) 주문을 처리·만료할 작업(eod-kr)이 아직 없다 → 묶인 돈이 풀리지 않으므로 받지 않는다(리뷰 SP-028 M2).
  -- 지연 공급자를 구현할 때 이 줄을 지우고 process_orders 의 1d 경로를 쓴다.
  if basis = '1d' then raise exception 'kr_delayed_orders_unavailable' using errcode = '22023'; end if;

  -- 거래일·장 상태
  today := sp.local_date(p_market, p_now);
  s := sp.session(p_market, today);
  if s.is_open and p_now < s.close_at then
    tdate := today;
    in_session := p_now >= s.open_at;
  else
    tdate := sp.next_session_date(p_market, today + 1);
    in_session := false;
  end if;

  -- 지정가 호가단위·가격제한
  if p_limit is not null then
    t := sp.tick_for(case p_market when 'KR' then 'KR_TICK' else 'US_TICK' end, p_limit, tdate);
    if t is null then raise exception 'tick_unknown' using errcode = '22023'; end if;
    if p_limit % t <> 0 then raise exception 'tick_mismatch' using errcode = '22023'; end if;
  end if;

  select * into q from sp.quotes qq where qq.market = p_market and qq.symbol = p_symbol;
  select coalesce(value::integer, 120) into max_age from sp.app_settings where key = 'quote_max_age_sec';
  fresh := q.price is not null and q.mode = 'realtime' and p_now - q.quote_at <= make_interval(secs => max_age);

  if p_limit is not null and p_market = 'KR' and q.base_price is not null and sp.local_date('KR', q.quote_at) = tdate then
    lim := sp.kr_limits(q.base_price, tdate);
    if p_limit > lim.upper or p_limit < lim.lower then raise exception 'price_limit' using errcode = '22023'; end if;
  end if;

  -- 원화 음수면 원화 매수 금지
  select a.balance into bal from sp.accounts a where a.participant_id = p_participant and a.currency = cur for update;
  if p_market = 'KR' and p_side = 'buy' and bal < 0 then raise exception 'krw_negative' using errcode = '22023'; end if;

  -- 즉시 체결 여부·예상가
  status := case when in_session then 'open' else 'reserved' end;
  if basis = '1m' and in_session then
    if p_type = 'market' then
      if not fresh then raise exception 'quote_stale' using errcode = '22023'; end if;
      status := 'filled'; est := q.price;
    elsif fresh and ((p_side = 'buy' and p_limit >= q.price) or (p_side = 'sell' and p_limit <= q.price)) then
      status := 'filled'; est := q.price;
    end if;
  end if;
  if status <> 'filled' then
    if p_type = 'limit' then
      est := p_limit;
    else
      if q.price is null then raise exception 'no_quote' using errcode = '22023'; end if;
      -- 시장가 대기: 최근가 × (1 + 가격제한 비율)로 묶는다(설계서 §3.2)
      est := q.price * (1 + (sp.rate_on('KR_PRICE_LIMIT', null, tdate)).value);
      est := case p_market when 'KR' then ceil(est) else ceil(est * 100) / 100 end;
    end if;
  end if;

  c := sp.order_costs(p_market, inst.exchange, p_side, est, p_qty, tdate);

  -- 돈·수량
  if p_side = 'buy' then
    if sp.available_cash(p_participant, cur) < -c.cash_delta then raise exception 'insufficient_funds' using errcode = '22023'; end if;
    if status <> 'filled' then reserve := -c.cash_delta; end if;
  else
    if sp.available_qty(p_participant, p_market, p_symbol) < p_qty then raise exception 'insufficient_qty' using errcode = '22023'; end if;
  end if;

  if p_dry_run then
    return jsonb_build_object('ok', true, 'dry_run', true, 'status', status, 'trade_date', tdate, 'fill_basis', basis,
      'price', est, 'gross', c.gross, 'broker_fee', c.broker_fee, 'reg_fee', c.reg_fee, 'tx_tax', c.tx_tax,
      'cash_delta', c.cash_delta, 'reserved_amount', reserve, 'available_cash', sp.available_cash(p_participant, cur));
  end if;

  insert into sp.orders (participant_id, market, symbol, side, order_type, is_reserved, trade_date, fill_basis, qty, limit_price,
                         status, reserved_amount, created_at, created_by, bot_decision_id)
  values (p_participant, p_market, p_symbol, p_side, p_type, not in_session, tdate, basis, p_qty, p_limit,
          case when status = 'filled' then 'open' else status end, reserve, p_now, p_created_by, p_bot_decision)
  returning id into oid;

  if status = 'filled' then
    res := sp._fill(oid, q.price, p_now, 'quote:' || q.source, q.quote_at);
  else
    res := status;
  end if;

  return jsonb_build_object('ok', true, 'order_id', oid, 'status', res, 'trade_date', tdate, 'fill_basis', basis,
    'price', est, 'gross', c.gross, 'broker_fee', c.broker_fee, 'reg_fee', c.reg_fee, 'tx_tax', c.tx_tax,
    'cash_delta', c.cash_delta, 'reserved_amount', reserve);
end $$;

-- ───────── 공개 함수 ─────────
-- 브라우저(본인): 봇 이름으로는 주문할 수 없다
create function sp.place_order(p_market text, p_symbol text, p_side text, p_type text, p_qty numeric,
                               p_limit numeric default null, p_dry_run boolean default false)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me smallint := sp.me();
begin
  if me is null then raise exception 'not_registered' using errcode = '42501'; end if;
  if (select kind from sp.participants where id = me) <> 'human' then raise exception 'forbidden' using errcode = '42501'; end if;
  return sp._place_order(me, p_market, p_symbol, p_side, p_type, p_qty, p_limit, p_dry_run, 'user', now());
end $$;

-- 서버(봇 함수, M6): 봇 참가자만
create function sp.place_order_bot(p_participant smallint, p_market text, p_symbol text, p_side text, p_type text, p_qty numeric,
                                   p_limit numeric default null, p_bot_decision bigint default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if (select kind from sp.participants where id = p_participant) is distinct from 'bot' then
    raise exception 'not_bot' using errcode = '42501';
  end if;
  return sp._place_order(p_participant, p_market, p_symbol, p_side, p_type, p_qty, p_limit, false, 'bot', now(), p_bot_decision);
end $$;

create function sp.cancel_order(p_order bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me smallint := sp.me();
  o sp.orders;
begin
  if me is null then raise exception 'not_registered' using errcode = '42501'; end if;
  select * into o from sp.orders where id = p_order for update;
  if not found or o.participant_id <> me or o.created_by <> 'user' then raise exception 'not_found' using errcode = '42501'; end if;
  if o.status not in ('reserved','open') then raise exception 'not_cancellable' using errcode = '22023'; end if;
  update sp.orders set status = 'cancelled', reserved_amount = 0, updated_at = now() where id = o.id;
  return jsonb_build_object('ok', true, 'order_id', o.id, 'status', 'cancelled');
end $$;

-- 대기·예약 주문 처리(tick 이 시세·봉을 저장한 뒤 부른다). 돌려주는 값: 이번에 체결된 건수
create function sp.process_orders(p_market text, p_now timestamptz default now()) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  o sp.orders;
  s record;
  cnd record;
  q record;
  lim record;
  px numeric;
  filled integer := 0;
  last_t timestamptz;
  v_id bigint;
begin
  for v_id in select id from sp.orders where market = p_market and status in ('reserved','open') order by created_at, id loop
    -- 루프 시작 때 읽은 값이 아니라 지금 값으로(처리 중 취소된 주문이 되살아나지 않게). 취소·체결과 같은 행 잠금으로 직렬화
    select * into o from sp.orders where id = v_id for update;
    if not found or o.status not in ('reserved','open') then continue; end if;
    s := sp.session(p_market, o.trade_date);
    if not s.is_open then continue; end if;

    -- 한국 지정가: 그날 기준가로 가격제한 다시 확인(예약 주문은 접수 때 기준가를 몰랐을 수 있음)
    if p_market = 'KR' and o.limit_price is not null then
      select * into q from sp.quotes where market = o.market and symbol = o.symbol;
      if q.base_price is not null and sp.local_date('KR', q.quote_at) = o.trade_date then
        lim := sp.kr_limits(q.base_price, o.trade_date);
        if o.limit_price > lim.upper or o.limit_price < lim.lower then
          update sp.orders set status = 'rejected', reject_reason = 'price_limit', reserved_amount = 0, updated_at = now() where id = o.id and status in ('reserved','open');
          continue;
        end if;
      end if;
    end if;

    if o.fill_basis = '1d' then
      if p_now < s.close_at then continue; end if;
      select * into cnd from sp.candles c
       where c.market = o.market and c.symbol = o.symbol and c.tf = '1d' and sp.local_date(o.market, c.t) = o.trade_date
       limit 1;
      if not found then continue; end if;  -- 일봉 공개 전(지연): 그대로 둔다
      px := case
        when o.order_type = 'market' then cnd.c
        when o.side = 'buy' and cnd.l <= o.limit_price then least(cnd.o, o.limit_price)
        when o.side = 'sell' and cnd.h >= o.limit_price then greatest(cnd.o, o.limit_price)
      end;
      if px is null then
        update sp.orders set status = 'expired', reserved_amount = 0, updated_at = now() where id = o.id and status in ('reserved','open');
      elsif sp._fill(o.id, px, s.close_at, 'candle:1d:' || cnd.source, cnd.t) = 'filled' then
        filled := filled + 1;
      end if;
      continue;
    end if;

    -- 1m
    if p_now < s.open_at then continue; end if;
    if o.status = 'reserved' then
      select * into cnd from sp.candles c
       where c.market = o.market and c.symbol = o.symbol and c.tf = '1m' and c.t >= s.open_at and c.t < s.close_at
       order by c.t limit 1;
      if not found then continue; end if;
      if o.order_type = 'market'
         or (o.side = 'buy' and cnd.o <= o.limit_price) or (o.side = 'sell' and cnd.o >= o.limit_price) then
        if sp._fill(o.id, cnd.o, cnd.t, 'candle:1m:' || cnd.source, cnd.t) = 'filled' then filled := filled + 1; end if;
        continue;
      end if;
      -- 시가에 안 맞으면 대기 주문으로: 첫 봉부터 저·고가 검사
      update sp.orders set status = 'open', checked_until = cnd.t - interval '1 millisecond', updated_at = now() where id = o.id and status = 'reserved';
      o.status := 'open';
      o.checked_until := cnd.t - interval '1 millisecond';
    end if;

    -- 대기 지정가: 접수한 분 다음 봉부터(접수 전 가격으로 체결되지 않게)
    last_t := null;
    px := null;
    for cnd in select * from sp.candles c
                where c.market = o.market and c.symbol = o.symbol and c.tf = '1m'
                  and c.t > coalesce(o.checked_until, date_trunc('minute', o.created_at))
                  and c.t >= s.open_at and c.t < s.close_at
                order by c.t loop
      last_t := cnd.t;
      if o.side = 'buy' and cnd.l <= o.limit_price then px := least(cnd.o, o.limit_price); end if;
      if o.side = 'sell' and cnd.h >= o.limit_price then px := greatest(cnd.o, o.limit_price); end if;
      if px is not null then
        if sp._fill(o.id, px, cnd.t, 'candle:1m:' || cnd.source, cnd.t) = 'filled' then filled := filled + 1; end if;
        exit;
      end if;
    end loop;
    if px is null and last_t is not null then
      update sp.orders set checked_until = last_t, updated_at = now() where id = o.id and status = 'open';
    end if;
  end loop;
  return filled;
end $$;

-- 당일 유효 만료(1m). 1d(지연 모드)는 일봉이 올 때까지 두고 process_orders 가 처리한다.
create function sp.expire_orders(p_market text, p_now timestamptz default now()) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update sp.orders o set status = 'expired', reserved_amount = 0, updated_at = now()
   where o.market = p_market and o.status in ('reserved','open') and o.fill_basis = '1m'
     and (o.trade_date < sp.local_date(p_market, p_now)
          or (o.trade_date = sp.local_date(p_market, p_now) and p_now >= (sp.session(p_market, o.trade_date)).close_at));
  get diagnostics n = row_count;
  return n;
end $$;

-- ───────── 권한 ─────────
revoke execute on function
  sp.market_tz(text), sp.local_date(text, timestamptz), sp.session(text, date), sp.next_session_date(text, date),
  sp.add_sessions(text, date, integer), sp.rate_on(text, text, date, boolean), sp.tick_for(text, numeric, date),
  sp.kr_limits(numeric, date), sp.order_costs(text, text, text, numeric, numeric, date),
  sp.available_cash(smallint, text, bigint), sp.available_qty(smallint, text, text, bigint),
  sp._fill(bigint, numeric, timestamptz, text, timestamptz),
  sp._place_order(smallint, text, text, text, text, numeric, numeric, boolean, text, timestamptz, bigint),
  sp.place_order(text, text, text, text, numeric, numeric, boolean),
  sp.place_order_bot(smallint, text, text, text, text, numeric, numeric, bigint),
  sp.cancel_order(bigint), sp.process_orders(text, timestamptz), sp.expire_orders(text, timestamptz)
from public, anon, authenticated, service_role;

grant execute on function sp.place_order(text, text, text, text, numeric, numeric, boolean), sp.cancel_order(bigint) to authenticated;
grant execute on function sp.process_orders(text, timestamptz), sp.expire_orders(text, timestamptz),
  sp.place_order_bot(smallint, text, text, text, text, numeric, numeric, bigint) to service_role;

alter table sp.orders    enable row level security;
alter table sp.fills     enable row level security;
alter table sp.tax_lots  enable row level security;
alter table sp.lot_sales enable row level security;

-- 읽기: 허용 계정 전원(비교 화면). 쓰기: 없음(함수만)
grant select on sp.orders, sp.fills, sp.tax_lots, sp.lot_sales, sp.positions to authenticated;
create policy member_read on sp.orders    for select to authenticated using (sp.me() is not null);
create policy member_read on sp.fills     for select to authenticated using (sp.me() is not null);
create policy member_read on sp.tax_lots  for select to authenticated using (sp.me() is not null);
create policy member_read on sp.lot_sales for select to authenticated using (sp.me() is not null);
