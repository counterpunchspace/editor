/**
 * State and rules behind the Add axis dialog: where copies of the existing
 * masters go on a new axis, how they are named, validation, and the plan the
 * worker turns into one batch. No DOM here, so it can be unit-tested.
 */

import type { Babelfont } from './babelfont';
import type { AxisMasterCopyPlan } from './babelfont-model';
import { AXIS_REGISTRY, type RegisteredAxis } from './generated/axis-registry';

export type Side = 'min' | 'max';
export type Direction = 'below' | 'both' | 'above';
export type DefaultChoice = 'existing' | Side;

export type AxisDialogMaster = {
    id: string;
    name: string;
    location: Record<string, number>;
};

/** What the dialog needs to know about the open font. */
export type AxisDialogFont = {
    axes: Array<{ tag: string; name: string }>;
    masters: AxisDialogMaster[];
    defaultMasterId: string;
    glyphCount: number;
    /** Glyphs with intermediate (brace) layers. */
    braceGlyphCount: number;
    /** Intermediate layers in the whole font. */
    braceLayerCount: number;
    instanceCount: number;
};

type Cell = {
    on: boolean;
    name: string | null;
    value: number | null;
    user: number | null;
};

export type MapRow = {
    key: string;
    position: number;
    user: number;
    names: string[];
    all: boolean;
};

export type Notes = {
    errors: Record<1 | 2 | 3, string[]>;
    warnings: Record<1 | 2 | 3, string[]>;
    /** Cell keys (`masterId:side`, or `n:masterId:side` for names) with errors. */
    bad: Set<string>;
};

export const CUSTOM_AXIS_KEY = 'custom';
const CUSTOM_AXIS: RegisteredAxis = {
    tag: 'AX01',
    name: 'Axis',
    min: -1000,
    default: 0,
    max: 1000,
    fallbacks: []
};
/** Registered OpenType axes, listed first in the axis menu. */
export const OPENTYPE_AXIS_ORDER = ['wdth', 'wght', 'opsz', 'slnt', 'ital'];
// Where style names don't give a good first step, or the usual direction differs.
const SUGGEST: Record<
    string,
    { dir?: Exclude<Direction, 'both'>; above?: number; below?: number }
> = {
    [CUSTOM_AXIS_KEY]: { dir: 'above', above: 100, below: -100 },
    opsz: { dir: 'above', above: 72, below: 8 },
    slnt: { dir: 'below', above: 12, below: -12 }
};
// The two directions in the axis's own words: [lower values, higher values].
const DIRECTION_WORDS: Record<string, [string, string]> = {
    wdth: ['Narrower', 'Wider'],
    wght: ['Lighter', 'Bolder'],
    opsz: ['Smaller', 'Larger'],
    slnt: ['Slanted', 'Back-slanted'],
    ital: ['Upright', 'Italic'],
    GRAD: ['Lower grade', 'Higher grade']
};

const REGISTRY_BY_TAG = new Map(AXIS_REGISTRY.map((axis) => [axis.tag, axis]));
const isPointSizeName = (name: string) => /^\d+(\.\d+)?pt$/.test(name);

// ---------- text shortening ----------

/** "A, B and C". */
export function listNames(names: string[]): string {
    return names.length <= 1
        ? names.join('')
        : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "A, B, C and 9 more" once a list gets long. Never "and 1 more". */
export function listShort(names: string[], max = 3): string {
    return names.length <= max + 1
        ? listNames(names)
        : `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

/** A short list of names, otherwise a count: "Light and Bold" / "18 masters". */
export function namesOrCount(names: string[], noun: string, max = 5): string {
    return names.length <= max ? listNames(names) : `${names.length} ${noun}`;
}

/** Cuts a single name to a character budget with an ellipsis. */
export function clipText(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Font records here are plain JSON (see rawArray in font-info). */
const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const formatNumber = (value: number) =>
    Number.isFinite(value) ? String(value) : '–';

/** Axes for the axis menu: OpenType ones first, then the rest by name. */
export function axisMenuEntries(): {
    opentype: RegisteredAxis[];
    others: RegisteredAxis[];
} {
    const opentype = OPENTYPE_AXIS_ORDER.flatMap((tag) => {
        const axis = REGISTRY_BY_TAG.get(tag);
        return axis ? [axis] : [];
    });
    const others = AXIS_REGISTRY.filter(
        (axis) => !OPENTYPE_AXIS_ORDER.includes(axis.tag)
    ).sort((a, b) => a.name.localeCompare(b.name));
    return { opentype, others };
}

export class AddAxisModel {
    readonly font: AxisDialogFont;
    readonly defaultMaster: AxisDialogMaster;
    key = CUSTOM_AXIS_KEY;
    registry: RegisteredAxis = CUSTOM_AXIS;
    direction: Direction = 'above';
    name = '';
    tag = '';
    existingAt = 0;
    newAt: Partial<Record<Side, number>> = {};
    defaultChoice: DefaultChoice = 'existing';
    separate = false;
    existingUser = 0;
    newUser: Partial<Record<Side, number>> = {};
    suffixEdited: Partial<Record<Side, string>> = {};
    copyKerning = true;
    copyIntermediateLayers = true;
    copyInstances = false;
    private cells = new Map<string, Cell>();
    private readonly fontTags: Set<string>;

    constructor(font: AxisDialogFont) {
        this.font = font;
        // A font without masters still gets a placeholder so names and
        // defaults resolve; the dialog then only offers the axis itself.
        this.defaultMaster = font.masters.find(
            (master) => master.id === font.defaultMasterId
        ) ??
            font.masters[0] ?? { id: '', name: '', location: {} };
        this.fontTags = new Set(font.axes.map((axis) => axis.tag));
        this.loadAxis(this.firstAvailableAxisKey());
    }

    // ---------- axis choice ----------

    isTagInFont(tag: string): boolean {
        return this.fontTags.has(tag);
    }

    firstAvailableAxisKey(): string {
        const order = [
            ...OPENTYPE_AXIS_ORDER,
            ...AXIS_REGISTRY.map((axis) => axis.tag)
        ];
        return (
            order.find(
                (tag) => REGISTRY_BY_TAG.has(tag) && !this.fontTags.has(tag)
            ) ?? CUSTOM_AXIS_KEY
        );
    }

    loadAxis(key: string): void {
        const registry =
            key === CUSTOM_AXIS_KEY
                ? this.customAxis()
                : (REGISTRY_BY_TAG.get(key) ?? this.customAxis());
        this.key = key === CUSTOM_AXIS_KEY ? key : registry.tag;
        this.registry = registry;
        this.name = registry.name;
        this.tag = registry.tag;
        this.existingAt = registry.default;
        this.existingUser = registry.default;
        this.newAt = {};
        this.newUser = {};
        this.defaultChoice = 'existing';
        this.suffixEdited = {};
        this.cells = new Map();
        let direction = SUGGEST[this.key]?.dir ?? 'above';
        if (!this.directionAllowed(direction)) {
            direction =
                (['above', 'below'] as const).find((d) =>
                    this.directionAllowed(d)
                ) ?? 'above';
        }
        this.setDirection(direction);
    }

    private customAxis(): RegisteredAxis {
        let index = 1;
        let tag = 'AX01';
        while (this.fontTags.has(tag)) {
            index += 1;
            tag = `AX${String(index).padStart(2, '0')}`;
        }
        return { ...CUSTOM_AXIS, tag, name: `Axis ${index}` };
    }

    isCustom(): boolean {
        return this.key === CUSTOM_AXIS_KEY;
    }

    directionWords(): [string, string] {
        return DIRECTION_WORDS[this.key] ?? ['Lower', 'Higher'];
    }

    sideWord(side: Side): string {
        return this.directionWords()[side === 'min' ? 0 : 1];
    }

    // ---------- positions ----------

    sides(): Side[] {
        return this.direction === 'above'
            ? ['max']
            : this.direction === 'below'
              ? ['min']
              : ['min', 'max'];
    }

    existingUserValue(): number {
        return this.separate ? this.existingUser : this.existingAt;
    }

    columnUser(side: Side): number {
        const value = this.separate ? this.newUser[side] : this.newAt[side];
        return value ?? Number.NaN;
    }

    columnValue(side: Side): number {
        return this.newAt[side] ?? Number.NaN;
    }

    private suggest(side: Side): number {
        const existing = this.existingUserValue();
        const override =
            SUGGEST[this.key]?.[side === 'max' ? 'above' : 'below'];
        if (
            override !== undefined &&
            (side === 'max' ? override > existing : override < existing)
        ) {
            return override;
        }
        const candidates = this.registry.fallbacks
            .filter(([, value]) =>
                side === 'max' ? value > existing : value < existing
            )
            .sort(
                (a, b) => Math.abs(a[1] - existing) - Math.abs(b[1] - existing)
            );
        // The second style name away (Width 100 → 125 Expanded, skipping SemiExpanded).
        if (candidates.length) {
            return candidates[Math.min(1, candidates.length - 1)][1];
        }
        if (side === 'max') {
            return this.registry.max > existing
                ? this.registry.max
                : existing + 100;
        }
        return this.registry.min < existing
            ? this.registry.min
            : existing - 100;
    }

    private sideAllowed(side: Side): boolean {
        if (this.isCustom()) {
            return true;
        }
        const existing = this.existingUserValue();
        return side === 'max'
            ? this.registry.max > existing
            : this.registry.min < existing;
    }

    directionAllowed(direction: Direction): boolean {
        return direction === 'both'
            ? this.sideAllowed('min') && this.sideAllowed('max')
            : this.sideAllowed(direction === 'above' ? 'max' : 'min');
    }

    setDirection(direction: Direction): void {
        this.direction = direction;
        const existing = this.existingAt;
        for (const side of this.sides()) {
            const value = this.newAt[side];
            const valid =
                value !== undefined &&
                Number.isFinite(value) &&
                (side === 'max' ? value > existing : value < existing);
            if (!valid) {
                const user = this.suggest(side);
                this.newUser[side] = user;
                this.newAt[side] = this.separate
                    ? existing + (user - this.existingUserValue())
                    : user;
            }
        }
        if (
            this.defaultChoice !== 'existing' &&
            !this.sides().includes(this.defaultChoice)
        ) {
            this.defaultChoice = 'existing';
        }
    }

    setSeparate(separate: boolean): void {
        this.separate = separate;
        if (separate) {
            this.existingUser = this.existingAt;
            this.newUser = { ...this.newAt };
        }
        for (const cell of this.cells.values()) {
            cell.user = null;
        }
    }

    // ---------- cells (one per existing master and side) ----------

    cell(masterId: string, side: Side): Cell {
        const key = `${masterId}:${side}`;
        let cell = this.cells.get(key);
        if (!cell) {
            cell = { on: true, name: null, value: null, user: null };
            this.cells.set(key, cell);
        }
        return cell;
    }

    cellValue(masterId: string, side: Side): number {
        return this.cell(masterId, side).value ?? this.columnValue(side);
    }

    cellUser(masterId: string, side: Side): number {
        const cell = this.cell(masterId, side);
        const value = this.cellValue(masterId, side);
        if (!this.separate) {
            return value;
        }
        if (cell.user !== null) {
            return cell.user;
        }
        if (cell.value === null) {
            return this.columnUser(side);
        }
        // A copy moved off its column sits on the line through the existing
        // masters and the column.
        const e = this.existingAt;
        const eu = this.existingUserValue();
        const d = this.columnValue(side);
        const du = this.columnUser(side);
        return d === e
            ? du
            : Math.round((eu + ((value - e) * (du - eu)) / (d - e)) * 100) /
                  100;
    }

    isCustomValue(masterId: string, side: Side): boolean {
        const cell = this.cell(masterId, side);
        return cell.value !== null && cell.value !== this.columnValue(side);
    }

    setCellValue(masterId: string, side: Side, value: number): void {
        this.cell(masterId, side).value =
            value === this.columnValue(side) ? null : value;
    }

    setCellName(masterId: string, side: Side, name: string): void {
        const master = this.masterById(masterId);
        this.cell(masterId, side).name =
            master && name === this.autoName(master, side) ? null : name;
    }

    resetCell(masterId: string, side: Side): void {
        const cell = this.cell(masterId, side);
        cell.value = null;
        cell.name = null;
        cell.user = null;
    }

    setColumnOn(side: Side, on: boolean): void {
        for (const master of this.font.masters) {
            this.cell(master.id, side).on = on;
        }
    }

    masterById(id: string): AxisDialogMaster | undefined {
        return this.font.masters.find((master) => master.id === id);
    }

    /** Masters in designspace order: by the font's axes, in axis order. */
    sortedMasters(): AxisDialogMaster[] {
        return [...this.font.masters].sort((a, b) => {
            for (const axis of this.font.axes) {
                const delta =
                    (a.location[axis.tag] ?? 0) - (b.location[axis.tag] ?? 0);
                if (delta) {
                    return delta;
                }
            }
            return 0;
        });
    }

    locationText(master: AxisDialogMaster): string {
        return this.font.axes.length
            ? this.font.axes
                  .map(
                      (axis) =>
                          `${axis.tag} ${formatNumber(master.location[axis.tag] ?? 0)}`
                  )
                  .join(' · ')
            : 'No axes yet';
    }

    // ---------- names ----------

    /** Registry style name for a userspace value ("125" → "Expanded"). */
    styleName(user: number): string {
        const fallbacks = this.registry.fallbacks;
        if (!fallbacks.length || !Number.isFinite(user)) {
            return '';
        }
        if (fallbacks.every(([name]) => isPointSizeName(name))) {
            return `${user}pt`;
        }
        const exact = fallbacks.find(([, value]) => value === user);
        if (exact) {
            return exact[0];
        }
        if (fallbacks.length < 2) {
            return '';
        }
        let best = fallbacks[0];
        for (const fallback of fallbacks) {
            if (Math.abs(fallback[1] - user) < Math.abs(best[1] - user)) {
                best = fallback;
            }
        }
        return `near ${best[0]}`;
    }

    autoSuffix(side: Side): string {
        const existing = this.existingUserValue();
        const value = this.columnUser(side);
        const candidates = this.registry.fallbacks.filter(([, fallback]) =>
            side === 'max' ? fallback > existing : fallback < existing
        );
        if (!candidates.length) {
            return `${this.name} ${formatNumber(value)}`;
        }
        if (candidates.every(([name]) => isPointSizeName(name))) {
            return `${formatNumber(value)}pt`;
        }
        let best = candidates[0];
        for (const candidate of candidates) {
            if (Math.abs(candidate[1] - value) < Math.abs(best[1] - value)) {
                best = candidate;
            }
        }
        return best[0];
    }

    suffix(side: Side): string {
        return this.suffixEdited[side] ?? this.autoSuffix(side);
    }

    setSuffix(side: Side, suffix: string): void {
        if (suffix === this.autoSuffix(side)) {
            delete this.suffixEdited[side];
        } else {
            this.suffixEdited[side] = suffix;
        }
    }

    /** "Light" → "Light Expanded"; "Regular" → "Expanded"; "Regular Text" → "Text Expanded". */
    autoName(master: AxisDialogMaster, side: Side): string {
        const words = master.name
            .split(/\s+/)
            .filter((word) => word && word !== 'Regular');
        return [...words, this.suffix(side)].join(' ').trim();
    }

    cellName(master: AxisDialogMaster, side: Side): string {
        return this.cell(master.id, side).name ?? this.autoName(master, side);
    }

    newMasters(): Array<{
        master: AxisDialogMaster;
        side: Side;
        name: string;
    }> {
        const sorted = this.sortedMasters();
        return this.sides().flatMap((side) =>
            sorted
                .filter((master) => this.cell(master.id, side).on)
                .map((master) => ({
                    master,
                    side,
                    name: this.cellName(master, side)
                }))
        );
    }

    // ---------- default master and axis ----------

    defaultChoiceValid(choice: DefaultChoice): boolean {
        return (
            choice === 'existing' ||
            (this.sides().includes(choice) &&
                this.cell(this.defaultMaster.id, choice).on)
        );
    }

    effectiveDefaultChoice(): DefaultChoice {
        return this.defaultChoiceValid(this.defaultChoice)
            ? this.defaultChoice
            : 'existing';
    }

    private mapPoints(): Array<{ d: number; u: number; name: string }> {
        const points = [
            {
                d: this.existingAt,
                u: this.existingUserValue(),
                name: 'Your masters'
            }
        ];
        for (const { master, side, name } of this.newMasters()) {
            points.push({
                d: this.cellValue(master.id, side),
                u: this.cellUser(master.id, side),
                name
            });
        }
        return points
            .filter((p) => Number.isFinite(p.d) && Number.isFinite(p.u))
            .sort((a, b) => a.d - b.d);
    }

    /** Userspace min, default and max, plus the map points by position. */
    deriveAxis(): {
        min: number;
        max: number;
        default: number;
        map: Array<{ d: number; u: number }>;
    } {
        const points = this.mapPoints();
        const users = points.map((p) => p.u);
        const choice = this.effectiveDefaultChoice();
        const def =
            choice === 'existing'
                ? this.existingUserValue()
                : this.cellUser(this.defaultMaster.id, choice);
        const map: Array<{ d: number; u: number }> = [];
        for (const point of points) {
            if (!map.some((q) => q.d === point.d)) {
                map.push({ d: point.d, u: point.u });
            }
        }
        return {
            min: users.length ? Math.min(...users) : def,
            max: users.length ? Math.max(...users) : def,
            default: def,
            map
        };
    }

    /** Userspace table rows: one per distinct position, listing who sits there. */
    mapRows(): MapRow[] {
        const sorted = this.sortedMasters();
        const rows: MapRow[] = [
            {
                key: 'existing',
                position: this.existingAt,
                user: this.existingUserValue(),
                names: sorted.map((master) => master.name),
                all: true
            }
        ];
        for (const side of this.sides()) {
            const onColumn = sorted.filter((master) => {
                const cell = this.cell(master.id, side);
                return cell.on && cell.value === null && cell.user === null;
            });
            if (onColumn.length) {
                rows.push({
                    key: `col:${side}`,
                    position: this.columnValue(side),
                    user: this.columnUser(side),
                    names: onColumn.map((master) =>
                        this.cellName(master, side)
                    ),
                    all: false
                });
            }
            for (const master of sorted) {
                const cell = this.cell(master.id, side);
                if (cell.on && (cell.value !== null || cell.user !== null)) {
                    rows.push({
                        key: `cell:${master.id}:${side}`,
                        position: this.cellValue(master.id, side),
                        user: this.cellUser(master.id, side),
                        names: [this.cellName(master, side)],
                        all: false
                    });
                }
            }
        }
        return rows;
    }

    setMapUser(key: string, value: number): void {
        if (key === 'existing') {
            this.existingUser = value;
        } else if (key.startsWith('col:')) {
            this.newUser[key.slice(4) as Side] = value;
        } else if (key.startsWith('cell:')) {
            const [masterId, side] = key.slice(5).split(':');
            this.cell(masterId, side as Side).user = value;
        }
    }

    // ---------- validation ----------

    validate(): Notes {
        const notes: Notes = {
            errors: { 1: [], 2: [], 3: [] },
            warnings: { 1: [], 2: [], 3: [] },
            bad: new Set()
        };
        const axis = this.deriveAxis();
        const existing = this.existingAt;
        if (!/^[A-Za-z][A-Za-z0-9]{3}$/.test(this.tag)) {
            notes.errors[1].push(
                'The tag needs exactly four letters or digits, starting with a letter.'
            );
        } else if (this.fontTags.has(this.tag)) {
            notes.errors[1].push(
                `The font already has an axis with the tag ${this.tag}.`
            );
        }
        if (!this.name.trim()) {
            notes.errors[1].push('Give the axis a name.');
        }
        if (!Number.isFinite(existing)) {
            notes.errors[2].push('Enter where your masters stay.');
        }
        // Problems with many masters are grouped into one message per side.
        const unnamed: string[] = [];
        for (const side of this.sides()) {
            const wrong: string[] = [];
            for (const master of this.font.masters) {
                const cell = this.cell(master.id, side);
                if (!cell.on) {
                    continue;
                }
                const value = this.cellValue(master.id, side);
                const key = `${master.id}:${side}`;
                const outOfSide =
                    !Number.isFinite(value) ||
                    (Number.isFinite(existing) &&
                        (side === 'min'
                            ? value >= existing
                            : value <= existing));
                if (outOfSide) {
                    wrong.push(this.cellName(master, side) || master.name);
                    notes.bad.add(key);
                }
                if (cell.name !== null && !cell.name.trim()) {
                    unnamed.push(master.name);
                    notes.bad.add(`n:${key}`);
                }
            }
            if (wrong.length) {
                const limit =
                    side === 'min'
                        ? `under ${formatNumber(existing)}`
                        : `over ${formatNumber(existing)}`;
                notes.errors[2].push(
                    `${listShort(wrong)}: ${this.sideWord(side).toLowerCase()} copies need a position ${limit}.`
                );
            }
            const skipped = this.sortedMasters().filter(
                (master) => !this.cell(master.id, side).on
            );
            if (skipped.length && skipped.length < this.font.masters.length) {
                const several = skipped.length > 1;
                notes.warnings[2].push(
                    `${listShort(skipped.map((m) => m.name))} ${several ? 'get' : 'gets'} no ${this.sideWord(side).toLowerCase()} copy. ${several ? 'Those masters are' : 'That master is'} filled in there by interpolating the copies you do add.`
                );
            }
        }
        if (unnamed.length) {
            notes.errors[2].push(
                `Copies of ${listShort(unnamed)} have no name.`
            );
        }
        if (this.separate) {
            if (!Number.isFinite(this.existingUserValue())) {
                notes.errors[3].push(
                    'Enter a userspace value for your masters.'
                );
            }
            const points = this.mapPoints();
            for (let i = 1; i < points.length; i += 1) {
                const a = points[i - 1];
                const b = points[i];
                if (a.d === b.d && a.u !== b.u) {
                    notes.errors[3].push(
                        `${a.name} and ${b.name} sit at the same position (${a.d}) but have different userspace values.`
                    );
                } else if (a.d !== b.d && b.u <= a.u) {
                    notes.errors[3].push(
                        `Userspace values must rise in the same order as positions. ${b.name} (${b.d} → ${b.u}) is not above ${a.name} (${a.d} → ${a.u}).`
                    );
                }
                if (notes.errors[3].length >= 3) {
                    break;
                }
            }
        }
        if (
            !this.isCustom() &&
            (axis.min < this.registry.min || axis.max > this.registry.max)
        ) {
            notes.warnings[this.separate ? 3 : 2].push(
                `The Google Fonts registry allows ${this.registry.name} values from ${this.registry.min} to ${this.registry.max}. Fonts beyond that range won’t be accepted on Google Fonts.`
            );
        }
        return notes;
    }

    // ---------- result ----------

    /** The axis record. Without masters it spans the chosen positions anyway. */
    axisRecord(withMasters: boolean): Babelfont.Axis {
        // Every axis carries a map: Font info reads designspace min, default
        // and max from it. Without separate userspace values it is identity.
        let points = this.deriveAxis().map;
        let def = this.deriveAxis().default;
        if (!withMasters) {
            points = [
                { d: this.existingAt, u: this.existingUserValue() },
                ...this.sides().map((side) => ({
                    d: this.columnValue(side),
                    u: this.columnUser(side)
                }))
            ]
                .filter((p) => Number.isFinite(p.d) && Number.isFinite(p.u))
                .sort((a, b) => a.d - b.d);
            def = this.existingUserValue();
        }
        const users = points.map((point) => point.u);
        return {
            name: { dflt: this.name.trim() },
            tag: this.tag,
            min: users.length ? Math.min(...users) : def,
            default: def,
            max: users.length ? Math.max(...users) : def,
            map: points.map((point) => [point.u, point.d])
        };
    }

    /**
     * Builds the batch plan from the font's own records. Copies take metrics,
     * custom values and format data from their source master; kerning and
     * guides only when asked.
     */
    buildPlan(
        axes: Babelfont.Axis[],
        masters: Babelfont.Master[],
        instances: Babelfont.Instance[],
        newId: () => string
    ): { plan: AxisMasterCopyPlan; masterCount: number } {
        const tag = this.tag;
        const withTag = <T extends { location?: Babelfont.Master['location'] }>(
            record: T,
            value: number
        ): T => ({
            ...record,
            location: { ...(record.location ?? {}), [tag]: value }
        });
        const copies: AxisMasterCopyPlan['copies'] = [];
        const nextMasters = masters.map((master) =>
            withTag(cloneJson(master), this.existingAt)
        );
        for (const { master, side, name } of this.newMasters()) {
            const source = masters.find((record) => record.id === master.id);
            if (!source) {
                continue;
            }
            const value = this.cellValue(master.id, side);
            const copy = withTag(cloneJson(source), value);
            copy.id = newId();
            copy.name = { dflt: name };
            if (!this.copyKerning) {
                Object.assign(copy, { kerning: {}, guides: [] });
                if ('kerning_rtl' in copy) {
                    Object.assign(copy, { kerning_rtl: {} });
                }
            }
            nextMasters.push(copy);
            copies.push({
                sourceMasterId: source.id,
                newMasterId: copy.id,
                value
            });
        }

        const nextInstances = instances.map((instance) =>
            withTag(cloneJson(instance), this.existingAt)
        );
        if (this.copyInstances && copies.length) {
            for (const side of this.sides()) {
                if (!this.font.masters.some((m) => this.cell(m.id, side).on)) {
                    continue;
                }
                for (const instance of instances) {
                    if (instance.variable) {
                        continue;
                    }
                    const copy = withTag(
                        cloneJson(instance),
                        this.columnValue(side)
                    );
                    copy.id = newId();
                    const words = (instance.name?.dflt ?? '')
                        .split(/\s+/)
                        .filter((word) => word && word !== 'Regular');
                    copy.name = {
                        dflt: [...words, this.suffix(side)].join(' ').trim()
                    };
                    copy.custom_names =
                        {} as Babelfont.Instance['custom_names'];
                    nextInstances.push(copy);
                }
            }
        }

        return {
            plan: {
                axes: [
                    ...axes.map((axis) => cloneJson(axis)),
                    this.axisRecord(true)
                ],
                masters: nextMasters,
                instances: nextInstances,
                axisTag: tag,
                existingValue: this.existingAt,
                copies,
                copyIntermediateLayers: this.copyIntermediateLayers
            },
            masterCount: copies.length
        };
    }
}
