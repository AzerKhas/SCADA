/**
 * custom-SCADA: versions.js, page Versions of a site (versions.html): versions of the site (changes, comparison
 * of the HTML files, restoration) and full backups of the folder of the site (creation, download, restoration).
 * Uses the API v1 of the server with site-api.js; the page has <div id="versions-app">.
 */
(function () {
    'use strict';

    var app = document.getElementById('versions-app');
    var versions = [];
    var current = null;

    function esc(t) {
        return String(t === null || t === undefined ? '' : t).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c];
        });
    }

    function date(ms) {
        return SiteApi.formatDate(ms, true);
    }

    function size(bytes) {
        return bytes > 1048576 ? (bytes / 1048576).toFixed(1) + ' Mo' : Math.max(1, Math.round(bytes / 1024)) + ' Ko';
    }

    function status(id, text, error) {
        var el = document.getElementById(id);
        el.textContent = text;
        el.className = 'status' + (error ? ' error' : '');
    }

    app.innerHTML =
        '<section><h2>Versions du site</h2>' +
        '<div class="period"><input id="v-comment" size="50" placeholder="Description (ex. avant modification du synoptique)">' +
        '<button id="v-create" class="primary">Créer une version</button><span id="v-status" class="status"></span></div>' +
        '<div class="history"><table><thead><tr><th>Date</th><th>Type</th><th>Description</th><th>Modifications par rapport à la version précédente</th><th></th></tr></thead>' +
        '<tbody id="v-rows"><tr><td colspan="5" class="empty">Chargement...</td></tr></tbody></table></div>' +
        '<div id="v-detail"></div></section>' +
        '<section><h2>Sauvegardes complètes du dossier</h2>' +
        '<div class="period"><input id="b-comment" size="50" placeholder="Description (facultatif)">' +
        '<button id="b-create" class="primary">Créer une sauvegarde</button><span id="b-status" class="status"></span></div>' +
        '<table><thead><tr><th>Date</th><th>Type</th><th>Description</th><th>Taille</th><th>Fichiers</th><th></th></tr></thead>' +
        '<tbody id="b-rows"><tr><td colspan="6" class="empty">Chargement...</td></tr></tbody></table></section>';

    // ---------------------------------------------------------------- versions
    function loadVersions() {
        return SiteApi.request('GET', '/versions').then(function (r) {
            versions = r.data;
            document.getElementById('v-rows').innerHTML = versions.map(function (v, i) {
                return '<tr' + (current === v.version_id ? ' style="background:#e3f2fd"' : '') + '><td>' + date(v.time) + (i === 0 ? ' <b>(dernière)</b>' : '') + '</td>' +
                    '<td>' + esc(v.typeText) + '</td><td>' + esc(v.comment) + '</td><td>' + esc(v.summary) + '</td>' +
                    '<td style="white-space:nowrap"><button data-show="' + esc(v.version_id) + '">Modifications</button> ' +
                    (i === 0 ? '' : '<button data-restore="' + esc(v.version_id) + '">Restaurer</button>') + '</td></tr>';
            }).join('') || '<tr><td colspan="5" class="empty">Aucune version : elles sont créées à chaque enregistrement de l’éditeur.</td></tr>';
            status('v-status', versions.length + ' version(s)');
        }).catch(function (err) { status('v-status', err.message, true); });
    }

    var ACTION_COLORS = { 'ajouté': '#2e7d32', 'supprimé': '#c62828', 'modifié': '#e65100' };

    function showVersion(id) {
        current = id;
        loadVersions();
        var box = document.getElementById('v-detail');
        box.innerHTML = '<p class="status">Chargement...</p>';
        SiteApi.request('GET', '/versions/' + encodeURIComponent(id)).then(function (r) {
            var v = r.data;
            var others = versions.filter(function (x) { return x.version_id !== id; });
            box.innerHTML = '<h3>Version du ' + date(v.time) + ' (' + esc(v.typeText) + ')' + (v.comment ? ' : ' + esc(v.comment) : '') + '</h3>' +
                '<div class="period"><label>Comparer avec <select id="v-with"><option value="previous">la version précédente</option>' +
                '<option value="current">l’état actuel du site</option>' +
                others.map(function (x) { return '<option value="' + esc(x.version_id) + '">la version du ' + date(x.time) + '</option>'; }).join('') +
                '</select></label><span id="v-sum" class="status"></span></div>' +
                '<div id="v-changes"></div>' +
                '<h3>Comparer un fichier HTML ligne par ligne</h3>' +
                '<div class="period"><select id="v-file">' + v.files.map(function (f) { return '<option>' + esc(f) + '</option>'; }).join('') + '</select>' +
                '<button id="v-diff">Comparer</button><span id="v-diff-status" class="status"></span></div>' +
                '<div id="v-diff-view"></div>';
            document.getElementById('v-with').addEventListener('change', function () { loadChanges(id); });
            document.getElementById('v-diff').addEventListener('click', function () { loadDiff(id); });
            loadChanges(id);
            box.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }).catch(function (err) { box.innerHTML = '<p class="status error">' + esc(err.message) + '</p>'; });
    }

    function loadChanges(id) {
        var other = document.getElementById('v-with').value;
        SiteApi.request('GET', '/versions/' + encodeURIComponent(id) + '/changes', undefined, { with: other }).then(function (r) {
            document.getElementById('v-sum').textContent = r.meta.summary;
            document.getElementById('v-changes').innerHTML = r.data.length ? '<table><thead><tr><th>Catégorie</th><th>Élément</th><th>Action</th><th>Détails</th></tr></thead><tbody>' +
                r.data.map(function (c) {
                    return '<tr><td>' + esc(c.category) + '</td><td>' + esc(c.name) + '</td><td style="color:' + (ACTION_COLORS[c.action] || '#333') + ';font-weight:bold">' +
                        esc(c.action) + '</td><td>' + esc(c.details || '') + '</td></tr>';
                }).join('') + '</tbody></table>' : '<p class="empty">Aucune modification.</p>';
            document.getElementById('v-diff-view').innerHTML = '';
        }).catch(function (err) { document.getElementById('v-changes').innerHTML = '<p class="status error">' + esc(err.message) + '</p>'; });
    }

    function loadDiff(id) {
        var file = document.getElementById('v-file').value;
        var other = document.getElementById('v-with').value;
        status('v-diff-status', 'Comparaison...');
        SiteApi.request('GET', '/versions/' + encodeURIComponent(id) + '/diff', undefined, { file: file, with: other }).then(function (r) {
            status('v-diff-status', r.meta.added + ' ligne(s) ajoutée(s), ' + r.meta.removed + ' ligne(s) supprimée(s)');
            document.getElementById('v-diff-view').innerHTML = '<pre class="diff">' + r.data.map(function (l) {
                if (l.type === '…') {
                    return '<span class="d-skip">… ' + l.count + ' ligne(s) identique(s)</span>';
                }
                var cls = l.type === '+' ? 'd-add' : l.type === '-' ? 'd-del' : 'd-same';
                var num = (l.type === '+' ? '' : l.a) + '/' + (l.type === '-' ? '' : l.b);
                return '<span class="' + cls + '"><i>' + num + '</i>' + l.type + ' ' + esc(l.line) + '</span>';
            }).join('') + '</pre>';
        }).catch(function (err) { status('v-diff-status', err.message, true); });
    }

    function restoreVersion(id) {
        var v = versions.filter(function (x) { return x.version_id === id; })[0];
        if (!v || !confirm('Restaurer la version du ' + date(v.time) + ' ?\n\nL’état actuel du site est conservé dans une version « avant restauration », il peut être restauré ensuite.')) {
            return;
        }
        status('v-status', 'Restauration...');
        SiteApi.request('POST', '/versions/' + encodeURIComponent(id) + '/restore').then(function () {
            status('v-status', 'Version du ' + date(v.time) + ' restaurée. Les fichiers du site sont mis à jour...');
            setTimeout(loadVersions, 4000);
        }).catch(function (err) { status('v-status', 'Non restaurée : ' + err.message, true); });
    }

    document.getElementById('v-rows').addEventListener('click', function (e) {
        var show = e.target.getAttribute('data-show'), restore = e.target.getAttribute('data-restore');
        if (show) { showVersion(show); }
        if (restore) { restoreVersion(restore); }
    });
    document.getElementById('v-create').addEventListener('click', function () {
        var comment = document.getElementById('v-comment').value.trim();
        if (!comment) {
            status('v-status', 'Écrire une description de la version.', true);
            return;
        }
        status('v-status', 'Création...');
        SiteApi.request('POST', '/versions', { comment: comment }).then(function (r) {
            document.getElementById('v-comment').value = '';
            status('v-status', 'Version créée : ' + r.data.summary);
            loadVersions();
        }).catch(function (err) { status('v-status', err.message, true); });
    });

    // ---------------------------------------------------------------- backups
    function loadBackups() {
        return SiteApi.request('GET', '/backups').then(function (r) {
            document.getElementById('b-rows').innerHTML = r.data.map(function (b) {
                return '<tr><td>' + date(b.time) + '</td><td>' + esc(b.typeText) + '</td><td>' + esc(b.comment) + '</td><td>' + size(b.size) + '</td>' +
                    '<td>' + (b.files || '') + '</td><td style="white-space:nowrap">' +
                    '<a href="' + SiteApi.base + '/backups/' + encodeURIComponent(b.backup_id) + '"><button>Télécharger</button></a> ' +
                    '<button data-brestore="' + esc(b.backup_id) + '">Restaurer</button> <button data-bdelete="' + esc(b.backup_id) + '">Supprimer</button></td></tr>';
            }).join('') || '<tr><td colspan="6" class="empty">Aucune sauvegarde.</td></tr>';
            status('b-status', r.data.length + ' sauvegarde(s)');
        }).catch(function (err) { status('b-status', err.message, true); });
    }

    /** after the restoration of a backup the site starts again: wait for it, then load the page again */
    function waitSite(tries) {
        SiteApi.request('GET', '/config').then(function () { location.reload(); }).catch(function () {
            if (tries > 0) { setTimeout(function () { waitSite(tries - 1); }, 2000); } else { status('b-status', 'Le site ne répond pas encore, recharger la page.', true); }
        });
    }

    document.getElementById('b-rows').addEventListener('click', function (e) {
        var restore = e.target.getAttribute('data-brestore'), del = e.target.getAttribute('data-bdelete');
        if (restore) {
            if (!confirm('Restaurer la sauvegarde ' + restore + ' ?\n\nLe site est arrêté, son dossier est remplacé par celui de la sauvegarde, puis il redémarre. ' +
                'Le dossier actuel est d’abord sauvegardé (« avant restauration »).')) {
                return;
            }
            status('b-status', 'Restauration en cours, le site redémarre...');
            SiteApi.request('POST', '/backups/' + encodeURIComponent(restore) + '/restore').then(function () {
                status('b-status', 'Sauvegarde restaurée, rechargement de la page...');
                waitSite(30);
            }).catch(function (err) { status('b-status', 'Non restaurée : ' + err.message, true); });
        }
        if (del) {
            if (!confirm('Supprimer définitivement la sauvegarde ' + del + ' ?')) {
                return;
            }
            SiteApi.request('DELETE', '/backups/' + encodeURIComponent(del)).then(loadBackups).catch(function (err) { status('b-status', err.message, true); });
        }
    });
    document.getElementById('b-create').addEventListener('click', function () {
        status('b-status', 'Création de la sauvegarde...');
        SiteApi.request('POST', '/backups', { comment: document.getElementById('b-comment').value.trim() }).then(function (r) {
            document.getElementById('b-comment').value = '';
            status('b-status', 'Sauvegarde créée (' + size(r.data.size) + ').');
            loadBackups();
        }).catch(function (err) { status('b-status', err.message, true); });
    });

    loadVersions();
    loadBackups();
})();
