import { Component, EventEmitter, Input, OnChanges, OnInit, Output, SimpleChanges } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { MatDialog } from '@angular/material/dialog';
import { TranslateService } from '@ngx-translate/core';
import { ToastrService } from 'ngx-toastr';
import { EndPointApi } from '../../_helpers/endpointapi';
import { View } from '../../_models/hmi';
import { EditNameComponent, EditNameData } from '../../gui-helpers/edit-name/edit-name.component';

/**
 * custom-SCADA: panel "Sites" of the editor
 * each site is a folder (its own FUXA project) with its pages; the editor of a site is at /site/<name>/editor
 */
@Component({
    selector: 'app-editor-sites-list',
    templateUrl: './editor-sites-list.component.html',
    styleUrls: ['./editor-sites-list.component.scss']
})
export class EditorSitesListComponent implements OnInit, OnChanges {

    /** pages of the project open in the editor, to open the page asked before the change of site */
    @Input() views: View[];
    @Input() selectedViewId: string;
    @Output() selectPage = new EventEmitter<string>();

    private static readonly openViewKey = 'custom-scada.sites.open-view';
    private static readonly siteNameRegex = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

    sites: SiteInfo[] = [];
    expanded: Record<string, boolean> = {};
    /** name of the site open in this editor, null for the main project */
    currentSite: string = EditorSitesListComponent.getCurrentSite();
    loading = false;
    creating = false;
    error = '';

    constructor(private http: HttpClient,
                private dialog: MatDialog,
                private translateService: TranslateService,
                private toastr: ToastrService) {
    }

    ngOnInit() {
        if (this.currentSite) {
            this.expanded[this.currentSite] = true;
        }
        this.load();
    }

    ngOnChanges(changes: SimpleChanges) {
        if (changes.views && this.views?.length) {
            const viewId = sessionStorage.getItem(EditorSitesListComponent.openViewKey);
            if (viewId) {
                sessionStorage.removeItem(EditorSitesListComponent.openViewKey);
                if (this.views.some(view => view.id === viewId)) {
                    setTimeout(() => this.selectPage.emit(viewId));
                }
            }
        }
    }

    /** name of the site from the base path of the page: /site/<name>/editor */
    static getCurrentSite(): string | null {
        const match = EndPointApi.getBasePath().match(/^\/site\/([^/]+)$/);
        return match ? decodeURIComponent(match[1]) : null;
    }

    load() {
        this.loading = true;
        this.http.get<SiteInfo[]>(`${EndPointApi.getURL()}/api/sites`).subscribe({
            next: sites => {
                this.sites = sites || [];
                this.error = '';
                this.loading = false;
            },
            error: () => {
                this.error = 'editor.sites-load-error';
                this.loading = false;
            }
        });
    }

    onToggle(site: SiteInfo) {
        this.expanded[site.name] = !this.expanded[site.name];
    }

    /** open the editor of the main project */
    onOpenMain() {
        if (this.currentSite) {
            window.location.href = '/editor';
        }
    }

    /** open the editor of a site, or select the page when it is the site open in this editor */
    onOpenPage(site: SiteInfo, page?: SitePage) {
        if (site.name === this.currentSite) {
            if (page) {
                this.selectPage.emit(page.id);
            }
            return;
        }
        if (!site.running) {
            this.toastr.warning(this.translateService.instant('editor.sites-not-running', { name: site.name }));
            return;
        }
        if (page) {
            sessionStorage.setItem(EditorSitesListComponent.openViewKey, page.id);
        }
        window.location.href = site.editorUrl;
    }

    /** supervision of the site (operator view) in a new tab */
    onOpenSupervision(site: SiteInfo) {
        window.open(site.url, '_blank');
    }

    onAddSite() {
        const dialogRef = this.dialog.open(EditNameComponent, {
            disableClose: true,
            position: { top: '60px' },
            data: <EditNameData>{
                title: this.translateService.instant('editor.sites-new-title'),
                label: this.translateService.instant('editor.sites-new-name'),
                name: '',
                exist: this.sites.map(site => site.name),
                error: this.translateService.instant('editor.sites-new-exists'),
                validator: (name: string) => EditorSitesListComponent.siteNameRegex.test(name || '')
            }
        });
        dialogRef.afterClosed().subscribe(result => {
            if (result?.name) {
                this.createSite(result.name.trim());
            }
        });
    }

    private createSite(name: string) {
        this.creating = true;
        this.http.post<SiteInfo>(`${EndPointApi.getURL()}/api/sites`, { name }).subscribe({
            next: site => {
                this.creating = false;
                this.expanded[site.name] = true;
                this.toastr.success(this.translateService.instant('editor.sites-created', { name: site.name }));
                this.load();
            },
            error: err => {
                this.creating = false;
                this.toastr.error(err?.error?.message || this.translateService.instant('editor.sites-create-error'));
            }
        });
    }

    isCurrentPage(site: SiteInfo, page: SitePage): boolean {
        return site.name === this.currentSite && page.id === this.selectedViewId;
    }
}

export interface SitePage {
    id: string;
    name: string;
}

export interface SiteInfo {
    name: string;
    port: number;
    created: string;
    running: boolean;
    url: string;
    editorUrl: string;
    labUrl: string;
    pages: SitePage[];
}
