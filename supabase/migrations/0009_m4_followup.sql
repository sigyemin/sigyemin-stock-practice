-- 0009_m4_followup: M4 리뷰 후속(SP-031). 0008 함수 네 개를 고쳐 다시 만든다(권한은 create or replace 라 그대로).
--   L13 (a) daily_close 결과에 '결제일 환율 대기 미국 체결 수·가장 오래된 결제일', 늦은 손익 표시 수
--       (c) 1/1 확정 뒤 납부 전이면 늦게 생긴 지난해 손익으로 다시 계산, 이미 낸 해는 late_gain 표시만
--       ((b) 지난 날짜 환율 재수집은 fx-sync 함수 쪽)
--   R14 배당 지급 루프: (참가자, 통화 KRW→USD) 순으로 계좌 잠금 — 환전(KRW→USD)과 같은 순서라 교착 없음
--   R15 환전 usd_amount 소수 2자리로 고정

alter table sp.tax_assessments add column late_gain boolean not null default false;
comment on column sp.tax_assessments.late_gain is '납부 뒤 그 해 실현손익이 바뀜(세액은 그대로, 확인 필요)';

create or replace function sp._fx_convert(p_participant smallint, p_direction text, p_amount numeric, p_dry_run boolean,
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
    usd := round(floor(krw / applied * 100) / 100, 2);   -- 소수 자릿수 고정(R15)
    if usd < 0.01 then raise exception 'amount_too_small' using errcode = '22023'; end if;
    if sp.available_cash(p_participant, 'KRW') < krw then raise exception 'insufficient_funds' using errcode = '22023'; end if;
  else
    applied := fx.usdkrw * (1 - eff);
    usd := round(p_amount, 2);
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

create or replace function sp._dividends(p_now timestamptz) returns jsonb
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
           order by x.participant_id, d.currency, x.id for update of x loop   -- 계좌 잠금 순서 = 참가자, KRW→USD(환전과 같음, R14)
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

create or replace function sp._cgt_refresh(p_participant smallint, p_year integer) returns void
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
    where sp.tax_assessments.status in ('estimated', 'assessed');   -- 확정 뒤 납부 전이면 다시 계산(L13)
  -- 이미 낸 해에 손익이 늦게 생기면 금액은 그대로 두고 표시만(사람이 판단)
  update sp.tax_assessments set late_gain = true, updated_at = now()
   where participant_id = p_participant and tax_year = p_year and status = 'paid' and realized_gain_krw <> g and not late_gain;
end $$;

create or replace function sp._settle_fx(p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  f record;
  fx record;
  n_fx integer := 0;
  n_gain integer := 0;
  s record;
  cost numeric;
  missing boolean;
  n_wait integer;
  oldest date;
  n_late integer;
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
  -- 환율 대기 현황(L13): 결제일이 지났는데 결제일 환율이 없는 미국 체결
  select count(*), min(fl.settle_date) into n_wait, oldest from sp.fills fl join sp.orders o on o.id = fl.order_id
   where o.market = 'US' and fl.fx_rate_settle is null and fl.settle_date < sp.local_date('KR', p_now);
  select count(*) into n_late from sp.tax_assessments where late_gain;
  return jsonb_build_object('fx_filled', n_fx, 'gains', n_gain, 'fx_waiting', n_wait, 'fx_waiting_oldest_settle', oldest,
                            'late_gain_paid_years', n_late);
end $$;
