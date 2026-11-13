/**
 * custom-SCADA: diagnostic of a site (runs in the FUXA instance of the site)
 *
 * - state of the communication of each equipment (connection of FUXA: connect-ok, connect-error, connect-off...),
 *   with the time of its last change; each change is kept in the journal
 * - last data received: time of the last value of each tag (and of each equipment)
 * - tags without update: last value older than max(60 s, 10 x polling of the equipment)
 * - communication errors: the errors and warnings written by FUXA in its log (drivers S7, OPC UA, Modbus...)
 * The journal (500 events at most) is kept in _appdata/diagnostic-journal.json (also after a restart of the site).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const JOURNAL_FILE = 'diagnostic-journal.json';
const MAX_EVENTS = 500;
const SAVE_DELAY = 10000;
const MIN_STALE = 60000;
const STATUS_TEXT = {
    'connect-ok': 'connecté', 'connect-error': 'erreur de communication', 'connect-failed': 'connexion impossible',
    'connect-off': 'déconnecté', 'connect-busy': 'connexion en cours', disabled: 'désactivé', unknown: 'inconnu'
};

var runtime;
var file;
var events = [];
var devices = {};       // id: { status, since }
var saveTimer = null;
var started = Date.now();

function init(_runtime, settings, logger) {
    runtime = _runtime;
    file = path.join(path.dirname(settings.workDir), '_appdata', JOURNAL_FILE);
    try {
        events = JSON.parse(fs.readFileSync(file, 'utf8')).events || [];
    } catch (err) {
        events = [];
    }
    add({ level: 'info', type: 'start', message: 'Démarrage du site' });
    // errors and warnings of FUXA (connections to the PLC and servers)
    ['error', 'warn'].forEach(level => {
        const original = logger[level].bind(logger);
        logger[level] = function (message) {
            try {
                add({ level: level === 'warn' ? 'warning' : 'error', type: 'log', message: String(message).slice(0, 500), device: deviceOf(String(message)) });
            } catch (err) {
                // the diagnostic must not stop the logger
            }
            return original.apply(null, arguments);
        };
    });
    // changes of the state of the connections
    if (runtime.events && runtime.events.on) {
        runtime.events.on('device-status:changed', event => check(event && event.id, event && event.status));
    }
    setInterval(() => check(), 5000);
}

function add(event) {
    events.push(Object.assign({ time: Date.now() }, event));
    if (events.length > MAX_EVENTS) {
        events = events.slice(events.length - MAX_EVENTS);
    }
    if (!saveTimer) {
        saveTimer = setTimeout(save, SAVE_DELAY);
    }
}

function save() {
    saveTimer = null;
    try {
        fs.writeFileSync(file, JSON.stringify({ events }, null, 1));
    } catch (err) {
        // folder not ready
    }
}

/** name of the equipment written in a message of the log ('Station S7' connect failed...) */
function deviceOf(message) {
    try {
        const list = runtime.project && runtime.project.getDevices ? Object.values(runtime.project.getDevices() || {}) : [];
        const found = list.find(d => d.name && message.includes(d.name));
        return found ? found.name : null;
    } catch (err) {
        return null;
    }
}

function statusOf(id) {
    const all = runtime.devices && runtime.devices.getDevicesStatus ? runtime.devices.getDevicesStatus() || {} : {};
    const value = all[id];
    return value ? String(value.status || value) : null;
}

/** state of the connections: a change is written in the journal */
function check(onlyId, newStatus) {
    let list = [];
    try {
        list = runtime.project && runtime.project.getDevices ? Object.values(runtime.project.getDevices() || {}) : [];
    } catch (err) {
        return;
    }
    list.filter(d => !onlyId || d.id === onlyId).forEach(device => {
        const status = device.enabled === false ? 'disabled' : (onlyId && newStatus ? newStatus : statusOf(device.id)) || 'unknown';
        const old = devices[device.id];
        if (!old) {
            devices[device.id] = { status, since: Date.now() };
            if (status !== 'connect-ok' && status !== 'disabled' && status !== 'unknown') {
                add({ level: 'error', type: 'status', device: device.name, status, message: `${device.name} : ${STATUS_TEXT[status] || status}` });
            }
            return;
        }
        if (old.status !== status) {
            add({
                level: status === 'connect-ok' || status === 'disabled' ? 'info' : 'error', type: 'status', device: device.name, status,
                message: `${device.name} : ${STATUS_TEXT[old.status] || old.status} → ${STATUS_TEXT[status] || status}`
            });
            devices[device.id] = { status, since: Date.now() };
        }
    });
}

/**
 * diagnostic of the site
 * @param project project of the site, tags: all the tags [{ id, name, deviceName }]
 */
function report(project) {
    check();
    const now = Date.now();
    const dayAgo = now - 24 * 3600 * 1000, hourAgo = now - 3600 * 1000;
    const result = { time: now, started, devices: [], tags: [] };
    Object.values(project.devices || {}).forEach(device => {
        const known = devices[device.id] || { status: device.enabled === false ? 'disabled' : statusOf(device.id) || 'unknown', since: started };
        const polling = Number(device.polling) || 1000;
        const limit = Math.max(MIN_STALE, polling * 10);
        let lastData = null, stale = 0, count = 0;
        Object.values(device.tags || {}).filter(t => !t.sysType).forEach(tag => {
            count++;
            const current = runtime.devices.getTagValue(tag.id, true);
            const time = current ? Number(current.timestamp || current.ts) || null : null;
            if (time && (!lastData || time > lastData)) {
                lastData = time;
            }
            const isStale = device.enabled !== false && (!time || now - time > limit);
            if (isStale) {
                stale++;
            }
            result.tags.push({
                id: tag.id, name: tag.name, device: device.name, address: tag.address || '', value: current ? current.value : null,
                lastUpdate: time, age: time ? now - time : null, limit, stale: isStale
            });
        });
        const deviceEvents = events.filter(e => e.device === device.name && e.level !== 'info');
        result.devices.push({
            id: device.id, name: device.name, type: device.type, enabled: device.enabled !== false, polling,
            status: known.status, statusText: STATUS_TEXT[known.status] || known.status, connected: known.status === 'connect-ok',
            since: known.since, lastData, tags: count, staleTags: stale,
            errors24h: deviceEvents.filter(e => e.time >= dayAgo).length,
            lastError: deviceEvents.length ? deviceEvents[deviceEvents.length - 1] : null
        });
    });
    const enabled = result.devices.filter(d => d.enabled);
    const errors1h = events.filter(e => e.time >= hourAgo && e.level === 'error').length;
    const staleTags = result.tags.filter(t => t.stale).length;
    const disconnected = enabled.filter(d => !d.connected).length;
    result.summary = {
        communication: disconnected ? 'error' : (staleTags || errors1h) ? 'warning' : 'ok',
        devices: { total: result.devices.length, enabled: enabled.length, connected: enabled.filter(d => d.connected).length, disconnected },
        lastData: result.devices.reduce((m, d) => (d.lastData && (!m || d.lastData > m) ? d.lastData : m), null),
        tags: result.tags.length,
        staleTags,
        errors1h,
        errors24h: events.filter(e => e.time >= dayAgo && e.level === 'error').length,
        warnings24h: events.filter(e => e.time >= dayAgo && e.level === 'warning').length
    };
    return result;
}

/** journal: newest first, filters { from, to, level, device } */
function journal(filters) {
    filters = filters || {};
    return events.filter(e => (!filters.from || e.time >= filters.from) && (!filters.to || e.time <= filters.to) &&
        (!filters.level || e.level === filters.level) && (!filters.device || e.device === filters.device)).slice().reverse();
}

module.exports = {
    init,
    report,
    journal,
    STATUS_TEXT
};
