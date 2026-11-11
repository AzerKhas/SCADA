/**
 * custom-SCADA: small ZIP writer and reader (deflate of node zlib, no other module)
 * used for the export / import of a site folder and for the Excel files (an .xlsx file is a ZIP of XML files)
 */

'use strict';

const zlib = require('zlib');

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c;
    }
    return table;
})();

function crc32(buffer) {
    let crc = -1;
    for (let i = 0; i < buffer.length; i++) {
        crc = CRC_TABLE[(crc ^ buffer[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ -1) >>> 0;
}

/** date and time of a ZIP entry (MS-DOS format, local time) */
function dosTime(date) {
    return {
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
        date: ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
}

/**
 * @param entries [{ name: 'dossier/fichier.ext', data: Buffer | string, date?: Date }]
 * @returns Buffer of the ZIP file
 */
function create(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    entries.forEach(entry => {
        const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
        const name = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
        const deflated = zlib.deflateRawSync(data);
        // stored when the deflate does not reduce the size (images, files already compressed)
        const stored = deflated.length >= data.length;
        const content = stored ? data : deflated;
        const crc = crc32(data);
        const { time, date } = dosTime(entry.date || new Date());
        if (offset + content.length > 0xFFFFFFFF || data.length > 0xFFFFFFFF) {
            throw new Error('ZIP trop volumineux (4 Go au plus)');
        }
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);              // version needed
        local.writeUInt16LE(0x0800, 6);          // flag: names in UTF-8
        local.writeUInt16LE(stored ? 0 : 8, 8);  // method
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(content.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        locals.push(local, name, content);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);            // version made by
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(stored ? 0 : 8, 10);
        central.writeUInt16LE(time, 12);
        central.writeUInt16LE(date, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(content.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);
        offset += local.length + name.length + content.length;
    });
    const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, ...centrals, end]);
}

/**
 * entries of a ZIP file (from its central directory)
 * @returns [{ name, data: Buffer }] (folders are not returned)
 */
function read(buffer) {
    let end = -1;
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xFFFF); i--) {
        if (buffer.readUInt32LE(i) === 0x06054b50) {
            end = i;
            break;
        }
    }
    if (end < 0) {
        throw new Error('Fichier ZIP invalide');
    }
    const count = buffer.readUInt16LE(end + 10);
    let pos = buffer.readUInt32LE(end + 16);
    const result = [];
    for (let i = 0; i < count; i++) {
        if (buffer.readUInt32LE(pos) !== 0x02014b50) {
            throw new Error('Fichier ZIP invalide (répertoire)');
        }
        const flags = buffer.readUInt16LE(pos + 8);
        const method = buffer.readUInt16LE(pos + 10);
        const compressedSize = buffer.readUInt32LE(pos + 20);
        const nameLength = buffer.readUInt16LE(pos + 28);
        const extraLength = buffer.readUInt16LE(pos + 30);
        const commentLength = buffer.readUInt16LE(pos + 32);
        const localOffset = buffer.readUInt32LE(pos + 42);
        const nameBytes = buffer.slice(pos + 46, pos + 46 + nameLength);
        const name = (flags & 0x0800 ? nameBytes.toString('utf8') : nameBytes.toString('latin1')).replace(/\\/g, '/');
        pos += 46 + nameLength + extraLength + commentLength;
        if (name.endsWith('/')) {
            continue;
        }
        if (flags & 0x0001) {
            throw new Error(`Fichier chiffré non pris en charge : ${name}`);
        }
        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + localNameLength + localExtraLength;
        const content = buffer.slice(start, start + compressedSize);
        let data;
        if (method === 0) {
            data = Buffer.from(content);
        } else if (method === 8) {
            data = zlib.inflateRawSync(content);
        } else {
            throw new Error(`Méthode de compression non prise en charge (${method}) : ${name}`);
        }
        result.push({ name, data });
    }
    return result;
}

module.exports = {
    create: create,
    read: read
};
