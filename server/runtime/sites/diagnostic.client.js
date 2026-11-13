/**
 * custom-SCADA: diagnostic.js, page Diagnostic of a site (diagnostic.html): state of the communication of all the sites,
 * equipments of the site (connected / disconnected, last data), tags without update, journal of the communication errors.
 * Refreshed every 10 s. Uses the API v1 of the server with site-api.js; the page has <div id="diagnostic-app">.
 */
(function () {
    'use strict';

    var app = document.getElementById('diagnostic-app');
    var STATE = {
        ok: ['OK', 'st-ok'], warning: ['À surveiller', 'st-warning'], error: ['Problème', 'st-error'],
        stopped: ['Arrêté', 'st-off'], starting: ['Démarrage', 'st-off']
    };
    var LEVEL = { error: ['Erreur', 'st-error'], warning: ['Avertissement', 'st-warning'], info: ['Information', 'st-info'] };
    var timer = null, devices = [];

    function esc(t) {
        return String(t === null || t === undefined ? '' : t).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c];
        });
    }

    function date(ms) {
        return ms ? SiteApi.formatDate(ms, true) : '—';
    }

    function age(ms) {
        if (ms === null || ms === undefined) { return 'jamais'; }
        var s = Math.round(ms / 1000);
        if (s < 60) { return 'il y a ' + s + ' s'; }
        if (s < 3600) { return 'il y a ' + Math.floor(s / 60) + ' min'; }
        if (s < 86400) { return 'il y a ' + Math.floor(s / 3600) + ' h ' + Math.floor((s % 3600) / 60) + ' min'; }
        return 'il y a ' + Math.floor(s / 86400) + ' j';
    }

    function state(code) {
        var s = STATE[code] || [code, 'st-off'];
        return '<span class="st ' + s[1] + '">' + esc(s[0]) + '</span>';
    }

    function value(v) {
        var n = Number(v);
        return v === null || v === undefined || v === '' ? '' : typeof v !== 'boolean' && isFinite(n) ? String(Math.round(n * 1000) / 1000) : String(v);
    }

    app.innerHTML =
        '<section><h2>Communication de tous les sites</h2>' +
        '<table><thead><tr><th>Site</th><th>État</th><th>Équipements connectés</th><th>Dernière donnée reçue</th><th>Tags sans mise à jour</th><th>Erreurs (1 h)</th><th></th></tr></thead>' +
        '<tbody id="d-sites"><tr><td colspan="7" class="empty">Chargement...</td></tr></tbody></table></section>' +
        '<section><h2>Ce site</h2><div class="diag-cards" id="d-cards"></div>' +
        '<h3>Équipements</h3>' +
        '<table><thead><tr><th>Équipement</th><th>Type</th><th>État</th><th>Depuis</th><th>Dernière donnée</th><th>Tags</th><th>Sans mise à jour</th><th>Erreurs (24 h)</th><th>Dernière erreur</th></tr></thead>' +
        '<tbody id="d-devices"></tbody></table>' +
        '<h3>Tags sans mise à jour</h3>' +
        '<p class="info">Un tag est sans mise à jour quand sa dernière valeur date de plus de 10 fois la période de lecture de son équipement (60 s au moins).</p>' +
        '<div class="period"><label><input type="checkbox" id="d-alltags"> Afficher tous les tags avec leur dernière mise à jour</label></div>' +
        '<div class="history"><table><thead><tr><th>Tag</th><th>Équipement</th><th>Adresse</th><th>Dernière valeur</th><th>Dernière mise à jour</th><th>Limite</th><th>État</th></tr></thead>' +
        '<tbody id="d-tags"></tbody></table></div>' +
        '<h3>Journal des communications</h3>' +
        '<div class="period"><select id="d-level"><option value="">Tous les niveaux</option><option value="error">Erreurs</option><option value="warning">Avertissements</option><option value="info">Informations</option></select>' +
        '<select id="d-device"><option value="">Tous les équipements</option></select>' +
        '<select id="d-days"><option value="1">24 dernières heures</option><option value="7" selected>7 derniers jours</option><option value="30">30 derniers jours</option></select>' +
        '<span id="d-status" class="status"></span></div>' +
        '<div class="history"><table><thead><tr><th>Date</th><th>Niveau</th><th>Équipement</th><th>Message</th></tr></thead><tbody id="d-events"></tbody></table></div></section>';

    function loadSites() {
        // service of the main FUXA (all the sites), not of this site
        var headers = {};
        try {
            var token = (JSON.parse(sessionStorage.getItem('currentUser')) || {}).token;
            if (token) { headers['x-access-token'] = token; }
        } catch (err) { /* no user */ }
        return fetch('/api/v1/diagnostic', { headers: headers }).then(function (res) {
            return res.json().then(function (body) {
                if (!res.ok) { throw new Error(body && body.error ? body.error.message : 'Erreur ' + res.status); }
                return body;
            });
        }).then(function (r) {
            document.getElementById('d-sites').innerHTML = r.data.map(function (s) {
                var d = s.deviceCount;
                return '<tr' + (s.site_id === SiteApi.siteId ? ' style="font-weight:bold"' : '') + '><td>' + esc(s.site_id) + '</td><td>' + state(s.communication) +
                    (s.error ? ' <small>' + esc(s.error) + '</small>' : '') + '</td>' +
                    '<td>' + (d ? d.connected + ' / ' + d.enabled : '—') + '</td><td>' + (s.lastData ? date(s.lastData) + ' <small>(' + age(Date.now() - s.lastData) + ')</small>' : '—') + '</td>' +
                    '<td>' + (s.staleTags === undefined ? '—' : s.staleTags) + '</td><td>' + (s.errors1h === undefined ? '—' : s.errors1h) + '</td>' +
                    '<td>' + (s.state === 'running' ? '<a href="/site/' + encodeURIComponent(s.site_id) + '/fichiers/diagnostic.html">diagnostic</a>' : '') + '</td></tr>';
            }).join('') || '<tr><td colspan="7" class="empty">Aucun site.</td></tr>';
        }).catch(function (err) {
            document.getElementById('d-sites').innerHTML = '<tr><td colspan="7" class="status error">État des sites non disponible : ' + esc(err.message) + '</td></tr>';
        });
    }

    function loadSite() {
        return SiteApi.request('GET', '/diagnostic').then(function (r) {
            var d = r.data, s = d.summary;
            devices = d.devices;
            document.getElementById('d-cards').innerHTML =
                '<div class="card">État de la communication<b>' + state(s.communication) + '</b></div>' +
                '<div class="card">Équipements connectés<b>' + s.devices.connected + ' / ' + s.devices.enabled + '</b>' + (s.devices.disconnected ? '<small class="bad">' + s.devices.disconnected + ' déconnecté(s)</small>' : '') + '</div>' +
                '<div class="card">Dernière donnée reçue<b>' + (s.lastData ? date(s.lastData).slice(11) : '—') + '</b><small>' + (s.lastData ? age(r.meta.time - s.lastData) : '') + '</small></div>' +
                '<div class="card">Tags sans mise à jour<b' + (s.staleTags ? ' class="bad"' : '') + '>' + s.staleTags + ' / ' + s.tags + '</b></div>' +
                '<div class="card">Erreurs<b' + (s.errors1h ? ' class="bad"' : '') + '>' + s.errors1h + '</b><small>dernière heure (' + s.errors24h + ' en 24 h)</small></div>';
            document.getElementById('d-devices').innerHTML = d.devices.map(function (e) {
                var cls = !e.enabled ? 'st-off' : e.connected ? 'st-ok' : 'st-error';
                return '<tr><td>' + esc(e.name) + '</td><td>' + esc(e.type) + '</td><td><span class="st ' + cls + '">' + esc(e.statusText) + '</span></td>' +
                    '<td>' + date(e.since) + '</td><td>' + (e.lastData ? date(e.lastData) + ' <small>(' + age(r.meta.time - e.lastData) + ')</small>' : '—') + '</td>' +
                    '<td>' + e.tags + '</td><td' + (e.staleTags ? ' class="bad"' : '') + '>' + e.staleTags + '</td><td>' + e.errors24h + '</td>' +
                    '<td><small>' + (e.lastError ? date(e.lastError.time) + ' : ' + esc(e.lastError.message) : '') + '</small></td></tr>';
            }).join('');
            var select = document.getElementById('d-device'), current = select.value;
            select.innerHTML = '<option value="">Tous les équipements</option>' + devices.map(function (e) {
                return '<option' + (e.name === current ? ' selected' : '') + '>' + esc(e.name) + '</option>';
            }).join('');
            return loadTags();
        });
    }

    function loadTags() {
        var all = document.getElementById('d-alltags').checked;
        return SiteApi.request('GET', '/diagnostic/tags', undefined, all ? {} : { stale: 'true' }).then(function (r) {
            document.getElementById('d-tags').innerHTML = r.data.map(function (t) {
                return '<tr' + (t.stale ? ' class="row-critical"' : '') + '><td>' + esc(t.name) + '</td><td>' + esc(t.device) + '</td><td>' + esc(t.address) + '</td>' +
                    '<td>' + esc(value(t.value)) + '</td><td>' + (t.lastUpdate ? date(t.lastUpdate) + ' <small>(' + age(t.age) + ')</small>' : 'jamais') + '</td>' +
                    '<td>' + Math.round(t.limit / 1000) + ' s</td><td>' + (t.stale ? '<span class="st st-error">sans mise à jour</span>' : '<span class="st st-ok">à jour</span>') + '</td></tr>';
            }).join('') || '<tr><td colspan="7" class="empty">' + (all ? 'Aucun tag.' : 'Tous les tags sont à jour.') + '</td></tr>';
        });
    }

    function loadEvents() {
        var days = Number(document.getElementById('d-days').value);
        var params = { from: Date.now() - days * 86400000, level: document.getElementById('d-level').value, device: document.getElementById('d-device').value };
        return SiteApi.request('GET', '/diagnostic/events', undefined, params).then(function (r) {
            document.getElementById('d-events').innerHTML = r.data.slice(0, 300).map(function (e) {
                var l = LEVEL[e.level] || [e.level, 'st-off'];
                return '<tr><td>' + date(e.time) + '</td><td><span class="st ' + l[1] + '">' + esc(l[0]) + '</span></td><td>' + esc(e.device || '') + '</td>' +
                    '<td><small>' + esc(e.message) + '</small></td></tr>';
            }).join('') || '<tr><td colspan="4" class="empty">Aucun événement.</td></tr>';
            document.getElementById('d-status').textContent = r.data.length + ' événement(s)' + (r.data.length > 300 ? ' (300 affichés)' : '') +
                ', mise à jour ' + SiteApi.formatDate(Date.now(), true).slice(11);
        });
    }

    function refresh() {
        Promise.all([loadSites(), loadSite(), loadEvents()]).catch(function (err) {
            document.getElementById('d-status').textContent = err.message;
            document.getElementById('d-status').className = 'status error';
        });
    }

    document.getElementById('d-alltags').addEventListener('change', loadTags);
    ['d-level', 'd-device', 'd-days'].forEach(function (id) { document.getElementById(id).addEventListener('change', loadEvents); });
    refresh();
    timer = setInterval(function () { if (!document.hidden) { refresh(); } }, 10000);
})();
