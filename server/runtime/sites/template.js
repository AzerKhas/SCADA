/**
 * custom-SCADA: first project of a new site, made from the template "Site pilote"
 * with the 4 base pages: Accueil, Courbes, Configuration, Historiques
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
    // order of the pages in the editor: Accueil, Courbes, Configuration, Historiques
    const order = ['v_site_accueil', 'v_site_courbes', 'v_site_configuration', 'v_site_historique'];
    views.sort((a, b) => rank(order, a.id) - rank(order, b.id));

    const navigation = project.hmi.layout.navigation;
    const alarms = navigation.items.filter(item => item.view === '[alarms]');
    navigation.items = [
        menuItem('n_accueil', 'Accueil', 'v_site_accueil', 'home'),
        menuItem('n_courbes', 'Courbes', 'v_site_courbes', 'show_chart'),
        menuItem('n_configuration', 'Configuration', 'v_site_configuration', 'settings'),
        menuItem('n_historique', 'Historiques', 'v_site_historique', 'history'),
        ...alarms
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

/**
 * page Configuration: its title and a frame (iframe object of FUXA) showing configuration.html of the site
 * (all the properties of the site, choice of the tags of the curves)
 */
function configurationView(name, model) {
    const width = (model.profile && model.profile.width) || 1280;
    const height = (model.profile && model.profile.height) || 720;
    const frame = { x: 20, y: 80, width: width - 40, height: height - 100 };
    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg" xmlns:html="http://www.w3.org/1999/xhtml">
 <g>
  <title>Layer 1</title>
  <text id="svg_cfg_title" x="40" y="55" font-family="Arial" font-size="32" font-weight="bold" fill="#0D47A1">CONFIGURATION - ${escapeXml(name)}</text>
  <g id="${CONFIGURATION_IFRAME}" type="svg-ext-own_ctrl-iframe" data-name="configuration_site" style="pointer-events:none" fill="#FFFFFF" stroke="#000000" stroke-width="1" font-size="14" font-family="sans-serif" text-anchor="right" xml:space="preserve">
   <rect id="svg_cfg_frame" x="${frame.x}" y="${frame.y}" width="${frame.width}" height="${frame.height}" stroke-width="0"/>
   <foreignObject id="H-${CONFIGURATION_IFRAME}_d" x="${frame.x}" y="${frame.y}" width="${frame.width}" height="${frame.height}">
    <div xmlns="http://www.w3.org/1999/xhtml" id="D-${CONFIGURATION_IFRAME}_d" style="width:100%;height:100%;"></div>
   </foreignObject>
  </g>
 </g>
</svg>`;
    return {
        id: CONFIGURATION_VIEW,
        name: 'Configuration',
        type: model.type || 'svg',
        profile: JSON.parse(JSON.stringify(model.profile || {})),
        items: {
            [CONFIGURATION_IFRAME]: {
                id: CONFIGURATION_IFRAME,
                type: 'svg-ext-own_ctrl-iframe',
                name: 'configuration_site',
                // relative to the base of the pages of the site (/site/<name>/): still valid after a renaming
                property: { address: 'fichiers/configuration.html' },
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
    upgradeConfigurationView: upgradeConfigurationView
};
