/**
 * custom-SCADA: API of a site (runs in the FUXA instance of the site, under /site/<name>/api/site)
 * Each site has its own instance, so the API gives only the tags and the data of its site.
 *
 * GET  /api/site                      list of the services
 * GET  /api/site/info                 site, tags, curves (tags of the page Courbes), history source
 * GET  /api/site/values?tags=a,b      current values (all the tags if no tags)
 * GET  /api/site/history?tags=a,b&from=..&to=..&maxPoints=2000
 *                                     history between from and to (ms or ISO date), default: last 8 hours,
 *                                     tags of the page Courbes if no tags
 * PUT  /api/site/curves               choice of the tags of the page Courbes { curves: [{ tag, label, color, axis }] }
 * GET  /api/site/history-config       source of the history (FUXA or PostgreSQL), without the password
 * PUT  /api/site/history-config       save the source of the history
 * POST /api/site/history-config/test  test a PostgreSQL connection (tables, columns of a table)
 */

'use strict';

const express = require('express');
const history = require('./history');

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
                curves: curves(project)
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
            const series = [];
            for (const tag of tags) {
                const values = await source.values(tag, from, to);
                series.push(Object.assign(tagInfo(tag), { count: values.length, values: reduce(values, maxPoints) }));
            }
            res.json({ site: siteName, from, to, source: source.type, series });
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
            const chartId = curvesChartId(project);
            const old = (project.charts || []).find(c => c.id === chartId);
            const charts = (project.charts || []).filter(c => c.id !== chartId);
            charts.push({ id: chartId, name: (old && old.name) || 'Courbes du site', lines });
            await save(runtime, 'charts', charts);
            // the history of a tag exists only if the tag is recorded
            for (const device of Object.values(project.devices || {})) {
                let changed = false;
                lines.forEach(line => {
                    const tag = device.tags && device.tags[line.id];
                    if (tag && !(tag.daq && tag.daq.enabled)) {
                        tag.daq = Object.assign({ interval: 5, changed: true, restored: false }, tag.daq, { enabled: true });
                        changed = true;
                    }
                });
                if (changed) {
                    await save(runtime, 'set-device', device);
                }
            }
            res.json({ site: siteName, curves: curves(await runtime.project.getProject(null, -1)) });
        } catch (err) {
            sendError(res, err);
        }
    });

    return app;
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
