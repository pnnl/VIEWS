import { tableColumnsAndOrder } from './tableLayout.js';

const CARRIERS = new Set(['Electricity', 'Liquid Fuels']);
const TOP_MARGIN = 0.005;
const BOTTOM_MARGIN = 0.995;

function primaryRanks(rows, nodeTable) {
    const tot = new Map();
    for (const r of rows) {
        if (nodeTable.get(r.source)?.role === 'primary') {
            tot.set(r.source, (tot.get(r.source) || 0) + (Number(r.value) || 0));
        }
    }
    const sorted = [...tot].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return new Map(sorted.map(([n], i) => [n, i + 1]));
}

// Mirror Plotly's per-frame scale: the tightest REAL column (node total + pads)
// sets the height per unit of value. Uses the table's column assignment.
function frameScale(links, padFrac, placement) {
    const inV = new Map(), outV = new Map();
    for (const r of links) {
        const v = Number(r.value);
        if (!(v > 0)) continue;
        outV.set(r.source, (outV.get(r.source) || 0) + v);
        inV.set(r.target, (inV.get(r.target) || 0) + v);
    }
    const val = n => Math.max(inV.get(n) || 0, outV.get(n) || 0);

    // Group this frame's active nodes by their table column
    const byCol = new Map();
    for (const n of new Set([...inV.keys(), ...outV.keys()])) {
        const c = placement.get(n)?.col;
        if (c == null) continue;
        if (!byCol.has(c)) byCol.set(c, []);
        byCol.get(c).push(n);
    }

    let ky = Infinity;
    for (const colNodes of byCol.values()) {
        const total = colNodes.reduce((a, n) => a + val(n), 0);
        if (total > 0) {
            ky = Math.min(ky, (1 - padFrac * Math.max(0, colNodes.length - 1)) / total);
        }
    }
    return { ky, val };
}

export function computeEnergyLayout(labels, rows, nodeTable, level, { padPx = 15, plotHeightPx = 600 } = {}) {
    const placement = tableColumnsAndOrder(labels, nodeTable, level, primaryRanks(rows, nodeTable));
    const padFrac = padPx / plotHeightPx;
    const warnings = [];

    // Largest height each node reaches in any year
    const byYear = new Map();
    for (const r of rows) {
        if (!byYear.has(r.year)) byYear.set(r.year, []);
        byYear.get(r.year).push(r);
    }
    const h = new Map(labels.map(l => [l, 0]));
    for (const yearRows of byYear.values()) {
        const { ky, val } = frameScale(yearRows, padFrac, placement);
        if (!Number.isFinite(ky)) continue;
        for (const l of labels) h.set(l, Math.max(h.get(l), val(l) * ky));
    }

    // x: table columns, renumbered 0..n-1
    const cols = [...new Set(labels.map(l => placement.get(l).col))].sort((a, b) => a - b);
    const colIdx = new Map(cols.map((c, i) => [c, i]));
    const xOf = l => (cols.length <= 1 ? 0.5 : 0.01 + (0.98 * colIdx.get(placement.get(l).col)) / (cols.length - 1));

    // y: stack each column from the top in table order, then rescale into
    // [TOP_MARGIN, BOTTOM_MARGIN] if the stack overflows. This guarantees no
    // node center is ever placed below the plot area.
    const yMap = new Map();
    const span = BOTTOM_MARGIN - TOP_MARGIN;
    for (const c of cols) {
        const col = labels
            .filter(l => placement.get(l).col === c)
            .sort((a, b) => placement.get(a).order - placement.get(b).order);

        // Total stacked extent of this column: node heights + pads between them
        const totalH = col.reduce((a, l) => a + h.get(l), 0)
            + padFrac * Math.max(0, col.length - 1);

        // Compress the whole stack when it would overflow the drawing area
        const scale = totalH > span ? span / totalH : 1;
        if (scale < 1) {
            warnings.push(
                `Column ${c} stack is ${totalH.toFixed(2)}× plot height; compressed to fit.`
            );
        }

        let cursor = TOP_MARGIN;
        for (const l of col) {
            const hs = h.get(l) * scale;
            yMap.set(l, cursor + hs / 2); // Plotly's node.y is the node centre
            cursor += hs + padFrac * scale;
        }
    }

    // Every link must go left to right (except Electricity <-> Liquid Fuels)
    for (const r of rows) {
        if (!(Number(r.value) > 0) || (CARRIERS.has(r.source) && CARRIERS.has(r.target))) continue;
        const s = placement.get(r.source), t = placement.get(r.target);
        if (s.col >= t.col) warnings.push(`"${r.source}" (col ${s.col}) → "${r.target}" (col ${t.col}) is not left→right`);
    }

    return { labels, x: labels.map(xOf), y: labels.map(l => yMap.get(l)), placement, warnings: [...new Set(warnings)] };
}