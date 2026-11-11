/**
 * custom-SCADA: type of the chart of the page Courbes of a site (courbes.html)
 * - 'temps': the tags in function of the time (default)
 * - 'xy': the chosen tags (axis Y) in function of the value of another tag (axis X), for example current / pressure
 * kept in the folder of the site: _appdata/courbes-mode.json { mode, xTag }
 */

'use strict';

const fs = require('fs');
const path = require('path');

const FILE = 'courbes-mode.json';
const MODES = ['temps', 'xy'];

function file(settings) {
    return path.join(path.dirname(settings.workDir), '_appdata', FILE);
}

function get(settings) {
    try {
        const config = JSON.parse(fs.readFileSync(file(settings), 'utf8'));
        if (config.mode === 'xy' && config.xTag) {
            return { mode: 'xy', xTag: String(config.xTag) };
        }
    } catch (err) {
        // no file: chart in function of the time
    }
    return { mode: 'temps', xTag: null };
}

function set(settings, config) {
    const mode = MODES.includes(config && config.mode) ? config.mode : 'temps';
    const value = mode === 'xy' ? { mode, xTag: String(config.xTag) } : { mode, xTag: null };
    fs.writeFileSync(file(settings), JSON.stringify(value, null, 2));
    return value;
}

module.exports = {
    get: get,
    set: set
};
