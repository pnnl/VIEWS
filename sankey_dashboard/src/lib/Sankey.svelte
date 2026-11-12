<script>
    import Papa from 'papaparse';
    import { parquetRead } from 'hyparquet';
    import { onMount } from 'svelte';
    import { base } from '$app/paths';
    import Icon from "@iconify/svelte";
    import { slide } from 'svelte/transition';
    import { computeNodePositions } from './sankeyLayout.js';
    import { computeEnergyLayout } from './energyLayout.js';
    import { buildNodeTable } from './tableLayout.js';

    const sspMapping = { 'ssp3': 'Low', 'ssp5': 'High', };
    const rcpMapping = { 'rcp45': 'Low', 'rcp85': 'High',};
    const climateMapping = { 'cooler': 'Cooler', 'hotter': 'Hotter', };
    const diagramMapping = {'Energy & Water': 'Integrated Energy & Water', 'Energy': 'Energy', 'Water': 'Water'};
    const waterUnitMapping = {'km3': 'Cubic Kilometers', 'billion_gallons': 'Billion Gallons', 'million_acre_ft': 'Million Acre-Feet'};
    const energyUnitMapping = {'EJ': 'Exajoules', 'quads': 'Quads', 'terawatt_hours': 'Terawatt-hours'};

    const detailLevels = [
        { label: 'Low', value: '1' },
        { label: 'Medium', value: '2' },
        { label: 'High', value: '3' }
    ];

    let energyNodeTable = null;
    let layoutWarnings = [];

    // This is the actual Sankey trace height used by the layout solver.
    // Controls are placed in Plotly's bottom margin, not inside this area.
    const PLOT_HEIGHT_PX = 600;
    const NODE_PAD_PX = 10;        
    const WATER_NODE_PAD_PX = 30;  
    const LABEL_LINE_PX = 20;      

    async function fetchParquet(fileName) {
        const response = await fetch(`${base}/${fileName}`);

        if (!response.ok) {
            throw new Error(`Failed to fetch ${fileName}: ${response.status}`);
        }

        const file = await response.arrayBuffer();
        let rows = [];

        await parquetRead({
            file,
            rowFormat: 'object',
            onComplete: (data) => {
                rows = data;
            }
        });

        return rows;
    }

    // 8 rows x 12 columns US cartogram layout
    const stateGrid = [
        ['AK', null, null, null, null, null, null, null, null, null, null, 'ME'],
        [null, null, null, null, null, 'WI', null, null, null, null, 'VT', 'NH'],
        ['WA', 'ID', 'MT', 'ND', 'MN', 'IL', 'MI', null, 'NY', 'MA', null, null],
        ['OR', 'NV', 'WY', 'SD', 'IA', 'IN', 'OH', 'PA', 'NJ', 'CT', 'RI', null],
        ['CA', 'UT', 'CO', 'NE', 'MO', 'KY', 'WV', 'VA', 'MD', 'DE', null, null],
        [null, 'AZ', 'NM', 'KS', 'AR', 'TN', 'NC', 'SC', 'DC', null, null, null],
        [null, null, null, 'OK', 'LA', 'MS', 'AL', 'GA', null, null, null, null],
        ['HI', null, null, 'TX', null, null, null, 'FL', null, null, null, null]
    ];

    const ssps = ['ssp3', 'ssp5']; // backend identifiers 
    let selectedSSP = ssps[0]; // default to 'ssp3'

    const rcps = ['rcp45', 'rcp85']; // backend identifiers 
    let selectedRCP = rcps[0]; // default to 'rcp45'

    const climates = ['cooler', 'hotter']; // backend identifiers 
    let selectedClimate = climates[0]; // default to 'Cooler'
    
    const diagrams = ['Energy & Water', 'Energy', 'Water'];  // backend identifiers 
    let selectedDiagram = diagrams[0]; // default to 'Energy & Water'

    const water_units = ['km3', 'billion_gallons', 'million_acre_ft'];  // backend identifiers
    let selectedWaterUnits = water_units[0]; // default to km3

    const energy_units = ['EJ', 'quads', 'terawatt_hours'];  // backend identifiers
    let selectedEnergyUnits = energy_units[0]; // default to EJ

    let energywaterdata;
    let gcamEnergyData = null;
    let loadedDetailLevel = null;
    let energyLevelDataCache = {};
    let pendingLevelPromises = {};
    let isLoadingEnergyData = false;
    let selectedStates = ['WA'];
    let selectedDetailLevel = '1'; // maps to 1, 2, 3 (always includes level 0)
    let renderCounter = 0;
    let currentSelectedYear = null;
    let layoutErrorMessage = '';

    const rcpRegex = /rcp[0-9]+/i;
    const sspRegex = /ssp[0-9]+/i;

    const colorPalettes = [
        {
            value: 'energy-water',
            label: 'Simple'
        },
        {
            value: 'data',
            label: 'By Energy Type'
        },
        {
            value: 'interpolated',
            label: 'Interpolated'
        }
    ];
    const energyWaterPalette = {
        energy: 'rgba(238, 118, 24, 0.6)',
        water: 'rgba(0, 177, 209, 0.6)',
        electricity: 'rgba(252, 207, 18, 0.6)',
        losses: 'rgba(105, 105, 105, 0.6)'
    };

    let selectedColorPalette = 'energy-water';

    // Collapsible Visualization Options sections (collapsed by default)
    let expandedSections = { palette: false, flows: false, waterUnits: false, energyUnits: false };
    function toggleSection(key) {
        expandedSections = { ...expandedSections, [key]: !expandedSections[key] };
    }

    // Current-choice summaries shown in collapsed headers
    $: paletteLabel = colorPalettes.find(p => p.value === selectedColorPalette)?.label ?? '';
    $: diagramLabel = selectedDiagram;
    $: waterUnitLabel = waterUnitMapping[selectedWaterUnits];
    $: energyUnitLabel = energyUnitMapping[selectedEnergyUnits];

    function normalizeLabel(value) {
        return String(value ?? '').trim().toLowerCase();
    }

    function isElectricityNode(label) {
        const name = normalizeLabel(label);

        return (
            name === 'electricity' ||
            name.includes('electricity') ||
            name.includes('electric power') ||
            name.includes('power grid')
        );
    }

    function isLossNode(label) {
        const name = normalizeLabel(label);

        return (
            name.includes('loss') ||
            name.includes('waste') ||
            name.includes('reject')
        );
    }

    function isWaterUnit(units) {
        const unit = String(units ?? '').trim().toLowerCase();

        return (
            unit === 'km3' ||
            unit.includes('gallon') ||
            unit.includes('acre') ||
            unit.includes('water')
        );
    }

    function parseColor(color) {
        if (!color) return [128, 128, 128];
        const hex = color.trim().replace(/^#/, '');
        if (hex.length === 6) {
            return [
                parseInt(hex.slice(0, 2), 16),
                parseInt(hex.slice(2, 4), 16),
                parseInt(hex.slice(4, 6), 16)
            ];
        }
        if (hex.length === 3) {
            return [
                parseInt(hex[0] + hex[0], 16),
                parseInt(hex[1] + hex[1], 16),
                parseInt(hex[2] + hex[2], 16)
            ];
        }
        const rgbMatch = color.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
        if (rgbMatch) {
            return [parseFloat(rgbMatch[1]), parseFloat(rgbMatch[2]), parseFloat(rgbMatch[3])];
        }
        return [128, 128, 128];
    }

    function colorWithAlpha(color, alpha = 0.35) {
        if (!color) return `rgba(0, 0, 0, ${alpha})`;

        const [r, g, b] = parseColor(color);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    function getEnergyWaterFlowType(row) {
        // A flow ending in losses is always gray.
        if (isLossNode(row.target)) {
            return 'losses';
        }

        // A flow originating from Electricity is yellow.
        if (isElectricityNode(row.source)) {
            return 'electricity';
        }

        // Any other EJ flow is orange Energy.
        if (String(row.units ?? '').trim() === 'EJ') {
            return 'energy';
        }

        // Water-unit flows are blue.
        if (isWaterUnit(row.units)) {
            return 'water';
        }

        return 'energy';
    }

    function getEnergyWaterNodeType(nodeLabel, data) {
        // Named categories always take precedence.
        if (isLossNode(nodeLabel)) {
            return 'losses';
        }

        if (isElectricityNode(nodeLabel)) {
            return 'electricity';
        }

        // Find all flows connected to this node.
        const connectedRows = data.filter(
            (row) => row.source === nodeLabel || row.target === nodeLabel
        );

        // Any non-electricity node associated with an EJ flow is Energy.
        if (connectedRows.some((row) => String(row.units ?? '').trim() === 'EJ')) {
            return 'energy';
        }

        // Nodes associated with water-unit flows are Water.
        if (connectedRows.some((row) => isWaterUnit(row.units))) {
            return 'water';
        }

        // Optional fallback if some water flows have unexpected/missing units.
        const nodeName = normalizeLabel(nodeLabel);

        if (
            nodeName.includes('water') ||
            nodeName.includes('withdraw') ||
            nodeName.includes('irrigation') 
        ) {
            return 'water';
        }

        // Default all otherwise unknown non-electricity nodes to energy.
        return 'energy';
    }

    function getLinkColor(row, palette) {
        // Any flow ending in losses uses the losses gray, regardless of palette.
        // (energy-water already handles this via getEnergyWaterFlowType.)
        if (palette !== 'energy-water' && isLossNode(row.target)) {
            return colorWithAlpha(energyWaterPalette.losses, 0.35);
        }

        switch (palette) {
            case 'energy-water':
                return energyWaterPalette[getEnergyWaterFlowType(row)];

            case 'data':
                // Edge color straight from the parquet (keyed by originating fuel).
                if (row.link_color) {
                    return colorWithAlpha(row.link_color, 0.35);
                }
                // No parquet edge color (e.g. non-Energy diagrams): fall back to interpolated.
                // falls through

            case 'interpolated':
            default:
                if (row.source_color && row.target_color) {
                    return interpolateRgba(
                        row.source_color,
                        row.target_color,
                        0.35
                    );
                }

                return row.link_color || 'rgba(0,0,0,0.2)';
        }
    }

    function interpolateRgba(sourceColor, targetColor, alpha = 0.35) {
        const s = parseColor(sourceColor);
        const t = parseColor(targetColor);
        const r = Math.round((s[0] + t[0]) / 2);
        const g = Math.round((s[1] + t[1]) / 2);
        const b = Math.round((s[2] + t[2]) / 2);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    function handleStateClick(event, code) {
        const isMulti = event.shiftKey || event.ctrlKey || event.metaKey;

        if (isMulti) {
            if (selectedStates.includes(code)) {
                selectedStates = selectedStates.filter(s => s !== code);
            } else {
                selectedStates = [...selectedStates, code];
            }
        } else {
            // Normal click: clicking already selected only state deselects it; otherwise select only this state
            if (selectedStates.length === 1 && selectedStates[0] === code) {
                selectedStates = [];
            } else {
                selectedStates = [code];
            }
        }
    }

    function selectAllStates() {
        const all = [];
        stateGrid.forEach(row => {
            row.forEach(cell => {
                if (cell) all.push(cell);
            });
        });
        selectedStates = all;
    }

    function clearStates() {
        // Keep at least one default selected
        selectedStates = ['WA'];
    }

    function resetLayout() {
        // Re-render
        if (activeData) {
            initializeHybridSankey(activeData, selectedSSP, selectedRCP, selectedClimate, selectedDiagram, selectedEnergyUnits, selectedWaterUnits, selectedStates, selectedDetailLevel, selectedColorPalette);
        }
    }

    function computeWaterFrameLayout(frameLabels, yearData) {
    let padPx = WATER_NODE_PAD_PX, res, best = null;
    for (let attempt = 0; attempt < 8; attempt++) {
        res = computeNodePositions(frameLabels, yearData, {
            strict: false,
            mirrorPlotlyHeights: true,
            padPx,
            plotHeightPx: PLOT_HEIGHT_PX,
            labelSepFrac: LABEL_LINE_PX / PLOT_HEIGHT_PX
        });
        if (res.overflow <= 0 && res.validation.valid) {
            best = { ...res, padPx };
            if (res.labelsFit) return best;
        }
        padPx *= 1.25; // larger pad -> smaller nodes -> more room for labels
    }
    if (best) {
        console.warn('Sankey: nodes do not overlap, but some labels may still be too close.');
        return best;
    }
    const msg = res.validation.violations.map(v => `${v.rule}: ${v.message}`).join('; ');
    throw new Error(`Layout could not be made overlap-free: ${msg || 'band overflow'}`);
}

    // Generate Sankey frames by year and scenario
    function generateSankeyFrames(data, selectedSSP, selectedRCP, selectedClimate, selectedDiagram, selectedEnergyUnits, selectedWaterUnits, currentSelectedStates, currentDetailLevel, selectedColorPalette) {
        let filteredData;
        if (selectedDiagram === 'Energy') {
            const stateSet = new Set(currentSelectedStates);
            // Levels 1-3 always include level 0, and level 0 is not a standalone option
            const matchingRows = data.filter(row => 
                stateSet.has(row.region) && 
                row.ssp === selectedSSP && 
                row.rcp === selectedRCP 
            );

            // Sum flows across multiple selected states.
            // Node colors come from the nodes parquet. In 'data' mode, edges are
            // additionally split by their parquet color so each fuel keeps its own band.
            const splitByColor = selectedColorPalette === 'data';
            const aggregatedMap = new Map();
            matchingRows.forEach(row => {
                const key = splitByColor
                    ? `${row.year}|||${row.source}|||${row.target}|||${row.color}`
                    : `${row.year}|||${row.source}|||${row.target}`;
                const val = parseFloat(row.value) || 0;
                if (!aggregatedMap.has(key)) {
                    aggregatedMap.set(key, {
                        year: row.year,
                        source: row.source,
                        target: row.target,
                        source_color: energyNodeTable?.get(row.source)?.color ?? null,
                        target_color: energyNodeTable?.get(row.target)?.color ?? null,
                        link_color: splitByColor ? (row.color ?? null) : null,
                        source_key: splitByColor ? (row.source_key ?? null) : null,
                        source_position: row.source_position,
                        target_position: row.target_position,
                        value: val,
                        units: row.units
                    });
                } else {
                    const existing = aggregatedMap.get(key);
                    existing.value += val;
                }
            });
            filteredData = Array.from(aggregatedMap.values());
        } else {
            const selectedUnitsList = [selectedEnergyUnits, selectedWaterUnits];
            filteredData = data.filter(row => (row.ssp === selectedSSP) && (row.rcp === selectedRCP) && (row.climate_sensitivity === selectedClimate) && (row.diagram === selectedDiagram) && (selectedUnitsList.includes(row.units)));
        }

        const years = [...new Set(filteredData.map(row => row.year))].sort((a, b) => a - b);
        const labels = new Set();
        const xCoords = [];
        const yCoords = [];
        const frames = [];

        // collect all unique labels
        filteredData.forEach(row => {
            labels.add(row.source);
            labels.add(row.target);
        });

        // One fixed layout for every frame -> no node drift during animation
        let nodeX, nodeY;
        let labelsArray;
        try {
            const layoutRes = selectedDiagram === 'Energy'
                ? computeEnergyLayout([...labels], filteredData, energyNodeTable, currentDetailLevel,
                    { padPx: NODE_PAD_PX, plotHeightPx: PLOT_HEIGHT_PX })
                : computeNodePositions([...labels], filteredData,
                    { strict: false, padPx: NODE_PAD_PX, plotHeightPx: PLOT_HEIGHT_PX });
            layoutWarnings = layoutRes.warnings ?? [];
            labelsArray = layoutRes.labels; // Use the canonical deterministically sorted label order!
            nodeX = layoutRes.x;
            nodeY = layoutRes.y;
            
            layoutErrorMessage = '';
        } catch (err) {
            console.error('Sankey layout error:', err);
            layoutErrorMessage = err.message || 'Layout constraint conflict detected.';
            return { frames: [], labels: [...labels] };
        }

        const energyWaterNodeColors = labelsArray.map((label) => {
            const nodeType = getEnergyWaterNodeType(label, filteredData);
            return energyWaterPalette[nodeType];
        });

        const finalNodeY = nodeY;

        const pos = new Map(labelsArray.map((l, i) => [l, { x: nodeX[i], y: finalNodeY[i], c: energyWaterNodeColors[i] }]));

        years.forEach(year => {
            const yearData = filteredData.filter(row => row.year === year && Number(row.value) > 0);
            const used = new Set(yearData.flatMap(row => [row.source, row.target]));
            const frameLabels = labelsArray.filter(l => used.has(l));
            const idx = new Map(frameLabels.map((l, i) => [l, i]));
            const frameLayout = selectedDiagram !== 'Energy'
                ? computeWaterFrameLayout(frameLabels, yearData)
                : null;
            const frameXY = frameLayout
                ? new Map(frameLayout.labels.map((l, i) => [l, { x: frameLayout.x[i], y: frameLayout.y[i] }]))
                : null;

            const sources = [];
            const targets = [];
            const values = [];
            const linkColors = [];
            const flowHoverLabels = [];
            const nodeColors = selectedColorPalette === 'energy-water'
                ? frameLabels.map(l => pos.get(l).c)
                : frameLabels.map(l =>
                    (selectedDiagram === 'Energy' ? energyNodeTable?.get(l)?.color : null) ?? null
                );

            yearData.forEach(row => {
                const sIdx = idx.get(row.source);
                const tIdx = idx.get(row.target);
                sources.push(sIdx);
                targets.push(tIdx);
                values.push(parseFloat(row.value));
                linkColors.push(getLinkColor(row, selectedColorPalette));
                if (selectedColorPalette === 'interpolated' ||
                    (selectedColorPalette === 'data' && selectedDiagram !== 'Energy')) {
                    if (row.source_color) nodeColors[sIdx] = row.source_color;
                    if (row.target_color) nodeColors[tIdx] = row.target_color;
                }
                flowHoverLabels.push([parseFloat(row.unit_value ?? row.value), row.source_key ?? '']);
            });

            frames.push({
                name: year,
                data: [{
                    type: "sankey",
                    arrangement: "perpendicular",
                    valueformat: '.3r',
                    orientation: "h",
                    node: {
                        pad: frameLayout ? frameLayout.padPx : NODE_PAD_PX,
                        thickness: 20,
                        line: { color: "black", width: 0.5 },
                        label: frameLabels,
                        hoverinfo: "none",
                        color: nodeColors,
                        x: frameLabels.map(l => (frameXY ? frameXY.get(l) : pos.get(l)).x),
                        y: frameLabels.map(l => (frameXY ? frameXY.get(l) : pos.get(l)).y)
                    },
                    link: {
                        source: sources,
                        target: targets,
                        value: values,
                        color: linkColors,
                        customdata: flowHoverLabels,
                        hovertemplate: selectedColorPalette === 'data'
                            ? "Source: %{source.label}<br>Fuel: %{customdata[1]}<br>Target: %{customdata[0]}<extra></extra>"
                            : "Source: %{source.label}<br>Target: %{customdata[0]}<extra></extra>"
                    }
                }]
            });
        });

        return { frames, labels: labelsArray };
    }

    async function loadParquetLevel(levelKey) {
        if (energyLevelDataCache[levelKey]) {
            return energyLevelDataCache[levelKey];
        }

        if (pendingLevelPromises[levelKey]) {
            return pendingLevelPromises[levelKey];
        }

        const fileName = `gcam_usa_energy_l${levelKey}.parquet`;

        pendingLevelPromises[levelKey] = (async () => {
            const response = await fetch(`${base}/${fileName}`);

            if (!response.ok) {
                throw new Error(`Failed to fetch parquet file (${fileName}): ${response.status}`);
            }

            const arrayBuffer = await response.arrayBuffer();
            let parsedRows = [];

            await parquetRead({
                file: arrayBuffer,
                rowFormat: 'object',
                onComplete: (data) => {
                    parsedRows = data;
                }
            });

            const processedRows = parsedRows
                .filter(
                    (r) =>
                        r.source &&
                        r.target &&
                        r.year != null &&
                        r.scenario &&
                        r.region
                )
                .map((r) => {
                    const rcpMatch = String(r.scenario).match(rcpRegex);
                    const sspMatch = String(r.scenario).match(sspRegex);
                    return {
                        ...r,
                        rcp: rcpMatch ? rcpMatch[0].toLowerCase() : null,
                        ssp: sspMatch ? sspMatch[0].toLowerCase() : null
                    };
                });

            energyLevelDataCache = {
                ...energyLevelDataCache,
                [levelKey]: processedRows
            };

            return processedRows;
        })().finally(() => {
            delete pendingLevelPromises[levelKey];
        });

        return pendingLevelPromises[levelKey];
    }

    async function loadGcamEnergyForDetailLevel(detailLevel) {
        const requiredLevels = ['0', String(detailLevel)];
        const needsFetch = !energyNodeTable || requiredLevels.some(lvl => !energyLevelDataCache[lvl]);

        if (needsFetch) {
            isLoadingEnergyData = true;
        }

        try {
            await Promise.all([
                ...requiredLevels.map(lvl => loadParquetLevel(lvl)),
                energyNodeTable
                    ? null
                    : fetchParquet('gcam_usa_energy_nodes.parquet').then(rows => { energyNodeTable = buildNodeTable(rows); })
            ]);

            // Merge level 0 plus the active detail level
            const l0Rows = energyLevelDataCache['0'] || [];
            const detailRows = energyLevelDataCache[String(detailLevel)] || [];
            gcamEnergyData = [...l0Rows, ...detailRows];
            loadedDetailLevel = String(detailLevel);
        } catch (error) {
            console.error('Error loading split GCAM energy parquet files:', error);
        } finally {
            isLoadingEnergyData = false;
        }
    }

    // Energy-water Sankey
    function initializeHybridSankey(data, selectedSSP, selectedRCP, selectedClimate, selectedDiagram, selectedEnergyUnits, selectedWaterUnits, currentSelectedStates, currentDetailLevel, selectedColorPalette) {
        const { frames, labels } = generateSankeyFrames(data, selectedSSP, selectedRCP, selectedClimate, selectedDiagram, selectedEnergyUnits, selectedWaterUnits, currentSelectedStates, currentDetailLevel, selectedColorPalette);
        if (!frames || frames.length === 0) return;

        let activeIndex = 0;
        if (currentSelectedYear != null) {
            const foundIndex = frames.findIndex(f => String(f.name) === String(currentSelectedYear));
            if (foundIndex !== -1) {
                activeIndex = foundIndex;
            }
        }
        currentSelectedYear = frames[activeIndex].name;
        const initialFrame = frames[activeIndex];

        const stateLabel = currentSelectedStates.length === 1 
            ? currentSelectedStates[0] 
            : `${currentSelectedStates.length} Selected States (${currentSelectedStates.join(', ')})`;

        const detailName = (detailLevels.find(d => d.value === currentDetailLevel) || {}).label || currentDetailLevel;
        
        const CONTROLS_Y = -0.01;  // paper units below the plot
        const MARGIN_B = 60;

        const layout = {
            autosize: true,
            height: PLOT_HEIGHT_PX + 100 + MARGIN_B,
            margin: { t: 100, b: MARGIN_B, l: 20, r: 20 },
            title: selectedDiagram === 'Energy' 
                ? `Energy Sankey Diagram for ${currentSelectedStates.length === 1 ? currentSelectedStates[0] : 'Selected Region'}` 
                : `${diagramMapping[selectedDiagram]} Sankey Diagram for the United States`,
            font: { size: 14 },
            sliders: [{
                steps: frames.map(frame => ({
                    method: "animate",
                    label: frame.name,
                    args: [[frame.name], {
                        mode: "next",
                        frame: { duration: 1200, redraw: true },
                        transition: {
                            duration: 600,
                            easing: "cubic-in-out"
                        }
                    }]
                })),
                active: activeIndex,

                // Place the bar in the lower margin.
                x: 0.1,
                xanchor: "left",
                len: .85,
                y: CONTROLS_Y,
                yanchor: "top",

                currentvalue: {
                    prefix: "Year: ",
                    font: { size: 16, color: "#666" }
                },
                pad: { t: 0, b: 0 }
            }],
            updatemenus: [{
                type: "buttons",
                active: -1,              // start paused, so the first click plays
                direction: "right",
                x: 0.07,
                xanchor: "right",
                y: CONTROLS_Y - .05,
                yanchor: "top",
                pad: { t: 0, r: 6 },
                buttons: [{
                    label: "▶ / ❚❚",
                    method: "animate",
                    // 1st click: play
                    args: [null, {
                        frame: { duration: 1200, redraw: true },
                        fromcurrent: true,
                        mode: "next",
                        transition: { duration: 600 }
                    }],
                    // 2nd click: pause
                    args2: [[null], {
                        mode: "immediate",
                        frame: { duration: 0, redraw: false },
                        transition: { duration: 0 }
                    }]
                }]
            }],
            annotations: [
                {
                    text: selectedDiagram === 'Energy'
                        ? `${rcpMapping[selectedRCP]} Fossil-fuel Emphasis & ${sspMapping[selectedSSP]} Population and Economic Growth Scenario | States: ${stateLabel} | Level of Detail: ${detailName}`
                        : `${rcpMapping[selectedRCP]} Fossil-fuel Emphasis & ${sspMapping[selectedSSP]} Population and Economic Growth Scenario`,
                    x: 0.5,
                    y: 1.05,
                    xref: "paper",
                    yref: "paper",
                    showarrow: false,
                    font: {
                        size: 14,
                        color: "gray"
                    },
                    align: "center"
                }
            ],
        };

        const thisRender = ++renderCounter;
        const targetElement = document.getElementById("hybridSankeyDiagram");
        if (!targetElement) return;

        Plotly.react(targetElement, initialFrame.data, layout, { responsive: true })
            .then(() => {
                if (thisRender === renderCounter) {
                    if (targetElement.on && !targetElement._hasSliderChangeListener) {
                        targetElement._hasSliderChangeListener = true;
                        targetElement.on('plotly_sliderchange', e => {
                            if (e && e.step && e.step.label != null) {
                                currentSelectedYear = e.step.label;
                            }
                        });
                    }

                    if (targetElement.on && !targetElement._hasPlayToggleListener) {
                        targetElement._hasPlayToggleListener = true;

                        // Animation finished (last year played, or slider jump): reset toggle to "paused"
                        targetElement.on('plotly_animated', () => {
                            Plotly.relayout(targetElement, {
                                'updatemenus[0].active': -1,
                                'updatemenus[0].buttons[0].label': '▶ Play'   // optional
                            });
                        });

                        // Optional: switch the label when the button is clicked
                        targetElement.on('plotly_buttonclicked', () => {
                            const playing = targetElement.layout.updatemenus[0].active === 0;
                            Plotly.relayout(targetElement, {
                                'updatemenus[0].buttons[0].label': playing ? '❚❚ Pause' : '▶ Play'
                            });
                        });
                    }

                    return Plotly.addFrames(targetElement, frames);
                }
            })
            .catch(err => {
                console.error("Plotly render error:", err);
            });
    }

    onMount(() => {
        fetch(`${base}/energy_water_data.csv`).then(response => {
            if (!response.ok) throw new Error("Network response was not ok");
            return response.text();
        }).then(
            d => Papa.parse(d, { header: true }).data
        ).then(d => {
            energywaterdata = d;
        }).catch(
            error => console.error("Error loading CSV file:", error)
        );
    });

    $: activeData = selectedDiagram === 'Energy' ? gcamEnergyData : energywaterdata;

    $: if (selectedDiagram === 'Energy') {
        const hasL0 = Boolean(energyLevelDataCache['0']);
        const hasDetail = Boolean(energyLevelDataCache[String(selectedDetailLevel)]);
        const hasNodeTable = Boolean(energyNodeTable);

        if (!hasL0 || !hasDetail || !hasNodeTable) {
            loadGcamEnergyForDetailLevel(selectedDetailLevel);
        } else if (gcamEnergyData !== undefined && loadedDetailLevel !== String(selectedDetailLevel)) {
            const l0Rows = energyLevelDataCache['0'] || [];
            const detailRows = energyLevelDataCache[String(selectedDetailLevel)] || [];

            gcamEnergyData = [...l0Rows, ...detailRows];
            loadedDetailLevel = String(selectedDetailLevel);
        }
    }

    $: if (
        activeData &&
        (
            selectedDiagram === 'Energy'
                ? (
                    energyNodeTable &&
                    selectedStates.length > 0 &&
                    selectedSSP &&
                    selectedRCP &&
                    selectedDetailLevel &&
                    loadedDetailLevel === String(selectedDetailLevel)
                )
                : (
                    selectedSSP &&
                    selectedRCP &&
                    selectedClimate &&
                    selectedDiagram &&
                    selectedEnergyUnits &&
                    selectedWaterUnits
                )
        )
    ) {
        initializeHybridSankey(
            activeData,
            selectedSSP,
            selectedRCP,
            selectedClimate,
            selectedDiagram,
            selectedEnergyUnits,
            selectedWaterUnits,
            selectedStates,
            selectedDetailLevel,
            selectedColorPalette
        );
    }

    function downloadCSV(data, selectedSSP, selectedRCP, selectedClimate, selectedDiagram, selectedEnergyUnits, selectedWaterUnits, currentSelectedStates, currentDetailLevel) {
        if (!data || !data.length) return;
        
        let filteredData;
        let columnsToDownload;

        if (selectedDiagram === 'Energy') {
            const stateSet = new Set(currentSelectedStates);
            filteredData = data.filter(row => 
                stateSet.has(row.region) &&
                row.ssp === selectedSSP &&
                row.rcp === selectedRCP &&
                (String(row.level) === '0' || String(row.level) === '0.0' || String(row.level) === String(currentDetailLevel))
            );
            columnsToDownload = ["scenario", "region", "year", "source", "target", "level", "units", "diagram", "value"];
        } else {
            const selectedUnitsList = [selectedEnergyUnits, selectedWaterUnits];
            filteredData = data.filter(row => (row.ssp === selectedSSP) && (row.rcp === selectedRCP) && (row.climate_sensitivity === selectedClimate) && (row.diagram === selectedDiagram) && (selectedUnitsList.includes(row.units)));
            columnsToDownload = ["rcp", 'ssp', "source", "target", "year", "unit_value", "units", "diagram"];
        }

        const selectedData = filteredData.map(item => {
            let filteredItem = {};
            columnsToDownload.forEach(key => {
                filteredItem[key] = item[key];
            });
            return filteredItem;
        });

        const csv = Papa.unparse(selectedData);
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", "sankey_data_download.csv");
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }
</script>

<div class="flex flex-row w-screen">

    <div id='scenarioSelectionBar'
    class="sticky top-0 flex h-full w-full max-w-[24rem] p-5 flex-col rounded-xl bg-white bg-clip-border text-gray-700 border-2 drop-shadow-xl overflow-y-auto max-h-screen">
    <div class="p-2 mb-2">
        <div class="flex items-center">
            <h5 class="block font-sans text-xl antialiased font-semibold leading-snug tracking-normal text-blue-gray-900">
            Scenario Selection 
            </h5>
        </div>
    </div>
    
    {#if selectedDiagram === 'Energy'}
        <div class="flex flex-col gap-2 mb-4 font-sans text-base font-normal text-blue-gray-700">
            <div class="flex items-center justify-between">
                <span class="font-semibold text-sm text-gray-700">Select States ({selectedStates.length}):</span>
                <div class="flex gap-2 text-xs">
                    <button type="button" on:click={selectAllStates} class="text-blue-600 hover:underline">All</button>
                    <span>|</span>
                    <button type="button" on:click={clearStates} class="text-blue-600 hover:underline">Reset</button>
                </div>
            </div>

            <!-- United States map click-box grid -->
            <div class="grid grid-cols-12 gap-1 p-2 bg-gray-50 border border-gray-200 rounded-lg select-none">
                {#each stateGrid as row}
                    {#each row as cell}
                        {#if cell}
                            <button
                                type="button"
                                class="h-6 text-[10px] font-bold rounded flex items-center justify-center transition-colors border {selectedStates.includes(cell) ? 'bg-blue-600 text-white border-blue-700 shadow-sm' : 'bg-white text-gray-700 border-gray-300 hover:bg-blue-100'}"
                                title={cell}
                                on:click={(event) => handleStateClick(event, cell)}>
                                {cell}
                            </button>
                        {:else}
                            <div class="h-6"></div>
                        {/if}
                    {/each}
                {/each}
            </div>
            <p class="text-xs text-gray-500 italic">Click a state to select/deselect. Shift-click or Ctrl-click to select multiple.</p>
        </div>

        <div class="flex flex-col gap-2 mb-6 font-sans text-base font-normal text-blue-gray-700">
            <span class="font-semibold text-sm text-gray-700">Level of Detail:</span>
            <div class="flex flex-row gap-4 pt-1">
                {#each detailLevels as lvl}
                    <div class="flex items-center gap-1">
                        <input type="radio" id={'detail-level-' + lvl.value} name="detailLevels" value={lvl.value} bind:group={selectedDetailLevel}/>
                        <label for={'detail-level-' + lvl.value}>{lvl.label}</label>
                    </div>
                {/each}
            </div>
        </div>
    {/if}

    <nav class="flex min-w-[240px] flex-col gap-3 mb-8 font-sans text-base font-normal text-blue-gray-700">
        <div role="contentinfo"
        class="flex items-center w-full p-3 leading-tight transition-all rounded-lg outline-none text-start hover:bg-blue-gray-50 hover:bg-opacity-80 hover:text-blue-gray-900 focus:bg-blue-gray-50 focus:bg-opacity-80 focus:text-blue-gray-900 active:bg-blue-gray-50 active:bg-opacity-80 active:text-blue-gray-900">
            <div class="grid mr-4 place-items-center">
                <Icon icon="tabler:building-factory" style="font-size: 30px" />
            </div>
            <div class="group flex relative">
                <span>Fossil-fuel Emphasis</span> 
            </div>
        </div>
        <div class="flex leading-normal pl-16 font-light h-6 bg-[#FFFFFF] items-center gap-8 text-[#000000]">
            <fieldset>
                <div class="flex flex-row gap-5">
                {#each rcps as r}
                <div>
                    <input type="radio" id={r} name="rcps" value={r} bind:group={selectedRCP}/>
                    <label for={r}>{rcpMapping[r]}</label>
                </div>
                {/each}
                </div>
            </fieldset>
        </div>

        <div role="contentinfo"
        class="flex items-center w-full p-3 leading-tight transition-all rounded-lg outline-none text-start hover:bg-blue-gray-50 hover:bg-opacity-80 hover:text-blue-gray-900 focus:bg-blue-gray-50 focus:bg-opacity-80 focus:text-blue-gray-900 active:bg-blue-gray-50 active:bg-opacity-80 active:text-blue-gray-900">
            <div class="grid mr-4 place-items-center">
                <Icon icon="ix:user-management" style="font-size: 30px" />
            </div>
            <div class="group flex relative">
                <span>Population & Economic Growth</span> 
            </div>
        </div>

        <div class="flex leading-normal pl-16 font-light h-6 bg-[#FFFFFF] items-center gap-8 text-[#000000]">
            <fieldset>
                <div class="flex flex-row gap-5">
                {#each ssps as s}
                <div>
                    <input type="radio" id={s} name="ssps" value={s} bind:group={selectedSSP}/>
                    <label for={s}>{sspMapping[s]}</label>
                </div>
                {/each}
                </div>
            </fieldset>
        </div>
    </nav>

    <div class="pt-9 ">
        <h5 class="block font-sans text-xl antialiased font-semibold tracking-normal text-blue-gray-900">
        Visualization Options
        </h5>
    </div>
    <nav class="flex min-w-[240px] flex-col font-sans text-base font-normal text-blue-gray-700">
        <button type="button"
        on:click={() => toggleSection('palette')}
        aria-expanded={expandedSections.palette}
        aria-controls="section-palette"
        class="flex items-center w-full p-3 leading-tight transition-all rounded-lg outline-none text-start cursor-pointer hover:bg-blue-gray-50 hover:bg-opacity-80 hover:text-blue-gray-900 focus:bg-blue-gray-50 focus:bg-opacity-80 focus:text-blue-gray-900 active:bg-blue-gray-50 active:bg-opacity-80 active:text-blue-gray-900">
            <div class="grid mr-4 place-items-center">
                <Icon icon="tabler:palette" style="font-size: 25px" />
            </div>
            <div class="flex flex-col items-start flex-1 min-w-0">
                <span>Color Palette</span>
                {#if !expandedSections.palette}
                    <span class="text-xs text-gray-500 truncate">{paletteLabel}</span>
                {/if}
            </div>
            <Icon icon={expandedSections.palette ? 'tabler:chevron-up' : 'tabler:chevron-down'} class="ml-auto text-lg" />
        </button>
        {#if expandedSections.palette}
        <div id="section-palette" transition:slide={{ duration: 200 }} class="flex leading-normal ml-8 pl-7 pb-2 font-light bg-[#FFFFFF] items-center gap-8 text-[#000000]">
            <fieldset class="flex flex-col gap-2 text-gray-800">
                {#each colorPalettes as palette}
                    <div class="flex items-center gap-2">
                        <input
                            type="radio"
                            id={'palette-' + palette.value}
                            name="colorPalette"
                            value={palette.value}
                            bind:group={selectedColorPalette}
                        />
                        <label for={'palette-' + palette.value}>{palette.label}</label>
                    </div>
                {/each}
            </fieldset>
        </div>
        {/if}
    </nav>

    <nav class="flex min-w-[240px] flex-col font-sans text-base font-normal text-blue-gray-700">
        <button type="button"
        on:click={() => toggleSection('flows')}
        aria-expanded={expandedSections.flows}
        aria-controls="section-flows"
        class="flex items-center w-full p-3 leading-tight transition-all rounded-lg outline-none text-start cursor-pointer hover:bg-blue-gray-50 hover:bg-opacity-80 hover:text-blue-gray-900 focus:bg-blue-gray-50 focus:bg-opacity-80 focus:text-blue-gray-900 active:bg-blue-gray-50 active:bg-opacity-80 active:text-blue-gray-900">
            <div class="grid mr-4 place-items-center">
                <Icon icon="tabler:mist" style="font-size: 25px" />
            </div>
            <div class="flex flex-col items-start flex-1 min-w-0">
                <span>Show flows for</span>
                {#if !expandedSections.flows}
                    <span class="text-xs text-gray-500 truncate">{diagramLabel}</span>
                {/if}
            </div>
            <Icon icon={expandedSections.flows ? 'tabler:chevron-up' : 'tabler:chevron-down'} class="ml-auto text-lg" />
        </button>

        {#if expandedSections.flows}
        <div id="section-flows" transition:slide={{ duration: 200 }} class="flex leading-normal ml-8 pl-7 pb-2 font-light bg-[#FFFFFF] items-center gap-8 text-[#000000]">
            <fieldset>
                <div class="flex flex-col gap-2">
                {#each diagrams as s}
                <div>
                    <input type="radio" id={s} name="diagram" value={s} bind:group={selectedDiagram}/>
                    <label for={s}>{s}</label>
                </div>
                {/each}
                </div>
            </fieldset>
        </div>
        {/if}
    </nav>

    <nav class="flex min-w-[240px] flex-col font-sans text-base font-normal text-blue-gray-700">
        <button type="button"
        on:click={() => toggleSection('waterUnits')}
        aria-expanded={expandedSections.waterUnits}
        aria-controls="section-waterUnits"
        class="flex items-center w-full p-3 leading-tight transition-all rounded-lg outline-none text-start cursor-pointer hover:bg-blue-gray-50 hover:bg-opacity-80 hover:text-blue-gray-900 focus:bg-blue-gray-50 focus:bg-opacity-80 focus:text-blue-gray-900 active:bg-blue-gray-50 active:bg-opacity-80 active:text-blue-gray-900">
            <div class="grid mr-4 place-items-center">
                <Icon icon="lets-icons:water" style="font-size: 25px" />
            </div>
            <div class="flex flex-col items-start flex-1 min-w-0">
                <span>Select Water Units</span>
                {#if !expandedSections.waterUnits}
                    <span class="text-xs text-gray-500 truncate">{waterUnitLabel}</span>
                {/if}
            </div>
            <Icon icon={expandedSections.waterUnits ? 'tabler:chevron-up' : 'tabler:chevron-down'} class="ml-auto text-lg" />
        </button>

        {#if expandedSections.waterUnits}
        <div id="section-waterUnits" transition:slide={{ duration: 200 }} class="flex leading-normal ml-8 pl-7 pb-2 font-light bg-[#FFFFFF] items-center gap-8 text-[#000000]">
            <fieldset>
                <div class="flex flex-col gap-2">
                {#each water_units as s}
                <div>
                    <input type="radio" id={s} name="waterUnits" value={s} bind:group={selectedWaterUnits}/>
                    <label for={s}>{waterUnitMapping[s]}</label>
                </div>
                {/each}
                </div>
            </fieldset>
        </div>
        {/if}
    </nav>
    
    <nav class="flex min-w-[240px] flex-col font-sans text-base font-normal text-blue-gray-700">
        <button type="button"
        on:click={() => toggleSection('energyUnits')}
        aria-expanded={expandedSections.energyUnits}
        aria-controls="section-energyUnits"
        class="flex items-center w-full p-3 leading-tight transition-all rounded-lg outline-none text-start cursor-pointer hover:bg-blue-gray-50 hover:bg-opacity-80 hover:text-blue-gray-900 focus:bg-blue-gray-50 focus:bg-opacity-80 focus:text-blue-gray-900 active:bg-blue-gray-50 active:bg-opacity-80 active:text-blue-gray-900">
            <div class="grid mr-4 place-items-center">
                <Icon icon="nimbus:fire" style="font-size: 25px" />
            </div>
            <div class="flex flex-col items-start flex-1 min-w-0">
                <span>Select Energy Units</span>
                {#if !expandedSections.energyUnits}
                    <span class="text-xs text-gray-500 truncate">{energyUnitLabel}</span>
                {/if}
            </div>
            <Icon icon={expandedSections.energyUnits ? 'tabler:chevron-up' : 'tabler:chevron-down'} class="ml-auto text-lg" />
        </button>

        {#if expandedSections.energyUnits}
        <div id="section-energyUnits" transition:slide={{ duration: 200 }} class="flex leading-normal ml-8 pl-7 pb-2 font-light bg-[#FFFFFF] items-center gap-8 text-[#000000]">
            <fieldset>
                <div class="flex flex-col gap-2">
                {#each energy_units as s}
                <div>
                    <input type="radio" id={s} name="energyUnits" value={s} bind:group={selectedEnergyUnits}/>
                    <label for={s}>{energyUnitMapping[s]}</label>
                </div>
                {/each}
                </div>
            </fieldset>
        </div>
        {/if}

        <div class="pt-6 flex flex-col gap-3">
            <button on:click={resetLayout} type="button" class="bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-300 font-semibold py-2 px-4 rounded inline-flex items-center justify-center">
                <Icon icon="tabler:restore" class="mr-2 text-lg" />
                <span>Reset Layout</span>
            </button>

            <button on:click={() => downloadCSV(activeData, selectedSSP, selectedRCP, selectedClimate, selectedDiagram, selectedEnergyUnits, selectedWaterUnits, selectedStates, selectedDetailLevel)} class="bg-gray-200 hover:bg-gray-400 text-gray-800 font-bold py-2 px-4 rounded inline-flex items-center">
                <svg class="fill-current w-4 h-4 mr-2" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M13 8V2H7v6H2l8 8 8-8h-5zM0 18h20v2H0v-2z"/></svg>
                <span>Download Selected Data</span>
            </button>
        </div>
    </nav>

    </div>

    <!-- Sankey placement -->
    <div id="sankeyWrapper" class="h-full w-full min-h-[800px] flex flex-col items-stretch flex-1 m-0 p-0">
        {#if layoutErrorMessage}
            <div class="m-8 p-6 bg-red-50 border border-red-300 rounded-lg text-red-800">
                <h3 class="text-lg font-bold mb-2">Layout Configuration Error</h3>
                <p class="mb-4">The selected filters produced conflicting semantic layout constraints:</p>
                <pre class="bg-white p-3 border border-red-200 rounded text-xs overflow-x-auto whitespace-pre-wrap">{layoutErrorMessage}</pre>
                <button on:click={resetLayout} class="mt-4 px-4 py-2 bg-red-600 text-white rounded font-medium hover:bg-red-700">
                    Retry Default Layout
                </button>
            </div>
        {:else if isLoadingEnergyData}
            <div class="flex items-center justify-center min-h-[800px]">
                <p class="text-xl text-gray-600">Loading Energy data...</p>
            </div>
        {/if}
        <div id="hybridSankeyDiagram"
     class="w-full min-h-[800px] m-0 p-0"
     class:invisible={isLoadingEnergyData || layoutErrorMessage}></div>    </div>

</div>
