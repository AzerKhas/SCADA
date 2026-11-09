/**
 * custom-SCADA: source of the history of the tags of a site
 *
 * - 'fuxa' (default): recording (DAQ) of FUXA, in its database (SQLite)
 * - the PostgreSQL database of the company will be added here as a second source,
 *   with the same function: values(tag, from, to) -> [{ t: ms, v: value }]
 */

'use strict';

const SOURCES = {
    fuxa: {
        label: 'FUXA (enregistrement DAQ, SQLite)',
        values: (runtime, tag, from, to) => runtime.daqStorage.getNodeValues(tag.id, from, to)
            .then(rows => (rows || []).map(row => ({ t: Number(row.dt), v: row.value })))
    }
};

function create(runtime, config) {
    const type = (config && config.type) || 'fuxa';
    const source = SOURCES[type] || SOURCES.fuxa;
    return {
        type: SOURCES[type] ? type : 'fuxa',
        label: source.label,
        /** values of the tag between from and to (ms), sorted by time */
        values: (tag, from, to) => source.values(runtime, tag, from, to).then(values => values.sort((a, b) => a.t - b.t))
    };
}

module.exports = {
    create: create
};
