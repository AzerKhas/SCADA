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

    function history(options) {
        options = options || {};
        return get('/history', {
            tags: (options.tags || []).join(','),
            from: time(options.from),
            to: time(options.to),
            maxPoints: options.maxPoints
        });
    }

    function saveCurves(curves) {
        return fetch(base + '/curves', { method: 'PUT', headers: headers(true), body: JSON.stringify({ curves: curves }) }).then(answer);
    }

    function pad(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function formatDate(ms, withSeconds) {
        var d = new Date(ms);
        return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) +
            (withSeconds ? ':' + pad(d.getSeconds()) : '');
    }

    function numbers(series) {
        return series.values.filter(function (p) { return typeof p.v === 'number' || (p.v !== null && p.v !== '' && !isNaN(Number(p.v))); })
            .map(function (p) { return { t: p.t, v: typeof p.v === 'boolean' ? (p.v ? 1 : 0) : Number(p.v) }; });
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

    function round(v) {
        return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
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

    window.SiteApi = {
        base: base,
        info: info,
        values: values,
        history: history,
        saveCurves: saveCurves,
        drawChart: drawChart,
        historyTable: historyTable,
        formatDate: formatDate,
        inputValue: inputValue
    };
})();
