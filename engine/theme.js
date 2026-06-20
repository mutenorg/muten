// Engine DEFAULT (spec §6). The engine does NOT impose a theme: this is just a sensible
// starting point. Each project OVERRIDES it with its styles/<screen>.scss|css sheet
// (see src/styles.js), which is injected afterwards and wins via the cascade.
//
//  PALETTE — theme variables (palette + scales). The ":root". 100% override-able by
//            redefining the --vars in the project sheet.
//  BASE    — default look of each primitive (reset + components). Override-able by
//            class (.page, .datatable, ...).
//  TOKENS  — vocabulary of semantic tokens, opt-in via style(...) in the .screen.
//            Compile to STATIC atomic classes (cacheable, deduped). An invalid token
//            is rejected by validation. (Adding NEW tokens to the validated vocabulary
//            = extend this map; a next step is letting the project extend it.)

export const PALETTE = `:root{
  --bg:#f6f7f9; --surface:#fff; --border:#e6e8ec; --fg:#1b2330; --muted:#737a88;
  --primary:#3b5bdb; --primary-fg:#fff; --danger:#e03131; --danger-fg:#fff;
  --radius:10px; --radius-lg:16px;
  --space-sm:8px; --space-md:16px; --space-lg:24px;
  --shadow-sm:0 1px 2px rgba(16,24,40,.06); --shadow-md:0 6px 20px rgba(16,24,40,.10);
}`;

export const BASE = `*{box-sizing:border-box}
body{margin:0;font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
#app{max-width:780px;margin:40px auto;padding:0 16px}
.page{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:var(--space-lg)}
.page>h1{margin:0 0 18px;font-size:22px;font-weight:650;letter-spacing:-.01em}
.stack{display:flex;flex-direction:column}
.text{color:inherit;margin:0 0 10px;font-size:14px}
.image{display:block;width:100%;border-radius:8px}
.search{width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:15px;margin-bottom:16px;background:#fff;color:inherit}
.search:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px rgba(59,91,219,.13)}
.datatable{width:100%;border-collapse:collapse;margin-bottom:20px}
.datatable th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);border-bottom:1px solid var(--border);padding:8px 10px;font-weight:600}
.datatable td{padding:10px;border-bottom:1px solid var(--border)}
.datatable tbody tr:last-child td{border-bottom:none}
.row-action{border:1px solid var(--border);background:#fff;color:var(--danger);border-radius:6px;padding:4px 10px;font-size:13px;cursor:pointer;transition:background .12s,color .12s}
.row-action:hover{background:var(--danger);color:var(--danger-fg);border-color:var(--danger)}
.form{display:flex;flex-wrap:wrap;gap:10px;align-items:center;border-top:1px solid var(--border);padding-top:18px}
.form-title{width:100%;margin:0;font-size:13px;font-weight:600;color:var(--muted)}
.field{flex:1 1 150px;padding:9px 11px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:#fff;color:inherit}
.field:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px rgba(59,91,219,.13)}
.submit{padding:9px 16px;border:none;border-radius:8px;background:var(--primary);color:var(--primary-fg);font-size:14px;font-weight:550;cursor:pointer;transition:filter .12s}
.submit:hover{filter:brightness(1.06)}
.button{align-self:flex-start;padding:6px 12px;border:1px solid var(--border);background:#fff;color:var(--fg);border-radius:8px;font-size:13px;cursor:pointer;transition:background .12s}
.button:hover{background:var(--bg)}
.custom{display:block}`;

// token -> CSS declarations (no selector). Each one = an atomic class.
export const TOKENS = {
  surface:      'background:var(--surface);border:1px solid var(--border)',
  muted:        'color:var(--muted)',
  bold:         'font-weight:650',
  'padding.sm': 'padding:var(--space-sm)',
  'padding.md': 'padding:var(--space-md)',
  'padding.lg': 'padding:var(--space-lg)',
  'gap.sm':     'gap:var(--space-sm)',
  'gap.md':     'gap:var(--space-md)',
  'gap.lg':     'gap:var(--space-lg)',
  grid:         'display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr))',
  'rounded.sm': 'border-radius:6px',
  'rounded.md': 'border-radius:var(--radius)',
  'rounded.lg': 'border-radius:var(--radius-lg)',
  'shadow.sm':  'box-shadow:var(--shadow-sm)',
  'shadow.md':  'box-shadow:var(--shadow-md)',
  'text.sm':    'font-size:13px',
  'text.md':    'font-size:15px',
  'text.lg':    'font-size:20px',
};

// a token's class name: padding.lg -> t-padding-lg
export const tokenClass = (t) => 't-' + t.replace(/\./g, '-');
