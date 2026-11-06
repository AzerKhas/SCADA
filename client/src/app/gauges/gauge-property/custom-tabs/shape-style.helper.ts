import { GaugeSettings, GaugeShapeAdvanced, GaugeShapeCondition, GaugeShapeGeneral, GaugeShapeLabel, GaugeShapeStyle, GaugeShapeVisibility, GaugeStatus } from '../../../_models/hmi';
import { Utils } from '../../../_helpers/utils';
import { FormulaHelper } from './formula.helper';

/**
 * custom-SCADA: applies the style of the pages "General" and "Label" to the SVG element of an object.
 * The attributes are written in the SVG of the view, so they are saved with the project and shown in the viewer.
 */
export class ShapeStyleHelper {

    static readonly valueTypeTag = 'svg-ext-value';
    private static readonly svgNs = 'http://www.w3.org/2000/svg';

    /** true if the style was never changed by the user (only the default values) */
    static isDefault(style: GaugeShapeStyle): boolean {
        return JSON.stringify(style) === JSON.stringify(new GaugeShapeStyle());
    }

    /**
     * apply the style to the SVG element of the object
     * - text objects (text, Value): font, font color, position, text (Value only)
     * - other shapes: border color, background and pattern
     * @returns true if the element was changed
     */
    static applyToElement(settings: GaugeSettings): boolean {
        const style: GaugeShapeStyle = settings?.property?.style;
        const element = settings?.id ? document.getElementById(settings.id) : null;
        if (!style || !element) {
            return false;
        }
        const isValue = settings.type === ShapeStyleHelper.valueTypeTag;
        const texts: Element[] = element.tagName.toLowerCase() === 'text' ? [element] : isValue ? Array.from(element.querySelectorAll('text')) : [];
        if (texts.length) {
            if (isValue) {
                ShapeStyleHelper.setTextAttributes(element, style.label);
            }
            texts.forEach(text => {
                ShapeStyleHelper.setTextAttributes(text, style.label);
                if (isValue) {
                    text.textContent = style.label.text;
                }
            });
        } else {
            ShapeStyleHelper.setShapeAttributes(element, style.general);
        }
        return true;
    }

    /**
     * format a numeric value with the digits of the page "General" (used by the Value object in the viewer)
     * @returns the formatted value, or null if the value is not a number or the data type is not numeric
     */
    static formatValue(value: any, general: GaugeShapeGeneral): string | null {
        if (!general || general.dataType === 'string' || general.dataType === 'bool') {
            return null;
        }
        const num = Utils.toFiniteNumber(value);
        if (num === null) {
            return null;
        }
        const isInteger = general.dataType.indexOf('int') >= 0;
        const fractional = isInteger ? 0 : Math.max(0, Number(general.fractionalDigits) || 0);
        let result = Math.abs(isInteger ? Math.trunc(num) : num).toFixed(fractional);
        if (general.zeroPadding) {
            const integerDigits = Math.max(1, (Number(general.totalDigits) || 1) - fractional);
            const parts = result.split('.');
            parts[0] = parts[0].padStart(integerDigits, '0');
            result = parts.join('.');
        }
        return (num < 0 ? '-' : '') + result;
    }

    /** shown instead of the value when the formula cannot be calculated (invalid formula, division by 0, sqrt of a negative value) */
    static readonly invalidValue = '---';

    /**
     * zoom of the page Advanced: value x gain + offset, or the formula with x = value
     * @returns the converted value, or null if the formula cannot be calculated
     */
    static zoomValue(num: number, advanced: GaugeShapeAdvanced, values: Record<string, any> = {}): number | null {
        if (!advanced?.zoom) {
            return num;
        }
        if (advanced.zoomMode === 'formula') {
            return FormulaHelper.evaluate(advanced.zoomFormula, num);
        }
        const gain = ShapeStyleHelper.getParameter(advanced.zoomGain, advanced.zoomTransform, advanced.zoomGainVariableId, values);
        const offset = ShapeStyleHelper.getParameter(advanced.zoomOffset, advanced.zoomTransform, advanced.zoomOffsetVariableId, values);
        return num * (gain ?? 1) + (offset ?? 0);
    }

    /**
     * format the value of a Value object with the pages General and Advanced
     * (zoom: value x gain + offset or formula, display range colors, ratio display; parameters as values or tags)
     * @param textElement SVG text of the value, its colors are changed when the value is out of the display range
     * @param values last values of the tags of the object (for the parameters read from tags)
     * @returns the formatted value, or null to keep the FUXA formatting
     */
    static formatStyledValue(value: any, style: GaugeShapeStyle, textElement?: Element, values: Record<string, any> = {}): string | null {
        let num = Utils.toFiniteNumber(value);
        if (num === null || !style?.general || style.general.dataType === 'string' || style.general.dataType === 'bool') {
            return null;
        }
        const advanced = style.advanced;
        num = ShapeStyleHelper.zoomValue(num, advanced, values);
        if (num === null) {
            if (textElement) {
                ShapeStyleHelper.setRangeColors(textElement, 0, null, null, advanced);
            }
            return ShapeStyleHelper.invalidValue;
        }
        if (textElement) {
            const min = ShapeStyleHelper.getParameter(advanced?.rangeMin, advanced?.rangeDynamic, advanced?.rangeMinVariableId, values);
            const max = ShapeStyleHelper.getParameter(advanced?.rangeMax, advanced?.rangeDynamic, advanced?.rangeMaxVariableId, values);
            ShapeStyleHelper.setRangeColors(textElement, num, advanced?.displayRange ? min : null, advanced?.displayRange ? max : null, advanced);
        }
        if (advanced?.ratioDisplay) {
            const min = ShapeStyleHelper.getParameter(advanced.ratioMin, advanced.ratioDynamic, advanced.ratioMinVariableId, values);
            const max = ShapeStyleHelper.getParameter(advanced.ratioMax, advanced.ratioDynamic, advanced.ratioMaxVariableId, values);
            if (min !== null && max !== null && max !== min) {
                const ratio = (num - min) / (max - min) * 100;
                return ratio.toFixed(Math.max(0, Number(style.general.fractionalDigits) || 0)) + ' %';
            }
        }
        return ShapeStyleHelper.formatValue(num, style.general);
    }

    /** tags used by the pages Advanced and Visibility, to add to the signals of the object */
    static addStyleSignals(signals: string[] | null, property: any): string[] | null {
        const ids = ShapeStyleHelper.getStyleSignals(property);
        if (!ids.length) {
            return signals;
        }
        return [...(signals || []), ...ids.filter(id => !signals?.includes(id))];
    }

    /** true if the signal is the tag of the value or a tag of the page Advanced (the value must be refreshed) */
    static isValueSignal(property: any, signalId: string): boolean {
        return property?.variableId === signalId || ShapeStyleHelper.getAdvancedSignals(property?.style?.advanced).includes(signalId);
    }

    private static getStyleSignals(property: any): string[] {
        const visibility: GaugeShapeVisibility = property?.style?.visibility;
        const ids = ShapeStyleHelper.getAdvancedSignals(property?.style?.advanced);
        if (visibility?.byBit && visibility.bitVariableId) {
            ids.push(visibility.bitVariableId);
        }
        if (visibility?.byWord && visibility.wordVariableId) {
            ids.push(visibility.wordVariableId);
        }
        return ids;
    }

    private static getAdvancedSignals(advanced: GaugeShapeAdvanced): string[] {
        const ids = [];
        if (advanced?.zoom && advanced.zoomMode !== 'formula' && advanced.zoomTransform) {
            ids.push(advanced.zoomGainVariableId, advanced.zoomOffsetVariableId);
        }
        if (advanced?.displayRange && advanced.rangeDynamic) {
            ids.push(advanced.rangeMinVariableId, advanced.rangeMaxVariableId);
        }
        if (advanced?.ratioDisplay && advanced.ratioDynamic) {
            ids.push(advanced.ratioMinVariableId, advanced.ratioMaxVariableId);
        }
        return ids.filter(id => !!id);
    }

    /** value of a parameter: the fixed value, or the last value of its tag (null if not yet received) */
    private static getParameter(fixed: any, fromTag: boolean, variableId: string, values: Record<string, any>): number | null {
        if (fromTag) {
            return variableId ? Utils.toFiniteNumber(values[variableId]) : null;
        }
        return Utils.toFiniteNumber(fixed);
    }

    /**
     * show or hide the object in the viewer with the page Visibility (bit and word conditions)
     * an unknown tag value does not hide the object
     */
    static processVisibility(ga: GaugeSettings, svgele: any, gaugeStatus: GaugeStatus) {
        const visibility = ga?.property?.style?.visibility;
        const node: HTMLElement | SVGElement = svgele?.node ?? svgele;
        if (!visibility || (!visibility.byBit && !visibility.byWord) || !node?.style) {
            return;
        }
        const values = gaugeStatus?.variablesValue || {};
        let visible = true;
        if (visibility.byBit && !Utils.isNullOrUndefined(values[visibility.bitVariableId])) {
            const bitValue = values[visibility.bitVariableId];
            const isOn = bitValue === true || bitValue === 'true' || (Utils.toFiniteNumber(bitValue) ?? 0) !== 0;
            visible = visible && (visibility.bitShowWhen === 'off' ? !isOn : isOn);
        }
        if (visibility.byWord && !Utils.isNullOrUndefined(values[visibility.wordVariableId])) {
            const wordValue = Utils.toFiniteNumber(values[visibility.wordVariableId]);
            if (wordValue !== null) {
                visible = visible && ShapeStyleHelper.compare(wordValue, visibility.wordCondition, Number(visibility.wordValue));
            }
        }
        // '' keeps the visibility attribute set by the server for the user permission
        node.style.visibility = visible ? '' : 'hidden';
    }

    /** prepare the object in the viewer: "Control penetration" lets the clicks pass through the object */
    static initInView(ga: GaugeSettings) {
        if (ga?.property?.style?.visibility?.penetration) {
            const element = document.getElementById(ga.id);
            if (element) {
                element.style.pointerEvents = 'none';
            }
        }
    }

    private static compare(value: number, condition: GaugeShapeCondition, reference: number): boolean {
        switch (condition) {
            case 'ne': return value !== reference;
            case 'gt': return value > reference;
            case 'ge': return value >= reference;
            case 'lt': return value < reference;
            case 'le': return value <= reference;
            default: return value === reference;
        }
    }

    /**
     * text and background colors when the value is above the max (high) or below the min (low)
     * the original text color is kept in data-fill, the background is a rect placed just before the object
     */
    private static setRangeColors(textElement: Element, value: number, min: number | null, max: number | null, advanced: GaugeShapeAdvanced) {
        if (!textElement.hasAttribute('data-fill')) {
            textElement.setAttribute('data-fill', textElement.getAttribute('fill') || '');
        }
        let color = textElement.getAttribute('data-fill');
        let background: string = null;
        if (max !== null && value > max) {
            color = advanced.highTextColor;
            background = advanced.highBackgroundColor;
        } else if (min !== null && value < min) {
            color = advanced.lowTextColor;
            background = advanced.lowBackgroundColor;
        }
        if (color) {
            textElement.setAttribute('fill', color);
        } else {
            textElement.removeAttribute('fill');
        }
        ShapeStyleHelper.setBackground(textElement, background);
    }

    private static setBackground(textElement: Element, color: string | null) {
        const group = textElement.parentElement as unknown as SVGGraphicsElement;
        if (!group?.id || !group.parentNode) {
            return;
        }
        const id = `${group.id}_bg`;
        let rect = document.getElementById(id);
        if (!color) {
            rect?.remove();
            return;
        }
        if (!rect) {
            rect = document.createElementNS(ShapeStyleHelper.svgNs, 'rect') as unknown as HTMLElement;
            rect.id = id;
            group.parentNode.insertBefore(rect, group);
        }
        rect.setAttribute('fill', color);
        // measured after the new text is written in the object
        Promise.resolve().then(() => {
            try {
                const box = group.getBBox();
                const padding = 3;
                rect.setAttribute('x', String(box.x - padding));
                rect.setAttribute('y', String(box.y - padding));
                rect.setAttribute('width', String(box.width + padding * 2));
                rect.setAttribute('height', String(box.height + padding * 2));
                rect.setAttribute('transform', group.getAttribute('transform') || '');
            } catch (err) {
                // getBBox fails when the object is not rendered (hidden view)
            }
        });
    }

    private static setTextAttributes(element: Element, label: GaugeShapeLabel) {
        element.setAttribute('fill', label.color);
        element.setAttribute('font-family', label.fontFamily);
        element.setAttribute('font-size', String(label.fontSize));
        element.setAttribute('font-weight', label.bold ? 'bold' : 'normal');
        element.setAttribute('font-style', label.italic ? 'italic' : 'normal');
        element.setAttribute('text-decoration', label.underline ? 'underline' : 'none');
        element.setAttribute('word-spacing', String(label.wordSpacing));
        element.setAttribute('text-anchor', label.position === 'left' ? 'start' : label.position === 'right' ? 'end' : 'middle');
    }

    private static setShapeAttributes(element: Element, general: GaugeShapeGeneral) {
        element.setAttribute('stroke', general.borderColor);
        if (general.pattern === 'solid') {
            element.setAttribute('fill', general.background);
        } else if (general.pattern === 'hatch') {
            element.setAttribute('fill', `url(#${ShapeStyleHelper.setHatchPattern(element, general)})`);
        } else {
            element.setAttribute('fill', 'none');
        }
    }

    /** create (or update) the SVG hatch pattern of the element, returns its id */
    private static setHatchPattern(element: Element, general: GaugeShapeGeneral): string {
        const id = `hatch_${element.id}`;
        const svg = (element as SVGElement).ownerSVGElement;
        let defs = svg.querySelector('defs');
        if (!defs) {
            defs = document.createElementNS(ShapeStyleHelper.svgNs, 'defs');
            svg.insertBefore(defs, svg.firstChild);
        }
        svg.querySelector(`#${id}`)?.remove();
        const pattern = document.createElementNS(ShapeStyleHelper.svgNs, 'pattern');
        pattern.setAttribute('id', id);
        pattern.setAttribute('width', '8');
        pattern.setAttribute('height', '8');
        pattern.setAttribute('patternUnits', 'userSpaceOnUse');
        pattern.setAttribute('patternTransform', 'rotate(45)');
        const background = document.createElementNS(ShapeStyleHelper.svgNs, 'rect');
        background.setAttribute('width', '8');
        background.setAttribute('height', '8');
        background.setAttribute('fill', general.background);
        const line = document.createElementNS(ShapeStyleHelper.svgNs, 'rect');
        line.setAttribute('width', '2');
        line.setAttribute('height', '8');
        line.setAttribute('fill', general.foreground);
        pattern.appendChild(background);
        pattern.appendChild(line);
        defs.appendChild(pattern);
        return id;
    }
}
