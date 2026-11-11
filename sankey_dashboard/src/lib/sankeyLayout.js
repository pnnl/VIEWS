// Pure layout solver and constraint validator for Sankey diagrams.
// Supports Parquet source_position / target_position metadata (input_L0..L3, output_L1..L4)
// as well as CSV datasets (Energy, Water, Energy & Water).

import { tableColumnsAndOrder } from './tableLayout.js';

const CANONICAL_PRIMARY_ENERGY = new Set([
    'biomass',
    'coal',
    'geothermal',
    'hydropower',
    'natural gas',
    'nuclear',
    'oil',
    'solar',
    'wind'
]);

const SECONDARY_CARRIERS = new Set([
    'hydrogen', 'gaseous fuels', 'refined liquids', 'biorefining', 'oil refining',
    'coal to liquids', 'gas to liquids', 'biodiesel', 'corn ethanol',
    'cellulosic ethanol', 'sugar cane ethanol', 'biomass liquids'
]);

const BUILDINGS_ROOTS = new Set([
    'buildings',
    'commercial',
    'residential'
]);

const INDUSTRY_ROOTS = new Set([
    'industry',
    'cement',
    'cement ccs',
    'cogeneration',
    'industrial energy use',
    'industrial feedstocks',
    'n fertilizer',
    'n fertilizer ccs',
    'process heat',
    'mining'
]);

const TRANSPORT_ROOTS = new Set([
    'transport',
    'transportation',
    'transportation-vehicle',
    'transportation-nonvehicle',
    'aviation',
    'rail',
    'road',
    'ship',
    'freight',
    'passenger',
    'international aviation'
]);

const WATER_BASIN_KEYWORDS = [
    'arkansas white red',
    'california river',
    'caribbean',
    'great basin',
    'lower colorado river',
    'lower mississippi river',
    'mid atlantic',
    'missouri river',
    'new england',
    'ohio river',
    'pacific northwest',
    'rio grande river',
    'south atlantic gulf',
    'tennessee river',
    'texas gulf coast',
    'upper colorado river',
    'upper mississippi'
];

function normLabel(label) {
    return String(label || '').trim().toLowerCase();
}

export function isElectricity(label) {
    return normLabel(label) === 'electricity';
}

export function isLiquidFuels(label) {
    return normLabel(label) === 'liquid fuels';
}

function isElecOrLiq(label) {
    const nl = normLabel(label);
    return nl === 'electricity' || nl === 'liquid fuels';
}

export function isLossesNode(label, meta) {
    const nl = normLabel(label);
    if (nl === 'losses' || nl === 'loss' || nl.includes('losses')) return true;
    return false;
}

function isNetImportedNode(label, meta) {
    const nl = normLabel(label);
    if (nl.startsWith('net imported') || nl.startsWith('produced ') || nl === 'surface mining' || nl === 'underground mining') {
        return true;
    }
    if (meta && meta.srcPositions.size > 0 && meta.tgtPositions.size === 0) {
        if ([...meta.srcPositions].every(p => p === 'input_L0')) return true;
    }
    return false;
}

function isNetExportedNode(label) {
    const nl = normLabel(label);
    return nl.startsWith('net exported');
}

export function isWaterNode(label, meta) {
    const nl = normLabel(label);
    // Energy building/cooling equipment containing the word 'water'
    if (nl.includes('water heater') || nl === 'hot water' || nl === 'seawater') {
        return false;
    }
    if (meta) {
        if (meta.hasEnergyUnit || meta.srcPositions.size > 0 || meta.tgtPositions.size > 0) {
            // If it has explicit GCAM energy position tags or EJ units, it is an energy node
            // unless its label is explicitly a water supply/use node
            if (
                !nl.includes('water') &&
                nl !== 'desalination' &&
                nl !== 'groundwater' &&
                nl !== 'irrigation' &&
                nl !== 'livestock' &&
                nl !== 'crops' &&
                !WATER_BASIN_KEYWORDS.includes(nl)
            ) {
                return false;
            }
        }
        if (meta.hasWaterUnit && !meta.hasEnergyUnit) {
            return true;
        }
    }
    if (
        nl.includes('water') ||
        nl === 'desalination' ||
        nl === 'groundwater' ||
        nl.includes('irrigation') ||
        nl.includes('livestock') ||
        nl === 'crops' ||
        nl.includes('aquifer') ||
        WATER_BASIN_KEYWORDS.includes(nl)
    ) {
        return true;
    }
    return false;
}

export function isPrimaryEnergy(label, inDegree = 0, outDegree = 0) {
    if (isWaterNode(label) || isLossesNode(label) || isElecOrLiq(label) || isNetImportedNode(label) || isNetExportedNode(label)) {
        return false;
    }
    const nl = normLabel(label);
    if (CANONICAL_PRIMARY_ENERGY.has(nl)) return true;
    if (classifyEndUse(label)) return false;
    if (SECONDARY_CARRIERS.has(nl)) return false;
    return inDegree === 0 && outDegree > 0;
}

function isPrimaryEnergyNode(label, meta, isWater) {
    if (isWater) return false;
    const nl = normLabel(label);
    if (isElecOrLiq(label) || isLossesNode(label, meta) || isNetImportedNode(label, meta) || isNetExportedNode(label)) {
        return false;
    }
    if (CANONICAL_PRIMARY_ENERGY.has(nl)) {
        return true;
    }
    // Check synthetic primary energy nodes tagged with source_position === 'input_L1'
    if (meta && meta.srcPositions.has('input_L1')) {
        const nonSecondary = !SECONDARY_CARRIERS.has(nl);
        const onlyFromL0OrNone = [...meta.incomingSources].every(src => isNetImportedNode(src, null));
        if (nonSecondary && onlyFromL0OrNone) {
            return true;
        }
    }
    // Also treat pure source energy nodes (inDegree === 0, outDegree > 0) in synthetic/CSV graphs as primary energy
    if (
        meta &&
        meta.srcPositions.size === 0 &&
        meta.tgtPositions.size === 0 &&
        meta.incomingSources.size === 0 &&
        meta.outgoingTargets.size > 0 &&
        !classifyEndUse(label) &&
        !SECONDARY_CARRIERS.has(nl)
    ) {
        return true;
    }
    return false;
}

export function classifyEndUse(label, meta = null) {
    if ((meta && meta.isWater) || isWaterNode(label, meta)) return null;
    const nl = normLabel(label);
    if (BUILDINGS_ROOTS.has(nl) || nl.includes('building') || nl.includes('residential') || nl.includes('commercial')) {
        return 'buildings';
    }
    if (INDUSTRY_ROOTS.has(nl) || nl.includes('industry') || nl.includes('industrial')) {
        return 'industry';
    }
    if (TRANSPORT_ROOTS.has(nl) || nl.includes('transport')) {
        return 'transport';
    }
    return null;
}

function classifyEndUseSectors(labels, activeLinks, nodeMeta) {
    const sectorMap = new Map(); // label -> 'buildings' | 'industry' | 'transport'

    for (const label of labels) {
        if (nodeMeta.get(label)?.isWater) continue;
        const sec = classifyEndUse(label);
        if (sec) sectorMap.set(label, sec);
    }

    // Propagate sector classification along output_L* -> output_L* hierarchy edges
    let changed = true;
    while (changed) {
        changed = false;
        for (const link of activeLinks) {
            const s = link.source;
            const t = link.target;
            if (isLossesNode(t, nodeMeta.get(t)) || nodeMeta.get(t)?.isWater) continue;
            const sSector = sectorMap.get(s);
            if (sSector && !sectorMap.has(t)) {
                const tp = String(link.target_position || '');
                const sp = String(link.source_position || '');
                const tMeta = nodeMeta.get(t);
                const isOutputTarget =
                    tp.startsWith('output_') ||
                    sp.startsWith('output_') ||
                    (tMeta && tMeta.outgoingTargets.size === 0 && !isElecOrLiq(t) && !isPrimaryEnergyNode(t, tMeta, false));
                if (isOutputTarget) {
                    sectorMap.set(t, sSector);
                    changed = true;
                }
            }
        }
    }

    return sectorMap;
}

/**
 * Identify feedback edges from {Electricity, Liquid Fuels} to upstream conversion/refining nodes
 * that themselves have a directed path to {Electricity, Liquid Fuels}.
 */
function findFeedbackEdges(activeLinks) {
    // Build adjacency excluding {Electricity, Liquid Fuels} as sources
    const adj = new Map();
    for (const r of activeLinks) {
        const u = r.source;
        const v = r.target;
        if (!u || !v || u === v) continue;
        if (isElecOrLiq(u)) continue;
        if (!adj.has(u)) adj.set(u, new Set());
        adj.get(u).add(v);
    }

    function canReachElecOrLiq(start) {
        const visited = new Set([start]);
        const queue = [start];
        while (queue.length > 0) {
            const curr = queue.shift();
            if (isElecOrLiq(curr)) return true;
            const nexts = adj.get(curr);
            if (!nexts) continue;
            for (const nxt of nexts) {
                if (!visited.has(nxt)) {
                    visited.add(nxt);
                    queue.push(nxt);
                }
            }
        }
        return false;
    }

    const excludedEdgeKeys = new Set();
    for (const r of activeLinks) {
        const u = r.source;
        const v = r.target;
        if (!u || !v || u === v) continue;
        if (isElecOrLiq(u) && isElecOrLiq(v)) {
            excludedEdgeKeys.add(`${u}|||${v}`);
            continue;
        }
        if (isElecOrLiq(u) && canReachElecOrLiq(v)) {
            excludedEdgeKeys.add(`${u}|||${v}`);
        }
    }
    return excludedEdgeKeys;
}

/**
 * Compute deterministic x, y node positions and metadata satisfying all layout constraints.
 *
 * @param {Array<Object>} links - Array of link objects { source, target, value, source_position?, target_position?, units?, diagram? }
 * @param {Object} [options] - Layout options
 * @returns {Object} { x, y, labels, columns, heights, nodeMeta, validation }
 */
export function computeLayout(links = [], options = {}) {
    const activeLinks = (links || []).filter(
        r => r && r.source != null && r.target != null && Number(r.value) > 0
    );

    // Derive ordered unique labels
    let labels = [];
    if (Array.isArray(options.labels) && options.labels.length > 0) {
        labels = [...options.labels];
    } else {
        const seen = new Set();
        for (const r of activeLinks) {
            if (!seen.has(r.source)) {
                seen.add(r.source);
                labels.push(r.source);
            }
            if (!seen.has(r.target)) {
                seen.add(r.target);
                labels.push(r.target);
            }
        }
    }

    if (labels.length === 0) {
        return {
            x: [],
            y: [],
            labels: [],
            columns: [],
            heights: [],
            nodeMeta: new Map(),
            validation: { valid: true, violations: [] }
        };
    }

    // Build per-node metadata
    const nodeMeta = new Map();
    for (const label of labels) {
        nodeMeta.set(label, {
            label,
            inflow: 0,
            outflow: 0,
            magnitude: 0,
            srcPositions: new Set(),
            tgtPositions: new Set(),
            incomingSources: new Set(),
            outgoingTargets: new Set(),
            hasWaterUnit: false,
            hasEnergyUnit: false,
            isWater: false,
            isPrimaryEnergy: false,
            isLosses: false,
            isNetImported: false,
            isNetExported: false,
            sector: null // 'buildings' | 'industry' | 'transport' | null
        });
    }

    for (const r of activeLinks) {
        const val = Number(r.value) || 0;
        if (val <= 0) continue;
        const s = r.source;
        const t = r.target;
        if (!nodeMeta.has(s)) {
            labels.push(s);
            nodeMeta.set(s, {
                label: s,
                inflow: 0,
                outflow: 0,
                magnitude: 0,
                srcPositions: new Set(),
                tgtPositions: new Set(),
                incomingSources: new Set(),
                outgoingTargets: new Set(),
                hasWaterUnit: false,
                hasEnergyUnit: false,
                isWater: false,
                isPrimaryEnergy: false,
                isLosses: false,
                isNetImported: false,
                isNetExported: false,
                sector: null
            });
        }
        if (!nodeMeta.has(t)) {
            labels.push(t);
            nodeMeta.set(t, {
                label: t,
                inflow: 0,
                outflow: 0,
                magnitude: 0,
                srcPositions: new Set(),
                tgtPositions: new Set(),
                incomingSources: new Set(),
                outgoingTargets: new Set(),
                hasWaterUnit: false,
                hasEnergyUnit: false,
                isWater: false,
                isPrimaryEnergy: false,
                isLosses: false,
                isNetImported: false,
                isNetExported: false,
                sector: null
            });
        }

        const sMeta = nodeMeta.get(s);
        const tMeta = nodeMeta.get(t);
        sMeta.outflow += val;
        tMeta.inflow += val;
        sMeta.outgoingTargets.add(t);
        tMeta.incomingSources.add(s);

        if (r.source_position) sMeta.srcPositions.add(String(r.source_position));
        if (r.target_position) tMeta.tgtPositions.add(String(r.target_position));

        const unit = String(r.units || '').toLowerCase();
        const diag = String(r.diagram || '').toLowerCase();
        if (unit === 'km3' || diag === 'water') {
            sMeta.hasWaterUnit = true;
            tMeta.hasWaterUnit = true;
        }
        if (unit === 'ej' || diag === 'energy') {
            sMeta.hasEnergyUnit = true;
            tMeta.hasEnergyUnit = true;
        }
    }

    for (const label of labels) {
        const m = nodeMeta.get(label);
        m.magnitude = Math.max(m.inflow, m.outflow);
        m.isWater = isWaterNode(label, m);
        m.isLosses = isLossesNode(label, m);
        m.isNetImported = isNetImportedNode(label, m);
        m.isNetExported = isNetExportedNode(label);
    }

    for (const label of labels) {
        const m = nodeMeta.get(label);
        m.isPrimaryEnergy = isPrimaryEnergyNode(label, m, m.isWater);
    }

    const sectorMap = classifyEndUseSectors(labels, activeLinks, nodeMeta);
    for (const [label, sector] of sectorMap.entries()) {
        if (nodeMeta.has(label)) {
            nodeMeta.get(label).sector = sector;
        }
    }

    // Identify feedback edges to exclude from horizontal DAG constraints
    const excludedEdgeKeys = findFeedbackEdges(activeLinks);

    // Table-driven placement (columns + within-column order) when a node table and level are given
    const placement = options.nodeTable && options.level != null
        ? tableColumnsAndOrder(labels, options.nodeTable, options.level, options.primaryRanks ?? null)
        : null;
    const tableOrder = placement ? (a, b) => placement.get(a).order - placement.get(b).order : null;

    // Build horizontal column assignment
    const colMap = new Map();
    for (const label of labels) {
        colMap.set(label, 0);
    }

    // Filter DAG edges
    const dagEdges = [];
    for (const r of activeLinks) {
        const u = r.source;
        const v = r.target;
        if (!u || !v || u === v) continue;
        if (excludedEdgeKeys.has(`${u}|||${v}`)) continue;
        dagEdges.push([u, v]);
    }

    const elecLabel = labels.find(l => isElectricity(l));
    const liqLabel = labels.find(l => isLiquidFuels(l));

    function syncElecLiqColumns() {
        if (elecLabel && liqLabel) {
            const c = Math.max(colMap.get(elecLabel), colMap.get(liqLabel));
            colMap.set(elecLabel, c);
            colMap.set(liqLabel, c);
        }
    }

    // Iterative longest-path relaxation with cycle guard
    const maxIter = labels.length * 4 + 20;
    for (let iter = 0; iter < maxIter; iter++) {
        let updated = false;
        syncElecLiqColumns();

        for (const [u, v] of dagEdges) {
            const cu = colMap.get(u);
            const cv = colMap.get(v);
            if (cv < cu + 1) {
                colMap.set(v, cu + 1);
                updated = true;
            }
        }

        syncElecLiqColumns();

        // Align all primary energy nodes into the same primary column.
        // The anchor column is set ONLY by canonical primaries (coal, solar, ...)
        // so a misclassified fallback node can never drag the primary column right.
        const primaryNodes = labels.filter(l => nodeMeta.get(l).isPrimaryEnergy);
        const canonicalPrimaries = primaryNodes.filter(l => CANONICAL_PRIMARY_ENERGY.has(normLabel(l)));
        const anchorNodes = canonicalPrimaries.length > 0 ? canonicalPrimaries : primaryNodes;
        if (primaryNodes.length > 1 && anchorNodes.length > 0) {
            const maxPrimaryCol = Math.max(...anchorNodes.map(l => colMap.get(l)));
            for (const l of primaryNodes) {
                if (colMap.get(l) < maxPrimaryCol) {
                    colMap.set(l, maxPrimaryCol);
                    updated = true;
                }
            }
        }

        // Ensure transformation nodes (input_L2 / input_L3 that are not primary/carrier/enduse/water)
        // are strictly to the right of primary energy nodes
        const primaryCol = anchorNodes.length > 0 ? Math.max(...anchorNodes.map(l => colMap.get(l))) : -1;
        if (primaryCol >= 0) {
            for (const l of labels) {
                const m = nodeMeta.get(l);
                if (m.isWater || m.isPrimaryEnergy || m.isNetImported || m.isLosses) continue;
                const hasTransformPos =
                    m.srcPositions.has('input_L2') ||
                    m.srcPositions.has('input_L3') ||
                    m.tgtPositions.has('input_L2') ||
                    m.tgtPositions.has('input_L3');
                if (hasTransformPos && colMap.get(l) <= primaryCol) {
                    colMap.set(l, primaryCol + 1);
                    updated = true;
                }
            }
        }

        // Ensure {Electricity, Liquid Fuels} are strictly to the right of all upstream transformation nodes
        const transformCols = labels
            .filter(l => {
                const m = nodeMeta.get(l);
                if (m.isWater || m.isPrimaryEnergy || m.isNetImported || m.isLosses || m.isNetExported || m.sector) return false;
                if (isElecOrLiq(l)) return false;
                return (
                    m.srcPositions.has('input_L2') ||
                    m.srcPositions.has('input_L3') ||
                    m.tgtPositions.has('input_L2') ||
                    m.tgtPositions.has('input_L3')
                );
            })
            .map(l => colMap.get(l));

        const minCarrierCol = Math.max(
            primaryCol >= 0 ? primaryCol + 1 : 0,
            transformCols.length > 0 ? Math.max(...transformCols) + 1 : 0
        );
        if (elecLabel && colMap.get(elecLabel) < minCarrierCol) {
            colMap.set(elecLabel, minCarrierCol);
            updated = true;
        }
        if (liqLabel && colMap.get(liqLabel) < minCarrierCol) {
            colMap.set(liqLabel, minCarrierCol);
            updated = true;
        }
        syncElecLiqColumns();

        // Ensure all end-use sector nodes and Net Exported nodes are strictly to the right of
        // {Electricity, Liquid Fuels} and all transformation nodes
        const carrierCol = Math.max(
            elecLabel ? colMap.get(elecLabel) : -1,
            liqLabel ? colMap.get(liqLabel) : -1,
            transformCols.length > 0 ? Math.max(...transformCols) : -1,
            primaryCol
        );
        if (carrierCol >= 0) {
            const minEndUseCol = carrierCol + 1;
            for (const l of labels) {
                const m = nodeMeta.get(l);
                if (m.sector || m.isNetExported) {
                    if (colMap.get(l) < minEndUseCol) {
                        colMap.set(l, minEndUseCol);
                        updated = true;
                    }
                }
            }
        }

        if (!updated) break;
    }

    // Place Losses in the rightmost column
    const nonLossCols = labels.filter(l => !nodeMeta.get(l).isLosses).map(l => colMap.get(l));
    const maxNonLossCol = nonLossCols.length > 0 ? Math.max(...nonLossCols) : 0;
    for (const l of labels) {
        if (nodeMeta.get(l).isLosses) {
            // Check if any incoming source to Losses is already at maxNonLossCol
            let reqCol = maxNonLossCol;
            for (const src of nodeMeta.get(l).incomingSources) {
                if (colMap.has(src)) {
                    reqCol = Math.max(reqCol, colMap.get(src) + 1);
                }
            }
            // If all other nodes in maxNonLossCol are pure sinks (no edge into Losses), Losses can share maxNonLossCol
            colMap.set(l, Math.max(maxNonLossCol, reqCol));
        }
    }

    // Table placement overrides the heuristic columns; otherwise pin Losses to the rightmost column
    if (placement) {
        for (const l of labels) colMap.set(l, placement.get(l).col);
    } else {
        const finalMaxCol = Math.max(...labels.map(l => colMap.get(l)));
        for (const l of labels) {
            if (nodeMeta.get(l).isLosses) {
                colMap.set(l, finalMaxCol);
            }
        }
    }

    // Compress column indices to contiguous 0 .. numCols - 1
    const uniqueSortedCols = [...new Set(labels.map(l => colMap.get(l)))].sort((a, b) => a - b);
    const colIndexMap = new Map(uniqueSortedCols.map((c, idx) => [c, idx]));
    for (const l of labels) {
        colMap.set(l, colIndexMap.get(colMap.get(l)));
    }

    const numCols = uniqueSortedCols.length;
    const xByLabel = new Map();
    for (const l of labels) {
        const c = colMap.get(l);
        const xVal = numCols <= 1 ? 0.5 : 0.01 + (c / (numCols - 1)) * 0.98;
        xByLabel.set(l, xVal);
    }

    // Compute column flow totals to estimate normalized node heights
    const colFlowTotals = new Array(numCols).fill(0);
    const colNodeLists = Array.from({ length: numCols }, () => []);
    for (const l of labels) {
        const c = colMap.get(l);
        colNodeLists[c].push(l);
        colFlowTotals[c] += nodeMeta.get(l).magnitude;
    }

    // Mirror Plotly's node scaling: the tightest column (flow + pad) sets ky
    const padFrac = (options.padPx ?? 15) / (options.plotHeightPx ?? 600);
    let ky = Infinity;
    for (let c = 0; c < numCols; c++) {
        const n = colNodeLists[c].length;
        if (colFlowTotals[c] > 0) {
            ky = Math.min(ky, (1 - padFrac * Math.max(0, n - 1)) / colFlowTotals[c]);
        }
    }
    if (!Number.isFinite(ky) || ky < 0) ky = 0;

    const heightByLabel = new Map();
    for (const l of labels) {
        const mag = nodeMeta.get(l).magnitude;
        heightByLabel.set(l, Math.max(0.004, mag * ky));
    }

    // Required vertical span per band: tallest column's total height + gaps
    const gapY = 0.008;
    const sumBand = ns =>
        ns.reduce((a, l) => a + heightByLabel.get(l), 0) + gapY * Math.max(0, ns.length - 1);
    let reqEnergy = 0, reqWater = 0, reqLosses = 0;
    for (let c = 0; c < numCols; c++) {
        const col = colNodeLists[c];
        reqLosses = Math.max(reqLosses, sumBand(col.filter(l => nodeMeta.get(l).isLosses)));
        reqEnergy = Math.max(reqEnergy, sumBand(col.filter(l => !nodeMeta.get(l).isWater && !nodeMeta.get(l).isLosses)));
        reqWater = Math.max(reqWater, sumBand(col.filter(l => nodeMeta.get(l).isWater)));
    }

    const hasEnergyNodes = labels.some(l => !nodeMeta.get(l).isWater);
    const hasWaterNodes = labels.some(l => nodeMeta.get(l).isWater);
    const hasLosses = labels.some(l => nodeMeta.get(l).isLosses);

    // End-use sector groups (classified before band computation so band sizes
    // can account for the sum of global sector band requirements)
    const hasBuildings = labels.some(l => nodeMeta.get(l).sector === 'buildings');
    const hasIndustry = labels.some(l => nodeMeta.get(l).sector === 'industry');
    const hasTransport = labels.some(l => nodeMeta.get(l).sector === 'transport');
    const hasExports = labels.some(l => nodeMeta.get(l).isNetExported);

    const activeEndUseGroups = [];
    if (hasBuildings) activeEndUseGroups.push('buildings');
    if (hasIndustry) activeEndUseGroups.push('industry');
    if (hasTransport) activeEndUseGroups.push('transport');
    if (hasExports) activeEndUseGroups.push('exports');

    const groupWeights = new Map();
    for (const g of activeEndUseGroups) {
        // Weight by the group's maximum required height in any single column
        let req = 0.01;
        for (let c = 0; c < numCols; c++) {
            const groupNodes = colNodeLists[c].filter(l => {
                const m = nodeMeta.get(l);
                return g === 'exports' ? m.isNetExported : m.sector === g;
            });
            req = Math.max(req, sumBand(groupNodes));
        }
        groupWeights.set(g, req);
    }

    const bandGap = activeEndUseGroups.length > 1 ? 0.025 : 0;
    const reqEndUse = [...groupWeights.values()].reduce((a, b) => a + b, 0)
        + bandGap * Math.max(0, activeEndUseGroups.length - 1);

    // Data-driven vertical band allocation: Losses / Energy / Water
    const bandPad = 0.025;
    const lossesTopY = 0.01;
    const nonLossEnergyTop = hasLosses ? lossesTopY + reqLosses + bandPad : 0.01;

    // Energy band must fit BOTH the tallest upstream column AND the summed sector bands
    const reqEnergyTotal = Math.max(reqEnergy, reqEndUse);
    const energyBottom = hasWaterNodes
        ? Math.max(nonLossEnergyTop + reqEnergyTotal, 0.99 - reqWater - bandPad)
        : 0.99;
    const waterRange = hasEnergyNodes ? [energyBottom + bandPad, 0.99] : [0.01, 0.99];

    const totalGroupWeight = [...groupWeights.values()].reduce((a, b) => a + b, 0) || 1;
    const availEndUseSpan = Math.max(0.1, (energyBottom - nonLossEnergyTop) - bandGap * Math.max(0, activeEndUseGroups.length - 1));

    const sectorBands = new Map();
    let bandCursor = nonLossEnergyTop;
    for (const g of activeEndUseGroups) {
        const span = availEndUseSpan * (groupWeights.get(g) / totalGroupWeight);
        sectorBands.set(g, [bandCursor, bandCursor + span]);
        bandCursor += span + bandGap;
    }

    /**
    * Pack an ordered list of nodes into [spanTop, spanBottom] without vertical overlap.
    * Node heights are fixed (Plotly-determined); only positions are assigned.
    */
    function packNodesInBand(orderedNodes, spanTop, spanBottom, yMap) {
        const n = orderedNodes.length;
        if (n === 0) return;
        const span = Math.max(0.005, spanBottom - spanTop);
        if (n === 1) {
            const u = orderedNodes[0];
            yMap.set(u, spanTop + heightByLabel.get(u) / 2);
            return;
        }

        const actualTotalH = orderedNodes.reduce((acc, u) => acc + heightByLabel.get(u), 0);
        const extraSpace = Math.max(0, span - actualTotalH);
        const gap = extraSpace / (n - 1);

        let cursor = spanTop;
        for (const u of orderedNodes) {
            const h = heightByLabel.get(u);
            yMap.set(u, cursor + h / 2);
            cursor += h + gap;
        }
    }

    const yByLabel = new Map();

    // Comparator helper: magnitude descending, then outflow descending, then label ascending
    function compareByMagnitudeDesc(a, b) {
        const ma = nodeMeta.get(a);
        const mb = nodeMeta.get(b);
        if (Math.abs(mb.magnitude - ma.magnitude) > 1e-12) {
            return mb.magnitude - ma.magnitude;
        }
        if (Math.abs(mb.outflow - ma.outflow) > 1e-12) {
            return mb.outflow - ma.outflow;
        }
        return String(a).localeCompare(String(b));
    }

    // Assign y coordinates column by column
    for (let c = 0; c < numCols; c++) {
        const colNodes = colNodeLists[c];
        const energyNodes = colNodes.filter(l => !nodeMeta.get(l).isWater);
        const waterNodes = colNodes.filter(l => nodeMeta.get(l).isWater);

        // 1. Place Losses if in this column
        const lossNodes = energyNodes.filter(l => nodeMeta.get(l).isLosses);
        const remEnergyNodes = energyNodes.filter(l => !nodeMeta.get(l).isLosses);

        if (lossNodes.length > 0) {
            packNodesInBand(lossNodes, lossesTopY, lossesTopY + Math.max(reqLosses, 0.03), yByLabel);
        }

        // 2. Partition remaining energy nodes in this column
        const sectorNodesInCol = remEnergyNodes.filter(l => nodeMeta.get(l).sector || nodeMeta.get(l).isNetExported);
        const nonSectorNodesInCol = remEnergyNodes.filter(l => !nodeMeta.get(l).sector && !nodeMeta.get(l).isNetExported);

        if (sectorNodesInCol.length > 0 && nonSectorNodesInCol.length === 0) {
            // Pure end-use column: pack each sector family into its dedicated global vertical band
            for (const g of activeEndUseGroups) {
                const groupNodes = sectorNodesInCol
                    .filter(l => {
                        const m = nodeMeta.get(l);
                        return g === 'exports' ? m.isNetExported : m.sector === g;
                    })
                    .sort(tableOrder ?? compareByMagnitudeDesc);
                if (groupNodes.length > 0) {
                    const [bTop, bBot] = sectorBands.get(g);
                    packNodesInBand(groupNodes, bTop, bBot, yByLabel);
                }
            }
        } else if (sectorNodesInCol.length === 0 && nonSectorNodesInCol.length > 0) {
            // Pure upstream / primary / carrier column
            const ordered = [...nonSectorNodesInCol].sort(tableOrder ?? ((a, b) => {
                // Electricity always above Liquid Fuels
                if (isElectricity(a) && isLiquidFuels(b)) return -1;
                if (isLiquidFuels(a) && isElectricity(b)) return 1;
                if (isElecOrLiq(a) && !isElecOrLiq(b)) return -1;
                if (!isElecOrLiq(a) && isElecOrLiq(b)) return 1;

                // Primary energy nodes before non-primary in the same column
                const pa = nodeMeta.get(a).isPrimaryEnergy;
                const pb = nodeMeta.get(b).isPrimaryEnergy;
                if (pa && !pb) return -1;
                if (!pa && pb) return 1;

                return compareByMagnitudeDesc(a, b);
            }));
            packNodesInBand(ordered, nonLossEnergyTop, energyBottom, yByLabel);
        } else if (sectorNodesInCol.length > 0 && nonSectorNodesInCol.length > 0) {
            // Mixed column: order by sector rank, then magnitude
            const ordered = [...remEnergyNodes].sort(tableOrder ?? ((a, b) => {
                if (isElectricity(a) && isLiquidFuels(b)) return -1;
                if (isLiquidFuels(a) && isElectricity(b)) return 1;
                const rank = l => {
                    const m = nodeMeta.get(l);
                    if (m.sector === 'buildings') return 1;
                    if (m.sector === 'industry') return 2;
                    if (m.sector === 'transport') return 3;
                    if (m.isNetExported) return 4;
                    return 5;
                };
                const ra = rank(a);
                const rb = rank(b);
                if (ra !== rb) return ra - rb;
                return compareByMagnitudeDesc(a, b);
            }));
            packNodesInBand(ordered, nonLossEnergyTop, energyBottom, yByLabel);
        }

        // 3. Pack Water nodes in this column within waterRange
        if (waterNodes.length > 0) {
            const orderedWater = [...waterNodes].sort(tableOrder ?? compareByMagnitudeDesc);
            packNodesInBand(orderedWater, waterRange[0], waterRange[1], yByLabel);
        }
    }

    // Apply user perpendicular drag overrides (userYOverrides) if provided, then re-project
    const overrides = options.userYOverrides;
    if (overrides && (overrides instanceof Map ? overrides.size > 0 : Object.keys(overrides).length > 0)) {
        const getOverride = l => (overrides instanceof Map ? overrides.get(l) : overrides[l]);
        for (const l of labels) {
            const ov = getOverride(l);
            if (typeof ov === 'number' && Number.isFinite(ov)) {
                const m = nodeMeta.get(l);
                if (m.isLosses) continue; // Keep Losses pinned to upper right
                const h = heightByLabel.get(l) || 0;
                const centered = ov + h / 2; // Plotly reports node top; internal math is center-based
                const [bMin, bMax] = m.isWater ? waterRange : [nonLossEnergyTop, energyBottom];
                const clamped = Math.max(bMin + h / 2, Math.min(bMax - h / 2, centered));
                yByLabel.set(l, clamped);
            }
        }
        // Re-project each column to guarantee non-overlap and hard ordering invariants
        for (let c = 0; c < numCols; c++) {
            const colNodes = colNodeLists[c];
            const energyNodes = colNodes.filter(l => !nodeMeta.get(l).isWater && !nodeMeta.get(l).isLosses);
            const waterNodes = colNodes.filter(l => nodeMeta.get(l).isWater);

            if (energyNodes.length > 1) {
                energyNodes.sort(tableOrder ?? ((a, b) => {
                    if (isElectricity(a) && isLiquidFuels(b)) return -1;
                    if (isLiquidFuels(a) && isElectricity(b)) return 1;
                    const sa = nodeMeta.get(a).sector;
                    const sb = nodeMeta.get(b).sector;
                    const sOrder = { buildings: 1, industry: 2, transport: 3 };
                    if (sa && sb && sOrder[sa] !== sOrder[sb]) return sOrder[sa] - sOrder[sb];
                    const pa = nodeMeta.get(a).isPrimaryEnergy;
                    const pb = nodeMeta.get(b).isPrimaryEnergy;
                    if (pa && pb) return compareByMagnitudeDesc(a, b);
                    return (yByLabel.get(a) || 0) - (yByLabel.get(b) || 0);
                }));
                projectNonOverlapping(energyNodes, nonLossEnergyTop, energyBottom, yByLabel, heightByLabel);
            }
            if (waterNodes.length > 1) {
                waterNodes.sort(tableOrder ?? ((a, b) => (yByLabel.get(a) || 0) - (yByLabel.get(b) || 0)));
                projectNonOverlapping(waterNodes, waterRange[0], waterRange[1], yByLabel, heightByLabel);
            }
        }
    }

    const x = labels.map(l => xByLabel.get(l));
    const yCenters = labels.map(l => yByLabel.get(l));
    const columns = labels.map(l => colMap.get(l));
    const heights = labels.map(l => heightByLabel.get(l));

    const result = {
        x,
        y: yCenters, // validate with center-based coordinates
        labels,
        columns,
        heights,
        nodeMeta,
        excludedEdgeKeys,
        placement // Map(label -> {col, order}) when table-driven, else null
    };

    const validation = validateLayout(result, activeLinks, options);
    result.validation = validation;

    if (options.strict && !validation.valid) {
        const msg = validation.violations.map(v => `${v.rule}: ${v.message}`).join('; ');
        throw new Error(`Sankey layout constraint violation: ${msg}`);
    }

    return result;
}

function projectNonOverlapping(orderedNodes, minBound, maxBound, yMap, hMap) {
    const n = orderedNodes.length;
    if (n <= 1) return;
    const minGap = 0.004;
    for (let i = 1; i < n; i++) {
        const prev = orderedNodes[i - 1];
        const curr = orderedNodes[i];
        const reqDiff = (hMap.get(prev) + hMap.get(curr)) / 2 + minGap;
        if (yMap.get(curr) < yMap.get(prev) + reqDiff) {
            yMap.set(curr, yMap.get(prev) + reqDiff);
        }
    }
    const last = orderedNodes[n - 1];
    const overflow = (yMap.get(last) + hMap.get(last) / 2) - maxBound;
    if (overflow > 0) {
        // Shift back or re-pack within [minBound, maxBound]
        for (let i = n - 1; i >= 0; i--) {
            const u = orderedNodes[i];
            yMap.set(u, Math.max(minBound + hMap.get(u) / 2, yMap.get(u) - overflow));
        }
    }
}

/**
 * Validate a computed layout against all 7 required invariants.
 *
 * @param {Object} layoutResult - Result from computeLayout
 * @param {Array<Object>} links - Links array
 * @param {Object} [options] - Validation options
 * @returns {{ valid: boolean, violations: Array<{ rule: string, message: string }> }}
 */
export function validateLayout(layoutResult, links = [], options = {}) {
    const violations = [];
    if (!layoutResult || !Array.isArray(layoutResult.labels)) {
        return { valid: false, violations: [{ rule: 'structure', message: 'Invalid layoutResult' }] };
    }

    const { x, y, labels, heights = [], nodeMeta } = layoutResult;
    if (labels.length === 0) {
        return { valid: true, violations: [] };
    }

    const idxMap = new Map(labels.map((l, i) => [l, i]));
    const activeLinks = (links || []).filter(
        r => r && r.source != null && r.target != null && Number(r.value) > 0
    );
    const excludedEdgeKeys = layoutResult.excludedEdgeKeys || findFeedbackEdges(activeLinks);

    // 1. Sources left of targets, EXCEPT Electricity and Liquid Fuels share the same x
    for (const r of activeLinks) {
        const u = r.source;
        const v = r.target;
        if (!idxMap.has(u) || !idxMap.has(v) || u === v) continue;
        const iu = idxMap.get(u);
        const iv = idxMap.get(v);

        if (isElecOrLiq(u) && isElecOrLiq(v)) {
            if (Math.abs(x[iu] - x[iv]) > 1e-5) {
                violations.push({
                    rule: 'electricity_liquid_fuels_same_x',
                    message: `Electricity (x=${x[iu]}) and Liquid Fuels (x=${x[iv]}) must have the same x position`
                });
            }
            continue;
        }

        if (excludedEdgeKeys.has(`${u}|||${v}`)) {
            continue;
        }

        if (!(x[iu] + 1e-6 < x[iv])) {
            violations.push({
                rule: 'source_left_of_target',
                message: `Source "${u}" (x=${x[iu]}) must be to the left of target "${v}" (x=${x[iv]})`
            });
        }
    }

    // 2. Electricity same x as Liquid Fuels AND Electricity above Liquid Fuels
    const elecIdx = labels.findIndex(l => isElectricity(l));
    const liqIdx = labels.findIndex(l => isLiquidFuels(l));
    if (elecIdx !== -1 && liqIdx !== -1) {
        if (Math.abs(x[elecIdx] - x[liqIdx]) > 1e-5) {
            violations.push({
                rule: 'electricity_liquid_fuels_same_x',
                message: `Electricity (x=${x[elecIdx]}) must have the same x as Liquid Fuels (x=${x[liqIdx]})`
            });
        }
        if (!(y[elecIdx] < y[liqIdx])) {
            violations.push({
                rule: 'electricity_above_liquid_fuels',
                message: `Electricity (y=${y[elecIdx]}) must be rendered above Liquid Fuels (y=${y[liqIdx]})`
            });
        }
    }

    // Ensure no other pair of distinct columns violates the "ONLY exception" rule along active links
    // (already checked per-link above: every non-Elec/Liq link has x[source] < x[target])

    // 3. Water nodes below Energy nodes
    const energyIndices = [];
    const waterIndices = [];
    for (let i = 0; i < labels.length; i++) {
        const l = labels[i];
        const m = nodeMeta ? nodeMeta.get(l) : null;
        const isW = m ? m.isWater : isWaterNode(l, null);
        if (isW) waterIndices.push(i);
        else energyIndices.push(i);
    }
    if (energyIndices.length > 0 && waterIndices.length > 0) {
        for (const ei of energyIndices) {
            for (const wi of waterIndices) {
                const eBot = y[ei] + (heights[ei] || 0) / 2;
                const wTop = y[wi] - (heights[wi] || 0) / 2;
                if (!(y[ei] < y[wi]) || eBot > wTop + 1e-5) {
                    violations.push({
                        rule: 'water_below_energy',
                        message: `Water node "${labels[wi]}" (y=${y[wi]}) must be below energy node "${labels[ei]}" (y=${y[ei]})`
                    });
                }
            }
        }
    }

    // 4. Losses on the upper right
    const lossIndices = labels
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => isLossesNode(l, nodeMeta ? nodeMeta.get(l) : null))
        .map(({ i }) => i);

    if (lossIndices.length > 0) {
        const maxX = Math.max(...x);
        const nonLossY = labels
            .map((_, i) => i)
            .filter(i => !lossIndices.includes(i))
            .map(i => y[i]);
        const minNonLossY = nonLossY.length > 0 ? Math.min(...nonLossY) : 1;

        for (const li of lossIndices) {
            if (Math.abs(x[li] - maxX) > 1e-5) {
                violations.push({
                    rule: 'losses_upper_right',
                    message: `Losses node "${labels[li]}" (x=${x[li]}) must be at rightmost x (${maxX})`
                });
            }
            if (!(y[li] < minNonLossY)) {
                violations.push({
                    rule: 'losses_upper_right',
                    message: `Losses node "${labels[li]}" (y=${y[li]}) must be above all non-loss nodes (min y=${minNonLossY})`
                });
            }
        }
    }

    // 5. Buildings above Industry above Transport
    const sectorMap = nodeMeta
        ? new Map([...nodeMeta.entries()].map(([k, v]) => [k, v.sector]))
        : classifyEndUseSectors(labels, activeLinks, new Map());

    const bIndices = [];
    const iIndices = [];
    const tIndices = [];
    for (let idx = 0; idx < labels.length; idx++) {
        const sec = sectorMap.get(labels[idx]);
        if (sec === 'buildings') bIndices.push(idx);
        else if (sec === 'industry') iIndices.push(idx);
        else if (sec === 'transport') tIndices.push(idx);
    }

    for (const bi of bIndices) {
        for (const ii of iIndices) {
            if (!(y[bi] < y[ii])) {
                violations.push({
                    rule: 'buildings_industry_transport_order',
                    message: `Buildings node "${labels[bi]}" (y=${y[bi]}) must be above Industry node "${labels[ii]}" (y=${y[ii]})`
                });
            }
        }
        for (const ti of tIndices) {
            if (!(y[bi] < y[ti])) {
                violations.push({
                    rule: 'buildings_industry_transport_order',
                    message: `Buildings node "${labels[bi]}" (y=${y[bi]}) must be above Transport node "${labels[ti]}" (y=${y[ti]})`
                });
            }
        }
    }
    for (const ii of iIndices) {
        for (const ti of tIndices) {
            if (!(y[ii] < y[ti])) {
                violations.push({
                    rule: 'buildings_industry_transport_order',
                    message: `Industry node "${labels[ii]}" (y=${y[ii]}) must be above Transport node "${labels[ti]}" (y=${y[ti]})`
                });
            }
        }
    }

    // 6. Primary energy nodes ordered by highest magnitude descending
    const primaryIndices = [];
    for (let idx = 0; idx < labels.length; idx++) {
        const l = labels[idx];
        const m = nodeMeta ? nodeMeta.get(l) : null;
        const isPrim = m ? m.isPrimaryEnergy : CANONICAL_PRIMARY_ENERGY.has(normLabel(l));
        if (isPrim) primaryIndices.push(idx);
    }
    if (primaryIndices.length > 1) {
        const getMag = idx => {
            const l = labels[idx];
            if (nodeMeta && nodeMeta.has(l)) return nodeMeta.get(l).magnitude;
            let inflow = 0;
            let outflow = 0;
            for (const r of activeLinks) {
                const val = Number(r.value) || 0;
                if (r.source === l) outflow += val;
                if (r.target === l) inflow += val;
            }
            return Math.max(inflow, outflow);
        };

        for (let a = 0; a < primaryIndices.length; a++) {
            for (let b = a + 1; b < primaryIndices.length; b++) {
                const ia = primaryIndices[a];
                const ib = primaryIndices[b];
                const magA = getMag(ia);
                const magB = getMag(ib);
                if (magA > magB + 1e-12 && !(y[ia] < y[ib])) {
                    violations.push({
                        rule: 'primary_energy_descending',
                        message: `Primary energy node "${labels[ia]}" (mag=${magA}, y=${y[ia]}) must be above "${labels[ib]}" (mag=${magB}, y=${y[ib]})`
                    });
                } else if (magB > magA + 1e-12 && !(y[ib] < y[ia])) {
                    violations.push({
                        rule: 'primary_energy_descending',
                        message: `Primary energy node "${labels[ib]}" (mag=${magB}, y=${y[ib]}) must be above "${labels[ia]}" (mag=${magA}, y=${y[ia]})`
                    });
                }
            }
        }
    }

    // 7. Nodes must not overlap vertically within each column
    const colBuckets = new Map();
    for (let i = 0; i < labels.length; i++) {
        const xKey = Math.round(x[i] * 10000);
        if (!colBuckets.has(xKey)) colBuckets.set(xKey, []);
        colBuckets.get(xKey).push(i);
    }

    for (const [, indices] of colBuckets.entries()) {
        if (indices.length <= 1) continue;
        const sorted = [...indices].sort((a, b) => y[a] - y[b]);
        for (let k = 0; k < sorted.length - 1; k++) {
            const ia = sorted[k];
            const ib = sorted[k + 1];
            const ha = heights[ia] || 0.004;
            const hb = heights[ib] || 0.004;
            const minSep = (ha + hb) / 2;
            if (y[ib] - y[ia] < minSep - 1e-6) {
                violations.push({
                    rule: 'no_vertical_overlap',
                    message: `Nodes "${labels[ia]}" (y=${y[ia]}, h=${ha}) and "${labels[ib]}" (y=${y[ib]}, h=${hb}) overlap vertically in column x=${x[ia]}`
                });
            }
        }
    }

    return {
        valid: violations.length === 0,
        violations
    };
}

/**
 * Backwards-compatible wrapper used by existing callers/tests.
 * Pass `nodeTable` and `level` (and optionally `primaryRanks` in options) for table-driven placement.
 */
export function computeNodePositions(labels, links, options = {}, nodeTable = null, level = null) {
    const opts = { ...options, labels };
    if (nodeTable) opts.nodeTable = nodeTable;
    if (level != null) opts.level = level;
    return computeLayout(links, opts);
}
