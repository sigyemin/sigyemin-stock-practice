// 지연 모드(KRX Open API·data.go.kr, 일봉 D+1) — KIS 장애 때 되돌리기용 자리.
// M2 범위에서는 구현하지 않았다: 두 공급자의 응답 필드를 공식 문서로 확인하지 못했고(키 없음), 실제 응답 없이 만든 해석은 틀릴 수 있어서.
// 허용 목록은 비워 둔다 → 이 모드로 바꿔도 외부 호출은 일어나지 않고 'not_implemented' 로 끝난다.
import type { AllowRule } from '../http.ts';

export const KRX_ALLOW: AllowRule[] = [];
export const DATAGOKR_ALLOW: AllowRule[] = [];

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`not_implemented: ${what}`);
    this.name = 'NotImplementedError';
  }
}

export function createDelayedKr() {
  return {
    async dailyClose(_symbol: string, _date: string): Promise<never> {
      throw new NotImplementedError('delayed KR quotes (KRX/data.go.kr)');
    },
  };
}
