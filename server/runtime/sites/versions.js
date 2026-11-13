/**
 * custom-SCADA: versions of a site (runs in the FUXA instance of the site)
 *
 * After each writing of the HTML files (after each save of the editor, files.js), a version of the site is kept in
 * _versions/: the project (pages, connections, tags, alarms...), the configurations (_appdata/courbes-graphes.json,
 * history-db.json without the password) and the HTML files of the site, compressed (gzip).
 * - a version identical to the previous one is not kept (same project and configurations)
 * - the automatic versions made within 5 minutes are grouped (the last one is replaced), so a session of work
 *   gives a few versions; the manual versions (with a comment) are always kept
 * - 200 versions at most (the oldest automatic versions are removed first)
 * The changes between two versions are given by category (pages, menu, connections, tags, alarms, scripts, graphs...),
 * with a line by line comparison of the HTML files; a version can be restored (the current state is kept before).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const DIR = '_versions';
const INDEX = 'index.json';
const GROUP_TIME = 5 * 60 * 1000;
const MAX_VERSIONS = 200;
const CONFIG_FILES = ['courbes-graphes.json', 'history-db.json'];
const TYPES = { auto: 'automatique', manual: 'manuelle', before: 'avant restauration', restored: 'restauration' };

var siteDir;
var logger;
var runtime;
/** label of the next automatic version (after a restoration) */
var nextLabel = null;

function init(_runtime, settings, _logger) {
    runtime = _runtime;
    logger = _logger;
    siteDir = path.dirname(settings.workDir);
}

const dir = () => path.join(siteDir, DIR);

function readIndex() {
    try {
        return JSON.parse(fs.readFileSync(path.join(dir(), INDEX), 'utf8')).versions || [];
    } catch (err) {
        return [];
    }
}

function writeIndex(list) {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(path.join(dir(), INDEX), JSON.stringify({ versions: list }, null, 1));
}

function readVersion(id) {
    if (!/^v\d{8}_\d{6}_\d{3}$/.test(id || '')) {
        return null;
    }
    try {
        return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir(), `${id}.json.gz`))).toString('utf8'));
    } catch (err) {
        return null;
    }
}

/** configurations of the site (the password of the database is never kept) */
function readConfig() {
    const config = {};
    CONFIG_FILES.forEach(name => {
        try {
            const value = JSON.parse(fs.readFileSync(path.join(siteDir, '_appdata', name), 'utf8'));
            if (value && value.password !== undefined) {
                value.password = value.password ? '********' : '';
            }
            config[name] = value;
        } catch (err) {
            // no file: default configuration
        }
    });
    return config;
}

function hashOf(project, config) {
    return crypto.createHash('sha1').update(JSON.stringify({ project, config })).digest('hex');
}

function newId(time) {
    const d = new Date(time);
    const p = (n, l = 2) => String(n).padStart(l, '0');
    return `v${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${p(d.getMilliseconds(), 3)}`;
}

/** state of the site now: project, configurations, HTML files */
async function currentState(files) {
    const project = await runtime.project.getProject(null, -1);
    const state = { project: JSON.parse(JSON.stringify(project)), config: readConfig(), files: files || {} };
    if (!files) {
        // HTML files of the folder (list of pages.json)
        try {
            const manifest = JSON.parse(fs.readFileSync(path.join(siteDir, 'pages.json'), 'utf8'));
            (manifest.files || []).filter(f => /\.html$/.test(f.file)).forEach(f => {
                state.files[f.file] = fs.readFileSync(path.join(siteDir, f.file), 'utf8');
            });
        } catch (err) {
            // no files yet
        }
    }
    return state;
}

/**
 * keep a version of the site
 * @param options { type: 'auto' | 'manual' | 'before' | 'restored', comment, files: { name: html } (written files) }
 * @returns the version (index entry), or null if nothing changed (automatic version)
 */
async function snapshot(options) {
    options = options || {};
    let type = options.type || 'auto';
    let comment = options.comment || '';
    if (type === 'auto' && nextLabel) {
        type = 'restored';
        comment = nextLabel;
        nextLabel = null;
    }
    const state = await currentState(options.files);
    const hash = hashOf(state.project, state.config);
    let list = readIndex();
    const last = list[list.length - 1];
    if (type === 'auto' && last && last.hash === hash) {
        return null;
    }
    const time = Date.now();
    // automatic versions within 5 minutes: the last automatic version is replaced
    if (type === 'auto' && last && last.type === 'auto' && time - last.time < GROUP_TIME && list.length > 1) {
        removeFile(last.id);
        list.pop();
        const before = list[list.length - 1];
        if (before && before.hash === hash) {
            // back to the previous version: nothing to keep
            writeIndex(list);
            return null;
        }
    }
    const base = list.length ? readVersion(list[list.length - 1].id) : null;
    const id = newId(time);
    const data = zlib.gzipSync(Buffer.from(JSON.stringify(Object.assign({ id, time, type, comment }, state))));
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(path.join(dir(), `${id}.json.gz`), data);
    const entry = {
        id, time, type, comment, hash, size: data.length,
        pages: ((state.project.hmi && state.project.hmi.views) || []).length,
        summary: base ? summarize(compare(base, state)) : 'première version'
    };
    list.push(entry);
    // limit: the oldest automatic versions first
    while (list.length > MAX_VERSIONS) {
        const index = list.findIndex(v => v.type === 'auto');
        const removed = list.splice(index >= 0 ? index : 0, 1)[0];
        removeFile(removed.id);
    }
    writeIndex(list);
    return entry;
}

function removeFile(id) {
    try {
        fs.unlinkSync(path.join(dir(), `${id}.json.gz`));
    } catch (err) {
        // already removed
    }
}

function list() {
    return readIndex().slice().reverse().map(v => Object.assign({}, v, { typeText: TYPES[v.type] || v.type }));
}

/** version, or the current state ('current') */
async function get(id) {
    if (id === 'current') {
        return Object.assign({ id: 'current', time: Date.now(), type: 'current', comment: 'état actuel' }, await currentState());
    }
    return readVersion(id);
}

/**
 * restore a version: the current state is kept as a version, then the project and the configurations of the version
 * are written (the HTML files are written again by files.js after the save of the project)
 */
async function restore(id) {
    const version = readVersion(id);
    if (!version) {
        return null;
    }
    await snapshot({ type: 'before', comment: `Avant la restauration de la version du ${dateText(version.time)}` });
    CONFIG_FILES.forEach(name => {
        const file = path.join(siteDir, '_appdata', name);
        const value = version.config && version.config[name];
        if (!value) {
            return;
        }
        // the password is not in the versions: the current password is kept
        if (value.password !== undefined) {
            try {
                value.password = JSON.parse(fs.readFileSync(file, 'utf8')).password || '';
            } catch (err) {
                value.password = '';
            }
        }
        fs.writeFileSync(file, JSON.stringify(value, null, 2));
    });
    nextLabel = `Restauration de la version du ${dateText(version.time)}`;
    await runtime.project.setProject(version.project);
    await runtime.restart(true);
    logger.info(`site versions: version ${id} restored`);
    return version;
}

function dateText(time) {
    return new Date(time).toLocaleString('fr-FR');
}

// ---------------------------------------------------------------- comparison

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** keys of the first level that are different */
function changedKeys(a, b, skip) {
    const keys = new Set(Object.keys(a || {}).concat(Object.keys(b || {})));
    return Array.from(keys).filter(k => !(skip || []).includes(k) && !same((a || {})[k], (b || {})[k]));
}

/** objects of 2 lists (or maps) compared by key: added, removed, changed */
function compareItems(category, before, after, key, name, details) {
    const toMap = list => {
        const map = {};
        (Array.isArray(list) ? list : Object.values(list || {})).forEach(item => { if (item) { map[key(item)] = item; } });
        return map;
    };
    const a = toMap(before), b = toMap(after);
    const result = [];
    Object.keys(b).forEach(k => {
        if (!a[k]) {
            result.push({ category, action: 'ajouté', name: name(b[k]) });
        } else if (!same(a[k], b[k])) {
            result.push({ category, action: 'modifié', name: name(b[k]), details: details ? details(a[k], b[k]) : changedKeys(a[k], b[k]).join(', ') });
        }
    });
    Object.keys(a).forEach(k => {
        if (!b[k]) {
            result.push({ category, action: 'supprimé', name: name(a[k]) });
        }
    });
    return result;
}

/** changes from the version a to the version b */
function compare(a, b) {
    const pa = (a && a.project) || {}, pb = (b && b.project) || {};
    const ha = pa.hmi || {}, hb = pb.hmi || {};
    const changes = [];
    changes.push(...compareItems('Pages', ha.views, hb.views, v => v.id, v => v.name, (x, y) => {
        const d = [];
        if (x.name !== y.name) { d.push(`nom : ${x.name} → ${y.name}`); }
        if (!same(x.svgcontent, y.svgcontent)) { d.push('dessin modifié'); }
        const ix = x.items || {}, iy = y.items || {};
        const added = Object.keys(iy).filter(k => !ix[k]).length, removed = Object.keys(ix).filter(k => !iy[k]).length;
        const changed = Object.keys(iy).filter(k => ix[k] && !same(ix[k], iy[k])).length;
        if (added) { d.push(`${added} objet(s) ajouté(s)`); }
        if (removed) { d.push(`${removed} objet(s) supprimé(s)`); }
        if (changed) { d.push(`${changed} objet(s) modifié(s)`); }
        if (!same(x.profile, y.profile)) { d.push('taille ou fond modifié'); }
        const other = changedKeys(x, y, ['name', 'svgcontent', 'items', 'profile']);
        if (other.length) { d.push(other.join(', ')); }
        return d.join(', ');
    }));
    const menu = l => ((l && l.navigation && l.navigation.items) || []).map(i => i.text || i.view || i.link);
    if (!same(menu(ha.layout), menu(hb.layout))) {
        changes.push({ category: 'Menu', action: 'modifié', name: 'menu du site', details: `${menu(ha.layout).join(', ')} → ${menu(hb.layout).join(', ')}` });
    }
    if ((ha.layout && ha.layout.start) !== (hb.layout && hb.layout.start)) {
        changes.push({ category: 'Menu', action: 'modifié', name: 'page de démarrage' });
    }
    const other = changedKeys(ha.layout, hb.layout, ['navigation', 'start']);
    if (other.length) {
        changes.push({ category: 'Menu', action: 'modifié', name: 'mise en page', details: other.join(', ') });
    }
    changes.push(...compareItems('Connexions', pa.devices, pb.devices, d => d.id, d => d.name, (x, y) => changedKeys(x, y, ['tags']).join(', ')));
    const tags = p => {
        const list = [];
        Object.values(p.devices || {}).forEach(d => Object.values(d.tags || {}).forEach(t => list.push(Object.assign({ deviceName: d.name }, t))));
        return list;
    };
    changes.push(...compareItems('Tags', tags(pa), tags(pb), t => t.id, t => `${t.name} (${t.deviceName})`, (x, y) => changedKeys(x, y, ['value', 'timestamp']).join(', ')));
    changes.push(...compareItems('Alarmes', pa.alarms, pb.alarms, x => x.name, x => x.name));
    changes.push(...compareItems('Scripts', pa.scripts, pb.scripts, x => x.id || x.name, x => x.name));
    changes.push(...compareItems('Graphiques FUXA', pa.charts, pb.charts, x => x.id, x => x.name));
    changes.push(...compareItems('Notifications', pa.notifications, pb.notifications, x => x.id, x => x.name));
    changes.push(...compareItems('Textes', pa.texts, pb.texts, x => x.id || x.name, x => x.name));
    const ca = (a && a.config) || {}, cb = (b && b.config) || {};
    // graphs of the page Courbes: several configurations (sets), or one list (first version of the file)
    const store = c => c['courbes-graphes.json'] || {};
    const sets = c => (Array.isArray(store(c).sets) ? store(c).sets : []).map(s => ({ id: s.id, name: s.name }));
    const graphs = c => {
        const value = store(c);
        if (!Array.isArray(value.sets)) {
            return value.graphs || [];
        }
        const result = [];
        value.sets.forEach(s => (s.graphs || []).forEach(g => result.push(Object.assign({}, g, { id: `${s.id}/${g.id}`, title: `${s.name} : ${g.title}` }))));
        return result;
    };
    changes.push(...compareItems('Configurations de courbes', sets(ca), sets(cb), s => s.id, s => s.name, (x, y) => `nom : ${x.name} → ${y.name}`));
    if (store(ca).active && store(cb).active && store(ca).active !== store(cb).active) {
        changes.push({ category: 'Configurations de courbes', action: 'modifié', name: 'configuration par défaut' });
    }
    changes.push(...compareItems('Graphiques de la page Courbes', graphs(ca), graphs(cb), g => g.id, g => g.title));
    if (!same(ca['history-db.json'], cb['history-db.json'])) {
        changes.push({ category: 'Source de l\'historique', action: 'modifié', name: 'base de données', details: changedKeys(ca['history-db.json'], cb['history-db.json']).join(', ') });
    }
    const known = ['devices', 'hmi', 'alarms', 'scripts', 'charts', 'notifications', 'texts', 'version', 'server'];
    const rest = changedKeys(pa, pb, known);
    if (rest.length) {
        changes.push({ category: 'Autres', action: 'modifié', name: rest.join(', ') });
    }
    return changes;
}

/** "2 pages modifiées, 1 tag ajouté" */
function summarize(changes) {
    if (!changes.length) {
        return 'aucune modification';
    }
    const counts = {};
    changes.forEach(c => {
        const key = `${c.category}|${c.action}`;
        counts[key] = (counts[key] || 0) + 1;
    });
    return Object.keys(counts).map(k => {
        const [category, action] = k.split('|');
        return `${category} : ${counts[k]} ${action}${counts[k] > 1 ? 's' : ''}`;
    }).join(' ; ');
}

/**
 * line by line comparison of 2 texts: [{ type: ' ' | '+' | '-', line, a, b }] (a, b: line numbers),
 * the unchanged lines far from a change are grouped ({ type: '…', count })
 */
function diffLines(textA, textB, context) {
    context = context === undefined ? 3 : context;
    const a = String(textA || '').split(/\r?\n/), b = String(textB || '').split(/\r?\n/);
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) { start++; }
    let endA = a.length - 1, endB = b.length - 1;
    while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
    const midA = a.slice(start, endA + 1), midB = b.slice(start, endB + 1);
    let ops = [];
    if (midA.length * midB.length <= 4000000) {
        // longest common subsequence of the changed part
        const n = midA.length, m = midB.length;
        const table = new Uint32Array((n + 1) * (m + 1));
        for (let i = n - 1; i >= 0; i--) {
            for (let j = m - 1; j >= 0; j--) {
                table[i * (m + 1) + j] = midA[i] === midB[j] ? table[(i + 1) * (m + 1) + j + 1] + 1
                    : Math.max(table[(i + 1) * (m + 1) + j], table[i * (m + 1) + j + 1]);
            }
        }
        let i = 0, j = 0;
        while (i < n || j < m) {
            if (i < n && j < m && midA[i] === midB[j]) { ops.push([' ', midA[i]]); i++; j++; }
            else if (j < m && (i >= n || table[i * (m + 1) + j + 1] >= table[(i + 1) * (m + 1) + j])) { ops.push(['+', midB[j]]); j++; }
            else { ops.push(['-', midA[i]]); i++; }
        }
    } else {
        // too long: removed block then added block
        ops = midA.map(l => ['-', l]).concat(midB.map(l => ['+', l]));
    }
    const all = a.slice(0, start).map(l => [' ', l]).concat(ops, a.slice(endA + 1).map(l => [' ', l]));
    const result = [];
    let la = 0, lb = 0;
    const lines = all.map(([type, line]) => {
        if (type !== '+') { la++; }
        if (type !== '-') { lb++; }
        return { type, line: line.length > 2000 ? line.slice(0, 2000) + ' …' : line, a: type === '+' ? null : la, b: type === '-' ? null : lb };
    });
    const near = new Uint8Array(lines.length);
    lines.forEach((l, k) => {
        if (l.type !== ' ') {
            for (let x = Math.max(0, k - context); x <= Math.min(lines.length - 1, k + context); x++) { near[x] = 1; }
        }
    });
    let hidden = 0;
    lines.forEach((l, k) => {
        if (near[k]) {
            if (hidden) { result.push({ type: '…', count: hidden }); hidden = 0; }
            result.push(l);
        } else {
            hidden++;
        }
    });
    if (hidden) { result.push({ type: '…', count: hidden }); }
    return result;
}

module.exports = {
    init,
    snapshot,
    list,
    get,
    restore,
    compare,
    summarize,
    diffLines,
    TYPES
};
