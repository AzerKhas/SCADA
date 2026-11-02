import { Component, Inject, OnDestroy, OnInit } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { Subject, takeUntil } from 'rxjs';
import { Device, Tag, TagType } from '../../_models/device';
import { HmiService } from '../../_services/hmi.service';
import { S7ImportVariable } from './s7-import.helper';

/**
 * custom-SCADA: explore a Siemens S7 PLC (data blocks and M / I / Q areas read with snap7)
 * and create tags by giving a name to the addresses found in the PLC
 */
@Component({
    selector: 'app-s7-explore',
    templateUrl: './s7-explore.component.html',
    styleUrls: ['./s7-import.component.scss']
})
export class S7ExploreComponent implements OnInit, OnDestroy {

    static readonly PAGE = 64;
    static readonly SIZES = { Bool: 1, Byte: 1, Int: 2, Word: 2, DInt: 4, DWord: 4, Real: 4 };

    loading = false;
    error = '';
    blocks: S7Block[] = [];
    selected: S7Block = null;
    start = 0;
    bytes: number[] = [];
    tagTypes = Object.keys(TagType);
    form = { name: '', type: 'Int', byte: 0, bit: 0 };
    formError = '';
    pending: S7ImportVariable[] = [];
    private destroy$ = new Subject<void>();

    constructor(public dialogRef: MatDialogRef<S7ExploreComponent>,
                private hmiService: HmiService,
                @Inject(MAT_DIALOG_DATA) public data: S7ExploreData) {
    }

    ngOnInit() {
        this.hmiService.onDeviceBrowse.pipe(takeUntil(this.destroy$)).subscribe(message => {
            if (message?.device !== this.data.device.id || !message.node?.s7explore) {
                return;
            }
            this.loading = false;
            if (message.error) {
                this.error = String(message.error);
            } else if (message.result?.cmd === 'list') {
                this.blocks = message.result.blocks || [];
                this.error = this.blocks.some(b => b.size > 0) ? '' : 'device.s7explore-nothing';
            } else if (message.result?.cmd === 'read') {
                this.start = message.result.start;
                this.bytes = message.result.bytes || [];
            }
        });
        this.onRefreshList();
    }

    ngOnDestroy() {
        this.destroy$.next(null);
        this.destroy$.complete();
    }

    onRefreshList() {
        this.loading = true;
        this.error = '';
        this.hmiService.askDeviceBrowse(this.data.device.id, { s7explore: true, cmd: 'list' });
    }

    onSelectBlock(block: S7Block) {
        if (!block.size) {
            return;
        }
        this.selected = block;
        this.form.byte = 0;
        this.form.bit = 0;
        this.read(0);
    }

    read(start: number) {
        if (!this.selected) {
            return;
        }
        this.start = Math.max(0, Math.min(start, Math.max(0, this.selected.size - 1)));
        const size = Math.min(S7ExploreComponent.PAGE, this.selected.size - this.start);
        this.loading = true;
        this.hmiService.askDeviceBrowse(this.data.device.id, { s7explore: true, cmd: 'read', area: this.selected.area, db: this.selected.db, start: this.start, size });
    }

    blockLabel(block: S7Block): string {
        return block.area === 'DB' ? `DB${block.db}` : block.area;
    }

    /** bits of a byte, bit 7 first */
    bits(value: number): string {
        return ('0000000' + value.toString(2)).slice(-8);
    }

    onSelectByte(offset: number) {
        this.form.byte = offset;
    }

    /** value of the form address, decoded from the bytes read (big endian, like the PLC) */
    get formValue(): string {
        const index = this.form.byte - this.start;
        const size = S7ExploreComponent.SIZES[this.form.type] || 1;
        if (index < 0 || index + size > this.bytes.length) {
            return '';
        }
        const view = new DataView(Uint8Array.from(this.bytes.slice(index, index + size)).buffer);
        switch (this.form.type) {
            case 'Bool': return String(!!((view.getUint8(0) >> this.form.bit) & 1));
            case 'Byte': return String(view.getUint8(0));
            case 'Int': return String(view.getInt16(0));
            case 'Word': return String(view.getUint16(0));
            case 'DInt': return String(view.getInt32(0));
            case 'DWord': return String(view.getUint32(0));
            case 'Real': return String(+view.getFloat32(0).toPrecision(7));
            default: return '';
        }
    }

    /** FUXA S7 address of the form: DB1.DBX0.0, DB1.DBW2, MW10, M0.1, I0.0, QD4... */
    get formAddress(): string {
        if (!this.selected) {
            return '';
        }
        const size = S7ExploreComponent.SIZES[this.form.type];
        const letter = this.form.type === 'Bool' ? 'X' : size === 1 ? 'B' : size === 2 ? 'W' : 'D';
        const bit = this.form.type === 'Bool' ? `.${this.form.bit}` : '';
        if (this.selected.area === 'DB') {
            return `DB${this.selected.db}.DB${letter}${this.form.byte}${bit}`;
        }
        return this.form.type === 'Bool' ? `${this.selected.area}${this.form.byte}${bit}` : `${this.selected.area}${letter}${this.form.byte}`;
    }

    onAddTag() {
        const name = (this.form.name || '').trim();
        this.formError = '';
        const used = (Object.values(this.data.device.tags || {}) as Tag[]).some(t => t.name === name) || this.pending.some(p => p.name === name);
        if (!name) {
            this.formError = 'device.s7explore-error-name';
        } else if (used) {
            this.formError = 'device.s7import-status-exists';
        } else if (this.form.byte + (S7ExploreComponent.SIZES[this.form.type] || 1) > this.selected.size) {
            this.formError = 'device.s7explore-error-size';
        } else {
            this.pending.push({ name, type: this.form.type, address: this.formAddress });
            this.form.name = '';
        }
    }

    onRemovePending(index: number) {
        this.pending.splice(index, 1);
    }

    onNoClick() {
        this.dialogRef.close();
    }

    onOkClick() {
        this.dialogRef.close(this.pending);
    }
}

export interface S7ExploreData {
    device: Device;
}

interface S7Block {
    area: 'DB' | 'M' | 'I' | 'Q';
    db: number;
    size: number;
}
