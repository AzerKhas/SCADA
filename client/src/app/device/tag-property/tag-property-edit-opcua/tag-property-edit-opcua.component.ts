import { Component, OnInit, Inject, OnDestroy, ViewChild, Output, EventEmitter } from '@angular/core';
import { HmiService } from '../../../_services/hmi.service';
import { MAT_DIALOG_DATA as MAT_DIALOG_DATA, MatDialogRef as MatDialogRef } from '@angular/material/dialog';
import { Device, OpcUaTagType, Tag } from '../../../_models/device';
import { Subject, takeUntil } from 'rxjs';
import { TreetableComponent, Node, NodeType } from '../../../gui-helpers/treetable/treetable.component';
import { UntypedFormBuilder, UntypedFormGroup, Validators } from '@angular/forms';

@Component({
    selector: 'app-tag-property-edit-opcua',
    templateUrl: './tag-property-edit-opcua.component.html',
    styleUrls: ['./tag-property-edit-opcua.component.scss']
})
export class TagPropertyEditOpcuaComponent implements OnInit, OnDestroy {

    formGroup: UntypedFormGroup;
    @Output() result = new EventEmitter<any>();
    private destroy$ = new Subject<void>();
    @ViewChild(TreetableComponent, {static: false}) treetable: TreetableComponent;
    tagType = OpcUaTagType;

    config = {
        // custom-SCADA: lower than 640px so that the OK button stays visible under the NodeId block
        height: 'max(240px, calc(100vh - 420px))',
        width: '1000px'
    };

    /** custom-SCADA: tags added by typing the NodeId (ns=..;i=.. / ns=..;s=..), without browsing */
    manualNodeId = '';
    manualName = '';
    manualType = '';
    manualNodes: Node[] = [];
    manualError = '';

    constructor(
        private fb: UntypedFormBuilder,
        private hmiService: HmiService,
        public dialogRef: MatDialogRef<TagPropertyEditOpcuaComponent>,
        @Inject(MAT_DIALOG_DATA) public data: TagPropertyOpcUaData) {
        }

    ngOnInit() {
        if (this.data.tag) {
            this.formGroup = this.fb.group({
                deviceName: [this.data.device.name, Validators.required],
                tagName: [this.data.tag.name, Validators.required],
                tagType: [this.data.tag.type],
                tagDescription: [this.data.tag.description]
            });
        } else {
            this.hmiService.onDeviceBrowse.pipe(
                takeUntil(this.destroy$),
            ).subscribe(values => {
                if (this.data.device.id === values.device) {
                    if (values.error) {
                        this.addError(values.node, values.error);
                    } else {
                        this.addNodes(values.node, values.result);
                    }
                }
            });
            this.hmiService.onDeviceNodeAttribute.pipe(
                takeUntil(this.destroy$),
            ).subscribe(values => {
                if (this.data.device.id === values.device) {
                    if (values.error) {
                        //   this.addError(values.node, values.error);
                    } else if (values.node) {
                        if (values.node.attribute[14]) {    // datatype
                            values.node.type = values.node.attribute[14];
                        }
                        this.treetable.setNodeProperty(values.node, this.attributeToString(values.node.attribute));
                    }
                }
            });
            this.queryNext(null);
        }
    }

    ngOnDestroy() {
        this.destroy$.next(null);
        this.destroy$.complete();
    }

    queryNext(node: Node) {
        let n = (node) ? { id: node.id } : null;
        if (node) {
            n['parent'] = (node.parent) ? node.parent.id : null;
        }
        this.hmiService.askDeviceBrowse(this.data.device.id, n);
    }

    addNodes(parent: Node, nodes: any) {
        if (nodes) {
            let tempTags = Object.values(this.data.device.tags);
            nodes.forEach((n) => {
                let node = new Node(n.id, n.name);
                node.class = n.class;
                node.property = this.getProperty(n);
                let enabled = true;
                if (node.class === NodeType.Variable) {
                    const selected = tempTags.find((t: Tag) => t.address === n.id);
                    if (selected) {
                        enabled = false;
                    }
                }
                this.treetable.addNode(node, parent, enabled, false);
                if (node.class === NodeType.Variable) {
                    this.hmiService.askNodeAttributes(this.data.device.id, n);
                }
            });
            this.treetable.update();
        }
    }

    attributeToString(attribute) {
        let result = '';
        if (attribute) {
            Object.values(attribute).forEach((x) => {
                if (result.length) {
                    result += ', ';
                }
                result += x;
            });
        }
        return result;
    }

    getProperty(n: any) {
        if (n.class === 'Object') { // Object
            return '';
        } else if (n.class === 'Variable') {
            return 'Variable';
        } else if (n.class === 'Method') {
            return 'Method';
        }
        return '';
    }

    addError(parent: string, error: any) {
    }

    /** custom-SCADA: valid OPC UA NodeId, ex. ns=3;i=1001, ns=3;s="DB_Pompe"."Marche", i=2258 */
    static isValidNodeId(nodeId: string): boolean {
        return /^(ns=\d+;)?(i=\d+|s=.+|g=[0-9a-fA-F-]{36}|b=.+)$/.test((nodeId || '').trim());
    }

    /** custom-SCADA: add the typed NodeId to the list of tags to create */
    onAddManualNode() {
        const nodeId = (this.manualNodeId || '').trim();
        this.manualError = '';
        if (!TagPropertyEditOpcuaComponent.isValidNodeId(nodeId)) {
            this.manualError = 'device.opcua-manual-invalid';
            return;
        }
        const exists = Object.values(this.data.device.tags || {}).some((t: Tag) => t.address === nodeId) ||
            this.manualNodes.some(n => n.id === nodeId);
        if (exists) {
            this.manualError = 'device.opcua-manual-exists';
            return;
        }
        const node = new Node(nodeId, (this.manualName || '').trim() || nodeId);
        node.type = this.manualType || '';
        this.manualNodes.push(node);
        this.manualNodeId = '';
        this.manualName = '';
    }

    onRemoveManualNode(index: number) {
        this.manualNodes.splice(index, 1);
    }

    onNoClick(): void {
        this.dialogRef.close();
    }

    onOkClick(): void {
        if (this.data.tag) {
            this.result.emit(this.formGroup.getRawValue());
        } else {
            // custom-SCADA: a NodeId typed but not yet added with the button is added too
            if (this.manualNodeId?.trim()) {
                this.onAddManualNode();
                if (this.manualError) {
                    return;
                }
            }
            this.data.nodes = [...this.manualNodes];
            Object.keys(this.treetable.nodes).forEach((key) => {
                let n: Node = this.treetable.nodes[key];
                if (n.checked && n.enabled && (n.type || !n.childs || n.childs.length == 0)) {
                    this.data.nodes.push(this.treetable.nodes[key]);
                }
            });
            this.result.emit(this.data);
        }
    }
}

export interface TagPropertyOpcUaData {
    device: Device;
    nodes?: Node[];
    tag?: Tag;
}
