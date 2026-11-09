import { Component, Inject, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { TranslateService } from '@ngx-translate/core';
import { EndPointApi } from '../../../_helpers/endpointapi';

/**
 * custom-SCADA: source of the history of the site (FUXA or a PostgreSQL database), like a connection:
 * server, database and user, then the table and its columns chosen in the lists given by the connection test
 */
@Component({
    selector: 'app-site-history-dialog',
    templateUrl: './site-history-dialog.component.html',
    styleUrls: ['./site-history-dialog.component.scss']
})
export class SiteHistoryDialogComponent implements OnInit {

    config: HistoryDbConfig = null;
    /** new password, empty = keep the saved one */
    password = '';
    tables: string[] = [];
    columns: { name: string; type: string }[] = [];
    testing = false;
    saving = false;
    message = '';
    error = '';

    private static readonly numberTypes = ['bigint', 'integer', 'smallint', 'numeric', 'double precision', 'real'];

    constructor(private http: HttpClient,
                private translateService: TranslateService,
                public dialogRef: MatDialogRef<SiteHistoryDialogComponent>,
                @Inject(MAT_DIALOG_DATA) public data: { site: string }) {
    }

    private get url(): string {
        return `${EndPointApi.getURL()}/api/site/history-config`;
    }

    ngOnInit() {
        this.http.get<HistoryDbConfig>(this.url).subscribe({
            next: config => {
                this.config = config;
                if (config.source === 'postgres' && config.host) {
                    this.onTest(true);
                }
            },
            error: err => this.error = err?.error?.message || this.translateService.instant('editor.sites-history-read-error')
        });
    }

    /** the numeric date/time columns need the unit (ms or s) */
    /** a date without time zone needs the time zone used by the program that writes the values */
    get timeWithoutZone(): boolean {
        const column = this.columns.find(c => c.name === this.config?.timeColumn);
        return !!column && (column.type === 'timestamp without time zone' || column.type === 'date');
    }

    get timeIsNumber(): boolean {
        const column = this.columns.find(c => c.name === this.config?.timeColumn);
        return !!column && SiteHistoryDialogComponent.numberTypes.includes(column.type);
    }

    private body(): any {
        const body: any = Object.assign({}, this.config);
        delete body.hasPassword;
        if (this.password) {
            body.password = this.password;
        }
        return body;
    }

    /** connection test: list of the tables, and the columns of the chosen table */
    onTest(quiet = false) {
        this.testing = true;
        this.error = '';
        this.message = '';
        this.http.post<{ tables: string[]; columns?: { name: string; type: string }[] }>(`${this.url}/test`, this.body()).subscribe({
            next: result => {
                this.testing = false;
                this.tables = result.tables || [];
                this.columns = result.columns || [];
                if (!quiet) {
                    this.message = this.translateService.instant('editor.sites-history-test-ok', { count: this.tables.length });
                }
            },
            error: err => {
                this.testing = false;
                this.tables = [];
                this.columns = [];
                this.error = err?.error?.message || this.translateService.instant('editor.sites-history-test-error');
            }
        });
    }

    onTableChange() {
        this.config.tagColumn = this.config.timeColumn = this.config.valueColumn = this.config.siteColumn = '';
        this.columns = [];
        if (this.config.table) {
            this.onTest(true);
        }
    }

    onNoClick() {
        this.dialogRef.close();
    }

    onOkClick() {
        this.saving = true;
        this.error = '';
        this.http.put<HistoryDbConfig>(this.url, this.body()).subscribe({
            next: config => {
                this.saving = false;
                this.dialogRef.close(config);
            },
            error: err => {
                this.saving = false;
                this.error = err?.error?.message || this.translateService.instant('editor.sites-history-save-error');
            }
        });
    }
}

export interface HistoryDbConfig {
    source: 'fuxa' | 'postgres';
    host: string;
    port: number;
    database: string;
    user: string;
    hasPassword?: boolean;
    ssl: boolean;
    table: string;
    tagColumn: string;
    timeColumn: string;
    valueColumn: string;
    tagMatch: 'name' | 'address' | 'id';
    timeUnit: 'ms' | 's';
    timeZone: 'local' | 'UTC';
    siteColumn: string;
    siteValue: string;
}
