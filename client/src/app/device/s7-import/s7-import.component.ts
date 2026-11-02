import { Component, Inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { Device, Tag } from '../../_models/device';
import { S7ImportHelper, S7ImportVariable } from './s7-import.helper';

/**
 * custom-SCADA: import of Siemens S7 variables from TIA Portal exports,
 * so that the tags are created with the variable names of the PLC
 */
@Component({
    selector: 'app-s7-import',
    templateUrl: './s7-import.component.html',
    styleUrls: ['./s7-import.component.scss']
})
export class S7ImportComponent {

    source: 'tagtable' | 'db' = 'tagtable';
    dbNumber = 1;
    fileName = '';
    error = '';
    rows: S7ImportRow[] = [];

    constructor(public dialogRef: MatDialogRef<S7ImportComponent>,
                @Inject(MAT_DIALOG_DATA) public data: S7ImportData) {
    }

    get selectedCount(): number {
        return this.rows.filter(r => r.selected).length;
    }

    get allSelected(): boolean {
        const selectable = this.rows.filter(r => r.selectable);
        return selectable.length > 0 && selectable.every(r => r.selected);
    }

    onSourceChange() {
        this.rows = [];
        this.error = '';
        this.fileName = '';
    }

    onFileSelected(event: Event) {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) {
            return;
        }
        this.fileName = file.name;
        const reader = new FileReader();
        reader.onload = () => {
            this.loadText(<string>reader.result);
            input.value = '';
        };
        reader.readAsText(file);
    }

    loadText(text: string) {
        const result = this.source === 'db' ? S7ImportHelper.parseDbSource(text, Number(this.dbNumber) || 1) : S7ImportHelper.parseTagTableCsv(text);
        this.error = result.error ? 'device.s7import-error-' + result.error : '';
        const existing = Object.values(this.data.device.tags || {}) as Tag[];
        this.rows = result.variables.map(v => {
            const exists = existing.some(t => t.name === v.name);
            const status = v.error ? 'device.s7import-status-' + v.error : exists ? 'device.s7import-status-exists' : '';
            return { ...v, status, selectable: !status, selected: !status };
        });
    }

    onToggleAll(checked: boolean) {
        this.rows.filter(r => r.selectable).forEach(r => r.selected = checked);
    }

    onNoClick() {
        this.dialogRef.close();
    }

    onOkClick() {
        this.dialogRef.close(this.rows.filter(r => r.selected).map(r => <S7ImportVariable>{ name: r.name, type: r.type, address: r.address }));
    }
}

export interface S7ImportData {
    device: Device;
}

interface S7ImportRow extends S7ImportVariable {
    status: string;
    selectable: boolean;
    selected: boolean;
}
