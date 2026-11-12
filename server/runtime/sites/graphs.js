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
 * Without the file (first sites): one graph per tag of the chart of the page Courbes,
 * or one XY graph if the old type of chart (courbes-mode.json) was XY.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const FILE = 'courbes-graphes.json';
const OLD_MODE_FILE = 'courbes-mode.json';
const MAX_GRAPHS = 30;
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
 * graphs of the site
 * @param tags all the tags of the site [{ id, name }]
 * @param lines lines of the chart of the page Courbes (tags chosen in the editor) [{ id, label, color }]
 */
function get(settings, tags, lines) {
    const known = new Set(tags.map(t => t.id));
    const saved = readJson(path.join(dir(settings), FILE));
    let graphs;
    if (saved && Array.isArray(saved.graphs)) {
        graphs = saved.graphs.map((g, i) => clean(g, i, known, false)).filter(g => g);
    } else {
        graphs = defaults(settings, lines, known);
    }
    // a tag added to the chart in the editor (Tags des courbes) and in no graph gets its own graph
    const used = new Set();
    graphs.forEach(g => { g.series.forEach(s => used.add(s.tag)); });
    lines.filter(line => known.has(line.id) && !used.has(line.id)).forEach(line => {
        used.add(line.id);
        graphs.push(clean({ title: line.label || line.name, series: [{ tag: line.id, label: line.label, color: line.color }] }, graphs.length, known, false));
    });
    return graphs;
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

/** save the graphs (checked: an unknown tag is an error) */
function set(settings, graphs, tags) {
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
    fs.mkdirSync(dir(settings), { recursive: true });
    fs.writeFileSync(path.join(dir(settings), FILE), JSON.stringify({ graphs: result }, null, 2));
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
    usedTags: usedTags,
    COLORS: COLORS
};
