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
            var t = function (px) { return Math.round(c.from + (px - c.left) / c.width * (c.to - c.from)); };
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
        drawChart: drawChart,
        enableZoom: enableZoom,
        chartPicture: chartPicture,
        savePicture: savePicture,
        exportFile: exportFile,
        historyTable: historyTable,
        formatDate: formatDate,
        inputValue: inputValue
    };
})();
