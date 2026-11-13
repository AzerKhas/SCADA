/**
 * custom-SCADA: alarmes.js, page Alarmes of a site (alarmes.html): active alarms (refreshed every 5 s, acknowledgement),
 * history of the alarms, filters (equipment, tag, priority, text, period) and thresholds of the alarms of the tags.
 * Uses the API v1 of the server with site-api.js; the page has <div id="alarms-app">.
 */
(function () {
    'use strict';

    var app = document.getElementById('alarms-app');
    var LEVELS = [['highhigh', 'Critique'], ['high', 'Haute'], ['low', 'Basse'], ['info', 'Information']];
    var LEVEL_NAME = { highhigh: 'Critique', high: 'Haute', low: 'Basse', info: 'Information' };
    var tags = [], devices = [], tab = 'active', timer = null, history = [], historyToken = null;

    function esc(t) {
        return String(t === null || t === undefined ? '' : t).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c];
        });
    }

    function date(ms) {
        return ms ? SiteApi.formatDate(ms, true) : '';
    }

    function duration(a) {
        if (!a.ontime) { return ''; }
        var s = Math.round(((a.offtime || Date.now()) - a.ontime) / 1000);
        if (s < 60) { return s + ' s'; }
        if (s < 3600) { return Math.floor(s / 60) + ' min ' + (s % 60) + ' s'; }
        return Math.floor(s / 3600) + ' h ' + Math.floor((s % 3600) / 60) + ' min';
    }

    function status(id, text, error) {
        var el = document.getElementById(id);
        el.textContent = text;
        el.className = 'status' + (error ? ' error' : '');
    }

    /** value of the alarm: numbers with 3 decimals at most */
    function value(v) {
        var n = Number(v);
        return v === null || v === undefined || v === '' ? '' : isFinite(n) ? String(Math.round(n * 1000) / 1000) : String(v);
    }

    function badge(type) {
        return '<span class="lvl lvl-' + esc(type) + '">' + esc(LEVEL_NAME[type] || type) + '</span>';
    }

    app.innerHTML =
        '<div class="alarm-counts" id="a-counts"></div>' +
        '<div class="tabs"><button data-tab="active" class="on">Alarmes actives</button><button data-tab="history">Historique</button>' +
        '<button data-tab="config">Seuils d’alarme</button></div>' +
        '<div class="period" id="a-filters">' +
        '  <select id="f-device"><option value="">Tous les équipements</option></select>' +
        '  <select id="f-tag"><option value="">Tous les tags</option></select>' +
        LEVELS.map(function (l) { return '<label><input type="checkbox" class="f-level" value="' + l[0] + '" checked> ' + l[1] + '</label>'; }).join('') +
        '  <input id="f-text" size="18" placeholder="Texte du message">' +
        '  <span id="f-period" style="display:none"><label>Du <input type="datetime-local" id="f-from"></label> <label>Au <input type="datetime-local" id="f-to"></label>' +
        '  <button data-hours="24">24 h</button><button data-hours="168">7 j</button><button data-hours="720">30 j</button> <button id="f-show" class="primary">Afficher</button></span>' +
        '</div>' +
        '<div id="tab-active"><div class="period"><button id="ack-all">Tout acquitter</button><span id="a-status" class="status"></span></div>' +
        '<div class="history"><table><thead><tr><th>Priorité</th><th>Début</th><th>Tag</th><th>Équipement</th><th>Message</th><th>Valeur</th><th>État</th><th>Durée</th><th>Acquittement</th><th></th></tr></thead>' +
        '<tbody id="a-rows"></tbody></table></div></div>' +
        '<div id="tab-history" style="display:none"><div class="period"><button id="h-csv">Exporter en CSV</button><span id="h-status" class="status"></span></div>' +
        '<div class="history"><table><thead><tr><th>Priorité</th><th>Début</th><th>Fin</th><th>Durée</th><th>Acquittement</th><th>Tag</th><th>Équipement</th><th>Message</th><th>Valeur</th><th>État</th></tr></thead>' +
        '<tbody id="h-rows"></tbody></table></div></div>' +
        '<div id="tab-config" style="display:none"><p class="info">Une alarme surveille un tag : pour chaque niveau de priorité, l’alarme s’active quand la valeur dépasse le seuil ' +
        '(au-dessus, en dessous ou entre deux valeurs) pendant le délai choisi. Les alarmes critiques sont mises en évidence dans la liste des alarmes actives.</p>' +
        '<div class="period"><button id="c-new" class="primary">+ Nouvelle alarme</button><span id="c-status" class="status"></span></div>' +
        '<div id="c-form"></div>' +
        '<table><thead><tr><th>Nom</th><th>Tag</th><th>Équipement</th><th>Seuils</th><th></th></tr></thead><tbody id="c-rows"></tbody></table></div>';

    // ---------------------------------------------------------------- filters
    function filters() {
        var levels = Array.prototype.filter.call(document.querySelectorAll('.f-level'), function (c) { return c.checked; }).map(function (c) { return c.value; });
        return {
            device: document.getElementById('f-device').value,
            tag: document.getElementById('f-tag').value,
            type: levels.length === LEVELS.length ? '' : (levels.join(',') || 'none'),
            text: document.getElementById('f-text').value.trim()
        };
    }

    function fillFilters() {
        document.getElementById('f-device').innerHTML = '<option value="">Tous les équipements</option>' + devices.map(function (d) {
            return '<option>' + esc(d.name) + '</option>';
        }).join('');
        drawTagFilter();
    }

    function drawTagFilter() {
        var device = document.getElementById('f-device').value;
        var current = document.getElementById('f-tag').value;
        document.getElementById('f-tag').innerHTML = '<option value="">Tous les tags</option>' + tags.filter(function (t) { return !device || t.device === device; }).map(function (t) {
            return '<option' + (t.name === current ? ' selected' : '') + '>' + esc(t.name) + '</option>';
        }).join('');
    }

    function refreshTab() {
        if (tab === 'active') { loadActive(); }
        if (tab === 'history') { loadHistory(); }
    }

    document.getElementById('f-device').addEventListener('change', function () { drawTagFilter(); refreshTab(); });
    document.getElementById('f-tag').addEventListener('change', refreshTab);
    document.querySelectorAll('.f-level').forEach(function (c) { c.addEventListener('change', refreshTab); });
    var textTimer = null;
    document.getElementById('f-text').addEventListener('input', function () { clearTimeout(textTimer); textTimer = setTimeout(refreshTab, 400); });

    // ---------------------------------------------------------------- active alarms
    function drawCounts(counts) {
        document.getElementById('a-counts').innerHTML =
            '<span class="cnt lvl-highhigh' + (counts.highhigh ? ' blink' : '') + '">' + counts.highhigh + ' critique(s)</span>' +
            '<span class="cnt lvl-high">' + counts.high + ' haute(s)</span><span class="cnt lvl-low">' + counts.low + ' basse(s)</span>' +
            '<span class="cnt lvl-info">' + counts.info + ' information(s)</span><span class="cnt toack">' + counts.toack + ' à acquitter</span>';
    }

    function loadActive() {
        var f = filters();
        if (f.type === 'none') { document.getElementById('a-rows').innerHTML = '<tr><td colspan="10" class="empty">Aucune priorité cochée.</td></tr>'; return; }
        SiteApi.request('GET', '/alarms', undefined, f).then(function (r) {
            drawCounts(r.meta.counts);
            document.getElementById('a-rows').innerHTML = r.data.map(function (a) {
                return '<tr class="' + (a.critical ? 'row-critical' : '') + '"><td>' + badge(a.type) + '</td><td>' + date(a.ontime) + '</td><td>' + esc(a.tag) + '</td>' +
                    '<td>' + esc(a.device) + '</td><td>' + esc(a.text) + (a.group ? ' <small>(' + esc(a.group) + ')</small>' : '') + '</td><td>' + esc(value(a.value)) + '</td>' +
                    '<td>' + esc(a.statusText) + '</td><td>' + duration(a) + '</td><td>' + (a.acktime ? date(a.acktime) + (a.userack ? ' (' + esc(a.userack) + ')' : '') : '') + '</td>' +
                    '<td>' + (a.toack ? '<button data-ack="' + esc(a.alarm_id) + '">Acquitter</button>' : '') + '</td></tr>';
            }).join('') || '<tr><td colspan="10" class="empty">Aucune alarme active.</td></tr>';
            status('a-status', r.data.length + ' alarme(s) affichée(s), mise à jour ' + SiteApi.formatDate(r.meta.time, true).slice(11));
        }).catch(function (err) { status('a-status', err.message, true); });
    }

    document.getElementById('a-rows').addEventListener('click', function (e) {
        var id = e.target.getAttribute('data-ack');
        if (!id) { return; }
        SiteApi.request('POST', '/alarms/' + encodeURIComponent(id) + '/ack').then(loadActive).catch(function (err) { status('a-status', err.message, true); });
    });
    document.getElementById('ack-all').addEventListener('click', function () {
        if (!confirm('Acquitter toutes les alarmes ?')) { return; }
        SiteApi.request('POST', '/alarms/ack').then(loadActive).catch(function (err) { status('a-status', err.message, true); });
    });

    // ---------------------------------------------------------------- history
    /** last n hours (until now at each loading), or the dates typed (relativeHours null) */
    var relativeHours = 24;
    function setPeriod(hours) {
        relativeHours = hours;
        var now = Date.now();
        document.getElementById('f-from').value = SiteApi.inputValue(now - hours * 3600000);
        document.getElementById('f-to').value = SiteApi.inputValue(now);
    }
    ['f-from', 'f-to'].forEach(function (id) {
        document.getElementById(id).addEventListener('change', function () { relativeHours = null; });
    });

    function loadHistory() {
        var f = filters();
        if (f.type === 'none') { document.getElementById('h-rows').innerHTML = '<tr><td colspan="10" class="empty">Aucune priorité cochée.</td></tr>'; return; }
        if (relativeHours) {
            // the inputs are rounded to the minute: the exact time is sent
            setPeriod(relativeHours);
            f.to = Date.now();
            f.from = f.to - relativeHours * 3600000;
        } else {
            f.from = new Date(document.getElementById('f-from').value).getTime();
            f.to = new Date(document.getElementById('f-to').value).getTime();
        }
        status('h-status', 'Chargement...');
        var token = historyToken = {};
        SiteApi.request('GET', '/alarms/history', undefined, f).then(function (r) {
            // only the answer of the last request is shown
            if (token !== historyToken) { return; }
            history = r.data;
            document.getElementById('h-rows').innerHTML = history.map(function (a) {
                return '<tr class="' + (a.critical ? 'row-critical' : '') + '"><td>' + badge(a.type) + '</td><td>' + date(a.ontime) + '</td><td>' + date(a.offtime) + '</td>' +
                    '<td>' + duration(a) + '</td><td>' + (a.acktime ? date(a.acktime) + (a.userack ? ' (' + esc(a.userack) + ')' : '') : '') + '</td><td>' + esc(a.tag) + '</td>' +
                    '<td>' + esc(a.device) + '</td><td>' + esc(a.text) + '</td><td>' + esc(value(a.value)) + '</td><td>' + esc(a.statusText) + '</td></tr>';
            }).join('') || '<tr><td colspan="10" class="empty">Aucune alarme sur cette période.</td></tr>';
            var c = r.meta.counts;
            status('h-status', history.length + ' alarme(s) : ' + c.highhigh + ' critique(s), ' + c.high + ' haute(s), ' + c.low + ' basse(s), ' + c.info + ' information(s)');
        }).catch(function (err) { status('h-status', err.message, true); });
    }

    document.querySelectorAll('#f-period [data-hours]').forEach(function (b) {
        b.addEventListener('click', function () { setPeriod(Number(b.getAttribute('data-hours'))); loadHistory(); });
    });
    document.getElementById('f-show').addEventListener('click', loadHistory);
    document.getElementById('h-csv').addEventListener('click', function () {
        var head = ['Priorité', 'Début', 'Fin', 'Durée', 'Acquittement', 'Utilisateur', 'Tag', 'Équipement', 'Message', 'Valeur', 'État'];
        var rows = history.map(function (a) {
            return [LEVEL_NAME[a.type] || a.type, date(a.ontime), date(a.offtime), duration(a), date(a.acktime), a.userack || '', a.tag || '', a.device || '', a.text, value(a.value), a.statusText];
        });
        var csv = [head].concat(rows).map(function (r) { return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(';'); }).join('\r\n');
        SiteApi.download(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), 'alarmes-' + SiteApi.siteId + '.csv');
    });

    // ---------------------------------------------------------------- thresholds
    var CONDITIONS = [['above', 'au-dessus de (≥)'], ['below', 'en dessous de (≤)'], ['between', 'entre']];
    var ACKMODES = [['ackactive', 'acquittement obligatoire'], ['ackpassive', 'acquittement après la fin'], ['float', 'sans acquittement']];
    var configs = [];

    function levelText(l) {
        if (l.condition === 'above') { return '≥ ' + l.value; }
        if (l.condition === 'below') { return '≤ ' + l.value; }
        return 'entre ' + l.min + ' et ' + l.max;
    }

    function loadConfig() {
        SiteApi.request('GET', '/alarms/config').then(function (r) {
            configs = r.data;
            document.getElementById('c-rows').innerHTML = configs.map(function (c, i) {
                var levels = LEVELS.filter(function (l) { return c.levels[l[0]].enabled; }).map(function (l) {
                    return badge(l[0]) + ' ' + esc(levelText(c.levels[l[0]])) + (c.levels[l[0]].text ? ' : ' + esc(c.levels[l[0]].text) : '');
                }).join('<br>');
                return '<tr><td>' + esc(c.name) + '</td><td>' + esc(c.tag || c.tagId) + '</td><td>' + esc(c.device) + '</td><td>' + levels + '</td>' +
                    '<td style="white-space:nowrap"><button data-edit="' + i + '">Modifier</button> <button data-del="' + i + '">Supprimer</button></td></tr>';
            }).join('') || '<tr><td colspan="5" class="empty">Aucune alarme configurée.</td></tr>';
            status('c-status', configs.length + ' alarme(s) configurée(s)');
        }).catch(function (err) { status('c-status', err.message, true); });
    }

    function options(values, selected) {
        return values.map(function (v) { return '<option value="' + esc(v[0]) + '"' + (v[0] === selected ? ' selected' : '') + '>' + esc(v[1]) + '</option>'; }).join('');
    }

    function editConfig(c) {
        var isNew = !c;
        c = c || { name: '', tag: '', levels: {} };
        var form = document.getElementById('c-form');
        var byDevice = {};
        tags.forEach(function (t) { (byDevice[t.device] = byDevice[t.device] || []).push(t); });
        form.innerHTML = '<div class="graph-card"><h3>' + (isNew ? 'Nouvelle alarme' : 'Modifier l’alarme « ' + esc(c.name) + ' »') + '</h3>' +
            '<div class="period"><label>Nom <input id="e-name" size="24" value="' + esc(c.name) + '"' + (isNew ? '' : ' disabled') + '></label>' +
            '<label>Tag <select id="e-tag"><option value="">(choisir)</option>' + Object.keys(byDevice).map(function (d) {
                return '<optgroup label="' + esc(d) + '">' + byDevice[d].map(function (t) {
                    return '<option value="' + esc(t.name) + '"' + (t.name === c.tag ? ' selected' : '') + '>' + esc(t.name) + (t.description ? ' — ' + esc(t.description) : '') + '</option>';
                }).join('') + '</optgroup>';
            }).join('') + '</select></label><span id="e-value" class="status"></span></div>' +
            '<table><thead><tr><th>Niveau</th><th>Actif</th><th>Condition</th><th>Seuil</th><th>Message</th><th>Groupe</th><th>Délai (s)</th><th>Acquittement</th></tr></thead><tbody>' +
            LEVELS.map(function (l) {
                var v = c.levels[l[0]] || { enabled: false, condition: l[0] === 'low' ? 'below' : 'above', delay: 1, ackmode: 'ackactive' };
                var k = function (f) { return 'data-l="' + l[0] + '" data-f="' + f + '"'; };
                return '<tr><td>' + badge(l[0]) + '</td><td><input type="checkbox" ' + k('enabled') + (v.enabled ? ' checked' : '') + '></td>' +
                    '<td><select ' + k('condition') + '>' + options(CONDITIONS, v.condition) + '</select></td>' +
                    '<td><input type="number" step="any" style="width:80px" ' + k('value') + ' value="' + esc(v.value === null || v.value === undefined ? '' : v.value) + '">' +
                    '<span data-l="' + l[0] + '" data-between> <input type="number" step="any" style="width:70px" ' + k('min') + ' value="' + esc(v.min === null || v.min === undefined ? '' : v.min) + '">' +
                    ' et <input type="number" step="any" style="width:70px" ' + k('max') + ' value="' + esc(v.max === null || v.max === undefined ? '' : v.max) + '"></span></td>' +
                    '<td><input size="22" ' + k('text') + ' value="' + esc(v.text || '') + '" placeholder="ex. Niveau très haut"></td>' +
                    '<td><input size="10" ' + k('group') + ' value="' + esc(v.group || '') + '"></td>' +
                    '<td><input type="number" min="0" style="width:60px" ' + k('delay') + ' value="' + esc(v.delay === undefined ? 1 : v.delay) + '"></td>' +
                    '<td><select ' + k('ackmode') + '>' + options(ACKMODES, v.ackmode || 'ackactive') + '</select></td></tr>';
            }).join('') + '</tbody></table>' +
            '<div class="period"><button id="e-save" class="primary">Enregistrer</button><button id="e-cancel">Annuler</button><span id="e-status" class="status"></span></div></div>';
        var showCondition = function () {
            LEVELS.forEach(function (l) {
                var between = form.querySelector('[data-l="' + l[0] + '"][data-f="condition"]').value === 'between';
                form.querySelector('[data-l="' + l[0] + '"][data-f="value"]').style.display = between ? 'none' : '';
                form.querySelector('[data-l="' + l[0] + '"][data-between]').style.display = between ? '' : 'none';
            });
        };
        var showValue = function () {
            var name = document.getElementById('e-tag').value;
            if (!name) { document.getElementById('e-value').textContent = ''; return; }
            SiteApi.values([name]).then(function (r) {
                var v = r.values[0];
                document.getElementById('e-value').textContent = 'valeur actuelle : ' + (v && v.value !== null ? v.value : '—');
            }).catch(function () { /* no value */ });
        };
        form.addEventListener('change', function (e) {
            if (e.target.getAttribute('data-f') === 'condition') { showCondition(); }
        });
        document.getElementById('e-tag').addEventListener('change', function () {
            if (isNew && !document.getElementById('e-name').value) { document.getElementById('e-name').value = document.getElementById('e-tag').value; }
            showValue();
        });
        document.getElementById('e-cancel').addEventListener('click', function () { form.innerHTML = ''; });
        document.getElementById('e-save').addEventListener('click', function () {
            var name = document.getElementById('e-name').value.trim();
            var levels = {};
            LEVELS.forEach(function (l) {
                var get = function (f) { var el = form.querySelector('[data-l="' + l[0] + '"][data-f="' + f + '"]'); return el.type === 'checkbox' ? el.checked : el.value; };
                levels[l[0]] = {
                    enabled: get('enabled'), condition: get('condition'), value: get('value'), min: get('min'), max: get('max'),
                    text: get('text'), group: get('group'), delay: Number(get('delay')), ackmode: get('ackmode')
                };
            });
            if (!name) { status('e-status', 'Écrire le nom de l’alarme.', true); return; }
            SiteApi.request('PUT', '/alarms/config/' + encodeURIComponent(name), { tag: document.getElementById('e-tag').value, levels: levels }).then(function () {
                form.innerHTML = '';
                status('c-status', 'Alarme « ' + name + ' » enregistrée.');
                loadConfig();
            }).catch(function (err) { status('e-status', err.message, true); });
        });
        showCondition();
        showValue();
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    document.getElementById('c-new').addEventListener('click', function () { editConfig(null); });
    document.getElementById('c-rows').addEventListener('click', function (e) {
        var edit = e.target.getAttribute('data-edit'), del = e.target.getAttribute('data-del');
        if (edit !== null) { editConfig(configs[Number(edit)]); }
        if (del !== null) {
            var c = configs[Number(del)];
            if (!confirm('Supprimer l’alarme « ' + c.name + ' » ?')) { return; }
            SiteApi.request('DELETE', '/alarms/config/' + encodeURIComponent(c.name)).then(loadConfig).catch(function (err) { status('c-status', err.message, true); });
        }
    });

    // ---------------------------------------------------------------- tabs
    function showTab(name) {
        tab = name;
        document.querySelectorAll('.tabs button').forEach(function (b) { b.className = b.getAttribute('data-tab') === name ? 'on' : ''; });
        ['active', 'history', 'config'].forEach(function (t) { document.getElementById('tab-' + t).style.display = t === name ? '' : 'none'; });
        document.getElementById('a-filters').style.display = name === 'config' ? 'none' : '';
        document.getElementById('f-period').style.display = name === 'history' ? '' : 'none';
        clearInterval(timer);
        // the active alarms (and the counts at the top) are refreshed every 5 s in all the tabs
        loadActive();
        timer = setInterval(function () { if (!document.hidden) { loadActive(); } }, 5000);
        if (name === 'history') {
            loadHistory();
        } else if (name === 'config') {
            loadConfig();
        }
    }
    document.querySelectorAll('.tabs button').forEach(function (b) {
        b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); });
    });

    setPeriod(24);
    SiteApi.info().then(function (info) {
        tags = info.tags;
        devices = info.devices || [];
        fillFilters();
        showTab(location.hash === '#historique' ? 'history' : location.hash === '#seuils' ? 'config' : 'active');
    }).catch(function (err) { status('a-status', err.message, true); });
})();
