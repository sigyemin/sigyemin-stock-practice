// 서버 함수(supabase/functions)의 "외부 호출은 허용 목록(_shared/http.ts)으로만" 규칙(순수 함수).
// check-security.mjs 가 쓰고, tests/unit/net-rules.test.js 가 우회 시도로 시험한다.
//
// 방식
//   1) 주석만 지운다(문자열·템플릿 안의 // 와 /* 는 그대로 둔다 — 간단한 토큰 처리).
//   2) import 는 허용 목록: 상대 경로('./' '../') + npm:@supabase/supabase-js@2.118.0 만. 동적 import(·require( 금지.
//   3) 네트워크 수단 이름(fetch·WebSocket·Deno.connect·Worker …)과 우회 수단(globalThis[·Reflect.·\u 이스케이프)을 금지.
//   4) fetch·transport 라는 이름은 정해진 줄 모양에서만.
//   5) createClient( 첫 인자는 SUPABASE_URL 변수만, 그 변수는 기본 주입값(SUPABASE_URL 환경변수)에서만.

export const ALLOWLIST_FILE = 'supabase/functions/_shared/http.ts';
export const ADAPTER_WIRING_FILE = 'supabase/functions/_shared/server.ts';
export const ALLOWED_IMPORTS = ['npm:@supabase/supabase-js@2.118.0'];

// 주석을 공백으로 바꾼 소스(줄 수 유지). 문자열 '…' "…" `…` 은 건드리지 않는다.
export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && d === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += c;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\' && i + 1 < n) { out += src[i] + src[i + 1]; i += 2; continue; }
        if (q !== '`' && src[i] === '\n') break; // 닫히지 않은 문자열: 줄 끝에서 멈춤
        out += src[i];
        i++;
      }
      if (i < n && src[i] === q) { out += q; i++; }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const ALWAYS = [
  [/new\s+WebSocket\b|\bWebSocket\s*\(/, 'WebSocket'],
  [/\bDeno\s*\.\s*connect(Tls)?\b/, 'Deno.connect'],
  [/\bDeno\s*\.\s*(Command|run)\b/, 'Deno.Command/run'],
  [/\bDeno\s*\.\s*(createHttpClient|HttpClient|serveHttp)\b/, 'Deno http client'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bEventSource\b/, 'EventSource'],
  [/\bnew\s+(Shared)?Worker\b|\b(Shared)?Worker\s*\(/, 'Worker'],
  [/\bimport\s*\(/, '동적 import('],
  [/\brequire\s*\(/, 'require('],
  [/\bglobalThis\s*\[|\bself\s*\[|\bwindow\s*\[/, '전역 객체 대괄호 접근'],
  [/\bReflect\s*\./, 'Reflect'],
  [/\\u[0-9a-fA-F]{4}|\\u\{|\\x[0-9a-fA-F]{2}/, '\\u·\\x 이스케이프'],
];

const FETCH_WORD = /\bfetch\b/;
const FETCH_STRING = /['"`]fetch['"`]/;
const WIRING_LINE = /^\s*return\s+[\w\s&?]+\bcreate(Kis|Alpaca|Exim)\(\{[^}]*\btransport: fetch\b[^}]*\}\)\s*:\s*null;\s*$/;
// transport 는 (a) server.ts 연결 줄 (b) const f = guardedFetch(X_ALLOW, deps.transport); (c) 타입 선언 transport: FetchLike 만
const TRANSPORT_WORD = /\btransport\b/;
const TRANSPORT_GUARD_LINE = /^\s*const\s+f\s*=\s*guardedFetch\([A-Z_]+_ALLOW,\s*deps\.transport\);\s*$/;
const TRANSPORT_TYPE = /\btransport:\s*FetchLike\b/g;

const CREATE_CLIENT = /\bcreateClient\s*\(/;
const CREATE_CLIENT_OK = /\bcreateClient\(SUPABASE_URL,/;
const URL_ASSIGN = /\bSUPABASE_URL\s*=/;
const URL_ASSIGN_OK = /^\s*const SUPABASE_URL = (Deno\.env\.get\('SUPABASE_URL'\) \?\? ''|env\('SUPABASE_URL'\));\s*$/;

function importViolations(relPath, code) {
  const out = [];
  const specs = [];
  for (const m of code.matchAll(/\b(?:import|export)\b[^;'"`]*?\bfrom\s*(['"`])([^'"`]*)\1/g)) specs.push([m.index, m[2]]);
  for (const m of code.matchAll(/\bimport\s*(['"`])([^'"`]*)\1/g)) specs.push([m.index, m[2]]);
  for (const [idx, s] of specs) {
    const ok = s.startsWith('./') || s.startsWith('../') ? !s.includes('://') : ALLOWED_IMPORTS.includes(s);
    if (!ok) out.push(`${relPath}:${code.slice(0, idx).split('\n').length} 허용되지 않은 import '${s}'`);
  }
  return out;
}

export function netViolations(relPath, source) {
  if (!/^supabase\/functions\/.*\.(ts|js|mjs|tsx|jsx)$/.test(relPath)) return [];
  const code = stripComments(source);
  const out = importViolations(relPath, code);
  code.split('\n').forEach((line, i) => {
    const at = `${relPath}:${i + 1}`;
    for (const [re, label] of ALWAYS) if (re.test(line)) out.push(`${at} 금지(${label})`);
    if (CREATE_CLIENT.test(line) && !CREATE_CLIENT_OK.test(line)) out.push(`${at} createClient 첫 인자는 SUPABASE_URL 변수만`);
    if (URL_ASSIGN.test(line) && !URL_ASSIGN_OK.test(line)) out.push(`${at} SUPABASE_URL 은 기본 주입 환경변수에서만`);
    if (relPath === ALLOWLIST_FILE) return;
    if (FETCH_STRING.test(line)) out.push(`${at} 'fetch' 문자열 금지`);
    const wiring = relPath === ADAPTER_WIRING_FILE && WIRING_LINE.test(line);
    if (FETCH_WORD.test(line) && !wiring) out.push(`${at} fetch 는 _shared/http.ts(허용 목록)에서만`);
    if (TRANSPORT_WORD.test(line) && !wiring && !TRANSPORT_GUARD_LINE.test(line)) {
      // 타입 선언(transport: FetchLike)을 지운 뒤에도 transport 가 남으면 위반(예: deps.transport(url) 직접 호출)
      if (TRANSPORT_WORD.test(line.replace(TRANSPORT_TYPE, ''))) out.push(`${at} transport 는 guardedFetch 에 넘기는 곳에서만`);
    }
  });
  return out;
}
