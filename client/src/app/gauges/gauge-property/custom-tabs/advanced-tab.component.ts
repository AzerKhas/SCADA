import { Component, Input } from '@angular/core';
import { GaugeProperty, GaugeShapeAdvanced } from '../../../_models/hmi';
import { Utils } from '../../../_helpers/utils';
import { FormulaError, FormulaHelper } from './formula.helper';

/**
 * custom-SCADA: page "Advanced" of the object dialog
 * (zoom = gain/offset conversion or math formula of the value, display range colors, ratio display; values or tags)
 */
@Component({
    selector: 'gauge-advanced-tab',
    templateUrl: './advanced-tab.component.html',
    styleUrls: ['./custom-tabs.css']
})
export class GaugeAdvancedTabComponent {

    @Input() data: any;
    @Input() property: GaugeProperty;

    defaultColor = Utils.defaultColor;
    functionNames = FormulaHelper.functionNames.join(', ');

    /** value used to try the formula in the dialog (not saved) */
    testValue = 100;

    get advanced(): GaugeShapeAdvanced {
        return this.property.style.advanced;
    }

    get formulaError(): FormulaError | null {
        return FormulaHelper.check(this.advanced.zoomFormula);
    }

    get testResult(): number | null {
        const value = Utils.toFiniteNumber(this.testValue);
        return value === null ? null : FormulaHelper.evaluate(this.advanced.zoomFormula, value);
    }
}
