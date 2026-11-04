-- 0008_fx_div_tax: 환전·배당·해외주식 양도세(M4). 돈은 원장으로만, 접수·처리는 security definer 함수로만.
--   브라우저(authenticated): sp.fx_convert(본인 계좌 간, dry_run), sp.cgt_pay(본인, 5월) + 내역 읽기
--   서버(service_role): sp.daily_close(배당 권리·지급, 결제일 환율), sp.tax_annual(1/1 확정, 5/31 자동),
--                      sp.fx_convert_bot(봇만), sp.upsert_dividend_events(ref-sync)
--   숫자(스프레드·우대율·배당세율·양도세율·공제)는 요율표에서만.
-- 이 파일 맨 아래에 0007 함수 두 개를 고쳐 다시 만든다:
--   sp._fill        — 미국 체결 환율은 fx_max_age_days 이내 고시값만(리뷰 R10), 너무 오래되면 비워 둔다
--   sp.expire_orders — created_at,id 순으로 잠근 뒤 만료(process_orders 와 같은 잠금 순서, 리뷰 R11)

insert into sp.app_settings (key, value, note) values
  ('fx_max_age_days', '7', '환전·체결·결제일 환율로 쓸 수 있는 고시값의 최대 경과일(오늘 값이 없으면 직전 고시값)')
on conflict (key) do nothing;

-- ───────── 환율 도우미 ─────────
-- p_date 이전(포함) 가장 최근 고시값. p_max_age_days 보다 오래됐으면 null
create function sp.fx_on(p_date date, p_max_age_days integer, out rate_date date, out usdkrw numeric)
language sql stable set search_path = '' as $$
  select r.rate_date, r.usdkrw from sp.fx_rates r
   where r.rate_date <= p_date and r.rate_date >= p_date - p_max_age_days
   order by r.rate_date desc limit 1
$$;

create function sp.fx_max_age() returns integer
language sql stable set search_path = '' as $$
  select coalesce((select value::integer from sp.app_settings where key = 'fx_max_age_days'), 7)
$$;

-- ───────── 환전 ─────────
create table sp.fx_conversions (
  id             bigserial primary key,
  participant_id smallint not null references sp.participants(id),
  direction      text not null check (direction in ('KRW_TO_USD','USD_TO_KRW')),
  base_rate      numeric not null check (base_rate > 0),
  base_rate_date date not null,
  applied_rate   numeric not null check (applied_rate > 0),
  krw_amount     numeric not null check (krw_amount > 0),
  usd_amount     numeric not null check (usd_amount > 0),
  rate_ids       bigint[] not null,
  created_by     text not null default 'user' check (created_by in ('user','bot')),
  at             timestamptz not null default now()
);
create index on sp.fx_conversions (participant_id, at desc);

-- 원→달러: 적용 = 기준 × (1 + 스프레드×(1−우대)), 받는 달러 = 원 ÷ 적용(센트 절사)
-- 달러→원: 적용 = 기준 × (1 − 스프레드×(1−우대)), 받는 원 = 달러 × 적용(원 절사)   (설계서 §4.4, 결정 환전 0.1%)
create function sp._fx_convert(p_participant smallint, p_direction text, p_amount numeric, p_dry_run boolean,
                               p_created_by text, p_now timestamptz)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  today date := sp.local_date('KR', p_now);
  fx record;
  sp_r record;
  pf_r record;
  eff numeric;
  applied numeric;
  krw numeric;
  usd numeric;
  acc_krw bigint;
  acc_usd bigint;
  cid bigint;
begin
  if p_direction not in ('KRW_TO_USD','USD_TO_KRW') then raise exception 'invalid_direction' using errcode = '22023'; end if;
  if p_amount is null or p_amount = 'NaN'::numeric or p_amount <= 0 or p_amount >= 1000000000000 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  if p_direction = 'KRW_TO_USD' and p_amount <> trunc(p_amount) then raise exception 'invalid_amount' using errcode = '22023'; end if;
  if p_direction = 'USD_TO_KRW' and p_amount <> trunc(p_amount, 2) then raise exception 'invalid_amount' using errcode = '22023'; end if;

  select * into fx from sp.fx_on(today, sp.fx_max_age());
  if fx.usdkrw is null then raise exception 'fx_stale' using errcode = '22023'; end if;
  sp_r := sp.rate_on('FX_SPREAD', null, today);
  pf_r := sp.rate_on('FX_PREF', null, today);
  eff := sp_r.value * (1 - pf_r.value);

  -- 두 계좌를 같은 순서(KRW → USD)로 잠근다
  select id into acc_krw from sp.accounts where participant_id = p_participant and currency = 'KRW' for update;
  select id into acc_usd from sp.accounts where participant_id = p_participant and currency = 'USD' for update;

  if p_direction = 'KRW_TO_USD' then
    applied := fx.usdkrw * (1 + eff);
    krw := p_amount;
    usd := floor(krw / applied * 100) / 100;
    if usd < 0.01 then raise exception 'amount_too_small' using errcode = '22023'; end if;
    if sp.available_cash(p_participant, 'KRW') < krw then raise exception 'insufficient_funds' using errcode = '22023'; end if;
  else
    applied := fx.usdkrw * (1 - eff);
    usd := p_amount;
    krw := floor(usd * applied);
    if krw < 1 then raise exception 'amount_too_small' using errcode = '22023'; end if;
    if sp.available_cash(p_participant, 'USD') < usd then raise exception 'insufficient_funds' using errcode = '22023'; end if;
  end if;

  if p_dry_run then
    return jsonb_build_object('ok', true, 'dry_run', true, 'direction', p_direction, 'base_rate', fx.usdkrw, 'base_rate_date', fx.rate_date,
      'applied_rate', applied, 'krw_amount', krw, 'usd_amount', usd);
  end if;

  insert into sp.fx_conversions (participant_id, direction, base_rate, base_rate_date, applied_rate, krw_amount, usd_amount, rate_ids, created_by, at)
  values (p_participant, p_direction, fx.usdkrw, fx.rate_date, applied, krw, usd, array[sp_r.id, pf_r.id], p_created_by, p_now)
  returning id into cid;

  insert into sp.cash_ledger (account_id, kind, amount, ref_table, ref_id) values
    (case p_direction when 'KRW_TO_USD' then acc_krw else acc_usd end, 'fx_out',
     case p_direction when 'KRW_TO_USD' then -krw else -usd end, 'fx_conversions', cid),
    (case p_direction when 'KRW_TO_USD' then acc_usd else acc_krw end, 'fx_in',
     case p_direction when 'KRW_TO_USD' then usd else krw end, 'fx_conversions', cid);

  return jsonb_build_object('ok', true, 'conversion_id', cid, 'direction', p_direction, 'base_rate', fx.usdkrw, 'base_rate_date', fx.rate_date,
    'applied_rate', applied, 'krw_amount', krw, 'usd_amount', usd);
end $$;

create function sp.fx_convert(p_direction text, p_amount numeric, p_dry_run boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me smallint := sp.me();
begin
  if me is null then raise exception 'not_registered' using errcode = '42501'; end if;
  if (select kind from sp.participants where id = me) <> 'human' then raise exception 'forbidden' using errcode = '42501'; end if;
  return sp._fx_convert(me, p_direction, p_amount, p_dry_run, 'user', now());
end $$;

create function sp.fx_convert_bot(p_participant smallint, p_direction text, p_amount numeric) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if (select kind from sp.participants where id = p_participant) is distinct from 'bot' then
    raise exception 'not_bot' using errcode = '42501';
  end if;
  return sp._fx_convert(p_participant, p_direction, p_amount, false, 'bot', now());
end $$;

-- ───────── 배당 ─────────
create table sp.dividend_events (
  id             bigserial primary key,
  market         text not null check (market in ('KR','US')),
  symbol         text not null,
  ex_date        date,                                -- 모르면 null → 기준일 직전 거래일로 계산
  record_date    date not null,
  pay_date       date not null,
  cash_per_share numeric not null check (cash_per_share > 0),
  currency       text not null check (currency in ('KRW','USD')),
  source         text not null,
  updated_at     timestamptz not null default now(),
  unique (market, symbol, record_date),
  foreign key (market, symbol) references sp.instruments(market, symbol),
  check (pay_date >= record_date),
  check ((market = 'KR') = (currency = 'KRW'))
);

create table sp.dividend_payouts (
  id              bigserial primary key,
  event_id        bigint not null references sp.dividend_events(id),
  participant_id  smallint not null references sp.participants(id),
  qty_at_record   numeric not null check (qty_at_record > 0),
  entitled_at     timestamptz not null,               -- 권리 판정 시각(배당락일 전날 장 마감)
  gross           numeric,
  withheld        numeric,
  net             numeric,
  rate_ids        bigint[],
  status          text not null default 'entitled' check (status in ('entitled','paid')),
  paid_at         timestamptz,
  unique (event_id, participant_id)
);

-- 배당락일: 주어지면 그 날, 없으면 기준일의 직전 거래일(결정 Q-D8)
create function sp.dividend_ex_date(p_market text, p_record date, p_ex date) returns date
language plpgsql stable set search_path = '' as $$
declare d date := p_record - 1;
begin
  if p_ex is not null then return p_ex; end if;
  for i in 1..30 loop
    if (sp.session(p_market, d)).is_open then return d; end if;
    d := d - 1;
  end loop;
  raise exception 'no session before record date' using errcode = '22023';
end $$;

-- 권리 판정 시각 = 배당락일 직전 거래일의 정규장 마감
create function sp.dividend_cutoff(p_market text, p_record date, p_ex date) returns timestamptz
language plpgsql stable set search_path = '' as $$
declare
  ex date := sp.dividend_ex_date(p_market, p_record, p_ex);
  d date := ex - 1;
begin
  for i in 1..30 loop
    if (sp.session(p_market, d)).is_open then return (sp.session(p_market, d)).close_at; end if;
    d := d - 1;
  end loop;
  raise exception 'no session before ex date' using errcode = '22023';
end $$;

-- 그 시각까지 체결된 수량(매수 − 매도)
create function sp.qty_at(p_participant smallint, p_market text, p_symbol text, p_at timestamptz) returns numeric
language sql stable set search_path = '' as $$
  select coalesce(sum(case o.side when 'buy' then f.qty else -f.qty end), 0)
    from sp.fills f join sp.orders o on o.id = f.order_id
   where o.participant_id = p_participant and o.market = p_market and o.symbol = p_symbol and f.at <= p_at
$$;

-- ref-sync 가 넣는 배당 일정(서버만). 이미 권리가 생긴 일정은 금액·날짜를 바꾸지 않는다
create function sp.upsert_dividend_events(p_rows jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r jsonb;
  n integer := 0;
begin
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    if not exists (select 1 from sp.instruments i where i.market = r->>'market' and i.symbol = r->>'symbol') then continue; end if;
    insert into sp.dividend_events (market, symbol, ex_date, record_date, pay_date, cash_per_share, currency, source)
    values (r->>'market', r->>'symbol', nullif(r->>'ex_date', '')::date, (r->>'record_date')::date, (r->>'pay_date')::date,
            (r->>'cash_per_share')::numeric, case r->>'market' when 'KR' then 'KRW' else 'USD' end, r->>'source')
    on conflict (market, symbol, record_date) do update
      set ex_date = excluded.ex_date, pay_date = excluded.pay_date, cash_per_share = excluded.cash_per_share,
          source = excluded.source, updated_at = now()
      where not exists (select 1 from sp.dividend_payouts p where p.event_id = sp.dividend_events.id);
    n := n + 1;
  end loop;
  return n;
end $$;

-- 권리 확정 + 지급. 한국 = 총액 − (소득세 14% + 그 10%) 원 미만 절사, 미국 = 총액 − 15%(센트 절사) [요율표]
create function sp._dividends(p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  e record;
  p record;
  cutoff timestamptz;
  q numeric;
  v_gross numeric;
  v_w numeric;
  r1 record; r2 record; r3 record;
  acc bigint;
  n_ent integer := 0;
  n_paid integer := 0;
begin
  -- 권리 확정: 판정 시각이 지났고 아직 지급일 전후 상관없이 한 번만
  for e in select * from sp.dividend_events d
            where not exists (select 1 from sp.dividend_payouts x where x.event_id = d.id)
              and d.record_date >= sp.local_date(d.market, p_now) - 400 loop
    cutoff := sp.dividend_cutoff(e.market, e.record_date, e.ex_date);
    if p_now < cutoff then continue; end if;
    for p in select id from sp.participants loop
      q := sp.qty_at(p.id, e.market, e.symbol, cutoff);
      if q > 0 then
        insert into sp.dividend_payouts (event_id, participant_id, qty_at_record, entitled_at)
        values (e.id, p.id, q, cutoff) on conflict do nothing;
        n_ent := n_ent + 1;
      end if;
    end loop;
  end loop;

  -- 지급: 지급일(현지 날짜)이 된 권리
  for p in select x.*, d.market, d.cash_per_share, d.pay_date, d.currency from sp.dividend_payouts x
            join sp.dividend_events d on d.id = x.event_id
           where x.status = 'entitled' and d.pay_date <= sp.local_date(d.market, p_now)
           order by x.id for update of x loop
    if p.market = 'KR' then
      v_gross := floor(p.qty_at_record * p.cash_per_share);
      r1 := sp.rate_on('KR_DIV_TAX', null, p.pay_date);
      r2 := sp.rate_on('KR_DIV_LOCAL_TAX', null, p.pay_date);
      v_w := floor(v_gross * r1.value);
      v_w := v_w + floor(v_w * r2.value);
      r3 := null;
    else
      v_gross := floor(p.qty_at_record * p.cash_per_share * 100) / 100;
      r1 := sp.rate_on('US_DIV_WHT', null, p.pay_date);
      r2 := sp.rate_on('KR_DIV_TAX_FOREIGN_EXTRA', null, p.pay_date);
      v_w := v_gross - floor((v_gross - v_gross * r1.value) * 100) / 100;   -- 받는 돈을 센트 절사
      v_w := round(v_w + floor(v_gross * r2.value * 100) / 100, 2);        -- 국내 추가 징수(현행 0)
      v_gross := round(v_gross, 2);
    end if;
    select id into acc from sp.accounts where participant_id = p.participant_id and currency = p.currency for update;
    update sp.dividend_payouts set gross = v_gross, withheld = v_w, net = v_gross - v_w, status = 'paid', paid_at = p_now,
           rate_ids = array_remove(array[r1.id, r2.id], null)
     where id = p.id;
    insert into sp.cash_ledger (account_id, kind, amount, ref_table, ref_id) values
      (acc, 'dividend', v_gross, 'dividend_payouts', p.id);
    if v_w <> 0 then
      insert into sp.cash_ledger (account_id, kind, amount, ref_table, ref_id) values (acc, 'dividend_tax', -v_w, 'dividend_payouts', p.id);
    end if;
    n_paid := n_paid + 1;
  end loop;
  return jsonb_build_object('entitled', n_ent, 'paid', n_paid);
end $$;

-- ───────── 해외주식 양도세 ─────────
-- 매도 체결마다 실현손익(원화) = (매도금액 − 매도 비용) × 매도 결제일 환율 − Σ(매수 묶음 취득가 × 매수 결제일 환율)
-- 과세 연도 = 매도 결제일의 연도(양도 시기 = 대금 청산일로 봄 — 추정, 질문 파일)
create table sp.cgt_realized (
  sell_fill_id   bigint primary key references sp.fills(id),
  participant_id smallint not null references sp.participants(id),
  tax_year       integer not null,
  proceeds_krw   numeric not null,
  cost_krw       numeric not null,
  gain_krw       numeric not null,
  fx_settle      numeric not null,
  computed_at    timestamptz not null default now()
);
create index on sp.cgt_realized (participant_id, tax_year);

create table sp.tax_assessments (
  id                bigserial primary key,
  participant_id    smallint not null references sp.participants(id),
  tax_year          integer not null,
  realized_gain_krw numeric not null,
  deduction_krw     numeric not null,
  tax_krw           numeric not null check (tax_krw >= 0),
  rate_ids          bigint[] not null,
  status            text not null default 'estimated' check (status in ('estimated','assessed','paid')),
  due_date          date,
  paid_at           timestamptz,
  paid_by           text check (paid_by in ('user','auto')),
  updated_at        timestamptz not null default now(),
  unique (participant_id, tax_year)
);

-- 세액 = max(0, 연간 손익 합계 − 기본공제) × (세율 + 지방세율), 원 미만 절사 (설계서 §4.2)
create function sp.cgt_compute(p_gain numeric, p_year integer, out deduction numeric, out tax numeric, out rate_ids bigint[])
language plpgsql stable set search_path = '' as $$
declare
  d date := make_date(p_year, 12, 31);
  r1 record := sp.rate_on('US_CGT_DEDUCTION', null, d);
  r2 record := sp.rate_on('US_CGT_RATE', null, d);
  r3 record := sp.rate_on('US_CGT_LOCAL', null, d);
begin
  deduction := r1.value;
  tax := floor(greatest(0, p_gain - r1.value) * (r2.value + r3.value));
  rate_ids := array[r1.id, r2.id, r3.id];
end $$;

-- 예상 세액 갱신(확정 전 연도만)
create function sp._cgt_refresh(p_participant smallint, p_year integer) returns void
language plpgsql security definer set search_path = '' as $$
declare
  g numeric;
  c record;
begin
  select coalesce(sum(gain_krw), 0) into g from sp.cgt_realized where participant_id = p_participant and tax_year = p_year;
  c := sp.cgt_compute(g, p_year);
  insert into sp.tax_assessments (participant_id, tax_year, realized_gain_krw, deduction_krw, tax_krw, rate_ids, status, due_date)
  values (p_participant, p_year, g, c.deduction, c.tax, c.rate_ids, 'estimated', make_date(p_year + 1, 5, 31))
  on conflict (participant_id, tax_year) do update
    set realized_gain_krw = excluded.realized_gain_krw, deduction_krw = excluded.deduction_krw, tax_krw = excluded.tax_krw,
        rate_ids = excluded.rate_ids, updated_at = now()
    where sp.tax_assessments.status = 'estimated';
end $$;

-- 결제일 환율 채우기(미국 체결) → 매수 묶음 원화 취득가 → 매도 실현손익 → 예상 세액
create function sp._settle_fx(p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  f record;
  fx record;
  n_fx integer := 0;
  n_gain integer := 0;
  s record;
  cost numeric;
  missing boolean;
begin
  for f in select fl.id, fl.settle_date from sp.fills fl join sp.orders o on o.id = fl.order_id
            where o.market = 'US' and fl.fx_rate_settle is null and fl.settle_date <= sp.local_date('KR', p_now)
            order by fl.id for update of fl loop
    select * into fx from sp.fx_on(f.settle_date, sp.fx_max_age());
    if fx.usdkrw is null then continue; end if;
    -- 결제일 당일 고시값이 아직 안 나왔으면(한국 날짜가 결제일과 같을 때) 다음 실행까지 기다린다. 결제일이 휴일이면 다음 날 직전 고시값
    if fx.rate_date < f.settle_date and sp.local_date('KR', p_now) = f.settle_date then continue; end if;
    update sp.fills set fx_rate_settle = fx.usdkrw where id = f.id;
    update sp.tax_lots set cost_krw = floor(cost_local * fx.usdkrw) where buy_fill_id = f.id;
    n_fx := n_fx + 1;
  end loop;

  for s in select fl.id, fl.gross, fl.broker_fee, fl.reg_fee, fl.tx_tax, fl.fx_rate_settle, fl.settle_date, o.participant_id
             from sp.fills fl join sp.orders o on o.id = fl.order_id
            where o.market = 'US' and o.side = 'sell' and fl.fx_rate_settle is not null
              and not exists (select 1 from sp.cgt_realized c where c.sell_fill_id = fl.id) loop
    select bool_or(l.cost_krw is null), coalesce(sum(floor(ls.cost_local * bf.fx_rate_settle)), 0) into missing, cost
      from sp.lot_sales ls join sp.tax_lots l on l.id = ls.lot_id join sp.fills bf on bf.id = l.buy_fill_id
     where ls.sell_fill_id = s.id;
    if missing then continue; end if;  -- 매수 결제일 환율이 아직 없음
    insert into sp.cgt_realized (sell_fill_id, participant_id, tax_year, proceeds_krw, cost_krw, gain_krw, fx_settle)
    values (s.id, s.participant_id, extract(year from s.settle_date)::integer,
            floor((s.gross - s.broker_fee - s.reg_fee - s.tx_tax) * s.fx_rate_settle), cost,
            floor((s.gross - s.broker_fee - s.reg_fee - s.tx_tax) * s.fx_rate_settle) - cost, s.fx_rate_settle);
    perform sp._cgt_refresh(s.participant_id, extract(year from s.settle_date)::integer);
    n_gain := n_gain + 1;
  end loop;
  return jsonb_build_object('fx_filled', n_fx, 'gains', n_gain);
end $$;

-- 매일 마감 처리(서버): 결제일 환율·실현손익, 배당 권리·지급
create function sp.daily_close(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  return sp._settle_fx(p_now) || sp._dividends(p_now);
end $$;

-- 연간 정산(서버, 매일 돌려도 됨): 1월 1일 이후 지난해 확정, 납부 기한(5/31) 당일 이후 자동 차감
create function sp.tax_annual(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  today date := sp.local_date('KR', p_now);
  last_year integer := extract(year from today)::integer - 1;
  p record;
  a record;
  acc bigint;
  n_assessed integer := 0;
  n_paid integer := 0;
begin
  perform sp._settle_fx(p_now);
  -- 확정: 지난해 실현손익이 있는 참가자(없으면 행 없음 = 낼 세금 없음)
  for p in select distinct participant_id from sp.cgt_realized where tax_year = last_year loop
    perform sp._cgt_refresh(p.participant_id, last_year);
    update sp.tax_assessments set status = 'assessed', due_date = make_date(last_year + 1, 5, 31), updated_at = now()
     where participant_id = p.participant_id and tax_year = last_year and status = 'estimated';
    if found then n_assessed := n_assessed + 1; end if;
  end loop;
  -- 자동 납부: 기한 날 밤. 원화가 모자라면 마이너스(결정사항)
  -- 기한 날 23:30(한국) 이후 = 그날 본인 납부 기회를 남긴다(cron 은 23:50 한국)
  for a in select * from sp.tax_assessments
            where status = 'assessed' and p_now >= (due_date + time '23:30') at time zone 'Asia/Seoul' order by id for update loop
    select id into acc from sp.accounts where participant_id = a.participant_id and currency = 'KRW' for update;
    if a.tax_krw > 0 then
      insert into sp.cash_ledger (account_id, kind, amount, ref_table, ref_id) values (acc, 'cgt_payment', -a.tax_krw, 'tax_assessments', a.id);
    end if;
    update sp.tax_assessments set status = 'paid', paid_at = p_now, paid_by = 'auto', updated_at = now() where id = a.id;
    n_paid := n_paid + 1;
  end loop;
  return jsonb_build_object('assessed', n_assessed, 'auto_paid', n_paid);
end $$;

-- 본인 납부(5월 1일~31일, 한국 날짜)
create function sp._cgt_pay(p_participant smallint, p_year integer, p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  today date := sp.local_date('KR', p_now);
  a sp.tax_assessments;
  acc bigint;
begin
  select * into a from sp.tax_assessments where participant_id = p_participant and tax_year = p_year for update;
  if not found or a.status <> 'assessed' then raise exception 'nothing_to_pay' using errcode = '22023'; end if;
  if today < make_date(p_year + 1, 5, 1) or today > a.due_date then raise exception 'not_payment_period' using errcode = '22023'; end if;
  select id into acc from sp.accounts where participant_id = p_participant and currency = 'KRW' for update;
  if a.tax_krw > 0 then
    insert into sp.cash_ledger (account_id, kind, amount, ref_table, ref_id) values (acc, 'cgt_payment', -a.tax_krw, 'tax_assessments', a.id);
  end if;
  update sp.tax_assessments set status = 'paid', paid_at = p_now, paid_by = 'user', updated_at = now() where id = a.id;
  return jsonb_build_object('ok', true, 'tax_year', p_year, 'tax_krw', a.tax_krw, 'status', 'paid');
end $$;

create function sp.cgt_pay(p_year integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me smallint := sp.me();
begin
  if me is null then raise exception 'not_registered' using errcode = '42501'; end if;
  if (select kind from sp.participants where id = me) <> 'human' then raise exception 'forbidden' using errcode = '42501'; end if;
  return sp._cgt_pay(me, p_year, now());
end $$;

-- ───────── 0007 함수 고치기 ─────────
-- (R10) 미국 체결 환율: 최대 경과일 안의 고시값만
create or replace function sp._fill(p_order bigint, p_price numeric, p_at timestamptz, p_source text, p_quote_at timestamptz)
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
    -- 체결일 환율: fx_max_age_days 이내 고시값만. 너무 오래되면 비워 둔다(양도세는 결제일 환율을 쓰고, 그것도 같은 기준으로 기다림)
    fx := (sp.fx_on(o.trade_date, sp.fx_max_age())).usdkrw;
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

-- (R11) 만료도 created_at,id 순으로 행을 잠근 뒤(process_orders 와 같은 순서) → 겹친 tick 사이 교착 방지
create or replace function sp.expire_orders(p_market text, p_now timestamptz default now()) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  with c as (
    select o.id from sp.orders o
     where o.market = p_market and o.status in ('reserved','open') and o.fill_basis = '1m'
       and (o.trade_date < sp.local_date(p_market, p_now)
            or (o.trade_date = sp.local_date(p_market, p_now) and p_now >= (sp.session(p_market, o.trade_date)).close_at))
     order by o.created_at, o.id
     for update
  )
  update sp.orders o set status = 'expired', reserved_amount = 0, updated_at = now()
    from c where o.id = c.id and o.status in ('reserved','open');
  get diagnostics n = row_count;
  return n;
end $$;

-- ───────── 권한 ─────────
revoke execute on function
  sp.fx_on(date, integer), sp.fx_max_age(),
  sp._fx_convert(smallint, text, numeric, boolean, text, timestamptz),
  sp.fx_convert(text, numeric, boolean), sp.fx_convert_bot(smallint, text, numeric),
  sp.dividend_ex_date(text, date, date), sp.dividend_cutoff(text, date, date), sp.qty_at(smallint, text, text, timestamptz),
  sp.upsert_dividend_events(jsonb), sp._dividends(timestamptz),
  sp.cgt_compute(numeric, integer), sp._cgt_refresh(smallint, integer), sp._settle_fx(timestamptz),
  sp.daily_close(timestamptz), sp.tax_annual(timestamptz), sp._cgt_pay(smallint, integer, timestamptz), sp.cgt_pay(integer),
  sp._fill(bigint, numeric, timestamptz, text, timestamptz), sp.expire_orders(text, timestamptz)
from public, anon, authenticated, service_role;

grant execute on function sp.fx_convert(text, numeric, boolean), sp.cgt_pay(integer) to authenticated;
grant execute on function sp.fx_convert_bot(smallint, text, numeric), sp.upsert_dividend_events(jsonb),
  sp.daily_close(timestamptz), sp.tax_annual(timestamptz), sp.expire_orders(text, timestamptz) to service_role;

alter table sp.fx_conversions   enable row level security;
alter table sp.dividend_events  enable row level security;
alter table sp.dividend_payouts enable row level security;
alter table sp.cgt_realized     enable row level security;
alter table sp.tax_assessments  enable row level security;

grant select on sp.fx_conversions, sp.dividend_events, sp.dividend_payouts, sp.cgt_realized, sp.tax_assessments to authenticated;
create policy member_read on sp.fx_conversions   for select to authenticated using (sp.me() is not null);
create policy member_read on sp.dividend_events  for select to authenticated using (sp.me() is not null);
create policy member_read on sp.dividend_payouts for select to authenticated using (sp.me() is not null);
create policy member_read on sp.cgt_realized     for select to authenticated using (sp.me() is not null);
create policy member_read on sp.tax_assessments  for select to authenticated using (sp.me() is not null);

-- ref-sync(서버)가 배당 대상 종목을 고르려고 보유 종목을 읽는다
grant select on sp.tax_lots to service_role;
