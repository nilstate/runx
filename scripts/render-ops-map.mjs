// Renders the README hero map (docs/assets/ops-fanout-{dark,light}.svg): one
// goal entering a governed chain of skill lanes, consequential lanes held at
// approval gates, everything converging into one sealed receipt, and the
// receipt feeding the next run.
//
//   node scripts/render-ops-map.mjs [--outdir docs/assets]
//
// The map is a scene spec (nodes, edges, loops, routes) rendered by a small
// transit-map engine. Animation is additive only (pulses riding the lines,
// dash flow, the seal ring turning): the diagram is complete at every frame,
// so static rasterizers, social cards, and prefers-reduced-motion all see the
// finished picture. Styles are scoped per theme so both variants can share a
// document without colliding.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}
const outDir = args.get('outdir') ?? 'docs/assets';

const WIDTH = 1120;
const HEIGHT = 470;

// ---------------------------------------------------------------------------
// scene spec: the story. hue keys resolve per theme.
// ---------------------------------------------------------------------------

const SCENE = {
  prompt: {
    x: 64,
    y: 200,
    lines: [
      { text: '$ runx skill business-ops', tone: 'ink' },
      { text: 'signal: acme.com signed up 40 seats', tone: 'muted' },
      { text: 'approved · actor=kam', tone: 'amber' },
    ],
  },
  origin: { x: 344, y: 225 },
  nodes: {
    scout: { x: 442, y: 225, hue: 'pink', label: 'scout', sub: 'account enriched', interchange: true, labelSide: 'below' },
    triage: { x: 600, y: 128, hue: 'teal', label: 'triage', sub: 'routed · p1 to gtm', labelSide: 'above' },
    ghostwrite: { x: 600, y: 322, hue: 'violet', label: 'ghostwrite', sub: 'draft · 2 passes', labelSide: 'below', loop: true },
    warroom: { x: 796, y: 86, hue: 'amber', label: 'warroom', sub: 'held · needs approval', labelSide: 'above', held: true },
    ledger: { x: 812, y: 225, hue: 'green', label: 'ledger', sub: 'run appended to record', labelSide: 'above' },
    send: { x: 796, y: 364, hue: 'magenta', label: 'send', sub: 'held · needs approval', labelSide: 'below', held: true },
  },
  seal: { x: 990, y: 225 },
  edges: [
    { from: 'origin', to: 'scout', hue: 'pink', width: 2.4 },
    { from: 'scout', to: 'triage', hue: 'teal' },
    { from: 'scout', to: 'ghostwrite', hue: 'violet' },
    { from: 'triage', to: 'warroom', hue: 'amber' },
    { from: 'triage', to: 'ledger', hue: 'green' },
    { from: 'ghostwrite', to: 'send', hue: 'magenta' },
    { from: 'warroom', to: 'seal', hue: 'amber', held: true },
    { from: 'send', to: 'seal', hue: 'magenta', held: true },
    { from: 'ledger', to: 'seal', hue: 'green' },
  ],
  // pulse journeys: full routes a run actually takes through the map
  routes: [
    { hue: 'amber', via: ['origin', 'scout', 'triage', 'warroom', 'seal'] },
    { hue: 'magenta', via: ['origin', 'scout', 'ghostwrite', 'send', 'seal'] },
    { hue: 'green', via: ['origin', 'scout', 'triage', 'ledger', 'seal'] },
  ],
  sealLabel: { name: 'sealed', sub: '$ runx verify → ok' },
  replayLabel: 'receipts feed the next run',
};

const THEMES = {
  dark: {
    bg: '#09090e',
    frame: 'none',
    ink: '#f5f1ea',
    muted: '#c7beca',
    faint: '#8f8795',
    amberText: '#ffb84d',
    seal: '#65b7ff',
    glowOpacity: 0.08,
    lineOpacity: 0.75,
    hues: { pink: '#ff2e88', teal: '#28d7c2', violet: '#b48cff', amber: '#ffb84d', magenta: '#ff2e88', green: '#7ee787' },
  },
  light: {
    bg: '#fdfcfa',
    frame: '#e6e1d8',
    ink: '#16121e',
    muted: '#585165',
    faint: '#8a8394',
    amberText: '#b26a05',
    seal: '#2563c4',
    glowOpacity: 0.05,
    lineOpacity: 0.92,
    hues: { pink: '#e0186f', teal: '#0f9d8f', violet: '#7a4fd6', amber: '#c47d10', magenta: '#e0186f', green: '#2f9e44' },
  },
};

// ---------------------------------------------------------------------------
// transit-map engine
// ---------------------------------------------------------------------------

const point = (ref) =>
  ref === 'origin' ? SCENE.origin : ref === 'seal' ? SCENE.seal : SCENE.nodes[ref];

// smooth horizontal-tangent cubic between two points; the transit-map curve
const segment = (a, b) => {
  const bend = Math.max(36, (b.x - a.x) * 0.55);
  return `C ${a.x + bend} ${a.y}, ${b.x - bend} ${b.y}, ${b.x} ${b.y}`;
};
const edgePath = (edge) => {
  const a = point(edge.from);
  const b = point(edge.to);
  return `M${a.x} ${a.y} ${segment(a, b)}`;
};
const routePath = (via) => {
  const [first, ...rest] = via.map(point);
  let d = `M${first.x} ${first.y}`;
  let prev = first;
  for (const next of rest) {
    d += ` ${segment(prev, next)}`;
    prev = next;
  }
  return d;
};

// self-loop: a small circuit rising from the node and returning to it
const loopPath = ({ x, y }) =>
  `M${x - 7} ${y - 5} C ${x - 34} ${y - 34}, ${x + 30} ${y - 40}, ${x + 7} ${y - 6}`;

const esc = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const labelAnchor = (node) => {
  switch (node.labelSide) {
    case 'above':
      return { x: node.x - 6, nameY: node.y - 34, subY: node.y - 17, anchor: 'start' };
    case 'belowRight':
      return { x: node.x + 16, nameY: node.y + 6, subY: node.y + 23, anchor: 'start' };
    default: // below
      return { x: node.x - 6, nameY: node.y + 28, subY: node.y + 45, anchor: 'start' };
  }
};

const render = (theme) => {
  const t = THEMES[theme];
  const ns = `rx-${theme}`;
  const hue = (key) => t.hues[key];

  const edges = SCENE.edges
    .map((edge) => {
      const d = edgePath(edge);
      const dash = edge.held ? ' stroke-dasharray="5 6"' : '';
      const width = edge.width ?? 2;
      return `
  <path d="${d}" stroke="${hue(edge.hue)}" stroke-opacity="${t.glowOpacity}" stroke-width="7" fill="none"/>
  <path d="${d}" stroke="${hue(edge.hue)}" stroke-opacity="${t.lineOpacity}" stroke-width="${width}" fill="none"${dash} stroke-linecap="round"/>`;
    })
    .join('\n');

  const nodes = Object.values(SCENE.nodes)
    .map((node) => {
      const c = hue(node.hue);
      const { x, nameY, subY, anchor } = labelAnchor(node);
      const ring = node.interchange
        ? `<circle cx="${node.x}" cy="${node.y}" r="9.5" fill="${t.bg}" stroke="${c}" stroke-width="2.4"/>
  <circle cx="${node.x}" cy="${node.y}" r="3.4" fill="${c}"/>`
        : node.held
          ? `<path d="M${node.x} ${node.y - 8.5} L${node.x + 8.5} ${node.y} L${node.x} ${node.y + 8.5} L${node.x - 8.5} ${node.y} Z" fill="${t.bg}" stroke="${t.hues.amber}" stroke-width="2.2"/>`
          : `<circle cx="${node.x}" cy="${node.y}" r="5.5" fill="${t.bg}" stroke="${c}" stroke-width="2.2"/>`;
      const loop = node.loop
        ? `<path d="${loopPath(node)}" stroke="${c}" stroke-opacity=".55" stroke-width="1.4" fill="none" stroke-dasharray="3 5"/>
  <circle r="2.2" fill="${c}"><animateMotion dur="3.2s" repeatCount="indefinite" path="${loopPath(node)}"/></circle>`
        : '';
      return `
  ${ring}
  ${loop}
  <text class="name" x="${x}" y="${nameY}" text-anchor="${anchor}">${esc(node.label)}</text>
  <text class="mono ${node.held ? 'amber' : 'faint'}" x="${x}" y="${subY}" text-anchor="${anchor}">${esc(node.sub)}</text>`;
    })
    .join('\n');

  const pulses = SCENE.routes
    .map(
      (route, i) => `
  <circle r="3.1" fill="${hue(route.hue)}">
    <animateMotion dur="7s" begin="${(i * 2.2).toFixed(1)}s" repeatCount="indefinite" path="${routePath(route.via)}"/>
  </circle>`,
    )
    .join('\n');

  // the replay arc departs beneath the seal's label; a hidden left-to-right
  // twin carries the textPath so the sentence reads upright along the curve
  const replayD = `M${SCENE.seal.x} ${SCENE.seal.y + 62} C ${SCENE.seal.x - 60} ${HEIGHT - 10}, ${SCENE.origin.x + 90} ${HEIGHT - 12}, ${SCENE.origin.x} ${SCENE.origin.y + 16}`;
  const replayGuideD = `M${SCENE.origin.x} ${SCENE.origin.y + 16} C ${SCENE.origin.x + 90} ${HEIGHT - 12}, ${SCENE.seal.x - 60} ${HEIGHT - 10}, ${SCENE.seal.x} ${SCENE.seal.y + 62}`;

  const promptLines = SCENE.prompt.lines
    .map((line, i) => `<text class="mono ${line.tone}" x="${SCENE.prompt.x}" y="${SCENE.prompt.y + i * 24}">${esc(line.text)}</text>`)
    .join('\n  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" class="${ns}" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-labelledby="title desc">
  <title id="title">runx governed skill chain</title>
  <desc id="desc">One goal enters a governed chain: scout enriches the account, triage routes it, ghostwrite drafts in two passes, the send and warroom lanes hold at approval gates, ledger appends the record, and everything converges into one sealed receipt that feeds the next run.</desc>
  <defs>
    <style>
      .${ns} .ink { fill: ${t.ink}; }
      .${ns} .muted { fill: ${t.muted}; }
      .${ns} .faint { fill: ${t.faint}; }
      .${ns} .amber { fill: ${t.amberText}; }
      .${ns} .seal-text { fill: ${t.seal}; }
      .${ns} .name { font: 700 13.5px Inter, ui-sans-serif, system-ui, sans-serif; fill: ${t.ink}; }
      .${ns} .mono { font: 600 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      .${ns} .small { font: 520 11px Inter, ui-sans-serif, system-ui, sans-serif; }
      .${ns} .seal-ring { animation: ${ns}-turn 14s linear infinite; transform-origin: ${SCENE.seal.x}px ${SCENE.seal.y}px; }
      .${ns} .replay { stroke-dasharray: 2 9; animation: ${ns}-flow 1.4s linear infinite; }
      @keyframes ${ns}-turn { to { transform: rotate(360deg); } }
      @keyframes ${ns}-flow { to { stroke-dashoffset: -11; } }
      @media (prefers-reduced-motion: reduce) { .${ns} * { animation: none !important; } }
    </style>
  </defs>

  <rect width="${WIDTH}" height="${HEIGHT}" rx="18" fill="${t.bg}"${t.frame === 'none' ? '' : ` stroke="${t.frame}" stroke-width="1.5"`}/>

  ${promptLines}
  <circle cx="${SCENE.origin.x}" cy="${SCENE.origin.y}" r="5.5" fill="${t.hues.pink}"/>

${edges}
${nodes}
${pulses}

  <g class="seal-ring">
    <circle cx="${SCENE.seal.x}" cy="${SCENE.seal.y}" r="24" fill="none" stroke="${t.seal}" stroke-width="1.6" stroke-dasharray="4 7"/>
  </g>
  <circle cx="${SCENE.seal.x}" cy="${SCENE.seal.y}" r="15" fill="none" stroke="${t.seal}" stroke-opacity=".55" stroke-width="1.2"/>
  <circle cx="${SCENE.seal.x}" cy="${SCENE.seal.y}" r="7" fill="${t.seal}"/>
  <text class="name" x="${SCENE.seal.x}" y="${SCENE.seal.y + 42}" text-anchor="middle">${esc(SCENE.sealLabel.name)}</text>
  <text class="mono seal-text" x="${SCENE.seal.x}" y="${SCENE.seal.y + 60}" text-anchor="middle">${esc(SCENE.sealLabel.sub)}</text>

  <path class="replay" d="${replayD}" stroke="${t.seal}" stroke-opacity=".45" stroke-width="1.4" fill="none"/>
  <circle r="2.6" fill="${t.seal}" opacity=".8">
    <animateMotion dur="5s" repeatCount="indefinite" path="${replayD}"/>
  </circle>
  <path id="${ns}-replay-guide" d="${replayGuideD}" fill="none" stroke="none"/>
  <text class="small faint" dy="-6"><textPath href="#${ns}-replay-guide" startOffset="42%">${esc(SCENE.replayLabel)}</textPath></text>
</svg>
`;
};

for (const theme of Object.keys(THEMES)) {
  const outPath = join(outDir, `ops-fanout-${theme}.svg`);
  writeFileSync(outPath, render(theme));
  console.log(`wrote ${outPath}`);
}
