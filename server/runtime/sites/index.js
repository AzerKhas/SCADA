/**
 * custom-SCADA: multi-sites manager (runs only in the main FUXA, not in the instances of the sites)
 *
 * - each site has its own folder sites/<name>/ used as userDir of its own FUXA instance
 *   (own project, connections, tags and database), started on an internal port with BASE_PATH=/site/<name>
 * - http://server:1881/site/<name>/ is forwarded to the instance of the site (http and websocket)
 * - /api/sites (and /site/<name>/api/sites, called by the editor of a site) lists and creates the sites
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const siteTemplate = require('./template');

const SITE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const SITE_URL = /^\/site\/([^/?#]+)(\/.*)?$/;
const SITE_FILE = 'site.json';
/** time to wait for a new instance before sending its first project */
const START_TIMEOUT = 60000;

var settings;
var logger;
var sitesDir;
var authJwt;
const sites = {};       // name: { name, port, created, process, running }

/**
 * @param app express app of the main FUXA
 * @param server http(s) server of the main FUXA (for the websocket upgrade)
 */
function init(app, server, _settings, _logger) {
    settings = _settings;
    logger = _logger;
    sitesDir = path.resolve(path.dirname(settings.workDir), 'sites');
    authJwt = require('../../api/jwt-helper');
    if (!fs.existsSync(sitesDir)) {
        fs.mkdirSync(sitesDir);
    }
    loadSites();
    app.use(onRequest);
    server.on('upgrade', onUpgrade);
    process.on('exit', stopAll);
    Object.values(sites).forEach(site => start(site));
}

function loadSites() {
    fs.readdirSync(sitesDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).forEach(entry => {
        const file = path.join(sitesDir, entry.name, SITE_FILE);
        try {
            const site = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (site.name === entry.name && SITE_NAME.test(site.name)) {
                sites[site.name] = { name: site.name, port: site.port, created: site.created };
            }
        } catch (err) {
            logger.warn(`sites: '${entry.name}' ignored (${SITE_FILE} missing or invalid)`);
        }
    });
}

/** /api/sites, /site/<name>/api/sites and the forwarding of /site/<name>/... */
function onRequest(req, res, next) {
    const url = req.originalUrl || req.url;
    const match = url.match(SITE_URL);
    const rest = match ? (match[2] || '') : url;
    if (rest === '/api/sites' || rest.startsWith('/api/sites?')) {
        return apiSites(req, res);
    }
    if (!match) {
        return next();
    }
    const site = sites[decodeURIComponent(match[1])];
    if (!site) {
        return sendPage(res, 404, 'Site inconnu', `Le site « ${escapeHtml(decodeURIComponent(match[1]))} » n'existe pas.`);
    }
    if (!match[2]) {
        // the base href of the site needs the final /
        return res.redirect(301, url.replace(/^\/site\/[^/?#]+/, `/site/${encodeURIComponent(site.name)}/`));
    }
    forward(site, req, res);
}

function apiSites(req, res) {
    const check = settings.secureEnabled ? authJwt.requireAuth : (rq, rs, next) => next();
    check(req, res, () => {
        if (req.method === 'GET') {
            listSites().then(result => res.json(result)).catch(err => res.status(500).json({ error: 'sites_error', message: err.toString() }));
        } else if (req.method === 'POST') {
            readBody(req).then(body => createSite(body && body.name)).then(site => {
                res.json(siteInfo(site));
            }).catch(err => {
                res.status(err.status || 500).json({ error: err.code || 'sites_error', message: err.message || err.toString() });
            });
        } else {
            res.status(405).end();
        }
    });
}

async function listSites() {
    const result = [];
    for (const site of Object.values(sites).sort((a, b) => a.name.localeCompare(b.name))) {
        const info = siteInfo(site);
        info.pages = site.running ? await getPages(site).catch(() => []) : [];
        result.push(info);
    }
    return result;
}

function siteInfo(site) {
    const base = `/site/${encodeURIComponent(site.name)}`;
    return {
        name: site.name,
        port: site.port,
        created: site.created,
        running: !!site.running,
        url: base + '/',
        editorUrl: base + '/editor',
        labUrl: base + '/lab',
        pages: []
    };
}

/** views of the project of the site (pages shown under the site in the editor) */
function getPages(site) {
    return requestSite(site, 'GET', '/api/project').then(project => {
        const views = (project && project.hmi && project.hmi.views) || [];
        return views.map(view => ({ id: view.id, name: view.name }));
    });
}

async function createSite(name) {
    name = (name || '').trim();
    if (!SITE_NAME.test(name)) {
        throw httpError(400, 'invalid_name', 'Nom invalide : lettres, chiffres, - et _ (40 caractères au plus), sans espace.');
    }
    if (Object.keys(sites).some(key => key.toLowerCase() === name.toLowerCase())) {
        throw httpError(409, 'site_exists', `Le site « ${name} » existe déjà.`);
    }
    const dir = path.join(sitesDir, name);
    fs.mkdirSync(dir, { recursive: true });
    const site = { name, port: await freePort(), created: new Date().toISOString() };
    fs.writeFileSync(path.join(dir, SITE_FILE), JSON.stringify({ name: site.name, port: site.port, created: site.created }, null, 2));
    sites[name] = site;
    start(site);
    await waitRunning(site);
    await requestSite(site, 'POST', '/api/project', siteTemplate.create(name, settings.appDir));
    logger.info(`sites: '${name}' created on port ${site.port}`);
    return site;
}

/** start the FUXA instance of the site, restarted if it stops */
function start(site) {
    const dir = path.join(sitesDir, site.name);
    const log = fs.openSync(path.join(dir, 'site.log'), 'a');
    const child = spawn(process.execPath, [path.join(settings.appDir, 'main.js'), '--userDir', dir, '--port', String(site.port)], {
        cwd: settings.appDir,
        env: Object.assign({}, process.env, {
            BASE_PATH: `/site/${site.name}`,
            FUXA_SITE: site.name,
            // the plugins (S7, OPC UA...) installed in the main FUXA are used by all the sites
            FUXA_PACKAGE_DIR: settings.packageDir
        }),
        stdio: ['ignore', log, log],
        windowsHide: true
    });
    site.process = child;
    site.running = false;
    fs.closeSync(log);
    waitRunning(site).then(() => logger.info(`sites: '${site.name}' running on port ${site.port}`)).catch(() => {});
    child.on('exit', code => {
        site.running = false;
        if (site.process === child && !site.stopping) {
            logger.warn(`sites: '${site.name}' stopped (code ${code}), restart in 5 s`);
            setTimeout(() => start(site), 5000);
        }
    });
}

function stopAll() {
    Object.values(sites).forEach(site => {
        site.stopping = true;
        if (site.process && !site.process.killed) {
            site.process.kill();
        }
    });
}

/** resolve when the instance of the site answers */
function waitRunning(site) {
    const end = Date.now() + START_TIMEOUT;
    return new Promise((resolve, reject) => {
        const check = () => {
            requestSite(site, 'GET', '/api/version').then(() => {
                site.running = true;
                resolve();
            }).catch(() => {
                if (Date.now() > end || !site.process || site.process.exitCode !== null) {
                    reject(httpError(500, 'site_not_started', `Le site « ${site.name} » n'a pas démarré (voir sites/${site.name}/site.log).`));
                } else {
                    setTimeout(check, 1000);
                }
            });
        };
        check();
    });
}

/** call the api of the instance of a site */
function requestSite(site, method, apiPath, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({
            host: '127.0.0.1', port: site.port, method,
            path: `/site/${encodeURIComponent(site.name)}${apiPath}`,
            headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
        }, res => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', chunk => text += chunk);
            res.on('end', () => {
                if (res.statusCode >= 400) {
                    return reject(new Error(`${res.statusCode} ${text}`));
                }
                try {
                    resolve(text ? JSON.parse(text) : null);
                } catch (err) {
                    resolve(text);
                }
            });
        });
        req.setTimeout(10000, () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        if (data) {
            req.write(data);
        }
        req.end();
    });
}

/** forward an http request to the instance of the site (the path keeps /site/<name>, it is the BASE_PATH of the instance) */
function forward(site, req, res) {
    if (!site.running) {
        return sendPage(res, 503, 'Site en démarrage', `Le site « ${escapeHtml(site.name)} » démarre, réessayez dans quelques secondes.`);
    }
    const proxy = http.request({
        host: '127.0.0.1', port: site.port, method: req.method, path: req.originalUrl || req.url,
        headers: Object.assign({}, req.headers, { 'x-forwarded-for': req.socket.remoteAddress })
    }, proxyRes => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
    });
    proxy.on('error', () => {
        if (!res.headersSent) {
            sendPage(res, 502, 'Site indisponible', `Le site « ${escapeHtml(site.name)} » ne répond pas.`);
        } else {
            res.end();
        }
    });
    req.pipe(proxy);
}

/** websocket (socket.io) of the pages of a site */
function onUpgrade(req, socket, head) {
    const match = (req.url || '').match(SITE_URL);
    const site = match ? sites[decodeURIComponent(match[1])] : null;
    if (!site) {
        return;     // not a site: handled by the socket.io of the main FUXA
    }
    const target = net.connect(site.port, '127.0.0.1', () => {
        let headers = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
            headers += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
        }
        target.write(headers + '\r\n');
        if (head && head.length) {
            target.write(head);
        }
        target.pipe(socket);
        socket.pipe(target);
    });
    target.on('error', () => socket.destroy());
    socket.on('error', () => target.destroy());
}

/** first free port after the ports of the existing sites */
async function freePort() {
    const used = Object.values(sites).map(site => site.port);
    let port = Number(settings.sitesBasePort) || (Number(settings.uiPort) || 1881) + 100;
    while (used.includes(port) || !(await isPortFree(port))) {
        port++;
    }
    return port;
}

function isPortFree(port) {
    return new Promise(resolve => {
        const tester = net.createServer().once('error', () => resolve(false)).once('listening', () => tester.close(() => resolve(true)));
        tester.listen(port, '0.0.0.0');
    });
}

function readBody(req) {
    if (req.body && Object.keys(req.body).length) {
        return Promise.resolve(req.body);
    }
    return new Promise((resolve, reject) => {
        let text = '';
        req.setEncoding('utf8');
        req.on('data', chunk => {
            text += chunk;
            if (text.length > 10000) {
                req.destroy();
            }
        });
        req.on('end', () => {
            try {
                resolve(text ? JSON.parse(text) : {});
            } catch (err) {
                reject(httpError(400, 'invalid_body', 'Corps de requête invalide.'));
            }
        });
        req.on('error', reject);
    });
}

function httpError(status, code, message) {
    const err = new Error(message);
    err.status = status;
    err.code = code;
    return err;
}

function sendPage(res, status, title, text) {
    res.status(status).type('html').send(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title></head>` +
        `<body style="font-family:sans-serif;padding:40px"><h2>${title}</h2><p>${text}</p><p><a href="/editor">Retour à l'éditeur</a></p></body></html>`);
}

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

module.exports = {
    init: init
};
