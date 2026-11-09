import { Component, Inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { ChartLine } from '../../../_models/chart';
import { Device } from '../../../_models/device';

/**
 * custom-SCADA: choice of the tags shown as curves in the page Courbes of the site
 * (label, color and axis of each curve); the chosen tags are recorded (DAQ) to have their history
 */
@Component({
    selector: 'app-site-curves-dialog',
    templateUrl: './site-curves-dialog.component.html',
    styleUrls: ['./site-curves-dialog.component.scss']
})
export class SiteCurvesDialogComponent {

    static readonly colors = ['#1565C0', '#E65100', '#2E7D32', '#C62828', '#6A1B9A', '#00838F', '#F9A825', '#4E342E', '#AD1457', '#37474F'];

    rows: CurveRow[] = [];
    filter = '';
    defaultColors = SiteCurvesDialogComponent.colors;

    constructor(public dialogRef: MatDialogRef<SiteCurvesDialogComponent>,
                @Inject(MAT_DIALOG_DATA) public data: SiteCurvesData) {
        const lines = data.lines || [];
        Object.values(data.devices || {}).forEach(device => {
            Object.values(device.tags || {}).forEach(tag => {
                // the system tags (connection status...) are not curves
                if (tag.sysType) {
                    return;
                }
                const line = lines.find(l => l.id === tag.id);
                this.rows.push({
                    selected: !!line,
                    deviceName: device.name,
                    tagId: tag.id,
                    tagName: tag.name,
                    address: tag.address || '',
                    recorded: !!tag.daq?.enabled,
                    label: line?.label || tag.label || tag.name,
                    color: line?.color || '',
                    yaxis: line?.yaxis || 1,
                    order: line ? lines.indexOf(line) : lines.length + this.rows.length
                });
            });
        });
        this.rows.sort((a, b) => Number(b.selected) - Number(a.selected) || a.order - b.order);
        this.rows.filter(row => row.selected && !row.color).forEach(row => row.color = this.nextColor());
    }

    get visibleRows(): CurveRow[] {
        const text = this.filter.trim().toLowerCase();
        return !text ? this.rows : this.rows.filter(row =>
            `${row.tagName} ${row.deviceName} ${row.label} ${row.address}`.toLowerCase().includes(text));
    }

    get selectedCount(): number {
        return this.rows.filter(row => row.selected).length;
    }

    onToggle(row: CurveRow) {
        if (row.selected && !row.color) {
            row.color = this.nextColor();
        }
    }

    /** first color of the palette not used by a selected curve */
    private nextColor(): string {
        const used = this.rows.filter(row => row.selected).map(row => row.color);
        return SiteCurvesDialogComponent.colors.find(color => !used.includes(color)) || SiteCurvesDialogComponent.colors[0];
    }

    onNoClick() {
        this.dialogRef.close();
    }

    onOkClick() {
        const lines: ChartLine[] = this.rows.filter(row => row.selected).map(row => <ChartLine>{
            device: row.deviceName,
            id: row.tagId,
            name: row.tagName,
            label: (row.label || row.tagName).trim(),
            color: row.color,
            yaxis: Number(row.yaxis) === 2 ? 2 : 1,
            spanGaps: true
        });
        this.dialogRef.close(<SiteCurvesResult>{ lines });
    }
}

export interface SiteCurvesData {
    site: string;
    devices: Record<string, Device>;
    lines: ChartLine[];
}

export interface SiteCurvesResult {
    lines: ChartLine[];
}

interface CurveRow {
    selected: boolean;
    deviceName: string;
    tagId: string;
    tagName: string;
    address: string;
    recorded: boolean;
    label: string;
    color: string;
    yaxis: number;
    order: number;
}
