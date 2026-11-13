import { Component, Inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';

/**
 * custom-SCADA: preview of a page of a site without leaving the editor
 * (live supervision of the page, or the HTML file of the page written in the folder of the site)
 */
@Component({
    selector: 'app-site-preview-dialog',
    templateUrl: './site-preview-dialog.component.html',
    styleUrls: ['./site-preview-dialog.component.scss']
})
export class SitePreviewDialogComponent {

    mode: 'live' | 'file' = 'live';
    url: SafeResourceUrl;

    constructor(public dialogRef: MatDialogRef<SitePreviewDialogComponent>,
                private sanitizer: DomSanitizer,
                @Inject(MAT_DIALOG_DATA) public data: SitePreviewData) {
        this.setMode(data.fileUrl && !data.liveUrl ? 'file' : 'live');
    }

    setMode(mode: 'live' | 'file') {
        this.mode = mode;
        this.url = this.sanitizer.bypassSecurityTrustResourceUrl(this.currentUrl());
    }

    currentUrl(): string {
        return this.mode === 'file' ? this.data.fileUrl : this.data.liveUrl;
    }

    onOpenTab() {
        window.open(this.currentUrl(), '_blank');
    }

    onClose() {
        this.dialogRef.close();
    }
}

export interface SitePreviewData {
    site: string;
    page: string;
    /** supervision of the page: /site/<name>/home?viewName=<page> */
    liveUrl: string;
    /** HTML file of the page: /site/<name>/fichiers/<file>.html */
    fileUrl?: string;
}
