/**
 * custom-SCADA: API v1 of the main FUXA (/api/v1): management of the sites, and access to the data of each site
 *
 * GET    /api/v1                              list of the services
 * GET    /api/v1/sites                        sites (state, address, pages, files)
 * POST   /api/v1/sites                        create a site { site_id }
 * GET    /api/v1/sites/:site_id               one site
 * PUT    /api/v1/sites/:site_id               rename a site { site_id: new name }
 * DELETE /api/v1/sites/:site_id               delete a site (moved to sites/_supprimes)
 * POST   /api/v1/sites/:site_id/start         start the site
 * POST   /api/v1/sites/:site_id/stop          stop the site
 * GET    /api/v1/sites/:site_id/export        folder of the site (.zip)
 * *      /api/v1/sites/:site_id/<service>     services of the site (config, tags, values, history, curves, alarms),
 *                                             forwarded to the instance of the site (api-v1-site.js)
 */

'use strict';

const http = require('http');
const express = require('express');
const { ApiError, badRequest, notFound, send, sendError, handle, jsonErrors, body } = require('./api-v1-common');

/** services answered by the main FUXA, the others are forwarded to the site */
const HUB_ACTIONS = ['start', 'stop', 'export'];

/**
 * @param manager functions of the manager of the sites (index.js)
 */
function router(manager, settings, logger) {
    const app = express.Router();
    const authJwt = require('../../api/jwt-helper');
    const h = fnc => handle(fnc, logger);

    app.use((req, res, next) => settings.secureEnabled ? authJwt.requireAuth(req, res, next) : next());

    const findSite = id => {
        const site = manager.get(id);
        if (!site) {
            throw notFound('site_not_found', `Le site « ${id} » n'existe pas.`);
        }
        return site;
    };
    /** body already read by FUXA (body-parser) or JSON to read */
    const readJson = express.json({ limit: '1mb' });
    const withBody = [(req, res, next) => (req._body ? next() : readJson(req, res, next)), jsonErrors];

    app.get('/', h((req, res) => {
        send(res, {
            name: 'API custom-SCADA',
            version: 'v1',
            format: { success: '{ data, meta }', error: '{ error: { code, message, details } }' },
            services: {
                sites: [
                    'GET /api/v1/sites', 'POST /api/v1/sites { site_id }', 'GET /api/v1/sites/{site_id}',
                    'PUT /api/v1/sites/{site_id} { site_id }', 'DELETE /api/v1/sites/{site_id}',
                    'POST /api/v1/sites/{site_id}/start', 'POST /api/v1/sites/{site_id}/stop', 'GET /api/v1/sites/{site_id}/export'
                ],
                configuration: ['GET /api/v1/sites/{site_id}/config', 'GET|PUT /api/v1/sites/{site_id}/config/graphs',
                    'GET|PUT /api/v1/sites/{site_id}/config/history', 'POST /api/v1/sites/{site_id}/config/history/test'],
                data: ['GET /api/v1/sites/{site_id}/devices', 'GET /api/v1/sites/{site_id}/tags', 'GET /api/v1/sites/{site_id}/tags/{tag}',
                    'GET /api/v1/sites/{site_id}/values', 'GET /api/v1/sites/{site_id}/history'],
                curves: ['GET /api/v1/sites/{site_id}/curves', 'GET /api/v1/sites/{site_id}/curves/{graph_id}/data'],
                alarms: ['GET /api/v1/sites/{site_id}/alarms', 'GET /api/v1/sites/{site_id}/alarms/history',
                    'POST /api/v1/sites/{site_id}/alarms/{alarm_id}/ack', 'POST /api/v1/sites/{site_id}/alarms/ack'],
                versions: ['GET /api/v1/sites/{site_id}/versions', 'POST /api/v1/sites/{site_id}/versions { comment }',
                    'GET /api/v1/sites/{site_id}/versions/{version_id}', 'GET /api/v1/sites/{site_id}/versions/{version_id}/changes?with=',
                    'GET /api/v1/sites/{site_id}/versions/{version_id}/diff?file=&with=', 'POST /api/v1/sites/{site_id}/versions/{version_id}/restore'],
                backups: ['GET /api/v1/sites/{site_id}/backups', 'POST /api/v1/sites/{site_id}/backups { comment }',
                    'GET /api/v1/sites/{site_id}/backups/{backup_id}', 'DELETE /api/v1/sites/{site_id}/backups/{backup_id}',
                    'POST /api/v1/sites/{site_id}/backups/{backup_id}/restore']
            }
        });
    }));

    app.get('/sites', h(async (req, res) => {
        const list = await manager.list();
        send(res, list.map(siteData), { count: list.length });
    }));

    app.post('/sites', withBody, h(async (req, res) => {
        const input = body(req);
        const id = input.site_id || input.name;
        if (typeof id !== 'string' || !id.trim()) {
            throw badRequest('Champ site_id manquant : nom du nouveau site.', { field: 'site_id' });
        }
        const site = await manager.create(id);
        send(res, siteData(manager.info(site)), null, 201);
    }));

    app.get('/sites/:site_id', h(async (req, res) => {
        const site = findSite(req.params.site_id);
        send(res, siteData(await manager.infoWithPages(site)));
    }));

    app.put('/sites/:site_id', withBody, h(async (req, res) => {
        const site = findSite(req.params.site_id);
        const input = body(req);
        const id = input.site_id || input.name;
        if (typeof id !== 'string' || !id.trim()) {
            throw badRequest('Champ site_id manquant : nouveau nom du site.', { field: 'site_id' });
        }
        send(res, siteData(manager.info(await manager.rename(site, id))));
    }));

    app.delete('/sites/:site_id', h(async (req, res) => {
        const site = findSite(req.params.site_id);
        await manager.remove(site);
        send(res, { site_id: site.name, deleted: true });
    }));

    app.post('/sites/:site_id/start', h(async (req, res) => {
        const site = findSite(req.params.site_id);
        await manager.start(site);
        send(res, siteData(manager.info(site)));
    }));

    app.post('/sites/:site_id/stop', h(async (req, res) => {
        const site = findSite(req.params.site_id);
        await manager.stop(site);
        send(res, siteData(manager.info(site)));
    }));

    app.get('/sites/:site_id/export', h(async (req, res) => {
        await manager.exportZip(findSite(req.params.site_id), res);
    }));

    // full backups of the folder of the site (sites/_sauvegardes/<site_id>/)
    app.get('/sites/:site_id/backups', h((req, res) => {
        const list = manager.backups(findSite(req.params.site_id));
        send(res, list, { site_id: req.params.site_id, count: list.length });
    }));

    app.post('/sites/:site_id/backups', withBody, h((req, res) => {
        const site = findSite(req.params.site_id);
        const input = req.body && typeof req.body === 'object' ? req.body : {};
        send(res, manager.createBackup(site, input.comment), { site_id: site.name }, 201);
    }));

    app.get('/sites/:site_id/backups/:backup_id', h((req, res) => {
        const backup = manager.backup(findSite(req.params.site_id), req.params.backup_id);
        res.download(backup.path, backup.file);
    }));

    app.delete('/sites/:site_id/backups/:backup_id', h((req, res) => {
        const site = findSite(req.params.site_id);
        manager.deleteBackup(site, req.params.backup_id);
        send(res, { backup_id: req.params.backup_id, deleted: true }, { site_id: site.name });
    }));

    app.post('/sites/:site_id/backups/:backup_id/restore', h(async (req, res) => {
        const site = findSite(req.params.site_id);
        send(res, await manager.restoreBackup(site, req.params.backup_id), { site_id: site.name });
    }));

    // the other services are answered by the instance of the site
    app.all('/sites/:site_id/*', h((req, res) => {
        const site = findSite(req.params.site_id);
        const service = req.params[0] || '';
        if (HUB_ACTIONS.includes(service)) {
            throw new ApiError(405, 'method_not_allowed', `Méthode ${req.method} non autorisée pour ${service}.`);
        }
        if (!site.running) {
            throw new ApiError(503, site.stopped ? 'site_stopped' : 'site_starting',
                site.stopped ? `Le site « ${site.name} » est arrêté (POST /api/v1/sites/${site.name}/start).` : `Le site « ${site.name} » démarre, réessayez dans quelques secondes.`);
        }
        forward(site, req, res, `/site/${encodeURIComponent(site.name)}/api/v1/${service}`);
    }));

    app.use(h(req => {
        throw notFound('unknown_service', `Service inconnu : ${req.method} /api/v1${req.path}`);
    }));
    return app;
}

/** site in the API: site_id = name of the site */
function siteData(info) {
    return {
        site_id: info.name,
        state: info.running ? 'running' : info.stopped ? 'stopped' : 'starting',
        port: info.port,
        created: info.created,
        url: info.url,
        editorUrl: info.editorUrl,
        api: `/api/v1/sites/${encodeURIComponent(info.name)}`,
        pages: info.pages || [],
        files: info.files || []
    };
}

/** forward the request to the API v1 of the instance of the site */
function forward(site, req, res, target) {
    const query = (req.originalUrl || req.url).split('?')[1];
    const headers = Object.assign({}, req.headers, { 'x-forwarded-for': req.socket.remoteAddress });
    let data = null;
    if (req._body) {
        // body already read by FUXA: sent again in JSON
        data = Buffer.from(JSON.stringify(req.body || {}));
        headers['content-type'] = 'application/json';
        headers['content-length'] = data.length;
        delete headers['transfer-encoding'];
    }
    const proxy = http.request({ host: '127.0.0.1', port: site.port, method: req.method, path: target + (query ? `?${query}` : ''), headers }, proxyRes => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
    });
    proxy.setTimeout(120000, () => proxy.destroy(new Error('timeout')));
    proxy.on('error', () => sendError(res, new ApiError(502, 'site_unavailable', `Le site « ${site.name} » ne répond pas.`)));
    if (data) {
        proxy.end(data);
    } else {
        req.pipe(proxy);
    }
}

module.exports = {
    router: router
};
