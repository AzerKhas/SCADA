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
/** wait the end of the saves of the editor (one save per view, layout...) before writing */
const WRITE_DELAY = 1500;

var runtime;
var logger;
var siteName;
var siteDir;
var timer = null;

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

function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => writeFiles().catch(err => logger.error(`site files: ${err}`)), WRITE_DELAY);
}

async function writeFiles() {
    const project = await runtime.project.getProject(null, -1);
    if (!project || !project.hmi) {
        return;
    }
    const views = project.hmi.views || [];
    const files = [];
    const used = new Set(['configuration.html']);
    views.filter(view => view.id !== CONFIGURATION_VIEW).forEach(view => {
        const file = fileName(view.name, used);
        fs.writeFileSync(path.join(siteDir, file), pageHtml(view, project));
        files.push({ file, page: view.name, viewId: view.id });
    });
    const configurationView = views.find(view => view.id === CONFIGURATION_VIEW);
    fs.writeFileSync(path.join(siteDir, 'configuration.html'), configurationHtml(project, configurationView, files));
    files.splice(order(files), 0, { file: 'configuration.html', page: configurationView ? configurationView.name : 'Configuration', viewId: configurationView ? configurationView.id : null });

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
function pageHtml(view, project) {
    const profile = view.profile || {};
    const tags = tagNames(project);
    const items = Object.values(view.items || {});
    const liveUrl = `/site/${encodeURIComponent(siteName)}/home/${encodeURIComponent(view.name)}`;
    return document(`${view.name} - ${siteName}`, `
<header>
  <h1>${esc(view.name)} <small>${esc(siteName)}</small></h1>
  <p class="info">Fichier généré automatiquement à chaque enregistrement de l'éditeur FUXA (${esc(dateText())}).
     Version en direct : <a href="${liveUrl}">${esc(liveUrl)}</a></p>
</header>
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
    return document(`Configuration - ${siteName}`, `
<header>
  <h1>Configuration <small>${esc(siteName)}</small></h1>
  <p class="info">Fichier généré automatiquement à chaque enregistrement de l'éditeur FUXA (${esc(dateText())}).
     Il contient toutes les propriétés configurées dans l'éditeur pour ce site.</p>
</header>
${configurationView ? `<section class="synoptic" style="background:${esc(profile.bkcolor || '#ffffff')};width:${Number(profile.width) || 1280}px;height:${Number(profile.height) || 720}px">
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
    init: init
};
