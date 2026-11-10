/**
 * custom-SCADA: HTML files of a site (runs in the FUXA instance of the site)
 *
 * After each save of the project, the folder of the site gets one HTML file per page
 * (accueil.html, courbes.html, historiques.html, ... with the synoptic and its objects)
 * and configuration.html (page Configuration + all the properties configured in the editor).
 * The list of the written files is kept in pages.json, to remove the files of the deleted pages.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MANIFEST = 'pages.json';
const CONFIGURATION_VIEW = 'v_site_configuration';
const CURVES_VIEW = 'v_site_courbes';
const HISTORY_VIEW = 'v_site_historique';
/** wait the end of the saves of the editor (one save per view, layout...) before writing */
const WRITE_DELAY = 1500;

var runtime;
var logger;
var siteName;
var siteDir;
var timer = null;
var upgradeChecked = false;
/** files of the pages, for the navigation bar of the files (set before each writing) */
var navFiles = [];

function init(_runtime, settings, _logger, _siteName) {
    runtime = _runtime;
    logger = _logger;
    siteName = _siteName;
    siteDir = path.dirname(settings.workDir);
    // the project is saved by setProject (import, new site) or setProjectData (editor)
    ['setProject', 'setProjectData'].forEach(fnc => {
        const original = runtime.project[fnc];
        runtime.project[fnc] = function () {
            return original.apply(this, arguments).then(result => {
                schedule();
                return result;
            });
        };
    });
    schedule();
}

/**
 * the page Configuration of the first sites gets the frame showing configuration.html (template.js)
 * checked once, at the first writing of the files (the pages of the project are not loaded at the start)
 */
async function upgradeConfigurationPage(project) {
    const view = ((project.hmi && project.hmi.views) || []).find(v => v.id === CONFIGURATION_VIEW);
    const upgraded = require('./template').upgradeConfigurationView(view, siteName);
    if (upgraded) {
        await runtime.project.setProjectData('set-view', upgraded);
        await runtime.update('set-view', upgraded);
        logger.info('site files: page Configuration updated (configuration.html shown in the page)');
    }
}

/** the page Configuration that shows configuration.html is not copied in configuration.html */
function showsThisFile(view) {
    return Object.values(view.items || {}).some(item => item.type === 'svg-ext-own_ctrl-iframe' &&
        /configuration\.html$/.test((item.property && item.property.address) || ''));
}

function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => writeFiles().catch(err => logger.error(`site files: ${err}`)), WRITE_DELAY);
}

async function writeFiles() {
    const project = await runtime.project.getProject(null, -1);
    if (!project || !project.hmi) {
        return;
    }
    if (!upgradeChecked && (project.hmi.views || []).length) {
        upgradeChecked = true;
        // the save of the page writes the files again (setProjectData)
        await upgradeConfigurationPage(project);
    }
    const views = project.hmi.views || [];
    const files = [];
    const used = new Set(['configuration.html']);
    const pageViews = views.filter(view => view.id !== CONFIGURATION_VIEW);
    pageViews.forEach(view => {
        files.push({ file: fileName(view.name, used), page: view.name, viewId: view.id });
    });
    const configurationView = views.find(view => view.id === CONFIGURATION_VIEW);
    const pageFiles = files.slice();
    files.splice(order(files), 0, { file: 'configuration.html', page: configurationView ? configurationView.name : 'Configuration', viewId: configurationView ? configurationView.id : null });
    // same order as the menu of the site (pages out of the menu after)
    const menu = ((project.hmi.layout && project.hmi.layout.navigation && project.hmi.layout.navigation.items) || []).map(item => item.view);
    const rankInMenu = f => { const i = menu.indexOf(f.viewId); return i < 0 ? menu.length : i; };
    navFiles = files.slice().sort((a, b) => rankInMenu(a) - rankInMenu(b));
    pageViews.forEach((view, i) => {
        fs.writeFileSync(path.join(siteDir, pageFiles[i].file), pageHtml(view, project, pageFiles[i].file));
    });
    fs.writeFileSync(path.join(siteDir, 'configuration.html'), configurationHtml(project, configurationView, pageFiles));
    // access to the data of the site (API) for the pages of the folder
    fs.copyFileSync(path.join(__dirname, 'site-api.client.js'), path.join(siteDir, 'site-api.js'));
    fs.writeFileSync(path.join(siteDir, 'api.html'), apiHtml());
    files.push({ file: 'api.html', page: 'API', viewId: null }, { file: 'site-api.js', page: 'API (script)', viewId: null });

    // remove the files of the pages deleted or renamed since the last save
    const previous = readManifest();
    previous.filter(old => !files.some(f => f.file === old.file)).forEach(old => {
        const file = path.join(siteDir, path.basename(old.file));
        if (fs.existsSync(file)) {
            fs.unlinkSync(file);
        }
    });
    fs.writeFileSync(path.join(siteDir, MANIFEST), JSON.stringify({ site: siteName, updated: new Date().toISOString(), files }, null, 2));
    logger.info(`site files: ${files.length} HTML files written in ${siteDir}`);
}

/** position of configuration.html: after accueil and courbes, like in the menu */
function order(files) {
    const index = files.findIndex(f => f.file !== 'accueil.html' && f.file !== 'courbes.html');
    return index < 0 ? files.length : index;
}

function readManifest() {
    try {
        return JSON.parse(fs.readFileSync(path.join(siteDir, MANIFEST), 'utf8')).files || [];
    } catch (err) {
        return [];
    }
}

/** accueil.html from "Accueil": lower case, no accent, - instead of the other characters */
function fileName(pageName, used) {
    const base = String(pageName || 'page').normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'page';
    let name = `${base}.html`;
    for (let i = 2; used.has(name); i++) {
        name = `${base}-${i}.html`;
    }
    used.add(name);
    return name;
}

/** page with the synoptic (SVG of the editor) and the definition of its objects */
function pageHtml(view, project, file) {
    const profile = view.profile || {};
    const tags = tagNames(project);
    const items = Object.values(view.items || {});
    const liveUrl = `/site/${encodeURIComponent(siteName)}/home/${encodeURIComponent(view.name)}`;
    const live = view.id === CURVES_VIEW ? curvesLive() : view.id === HISTORY_VIEW ? historyLive() : '';
    return document(`${view.name} - ${siteName}`, `${navBar(file)}
<header>
  <h1>${esc(view.name)} <small>${esc(siteName)}</small></h1>
  <p class="info">Fichier généré automatiquement à chaque enregistrement de l'éditeur FUXA (${esc(dateText())}).
     Version en direct : <a href="${liveUrl}">${esc(liveUrl)}</a></p>
</header>
${live}
${live ? '<h2>Synoptique de la page (copie de l\'éditeur)</h2>' : ''}
<section class="synoptic" style="background:${esc(profile.bkcolor || '#ffffff')};width:${Number(profile.width) || 1280}px;height:${Number(profile.height) || 720}px">
${view.svgcontent || ''}
</section>
<section>
  <h2>Objets de la page (${items.length})</h2>
  ${itemsTable(items, tags)}
</section>
${jsonBlock('fuxa-view', view)}`);
}

/** configuration of the site: page Configuration + connections, tags, pages, objects, menu, alarms, scripts */
function configurationHtml(project, configurationView, files) {
    const tags = tagNames(project);
    const devices = Object.values(project.devices || {});
    const views = (project.hmi && project.hmi.views) || [];
    const menu = (project.hmi.layout && project.hmi.layout.navigation && project.hmi.layout.navigation.items) || [];
    const profile = (configurationView && configurationView.profile) || {};
    return document(`Configuration - ${siteName}`, `${navBar('configuration.html')}
<header>
  <h1>Configuration <small>${esc(siteName)}</small></h1>
  <p class="info">Fichier généré automatiquement à chaque enregistrement de l'éditeur FUXA (${esc(dateText())}).
     Il contient toutes les propriétés configurées dans l'éditeur pour ce site.</p>
</header>
${configurationView && !showsThisFile(configurationView) ? `<section class="synoptic" style="background:${esc(profile.bkcolor || '#ffffff')};width:${Number(profile.width) || 1280}px;height:${Number(profile.height) || 720}px">
${configurationView.svgcontent || ''}
</section>` : ''}
<section>
  <h2>Site</h2>
  ${table(['Propriété', 'Valeur'], [
        ['Nom du site', siteName],
        ['Adresse', `/site/${siteName}/`],
        ['Version FUXA', project.version || ''],
        ['Page de démarrage', viewName(views, project.hmi.layout && project.hmi.layout.start)],
        ['Fichiers HTML', files.map(f => f.file).concat('configuration.html').join(', ')]
    ])}
</section>
${historySection()}
${curvesSection(project, views)}
<section>
  <h2>Connexions (${devices.length})</h2>
  ${table(['Nom', 'Type', 'Activée', 'Polling (ms)', 'Paramètres'], devices.map(device => [
        device.name, device.type, device.enabled === false ? 'non' : 'oui', device.polling || '', flatten(device.property)
    ]))}
</section>
<section>
  <h2>Tags</h2>
  ${devices.map(device => {
        const deviceTags = Object.values(device.tags || {});
        return `<h3>${esc(device.name)} (${deviceTags.length})</h3>` + table(
            ['Nom', 'Adresse', 'Type', 'Description', 'Enregistrement (DAQ)', 'Mise à l\'échelle', 'Format', 'Zone morte'],
            deviceTags.map(tag => [
                tag.name, tag.address || tag.memaddress || '', tag.type || '', tag.description || '',
                tag.daq && tag.daq.enabled ? `oui, ${tag.daq.interval || ''} s${tag.daq.changed ? ', au changement' : ''}` : 'non',
                tag.scale && tag.scale.mode ? flatten(tag.scale) : '',
                tag.format !== undefined && tag.format !== null ? tag.format : '',
                tag.deadband && tag.deadband.value ? tag.deadband.value : ''
            ]));
    }).join('\n')}
</section>
<section>
  <h2>Pages (${views.length})</h2>
  ${table(['Page', 'Fichier', 'Taille', 'Fond', 'Objets'], views.map(view => {
        const file = files.find(f => f.viewId === view.id);
        const profile = view.profile || {};
        return [view.name, view.id === CONFIGURATION_VIEW ? 'configuration.html' : (file ? file.file : ''),
            `${profile.width || ''} x ${profile.height || ''}`, profile.bkcolor || '', Object.keys(view.items || {}).length];
    }))}
  ${views.map(view => `<h3>Objets de la page ${esc(view.name)}</h3>` + itemsTable(Object.values(view.items || {}), tags)).join('\n')}
</section>
<section>
  <h2>Menu</h2>
  ${table(['Texte', 'Page', 'Icône', 'Lien'], menu.map(item => [item.text, viewName(views, item.view), item.icon || '', item.link || '']))}
</section>
${listSection('Alarmes', project.alarms, alarm => [alarm.name, tags[alarm.property && alarm.property.variableId] || '', flatten({ high: alarm.highhigh || alarm.high, low: alarm.low })], ['Nom', 'Tag', 'Seuils'])}
${listSection('Scripts', project.scripts, script => [script.name, script.mode || '', (script.parameters || []).map(p => p.name).join(', ')], ['Nom', 'Mode', 'Paramètres'])}
${listSection('Graphiques (courbes)', project.charts, chart => [chart.name, (chart.lines || []).map(line => tags[line.id] || line.name || line.id).join(', ')], ['Nom', 'Tags'])}
${jsonBlock('fuxa-configuration', { site: siteName, devices: project.devices, hmi: project.hmi, alarms: project.alarms, scripts: project.scripts, charts: project.charts })}`);
}

/** source of the history (FUXA or PostgreSQL), without the password (history.js, _appdata/history-db.json) */
function historySection() {
    let config = { source: 'fuxa' };
    try {
        config = JSON.parse(fs.readFileSync(path.join(siteDir, '_appdata', 'history-db.json'), 'utf8'));
    } catch (err) {
        // no configuration: history of FUXA
    }
    const match = { name: 'nom du tag', address: 'adresse du tag', id: 'identifiant FUXA du tag' };
    const rows = config.source === 'postgres' ? [
        ['Source', 'PostgreSQL (lecture seule)'],
        ['Serveur', `${config.host}:${config.port}${config.ssl ? ' (SSL)' : ''}`],
        ['Base / utilisateur', `${config.database} / ${config.user}`],
        ['Table', config.table],
        ['Colonnes', `tag : ${config.tagColumn}, date/heure : ${config.timeColumn}, valeur : ${config.valueColumn}`],
        ['Correspondance', `la colonne ${config.tagColumn} contient le ${match[config.tagMatch] || match.name}`],
        ['Fuseau des dates', config.timeZone === 'UTC' ? 'UTC' : 'heure locale du serveur FUXA'],
        ['Filtre site', config.siteColumn ? `${config.siteColumn} = ${config.siteValue}` : 'aucun']
    ] : [['Source', 'FUXA (enregistrement intégré, SQLite)']];
    return `<section>
  <h2>Source de l'historique</h2>
  <p class="info">Données des pages Courbes et Historiques et de l'API. À modifier dans l'éditeur : panneau Sites, menu du site, Base de données (historique).</p>
  ${table(['Propriété', 'Valeur'], rows)}
</section>`;
}

/** choice of the period: dates + quick buttons, calls window.loadData(from, to) */
function periodControls() {
    return `<div class="period">
  <label>Du <input type="datetime-local" id="from"></label>
  <label>Au <input type="datetime-local" id="to"></label>
  <button data-hours="1">1 h</button><button data-hours="8">8 h</button><button data-hours="24">24 h</button><button data-hours="168">7 j</button>
  <button id="show" class="primary">Afficher</button>
  <span id="status" class="status"></span>
</div>
<script>
  (function () {
    var from = document.getElementById('from'), to = document.getElementById('to');
    function setLast(hours) {
      var now = Date.now();
      from.value = SiteApi.inputValue(now - hours * 3600000);
      to.value = SiteApi.inputValue(now);
      window.loadData(new Date(from.value), new Date(to.value));
    }
    document.querySelectorAll('.period [data-hours]').forEach(function (b) {
      b.addEventListener('click', function () { setLast(Number(b.getAttribute('data-hours'))); });
    });
    document.getElementById('show').addEventListener('click', function () {
      window.loadData(new Date(from.value), new Date(to.value));
    });
    window.addEventListener('load', function () { setLast(8); });
  })();
  function setStatus(text, error) {
    var s = document.getElementById('status');
    s.textContent = text;
    s.className = 'status' + (error ? ' error' : '');
  }
</script>`;
}

/** courbes.html: curves of the tags configured for the page Courbes, from the API */
function curvesLive() {
    return `<section>
  <h2>Courbes (données de l'API du site)</h2>
  ${periodControls()}
  <div id="legend" class="legend"></div>
  <canvas id="chart" class="chart"></canvas>
</section>
<script src="site-api.js"></script>
<script>
  var curves = [];
  window.loadData = function (from, to) {
    setStatus('Chargement...');
    SiteApi.info().then(function (info) {
      curves = info.curves;
      if (!curves.length) {
        throw new Error('Aucun tag choisi : éditeur, panneau Sites, menu du site, Tags des courbes.');
      }
      return SiteApi.history({ tags: curves.map(function (c) { return c.tagId; }), from: from, to: to });
    }).then(function (data) {
      document.getElementById('legend').innerHTML = data.series.map(function (s) {
        var c = curves.find(function (x) { return x.tagId === s.id; }) || {};
        return '<span><i style="background:' + (c.color || '#1565C0') + '"></i>' + (c.label || s.name) + ' (' + (c.axis || 'gauche') + ', ' + s.count + ' valeurs)</span>';
      }).join('');
      SiteApi.drawChart(document.getElementById('chart'), data, curves);
      setStatus(data.series.reduce(function (n, s) { return n + s.count; }, 0) + ' valeurs, source : ' + data.source);
    }).catch(function (err) { setStatus(err.message, true); });
  };
</script>`;
}

/** historiques.html: table of the history of the tags of the page Courbes, from the API */
function historyLive() {
    return `<section>
  <h2>Historique (données de l'API du site)</h2>
  ${periodControls()}
  <p><button id="csv">Exporter en CSV</button></p>
  <div id="table" class="history"></div>
</section>
<script src="site-api.js"></script>
<script>
  var last = null;
  function escapeHtml(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  window.loadData = function (from, to) {
    setStatus('Chargement...');
    var labels = {};
    SiteApi.info().then(function (info) {
      info.curves.forEach(function (c) { labels[c.tagId] = c.label; });
      if (!info.curves.length) {
        throw new Error('Aucun tag choisi : éditeur, panneau Sites, menu du site, Tags des courbes.');
      }
      return SiteApi.history({ tags: info.curves.map(function (c) { return c.tagId; }), from: from, to: to, maxPoints: 5000 });
    }).then(function (data) {
      last = SiteApi.historyTable(data, labels);
      document.getElementById('table').innerHTML = '<table><thead><tr>' + last.head.map(function (h) { return '<th>' + escapeHtml(h) + '</th>'; }).join('') +
        '</tr></thead><tbody>' + last.rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + escapeHtml(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table>';
      setStatus(last.rows.length + ' lignes, source : ' + data.source);
    }).catch(function (err) { setStatus(err.message, true); });
  };
  document.getElementById('csv').addEventListener('click', function () {
    if (!last) { return; }
    var csv = [last.head].concat(last.rows).map(function (r) { return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(';'); }).join('\\r\\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'historique-${esc(siteName)}.csv';
    a.click();
  });
</script>`;
}

/** api.html: services of the API of the site, with a test of each service */
function apiHtml() {
    const base = `/site/${siteName}/api/site`;
    return document(`API - ${siteName}`, `${navBar('api.html')}
<header>
  <h1>API du site <small>${esc(siteName)}</small></h1>
  <p class="info">Services d'accès aux données de ce site (tags, valeurs, historique). Chaque site a sa propre API : elle ne donne que les données du site.
     Les pages du dossier utilisent le script <a href="site-api.js">site-api.js</a>.</p>
</header>
<section>
  <h2>Services</h2>
  ${table(['Service', 'Adresse', 'Paramètres', 'Réponse'], [
        ['Informations', `GET ${base}/info`, '', 'site, tags (nom, connexion, adresse, type, enregistré), curves (tags de la page Courbes), source de l\'historique'],
        ['Valeurs actuelles', `GET ${base}/values`, 'tags=nom1,nom2 (tous les tags si absent)', 'values : nom, valeur, timestamp'],
        ['Historique', `GET ${base}/history`, 'tags=nom1,nom2 (tags des courbes si absent)\nfrom, to : ms ou date ISO (8 dernières heures si absent)\nmaxPoints : 2000 par défaut', 'series : nom, count, values [{ t : ms, v : valeur }]']
    ])}
</section>
<section>
  <h2>Utilisation dans une page HTML du dossier</h2>
  <pre>&lt;script src="site-api.js"&gt;&lt;/script&gt;
&lt;script&gt;
  SiteApi.info().then(function (info) { console.log(info.tags, info.curves); });
  SiteApi.values(['reservoir_niveau']).then(function (r) { console.log(r.values); });
  SiteApi.history({ tags: ['reservoir_niveau'], from: new Date(Date.now() - 3600000), to: new Date() })
    .then(function (r) { console.log(r.series); });
&lt;/script&gt;</pre>
</section>
<section>
  <h2>Tester</h2>
  <div class="period">
    <select id="service"><option value="/info">info</option><option value="/values">values</option><option value="/history">history</option></select>
    <input id="params" placeholder="tags=reservoir_niveau&amp;from=..." size="60">
    <button id="run" class="primary">Envoyer</button>
  </div>
  <pre id="result">Résultat...</pre>
</section>
<script src="site-api.js"></script>
<script>
  document.getElementById('run').addEventListener('click', function () {
    var url = SiteApi.base + document.getElementById('service').value;
    var params = document.getElementById('params').value.trim();
    document.getElementById('result').textContent = 'GET ' + url + (params ? '?' + params : '') + ' ...';
    fetch(url + (params ? '?' + params : '')).then(function (r) { return r.json(); }).then(function (body) {
      document.getElementById('result').textContent = JSON.stringify(body, null, 2);
    }).catch(function (err) { document.getElementById('result').textContent = err.message; });
  });
</script>`);
}

/** tags chosen for the page Courbes (lines of the chart shown by the page) */
function curvesSection(project, views) {
    const curvesView = views.find(view => view.id === CURVES_VIEW);
    const chartItem = Object.values((curvesView && curvesView.items) || {}).find(item => item.type === 'svg-ext-html_chart' && item.property && item.property.id);
    const chart = chartItem ? (project.charts || []).find(c => c.id === chartItem.property.id) : null;
    const allTags = {};
    Object.values(project.devices || {}).forEach(device => Object.values(device.tags || {}).forEach(tag => allTags[tag.id] = { device, tag }));
    const lines = (chart && chart.lines) || [];
    return `<section>
  <h2>Tags des courbes (page Courbes)</h2>
  <p class="info">Tags affichés par le graphique de la page Courbes. La période est choisie avec le calendrier du graphique.</p>
  ${table(['Libellé', 'Tag', 'Connexion', 'Couleur', 'Axe', 'Enregistré (historique)'], lines.map(line => {
        const found = allTags[line.id];
        return [line.label || line.name, found ? found.tag.name : line.name || line.id, found ? found.device.name : line.device || '',
            line.color || '', Number(line.yaxis) === 2 ? 'droite' : 'gauche',
            found && found.tag.daq && found.tag.daq.enabled ? `oui (${found.tag.daq.interval || ''} s)` : 'non'];
    }))}
  ${curvesEditor()}
</section>`;
}

/**
 * choice of the tags of the page Courbes in configuration.html: list of the tags of the site (API info),
 * saved with the API (PUT curves); the file is written again by the server after the save
 */
function curvesEditor() {
    return `<h3>Choisir les tags des courbes</h3>
<p class="info">Cochez les tags à afficher dans la page Courbes, puis Enregistrer. Les tags choisis sont enregistrés (historique).</p>
<div class="period">
  <input id="curves-filter" placeholder="Rechercher un tag" size="30">
  <button id="curves-save" class="primary">Enregistrer</button>
  <span id="curves-status" class="status"></span>
</div>
<div class="history"><table><thead><tr><th></th><th>Tag</th><th>Connexion</th><th>Adresse</th><th>Libellé de la courbe</th><th>Couleur</th><th>Axe</th></tr></thead>
<tbody id="curves-rows"><tr><td colspan="7" class="empty">Chargement...</td></tr></tbody></table></div>
<script src="site-api.js"></script>
<script>
  (function () {
    var colors = ['#1565C0', '#E65100', '#2E7D32', '#C62828', '#6A1B9A', '#00838F', '#F9A825', '#4E342E', '#AD1457', '#37474F'];
    var rows = [];
    function status(text, error) {
      var s = document.getElementById('curves-status');
      s.textContent = text;
      s.className = 'status' + (error ? ' error' : '');
    }
    function escapeHtml(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function render() {
      var text = document.getElementById('curves-filter').value.trim().toLowerCase();
      document.getElementById('curves-rows').innerHTML = rows.map(function (r, i) {
        var visible = !text || (r.name + ' ' + r.device + ' ' + r.label + ' ' + r.address).toLowerCase().indexOf(text) >= 0;
        return '<tr' + (visible ? '' : ' style="display:none"') + '>' +
          '<td><input type="checkbox" data-i="' + i + '" data-f="selected"' + (r.selected ? ' checked' : '') + '></td>' +
          '<td>' + escapeHtml(r.name) + (r.recorded ? ' &#128339;' : '') + '</td><td>' + escapeHtml(r.device) + '</td><td>' + escapeHtml(r.address) + '</td>' +
          '<td><input data-i="' + i + '" data-f="label" value="' + escapeHtml(r.label) + '" size="24"></td>' +
          '<td><input type="color" data-i="' + i + '" data-f="color" value="' + r.color + '"></td>' +
          '<td><select data-i="' + i + '" data-f="axis"><option value="gauche"' + (r.axis !== 'droite' ? ' selected' : '') + '>gauche</option>' +
          '<option value="droite"' + (r.axis === 'droite' ? ' selected' : '') + '>droite</option></select></td></tr>';
      }).join('') || '<tr><td colspan="7" class="empty">Aucun tag dans ce site.</td></tr>';
    }
    function load() {
      SiteApi.info().then(function (info) {
        rows = info.tags.map(function (t, i) {
          var c = info.curves.filter(function (x) { return x.tagId === t.id; })[0];
          return { tag: t.id, name: t.name, device: t.device, address: t.address, recorded: t.recorded, selected: !!c,
            label: c ? c.label : t.name, color: (c && c.color ? c.color : colors[i % colors.length]).slice(0, 7), axis: c ? c.axis : 'gauche',
            order: c ? info.curves.indexOf(c) : 1000 + i };
        }).sort(function (a, b) { return a.order - b.order; });
        // a tag not yet chosen gets a color not used by the chosen curves
        var used = rows.filter(function (r) { return r.selected; }).map(function (r) { return r.color.toLowerCase(); });
        var free = colors.filter(function (c) { return used.indexOf(c.toLowerCase()) < 0; });
        rows.filter(function (r) { return !r.selected; }).forEach(function (r, i) { if (free.length) { r.color = free[i % free.length]; } });
        render();
        status(info.curves.length + ' tag(s) choisi(s)');
      }).catch(function (err) { status(err.message, true); });
    }
    document.getElementById('curves-rows').addEventListener('change', function (e) {
      var i = e.target.getAttribute('data-i'), f = e.target.getAttribute('data-f');
      if (i !== null) { rows[i][f] = f === 'selected' ? e.target.checked : e.target.value; }
    });
    document.getElementById('curves-rows').addEventListener('input', function (e) {
      var i = e.target.getAttribute('data-i'), f = e.target.getAttribute('data-f');
      if (i !== null && f === 'label') { rows[i].label = e.target.value; }
    });
    document.getElementById('curves-filter').addEventListener('input', render);
    document.getElementById('curves-save').addEventListener('click', function () {
      var curves = rows.filter(function (r) { return r.selected; }).map(function (r) {
        return { tag: r.tag, label: r.label, color: r.color, axis: r.axis };
      });
      status('Enregistrement...');
      SiteApi.saveCurves(curves).then(function (result) {
        status('Enregistré : ' + result.curves.length + ' tag(s). Page Courbes mise à jour.');
        setTimeout(function () { location.reload(); }, 2500);
      }).catch(function (err) { status(err.message, true); });
    });
    load();
  })();
</script>`;
}

function itemsTable(items, tags) {
    if (!items.length) {
        return '<p class="empty">Aucun objet.</p>';
    }
    return table(['Nom', 'Type', 'Tag', 'Propriétés'], items.map(item => {
        const property = Object.assign({}, item.property);
        const tag = tags[property.variableId] || property.variableId || '';
        delete property.variableId;
        return [item.name || item.id, typeName(item.type), tag, flatten(property, tags)];
    }));
}

function listSection(title, list, row, head) {
    const values = Array.isArray(list) ? list : Object.values(list || {});
    if (!values.length) {
        return '';
    }
    return `<section><h2>${esc(title)} (${values.length})</h2>${table(head, values.map(row))}</section>`;
}

/** id of tag -> "device / name" */
function tagNames(project) {
    const names = {};
    Object.values(project.devices || {}).forEach(device => {
        Object.values(device.tags || {}).forEach(tag => {
            names[tag.id] = `${device.name} / ${tag.name}`;
        });
    });
    return names;
}

function viewName(views, id) {
    if (!id) {
        return '';
    }
    const view = views.find(v => v.id === id);
    return view ? view.name : id;
}

function typeName(type) {
    return String(type || '').replace(/^svg-ext-/, '').replace(/^html_/, '').replace(/^proceng-/, '');
}

/** properties as "key: value" lines, empty values removed, tag ids replaced by the tag names */
function flatten(value, tags = {}, prefix = '') {
    if (value === null || value === undefined || value === '') {
        return '';
    }
    if (typeof value !== 'object') {
        return `${prefix}${tags[value] || value}`;
    }
    const lines = [];
    const entries = Array.isArray(value) ? value.map((v, i) => [String(i + 1), v]) : Object.entries(value);
    entries.forEach(([key, v]) => {
        if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length) ||
            (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)) {
            return;
        }
        if (typeof v === 'object') {
            const inner = flatten(v, tags, '');
            if (inner) {
                lines.push(`${key}: { ${inner.split('\n').join(', ')} }`);
            }
        } else {
            lines.push(`${key}: ${tags[v] || v}`);
        }
    });
    return prefix + lines.join('\n');
}

function table(head, rows) {
    if (!rows.length) {
        return '<p class="empty">Aucun élément.</p>';
    }
    return `<table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>
${rows.map(row => `<tr>${row.map(cell => `<td>${esc(cell).replace(/\n/g, '<br>')}</td>`).join('')}</tr>`).join('\n')}
</tbody></table>`;
}

/** full definition, readable by a program: <script type="application/json"> */
function jsonBlock(id, value) {
    const json = JSON.stringify(value, null, 1).replace(/</g, '\\u003c');
    return `<details><summary>Définition complète (JSON)</summary><pre>${esc(JSON.stringify(value, null, 2))}</pre></details>
<script type="application/json" id="${id}">${json}</script>`;
}

/**
 * navigation bar of the files: back, supervision of the site, the other files, API, editor
 * (hidden when the file is shown in a page of FUXA, frame of the page Configuration)
 */
function navBar(current) {
    const base = `/site/${encodeURIComponent(siteName)}`;
    const link = (href, text, active) => `<a href="${href}"${active ? ' class="active"' : ''}>${esc(text)}</a>`;
    const pages = navFiles.map(f => link(f.file, f.page, f.file === current)).join('');
    return `<nav class="sitenav" id="sitenav">
  <a href="${base}/home" class="back" onclick="if (history.length > 1 && document.referrer) { history.back(); return false; }">&#8592; Retour</a>
  ${link(`${base}/home`, 'Supervision')}
  <span class="sep"></span>${pages}${link('api.html', 'API', current === 'api.html')}
  <span class="sep"></span>${link(`${base}/editor`, 'Éditeur')}
</nav>
<script>if (window.self !== window.top) { document.getElementById('sitenav').style.display = 'none'; }</script>`;
}

function document(title, body) {
    return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body { font-family: Arial, sans-serif; margin: 20px; color: #222; background: #f4f5f7; }
  h1 { color: #0d47a1; margin: 0 0 4px 0; } h1 small { color: #666; font-size: 60%; margin-left: 10px; }
  h2 { color: #1f3864; border-bottom: 2px solid #1f3864; padding-bottom: 4px; margin-top: 28px; }
  h3 { color: #2e74b5; margin-top: 18px; }
  .info { color: #555; font-size: 13px; }
  .synoptic { overflow: auto; border: 1px solid #bbb; max-width: 100%; }
  table { border-collapse: collapse; width: 100%; background: #fff; font-size: 13px; }
  th { background: #1f3864; color: #fff; text-align: left; padding: 5px 8px; }
  td { border: 1px solid #ccc; padding: 4px 8px; vertical-align: top; }
  .empty { color: #888; font-style: italic; }
  details { margin-top: 24px; } pre { background: #fff; border: 1px solid #ccc; padding: 10px; overflow: auto; max-height: 400px; font-size: 12px; }
  .period { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 10px 0; }
  .period input, .period select { padding: 4px; } .period button, button { padding: 5px 12px; cursor: pointer; }
  button.primary { background: #1e88e5; color: #fff; border: none; border-radius: 3px; }
  .status { font-size: 13px; color: #555; } .status.error { color: #c62828; font-weight: bold; }
  .chart { width: 100%; height: 420px; background: #fff; border: 1px solid #ccc; display: block; }
  .legend { display: flex; flex-wrap: wrap; gap: 16px; margin: 6px 0; font-size: 13px; }
  .legend i { display: inline-block; width: 22px; height: 4px; margin-right: 6px; vertical-align: middle; }
  .history { max-height: 520px; overflow: auto; }
  .sitenav { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin: -20px -20px 18px -20px; padding: 8px 20px; background: #1f3864; position: sticky; top: 0; z-index: 10; }
  .sitenav a { color: #fff; text-decoration: none; padding: 5px 10px; border-radius: 3px; font-size: 14px; }
  .sitenav a:hover { background: rgba(255,255,255,0.15); } .sitenav a.active { background: #1e88e5; }
  .sitenav a.back { font-weight: bold; border: 1px solid rgba(255,255,255,0.5); margin-right: 6px; }
  .sitenav .sep { width: 1px; height: 20px; background: rgba(255,255,255,0.35); margin: 0 6px; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

function dateText() {
    return new Date().toLocaleString('fr-FR');
}

function esc(text) {
    return String(text === null || text === undefined ? '' : text)
        .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

module.exports = {
    init: init,
    /** write the files again (after a change outside of the project, like the source of the history) */
    refresh: () => runtime && schedule()
};
