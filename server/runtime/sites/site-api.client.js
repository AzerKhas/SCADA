/**
 * custom-SCADA: site-api.js, access to the data of the site from the HTML pages of its folder
 * (copied in the folder of each site, used by courbes.html, historiques.html and api.html)
 *
 *   SiteApi.info()                                  site, tags, curves of the page Courbes
 *   SiteApi.values(['tag1', 'tag2'])                current values
 *   SiteApi.history({ tags, from, to, maxPoints })  history (from/to: Date, ms or ISO)
 *   SiteApi.saveCurves([{ tag, label, color, axis }]) choice of the tags of the page Courbes
 *   SiteApi.drawChart(canvas, series, curves)       curves on a canvas
 *   SiteApi.historyTable(series)                    { head, rows } with one column per tag
 */
(function () {
    'use strict';

    // /site/<name>/fichiers/courbes.html -> /site/<name>/api/site
    var base = location.pathname.replace(/\/fichiers\/[^/]*$/, '') + '/api/site';

    function headers(json) {
        var result = json ? { 'Content-Type': 'application/json' } : {};
        // with the security of FUXA enabled: token of the user logged in FUXA in this tab
        try {
            var token = (JSON.parse(sessionStorage.getItem('currentUser')) || {}).token;
            if (token) {
                result['x-access-token'] = token;
            }
        } catch (err) {
            // no user logged in
        }
        return result;
    }

    function answer(res) {
        return res.json().then(function (body) {
            if (!res.ok) {
                throw new Error(body && body.message ? body.message : 'Erreur ' + res.status);
            }
            return body;
        });
    }

    function get(path, params) {
        var query = Object.keys(params || {}).filter(function (k) { return params[k] !== undefined && params[k] !== null && params[k] !== ''; })
            .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
        return fetch(base + path + (query ? '?' + query : ''), { headers: headers(false) }).then(answer);
    }

    function time(value) {
        if (value instanceof Date) {
            return value.getTime();
        }
        return value;
    }

    function info() {
        return get('/info');
    }

    function values(tags) {
        return get('/values', { tags: (tags || []).join(',') });
    }

    /** options: { tags, from, to, maxPoints, interval (seconds: one average value per interval) } */
    function history(options) {
        options = options || {};
        return get('/history', {
            tags: (options.tags || []).join(','),
            from: time(options.from),
            to: time(options.to),
            maxPoints: options.maxPoints,
            interval: options.interval || ''
        });
    }

    /** graphs of the page Courbes */
    function graphs() {
        return get('/graphs');
    }

    function saveGraphs(list) {
        return fetch(base + '/graphs', { method: 'PUT', headers: headers(true), body: JSON.stringify({ graphs: list }) }).then(answer);
    }

    /** chartMode (optional): { mode: 'temps' | 'xy', xTag: tag of the axis X } */
    function saveCurves(curves, chartMode) {
        var body = { curves: curves };
        if (chartMode) {
            body.mode = chartMode.mode;
            body.xTag = chartMode.xTag;
        }
        return fetch(base + '/curves', { method: 'PUT', headers: headers(true), body: JSON.stringify(body) }).then(answer);
    }

    function pad(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function formatDate(ms, withSeconds) {
        var d = new Date(ms);
        return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) +
            (withSeconds ? ':' + pad(d.getSeconds()) : '');
    }

    /** numeric values of a series (true / false: 1 / 0), the other values (null, text) are missing values */
    function numbers(series) {
        var result = [];
        series.values.forEach(function (p) {
            var v = p.v === true || p.v === 'true' ? 1 : p.v === false || p.v === 'false' ? 0 : p.v === null || p.v === '' ? NaN : Number(p.v);
            if (isFinite(v)) {
                result.push({ t: p.t, v: v });
            }
        });
        return result;
    }

    /** curves of the series on a canvas: axis left / right from the configuration of the curves */
    function drawChart(canvas, data, curves) {
        var ctx = canvas.getContext('2d');
        var ratio = window.devicePixelRatio || 1;
        var width = canvas.clientWidth, height = canvas.clientHeight;
        canvas.width = width * ratio;
        canvas.height = height * ratio;
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.clearRect(0, 0, width, height);
        var margin = { left: 60, right: 60, top: 14, bottom: 36 };
        var plotW = width - margin.left - margin.right, plotH = height - margin.top - margin.bottom;
        var from = data.from, to = data.to;
        var config = {};
        (curves || []).forEach(function (c) { config[c.tagId] = c; });
        var axes = { gauche: { min: Infinity, max: -Infinity }, droite: { min: Infinity, max: -Infinity } };
        var lines = data.series.map(function (s, i) {
            var c = config[s.id] || {};
            var points = numbers(s);
            var axis = c.axis === 'droite' ? 'droite' : 'gauche';
            points.forEach(function (p) {
                axes[axis].min = Math.min(axes[axis].min, p.v);
                axes[axis].max = Math.max(axes[axis].max, p.v);
            });
            return { points: points, axis: axis, color: c.color || ['#1565C0', '#E65100', '#2E7D32', '#C62828', '#6A1B9A'][i % 5] };
        });
        Object.keys(axes).forEach(function (k) {
            var a = axes[k];
            if (a.min === Infinity) { a.min = 0; a.max = 1; }
            if (a.min === a.max) { a.min -= 1; a.max += 1; }
            var pad = (a.max - a.min) * 0.05;
            a.min -= pad; a.max += pad;
        });
        var x = function (t) { return margin.left + (t - from) / (to - from) * plotW; };
        var y = function (v, axis) { var a = axes[axis]; return margin.top + plotH - (v - a.min) / (a.max - a.min) * plotH; };
        // grid and axes
        ctx.strokeStyle = '#ddd';
        ctx.fillStyle = '#555';
        ctx.font = '11px Arial';
        ctx.lineWidth = 1;
        for (var i = 0; i <= 5; i++) {
            var gy = margin.top + plotH * i / 5;
            ctx.beginPath(); ctx.moveTo(margin.left, gy); ctx.lineTo(margin.left + plotW, gy); ctx.stroke();
            ctx.textAlign = 'right';
            ctx.fillText(round(axes.gauche.max - (axes.gauche.max - axes.gauche.min) * i / 5), margin.left - 6, gy + 4);
            if (lines.some(function (l) { return l.axis === 'droite'; })) {
                ctx.textAlign = 'left';
                ctx.fillText(round(axes.droite.max - (axes.droite.max - axes.droite.min) * i / 5), margin.left + plotW + 6, gy + 4);
            }
        }
        ctx.textAlign = 'center';
        // one label every 110 px at least, the date is written only for the periods longer than one day
        var ticks = Math.max(2, Math.min(8, Math.floor(plotW / 110)));
        var withDate = to - from > 24 * 3600 * 1000;
        for (var j = 0; j <= ticks; j++) {
            var t = from + (to - from) * j / ticks;
            var gx = x(t);
            ctx.beginPath(); ctx.moveTo(gx, margin.top); ctx.lineTo(gx, margin.top + plotH); ctx.stroke();
            var label = formatDate(t);
            ctx.fillText(withDate ? label.slice(0, 5) + ' ' + label.slice(11) : label.slice(11), gx, height - 12);
        }
        ctx.strokeStyle = '#888';
        ctx.strokeRect(margin.left, margin.top, plotW, plotH);
        // area of the curves, for the zoom with the mouse
        canvas._chart = { from: from, to: to, left: margin.left, top: margin.top, width: plotW, height: plotH };
        // curves
        lines.forEach(function (l) {
            ctx.strokeStyle = l.color;
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            l.points.forEach(function (p, k) {
                var px = x(p.t), py = y(p.v, l.axis);
                if (k === 0) { ctx.moveTo(px, py); } else { ctx.lineTo(px, py); }
            });
            ctx.stroke();
        });
    }

    /**
     * XY: each value of a tag Y gets the value of the tag X at the same time
     * (last value of X recorded before, the tags are not recorded at the same instants)
     * @returns [{ id, name, points: [{ x, y, t }] }] for each tag Y
     */
    function pairXY(data, xId) {
        var xSeries = data.series.filter(function (s) { return s.id === xId; })[0];
        var xs = xSeries ? numbers(xSeries) : [];
        return data.series.filter(function (s) { return s.id !== xId; }).map(function (s) {
            var points = [], k = -1;
            numbers(s).forEach(function (p) {
                while (k + 1 < xs.length && xs[k + 1].t <= p.t) { k++; }
                if (k >= 0) { points.push({ x: xs[k].v, y: p.v, t: p.t }); }
            });
            return { id: s.id, name: s.name, points: points };
        });
    }

    /**
     * XY chart: points (x, y) of each tag Y, axis Y left / right from the configuration of the curves
     * xRange { min, max } (zoom) or null: all the points
     */
    function drawXY(canvas, lines, curves, xLabel, xRange) {
        var ctx = canvas.getContext('2d');
        var ratio = window.devicePixelRatio || 1;
        var width = canvas.clientWidth, height = canvas.clientHeight;
        canvas.width = width * ratio;
        canvas.height = height * ratio;
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.clearRect(0, 0, width, height);
        var margin = { left: 60, right: 60, top: 14, bottom: 44 };
        var plotW = width - margin.left - margin.right, plotH = height - margin.top - margin.bottom;
        var config = {};
        (curves || []).forEach(function (c) { config[c.tagId] = c; });
        var xMin = Infinity, xMax = -Infinity;
        lines.forEach(function (l) { l.points.forEach(function (p) { xMin = Math.min(xMin, p.x); xMax = Math.max(xMax, p.x); }); });
        if (xRange) { xMin = xRange.min; xMax = xRange.max; }
        if (xMin === Infinity) { xMin = 0; xMax = 1; }
        if (xMin === xMax) { xMin -= 1; xMax += 1; }
        if (!xRange) { var px = (xMax - xMin) * 0.03; xMin -= px; xMax += px; }
        var axes = { gauche: { min: Infinity, max: -Infinity }, droite: { min: Infinity, max: -Infinity } };
        var drawn = lines.map(function (l, i) {
            var c = config[l.id] || {};
            var axis = c.axis === 'droite' ? 'droite' : 'gauche';
            var points = l.points.filter(function (p) { return p.x >= xMin && p.x <= xMax; });
            points.forEach(function (p) {
                axes[axis].min = Math.min(axes[axis].min, p.y);
                axes[axis].max = Math.max(axes[axis].max, p.y);
            });
            return { points: points, axis: axis, color: c.color || ['#1565C0', '#E65100', '#2E7D32', '#C62828', '#6A1B9A'][i % 5] };
        });
        Object.keys(axes).forEach(function (k) {
            var a = axes[k];
            if (a.min === Infinity) { a.min = 0; a.max = 1; }
            if (a.min === a.max) { a.min -= 1; a.max += 1; }
            var pad = (a.max - a.min) * 0.05;
            a.min -= pad; a.max += pad;
        });
        var x = function (v) { return margin.left + (v - xMin) / (xMax - xMin) * plotW; };
        var y = function (v, axis) { var a = axes[axis]; return margin.top + plotH - (v - a.min) / (a.max - a.min) * plotH; };
        ctx.strokeStyle = '#ddd';
        ctx.fillStyle = '#555';
        ctx.font = '11px Arial';
        ctx.lineWidth = 1;
        for (var i = 0; i <= 5; i++) {
            var gy = margin.top + plotH * i / 5;
            ctx.beginPath(); ctx.moveTo(margin.left, gy); ctx.lineTo(margin.left + plotW, gy); ctx.stroke();
            ctx.textAlign = 'right';
            ctx.fillText(round(axes.gauche.max - (axes.gauche.max - axes.gauche.min) * i / 5), margin.left - 6, gy + 4);
            if (drawn.some(function (l) { return l.axis === 'droite'; })) {
                ctx.textAlign = 'left';
                ctx.fillText(round(axes.droite.max - (axes.droite.max - axes.droite.min) * i / 5), margin.left + plotW + 6, gy + 4);
            }
        }
        ctx.textAlign = 'center';
        var ticks = Math.max(2, Math.min(10, Math.floor(plotW / 90)));
        for (var j = 0; j <= ticks; j++) {
            var v = xMin + (xMax - xMin) * j / ticks;
            var gx = x(v);
            ctx.beginPath(); ctx.moveTo(gx, margin.top); ctx.lineTo(gx, margin.top + plotH); ctx.stroke();
            ctx.fillText(round(v), gx, margin.top + plotH + 16);
        }
        ctx.font = 'bold 12px Arial';
        ctx.fillStyle = '#333';
        ctx.fillText(xLabel || 'X', margin.left + plotW / 2, height - 6);
        ctx.strokeStyle = '#888';
        ctx.strokeRect(margin.left, margin.top, plotW, plotH);
        drawn.forEach(function (l) {
            ctx.fillStyle = l.color;
            l.points.forEach(function (p) {
                ctx.beginPath();
                ctx.arc(x(p.x), y(p.y, l.axis), 2.2, 0, 2 * Math.PI);
                ctx.fill();
            });
        });
        // area of the points, for the zoom with the mouse (values of the axis X)
        canvas._chart = { from: xMin, to: xMax, left: margin.left, top: margin.top, width: plotW, height: plotH };
        return drawn.map(function (l) { return l.points.length; });
    }

    function round(v) {
        return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
    }

    /** 1, 2, 2.5 or 5 x 10^n, the first one >= raw */
    function niceStep(raw) {
        if (!(raw > 0) || !isFinite(raw)) {
            return 1;
        }
        var exp = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
        var f = raw / exp;
        return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp;
    }

    /** decimals needed to write the multiples of step */
    function stepDecimals(step) {
        var d = 0;
        while (d < 8 && Math.abs(Math.round(step * Math.pow(10, d)) - step * Math.pow(10, d)) > 1e-6) {
            d++;
        }
        return d;
    }

    /**
     * automatic scale of an axis: limits of the data with a margin, rounded to the graduations
     * manualMin / manualMax (null: automatic) are kept as they are; constant values get a range around the value;
     * no data: 0 to 1
     * @returns { min, max, step, ticks: [values], decimals }
     */
    function niceScale(dataMin, dataMax, manualMin, manualMax, count) {
        var hasMin = manualMin !== null && manualMin !== undefined && isFinite(manualMin);
        var hasMax = manualMax !== null && manualMax !== undefined && isFinite(manualMax);
        if (hasMin && hasMax && manualMin >= manualMax) {
            hasMin = hasMax = false;
        }
        var lo = dataMin, hi = dataMax;
        if (!isFinite(lo) || !isFinite(hi)) {
            lo = 0; hi = 1;
        }
        if (hasMin) { lo = manualMin; if (!hasMax && hi <= lo) { hi = lo + Math.max(Math.abs(lo) * 0.1, 1); } }
        if (hasMax) { hi = manualMax; if (!hasMin && lo >= hi) { lo = hi - Math.max(Math.abs(hi) * 0.1, 1); } }
        if (hi === lo) {
            var d = Math.abs(hi) * 0.1 || 1;
            lo -= d; hi += d;
        } else {
            var pad = (hi - lo) * 0.05;
            if (!hasMin) { lo -= pad; }
            if (!hasMax) { hi += pad; }
        }
        var step = niceStep((hi - lo) / Math.max(count || 5, 2));
        if (!hasMin) { lo = Math.floor(lo / step + 1e-9) * step; }
        if (!hasMax) { hi = Math.ceil(hi / step - 1e-9) * step; }
        var ticks = [];
        for (var v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-6 && ticks.length < 50; v += step) {
            ticks.push(Math.round(v / step) * step);
        }
        return { min: lo, max: hi, step: step, ticks: ticks, decimals: stepDecimals(step) };
    }

    /** number with the decimals, - for the negative numbers close to 0 */
    function formatNumber(v, decimals) {
        var text = Number(v).toFixed(Math.min(Math.max(decimals, 0), 8));
        return /^-0(\.0*)?$/.test(text) ? text.slice(1) : text;
    }

    function trimZeros(text) {
        return text.indexOf('.') < 0 ? text : text.replace(/0+$/, '').replace(/\.$/, '');
    }

    var TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800, 2592000]
        .map(function (s) { return s * 1000; });

    /** graduations of a time axis, at round local times (every 5 min, 1 h, 1 day...) */
    function timeTicks(from, to, count) {
        var raw = (to - from) / Math.max(count, 2);
        var step = TIME_STEPS.filter(function (s) { return s >= raw; })[0] || TIME_STEPS[TIME_STEPS.length - 1];
        var offset = new Date(from).getTimezoneOffset() * 60000;
        var ticks = [];
        for (var t = Math.ceil((from - offset) / step) * step + offset; t <= to && ticks.length < 60; t += step) {
            ticks.push(t);
        }
        var label = function (t) {
            var text = formatDate(t, step < 60000);
            if (step >= 86400000) { return text.slice(0, 5); }
            return to - from > 86400000 ? text.slice(0, 5) + ' ' + text.slice(11) : text.slice(11);
        };
        return { ticks: ticks, step: step, label: label };
    }

    /**
     * graph of the page Courbes on a canvas
     * options: {
     *   mode: 'temps' | 'xy', from, to (temps: period shown),
     *   xMin, xMax (xy: limits of the axis X, null: automatic), xLabel, xUnit,
     *   series: [{ id, label, color, unit, min, max, decimals, hidden, points: [{ x, y, t }] }] (temps: x = t),
     *   grid, gap (temps: ms without value that cuts the line)
     * }
     * The series with the same unit share an axis Y; each other series has its own axis (left, right, left...).
     * @returns { counts: number of points shown for each series }
     */
    function plot(canvas, options) {
        var ctx = canvas.getContext('2d');
        var ratio = window.devicePixelRatio || 1;
        var width = canvas.clientWidth, height = canvas.clientHeight;
        canvas.width = width * ratio;
        canvas.height = height * ratio;
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.clearRect(0, 0, width, height);
        var xy = options.mode === 'xy';
        var all = options.series || [];
        var visible = all.filter(function (s) { return !s.hidden; });

        // axis X
        var xScale;
        if (xy) {
            var xLo = Infinity, xHi = -Infinity;
            visible.forEach(function (s) { s.points.forEach(function (p) { if (p.x < xLo) { xLo = p.x; } if (p.x > xHi) { xHi = p.x; } }); });
            xScale = niceScale(xLo, xHi, options.xMin, options.xMax, Math.max(2, Math.floor((width - 140) / 90)));
        } else {
            xScale = { min: options.from, max: options.to };
        }
        var inX = function (p) { return p.x >= xScale.min && p.x <= xScale.max; };

        // axes Y: one per unit, or per series without unit
        var axes = [], byKey = {};
        visible.forEach(function (s) {
            var key = s.unit ? 'u:' + s.unit : 's:' + s.id;
            var axis = byKey[key];
            if (!axis) {
                axis = byKey[key] = { key: key, series: [], lo: Infinity, hi: -Infinity, min: null, max: null, unit: s.unit || '' };
                axes.push(axis);
            }
            axis.series.push(s);
            if (axis.min === null && s.min !== null && s.min !== undefined && s.min !== '') { axis.min = Number(s.min); }
            if (axis.max === null && s.max !== null && s.max !== undefined && s.max !== '') { axis.max = Number(s.max); }
            s.points.forEach(function (p) {
                if (inX(p)) {
                    if (p.y < axis.lo) { axis.lo = p.y; }
                    if (p.y > axis.hi) { axis.hi = p.y; }
                }
            });
        });
        var AXIS_W = 62;
        var nLeft = Math.ceil(axes.length / 2) || 1, nRight = Math.floor(axes.length / 2);
        var margin = { left: 10 + AXIS_W * nLeft, right: nRight ? 10 + AXIS_W * nRight : 24, top: 26, bottom: xy ? 46 : 32 };
        var plotW = Math.max(width - margin.left - margin.right, 40), plotH = Math.max(height - margin.top - margin.bottom, 40);
        var yCount = Math.max(2, Math.floor(plotH / 45));
        axes.forEach(function (a, i) {
            a.scale = niceScale(a.lo, a.hi, a.min, a.max, yCount);
            a.side = i % 2 === 0 ? 'left' : 'right';
            var level = Math.floor(i / 2);
            a.pos = a.side === 'left' ? margin.left - level * AXIS_W : margin.left + plotW + level * AXIS_W;
            a.color = a.series.length === 1 ? a.series[0].color : '#333';
            a.title = a.unit || (a.series.length === 1 ? a.series[0].label : '');
            a.series.forEach(function (s) {
                s.axis = a;
                // decimals of the values (mouse): chosen, else the graduations + 2 without the zeros at the end
                s.decimalsShown = s.decimals !== null && s.decimals !== undefined && s.decimals !== '' ? Number(s.decimals) : null;
                s.autoDecimals = a.scale.decimals + 2;
            });
        });
        var px = function (v) { return margin.left + (v - xScale.min) / (xScale.max - xScale.min) * plotW; };
        var py = function (v, a) { return margin.top + plotH - (v - a.scale.min) / (a.scale.max - a.scale.min) * plotH; };

        ctx.font = '11px Arial';
        ctx.lineWidth = 1;
        // grid: graduations of the first axis Y and of the axis X
        var xTicks = xy ? null : timeTicks(xScale.min, xScale.max, Math.max(2, Math.floor(plotW / 110)));
        var xValues = xy ? xScale.ticks : xTicks.ticks;
        if (options.grid !== false) {
            ctx.strokeStyle = '#e3e3e3';
            if (axes.length) {
                axes[0].scale.ticks.forEach(function (v) {
                    var gy = Math.round(py(v, axes[0])) + 0.5;
                    ctx.beginPath(); ctx.moveTo(margin.left, gy); ctx.lineTo(margin.left + plotW, gy); ctx.stroke();
                });
            }
            xValues.forEach(function (v) {
                var gx = Math.round(px(v)) + 0.5;
                ctx.beginPath(); ctx.moveTo(gx, margin.top); ctx.lineTo(gx, margin.top + plotH); ctx.stroke();
            });
        }
        // graduations of the axis X
        ctx.fillStyle = '#555';
        ctx.textAlign = 'center';
        xValues.forEach(function (v) {
            ctx.fillText(xy ? formatNumber(v, xScale.decimals) : xTicks.label(v), px(v), margin.top + plotH + 15);
        });
        if (xy) {
            ctx.font = 'bold 12px Arial';
            ctx.fillStyle = '#333';
            ctx.fillText((options.xLabel || 'X') + (options.xUnit ? ' (' + options.xUnit + ')' : ''), margin.left + plotW / 2, height - 8);
            ctx.font = '11px Arial';
        }
        // axes Y with their graduations, in the color of their series
        axes.forEach(function (a) {
            var left = a.side === 'left';
            ctx.strokeStyle = a.color;
            ctx.beginPath(); ctx.moveTo(a.pos + 0.5, margin.top); ctx.lineTo(a.pos + 0.5, margin.top + plotH); ctx.stroke();
            ctx.fillStyle = a.color;
            ctx.textAlign = left ? 'right' : 'left';
            a.scale.ticks.forEach(function (v) {
                var y = py(v, a);
                ctx.beginPath(); ctx.moveTo(a.pos, y); ctx.lineTo(a.pos + (left ? -4 : 4), y); ctx.stroke();
                ctx.fillText(formatNumber(v, a.scale.decimals), a.pos + (left ? -6 : 6), y + 4);
            });
            ctx.font = 'bold 11px Arial';
            var title = a.title.length > 12 ? a.title.slice(0, 11) + '…' : a.title;
            ctx.fillText(title, a.pos + (left ? -2 : 2), margin.top - 10);
            ctx.font = '11px Arial';
        });
        ctx.strokeStyle = '#999';
        ctx.strokeRect(margin.left + 0.5, margin.top + 0.5, plotW, plotH);

        // series, inside the area of the graph
        ctx.save();
        ctx.beginPath();
        ctx.rect(margin.left, margin.top, plotW, plotH);
        ctx.clip();
        var counts = {};
        visible.forEach(function (s) {
            var a = s.axis, n = 0;
            ctx.strokeStyle = s.color;
            ctx.fillStyle = s.color;
            if (xy) {
                s.points.forEach(function (p) {
                    if (!inX(p)) { return; }
                    n++;
                    ctx.beginPath();
                    ctx.arc(px(p.x), py(p.y, a), 2.4, 0, 2 * Math.PI);
                    ctx.fill();
                });
            } else {
                ctx.lineWidth = 1.8;
                var gap = gapOf(s.points, options.gap);
                var run = [];
                var flush = function () {
                    if (run.length === 1) {
                        ctx.beginPath(); ctx.arc(run[0][0], run[0][1], 2, 0, 2 * Math.PI); ctx.fill();
                    } else if (run.length > 1) {
                        ctx.beginPath();
                        run.forEach(function (q, k) { if (k) { ctx.lineTo(q[0], q[1]); } else { ctx.moveTo(q[0], q[1]); } });
                        ctx.stroke();
                    }
                    run = [];
                };
                s.points.forEach(function (p, k) {
                    if (k && p.x - s.points[k - 1].x > gap) { flush(); }
                    if (p.x >= xScale.min && p.x <= xScale.max) { n++; }
                    run.push([px(p.x), py(p.y, a)]);
                });
                flush();
                s.gap = gap;
            }
            counts[s.id] = n;
        });
        ctx.restore();
        if (!visible.some(function (s) { return counts[s.id]; })) {
            ctx.fillStyle = '#888';
            ctx.font = '14px Arial';
            ctx.textAlign = 'center';
            ctx.fillText(visible.length ? 'Aucune donnée sur cette période' : 'Toutes les séries sont masquées', margin.left + plotW / 2, margin.top + plotH / 2);
        }
        // for the zoom and the values under the mouse
        canvas._chart = {
            from: xScale.min, to: xScale.max, left: margin.left, top: margin.top, width: plotW, height: plotH,
            mode: xy ? 'xy' : 'temps', series: visible, px: px, py: py, xDecimals: xy ? xScale.decimals + 2 : 0,
            xLabel: options.xLabel, xUnit: options.xUnit || ''
        };
        return { counts: counts };
    }

    /** time without value that cuts the line: 10 times the usual step between 2 values, 5 minutes at least */
    function gapOf(points, gap) {
        if (gap) {
            return gap;
        }
        var steps = [];
        for (var i = 1; i < points.length; i++) { steps.push(points[i].x - points[i - 1].x); }
        steps.sort(function (a, b) { return a - b; });
        var median = steps.length ? steps[Math.floor(steps.length / 2)] : 0;
        return Math.max(median * 10, 300000);
    }

    /** index of the point with x closest to value (points sorted by x) */
    function nearest(points, value) {
        var lo = 0, hi = points.length - 1;
        if (hi < 0) { return -1; }
        while (hi - lo > 1) {
            var mid = (lo + hi) >> 1;
            if (points[mid].x < value) { lo = mid; } else { hi = mid; }
        }
        return Math.abs(points[lo].x - value) <= Math.abs(points[hi].x - value) ? lo : hi;
    }

    function escapeText(t) {
        return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
    }

    /**
     * exact values under the mouse (graph drawn by plot): temps: the value of each series at this time,
     * xy: the closest point; enabled() says if the graph shows the values
     */
    function enableTooltip(canvas, enabled) {
        var parent = canvas.parentNode;
        var tip = document.createElement('div');
        tip.style.cssText = 'position:absolute;display:none;pointer-events:none;background:rgba(255,255,255,0.96);border:1px solid #999;border-radius:4px;' +
            'padding:6px 8px;font:12px Arial;color:#222;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,0.2);z-index:5';
        var line = document.createElement('div');
        line.style.cssText = 'position:absolute;display:none;pointer-events:none;width:0;border-left:1px dashed #607D8B';
        parent.appendChild(line);
        parent.appendChild(tip);
        var dots = [];
        function dot(i) {
            if (!dots[i]) {
                dots[i] = document.createElement('div');
                dots[i].style.cssText = 'position:absolute;pointer-events:none;width:8px;height:8px;margin:-5px 0 0 -5px;border-radius:50%;border:1px solid #fff';
                parent.appendChild(dots[i]);
            }
            return dots[i];
        }
        function hide() {
            tip.style.display = 'none';
            line.style.display = 'none';
            dots.forEach(function (d) { d.style.display = 'none'; });
        }
        function value(s, v) {
            var text = s.decimalsShown === null ? trimZeros(formatNumber(v, s.autoDecimals)) : formatNumber(v, s.decimalsShown);
            return text + (s.unit ? ' ' + escapeText(s.unit) : '');
        }
        canvas.addEventListener('mouseleave', hide);
        canvas.addEventListener('mousemove', function (e) {
            var c = canvas._chart;
            var r = canvas.getBoundingClientRect();
            var mx = e.clientX - r.left, my = e.clientY - r.top;
            if (!c || (enabled && !enabled()) || e.buttons || mx < c.left || mx > c.left + c.width || my < c.top || my > c.top + c.height) {
                hide();
                return;
            }
            var html = '', shown = 0;
            dots.forEach(function (d) { d.style.display = 'none'; });
            if (c.mode === 'xy') {
                var best = null;
                c.series.forEach(function (s) {
                    s.points.forEach(function (p) {
                        var d = Math.pow(c.px(p.x) - mx, 2) + Math.pow(c.py(p.y, s.axis) - my, 2);
                        if (d < 144 && (!best || d < best.d)) { best = { d: d, s: s, p: p }; }
                    });
                });
                if (!best) { hide(); return; }
                html = '<b style="color:' + best.s.color + '">' + escapeText(best.s.label) + '</b><br>' +
                    escapeText(c.xLabel || 'X') + ' : ' + trimZeros(formatNumber(best.p.x, c.xDecimals)) + (c.xUnit ? ' ' + escapeText(c.xUnit) : '') + '<br>' +
                    escapeText(best.s.label) + ' : ' + value(best.s, best.p.y) + '<br><span style="color:#777">' + formatDate(best.p.t, true) + '</span>';
                var d0 = dot(0);
                d0.style.background = best.s.color;
                d0.style.left = (canvas.offsetLeft + c.px(best.p.x)) + 'px';
                d0.style.top = (canvas.offsetTop + c.py(best.p.y, best.s.axis)) + 'px';
                d0.style.display = 'block';
                line.style.display = 'none';
            } else {
                var t = c.from + (mx - c.left) / c.width * (c.to - c.from);
                html = '<b>' + formatDate(t, true) + '</b>';
                c.series.forEach(function (s, i) {
                    var k = nearest(s.points, t);
                    var p = k >= 0 ? s.points[k] : null;
                    // no value close to this time (missing data): -
                    var ok = p && Math.abs(p.x - t) <= Math.max(s.gap || 0, (c.to - c.from) / c.width * 8);
                    html += '<br><i style="display:inline-block;width:10px;height:10px;background:' + s.color + ';margin-right:5px"></i>' +
                        escapeText(s.label) + ' : ' + (ok ? value(s, p.y) : '—');
                    if (ok) {
                        shown++;
                        var d = dot(i);
                        d.style.background = s.color;
                        d.style.left = (canvas.offsetLeft + c.px(p.x)) + 'px';
                        d.style.top = (canvas.offsetTop + c.py(p.y, s.axis)) + 'px';
                        d.style.display = 'block';
                    }
                });
                line.style.left = (canvas.offsetLeft + mx) + 'px';
                line.style.top = (canvas.offsetTop + c.top) + 'px';
                line.style.height = c.height + 'px';
                line.style.display = 'block';
            }
            tip.innerHTML = html;
            tip.style.display = 'block';
            var left = canvas.offsetLeft + mx + 14;
            if (left + tip.offsetWidth > canvas.offsetLeft + canvas.clientWidth) { left = canvas.offsetLeft + mx - 14 - tip.offsetWidth; }
            tip.style.left = left + 'px';
            tip.style.top = (canvas.offsetTop + Math.max(c.top, my - tip.offsetHeight - 10)) + 'px';
        });
    }

    /** table of the history: one row per time, one column per tag */
    function historyTable(data, labels) {
        var times = {};
        data.series.forEach(function (s, col) {
            s.values.forEach(function (p) {
                times[p.t] = times[p.t] || [];
                times[p.t][col] = p.v;
            });
        });
        var head = ['Date / Heure'].concat(data.series.map(function (s) { return (labels && labels[s.id]) || s.name; }));
        var rows = Object.keys(times).map(Number).sort(function (a, b) { return b - a; }).map(function (t) {
            var row = [formatDate(t, true)];
            data.series.forEach(function (s, col) {
                var v = times[t][col];
                row.push(v === undefined || v === null ? '' : v);
            });
            return row;
        });
        return { head: head, rows: rows };
    }

    /** value for an input datetime-local (local time) */
    function inputValue(ms) {
        var d = new Date(ms);
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    /**
     * zoom with the mouse: the user selects a period on the chart (drag), onZoom(from, to) is called with the period (ms)
     * the parent of the canvas must have position: relative (the selection is drawn over the canvas)
     */
    function enableZoom(canvas, onZoom) {
        var box = document.createElement('div');
        box.style.cssText = 'position:absolute;display:none;background:rgba(30,136,229,0.18);border:1px solid #1e88e5;pointer-events:none';
        canvas.parentNode.appendChild(box);
        canvas.style.cursor = 'crosshair';
        var start = null;
        function offset(e) {
            var r = canvas.getBoundingClientRect();
            return { x: e.clientX - r.left, y: e.clientY - r.top, r: r };
        }
        function clamp(c, x) {
            return Math.min(Math.max(x, c.left), c.left + c.width);
        }
        canvas.addEventListener('mousedown', function (e) {
            var c = canvas._chart, p = offset(e);
            if (!c || e.button !== 0 || p.x < c.left || p.x > c.left + c.width) { return; }
            start = p.x;
            box.style.left = (canvas.offsetLeft + p.x) + 'px';
            box.style.top = (canvas.offsetTop + c.top) + 'px';
            box.style.height = c.height + 'px';
            box.style.width = '0px';
            box.style.display = 'block';
            e.preventDefault();
        });
        window.addEventListener('mousemove', function (e) {
            if (start === null) { return; }
            var c = canvas._chart, x = clamp(c, offset(e).x);
            box.style.left = (canvas.offsetLeft + Math.min(start, x)) + 'px';
            box.style.width = Math.abs(x - start) + 'px';
        });
        window.addEventListener('mouseup', function (e) {
            if (start === null) { return; }
            var c = canvas._chart, x = clamp(c, offset(e).x);
            var x1 = Math.min(start, x), x2 = Math.max(start, x);
            start = null;
            box.style.display = 'none';
            if (x2 - x1 < 5) { return; }
            // time (ms) of a chart in function of the time, value of the axis X of a XY chart
            var t = function (px) { return c.from + (px - c.left) / c.width * (c.to - c.from); };
            onZoom(t(x1), t(x2));
        });
    }

    /**
     * picture of the chart with its title and its legend
     * @param legend [{ label, color }]
     * @returns canvas (white background)
     */
    function chartPicture(canvas, title, subtitle, legend) {
        var ratio = canvas.width / canvas.clientWidth;
        var w = canvas.clientWidth, h = canvas.clientHeight;
        var out = document.createElement('canvas');
        var head = (title ? 30 : 0) + (subtitle ? 20 : 0) + 26;
        out.width = w * ratio;
        out.height = (h + head + 8) * ratio;
        var ctx = out.getContext('2d');
        ctx.scale(ratio, ratio);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h + head + 8);
        var y = 8;
        if (title) {
            ctx.fillStyle = '#1f3864';
            ctx.font = 'bold 18px Arial';
            ctx.fillText(title, 10, y + 18);
            y += 30;
        }
        if (subtitle) {
            ctx.fillStyle = '#555';
            ctx.font = '13px Arial';
            ctx.fillText(subtitle, 10, y + 13);
            y += 20;
        }
        ctx.font = '12px Arial';
        var x = 10;
        (legend || []).forEach(function (l) {
            ctx.fillStyle = l.color;
            ctx.fillRect(x, y + 6, 22, 4);
            ctx.fillStyle = '#222';
            ctx.fillText(l.label, x + 28, y + 12);
            x += 40 + ctx.measureText(l.label).width;
        });
        ctx.drawImage(canvas, 0, head, w, h);
        return out;
    }

    function download(blob, name) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }

    function savePicture(picture, name) {
        picture.toBlob(function (blob) { download(blob, name); }, 'image/png');
    }

    /**
     * Excel or PDF file made by the server (/api/export/xlsx or /pdf of the site)
     * body: { title, subtitle, fileName, series: [{ label, values: [{ t, v }] }], image (PDF: data URL JPEG) }
     */
    function exportFile(kind, body, name) {
        body.tzOffset = new Date().getTimezoneOffset();
        var url = base.replace(/\/api\/site$/, '/api/export/') + kind;
        return fetch(url, { method: 'POST', headers: headers(true), body: JSON.stringify(body) }).then(function (res) {
            if (!res.ok) {
                return res.json().then(function (b) { throw new Error(b && b.message ? b.message : 'Erreur ' + res.status); });
            }
            return res.blob();
        }).then(function (blob) { download(blob, name); });
    }

    window.SiteApi = {
        base: base,
        info: info,
        values: values,
        history: history,
        saveCurves: saveCurves,
        graphs: graphs,
        saveGraphs: saveGraphs,
        numbers: numbers,
        plot: plot,
        enableTooltip: enableTooltip,
        niceScale: niceScale,
        formatNumber: formatNumber,
        download: download,
        drawChart: drawChart,
        pairXY: pairXY,
        drawXY: drawXY,
        enableZoom: enableZoom,
        chartPicture: chartPicture,
        savePicture: savePicture,
        exportFile: exportFile,
        historyTable: historyTable,
        formatDate: formatDate,
        inputValue: inputValue
    };
})();
