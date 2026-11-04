-- 0006_kv_claim_key: sp.kv_claim 이 쓸 수 있는 키를 'kis_token_issue_at' 하나로 제한(리뷰 P1).
-- server_kv 의 다른 행(cron_token·kis_token 등)을 claim 으로 덮어쓰지 못하게 한다. 실행 권한(service_role)은 그대로.
create or replace function sp.kv_claim(p_key text, p_min_gap_ms integer) returns boolean
language plpgsql set search_path = '' as $$
declare
  v_hit integer;
begin
  if p_key is distinct from 'kis_token_issue_at' then
    raise exception 'key not allowed' using errcode = '22023';
  end if;
  if p_min_gap_ms is null or p_min_gap_ms < 0 then
    raise exception 'invalid gap' using errcode = '22023';
  end if;

  update sp.server_kv
     set value = now()::text, updated_at = clock_timestamp()
   where key = p_key
     and updated_at < clock_timestamp() - make_interval(secs => p_min_gap_ms / 1000.0);
  get diagnostics v_hit = row_count;
  if v_hit = 1 then
    return true;
  end if;

  insert into sp.server_kv (key, value, updated_at) values (p_key, now()::text, clock_timestamp())
  on conflict (key) do nothing;
  get diagnostics v_hit = row_count;
  return v_hit = 1;
end $$;

-- create or replace 는 권한을 그대로 두지만, 명시해 둔다
revoke execute on function sp.kv_claim(text, integer) from public, anon, authenticated;
grant execute on function sp.kv_claim(text, integer) to service_role;
