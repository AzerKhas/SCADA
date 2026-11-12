/**
 * custom-SCADA: API of a site (runs in the FUXA instance of the site, under /site/<name>/api/site)
 * Each site has its own instance, so the API gives only the tags and the data of its site.
 *
 * GET  /api/site                      list of the services
 * GET  /api/site/info                 site, tags, curves (tags of the page Courbes), graphs, history source
 * GET  /api/site/values?tags=a,b      current values (all the tags if no tags)
 * GET  /api/site/history?tags=a,b&from=..&to=..&maxPoints=2000&interval=60
 *                                     history between from and to (ms or ISO date), default: last 8 hours,
 *                                     tags of the page Courbes if no tags, interval: one value (average) every n seconds
 * PUT  /api/site/curves               choice of the tags of the page Courbes { curves: [{ tag, label, color, axis }] }
 * GET  /api/site/graphs               graphs of the page Courbes (graphs.js)
 * PUT  /api/site/graphs               save the graphs { graphs: [...] }, the tags of the graphs are recorded
 * GET  /api/site/history-config       source of the history (FUXA or PostgreSQL), without the password
 * PUT  /api/site/history-config       save the source of the history
 * POST /api/site/history-config/test  test a PostgreSQL connection (tables, columns of a table)
 */

'use strict';

const express = require('express');
const history = require('./history');
const graphs = require('./graphs');

const CURVES_VIEW = 'v_site_courbes';
const DEFAULT_RANGE = 8 * 3600 * 1000;
const MAX_RANGE = 366 * 24 * 3600 * 1000;
const MAX_TAGS = 50;
const MAX_POINTS = 200000;

function router(runtime, settings, siteName) {
    const app = express.Router();
    const source = history.create(runtime, settings);
    const authJwt = require('../../api/jwt-helper');
    // with the security enabled, a valid token is needed (header x-access-token)
    app.use((req, res, next) => settings.secureEnabled ? authJwt.requireAuth(req, res, next) : next());
    app.use((req, res, next) => runtime.project ? next() : res.status(503).json({ error: 'not_ready', message: 'Site en démarrage' }));

    app.get('/', (req, res) => {
        const base = `/site/${siteName}/api/site`;
        res.json({
            site: siteName,
            services: {
                info: `${base}/info`,
                values: `${base}/values?tags=nom1,nom2`,
                history: `${base}/history?tags=nom1,nom2&from=2026-11-09T08:00&to=2026-11-09T16:00`
            }
        });
    });

    app.get('/info', async (req, res) => {
        try {
            const project = await runtime.project.getProject(null, -1);
            res.json({
                site: siteName,
                historySource: { type: source.type, label: source.label },
                tags: allTags(project).map(tagInfo),
                curves: curves(project),
                graphs: siteGraphs(project, settings)
            });
        } catch (err) {
            sendError(res, err);
        }
    });

    app.get('/values', async (req, res) => {
        try {
            const project = await runtime.project.getProject(null, -1);
            const tags = findTags(project, req.query.tags, allTags(project));
            res.json({
                site: siteName,
                time: Date.now(),
                values: tags.map(tag => {
                    const current = runtime.devices.getTagValue(tag.id, true);
                    return Object.assign(tagInfo(tag), {
                        value: current ? current.value : null,
                        timestamp: current ? current.timestamp || current.ts || null : null
                    });
                })
            });
        } catch (err) {
            sendError(res, err);
        }
    });

    app.get('/history', async (req, res) => {
        try {
            const project = await runtime.project.getProject(null, -1);
            const to = parseTime(req.query.to, Date.now());
            const from = parseTime(req.query.from, to - DEFAULT_RANGE);
            if (from === null || to === null || from >= to) {
                return res.status(400).json({ error: 'invalid_period', message: 'Période invalide : from doit être avant to (ms ou date ISO).' });
            }
            if (to - from > MAX_RANGE) {
                return res.status(400).json({ error: 'period_too_long', message: 'Période trop longue (1 an au plus).' });
            }
            const curveTags = curves(project).map(line => line.tagId);
            const tags = findTags(project, req.query.tags, allTags(project).filter(tag => curveTags.includes(tag.id)));
            const maxPoints = Math.min(Math.max(parseInt(req.query.maxPoints, 10) || 2000, 10), MAX_POINTS);
            const interval = Math.max(parseInt(req.query.interval, 10) || 0, 0) * 1000;
            const series = [];
            for (const tag of tags) {
                const values = await source.values(tag, from, to);
                const sampled = interval ? sample(values, from, interval) : values;
                series.push(Object.assign(tagInfo(tag), { count: values.length, values: reduce(sampled, maxPoints) }));
            }
            res.json({ site: siteName, from, to, interval: interval / 1000, source: source.type, series });
        } catch (err) {
            sendError(res, err);
        }
    });

    /**
     * choice of the tags of the page Courbes (from configuration.html)
     * body: { curves: [{ tag: name or id, label, color, axis: 'gauche' | 'droite' }] }
     * the chart of the page Courbes shows these tags, and the tags are recorded (DAQ) to have their history
     */
    /** source of the history (FUXA or PostgreSQL), without the password */
    app.get('/history-config', (req, res) => {
        res.json(source.getConfig());
    });

    /** save the source of the history (the PostgreSQL table and columns are checked before) */
    app.put('/history-config', express.json({ limit: '50kb' }), async (req, res) => {
        try {
            const config = await source.setConfig(req.body);
            require('./files').refresh();
            res.json(config);
        } catch (err) {
            sendError(res, err);
        }
    });

    /** test of a PostgreSQL connection: its tables, and the columns of the table if given */
    app.post('/history-config/test', express.json({ limit: '50kb' }), async (req, res) => {
        try {
            res.json(await source.test(req.body));
        } catch (err) {
            res.status(400).json({ error: 'connection_failed', message: `Connexion impossible : ${err.message}` });
        }
    });

    app.put('/curves', express.json({ limit: '200kb' }), async (req, res) => {
        try {
            const list = req.body && Array.isArray(req.body.curves) ? req.body.curves : null;
            if (!list || list.length > MAX_TAGS) {
                return res.status(400).json({ error: 'invalid_curves', message: `Liste des courbes invalide (${MAX_TAGS} tags au plus).` });
            }
            const project = await runtime.project.getProject(null, -1);
            const all = allTags(project);
            const lines = list.map((curve, index) => {
                const tag = all.find(t => t.id === curve.tag || t.name === curve.tag);
                if (!tag) {
                    const err = new Error(`Tag inconnu dans ce site : ${curve.tag}`);
                    err.status = 404;
                    throw err;
                }
                return {
                    device: tag.deviceName, id: tag.id, name: tag.name,
                    label: String(curve.label || tag.name).trim().slice(0, 100) || tag.name,
                    color: /^#[0-9a-fA-F]{3,8}$/.test(curve.color || '') ? curve.color : COLORS[index % COLORS.length],
                    yaxis: curve.axis === 'droite' ? 2 : 1,
                    spanGaps: true
                };
            });
            await saveChart(runtime, project, lines);
            // the history of a tag exists only if the tag is recorded
            await record(runtime, project, lines.map(line => line.id));
            const saved = await runtime.project.getProject(null, -1);
            res.json({ site: siteName, curves: curves(saved) });
        } catch (err) {
            sendError(res, err);
        }
    });

    app.get('/graphs', async (req, res) => {
        try {
            const project = await runtime.project.getProject(null, -1);
            res.json({ site: siteName, graphs: siteGraphs(project, settings) });
        } catch (err) {
            sendError(res, err);
        }
    });

    /**
     * graphs of the page Courbes (from configuration.html): the tags of the graphs become the curves of the chart
     * of the page Courbes (used by historiques.html and the supervision) and are recorded (history)
     */
    app.put('/graphs', express.json({ limit: '500kb' }), async (req, res) => {
        try {
            const project = await runtime.project.getProject(null, -1);
            const all = allTags(project);
            const result = graphs.set(settings, req.body && req.body.graphs, all);
            const ids = graphs.usedTags(result);
            const lines = ids.map((id, index) => {
                const tag = all.find(t => t.id === id);
                let first = null;
                result.forEach(g => { first = first || g.series.find(x => x.tag === id); });
                return {
                    device: tag.deviceName, id: tag.id, name: tag.name,
                    label: (first && first.label) || tag.name,
                    color: (first && first.color) || COLORS[index % COLORS.length],
                    yaxis: 1,
                    spanGaps: true
                };
            });
            await saveChart(runtime, project, lines);
            await record(runtime, project, ids);
            const saved = await runtime.project.getProject(null, -1);
            res.json({ site: siteName, graphs: siteGraphs(saved, settings) });
        } catch (err) {
            sendError(res, err);
        }
    });

    return app;
}

/** lines of the chart of the page Courbes */
async function saveChart(runtime, project, lines) {
    const chartId = curvesChartId(project);
    const old = (project.charts || []).find(c => c.id === chartId);
    const charts = (project.charts || []).filter(c => c.id !== chartId);
    charts.push({ id: chartId, name: (old && old.name) || 'Courbes du site', lines });
    await save(runtime, 'charts', charts);
}

/** the history of a tag exists only if the tag is recorded (DAQ) */
async function record(runtime, project, ids) {
    for (const device of Object.values(project.devices || {})) {
        let changed = false;
        ids.forEach(id => {
            const tag = device.tags && device.tags[id];
            if (tag && !(tag.daq && tag.daq.enabled)) {
                tag.daq = Object.assign({ interval: 5, changed: true, restored: false }, tag.daq, { enabled: true });
                changed = true;
            }
        });
        if (changed) {
            await save(runtime, 'set-device', device);
        }
    }
}

/** graphs of the page Courbes, with the names of the tags */
function siteGraphs(project, settings) {
    const all = allTags(project);
    const lines = curves(project).map(c => ({ id: c.tagId, name: c.name, label: c.label, color: c.color }));
    const names = {};
    all.forEach(t => { names[t.id] = t.name; });
    return graphs.get(settings, all, lines).map(g => Object.assign(g, {
        xName: g.xTag ? names[g.xTag] : null,
        series: g.series.map(s => Object.assign(s, { name: names[s.tag] }))
    }));
}

const COLORS = ['#1565C0', '#E65100', '#2E7D32', '#C62828', '#6A1B9A', '#00838F', '#F9A825', '#4E342E', '#AD1457', '#37474F'];

/** save a part of the project and update the runtime, like the editor (api/projectData) */
function save(runtime, cmd, data) {
    return runtime.project.setProjectData(cmd, data).then(() => runtime.update(cmd, data));
}

/** chart shown by the page Courbes, else the default chart of the site */
function curvesChartId(project) {
    const view = ((project.hmi && project.hmi.views) || []).find(v => v.id === CURVES_VIEW);
    const item = Object.values((view && view.items) || {}).find(i => i.type === 'svg-ext-html_chart' && i.property && i.property.id);
    return item ? item.property.id : 'chart_site_courbes';
}

/** tags of the site, without the system tags (connection status...) */
function allTags(project) {
    const tags = [];
    Object.values(project.devices || {}).forEach(device => {
        Object.values(device.tags || {}).forEach(tag => {
            if (!tag.sysType) {
                tags.push(Object.assign({}, tag, { deviceName: device.name }));
            }
        });
    });
    return tags;
}

/** tags asked by name or id (tags=a,b), else the default list */
function findTags(project, query, defaults) {
    if (!query) {
        return defaults.slice(0, MAX_TAGS);
    }
    const all = allTags(project);
    const names = String(query).split(',').map(name => name.trim()).filter(name => name).slice(0, MAX_TAGS);
    const unknown = names.filter(name => !all.some(tag => tag.name === name || tag.id === name));
    if (unknown.length) {
        const err = new Error(`Tag inconnu dans ce site : ${unknown.join(', ')}`);
        err.status = 404;
        throw err;
    }
    return names.map(name => all.find(tag => tag.name === name || tag.id === name));
}

function tagInfo(tag) {
    return {
        id: tag.id,
        name: tag.name,
        device: tag.deviceName,
        address: tag.address || '',
        type: tag.type || '',
        description: tag.description || '',
        recorded: !!(tag.daq && tag.daq.enabled)
    };
}

/** curves of the page Courbes: lines of the chart shown by the page */
function curves(project) {
    const view = ((project.hmi && project.hmi.views) || []).find(v => v.id === CURVES_VIEW);
    const item = Object.values((view && view.items) || {}).find(i => i.type === 'svg-ext-html_chart' && i.property && i.property.id);
    const chart = item ? (project.charts || []).find(c => c.id === item.property.id) : null;
    return ((chart && chart.lines) || []).map(line => ({
        tagId: line.id, name: line.name, label: line.label || line.name, color: line.color || '', axis: Number(line.yaxis) === 2 ? 'droite' : 'gauche'
    }));
}

/**
 * sampling: one value every interval (ms) from the start of the period, average of the numbers
 * (time of the middle of the interval), last value for the other values (text)
 */
function sample(values, from, interval) {
    const result = [];
    let bucket = null;
    const close = () => {
        if (bucket) {
            const v = bucket.count ? Math.round(bucket.sum / bucket.count * 1e6) / 1e6 : bucket.last;
            result.push({ t: bucket.start + Math.round(interval / 2), v: v });
        }
    };
    values.forEach(p => {
        const start = from + Math.floor((p.t - from) / interval) * interval;
        if (!bucket || bucket.start !== start) {
            close();
            bucket = { start: start, sum: 0, count: 0, last: p.v };
        }
        const num = p.v === true || p.v === 'true' ? 1 : p.v === false || p.v === 'false' ? 0 : Number(p.v);
        if (p.v !== null && p.v !== '' && Number.isFinite(num)) {
            bucket.sum += num;
            bucket.count++;
        }
        bucket.last = p.v;
    });
    close();
    return result;
}

/** ms, or a date (ISO, 2026-11-09T08:00) */
function parseTime(value, fallback) {
    if (value === undefined || value === '') {
        return fallback;
    }
    const num = Number(value);
    const time = Number.isFinite(num) ? num : Date.parse(value);
    return Number.isFinite(time) ? time : null;
}

/** keep at most maxPoints values (one value every n), the last value is always kept */
function reduce(values, maxPoints) {
    if (values.length <= maxPoints) {
        return values;
    }
    const step = values.length / maxPoints;
    const result = [];
    for (let i = 0; i < maxPoints - 1; i++) {
        result.push(values[Math.floor(i * step)]);
    }
    result.push(values[values.length - 1]);
    return result;
}

function sendError(res, err) {
    res.status(err.status || 500).json({ error: err.status === 404 ? 'not_found' : 'site_api_error', message: err.message || String(err) });
}

module.exports = {
    router: router
};
