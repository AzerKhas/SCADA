/**
 * custom-SCADA: multi-sites manager (runs only in the main FUXA, not in the instances of the sites)
 *
 * - each site has its own folder sites/<name>/ used as userDir of its own FUXA instance
 *   (own project, connections, tags and database), started on an internal port with BASE_PATH=/site/<name>
 * - http://server:1881/site/<name>/ is forwarded to the instance of the site (http and websocket)
 * - /api/sites (and /site/<name>/api/sites, called by the editor of a site) lists and creates the sites,
 *   /api/sites/<name>/stop|start|rename and DELETE /api/sites/<name> manage a site
 *   (a deleted site is moved to sites/_supprimes/, not erased)
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
/** files of a site written by its instance (files.js): /site/<name>/fichiers/accueil.html, site-api.js */
const FILE_URL = /^\/fichiers\/([a-z0-9-]+\.(?:html|js))(\?.*)?$/;
const PAGES_FILE = 'pages.json';
const SITES_API = /^\/api\/sites(?:\/([^/?#]+)(?:\/(stop|start|rename))?)?\/?(?:\?.*)?$/;
/** folder of the deleted sites (its name is not a valid site name, so it is not loaded) */
const DELETED_DIR = '_supprimes';
/** time to wait for the end of an instance before moving its folder */
const STOP_TIMEOUT = 15000;
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
    Object.values(sites).filter(site => !site.stopped).forEach(site => start(site));
}

function loadSites() {
    fs.readdirSync(sitesDir, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith('_')).forEach(entry => {
        const file = path.join(sitesDir, entry.name, SITE_FILE);
        try {
            const site = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (site.name === entry.name && SITE_NAME.test(site.name)) {
                sites[site.name] = { name: site.name, port: site.port, created: site.created, stopped: !!site.stopped };
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
    const api = rest.match(SITES_API);
    if (api) {
        return apiSites(req, res, api[1] ? decodeURIComponent(api[1]) : null, api[2]);
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
    const file = match[2].match(FILE_URL);
    if (file) {
        return sendSiteFile(site, decodeURIComponent(file[1]), res);
    }
    forward(site, req, res);
}

function apiSites(req, res, name, action) {
    const check = settings.secureEnabled ? authJwt.requireAuth : (rq, rs, next) => next();
    const fail = err => res.status(err.status || 500).json({ error: err.code || 'sites_error', message: err.message || err.toString() });
    check(req, res, () => {
        if (name) {
            const site = sites[name];
            if (!site) {
                return fail(httpError(404, 'site_not_found', `Le site « ${name} » n'existe pas.`));
            }
            let task = null;
            if (req.method === 'DELETE' && !action) {
                task = deleteSite(site).then(() => ({ deleted: site.name }));
            } else if (req.method === 'POST' && action === 'stop') {
                task = stopSite(site).then(() => siteInfo(site));
            } else if (req.method === 'POST' && action === 'start') {
                task = startSite(site).then(() => siteInfo(site));
            } else if (req.method === 'POST' && action === 'rename') {
                task = readBody(req).then(body => renameSite(site, body && body.name)).then(renamed => siteInfo(renamed));
            }
            return task ? task.then(result => res.json(result)).catch(fail) : res.status(405).end();
        }
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
        stopped: !!site.stopped,
        url: base + '/',
        editorUrl: base + '/editor',
        labUrl: base + '/lab',
        pages: [],
        files: siteFiles(site).map(f => ({ file: f.file, page: f.page, viewId: f.viewId, url: `${base}/fichiers/${f.file}` }))
    };
}

/** HTML files of the site (list written by its instance after each save) */
function siteFiles(site) {
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(sitesDir, site.name, PAGES_FILE), 'utf8'));
        return (manifest.files || []).filter(f => FILE_URL.test(`/fichiers/${f.file}`));
    } catch (err) {
        return [];
    }
}

function sendSiteFile(site, file, res) {
    if (!siteFiles(site).some(f => f.file === file)) {
        return sendPage(res, 404, 'Fichier introuvable', `Le fichier « ${escapeHtml(file)} » n'existe pas dans le site « ${escapeHtml(site.name)} ».`);
    }
    res.type(file.endsWith('.js') ? 'application/javascript' : 'html').sendFile(path.join(sitesDir, site.name, file));
}

/** views of the project of the site (pages shown under the site in the editor) */
function getPages(site) {
    return requestSite(site, 'GET', '/api/project').then(project => {
        const views = (project && project.hmi && project.hmi.views) || [];
        // in the order of the menu of the site, then the pages that are not in the menu
        const items = (project.hmi.layout && project.hmi.layout.navigation && project.hmi.layout.navigation.items) || [];
        const menu = items.map(item => item.view);
        const rank = id => menu.indexOf(id) < 0 ? menu.length : menu.indexOf(id);
        return views.map((view, index) => ({ id: view.id, name: view.name, index }))
            .sort((a, b) => rank(a.id) - rank(b.id) || a.index - b.index)
            .map(page => ({ id: page.id, name: page.name }));
    });
}

async function createSite(name) {
    name = validateNewName(name);
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

/** valid name, not used by another site (current: name of the site renamed) */
function validateNewName(name, current) {
    name = (name || '').trim();
    if (!SITE_NAME.test(name)) {
        throw httpError(400, 'invalid_name', 'Nom invalide : lettres, chiffres, - et _ (40 caractères au plus), sans espace.');
    }
    const lower = name.toLowerCase();
    if (Object.keys(sites).some(key => key !== current && key.toLowerCase() === lower) ||
        (lower !== (current || '').toLowerCase() && fs.existsSync(path.join(sitesDir, name)))) {
        throw httpError(409, 'site_exists', `Le site « ${name} » existe déjà.`);
    }
    return name;
}

function writeSiteFile(site) {
    fs.writeFileSync(path.join(sitesDir, site.name, SITE_FILE),
        JSON.stringify({ name: site.name, port: site.port, created: site.created, stopped: !!site.stopped }, null, 2));
}

/** stop the instance of the site (it stays stopped, also after a restart of FUXA) */
async function stopSite(site) {
    site.stopped = true;
    writeSiteFile(site);
    await stopProcess(site);
    logger.info(`sites: '${site.name}' stopped`);
}

async function startSite(site) {
    site.stopped = false;
    writeSiteFile(site);
    if (!isAlive(site.process)) {
        start(site);
    }
    await waitRunning(site);
}

/** new name: new folder and new address /site/<new name>/ (the instance is restarted) */
async function renameSite(site, newName) {
    newName = validateNewName(newName, site.name);
    if (newName === site.name) {
        return site;
    }
    await stopProcess(site);
    await moveFolder(path.join(sitesDir, site.name), path.join(sitesDir, newName));
    delete sites[site.name];
    logger.info(`sites: '${site.name}' renamed '${newName}'`);
    site.name = newName;
    sites[newName] = site;
    writeSiteFile(site);
    if (!site.stopped) {
        start(site);
        await waitRunning(site);
    }
    return site;
}

/** the folder of the site is moved to sites/_supprimes/<name>_<date> (it can be restored by hand) */
async function deleteSite(site) {
    await stopProcess(site);
    const deletedDir = path.join(sitesDir, DELETED_DIR);
    if (!fs.existsSync(deletedDir)) {
        fs.mkdirSync(deletedDir);
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
    await moveFolder(path.join(sitesDir, site.name), path.join(deletedDir, `${site.name}_${stamp}`));
    delete sites[site.name];
    logger.info(`sites: '${site.name}' deleted (moved to ${DELETED_DIR})`);
}

/** a killed process has a signalCode and no exitCode (Windows too) */
function isAlive(child) {
    return !!child && child.exitCode === null && child.signalCode === null;
}

/** stop the instance and wait its end (its files must be closed before moving the folder) */
function stopProcess(site) {
    site.stopping = true;
    site.running = false;
    const child = site.process;
    if (!isAlive(child)) {
        return Promise.resolve();
    }
    return new Promise(resolve => {
        const timer = setTimeout(resolve, STOP_TIMEOUT);
        child.once('exit', () => {
            clearTimeout(timer);
            resolve();
        });
        child.kill();
    });
}

/** rename a folder, retried a few times on Windows while the files are still locked */
async function moveFolder(from, to) {
    for (let i = 0; ; i++) {
        try {
            fs.renameSync(from, to);
            return;
        } catch (err) {
            if (i >= 9) {
                throw httpError(500, 'move_failed', `Le dossier du site n'a pas pu être déplacé (${err.code || err.message}).`);
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
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
    site.stopping = false;
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
                if (Date.now() > end || !isAlive(site.process)) {
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
