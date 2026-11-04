// 서버 함수(supabase/functions)의 "외부 호출은 허용 목록(_shared/http.ts)으로만" 규칙(순수 함수).
// check-security.mjs 가 쓰고, tests/unit/net-rules.test.js 가 우회 시도로 시험한다.
//
// 방식
//   1) 주석만 지운다(문자열·템플릿 안의 // 와 /* 는 그대로 둔다 — 간단한 토큰 처리).
//   2) import 는 허용 목록: 상대 경로('./' '../') + npm:@supabase/supabase-js@2.118.0 만. 동적 import(·require( 금지.
//   3) 네트워크 수단 이름(fetch·WebSocket·Deno.connect·Worker …)과 우회 수단(globalThis[·Reflect.·\u 이스케이프)을 금지.
//   4) fetch·transport 라는 이름은 정해진 줄 모양에서만.
//   5) createClient( 첫 인자는 SUPABASE_URL 변수만, 그 변수는 기본 주입값(SUPABASE_URL 환경변수)에서만.
//   6) http.ts 밖: globalThis 금지, Deno 는 Deno.env.get( · Deno.serve( 만. 상대 import 는 supabase/functions/ 안만.
//   한계: 정규식 + 간단한 토큰 처리(구문 분석 아님). 1차 방어는 guardedFetch, 의도적 우회는 리뷰로 잡는다.

export const ALLOWLIST_FILE = 'supabase/functions/_shared/http.ts';
export const ADAPTER_WIRING_FILE = 'supabase/functions/_shared/server.ts';
export const ALLOWED_IMPORTS = ['npm:@supabase/supabase-js@2.118.0'];

// 주석을 공백으로 바꾼 소스(줄 수 유지). 문자열 '…' "…" `…` 과 정규식 리터럴 /…/ 은 건드리지 않는다.
// 정규식 판단: '/' 앞의 의미 있는 토큰이 "값"(식별자·숫자·닫는 괄호·문자열 끝)이 아니면 정규식 시작으로 본다.
const REGEX_PRECEDING_KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);

export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let prevValue = false; // 직전 의미 있는 토큰이 값으로 끝났는가(그러면 '/' 는 나눗셈)
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
        if (q !== '`' && src[i] === '\n') break;
        out += src[i];
        i++;
      }
      if (i < n && src[i] === q) { out += q; i++; }
      prevValue = true;
      continue;
    }
    if (c === '/' && !prevValue) {
      // 정규식 리터럴: 이스케이프와 [...] 문자 클래스 안의 '/' 는 끝이 아니다
      let j = i + 1;
      let inClass = false;
      let ok = false;
      while (j < n && src[j] !== '\n') {
        const ch = src[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { ok = true; break; }
        j++;
      }
      if (ok) {
        j++;
        while (j < n && /[a-z]/i.test(src[j])) j++; // 플래그
        out += src.slice(i, j);
        i = j;
        prevValue = true;
        continue;
      }
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      out += word;
      i = j;
      prevValue = !REGEX_PRECEDING_KEYWORDS.has(word);
      continue;
    }
    if (!/\s/.test(c)) prevValue = c === ')' || c === ']' || c === '}';
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
  [/\bgetOwnPropertyDescriptors?\b/, 'getOwnPropertyDescriptor'],
  [/\bfromCharCode\b|\bfromCodePoint\b/, 'fromCharCode'],
  [/\beval\b/, 'eval'],
  [/\bWebSocketStream\b/, 'WebSocketStream'],
  [/\bopenKv\b/, 'Deno.openKv'],
];

// http.ts 밖: globalThis 전면 금지, Deno 는 Deno.env.get( · Deno.serve( 만
const GLOBAL_WORD = /\bglobalThis\b/;
const DENO_ALLOWED = /\bDeno\.(env\.get|serve)\(/g;
const DENO_WORD = /\bDeno\b/;

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

function resolvesInsideFunctions(relPath, spec) {
  const parts = relPath.split('/').slice(0, -1);
  for (const seg of spec.split('?')[0].split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.slice(0, 2).join('/') === 'supabase/functions' && parts.length > 2;
}

function importViolations(relPath, code) {
  const out = [];
  const specs = [];
  for (const m of code.matchAll(/\b(?:import|export)\b[^;'"`]*?\bfrom\s*(['"`])([^'"`]*)\1/g)) specs.push([m.index, m[2]]);
  for (const m of code.matchAll(/\bimport\s*(['"`])([^'"`]*)\1/g)) specs.push([m.index, m[2]]);
  for (const [idx, s] of specs) {
    const relative = s.startsWith('./') || s.startsWith('../');
    const ok = relative
      ? !s.includes('://') && !s.includes('?') && /\.(ts|js|mjs)$/.test(s) && resolvesInsideFunctions(relPath, s)
      : ALLOWED_IMPORTS.includes(s);
    if (!ok) out.push(`${relPath}:${code.slice(0, idx).split('\n').length} 허용되지 않은 import '${s}'`);
  }
  return out;
}

export function netViolations(relPath, source) {
  if (!relPath.startsWith('supabase/functions/')) return [];
  // L11: 검사할 수 없는 확장자(.mts·.json·.wasm 등)는 두지 않는다
  if (!/\.(ts|js|mjs|tsx|jsx)$/.test(relPath)) return [`${relPath} 검사 대상 확장자(.ts·.js·.mjs·.tsx·.jsx)가 아닌 파일`];
  const code = stripComments(source);
  const out = importViolations(relPath, code);
  code.split('\n').forEach((line, i) => {
    const at = `${relPath}:${i + 1}`;
    for (const [re, label] of ALWAYS) if (re.test(line)) out.push(`${at} 금지(${label})`);
    if (CREATE_CLIENT.test(line) && !CREATE_CLIENT_OK.test(line)) out.push(`${at} createClient 첫 인자는 SUPABASE_URL 변수만`);
    if (URL_ASSIGN.test(line) && !URL_ASSIGN_OK.test(line)) out.push(`${at} SUPABASE_URL 은 기본 주입 환경변수에서만`);
    if (relPath === ALLOWLIST_FILE) return;
    if (GLOBAL_WORD.test(line)) out.push(`${at} globalThis 금지`);
    if (DENO_WORD.test(line.replace(DENO_ALLOWED, ''))) out.push(`${at} Deno 는 Deno.env.get( · Deno.serve( 만`);
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
