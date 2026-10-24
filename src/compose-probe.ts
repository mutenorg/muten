// compose-probe: `muten android --plan-b`, the numbers behind «should muten compile to Jetpack Compose?» (plan B of
// the Android front). It reads every page of an app, cold, and sorts each node by what compiling it to Compose would
// take: a direct equivalent (Stack → Column, each → LazyColumn, Text, Button, a field), work (a Canvas or SVG drawing,
// a Chart, a video, a table: there is a Compose way, it is not one line), or nothing (a Custom, a component from npm,
// anything that calls a JS function: that code only runs in a WebView). And it counts what decides it in practice:
// the nodes styled by CSS classes, because Compose has no CSS, so every class is a look someone must write again.

import { relative } from 'node:path';
import { readRoutes } from '#engine/project/routes.js';
import { load, loadAllParts } from '#engine/project/load.js';
import { Ek, Nt } from '#engine/shared/vocab.js';
import type { Doc, FlatNode } from '#engine/shared/types.js';

const DIRECT = new Set<string>(['Stack', 'Header', 'Nav', 'Sidebar', 'Footer', 'Page', 'Section', 'Article', 'List', 'Details', 'Row', 'Cell', 'Text', 'Title', 'Span', 'Image', 'Icon', 'SearchField', 'Password', 'Textarea', 'Select', 'Checkbox', 'Number', 'Range', 'Date', 'Button', 'Link', 'RowAction', 'Form', 'slot', 'When', 'Each']);
const WORK = new Set<string>(['Canvas', 'Svg', 'Rect', 'Line', 'Circle', 'Path', 'Group', 'Arc', 'Chart', 'Video', 'Audio', 'File', 'Table', 'DataTable']);

/** One app's verdict. */
export interface ComposeProbe { pages: number; nodes: number; direct: number; work: number; webOnly: number; styled: number; classes: number; blockers: Array<[string, number]>; perPage: Array<{ file: string; nodes: number; direct: number }> }

type Kind = 'direct' | 'work' | 'web';

// a node that calls a `use`d function (a JS library) anywhere in its props can only run where JS runs
function callsForeign(node: FlatNode, foreign: Set<string>): boolean {
  if (!foreign.size) return false;
  const walk = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(walk);
    if (typeof value !== 'object' || value === null) return false;
    if ('kind' in value && value.kind === Ek.Call && 'fn' in value && typeof value.fn === 'string' && foreign.has(value.fn.split('.')[0])) return true;
    return Object.values(value).some(walk);
  };
  return walk(node.props);
}

function kindOf(node: FlatNode, doc: Doc): Kind {
  if (node.type === Nt.Custom) return 'web';
  const foreign = new Set((doc.imports || []).flatMap((def) => def.names));
  if (callsForeign(node, foreign)) return 'web';
  if (DIRECT.has(node.type)) return 'direct';
  if (WORK.has(node.type)) return 'work';
  return 'web';
}

/** Every page of the app at `root`, sorted. */
export async function composeProbe(root: string): Promise<ComposeProbe> {
  const parts = await loadAllParts(root);
  const out: ComposeProbe = { pages: 0, nodes: 0, direct: 0, work: 0, webOnly: 0, styled: 0, classes: 0, blockers: [], perPage: [] };
  const blockers = new Map<string, number>();
  const classes = new Set<string>();
  for (const page of readRoutes(root)) {
    let doc: Doc;
    try { doc = (await load(page.screenPath, parts)).doc; } catch { continue; }   // a page that does not compile is check's
    out.pages++;
    let pageNodes = 0, pageDirect = 0;
    for (const node of Object.values(doc.nodes)) {
      const kind = kindOf(node, doc);
      out.nodes++; pageNodes++;
      if (kind === 'direct') { out.direct++; pageDirect++; }
      else if (kind === 'work') out.work++;
      else { out.webOnly++; const name = node.type === Nt.Custom ? `Custom ${node.props?.component || ''}`.trim() : node.type; blockers.set(name, (blockers.get(name) || 0) + 1); }
      const own = (node.props?.class || []).flatMap((entry) => (typeof entry === 'string' ? entry.split(/\s+/) : 'name' in entry ? entry.name.split(/\s+/) : []));
      if (own.length) { out.styled++; for (const name of own) if (name) classes.add(name); }
    }
    out.perPage.push({ file: relative(root, page.screenPath), nodes: pageNodes, direct: pageDirect });
  }
  out.classes = classes.size;
  out.blockers = [...blockers].sort((a, b) => b[1] - a[1]).slice(0, 8);
  return out;
}

const pct = (part: number, whole: number): string => `${whole ? Math.round((part / whole) * 100) : 0}%`;

/** The probe, printed. */
export async function composeProbeCommand(root: string, json: boolean): Promise<boolean> {
  const probe = await composeProbe(root);
  if (json) { console.log(JSON.stringify(probe, null, 2)); return true; }
  console.log(`\n  plan B (compile to Jetpack Compose): what this app would take, ${probe.pages} pages, ${probe.nodes} nodes\n`);
  console.log(`  direct       ${String(probe.direct).padStart(6)}  ${pct(probe.direct, probe.nodes).padStart(4)}   a Compose equivalent (Column, LazyColumn, Text, Button, a field)`);
  console.log(`  work         ${String(probe.work).padStart(6)}  ${pct(probe.work, probe.nodes).padStart(4)}   a Compose way, not one line (Canvas/SVG drawing, Chart, video, table)`);
  console.log(`  web only     ${String(probe.webOnly).padStart(6)}  ${pct(probe.webOnly, probe.nodes).padStart(4)}   stays in a WebView (a Custom, a component from npm, a call into JS)`);
  console.log(`\n  styled by CSS classes: ${probe.styled} nodes (${pct(probe.styled, probe.nodes)}), ${probe.classes} different classes. Compose has no CSS: each is a look to write again as a Modifier.`);
  if (probe.blockers.length) console.log(`  what stays web most: ${probe.blockers.map(([name, count]) => `${name} ×${count}`).join(', ')}`);
  const fully = probe.perPage.filter((page) => page.nodes && page.direct === page.nodes).length;
  console.log(`  pages with nothing but direct nodes: ${fully} of ${probe.pages}\n`);
  return true;
}
