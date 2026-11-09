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

/** page Configuration (its content is made in a next step) */
function configurationView(name, model) {
    const width = (model.profile && model.profile.width) || 1280;
    const height = (model.profile && model.profile.height) || 720;
    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg" xmlns:html="http://www.w3.org/1999/xhtml">
 <g>
  <title>Layer 1</title>
  <text id="svg_cfg_title" x="40" y="60" font-family="Arial" font-size="32" font-weight="bold" fill="#0D47A1">CONFIGURATION - ${escapeXml(name)}</text>
  <text id="svg_cfg_info" x="40" y="110" font-family="Arial" font-size="18" fill="#333333">Tags à exploiter et paramètres du site.</text>
 </g>
</svg>`;
    return {
        id: 'v_site_configuration',
        name: 'Configuration',
        type: model.type || 'svg',
        profile: JSON.parse(JSON.stringify(model.profile || {})),
        items: {},
        variables: {},
        svgcontent: svg
    };
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
    create: create
};
