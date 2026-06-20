// VS Code extension for .muten — aware of the whole app:
//   - LIVE LINTING: on each keystroke it runs the PROJECT-AWARE analyzer (loads parts,
//     composes, validates) and underlines errors with message + suggestion.
//   - SMART AUTOCOMPLETE: context-aware + documented + project-aware.
//       node position → primitives + control flow + the project's PARTS (with their params)
//       after @       → state (with type; query states also offer .loading/.error/.data)
//       after ->      → actions ;  inside style(...) → tokens ;  on(...) → actions
//       after a primitive on the line → that primitive's modifiers
//     Every item carries a signature (detail) + an explanation (markdown) + a snippet.
//   - OBSERVABLE: "Muten" output channel + "Muten: Lint active file" command.
//
// The engine (with node:fs) lives in ./engine (copied from src/ by tools/sync-engine.mjs).

const vscode = require('vscode');
const path = require('path');
const { pathToFileURL } = require('url');

let engine = null;
let out = null;
const log = (msg) => { if (out) out.appendLine(msg); };

async function loadEngine() {
  const dir = path.join(__dirname, 'engine');
  const imp = (f) => import(pathToFileURL(path.join(dir, f)).href);
  const [an, ma] = await Promise.all([imp('analyze.js'), imp('manifest.js')]);
  return { analyze: an.analyze, completion: an.completion, m: ma };
}

function toDiag(loc, message) {
  const line = Math.max(0, (loc && loc.line ? loc.line : 1) - 1);
  const col = Math.max(0, (loc && loc.col ? loc.col : 1) - 1);
  const d = new vscode.Diagnostic(new vscode.Range(line, col, line, col + 1), message, vscode.DiagnosticSeverity.Error);
  d.source = 'muten';
  return d;
}

function diagnosticsFor(document) {
  if (!engine) return [];
  let res;
  try {
    res = engine.analyze(document.uri.fsPath, document.getText());
  } catch (e) {
    log(`analyze ERROR in ${document.uri.fsPath}: ${e && e.stack ? e.stack : e}`);
    return [];
  }
  return (res.diagnostics || []).map((d) =>
    toDiag(d.loc, d.message + (d.suggestion ? `  → did you mean "${d.suggestion}"?` : '')));
}

// ── completion ──
function buildCompletions(document, position) {
  if (!engine) return [];
  const m = engine.m;
  const K = vscode.CompletionItemKind;
  const line = document.lineAt(position).text;
  const prefix = line.slice(0, position.character);
  const out = [];
  const md = (s) => new vscode.MarkdownString(s);
  const item = (label, kind, detail, doc, snippet, sort) => {
    const it = new vscode.CompletionItem(label, kind);
    if (detail) it.detail = detail;
    if (doc) it.documentation = md(doc);
    if (snippet) it.insertText = new vscode.SnippetString(snippet);
    if (sort) it.sortText = sort;
    return it;
  };

  // 1) inside style(...) → tokens (with the CSS they expand to)
  if (/style\([^)]*$/.test(prefix)) {
    for (const t of m.TOKEN_NAMES) out.push(item(t, K.Color, 'style token', '`' + m.TOKENS[t] + '`'));
    return out;
  }

  const ctx = engine.completion(document.uri.fsPath, document.getText());

  // 2) after `@ref.` → query sub-fields
  const dot = /@(\w+)\.(\w*)$/.exec(prefix);
  if (dot) {
    const st = ctx.state.find((s) => s.name === dot[1]);
    if (st && st.query) {
      for (const f of [['data', 'The loaded rows.'], ['loading', 'true while fetching.'], ['error', 'The error, or null.'], ['stale', 'true if the data is stale.']]) {
        out.push(item(f[0], K.Field, `query field`, f[1]));
      }
    }
    return out;
  }

  // 3) after `@` → state
  if (/@\w*$/.test(prefix)) {
    for (const s of ctx.state) {
      out.push(item(s.name, K.Variable, s.query ? `query : ${s.type}` : s.type,
        s.query ? `Async query. Also exposes \`@${s.name}.loading\`, \`.error\`, \`.data\`.` : `State of type \`${s.type}\`.`));
    }
    return out;
  }

  // 4) after `->` or inside `on(...)` → actions
  if (/->\s*\w*$/.test(prefix) || /\bon\([^)]*$/.test(prefix)) {
    for (const a of ctx.actions) out.push(item(a, K.Method, 'action', 'A declared action.'));
    return out;
  }

  // 5a) line already starts with a primitive → offer ITS modifiers first
  const lineType = /^\s*([A-Z][A-Za-z0-9_]*)\s/.exec(line);
  if (lineType && m.PRIMITIVES[lineType[1]]) {
    const props = m.PRIMITIVES[lineType[1]].props || {};
    for (const mod of Object.keys(props).filter((k) => m.MODIFIERS.includes(k))) {
      out.push(item(mod, K.Property, `${lineType[1]} prop`, m.MODIFIER_DOCS[mod] || '', null, '0' + mod));
    }
  }

  // 5b) node position → primitives, control flow, and the project's PARTS
  for (const [type, spec] of Object.entries(m.PRIMITIVES)) {
    const label = spec.control ? type.toLowerCase() : type;
    out.push(item(label, spec.control ? K.Keyword : K.Class, spec.control ? 'control flow' : 'primitive', spec.doc, spec.snippet, '1' + label));
  }
  for (const p of ctx.parts) {
    const sig = (p.params || []).map((x) => `${x.name}: ${x.type}`).join(', ');
    const snip = `${p.name}(${(p.params || []).map((x, i) => `${x.name}: \${${i + 1}}`).join(', ')})`;
    out.push(item(p.name, K.Constructor, `part(${sig})`, `Reusable part. Params: ${sig || '(none)'}.`, snip, '2' + p.name));
  }
  for (const k of m.KEYWORDS) {
    if (['when', 'each', 'as', 'and', 'or', 'not', 'contains'].includes(k)) continue; // control/operators handled elsewhere
    out.push(item(k, K.Keyword, 'keyword', m.KEYWORD_DOCS[k] || '', null, '3' + k));
  }
  return out;
}

async function activate(context) {
  out = vscode.window.createOutputChannel('Muten');
  context.subscriptions.push(out);
  log('Activating .muten extension…');

  try {
    engine = await loadEngine();
    log('Engine loaded OK (analyze + manifest).');
  } catch (e) {
    log(`FAILED to load the engine: ${e && e.stack ? e.stack : e}`);
    vscode.window.showErrorMessage('Muten: could not load the lint engine. See "Output → Muten".');
    return;
  }

  const collection = vscode.languages.createDiagnosticCollection('muten');
  context.subscriptions.push(collection);

  const lint = (doc) => {
    if (!doc || doc.languageId !== 'muten') return;
    const ds = diagnosticsFor(doc);
    collection.set(doc.uri, ds);
    log(`lint ${vscode.workspace.asRelativePath(doc.uri)}: ${ds.length} problem(s)`);
    return ds;
  };

  const timers = new Map();
  const lintSoon = (doc) => {
    if (!doc || doc.languageId !== 'muten') return;
    const key = doc.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => lint(doc), 250));
  };

  vscode.workspace.textDocuments.forEach(lint);
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(lint),
    vscode.workspace.onDidChangeTextDocument((e) => lintSoon(e.document)),
    vscode.workspace.onDidCloseTextDocument((d) => collection.delete(d.uri)),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('muten.lint', () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.document.languageId !== 'muten') { vscode.window.showInformationMessage('Muten: open a .muten file.'); return; }
      const ds = lint(ed.document) || [];
      out.show(true);
      vscode.window.showInformationMessage(`Muten: ${ds.length} problem(s). See "Output → Muten".`);
    }),
  );

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider('muten', {
      provideCompletionItems(document, position) {
        try {
          const items = buildCompletions(document, position);
          log(`completion @ ${position.line + 1}:${position.character} → ${items.length} item(s)`);
          return items;
        } catch (e) { log(`completion ERROR: ${e && e.stack ? e.stack : e}`); return []; }
      },
    }, '(', ' ', '@', '.', '>'),
  );

  log('Ready: live-lint + smart autocomplete active.');
}

function deactivate() {}

module.exports = { activate, deactivate };
