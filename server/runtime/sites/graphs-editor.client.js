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
        '<div class="period sets-bar">' +
        '  <b>Configuration de courbes :</b> <select id="set-select"></select>' +
        '  <button data-a="set-new" title="Nouvelle configuration vide">Nouvelle</button>' +
        '  <button data-a="set-copy" title="Copie de cette configuration">Dupliquer</button>' +
        '  <button data-a="set-rename">Renommer</button>' +
        '  <button data-a="set-delete">Supprimer</button>' +
        '  <button data-a="set-activate" title="Configuration affichée à l’ouverture de la page Courbes">Afficher par défaut</button>' +
        '  <span id="set-info" class="status"></span>' +
        '</div>' +
        '<div class="period">' +
        '  <button data-a="add" class="primary">+ Nouveau graphique</button>' +
        '  <button data-a="add-tags" title="Choisir des tags dans la liste des variables du site">+ Graphiques depuis des tags...</button>' +
        '  <span style="flex:1"></span>' +
        '  <a href="courbes.html">Voir la page Courbes</a>' +
        '  <span id="graphs-status" class="status"></span>' +
        '</div>' +
        '<div id="graphs-list"><p class="empty">Chargement...</p></div>' +
        '<div id="tag-picker" class="picker-back" style="display:none"></div>';
    var list = document.getElementById('graphs-list');
    var statusEl = document.getElementById('graphs-status');
    var sets = [], currentSet = null;

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
                '<div class="period"><button data-g="' + gi + '" data-a="add-series">+ Ajouter des tags à ce graphique...</button></div>' +
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
        SiteApi.saveGraphs(graphs, currentSet).then(function (result) {
            status('Enregistré : ' + result.graphs.length + ' graphique(s) dans la configuration « ' + setName(currentSet) + ' ».');
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
        if (action.indexOf('set-') === 0) {
            setAction(action);
            return;
        }
        if (action === 'add-tags') {
            // new graphs from tags chosen in the list: one graph per tag, or one graph with all the tags
            openPicker({
                title: 'Créer des graphiques depuis des tags', exclude: [], grouping: true,
                done: function (ids, together) {
                    if (together) {
                        var ng = newGraph(null);
                        ng.title = ids.map(tagName).join(', ').slice(0, 100);
                        ids.forEach(function (id) { ng.series.push(newSeries(id, ng)); });
                        graphs.push(ng);
                    } else {
                        ids.forEach(function (id) { graphs.push(newGraph(id)); });
                    }
                    render();
                    schedule();
                }
            });
            return;
        }
        if (action === 'add-series') {
            openPicker({
                title: 'Ajouter des tags au graphique « ' + g.title + ' »', exclude: g.series.map(function (s) { return s.tag; }),
                done: function (ids) {
                    ids.forEach(function (id) { g.series.push(newSeries(id, g)); });
                    render();
                    schedule();
                }
            });
            return;
        }
        if (action === 'add') {
            graphs.push(newGraph(null));
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

    // ---------------------------------------------------------------- tag picker
    var CATEGORIES = { S7: 'Siemens S7', SiemensS7: 'Siemens S7', OPCUA: 'OPC UA', FuxaServer: 'Interne FUXA', ModbusRTU: 'Modbus RTU', ModbusTCP: 'Modbus TCP',
        BACnet: 'BACnet', WebAPI: 'Web API', MQTTclient: 'MQTT', EthernetIP: 'Ethernet/IP', ODBC: 'ODBC', ADSclient: 'ADS', GPIO: 'GPIO', WebCam: 'Webcam' };
    function categoryName(c) {
        return CATEGORIES[c] || c || 'autre';
    }

    /**
     * list of the variables of the site with search and filters (name, equipment, category, type, recorded),
     * several tags can be chosen; options: { title, exclude: [ids], grouping (choice one graph / one per tag), done(ids, together) }
     */
    function openPicker(options) {
        var box = document.getElementById('tag-picker');
        var uniq = function (values) { return values.filter(function (v, i) { return v && values.indexOf(v) === i; }).sort(); };
        var devices = uniq(tags.map(function (t) { return t.device; }));
        var categories = uniq(tags.map(function (t) { return t.category; }));
        var types = uniq(tags.map(function (t) { return t.type; }));
        var chosen = {};
        box.innerHTML = '<div class="picker">' +
            '<div class="graph-head"><h3>' + esc(options.title) + '</h3><span style="flex:1"></span><button data-p="close">&#10005;</button></div>' +
            '<div class="period">' +
            '  <input data-p="search" size="26" placeholder="Rechercher (nom, adresse, description)">' +
            '  <select data-p="device"><option value="">Tous les équipements</option>' + devices.map(function (d) { return '<option>' + esc(d) + '</option>'; }).join('') + '</select>' +
            '  <select data-p="category"><option value="">Toutes les catégories</option>' + categories.map(function (c) { return '<option value="' + esc(c) + '">' + esc(categoryName(c)) + '</option>'; }).join('') + '</select>' +
            '  <select data-p="type"><option value="">Tous les types</option>' + types.map(function (t) { return '<option>' + esc(t) + '</option>'; }).join('') + '</select>' +
            '  <label><input type="checkbox" data-p="recorded"> Enregistrés seulement</label>' +
            '</div>' +
            '<div class="picker-list"><table><thead><tr><th><input type="checkbox" data-p="all" title="Tout cocher"></th><th>Tag</th><th>Équipement</th><th>Catégorie</th><th>Type</th><th>Adresse</th><th>Description</th></tr></thead>' +
            '<tbody data-p="rows"></tbody></table></div>' +
            '<div class="period">' +
            (options.grouping ? '<label><input type="radio" name="grouping" value="each" checked> Un graphique par tag</label>' +
                '<label><input type="radio" name="grouping" value="together"> Un seul graphique avec tous les tags (comparaison)</label>' : '') +
            '  <span style="flex:1"></span><span data-p="count" class="status"></span>' +
            '  <button data-p="ok" class="primary">Ajouter</button><button data-p="close">Annuler</button>' +
            '</div></div>';
        box.style.display = '';
        var q = function (p) { return box.querySelector('[data-p="' + p + '"]'); };
        var visible = [];
        function draw() {
            var text = q('search').value.trim().toLowerCase(), device = q('device').value, category = q('category').value, type = q('type').value;
            var recorded = q('recorded').checked;
            visible = tags.filter(function (t) {
                return options.exclude.indexOf(t.id) < 0 && (!device || t.device === device) && (!category || t.category === category) &&
                    (!type || t.type === type) && (!recorded || t.recorded) &&
                    (!text || (t.name + ' ' + t.address + ' ' + (t.description || '') + ' ' + t.device).toLowerCase().indexOf(text) >= 0);
            });
            q('rows').innerHTML = visible.map(function (t) {
                return '<tr><td><input type="checkbox" data-id="' + esc(t.id) + '"' + (chosen[t.id] ? ' checked' : '') + '></td><td>' + esc(t.name) + (t.recorded ? ' &#128339;' : '') + '</td>' +
                    '<td>' + esc(t.device) + '</td><td>' + esc(categoryName(t.category)) + '</td><td>' + esc(t.type) + '</td><td>' + esc(t.address) + '</td><td>' + esc(t.description || '') + '</td></tr>';
            }).join('') || '<tr><td colspan="7" class="empty">Aucun tag ne correspond.</td></tr>';
            q('all').checked = visible.length > 0 && visible.every(function (t) { return chosen[t.id]; });
            count();
        }
        function count() {
            var n = Object.keys(chosen).filter(function (k) { return chosen[k]; }).length;
            q('count').textContent = n + ' tag(s) choisi(s), ' + visible.length + ' affiché(s)';
            q('ok').disabled = !n;
        }
        ['search'].forEach(function (p) { q(p).addEventListener('input', draw); });
        ['device', 'category', 'type', 'recorded'].forEach(function (p) { q(p).addEventListener('change', draw); });
        q('all').addEventListener('change', function () {
            visible.forEach(function (t) { chosen[t.id] = q('all').checked; });
            draw();
        });
        q('rows').addEventListener('change', function (e) {
            var id = e.target.getAttribute('data-id');
            if (id) { chosen[id] = e.target.checked; count(); }
        });
        box.querySelectorAll('[data-p="close"]').forEach(function (b) { b.addEventListener('click', function () { box.style.display = 'none'; }); });
        q('ok').addEventListener('click', function () {
            // order of the list of the variables
            var ids = tags.filter(function (t) { return chosen[t.id]; }).map(function (t) { return t.id; });
            var together = options.grouping && box.querySelector('input[name="grouping"]:checked').value === 'together';
            box.style.display = 'none';
            options.done(ids, together);
        });
        draw();
        q('search').focus();
    }

    // ---------------------------------------------------------------- configurations of graphs
    function setName(id) {
        var s = sets.filter(function (x) { return x.id === id; })[0];
        return s ? s.name : '';
    }

    function drawSets() {
        document.getElementById('set-select').innerHTML = sets.map(function (s) {
            return '<option value="' + esc(s.id) + '"' + (s.id === currentSet ? ' selected' : '') + '>' + esc(s.name) + ' (' + s.graphs + ' graphique(s))' + (s.active ? ' ★ par défaut' : '') + '</option>';
        }).join('');
        var active = sets.filter(function (s) { return s.active; })[0];
        document.getElementById('set-info').textContent = sets.length + ' configuration(s). Page Courbes par défaut : « ' + (active ? active.name : '') + ' »';
        root.querySelector('[data-a="set-delete"]').disabled = sets.length < 2;
        root.querySelector('[data-a="set-activate"]').disabled = !!(active && active.id === currentSet);
    }

    function loadSet(id) {
        currentSet = id;
        return SiteApi.graphs(id).then(function (r) {
            graphs = r.graphs.map(function (g) {
                delete g.xName;
                g.series.forEach(function (s) { delete s.name; });
                return g;
            });
            drawSets();
            render();
            status(graphs.length + ' graphique(s) dans « ' + setName(id) + ' »');
        });
    }

    function reloadSets(selectId) {
        return SiteApi.graphSets().then(function (list) {
            sets = list;
            var id = selectId && sets.some(function (s) { return s.id === selectId; }) ? selectId : (sets.filter(function (s) { return s.active; })[0] || sets[0]).id;
            return loadSet(id);
        });
    }

    /** changes not yet saved are saved before changing of configuration */
    function flush() {
        if (timer) { clearTimeout(timer); save(); }
    }

    function setAction(action) {
        flush();
        var p;
        if (action === 'set-new' || action === 'set-copy') {
            var name = prompt(action === 'set-new' ? 'Nom de la nouvelle configuration :' : 'Nom de la copie de « ' + setName(currentSet) + ' » :',
                action === 'set-copy' ? setName(currentSet) + ' (copie)' : '');
            if (!name) { return; }
            p = SiteApi.request('POST', '/config/graph-sets', { name: name, copyFrom: action === 'set-copy' ? currentSet : undefined }).then(function (r) { return reloadSets(r.data.id); });
        } else if (action === 'set-rename') {
            var newName = prompt('Nouveau nom de la configuration :', setName(currentSet));
            if (!newName) { return; }
            p = SiteApi.request('PUT', '/config/graph-sets/' + encodeURIComponent(currentSet), { name: newName }).then(function () { return reloadSets(currentSet); });
        } else if (action === 'set-delete') {
            if (!confirm('Supprimer la configuration « ' + setName(currentSet) + ' » et ses graphiques ?')) { return; }
            p = SiteApi.request('DELETE', '/config/graph-sets/' + encodeURIComponent(currentSet)).then(function () { return reloadSets(); });
        } else if (action === 'set-activate') {
            p = SiteApi.request('POST', '/config/graph-sets/' + encodeURIComponent(currentSet) + '/activate').then(function () { return reloadSets(currentSet); });
        }
        if (p) {
            p.catch(function (err) { status(err.message, true); });
        }
    }

    document.getElementById('set-select').addEventListener('change', function (e) {
        flush();
        loadSet(e.target.value).catch(function (err) { status(err.message, true); });
    });

    // ---------------------------------------------------------------- start
    SiteApi.info().then(function (info) {
        tags = info.tags;
        return reloadSets();
    }).catch(function (err) { status(err.message, true); });
})();
