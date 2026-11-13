/**
 * custom-SCADA: first project of a new site, made from the template "Site pilote"
 * with the base pages: Accueil, Courbes, Configuration, Historiques, Alarmes
 */

'use strict';

const fs = require('fs');
const path = require('path');

const TEMPLATE = ['templates', 'site-pilote', 'site-pilote.fuxap'];

/**
 * @param name name of the site, written in the title of the pages
 * @param appDir server folder of FUXA (the templates folder is next to it)
 */
function create(name, appDir) {
    const file = path.resolve(appDir, '..', ...TEMPLATE);
    const project = JSON.parse(fs.readFileSync(file, 'utf8'));
    const views = project.hmi.views;
    const safeName = escapeXml(name);
    views.forEach(view => {
        view.svgcontent = (view.svgcontent || '').replace(/NOM DU SITE/g, safeName);
    });
    const history = views.find(view => view.id === 'v_site_historique');
    if (history) {
        history.name = 'Historiques';
    }
    const charts = views.find(view => view.id === 'v_site_courbes');
    if (charts) {
        simplifyCurvesView(charts);
    }
    views.push(configurationView(name, charts || views[0]));
    views.push(alarmsView(name, charts || views[0]));
    // order of the pages in the editor: Accueil, Courbes, Configuration, Historiques, Alarmes
    const order = ['v_site_accueil', 'v_site_courbes', 'v_site_configuration', 'v_site_historique', ALARMS_VIEW];
    views.sort((a, b) => rank(order, a.id) - rank(order, b.id));

    const navigation = project.hmi.layout.navigation;
    // the page Alarmes of the site replaces the alarm page of FUXA ([alarms]) in the menu
    navigation.items = [
        menuItem('n_accueil', 'Accueil', 'v_site_accueil', 'home'),
        menuItem('n_courbes', 'Courbes', 'v_site_courbes', 'show_chart'),
        menuItem('n_configuration', 'Configuration', 'v_site_configuration', 'settings'),
        menuItem('n_historique', 'Historiques', 'v_site_historique', 'history'),
        alarmsMenuItem()
    ];
    project.hmi.layout.start = 'v_site_accueil';
    return project;
}

/**
 * page Courbes: the period is chosen with the calendar of the chart (its toolbar),
 * so the date fields and the button of the template (without action) are removed
 */
function simplifyCurvesView(view) {
    const removed = Object.values(view.items || {}).filter(item =>
        ['courbes_date_debut', 'courbes_date_fin', 'courbes_btn_afficher'].includes(item.name));
    let svg = view.svgcontent || '';
    removed.forEach(item => {
        delete view.items[item.id];
        // the group of these objects has no inner group
        svg = svg.replace(new RegExp(`\\s*<g [^>]*id="${item.id}"[^>]*>[\\s\\S]*?</g>`), '');
    });
    svg = svg.replace(/\s*<text [^>]*id="svg_courbes_(du|au)"[^>]*>[^<]*<\/text>/g, '');
    svg = svg.replace(/(<text [^>]*id="svg_courbes_note"[^>]*>)[^<]*(<\/text>)/,
        '$1Période : calendrier du graphique (horloge). Tags des courbes : éditeur, panneau Sites, menu du site, Tags des courbes.$2');
    view.svgcontent = svg;
}

const CONFIGURATION_VIEW = 'v_site_configuration';
const CONFIGURATION_IFRAME = 'OXC_site_configuration';

const ALARMS_VIEW = 'v_site_alarmes';
const ALARMS_IFRAME = 'OXC_site_alarmes';

/**
 * page Configuration: its title and a frame (iframe object of FUXA) showing configuration.html of the site
 * (all the properties of the site, choice of the tags of the curves)
 */
function configurationView(name, model) {
    return frameView({ id: CONFIGURATION_VIEW, name: 'Configuration', title: `CONFIGURATION - ${name}`, frameId: CONFIGURATION_IFRAME,
        objectName: 'configuration_site', file: 'configuration.html', prefix: 'cfg' }, model);
}

/** page Alarmes: its title and a frame showing alarmes.html of the site (active alarms, history, thresholds) */
function alarmsView(name, model) {
    return frameView({ id: ALARMS_VIEW, name: 'Alarmes', title: `ALARMES - ${name}`, frameId: ALARMS_IFRAME,
        objectName: 'alarmes_site', file: 'alarmes.html', prefix: 'alm' }, model);
}

function alarmsMenuItem() {
    return menuItem('n_alarmes', 'Alarmes', ALARMS_VIEW, 'notifications');
}

/**
 * the sites made before the page Alarmes get it: the page and its menu entry (instead of the alarm page of FUXA)
 * @returns { view, layout } to save, or null if the site has the page
 */
function addAlarmsPage(project, name) {
    const views = (project.hmi && project.hmi.views) || [];
    if (!views.length || views.some(v => v.id === ALARMS_VIEW)) {
        return null;
    }
    const model = views.find(v => v.id === 'v_site_courbes') || views[0];
    const layout = JSON.parse(JSON.stringify(project.hmi.layout || {}));
    layout.navigation = layout.navigation || {};
    const items = (layout.navigation.items || []).filter(item => item.view !== '[alarms]');
    items.push(alarmsMenuItem());
    layout.navigation.items = items;
    return { view: alarmsView(name, model), layout };
}

/** page with a title and a frame (iframe object of FUXA) showing a file of the folder of the site */
function frameView(page, model) {
    const width = (model.profile && model.profile.width) || 1280;
    const height = (model.profile && model.profile.height) || 720;
    const frame = { x: 20, y: 80, width: width - 40, height: height - 100 };
    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg" xmlns:html="http://www.w3.org/1999/xhtml">
 <g>
  <title>Layer 1</title>
  <text id="svg_${page.prefix}_title" x="40" y="55" font-family="Arial" font-size="32" font-weight="bold" fill="#0D47A1">${escapeXml(page.title)}</text>
  <g id="${page.frameId}" type="svg-ext-own_ctrl-iframe" data-name="${page.objectName}" style="pointer-events:none" fill="#FFFFFF" stroke="#000000" stroke-width="1" font-size="14" font-family="sans-serif" text-anchor="right" xml:space="preserve">
   <rect id="svg_${page.prefix}_frame" x="${frame.x}" y="${frame.y}" width="${frame.width}" height="${frame.height}" stroke-width="0"/>
   <foreignObject id="H-${page.frameId}_d" x="${frame.x}" y="${frame.y}" width="${frame.width}" height="${frame.height}">
    <div xmlns="http://www.w3.org/1999/xhtml" id="D-${page.frameId}_d" style="width:100%;height:100%;"></div>
   </foreignObject>
  </g>
 </g>
</svg>`;
    return {
        id: page.id,
        name: page.name,
        type: model.type || 'svg',
        profile: JSON.parse(JSON.stringify(model.profile || {})),
        items: {
            [page.frameId]: {
                id: page.frameId,
                type: 'svg-ext-own_ctrl-iframe',
                name: page.objectName,
                // relative to the base of the pages of the site (/site/<name>/): still valid after a renaming
                property: { address: `fichiers/${page.file}` },
                label: 'HtmlIframe',
                hide: false,
                lock: false
            }
        },
        variables: {},
        svgcontent: svg
    };
}

/**
 * the page Configuration of the first sites only had a title and a text: it gets the frame with configuration.html
 * (only when the page was not changed by the user: no object in the page)
 * @returns the new page, or null if nothing to change
 */
function upgradeConfigurationView(view, name) {
    if (!view || view.id !== CONFIGURATION_VIEW || Object.keys(view.items || {}).length || !(view.svgcontent || '').includes('svg_cfg_info')) {
        return null;
    }
    const upgraded = configurationView(name, view);
    upgraded.name = view.name;
    upgraded.type = view.type;
    return upgraded;
}

function menuItem(id, text, view, icon) {
    return { id, text, link: '', view, icon, image: '', permission: null, permissionRoles: null };
}

function rank(order, id) {
    const index = order.indexOf(id);
    return index < 0 ? order.length : index;
}

function escapeXml(text) {
    return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&apos;' }[c]));
}

module.exports = {
    create: create,
    upgradeConfigurationView: upgradeConfigurationView,
    addAlarmsPage: addAlarmsPage,
    ALARMS_VIEW: ALARMS_VIEW
};
