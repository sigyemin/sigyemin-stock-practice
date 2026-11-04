// 허용 목록(allowlist)만 부르는 fetch. 목록 밖의 호스트·경로·메서드·TR ID 는 요청을 보내기 전에 막는다.
// 시세 공급자 어댑터는 반드시 이 함수로 만든 fetch 만 쓴다(주문·잔고·계좌 경로는 목록에 없다).

export type AllowRule = {
  method: 'GET' | 'POST';
  origin: string; // 'https://host[:port]'
  path: string | RegExp; // 정확히 같은 경로, 또는 정규식(전체 일치)
  trIds?: string[]; // KIS: 이 경로에서 허용하는 tr_id 헤더 값
};

export class AllowlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllowlistError';
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function headerValue(init: RequestInit | undefined, name: string): string | null {
  const h = new Headers(init?.headers ?? {});
  return h.get(name);
}

export function isAllowed(rules: AllowRule[], url: string, init?: RequestInit): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const method = (init?.method ?? 'GET').toUpperCase();
  const trId = headerValue(init, 'tr_id');
  return rules.some((r) => {
    if (r.method !== method || r.origin !== u.origin) return false;
    const pathOk = typeof r.path === 'string' ? r.path === u.pathname : new RegExp(`^(?:${r.path.source})$`).test(u.pathname);
    if (!pathOk) return false;
    if (r.trIds) return trId !== null && r.trIds.includes(trId);
    return trId === null;
  });
}

export function guardedFetch(rules: AllowRule[], fetchImpl: FetchLike): FetchLike {
  return (url: string, init?: RequestInit) => {
    if (!isAllowed(rules, url, init)) {
      const u = (() => {
        try {
          const x = new URL(url);
          return `${x.origin}${x.pathname}`;
        } catch {
          return 'invalid-url';
        }
      })();
      return Promise.reject(new AllowlistError(`blocked: ${(init?.method ?? 'GET').toUpperCase()} ${u}`));
    }
    return fetchImpl(url, { ...init, redirect: 'error' });
  };
}
