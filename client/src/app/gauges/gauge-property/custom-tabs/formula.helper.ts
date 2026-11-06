/**
 * custom-SCADA: math formula applied to the value of a tag (page "Advanced", Zoom in "Formula" mode).
 * x = value of the tag. Only the operations below are accepted (no JavaScript is executed):
 * + - * / % ^ ( ), comparisons > < >= <= == !=, constants PI and E,
 * functions abs sqrt pow exp ln log10 sin cos tan (degrees) round floor ceil min max limit si bit
 */

type FormulaNode =
    | { type: 'num'; value: number }
    | { type: 'var'; name: string }
    | { type: 'neg'; arg: FormulaNode }
    | { type: 'op'; op: string; left: FormulaNode; right: FormulaNode }
    | { type: 'call'; name: string; args: FormulaNode[] };

interface Token {
    type: 'num' | 'name' | 'op' | 'end';
    text: string;
    value?: number;
    pos: number;
}

/** error of a formula: key of the message to translate, with its parameters */
export class FormulaError extends Error {
    constructor(public key: string, public params: Record<string, any> = {}) {
        super(key);
    }
}

const degrees = Math.PI / 180;

/** functions accepted in the formulas: [min args, max args, function] */
const FUNCTIONS: Record<string, [number, number, (...a: number[]) => number]> = {
    abs: [1, 1, Math.abs],
    sqrt: [1, 1, Math.sqrt],
    pow: [2, 2, Math.pow],
    exp: [1, 1, Math.exp],
    ln: [1, 1, Math.log],
    log10: [1, 1, Math.log10],
    sin: [1, 1, a => Math.sin(a * degrees)],
    cos: [1, 1, a => Math.cos(a * degrees)],
    tan: [1, 1, a => Math.tan(a * degrees)],
    round: [1, 2, (a, n = 0) => {
        const factor = Math.pow(10, Math.trunc(n));
        return Math.round(a * factor) / factor;
    }],
    floor: [1, 1, Math.floor],
    ceil: [1, 1, Math.ceil],
    min: [2, 20, Math.min],
    max: [2, 20, Math.max],
    limit: [3, 3, (a, low, high) => Math.min(Math.max(a, low), high)],
    si: [3, 3, (condition, yes, no) => condition !== 0 ? yes : no],
    bit: [2, 2, (a, n) => (n < 0 || n > 31) ? NaN : (Math.trunc(a) >>> Math.trunc(n)) & 1],
};

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

const COMPARISONS = ['>=', '<=', '==', '!=', '>', '<'];

/** own keys only: names like 'constructor' or 'toString' must not be found in the prototype */
const has = (table: object, name: string) => Object.prototype.hasOwnProperty.call(table, name);

export class FormulaHelper {

    private static cache = new Map<string, FormulaNode>();

    /** names of the functions, for the help of the dialog */
    static readonly functionNames = Object.keys(FUNCTIONS);

    /** check a formula, returns null if it is valid, else the error */
    static check(formula: string): FormulaError | null {
        try {
            FormulaHelper.compile(formula);
            return null;
        } catch (err) {
            return err instanceof FormulaError ? err : new FormulaError('gauges.shape-adv-formula-err-syntax', { pos: 1 });
        }
    }

    /**
     * calculate the formula with x = value
     * @returns the result, or null if the formula is not valid or the result is not a number (division by 0, sqrt(-1)...)
     */
    static evaluate(formula: string, x: number): number | null {
        try {
            const result = FormulaHelper.calc(FormulaHelper.compile(formula), x);
            return Number.isFinite(result) ? result : null;
        } catch (err) {
            return null;
        }
    }

    private static compile(formula: string): FormulaNode {
        const text = (formula || '').trim();
        if (!text) {
            throw new FormulaError('gauges.shape-adv-formula-err-empty');
        }
        let node = FormulaHelper.cache.get(text);
        if (!node) {
            node = new FormulaParser(text).parse();
            FormulaHelper.cache.set(text, node);
        }
        return node;
    }

    private static calc(node: FormulaNode, x: number): number {
        switch (node.type) {
            case 'num': return node.value;
            case 'var': return node.name === 'x' ? x : CONSTANTS[node.name];
            case 'neg': return -FormulaHelper.calc(node.arg, x);
            case 'call': {
                // si(): only the chosen branch is calculated
                if (node.name === 'si') {
                    return FormulaHelper.calc(node.args[0], x) !== 0 ? FormulaHelper.calc(node.args[1], x) : FormulaHelper.calc(node.args[2], x);
                }
                return FUNCTIONS[node.name][2](...node.args.map(arg => FormulaHelper.calc(arg, x)));
            }
            case 'op': {
                const a = FormulaHelper.calc(node.left, x);
                const b = FormulaHelper.calc(node.right, x);
                switch (node.op) {
                    case '+': return a + b;
                    case '-': return a - b;
                    case '*': return a * b;
                    case '/': return a / b;
                    case '%': return a % b;
                    case '^': return Math.pow(a, b);
                    case '>': return a > b ? 1 : 0;
                    case '<': return a < b ? 1 : 0;
                    case '>=': return a >= b ? 1 : 0;
                    case '<=': return a <= b ? 1 : 0;
                    case '==': return a === b ? 1 : 0;
                    case '!=': return a !== b ? 1 : 0;
                }
            }
        }
        return NaN;
    }
}

/** recursive descent parser: comparison > + - > * / % > unary - > ^ > number, name, function, ( ) */
class FormulaParser {

    private tokens: Token[];
    private index = 0;

    constructor(private text: string) {
        this.tokens = this.tokenize();
    }

    parse(): FormulaNode {
        const node = this.comparison();
        if (this.peek().type !== 'end') {
            this.unexpected();
        }
        return node;
    }

    private comparison(): FormulaNode {
        const left = this.additive();
        const token = this.peek();
        if (token.type === 'op' && COMPARISONS.includes(token.text)) {
            this.index++;
            return { type: 'op', op: token.text, left, right: this.additive() };
        }
        return left;
    }

    private additive(): FormulaNode {
        let node = this.term();
        while (this.isOp('+', '-')) {
            const op = this.next().text;
            node = { type: 'op', op, left: node, right: this.term() };
        }
        return node;
    }

    private term(): FormulaNode {
        let node = this.unary();
        while (this.isOp('*', '/', '%')) {
            const op = this.next().text;
            node = { type: 'op', op, left: node, right: this.unary() };
        }
        return node;
    }

    private unary(): FormulaNode {
        if (this.isOp('-')) {
            this.index++;
            return { type: 'neg', arg: this.unary() };
        }
        if (this.isOp('+')) {
            this.index++;
            return this.unary();
        }
        return this.power();
    }

    /** ^ is right associative and stronger than the unary minus: -x^2 = -(x^2), 2^-1 = 0.5 */
    private power(): FormulaNode {
        const base = this.primary();
        if (this.isOp('^')) {
            this.index++;
            return { type: 'op', op: '^', left: base, right: this.unary() };
        }
        return base;
    }

    private primary(): FormulaNode {
        const token = this.next();
        if (token.type === 'num') {
            return { type: 'num', value: token.value };
        }
        if (token.type === 'op' && token.text === '(') {
            const node = this.comparison();
            this.expect(')');
            return node;
        }
        if (token.type === 'name') {
            const name = token.text.toLowerCase();
            if (this.isOp('(')) {
                return this.call(name, token);
            }
            if (name === 'x' || has(CONSTANTS, name)) {
                return { type: 'var', name };
            }
            if (has(FUNCTIONS, name)) {
                throw new FormulaError('gauges.shape-adv-formula-err-args', { name });
            }
            throw new FormulaError('gauges.shape-adv-formula-err-name', { name: token.text });
        }
        this.index--;
        return this.unexpected();
    }

    private call(name: string, token: Token): FormulaNode {
        const fn = has(FUNCTIONS, name) ? FUNCTIONS[name] : null;
        if (!fn) {
            throw new FormulaError('gauges.shape-adv-formula-err-name', { name: token.text });
        }
        this.expect('(');
        const args: FormulaNode[] = [];
        if (!this.isOp(')')) {
            args.push(this.comparison());
            while (this.isOp(',')) {
                this.index++;
                args.push(this.comparison());
            }
        }
        this.expect(')');
        if (args.length < fn[0] || args.length > fn[1]) {
            throw new FormulaError('gauges.shape-adv-formula-err-args', { name });
        }
        return { type: 'call', name, args };
    }

    private tokenize(): Token[] {
        const tokens: Token[] = [];
        const re = /\s*(?:(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(>=|<=|==|!=|[-+*/%^(),<>]))/y;
        let pos = 0;
        while (pos < this.text.length) {
            if (/^\s*$/.test(this.text.slice(pos))) {
                break;
            }
            re.lastIndex = pos;
            const match = re.exec(this.text);
            if (!match) {
                const at = pos + (this.text.slice(pos).length - this.text.slice(pos).trimStart().length);
                throw new FormulaError('gauges.shape-adv-formula-err-char', { char: this.text[at], pos: at + 1 });
            }
            const start = re.lastIndex - match[0].trimStart().length;
            if (match[1] !== undefined) {
                tokens.push({ type: 'num', text: match[1], value: Number(match[1]), pos: start });
            } else if (match[2] !== undefined) {
                tokens.push({ type: 'name', text: match[2], pos: start });
            } else {
                tokens.push({ type: 'op', text: match[3], pos: start });
            }
            pos = re.lastIndex;
        }
        tokens.push({ type: 'end', text: '', pos: this.text.length });
        return tokens;
    }

    private peek(): Token {
        return this.tokens[this.index];
    }

    private next(): Token {
        return this.tokens[this.index++];
    }

    private isOp(...ops: string[]): boolean {
        const token = this.peek();
        return token.type === 'op' && ops.includes(token.text);
    }

    private expect(op: string) {
        if (!this.isOp(op)) {
            this.unexpected();
        }
        this.index++;
    }

    private unexpected(): never {
        const token = this.peek();
        if (token.type === 'end') {
            throw new FormulaError('gauges.shape-adv-formula-err-end');
        }
        if (token.text === ',') {
            // 0,5 instead of 0.5 (a comma is only accepted between the arguments of a function)
            throw new FormulaError('gauges.shape-adv-formula-err-comma', { pos: token.pos + 1 });
        }
        throw new FormulaError('gauges.shape-adv-formula-err-syntax', { pos: token.pos + 1 });
    }
}
