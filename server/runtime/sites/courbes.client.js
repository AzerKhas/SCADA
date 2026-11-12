/**
 * custom-SCADA: courbes.js, page Courbes of a site (courbes.html): one card per graph configured in configuration.html
 * (SiteApi.graphs), each graph with its period, its zoom, its bar to slide the period, its exports and the values under the mouse.
 * Needs site-api.js; the page has <div id="graphs-app" data-site="name">.
 */
(function () {
    'use strict';

    var app = document.getElementById('graphs-app');
    var siteName = app.getAttribute('data-site') || '';
    var cards = [];
    var HOUR = 3600000;

    function esc(t) {
        return String(t === null || t === undefined ? '' : t).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c];
        });
    }

    function status(el, text, error) {
        el.textContent = text;
        el.className = 'status' + (error ? ' error' : '');
    }

    function intervalText(s) {
        if (!s) { return 'toutes les valeurs'; }
        if (s % 86400 === 0) { return 'moyenne par ' + (s / 86400) + ' j'; }
        if (s % 3600 === 0) { return 'moyenne par ' + (s / 3600) + ' h'; }
        if (s % 60 === 0) { return 'moyenne par ' + (s / 60) + ' min'; }
        return 'moyenne par ' + s + ' s';
    }

    /** period of a graph from its configuration: last n hours, or fixed dates */
    function configPeriod(cfg) {
        if (cfg.mode !== 'xy' && cfg.period && cfg.period.type === 'fixed') {
            return { from: Date.parse(cfg.period.from), to: Date.parse(cfg.period.to) };
        }
        var now = Date.now();
        return { from: now - ((cfg.period && cfg.period.hours) || 8) * HOUR, to: now };
    }

    // ---------------------------------------------------------------- page
    app.innerHTML =
        '<div class="period">' +
        '  <b>Tous les graphiques :</b>' +
        '  <label>Du <input type="datetime-local" id="all-from"></label>' +
        '  <label>Au <input type="datetime-local" id="all-to"></label>' +
        '  <button data-hours="1">1 h</button><button data-hours="8">8 h</button><button data-hours="24">24 h</button><button data-hours="168">7 j</button>' +
        '  <button id="all-apply" class="primary">Appliquer à tous</button>' +
        '  <span style="flex:1"></span><a href="configuration.html#graphes">Configurer les graphiques</a>' +
        '</div>' +
        '<p class="info">Zoom : sélectionner une partie du graphique avec la souris. Déplacement : glisser la barre sous le graphique. ' +
        'Valeurs exactes : passer la souris sur le graphique. Cliquer sur une série de la légende pour l’afficher ou la masquer.</p>' +
        '<p id="all-status" class="status">Chargement...</p>' +
        '<div id="graphs"></div>';
    var allFrom = document.getElementById('all-from'), allTo = document.getElementById('all-to');
    var allStatus = document.getElementById('all-status');

    function applyAll(from, to) {
        if (!(from < to)) {
            status(allStatus, 'Période invalide : la date de début doit être avant la date de fin.', true);
            return;
        }
        cards.forEach(function (g) {
            g.home = { from: from, to: to };
            g.zooms = [];
            g.xRange = null;
            load(g, from, to);
        });
    }
    app.querySelectorAll('[data-hours]').forEach(function (b) {
        b.addEventListener('click', function () {
            var now = Date.now(), from = now - Number(b.getAttribute('data-hours')) * HOUR;
            allFrom.value = SiteApi.inputValue(from);
            allTo.value = SiteApi.inputValue(now);
            applyAll(from, now);
        });
    });
    document.getElementById('all-apply').addEventListener('click', function () {
        applyAll(new Date(allFrom.value).getTime(), new Date(allTo.value).getTime());
    });

    // ---------------------------------------------------------------- one graph
    function createCard(cfg, index) {
        var el = document.createElement('div');
        el.className = 'graph-card';
        var xy = cfg.mode === 'xy';
        var names = cfg.series.map(function (s) { return s.label || s.name; }).join(', ');
        el.innerHTML =
            '<div class="graph-head">' +
            '  <h3>' + esc(cfg.title) + '</h3>' +
            '  <span class="status">' + (xy ? esc(names) + ' en fonction de ' + esc(cfg.xName) : 'en fonction du temps') + ' — ' + intervalText(cfg.interval) + '</span>' +
            '</div>' +
            '<div class="period">' +
            '  <label>Du <input type="datetime-local" data-f="from"></label>' +
            '  <label>Au <input type="datetime-local" data-f="to"></label>' +
            '  <button data-f="show" class="primary">Afficher</button>' +
            '  <button data-f="back" style="display:none" title="Revenir au zoom précédent">&#8630; Zoom précédent</button>' +
            '  <button data-f="reset" title="Revenir à la période du graphique et aux échelles automatiques">&#8634; Réinitialiser</button>' +
            '  <span style="flex:1"></span>' +
            '  <button data-f="xlsx">Excel</button><button data-f="png">Image</button><button data-f="pdf">PDF</button>' +
            '</div>' +
            '<div class="legend" data-f="legend"></div>' +
            '<div style="position:relative"><canvas class="chart"></canvas></div>' +
            '<div class="pan-bar" data-f="bar" title="Glisser pour déplacer la période affichée"><div class="pan-thumb" data-f="thumb"></div></div>' +
            '<div class="pan-labels"><span data-f="bar-start"></span><span>Glisser la barre pour se déplacer dans le temps</span><span>maintenant</span></div>' +
            '<div class="status" data-f="status"></div>';
        var part = function (f) { return el.querySelector('[data-f="' + f + '"]'); };
        var home = configPeriod(cfg);
        var g = {
            cfg: cfg, index: index, el: el, part: part, canvas: el.querySelector('canvas'),
            home: home, from: home.from, to: home.to, data: null, zooms: [], xRange: null, hidden: {}, counts: {}
        };
        part('show').addEventListener('click', function () {
            var from = new Date(part('from').value).getTime(), to = new Date(part('to').value).getTime();
            if (!(from < to)) {
                status(part('status'), 'Période invalide : la date de début doit être avant la date de fin.', true);
                return;
            }
            g.home = { from: from, to: to };
            g.zooms = [];
            g.xRange = null;
            load(g, from, to);
        });
        part('reset').addEventListener('click', function () {
            g.zooms = [];
            g.xRange = null;
            load(g, g.home.from, g.home.to);
        });
        part('back').addEventListener('click', function () {
            var z = g.zooms.pop();
            if (!z) { return; }
            if (z.xRange !== undefined) {
                g.xRange = z.xRange;
                draw(g);
                return;
            }
            load(g, z.from, z.to);
        });
        part('legend').addEventListener('click', function (e) {
            var item = e.target.closest('[data-tag]');
            if (!item) { return; }
            var tag = item.getAttribute('data-tag');
            g.hidden[tag] = !g.hidden[tag];
            draw(g);
        });
        SiteApi.enableZoom(g.canvas, function (from, to) {
            if (!g.data) { return; }
            if (cfg.mode === 'xy') {
                // XY: zoom on a range of the axis X, with the same data
                g.zooms.push({ xRange: g.xRange });
                g.xRange = { min: from, max: to };
                draw(g);
                return;
            }
            g.zooms.push({ from: g.from, to: g.to });
            load(g, Math.round(from), Math.round(to));
        });
        SiteApi.enableTooltip(g.canvas, function () { return cfg.tooltip !== false; });
        g.bar = panBar(g);
        ['xlsx', 'pdf'].forEach(function (kind) { part(kind).addEventListener('click', function () { exportData(g, kind); }); });
        part('png').addEventListener('click', function () {
            if (!g.data) { return; }
            SiteApi.savePicture(SiteApi.chartPicture(g.canvas, cfg.title + ' - ' + siteName, periodText(g), legendItems(g)), fileName(g, 'png'));
        });
        return g;
    }

    function tagIds(g) {
        var ids = g.cfg.series.map(function (s) { return s.tag; });
        if (g.cfg.mode === 'xy' && ids.indexOf(g.cfg.xTag) < 0) { ids.push(g.cfg.xTag); }
        return ids;
    }

    function load(g, from, to) {
        g.from = from;
        g.to = to;
        g.part('from').value = SiteApi.inputValue(from);
        g.part('to').value = SiteApi.inputValue(to);
        var token = g.token = {};
        status(g.part('status'), 'Chargement...');
        return SiteApi.history({
            tags: tagIds(g), from: from, to: to, interval: g.cfg.interval,
            maxPoints: g.cfg.mode === 'xy' ? 20000 : 4000
        }).then(function (data) {
            if (token !== g.token) { return; }
            g.data = data;
            draw(g);
            g.bar.update();
            var total = data.series.reduce(function (n, s) { return n + s.count; }, 0);
            status(g.part('status'), total + ' valeurs enregistrées sur la période, source : ' + data.source +
                (g.cfg.interval ? ' (' + intervalText(g.cfg.interval) + ')' : ''));
        }).catch(function (err) {
            if (token === g.token) { status(g.part('status'), err.message, true); }
        });
    }

    /** series for SiteApi.plot from the history and the configuration */
    function plotSeries(g) {
        var cfg = g.cfg, data = g.data;
        var byId = {};
        if (cfg.mode === 'xy') {
            SiteApi.pairXY(data, cfg.xTag).forEach(function (s) { byId[s.id] = s.points; });
        } else {
            data.series.forEach(function (s) {
                byId[s.id] = SiteApi.numbers(s).map(function (p) { return { x: p.t, y: p.v, t: p.t }; });
            });
        }
        return cfg.series.filter(function (s) { return byId[s.tag]; }).map(function (s) {
            return {
                id: s.tag, label: s.label || s.name, color: s.color, unit: s.unit, min: s.min, max: s.max, decimals: s.decimals,
                hidden: !!g.hidden[s.tag], points: byId[s.tag]
            };
        });
    }

    function draw(g) {
        if (!g.data) { return; }
        var cfg = g.cfg;
        g.series = plotSeries(g);
        var result = SiteApi.plot(g.canvas, {
            mode: cfg.mode, from: g.from, to: g.to,
            xMin: g.xRange ? g.xRange.min : cfg.xMin, xMax: g.xRange ? g.xRange.max : cfg.xMax,
            xLabel: cfg.xName, xUnit: cfg.xUnit, series: g.series, grid: cfg.grid !== false,
            gap: cfg.interval ? cfg.interval * 3000 : 0
        });
        var legend = g.part('legend');
        legend.style.display = cfg.legend === false ? 'none' : '';
        legend.innerHTML = g.series.map(function (s) {
            return '<span data-tag="' + esc(s.id) + '" class="legend-item' + (s.hidden ? ' off' : '') + '" title="Cliquer pour afficher / masquer">' +
                '<i style="background:' + esc(s.color) + '"></i>' + esc(s.label) + (s.unit ? ' (' + esc(s.unit) + ')' : '') +
                ' <small>' + (s.hidden ? 'masquée' : (result.counts[s.id] || 0) + ' points') + '</small></span>';
        }).join('') + (cfg.mode === 'xy' ? '<span>axe X : ' + esc(cfg.xName) + (cfg.xUnit ? ' (' + esc(cfg.xUnit) + ')' : '') + '</span>' : '');
        g.part('back').style.display = g.zooms.length ? '' : 'none';
    }

    /**
     * bar under the graph: the track is the history (at least 7 days, or 10 periods) until now,
     * the thumb is the displayed period; drag it (or click the track) to slide the period, the data is loaded on release
     */
    function panBar(g) {
        var bar = g.part('bar'), thumb = g.part('thumb');
        var start = 0, end = 0, width = 0, from = 0, drag = null;
        function place() {
            var total = end - start;
            thumb.style.left = (100 * (from - start) / total) + '%';
            thumb.style.width = (100 * width / total) + '%';
        }
        function update() {
            from = g.from;
            width = g.to - g.from;
            end = Math.max(Date.now(), from + width);
            start = Math.min(from, end - Math.max(7 * 24 * HOUR, 10 * width));
            g.part('bar-start').textContent = SiteApi.formatDate(start, false);
            place();
        }
        function moveTo(newFrom) {
            from = Math.min(Math.max(newFrom, start), end - width);
            place();
            g.part('from').value = SiteApi.inputValue(from);
            g.part('to').value = SiteApi.inputValue(from + width);
        }
        bar.addEventListener('pointerdown', function (e) {
            if (!g.data) { return; }
            var rect = bar.getBoundingClientRect(), msPerPx = (end - start) / rect.width;
            if (e.target !== thumb) {
                // click on the track: the period is centered there
                moveTo(start + (e.clientX - rect.left) * msPerPx - width / 2);
            }
            drag = { x: e.clientX, from: from, msPerPx: msPerPx };
            thumb.style.cursor = 'grabbing';
            try { bar.setPointerCapture(e.pointerId); } catch (err) { /* synthetic event */ }
        });
        bar.addEventListener('pointermove', function (e) {
            if (drag) { moveTo(drag.from + (e.clientX - drag.x) * drag.msPerPx); }
        });
        function stop() {
            if (!drag) { return; }
            drag = null;
            thumb.style.cursor = 'grab';
            var f = Math.round(from);
            if (g.cfg.mode === 'xy') { g.xRange = null; g.zooms = []; }
            load(g, f, f + width);
        }
        bar.addEventListener('pointerup', stop);
        bar.addEventListener('pointercancel', stop);
        return { update: update };
    }

    // ---------------------------------------------------------------- exports
    function periodText(g) {
        var text = 'Période du ' + SiteApi.formatDate(g.from, true) + ' au ' + SiteApi.formatDate(g.to, true);
        if (g.cfg.mode === 'xy') {
            text = 'En fonction de ' + g.cfg.xName + (g.xRange ? ' (de ' + SiteApi.formatNumber(g.xRange.min, 3) + ' à ' + SiteApi.formatNumber(g.xRange.max, 3) + ')' : '') + ' - ' + text;
        }
        return text;
    }

    function legendItems(g) {
        return (g.series || []).filter(function (s) { return !s.hidden; }).map(function (s) {
            return { label: s.label + (s.unit ? ' (' + s.unit + ')' : ''), color: s.color };
        });
    }

    function fileName(g, ext) {
        var d = new Date(g.from);
        var p = function (n) { return (n < 10 ? '0' : '') + n; };
        var title = String(g.cfg.title).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'Graphique';
        return title + '_' + siteName + '_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + '.' + ext;
    }

    /**
     * series of the files: the values of the period (with the sampling of the graph), the hidden series are not exported
     * XY: the tag X (its value at the time of each point) then the tags Y, only the points of the zoomed range
     */
    function fileSeries(g, data) {
        var cfg = g.cfg;
        var shown = cfg.series.filter(function (s) { return !g.hidden[s.tag]; });
        var name = function (s) { return (s.label || s.name) + (s.unit ? ' (' + s.unit + ')' : ''); };
        if (cfg.mode !== 'xy') {
            return shown.map(function (s) {
                var serie = data.series.filter(function (x) { return x.id === s.tag; })[0];
                return { label: name(s), values: serie ? serie.values : [] };
            });
        }
        var pairs = {};
        SiteApi.pairXY(data, cfg.xTag).forEach(function (s) { pairs[s.id] = s.points; });
        var xMin = g.xRange ? g.xRange.min : cfg.xMin, xMax = g.xRange ? g.xRange.max : cfg.xMax;
        var inRange = function (pt) { return (xMin === null || xMin === undefined || pt.x >= xMin) && (xMax === null || xMax === undefined || pt.x <= xMax); };
        var xValues = {};
        shown.forEach(function (s) { (pairs[s.tag] || []).filter(inRange).forEach(function (pt) { xValues[pt.t] = pt.x; }); });
        var xSeries = {
            label: cfg.xName + (cfg.xUnit ? ' (' + cfg.xUnit + ')' : '') + ' (axe X)',
            values: Object.keys(xValues).map(function (t) { return { t: Number(t), v: xValues[t] }; })
        };
        return [xSeries].concat(shown.map(function (s) {
            return { label: name(s), values: (pairs[s.tag] || []).filter(inRange).map(function (pt) { return { t: pt.t, v: pt.y }; }) };
        }));
    }

    function exportData(g, kind) {
        if (!g.data) { return; }
        var st = g.part('status');
        status(st, 'Préparation du fichier ' + kind.toUpperCase() + '...');
        SiteApi.history({ tags: tagIds(g), from: g.from, to: g.to, interval: g.cfg.interval, maxPoints: 200000 }).then(function (data) {
            var body = {
                title: g.cfg.title + ' - ' + siteName, subtitle: periodText(g),
                fileName: fileName(g, kind).replace(/[.][a-z]+$/, ''), series: fileSeries(g, data)
            };
            if (kind === 'pdf') {
                body.image = SiteApi.chartPicture(g.canvas, '', '', legendItems(g)).toDataURL('image/jpeg', 0.92);
            }
            return SiteApi.exportFile(kind, body, fileName(g, kind));
        }).then(function () { status(st, 'Fichier ' + kind.toUpperCase() + ' créé.'); })
            .catch(function (err) { status(st, err.message, true); });
    }

    // ---------------------------------------------------------------- start
    var resizeTimer = null;
    window.addEventListener('resize', function () {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () { cards.forEach(draw); }, 150);
    });

    var now = Date.now();
    allFrom.value = SiteApi.inputValue(now - 8 * HOUR);
    allTo.value = SiteApi.inputValue(now);
    SiteApi.graphs().then(function (result) {
        var list = result.graphs || [];
        if (!list.length) {
            status(allStatus, 'Aucun graphique : les graphiques se configurent dans la page Configuration (section Graphiques de la page Courbes).', true);
            return;
        }
        status(allStatus, list.length + ' graphique(s)');
        var box = document.getElementById('graphs');
        cards = list.map(function (cfg, i) {
            var g = createCard(cfg, i);
            box.appendChild(g.el);
            return g;
        });
        cards.forEach(function (g) { load(g, g.from, g.to); });
    }).catch(function (err) { status(allStatus, err.message, true); });
})();
