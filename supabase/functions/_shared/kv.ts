// 서버 전용 키-값 저장소(sp.server_kv). authenticated·anon 권한 없음, 서버 함수(secret 키)만 읽고 쓴다.
// 쓰임: KIS 접근 토큰 재사용, cron 호출 확인용 토큰.

export type KvRow = { value: string; expires_at: string | null; updated_at?: string };

export interface KvStore {
  get(key: string): Promise<KvRow | null>;
  set(key: string, value: string, expiresAt: Date | null): Promise<void>;
  // key 의 마지막 기록이 minGapMs 보다 오래됐을 때만 지금 시각으로 기록하고 true. 원자적(DB: sp.kv_claim)
  claim(key: string, minGapMs: number): Promise<boolean>;
}

export class MemoryKv implements KvStore {
  rows = new Map<string, KvRow>();
  async get(key: string) {
    return this.rows.get(key) ?? null;
  }
  now: () => Date = () => new Date();
  async set(key: string, value: string, expiresAt: Date | null) {
    this.rows.set(key, { value, expires_at: expiresAt ? expiresAt.toISOString() : null, updated_at: this.now().toISOString() });
  }
  async claim(key: string, minGapMs: number) {
    const row = this.rows.get(key);
    const t = this.now().getTime();
    if (row?.updated_at && t - Date.parse(row.updated_at) < minGapMs) return false;
    await this.set(key, this.now().toISOString(), null);
    return true;
  }
}

// 길이가 같을 때 시간 차이로 값이 새지 않게 비교
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// cron 이 보낸 x-cron-token 확인. 저장된 토큰이 없거나 짧으면 항상 거부.
export async function verifyCronToken(kv: KvStore, req: Request): Promise<boolean> {
  const got = req.headers.get('x-cron-token') ?? '';
  const row = await kv.get('cron_token');
  if (!row || row.value.length < 32 || got.length === 0) return false;
  return safeEqual(got, row.value);
}
