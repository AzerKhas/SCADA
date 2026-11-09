import { Component, EventEmitter, Input, OnChanges, OnInit, Output, SimpleChanges } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { MatDialog } from '@angular/material/dialog';
import { TranslateService } from '@ngx-translate/core';
import { ToastrService } from 'ngx-toastr';
import { EndPointApi } from '../../_helpers/endpointapi';
import { NavigationSettings, View } from '../../_models/hmi';
import { EditNameComponent, EditNameData } from '../../gui-helpers/edit-name/edit-name.component';
import { ConfirmDialogComponent, ConfirmDialogData } from '../../gui-helpers/confirm-dialog/confirm-dialog.component';
import { ProjectService } from '../../_services/project.service';
import { Chart } from '../../_models/chart';
import { Device } from '../../_models/device';
import { SiteCurvesDialogComponent, SiteCurvesData, SiteCurvesResult } from './site-curves-dialog/site-curves-dialog.component';
import { HistoryDbConfig, SiteHistoryDialogComponent } from './site-history-dialog/site-history-dialog.component';

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
    /** menu of the project open in the editor (pages shown in the menu of the site) */
    @Input() navigation: NavigationSettings;
    @Output() selectPage = new EventEmitter<string>();
    @Output() addPage = new EventEmitter<void>();
    @Output() toggleMenu = new EventEmitter<string>();

    private static readonly openViewKey = 'custom-scada.sites.open-view';
    private static readonly siteNameRegex = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
    /** page Configuration of a new site: its file is configuration.html (with all the properties of the site) */
    private static readonly configurationViewId = 'v_site_configuration';
    /** page Courbes of a new site: its chart shows the tags chosen in "Tags des courbes" */
    private static readonly curvesViewId = 'v_site_courbes';
    private static readonly curvesChartId = 'chart_site_courbes';

    sites: SiteInfo[] = [];
    expanded: Record<string, boolean> = {};
    /** name of the site open in this editor, null for the main project */
    currentSite: string = EditorSitesListComponent.getCurrentSite();
    loading = false;
    creating = false;
    error = '';

    constructor(private http: HttpClient,
                private dialog: MatDialog,
                private projectService: ProjectService,
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

    /** stop or start the instance of a site (a stopped site stays stopped after a restart of FUXA) */
    onStopStartSite(site: SiteInfo, start: boolean) {
        this.manage(site, 'POST', `/${start ? 'start' : 'stop'}`, null,
                    start ? 'editor.sites-started' : 'editor.sites-stopped-done');
    }

    /** new name: new folder and new address of the site */
    onRenameSite(site: SiteInfo) {
        const dialogRef = this.dialog.open(EditNameComponent, {
            disableClose: true,
            position: { top: '60px' },
            data: <EditNameData>{
                title: this.translateService.instant('editor.sites-rename-title', { name: site.name }),
                label: this.translateService.instant('editor.sites-new-name'),
                name: site.name,
                exist: this.sites.filter(s => s.name !== site.name).map(s => s.name),
                error: this.translateService.instant('editor.sites-new-exists'),
                validator: (name: string) => EditorSitesListComponent.siteNameRegex.test(name || '')
            }
        });
        dialogRef.afterClosed().subscribe(result => {
            const name = result?.name?.trim();
            if (name && name !== site.name) {
                this.manage(site, 'POST', '/rename', { name }, 'editor.sites-renamed', { name });
            }
        });
    }

    /** the folder of the site is moved to sites/_supprimes (not erased) */
    onDeleteSite(site: SiteInfo) {
        const dialogRef = this.dialog.open(ConfirmDialogComponent, {
            position: { top: '60px' },
            data: <ConfirmDialogData>{ msg: this.translateService.instant('editor.sites-delete-confirm', { name: site.name }) }
        });
        dialogRef.afterClosed().subscribe(result => {
            if (result) {
                this.manage(site, 'DELETE', '', null, 'editor.sites-deleted');
            }
        });
    }

    private manage(site: SiteInfo, method: string, action: string, body: any, success: string, params: any = {}) {
        site.busy = true;
        const url = `${EndPointApi.getURL()}/api/sites/${encodeURIComponent(site.name)}${action}`;
        const request = method === 'DELETE' ? this.http.delete(url) : this.http.post(url, body || {});
        request.subscribe({
            next: () => {
                this.toastr.success(this.translateService.instant(success, Object.assign({ site: site.name }, params)));
                this.load();
            },
            error: err => {
                site.busy = false;
                this.toastr.error(err?.error?.message || this.translateService.instant('editor.sites-manage-error'));
            }
        });
    }

    /** page api.html of the site: services of its API (tags, values, history) and test */
    onOpenApi(site: SiteInfo) {
        window.open(`/site/${encodeURIComponent(site.name)}/fichiers/api.html`, '_blank');
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

    /** pages of a site: the pages of the project open in the editor for the current site (always up to date) */
    getPages(site: SiteInfo): SitePage[] {
        if (site.name === this.currentSite && this.views) {
            // in the order of the menu, then the pages that are not in the menu
            const menu = (this.navigation?.items || []).map(item => item.view);
            const rank = (id: string) => menu.indexOf(id) < 0 ? menu.length : menu.indexOf(id);
            return this.views.map((view, index) => ({ id: view.id, name: view.name, index }))
                .sort((a, b) => rank(a.id) - rank(b.id) || a.index - b.index)
                .map(page => ({ id: page.id, name: page.name }));
        }
        return site.pages || [];
    }

    trackPage(index: number, page: SitePage) {
        return page.id;
    }

    isInMenu(page: SitePage): boolean {
        return (this.navigation?.items || []).some(item => item.view === page.id);
    }

    isCurrentPage(site: SiteInfo, page: SitePage): boolean {
        return site.name === this.currentSite && page.id === this.selectedViewId;
    }

    /**
     * HTML file of the page in the folder of the site (written by the server after each save)
     * a new page of the current site is not yet in the list of the server: its name is made like on the server
     */
    getFile(site: SiteInfo, page: SitePage): SiteFile {
        const file = site.files?.find(f => f.viewId === page.id);
        if (file || site.name !== this.currentSite) {
            return file;
        }
        const name = page.id === EditorSitesListComponent.configurationViewId ? 'configuration'
            : (page.name || 'page').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
                .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'page';
        return { file: `${name}.html`, page: page.name, viewId: page.id, url: `/site/${encodeURIComponent(site.name)}/fichiers/${name}.html` };
    }

    /**
     * choice of the tags of the page Courbes: the chart of the page shows these tags,
     * and the tags are recorded (DAQ) to have their history (period chosen with the calendar of the chart)
     */
    onConfigureCurves(site: SiteInfo) {
        const chartId = this.getCurvesChartId();
        const charts: Chart[] = this.projectService.getCharts() || [];
        const chart = charts.find(c => c.id === chartId);
        const devices: Record<string, Device> = this.projectService.getDevices() || {};
        const dialogRef = this.dialog.open(SiteCurvesDialogComponent, {
            position: { top: '60px' },
            data: <SiteCurvesData>{ site: site.name, devices, lines: chart?.lines || [] }
        });
        dialogRef.afterClosed().subscribe((result: SiteCurvesResult) => {
            if (!result) {
                return;
            }
            const newCharts = charts.filter(c => c.id !== chartId);
            newCharts.push(<Chart>{ id: chartId, name: chart?.name || this.translateService.instant('editor.sites-curves-chart-name'), lines: result.lines });
            this.projectService.setCharts(newCharts);
            // the history of a tag exists only if the tag is recorded
            Object.values(devices).forEach(device => {
                let changed = false;
                result.lines.forEach(line => {
                    const tag = device.tags?.[line.id];
                    if (tag && !tag.daq?.enabled) {
                        tag.daq = Object.assign({ interval: 5, changed: true, restored: false }, tag.daq, { enabled: true });
                        changed = true;
                    }
                });
                if (changed) {
                    this.projectService.setDeviceTags(device);
                }
            });
            if (!this.hasCurvesChart(chartId)) {
                this.toastr.warning(this.translateService.instant('editor.sites-curves-no-chart'));
            } else {
                this.toastr.success(this.translateService.instant('editor.sites-curves-saved', { count: result.lines.length }));
            }
        });
    }

    /** source of the history of the site: FUXA, or a PostgreSQL database (connection, table and columns) */
    onConfigureHistory(site: SiteInfo) {
        const dialogRef = this.dialog.open(SiteHistoryDialogComponent, {
            position: { top: '60px' },
            data: { site: site.name }
        });
        dialogRef.afterClosed().subscribe((config: HistoryDbConfig) => {
            if (config) {
                this.toastr.success(this.translateService.instant(config.source === 'postgres' ? 'editor.sites-history-saved-pg' : 'editor.sites-history-saved-fuxa',
                                                                  { table: config.table }));
            }
        });
    }

    /** chart shown by the page Courbes (first chart object of the page), else the default chart of the site */
    private getCurvesChartId(): string {
        const view = this.views?.find(v => v.id === EditorSitesListComponent.curvesViewId);
        const chartItem = Object.values(view?.items || {}).find(item => item.type === 'svg-ext-html_chart' && item.property?.id);
        return chartItem?.property?.id || EditorSitesListComponent.curvesChartId;
    }

    private hasCurvesChart(chartId: string): boolean {
        return (this.views || []).some(view => Object.values(view.items || {}).some(item => item.type === 'svg-ext-html_chart' && item.property?.id === chartId));
    }

    onOpenFile(file: SiteFile) {
        window.open(file.url, '_blank');
    }
}

export interface SitePage {
    id: string;
    name: string;
}

export interface SiteFile {
    file: string;
    page: string;
    viewId: string;
    url: string;
}

export interface SiteInfo {
    name: string;
    port: number;
    created: string;
    running: boolean;
    stopped?: boolean;
    /** an action (stop, start, rename, delete) is running */
    busy?: boolean;
    url: string;
    editorUrl: string;
    labUrl: string;
    pages: SitePage[];
    files: SiteFile[];
}
