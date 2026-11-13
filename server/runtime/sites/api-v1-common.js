/**
 * custom-SCADA: common parts of the API v1 (main FUXA and sites): format of the answers, errors and validation
 *
 * Success: { data: ..., meta: { ... } }          (HTTP 200, or 201 for a creation)
 * Error:   { error: { code, message, details } } (HTTP 400 invalid request, 401/403 access, 404 unknown,
 *                                                  409 conflict, 413 too large, 503 site not running, 500 server)
 */

'use strict';

class ApiError extends Error {
    constructor(status, code, message, details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

const badRequest = (message, details) => new ApiError(400, 'invalid_request', message, details);
const notFound = (code, message) => new ApiError(404, code, message);

function send(res, data, meta, status) {
    const body = { data };
    if (meta) {
        body.meta = meta;
    }
    res.status(status || 200).json(body);
}

function sendError(res, err, logger) {
    if (res.headersSent) {
        return res.end();
    }
    let status = Number(err && err.status) || 500;
    if (status < 400 || status > 599) {
        status = 500;
    }
    const body = {
        error: {
            code: (err && typeof err.code === 'string' && err.code) || (status === 404 ? 'not_found' : status === 400 ? 'invalid_request' : 'server_error'),
            message: (err && err.message) || String(err)
        }
    };
    if (err && err.details) {
        body.error.details = err.details;
    }
    if (status >= 500 && logger) {
        logger.error(`api v1: ${body.error.message}`);
    }
    res.status(status).json(body);
}

/** express handler: async function, errors sent with sendError */
function handle(fnc, logger) {
    return (req, res) => {
        Promise.resolve().then(() => fnc(req, res)).catch(err => sendError(res, err, logger));
    };
}

/** errors of express.json (invalid JSON, too large) in the format of the API */
function jsonErrors(err, req, res, next) {
    if (err && err.type === 'entity.parse.failed') {
        return sendError(res, badRequest('Corps de la requête invalide : JSON attendu.'));
    }
    if (err && err.type === 'entity.too.large') {
        return sendError(res, new ApiError(413, 'too_large', 'Corps de la requête trop volumineux.'));
    }
    next(err);
}

// ---------------------------------------------------------------- validation

/** date: ms or ISO text (2026-11-13T08:00), default value if missing */
function date(value, name, fallback) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }
    const num = Number(value);
    const time = Number.isFinite(num) ? num : Date.parse(value);
    if (!Number.isFinite(time)) {
        throw badRequest(`Paramètre ${name} invalide : date attendue (ms ou ISO, ex. 2026-11-13T08:00).`, { param: name, value });
    }
    return time;
}

/** integer between min and max, default value if missing */
function integer(value, name, min, max, fallback) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }
    const num = Number(value);
    if (!Number.isInteger(num) || num < min || num > max) {
        throw badRequest(`Paramètre ${name} invalide : entier entre ${min} et ${max} attendu.`, { param: name, value });
    }
    return num;
}

/** period from / to, checked (from < to, length max) */
function period(query, defaultLength, maxLength) {
    const to = date(query.to, 'to', Date.now());
    const from = date(query.from, 'from', to - defaultLength);
    if (from >= to) {
        throw badRequest('Période invalide : from doit être avant to.', { from, to });
    }
    if (to - from > maxLength) {
        throw badRequest(`Période trop longue (${Math.round(maxLength / 86400000)} jours au plus).`, { from, to });
    }
    return { from, to };
}

/** list a,b,c (query) or array (body) */
function list(value) {
    if (value === undefined || value === null || value === '') {
        return [];
    }
    return (Array.isArray(value) ? value : String(value).split(',')).map(v => String(v).trim()).filter(v => v);
}

/** body: object expected */
function body(req) {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        throw badRequest('Corps de la requête invalide : objet JSON attendu.');
    }
    return req.body;
}

module.exports = {
    ApiError,
    badRequest,
    notFound,
    send,
    sendError,
    handle,
    jsonErrors,
    date,
    integer,
    period,
    list,
    body
};
