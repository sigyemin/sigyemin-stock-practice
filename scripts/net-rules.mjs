// 서버 함수(supabase/functions)의 "외부 호출은 허용 목록(_shared/http.ts)으로만" 규칙(순수 함수).
// check-security.mjs 가 쓰고, tests/unit/net-rules.test.js 가 우회 시도로 시험한다.

export const ALLOWLIST_FILE = 'supabase/functions/_shared/http.ts';
export const ADAPTER_WIRING_FILE = 'supabase/functions/_shared/server.ts';

// 어떤 파일에서도 금지(http.ts 포함): 다른 네트워크 수단
const ALWAYS = [
  [/new\s+WebSocket\b/, 'WebSocket'],
  [/\bDeno\.connect(Tls)?\s*\(/, 'Deno.connect'],
  [/\bDeno\.(Command|run)\b/, 'Deno.Command/run'],
  [/\bDeno\.(createHttpClient|HttpClient|serveHttp)\b/, 'Deno http client'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bEventSource\b/, 'EventSource'],
  [/['"`](node:)?(http|https|net|tls|dgram|child_process|http2)['"`]/, 'node 네트워크·프로세스 모듈'],
  [/['"`]npm:(axios|node-fetch|undici|got|ky|superagent|needle|request)(@[^'"`]*)?(\/[^'"`]*)?['"`]/, 'npm HTTP 클라이언트'],
];

// http.ts 밖에서 금지: fetch 라는 이름 자체(호출·대괄호 접근·별칭 모두). 예외: server.ts 의 어댑터 생성 줄
const FETCH_WORD = /\bfetch\b/;
const FETCH_STRING = /\[\s*['"`]fetch['"`]\s*\]|['"`]fetch['"`]/;
const WIRING_LINE = /^\s*return\s+[\w\s&?]+\bcreate(Kis|Alpaca|Exim)\(\{[^}]*\btransport: fetch\b[^}]*\}\)\s*:\s*null;\s*$/;

function stripComment(line) {
  // 문자열 안의 // 는 드물다고 보고 단순 처리(주석에 쓴 'fetch' 단어 때문에 실패하지 않게)
  const i = line.indexOf('//');
  return i >= 0 ? line.slice(0, i) : line;
}

export function netViolations(relPath, source) {
  if (!/^supabase\/functions\/.*\.(ts|js|mjs|tsx|jsx)$/.test(relPath)) return [];
  const out = [];
  source.split('\n').forEach((raw, i) => {
    const line = stripComment(raw);
    if (/^\s*\*/.test(line)) return; // 블록 주석 줄
    for (const [re, label] of ALWAYS) if (re.test(line)) out.push(`${relPath}:${i + 1} 금지된 네트워크 수단(${label})`);
    if (relPath === ALLOWLIST_FILE) return;
    if (FETCH_STRING.test(line)) out.push(`${relPath}:${i + 1} 'fetch' 문자열 접근 금지`);
    if (FETCH_WORD.test(line) && !(relPath === ADAPTER_WIRING_FILE && WIRING_LINE.test(line))) {
      out.push(`${relPath}:${i + 1} fetch 는 _shared/http.ts(허용 목록)에서만`);
    }
  });
  return out;
}
