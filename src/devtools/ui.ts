// ui: the devtools' look and the one helper that builds their DOM. Everything lives in a shadow root: the app's styles
// never reach the panel, and the panel's never reach the app. The look is the approved one (a floating graphite panel,
// one row of tabs, Inter to read and a mono for code and values, muten's orange as the one accent).

export const CSS = `
:host{all:initial}
*{box-sizing:border-box}
.panel{position:fixed;right:24px;top:24px;bottom:24px;width:480px;z-index:2147483000;display:flex;flex-direction:column;background:#17181B;color:#E8E8E6;border:1px solid #2E2F35;border-radius:16px;box-shadow:0 24px 60px -18px rgba(0,0,0,.45),0 2px 8px rgba(0,0,0,.18);overflow:hidden;font:14px/1.45 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.panel[hidden]{display:none}
.head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #2A2B30;cursor:grab;user-select:none}
.grip{color:#6E6E6A;letter-spacing:-2px}
.logo{width:22px;height:22px;border-radius:6px;background:#FF5E00;color:#fff;font-weight:700;font-size:13px;display:flex;align-items:center;justify-content:center}
.screen{font-weight:600}.path{font-size:13px;color:#9C9C98;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.spacer{flex:1}
button{font:inherit;color:inherit;cursor:pointer}
.btn{background:#24252A;color:#E8E8E6;border:1px solid #34353B;border-radius:8px;height:32px;padding:0 11px;font-size:13px;font-weight:500;white-space:nowrap}
.btn:hover{background:#2C2D33}.btn.on{background:#FF5E00;border-color:#FF5E00;color:#fff;font-weight:600}
.btn.primary{background:#FF5E00;border-color:#FF5E00;color:#fff;font-weight:600}
.close{background:none;border:0;color:#9C9C98;width:32px;height:32px;font-size:16px}
.tabs{display:flex;gap:2px;padding:8px 10px;border-bottom:1px solid #2A2B30;white-space:nowrap}
.tab{background:none;border:0;color:#A8A8A4;border-radius:8px;padding:7px 9px;font-size:13px;display:flex;align-items:center;gap:6px}
.tab:hover{color:#E8E8E6}.tab.on{background:#2C2D33;color:#fff;font-weight:600}
.badge{background:#FF5E00;color:#fff;border-radius:999px;padding:1px 7px;font-size:11px;font-weight:700}
.badge.amber{background:#E8B95C;color:#1A1A1A}
.toolbar{display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid #2A2B30;background:#1B1C20}
.ibtn{width:32px;height:32px;border-radius:8px;border:1px solid #34353B;background:#24252A;color:#C9C9C5;display:flex;align-items:center;justify-content:center}
.ibtn.rec{border-color:#6A3418;background:#3A1F14;color:#FF7A3D}
.body{flex:1;min-height:0;overflow:auto;padding:14px 18px;display:flex;flex-direction:column;gap:12px}
.foot{padding:11px 18px;border-top:1px solid #2A2B30;font-size:13px;color:#9C9C98}
.label{font-size:12px;color:#9C9C98;text-transform:uppercase;letter-spacing:.06em}
.dim{color:#9C9C98}.small{font-size:13px}.strong{font-weight:600}.big{font-size:20px;font-weight:700}
.mono{font-family:"JetBrains Mono",ui-monospace,"SF Mono",Menlo,monospace;font-size:12.5px}
.row{display:flex;align-items:baseline;gap:8px;min-width:0}.between{justify-content:space-between}
.wrap{flex-wrap:wrap}.cut{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.card{background:#1E1F23;border-radius:10px;padding:11px 13px;display:flex;flex-direction:column;gap:6px}
.card.red{background:#2B1A1A;border:1px solid #5C2E2E}.card.amber{background:#2A2116;border:1px solid #5A4220}
.card.green{background:#16261B;border:1px solid #2D5A3A;color:#BFE3C8}
.red-t{color:#F2A3A3}.amber-t{color:#E8B95C}.green-t{color:#7BD88F}.orange-t{color:#FFB27A}
.chip{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12px;border-radius:6px;padding:2px 7px;background:#2C2D33;color:#C9C9C5;white-space:nowrap}
.chip.red{background:#4A2222;color:#F2C4C4}
.link{background:none;border:0;color:#FF8A3D;padding:0;font-size:13px;text-align:left}.link:hover{color:#FFB27A}
.code{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12.5px;line-height:1.65;background:#111214;border:1px solid #2A2B30;border-radius:10px;padding:10px 12px;white-space:pre-wrap;word-break:break-word;color:#D6D6D2}
.bar{height:6px;background:#2A2B30;border-radius:99px;overflow:hidden}.bar>i{display:block;height:100%;border-radius:99px}
.hbar{height:13px;border-radius:3px;display:inline-block;min-width:2px}
.list{display:flex;flex-direction:column;gap:6px}
.item{border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:2px;background:none;border:0;text-align:left}
.item:hover{background:#1E1F23}.item.on{background:#22242A;border:1px solid #3A3B42}
.steps{display:flex;align-items:flex-end;gap:3px;height:46px;border-bottom:1px solid #2A2B30}
.steps>button{flex:1;min-width:3px;border:0;border-radius:3px 3px 0 0;padding:0}
.steps>button.on{outline:2px solid #fff;outline-offset:1px}
.k{color:#9CC4FF}.s{color:#A8E0A0}.n{color:#F2C08A}.p{color:#8A8A86}.fold{background:none;border:0;color:#8A8A86;width:14px;padding:0}
.empty{color:#9C9C98;font-size:13px;padding:6px 0}
select,input{font:inherit;font-size:13px;background:#24252A;color:#E8E8E6;border:1px solid #34353B;border-radius:8px;height:32px;padding:0 9px}
input{background:#111214;width:100%}
.launcher{position:fixed;right:20px;bottom:20px;z-index:2147483000;display:flex;align-items:center;gap:8px;background:#17181B;color:#E8E8E6;border:1px solid #2E2F35;border-radius:999px;padding:7px 14px 7px 9px;font:500 13px Inter,system-ui,sans-serif;box-shadow:0 10px 30px -10px rgba(0,0,0,.5)}
.launcher[hidden]{display:none}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

type Child = Node | string | null | undefined | false;

/** An element with its classes, text or children, and attributes; falsy children are left out. */
export function h(tag: string, classes: string, children: Child[] | string = [], attributes: { [name: string]: string } = {}): HTMLElement {
  const node = document.createElement(tag);
  if (classes) node.className = classes;
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  if (typeof children === 'string') node.textContent = children;
  else for (const child of children) if (child) node.append(child);
  return node;
}

/** A button that does `run` when pressed. */
export function button(classes: string, text: string, run: () => void, attributes: { [name: string]: string } = {}): HTMLElement {
  const node = h('button', classes, text, { type: 'button', ...attributes });
  node.addEventListener('click', run);
  return node;
}

/** «12.3 ms», «1.2 s». */
export const ms = (value: number): string => (value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`);
/** «96 KB». */
export const kb = (bytes: number): string => `${Math.round(bytes / 1024)} KB`;
/** «8 s ago». */
export const ago = (at: number): string => { const s = Math.max(0, Math.round((performance.now() - at) / 1000)); return s < 2 ? 'just now' : s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`; };
