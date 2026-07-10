(function (global) {
    'use strict';

    const A =
        global.DashboardAnalysis ||
        (typeof require === 'function' ? require('./analysis-core.js') : null);
    const COLORS = {
        cw: '#1463d6',
        ccw: '#d63b32',
        static: '#59636e',
        mean: '#111820',
        green: '#168a55',
        amber: '#b26b00',
        magenta: '#b6388c',
        cyan: '#087d9e',
        purple: '#6e56a6',
        grid: '#dce2e7',
        text: '#17202a',
        muted: '#66717d',
        opto: 'rgba(229, 60, 104, 0.13)',
        sham: 'rgba(90, 101, 114, 0.10)',
        visual: 'rgba(45, 146, 85, 0.08)'
    };

    const METRICS = ['turning', 'forward', 'heading'];
    const COURSE_AXIS_FLOORS = {
        turning: [-400, 400],
        forward: [-20, 20],
        heading: [-180, 180]
    };
    const POSITION_COLORS = {
        f: '#20262d',
        l45: '#1463d6',
        r45: '#d63b32',
        l90: '#087d9e',
        r90: '#b26b00'
    };

    function rgba(hex, alpha) {
        const value = hex.replace('#', '');
        const number = Number.parseInt(
            value.length === 3
                ? value
                      .split('')
                      .map((x) => x + x)
                      .join('')
                : value,
            16
        );
        return `rgba(${(number >> 16) & 255}, ${(number >> 8) & 255}, ${number & 255}, ${alpha})`;
    }

    function humanize(value) {
        return A.safeText(value)
            .replaceAll('_', ' ')
            .replace(/\b\w/g, (letter) => letter.toUpperCase());
    }

    function sourceLabel(run) {
        const d = run.descriptor;
        return `${d.folder || d.bench || 'unassigned rig'} | ${d.genotype} | ${d.sex} | fly ${d.flyNumber || '?'} | ${d.runId}`;
    }

    function traceCsvRows(curve, pageId, cellTitle, series, level, runId) {
        return curve.x.map((time, index) => ({
            plot: pageId,
            panel: cellTitle,
            series,
            level,
            run_id: runId || '',
            x: time,
            y: curve.y[index],
            sem: curve.sem ? curve.sem[index] : '',
            n: curve.n ? curve.n[index] : ''
        }));
    }

    function curveBundle(runs, predicate, metric, options) {
        const opts = options || {};
        const mode = opts.mode || 'single';
        const perRun = [];
        const trialCurves = [];
        let epochs = [];
        for (const run of runs) {
            const steps = run.steps.filter((step) => predicate(step, run));
            const curves = steps.map((step) =>
                A.trialSeries(run, step, metric, { hz: opts.hz || 10 })
            );
            if (!epochs.length && curves.length) epochs = curves[0].epochs;
            if (!curves.length) continue;
            trialCurves.push(...curves.map((curve) => ({ ...curve, run })));
            perRun.push({ run, curve: A.averageCurves(curves), trials: curves });
        }
        return {
            mode,
            epochs,
            perRun,
            trialCurves,
            group: perRun.length
                ? A.averageCurves(perRun.map((item) => item.curve))
                : { x: [], y: [], sem: [], n: [] }
        };
    }

    function epochShapes(epochs) {
        const shapes = [
            {
                type: 'line',
                x0: 0,
                x1: 0,
                y0: 0,
                y1: 1,
                line: { color: '#6f7a84', width: 1, dash: 'dot' }
            }
        ];
        for (const epoch of epochs) {
            if (!(epoch.endSec > epoch.startSec)) continue;
            if (epoch.type === 'opto' || epoch.type === 'sham') {
                shapes.push({
                    type: 'rect',
                    x0: epoch.startSec,
                    x1: epoch.endSec,
                    y0: 0,
                    y1: 1,
                    fillcolor: epoch.type === 'opto' ? COLORS.opto : COLORS.sham,
                    line: { width: 0 },
                    layer: 'below'
                });
            }
        }
        return shapes;
    }

    function timeSeriesCell(runs, metric, seriesDefs, options) {
        const opts = options || {};
        const traces = [];
        const csvRows = [];
        let shapes = [];
        seriesDefs.forEach((series, seriesIndex) => {
            const bundle = curveBundle(runs, series.predicate, metric, opts);
            if (!shapes.length && bundle.epochs.length) shapes = epochShapes(bundle.epochs);
            const color = series.color;
            const legend = opts.showLegend && seriesIndex === 0;

            if (opts.showIndividuals) {
                if (opts.mode === 'single') {
                    bundle.trialCurves.forEach((item, index) => {
                        traces.push({
                            type: 'scatter',
                            mode: 'lines',
                            x: item.x,
                            y: item.y,
                            name: `${series.name} trial ${index + 1}`,
                            legendgroup: series.name,
                            showlegend: false,
                            line: { color: rgba(color, 0.23), width: 1 },
                            hovertemplate: `${series.name}<br>trial ${index + 1}<br>t=%{x:.2f} s<br>%{y:.2f}<extra></extra>`
                        });
                        csvRows.push(
                            ...traceCsvRows(
                                item,
                                opts.pageId,
                                opts.cellTitle,
                                series.name,
                                'trial',
                                item.run.id
                            )
                        );
                    });
                } else {
                    bundle.perRun.forEach((item) => {
                        traces.push({
                            type: 'scatter',
                            mode: 'lines',
                            x: item.curve.x,
                            y: item.curve.y,
                            name: `${series.name} ${item.run.id}`,
                            legendgroup: series.name,
                            showlegend: false,
                            line: { color: rgba(color, 0.38), width: 1.4 },
                            text: sourceLabel(item.run),
                            hovertemplate: '%{text}<br>t=%{x:.2f} s<br>%{y:.2f}<extra></extra>'
                        });
                        csvRows.push(
                            ...traceCsvRows(
                                item.curve,
                                opts.pageId,
                                opts.cellTitle,
                                series.name,
                                'fly_mean',
                                item.run.id
                            )
                        );
                    });
                }
            }

            const summary =
                opts.mode === 'group' ? bundle.group : bundle.perRun[0] && bundle.perRun[0].curve;
            if (!summary || !summary.x.length) return;
            if (opts.mode === 'group' && summary.sem.some((value) => value > 0)) {
                traces.push({
                    type: 'scatter',
                    mode: 'lines',
                    x: summary.x,
                    y: summary.y.map((value, index) => value - summary.sem[index]),
                    line: { width: 0 },
                    hoverinfo: 'skip',
                    showlegend: false,
                    legendgroup: series.name
                });
                traces.push({
                    type: 'scatter',
                    mode: 'lines',
                    x: summary.x,
                    y: summary.y.map((value, index) => value + summary.sem[index]),
                    line: { width: 0 },
                    fill: 'tonexty',
                    fillcolor: rgba(color, 0.16),
                    hoverinfo: 'skip',
                    showlegend: false,
                    legendgroup: series.name
                });
            }
            traces.push({
                type: 'scatter',
                mode: 'lines',
                x: summary.x,
                y: summary.y,
                name: series.name,
                legendgroup: series.name,
                showlegend: opts.showLegend !== false,
                line: { color, width: 2.6, dash: series.dash || 'solid' },
                hovertemplate: `${series.name}<br>t=%{x:.2f} s<br>%{y:.2f}<extra></extra>`
            });
            csvRows.push(
                ...traceCsvRows(
                    summary,
                    opts.pageId,
                    opts.cellTitle,
                    series.name,
                    opts.mode === 'group' ? 'group_mean' : 'fly_mean',
                    opts.mode === 'group' ? 'all' : runs[0] && runs[0].id
                )
            );
        });
        return { traces, shapes, csvRows };
    }

    function niceAxisStep(span, targetTicks) {
        const raw = Math.max(Number.EPSILON, span) / (targetTicks || 6);
        const magnitude = 10 ** Math.floor(Math.log10(raw));
        const normalized = raw / magnitude;
        const multiplier =
            normalized <= 1
                ? 1
                : normalized <= 2
                  ? 2
                  : normalized <= 2.5
                    ? 2.5
                    : normalized <= 5
                      ? 5
                      : 10;
        return multiplier * magnitude;
    }

    function datasetSharedRange(cells, metric) {
        const values = [];
        for (const cell of cells) {
            for (const trace of cell.traces || []) {
                if (!Array.isArray(trace.y)) continue;
                values.push(...trace.y.filter(Number.isFinite));
            }
        }
        if (!values.length) return [-1, 1];
        const minimum = Math.min(0, ...values);
        const maximum = Math.max(0, ...values);
        const span = Math.max(
            maximum - minimum,
            Math.max(Math.abs(minimum), Math.abs(maximum), 1) * 0.1
        );
        const padding = span * 0.08;
        const paddedMinimum = minimum - padding;
        const paddedMaximum = maximum + padding;
        const step = niceAxisStep(paddedMaximum - paddedMinimum, 7);
        let lower = Math.floor(paddedMinimum / step) * step;
        let upper = Math.ceil(paddedMaximum / step) * step;
        if (!(upper > lower)) {
            lower = minimum - 1;
            upper = maximum + 1;
        }
        const floor = COURSE_AXIS_FLOORS[metric];
        if (floor) {
            lower = Math.min(lower, floor[0]);
            upper = Math.max(upper, floor[1]);
        }
        return [Number(lower.toPrecision(12)), Number(upper.toPrecision(12))];
    }

    function cartesianGrid(cells, rows, cols, options) {
        const opts = options || {};
        const traces = [];
        const layout = {
            paper_bgcolor: '#ffffff',
            plot_bgcolor: '#ffffff',
            font: { family: 'Inter, system-ui, sans-serif', color: COLORS.text, size: 11 },
            margin: { l: 64, r: 26, t: 54, b: 52 },
            height: opts.height || Math.max(360, rows * 190 + 100),
            showlegend: true,
            legend: { orientation: 'h', x: 0, y: 1.06, xanchor: 'left', yanchor: 'bottom' },
            annotations: [],
            shapes: [],
            hovermode: 'closest'
        };
        const gapX = cols > 1 ? 0.025 : 0;
        const gapY = rows > 1 ? 0.035 : 0;
        const sharedRange =
            opts.yRange || (opts.sharedY === false ? null : datasetSharedRange(cells, opts.metric));
        const legendNames = new Set();

        cells.forEach((cell, index) => {
            const row = Math.floor(index / cols);
            const col = index % cols;
            const axisIndex = index + 1;
            const suffix = axisIndex === 1 ? '' : String(axisIndex);
            const xName = `x${suffix}`;
            const yName = `y${suffix}`;
            const xKey = `xaxis${suffix}`;
            const yKey = `yaxis${suffix}`;
            const x0 = col / cols + gapX / 2;
            const x1 = (col + 1) / cols - gapX / 2;
            const y0 = 1 - (row + 1) / rows + gapY / 2;
            const y1 = 1 - row / rows - gapY / 2;
            layout[xKey] = {
                domain: [x0, x1],
                anchor: yName,
                showgrid: true,
                gridcolor: COLORS.grid,
                zeroline: true,
                zerolinecolor: '#b7c0c8',
                title:
                    row === rows - 1
                        ? { text: opts.xLabel || 'Time from stimulus onset (s)', standoff: 4 }
                        : undefined,
                tickfont: { size: 10 },
                range: opts.xRange
            };
            layout[yKey] = {
                domain: [y0, y1],
                anchor: xName,
                showgrid: true,
                gridcolor: COLORS.grid,
                zeroline: true,
                zerolinecolor: '#aeb8c1',
                title:
                    col === 0 && row === Math.floor(rows / 2)
                        ? { text: opts.yLabel || '', standoff: 5 }
                        : undefined,
                tickfont: { size: 10 },
                range: sharedRange
            };
            for (const trace of cell.traces || []) {
                const showlegend = trace.showlegend !== false && !legendNames.has(trace.name);
                if (showlegend) legendNames.add(trace.name);
                traces.push({ ...trace, xaxis: xName, yaxis: yName, showlegend });
            }
            for (const shape of cell.shapes || []) {
                const dataY = !!shape.dataY;
                const nextShape = {
                    ...shape,
                    xref: xName,
                    yref: dataY ? yName : `${yName} domain`
                };
                delete nextShape.dataY;
                layout.shapes.push(nextShape);
            }
            layout.annotations.push({
                x: (x0 + x1) / 2,
                y: y1 + 0.008,
                xref: 'paper',
                yref: 'paper',
                text: `<b>${cell.title}</b>`,
                showarrow: false,
                yanchor: 'bottom',
                font: { size: 11, color: COLORS.text }
            });
        });
        if (opts.extraShapes) layout.shapes.push(...opts.extraShapes);
        return { data: traces, layout };
    }

    function pageFromCells(id, title, description, cells, rows, cols, options) {
        const figure = cartesianGrid(cells, rows, cols, options);
        return {
            id,
            title,
            description,
            figure,
            csvRows: cells.flatMap((cell) => cell.csvRows || [])
        };
    }

    function pairedCell(runs, metric, seriesDefs, pageId, title, options) {
        const result = timeSeriesCell(runs, metric, seriesDefs, {
            ...options,
            pageId,
            cellTitle: title
        });
        return { title, ...result };
    }

    function p0TimePages(runs, options) {
        const pages = [];
        const levels = [
            'sham_pre',
            'level_1',
            'level_2',
            'level_3',
            'level_4',
            'level_5',
            'sham_post'
        ];
        for (const family of ['grating', 'bar']) {
            for (const metric of METRICS) {
                const pageId = `p0-${family}-${metric}`;
                const cells = levels.map((level) =>
                    pairedCell(
                        runs,
                        metric,
                        [
                            {
                                name: 'CW',
                                color: COLORS.cw,
                                predicate: (step) => step.condition === `${family}_cw_${level}`
                            },
                            {
                                name: 'CCW',
                                color: COLORS.ccw,
                                predicate: (step) => step.condition === `${family}_ccw_${level}`
                            }
                        ],
                        pageId,
                        humanize(level),
                        options
                    )
                );
                pages.push(
                    pageFromCells(
                        pageId,
                        `p0 ${humanize(family)}: ${A.metricLabel(metric)}`,
                        'Trials are aligned to LED or sham onset. CW and CCW remain signed and are shown separately.',
                        cells,
                        levels.length,
                        1,
                        { metric, yLabel: A.metricLabel(metric), height: 1180 }
                    )
                );
            }
        }
        return pages;
    }

    function summarySeries(runs, pointsForRun, seriesDefs, options) {
        const traces = [];
        const csvRows = [];
        for (const series of seriesDefs) {
            const perRun = runs
                .map((run) => ({ run, points: pointsForRun(run, series) }))
                .filter((item) => item.points.length);
            if (options.showIndividuals) {
                perRun.forEach((item) => {
                    traces.push({
                        type: 'scatter',
                        mode: 'lines+markers',
                        x: item.points.map((point) => point.x),
                        y: item.points.map((point) => point.y),
                        name: `${series.name} ${item.run.id}`,
                        showlegend: false,
                        legendgroup: series.name,
                        line: {
                            color: rgba(series.color, options.mode === 'single' ? 0.4 : 0.3),
                            width: 1
                        },
                        marker: { color: rgba(series.color, 0.5), size: 5 },
                        text: sourceLabel(item.run),
                        hovertemplate: '%{text}<br>x=%{x}<br>%{y:.2f}<extra></extra>'
                    });
                    item.points.forEach((point) =>
                        csvRows.push({
                            series: series.name,
                            level: 'fly_mean',
                            run_id: item.run.id,
                            x: point.x,
                            y: point.y
                        })
                    );
                });
            }
            const xValues = [
                ...new Set(perRun.flatMap((item) => item.points.map((point) => point.x)))
            ].sort((a, b) => a - b);
            const y = xValues.map((x) =>
                A.mean(
                    perRun.map((item) => {
                        const point = item.points.find((candidate) => candidate.x === x);
                        return point ? point.y : NaN;
                    })
                )
            );
            const errors = xValues.map((x) =>
                A.sem(
                    perRun.map((item) => {
                        const point = item.points.find((candidate) => candidate.x === x);
                        return point ? point.y : NaN;
                    })
                )
            );
            traces.push({
                type: 'scatter',
                mode: 'lines+markers',
                x: xValues,
                y,
                name: series.name,
                legendgroup: series.name,
                line: { color: series.color, width: 2.6, dash: series.dash || 'solid' },
                marker: { color: series.color, size: 7, symbol: series.symbol || 'circle' },
                error_y:
                    options.mode === 'group'
                        ? { type: 'data', array: errors, visible: true, color: series.color }
                        : undefined,
                hovertemplate: `${series.name}<br>x=%{x}<br>%{y:.2f}<extra></extra>`
            });
            xValues.forEach((x, index) =>
                csvRows.push({
                    series: series.name,
                    level: options.mode === 'group' ? 'group_mean' : 'fly_mean',
                    run_id: options.mode === 'group' ? 'all' : runs[0] && runs[0].id,
                    x,
                    y: y[index],
                    sem: errors[index],
                    n: perRun.length
                })
            );
        }
        return { traces, csvRows };
    }

    function p0DosePage(runs, options) {
        const levelNumber = (condition) => {
            if (condition.endsWith('sham_pre')) return 0;
            if (condition.endsWith('sham_post')) return 6;
            const match = condition.match(/level_(\d+)/);
            return match ? Number(match[1]) : NaN;
        };
        const cells = ['grating', 'bar'].map((family) => {
            const result = summarySeries(
                runs,
                (run, series) => {
                    const grouped = new Map();
                    for (const step of run.steps.filter((candidate) =>
                        candidate.condition.startsWith(`${family}_${series.key}_`)
                    )) {
                        const x = levelNumber(step.condition);
                        if (!Number.isFinite(x)) continue;
                        if (!grouped.has(x)) grouped.set(x, []);
                        grouped.get(x).push(A.stepMean(run, step, 'turning', 0, 1));
                    }
                    return [...grouped.entries()]
                        .map(([x, values]) => ({ x, y: A.mean(values) }))
                        .sort((a, b) => a.x - b.x);
                },
                [
                    { name: 'CW', key: 'cw', color: COLORS.cw },
                    { name: 'CCW', key: 'ccw', color: COLORS.ccw }
                ],
                options
            );
            return {
                title: humanize(family),
                traces: result.traces,
                shapes: [],
                csvRows: result.csvRows
            };
        });
        return pageFromCells(
            'p0-dose-response',
            'p0 LED dose response',
            'Mean signed turning during the 1 s LED or sham epoch. Trials are averaged within fly before the genotype mean.',
            cells,
            1,
            2,
            {
                xLabel: 'LED level (0=pre sham, 6=post sham)',
                yLabel: 'Turning velocity (deg/s)',
                metric: 'turning',
                height: 430
            }
        );
    }

    function p1OptomotorPages(runs, options) {
        const pages = [];
        const periods = [36, 72];
        const frequencies = [0, 1, 2, 4, 8, 16];
        for (const metric of METRICS) {
            const pageId = `p1-optomotor-${metric}`;
            const cells = [];
            periods.forEach((period) =>
                frequencies.forEach((frequency) => {
                    const series =
                        frequency === 0
                            ? [
                                  {
                                      name: 'Static',
                                      color: COLORS.static,
                                      predicate: (step) =>
                                          step.condition === `om_${period}deg_static_0hz`
                                  }
                              ]
                            : [
                                  {
                                      name: 'CW',
                                      color: COLORS.cw,
                                      predicate: (step) =>
                                          step.condition === `om_${period}deg_cw_${frequency}hz`
                                  },
                                  {
                                      name: 'CCW',
                                      color: COLORS.ccw,
                                      predicate: (step) =>
                                          step.condition === `om_${period}deg_ccw_${frequency}hz`
                                  }
                              ];
                    cells.push(
                        pairedCell(
                            runs,
                            metric,
                            series,
                            pageId,
                            `${period} deg | ${frequency} Hz`,
                            options
                        )
                    );
                })
            );
            pages.push(
                pageFromCells(
                    pageId,
                    `p1 Optomotor: ${A.metricLabel(metric)}`,
                    'Rows are spatial period; columns are temporal frequency. Motion directions remain separate.',
                    cells,
                    periods.length,
                    frequencies.length,
                    { metric, yLabel: A.metricLabel(metric), height: 570 }
                )
            );
        }
        return pages;
    }

    function p1LoomPages(runs, options) {
        const pages = [];
        const classes = ['disc', 'ann', 'dots'];
        const speeds = ['fast', 'slow'];
        const positions = ['f', 'l45', 'r45', 'l90', 'r90'];
        for (const metric of METRICS) {
            const pageId = `p1-loom-${metric}`;
            const cells = [];
            classes.forEach((stimClass) =>
                speeds.forEach((speed) => {
                    const series = positions.map((position) => ({
                        name: position.toUpperCase(),
                        color: POSITION_COLORS[position],
                        predicate: (step) =>
                            step.condition === `loom_${stimClass}_${position}_${speed}`
                    }));
                    cells.push(
                        pairedCell(
                            runs,
                            metric,
                            series,
                            pageId,
                            `${humanize(stimClass)} | ${humanize(speed)}`,
                            options
                        )
                    );
                })
            );
            pages.push(
                pageFromCells(
                    pageId,
                    `p1 Looming: ${A.metricLabel(metric)}`,
                    'Rows are loom stimulus class; columns are loom speed. Positions remain separate and signed.',
                    cells,
                    classes.length,
                    speeds.length,
                    { metric, yLabel: A.metricLabel(metric), height: 760 }
                )
            );
        }
        return pages;
    }

    function p1TuningPage(runs, options) {
        const cells = [36, 72].map((period) => {
            const result = summarySeries(
                runs,
                (run, series) =>
                    [0, 1, 2, 4, 8, 16]
                        .map((frequency) => {
                            const direction = frequency === 0 ? 'static' : series.key;
                            const steps = run.steps.filter(
                                (step) =>
                                    step.condition === `om_${period}deg_${direction}_${frequency}hz`
                            );
                            return {
                                x: frequency,
                                y: A.mean(
                                    steps.map((step) => A.stepMean(run, step, 'turning', 0, 2))
                                )
                            };
                        })
                        .filter((point) => Number.isFinite(point.y)),
                [
                    { name: 'CW', key: 'cw', color: COLORS.cw },
                    { name: 'CCW', key: 'ccw', color: COLORS.ccw }
                ],
                options
            );
            return {
                title: `${period} deg spatial period`,
                traces: result.traces,
                shapes: [],
                csvRows: result.csvRows
            };
        });
        return pageFromCells(
            'p1-optomotor-tuning',
            'p1 Optomotor tuning',
            'Signed mean turning during visual motion. Static 0 Hz is shown in both directional series as the common control.',
            cells,
            1,
            2,
            {
                xLabel: 'Temporal frequency (Hz)',
                yLabel: 'Turning velocity (deg/s)',
                metric: 'turning',
                height: 430
            }
        );
    }

    function p2Phase(step) {
        if (step.condition.startsWith('burst_')) return 'opto';
        return step.epochs.some((epoch) => epoch.type === 'opto') ? 'opto' : 'baseline';
    }

    function p2SweepPages(runs, options) {
        const pages = [];
        const phases = ['baseline', 'opto'];
        const speeds = [36, 72, 144];
        for (const metric of ['turning', 'forward', 'heading']) {
            const pageId = `p2-sweep-${metric}`;
            const cells = [];
            phases.forEach((phase) =>
                speeds.forEach((speed) => {
                    const series = [
                        {
                            name: 'CW',
                            color: COLORS.cw,
                            predicate: (step) =>
                                /^(?:burst_)?sw_/.test(step.condition) &&
                                step.condition.includes(`_${speed}_cw`) &&
                                p2Phase(step) === phase
                        },
                        {
                            name: 'CCW',
                            color: COLORS.ccw,
                            predicate: (step) =>
                                /^(?:burst_)?sw_/.test(step.condition) &&
                                step.condition.includes(`_${speed}_ccw`) &&
                                p2Phase(step) === phase
                        }
                    ];
                    cells.push(
                        pairedCell(
                            runs,
                            metric,
                            series,
                            pageId,
                            `${humanize(phase)} | ${speed} deg/s`,
                            options
                        )
                    );
                })
            );
            pages.push(
                pageFromCells(
                    pageId,
                    `p2 Object sweeps: ${A.metricLabel(metric)}`,
                    'Rows separate baseline and optogenetic phases; columns progress from slow to fast. CW and CCW remain signed.',
                    cells,
                    phases.length,
                    speeds.length,
                    { metric, yLabel: A.metricLabel(metric), height: 570 }
                )
            );
        }
        return pages;
    }

    function p2FixationPages(runs, options) {
        const pages = [];
        const conditions = [
            { title: 'Baseline bar', predicate: (step) => step.condition === 'base_bar' },
            {
                title: 'Optogenetic bar',
                predicate: (step) => /^(burst_)?cl_bar$/.test(step.condition)
            }
        ];
        for (const metric of ['turning', 'forward', 'displayIndex']) {
            const pageId = `p2-fixation-${metric}`;
            const cells = conditions.map((condition) =>
                pairedCell(
                    runs,
                    metric,
                    [
                        {
                            name: condition.title,
                            color: metric === 'displayIndex' ? COLORS.purple : COLORS.green,
                            predicate: condition.predicate
                        }
                    ],
                    pageId,
                    condition.title,
                    options
                )
            );
            pages.push(
                pageFromCells(
                    pageId,
                    `p2 Fixation: ${A.metricLabel(metric)}`,
                    'Closed-loop trials are kept as time series so tracking stability and drift remain visible.',
                    cells,
                    conditions.length,
                    1,
                    { metric, yLabel: A.metricLabel(metric), height: 560 }
                )
            );
        }
        return pages;
    }

    function circularSmooth(values, width) {
        const out = [];
        const count = Math.max(1, Math.floor(width));
        const left = Math.floor((count - 1) / 2);
        for (let i = 0; i < values.length; i += 1) {
            const window = [];
            for (let offset = 0; offset < count; offset += 1)
                window.push(values[A.mod(i + offset - left, values.length)]);
            out.push(A.mean(window));
        }
        return out;
    }

    function occupancyBundle(runs, object, side, options) {
        const perRun = [];
        const trials = [];
        for (const run of runs) {
            const curves = run.steps
                .filter((step) => {
                    const info = A.choiceInfo(step.condition);
                    return info && info.object === object && info.side === side;
                })
                .map((step) => {
                    const hist = A.occupancyHistogram(A.choiceAngles(run, step, 2), 100);
                    return {
                        x: hist.angle,
                        y: circularSmooth(hist.percent, 4),
                        stepIndex: step.index,
                        run
                    };
                });
            if (!curves.length) continue;
            trials.push(...curves);
            perRun.push({ run, curve: A.averageCurves(curves), trials: curves });
        }
        return {
            trials,
            perRun,
            group: perRun.length
                ? A.averageCurves(perRun.map((item) => item.curve))
                : { x: [], y: [], sem: [], n: [] }
        };
    }

    function occupancyCell(runs, object, options) {
        const traces = [];
        const csvRows = [];
        [
            { side: 'l', name: 'Left-handed', color: COLORS.cw, dash: 'dash' },
            { side: 'r', name: 'Right-handed', color: COLORS.ccw, dash: 'solid' }
        ].forEach((series) => {
            const bundle = occupancyBundle(runs, object, series.side, options);
            if (options.showIndividuals) {
                const items =
                    options.mode === 'single'
                        ? bundle.trials.map((curve) => ({ run: curve.run, curve, level: 'trial' }))
                        : bundle.perRun.map((item) => ({
                              run: item.run,
                              curve: item.curve,
                              level: 'fly_mean'
                          }));
                items.forEach((item) => {
                    traces.push({
                        type: 'scatter',
                        mode: 'lines',
                        x: item.curve.x,
                        y: item.curve.y,
                        name: `${series.name} ${item.run.id}`,
                        showlegend: false,
                        legendgroup: series.name,
                        line: { color: rgba(series.color, 0.3), width: 1, dash: series.dash },
                        text: sourceLabel(item.run),
                        hovertemplate: '%{text}<br>%{x:.0f} deg<br>%{y:.2f}%<extra></extra>'
                    });
                    csvRows.push(
                        ...traceCsvRows(
                            item.curve,
                            `p2-occupancy`,
                            humanize(object),
                            series.name,
                            item.level,
                            item.run.id
                        )
                    );
                });
            }
            const summary =
                options.mode === 'group'
                    ? bundle.group
                    : bundle.perRun[0] && bundle.perRun[0].curve;
            if (!summary || !summary.x.length) return;
            traces.push({
                type: 'scatter',
                mode: 'lines',
                x: summary.x,
                y: summary.y,
                name: series.name,
                legendgroup: series.name,
                line: { color: series.color, width: 2.4, dash: series.dash },
                hovertemplate: `${series.name}<br>%{x:.0f} deg<br>%{y:.2f}%<extra></extra>`
            });
            csvRows.push(
                ...traceCsvRows(
                    summary,
                    `p2-occupancy`,
                    humanize(object),
                    series.name,
                    options.mode === 'group' ? 'group_mean' : 'fly_mean',
                    options.mode === 'group' ? 'all' : runs[0] && runs[0].id
                )
            );
        });
        const shapes = [
            {
                type: 'line',
                x0: -180,
                x1: -180,
                y0: 0,
                y1: 1,
                line: { color: COLORS.text, width: 1 }
            },
            {
                type: 'line',
                x0: -90,
                x1: -90,
                y0: 0,
                y1: 1,
                line: { color: COLORS.magenta, width: 1, dash: 'dot' }
            },
            { type: 'line', x0: 0, x1: 0, y0: 0, y1: 1, line: { color: COLORS.text, width: 1 } },
            {
                type: 'line',
                x0: 90,
                x1: 90,
                y0: 0,
                y1: 1,
                line: { color: COLORS.magenta, width: 1, dash: 'dot' }
            },
            {
                type: 'line',
                x0: -180,
                x1: 180,
                y0: 1,
                y1: 1,
                dataY: true,
                line: { color: COLORS.amber, width: 1, dash: 'dash' }
            }
        ];
        return { title: humanize(object), traces, shapes, csvRows };
    }

    function p2OccupancyPage(runs, options) {
        const objects = ['small', 'bpole', 'bright', 'dark', 'edge', 'peak'];
        const cells = objects.map((object) => occupancyCell(runs, object, options));
        const maxY =
            Math.max(
                3,
                ...cells.flatMap((cell) =>
                    cell.traces.flatMap((trace) =>
                        Array.isArray(trace.y) ? trace.y.filter(Number.isFinite) : []
                    )
                )
            ) * 1.08;
        return pageFromCells(
            'p2-occupancy',
            'p2 Object-choice occupancy',
            'Full 360 degree reference-aligned occupancy. Black/reference objects are at 0 and 180 deg; paired objects are at +/-90 deg; chance is 1% per bin.',
            cells,
            2,
            3,
            {
                xLabel: 'Reference-aligned angle (deg)',
                yLabel: 'Occupancy (%)',
                yRange: [0, maxY],
                xRange: [-180, 180],
                sharedY: true,
                height: 660
            }
        );
    }

    function polarGrid(cells) {
        const traces = [];
        const layout = {
            paper_bgcolor: '#ffffff',
            plot_bgcolor: '#ffffff',
            font: { family: 'Inter, system-ui, sans-serif', color: COLORS.text, size: 11 },
            margin: { l: 30, r: 30, t: 62, b: 34 },
            height: 760,
            showlegend: true,
            legend: { orientation: 'h', x: 0, y: 1.04 },
            annotations: []
        };
        const rows = 2;
        const cols = 3;
        const maxR =
            Math.max(
                3,
                ...cells.flatMap((cell) =>
                    cell.traces.flatMap((trace) =>
                        Array.isArray(trace.y) ? trace.y.filter(Number.isFinite) : []
                    )
                )
            ) * 1.08;
        const legendNames = new Set();
        cells.forEach((cell, index) => {
            const row = Math.floor(index / cols);
            const col = index % cols;
            const suffix = index === 0 ? '' : String(index + 1);
            const subplot = `polar${suffix}`;
            const x0 = col / cols + 0.025;
            const x1 = (col + 1) / cols - 0.025;
            const y0 = 1 - (row + 1) / rows + 0.07;
            const y1 = 1 - row / rows - 0.07;
            layout[subplot] = {
                domain: { x: [x0, x1], y: [y0, y1] },
                bgcolor: '#ffffff',
                angularaxis: {
                    rotation: 90,
                    direction: 'counterclockwise',
                    tickmode: 'array',
                    tickvals: [0, 90, 180, 270],
                    ticktext: ['reference', 'paired', 'reference', 'paired'],
                    gridcolor: COLORS.grid
                },
                radialaxis: {
                    range: [0, maxR],
                    gridcolor: COLORS.grid,
                    angle: 45,
                    tickfont: { size: 9 }
                }
            };
            cell.traces.forEach((trace) => {
                const showlegend = trace.showlegend !== false && !legendNames.has(trace.name);
                if (showlegend) legendNames.add(trace.name);
                traces.push({
                    ...trace,
                    type: 'scatterpolar',
                    subplot,
                    theta: trace.x,
                    r: trace.y,
                    x: undefined,
                    y: undefined,
                    showlegend,
                    hovertemplate: trace.hovertemplate
                        ? trace.hovertemplate
                              .replace('%{x:.0f}', '%{theta:.0f}')
                              .replace('%{y:.2f}', '%{r:.2f}')
                        : undefined
                });
            });
            layout.annotations.push({
                x: (x0 + x1) / 2,
                y: y1 + 0.032,
                xref: 'paper',
                yref: 'paper',
                text: `<b>${cell.title}</b>`,
                showarrow: false,
                yanchor: 'bottom'
            });
        });
        return { data: traces, layout };
    }

    function p2PolarPage(runs, options) {
        const objects = ['small', 'bpole', 'bright', 'dark', 'edge', 'peak'];
        const cells = objects.map((object) => occupancyCell(runs, object, options));
        return {
            id: 'p2-polar',
            title: 'p2 Polar object-choice occupancy',
            description:
                'The selected reference direction is up; paired objects are left and right; the second reference direction is down.',
            figure: polarGrid(cells),
            csvRows: cells.flatMap((cell) => cell.csvRows)
        };
    }

    function p2PreferencePage(runs, options) {
        const objects = ['small', 'bpole', 'bright', 'dark', 'edge', 'peak'];
        const traces = [];
        const csvRows = [];
        const sides = [
            { key: 'l', name: 'Left-handed', color: COLORS.cw, symbol: 'circle-open' },
            { key: 'r', name: 'Right-handed', color: COLORS.ccw, symbol: 'circle' }
        ];
        for (const side of sides) {
            const perRun = runs.map((run) => ({
                run,
                values: objects.map((object) => {
                    const metrics = run.steps
                        .filter((step) => {
                            const info = A.choiceInfo(step.condition);
                            return info && info.object === object && info.side === side.key;
                        })
                        .map((step) => A.preferenceMetrics(A.choiceAngles(run, step, 2)).harmonic);
                    return A.mean(metrics);
                })
            }));
            if (options.showIndividuals) {
                perRun.forEach((item) => {
                    traces.push({
                        type: 'scatter',
                        mode: 'markers+lines',
                        x: objects.map(humanize),
                        y: item.values,
                        name: `${side.name} ${item.run.id}`,
                        showlegend: false,
                        legendgroup: side.name,
                        line: { color: rgba(side.color, 0.18), width: 1 },
                        marker: { color: rgba(side.color, 0.65), symbol: side.symbol, size: 7 },
                        text: sourceLabel(item.run),
                        hovertemplate: '%{text}<br>%{x}<br>preference=%{y:.3f}<extra></extra>'
                    });
                    objects.forEach((object, index) =>
                        csvRows.push({
                            plot: 'p2-preference',
                            object,
                            side: side.key,
                            level: 'fly_mean',
                            run_id: item.run.id,
                            preference: item.values[index]
                        })
                    );
                });
            }
            const means = objects.map((_, index) =>
                A.mean(perRun.map((item) => item.values[index]))
            );
            const errors = objects.map((_, index) =>
                A.sem(perRun.map((item) => item.values[index]))
            );
            traces.push({
                type: 'scatter',
                mode: 'markers+lines',
                x: objects.map(humanize),
                y: means,
                name: side.name,
                legendgroup: side.name,
                line: { color: side.color, width: 2.4 },
                marker: { color: side.color, symbol: side.symbol, size: 9 },
                error_y:
                    options.mode === 'group'
                        ? { type: 'data', array: errors, visible: true, color: side.color }
                        : undefined,
                hovertemplate: `${side.name}<br>%{x}<br>preference=%{y:.3f}<extra></extra>`
            });
            objects.forEach((object, index) =>
                csvRows.push({
                    plot: 'p2-preference',
                    object,
                    side: side.key,
                    level: options.mode === 'group' ? 'group_mean' : 'fly_mean',
                    run_id: options.mode === 'group' ? 'all' : runs[0] && runs[0].id,
                    preference: means[index],
                    sem: errors[index],
                    n: perRun.length
                })
            );
        }
        return {
            id: 'p2-preference',
            title: 'p2 Object-choice preference',
            description:
                'Harmonic score from unsmoothed samples: +1 favors the selected reference pair, -1 favors the paired/opposite objects. Open markers are left-handed patterns.',
            figure: {
                data: traces,
                layout: {
                    paper_bgcolor: '#ffffff',
                    plot_bgcolor: '#ffffff',
                    font: { family: 'Inter, system-ui, sans-serif', color: COLORS.text },
                    margin: { l: 70, r: 30, t: 35, b: 70 },
                    height: 510,
                    hovermode: 'closest',
                    legend: { orientation: 'h', x: 0, y: 1.06 },
                    xaxis: { title: 'Object comparison', gridcolor: COLORS.grid },
                    yaxis: {
                        title: 'Reference-pair preference',
                        range: [-1.05, 1.05],
                        gridcolor: COLORS.grid,
                        zerolinecolor: '#8f99a3'
                    }
                }
            },
            csvRows
        };
    }

    function genericPages(runs, options) {
        const conditions = [
            ...new Set(runs.flatMap((run) => run.steps.map((step) => step.condition)))
        ]
            .filter((condition) => !/^(start|shutdown|opto_on)/.test(condition))
            .sort()
            .slice(0, 24);
        return METRICS.map((metric) => {
            const pageId = `generic-${metric}`;
            const cells = conditions.map((condition) =>
                pairedCell(
                    runs,
                    metric,
                    [
                        {
                            name: humanize(condition),
                            color: COLORS.cw,
                            predicate: (step) => step.condition === condition
                        }
                    ],
                    pageId,
                    humanize(condition),
                    { ...options, showLegend: false }
                )
            );
            const cols = conditions.length > 8 ? 2 : 1;
            const rows = Math.max(1, Math.ceil(cells.length / cols));
            return pageFromCells(
                pageId,
                `Trial browser: ${A.metricLabel(metric)}`,
                'Generic condition-aligned view for protocols without a specialized adapter.',
                cells,
                rows,
                cols,
                { metric, yLabel: A.metricLabel(metric), height: Math.max(450, rows * 190 + 100) }
            );
        });
    }

    function buildPages(runs, options) {
        if (!runs.length) return [];
        const opts = { mode: 'single', showIndividuals: true, ...options };
        const families = [...new Set(runs.map((run) => run.protocolInfo.family))];
        if (families.length !== 1) return genericPages(runs, opts);
        if (families[0] === 'p0') return [...p0TimePages(runs, opts), p0DosePage(runs, opts)];
        if (families[0] === 'p1')
            return [
                ...p1OptomotorPages(runs, opts),
                ...p1LoomPages(runs, opts),
                p1TuningPage(runs, opts)
            ];
        if (families[0] === 'p2-tonic' || families[0] === 'p2-burst') {
            return [
                ...p2SweepPages(runs, opts),
                ...p2FixationPages(runs, opts),
                p2OccupancyPage(runs, opts),
                p2PolarPage(runs, opts),
                p2PreferencePage(runs, opts)
            ];
        }
        return genericPages(runs, opts);
    }

    const DashboardPlots = {
        COLORS,
        METRICS,
        COURSE_AXIS_FLOORS,
        buildPages,
        cartesianGrid,
        datasetSharedRange
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = DashboardPlots;
    global.DashboardPlots = DashboardPlots;
})(typeof window !== 'undefined' ? window : globalThis);
