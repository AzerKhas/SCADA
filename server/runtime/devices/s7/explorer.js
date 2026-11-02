/**
 * custom-SCADA: explore a Siemens S7 PLC (S7-1200 / S7-1200 G2) with snap7, to create tags from what the PLC contains
 * - 'list': data blocks (DB) found in the PLC with their size, and the M / I / Q areas
 * - 'read': bytes of a DB or of an area, to see the values before naming a tag
 * A separate snap7 connection is used, so the polling of the tags is not disturbed.
 * The DB size is found by reading single bytes (the S7-1200 G2 does not support the block-info service, error 0x8104).
 * Optimized DBs cannot be read with PUT/GET: "Optimized block access" must be unchecked in TIA Portal.
 */

const AREA_SIZES = { M: 256, I: 128, Q: 128 };
const PROBE_MAX = 200;
const DB_SIZE_CAP = 65536;
const READ_MAX = 512;

function browse(snap7, data, node) {
    const request = node || {};
    const client = new snap7.S7Client();
    const rack = parseInt(data.property?.rack, 10);
    const slot = parseInt(data.property?.slot, 10);
    const errorText = (err) => (typeof err === 'number' ? client.ErrorText(err) : String(err));
    const call = (fnc, ...args) => new Promise((resolve, reject) => {
        fnc.call(client, ...args, (err, res) => err ? reject(errorText(err)) : resolve(res));
    });
    const canRead = (dbNumber, start) => call(client.DBRead, dbNumber, start, 1).then(() => true).catch(() => false);

    const dbSize = async (dbNumber) => {
        if (!(await canRead(dbNumber, 0))) {
            return 0;
        }
        let lo = 1, hi = 2;     // size >= lo, size < hi
        while (hi <= DB_SIZE_CAP && (await canRead(dbNumber, hi - 1))) {
            lo = hi;
            hi *= 2;
        }
        while (hi - lo > 1) {
            const mid = Math.floor((lo + hi) / 2);
            if (await canRead(dbNumber, mid - 1)) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        return lo;
    };

    const listDbs = async () => {
        try {
            const blocks = await call(client.ListBlocksOfType, client.Block_DB !== undefined ? client.Block_DB : 0x41);
            const numbers = (blocks || []).map(n => Number(n)).filter(n => n > 0);
            if (numbers.length) {
                return numbers.sort((a, b) => a - b);
            }
        } catch (err) {
            // block listing not allowed: probe the DB numbers
        }
        const found = [];
        for (let n = 1; n <= PROBE_MAX; n++) {
            if (await canRead(n, 0)) {
                found.push(n);
            }
        }
        return found;
    };

    const readArea = (area, dbNumber, start, size) => {
        if (area === 'DB') {
            return call(client.DBRead, dbNumber, start, size);
        }
        const areaCode = { M: client.S7AreaMK, I: client.S7AreaPE, Q: client.S7AreaPA }[area];
        return call(client.ReadArea, areaCode, 0, start, size, client.S7WLByte);
    };

    return new Promise((resolve, reject) => {
        if (!data.property?.address || !(rack >= 0) || !(slot >= 0)) {
            reject('Missing PLC address, rack or slot');
            return;
        }
        client.ConnectTo(data.property.address, rack, slot, async (err) => {
            if (err) {
                reject(`Connection to ${data.property.address} failed: ${errorText(err)}`);
                return;
            }
            try {
                if (request.cmd === 'read') {
                    const size = Math.min(Math.max(1, parseInt(request.size, 10) || 1), READ_MAX);
                    const start = Math.max(0, parseInt(request.start, 10) || 0);
                    const bytes = await readArea(request.area, parseInt(request.db, 10) || 0, start, size);
                    resolve({ cmd: 'read', area: request.area, db: request.db, start, bytes: Array.from(bytes || []) });
                } else {
                    const blocks = [];
                    for (const n of await listDbs()) {
                        blocks.push({ area: 'DB', db: n, size: await dbSize(n) });
                    }
                    for (const area of Object.keys(AREA_SIZES)) {
                        const readable = await readArea(area, 0, 0, 1).then(() => true).catch(() => false);
                        blocks.push({ area, db: 0, size: readable ? AREA_SIZES[area] : 0 });
                    }
                    resolve({ cmd: 'list', blocks });
                }
            } catch (e) {
                reject(String(e));
            } finally {
                try { client.Disconnect(); } catch (e) { }
            }
        });
    });
}

module.exports = { browse };
