/**
 * custom-SCADA: source of the history of the tags of a site
 *
 * - 'fuxa' (default): recording (DAQ) of FUXA, in its database (SQLite)
 * - 'postgres': a PostgreSQL database chosen by the user (like a connection), read only:
 *   one table with a column for the tag, a column for the date/time and a column for the value
 *
 * The configuration is in the folder of the site (_appdata/history-db.json), the password never leaves the server.
 * The names of the table and columns are accepted only if they exist in the database (no SQL injection).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = 'history-db.json';
const MAX_ROWS = 200000;
const TIMEOUT = 8000;
/** types of the date/time column, the numeric columns are epoch in ms or s (timeUnit) */
const DATE_TYPES = ['timestamp without time zone', 'timestamp with time zone', 'date'];
const NUMBER_TYPES = ['bigint', 'integer', 'smallint', 'numeric', 'double precision', 'real'];

const DEFAULT_CONFIG = {
    source: 'fuxa',
    host: '', port: 5432, database: '', user: '', password: '', ssl: false,
    table: '', tagColumn: '', timeColumn: '', valueColumn: '',
    /** the value of the tag column is the name, the address or the id of the FUXA tag */
    tagMatch: 'name',
    /** for a numeric date/time column: 'ms' or 's' */
    timeUnit: 'ms',
    /** time zone of the dates without time zone: 'local' (time of the server of FUXA) or 'UTC' */
    timeZone: 'local',
    /** optional: only the rows of this site (column = value) */
    siteColumn: '', siteValue: ''
};

function create(runtime, settings) {
    const file = path.join(path.dirname(settings.workDir), '_appdata', CONFIG_FILE);
    let config = readConfig(file);
    let pool = null;

    const getPool = () => {
        if (!pool) {
            pool = newPool(config);
        }
        return pool;
    };

    const source = {
        get type() { return config.source; },
        get label() {
            return config.source === 'postgres'
                ? `PostgreSQL ${config.host}:${config.port}/${config.database} (${config.table})`
                : 'FUXA (enregistrement DAQ, SQLite)';
        },
        /** configuration without the password */
        getConfig: () => publicConfig(config),
        /**
         * check and save a new configuration
         * an empty password keeps the saved password (it is never sent to the browser)
         */
        setConfig: async (input) => {
            const next = normalize(Object.assign({}, config, input || {}));
            if (!input || input.password === undefined || input.password === '') {
                next.password = config.password;
            }
            if (next.source === 'postgres') {
                await checkTable(next);
            }
            config = next;
            fs.writeFileSync(file, JSON.stringify(config, null, 2));
            if (pool) {
                pool.end().catch(() => {});
                pool = null;
            }
            return publicConfig(config);
        },
        /** connection test: list of the tables, and the columns of the table if given */
        test: async (input) => {
            const next = normalize(Object.assign({}, config, input || {}));
            if (!input || input.password === undefined || input.password === '') {
                next.password = config.password;
            }
            const client = newClient(next);
            try {
                await client.connect();
                const tables = await client.query(`SELECT table_schema, table_name FROM information_schema.tables
                    WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name`);
                const result = { ok: true, tables: tables.rows.map(r => r.table_schema === 'public' ? r.table_name : `${r.table_schema}.${r.table_name}`) };
                if (next.table) {
                    result.columns = await tableColumns(client, next.table);
                }
                return result;
            } finally {
                client.end().catch(() => {});
            }
        },
        /** values of the tag between from and to (ms), sorted by time: [{ t: ms, v: value }] */
        values: async (tag, from, to) => {
            if (config.source !== 'postgres') {
                const rows = await runtime.daqStorage.getNodeValues(tag.id, from, to);
                return (rows || []).map(row => ({ t: Number(row.dt), v: row.value })).sort((a, b) => a.t - b.t);
            }
            return postgresValues(getPool(), config, tag, from, to);
        }
    };
    return source;
}

async function postgresValues(pool, config, tag, from, to) {
    const client = await pool.connect();
    try {
        const columns = await tableColumns(client, config.table);
        const type = name => {
            const column = columns.find(c => c.name === name);
            if (!column) {
                throw new Error(`Colonne « ${name} » absente de la table ${config.table}`);
            }
            return column.type;
        };
        [config.tagColumn, config.valueColumn].forEach(type);
        const timeType = type(config.timeColumn);
        const time = quote(config.timeColumn);
        let timeSelect, timeWhere;
        if (DATE_TYPES.includes(timeType)) {
            // the dates without time zone are in the time zone of the configuration (TimeZone of the connection)
            timeSelect = `EXTRACT(EPOCH FROM ${time}::timestamptz) * 1000`;
            timeWhere = `${time} BETWEEN to_timestamp($2::double precision / 1000) AND to_timestamp($3::double precision / 1000)`;
        } else if (NUMBER_TYPES.includes(timeType)) {
            const factor = config.timeUnit === 's' ? 1000 : 1;
            timeSelect = `${time}::double precision * ${factor}`;
            timeWhere = `${time} BETWEEN $2::double precision / ${factor} AND $3::double precision / ${factor}`;
        } else {
            throw new Error(`Type de la colonne date/heure non pris en charge : ${timeType}`);
        }
        const params = [tagKey(tag, config.tagMatch), from, to];
        let siteWhere = '';
        if (config.siteColumn) {
            type(config.siteColumn);
            params.push(config.siteValue);
            siteWhere = ` AND ${quote(config.siteColumn)}::text = $4`;
        }
        const sql = `SELECT ${timeSelect} AS t, ${quote(config.valueColumn)} AS v FROM ${quoteTable(config.table)}
            WHERE ${quote(config.tagColumn)}::text = $1 AND ${timeWhere}${siteWhere} ORDER BY ${time} LIMIT ${MAX_ROWS}`;
        const result = await client.query(sql, params);
        return result.rows.map(row => ({ t: Number(row.t), v: typeof row.v === 'string' && row.v.trim() !== '' && !isNaN(Number(row.v)) ? Number(row.v) : row.v }));
    } finally {
        client.release();
    }
}

/** the table and the 3 columns must exist (checked in the database) */
async function checkTable(config) {
    ['host', 'database', 'user', 'table', 'tagColumn', 'timeColumn', 'valueColumn'].forEach(key => {
        if (!config[key]) {
            throw userError(`Champ obligatoire manquant : ${key}`);
        }
    });
    const client = newClient(config);
    try {
        await client.connect();
        const columns = await tableColumns(client, config.table);
        if (!columns.length) {
            throw userError(`Table introuvable : ${config.table}`);
        }
        const names = columns.map(c => c.name);
        [config.tagColumn, config.timeColumn, config.valueColumn, config.siteColumn].filter(c => c).forEach(name => {
            if (!names.includes(name)) {
                throw userError(`Colonne introuvable dans ${config.table} : ${name}`);
            }
        });
        const timeType = columns.find(c => c.name === config.timeColumn).type;
        if (!DATE_TYPES.includes(timeType) && !NUMBER_TYPES.includes(timeType)) {
            throw userError(`La colonne date/heure doit être une date ou un nombre (type actuel : ${timeType})`);
        }
    } catch (err) {
        throw err.status ? err : userError(`Connexion impossible : ${err.message}`);
    } finally {
        client.end().catch(() => {});
    }
}

async function tableColumns(client, table) {
    const [schema, name] = splitTable(table);
    const result = await client.query(`SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, [schema, name]);
    return result.rows.map(r => ({ name: r.column_name, type: r.data_type }));
}

function splitTable(table) {
    const parts = String(table || '').split('.');
    return parts.length > 1 ? [parts[0], parts.slice(1).join('.')] : ['public', parts[0]];
}

/** "name" with the " doubled: used only with names checked in information_schema */
function quote(name) {
    return '"' + String(name).replace(/"/g, '""') + '"';
}

function quoteTable(table) {
    const [schema, name] = splitTable(table);
    return `${quote(schema)}.${quote(name)}`;
}

function tagKey(tag, match) {
    if (match === 'address') {
        return tag.address || '';
    }
    return match === 'id' ? tag.id : tag.name;
}

function clientConfig(config) {
    return {
        host: config.host, port: Number(config.port) || 5432, database: config.database,
        user: config.user, password: config.password, ssl: config.ssl ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: TIMEOUT, query_timeout: 30000, application_name: 'custom-SCADA (FUXA)',
        options: `-c TimeZone=${config.timeZone === 'UTC' ? 'UTC' : (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')} -c default_transaction_read_only=on`
    };
}

function newClient(config) {
    const { Client } = require('pg');
    return new Client(clientConfig(config));
}

function newPool(config) {
    const { Pool } = require('pg');
    const pool = new Pool(Object.assign(clientConfig(config), { max: 3, idleTimeoutMillis: 60000 }));
    pool.on('error', () => {});
    return pool;
}

function normalize(config) {
    const result = Object.assign({}, DEFAULT_CONFIG);
    Object.keys(DEFAULT_CONFIG).forEach(key => {
        if (config[key] !== undefined && config[key] !== null) {
            result[key] = typeof DEFAULT_CONFIG[key] === 'boolean' ? !!config[key]
                : typeof DEFAULT_CONFIG[key] === 'number' ? Number(config[key]) || DEFAULT_CONFIG[key]
                : String(config[key]).trim();
        }
    });
    result.password = config.password !== undefined && config.password !== null ? String(config.password) : '';
    result.source = result.source === 'postgres' ? 'postgres' : 'fuxa';
    result.tagMatch = ['name', 'address', 'id'].includes(result.tagMatch) ? result.tagMatch : 'name';
    result.timeUnit = result.timeUnit === 's' ? 's' : 'ms';
    result.timeZone = result.timeZone === 'UTC' ? 'UTC' : 'local';
    return result;
}

function publicConfig(config) {
    const result = Object.assign({}, config, { hasPassword: !!config.password });
    delete result.password;
    return result;
}

function readConfig(file) {
    try {
        return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (err) {
        return normalize({});
    }
}

function userError(message) {
    const err = new Error(message);
    err.status = 400;
    return err;
}

module.exports = {
    create: create
};
