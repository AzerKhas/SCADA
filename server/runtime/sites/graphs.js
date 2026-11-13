/**
 * custom-SCADA: graphs of the page Courbes of a site (courbes.html), kept in _appdata/courbes-graphes.json
 *
 * Each graph has its own tags, mode and options:
 * {
 *   id, title,
 *   mode: 'temps' (tags in function of the time) | 'xy' (tags Y in function of the tag X),
 *   xTag: id of the tag X (mode xy), xUnit, xMin, xMax (limits of the axis X, null: automatic),
 *   period: { type: 'relative', hours } | { type: 'fixed', from, to } (mode temps, dates ISO),
 *   interval: sampling in seconds (0: all the values),
 *   legend, grid, tooltip: true / false,
 *   series: [{ tag: id, label, color, unit, min, max, decimals }]  (min / max / decimals null: automatic)
 * }
 * Several configurations of graphs can be kept (sets), one of them is active (shown by default):
 * { active: id, sets: [{ id, name, graphs: [...] }] }
 * Without the file (first sites): one graph per tag of the chart of the page Courbes,
 * or one XY graph if the old type of chart (courbes-mode.json) was XY.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const FILE = 'courbes-graphes.json';
const OLD_MODE_FILE = 'courbes-mode.json';
const MAX_GRAPHS = 30;
const MAX_SETS = 20;
const SET_ID = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_SERIES = 12;
const MAX_HOURS = 366 * 24;
const COLORS = ['#1565C0', '#E65100', '#2E7D32', '#C62828', '#6A1B9A', '#00838F', '#F9A825', '#4E342E', '#AD1457', '#37474F'];

function dir(settings) {
    return path.join(path.dirname(settings.workDir), '_appdata');
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        return null;
    }
}

/**
 * configurations of graphs of the site: { active: id, sets: [{ id, name, graphs }] }
 * (file of the first version { graphs }: one configuration « Configuration principale »)
 * @param tags all the tags of the site [{ id, name }]
 * @param lines lines of the chart of the page Courbes (tags chosen in the editor) [{ id, label, color }]
 */
function readStore(settings, tags, lines) {
    const known = new Set(tags.map(t => t.id));
    const saved = readJson(path.join(dir(settings), FILE));
    let store;
    if (saved && Array.isArray(saved.sets) && saved.sets.length) {
        store = {
            active: saved.active,
            sets: saved.sets.map((s, i) => ({
                id: SET_ID.test(s.id || '') ? s.id : `s${i + 1}`,
                name: text(s.name, 60) || `Configuration ${i + 1}`,
                graphs: (Array.isArray(s.graphs) ? s.graphs : []).map((g, k) => clean(g, k, known, false)).filter(g => g)
            }))
        };
    } else {
        const graphs = saved && Array.isArray(saved.graphs) ? saved.graphs.map((g, i) => clean(g, i, known, false)).filter(g => g) : defaults(settings, lines, known);
        store = { active: 's1', sets: [{ id: 's1', name: 'Configuration principale', graphs }] };
    }
    if (!store.sets.some(s => s.id === store.active)) {
        store.active = store.sets[0].id;
    }
    // a tag added to the chart in the editor (Tags des courbes) and in no graph gets its own graph (active configuration)
    const used = new Set();
    store.sets.forEach(s => s.graphs.forEach(g => { g.series.forEach(x => used.add(x.tag)); if (g.xTag) { used.add(g.xTag); } }));
    const active = store.sets.find(s => s.id === store.active);
    lines.filter(line => known.has(line.id) && !used.has(line.id)).forEach(line => {
        used.add(line.id);
        active.graphs.push(clean({ title: line.label || line.name, series: [{ tag: line.id, label: line.label, color: line.color }] }, active.graphs.length, known, false));
    });
    return store;
}

function writeStore(settings, store) {
    fs.mkdirSync(dir(settings), { recursive: true });
    fs.writeFileSync(path.join(dir(settings), FILE), JSON.stringify({ active: store.active, sets: store.sets }, null, 2));
}

function findSet(store, setId) {
    const found = store.sets.find(s => s.id === (setId || store.active));
    if (!found) {
        const err = new Error(`Configuration de courbes inconnue : ${setId}`);
        err.status = 404;
        err.code = 'graph_set_not_found';
        throw err;
    }
    return found;
}

/** graphs of a configuration (the active configuration if no setId) */
function get(settings, tags, lines, setId) {
    return findSet(readStore(settings, tags, lines), setId).graphs;
}

/** all the graphs of all the configurations (tags to record) */
function all(settings, tags, lines) {
    const result = [];
    readStore(settings, tags, lines).sets.forEach(s => result.push(...s.graphs));
    return result;
}

/** configurations: [{ id, name, graphs: count, active }] */
function listSets(settings, tags, lines) {
    const store = readStore(settings, tags, lines);
    return store.sets.map(s => ({ id: s.id, name: s.name, graphs: s.graphs.length, active: s.id === store.active }));
}

/** new configuration, empty or copy of another one */
function createSet(settings, tags, lines, name, copyFrom) {
    const store = readStore(settings, tags, lines);
    if (store.sets.length >= MAX_SETS) {
        throw httpError(`${MAX_SETS} configurations au plus.`);
    }
    name = checkName(store, name);
    const source = copyFrom ? findSet(store, copyFrom) : null;
    const set = { id: `s${Date.now().toString(36)}`, name, graphs: source ? JSON.parse(JSON.stringify(source.graphs)) : [] };
    store.sets.push(set);
    writeStore(settings, store);
    return set;
}

function renameSet(settings, tags, lines, setId, name) {
    const store = readStore(settings, tags, lines);
    const set = findSet(store, setId);
    set.name = checkName(store, name, set.id);
    writeStore(settings, store);
    return set;
}

/** the last configuration can not be deleted; the active one: the first other one becomes active */
function deleteSet(settings, tags, lines, setId) {
    const store = readStore(settings, tags, lines);
    const set = findSet(store, setId);
    if (store.sets.length === 1) {
        throw httpError('La dernière configuration ne peut pas être supprimée.');
    }
    store.sets = store.sets.filter(s => s !== set);
    if (store.active === set.id) {
        store.active = store.sets[0].id;
    }
    writeStore(settings, store);
}

/** configuration shown by default in the page Courbes */
function activateSet(settings, tags, lines, setId) {
    const store = readStore(settings, tags, lines);
    store.active = findSet(store, setId).id;
    writeStore(settings, store);
}

function checkName(store, name, currentId) {
    name = text(name, 60);
    if (!name) {
        throw httpError('Nom de la configuration manquant.');
    }
    if (store.sets.some(s => s.id !== currentId && s.name.toLowerCase() === name.toLowerCase())) {
        const err = httpError(`La configuration « ${name} » existe déjà.`);
        err.status = 409;
        err.code = 'graph_set_exists';
        throw err;
    }
    return name;
}

/** first graphs: from the chart of the page Courbes and the old type of chart */
function defaults(settings, lines, known) {
    const old = readJson(path.join(dir(settings), OLD_MODE_FILE));
    const series = lines.filter(line => known.has(line.id)).map(line => ({ tag: line.id, label: line.label, color: line.color }));
    if (old && old.mode === 'xy' && known.has(old.xTag) && series.length) {
        return [clean({ title: 'Graphique XY', mode: 'xy', xTag: old.xTag, series: series.filter(s => s.tag !== old.xTag) }, 0, known, false)];
    }
    return series.map((s, i) => clean({ title: s.label, series: [s] }, i, known, false));
}

/** save the graphs of a configuration (the active one if no setId; checked: an unknown tag is an error) */
function set(settings, graphs, tags, lines, setId) {
    if (!Array.isArray(graphs) || graphs.length > MAX_GRAPHS) {
        throw httpError(`Liste des graphiques invalide (${MAX_GRAPHS} graphiques au plus).`);
    }
    const known = new Set(tags.map(t => t.id));
    const result = graphs.map((g, i) => clean(g, i, known, true));
    const ids = new Set();
    result.forEach((g, i) => {
        if (ids.has(g.id)) {
            g.id = `g${Date.now().toString(36)}${i}`;
        }
        ids.add(g.id);
    });
    const store = readStore(settings, tags, lines || []);
    findSet(store, setId).graphs = result;
    writeStore(settings, store);
    return result;
}

/**
 * graph with valid values; strict: error for a wrong tag (save), else the wrong tags are removed (read)
 * @returns the graph, or null (read: no tag left)
 */
function clean(g, index, known, strict) {
    g = g || {};
    const checkTag = (id, what) => {
        if (id && known.has(String(id))) {
            return String(id);
        }
        if (strict) {
            throw httpError(`${what} : tag inconnu dans ce site (${id || 'aucun'}).`);
        }
        return null;
    };
    const mode = g.mode === 'xy' ? 'xy' : 'temps';
    const title = text(g.title, 100) || `Graphique ${index + 1}`;
    const xTag = mode === 'xy' ? checkTag(g.xTag, `${title}, axe X`) : null;
    const list = Array.isArray(g.series) ? g.series.slice(0, MAX_SERIES) : [];
    const series = [];
    list.forEach((s, i) => {
        const tag = checkTag(s && s.tag, title);
        if (tag && !series.some(x => x.tag === tag)) {
            series.push({
                tag: tag,
                label: text(s.label, 100),
                color: /^#[0-9a-fA-F]{6}$/.test(s.color || '') ? s.color : COLORS[(index + i) % COLORS.length],
                unit: text(s.unit, 20),
                min: number(s.min),
                max: number(s.max),
                decimals: decimals(s.decimals)
            });
        }
    });
    if (strict && !series.length) {
        throw httpError(`${title} : choisir au moins un tag.`);
    }
    if (!series.length || (mode === 'xy' && !xTag)) {
        return null;
    }
    return {
        id: /^[A-Za-z0-9_-]{1,40}$/.test(g.id || '') ? g.id : `g${index + 1}`,
        title: title,
        mode: mode,
        xTag: xTag,
        xUnit: mode === 'xy' ? text(g.xUnit, 20) : '',
        xMin: mode === 'xy' ? number(g.xMin) : null,
        xMax: mode === 'xy' ? number(g.xMax) : null,
        period: period(g.period),
        interval: Math.min(Math.max(Math.round(Number(g.interval) || 0), 0), 7 * 24 * 3600),
        legend: g.legend !== false,
        grid: g.grid !== false,
        tooltip: g.tooltip !== false,
        series: series
    };
}

function period(p) {
    if (p && p.type === 'fixed') {
        const from = Date.parse(p.from), to = Date.parse(p.to);
        if (Number.isFinite(from) && Number.isFinite(to) && from < to) {
            return { type: 'fixed', from: new Date(from).toISOString(), to: new Date(to).toISOString() };
        }
    }
    const hours = Number(p && p.hours);
    return { type: 'relative', hours: hours > 0 ? Math.min(hours, MAX_HOURS) : 8 };
}

function text(value, max) {
    return value === undefined || value === null ? '' : String(value).trim().slice(0, max);
}

function number(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function decimals(value) {
    const num = number(value);
    return num === null ? null : Math.min(Math.max(Math.round(num), 0), 6);
}

function httpError(message) {
    const err = new Error(message);
    err.status = 400;
    return err;
}

/** tags used by the graphs (to record them, and for the chart of the page Courbes) */
function usedTags(graphs) {
    const ids = [];
    graphs.forEach(g => {
        g.series.forEach(s => { if (!ids.includes(s.tag)) { ids.push(s.tag); } });
        if (g.xTag && !ids.includes(g.xTag)) {
            ids.push(g.xTag);
        }
    });
    return ids;
}

module.exports = {
    get: get,
    set: set,
    all: all,
    listSets: listSets,
    createSet: createSet,
    renameSet: renameSet,
    deleteSet: deleteSet,
    activateSet: activateSet,
    usedTags: usedTags,
    COLORS: COLORS
};
