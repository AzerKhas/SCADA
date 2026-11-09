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
 */

'use strict';

const express = require('express');
const history = require('./history');

const CURVES_VIEW = 'v_site_courbes';
const DEFAULT_RANGE = 8 * 3600 * 1000;
const MAX_RANGE = 366 * 24 * 3600 * 1000;
const MAX_TAGS = 50;
const MAX_POINTS = 20000;

function router(runtime, settings, siteName) {
    const app = express.Router();
    const source = history.create(runtime, settings.siteHistory);
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

    return app;
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
