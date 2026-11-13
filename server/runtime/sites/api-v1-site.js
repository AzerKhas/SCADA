/**
 * custom-SCADA: API v1 of a site (runs in the FUXA instance of the site, under /site/<site_id>/api/v1)
 * Called through the main FUXA: /api/v1/sites/<site_id>/... is forwarded here (api-v1-hub.js).
 * Each site has its own instance, so the data of a site is separated from the data of the other sites.
 *
 * GET  /                         list of the services
 * GET  /config                   configuration of the site: connections, pages, graphs, source of the history
 * GET  /config/graphs            graphs of the page Courbes
 * PUT  /config/graphs            save the graphs { graphs: [...] }
 * GET  /config/history           source of the history (without the password)
 * PUT  /config/history           save the source of the history
 * POST /config/history/test      test a PostgreSQL connection
 * GET  /devices                  connections (equipments) with their state
 * GET  /tags                     tags (search, device, recorded: filters)
 * GET  /tags/:tag                one tag with its current value
 * GET  /values?tags=a,b          current values (all the tags if no tags)
 * GET  /history?tags=a,b&from=&to=&interval=&maxPoints=
 * GET  /config/graph-sets        configurations of graphs (POST create, PUT /:id rename, DELETE /:id, POST /:id/activate,
 *                                GET / PUT /:id/graphs)
 * GET  /curves?set=              graphs of the page Courbes (active configuration, or set)
 * GET  /curves/:graph_id/data    data of a graph for a period (mode temps: values, mode XY: points x / y)
 * GET  /alarms                   active alarms (filters: type, tag, text)
 * GET  /alarms/history?from=&to= history of the alarms
 * POST /alarms/:alarm_id/ack     acknowledge an alarm (all the alarms: POST /alarms/ack)
 */

'use strict';

const express = require('express');
const api = require('./api');
const { ApiError, badRequest, notFound, send, handle, jsonErrors, period, integer, list, body } = require('./api-v1-common');

const MAX_HISTORY = 366 * 24 * 3600 * 1000;
const DEFAULT_PERIOD = 8 * 3600 * 1000;

function router(runtime, settings, siteId) {
    const app = express.Router();
    const logger = runtime.logger;
    const source = api.historySource(runtime, settings);
    const authJwt = require('../../api/jwt-helper');
    const meta = extra => Object.assign({ site_id: siteId }, extra || {});
    const h = fnc => handle(fnc, logger);

    // with the security enabled, a valid token is needed (header x-access-token)
    app.use((req, res, next) => settings.secureEnabled ? authJwt.requireAuth(req, res, next) : next());
    app.use((req, res, next) => runtime.project ? next() : h(() => { throw new ApiError(503, 'site_starting', 'Site en démarrage, réessayez dans quelques secondes.'); })(req, res));
    app.use(express.json({ limit: '1mb' }));
    app.use(jsonErrors);

    const project = () => runtime.project.getProject(null, -1);

    /** tags of the site asked by name or id; unknown tags: 404 with the list */
    const findTags = (all, names) => {
        const unknown = names.filter(n => !all.some(t => t.id === n || t.name === n));
        if (unknown.length) {
            throw new ApiError(404, 'tag_not_found', `Tag inconnu dans le site ${siteId} : ${unknown.join(', ')}`, { tags: unknown });
        }
        return names.map(n => all.find(t => t.id === n || t.name === n));
    };

    const currentValue = tag => {
        const current = runtime.devices.getTagValue(tag.id, true);
        return {
            value: current ? current.value : null,
            timestamp: current ? current.timestamp || current.ts || null : null
        };
    };

    app.get('/', h((req, res) => {
        const base = `/api/v1/sites/${siteId}`;
        send(res, {
            site_id: siteId,
            services: [
                `GET ${base}/config`, `GET|PUT ${base}/config/graphs`, `GET|PUT ${base}/config/history`, `POST ${base}/config/history/test`,
                `GET ${base}/devices`, `GET ${base}/tags`, `GET ${base}/tags/{tag}`, `GET ${base}/values`, `GET ${base}/history`,
                `GET ${base}/curves`, `GET ${base}/curves/{graph_id}/data`,
                `GET ${base}/alarms`, `GET ${base}/alarms/history`, `POST ${base}/alarms/{alarm_id}/ack`, `POST ${base}/alarms/ack`
            ]
        }, meta());
    }));

    // ---------------------------------------------------------------- configuration
    app.get('/config', h(async (req, res) => {
        const prj = await project();
        const views = (prj.hmi && prj.hmi.views) || [];
        send(res, {
            site_id: siteId,
            version: prj.version || null,
            devices: Object.values(prj.devices || {}).map(deviceInfo),
            pages: views.map(v => ({ id: v.id, name: v.name })),
            menu: ((prj.hmi && prj.hmi.layout && prj.hmi.layout.navigation && prj.hmi.layout.navigation.items) || [])
                .map(item => ({ text: item.text, page: item.view || null, link: item.link || null })),
            alarms: (prj.alarms || []).length,
            graphs: api.siteGraphs(prj, settings),
            history: source.getConfig()
        }, meta());
    }));

    app.get('/config/graphs', h(async (req, res) => {
        send(res, api.siteGraphs(await project(), settings), meta());
    }));

    app.put('/config/graphs', h(async (req, res) => {
        const input = body(req);
        if (!Array.isArray(input.graphs)) {
            throw badRequest('Champ graphs attendu : liste des graphiques.', { field: 'graphs' });
        }
        send(res, await api.saveGraphs(runtime, settings, input.graphs), meta());
    }));

    // configurations of graphs (several sets of graphs for the site, one of them active)
    app.get('/config/graph-sets', h(async (req, res) => {
        const result = await api.graphSets(runtime, settings, 'list');
        send(res, result.sets, meta({ count: result.sets.length }));
    }));

    app.post('/config/graph-sets', h(async (req, res) => {
        const input = body(req);
        if (typeof input.name !== 'string' || !input.name.trim()) {
            throw badRequest('Champ name manquant : nom de la configuration.', { field: 'name' });
        }
        const result = await api.graphSets(runtime, settings, 'create', { name: input.name, copyFrom: input.copyFrom });
        send(res, result.set, meta({ sets: result.sets }), 201);
    }));

    app.put('/config/graph-sets/:set_id', h(async (req, res) => {
        const input = body(req);
        const result = await api.graphSets(runtime, settings, 'rename', { setId: req.params.set_id, name: input.name });
        send(res, result.set, meta({ sets: result.sets }));
    }));

    app.delete('/config/graph-sets/:set_id', h(async (req, res) => {
        const result = await api.graphSets(runtime, settings, 'delete', { setId: req.params.set_id });
        send(res, { set_id: req.params.set_id, deleted: true }, meta({ sets: result.sets }));
    }));

    app.post('/config/graph-sets/:set_id/activate', h(async (req, res) => {
        const result = await api.graphSets(runtime, settings, 'activate', { setId: req.params.set_id });
        send(res, result.sets, meta());
    }));

    app.get('/config/graph-sets/:set_id/graphs', h(async (req, res) => {
        send(res, api.siteGraphs(await project(), settings, req.params.set_id), meta({ set_id: req.params.set_id }));
    }));

    app.put('/config/graph-sets/:set_id/graphs', h(async (req, res) => {
        const input = body(req);
        if (!Array.isArray(input.graphs)) {
            throw badRequest('Champ graphs attendu : liste des graphiques.', { field: 'graphs' });
        }
        send(res, await api.saveGraphs(runtime, settings, input.graphs, req.params.set_id), meta({ set_id: req.params.set_id }));
    }));

    app.get('/config/history', h((req, res) => {
        send(res, source.getConfig(), meta());
    }));

    app.put('/config/history', h(async (req, res) => {
        const config = await source.setConfig(body(req)).catch(err => { throw new ApiError(400, 'invalid_history_config', err.message); });
        require('./files').refresh();
        send(res, config, meta());
    }));

    app.post('/config/history/test', h(async (req, res) => {
        const result = await source.test(body(req)).catch(err => { throw new ApiError(400, 'connection_failed', `Connexion impossible : ${err.message}`); });
        send(res, result, meta());
    }));

    // ---------------------------------------------------------------- equipments and tags
    app.get('/devices', h(async (req, res) => {
        const prj = await project();
        const status = runtime.devices.getDevicesStatus() || {};
        send(res, Object.values(prj.devices || {}).map(device => Object.assign(deviceInfo(device), {
            status: status[device.id] ? String(status[device.id].status || status[device.id]) : (device.enabled === false ? 'disabled' : 'unknown')
        })), meta());
    }));

    app.get('/tags', h(async (req, res) => {
        const prj = await project();
        const search = String(req.query.search || '').trim().toLowerCase();
        const device = String(req.query.device || '').trim();
        const recorded = req.query.recorded;
        if (recorded !== undefined && recorded !== 'true' && recorded !== 'false') {
            throw badRequest('Paramètre recorded invalide : true ou false.', { param: 'recorded', value: recorded });
        }
        const devices = Object.values(prj.devices || {});
        const types = {};
        devices.forEach(d => { types[d.name] = d.type; });
        let tags = api.allTags(prj).map(tag => Object.assign(api.tagInfo(tag), { category: types[tag.deviceName] || '' }));
        if (device) {
            const found = devices.find(d => d.id === device || d.name === device);
            if (!found) {
                throw notFound('device_not_found', `Connexion inconnue dans le site ${siteId} : ${device}`);
            }
            tags = tags.filter(t => t.device === found.name);
        }
        if (search) {
            tags = tags.filter(t => `${t.name} ${t.device} ${t.address} ${t.description} ${t.category}`.toLowerCase().includes(search));
        }
        if (recorded !== undefined) {
            tags = tags.filter(t => t.recorded === (recorded === 'true'));
        }
        send(res, tags, meta({ count: tags.length }));
    }));

    app.get('/tags/:tag', h(async (req, res) => {
        const tag = findTags(api.allTags(await project()), [req.params.tag])[0];
        send(res, Object.assign(api.tagInfo(tag), currentValue(tag)), meta({ time: Date.now() }));
    }));

    app.get('/values', h(async (req, res) => {
        const all = api.allTags(await project());
        const names = list(req.query.tags);
        if (names.length > api.MAX_TAGS) {
            throw badRequest(`Trop de tags (${api.MAX_TAGS} au plus).`);
        }
        const tags = names.length ? findTags(all, names) : all;
        send(res, tags.map(tag => Object.assign(api.tagInfo(tag), currentValue(tag))), meta({ time: Date.now(), count: tags.length }));
    }));

    // ---------------------------------------------------------------- history and curves
    /** values of the tags for the period, sampled (interval in s) and reduced to maxPoints per tag */
    const readHistory = async (tags, query, defaultPoints) => {
        const { from, to } = period(query, DEFAULT_PERIOD, MAX_HISTORY);
        const interval = integer(query.interval, 'interval', 0, 7 * 24 * 3600, 0) * 1000;
        const maxPoints = integer(query.maxPoints, 'maxPoints', 10, api.MAX_POINTS, defaultPoints);
        const series = [];
        for (const tag of tags) {
            const values = await source.values(tag, from, to);
            const sampled = interval ? api.sample(values, from, interval) : values;
            series.push(Object.assign(api.tagInfo(tag), { count: values.length, values: api.reduce(sampled, maxPoints) }));
        }
        return { from, to, interval: interval / 1000, series };
    };

    app.get('/history', h(async (req, res) => {
        const prj = await project();
        const all = api.allTags(prj);
        let names = list(req.query.tags);
        if (!names.length) {
            // tags of the graphs of the page Courbes
            names = api.curves(prj).map(c => c.tagId);
        }
        if (!names.length) {
            throw badRequest('Paramètre tags manquant : tags=nom1,nom2.', { param: 'tags' });
        }
        if (names.length > api.MAX_TAGS) {
            throw badRequest(`Trop de tags (${api.MAX_TAGS} au plus).`);
        }
        const result = await readHistory(findTags(all, names), req.query, 2000);
        send(res, result.series, meta({ from: result.from, to: result.to, interval: result.interval, source: source.type }));
    }));

    app.get('/curves', h(async (req, res) => {
        const set = req.query.set ? String(req.query.set) : undefined;
        send(res, api.siteGraphs(await project(), settings, set), meta({ set_id: set || null }));
    }));

    /**
     * data of a graph: mode temps: series [{ tag, label, unit, color, values: [{ t, v }] }],
     * mode xy: series [{ tag, label, unit, color, points: [{ x, y, t }] }] (x: value of the tag X at the time of y)
     * period: from / to, else the period of the graph; interval: the sampling of the graph if not given
     */
    app.get('/curves/:graph_id/data', h(async (req, res) => {
        const prj = await project();
        const graph = api.siteGraphs(prj, settings, req.query.set ? String(req.query.set) : undefined).find(g => g.id === req.params.graph_id);
        if (!graph) {
            throw notFound('graph_not_found', `Graphique inconnu dans le site ${siteId} : ${req.params.graph_id}`);
        }
        const query = Object.assign({}, req.query);
        if (!query.from && !query.to) {
            if (graph.mode !== 'xy' && graph.period.type === 'fixed') {
                query.from = graph.period.from;
                query.to = graph.period.to;
            } else {
                query.to = Date.now();
                query.from = query.to - graph.period.hours * 3600000;
            }
        }
        if (query.interval === undefined) {
            query.interval = graph.interval;
        }
        const all = api.allTags(prj);
        const ids = graph.series.map(s => s.tag).concat(graph.mode === 'xy' && !graph.series.some(s => s.tag === graph.xTag) ? [graph.xTag] : []);
        const data = await readHistory(findTags(all, ids), query, graph.mode === 'xy' ? 20000 : 4000);
        const byId = {};
        data.series.forEach(s => { byId[s.id] = s; });
        const describe = s => ({ tag: s.tag, name: s.name, label: s.label || s.name, unit: s.unit, color: s.color, min: s.min, max: s.max, decimals: s.decimals });
        let series;
        if (graph.mode === 'xy') {
            const xs = numbers(byId[graph.xTag]);
            series = graph.series.filter(s => s.tag !== graph.xTag).map(s => Object.assign(describe(s), { points: pair(xs, numbers(byId[s.tag])) }));
        } else {
            series = graph.series.map(s => Object.assign(describe(s), { count: byId[s.tag].count, values: byId[s.tag].values }));
        }
        send(res, {
            graph: { id: graph.id, title: graph.title, mode: graph.mode, xTag: graph.xTag, xName: graph.xName, xUnit: graph.xUnit, xMin: graph.xMin, xMax: graph.xMax },
            series
        }, meta({ from: data.from, to: data.to, interval: data.interval, source: source.type }));
    }));

    // ---------------------------------------------------------------- alarms
    const ADMIN = -1;
    /** name of the alarm definition: name of its tag */
    const alarmTags = async () => {
        const prj = await project();
        const names = {};
        api.allTags(prj).forEach(t => { names[t.id] = t.name; });
        const defs = {};
        (prj.alarms || []).forEach(a => { defs[a.name] = names[a.property && a.property.variableId] || null; });
        return defs;
    };

    app.get('/alarms', h(async (req, res) => {
        const type = String(req.query.type || '').trim();
        const text = String(req.query.text || '').trim().toLowerCase();
        const tag = String(req.query.tag || '').trim();
        const defs = await alarmTags();
        let alarms = (runtime.alarmsMgr.getAlarmsValues(null, ADMIN) || []).map(a => alarmInfo(a, defs));
        if (type) {
            alarms = alarms.filter(a => a.type === type);
        }
        if (text) {
            alarms = alarms.filter(a => `${a.text} ${a.group} ${a.name}`.toLowerCase().includes(text));
        }
        if (tag) {
            alarms = alarms.filter(a => a.tag === tag || a.name === tag);
        }
        send(res, alarms, meta({ count: alarms.length, time: Date.now() }));
    }));

    app.get('/alarms/history', h(async (req, res) => {
        const { from, to } = period(req.query, 24 * 3600 * 1000, MAX_HISTORY);
        const history = await runtime.alarmsMgr.getAlarmsHistory({ start: from, end: to }, ADMIN);
        const defs = await alarmTags();
        send(res, history.map(a => alarmInfo(a, defs)), meta({ from, to, count: history.length }));
    }));

    app.post('/alarms/ack', h(async (req, res) => {
        const changed = await runtime.alarmsMgr.setAlarmAck(null, req.userId || null, ADMIN);
        send(res, { acknowledged: !!changed }, meta());
    }));

    app.post('/alarms/:alarm_id/ack', h(async (req, res) => {
        const id = req.params.alarm_id;
        const exists = (runtime.alarmsMgr.getAlarmsValues(null, ADMIN) || []).some(a => a.name === id);
        if (!exists) {
            throw notFound('alarm_not_found', `Alarme active inconnue dans le site ${siteId} : ${id}`);
        }
        const changed = await runtime.alarmsMgr.setAlarmAck(id, req.userId || null, ADMIN);
        send(res, { alarm_id: id, acknowledged: !!changed }, meta());
    }));

    // ---------------------------------------------------------------- versions
    const versions = require('./versions');
    const findVersion = async id => {
        const version = await versions.get(id);
        if (!version) {
            throw notFound('version_not_found', `Version inconnue dans le site ${siteId} : ${id}`);
        }
        return version;
    };
    const versionInfo = v => ({ version_id: v.id, time: v.time, type: v.type, typeText: versions.TYPES[v.type] || v.type, comment: v.comment || '' });
    /** version compared: ?with=<version_id> | current | previous (default: the previous version) */
    const compareWith = async (version, other) => {
        if (other && other !== 'previous') {
            return findVersion(other);
        }
        const all = versions.list();
        const index = all.findIndex(v => v.id === version.id);
        const previous = index >= 0 ? all[index + 1] : null;
        return previous ? versions.get(previous.id) : null;
    };

    app.get('/versions', h((req, res) => {
        const all = versions.list().map(v => Object.assign({ version_id: v.id }, v));
        all.forEach(v => { delete v.id; delete v.hash; });
        send(res, all, meta({ count: all.length }));
    }));

    app.post('/versions', h(async (req, res) => {
        const input = req.body && typeof req.body === 'object' ? req.body : {};
        const comment = String(input.comment || '').trim().slice(0, 200);
        if (!comment) {
            throw badRequest('Champ comment manquant : description de la version.', { field: 'comment' });
        }
        const entry = await versions.snapshot({ type: 'manual', comment });
        send(res, Object.assign(versionInfo(entry), { summary: entry.summary, size: entry.size }), meta(), 201);
    }));

    app.get('/versions/:version_id', h(async (req, res) => {
        const version = await findVersion(req.params.version_id);
        const previous = await compareWith(version, 'previous');
        const changes = previous ? versions.compare(previous, version) : [];
        send(res, Object.assign(versionInfo(version), {
            pages: ((version.project.hmi && version.project.hmi.views) || []).map(v => ({ id: v.id, name: v.name })),
            files: Object.keys(version.files || {}),
            changes,
            summary: previous ? versions.summarize(changes) : 'première version'
        }), meta());
    }));

    app.get('/versions/:version_id/changes', h(async (req, res) => {
        const version = await findVersion(req.params.version_id);
        const other = await compareWith(version, req.query.with);
        if (!other) {
            return send(res, [], meta({ from: null, to: version.id, summary: 'première version' }));
        }
        // from the older to the newer
        const [a, b] = other.time <= version.time ? [other, version] : [version, other];
        const changes = versions.compare(a, b);
        send(res, changes, meta({ from: a.id, to: b.id, summary: versions.summarize(changes), count: changes.length }));
    }));

    app.get('/versions/:version_id/diff', h(async (req, res) => {
        const version = await findVersion(req.params.version_id);
        const file = String(req.query.file || '');
        const other = await compareWith(version, req.query.with);
        const [a, b] = !other ? [null, version] : other.time <= version.time ? [other, version] : [version, other];
        const files = Array.from(new Set(Object.keys((a && a.files) || {}).concat(Object.keys(b.files || {})))).sort();
        if (!file) {
            throw badRequest(`Paramètre file manquant : ${files.join(', ')}`, { param: 'file', files });
        }
        if (!files.includes(file)) {
            throw notFound('file_not_found', `Fichier absent de ces versions : ${file}`);
        }
        const lines = versions.diffLines(a && a.files ? a.files[file] : '', b.files ? b.files[file] : '');
        send(res, lines, meta({ from: a ? a.id : null, to: b.id, file, added: lines.filter(l => l.type === '+').length, removed: lines.filter(l => l.type === '-').length }));
    }));

    app.post('/versions/:version_id/restore', h(async (req, res) => {
        const version = await findVersion(req.params.version_id);
        if (version.id === 'current') {
            throw badRequest('L\'état actuel ne peut pas être restauré.');
        }
        await versions.restore(version.id);
        send(res, Object.assign(versionInfo(version), { restored: true }), meta());
    }));

    // unknown service of the API v1
    app.use(h(req => {
        throw notFound('unknown_service', `Service inconnu : ${req.method} /api/v1/sites/${siteId}${req.path}`);
    }));
    return app;
}

function deviceInfo(device) {
    return {
        id: device.id, name: device.name, type: device.type, enabled: device.enabled !== false,
        polling: device.polling || null, tags: Object.values(device.tags || {}).filter(t => !t.sysType).length
    };
}

/** alarm: alarm_id = <name of the alarm>^~^<type> (id of FUXA), tag of the alarm */
function alarmInfo(a, defs) {
    const id = a.type && !String(a.name).includes('^~^') ? `${a.name}^~^${a.type}` : String(a.name);
    const name = id.split('^~^')[0];
    return {
        alarm_id: id, name: name, tag: (defs && defs[name]) || null, type: a.type, text: a.text || '', group: a.group || '', status: a.status || '',
        value: a.value === undefined ? null : a.value,
        ontime: a.ontime || null, offtime: a.offtime || null, acktime: a.acktime || null,
        toack: a.toack === undefined ? undefined : !!a.toack, userack: a.userack || undefined
    };
}

function numbers(series) {
    const result = [];
    ((series && series.values) || []).forEach(p => {
        const v = p.v === true || p.v === 'true' ? 1 : p.v === false || p.v === 'false' ? 0 : p.v === null || p.v === '' ? NaN : Number(p.v);
        if (Number.isFinite(v)) {
            result.push({ t: p.t, v });
        }
    });
    return result;
}

/** each value y gets the last value of x recorded before it */
function pair(xs, ys) {
    const points = [];
    let k = -1;
    ys.forEach(p => {
        while (k + 1 < xs.length && xs[k + 1].t <= p.t) {
            k++;
        }
        if (k >= 0) {
            points.push({ x: xs[k].v, y: p.v, t: p.t });
        }
    });
    return points;
}

module.exports = {
    router: router
};
