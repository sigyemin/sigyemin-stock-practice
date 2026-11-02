// 화면 요소 도우미. 글자는 항상 textContent 로만 넣는다(HTML 문자열 해석 없음).
export function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.text !== undefined) node.textContent = String(opts.text);
  if (opts.className) node.className = opts.className;
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) {
      if (/^on/i.test(k)) throw new Error('이벤트는 opts.on 으로');
      node.setAttribute(k, String(v));
    }
  }
  if (opts.on) {
    for (const [type, fn] of Object.entries(opts.on)) node.addEventListener(type, fn);
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

export function mount(root, ...nodes) {
  root.replaceChildren(...nodes);
}
