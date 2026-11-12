/**
 * custom-SCADA: configuration-graphes.js, configuration of the graphs of the page Courbes in configuration.html
 * (title, mode temps / XY, tags, units, colors, limits of the axes, period, sampling, legend, grid, values under the mouse).
 * Each change is saved with the API of the site (PUT graphs). Needs site-api.js; the page has <div id="graphs-editor">.
 */
(function () {
    'use strict';

    var root = document.getElementById('graphs-editor');
    var COLORS = ['#1565C0', '#E65100', '#2E7D32', '#C62828', '#6A1B9A', '#00838F', '#F9A825', '#4E342E', '#AD1457', '#37474F'];
    var PERIODS = [[1, '1 heure'], [8, '8 heures'], [24, '24 heures'], [168, '7 jours'], [720, '30 jours']];
    var INTERVALS = [[0, 'Toutes les valeurs'], [1, '1 s'], [5, '5 s'], [10, '10 s'], [30, '30 s'], [60, '1 min'], [300, '5 min'],
        [900, '15 min'], [3600, '1 h'], [86400, '1 jour']];
    var tags = [], graphs = [];

    function esc(t) {
        return String(t === null || t === undefined ? '' : t).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c];
        });
    }

    function newId() {
        return 'g' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
    }

    function tagName(id) {
        var t = tags.filter(function (x) { return x.id === id; })[0];
        return t ? t.name : id;
    }

    function freeColor(g) {
        var used = [];
        graphs.forEach(function (x) { x.series.forEach(function (s) { used.push(s.color.toLowerCase()); }); });
        var inGraph = g ? g.series.map(function (s) { return s.color.toLowerCase(); }) : [];
        return COLORS.filter(function (c) { return used.indexOf(c.toLowerCase()) < 0; })[0] ||
            COLORS.filter(function (c) { return inGraph.indexOf(c.toLowerCase()) < 0; })[0] || COLORS[0];
    }

    function newSeries(tagId, g) {
        return { tag: tagId, label: tagName(tagId), color: freeColor(g), unit: '', min: null, max: null, decimals: null };
    }

    function newGraph(tagId) {
        var g = {
            id: newId(), title: tagId ? tagName(tagId) : 'Nouveau graphique', mode: 'temps', xTag: null, xUnit: '', xMin: null, xMax: null,
            period: { type: 'relative', hours: 8 }, interval: 0, legend: true, grid: true, tooltip: true, series: []
        };
        if (tagId) { g.series.push(newSeries(tagId, g)); }
        return g;
    }

    // ---------------------------------------------------------------- page
    root.innerHTML =
        '<p class="info">Chaque graphique de la page Courbes a ses propres tags, son mode et ses échelles. Par défaut, un graphique par tag ; ' +
        'ajouter plusieurs tags dans un même graphique pour les comparer. Les tags avec la même unité partagent un axe Y, ' +
        'les autres ont chacun leur axe Y (échelles indépendantes). Min / Max vides : échelle automatique. ' +
        'Chaque changement est enregistré automatiquement ; les tags choisis sont enregistrés (historique) à partir de ce moment.</p>' +
        '<div class="period">' +
        '  <button data-a="add" class="primary">+ Nouveau graphique</button>' +
        '  <select data-a="add-tag-select"><option value="">Un graphique pour le tag...</option></select>' +
        '  <button data-a="add-tag">Créer</button>' +
        '  <span style="flex:1"></span>' +
        '  <a href="courbes.html">Voir la page Courbes</a>' +
        '  <span id="graphs-status" class="status"></span>' +
        '</div>' +
        '<div id="graphs-list"><p class="empty">Chargement...</p></div>';
    var list = document.getElementById('graphs-list');
    var statusEl = document.getElementById('graphs-status');

    function status(text, error) {
        statusEl.textContent = text;
        statusEl.className = 'status' + (error ? ' error' : '');
    }

    function options(values, selected) {
        return values.map(function (v) {
            return '<option value="' + esc(v[0]) + '"' + (String(v[0]) === String(selected) ? ' selected' : '') + '>' + esc(v[1]) + '</option>';
        }).join('');
    }

    function tagOptions(selected, empty) {
        return (empty ? '<option value="">' + esc(empty) + '</option>' : '') + tags.map(function (t) {
            return '<option value="' + esc(t.id) + '"' + (t.id === selected ? ' selected' : '') + '>' + esc(t.name) + ' (' + esc(t.device) + ')' + (t.recorded ? ' &#128339;' : '') + '</option>';
        }).join('');
    }

    function inputValue(iso) {
        return iso ? SiteApi.inputValue(Date.parse(iso)) : '';
    }

    function num(v) {
        return v === null || v === undefined ? '' : v;
    }

    function render() {
        if (!graphs.length) {
            list.innerHTML = '<p class="empty">Aucun graphique : cliquer sur « Nouveau graphique ».</p>';
            return;
        }
        list.innerHTML = graphs.map(function (g, gi) {
            var xy = g.mode === 'xy';
            var fixed = g.period.type === 'fixed';
            var a = function (f) { return 'data-g="' + gi + '" data-f="' + f + '"'; };
            var b = function (action, text, title, disabled) {
                return '<button data-g="' + gi + '" data-a="' + action + '"' + (title ? ' title="' + esc(title) + '"' : '') + (disabled ? ' disabled' : '') + '>' + text + '</button>';
            };
            return '<div class="graph-card">' +
                '<div class="graph-head"><h3>' + (gi + 1) + '. ' + esc(g.title) + '</h3><span style="flex:1"></span>' +
                b('up', '&#8593;', 'Monter', gi === 0) + b('down', '&#8595;', 'Descendre', gi === graphs.length - 1) +
                b('split', 'Séparer', 'Un graphique par tag', g.series.length < 2) + b('copy', 'Dupliquer') + b('remove', 'Supprimer') + '</div>' +
                '<div class="period">' +
                '  <label>Titre <input ' + a('title') + ' value="' + esc(g.title) + '" size="28"></label>' +
                '  <label>Mode <select ' + a('mode') + '>' + options([['temps', 'Paramètre(s) en fonction du temps'], ['xy', 'Paramètre(s) Y en fonction d’un paramètre X (nuage de points)']], g.mode) + '</select></label>' +
                '</div>' +
                (xy ? '<div class="period">' +
                    '  <label>Tag de l’axe X <select ' + a('xTag') + '>' + tagOptions(g.xTag, '(choisir)') + '</select></label>' +
                    '  <label>Unité X <input ' + a('xUnit') + ' value="' + esc(g.xUnit) + '" size="6"></label>' +
                    '  <label>X min <input type="number" step="any" ' + a('xMin') + ' value="' + num(g.xMin) + '" placeholder="auto" style="width:80px"></label>' +
                    '  <label>X max <input type="number" step="any" ' + a('xMax') + ' value="' + num(g.xMax) + '" placeholder="auto" style="width:80px"></label>' +
                    '</div>' : '') +
                '<div class="period">' +
                '  <label>Période ' + (xy ? '(valeurs utilisées) ' : '') + '<select ' + a('period') + '>' + options(PERIODS.map(function (p) { return ['h' + p[0], 'Dernières ' + p[1]]; })
                    .concat(xy ? [] : [['fixed', 'Dates fixes']]), fixed && !xy ? 'fixed' : 'h' + g.period.hours) + '</select></label>' +
                (fixed && !xy ? '  <label>Du <input type="datetime-local" ' + a('periodFrom') + ' value="' + inputValue(g.period.from) + '"></label>' +
                    '  <label>Au <input type="datetime-local" ' + a('periodTo') + ' value="' + inputValue(g.period.to) + '"></label>' : '') +
                '  <label>Échantillonnage <select ' + a('interval') + '>' + options(INTERVALS, g.interval) + '</select></label>' +
                '  <label><input type="checkbox" ' + a('legend') + (g.legend ? ' checked' : '') + '> Légende</label>' +
                '  <label><input type="checkbox" ' + a('grid') + (g.grid ? ' checked' : '') + '> Grille</label>' +
                '  <label><input type="checkbox" ' + a('tooltip') + (g.tooltip ? ' checked' : '') + '> Valeurs au survol</label>' +
                '</div>' +
                '<div style="overflow-x:auto"><table><thead><tr><th>Tag ' + (xy ? '(axe Y)' : '') + '</th><th>Libellé</th><th>Unité</th><th>Couleur</th><th>Min Y</th><th>Max Y</th><th>Décimales</th><th></th></tr></thead><tbody>' +
                g.series.map(function (s, si) {
                    var c = function (f) { return 'data-g="' + gi + '" data-s="' + si + '" data-f="' + f + '"'; };
                    return '<tr><td><select style="max-width:230px" ' + c('tag') + '>' + tagOptions(s.tag) + '</select></td>' +
                        '<td><input ' + c('label') + ' value="' + esc(s.label) + '" size="16"></td>' +
                        '<td><input ' + c('unit') + ' value="' + esc(s.unit) + '" size="6" placeholder="bar, m³/h..."></td>' +
                        '<td><input type="color" ' + c('color') + ' value="' + esc(s.color) + '"></td>' +
                        '<td><input type="number" step="any" ' + c('min') + ' value="' + num(s.min) + '" placeholder="auto" style="width:80px"></td>' +
                        '<td><input type="number" step="any" ' + c('max') + ' value="' + num(s.max) + '" placeholder="auto" style="width:80px"></td>' +
                        '<td><select ' + c('decimals') + '>' + options([['', 'auto'], [0, '0'], [1, '1'], [2, '2'], [3, '3'], [4, '4']], s.decimals === null ? '' : s.decimals) + '</select></td>' +
                        '<td><button data-g="' + gi + '" data-s="' + si + '" data-a="remove-series" title="Retirer ce tag">&#10005;</button></td></tr>';
                }).join('') +
                '</tbody></table></div>' +
                '<div class="period"><select data-g="' + gi + '" data-f="new-series">' + tagOptions('', '+ Ajouter un tag à ce graphique...') + '</select></div>' +
                '</div>';
        }).join('');
    }

    // ---------------------------------------------------------------- save
    var timer = null, saving = false, again = false;
    function schedule() {
        clearTimeout(timer);
        status('Modification en attente...');
        timer = setTimeout(save, 700);
    }

    function check() {
        for (var i = 0; i < graphs.length; i++) {
            var g = graphs[i];
            if (!g.series.length) { return 'Graphique ' + (i + 1) + ' : ajouter au moins un tag.'; }
            if (g.mode === 'xy' && !g.xTag) { return 'Graphique ' + (i + 1) + ' : choisir le tag de l’axe X.'; }
            if (g.mode !== 'xy' && g.period.type === 'fixed' && !(Date.parse(g.period.from) < Date.parse(g.period.to))) {
                return 'Graphique ' + (i + 1) + ' : la date de début doit être avant la date de fin.';
            }
        }
        return null;
    }

    function save() {
        timer = null;
        if (saving) { again = true; return; }
        var error = check();
        if (error) {
            status('Non enregistré : ' + error, true);
            return;
        }
        saving = true;
        status('Enregistrement...');
        SiteApi.saveGraphs(graphs).then(function (result) {
            status('Enregistré : ' + result.graphs.length + ' graphique(s) dans la page Courbes.');
        }).catch(function (err) {
            status('Non enregistré : ' + err.message, true);
        }).then(function () {
            saving = false;
            if (again) { again = false; save(); }
        });
    }

    window.addEventListener('beforeunload', function (e) {
        if (timer || saving) {
            if (timer) { clearTimeout(timer); save(); }
            e.preventDefault();
            e.returnValue = '';
        }
    });

    // ---------------------------------------------------------------- changes
    function numberOrNull(v) {
        return v === '' || v === null || !isFinite(Number(v)) ? null : Number(v);
    }

    /** change of a field: structure changes draw the list again */
    function change(el, typing) {
        var gi = el.getAttribute('data-g'), si = el.getAttribute('data-s'), f = el.getAttribute('data-f');
        if (gi === null || !f) { return; }
        var g = graphs[Number(gi)];
        var redraw = false;
        if (si !== null) {
            var s = g.series[Number(si)];
            if (f === 'tag') {
                if (s.label === tagName(s.tag)) { s.label = tagName(el.value); }
                s.tag = el.value;
            } else if (f === 'min' || f === 'max') {
                s[f] = numberOrNull(el.value);
            } else if (f === 'decimals') {
                s.decimals = el.value === '' ? null : Number(el.value);
            } else {
                s[f] = el.value;
            }
        } else if (f === 'new-series') {
            if (!el.value) { return; }
            if (g.series.some(function (x) { return x.tag === el.value; })) {
                status('Ce tag est déjà dans le graphique.', true);
                el.value = '';
                return;
            }
            g.series.push(newSeries(el.value, g));
            redraw = true;
        } else if (f === 'mode') {
            g.mode = el.value;
            if (g.mode === 'xy') {
                g.period = { type: 'relative', hours: g.period.type === 'relative' ? g.period.hours : 8 };
            }
            redraw = true;
        } else if (f === 'period') {
            if (el.value === 'fixed') {
                var now = Date.now();
                g.period = { type: 'fixed', from: new Date(now - 8 * 3600000).toISOString(), to: new Date(now).toISOString() };
            } else {
                g.period = { type: 'relative', hours: Number(el.value.slice(1)) };
            }
            redraw = true;
        } else if (f === 'periodFrom' || f === 'periodTo') {
            var t = new Date(el.value).getTime();
            if (isFinite(t)) { g.period[f === 'periodFrom' ? 'from' : 'to'] = new Date(t).toISOString(); }
        } else if (f === 'interval') {
            g.interval = Number(el.value);
        } else if (f === 'xMin' || f === 'xMax') {
            g[f] = numberOrNull(el.value);
        } else if (f === 'legend' || f === 'grid' || f === 'tooltip') {
            g[f] = el.checked;
        } else if (f === 'title') {
            g.title = el.value;
            var h = el.closest('.graph-card').querySelector('h3');
            h.textContent = (Number(gi) + 1) + '. ' + el.value;
        } else {
            g[f] = el.value;
        }
        if (redraw) { render(); }
        if (!typing || f === 'title') { schedule(); }
    }

    list.addEventListener('change', function (e) { change(e.target, false); });
    list.addEventListener('input', function (e) {
        // text fields: the model follows the typing, saved at the change (end of the typing)
        if (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && e.target.type !== 'color') { change(e.target, true); }
    });

    root.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-a]');
        if (!btn || btn.tagName !== 'BUTTON') { return; }
        var action = btn.getAttribute('data-a');
        var gi = Number(btn.getAttribute('data-g'));
        var g = graphs[gi];
        if (action === 'add') {
            graphs.push(newGraph(null));
        } else if (action === 'add-tag') {
            var select = root.querySelector('[data-a="add-tag-select"]');
            if (!select.value) { status('Choisir un tag.', true); return; }
            graphs.push(newGraph(select.value));
            select.value = '';
        } else if (action === 'up' || action === 'down') {
            var to = action === 'up' ? gi - 1 : gi + 1;
            graphs.splice(to, 0, graphs.splice(gi, 1)[0]);
        } else if (action === 'split') {
            // one graph per tag, with the options of the graph
            var parts = g.series.map(function (s) {
                var copy = JSON.parse(JSON.stringify(g));
                copy.id = newId();
                copy.title = s.label || tagName(s.tag);
                copy.series = [s];
                return copy;
            });
            parts[0].id = g.id;
            Array.prototype.splice.apply(graphs, [gi, 1].concat(parts));
        } else if (action === 'copy') {
            var copy = JSON.parse(JSON.stringify(g));
            copy.id = newId();
            copy.title = g.title + ' (copie)';
            graphs.splice(gi + 1, 0, copy);
        } else if (action === 'remove') {
            if (!confirm('Supprimer le graphique « ' + g.title + ' » ?')) { return; }
            graphs.splice(gi, 1);
        } else if (action === 'remove-series') {
            g.series.splice(Number(btn.getAttribute('data-s')), 1);
        } else {
            return;
        }
        render();
        if (action === 'add') {
            status('Ajouter au moins un tag au nouveau graphique.');
            return;
        }
        schedule();
    });

    // ---------------------------------------------------------------- start
    Promise.all([SiteApi.info(), SiteApi.graphs()]).then(function (results) {
        tags = results[0].tags;
        graphs = results[1].graphs.map(function (g) {
            delete g.xName;
            g.series.forEach(function (s) { delete s.name; });
            return g;
        });
        root.querySelector('[data-a="add-tag-select"]').innerHTML = tagOptions('', 'Un graphique pour le tag...');
        render();
        status(graphs.length + ' graphique(s)');
    }).catch(function (err) { status(err.message, true); });
})();
