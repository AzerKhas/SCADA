/**
 * custom-SCADA: export of curves to Excel (.xlsx) and PDF, written without other module
 * (used by the page Courbes of FUXA and by courbes.html of the sites)
 *
 * POST <base>/api/export/xlsx   { title, subtitle, fileName, tzOffset, series: [{ name, label, values: [{ t, v }] }] }
 * POST <base>/api/export/pdf    same body + image: 'data:image/jpeg;base64,...' (picture of the chart)
 *
 * tzOffset: Date.getTimezoneOffset() of the browser, the dates are written in the time of the user
 */

'use strict';

const express = require('express');
const zip = require('./zip');

/** more rows: average of the values by interval (Excel has at most 1 048 576 rows) */
const MAX_ROWS = 100000;
const BODY_LIMIT = '60mb';

function router(settings) {
    const app = express.Router();
    const authJwt = require('../../api/jwt-helper');
    app.use((req, res, next) => settings.secureEnabled ? authJwt.requireAuth(req, res, next) : next());
    app.use(express.json({ limit: BODY_LIMIT }));

    app.post('/xlsx', (req, res) => {
        try {
            const data = checkBody(req.body);
            send(res, xlsx(data), `${fileName(data)}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        } catch (err) {
            res.status(400).json({ error: 'export_error', message: err.message });
        }
    });

    app.post('/pdf', (req, res) => {
        try {
            const data = checkBody(req.body);
            send(res, pdf(data), `${fileName(data)}.pdf`, 'application/pdf');
        } catch (err) {
            res.status(400).json({ error: 'export_error', message: err.message });
        }
    });
    return app;
}

function send(res, buffer, name, type) {
    res.set({
        'Content-Type': type,
        'Content-Length': buffer.length,
        'Content-Disposition': `attachment; filename="${name.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`
    });
    res.end(buffer);
}

function checkBody(body) {
    if (!body || !Array.isArray(body.series)) {
        throw new Error('Données manquantes (series)');
    }
    const series = body.series.map((s, i) => ({
        label: String(s.label || s.name || `Courbe ${i + 1}`),
        values: (Array.isArray(s.values) ? s.values : [])
            .map(p => Array.isArray(p) ? { t: Number(p[0]), v: toNumber(p[1]) } : { t: Number(p && p.t), v: toNumber(p && p.v) })
            .filter(p => isFinite(p.t))
            .sort((a, b) => a.t - b.t)
    }));
    return {
        title: String(body.title || 'Courbes'),
        subtitle: String(body.subtitle || ''),
        fileName: body.fileName,
        tzOffset: Number(body.tzOffset) || 0,
        image: body.image,
        series
    };
}

function toNumber(value) {
    if (typeof value === 'boolean') {
        return value ? 1 : 0;
    }
    if (value === null || value === undefined || value === '') {
        return null;
    }
    const n = Number(value);
    return isFinite(n) ? n : null;
}

function fileName(data) {
    const base = String(data.fileName || data.title || 'courbes').normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
    return base || 'courbes';
}

/** min, max, average, first and last value of each series */
function stats(series) {
    return series.map(s => {
        const numbers = s.values.filter(p => p.v !== null);
        const result = { label: s.label, count: numbers.length, min: null, max: null, avg: null, first: null, last: null };
        if (numbers.length) {
            let sum = 0;
            result.min = Infinity;
            result.max = -Infinity;
            numbers.forEach(p => {
                result.min = Math.min(result.min, p.v);
                result.max = Math.max(result.max, p.v);
                sum += p.v;
            });
            result.avg = sum / numbers.length;
            result.first = numbers[0];
            result.last = numbers[numbers.length - 1];
        }
        return result;
    });
}

/**
 * one row per time with one column per series (all the values),
 * or the average by interval when there are too many rows
 */
function table(series) {
    const times = new Set();
    series.forEach(s => s.values.forEach(p => times.add(p.t)));
    if (times.size <= MAX_ROWS) {
        const rows = new Map([...times].sort((a, b) => a - b).map(t => [t, new Array(series.length).fill(null)]));
        series.forEach((s, i) => s.values.forEach(p => {
            rows.get(p.t)[i] = p.v;
        }));
        return { interval: 0, rows: [...rows.entries()] };
    }
    const from = Math.min(...series.map(s => s.values.length ? s.values[0].t : Infinity));
    const to = Math.max(...series.map(s => s.values.length ? s.values[s.values.length - 1].t : -Infinity));
    const interval = niceInterval((to - from) / MAX_ROWS);
    const buckets = new Map();
    series.forEach((s, i) => s.values.forEach(p => {
        if (p.v === null) {
            return;
        }
        const t = Math.floor(p.t / interval) * interval;
        let row = buckets.get(t);
        if (!row) {
            row = series.map(() => ({ sum: 0, n: 0 }));
            buckets.set(t, row);
        }
        row[i].sum += p.v;
        row[i].n++;
    }));
    const rows = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([t, row]) => [t, row.map(c => c.n ? c.sum / c.n : null)]);
    return { interval, rows };
}

/** interval of the averages: 1 s, 5 s, 10 s, 30 s, 1 min, 5 min... */
function niceInterval(ms) {
    const steps = [1, 5, 10, 30, 60, 300, 600, 1800, 3600, 7200, 21600, 43200, 86400].map(s => s * 1000);
    return steps.find(s => s >= ms) || Math.ceil(ms / 86400000) * 86400000;
}

function intervalText(ms) {
    return ms >= 3600000 ? `${ms / 3600000} h` : ms >= 60000 ? `${ms / 60000} min` : `${ms / 1000} s`;
}

/** date of the user (tzOffset of its browser) as text */
function dateText(t, tzOffset) {
    const d = new Date(t - tzOffset * 60000);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function numberText(value) {
    if (value === null || value === undefined) {
        return '';
    }
    const abs = Math.abs(value);
    const digits = abs >= 1000 ? 1 : abs >= 1 ? 3 : 4;
    return Number(value.toFixed(digits)).toLocaleString('fr-FR', { maximumFractionDigits: digits }).replace(/[  ]/g, ' ');
}

// ------------------------------------------------------------------ Excel

function xlsx(data) {
    const { interval, rows } = table(data.series);
    const sheetRows = [];
    sheetRows.push([{ text: data.title, style: 3 }]);
    if (data.subtitle) {
        sheetRows.push([{ text: data.subtitle }]);
    }
    if (interval) {
        sheetRows.push([{ text: `Valeurs moyennes par intervalle de ${intervalText(interval)} (période trop longue pour toutes les valeurs)` }]);
    }
    sheetRows.push([]);
    const headerRow = sheetRows.length + 1;
    sheetRows.push([{ text: 'Date / heure', style: 2 }, ...data.series.map(s => ({ text: s.label, style: 2 }))]);
    rows.forEach(([t, values]) => {
        // Excel date: days since 30/12/1899, in the time of the user
        sheetRows.push([{ number: (t - data.tzOffset * 60000) / 86400000 + 25569, style: 1 }, ...values.map(v => v === null ? null : { number: v })]);
    });
    const dataSheet = sheetXml(sheetRows, [22, ...data.series.map(s => Math.min(Math.max(s.label.length + 2, 14), 40))], headerRow);

    const summary = [[{ text: 'Résumé', style: 3 }], [{ text: data.subtitle }], [],
        ['Courbe', 'Nombre de valeurs', 'Minimum', 'Maximum', 'Moyenne', 'Première valeur', 'Dernière valeur'].map(text => ({ text, style: 2 }))];
    stats(data.series).forEach(s => {
        summary.push([{ text: s.label }, { number: s.count }, num(s.min), num(s.max), num(s.avg),
            s.first ? { text: `${numberText(s.first.v)} (${dateText(s.first.t, data.tzOffset)})` } : null,
            s.last ? { text: `${numberText(s.last.v)} (${dateText(s.last.t, data.tzOffset)})` } : null]);
    });
    const summarySheet = sheetXml(summary, [36, 18, 14, 14, 14, 30, 30], 0);

    const sheets = ['Courbes', 'Résumé'];
    return zip.create([
        { name: '[Content_Types].xml', data: xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`) },
        { name: '_rels/.rels', data: xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`) },
        { name: 'xl/workbook.xml', data: xml(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((s, i) => `<sheet name="${esc(s)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`) },
        { name: 'xl/_rels/workbook.xml.rels', data: xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`) },
        { name: 'xl/styles.xml', data: xml(`<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy hh:mm:ss"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="14"/><color rgb="FF1F3864"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`) },
        { name: 'xl/worksheets/sheet1.xml', data: dataSheet },
        { name: 'xl/worksheets/sheet2.xml', data: summarySheet }
    ]);
}

function num(value) {
    return value === null ? null : { number: value };
}

/** rows: [[cell]] with cell = { text } | { number } (+ style), freeze: row of the header (frozen) or 0 */
function sheetXml(rows, widths, freeze) {
    const body = rows.map((cells, r) => `<row r="${r + 1}">${cells.map((cell, c) => {
        if (!cell) {
            return '';
        }
        const ref = column(c) + (r + 1);
        const style = cell.style ? ` s="${cell.style}"` : '';
        if (cell.number !== undefined) {
            return isFinite(cell.number) ? `<c r="${ref}"${style}><v>${cell.number}</v></c>` : '';
        }
        return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(cell.text)}</t></is></c>`;
    }).join('')}</row>`).join('');
    const pane = freeze ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${freeze}" topLeftCell="A${freeze + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
        : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
    return xml(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${body}</sheetData></worksheet>`);
}

function column(index) {
    let name = '';
    for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
        name = String.fromCharCode(65 + (n - 1) % 26) + name;
    }
    return name;
}

function xml(text) {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + text;
}

function esc(text) {
    // characters not allowed in XML 1.0 are removed
    return String(text === null || text === undefined ? '' : text).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
        .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ------------------------------------------------------------------ PDF

const PAGE_W = 842, PAGE_H = 595, MARGIN = 36;      // A4 landscape, points
/** characters of WinAnsiEncoding outside latin-1 */
const WIN_ANSI = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, 'œ': 0x9C, 'Œ': 0x8C };

function pdf(data) {
    const image = jpeg(data.image);
    const allStats = stats(data.series);
    const times = data.series.flatMap(s => s.values.length ? [s.values[0].t, s.values[s.values.length - 1].t] : []);
    const pages = [];
    let ops = [];
    let y = PAGE_H - MARGIN;
    const newPage = () => {
        pages.push(ops);
        ops = [];
        y = PAGE_H - MARGIN;
    };
    const text = (x, yy, size, value, bold, color) => {
        ops.push(`BT ${color || '0 0 0'} rg /${bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(1)} ${yy.toFixed(1)} Td (${pdfString(value)}) Tj ET`);
    };

    text(MARGIN, y - 18, 18, data.title, true, '0.122 0.220 0.392');
    y -= 26;
    if (data.subtitle) {
        text(MARGIN, y - 12, 11, data.subtitle, false, '0.25 0.25 0.25');
        y -= 16;
    }
    const period = times.length ? `Données du ${dateText(Math.min(...times), data.tzOffset)} au ${dateText(Math.max(...times), data.tzOffset)}` : 'Aucune donnée sur la période';
    text(MARGIN, y - 11, 10, `${period} - document créé le ${dateText(Date.now(), data.tzOffset)}`, false, '0.4 0.4 0.4');
    y -= 22;

    if (image) {
        const maxW = PAGE_W - 2 * MARGIN, maxH = 330;
        const scale = Math.min(maxW / image.width, maxH / image.height);
        const w = image.width * scale, h = image.height * scale;
        ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${MARGIN} ${(y - h).toFixed(2)} cm /Im1 Do Q`);
        ops.push(`0.7 0.7 0.7 RG 0.5 w ${MARGIN} ${(y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re S`);
        y -= h + 18;
    }

    // table of the values of each curve
    const cols = [{ title: 'Courbe', w: 250 }, { title: 'Valeurs', w: 60 }, { title: 'Minimum', w: 80 }, { title: 'Maximum', w: 80 },
        { title: 'Moyenne', w: 80 }, { title: 'Dernière valeur', w: 220 }];
    const rowH = 17;
    const header = () => {
        let x = MARGIN;
        ops.push(`0.122 0.220 0.392 rg ${MARGIN} ${(y - rowH).toFixed(1)} ${cols.reduce((s, c) => s + c.w, 0)} ${rowH} re f`);
        cols.forEach(c => {
            text(x + 4, y - 12, 9.5, c.title, true, '1 1 1');
            x += c.w;
        });
        y -= rowH;
    };
    if (y - rowH * 2 < MARGIN) {
        newPage();
    }
    header();
    allStats.forEach((s, i) => {
        if (y - rowH < MARGIN) {
            newPage();
            header();
        }
        if (i % 2) {
            ops.push(`0.94 0.95 0.97 rg ${MARGIN} ${(y - rowH).toFixed(1)} ${cols.reduce((sum, c) => sum + c.w, 0)} ${rowH} re f`);
        }
        const values = [fit(s.label, 46), String(s.count), numberText(s.min), numberText(s.max), numberText(s.avg),
            s.last ? `${numberText(s.last.v)} (${dateText(s.last.t, data.tzOffset)})` : ''];
        let x = MARGIN;
        values.forEach((v, c) => {
            text(x + 4, y - 12, 9.5, v, false);
            x += cols[c].w;
        });
        y -= rowH;
    });
    pages.push(ops);
    return pdfFile(pages, image);
}

function fit(text, max) {
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/** picture of the chart: JPEG (data URL), with its size read in the file */
function jpeg(dataUrl) {
    const match = typeof dataUrl === 'string' && dataUrl.match(/^data:image\/jpe?g;base64,(.+)$/);
    if (!match) {
        return null;
    }
    const data = Buffer.from(match[1], 'base64');
    for (let i = 2; i < data.length - 9;) {
        if (data[i] !== 0xFF) {
            break;
        }
        const marker = data[i + 1];
        const length = data.readUInt16BE(i + 2);
        // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC)
        if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
            return { data, height: data.readUInt16BE(i + 5), width: data.readUInt16BE(i + 7), components: data[i + 9] };
        }
        i += 2 + length;
    }
    throw new Error('Image JPEG invalide');
}

function pdfString(text) {
    let out = '';
    for (const ch of String(text)) {
        let code = ch.charCodeAt(0);
        if (WIN_ANSI[ch]) {
            code = WIN_ANSI[ch];
        } else if (ch.length > 1 || code > 255 || (code >= 0x80 && code < 0xA0)) {
            code = ch === ' ' || ch === ' ' ? 32 : 63;    // '?' for the characters without glyph
        }
        const c = String.fromCharCode(code);
        out += c === '(' || c === ')' || c === '\\' ? '\\' + c : c;
    }
    return out;
}

function pdfFile(pages, image) {
    const objects = [];        // index + 1 = object number
    const add = content => {
        objects.push(content);
        return objects.length;
    };
    const catalog = add(null);
    const pagesObj = add(null);
    const font1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const font2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const imageObj = image ? add({
        dict: `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /${image.components === 1 ? 'DeviceGray' : image.components === 4 ? 'DeviceCMYK' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.data.length} >>`,
        stream: image.data
    }) : 0;
    const resources = `<< /Font << /F1 ${font1} 0 R /F2 ${font2} 0 R >>${imageObj ? ` /XObject << /Im1 ${imageObj} 0 R >>` : ''} >>`;
    const pageIds = pages.map((ops, i) => {
        const footer = `BT 0.5 0.5 0.5 rg /F1 8 Tf ${PAGE_W / 2 - 20} 18 Td (${pdfString(`Page ${i + 1} / ${pages.length}`)}) Tj ET`;
        const content = Buffer.from(ops.concat(footer).join('\n'), 'latin1');
        const contentObj = add({ dict: `<< /Length ${content.length} >>`, stream: content });
        return add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources ${resources} /Contents ${contentObj} 0 R >>`);
    });
    objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objects[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

    const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
    let size = parts[0].length;
    const offsets = [];
    objects.forEach((obj, i) => {
        offsets.push(size);
        const chunk = typeof obj === 'string'
            ? Buffer.from(`${i + 1} 0 obj\n${obj}\nendobj\n`, 'latin1')
            : Buffer.concat([Buffer.from(`${i + 1} 0 obj\n${obj.dict}\nstream\n`, 'latin1'), obj.stream, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
        parts.push(chunk);
        size += chunk.length;
    });
    const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}` +
        `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${size}\n%%EOF\n`;
    parts.push(Buffer.from(xref, 'latin1'));
    return Buffer.concat(parts);
}

module.exports = {
    router: router,
    xlsx: xlsx,
    pdf: pdf
};
