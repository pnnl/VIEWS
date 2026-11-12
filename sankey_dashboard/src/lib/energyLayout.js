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

// Detect links whose source and target share a table column (e.g.
// Biomass -> cellulosic ethanol -> Biorefining, where the ethanol step and
// Biorefining are both in column 2). Nodes at the end of such a chain
// ("anchors") keep their column; every other node in the chain is an
// "intermediate" and gets an x interpolated between its upstream input
// column and the anchor column. y is left untouched.
//
// Returns { intermediates: Map<node, {up, down}>, pred } where `up` is the
// longest same-column path into the node and `down` the longest path out.
function resolveIntraColumn(rows, placement, warnings) {
    const succ = new Map(), pred = new Map();
    const seen = new Set();
    for (const r of rows) {
        if (!(Number(r.value) > 0) || (CARRIERS.has(r.source) && CARRIERS.has(r.target))) continue;
        const s = placement.get(r.source), t = placement.get(r.target);
        if (!s || !t || s.col !== t.col || r.source === r.target) continue;
        const key = `${r.source}\u0000${r.target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!succ.has(r.source)) succ.set(r.source, []);
        if (!pred.has(r.target)) pred.set(r.target, []);
        succ.get(r.source).push(r.target);
        pred.get(r.target).push(r.source);
    }

    // Longest path along `adj`, ignoring edges that would close a cycle
    const longest = adj => {
        const memo = new Map(), visiting = new Set();
        const visit = n => {
            if (memo.has(n)) return memo.get(n);
            visiting.add(n);
            let best = 0;
            for (const m of adj.get(n) || []) {
                if (visiting.has(m)) {
                    warnings.push(`Cycle in same-column links at "${n}" → "${m}"; link ignored for layout.`);
                    continue;
                }
                best = Math.max(best, visit(m) + 1);
            }
            visiting.delete(n);
            memo.set(n, best);
            return best;
        };
        return visit;
    };
    const downOf = longest(succ);
    const upOf = longest(pred);

    const intermediates = new Map();
    for (const n of succ.keys()) intermediates.set(n, { up: upOf(n), down: downOf(n) });
    return { intermediates, pred };
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

    // x for intermediates of same-column chains: interpolate between the
    // largest x of their upstream (earlier-column) inputs and their own
    // (anchor) column. A single step sits exactly halfway.
    const xMap = new Map(labels.map(l => [l, xOf(l)]));
    const { intermediates, pred } = resolveIntraColumn(rows, placement, warnings);
    if (intermediates.size) {
        const extIn = new Map(); // node -> max x of earlier-column inputs
        for (const r of rows) {
            if (!(Number(r.value) > 0)) continue;
            const s = placement.get(r.source), t = placement.get(r.target);
            if (!s || !t || s.col >= t.col || !xMap.has(r.source)) continue;
            extIn.set(r.target, Math.max(extIn.get(r.target) ?? -Infinity, xMap.get(r.source)));
        }
        // Upstream x of a chain: own external inputs or those of same-column ancestors
        const upMemo = new Map();
        const chainUpX = (n, stack = new Set()) => {
            if (upMemo.has(n)) return upMemo.get(n);
            stack.add(n);
            let best = extIn.get(n) ?? -Infinity;
            for (const p of pred.get(n) || []) {
                if (!stack.has(p)) best = Math.max(best, chainUpX(p, stack));
            }
            stack.delete(n);
            upMemo.set(n, best);
            return best;
        };
        for (const [n, { up, down }] of intermediates) {
            if (!xMap.has(n)) continue;
            const xDown = xMap.get(n); // same column as its anchor
            let xUp = chainUpX(n);
            if (!Number.isFinite(xUp)) {
                const i = colIdx.get(placement.get(n).col);
                xUp = i > 0 ? 0.01 + (0.98 * (i - 1)) / (cols.length - 1) : xDown;
            }
            xMap.set(n, xUp + ((xDown - xUp) * (up + 1)) / (up + down + 1));
        }
    }

    // Every link must go left to right (except Electricity <-> Liquid Fuels)
    for (const r of rows) {
        if (!(Number(r.value) > 0) || (CARRIERS.has(r.source) && CARRIERS.has(r.target))) continue;
        const xs = xMap.get(r.source), xt = xMap.get(r.target);
        if (xs == null || xt == null) continue;
        if (xs >= xt) warnings.push(`"${r.source}" (x ${xs.toFixed(3)}) → "${r.target}" (x ${xt.toFixed(3)}) is not left→right`);
    }

    return { labels, x: labels.map(l => xMap.get(l)), y: labels.map(l => yMap.get(l)), placement, warnings: [...new Set(warnings)] };
}