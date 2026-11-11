// Table-driven column/order lookup for the Sankey layout.
// Columns and orders come from gcam_usa_energy_nodes.parquet (x_col_L{n}, y_order_L{n});
// primary sources are re-ranked from gcam_usa_energy_primary_rank.parquet.

const SWAP_PAIRS = [
    ['Electricity', 'Liquid Fuels'],
    ['Net Exported Electricity', 'Net Exported Liquid Fuels'],
    ['Net Imported Electricity', 'Net Imported Liquid Fuels']
];

const num = v => (v === null || v === undefined ? null : Number(v));

/** Map node name -> nodes-table row. Build once at load time. */
export function buildNodeTable(rows) {
    return new Map(rows.map(r => [r.node, r]));
}

/** Map `${scenario}|${region}|${year}` -> Map(node -> { value, y_order }). Build once at load time. */
export function buildRankIndex(rows) {
    const index = new Map();
    for (const r of rows) {
        const key = `${r.scenario}|${r.region}|${num(r.year)}`;
        if (!index.has(key)) index.set(key, new Map());
        index.get(key).set(r.node, { value: Number(r.value) || 0, y_order: num(r.y_order) });
    }
    return index;
}

/**
 * Rank of each primary source (1 = top) for one scenario/year and one or more regions.
 * One region: the table's y_order. Several regions: values are summed and re-ranked.
 */
export function getPrimaryRanks(rankIndex, scenario, regions, year) {
    const list = Array.isArray(regions) ? regions : [regions];
    if (list.length === 1) {
        const m = rankIndex.get(`${scenario}|${list[0]}|${num(year)}`);
        return new Map(m ? [...m].map(([node, r]) => [node, r.y_order]) : []);
    }
    const totals = new Map();
    for (const region of list) {
        const m = rankIndex.get(`${scenario}|${region}|${num(year)}`);
        if (!m) continue;
        for (const [node, r] of m) totals.set(node, (totals.get(node) || 0) + r.value);
    }
    const sorted = [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return new Map(sorted.map(([node], i) => [node, i + 1]));
}

/** Throws if two nodes in the same column share an order value. */
export function assertUniqueOrders(placement) {
    const seen = new Map();
    for (const [node, { col, order }] of placement) {
        const key = `${col}:${order}`;
        if (seen.has(key)) {
            throw new Error(`Nodes "${seen.get(key)}" and "${node}" share order ${order} in column ${col}`);
        }
        seen.set(key, node);
    }
}

/**
 * Column and order for every label at the given level (1-3).
 * Throws if a label is missing from the table or has no value for that level.
 * @returns {Map<string, {col:number, order:number}>}
 */
export function tableColumnsAndOrder(labels, nodeTable, level, primaryRanks = null) {
    const colKey = `x_col_L${level}`;
    const orderKey = `y_order_L${level}`;
    const placement = new Map();
    for (const label of labels) {
        const row = nodeTable.get(label);
        if (!row) throw new Error(`Node "${label}" is not in the nodes table`);
        const col = num(row[colKey]);
        const order = num(row[orderKey]);
        if (col === null || order === null) {
            throw new Error(`Node "${label}" has no ${colKey}/${orderKey} value for level ${level}`);
        }
        placement.set(label, { col, order });
    }

    // Re-sort primary sources by rank, reusing the order slots they already occupy in each column.
    if (primaryRanks && primaryRanks.size > 0) {
        const byCol = new Map();
        for (const label of labels) {
            if (nodeTable.get(label).role !== 'primary') continue;
            const { col } = placement.get(label);
            if (!byCol.has(col)) byCol.set(col, []);
            byCol.get(col).push(label);
        }
        for (const prims of byCol.values()) {
            const slots = prims.map(l => placement.get(l).order).sort((a, b) => a - b);
            const rankOf = l => primaryRanks.get(l) ?? Infinity;
            const ranked = [...prims].sort(
                (a, b) => rankOf(a) - rankOf(b) || placement.get(a).order - placement.get(b).order
            );
            ranked.forEach((l, i) => (placement.get(l).order = slots[i]));
        }
    }

    // Put Electricity above Liquid Fuels in each pair (lower order = higher on screen).
    for (const [elec, liq] of SWAP_PAIRS) {
        const e = placement.get(elec);
        const q = placement.get(liq);
        if (e && q && e.col === q.col && e.order > q.order) [e.order, q.order] = [q.order, e.order];
    }

    assertUniqueOrders(placement);
    return placement;
}
