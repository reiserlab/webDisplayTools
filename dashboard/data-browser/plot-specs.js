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
    const P3_PHASES = [
        { key: 'baseline', name: 'Baseline', color: '#59636e' },
        { key: 'training', name: 'Training', color: '#b6388c' },
        { key: 'probe', name: 'Probe', color: '#168a55' }
    ];
    const P3_PATTERN_IMAGES = {
        36: 'assets/p3_heisenberg_ts.gif',
        41: 'assets/p3_heisenberg_ts.gif',
        37: 'assets/p3_heisenberg_high_low.gif',
        42: 'assets/p3_heisenberg_high_low.gif',
        38: 'assets/p3_heisenberg_slashes.gif',
        43: 'assets/p3_heisenberg_slashes.gif',
        39: 'assets/p3_heisenberg_relational.gif',
        44: 'assets/p3_heisenberg_relational.gif',
        40: 'assets/p3_dill_random_checkers.gif',
        45: 'assets/p3_dill_random_checkers.gif'
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

    function datasetSharedRange(cells, metric, useCourseAxisFloor) {
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
        const floor = useCourseAxisFloor === false ? null : COURSE_AXIS_FLOORS[metric];
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
            margin: { l: 64, r: 26, t: opts.marginTop || 54, b: 52 },
            height: opts.height || Math.max(360, rows * 190 + 100),
            showlegend: true,
            legend: {
                orientation: 'h',
                x: 0,
                y: opts.legendY || 1.06,
                xanchor: 'left',
                yanchor: 'bottom'
            },
            annotations: [],
            images: [],
            shapes: [],
            hovermode: 'closest'
        };
        const gapX = cols > 1 ? 0.025 : 0;
        const gapY = rows > 1 ? 0.035 : 0;
        const manualRange =
            opts.axisRanges && Array.isArray(opts.axisRanges[opts.metric])
                ? opts.axisRanges[opts.metric]
                : null;
        const sharedRange =
            opts.yRange ||
            manualRange ||
            (opts.sharedY === false
                ? null
                : datasetSharedRange(cells, opts.metric, opts.useCourseAxisFloor));
        const rowRanges = Array.isArray(opts.rowMetrics)
            ? opts.rowMetrics.map((metric, row) => {
                  const override =
                      opts.axisRanges && Array.isArray(opts.axisRanges[metric])
                          ? opts.axisRanges[metric]
                          : null;
                  return (
                      override ||
                      datasetSharedRange(
                          cells.slice(row * cols, (row + 1) * cols),
                          metric,
                          opts.useCourseAxisFloor
                      )
                  );
              })
            : null;
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
                type: opts.xType,
                tickmode: opts.xTickVals ? 'array' : undefined,
                tickvals: opts.xTickVals,
                ticktext: opts.xTickText,
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
                    col === 0 && (rowRanges || row === Math.floor(rows / 2))
                        ? {
                              text:
                                  (Array.isArray(opts.rowLabels) && opts.rowLabels[row]) ||
                                  opts.yLabel ||
                                  '',
                              standoff: 5
                          }
                        : undefined,
                tickfont: { size: 10 },
                range: rowRanges ? rowRanges[row] : sharedRange
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
            for (const annotation of cell.annotations || []) {
                const dataY = !!annotation.dataY;
                const nextAnnotation = {
                    ...annotation,
                    xref: xName,
                    yref: dataY ? yName : `${yName} domain`
                };
                delete nextAnnotation.dataY;
                layout.annotations.push(nextAnnotation);
            }
            for (const item of cell.images || []) {
                const dataY = !!item.dataY;
                const nextImage = {
                    ...item,
                    xref: xName,
                    yref: dataY ? yName : `${yName} domain`
                };
                delete nextImage.dataY;
                layout.images.push(nextImage);
            }
            if (!opts.columnTitlesOnly || row === 0) {
                layout.annotations.push({
                    x: (x0 + x1) / 2,
                    y: y1 + (opts.titleOffset || 0.008),
                    xref: 'paper',
                    yref: 'paper',
                    text: `<b>${cell.title}</b>`,
                    showarrow: false,
                    yanchor: 'bottom',
                    font: { size: 11, color: COLORS.text }
                });
            }
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

    function axisGridOptions(options, metric, extra) {
        return {
            ...extra,
            metric,
            axisRanges: options && options.axisRanges,
            useCourseAxisFloor: !options || options.useCourseAxisFloor !== false
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
                        axisGridOptions(options, metric, {
                            yLabel: A.metricLabel(metric),
                            height: 1180
                        })
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
            axisGridOptions(options, 'turning', {
                xLabel: 'LED level (0=pre sham, 6=post sham)',
                yLabel: 'Turning velocity (deg/s)',
                height: 430
            })
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
                    axisGridOptions(options, metric, {
                        yLabel: A.metricLabel(metric),
                        height: 570
                    })
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
                    axisGridOptions(options, metric, {
                        yLabel: A.metricLabel(metric),
                        height: 760
                    })
                )
            );
        }
        return pages;
    }

    function p1TuningPoints(run, period, metric, series, alignDirection) {
        return [0, 1, 2, 4, 8, 16]
            .map((frequency) => {
                const direction = frequency === 0 ? 'static' : series.key;
                const steps = run.steps.filter(
                    (step) => step.condition === `om_${period}deg_${direction}_${frequency}hz`
                );
                let value = A.mean(steps.map((step) => A.stepMean(run, step, metric, 0, 2)));
                if (
                    alignDirection &&
                    metric === 'turning' &&
                    frequency > 0 &&
                    series.key === 'ccw'
                ) {
                    value *= -1;
                }
                return { x: frequency, y: value };
            })
            .filter((point) => Number.isFinite(point.y));
    }

    function p1MatchedTuningPage(runs, options) {
        const periods = [36, 72];
        const metrics = ['turning', 'forward'];
        const cells = [];
        metrics.forEach((metric) =>
            periods.forEach((period) => {
                const result = summarySeries(
                    runs,
                    (run, series) => p1TuningPoints(run, period, metric, series, true),
                    [
                        { name: 'CW / right', key: 'cw', color: COLORS.cw },
                        {
                            name: 'CCW / left',
                            key: 'ccw',
                            color: COLORS.ccw
                        }
                    ],
                    options
                );
                cells.push({
                    title: `${period} deg spatial period`,
                    traces: result.traces,
                    shapes: [],
                    csvRows: result.csvRows.map((row) => ({
                        ...row,
                        metric,
                        spatial_period_deg: period,
                        direction_aligned: metric === 'turning'
                    }))
                });
            })
        );
        return pageFromCells(
            'p1-optomotor-matched-summary',
            'p1 Matched optomotor summary',
            'Turning is shown above forward velocity; columns are spatial periods. CCW/left turning is sign-flipped into the CW/right frame. Forward velocity is not flipped. Static 0 Hz is the common control.',
            cells,
            metrics.length,
            periods.length,
            {
                xLabel: 'Temporal frequency (Hz)',
                rowMetrics: metrics,
                rowLabels: ['Aligned turning (deg/s)', 'Forward velocity (mm/s)'],
                axisRanges: options.axisRanges,
                useCourseAxisFloor: options.useCourseAxisFloor !== false,
                columnTitlesOnly: true,
                height: 650
            }
        );
    }

    function p1FoldedTuningPoints(run, period, metric) {
        return [0, 1, 2, 4, 8, 16]
            .map((frequency) => {
                if (frequency === 0) {
                    const staticSteps = run.steps.filter(
                        (step) => step.condition === `om_${period}deg_static_0hz`
                    );
                    return {
                        x: frequency,
                        y: A.mean(staticSteps.map((step) => A.stepMean(run, step, metric, 0, 2)))
                    };
                }
                const directionMeans = ['cw', 'ccw'].map((direction) => {
                    const steps = run.steps.filter(
                        (step) => step.condition === `om_${period}deg_${direction}_${frequency}hz`
                    );
                    return A.mean(steps.map((step) => A.stepMean(run, step, metric, 0, 2)));
                });
                if (!directionMeans.every(Number.isFinite)) return { x: frequency, y: NaN };
                const [cw, ccw] = directionMeans;
                return {
                    x: frequency,
                    y: metric === 'turning' ? (cw - ccw) / 2 : (cw + ccw) / 2
                };
            })
            .filter((point) => Number.isFinite(point.y));
    }

    function p1FoldedTuningPage(runs, options) {
        const periods = [36, 72];
        const metrics = ['turning', 'forward'];
        const cells = [];
        metrics.forEach((metric) =>
            periods.forEach((period) => {
                const result = summarySeries(
                    runs,
                    (run) => p1FoldedTuningPoints(run, period, metric),
                    [{ name: 'CW-aligned folded mean', key: 'folded', color: COLORS.cw }],
                    options
                );
                cells.push({
                    title: `${period} deg spatial period`,
                    traces: result.traces,
                    shapes: [],
                    csvRows: result.csvRows.map((row) => ({
                        ...row,
                        metric,
                        spatial_period_deg: period,
                        folding: metric === 'turning' ? 'mean(CW, -CCW)' : 'mean(CW, CCW)'
                    }))
                });
            })
        );
        return pageFromCells(
            'p1-optomotor-folded-summary',
            'p1 Folded optomotor summary',
            'Turning is folded into the CW frame and then averaged: mean(CW, -CCW). Forward velocity is averaged without sign reversal: mean(CW, CCW). Each direction is averaged within fly first, then flies are averaged for grouped views. Static 0 Hz is the common control.',
            cells,
            metrics.length,
            periods.length,
            {
                xLabel: 'Temporal frequency (Hz)',
                rowMetrics: metrics,
                rowLabels: ['CW-aligned folded turning (deg/s)', 'Direction-mean forward (mm/s)'],
                axisRanges: options.axisRanges,
                useCourseAxisFloor: options.useCourseAxisFloor !== false,
                columnTitlesOnly: true,
                height: 650
            }
        );
    }

    function p1TuningPage(runs, options) {
        const cells = [36, 72].map((period) => {
            const result = summarySeries(
                runs,
                (run, series) => p1TuningPoints(run, period, 'turning', series, false),
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
            axisGridOptions(options, 'turning', {
                xLabel: 'Temporal frequency (Hz)',
                yLabel: 'Turning velocity (deg/s)',
                height: 430
            })
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
                    axisGridOptions(options, metric, {
                        yLabel: A.metricLabel(metric),
                        height: 570
                    })
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
                    axisGridOptions(options, metric, {
                        yLabel: A.metricLabel(metric),
                        height: 560
                    })
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

    function p3PhaseBounds(run, scale) {
        return run.steps.flatMap((step) => {
            const phase = P3_PHASES.find(
                (candidate) => candidate.key === A.p3Phase(step.condition)
            );
            return phase
                ? [{ ...phase, start: step.startMs * scale, end: step.endMs * scale }]
                : [];
        });
    }

    function p3PhaseBandShapes(run, scale) {
        return p3PhaseBounds(run, scale).map((phase) => ({
            type: 'rect',
            x0: phase.start,
            x1: phase.end,
            y0: 0,
            y1: 1,
            fillcolor: rgba(phase.color, 0.09),
            line: { width: 0 },
            layer: 'below'
        }));
    }

    function p3LedBandShapes(run) {
        return A.p3LedEpochs(run).map((epoch) => ({
            type: 'rect',
            x0: epoch.startMs / 60000,
            x1: epoch.endMs / 60000,
            y0: 0,
            y1: 1,
            fillcolor: 'rgba(220, 42, 54, 0.18)',
            line: { width: 0 },
            layer: 'below'
        }));
    }

    function p3TimelineOrientationShapes(run) {
        const durationMin = (run.frames[run.frames.length - 1] || {}).timeS / 60 || 0;
        const reinforced = p3ReinforcedAngleSegments(run);
        const boundaries = [
            -180,
            180,
            ...reinforced.flatMap(([start, end]) => [start, end])
        ]
            .filter(Number.isFinite)
            .sort((a, b) => a - b)
            .filter((value, index, values) => index === 0 || value !== values[index - 1]);
        const shapes = [];
        for (let index = 0; index < boundaries.length - 1; index += 1) {
            const start = boundaries[index];
            const end = boundaries[index + 1];
            const midpoint = (start + end) / 2;
            const isReinforced = reinforced.some(
                ([rangeStart, rangeEnd]) => midpoint >= rangeStart && midpoint <= rangeEnd
            );
            shapes.push({
                type: 'rect',
                x0: 0,
                x1: durationMin,
                y0: start,
                y1: end,
                dataY: true,
                fillcolor: rgba(isReinforced ? COLORS.magenta : COLORS.green, 0.055),
                line: { width: 0 },
                layer: 'below'
            });
        }
        boundaries.slice(1, -1).forEach((boundary) =>
            shapes.push({
                type: 'line',
                x0: 0,
                x1: durationMin,
                y0: boundary,
                y1: boundary,
                dataY: true,
                line: { color: '#8f99a3', width: 1, dash: 'dot' }
            })
        );
        return shapes;
    }

    function p3TimelinePage(runs, options) {
        const metrics = [
            {
                key: 'orientation',
                title: 'Cue-normalized orientation',
                label: 'Cue-normalized orientation, A = 0 deg',
                color: COLORS.cw,
                value: (frame, run) =>
                    A.wrapDeg(
                        ((A.p3CueIndex(run, frame.condition, frame.index) - 25) * 360) / 200
                    )
            },
            {
                key: 'forward',
                title: 'Forward velocity',
                label: 'Forward velocity (mm/s)',
                color: COLORS.green,
                value: (frame) => frame.forwardMmSSmoothed
            },
            {
                key: 'turning',
                title: 'Turning velocity',
                label: 'Turning velocity (deg/s)',
                color: COLORS.ccw,
                value: (frame) => frame.turningDegSSmoothed
            }
        ];
        const phaseShapes = p3PhaseBandShapes(runs[0], 1 / 60000);
        const ledShapes = p3LedBandShapes(runs[0]);
        const orientationShapes = p3TimelineOrientationShapes(runs[0]);
        const cells = metrics.map((metric) => {
            const traces = [];
            const csvRows = [];
            runs.forEach((run) => {
                const stride = Math.max(1, Math.ceil(run.frames.length / 5000));
                const sampled = run.frames.filter(
                    (frame, index) =>
                        index % stride === 0 && Number.isFinite(metric.value(frame, run))
                );
                const x = sampled.map((frame) => frame.timeS / 60);
                const y = sampled.map((frame) => metric.value(frame, run));
                traces.push({
                    type: 'scatter',
                    mode: 'lines',
                    x,
                    y,
                    name: run.id,
                    showlegend: metric.key === 'orientation',
                    legendgroup: run.id,
                    line: {
                        color: rgba(metric.color, runs.length === 1 ? 0.9 : 0.45),
                        width: runs.length === 1 ? 1.2 : 0.8
                    },
                    text: sourceLabel(run),
                    hovertemplate: '%{text}<br>%{x:.2f} min<br>%{y:.2f}<extra></extra>'
                });
                sampled.forEach((frame, index) =>
                    csvRows.push({
                        plot: 'p3-timeline',
                        run_id: run.id,
                        metric: metric.key,
                        time_min: x[index],
                        value: y[index],
                        condition: frame.condition || ''
                    })
                );
            });
            return {
                title: metric.title,
                traces,
                shapes: [
                    ...(metric.key === 'orientation' ? orientationShapes : []),
                    ...phaseShapes,
                    ...ledShapes
                ],
                csvRows
            };
        });
        return pageFromCells(
            'p3-timeline',
            'p3 Experiment timeline',
            'Cue-normalized panorama orientation (not FicTrac fly heading), forward velocity, and turning velocity across the experiment. Current phase90 trials are shifted +50 frames so the same cues align across trials; legacy diagnostic runs remain raw. Horizontal bands mark safe and reinforced cue sectors; red vertical bands mark logged LED-on intervals.',
            cells,
            3,
            1,
            {
                xLabel: 'Experiment time (min)',
                rowMetrics: metrics.map((metric) => metric.key),
                rowLabels: metrics.map((metric) => metric.label),
                axisRanges: { ...(options.axisRanges || {}), orientation: [-180, 180] },
                useCourseAxisFloor: options.useCourseAxisFloor !== false,
                height: 760
            }
        );
    }

    function p3ReinforcedAngleSegments(run) {
        return A.p3AnalysisRanges(run).flatMap(([startIndex, endIndex]) => {
            const start = A.wrapDeg(((startIndex - 25) * 360) / 200);
            const width = ((endIndex - startIndex + 1) * 360) / 200;
            const end = start + width;
            if (end <= 180) return [[start, end]];
            return [
                [start, 180],
                [-180, end - 360]
            ];
        });
    }

    function p3OrientationShapes(run) {
        const shapes = p3ReinforcedAngleSegments(run).map(([start, end]) => ({
            type: 'rect',
            x0: start,
            x1: end,
            y0: 0,
            y1: 1,
            fillcolor: rgba(COLORS.magenta, 0.1),
            line: { width: 0 },
            layer: 'below'
        }));
        [-180, 0, 180].forEach((angle) =>
            shapes.push({
                type: 'line',
                x0: angle,
                x1: angle,
                y0: 0,
                y1: 1,
                line: { color: COLORS.text, width: 1 }
            })
        );
        [-90, 90].forEach((angle) =>
            shapes.push({
                type: 'line',
                x0: angle,
                x1: angle,
                y0: 0,
                y1: 1,
                line: { color: COLORS.green, width: 1, dash: 'dot' }
            })
        );
        shapes.push({
            type: 'line',
            x0: -180,
            x1: 180,
            y0: 1,
            y1: 1,
            dataY: true,
            line: { color: COLORS.amber, width: 1, dash: 'dash' }
        });
        return shapes;
    }

    function p3PatternId(run) {
        for (const step of run.steps || []) {
            if (!A.p3Phase(step.condition)) continue;
            for (const interval of step.intervals || []) {
                const patternId = Number(interval.params && interval.params.patternId);
                if (Number.isFinite(patternId)) return patternId;
            }
        }
        return NaN;
    }

    function p3StimulusImage(run) {
        return P3_PATTERN_IMAGES[p3PatternId(run)] || P3_PATTERN_IMAGES[36];
    }

    function p3StimulusImages(run) {
        return [
            {
                source: p3StimulusImage(run),
                x: -180,
                y: 1.025,
                sizex: 360,
                sizey: 0.1,
                xanchor: 'left',
                yanchor: 'bottom',
                sizing: 'stretch',
                opacity: 1,
                layer: 'above'
            }
        ];
    }

    function p3OrientationCell(runs, phase, options) {
        const perRun = runs
            .map((run) => {
                const angles = run.steps
                    .filter((step) => A.p3Phase(step.condition) === phase.key)
                    .flatMap((step) => A.p3TrialAngles(run, step, 0));
                const histogram = A.occupancyHistogram(angles, 100);
                return {
                    run,
                    curve: { x: histogram.angle, y: histogram.percent },
                    samples: histogram.samples
                };
            })
            .filter((item) => item.samples > 0);
        const traces = [];
        const csvRows = [];
        if (options.mode === 'group' && options.showIndividuals) {
            perRun.forEach((item) => {
                traces.push({
                    type: 'scatter',
                    mode: 'lines',
                    x: item.curve.x,
                    y: item.curve.y,
                    name: `${phase.name} ${item.run.id}`,
                    showlegend: false,
                    line: { color: rgba(phase.color, 0.28), width: 1 },
                    text: sourceLabel(item.run),
                    hovertemplate: '%{text}<br>%{x:.1f} deg<br>%{y:.2f}%<extra></extra>'
                });
            });
        }
        const summary =
            options.mode === 'group'
                ? A.averageCurves(perRun.map((item) => item.curve))
                : perRun[0] && perRun[0].curve;
        if (summary) {
            traces.push({
                type: 'scatter',
                mode: 'lines',
                x: summary.x,
                y: summary.y,
                name: phase.name,
                line: { color: phase.color, width: 2.4 },
                hovertemplate: `${phase.name}<br>%{x:.1f} deg<br>%{y:.2f}%<extra></extra>`
            });
        }
        perRun.forEach((item) => {
            item.curve.x.forEach((angle, index) =>
                csvRows.push({
                    plot: 'p3-orientation',
                    phase: phase.key,
                    level: 'fly',
                    run_id: item.run.id,
                    angle_deg: angle,
                    occupancy_percent: item.curve.y[index],
                    samples: item.samples
                })
            );
        });
        return {
            title: phase.name,
            traces,
            shapes: p3OrientationShapes(runs[0]),
            images: p3StimulusImages(runs[0]),
            csvRows
        };
    }

    function p3OrientationPage(runs, options) {
        const cells = P3_PHASES.map((phase) => p3OrientationCell(runs, phase, options));
        const maxY =
            Math.max(
                2,
                ...cells.flatMap((cell) =>
                    cell.traces.flatMap((trace) =>
                        Array.isArray(trace.y) ? trace.y.filter(Number.isFinite) : []
                    )
                )
            ) * 1.08;
        const activations = runs.flatMap(A.p3LoggedLedActivations);
        const levels = [
            ...new Set(
                activations.map((activation) => activation.level).filter(Number.isFinite)
            )
        ].sort((a, b) => a - b);
        const rangeSets = [
            ...new Set(
                activations.map(
                    (activation) =>
                        `${activation.variant || 'legacy'} ${activation.ranges
                            .map(([start, end]) => `${start}-${end}`)
                            .join(', ')}`
                )
            )
        ];
        const levelText = levels.length ? levels.map((level) => `${level}%`).join(', ') : 'unknown';
        const rangeText = rangeSets.length ? rangeSets.join('; ') : 'not logged';
        const legacyNote = runs.some((run) => run.protocolInfo.p3Legacy)
            ? ' Legacy diagnostic data are shown without phase shifting.'
            : '';
        return pageFromCells(
            'p3-orientation',
            'p3 Orientation occupancy',
            `Full 360 degree cue-A-aligned occupancy by phase with the logged stimulus unrolled above each histogram. Cue A is at 0/180 deg, cue B at +/-90 deg, magenta sectors were reinforced during training, and chance is 1% per bin. Logged LED level(s): ${levelText}; raw on-ranges: ${rangeText}.${legacyNote}`,
            cells,
            1,
            3,
            {
                xLabel: 'Cue A-aligned panorama angle (deg)',
                yLabel: 'Occupancy (%)',
                yRange: [0, maxY],
                xRange: [-180, 180],
                height: 500,
                marginTop: 120,
                titleOffset: 0.15,
                legendY: 1.23
            }
        );
    }

    function p3TrialRows(run) {
        let trial = 0;
        const phaseTrials = { baseline: 0, training: 0, probe: 0 };
        const rows = run.steps
            .filter((step) => A.p3Phase(step.condition))
            .map((step) => {
                trial += 1;
                const metric = A.p3PreferenceIndex(run, step, 0);
                const dose = A.p3TrialDoseMetrics(run, step);
                const quality = A.p3TrialQualityMetrics(run, step, 1);
                phaseTrials[metric.phase] += 1;
                return {
                    run,
                    step,
                    trial,
                    phaseTrial: phaseTrials[metric.phase],
                    variant: A.p3TrialVariant(step.condition),
                    ...metric,
                    ledOnFraction: dose.ledOnFraction,
                    ledOnSec: dose.ledOnSec,
                    sectorEntries: dose.sectorEntries,
                    loggedActivation: dose.loggedActivation,
                    ...quality
                };
            });
        const blocks = [];
        for (const row of rows) {
            const last = blocks[blocks.length - 1];
            if (last && last.phase === row.phase) last.rows.push(row);
            else blocks.push({ phase: row.phase, rows: [row] });
        }
        const probeBlockCount = blocks.filter((block) => block.phase === 'probe').length;
        const phaseBlockCounts = { baseline: 0, training: 0, probe: 0 };
        for (const block of blocks) {
            phaseBlockCounts[block.phase] += 1;
            const blockNumber = phaseBlockCounts[block.phase];
            const stage =
                block.phase === 'baseline'
                    ? 'baseline'
                    : block.phase === 'training'
                      ? `training_${blockNumber}`
                      : probeBlockCount === 1 || blockNumber === probeBlockCount
                        ? 'final_probe'
                        : `probe_${blockNumber}`;
            block.rows.forEach((row, index) => {
                row.stage = stage;
                row.stageTrial = index + 1;
            });
        }
        return rows;
    }

    function p3StageRank(stage) {
        if (stage === 'baseline') return 0;
        if (stage === 'final_probe') return 1000;
        const match = stage.match(/^(training|probe)_(\d+)$/);
        if (!match) return 999;
        return Number(match[2]) * 2 - (match[1] === 'training' ? 1 : 0);
    }

    function p3AlignedTrialRows(runs) {
        const perRun = runs.map((run) => ({ run, rows: p3TrialRows(run) }));
        const stages = [
            ...new Set(perRun.flatMap((item) => item.rows.map((row) => row.stage)))
        ].sort((a, b) => p3StageRank(a) - p3StageRank(b));
        const offsets = new Map();
        let offset = 0;
        for (const stage of stages) {
            offsets.set(stage, offset);
            offset += Math.max(
                ...perRun.map(
                    (item) => item.rows.filter((row) => row.stage === stage).length
                )
            );
        }
        return perRun.map((item) => ({
            run: item.run,
            rows: item.rows.map((row) => ({
                ...row,
                sourceTrial: row.trial,
                trial: offsets.get(row.stage) + row.stageTrial
            }))
        }));
    }

    function p3LoggedLedSummary(runs) {
        const activations = runs.flatMap(A.p3LoggedLedActivations);
        if (!activations.length) return 'No conditional LED configuration was logged.';
        const details = [
            ...new Set(
                activations.map((activation) => {
                    const ranges = activation.ranges
                        .map(([start, end]) => `${start}-${end}`)
                        .join(', ');
                    const level = Number.isFinite(activation.level)
                        ? `${activation.level}%`
                        : 'unknown level';
                    return `${activation.variant || 'legacy'}: ${level} at [${ranges}]`;
                })
            )
        ];
        return `Logged conditional LED: ${details.join('; ')}.`;
    }

    function p3PreferencePage(runs, options) {
        const perRun = p3AlignedTrialRows(runs);
        const traces = [];
        const csvRows = [];
        if (options.mode === 'group' && options.showIndividuals) {
            perRun.forEach((item) =>
                traces.push({
                    type: 'scatter',
                    mode: 'lines',
                    x: item.rows.map((row) => row.trial),
                    y: item.rows.map((row) => row.preference),
                    name: item.run.id,
                    showlegend: false,
                    line: { color: 'rgba(60, 70, 80, 0.22)', width: 1 },
                    text: sourceLabel(item.run),
                    hovertemplate: '%{text}<br>trial %{x}<br>PI=%{y:.3f}<extra></extra>'
                })
            );
        }
        perRun.forEach((item) =>
            item.rows.forEach((row) =>
                csvRows.push({
                    plot: 'p3-preference',
                    level: 'fly_trial',
                    run_id: item.run.id,
                    trial: row.trial,
                    source_trial: row.sourceTrial,
                    phase: row.phase,
                    phase_trial: row.phaseTrial,
                    stage: row.stage,
                    stage_trial: row.stageTrial,
                    trial_variant: row.variant,
                    condition: row.step.condition,
                    cue_normalized: A.p3UsesCueNormalization(item.run),
                    preference_index: row.preference,
                    safe_fraction: row.safeFraction,
                    reinforced_fraction: row.reinforcedFraction,
                    samples: row.samples
                })
            )
        );
        const trialNumbers = [
            ...new Set(perRun.flatMap((item) => item.rows.map((row) => row.trial)))
        ].sort((a, b) => a - b);
        const means = trialNumbers.map((trial) =>
            A.mean(
                perRun.map((item) => {
                    const row = item.rows.find((candidate) => candidate.trial === trial);
                    return row ? row.preference : NaN;
                })
            )
        );
        const errors = trialNumbers.map((trial) =>
            A.sem(
                perRun.map((item) => {
                    const row = item.rows.find((candidate) => candidate.trial === trial);
                    return row ? row.preference : NaN;
                })
            )
        );
        traces.push({
            type: 'scatter',
            mode: 'lines',
            x: trialNumbers,
            y: means,
            name: 'Trial sequence',
            showlegend: false,
            line: { color: '#7c8791', width: 1.4 },
            hoverinfo: 'skip'
        });
        const referenceRows = perRun[0] ? perRun[0].rows : [];
        P3_PHASES.forEach((phase) => {
            const indices = trialNumbers
                .map((trial, index) => ({
                    trial,
                    index,
                    row: referenceRows.find((candidate) => candidate.trial === trial)
                }))
                .filter((item) => item.row && item.row.phase === phase.key);
            traces.push({
                type: 'scatter',
                mode: 'markers',
                x: indices.map((item) => item.trial),
                y: indices.map((item) => means[item.index]),
                name: phase.name,
                marker: { color: phase.color, size: 9 },
                error_y:
                    options.mode === 'group'
                        ? {
                              type: 'data',
                              array: indices.map((item) => errors[item.index]),
                              visible: true,
                              color: phase.color
                          }
                        : undefined,
                hovertemplate: `${phase.name}<br>trial %{x}<br>PI=%{y:.3f}<extra></extra>`
            });
        });
        const shapes = p3TrialPhaseShapes(referenceRows).map((shape) => ({
            ...shape,
            xref: 'x',
            yref: 'y domain'
        }));
        shapes.push({
            type: 'line',
            x0: 0.5,
            x1: Math.max(1.5, ...trialNumbers) + 0.5,
            y0: 0,
            y1: 0,
            xref: 'x',
            yref: 'y',
            line: { color: '#8f99a3', width: 1, dash: 'dash' }
        });
        trialNumbers.forEach((trial, index) =>
            csvRows.push({
                plot: 'p3-preference',
                level: options.mode === 'group' ? 'group_mean' : 'fly_mean',
                run_id: options.mode === 'group' ? 'all' : runs[0].id,
                trial,
                phase:
                    (referenceRows.find((row) => row.trial === trial) || {}).phase || '',
                preference_index: means[index],
                sem: errors[index],
                n: perRun.length
            })
        );
        return {
            id: 'p3-preference',
            title: 'p3 Preference index by trial',
            description:
                'Classic sector preference index from unsmoothed frame samples: (time safe - time reinforced) / total. Current phase90 trials are shifted +50 frames before scoring; legacy diagnostic runs remain raw. +1 is entirely safe-sector occupancy; -1 is entirely reinforced-sector occupancy.',
            figure: {
                data: traces,
                layout: {
                    paper_bgcolor: '#ffffff',
                    plot_bgcolor: '#ffffff',
                    font: { family: 'Inter, system-ui, sans-serif', color: COLORS.text },
                    margin: { l: 82, r: 30, t: 35, b: 62 },
                    height: 470,
                    hovermode: 'closest',
                    legend: { orientation: 'h', x: 0.18, y: 1.08 },
                    images: [
                        {
                            source: p3StimulusImage(runs[0]),
                            xref: 'paper',
                            yref: 'paper',
                            x: 0.01,
                            y: 0.5,
                            sizex: 0.14,
                            sizey: 0.12,
                            xanchor: 'left',
                            yanchor: 'middle',
                            sizing: 'contain',
                            layer: 'above'
                        }
                    ],
                    shapes,
                    xaxis: {
                        title: '20 s trial',
                        domain: [0.18, 1],
                        range: [0.5, Math.max(1.5, ...trialNumbers) + 0.5],
                        dtick: 1,
                        gridcolor: COLORS.grid
                    },
                    yaxis: {
                        title: 'Preference index',
                        range: [-1.05, 1.05],
                        gridcolor: COLORS.grid,
                        zeroline: false
                    }
                }
            },
            csvRows
        };
    }

    function p3TrialPhaseShapes(rows) {
        const blocks = [];
        for (const row of rows) {
            const last = blocks[blocks.length - 1];
            if (last && last.phase === row.phase && row.trial === last.end + 1) {
                last.end = row.trial;
            } else {
                blocks.push({ phase: row.phase, start: row.trial, end: row.trial });
            }
        }
        return blocks.flatMap((block) => {
            const phase = P3_PHASES.find((candidate) => candidate.key === block.phase);
            return phase
                ? [
                      {
                          type: 'rect',
                          x0: block.start - 0.5,
                          x1: block.end + 0.5,
                          y0: 0,
                          y1: 1,
                          fillcolor: rgba(phase.color, 0.07),
                          line: { width: 0 },
                          layer: 'below'
                      }
                  ]
                : [];
        });
    }

    function p3TrialMetricCell(runs, options, metric) {
        const perRun = p3AlignedTrialRows(runs);
        const referenceRows = perRun[0] ? perRun[0].rows : [];
        const trialNumbers = [
            ...new Set(perRun.flatMap((item) => item.rows.map((row) => row.trial)))
        ].sort((a, b) => a - b);
        const value = metric.value;
        const means = trialNumbers.map((trial) =>
            A.mean(
                perRun.map((item) => {
                    const row = item.rows.find((candidate) => candidate.trial === trial);
                    return row ? value(row) : NaN;
                })
            )
        );
        const errors = trialNumbers.map((trial) =>
            A.sem(
                perRun.map((item) => {
                    const row = item.rows.find((candidate) => candidate.trial === trial);
                    return row ? value(row) : NaN;
                })
            )
        );
        const traces = [];
        if (options.mode === 'group' && options.showIndividuals) {
            perRun.forEach((item) =>
                traces.push({
                    type: 'scatter',
                    mode: 'lines',
                    x: item.rows.map((row) => row.trial),
                    y: item.rows.map(value),
                    name: item.run.id,
                    showlegend: false,
                    line: { color: 'rgba(60, 70, 80, 0.2)', width: 1 },
                    text: sourceLabel(item.run),
                    hovertemplate: '%{text}<br>trial %{x}<br>%{y:.2f}<extra></extra>'
                })
            );
        }
        traces.push({
            type: 'scatter',
            mode: 'lines',
            x: trialNumbers,
            y: means,
            name: 'Trial sequence',
            showlegend: false,
            line: { color: '#7c8791', width: 1.4 },
            hoverinfo: 'skip'
        });
        P3_PHASES.forEach((phase) => {
            const points = trialNumbers
                .map((trial, index) => ({
                    trial,
                    index,
                    row: referenceRows.find((candidate) => candidate.trial === trial)
                }))
                .filter((item) => item.row && item.row.phase === phase.key);
            traces.push({
                type: 'scatter',
                mode: 'markers',
                x: points.map((point) => point.trial),
                y: points.map((point) => means[point.index]),
                name: phase.name,
                marker: { color: phase.color, size: 8 },
                error_y:
                    options.mode === 'group'
                        ? {
                              type: 'data',
                              array: points.map((point) => errors[point.index]),
                              visible: true,
                              color: phase.color
                          }
                        : undefined,
                hovertemplate: `${phase.name}<br>trial %{x}<br>%{y:.2f}<extra></extra>`
            });
        });
        const csvRows = [];
        perRun.forEach((item) =>
            item.rows.forEach((row) =>
                csvRows.push({
                    plot: metric.plotId,
                    metric: metric.key,
                    level: 'fly_trial',
                    run_id: item.run.id,
                    trial: row.trial,
                    source_trial: row.sourceTrial,
                    phase: row.phase,
                    stage: row.stage,
                    stage_trial: row.stageTrial,
                    trial_variant: row.variant,
                    condition: row.step.condition,
                    value: value(row),
                    led_on_sec: row.ledOnSec,
                    led_level_percent: row.loggedActivation.level,
                    led_hysteresis: row.loggedActivation.hysteresis,
                    led_on_ranges_raw: JSON.stringify(row.loggedActivation.ranges),
                    skipped_frame_fraction: row.skippedFrameFraction,
                    samples: row.samples
                })
            )
        );
        trialNumbers.forEach((trial, index) =>
            csvRows.push({
                plot: metric.plotId,
                metric: metric.key,
                level: options.mode === 'group' ? 'group_mean' : 'fly_mean',
                run_id: options.mode === 'group' ? 'all' : runs[0].id,
                trial,
                phase:
                    (referenceRows.find((row) => row.trial === trial) || {}).phase || '',
                value: means[index],
                sem: errors[index],
                n: perRun.length
            })
        );
        return {
            title: metric.title,
            traces,
            shapes: p3TrialPhaseShapes(referenceRows),
            csvRows
        };
    }

    function p3DoseEntriesPage(runs, options) {
        const metrics = [
            {
                key: 'ledOnPercent',
                plotId: 'p3-dose-entries',
                title: 'LED-on fraction',
                label: 'LED on (% of trial)',
                value: (row) => row.ledOnFraction * 100
            },
            {
                key: 'sectorEntries',
                plotId: 'p3-dose-entries',
                title: 'Reinforced-sector entries',
                label: 'Safe to reinforced entries',
                value: (row) => row.sectorEntries
            }
        ];
        const cells = metrics.map((metric) => p3TrialMetricCell(runs, options, metric));
        return pageFromCells(
            'p3-dose-entries',
            'p3 LED dose and sector entries',
            `Actual logged LED-on fraction and cue-normalized safe-to-reinforced sector crossings for each 20 s trial. Raw LED level and on-ranges are retained in the CSV. ${p3LoggedLedSummary(runs)}`,
            cells,
            2,
            1,
            {
                xLabel: '20 s trial',
                rowMetrics: metrics.map((metric) => metric.key),
                rowLabels: metrics.map((metric) => metric.label),
                axisRanges: { ledOnPercent: [0, 100] },
                useCourseAxisFloor: false,
                height: 620
            }
        );
    }

    function p3QualityPage(runs, options) {
        const metrics = [
            {
                key: 'cueStabilization',
                plotId: 'p3-quality-qc',
                title: 'Cue stabilization strength',
                label: 'Doubled-angle vector strength',
                value: (row) => row.cueStabilizationStrength
            },
            {
                key: 'movementPercent',
                plotId: 'p3-quality-qc',
                title: 'Movement fraction',
                label: 'Frames moving >1 mm/s (%)',
                value: (row) => row.movementFraction * 100
            },
            {
                key: 'meanSpeed',
                plotId: 'p3-quality-qc',
                title: 'Mean walking speed',
                label: 'Speed (mm/s)',
                value: (row) => row.meanSpeedMmS
            },
            {
                key: 'meanAbsTurning',
                plotId: 'p3-quality-qc',
                title: 'Mean absolute turning',
                label: '|Turning| (deg/s)',
                value: (row) => row.meanAbsTurningDegS
            },
            {
                key: 'skippedFrames',
                plotId: 'p3-quality-qc',
                title: 'Skipped-frame QC',
                label: 'Skipped FicTrac frames',
                value: (row) => row.skippedFrames
            }
        ];
        const cells = metrics.map((metric) => p3TrialMetricCell(runs, options, metric));
        return pageFromCells(
            'p3-quality-qc',
            'p3 Behavior and timing QC',
            'Per-trial cue stabilization, movement, and acquisition quality. Stabilization is doubled-angle vector strength (0 uniform, 1 tightly aligned to either repeated cue axis); movement is speed >1 mm/s; speed and absolute turning use unsmoothed frame derivatives; skipped frames come from FicTrac frame-counter gaps.',
            cells,
            metrics.length,
            1,
            {
                xLabel: '20 s trial',
                rowMetrics: metrics.map((metric) => metric.key),
                rowLabels: metrics.map((metric) => metric.label),
                axisRanges: {
                    cueStabilization: [0, 1],
                    movementPercent: [0, 100]
                },
                useCourseAxisFloor: false,
                height: 1050
            }
        );
    }

    function p3DwellCurve(run, phase, sector) {
        const dwellTimes = run.steps
            .filter((step) => A.p3Phase(step.condition) === phase)
            .flatMap((step) => A.p3DwellBouts(run, step))
            .filter((bout) => bout.sector === sector)
            .map((bout) => bout.durationSec);
        const x = Array.from(
            { length: 201 },
            (_, index) => 10 ** (-2 + (index / 200) * (Math.log10(20) + 2))
        );
        return {
            x,
            y: x.map((threshold) =>
                dwellTimes.length
                    ? (dwellTimes.filter((duration) => duration >= threshold).length /
                          dwellTimes.length) *
                      100
                    : NaN
            ),
            dwellTimes
        };
    }

    function p3DwellCell(runs, phase, options) {
        const traces = [];
        const csvRows = [];
        const sectors = [
            { key: 'safe', name: 'Safe', color: COLORS.green },
            { key: 'reinforced', name: 'Reinforced', color: COLORS.magenta }
        ];
        sectors.forEach((sector) => {
            const perRun = runs.map((run) => ({
                run,
                curve: p3DwellCurve(run, phase.key, sector.key)
            }));
            if (options.mode === 'group' && options.showIndividuals) {
                perRun.forEach((item) =>
                    traces.push({
                        type: 'scatter',
                        mode: 'lines',
                        x: item.curve.x,
                        y: item.curve.y,
                        name: `${sector.name} ${item.run.id}`,
                        showlegend: false,
                        line: { color: rgba(sector.color, 0.25), width: 1 },
                        text: sourceLabel(item.run),
                        hovertemplate:
                            '%{text}<br>dwell >= %{x:.1f} s<br>%{y:.1f}%<extra></extra>'
                    })
                );
            }
            const summary =
                options.mode === 'group'
                    ? A.averageCurves(perRun.map((item) => item.curve))
                    : perRun[0] && perRun[0].curve;
            if (summary) {
                traces.push({
                    type: 'scatter',
                    mode: 'lines',
                    x: summary.x,
                    y: summary.y,
                    name: sector.name,
                    line: { color: sector.color, width: 2.5 },
                    hovertemplate: `${sector.name}<br>dwell >= %{x:.1f} s<br>%{y:.1f}%<extra></extra>`
                });
            }
            perRun.forEach((item) =>
                item.curve.dwellTimes.forEach((duration, index) =>
                    csvRows.push({
                        plot: 'p3-dwell',
                        phase: phase.key,
                        sector: sector.key,
                        level: 'bout',
                        run_id: item.run.id,
                        bout: index + 1,
                        duration_sec: duration
                    })
                )
            );
        });
        return { title: phase.name, traces, shapes: [], csvRows };
    }

    function p3DwellPage(runs, options) {
        const cells = P3_PHASES.map((phase) => p3DwellCell(runs, phase, options));
        return pageFromCells(
            'p3-dwell',
            'p3 Safe versus reinforced dwell times',
            'Dwell-time survival curves from unsmoothed sector occupancy. Each curve shows the percentage of contiguous bouts lasting at least the indicated duration.',
            cells,
            1,
            3,
            {
                xLabel: 'Dwell duration (s)',
                yLabel: 'Bouts at least this long (%)',
                xType: 'log',
                xRange: [-2, Math.log10(20)],
                xTickVals: [0.01, 0.1, 1, 10, 20],
                xTickText: ['0.01', '0.1', '1', '10', '20'],
                yRange: [0, 100],
                height: 450
            }
        );
    }

    function p3CorrectedProbeRows(run) {
        const rows = p3TrialRows(run);
        const baseline = {};
        const variants = [...new Set(rows.map((row) => row.variant).filter(Boolean))];
        variants.forEach((variant) => {
            baseline[variant] = A.mean(
                rows
                    .filter(
                        (row) =>
                            row.phase === 'baseline' &&
                            row.variant === variant
                    )
                    .map((row) => row.preference)
            );
        });
        const probeTrials = {};
        return rows
            .filter((row) => row.phase === 'probe')
            .map((row) => {
                probeTrials[row.variant] = (probeTrials[row.variant] || 0) + 1;
                return {
                    ...row,
                    probeTrial: probeTrials[row.variant],
                    baselinePreference: baseline[row.variant],
                    correctedPreference: row.preference - baseline[row.variant]
                };
            });
    }

    function p3CorrectedProbePage(runs, options) {
        const current = runs.some((run) => !run.protocolInfo.p3Legacy);
        const series = current
            ? [
                  { name: 'Phase 0', key: 'phase0', color: COLORS.cw, symbol: 'circle' },
                  { name: 'Phase 90', key: 'phase90', color: COLORS.green, symbol: 'square' }
              ]
            : [
                  { name: 'Legacy A', key: 'a', color: COLORS.cw, symbol: 'circle' },
                  { name: 'Legacy B', key: 'b', color: COLORS.green, symbol: 'square' }
              ];
        const result = summarySeries(
            runs,
            (run, item) =>
                p3CorrectedProbeRows(run)
                    .filter((row) => row.variant === item.key)
                    .map((row) => ({ x: row.probeTrial, y: row.correctedPreference })),
            series,
            options
        );
        const details = runs.flatMap((run) =>
            p3CorrectedProbeRows(run).map((row) => ({
                plot: 'p3-corrected-probe',
                level: 'fly_trial',
                run_id: run.id,
                probe_trial: row.probeTrial,
                trial_variant: row.variant,
                probe_preference: row.preference,
                matched_baseline_preference: row.baselinePreference,
                corrected_preference: row.correctedPreference
            }))
        );
        const maxProbeTrial = Math.max(
            1,
            ...runs.flatMap((run) =>
                p3CorrectedProbeRows(run).map((row) => row.probeTrial)
            )
        );
        return pageFromCells(
            'p3-corrected-probe',
            'p3 Baseline-corrected probe preference',
            'Probe PI minus the same fly\'s mean baseline PI for the matching phase0/phase90 trial variant. Legacy diagnostic runs are matched by their original A/B labels without phase normalization.',
            [
                {
                    title: 'Probe after matched baseline correction',
                    traces: result.traces,
                    shapes: [
                        {
                            type: 'line',
                            x0: 0.5,
                            x1: maxProbeTrial + 0.5,
                            y0: 0,
                            y1: 0,
                            dataY: true,
                            line: { color: '#8f99a3', width: 1, dash: 'dash' }
                        }
                    ],
                    csvRows: [...details, ...result.csvRows]
                }
            ],
            1,
            1,
            {
                xLabel: 'Probe trial',
                yLabel: 'Probe PI - matched baseline PI',
                xRange: [0.5, maxProbeTrial + 0.5],
                useCourseAxisFloor: false,
                height: 470
            }
        );
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
                axisGridOptions(options, metric, {
                    yLabel: A.metricLabel(metric),
                    height: Math.max(450, rows * 190 + 100)
                })
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
                p1FoldedTuningPage(runs, opts),
                p1MatchedTuningPage(runs, opts),
                p1TuningPage(runs, opts)
            ];
        if (families[0].startsWith('p3-'))
            return [
                p3TimelinePage(runs, opts),
                p3OrientationPage(runs, opts),
                p3PreferencePage(runs, opts),
                p3CorrectedProbePage(runs, opts),
                p3DoseEntriesPage(runs, opts),
                p3QualityPage(runs, opts),
                p3DwellPage(runs, opts)
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
