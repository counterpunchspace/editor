/**
 * Font Info View Manager
 * Handles switching between Names and Features tabs in the font info view
 */

import tippy, { type Instance as TippyInstance } from 'tippy.js';
import { Logger } from './logger';
import { fontCompilation } from './font-compilation';
import { attachTopRowSidebarInterpolation } from './top-row-sidebar-interpolation';
import { getFontInfoSection, setFontInfoSection } from './window-ui-state';
import type {
    PatchSyncEngine,
    TransactionHistoryTarget
} from './patch-sync-engine';
import type { Babelfont } from './babelfont';
import type { Font as BabelfontModelFont } from './babelfont-model';
import {
    getFeatureDescription,
    getFeatureExecutionOrder,
    isDiscretionary,
    SCRIPT_TO_SHAPER
} from './opentype-features';
import { extractPrimaryFeatureIssue } from './feature-error-parser';
import { beginLoadingCursor, endLoadingCursor } from './loading-cursor';
import {
    addTippyBackdropSupport,
    getOrCreateBackdrop,
    getTheme,
    setupMenuKeyboardNav
} from './tippy-utils';
import {
    areLocalizedStringValuesEqual,
    createLocalizedStringEditor,
    normalizeLocalizedStringValue,
    type LocalizedStringEditorHandle
} from './localized-string-editor';
import { designspaceToUserspace } from './locations';
import { AxisMapEditor } from './axis-map-editor';
import { bindModalEscape, type ModalEscapeBinding } from './ui/modal-escape';
import {
    ADDITIONAL_METRICS_PANEL_KEYS,
    isAdditionalMetricsPanelKey,
    isHiddenMasterMetricsPanelKey
} from './glyph-canvas/vertical-metrics';
// Import FEA mode for Ace Editor (registers the mode automatically)
import './mode-fea';
const console = new Logger('FontInfo');

const FEATURE_CODE_COMPILE_DEBOUNCE_MS = 5000;

type FontInfoTab =
    | 'general'
    | 'names'
    | 'axes'
    | 'masters'
    | 'instances'
    | 'custom_ot_values'
    | 'features';
type FeatureItemType = 'prefix' | 'class' | 'feature';
type FontNameFieldKey = keyof Babelfont.Names;
type FontRootFieldKey = 'upm' | 'version' | 'note' | 'date';
type CustomOTFieldKey = keyof Babelfont.CustomOTValues;
type MasterFieldKey = 'id';
type InstanceFieldKey = 'id' | 'variable' | 'linked_style';
type RecordDropPlacement = 'before' | 'after';

interface FontInfoSectionConfig {
    id: FontInfoTab;
    label: string;
    usesSearch: boolean;
}

interface FontNameFieldConfig {
    key: FontNameFieldKey;
    label: string;
    multiline?: boolean;
}

interface FontNameGroupConfig {
    title: string;
    fields: FontNameFieldConfig[];
}

interface CustomOTFieldConfig {
    key: CustomOTFieldKey;
    label: string;
    kind: 'integer' | 'string' | 'number-list';
    helperText?: string;
    exactLength?: number;
    placeholder?: string;
}

interface CustomOTGroupConfig {
    title: string;
    fields: CustomOTFieldConfig[];
}

const FONTINFO_SECTIONS: FontInfoSectionConfig[] = [
    {
        id: 'general',
        label: 'General',
        usesSearch: false
    },
    {
        id: 'names',
        label: 'Names',
        usesSearch: false
    },
    {
        id: 'axes',
        label: 'Axes',
        usesSearch: false
    },
    {
        id: 'masters',
        label: 'Masters',
        usesSearch: false
    },
    {
        id: 'instances',
        label: 'Instances',
        usesSearch: false
    },
    {
        id: 'custom_ot_values',
        label: 'Custom OT Values',
        usesSearch: false
    },
    {
        id: 'features',
        label: 'Features',
        usesSearch: true
    }
];

const FONT_NAME_GROUPS: FontNameGroupConfig[] = [
    {
        title: 'Identity',
        fields: [
            { key: 'family_name', label: 'Family Name' },
            {
                key: 'preferred_subfamily_name',
                label: 'Preferred Subfamily Name'
            },
            { key: 'typographic_family', label: 'Typographic Family' },
            {
                key: 'typographic_subfamily',
                label: 'Typographic Subfamily'
            },
            { key: 'full_name', label: 'Full Name' },
            { key: 'version', label: 'Version' }
        ]
    },
    {
        title: 'Technical/OpenType',
        fields: [
            { key: 'postscript_name', label: 'PostScript Name' },
            {
                key: 'variations_postscript_name_prefix',
                label: 'Variations PostScript Name Prefix'
            },
            { key: 'unique_id', label: 'Unique ID' },
            {
                key: 'compatible_full_name',
                label: 'Compatible Full Name'
            },
            { key: 'postscript_cid_name', label: 'PostScript CID Name' },
            { key: 'wws_family_name', label: 'WWS Family Name' },
            { key: 'wws_subfamily_name', label: 'WWS Subfamily Name' }
        ]
    },
    {
        title: 'Credits/URLs',
        fields: [
            { key: 'designer', label: 'Designer' },
            { key: 'designer_url', label: 'Designer URL' },
            { key: 'manufacturer', label: 'Manufacturer' },
            { key: 'manufacturer_url', label: 'Manufacturer URL' }
        ]
    },
    {
        title: 'Legal/Descriptive',
        fields: [
            { key: 'copyright', label: 'Copyright', multiline: true },
            { key: 'trademark', label: 'Trademark' },
            { key: 'description', label: 'Description', multiline: true },
            { key: 'license', label: 'License', multiline: true },
            { key: 'license_url', label: 'License URL' },
            { key: 'sample_text', label: 'Sample Text', multiline: true }
        ]
    }
];

const CUSTOM_OT_GROUPS: CustomOTGroupConfig[] = [
    {
        title: 'Head',
        fields: [
            {
                key: 'head_flags',
                label: 'Head Flags',
                kind: 'integer',
                placeholder: 'Bit field, e.g. 3 or 2048',
                helperText:
                    'Bit field for head.flags. Common low bits are 0 = baseline at y=0, 1 = LSB at x=0, 3 = integer PPEM math, 11 = lossless, 13 = ClearType optimized.'
            },
            {
                key: 'head_lowest_rec_ppem',
                label: 'Lowest Recommended PPEM',
                kind: 'integer',
                placeholder: 'Usually a small integer such as 8 or 9',
                helperText:
                    'Sets head.lowestRecPPEM, the smallest recommended rendering size in pixels per em.'
            }
        ]
    },
    {
        title: 'OS/2',
        fields: [
            {
                key: 'os2_us_weight_class',
                label: 'Weight Class',
                kind: 'integer',
                placeholder: '1-1000, e.g. 400 or 700',
                helperText:
                    'OS/2 usWeightClass. Standard values are usually 100 Thin, 400 Regular, 700 Bold, 900 Black.'
            },
            {
                key: 'os2_us_width_class',
                label: 'Width Class',
                kind: 'integer',
                placeholder: '1-9, where 5 is normal width',
                helperText:
                    'OS/2 usWidthClass. Typical values are 3 Condensed, 5 Normal, 7 Expanded.'
            },
            {
                key: 'os2_fs_type',
                label: 'fsType',
                kind: 'integer',
                placeholder: 'Embedding rights bit field',
                helperText:
                    'OS/2 fsType bit field. 0 means installable embedding; 2 restricted license; 4 preview/print; 8 no embedding; 256 no subsetting; 512 bitmap only.'
            },
            {
                key: 'os2_family_class',
                label: 'Family Class',
                kind: 'integer',
                placeholder: 'Packed class/subclass integer',
                helperText:
                    'OS/2 family class and subclass packed into one integer. Leave blank unless you intentionally classify the design.'
            },
            {
                key: 'os2_panose',
                label: 'Panose',
                kind: 'number-list',
                exactLength: 10,
                placeholder: '2, 11, 6, 4, 2, 2, 2, 2, 2, 4',
                helperText:
                    'Panose classification as 10 comma-separated integers in order. Must contain exactly 10 values.'
            },
            {
                key: 'os2_unicode_range1',
                label: 'Unicode Range 1',
                kind: 'integer',
                placeholder: 'Bits 0-31',
                helperText:
                    'OS/2 ulUnicodeRange1. Bit field for Unicode blocks 0-31 as defined by the OpenType spec.'
            },
            {
                key: 'os2_unicode_range2',
                label: 'Unicode Range 2',
                kind: 'integer',
                placeholder: 'Bits 32-63',
                helperText:
                    'OS/2 ulUnicodeRange2. Bit field for Unicode blocks 32-63.'
            },
            {
                key: 'os2_unicode_range3',
                label: 'Unicode Range 3',
                kind: 'integer',
                placeholder: 'Bits 64-95',
                helperText:
                    'OS/2 ulUnicodeRange3. Bit field for Unicode blocks 64-95.'
            },
            {
                key: 'os2_unicode_range4',
                label: 'Unicode Range 4',
                kind: 'integer',
                placeholder: 'Bits 96-127',
                helperText:
                    'OS/2 ulUnicodeRange4. Bit field for Unicode blocks 96-127.'
            },
            {
                key: 'os2_vendor_id',
                label: 'Vendor ID',
                kind: 'string',
                placeholder: 'Four-character vendor code, e.g. ABCD',
                helperText:
                    'OS/2 achVendID. Usually a four-character vendor identifier. Leave blank to remove the override.'
            },
            {
                key: 'os2_fs_selection',
                label: 'fsSelection',
                kind: 'integer',
                placeholder: 'Style bit field',
                helperText:
                    'OS/2 fsSelection bit field. Common bits include 0 Italic, 5 Bold, 6 Regular, 7 Use Typo Metrics, 8 WWS, 9 Oblique.'
            },
            {
                key: 'os2_code_page_range1',
                label: 'Code Page Range 1',
                kind: 'integer',
                placeholder: 'Bits 0-31',
                helperText:
                    'OS/2 ulCodePageRange1 bit field for code pages 0-31.'
            },
            {
                key: 'os2_code_page_range2',
                label: 'Code Page Range 2',
                kind: 'integer',
                placeholder: 'Bits 32-63',
                helperText:
                    'OS/2 ulCodePageRange2 bit field for code pages 32-63.'
            }
        ]
    },
    {
        title: 'CFF',
        fields: [
            {
                key: 'cff_blue_values',
                label: 'BlueValues',
                kind: 'number-list',
                placeholder: '-15, 0, 500, 515, 700, 715',
                helperText:
                    'CFF BlueValues. Comma-separated overshoot alignment zones, usually in bottom/top pairs.'
            },
            {
                key: 'cff_other_blues',
                label: 'OtherBlues',
                kind: 'number-list',
                placeholder: '-250, -235',
                helperText:
                    'CFF OtherBlues. Additional bottom alignment zones as comma-separated numbers.'
            },
            {
                key: 'cff_family_blues',
                label: 'FamilyBlues',
                kind: 'number-list',
                placeholder: '0, 15, 500, 515',
                helperText:
                    'CFF FamilyBlues. Family-wide blue zones used to keep related fonts aligned.'
            },
            {
                key: 'cff_family_other_blues',
                label: 'FamilyOtherBlues',
                kind: 'number-list',
                placeholder: '-250, -235',
                helperText:
                    'CFF FamilyOtherBlues. Family-wide bottom zones as comma-separated numbers.'
            },
            {
                key: 'cff_stem_snap_h',
                label: 'StemSnapH',
                kind: 'number-list',
                placeholder: '80, 120',
                helperText:
                    'CFF StemSnapH. Preferred horizontal stem widths as comma-separated numbers.'
            },
            {
                key: 'cff_stem_snap_v',
                label: 'StemSnapV',
                kind: 'number-list',
                placeholder: '80, 120',
                helperText:
                    'CFF StemSnapV. Preferred vertical stem widths as comma-separated numbers.'
            }
        ]
    }
];

function formatDateTimeLocal(date?: Date | string): string {
    const normalizedDate =
        date instanceof Date
            ? date
            : typeof date === 'string'
              ? new Date(date)
              : null;

    if (!normalizedDate || Number.isNaN(normalizedDate.getTime())) {
        return '';
    }

    const pad = (value: number): string => value.toString().padStart(2, '0');

    return [
        `${normalizedDate.getFullYear()}-${pad(normalizedDate.getMonth() + 1)}-${pad(normalizedDate.getDate())}`,
        `${pad(normalizedDate.getHours())}:${pad(normalizedDate.getMinutes())}:${pad(normalizedDate.getSeconds())}`
    ].join('T');
}

function parseIntegerInput(rawValue: string): number | undefined | null {
    const trimmedValue = rawValue.trim();
    if (trimmedValue.length === 0) {
        return undefined;
    }

    const nextValue = Number(trimmedValue);
    if (!Number.isInteger(nextValue)) {
        return null;
    }

    return nextValue;
}

function parseNumericInput(rawValue: string): number | undefined | null {
    const trimmedValue = rawValue.trim();
    if (trimmedValue.length === 0) {
        return undefined;
    }

    const nextValue = Number(trimmedValue);
    if (!Number.isFinite(nextValue)) {
        return null;
    }

    return nextValue;
}

function parseDateTimeLocalInput(rawValue: string): Date | null {
    if (!rawValue) {
        return null;
    }

    const nextValue = new Date(rawValue);
    if (Number.isNaN(nextValue.getTime())) {
        return null;
    }

    return nextValue;
}

function parseNumberListInput(
    rawValue: string,
    exactLength?: number
): number[] | undefined | null {
    const trimmedValue = rawValue.trim();
    if (trimmedValue.length === 0) {
        return undefined;
    }

    const nextValue = trimmedValue
        .split(/[\s,]+/)
        .filter((token) => token.length > 0)
        .map((token) => Number(token));

    if (nextValue.some((value) => !Number.isFinite(value))) {
        return null;
    }

    if (exactLength !== undefined && nextValue.length !== exactLength) {
        return null;
    }

    return nextValue;
}

function formatNumberListValue(value?: number[] | null): string {
    if (!Array.isArray(value) || value.length === 0) {
        return '';
    }

    return value.join(', ');
}

function getLocalizedDictionarySummary(
    value: Babelfont.I18NDictionary | undefined,
    fallbackLabel: string
): string {
    const normalizedValue = normalizeLocalizedStringValue(value);

    return (
        normalizedValue.dflt ??
        normalizedValue.en ??
        Object.values(normalizedValue)[0] ??
        fallbackLabel
    );
}

function cloneNumericRecord(
    value?: Record<string, number>
): Record<string, number> | undefined {
    return value ? { ...value } : undefined;
}

function areNumericRecordsEqual(
    left?: Record<string, number>,
    right?: Record<string, number>
): boolean {
    const leftKeys = Object.keys(left ?? {});
    const rightKeys = Object.keys(right ?? {});

    if (leftKeys.length !== rightKeys.length) {
        return false;
    }

    return leftKeys.every((key) => left?.[key] === right?.[key]);
}

function getLocationKeys(
    axes: Babelfont.Axis[] | undefined,
    location?: Record<string, number>
): string[] {
    const axisTags = (axes ?? []).map((axis) => axis.tag);
    const extraTags = Object.keys(location ?? {}).filter(
        (tag) => !axisTags.includes(tag)
    );

    return [...axisTags, ...extraTags];
}

function getDisplayLocationPair(
    axes: Babelfont.Axis[] | undefined,
    location?: Record<string, number>
): {
    userspace: Record<string, number>;
    designspace: Record<string, number>;
} {
    const designspace = { ...(location ?? {}) };
    const convertedUserspace = axes?.length
        ? (designspaceToUserspace(
              designspace as Record<string, any>,
              axes
          ) as unknown as Record<string, number>)
        : designspace;
    const userspace: Record<string, number> = { ...convertedUserspace };

    for (const [tag, value] of Object.entries(designspace)) {
        if (userspace[tag] === undefined) {
            userspace[tag] = value;
        }
    }

    return {
        userspace,
        designspace
    };
}

function formatSingleLocationSummary(
    axes: Babelfont.Axis[] | undefined,
    userspace: Record<string, number> | undefined,
    designspace: Record<string, number> | undefined
): string {
    const keys = getLocationKeys(axes, userspace).filter(
        (key, index, allKeys) => allKeys.indexOf(key) === index
    );
    const extraDesignspaceKeys = getLocationKeys(axes, designspace).filter(
        (key) => !keys.includes(key)
    );
    const allKeys = [...keys, ...extraDesignspaceKeys];
    if (allKeys.length === 0) {
        return 'default';
    }

    const summary = allKeys
        .filter(
            (key) =>
                userspace?.[key] !== undefined ||
                designspace?.[key] !== undefined
        )
        .map((key) => {
            const userspaceValue = userspace?.[key];
            const designspaceValue = designspace?.[key];
            return `${key}:${userspaceValue ?? designspaceValue}/${designspaceValue ?? userspaceValue}`;
        })
        .join(', ');

    return summary || 'default';
}

function formatLocationSummary(
    axes: Babelfont.Axis[] | undefined,
    location?: Record<string, number>
): string[] {
    const { userspace, designspace } = getDisplayLocationPair(axes, location);

    return [formatSingleLocationSummary(axes, userspace, designspace)];
}

function asSummaryLines(summary: string | string[]): string[] {
    return Array.isArray(summary) ? summary : [summary];
}

/** Extract a plain-data deep clone from an array that may contain model-wrapper objects.
 * Calls toJSON() on each element (if available) via JSON.parse/stringify so that
 * cloneMasterRecord / cloneInstanceRecord always receive plain Babelfont data objects.
 */
function rawArray<T>(arr: T[] | undefined): T[] {
    return JSON.parse(JSON.stringify(arr ?? []));
}

function cloneKerningValue(value: unknown): unknown {
    if (value instanceof Map) {
        return new Map(value);
    }

    if (value && typeof value === 'object') {
        return { ...(value as Record<string, unknown>) };
    }

    return value;
}

function cloneMasterRecord(master: Babelfont.Master): Babelfont.Master {
    return {
        ...master,
        name: normalizeLocalizedStringValue(master.name),
        location: cloneNumericRecord(
            master.location as Record<string, number> | undefined
        ),
        metrics: cloneNumericRecord(master.metrics) ?? {},
        kerning: cloneKerningValue(master.kerning) as any,
        custom_ot_values: master.custom_ot_values
            ? ({
                  ...master.custom_ot_values
              } as Babelfont.CustomOTValues)
            : undefined
    };
}

function cloneAxisRecord(axis: Babelfont.Axis): Babelfont.Axis {
    return {
        ...axis,
        name: normalizeLocalizedStringValue(axis.name),
        map: axis.map
            ? axis.map.map(([u, d]) => [u, d] as [number, number])
            : undefined,
        values: axis.values ? [...axis.values] : undefined,
        format_specific: axis.format_specific
            ? { ...axis.format_specific }
            : undefined
    };
}

function cloneInstanceRecord(instance: Babelfont.Instance): Babelfont.Instance {
    return {
        ...instance,
        name: normalizeLocalizedStringValue(instance.name),
        location: cloneNumericRecord(
            instance.location as Record<string, number> | undefined
        ),
        custom_names: { ...(instance.custom_names ?? {}) }
    };
}

function cloneVersionValue(
    value?: [number, number]
): [number, number] | undefined {
    if (!Array.isArray(value) || value.length !== 2) {
        return undefined;
    }

    return [value[0], value[1]];
}

function cloneCustomOTFieldValue(value: unknown): unknown {
    return Array.isArray(value) ? [...value] : value;
}

function areCustomOTFieldValuesEqual(left: unknown, right: unknown): boolean {
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right)) {
            return false;
        }
        if (left.length !== right.length) {
            return false;
        }

        return left.every((item, index) => item === right[index]);
    }

    return left === right;
}

interface SelectedItem {
    type: FeatureItemType;
    key: string | number; // string for prefix/class, number (index) for feature
}

interface FeatureErrorSpanIssue {
    start: number;
    end: number;
    message: string;
    category: string;
    coordinateMode?: 'byte' | 'codeUnit';
}

interface SidebarFeatureErrorTarget {
    type: 'prefix' | 'class' | 'feature';
    key: string | number;
    message: string;
}

type FeatureHistoryScopeTarget = {
    type: FeatureItemType;
    key: string;
    label: string;
};

interface FeatureErrorLocation {
    type: 'prefix' | 'class' | 'feature';
    label: string;
}

interface FeatureSourceBlock {
    type: 'prefix' | 'class' | 'feature';
    key: string | number;
    code: string;
    globalByteStart: number;
    globalByteEnd: number;
    codeByteStart: number;
    globalCodeUnitStart: number;
    globalCodeUnitEnd: number;
    codeUnitStart: number;
}

interface ResolvedFeatureSpanTarget {
    target: FeatureSourceBlock;
    coordinateMode: 'byte' | 'codeUnit';
    normalizedStart: number;
    normalizedEnd: number;
}

class FontInfoManager {
    private currentTab: FontInfoTab = 'names';
    private generalTab: HTMLElement | null = null;
    private namesTab: HTMLElement | null = null;
    private mastersTab: HTMLElement | null = null;
    private instancesTab: HTMLElement | null = null;
    private axesTab: HTMLElement | null = null;
    private customOTValuesTab: HTMLElement | null = null;
    private featuresTab: HTMLElement | null = null;
    private generalFieldsContainer: HTMLElement | null = null;
    private namesFieldsContainer: HTMLElement | null = null;
    private mastersFieldsContainer: HTMLElement | null = null;
    private instancesFieldsContainer: HTMLElement | null = null;
    private axesFieldsContainer: HTMLElement | null = null;
    private customOTValuesFieldsContainer: HTMLElement | null = null;
    private namesFieldEditors: Map<
        FontNameFieldKey,
        LocalizedStringEditorHandle
    > = new Map();
    private sectionMenuInstance: TippyInstance | null = null;
    private sectionButton: HTMLButtonElement | null = null;
    private generalDataLoaded = false;
    private pendingGeneralModelSyncRefresh = false;
    private namesDataLoaded = false;
    private pendingNamesModelSyncRefresh = false;
    private mastersDataLoaded = false;
    private pendingMastersModelSyncRefresh = false;
    private instancesDataLoaded = false;
    private pendingInstancesModelSyncRefresh = false;
    private axesDataLoaded = false;
    private pendingAxesModelSyncRefresh = false;
    private customOTValuesDataLoaded = false;
    private pendingCustomOTValuesModelSyncRefresh = false;
    private selectedMasterIndex = 0;
    private selectedInstanceIndex = 0;
    private selectedAxisIndex = 0;
    private selectedMasterIndices: Set<number> = new Set([0]);
    private selectedInstanceIndices: Set<number> = new Set([0]);
    private selectedAxisIndices: Set<number> = new Set([0]);
    private _deleteConfirmationHandler: boolean | null = null;
    private renderedMasterListSignature = '';
    private renderedInstanceListSignature = '';
    private renderedAxisListSignature = '';
    private draggedMasterIndex: number | null = null;
    private masterDragCommitted = false;
    private masterDropTargetIndex: number | null = null;
    private masterDropTargetPlacement: RecordDropPlacement | null = null;
    private draggedInstanceIndex: number | null = null;
    private instanceDragCommitted = false;
    private instanceDropTargetIndex: number | null = null;
    private instanceDropTargetPlacement: RecordDropPlacement | null = null;
    private draggedAxisIndex: number | null = null;
    private axisDragCommitted = false;
    private axisDropTargetIndex: number | null = null;
    private axisDropTargetPlacement: RecordDropPlacement | null = null;
    private featuresEditor: any = null;
    private featuresEditorInitialized = false;
    private suppressFeatureEditorChange = false;
    private selectedItem: SelectedItem | null = null;
    private selectedFeatureTag: string | null = null;
    private prefixListItems: Map<string, HTMLElement> = new Map();
    private classListItems: Map<string, HTMLElement> = new Map();
    private featureListItems: Map<number, HTMLElement> = new Map();
    private fontDataLoaded = false;
    private selectedShaper: string = 'default';
    private draggedFeatureIndex: number | null = null;
    private featureDropTargetIndex: number | null = null;
    private featureDropTargetPlacement: 'before' | 'after' | null = null;
    private featureCodeDirty = false;

    // Search-related properties
    private searchInput: HTMLInputElement | null = null;
    private searchTerms: string[] = [];
    private prefixCodeData: Map<string, string> = new Map();
    private classCodeData: Map<string, string> = new Map();
    private featureCodeData: Map<number, { tag: string; code: string }> =
        new Map();
    private searchMarkers: number[] = [];
    private classGlyphMembers: Map<string, Set<string>> = new Map();
    private resizeObserver: ResizeObserver | null = null;
    private featureErrorMarkerId: number | null = null;
    private featureErrorTextMarkerId: number | null = null;
    private featureErrorLineWidget: any = null;
    private aceLineWidgetsCtor: any = null;
    private featureErrorTarget: SidebarFeatureErrorTarget | null = null;
    private featureErrorIssue: FeatureErrorSpanIssue | null = null;
    private pendingModelSyncRefresh = false;
    private featureCodeCommitDebounceTimer: number | null = null;

    init() {
        const viewContent = document.querySelector(
            '#view-fontinfo .view-content'
        );
        if (!viewContent) {
            console.error('Font info view content not found');
            return;
        }

        // Create section selector in title bar
        this.createSectionPicker();

        // Initialize search for features tab
        this.initFeaturesSearch();

        // Create content containers
        this.createContentContainers(viewContent as HTMLElement);

        // Show saved or default tab (defer to ensure DOM is ready)
        const savedTab = this.getSavedTab();
        requestAnimationFrame(() => {
            this.switchTab(savedTab);
        });

        // Listen for new font models immediately so stale content clears as
        // soon as the replacement font is installed, not after startup gates.
        window.addEventListener('fontModelReady', () => this.onFontLoaded());
        window.addEventListener('fontModelSync', () =>
            this.onFontModelSynced()
        );

        // Set up ResizeObserver to resize the Ace editor continuously during dragging
        this.setupResizeObserver();

        const fontInfoView = document.getElementById('view-fontinfo');
        if (fontInfoView) {
            attachTopRowSidebarInterpolation(fontInfoView);
        }

        // Set up keyboard navigation for feature editor
        this.setupKeyboardNavigation();

        console.log('[FontInfo] Initialized');
    }

    private isViewActive(): boolean {
        const fontInfoView = document.querySelector('#view-fontinfo');
        return fontInfoView?.classList.contains('focused') ?? false;
    }

    private setupResizeObserver() {
        const fontInfoView = document.querySelector('#view-fontinfo');
        if (!fontInfoView) return;

        this.resizeObserver = new ResizeObserver(() => {
            if (this.featuresEditor) {
                this.featuresEditor.resize();
                this.refreshFeatureErrorLineWidgetLayout();
            }
        });

        this.resizeObserver.observe(fontInfoView);
    }

    private setupKeyboardNavigation() {
        document.addEventListener('keydown', (e: KeyboardEvent) => {
            // Only handle arrow keys when font info view is active and features tab is visible
            if (!this.isViewActive()) return;
            if (this.currentTab !== 'features') return;
            if (!this.featuresTab || this.featuresTab.style.display === 'none')
                return;

            // Don't handle if Ace editor has focus
            if (this.featuresEditor && this.featuresEditor.isFocused()) return;

            // Don't handle if focus is in an input or textarea
            const activeElement = document.activeElement;
            if (
                activeElement &&
                (activeElement.tagName === 'INPUT' ||
                    activeElement.tagName === 'TEXTAREA' ||
                    activeElement.getAttribute('contenteditable') === 'true')
            ) {
                return;
            }

            if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.navigateSidebar('up');
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.navigateSidebar('down');
            }
        });
    }

    private getAllSidebarItems(): HTMLElement[] {
        // Get all feature-list-item elements in DOM order (prefixes, then classes, then features)
        if (!this.featuresTab) return [];
        return Array.from(
            this.featuresTab.querySelectorAll('.feature-list-item')
        );
    }

    private navigateSidebar(direction: 'up' | 'down') {
        const items = this.getAllSidebarItems();
        if (items.length === 0) return;

        // Find currently selected item
        let currentIndex = -1;
        if (this.selectedItem) {
            const selectedElement =
                this.selectedItem.type === 'prefix'
                    ? this.prefixListItems.get(this.selectedItem.key as string)
                    : this.selectedItem.type === 'class'
                      ? this.classListItems.get(this.selectedItem.key as string)
                      : this.featureListItems.get(
                            this.selectedItem.key as number
                        );

            if (selectedElement) {
                currentIndex = items.indexOf(selectedElement);
            }
        }

        // Calculate new index
        let newIndex: number;
        if (direction === 'up') {
            newIndex = currentIndex - 1;
            // Don't wrap - stop at top
            if (newIndex < 0) return;
        } else {
            newIndex = currentIndex + 1;
            // Don't wrap - stop at bottom
            if (newIndex >= items.length) return;
        }

        // Get the target item and find its type and key
        const targetItem = items[newIndex];
        if (!targetItem) return;

        // Find the type and key from the stored maps
        let targetType: FeatureItemType | null = null;
        let targetKey: string | number | null = null;

        // Check prefix map
        for (const [key, element] of this.prefixListItems.entries()) {
            if (element === targetItem) {
                targetType = 'prefix';
                targetKey = key;
                break;
            }
        }

        // Check class map
        if (!targetType) {
            for (const [key, element] of this.classListItems.entries()) {
                if (element === targetItem) {
                    targetType = 'class';
                    targetKey = key;
                    break;
                }
            }
        }

        // Check feature map
        if (!targetType) {
            for (const [key, element] of this.featureListItems.entries()) {
                if (element === targetItem) {
                    targetType = 'feature';
                    targetKey = key;
                    break;
                }
            }
        }

        if (targetType && targetKey !== null) {
            this.selectItem(targetType, targetKey, true);
        }
    }

    private getSavedTab(): FontInfoTab {
        const saved = getFontInfoSection();
        if (
            saved === 'general' ||
            saved === 'names' ||
            saved === 'axes' ||
            saved === 'masters' ||
            saved === 'instances' ||
            saved === 'custom_ot_values' ||
            saved === 'features'
        ) {
            return saved;
        }
        return 'names'; // Default to names tab
    }

    private getCurrentSectionConfig(): FontInfoSectionConfig {
        return (
            FONTINFO_SECTIONS.find(
                (section) => section.id === this.currentTab
            ) ?? FONTINFO_SECTIONS[0]
        );
    }

    private createSectionMenuHtml(): string {
        const currentSection = this.getCurrentSectionConfig();

        return `
            <div class="plugin-menu" tabindex="0" role="menu" aria-label="Font info sections">
                ${FONTINFO_SECTIONS.map((section) => {
                    const isActive = section.id === currentSection.id;
                    return `
                        <div class="plugin-menu-item" data-section="${section.id}" role="menuitemradio" aria-checked="${isActive}" tabindex="-1">
                            <span class="plugin-menu-check material-symbols-outlined${isActive ? '' : ' empty'}">${isActive ? 'check' : ''}</span>
                            <span>${section.label}</span>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }

    private refreshSectionPicker() {
        const currentSection = this.getCurrentSectionConfig();
        const searchControl = document.getElementById(
            'fontinfo-search-control'
        );
        const buttonLabel = this.sectionButton?.querySelector(
            '.fontinfo-section-button-label'
        );

        if (buttonLabel) {
            buttonLabel.textContent = currentSection.label;
        }

        if (this.sectionMenuInstance) {
            this.sectionMenuInstance.setContent(this.createSectionMenuHtml());
        }

        if (searchControl) {
            searchControl.style.display = currentSection.usesSearch
                ? ''
                : 'none';
        }
    }

    private createSectionPicker() {
        const titleBar = document.querySelector(
            '#view-fontinfo .view-title-bar'
        );
        if (!titleBar) return;

        // Create view-title-right container if it doesn't exist
        let titleBarRight = titleBar.querySelector(
            '.view-title-right'
        ) as HTMLElement;
        if (!titleBarRight) {
            titleBarRight = document.createElement('div');
            titleBarRight.className = 'view-title-right';
            titleBar.appendChild(titleBarRight);
        }

        titleBarRight.querySelector('.fontinfo-section-button')?.remove();

        this.sectionButton = document.createElement('button');
        this.sectionButton.type = 'button';
        this.sectionButton.className =
            'view-title-button fontinfo-section-button';
        this.sectionButton.innerHTML = `
            <span class="fontinfo-section-button-label">Names</span>
            <span class="material-symbols-outlined">expand_more</span>
        `;
        titleBarRight.insertBefore(
            this.sectionButton,
            titleBarRight.firstChild
        );

        const backdrop = getOrCreateBackdrop('fontinfo-section-menu-backdrop');
        const tippyResult = tippy(this.sectionButton, {
            content: this.createSectionMenuHtml(),
            allowHTML: true,
            interactive: true,
            trigger: 'manual',
            theme: getTheme(),
            placement: 'bottom-end',
            arrow: false,
            offset: [0, 4],
            appendTo: document.body,
            hideOnClick: false,
            zIndex: 9999,
            onCreate: (instance) => {
                instance.popper.addEventListener('click', (event) => {
                    const item = (event.target as HTMLElement).closest(
                        '.plugin-menu-item'
                    );
                    const nextSection = item?.getAttribute(
                        'data-section'
                    ) as FontInfoTab | null;
                    if (!nextSection) {
                        return;
                    }
                    instance.hide();
                    this.switchTab(nextSection);
                });
            },
            onShown: (instance) => {
                const menu = instance.popper.querySelector('.plugin-menu');
                if (menu) {
                    setupMenuKeyboardNav(menu);
                }
            }
        });

        this.sectionMenuInstance = Array.isArray(tippyResult)
            ? (tippyResult[0] ?? null)
            : tippyResult;

        if (this.sectionMenuInstance) {
            addTippyBackdropSupport(this.sectionMenuInstance, backdrop, {
                targetElement: this.sectionButton,
                activeClass: 'fontinfo-section-button-active'
            });
        }

        this.sectionButton.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();

            if (this.sectionMenuInstance?.state.isVisible) {
                this.sectionMenuInstance.hide();
            } else {
                this.refreshSectionPicker();
                this.sectionMenuInstance?.show();
            }
        });

        this.refreshSectionPicker();
    }

    private initFeaturesSearch() {
        // Find search input in DOM
        this.searchInput = document.getElementById(
            'fontinfo-search-input'
        ) as HTMLInputElement;

        if (this.searchInput) {
            // Listen for input changes
            this.searchInput.addEventListener('input', (e) => {
                const value = (e.target as HTMLInputElement).value.trim();
                this.searchTerms = value
                    .split(/\s+/)
                    .filter((term) => term.length > 0)
                    .map((term) => term.toLowerCase());
                this.applyFeaturesSearch();
            });

            // Listen for keyboard shortcut (Cmd+F)
            document.addEventListener('keydown', (e) => {
                if (
                    (e.metaKey || e.ctrlKey) &&
                    e.key === 'f' &&
                    this.isViewActive() &&
                    this.currentTab === 'features'
                ) {
                    e.preventDefault();
                    if (this.searchInput) {
                        this.searchInput.focus();
                        this.searchInput.select();
                    }
                }

                // Escape key clears selection and filters
                if (
                    e.key === 'Escape' &&
                    this.isViewActive() &&
                    this.currentTab === 'features'
                ) {
                    // Only handle if search input is focused or there's an active selection
                    if (
                        this.searchInput &&
                        this.searchInput === document.activeElement
                    ) {
                        this.searchInput.blur();
                    }
                    if (this.searchTerms.length > 0) {
                        this.searchTerms = [];
                        if (this.searchInput) {
                            this.searchInput.value = '';
                        }
                        this.applyFeaturesSearch();
                    }
                }
            });
        }
    }

    private applyFeaturesSearch() {
        if (!this.featuresTab) return;

        // Get the three list containers
        const prefixesList = document.getElementById('prefixes-list');
        const classesList = document.getElementById('classes-list');
        const featuresList = document.getElementById('features-list');

        // Track visibility of sections
        let hasVisiblePrefixes = false;
        let hasVisibleClasses = false;
        let hasVisibleFeatures = false;

        // Filter prefixes
        if (prefixesList) {
            this.prefixListItems.forEach((element, key) => {
                let visible = true;
                if (this.searchTerms.length > 0) {
                    const codeData = this.prefixCodeData.get(key);
                    const searchText = (
                        key +
                        ' ' +
                        (codeData || '')
                    ).toLowerCase();
                    visible = this.searchTerms.every((term) =>
                        searchText.includes(term)
                    );
                }
                element.style.display = visible ? '' : 'none';
                if (visible) hasVisiblePrefixes = true;
            });
        }

        // Helper function to check if any search term matches a glyph name
        const termMatchesGlyph = (glyphName: string): boolean => {
            const glyphLower = glyphName.toLowerCase();
            return this.searchTerms.every((term) => glyphLower.includes(term));
        };

        // Find all classes that contain matching glyphs (recursively)
        const matchingClasses = new Set<string>();
        if (this.searchTerms.length > 0) {
            this.classGlyphMembers.forEach((_, className) => {
                const allGlyphs = this.getAllGlyphsInClass(className);
                for (const glyph of allGlyphs) {
                    if (termMatchesGlyph(glyph)) {
                        matchingClasses.add(className);
                        break;
                    }
                }
            });
        }

        // Filter classes
        if (classesList) {
            this.classListItems.forEach((element, key) => {
                let visible = true;
                if (this.searchTerms.length > 0) {
                    const codeData = this.classCodeData.get(key);
                    // Check: direct match in name/code OR class contains matching glyph
                    const directMatch = (
                        key +
                        ' ' +
                        (codeData || '')
                    ).toLowerCase();
                    const hasDirectMatch = this.searchTerms.every((term) =>
                        directMatch.includes(term)
                    );
                    const hasMatchingGlyph = matchingClasses.has(key);
                    visible = hasDirectMatch || hasMatchingGlyph;
                }
                element.style.display = visible ? '' : 'none';
                if (visible) hasVisibleClasses = true;
            });
        }

        // Filter features
        if (featuresList) {
            this.featureListItems.forEach((element, key) => {
                let visible = true;
                if (this.searchTerms.length > 0) {
                    const codeData = this.featureCodeData.get(key);
                    const searchText = codeData
                        ? (
                              codeData.tag +
                              ' ' +
                              (codeData.code || '')
                          ).toLowerCase()
                        : '';
                    // Check: direct match in tag/code OR feature references a matching class
                    const hasDirectMatch = this.searchTerms.every((term) =>
                        searchText.includes(term)
                    );
                    // Check if feature references any class that contains matching glyphs
                    let referencesMatchingClass = false;
                    if (codeData?.code) {
                        for (const className of matchingClasses) {
                            const classRef = '@' + className;
                            if (codeData.code.includes(classRef)) {
                                referencesMatchingClass = true;
                                break;
                            }
                        }
                    }
                    visible = hasDirectMatch || referencesMatchingClass;
                }
                element.style.display = visible ? '' : 'none';
                if (visible) hasVisibleFeatures = true;
            });

            // Hide section separators that don't have any visible features
            if (this.searchTerms.length > 0) {
                const allChildren = Array.from(featuresList.children);
                let currentSeparator: Element | null = null;
                let hasVisibleFeatureInSection = false;

                allChildren.forEach((child) => {
                    if (child.classList.contains('feature-section-separator')) {
                        // Hide previous separator if no visible features in its section
                        if (currentSeparator && !hasVisibleFeatureInSection) {
                            (currentSeparator as HTMLElement).style.display =
                                'none';
                        }
                        currentSeparator = child;
                        hasVisibleFeatureInSection = false;
                    } else if (child.classList.contains('feature-list-item')) {
                        if ((child as HTMLElement).style.display !== 'none') {
                            hasVisibleFeatureInSection = true;
                        }
                    }
                });

                // Handle the last separator
                if (currentSeparator && !hasVisibleFeatureInSection) {
                    (currentSeparator as HTMLElement).style.display = 'none';
                }
            } else {
                // Show all separators when no search
                const separators = featuresList.querySelectorAll(
                    '.feature-section-separator'
                );
                separators.forEach((sep: Element) => {
                    (sep as HTMLElement).style.display = '';
                });
            }
        }

        // Show/hide section titles based on whether they have visible items
        const sidebar = this.featuresTab.querySelector('.features-sidebar');
        if (sidebar) {
            const sectionTitles = sidebar.querySelectorAll(
                '.sidebar-section-title'
            );
            sectionTitles.forEach((title: Element, index: number) => {
                let hasVisibleItems = false;
                if (index === 0) hasVisibleItems = hasVisiblePrefixes;
                else if (index === 1) hasVisibleItems = hasVisibleClasses;
                else if (index === 2) hasVisibleItems = hasVisibleFeatures;

                (title as HTMLElement).style.display =
                    hasVisibleItems || this.searchTerms.length === 0
                        ? ''
                        : 'none';
            });
        }

        // Update search highlighting in editor
        this.highlightSearchTermsInEditor();
    }

    private highlightSearchTermsInEditor() {
        if (!this.featuresEditor) return;

        // Clear existing markers
        this.searchMarkers.forEach((id) =>
            this.featuresEditor.session.removeMarker(id)
        );
        this.searchMarkers = [];

        // If no search terms, don't add any markers
        if (this.searchTerms.length === 0) return;

        // Get the Range class from Ace
        const Range = window.ace.require('ace/range').Range;
        const content = this.featuresEditor.getValue();

        // Find and highlight each occurrence of each search term
        this.searchTerms.forEach((term) => {
            // Escape special regex characters in the search term
            const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(escapedTerm, 'gi');
            let match;

            while ((match = regex.exec(content)) !== null) {
                const startPos =
                    this.featuresEditor.session.doc.indexToPosition(
                        match.index
                    );
                const endPos = this.featuresEditor.session.doc.indexToPosition(
                    match.index + match[0].length
                );
                const range = new Range(
                    startPos.row,
                    startPos.column,
                    endPos.row,
                    endPos.column
                );
                const markerId = this.featuresEditor.session.addMarker(
                    range,
                    'ace_search_highlight',
                    'text'
                );
                this.searchMarkers.push(markerId);
            }
        });

        // Also highlight class names that contain matching glyphs
        this.classGlyphMembers.forEach((members, className) => {
            const allGlyphs = this.getAllGlyphsInClass(className);
            const hasMatchingGlyph = Array.from(allGlyphs).some((glyph) => {
                const glyphLower = glyph.toLowerCase();
                return this.searchTerms.every((term) =>
                    glyphLower.includes(term)
                );
            });

            if (hasMatchingGlyph) {
                // Highlight class name references (@ClassName)
                const classRefPattern = new RegExp(
                    '@' + className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
                    'g'
                );
                let match;
                while ((match = classRefPattern.exec(content)) !== null) {
                    const startPos =
                        this.featuresEditor.session.doc.indexToPosition(
                            match.index
                        );
                    const endPos =
                        this.featuresEditor.session.doc.indexToPosition(
                            match.index + match[0].length
                        );
                    const range = new Range(
                        startPos.row,
                        startPos.column,
                        endPos.row,
                        endPos.column
                    );
                    const markerId = this.featuresEditor.session.addMarker(
                        range,
                        'ace_search_highlight',
                        'text'
                    );
                    this.searchMarkers.push(markerId);
                }
            }
        });

        // Highlight individual glyph names within class definitions
        const classDefPattern = /@(\w+)\s*=\s*\[([\s\S]*?)\]/g;
        let classDefMatch;
        while ((classDefMatch = classDefPattern.exec(content)) !== null) {
            const className = classDefMatch[1];
            const classContent = classDefMatch[2];
            const classStartIndex =
                classDefMatch.index + classDefMatch[0].indexOf('[') + 1;

            // Check if this class contains matching glyphs
            const allGlyphs = this.getAllGlyphsInClass(className);
            const matchingGlyphs = Array.from(allGlyphs).filter((glyph) => {
                const glyphLower = glyph.toLowerCase();
                return this.searchTerms.every((term) =>
                    glyphLower.includes(term)
                );
            });

            if (matchingGlyphs.length > 0) {
                // Highlight each matching glyph within the class definition
                matchingGlyphs.forEach((glyph) => {
                    const glyphPattern = new RegExp(
                        '(?:(?<=\\s)|(?<=\\[))' +
                            glyph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
                            '(?:(?=\\s)|(?=\\]))',
                        'g'
                    );
                    let glyphMatch;
                    while (
                        (glyphMatch = glyphPattern.exec(classContent)) !== null
                    ) {
                        const absoluteIndex =
                            classStartIndex + glyphMatch.index;
                        const startPos =
                            this.featuresEditor.session.doc.indexToPosition(
                                absoluteIndex
                            );
                        const endPos =
                            this.featuresEditor.session.doc.indexToPosition(
                                absoluteIndex + glyphMatch[0].length
                            );
                        const range = new Range(
                            startPos.row,
                            startPos.column,
                            endPos.row,
                            endPos.column
                        );
                        const markerId = this.featuresEditor.session.addMarker(
                            range,
                            'ace_search_highlight',
                            'text'
                        );
                        this.searchMarkers.push(markerId);
                    }
                });
            }
        }
    }

    private clearFeatureErrorMarker() {
        if (
            !this.featuresEditor ||
            (this.featureErrorMarkerId === null &&
                this.featureErrorTextMarkerId === null)
        ) {
            return;
        }

        if (this.featureErrorMarkerId !== null) {
            try {
                this.featuresEditor.session.removeMarker(
                    this.featureErrorMarkerId
                );
            } catch (e) {
                console.warn(
                    '[FontInfo] Failed to remove feature error line marker:',
                    e
                );
            }
        }

        if (this.featureErrorTextMarkerId !== null) {
            try {
                this.featuresEditor.session.removeMarker(
                    this.featureErrorTextMarkerId
                );
            } catch (e) {
                console.warn(
                    '[FontInfo] Failed to remove feature error text marker:',
                    e
                );
            }
        }

        this.featureErrorMarkerId = null;
        this.featureErrorTextMarkerId = null;
        this.clearFeatureErrorLineWidget();
    }

    private isFeatureErrorTarget(
        type: FeatureItemType,
        key: string | number
    ): boolean {
        return (
            !!this.featureErrorTarget &&
            this.featureErrorTarget.type === type &&
            this.featureErrorTarget.key === key
        );
    }

    private utf8ByteLength(text: string): number {
        return new TextEncoder().encode(text).length;
    }

    private utf8ByteOffsetToCodeUnitIndex(
        text: string,
        byteOffset: number
    ): number {
        if (byteOffset <= 0) {
            return 0;
        }

        let byteCount = 0;
        let codeUnitIndex = 0;

        for (const char of text) {
            const charByteLen = this.utf8ByteLength(char);
            if (byteCount + charByteLen > byteOffset) {
                break;
            }
            byteCount += charByteLen;
            codeUnitIndex += char.length;
        }

        return codeUnitIndex;
    }

    private buildFeatureSourceBlocks(): FeatureSourceBlock[] {
        const font = window.currentFontModel;
        if (!font?.features) {
            return [];
        }

        const blocks: FeatureSourceBlock[] = [];
        let byteCursor = 0;
        let codeUnitCursor = 0;

        const classes = font.features.classes || {};
        Object.entries(classes).forEach(([className, codeData]) => {
            const code = codeData?.code || '';
            const prefix = `@${className} = [`;
            const suffix = `];\n`;
            const blockText = `${prefix}${code}${suffix}`;
            const blockByteLen = this.utf8ByteLength(blockText);
            const blockCodeUnitLen = blockText.length;

            blocks.push({
                type: 'class',
                key: className,
                code,
                globalByteStart: byteCursor,
                globalByteEnd: byteCursor + blockByteLen,
                codeByteStart: this.utf8ByteLength(prefix),
                globalCodeUnitStart: codeUnitCursor,
                globalCodeUnitEnd: codeUnitCursor + blockCodeUnitLen,
                codeUnitStart: prefix.length
            });

            byteCursor += blockByteLen;
            codeUnitCursor += blockCodeUnitLen;
        });

        const prefixes = font.features.prefixes || {};
        Object.entries(prefixes).forEach(([prefixName, codeData]) => {
            const code = codeData?.code || '';
            const header =
                prefixName !== 'anonymous' ? `# Prefix: ${prefixName}\n` : '';
            const suffix = `\n`;
            const blockText = `${header}${code}${suffix}`;
            const blockByteLen = this.utf8ByteLength(blockText);
            const blockCodeUnitLen = blockText.length;

            blocks.push({
                type: 'prefix',
                key: prefixName,
                code,
                globalByteStart: byteCursor,
                globalByteEnd: byteCursor + blockByteLen,
                codeByteStart: this.utf8ByteLength(header),
                globalCodeUnitStart: codeUnitCursor,
                globalCodeUnitEnd: codeUnitCursor + blockCodeUnitLen,
                codeUnitStart: header.length
            });

            byteCursor += blockByteLen;
            codeUnitCursor += blockCodeUnitLen;
        });

        const features = font.features.features || [];
        features.forEach(([featureTag, codeData], featureIndex) => {
            const code = codeData?.code || '';
            const head = `feature ${featureTag} {\n`;
            const tail = `\n} ${featureTag};\n`;
            const blockText = `${head}${code}${tail}`;
            const blockByteLen = this.utf8ByteLength(blockText);
            const blockCodeUnitLen = blockText.length;

            blocks.push({
                type: 'feature',
                key: featureIndex,
                code,
                globalByteStart: byteCursor,
                globalByteEnd: byteCursor + blockByteLen,
                codeByteStart: this.utf8ByteLength(head),
                globalCodeUnitStart: codeUnitCursor,
                globalCodeUnitEnd: codeUnitCursor + blockCodeUnitLen,
                codeUnitStart: head.length
            });

            byteCursor += blockByteLen;
            codeUnitCursor += blockCodeUnitLen;
        });

        return blocks;
    }

    private addFeatureErrorIcon(item: HTMLElement, message: string) {
        const existingIcon = item.querySelector('.feature-error-icon');
        if (existingIcon) {
            existingIcon.remove();
        }

        const errorIcon = document.createElement('span');
        errorIcon.className = 'material-symbols-outlined feature-error-icon';
        errorIcon.textContent = 'warning';
        errorIcon.title = message || 'Feature compilation error';
        item.appendChild(errorIcon);
    }

    private refreshFeatureErrorIconInSidebar() {
        const allItems = [
            ...this.prefixListItems.values(),
            ...this.featureListItems.values(),
            ...this.classListItems.values()
        ];

        allItems.forEach((item) => {
            const icon = item.querySelector('.feature-error-icon');
            if (icon) {
                icon.remove();
            }
        });

        if (!this.featureErrorTarget) {
            return;
        }

        const targetElement =
            this.featureErrorTarget.type === 'prefix'
                ? this.prefixListItems.get(
                      this.featureErrorTarget.key as string
                  )
                : this.featureErrorTarget.type === 'class'
                  ? this.classListItems.get(
                        this.featureErrorTarget.key as string
                    )
                  : this.featureListItems.get(
                        this.featureErrorTarget.key as number
                    );

        if (targetElement) {
            this.addFeatureErrorIcon(
                targetElement,
                this.featureErrorTarget.message
            );
        }
    }

    private setFeatureErrorLineWidget(row: number, text: string) {
        if (!this.featuresEditor) {
            return;
        }

        const LineWidgets = this.getAceLineWidgetsCtor();
        if (!LineWidgets) {
            console.warn('[FontInfo] Ace ext/line_widgets not available');
            return;
        }

        const session = this.featuresEditor.session;
        if (!session.widgetManager) {
            session.widgetManager = new LineWidgets(session);
            session.widgetManager.attach(this.featuresEditor);
        }

        this.clearFeatureErrorLineWidget();

        const node = document.createElement('div');
        node.className = 'feature-error-line-widget';
        node.textContent = text;

        this.featureErrorLineWidget = {
            row,
            el: node,
            fixedWidth: true,
            coverGutter: false
        };

        session.widgetManager.addLineWidget(this.featureErrorLineWidget);
        this.refreshFeatureErrorLineWidgetLayout();
    }

    private refreshFeatureErrorLineWidgetLayout() {
        if (!this.featuresEditor || !this.featureErrorLineWidget?.el) {
            return;
        }

        const scroller = this.featuresEditor.renderer?.scroller as
            HTMLElement | undefined;
        const manager = this.featuresEditor.session?.widgetManager;
        if (!scroller || !manager) {
            return;
        }

        const horizontalPadding = 36;
        const maxWidth = Math.max(
            120,
            scroller.clientWidth - horizontalPadding
        );
        const widgetEl = this.featureErrorLineWidget.el as HTMLElement;
        widgetEl.style.width = `${maxWidth}px`;

        if (typeof manager.onWidgetChanged === 'function') {
            manager.onWidgetChanged(this.featureErrorLineWidget);
        }
    }

    private getAceLineWidgetsCtor(): any {
        if (this.aceLineWidgetsCtor) {
            return this.aceLineWidgetsCtor;
        }

        const moduleIds = ['ace/line_widgets', 'ace/ext/line_widgets'];
        for (const moduleId of moduleIds) {
            try {
                const module = window.ace?.require?.(moduleId);
                if (module?.LineWidgets) {
                    this.aceLineWidgetsCtor = module.LineWidgets;
                    return this.aceLineWidgetsCtor;
                }
            } catch {
                // Try next module id
            }
        }

        return null;
    }

    private clearFeatureErrorLineWidget() {
        if (!this.featuresEditor || !this.featureErrorLineWidget) {
            this.featureErrorLineWidget = null;
            return;
        }

        const session = this.featuresEditor.session;
        if (!session?.widgetManager) {
            this.featureErrorLineWidget = null;
            return;
        }

        try {
            session.widgetManager.removeLineWidget(this.featureErrorLineWidget);
        } catch (e) {
            console.warn(
                '[FontInfo] Failed to remove feature error widget:',
                e
            );
        }

        this.featureErrorLineWidget = null;
    }

    clearFeatureErrorHighlight() {
        this.clearFeatureErrorMarker();
        this.featureErrorTarget = null;
        this.featureErrorIssue = null;
        this.refreshFeatureErrorIconInSidebar();
    }

    getFeatureCompilationErrorLocation(
        errorInput: unknown
    ): FeatureErrorLocation | null {
        const details = this.getFeatureCompilationErrorDetails(errorInput);
        if (!details || !details.type) {
            return null;
        }

        return {
            type: details.type,
            label: details.label
        };
    }

    getFeatureCompilationErrorDetails(errorInput: unknown): {
        type: 'prefix' | 'class' | 'feature' | null;
        label: string;
        message: string;
    } | null {
        const issue = this.extractFeatureSpanIssue(errorInput);
        if (!issue) {
            return null;
        }

        const resolved = this.resolveFeatureSpanTarget(
            issue.start,
            issue.end,
            issue.message
        );
        const target = resolved?.target || null;

        if (!target) {
            return {
                type: null,
                label: 'feature code',
                message: issue.message
            };
        }

        return {
            type: target.type,
            label: this.getFeatureTargetLabel(target.type, target.key),
            message: issue.message
        };
    }

    showFeatureCompilationError(errorInput: unknown) {
        const issue = this.extractFeatureSpanIssue(errorInput);
        if (!issue) {
            this.clearFeatureErrorHighlight();
            return;
        }

        const resolved = this.resolveFeatureSpanTarget(
            issue.start,
            issue.end,
            issue.message
        );
        const target = resolved?.target || null;
        if (!target) {
            this.featureErrorIssue = issue;
            this.featureErrorTarget = null;
            this.clearFeatureErrorMarker();
            this.refreshFeatureErrorIconInSidebar();
            return;
        }

        issue.start = resolved!.normalizedStart;
        issue.end = resolved!.normalizedEnd;
        issue.coordinateMode = resolved!.coordinateMode;

        this.featureErrorTarget = {
            type: target.type,
            key: target.key,
            message: `${issue.category}: ${issue.message}`
        };
        this.featureErrorIssue = issue;
        this.refreshFeatureErrorIconInSidebar();

        if (!this.featuresEditorInitialized) {
            this.initializeFeaturesEditor();
            this.featuresEditorInitialized = true;
        }

        if (window.currentFontModel && !this.fontDataLoaded) {
            this.loadAllLists();
            this.fontDataLoaded = true;
        }

        this.updateFeatureErrorDisplayForSelection();

        console.log(
            '[FontInfo] Feature compilation span resolved:',
            issue,
            '->',
            target
        );
    }

    openFeatureCompilationError(errorInput: unknown) {
        this.showFeatureCompilationError(errorInput);

        if (!this.featureErrorIssue || !this.featureErrorTarget) {
            return;
        }

        if (typeof window.focusView === 'function') {
            window.focusView('view-fontinfo');
        }

        this.switchTab('features');
        this.selectItem(
            this.featureErrorTarget.type,
            this.featureErrorTarget.key,
            true
        );

        const resolved = this.resolveFeatureSpanTarget(
            this.featureErrorIssue.start,
            this.featureErrorIssue.end,
            this.featureErrorIssue.message
        );
        const target = resolved?.target || null;
        if (!target || !this.featuresEditor) {
            return;
        }

        const coordinateMode =
            this.featureErrorIssue.coordinateMode || resolved?.coordinateMode;

        const localCodeUnitStartIndex =
            coordinateMode === 'codeUnit'
                ? Math.max(
                      0,
                      Math.min(
                          target.code.length,
                          this.featureErrorIssue.start -
                              (target.globalCodeUnitStart +
                                  target.codeUnitStart)
                      )
                  )
                : this.utf8ByteOffsetToCodeUnitIndex(
                      target.code,
                      Math.max(
                          0,
                          Math.min(
                              this.utf8ByteLength(target.code),
                              this.featureErrorIssue.start -
                                  (target.globalByteStart +
                                      target.codeByteStart)
                          )
                      )
                  );
        const row = this.featuresEditor.session.doc.indexToPosition(
            localCodeUnitStartIndex
        ).row;

        if (typeof this.featuresEditor.scrollToLine === 'function') {
            this.featuresEditor.scrollToLine(row, true, true);
        }
    }

    private updateFeatureErrorDisplayForSelection() {
        if (!this.featuresEditor || !this.selectedItem) {
            this.clearFeatureErrorMarker();
            return;
        }

        if (!this.featureErrorIssue || !this.featureErrorTarget) {
            this.clearFeatureErrorMarker();
            return;
        }

        if (
            this.selectedItem.type !== this.featureErrorTarget.type ||
            this.selectedItem.key !== this.featureErrorTarget.key
        ) {
            this.clearFeatureErrorMarker();
            return;
        }

        const resolved = this.resolveFeatureSpanTarget(
            this.featureErrorIssue.start,
            this.featureErrorIssue.end,
            this.featureErrorIssue.message
        );
        const target = resolved?.target || null;
        if (!target) {
            this.clearFeatureErrorMarker();
            return;
        }

        this.featureErrorIssue.coordinateMode =
            this.featureErrorIssue.coordinateMode || resolved!.coordinateMode;

        this.renderFeatureErrorInEditor(this.featureErrorIssue, target);
    }

    private renderFeatureErrorInEditor(
        issue: FeatureErrorSpanIssue,
        target: {
            type: 'prefix' | 'class' | 'feature';
            key: string | number;
            globalByteStart: number;
            codeByteStart: number;
            globalCodeUnitStart: number;
            codeUnitStart: number;
            code: string;
        }
    ) {
        if (!this.featuresEditor) {
            return;
        }

        const coordinateMode = issue.coordinateMode || 'byte';
        const localCodeUnitStartIndex =
            coordinateMode === 'codeUnit'
                ? Math.max(
                      0,
                      Math.min(
                          target.code.length,
                          issue.start -
                              (target.globalCodeUnitStart +
                                  target.codeUnitStart)
                      )
                  )
                : this.utf8ByteOffsetToCodeUnitIndex(
                      target.code,
                      Math.max(
                          0,
                          Math.min(
                              this.utf8ByteLength(target.code),
                              issue.start -
                                  (target.globalByteStart +
                                      target.codeByteStart)
                          )
                      )
                  );

        let localCodeUnitEndIndex =
            coordinateMode === 'codeUnit'
                ? Math.max(
                      0,
                      Math.min(
                          target.code.length,
                          issue.end -
                              (target.globalCodeUnitStart +
                                  target.codeUnitStart)
                      )
                  )
                : this.utf8ByteOffsetToCodeUnitIndex(
                      target.code,
                      Math.max(
                          0,
                          Math.min(
                              this.utf8ByteLength(target.code),
                              issue.end -
                                  (target.globalByteStart +
                                      target.codeByteStart)
                          )
                      )
                  );

        if (localCodeUnitEndIndex <= localCodeUnitStartIndex) {
            localCodeUnitEndIndex = Math.min(
                target.code.length,
                localCodeUnitStartIndex + 1
            );
        }

        const startPos = this.featuresEditor.session.doc.indexToPosition(
            localCodeUnitStartIndex
        );
        const endPos = this.featuresEditor.session.doc.indexToPosition(
            localCodeUnitEndIndex
        );

        const row = startPos.row;

        const Range = window.ace.require('ace/range').Range;
        this.clearFeatureErrorMarker();
        this.featureErrorMarkerId = this.featuresEditor.session.addMarker(
            new Range(row, 0, row, 1),
            'ace_feature_error_line',
            'fullLine'
        );
        this.featureErrorTextMarkerId = this.featuresEditor.session.addMarker(
            new Range(startPos.row, startPos.column, endPos.row, endPos.column),
            'ace_feature_error_text',
            'text'
        );
        this.setFeatureErrorLineWidget(
            row,
            `${issue.category}: ${issue.message}`
        );
    }

    private extractFeatureSpanIssue(
        errorInput: unknown
    ): FeatureErrorSpanIssue | null {
        const issue = extractPrimaryFeatureIssue(errorInput);
        if (!issue || issue.start === undefined || issue.end === undefined) {
            return null;
        }

        return {
            start: issue.start,
            end: issue.end,
            message: issue.message,
            category: issue.category
        };
    }

    private findFeatureItemFromGlobalSpan(
        start: number,
        end: number,
        coordinateMode: 'byte' | 'codeUnit' = 'byte'
    ): {
        type: 'prefix' | 'class' | 'feature';
        key: string | number;
        globalByteStart: number;
        globalByteEnd: number;
        codeByteStart: number;
        globalCodeUnitStart: number;
        globalCodeUnitEnd: number;
        codeUnitStart: number;
        code: string;
    } | null {
        const blocks = this.buildFeatureSourceBlocks();
        if (!blocks.length) {
            return null;
        }

        const endInclusive = Math.max(start, end - 1);

        const matching =
            blocks.find(
                (block) =>
                    start >=
                        (coordinateMode === 'byte'
                            ? block.globalByteStart
                            : block.globalCodeUnitStart) &&
                    start <
                        (coordinateMode === 'byte'
                            ? block.globalByteEnd
                            : block.globalCodeUnitEnd)
            ) ||
            blocks.find(
                (block) =>
                    endInclusive >=
                        (coordinateMode === 'byte'
                            ? block.globalByteStart
                            : block.globalCodeUnitStart) &&
                    endInclusive <
                        (coordinateMode === 'byte'
                            ? block.globalByteEnd
                            : block.globalCodeUnitEnd)
            );

        if (!matching) {
            return null;
        }

        return {
            type: matching.type,
            key: matching.key,
            globalByteStart: matching.globalByteStart,
            globalByteEnd: matching.globalByteEnd,
            codeByteStart: matching.codeByteStart,
            globalCodeUnitStart: matching.globalCodeUnitStart,
            globalCodeUnitEnd: matching.globalCodeUnitEnd,
            codeUnitStart: matching.codeUnitStart,
            code: matching.code
        };
    }

    private resolveFeatureSpanTarget(
        start: number,
        end: number,
        issueMessage?: string
    ): ResolvedFeatureSpanTarget | null {
        const normalizedStart = Math.max(0, start);
        const normalizedEnd = Math.max(normalizedStart, end);

        const candidates: Array<{
            start: number;
            end: number;
            coordinateMode: 'byte' | 'codeUnit';
        }> = [
            {
                start: normalizedStart,
                end: normalizedEnd,
                coordinateMode: 'byte'
            },
            {
                start: Math.max(0, normalizedStart - 1),
                end: Math.max(0, normalizedEnd - 1),
                coordinateMode: 'byte'
            },
            {
                start: normalizedStart,
                end: normalizedEnd,
                coordinateMode: 'codeUnit'
            },
            {
                start: Math.max(0, normalizedStart - 1),
                end: Math.max(0, normalizedEnd - 1),
                coordinateMode: 'codeUnit'
            }
        ];

        for (const candidate of candidates) {
            const target = this.findFeatureItemFromGlobalSpan(
                candidate.start,
                candidate.end,
                candidate.coordinateMode
            );
            if (target) {
                return {
                    target,
                    coordinateMode: candidate.coordinateMode,
                    normalizedStart: candidate.start,
                    normalizedEnd: candidate.end
                };
            }
        }

        return null;
    }

    private getFeatureTargetLabel(
        type: 'prefix' | 'class' | 'feature',
        key: string | number
    ): string {
        if (type === 'feature') {
            const font = window.currentFontModel;
            const features = font?.features?.features || [];
            const featureEntry =
                typeof key === 'number' ? features[key] : undefined;
            const featureTag = featureEntry?.[0];
            if (!featureTag) {
                return `#${String(key)}`;
            }

            const occurrence =
                typeof key === 'number'
                    ? features
                          .slice(0, key + 1)
                          .filter(([tag]) => tag === featureTag).length
                    : 1;
            return occurrence > 1 ? `${featureTag} #${occurrence}` : featureTag;
        }

        return String(key);
    }

    getHistoryScopeTarget(): FeatureHistoryScopeTarget | null {
        if (!this.isViewActive() || this.currentTab !== 'features') {
            return null;
        }

        if (!this.selectedItem) {
            return null;
        }

        const { type, key } = this.selectedItem;
        if (type === 'prefix' && typeof key === 'string') {
            return {
                type,
                key: `prefix:${key}`,
                label: key
            };
        }

        if (type === 'class' && typeof key === 'string') {
            return {
                type,
                key: `class:${key}`,
                label: key
            };
        }

        if (type === 'feature' && typeof key === 'number') {
            const font = window.currentFontModel;
            const features = font?.features?.features || [];
            const featureEntry = features[key];
            const tag = featureEntry?.[0];
            if (!tag) {
                return {
                    type,
                    key: `feature-index:${key}`,
                    label: `#${key + 1}`
                };
            }

            const occurrence = features
                .slice(0, key + 1)
                .filter(([featureTag]) => featureTag === tag).length;

            return {
                type,
                key: `feature:${tag}:${occurrence}`,
                label: occurrence > 1 ? `${tag} #${occurrence}` : String(tag)
            };
        }

        return null;
    }

    private notifyHistoryScopeChange() {
        window.dispatchEvent(new CustomEvent('featureHistoryContextChanged'));
    }

    private createContentContainers(viewContent: HTMLElement) {
        this.generalTab = document.createElement('div');
        this.generalTab.id = 'fontinfo-general-content';
        this.generalTab.style.display = 'none';
        this.generalTab.style.height = '100%';
        this.generalTab.style.overflow = 'auto';

        // Store existing content as Names tab
        this.namesTab = document.createElement('div');
        this.namesTab.id = 'fontinfo-names-content';
        this.namesTab.style.display = 'none';
        this.namesTab.style.height = '100%';
        this.namesTab.style.overflow = 'auto';

        // Move existing content to Names tab
        while (viewContent.firstChild) {
            this.namesTab.appendChild(viewContent.firstChild);
        }

        this.namesFieldsContainer = document.createElement('div');
        this.namesFieldsContainer.id = 'fontinfo-names-fields';
        this.namesFieldsContainer.className = 'fontinfo-names-fields';
        this.namesTab.appendChild(this.namesFieldsContainer);

        this.mastersTab = document.createElement('div');
        this.mastersTab.id = 'fontinfo-masters-content';
        this.mastersTab.style.display = 'none';
        this.mastersTab.style.height = '100%';
        this.mastersTab.style.overflow = 'hidden';

        this.mastersFieldsContainer = document.createElement('div');
        this.mastersFieldsContainer.id = 'fontinfo-masters-fields';
        this.mastersFieldsContainer.className = 'fontinfo-records-pane';
        this.mastersTab.appendChild(this.mastersFieldsContainer);

        this.instancesTab = document.createElement('div');
        this.instancesTab.id = 'fontinfo-instances-content';
        this.instancesTab.style.display = 'none';
        this.instancesTab.style.height = '100%';
        this.instancesTab.style.overflow = 'hidden';

        this.instancesFieldsContainer = document.createElement('div');
        this.instancesFieldsContainer.id = 'fontinfo-instances-fields';
        this.instancesFieldsContainer.className = 'fontinfo-records-pane';
        this.instancesTab.appendChild(this.instancesFieldsContainer);

        this.axesTab = document.createElement('div');
        this.axesTab.id = 'fontinfo-axes-content';
        this.axesTab.style.display = 'none';
        this.axesTab.style.height = '100%';
        this.axesTab.style.overflow = 'hidden';

        this.axesFieldsContainer = document.createElement('div');
        this.axesFieldsContainer.id = 'fontinfo-axes-fields';
        this.axesFieldsContainer.className = 'fontinfo-records-pane';
        this.axesTab.appendChild(this.axesFieldsContainer);

        this.generalFieldsContainer = document.createElement('div');
        this.generalFieldsContainer.id = 'fontinfo-general-fields';
        this.generalFieldsContainer.className = 'fontinfo-names-fields';
        this.generalTab.appendChild(this.generalFieldsContainer);

        this.customOTValuesTab = document.createElement('div');
        this.customOTValuesTab.id = 'fontinfo-custom-ot-values-content';
        this.customOTValuesTab.style.display = 'none';
        this.customOTValuesTab.style.height = '100%';
        this.customOTValuesTab.style.overflow = 'auto';

        this.customOTValuesFieldsContainer = document.createElement('div');
        this.customOTValuesFieldsContainer.id =
            'fontinfo-custom-ot-values-fields';
        this.customOTValuesFieldsContainer.className = 'fontinfo-names-fields';
        this.customOTValuesTab.appendChild(this.customOTValuesFieldsContainer);

        // Create Features tab
        this.featuresTab = document.createElement('div');
        this.featuresTab.id = 'fontinfo-features-content';
        this.featuresTab.style.display = 'none';
        this.featuresTab.style.height = '100%';
        this.featuresTab.style.overflow = 'hidden';
        this.featuresTab.innerHTML = `
            <div class="features-container">
                <div class="features-sidebar view-sidebar view-sidebar-left">
                    <div class="sidebar-section-title">Prefixes</div>
                    <div class="features-list sidebar-list" id="prefixes-list"></div>
                    <div class="sidebar-section-title">Classes</div>
                    <div class="features-list sidebar-list" id="classes-list"></div>
                    <div class="sidebar-section-title">Features</div>
                    <div class="features-list sidebar-list" id="features-list"></div>
                </div>
                <div class="features-editor-container">
                    <div class="glyph-filter-legend">
                        <label class="feature-auto-checkbox">
                            <input type="checkbox" id="feature-automatic-checkbox" />
                            <span>Automatically Generated</span>
                        </label>
                    </div>
                    <div class="features-editor" id="features-editor"></div>
                </div>
            </div>
        `;

        viewContent.appendChild(this.generalTab);
        viewContent.appendChild(this.namesTab);
        viewContent.appendChild(this.mastersTab);
        viewContent.appendChild(this.instancesTab);
        viewContent.appendChild(this.axesTab);
        viewContent.appendChild(this.customOTValuesTab);
        viewContent.appendChild(this.featuresTab);

        // Set up automatic checkbox handler
        const autoCheckbox = this.featuresTab.querySelector(
            '#feature-automatic-checkbox'
        ) as HTMLInputElement;
        if (autoCheckbox) {
            autoCheckbox.addEventListener('change', () =>
                this.onAutomaticCheckboxChanged()
            );
        }
    }

    private initializeFeaturesEditor() {
        if (!window.ace) {
            console.error('Ace Editor not loaded');
            return;
        }

        const editorContainer = document.getElementById('features-editor');
        if (!editorContainer) {
            console.error('Features editor container not found');
            return;
        }

        // Create Ace editor
        this.featuresEditor = window.ace.edit('features-editor');
        window.ace.require('ace/ext/language_tools');

        // Set theme based on current theme preference
        const getInitialTheme = () => {
            const savedTheme = localStorage.getItem('preferredTheme') || 'auto';
            if (savedTheme === 'auto') {
                const isDark = window.matchMedia(
                    '(prefers-color-scheme: dark)'
                ).matches;
                return isDark
                    ? 'ace/theme/tomorrow_night'
                    : 'ace/theme/tomorrow';
            }
            return savedTheme === 'light'
                ? 'ace/theme/tomorrow'
                : 'ace/theme/tomorrow_night';
        };

        this.featuresEditor.setTheme(getInitialTheme());

        // Set FEA mode with error handling
        try {
            this.featuresEditor.session.setMode('ace/mode/fea');
            console.log('[FontInfo] FEA mode loaded successfully');
        } catch (e) {
            console.error('[FontInfo] Failed to load FEA mode:', e);
            // Fallback to text mode
            this.featuresEditor.session.setMode('ace/mode/text');
        }
        this.featuresEditor.setOptions({
            fontSize: '12px',
            fontFamily: "'IBM Plex Mono', monospace",
            showPrintMargin: false,
            highlightActiveLine: true,
            enableBasicAutocompletion: false,
            enableLiveAutocompletion: false,
            showGutter: true,
            showLineNumbers: true,
            wrap: true
        });
        // Enable indented soft wrap on the session (must be set on session, not editor)
        this.featuresEditor.session.setOption('indentedSoftWrap', true);

        // Set up change handler
        this.featuresEditor.on('change', () => this.onFeatureCodeChanged());
        this.featuresEditor.on('blur', () => this.commitFeatureCodeChanges());
        this.featuresEditor.commands.addCommand({
            name: 'commitFeatureCodeChanges',
            bindKey: { win: 'Ctrl-Enter', mac: 'Command-Enter' },
            exec: () => {
                this.commitFeatureCodeChanges();
            }
        });
        // Font history owns Cmd+Z / Cmd+Shift+Z; Ace text undo is Cmd+Alt+Z.
        this.featuresEditor.commands.addCommand({
            name: 'undo',
            bindKey: { win: 'Ctrl-Alt-Z', mac: 'Command-Alt-Z' },
            exec: 'undo',
            readOnly: true
        });
        this.featuresEditor.commands.addCommand({
            name: 'redo',
            bindKey: {
                win: 'Ctrl-Alt-Shift-Z|Ctrl-Shift-Y',
                mac: 'Command-Alt-Shift-Z|Command-Shift-Y'
            },
            exec: 'redo',
            readOnly: true
        });
        this.featuresEditor.commands.addCommand({
            name: 'fontHistoryUndoPassthrough',
            bindKey: { win: 'Ctrl-Z', mac: 'Command-Z' },
            exec: () => false,
            readOnly: true,
            passEvent: true
        });
        this.featuresEditor.commands.addCommand({
            name: 'fontHistoryRedoPassthrough',
            bindKey: { win: 'Ctrl-Shift-Z', mac: 'Command-Shift-Z' },
            exec: () => false,
            readOnly: true,
            passEvent: true
        });
        this.featuresEditor.renderer.on('afterRender', () => {
            this.refreshFeatureErrorLineWidgetLayout();
        });

        console.log('[FontInfo] Features editor initialized');
    }

    private switchTab(tab: FontInfoTab) {
        this.currentTab = tab;
        this.notifyHistoryScopeChange();

        setFontInfoSection(tab);

        this.refreshSectionPicker();

        // Show/hide content
        if (this.generalTab) {
            this.generalTab.style.display =
                tab === 'general' ? 'block' : 'none';
        }
        if (this.namesTab) {
            this.namesTab.style.display = tab === 'names' ? 'block' : 'none';
        }
        if (this.mastersTab) {
            this.mastersTab.style.display =
                tab === 'masters' ? 'block' : 'none';
        }
        if (this.instancesTab) {
            this.instancesTab.style.display =
                tab === 'instances' ? 'block' : 'none';
        }
        if (this.axesTab) {
            this.axesTab.style.display = tab === 'axes' ? 'block' : 'none';
        }
        if (this.customOTValuesTab) {
            this.customOTValuesTab.style.display =
                tab === 'custom_ot_values' ? 'block' : 'none';
        }
        if (this.featuresTab) {
            this.featuresTab.style.display =
                tab === 'features' ? 'block' : 'none';
        }

        if (tab === 'features') {
            // Initialize editor lazily on first show
            if (!this.featuresEditorInitialized) {
                this.initializeFeaturesEditor();
                this.featuresEditorInitialized = true;
            }
            // Load font data if available and not already loaded
            if (
                window.currentFontModel &&
                (!this.fontDataLoaded || this.pendingModelSyncRefresh)
            ) {
                console.log('[FontInfo] Loading features lists (switchTab)');
                this.refreshVisibleFeatureContent();
            }
        } else {
            if (window.currentFontModel) {
                if (
                    tab === 'general' &&
                    (!this.generalDataLoaded ||
                        this.pendingGeneralModelSyncRefresh)
                ) {
                    this.refreshVisibleGeneralContent();
                }

                if (
                    tab === 'names' &&
                    (!this.namesDataLoaded || this.pendingNamesModelSyncRefresh)
                ) {
                    this.refreshVisibleNamesContent();
                }

                if (
                    tab === 'masters' &&
                    (!this.mastersDataLoaded ||
                        this.pendingMastersModelSyncRefresh)
                ) {
                    this.refreshVisibleMastersContent();
                }

                if (
                    tab === 'instances' &&
                    (!this.instancesDataLoaded ||
                        this.pendingInstancesModelSyncRefresh)
                ) {
                    this.refreshVisibleInstancesContent();
                }

                if (
                    tab === 'axes' &&
                    (!this.axesDataLoaded || this.pendingAxesModelSyncRefresh)
                ) {
                    this.refreshVisibleAxesContent();
                }

                if (
                    tab === 'custom_ot_values' &&
                    (!this.customOTValuesDataLoaded ||
                        this.pendingCustomOTValuesModelSyncRefresh)
                ) {
                    this.refreshVisibleCustomOTValuesContent();
                }
            }

            // Clear search terms and reset visibility
            if (this.searchTerms.length > 0) {
                this.searchTerms = [];
                if (this.searchInput) {
                    this.searchInput.value = '';
                }
                // Reset all items to visible
                this.applyFeaturesSearch();
            }
        }

        console.log(`[FontInfo] Switched to ${tab} tab`);
    }

    private onFontLoaded() {
        console.log(
            `[FontInfo] Font loaded event, current tab: ${this.currentTab}`
        );
        // Reset font data loaded flag for new font
        this.generalDataLoaded = false;
        this.pendingGeneralModelSyncRefresh = false;
        this.namesDataLoaded = false;
        this.pendingNamesModelSyncRefresh = false;
        this.mastersDataLoaded = false;
        this.pendingMastersModelSyncRefresh = false;
        this.instancesDataLoaded = false;
        this.pendingInstancesModelSyncRefresh = false;
        this.axesDataLoaded = false;
        this.pendingAxesModelSyncRefresh = false;
        this.customOTValuesDataLoaded = false;
        this.pendingCustomOTValuesModelSyncRefresh = false;
        this.fontDataLoaded = false;
        this.pendingModelSyncRefresh = false;
        this.featureCodeDirty = false;
        this.clearFeatureCodeCommitDebounce();
        // Clear Ace feature editor + selection so a new/empty font does not
        // keep showing the previous font's feature code via selectedFeatureTag.
        this.clearEditor();
        this.namesFieldEditors.clear();
        this.prefixListItems.clear();
        this.classListItems.clear();
        this.featureListItems.clear();
        if (this.currentTab === 'general') {
            requestAnimationFrame(() => this.refreshVisibleGeneralContent());
        }
        if (this.currentTab === 'names') {
            requestAnimationFrame(() => this.refreshVisibleNamesContent());
        }
        if (this.currentTab === 'masters') {
            requestAnimationFrame(() => this.refreshVisibleMastersContent());
        }
        if (this.currentTab === 'instances') {
            requestAnimationFrame(() => this.refreshVisibleInstancesContent());
        }
        if (this.currentTab === 'axes') {
            requestAnimationFrame(() => this.refreshVisibleAxesContent());
        }
        if (this.currentTab === 'custom_ot_values') {
            requestAnimationFrame(() =>
                this.refreshVisibleCustomOTValuesContent()
            );
        }
        // Load features data if we're on the features tab
        if (this.currentTab === 'features') {
            console.log('[FontInfo] Loading features lists (onFontLoaded)');
            // Ensure editor is initialized before loading data
            if (!this.featuresEditorInitialized) {
                this.initializeFeaturesEditor();
                this.featuresEditorInitialized = true;
            }
            // Defer to ensure font model is fully available and DOM is ready
            requestAnimationFrame(() => {
                if (window.currentFontModel) {
                    this.loadAllLists();
                    this.fontDataLoaded = true;
                }
            });
        }
    }

    private onFontModelSynced() {
        this.generalDataLoaded = false;
        this.pendingGeneralModelSyncRefresh = true;
        this.namesDataLoaded = false;
        this.pendingNamesModelSyncRefresh = true;
        this.mastersDataLoaded = false;
        this.pendingMastersModelSyncRefresh = true;
        this.instancesDataLoaded = false;
        this.pendingInstancesModelSyncRefresh = true;
        this.axesDataLoaded = false;
        this.pendingAxesModelSyncRefresh = true;
        this.customOTValuesDataLoaded = false;
        this.pendingCustomOTValuesModelSyncRefresh = true;
        this.fontDataLoaded = false;
        this.pendingModelSyncRefresh = true;

        if (this.currentTab === 'general') {
            if (this.isGeneralEditing()) {
                return;
            }
            requestAnimationFrame(() => this.refreshVisibleGeneralContent());
            return;
        }

        if (this.currentTab === 'names') {
            if (this.isNamesEditing()) {
                return;
            }
            requestAnimationFrame(() => this.refreshVisibleNamesContent());
            return;
        }

        if (this.currentTab === 'masters') {
            if (this.hasMasterListStructureChanged()) {
                requestAnimationFrame(() =>
                    this.forceRefreshVisibleMastersContent()
                );
                return;
            }
            if (this.isMastersEditing()) {
                return;
            }
            requestAnimationFrame(() => this.refreshVisibleMastersContent());
            return;
        }

        if (this.currentTab === 'instances') {
            if (this.hasInstanceListStructureChanged()) {
                requestAnimationFrame(() =>
                    this.forceRefreshVisibleInstancesContent()
                );
                return;
            }
            if (this.isInstancesEditing()) {
                return;
            }
            requestAnimationFrame(() => this.refreshVisibleInstancesContent());
            return;
        }

        if (this.currentTab === 'axes') {
            if (this.hasAxisListStructureChanged()) {
                requestAnimationFrame(() =>
                    this.forceRefreshVisibleAxesContent()
                );
                return;
            }
            if (this.isAxesEditing()) {
                return;
            }
            requestAnimationFrame(() => this.refreshVisibleAxesContent());
            return;
        }

        if (this.currentTab === 'custom_ot_values') {
            if (this.isCustomOTValuesEditing()) {
                return;
            }
            requestAnimationFrame(() =>
                this.refreshVisibleCustomOTValuesContent()
            );
            return;
        }

        if (this.currentTab !== 'features') {
            return;
        }

        if (this.featuresEditor?.isFocused?.() && this.featureCodeDirty) {
            this.loadFeaturesList({ preserveFeatureEditorDraft: true });
            return;
        }

        requestAnimationFrame(() => this.refreshVisibleFeatureContent());
    }

    private isGeneralEditing(): boolean {
        return this.isEditableControlWithin(this.generalTab);
    }

    private isNamesEditing(): boolean {
        return Array.from(this.namesFieldEditors.values()).some((editor) =>
            editor.isEditing()
        );
    }

    private isMastersEditing(): boolean {
        return this.isEditableControlWithin(this.mastersTab);
    }

    private isInstancesEditing(): boolean {
        return this.isEditableControlWithin(this.instancesTab);
    }

    private isCustomOTValuesEditing(): boolean {
        return this.isEditableControlWithin(this.customOTValuesTab);
    }

    private isEditableControlWithin(
        container: HTMLElement | null | undefined
    ): boolean {
        const activeElement = document.activeElement as HTMLElement | null;
        if (
            !container ||
            !activeElement ||
            !container.contains(activeElement)
        ) {
            return false;
        }

        return (
            activeElement instanceof HTMLInputElement ||
            activeElement instanceof HTMLTextAreaElement ||
            activeElement instanceof HTMLSelectElement ||
            activeElement.isContentEditable
        );
    }

    private refreshVisibleGeneralContent() {
        if (this.currentTab !== 'general' || !window.currentFontModel) {
            return;
        }

        if (this.isGeneralEditing()) {
            return;
        }

        this.preserveFontInfoScrollPosition(() => this.renderGeneralContent());
        this.generalDataLoaded = true;
        this.pendingGeneralModelSyncRefresh = false;
    }

    private refreshVisibleNamesContent() {
        if (this.currentTab !== 'names' || !window.currentFontModel) {
            return;
        }

        if (this.isNamesEditing()) {
            return;
        }

        this.preserveFontInfoScrollPosition(() => this.renderNamesContent());
        this.namesDataLoaded = true;
        this.pendingNamesModelSyncRefresh = false;
    }

    private refreshVisibleMastersContent() {
        if (this.currentTab !== 'masters' || !window.currentFontModel) {
            return;
        }

        if (this.isMastersEditing()) {
            return;
        }

        this.preserveFontInfoScrollPosition(() => this.renderMastersContent());
        this.mastersDataLoaded = true;
        this.pendingMastersModelSyncRefresh = false;
    }

    private forceRefreshVisibleMastersContent() {
        if (this.currentTab !== 'masters' || !window.currentFontModel) {
            return;
        }

        this.preserveFontInfoScrollPosition(() => this.renderMastersContent());
        this.mastersDataLoaded = true;
        this.pendingMastersModelSyncRefresh = false;
    }

    private refreshVisibleInstancesContent() {
        if (this.currentTab !== 'instances' || !window.currentFontModel) {
            return;
        }

        if (this.isInstancesEditing()) {
            return;
        }

        this.preserveFontInfoScrollPosition(() =>
            this.renderInstancesContent()
        );
        this.instancesDataLoaded = true;
        this.pendingInstancesModelSyncRefresh = false;
    }

    private forceRefreshVisibleInstancesContent() {
        if (this.currentTab !== 'instances' || !window.currentFontModel) {
            return;
        }

        this.preserveFontInfoScrollPosition(() =>
            this.renderInstancesContent()
        );
        this.instancesDataLoaded = true;
        this.pendingInstancesModelSyncRefresh = false;
    }

    private isAxesEditing(): boolean {
        return this.isEditableControlWithin(this.axesTab);
    }

    private getCurrentTabScrollRoot(): HTMLElement | null {
        switch (this.currentTab) {
            case 'general':
                return this.generalTab;
            case 'names':
                return this.namesTab;
            case 'masters':
                return this.mastersTab;
            case 'instances':
                return this.instancesTab;
            case 'axes':
                return this.axesTab;
            case 'custom_ot_values':
                return this.customOTValuesTab;
            default:
                return null;
        }
    }

    private preserveFontInfoScrollPosition(render: () => void) {
        const scrollRoot = this.getCurrentTabScrollRoot();
        const detailBefore = scrollRoot?.querySelector<HTMLElement>(
            '.fontinfo-records-detail'
        );
        const listBefore = scrollRoot?.querySelector<HTMLElement>(
            '.fontinfo-records-list'
        );
        const rootScrollTop = scrollRoot?.scrollTop ?? null;
        const rootScrollLeft = scrollRoot?.scrollLeft ?? null;
        const detailScrollTop = detailBefore?.scrollTop ?? null;
        const detailScrollLeft = detailBefore?.scrollLeft ?? null;
        const listScrollTop = listBefore?.scrollTop ?? null;
        const listScrollLeft = listBefore?.scrollLeft ?? null;

        render();

        if (!scrollRoot) {
            return;
        }

        const restore = () => {
            if (rootScrollTop !== null) {
                scrollRoot.scrollTop = rootScrollTop;
            }
            if (rootScrollLeft !== null) {
                scrollRoot.scrollLeft = rootScrollLeft;
            }

            const detailAfter = scrollRoot.querySelector<HTMLElement>(
                '.fontinfo-records-detail'
            );
            if (detailAfter) {
                if (detailScrollTop !== null) {
                    detailAfter.scrollTop = detailScrollTop;
                }
                if (detailScrollLeft !== null) {
                    detailAfter.scrollLeft = detailScrollLeft;
                }
            }

            const listAfter = scrollRoot.querySelector<HTMLElement>(
                '.fontinfo-records-list'
            );
            if (listAfter) {
                if (listScrollTop !== null) {
                    listAfter.scrollTop = listScrollTop;
                }
                if (listScrollLeft !== null) {
                    listAfter.scrollLeft = listScrollLeft;
                }
            }
        };

        restore();
        requestAnimationFrame(restore);
        requestAnimationFrame(() => requestAnimationFrame(restore));
        setTimeout(restore, 0);
        setTimeout(restore, 50);
        setTimeout(restore, 150);
    }

    private refreshVisibleAxesContent() {
        if (this.currentTab !== 'axes' || !window.currentFontModel) {
            return;
        }

        if (this.isAxesEditing()) {
            return;
        }

        this.preserveFontInfoScrollPosition(() => this.renderAxesContent());
        this.axesDataLoaded = true;
        this.pendingAxesModelSyncRefresh = false;
    }

    private forceRefreshVisibleAxesContent() {
        if (this.currentTab !== 'axes' || !window.currentFontModel) {
            return;
        }

        this.preserveFontInfoScrollPosition(() => this.renderAxesContent());
        this.axesDataLoaded = true;
        this.pendingAxesModelSyncRefresh = false;
    }

    private getMasterListStructureSignature(
        masters?: Babelfont.Master[] | undefined
    ): string {
        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        const sourceMasters = masters ?? font?.masters ?? [];

        return sourceMasters
            .map((master, index) => master.id ?? `index:${index}`)
            .join('|');
    }

    private getInstanceListStructureSignature(
        instances?: Babelfont.Instance[] | undefined
    ): string {
        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        const sourceInstances = instances ?? font?.instances ?? [];

        return sourceInstances
            .map((instance, index) => instance.id ?? `index:${index}`)
            .join('|');
    }

    private hasMasterListStructureChanged(): boolean {
        return (
            this.renderedMasterListSignature !==
            this.getMasterListStructureSignature()
        );
    }

    private hasInstanceListStructureChanged(): boolean {
        return (
            this.renderedInstanceListSignature !==
            this.getInstanceListStructureSignature()
        );
    }

    private getAxisListStructureSignature(
        axes?: Babelfont.Axis[] | undefined
    ): string {
        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        const sourceAxes = axes ?? font?.axes ?? [];

        return sourceAxes
            .map((axis, index) => axis.tag ?? `index:${index}`)
            .join('|');
    }

    private hasAxisListStructureChanged(): boolean {
        return (
            this.renderedAxisListSignature !==
            this.getAxisListStructureSignature()
        );
    }

    private getAxisListSummary(axisIndex: number): {
        primary: string;
        secondary: string;
    } {
        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        const axis = font?.axes?.[axisIndex];

        return {
            primary: getLocalizedDictionarySummary(
                axis?.name,
                axis?.tag ?? `Axis ${axisIndex + 1}`
            ),
            secondary: axis?.tag ?? ''
        };
    }

    private getMasterListSummary(masterIndex: number): {
        primary: string;
        secondary: string[];
    } {
        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        const master = font?.masters?.[masterIndex];

        return {
            primary: getLocalizedDictionarySummary(
                master?.name,
                `Master ${masterIndex + 1}`
            ),
            secondary: formatLocationSummary(
                font?.axes,
                master?.location as Record<string, number> | undefined
            )
        };
    }

    private getInstanceListSummary(instanceIndex: number): {
        primary: string;
        secondary: string[];
    } {
        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        const instance = font?.instances?.[instanceIndex];

        return {
            primary: getLocalizedDictionarySummary(
                instance?.name,
                `Instance ${instanceIndex + 1}`
            ),
            secondary: formatLocationSummary(
                font?.axes,
                instance?.location as Record<string, number> | undefined
            )
        };
    }

    private getMasterListItems(): HTMLElement[] {
        return Array.from(
            this.mastersFieldsContainer?.querySelectorAll(
                '.fontinfo-records-list .fontinfo-record-item'
            ) ?? []
        ) as HTMLElement[];
    }

    private getInstanceListItems(): HTMLElement[] {
        return Array.from(
            this.instancesFieldsContainer?.querySelectorAll(
                '.fontinfo-records-list .fontinfo-record-item'
            ) ?? []
        ) as HTMLElement[];
    }

    private getAxisListItems(): HTMLElement[] {
        return Array.from(
            this.axesFieldsContainer?.querySelectorAll(
                '.fontinfo-records-list .fontinfo-record-item'
            ) ?? []
        ) as HTMLElement[];
    }

    private updateRecordListItemSummary(
        item: Element | undefined,
        summary: { primary: string; secondary: string | string[] }
    ) {
        const primary = item?.querySelector('.fontinfo-record-item-primary');
        const secondary = item?.querySelector(
            '.fontinfo-record-item-secondary'
        );

        if (primary) {
            primary.textContent = summary.primary;
        }
        if (secondary) {
            secondary.replaceChildren(
                ...asSummaryLines(summary.secondary).map((line) => {
                    const lineEl = document.createElement('div');
                    lineEl.className = 'fontinfo-record-item-secondary-line';
                    lineEl.textContent = line;
                    return lineEl;
                })
            );
        }
    }

    private refreshMasterSidebarItemSummary(masterIndex: number) {
        if (this.currentTab !== 'masters') {
            return;
        }

        this.updateRecordListItemSummary(
            this.getMasterListItems()[masterIndex],
            this.getMasterListSummary(masterIndex)
        );
    }

    private refreshInstanceSidebarItemSummary(instanceIndex: number) {
        if (this.currentTab !== 'instances') {
            return;
        }

        this.updateRecordListItemSummary(
            this.getInstanceListItems()[instanceIndex],
            this.getInstanceListSummary(instanceIndex)
        );
    }

    private refreshAxisSidebarItemSummary(axisIndex: number) {
        if (this.currentTab !== 'axes') {
            return;
        }

        this.updateRecordListItemSummary(
            this.getAxisListItems()[axisIndex],
            this.getAxisListSummary(axisIndex)
        );
    }

    private refreshVisibleCustomOTValuesContent() {
        if (
            this.currentTab !== 'custom_ot_values' ||
            !window.currentFontModel
        ) {
            return;
        }

        if (this.isCustomOTValuesEditing()) {
            return;
        }

        this.preserveFontInfoScrollPosition(() =>
            this.renderCustomOTValuesContent()
        );
        this.customOTValuesDataLoaded = true;
        this.pendingCustomOTValuesModelSyncRefresh = false;
    }

    private createSimpleFieldEditor(options: {
        label: string;
        value: string;
        multiline?: boolean;
        inputType?: 'text' | 'number' | 'datetime-local';
        placeholder?: string;
        helperText?: string;
        onCommit: (rawValue: string) => string;
        step?: string;
        min?: string;
        dataField?: string;
    }): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'localized-string-editor';
        if (options.dataField) {
            wrapper.setAttribute('data-font-field', options.dataField);
        }

        const label = document.createElement('label');
        label.className = 'localized-string-label';
        label.textContent = options.label;
        wrapper.appendChild(label);

        const input = options.multiline
            ? document.createElement('textarea')
            : document.createElement('input');
        input.className = options.multiline
            ? 'localized-string-input localized-string-textarea'
            : 'localized-string-input';

        if (!options.multiline && input instanceof HTMLInputElement) {
            input.type = options.inputType ?? 'text';
            if (options.step) {
                input.step = options.step;
            }
            if (options.min) {
                input.min = options.min;
            }
        }

        if (options.placeholder) {
            input.placeholder = options.placeholder;
        }

        input.value = options.value;
        wrapper.appendChild(input);

        if (options.helperText) {
            const helper = document.createElement('div');
            helper.className = 'localized-string-helper';
            helper.textContent = options.helperText;
            wrapper.appendChild(helper);
        }

        let lastCommittedValue = options.value;
        const commit = (): void => {
            const normalizedValue = options.onCommit(input.value);
            lastCommittedValue = normalizedValue;
            input.value = normalizedValue;
        };

        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (event) => {
            const keyboardEvent = event as KeyboardEvent;
            if (keyboardEvent.key === 'Escape') {
                keyboardEvent.preventDefault();
                input.value = lastCommittedValue;
                input.blur();
                return;
            }

            if (
                !(input instanceof HTMLInputElement) ||
                keyboardEvent.key !== 'Enter' ||
                keyboardEvent.isComposing
            ) {
                return;
            }

            keyboardEvent.preventDefault();
            commit();
            input.blur();
        });

        return wrapper;
    }

    private createCreatedFieldEditor(date?: Date | string): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'localized-string-editor';
        wrapper.setAttribute('data-font-field', 'date');

        const label = document.createElement('label');
        label.className = 'localized-string-label';
        label.textContent = 'Created';
        wrapper.appendChild(label);

        const input = document.createElement('input');
        input.type = 'datetime-local';
        input.className = 'localized-string-input';

        let lastCommittedValue = formatDateTimeLocal(date);
        input.value = lastCommittedValue;
        wrapper.appendChild(input);

        const actions = document.createElement('div');
        actions.className = 'fontinfo-field-actions';

        const nowButton = document.createElement('button');
        nowButton.type = 'button';
        nowButton.className = 'localized-string-locales-button';
        nowButton.textContent = 'Now';
        nowButton.addEventListener('click', () => {
            const nextDate = new Date();
            const formattedValue = formatDateTimeLocal(nextDate);
            this.commitRootFontFieldValue('date', nextDate);
            lastCommittedValue = formattedValue;
            input.value = formattedValue;
        });
        actions.appendChild(nowButton);
        wrapper.appendChild(actions);

        const helper = document.createElement('div');
        helper.className = 'localized-string-helper';
        helper.textContent =
            'Stored as an ISO date when serialized. Use Now to stamp the current local date and time.';
        wrapper.appendChild(helper);

        const commit = (): void => {
            const nextValue = parseDateTimeLocalInput(input.value);
            if (!nextValue) {
                input.value = lastCommittedValue;
                return;
            }

            this.commitRootFontFieldValue('date', nextValue);
            lastCommittedValue = formatDateTimeLocal(nextValue);
            input.value = lastCommittedValue;
        };

        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (event) => {
            const keyboardEvent = event as KeyboardEvent;
            if (keyboardEvent.key === 'Escape') {
                keyboardEvent.preventDefault();
                input.value = lastCommittedValue;
                input.blur();
                return;
            }

            if (keyboardEvent.key !== 'Enter' || keyboardEvent.isComposing) {
                return;
            }

            keyboardEvent.preventDefault();
            commit();
            input.blur();
        });

        return wrapper;
    }

    private createVersionFieldEditor(version?: [number, number]): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'localized-string-editor';
        wrapper.setAttribute('data-font-field', 'version');

        const label = document.createElement('label');
        label.className = 'localized-string-label';
        label.textContent = 'Version';
        wrapper.appendChild(label);

        const fields = document.createElement('div');
        fields.className = 'fontinfo-version-fields';

        const majorInput = document.createElement('input');
        majorInput.type = 'number';
        majorInput.step = '1';
        majorInput.min = '0';
        majorInput.placeholder = 'Major';
        majorInput.className = 'localized-string-input';

        const minorInput = document.createElement('input');
        minorInput.type = 'number';
        minorInput.step = '1';
        minorInput.min = '0';
        minorInput.placeholder = 'Minor';
        minorInput.className = 'localized-string-input';

        const setInputsFromVersion = (
            nextVersion: [number, number] | undefined
        ): void => {
            majorInput.value = nextVersion ? String(nextVersion[0]) : '';
            minorInput.value = nextVersion ? String(nextVersion[1]) : '';
        };

        let lastCommittedVersion = cloneVersionValue(version);
        setInputsFromVersion(lastCommittedVersion);

        const commit = (): void => {
            const nextMajor = parseIntegerInput(majorInput.value);
            const nextMinor = parseIntegerInput(minorInput.value);
            if (
                typeof nextMajor !== 'number' ||
                typeof nextMinor !== 'number'
            ) {
                setInputsFromVersion(lastCommittedVersion);
                return;
            }

            const nextVersion: [number, number] = [nextMajor, nextMinor];
            this.commitRootFontFieldValue('version', nextVersion);
            lastCommittedVersion = nextVersion;
            setInputsFromVersion(nextVersion);
        };

        [majorInput, minorInput].forEach((input) => {
            input.addEventListener('blur', commit);
            input.addEventListener('keydown', (event: KeyboardEvent) => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    setInputsFromVersion(lastCommittedVersion);
                    input.blur();
                    return;
                }

                if (event.key !== 'Enter' || event.isComposing) {
                    return;
                }

                event.preventDefault();
                commit();
                input.blur();
            });
        });

        fields.appendChild(majorInput);
        fields.appendChild(minorInput);
        wrapper.appendChild(fields);

        const helper = document.createElement('div');
        helper.className = 'localized-string-helper';
        helper.textContent = 'Stored as a [major, minor] tuple.';
        wrapper.appendChild(helper);

        return wrapper;
    }

    private renderGeneralContent() {
        if (!this.generalFieldsContainer) {
            return;
        }

        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        if (!font) {
            return;
        }

        this.generalFieldsContainer.innerHTML = '';

        const section = document.createElement('section');
        section.className = 'fontinfo-name-group';

        const title = document.createElement('h3');
        title.className = 'sidebar-section-title';
        title.textContent = 'Font';
        section.appendChild(title);

        const fields = document.createElement('div');
        fields.className = 'fontinfo-name-group-fields';

        fields.appendChild(
            this.createSimpleFieldEditor({
                label: 'UPM',
                value: String(font.upm ?? ''),
                inputType: 'number',
                step: '1',
                min: '1',
                dataField: 'upm',
                onCommit: (rawValue) => {
                    const nextValue = parseIntegerInput(rawValue);
                    if (typeof nextValue !== 'number') {
                        return String(window.currentFontModel?.upm ?? font.upm);
                    }
                    this.commitRootFontFieldValue('upm', nextValue);
                    return String(nextValue);
                }
            })
        );

        fields.appendChild(this.createVersionFieldEditor(font.version));

        fields.appendChild(this.createCreatedFieldEditor(font.date));

        fields.appendChild(
            this.createSimpleFieldEditor({
                label: 'Note',
                value: font.note ?? '',
                multiline: true,
                dataField: 'note',
                helperText: 'Leave blank to remove the note.',
                onCommit: (rawValue) => {
                    const nextValue =
                        rawValue.trim().length > 0 ? rawValue : undefined;
                    this.commitRootFontFieldValue('note', nextValue);
                    return nextValue ?? '';
                }
            })
        );

        section.appendChild(fields);
        this.generalFieldsContainer.appendChild(section);
    }

    private renderNamesContent() {
        if (!this.namesFieldsContainer) {
            return;
        }

        const font = window.currentFontModel;
        const names = font?.names ?? {};

        this.namesFieldsContainer.innerHTML = '';
        this.namesFieldEditors.clear();

        FONT_NAME_GROUPS.forEach((group) => {
            const groupEl = document.createElement('section');
            groupEl.className = 'fontinfo-name-group';

            const titleEl = document.createElement('h3');
            titleEl.className = 'sidebar-section-title';
            titleEl.textContent = group.title;
            groupEl.appendChild(titleEl);

            const fieldsEl = document.createElement('div');
            fieldsEl.className = 'fontinfo-name-group-fields';

            group.fields.forEach((field) => {
                const editor = createLocalizedStringEditor({
                    label: field.label,
                    value: names[field.key],
                    multiline: field.multiline,
                    onCommit: (nextValue) =>
                        this.commitNameFieldValue(field.key, nextValue)
                });

                editor.element.setAttribute('data-name-field', field.key);
                fieldsEl.appendChild(editor.element);
                this.namesFieldEditors.set(field.key, editor);
            });

            groupEl.appendChild(fieldsEl);
            this.namesFieldsContainer?.appendChild(groupEl);
        });
    }

    private createCheckboxFieldEditor(options: {
        label: string;
        checked: boolean;
        helperText?: string;
        dataField?: string;
        onCommit: (checked: boolean) => void;
    }): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'localized-string-editor';
        if (options.dataField) {
            wrapper.setAttribute('data-font-field', options.dataField);
        }

        const label = document.createElement('label');
        label.className = 'localized-string-label';
        label.textContent = options.label;
        wrapper.appendChild(label);

        const checkboxLabel = document.createElement('label');
        checkboxLabel.className = 'feature-auto-checkbox';

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = options.checked;
        input.addEventListener('change', () => options.onCommit(input.checked));

        const text = document.createElement('span');
        text.textContent = 'Enabled';

        checkboxLabel.appendChild(input);
        checkboxLabel.appendChild(text);
        wrapper.appendChild(checkboxLabel);

        if (options.helperText) {
            const helper = document.createElement('div');
            helper.className = 'localized-string-helper';
            helper.textContent = options.helperText;
            wrapper.appendChild(helper);
        }

        return wrapper;
    }

    private createRecordListButton(options: {
        primary: string;
        secondary: string | string[];
        selected: boolean;
        onClick: (event: MouseEvent) => void;
        draggable?: boolean;
        onDragStart?: (event: DragEvent) => void;
        onDragOver?: (event: DragEvent) => void;
        onDrop?: (event: DragEvent) => void;
        onDragEnd?: () => void;
    }): HTMLButtonElement {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `editor-layer-item fontinfo-record-item${options.selected ? ' selected' : ''}`;
        button.addEventListener('click', options.onClick);

        if (options.draggable) {
            button.draggable = true;
            button.classList.add('draggable-feature');
            button.addEventListener('dragstart', (event) =>
                options.onDragStart?.(event)
            );
            button.addEventListener('dragover', (event) =>
                options.onDragOver?.(event)
            );
            button.addEventListener('drop', (event) => options.onDrop?.(event));
            button.addEventListener('dragend', () => options.onDragEnd?.());
        }

        const content = document.createElement('div');
        content.className =
            'editor-layer-item-content fontinfo-record-item-content';

        const primary = document.createElement('div');
        primary.className = 'fontinfo-record-item-primary master-item-name';
        primary.textContent = options.primary;

        const secondary = document.createElement('div');
        secondary.className =
            'fontinfo-record-item-secondary master-item-location';
        secondary.replaceChildren(
            ...asSummaryLines(options.secondary).map((line) => {
                const lineEl = document.createElement('div');
                lineEl.className =
                    'fontinfo-record-item-secondary-line master-item-location-line';
                lineEl.textContent = line;
                return lineEl;
            })
        );

        content.appendChild(primary);
        content.appendChild(secondary);
        button.appendChild(content);

        if (options.draggable) {
            const handle = document.createElement('span');
            handle.className = 'material-symbols-outlined feature-drag-handle';
            handle.textContent = 'drag_indicator';
            button.appendChild(handle);
        }

        return button;
    }

    private createRecordsSidebarHeader(options: {
        title: string;
        canRemove: boolean;
        onAdd: () => void;
        onRemove: () => void;
    }): HTMLElement {
        const header = document.createElement('div');
        header.className = 'editor-layers-header';

        const title = document.createElement('div');
        title.className = 'editor-section-title';
        const titleText = document.createElement('span');
        titleText.className = 'editor-section-title-text';
        titleText.textContent = options.title;
        title.appendChild(titleText);

        const actions = document.createElement('div');
        actions.className = 'editor-layers-header-actions';

        const addButton = document.createElement('button');
        addButton.type = 'button';
        addButton.className = 'editor-layer-add-button';
        addButton.setAttribute(
            'aria-label',
            `Add ${options.title.slice(0, -1).toLowerCase()}`
        );
        addButton.setAttribute(
            'data-fontinfo-list-action',
            `${options.title.toLowerCase()}-add`
        );
        addButton.textContent = '+';
        addButton.addEventListener('mousedown', (event) => {
            event.preventDefault();
        });
        addButton.addEventListener('click', options.onAdd);

        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.className = 'editor-layer-add-button';
        removeButton.setAttribute(
            'aria-label',
            `Remove ${options.title.slice(0, -1).toLowerCase()}`
        );
        removeButton.setAttribute(
            'data-fontinfo-list-action',
            `${options.title.toLowerCase()}-remove`
        );
        removeButton.textContent = '−';
        removeButton.disabled = !options.canRemove;
        removeButton.addEventListener('mousedown', (event) => {
            event.preventDefault();
        });
        removeButton.addEventListener('click', options.onRemove);

        actions.appendChild(addButton);
        actions.appendChild(removeButton);
        header.appendChild(title);
        header.appendChild(actions);

        return header;
    }

    private appendNameGroups(options: {
        container: HTMLElement;
        names: Babelfont.Names;
        dataFieldPrefix: string;
        sectionTitle?: string;
        sectionHelperText?: string;
        onCommit: (
            key: FontNameFieldKey,
            nextValue: Babelfont.I18NDictionary
        ) => void;
    }) {
        if (options.sectionTitle) {
            const introSection = document.createElement('section');
            introSection.className = 'fontinfo-name-group';

            const titleEl = document.createElement('h3');
            titleEl.className = 'sidebar-section-title';
            titleEl.textContent = options.sectionTitle;
            introSection.appendChild(titleEl);

            if (options.sectionHelperText) {
                const helper = document.createElement('div');
                helper.className = 'localized-string-helper';
                helper.textContent = options.sectionHelperText;
                introSection.appendChild(helper);
            }

            options.container.appendChild(introSection);
        }

        FONT_NAME_GROUPS.forEach((group) => {
            const groupEl = document.createElement('section');
            groupEl.className = 'fontinfo-name-group';

            const titleEl = document.createElement('h3');
            titleEl.className = 'sidebar-section-title';
            titleEl.textContent = group.title;
            groupEl.appendChild(titleEl);

            const fieldsEl = document.createElement('div');
            fieldsEl.className = 'fontinfo-name-group-fields';

            group.fields.forEach((field) => {
                const editor = createLocalizedStringEditor({
                    label: field.label,
                    value: options.names[field.key],
                    multiline: field.multiline,
                    onCommit: (nextValue) =>
                        options.onCommit(field.key, nextValue)
                });

                editor.element.setAttribute(
                    'data-font-field',
                    `${options.dataFieldPrefix}.${field.key}`
                );
                fieldsEl.appendChild(editor.element);
            });

            groupEl.appendChild(fieldsEl);
            options.container.appendChild(groupEl);
        });
    }

    private appendCustomOTGroups(options: {
        container: HTMLElement;
        customOTValues: Partial<Babelfont.CustomOTValues>;
        dataFieldPrefix: string;
        sectionTitle?: string;
        sectionHelperText?: string;
        onCommit: (key: CustomOTFieldKey, nextValue: unknown) => void;
    }) {
        if (options.sectionTitle) {
            const introSection = document.createElement('section');
            introSection.className = 'fontinfo-name-group';

            const titleEl = document.createElement('h3');
            titleEl.className = 'sidebar-section-title';
            titleEl.textContent = options.sectionTitle;
            introSection.appendChild(titleEl);

            if (options.sectionHelperText) {
                const helper = document.createElement('div');
                helper.className = 'localized-string-helper';
                helper.textContent = options.sectionHelperText;
                introSection.appendChild(helper);
            }

            options.container.appendChild(introSection);
        }

        CUSTOM_OT_GROUPS.forEach((group) => {
            const groupEl = document.createElement('section');
            groupEl.className = 'fontinfo-name-group';

            const titleEl = document.createElement('h3');
            titleEl.className = 'sidebar-section-title';
            titleEl.textContent = group.title;
            groupEl.appendChild(titleEl);

            const fieldsEl = document.createElement('div');
            fieldsEl.className = 'fontinfo-name-group-fields';

            group.fields.forEach((field) => {
                const currentValue = options.customOTValues[field.key];
                const formattedValue =
                    field.kind === 'number-list'
                        ? formatNumberListValue(
                              currentValue as number[] | undefined
                          )
                        : currentValue === undefined || currentValue === null
                          ? ''
                          : String(currentValue);

                fieldsEl.appendChild(
                    this.createSimpleFieldEditor({
                        label: field.label,
                        value: formattedValue,
                        placeholder: field.placeholder,
                        dataField: `${options.dataFieldPrefix}.${field.key}`,
                        helperText: field.helperText,
                        onCommit: (rawValue) => {
                            let nextValue: unknown;

                            if (field.kind === 'integer') {
                                const parsedValue = parseIntegerInput(rawValue);
                                if (parsedValue === null) {
                                    return currentValue === undefined ||
                                        currentValue === null
                                        ? ''
                                        : String(currentValue);
                                }
                                nextValue = parsedValue;
                            } else if (field.kind === 'number-list') {
                                const parsedValue = parseNumberListInput(
                                    rawValue,
                                    field.exactLength
                                );
                                if (parsedValue === null) {
                                    return formatNumberListValue(
                                        currentValue as number[] | undefined
                                    );
                                }
                                nextValue = parsedValue;
                            } else {
                                nextValue =
                                    rawValue.trim().length > 0
                                        ? rawValue
                                        : undefined;
                            }

                            options.onCommit(field.key, nextValue);

                            if (field.kind === 'number-list') {
                                return formatNumberListValue(
                                    nextValue as number[] | undefined
                                );
                            }

                            return nextValue === undefined || nextValue === null
                                ? ''
                                : String(nextValue);
                        }
                    })
                );
            });

            groupEl.appendChild(fieldsEl);
            options.container.appendChild(groupEl);
        });
    }

    private appendLocationSection(options: {
        container: HTMLElement;
        title: string;
        dataFieldPrefix: string;
        location?: Record<string, number>;
        onCommit: (axisTag: string, nextValue: number | undefined) => void;
    }) {
        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        const section = document.createElement('section');
        section.className = 'fontinfo-name-group';

        const titleEl = document.createElement('h3');
        titleEl.className = 'sidebar-section-title';
        titleEl.textContent = options.title;
        section.appendChild(titleEl);

        const fieldsEl = document.createElement('div');
        fieldsEl.className = 'fontinfo-name-group-fields';

        const locationKeys = getLocationKeys(font?.axes, options.location);
        locationKeys.forEach((axisTag) => {
            const axis = font?.axes?.find((item) => item.tag === axisTag);
            const currentValue = options.location?.[axisTag];
            const label = axis
                ? `${getLocalizedDictionarySummary(axis.name, axis.tag)} (${axis.tag})`
                : axisTag;

            fieldsEl.appendChild(
                this.createSimpleFieldEditor({
                    label,
                    value:
                        currentValue === undefined ? '' : String(currentValue),
                    inputType: 'number',
                    placeholder:
                        axis?.default !== undefined
                            ? `Default ${String(axis.default)}`
                            : 'Leave blank for default',
                    dataField: `${options.dataFieldPrefix}.${axisTag}`,
                    helperText: axis
                        ? 'Designspace location value for this axis.'
                        : 'Location value for an axis not currently listed in font.axes.',
                    onCommit: (rawValue) => {
                        const parsedValue = parseNumericInput(rawValue);
                        if (parsedValue === null) {
                            return currentValue === undefined
                                ? ''
                                : String(currentValue);
                        }

                        options.onCommit(axisTag, parsedValue);
                        return parsedValue === undefined
                            ? ''
                            : String(parsedValue);
                    }
                })
            );
        });

        if (locationKeys.length === 0) {
            const helper = document.createElement('div');
            helper.className = 'localized-string-helper';
            helper.textContent =
                'No axes defined, so there are no location coordinates to edit.';
            section.appendChild(helper);
        } else {
            section.appendChild(fieldsEl);
        }

        options.container.appendChild(section);
    }

    private renderMastersContent() {
        if (!this.mastersFieldsContainer) {
            return;
        }

        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        const masters = font?.masters ?? [];
        this.renderedMasterListSignature =
            this.getMasterListStructureSignature(masters);

        this.mastersFieldsContainer.innerHTML = '';

        if (masters.length === 0) {
            this.selectedMasterIndex = 0;
            this.selectedMasterIndices = new Set();
        } else {
            this.selectedMasterIndex = Math.min(
                this.selectedMasterIndex,
                masters.length - 1
            );
            const clamped = new Set(
                [...this.selectedMasterIndices].filter(
                    (i) => i < masters.length
                )
            );
            this.selectedMasterIndices =
                clamped.size > 0
                    ? clamped
                    : new Set([this.selectedMasterIndex]);
        }
        const selectedMaster = masters[this.selectedMasterIndex];

        const layout = document.createElement('div');
        layout.className = 'fontinfo-records-layout';

        const sidebar = document.createElement('aside');
        sidebar.className =
            'view-sidebar view-sidebar-left fontinfo-records-sidebar';
        sidebar.appendChild(
            this.createRecordsSidebarHeader({
                title: 'Masters',
                canRemove:
                    masters.length > 0 && this.selectedMasterIndices.size > 0,
                onAdd: () => this.addMasterRecord(),
                onRemove: () => this.removeSelectedMasterRecord()
            })
        );
        const list = document.createElement('div');
        list.className =
            'sidebar-list editor-layers-list fontinfo-records-list';

        const masterContextMenuBackdrop = getOrCreateBackdrop(
            'fontinfo-master-context-menu-backdrop'
        );

        masters.forEach((master, index) => {
            const masterId = (master as any).id as string | undefined;
            const summary = this.getMasterListSummary(index);
            const btn = this.createRecordListButton({
                primary: summary.primary,
                secondary: summary.secondary,
                selected: this.selectedMasterIndices.has(index),
                draggable: masters.length > 1,
                onClick: (event: MouseEvent) => {
                    const isMulti = event.ctrlKey || event.metaKey;
                    const isRange = event.shiftKey;
                    if (isMulti) {
                        if (this.selectedMasterIndices.has(index)) {
                            if (this.selectedMasterIndices.size > 1) {
                                this.selectedMasterIndices = new Set(
                                    [...this.selectedMasterIndices].filter(
                                        (i) => i !== index
                                    )
                                );
                            }
                        } else {
                            this.selectedMasterIndices = new Set([
                                ...this.selectedMasterIndices,
                                index
                            ]);
                            this.selectedMasterIndex = index;
                        }
                    } else if (isRange) {
                        const lo = Math.min(this.selectedMasterIndex, index);
                        const hi = Math.max(this.selectedMasterIndex, index);
                        const newSet = new Set(this.selectedMasterIndices);
                        for (let i = lo; i <= hi; i++) {
                            newSet.add(i);
                        }
                        this.selectedMasterIndices = newSet;
                        this.selectedMasterIndex = index;
                    } else {
                        this.selectedMasterIndices = new Set([index]);
                        this.selectedMasterIndex = index;
                    }
                    this.renderMastersContent();
                },
                onDragStart: (event) => this.onMasterDragStart(event, index),
                onDragOver: (event) => this.onMasterDragOver(event, index),
                onDrop: (event) => this.onMasterDrop(event, index),
                onDragEnd: () => this.onMasterDragEnd()
            });

            // Context menu — appears on right-click.
            if (masterId) {
                const menuHtml = `<div class="plugin-menu" tabindex="0" role="menu">
                    <div class="plugin-menu-item" data-action="reinterpolate" role="menuitem">
                        <span class="material-symbols-outlined">refresh</span>
                        <span>Reinterpolate all layers</span>
                    </div>
                </div>`;
                const tippyInstance = tippy(btn, {
                    content: menuHtml,
                    allowHTML: true,
                    trigger: 'manual',
                    interactive: true,
                    placement: 'right-start',
                    theme: getTheme(),
                    arrow: false,
                    offset: [0, 4],
                    hideOnClick: false,
                    onShown: (instance) => {
                        const menu =
                            instance.popper.querySelector('.plugin-menu');
                        if (menu) {
                            setupMenuKeyboardNav(menu as HTMLElement);
                            (menu as HTMLElement)
                                .querySelectorAll('.plugin-menu-item')
                                .forEach((item) => {
                                    (item as HTMLElement).onclick = () => {
                                        instance.hide();
                                        if (
                                            item.getAttribute('data-action') ===
                                            'reinterpolate'
                                        ) {
                                            beginLoadingCursor();
                                            this.reinterpolateLayersForMaster(
                                                masterId
                                            )
                                                .catch((err) => {
                                                    console.error(
                                                        'Reinterpolate all layers error:',
                                                        err
                                                    );
                                                })
                                                .finally(() => {
                                                    endLoadingCursor();
                                                });
                                        }
                                    };
                                });
                        }
                    }
                });
                addTippyBackdropSupport(
                    tippyInstance,
                    masterContextMenuBackdrop,
                    {
                        targetElement: btn,
                        activeClass: 'context-menu-active'
                    }
                );
                btn.addEventListener('contextmenu', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const mouseX = event.clientX;
                    const mouseY = event.clientY;
                    tippyInstance.setProps({
                        getReferenceClientRect: () => ({
                            width: 0,
                            height: 0,
                            top: mouseY,
                            bottom: mouseY,
                            left: mouseX,
                            right: mouseX,
                            x: mouseX,
                            y: mouseY,
                            toJSON: () => ({})
                        })
                    });
                    tippyInstance.show();
                });
            }

            list.appendChild(btn);
        });
        sidebar.appendChild(list);

        const detail = document.createElement('div');
        detail.className = 'fontinfo-records-detail';

        if (!selectedMaster) {
            const helper = document.createElement('div');
            helper.className = 'localized-string-helper';
            helper.textContent = 'No masters defined.';
            detail.appendChild(helper);
            layout.appendChild(sidebar);
            layout.appendChild(detail);
            this.mastersFieldsContainer.appendChild(layout);
            return;
        }

        const identitySection = document.createElement('section');
        identitySection.className = 'fontinfo-name-group';
        const identityTitle = document.createElement('h3');
        identityTitle.className = 'sidebar-section-title';
        identityTitle.textContent = 'Identity';
        identitySection.appendChild(identityTitle);
        const identityFields = document.createElement('div');
        identityFields.className = 'fontinfo-name-group-fields';

        const nameEditor = createLocalizedStringEditor({
            label: 'Name',
            value: selectedMaster.name,
            onCommit: (nextValue) =>
                this.commitMasterNameFieldValue(
                    this.selectedMasterIndex,
                    nextValue
                )
        });
        nameEditor.element.setAttribute(
            'data-font-field',
            `masters.${this.selectedMasterIndex}.name`
        );
        identityFields.appendChild(nameEditor.element);
        identitySection.appendChild(identityFields);
        detail.appendChild(identitySection);

        this.appendLocationSection({
            container: detail,
            title: 'Location',
            dataFieldPrefix: `masters.${this.selectedMasterIndex}.location`,
            location: cloneNumericRecord(
                selectedMaster.location as Record<string, number> | undefined
            ),
            onCommit: (axisTag, nextValue) =>
                this.commitMasterLocationValue(
                    this.selectedMasterIndex,
                    axisTag,
                    nextValue
                )
        });

        const metricsSection = document.createElement('section');
        metricsSection.className = 'fontinfo-name-group';
        const metricsTitle = document.createElement('h3');
        metricsTitle.className = 'sidebar-section-title';
        metricsTitle.textContent = 'Metrics';
        metricsSection.appendChild(metricsTitle);
        const metricsFields = document.createElement('div');
        metricsFields.className = 'fontinfo-name-group-fields';

        const additionalMetricsSection = document.createElement('section');
        additionalMetricsSection.className = 'fontinfo-name-group';
        const additionalMetricsTitle = document.createElement('h3');
        additionalMetricsTitle.className = 'sidebar-section-title';
        additionalMetricsTitle.textContent = 'Additional metrics';
        additionalMetricsSection.appendChild(additionalMetricsTitle);
        const additionalMetricsFields = document.createElement('div');
        additionalMetricsFields.className = 'fontinfo-name-group-fields';

        const masterMetrics = selectedMaster.metrics ?? {};
        const metricEntries = Object.entries(masterMetrics).filter(
            ([metricKey]) => !isHiddenMasterMetricsPanelKey(metricKey)
        );
        const coreMetricEntries = metricEntries
            .filter(([metricKey]) => !isAdditionalMetricsPanelKey(metricKey))
            .sort(([left], [right]) => left.localeCompare(right));
        const additionalMetricEntries = [
            ...ADDITIONAL_METRICS_PANEL_KEYS.filter(
                (metricKey) =>
                    masterMetrics[metricKey] !== undefined &&
                    !isHiddenMasterMetricsPanelKey(metricKey)
            ).map(
                (metricKey) =>
                    [metricKey, masterMetrics[metricKey]] as [string, number]
            ),
            ...metricEntries
                .filter(
                    ([metricKey]) =>
                        isAdditionalMetricsPanelKey(metricKey) &&
                        !(
                            ADDITIONAL_METRICS_PANEL_KEYS as readonly string[]
                        ).includes(metricKey)
                )
                .sort(([left], [right]) => left.localeCompare(right))
        ];

        const appendMetricField = (
            container: HTMLElement,
            metricKey: string,
            currentValue: number
        ) => {
            container.appendChild(
                this.createSimpleFieldEditor({
                    label: metricKey,
                    value: String(currentValue),
                    inputType: 'number',
                    dataField: `masters.${this.selectedMasterIndex}.metrics.${metricKey}`,
                    helperText: 'Master-specific numeric metric value.',
                    onCommit: (rawValue) => {
                        const parsedValue = parseNumericInput(rawValue);
                        if (parsedValue === null || parsedValue === undefined) {
                            return String(currentValue);
                        }

                        this.commitMasterMetricValue(
                            this.selectedMasterIndex,
                            metricKey,
                            parsedValue
                        );
                        return String(parsedValue);
                    }
                })
            );
        };

        for (const [metricKey, currentValue] of coreMetricEntries) {
            appendMetricField(metricsFields, metricKey, currentValue as number);
        }

        for (const [metricKey, currentValue] of additionalMetricEntries) {
            appendMetricField(
                additionalMetricsFields,
                metricKey,
                currentValue as number
            );
        }

        if (metricsFields.childElementCount === 0) {
            const helper = document.createElement('div');
            helper.className = 'localized-string-helper';
            helper.textContent = 'No master metrics are defined.';
            metricsSection.appendChild(helper);
        } else {
            metricsSection.appendChild(metricsFields);
        }
        detail.appendChild(metricsSection);

        if (additionalMetricsFields.childElementCount === 0) {
            const helper = document.createElement('div');
            helper.className = 'localized-string-helper';
            helper.textContent = 'No additional metrics are defined.';
            additionalMetricsSection.appendChild(helper);
        } else {
            additionalMetricsSection.appendChild(additionalMetricsFields);
        }
        detail.appendChild(additionalMetricsSection);

        layout.appendChild(sidebar);
        layout.appendChild(detail);
        this.mastersFieldsContainer.appendChild(layout);
    }

    private renderInstancesContent() {
        if (!this.instancesFieldsContainer) {
            return;
        }

        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        const instances = font?.instances ?? [];
        this.renderedInstanceListSignature =
            this.getInstanceListStructureSignature(instances);

        this.instancesFieldsContainer.innerHTML = '';

        if (instances.length === 0) {
            this.selectedInstanceIndex = 0;
            this.selectedInstanceIndices = new Set();
        } else {
            this.selectedInstanceIndex = Math.min(
                this.selectedInstanceIndex,
                instances.length - 1
            );
            const clamped = new Set(
                [...this.selectedInstanceIndices].filter(
                    (i) => i < instances.length
                )
            );
            this.selectedInstanceIndices =
                clamped.size > 0
                    ? clamped
                    : new Set([this.selectedInstanceIndex]);
        }
        const selectedInstance = instances[this.selectedInstanceIndex];

        const layout = document.createElement('div');
        layout.className = 'fontinfo-records-layout';

        const sidebar = document.createElement('aside');
        sidebar.className =
            'view-sidebar view-sidebar-left fontinfo-records-sidebar';
        sidebar.appendChild(
            this.createRecordsSidebarHeader({
                title: 'Instances',
                canRemove:
                    instances.length > 0 &&
                    this.selectedInstanceIndices.size > 0,
                onAdd: () => this.addInstanceRecord(),
                onRemove: () => this.removeSelectedInstanceRecord()
            })
        );
        const list = document.createElement('div');
        list.className =
            'sidebar-list editor-layers-list fontinfo-records-list';

        instances.forEach((instance, index) => {
            const summary = this.getInstanceListSummary(index);
            list.appendChild(
                this.createRecordListButton({
                    primary: summary.primary,
                    secondary: summary.secondary,
                    selected: this.selectedInstanceIndices.has(index),
                    draggable: instances.length > 1,
                    onClick: (event: MouseEvent) => {
                        const isMulti = event.ctrlKey || event.metaKey;
                        const isRange = event.shiftKey;
                        if (isMulti) {
                            if (this.selectedInstanceIndices.has(index)) {
                                if (this.selectedInstanceIndices.size > 1) {
                                    this.selectedInstanceIndices = new Set(
                                        [
                                            ...this.selectedInstanceIndices
                                        ].filter((i) => i !== index)
                                    );
                                }
                            } else {
                                this.selectedInstanceIndices = new Set([
                                    ...this.selectedInstanceIndices,
                                    index
                                ]);
                                this.selectedInstanceIndex = index;
                            }
                        } else if (isRange) {
                            const lo = Math.min(
                                this.selectedInstanceIndex,
                                index
                            );
                            const hi = Math.max(
                                this.selectedInstanceIndex,
                                index
                            );
                            const newSet = new Set(
                                this.selectedInstanceIndices
                            );
                            for (let i = lo; i <= hi; i++) {
                                newSet.add(i);
                            }
                            this.selectedInstanceIndices = newSet;
                            this.selectedInstanceIndex = index;
                        } else {
                            this.selectedInstanceIndices = new Set([index]);
                            this.selectedInstanceIndex = index;
                        }
                        this.renderInstancesContent();
                    },
                    onDragStart: (event) =>
                        this.onInstanceDragStart(event, index),
                    onDragOver: (event) =>
                        this.onInstanceDragOver(event, index),
                    onDrop: (event) => this.onInstanceDrop(event, index),
                    onDragEnd: () => this.onInstanceDragEnd()
                })
            );
        });
        sidebar.appendChild(list);

        const detail = document.createElement('div');
        detail.className = 'fontinfo-records-detail';

        if (!selectedInstance) {
            const helper = document.createElement('div');
            helper.className = 'localized-string-helper';
            helper.textContent = 'No instances defined.';
            detail.appendChild(helper);
            layout.appendChild(sidebar);
            layout.appendChild(detail);
            this.instancesFieldsContainer.appendChild(layout);
            return;
        }

        const identitySection = document.createElement('section');
        identitySection.className = 'fontinfo-name-group';
        const identityTitle = document.createElement('h3');
        identityTitle.className = 'sidebar-section-title';
        identityTitle.textContent = 'Identity';
        identitySection.appendChild(identityTitle);
        const identityFields = document.createElement('div');
        identityFields.className = 'fontinfo-name-group-fields';

        const nameEditor = createLocalizedStringEditor({
            label: 'Name',
            value: selectedInstance.name,
            onCommit: (nextValue) =>
                this.commitInstanceNameFieldValue(
                    this.selectedInstanceIndex,
                    nextValue
                )
        });
        nameEditor.element.setAttribute(
            'data-font-field',
            `instances.${this.selectedInstanceIndex}.name`
        );
        identityFields.appendChild(nameEditor.element);
        identitySection.appendChild(identityFields);
        detail.appendChild(identitySection);

        const exportSection = document.createElement('section');
        exportSection.className = 'fontinfo-name-group';
        const exportTitle = document.createElement('h3');
        exportTitle.className = 'sidebar-section-title';
        exportTitle.textContent = 'Export';
        exportSection.appendChild(exportTitle);
        const exportFields = document.createElement('div');
        exportFields.className = 'fontinfo-name-group-fields';

        exportFields.appendChild(
            this.createCheckboxFieldEditor({
                label: 'Variable Instance',
                checked: Boolean(selectedInstance.variable),
                dataField: `instances.${this.selectedInstanceIndex}.variable`,
                helperText:
                    'If enabled, this instance represents a variable-font export rather than a static instance.',
                onCommit: (checked) =>
                    this.commitInstanceFieldValue(
                        this.selectedInstanceIndex,
                        'variable',
                        checked
                    )
            })
        );

        exportFields.appendChild(
            this.createSimpleFieldEditor({
                label: 'Linked Style',
                value: selectedInstance.linked_style ?? '',
                dataField: `instances.${this.selectedInstanceIndex}.linked_style`,
                helperText:
                    'Optional style-linking target, e.g. Bold or Italic.',
                onCommit: (rawValue) => {
                    const nextValue =
                        rawValue.trim().length > 0
                            ? rawValue.trim()
                            : undefined;
                    this.commitInstanceFieldValue(
                        this.selectedInstanceIndex,
                        'linked_style',
                        nextValue
                    );
                    return nextValue ?? '';
                }
            })
        );

        exportSection.appendChild(exportFields);
        detail.appendChild(exportSection);

        this.appendLocationSection({
            container: detail,
            title: 'Location',
            dataFieldPrefix: `instances.${this.selectedInstanceIndex}.location`,
            location: cloneNumericRecord(
                selectedInstance.location as Record<string, number> | undefined
            ),
            onCommit: (axisTag, nextValue) =>
                this.commitInstanceLocationValue(
                    this.selectedInstanceIndex,
                    axisTag,
                    nextValue
                )
        });

        layout.appendChild(sidebar);
        layout.appendChild(detail);
        this.instancesFieldsContainer.appendChild(layout);
    }

    private renderAxesContent() {
        if (!this.axesFieldsContainer) {
            return;
        }

        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        const axes = font?.axes ?? [];
        this.renderedAxisListSignature =
            this.getAxisListStructureSignature(axes);

        this.axesFieldsContainer.innerHTML = '';

        if (axes.length === 0) {
            this.selectedAxisIndex = 0;
            this.selectedAxisIndices = new Set();
        } else {
            this.selectedAxisIndex = Math.min(
                this.selectedAxisIndex,
                axes.length - 1
            );
            const clamped = new Set(
                [...this.selectedAxisIndices].filter((i) => i < axes.length)
            );
            this.selectedAxisIndices =
                clamped.size > 0 ? clamped : new Set([this.selectedAxisIndex]);
        }
        const selectedAxis = axes[this.selectedAxisIndex];

        const layout = document.createElement('div');
        layout.className = 'fontinfo-records-layout';

        const sidebar = document.createElement('aside');
        sidebar.className =
            'view-sidebar view-sidebar-left fontinfo-records-sidebar';
        sidebar.appendChild(
            this.createRecordsSidebarHeader({
                title: 'Axes',
                canRemove: axes.length > 0 && this.selectedAxisIndices.size > 0,
                onAdd: () => this.addAxisRecord(),
                onRemove: () => this.removeSelectedAxisRecord()
            })
        );
        const list = document.createElement('div');
        list.className =
            'sidebar-list editor-layers-list fontinfo-records-list';

        axes.forEach((axis, index) => {
            const summary = this.getAxisListSummary(index);
            list.appendChild(
                this.createRecordListButton({
                    primary: summary.primary,
                    secondary: summary.secondary,
                    selected: this.selectedAxisIndices.has(index),
                    draggable: axes.length > 1,
                    onClick: (event: MouseEvent) => {
                        const isMulti = event.ctrlKey || event.metaKey;
                        const isRange = event.shiftKey;
                        if (isMulti) {
                            if (this.selectedAxisIndices.has(index)) {
                                if (this.selectedAxisIndices.size > 1) {
                                    this.selectedAxisIndices = new Set(
                                        [...this.selectedAxisIndices].filter(
                                            (i) => i !== index
                                        )
                                    );
                                }
                            } else {
                                this.selectedAxisIndices = new Set([
                                    ...this.selectedAxisIndices,
                                    index
                                ]);
                                this.selectedAxisIndex = index;
                            }
                        } else if (isRange) {
                            const lo = Math.min(this.selectedAxisIndex, index);
                            const hi = Math.max(this.selectedAxisIndex, index);
                            const newSet = new Set(this.selectedAxisIndices);
                            for (let i = lo; i <= hi; i++) {
                                newSet.add(i);
                            }
                            this.selectedAxisIndices = newSet;
                            this.selectedAxisIndex = index;
                        } else {
                            this.selectedAxisIndices = new Set([index]);
                            this.selectedAxisIndex = index;
                        }
                        this.renderAxesContent();
                    },
                    onDragStart: (event) => this.onAxisDragStart(event, index),
                    onDragOver: (event) => this.onAxisDragOver(event, index),
                    onDrop: (event) => this.onAxisDrop(event, index),
                    onDragEnd: () => this.onAxisDragEnd()
                })
            );
        });
        sidebar.appendChild(list);

        const detail = document.createElement('div');
        detail.className = 'fontinfo-records-detail';

        if (!selectedAxis) {
            const helper = document.createElement('div');
            helper.className = 'localized-string-helper';
            helper.textContent = 'No axes defined.';
            detail.appendChild(helper);
            layout.appendChild(sidebar);
            layout.appendChild(detail);
            this.axesFieldsContainer.appendChild(layout);
            return;
        }

        // Identity section
        const identitySection = document.createElement('section');
        identitySection.className = 'fontinfo-name-group';
        const identityTitle = document.createElement('h3');
        identityTitle.className = 'sidebar-section-title';
        identityTitle.textContent = 'Identity';
        identitySection.appendChild(identityTitle);
        const identityFields = document.createElement('div');
        identityFields.className = 'fontinfo-name-group-fields';

        const nameEditor = createLocalizedStringEditor({
            label: 'Name',
            value: selectedAxis.name,
            onCommit: (nextValue) =>
                this.commitAxisNameFieldValue(this.selectedAxisIndex, nextValue)
        });
        nameEditor.element.setAttribute(
            'data-font-field',
            `axes.${this.selectedAxisIndex}.name`
        );
        identityFields.appendChild(nameEditor.element);

        identityFields.appendChild(
            this.createSimpleFieldEditor({
                label: 'Tag',
                value: selectedAxis.tag ?? '',
                dataField: `axes.${this.selectedAxisIndex}.tag`,
                helperText: 'Four-character OpenType axis tag, e.g. wght.',
                onCommit: (rawValue) => {
                    const trimmed = rawValue.trim().slice(0, 4);
                    this.commitAxisTagFieldValue(
                        this.selectedAxisIndex,
                        trimmed
                    );
                    return trimmed;
                }
            })
        );

        identitySection.appendChild(identityFields);
        detail.appendChild(identitySection);

        // Designspace section
        const dsSection = document.createElement('section');
        dsSection.className = 'fontinfo-name-group';
        const dsTitle = document.createElement('h3');
        dsTitle.className = 'sidebar-section-title';
        dsTitle.textContent = 'Designspace';
        dsSection.appendChild(dsTitle);
        const dsDescription = document.createElement('div');
        dsDescription.className = 'localized-string-helper';
        dsDescription.textContent = 'Designspace coordinates are required.';
        dsSection.appendChild(dsDescription);
        const dsFields = document.createElement('div');
        dsFields.className = 'fontinfo-name-group-fields';

        for (const [dsFieldKey, dsLabel, dsHelperText] of [
            [
                'min',
                'Minimum',
                'Designspace coordinate at the userspace minimum.'
            ],
            [
                'max',
                'Maximum',
                'Designspace coordinate at the userspace maximum.'
            ],
            [
                'default',
                'Default',
                'Designspace coordinate at the userspace default.'
            ]
        ] as ['min' | 'max' | 'default', string, string][]) {
            const userspaceValue = selectedAxis[dsFieldKey] as
                number | undefined;
            const currentDsValue = this.getAxisDesignspaceValue(
                selectedAxis,
                userspaceValue
            );
            dsFields.appendChild(
                this.createSimpleFieldEditor({
                    label: dsLabel,
                    value:
                        currentDsValue === undefined
                            ? ''
                            : String(currentDsValue),
                    inputType: 'number',
                    dataField: `axes.${this.selectedAxisIndex}.map.${dsFieldKey}`,
                    helperText: dsHelperText,
                    onCommit: (rawValue) => {
                        const trimmed = rawValue.trim();
                        if (trimmed === '') {
                            this.commitAxisDesignspaceMapValue(
                                this.selectedAxisIndex,
                                dsFieldKey,
                                undefined
                            );
                            return '';
                        }

                        const parsedValue = parseNumericInput(rawValue);
                        if (parsedValue === null || parsedValue === undefined) {
                            return currentDsValue === undefined
                                ? ''
                                : String(currentDsValue);
                        }

                        this.commitAxisDesignspaceMapValue(
                            this.selectedAxisIndex,
                            dsFieldKey,
                            parsedValue
                        );
                        return String(parsedValue);
                    }
                })
            );
        }

        dsSection.appendChild(dsFields);
        detail.appendChild(dsSection);

        // Userspace section
        const rangeSection = document.createElement('section');
        rangeSection.className = 'fontinfo-name-group';
        const rangeTitle = document.createElement('h3');
        rangeTitle.className = 'sidebar-section-title';
        rangeTitle.textContent = 'Userspace';
        rangeSection.appendChild(rangeTitle);
        const rangeDescription = document.createElement('div');
        rangeDescription.className = 'localized-string-helper';
        rangeDescription.textContent =
            'Userspace coordinates are not required. If left empty, designspace coordinates will be used instead.';
        rangeSection.appendChild(rangeDescription);
        const rangeFields = document.createElement('div');
        rangeFields.className = 'fontinfo-name-group-fields';

        for (const [fieldKey, label, helperText] of [
            ['min', 'Minimum', 'Minimum user-space value for this axis.'],
            ['max', 'Maximum', 'Maximum user-space value for this axis.'],
            ['default', 'Default', 'Default user-space value for this axis.']
        ] as ['min' | 'max' | 'default', string, string][]) {
            const currentValue = selectedAxis[fieldKey] as number | undefined;
            rangeFields.appendChild(
                this.createSimpleFieldEditor({
                    label,
                    value:
                        currentValue === undefined ? '' : String(currentValue),
                    inputType: 'number',
                    dataField: `axes.${this.selectedAxisIndex}.${fieldKey}`,
                    helperText,
                    onCommit: (rawValue) => {
                        const parsedValue = parseNumericInput(rawValue);
                        if (parsedValue === null || parsedValue === undefined) {
                            return currentValue === undefined
                                ? ''
                                : String(currentValue);
                        }

                        this.commitAxisRangeValue(
                            this.selectedAxisIndex,
                            fieldKey,
                            parsedValue
                        );
                        return String(parsedValue);
                    }
                })
            );
        }

        rangeSection.appendChild(rangeFields);
        detail.appendChild(rangeSection);

        // Options section
        const optionsSection = document.createElement('section');
        optionsSection.className = 'fontinfo-name-group';
        const optionsTitle = document.createElement('h3');
        optionsTitle.className = 'sidebar-section-title';
        optionsTitle.textContent = 'Options';
        optionsSection.appendChild(optionsTitle);
        const optionsFields = document.createElement('div');
        optionsFields.className = 'fontinfo-name-group-fields';

        optionsFields.appendChild(
            this.createCheckboxFieldEditor({
                label: 'Hidden',
                checked: Boolean(selectedAxis.hidden),
                dataField: `axes.${this.selectedAxisIndex}.hidden`,
                helperText:
                    "If enabled, this axis is hidden in the font's user interface.",
                onCommit: (checked) =>
                    this.commitAxisHiddenValue(this.selectedAxisIndex, checked)
            })
        );

        optionsSection.appendChild(optionsFields);
        detail.appendChild(optionsSection);

        const mapEditor = new AxisMapEditor({
            axis: selectedAxis,
            onCommit: (nextMap) =>
                this.commitAxisMapValue(this.selectedAxisIndex, nextMap)
        });
        detail.appendChild(mapEditor.element);

        layout.appendChild(sidebar);
        layout.appendChild(detail);
        this.axesFieldsContainer.appendChild(layout);
    }

    private renderCustomOTValuesContent() {
        if (!this.customOTValuesFieldsContainer) {
            return;
        }

        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        if (!font) {
            return;
        }

        const customOTValues = (font.custom_ot_values ??
            {}) as Partial<Babelfont.CustomOTValues>;
        this.customOTValuesFieldsContainer.innerHTML = '';

        this.appendCustomOTGroups({
            container: this.customOTValuesFieldsContainer,
            customOTValues,
            dataFieldPrefix: 'custom_ot_values',
            onCommit: (key, nextValue) =>
                this.commitCustomOTValue(key, nextValue)
        });
    }

    private applyLocalNameFieldValue(
        key: FontNameFieldKey,
        nextValue: Babelfont.I18NDictionary
    ) {
        const font = window.currentFontModel;
        if (!font) {
            return;
        }

        const normalizedNextValue = normalizeLocalizedStringValue(nextValue);
        if (Object.keys(normalizedNextValue).length === 0) {
            if (font.names && key in font.names) {
                delete font.names[key];
            }
            return;
        }

        if (!font.names) {
            font.names = {};
        }

        font.names[key] = normalizedNextValue;
    }

    private commitNameFieldValue(
        key: FontNameFieldKey,
        nextValue: Babelfont.I18NDictionary
    ) {
        const font = window.currentFontModel;
        if (!font) {
            return;
        }

        const previousValue = normalizeLocalizedStringValue(font.names?.[key]);
        const normalizedNextValue = normalizeLocalizedStringValue(nextValue);

        if (areLocalizedStringValuesEqual(previousValue, normalizedNextValue)) {
            if (
                this.pendingNamesModelSyncRefresh &&
                this.currentTab === 'names'
            ) {
                requestAnimationFrame(() => this.refreshVisibleNamesContent());
            }
            return;
        }

        const bridge = window.patchSyncEngine as
            | {
                  beginTransaction: (
                      label: string,
                      historyTarget?: unknown,
                      historyMetadata?: {
                          compileChangeSource?: string | null;
                          compileEditType?: string | null;
                      }
                  ) => void;
                  endTransaction: () => void;
                  applySyntheticChangeSet: (
                      label: string,
                      operations: Array<{
                          op: 'set' | 'remove';
                          path: (string | number)[];
                          oldValue: unknown;
                          newValue: unknown;
                          compileChangeSource?: string | null;
                          compileEditType?: string | null;
                      }>,
                      options?: {
                          compileChangeSource?: string | null;
                          compileEditType?: string | null;
                          ignoreRecordingSuppression?: boolean;
                      }
                  ) => void;
                  runWithoutRecording?: <T>(fn: () => T) => T;
              }
            | undefined;

        const label = 'Edit font name';
        if (bridge) {
            bridge.beginTransaction(label, null, {
                compileChangeSource: 'font-info',
                compileEditType: null
            });
            try {
                if (bridge.runWithoutRecording) {
                    bridge.runWithoutRecording(() =>
                        this.applyLocalNameFieldValue(key, normalizedNextValue)
                    );
                } else {
                    this.applyLocalNameFieldValue(key, normalizedNextValue);
                }

                bridge.applySyntheticChangeSet(label, [
                    Object.keys(normalizedNextValue).length === 0
                        ? {
                              op: 'remove',
                              path: ['names', key],
                              compileChangeSource: 'font-info',
                              compileEditType: null,
                              oldValue: { ...previousValue },
                              newValue: undefined
                          }
                        : {
                              op: 'set',
                              path: ['names', key],
                              compileChangeSource: 'font-info',
                              compileEditType: null,
                              oldValue:
                                  Object.keys(previousValue).length > 0
                                      ? { ...previousValue }
                                      : undefined,
                              newValue: { ...normalizedNextValue }
                          }
                ]);
            } finally {
                bridge.endTransaction();
            }
        } else {
            this.applyLocalNameFieldValue(key, normalizedNextValue);
            const currentFont = window.fontManager?.currentFont;
            currentFont?.markDirty?.('font-info-name');
        }

        if (this.pendingNamesModelSyncRefresh && this.currentTab === 'names') {
            requestAnimationFrame(() => this.refreshVisibleNamesContent());
        }
    }

    /**
     * Override the deletion confirmation dialog for testing.
     * Pass `true` to auto-confirm, `false` to auto-cancel, `null` to restore the real dialog.
     */
    setDeleteConfirmationHandler(value: boolean | null): void {
        this._deleteConfirmationHandler = value;
    }

    private showDeleteConfirmDialog(
        message: string,
        callback: (confirmed: boolean) => void
    ): void {
        if (this._deleteConfirmationHandler !== null) {
            callback(this._deleteConfirmationHandler);
            return;
        }
        callback(window.confirm(message));
    }

    private commitFontPathChange(options: {
        label: string;
        path: (string | number)[];
        oldValue: unknown;
        newValue: unknown;
        applyLocal: () => void;
        remove?: boolean;
        markDirtyKey: string;
        refresh?: () => void;
    }) {
        const bridge = window.patchSyncEngine as
            | {
                  beginTransaction: (
                      label: string,
                      historyTarget?: unknown,
                      historyMetadata?: {
                          compileChangeSource?: string | null;
                          compileEditType?: string | null;
                      }
                  ) => void;
                  endTransaction: () => void;
                  applySyntheticChangeSet: (
                      label: string,
                      operations: Array<{
                          op: 'set' | 'remove';
                          path: (string | number)[];
                          oldValue: unknown;
                          newValue: unknown;
                          compileChangeSource?: string | null;
                          compileEditType?: string | null;
                      }>,
                      options?: {
                          compileChangeSource?: string | null;
                          compileEditType?: string | null;
                          ignoreRecordingSuppression?: boolean;
                      }
                  ) => void;
                  runWithoutRecording?: <T>(fn: () => T) => T;
              }
            | undefined;

        if (bridge) {
            bridge.beginTransaction(options.label, null, {
                compileChangeSource: 'font-info',
                compileEditType: null
            });
            try {
                if (bridge.runWithoutRecording) {
                    bridge.runWithoutRecording(() => options.applyLocal());
                } else {
                    options.applyLocal();
                }

                bridge.applySyntheticChangeSet(
                    options.label,
                    [
                        options.remove
                            ? {
                                  op: 'remove',
                                  path: options.path,
                                  oldValue: options.oldValue,
                                  newValue: undefined
                              }
                            : {
                                  op: 'set',
                                  path: options.path,
                                  oldValue: options.oldValue,
                                  newValue: options.newValue
                              }
                    ],
                    {
                        compileChangeSource: 'font-info',
                        compileEditType: null
                    }
                );
            } finally {
                bridge.endTransaction();
            }
        } else {
            options.applyLocal();
            const currentFont = window.fontManager?.currentFont;
            currentFont?.markDirty?.(options.markDirtyKey);
        }

        options.refresh?.();
    }

    private commitMultipleFontPathChanges(options: {
        label: string;
        changes: Array<{
            op?: 'set' | 'remove';
            path: (string | number)[];
            oldValue: unknown;
            newValue: unknown;
        }>;
        applyLocal: () => void;
        markDirtyKey: string;
        refresh?: () => void;
    }) {
        const bridge = window.patchSyncEngine as
            | {
                  beginTransaction: (
                      label: string,
                      historyTarget?: unknown,
                      historyMetadata?: {
                          compileChangeSource?: string | null;
                          compileEditType?: string | null;
                      }
                  ) => void;
                  endTransaction: () => void;
                  applySyntheticChangeSet: (
                      label: string,
                      operations: Array<{
                          op: 'set' | 'remove';
                          path: (string | number)[];
                          oldValue: unknown;
                          newValue: unknown;
                          compileChangeSource?: string | null;
                          compileEditType?: string | null;
                      }>,
                      options?: {
                          compileChangeSource?: string | null;
                          compileEditType?: string | null;
                          ignoreRecordingSuppression?: boolean;
                      }
                  ) => void;
                  runWithoutRecording?: <T>(fn: () => T) => T;
              }
            | undefined;

        if (bridge) {
            bridge.beginTransaction(options.label, null, {
                compileChangeSource: 'font-info',
                compileEditType: null
            });
            try {
                if (bridge.runWithoutRecording) {
                    bridge.runWithoutRecording(() => options.applyLocal());
                } else {
                    options.applyLocal();
                }

                bridge.applySyntheticChangeSet(
                    options.label,
                    options.changes.map((c) => ({
                        op: c.op ?? 'set',
                        path: c.path,
                        oldValue: c.oldValue,
                        newValue: c.newValue
                    })),
                    {
                        compileChangeSource: options.label.includes('master')
                            ? 'master-topology'
                            : 'font-info',
                        compileEditType: options.label.includes('master')
                            ? 'master-topology'
                            : null
                    }
                );
            } finally {
                bridge.endTransaction();
            }
        } else {
            options.applyLocal();
            const currentFont = window.fontManager?.currentFont;
            currentFont?.markDirty?.(options.markDirtyKey);
        }

        options.refresh?.();
    }

    private applyLocalMasterNameFieldValue(
        masterIndex: number,
        nextValue: Babelfont.I18NDictionary
    ) {
        const font = window.currentFontModel as any;
        const master = font?.masters?.[masterIndex];
        if (!master) {
            return;
        }

        const normalizedNextValue = normalizeLocalizedStringValue(nextValue);
        master.name = normalizedNextValue;
    }

    private commitMasterNameFieldValue(
        masterIndex: number,
        nextValue: Babelfont.I18NDictionary
    ) {
        const font = window.currentFontModel as any;
        const master = font?.masters?.[masterIndex];
        if (!master) {
            return;
        }

        const previousValue = normalizeLocalizedStringValue(master.name);
        const normalizedNextValue = normalizeLocalizedStringValue(nextValue);
        if (areLocalizedStringValuesEqual(previousValue, normalizedNextValue)) {
            if (
                this.pendingMastersModelSyncRefresh &&
                this.currentTab === 'masters'
            ) {
                requestAnimationFrame(() =>
                    this.refreshVisibleMastersContent()
                );
            }
            return;
        }

        this.commitFontPathChange({
            label: 'Edit master name',
            path: ['masters', masterIndex, 'name'],
            oldValue: { ...previousValue },
            newValue: { ...normalizedNextValue },
            applyLocal: () =>
                this.applyLocalMasterNameFieldValue(
                    masterIndex,
                    normalizedNextValue
                ),
            markDirtyKey: 'font-info-master-name',
            refresh: () => this.refreshMasterSidebarItemSummary(masterIndex)
        });
    }

    private applyLocalMasterFieldValue(
        masterIndex: number,
        key: MasterFieldKey,
        nextValue: string
    ) {
        const font = window.currentFontModel as any;
        const master = font?.masters?.[masterIndex];
        if (!master) {
            return;
        }

        master[key] = nextValue;
    }

    private commitMasterFieldValue(
        masterIndex: number,
        key: MasterFieldKey,
        nextValue: string
    ) {
        const font = window.currentFontModel as any;
        const master = font?.masters?.[masterIndex];
        if (!master) {
            return;
        }

        const previousValue = master[key];
        if (previousValue === nextValue) {
            return;
        }

        this.commitFontPathChange({
            label: 'Edit master field',
            path: ['masters', masterIndex, key],
            oldValue: previousValue,
            newValue: nextValue,
            applyLocal: () =>
                this.applyLocalMasterFieldValue(masterIndex, key, nextValue),
            markDirtyKey: 'font-info-master-field'
        });
    }

    private applyLocalMasterLocationValue(
        masterIndex: number,
        axisTag: string,
        nextValue: number | undefined
    ) {
        const font = window.currentFontModel as any;
        const master = font?.masters?.[masterIndex];
        if (!master) {
            return;
        }

        if (nextValue === undefined) {
            if (master.location) {
                delete master.location[axisTag];
                if (Object.keys(master.location).length === 0) {
                    delete master.location;
                }
            }
            return;
        }

        if (!master.location) {
            master.location = {};
        }

        master.location[axisTag] = nextValue;
    }

    private commitMasterLocationValue(
        masterIndex: number,
        axisTag: string,
        nextValue: number | undefined
    ) {
        const font = window.currentFontModel as any;
        const master = font?.masters?.[masterIndex];
        if (!master) {
            return;
        }

        const previousValue = master.location?.[axisTag];
        if (previousValue === nextValue) {
            return;
        }

        this.commitFontPathChange({
            label: 'Edit master location',
            path: ['masters', masterIndex, 'location', axisTag],
            oldValue: previousValue,
            newValue: nextValue,
            remove: nextValue === undefined,
            applyLocal: () =>
                this.applyLocalMasterLocationValue(
                    masterIndex,
                    axisTag,
                    nextValue
                ),
            markDirtyKey: 'font-info-master-location',
            refresh: () => this.refreshMasterSidebarItemSummary(masterIndex)
        });
    }

    private applyLocalMasterMetricValue(
        masterIndex: number,
        metricKey: string,
        nextValue: number
    ) {
        const font = window.currentFontModel as any;
        const master = font?.masters?.[masterIndex];
        if (!master) {
            return;
        }

        if (!master.metrics) {
            master.metrics = {};
        }
        master.metrics[metricKey] = nextValue;
    }

    private commitMasterMetricValue(
        masterIndex: number,
        metricKey: string,
        nextValue: number
    ) {
        const font = window.currentFontModel as any;
        const master = font?.masters?.[masterIndex];
        if (!master) {
            return;
        }

        const previousValue = master.metrics?.[metricKey];
        if (previousValue === nextValue) {
            return;
        }

        this.commitFontPathChange({
            label: 'Edit master metric',
            path: ['masters', masterIndex, 'metrics', metricKey],
            oldValue: previousValue,
            newValue: nextValue,
            applyLocal: () =>
                this.applyLocalMasterMetricValue(
                    masterIndex,
                    metricKey,
                    nextValue
                ),
            markDirtyKey: 'font-info-master-metric'
        });
    }

    private applyLocalMasterCustomOTValue(
        masterIndex: number,
        key: CustomOTFieldKey,
        nextValue: unknown
    ) {
        const font = window.currentFontModel as any;
        const master = font?.masters?.[masterIndex];
        if (!master) {
            return;
        }

        if (nextValue === undefined) {
            if (master.custom_ot_values) {
                delete master.custom_ot_values[key];
                if (Object.keys(master.custom_ot_values).length === 0) {
                    delete master.custom_ot_values;
                }
            }
            return;
        }

        if (!master.custom_ot_values) {
            master.custom_ot_values = {};
        }
        master.custom_ot_values[key] = nextValue;
    }

    private commitMasterCustomOTValue(
        masterIndex: number,
        key: CustomOTFieldKey,
        nextValue: unknown
    ) {
        const font = window.currentFontModel as any;
        const master = font?.masters?.[masterIndex];
        if (!master) {
            return;
        }

        const previousValue = master.custom_ot_values?.[key];
        if (areCustomOTFieldValuesEqual(previousValue, nextValue)) {
            return;
        }

        this.commitFontPathChange({
            label: 'Edit master custom OpenType value',
            path: ['masters', masterIndex, 'custom_ot_values', key],
            oldValue: cloneCustomOTFieldValue(previousValue),
            newValue: cloneCustomOTFieldValue(nextValue),
            remove: nextValue === undefined,
            applyLocal: () =>
                this.applyLocalMasterCustomOTValue(masterIndex, key, nextValue),
            markDirtyKey: 'font-info-master-custom-ot'
        });
    }

    private applyLocalInstanceNameFieldValue(
        instanceIndex: number,
        nextValue: Babelfont.I18NDictionary
    ) {
        const font = window.currentFontModel as any;
        const instance = font?.instances?.[instanceIndex];
        if (!instance) {
            return;
        }

        instance.name = normalizeLocalizedStringValue(nextValue);
    }

    private commitInstanceNameFieldValue(
        instanceIndex: number,
        nextValue: Babelfont.I18NDictionary
    ) {
        const font = window.currentFontModel as any;
        const instance = font?.instances?.[instanceIndex];
        if (!instance) {
            return;
        }

        const previousValue = normalizeLocalizedStringValue(instance.name);
        const normalizedNextValue = normalizeLocalizedStringValue(nextValue);
        if (areLocalizedStringValuesEqual(previousValue, normalizedNextValue)) {
            if (
                this.pendingInstancesModelSyncRefresh &&
                this.currentTab === 'instances'
            ) {
                requestAnimationFrame(() =>
                    this.refreshVisibleInstancesContent()
                );
            }
            return;
        }

        this.commitFontPathChange({
            label: 'Edit instance name',
            path: ['instances', instanceIndex, 'name'],
            oldValue: { ...previousValue },
            newValue: { ...normalizedNextValue },
            applyLocal: () =>
                this.applyLocalInstanceNameFieldValue(
                    instanceIndex,
                    normalizedNextValue
                ),
            markDirtyKey: 'font-info-instance-name',
            refresh: () => this.refreshInstanceSidebarItemSummary(instanceIndex)
        });
    }

    private applyLocalInstanceFieldValue(
        instanceIndex: number,
        key: InstanceFieldKey,
        nextValue: string | boolean | undefined
    ) {
        const font = window.currentFontModel as any;
        const instance = font?.instances?.[instanceIndex];
        if (!instance) {
            return;
        }

        if (nextValue === undefined && key === 'linked_style') {
            delete instance.linked_style;
            return;
        }

        instance[key] = nextValue;
    }

    private commitInstanceFieldValue(
        instanceIndex: number,
        key: InstanceFieldKey,
        nextValue: string | boolean | undefined
    ) {
        const font = window.currentFontModel as any;
        const instance = font?.instances?.[instanceIndex];
        if (!instance) {
            return;
        }

        const previousValue = instance[key];
        if (previousValue === nextValue) {
            return;
        }

        this.commitFontPathChange({
            label: 'Edit instance field',
            path: ['instances', instanceIndex, key],
            oldValue: previousValue,
            newValue: nextValue,
            remove: nextValue === undefined && key === 'linked_style',
            applyLocal: () =>
                this.applyLocalInstanceFieldValue(
                    instanceIndex,
                    key,
                    nextValue
                ),
            markDirtyKey: 'font-info-instance-field'
        });
    }

    private applyLocalInstanceLocationValue(
        instanceIndex: number,
        axisTag: string,
        nextValue: number | undefined
    ) {
        const font = window.currentFontModel as any;
        const instance = font?.instances?.[instanceIndex];
        if (!instance) {
            return;
        }

        if (nextValue === undefined) {
            if (instance.location) {
                delete instance.location[axisTag];
                if (Object.keys(instance.location).length === 0) {
                    delete instance.location;
                }
            }
            return;
        }

        if (!instance.location) {
            instance.location = {};
        }
        instance.location[axisTag] = nextValue;
    }

    private commitInstanceLocationValue(
        instanceIndex: number,
        axisTag: string,
        nextValue: number | undefined
    ) {
        const font = window.currentFontModel as any;
        const instance = font?.instances?.[instanceIndex];
        if (!instance) {
            return;
        }

        const previousValue = instance.location?.[axisTag];
        if (previousValue === nextValue) {
            return;
        }

        this.commitFontPathChange({
            label: 'Edit instance location',
            path: ['instances', instanceIndex, 'location', axisTag],
            oldValue: previousValue,
            newValue: nextValue,
            remove: nextValue === undefined,
            applyLocal: () =>
                this.applyLocalInstanceLocationValue(
                    instanceIndex,
                    axisTag,
                    nextValue
                ),
            markDirtyKey: 'font-info-instance-location',
            refresh: () => this.refreshInstanceSidebarItemSummary(instanceIndex)
        });
    }

    private applyLocalInstanceCustomNameFieldValue(
        instanceIndex: number,
        key: FontNameFieldKey,
        nextValue: Babelfont.I18NDictionary
    ) {
        const font = window.currentFontModel as any;
        const instance = font?.instances?.[instanceIndex];
        if (!instance) {
            return;
        }

        if (!instance.custom_names) {
            instance.custom_names = {};
        }

        const normalizedNextValue = normalizeLocalizedStringValue(nextValue);
        if (Object.keys(normalizedNextValue).length === 0) {
            delete instance.custom_names[key];
            return;
        }

        instance.custom_names[key] = normalizedNextValue;
    }

    private commitInstanceCustomNameFieldValue(
        instanceIndex: number,
        key: FontNameFieldKey,
        nextValue: Babelfont.I18NDictionary
    ) {
        const font = window.currentFontModel as any;
        const instance = font?.instances?.[instanceIndex];
        if (!instance) {
            return;
        }

        const previousValue = normalizeLocalizedStringValue(
            instance.custom_names?.[key]
        );
        const normalizedNextValue = normalizeLocalizedStringValue(nextValue);
        if (areLocalizedStringValuesEqual(previousValue, normalizedNextValue)) {
            return;
        }

        this.commitFontPathChange({
            label: 'Edit instance custom name',
            path: ['instances', instanceIndex, 'custom_names', key],
            oldValue:
                Object.keys(previousValue).length > 0
                    ? { ...previousValue }
                    : undefined,
            newValue:
                Object.keys(normalizedNextValue).length > 0
                    ? { ...normalizedNextValue }
                    : undefined,
            remove: Object.keys(normalizedNextValue).length === 0,
            applyLocal: () =>
                this.applyLocalInstanceCustomNameFieldValue(
                    instanceIndex,
                    key,
                    normalizedNextValue
                ),
            markDirtyKey: 'font-info-instance-custom-name'
        });
    }

    private createFontInfoRecordId(prefix: string): string {
        if (
            typeof crypto !== 'undefined' &&
            typeof crypto.randomUUID === 'function'
        ) {
            return crypto.randomUUID();
        }

        return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }

    private getDefaultAxisLocation(): Record<string, number> | undefined {
        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        const locationEntries = (font?.axes ?? [])
            .filter((axis) => axis.default !== undefined)
            .map((axis) => [axis.tag, axis.default as number] as const);

        if (locationEntries.length === 0) {
            return undefined;
        }

        return Object.fromEntries(locationEntries);
    }

    private getDefaultNewMasterLocation(): Record<string, number> | undefined {
        const font =
            window.currentFontModel as unknown as BabelfontModelFont | null;
        const axisDefaults = this.getDefaultAxisLocation() ?? {};
        const lastMaster = rawArray(font?.masters)[
            rawArray(font?.masters).length - 1
        ];
        const lastLocation = lastMaster?.location;
        const normalizedLastLocation = lastLocation
            ? Object.fromEntries(
                  Object.entries(lastLocation).filter(
                      ([, value]) => typeof value === 'number'
                  ) as Array<[string, number]>
              )
            : undefined;

        if (
            !normalizedLastLocation ||
            Object.keys(normalizedLastLocation).length === 0
        ) {
            return Object.keys(axisDefaults).length > 0
                ? axisDefaults
                : undefined;
        }

        return {
            ...axisDefaults,
            ...normalizedLastLocation
        };
    }

    private async promptForNewMasterLocation(): Promise<Record<
        string,
        number
    > | null> {
        const font =
            window.currentFontModel as unknown as BabelfontModelFont | null;
        const axes = rawArray(font?.axes).filter(
            (axis) => typeof axis?.tag === 'string'
        );
        if (axes.length === 0) {
            return {};
        }

        const defaultLocation = this.getDefaultNewMasterLocation() ?? {};

        return await new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className =
                'matplotlib-modal fontinfo-master-location-modal active';
            modal.innerHTML = `
                <div class="matplotlib-modal-content fontinfo-master-location-modal-content">
                    <div class="matplotlib-modal-header">
                        <h3>New Master Location</h3>
                        <button type="button" class="matplotlib-modal-close" aria-label="Close">×</button>
                    </div>
                    <div class="matplotlib-modal-body fontinfo-master-location-modal-body">
                        <div class="fontinfo-master-location-description">
                            Adjust the designspace location for the new master before creating it.
                        </div>
                        <div class="fontinfo-master-location-rows"></div>
                        <div class="fontinfo-master-location-actions">
                            <button type="button" class="dialog-button fontinfo-master-location-cancel">Cancel</button>
                            <button type="button" class="dialog-button dialog-button-primary fontinfo-master-location-create">Create</button>
                        </div>
                    </div>
                </div>
            `;

            const rows = modal.querySelector(
                '.fontinfo-master-location-rows'
            ) as HTMLElement;
            const closeButton = modal.querySelector(
                '.matplotlib-modal-close'
            ) as HTMLButtonElement;
            const cancelButton = modal.querySelector(
                '.fontinfo-master-location-cancel'
            ) as HTMLButtonElement;
            const createButton = modal.querySelector(
                '.fontinfo-master-location-create'
            ) as HTMLButtonElement;
            const inputs = new Map<string, HTMLInputElement>();

            const closeModal = (value: Record<string, number> | null): void => {
                escapeBinding?.release();
                escapeBinding = null;
                document.removeEventListener('keydown', onKeyDown, true);
                modal.remove();
                resolve(value);
            };

            const commit = (): void => {
                const nextLocation: Record<string, number> = {};

                for (const axis of axes) {
                    const input = inputs.get(axis.tag as string);
                    if (!input) {
                        continue;
                    }

                    const trimmedValue = input.value.trim();
                    if (!trimmedValue.length) {
                        continue;
                    }

                    const parsedValue = Number(trimmedValue);
                    if (!Number.isFinite(parsedValue)) {
                        input.focus();
                        input.select();
                        return;
                    }

                    nextLocation[axis.tag as string] = parsedValue;
                }

                closeModal(nextLocation);
            };

            let escapeBinding: ModalEscapeBinding | null = null;

            const onKeyDown = (event: KeyboardEvent): void => {
                if (event.key === 'Enter') {
                    const target = event.target;
                    if (target instanceof HTMLInputElement) {
                        event.preventDefault();
                        commit();
                    }
                }
            };

            for (const axis of axes) {
                const row = document.createElement('div');
                row.className = 'fontinfo-master-location-row';

                const label = document.createElement('label');
                label.className = 'fontinfo-master-location-label';
                label.textContent =
                    (typeof axis.name === 'string'
                        ? axis.name
                        : axis.name?.dflt) ||
                    axis.tag ||
                    'Axis';
                label.htmlFor = `fontinfo-master-location-${axis.tag}`;

                const input = document.createElement('input');
                input.type = 'number';
                input.step = 'any';
                input.id = `fontinfo-master-location-${axis.tag}`;
                input.dataset.masterLocationAxis = axis.tag as string;
                input.className =
                    'localized-string-input localized-string-modal-input fontinfo-master-location-input';
                const defaultValue = defaultLocation[axis.tag as string];
                input.value =
                    typeof defaultValue === 'number'
                        ? String(defaultValue)
                        : '';

                row.appendChild(label);
                row.appendChild(input);
                rows.appendChild(row);
                inputs.set(axis.tag as string, input);
            }

            closeButton.addEventListener('click', () => closeModal(null));
            cancelButton.addEventListener('click', () => closeModal(null));
            createButton.addEventListener('click', commit);
            modal.addEventListener('click', (event: MouseEvent) => {
                if (event.target === modal) {
                    closeModal(null);
                }
            });
            escapeBinding = bindModalEscape(() => closeModal(null), {
                isOpen: () => modal.isConnected
            });
            document.addEventListener('keydown', onKeyDown, true);
            document.body.appendChild(modal);
            requestAnimationFrame(() => {
                inputs.values().next().value?.focus();
            });
        });
    }

    private createDefaultInstanceRecord(): Babelfont.Instance {
        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        const nextIndex = (font?.instances?.length ?? 0) + 1;

        return {
            id: this.createFontInfoRecordId('instance'),
            name: { dflt: `Instance ${nextIndex}` },
            location: this.getDefaultAxisLocation(),
            custom_names: {},
            variable: false
        };
    }

    private applyLocalMastersList(nextMasters: Babelfont.Master[]) {
        const font = window.currentFontModel as any;
        if (!font) {
            return;
        }

        font.masters = nextMasters;
    }

    private commitMastersListChange(
        label: string,
        nextMasters: Babelfont.Master[]
    ) {
        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        if (!font) {
            return;
        }

        const previousMasters = rawArray(font.masters).map(cloneMasterRecord);
        const clonedNextMasters = rawArray(nextMasters).map(cloneMasterRecord);

        this.commitFontPathChange({
            label,
            path: ['masters'],
            oldValue: previousMasters.length > 0 ? previousMasters : undefined,
            newValue: clonedNextMasters,
            applyLocal: () => this.applyLocalMastersList(clonedNextMasters),
            markDirtyKey: 'font-info-masters-list',
            refresh: () => {
                this.forceRefreshVisibleMastersContent();
                void (
                    window.glyphCanvas as
                        | {
                              updatePropertiesUI?: (options?: {
                                  skipAutoSelectMatchingLayer?: boolean;
                              }) => Promise<void>;
                          }
                        | undefined
                )?.updatePropertiesUI?.({
                    skipAutoSelectMatchingLayer: true
                });
            }
        });
    }

    /**
     * Re-interpolates all glyph layers that are bound to the given master ID.
     * Delegates to OutlineEditor.reinterpolateAllLayersForMaster which fires
     * all interpolation requests concurrently (O(1) worker latency instead of
     * O(N)) and applies all results in a single synchronous pass.
     *
     */
    private async reinterpolateLayersForMaster(
        masterId: string
    ): Promise<void> {
        const font =
            window.currentFontModel as unknown as BabelfontModelFont | null;
        const modelMaster = font?.findMaster(masterId);
        if (!modelMaster) {
            return;
        }

        await modelMaster.reinterpolateLayers();
    }

    private async addMasterRecord() {
        const font =
            window.currentFontModel as unknown as BabelfontModelFont | null;
        if (!font || typeof font.addMaster !== 'function') {
            return;
        }

        const requestedLocation = await this.promptForNewMasterLocation();
        if (requestedLocation === null) {
            return;
        }

        try {
            const metricTemplateMasterId = rawArray(font.masters)[
                this.selectedMasterIndex
            ]?.id;
            const createdMaster = await font.addMaster(undefined, {
                location:
                    Object.keys(requestedLocation).length > 0
                        ? requestedLocation
                        : undefined,
                metricTemplateMasterId
            });
            const selectedMasterIndex = createdMaster
                ? rawArray(font.masters).findIndex(
                      (master) => master.id === createdMaster.id
                  )
                : rawArray(font.masters).length - 1;
            this.selectedMasterIndex = Math.max(0, selectedMasterIndex);
            this.selectedMasterIndices = new Set([this.selectedMasterIndex]);
            this.forceRefreshVisibleMastersContent();
        } catch (err) {
            console.error(
                'addMasterRecord: object-model addMaster failed:',
                err
            );
            throw err;
        }
    }

    private removeSelectedMasterRecord() {
        const font =
            window.currentFontModel as unknown as BabelfontModelFont | null;
        const masters = font?.masters ?? [];
        if (masters.length === 0) {
            return;
        }

        const indicesToRemove = new Set(
            [...this.selectedMasterIndices].filter((i) => i < masters.length)
        );
        if (indicesToRemove.size === 0) {
            return;
        }

        const masterNames = [...indicesToRemove]
            .sort((a, b) => a - b)
            .map((i) => {
                const m = masters[i];
                const n = m?.name;
                if (typeof n === 'string') return n;
                if (n && typeof n === 'object' && 'dflt' in n)
                    return (n as { dflt: string }).dflt;
                return `Master ${i + 1}`;
            })
            .join(', ');
        const count = indicesToRemove.size;
        const message =
            count === 1
                ? `Delete master "${masterNames}"? This will also remove its layers from all glyphs.`
                : `Delete ${count} masters (${masterNames})? This will also remove their layers from all glyphs.`;

        this.showDeleteConfirmDialog(message, async (confirmed) => {
            if (!confirmed) {
                return;
            }

            const masterIds = [...indicesToRemove]
                .map((i) => (masters[i] as any)?.id as string | undefined)
                .filter((id): id is string => typeof id === 'string');
            const nextMasterCount = Math.max(
                0,
                masters.length - indicesToRemove.size
            );

            // Choose new primary selection: first remaining index
            const firstRemaining = [...Array(masters.length).keys()].find(
                (i) => !indicesToRemove.has(i)
            );
            this.selectedMasterIndex =
                firstRemaining !== undefined
                    ? firstRemaining
                    : Math.max(0, nextMasterCount - 1);
            this.selectedMasterIndices =
                nextMasterCount > 0
                    ? new Set([this.selectedMasterIndex])
                    : new Set();

            if (typeof font?.removeMastersByIds !== 'function') {
                return;
            }

            await font.removeMastersByIds(masterIds);

            this.forceRefreshVisibleMastersContent();
        });
    }

    private reorderMastersList(fromIndex: number, insertionIndex: number) {
        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        const masters = rawArray(font?.masters).map(cloneMasterRecord);
        if (
            fromIndex < 0 ||
            fromIndex >= masters.length ||
            insertionIndex < 0 ||
            insertionIndex > masters.length
        ) {
            return;
        }

        const [movedMaster] = masters.splice(fromIndex, 1);
        if (!movedMaster) {
            return;
        }

        const adjustedTargetIndex =
            fromIndex < insertionIndex ? insertionIndex - 1 : insertionIndex;
        if (adjustedTargetIndex === fromIndex) {
            return;
        }

        masters.splice(adjustedTargetIndex, 0, movedMaster);
        this.selectedMasterIndex = adjustedTargetIndex;
        this.commitMastersListChange('Reorder masters', masters);
    }

    private onMasterDragStart(event: DragEvent, index: number) {
        this.draggedMasterIndex = index;
        this.masterDragCommitted = false;
        this.clearMasterDropIndicator();
        (event.currentTarget as HTMLElement | null)?.classList.add('dragging');
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            try {
                event.dataTransfer.setData('text/plain', String(index));
            } catch {
                // Some test environments expose partial dataTransfer shims.
            }
        }
    }

    private onMasterDragOver(event: DragEvent, targetIndex: number) {
        event.preventDefault();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'move';
        }
        if (this.draggedMasterIndex === null) {
            return;
        }

        const target = event.currentTarget as HTMLElement | null;
        if (!target) {
            return;
        }

        const rect = target.getBoundingClientRect();
        const placement: RecordDropPlacement =
            event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
        this.setMasterDropIndicator(targetIndex, placement);
    }

    private onMasterDrop(event: DragEvent, targetIndex: number) {
        event.preventDefault();
        const insertionIndex = this.getMasterDropInsertionIndex(targetIndex);
        this.clearMasterDropIndicator();

        if (this.draggedMasterIndex === null || insertionIndex === null) {
            return;
        }

        const originalIndex = this.draggedMasterIndex;
        this.masterDragCommitted = true;
        this.draggedMasterIndex = null;
        this.reorderMastersList(originalIndex, insertionIndex);
    }

    private onMasterDragEnd() {
        const originalIndex = this.draggedMasterIndex;
        const insertionIndex =
            originalIndex !== null && this.masterDropTargetIndex !== null
                ? this.getMasterDropInsertionIndex(this.masterDropTargetIndex)
                : null;
        const shouldCommitFallback =
            !this.masterDragCommitted &&
            originalIndex !== null &&
            insertionIndex !== null;

        this.clearMasterDropIndicator();
        this.draggedMasterIndex = null;
        this.masterDragCommitted = false;
        this.mastersFieldsContainer
            ?.querySelectorAll('.fontinfo-record-item')
            .forEach((item) => item.classList.remove('dragging'));

        if (shouldCommitFallback) {
            this.reorderMastersList(originalIndex, insertionIndex);
        } else {
            requestAnimationFrame(() =>
                this.forceRefreshVisibleMastersContent()
            );
        }
    }

    private setMasterDropIndicator(
        targetIndex: number,
        placement: RecordDropPlacement
    ) {
        if (
            this.masterDropTargetIndex === targetIndex &&
            this.masterDropTargetPlacement === placement
        ) {
            return;
        }

        this.clearMasterDropIndicator();
        const target = this.getMasterListItems()[targetIndex];
        if (!target) {
            return;
        }

        target.classList.add(
            placement === 'before'
                ? 'feature-drop-target-before'
                : 'feature-drop-target-after'
        );
        this.masterDropTargetIndex = targetIndex;
        this.masterDropTargetPlacement = placement;
    }

    private clearMasterDropIndicator() {
        if (this.masterDropTargetIndex !== null) {
            const previousTarget =
                this.getMasterListItems()[this.masterDropTargetIndex];
            previousTarget?.classList.remove(
                'feature-drop-target-before',
                'feature-drop-target-after'
            );
        }

        this.masterDropTargetIndex = null;
        this.masterDropTargetPlacement = null;
    }

    private getMasterDropInsertionIndex(
        fallbackTargetIndex: number
    ): number | null {
        if (this.draggedMasterIndex === null) {
            return null;
        }

        const targetIndex = this.masterDropTargetIndex ?? fallbackTargetIndex;
        const placement = this.masterDropTargetPlacement ?? 'before';
        return placement === 'after' ? targetIndex + 1 : targetIndex;
    }

    private applyLocalInstancesList(nextInstances: Babelfont.Instance[]) {
        const font = window.currentFontModel as any;
        if (!font) {
            return;
        }

        font.instances = nextInstances;
    }

    private commitInstancesListChange(
        label: string,
        nextInstances: Babelfont.Instance[]
    ) {
        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        if (!font) {
            return;
        }

        const previousInstances = rawArray(font.instances).map(
            cloneInstanceRecord
        );
        const clonedNextInstances =
            rawArray(nextInstances).map(cloneInstanceRecord);

        this.commitFontPathChange({
            label,
            path: ['instances'],
            oldValue:
                previousInstances.length > 0 ? previousInstances : undefined,
            newValue: clonedNextInstances,
            applyLocal: () => this.applyLocalInstancesList(clonedNextInstances),
            markDirtyKey: 'font-info-instances-list',
            refresh: () => this.forceRefreshVisibleInstancesContent()
        });
    }

    private addInstanceRecord() {
        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        if (!font) {
            return;
        }

        const nextInstances = [
            ...rawArray(font.instances).map(cloneInstanceRecord),
            this.createDefaultInstanceRecord()
        ];
        this.selectedInstanceIndex = nextInstances.length - 1;
        this.selectedInstanceIndices = new Set([this.selectedInstanceIndex]);
        this.commitInstancesListChange('Add instance', nextInstances);
    }

    private removeSelectedInstanceRecord() {
        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        const instances = font?.instances ?? [];
        if (instances.length === 0) {
            return;
        }

        const indicesToRemove = new Set(
            [...this.selectedInstanceIndices].filter(
                (i) => i < instances.length
            )
        );
        if (indicesToRemove.size === 0) {
            return;
        }

        const instanceNames = [...indicesToRemove]
            .sort((a, b) => a - b)
            .map((i) => {
                const inst = instances[i];
                const n = inst?.name;
                if (typeof n === 'string') return n;
                if (n && typeof n === 'object' && 'dflt' in n)
                    return (n as { dflt: string }).dflt;
                return `Instance ${i + 1}`;
            })
            .join(', ');
        const count = indicesToRemove.size;
        const message =
            count === 1
                ? `Delete instance "${instanceNames}"?`
                : `Delete ${count} instances (${instanceNames})?`;

        this.showDeleteConfirmDialog(message, (confirmed) => {
            if (!confirmed) {
                return;
            }

            const nextInstances = rawArray(instances)
                .map(cloneInstanceRecord)
                .filter((_, i) => !indicesToRemove.has(i));

            const firstRemaining = [...Array(instances.length).keys()].find(
                (i) => !indicesToRemove.has(i)
            );
            this.selectedInstanceIndex =
                firstRemaining !== undefined
                    ? firstRemaining
                    : Math.max(0, nextInstances.length - 1);
            this.selectedInstanceIndices =
                nextInstances.length > 0
                    ? new Set([this.selectedInstanceIndex])
                    : new Set();

            this.commitInstancesListChange('Remove instance', nextInstances);
        });
    }

    private reorderInstancesList(fromIndex: number, insertionIndex: number) {
        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        const instances = rawArray(font?.instances).map(cloneInstanceRecord);
        if (
            fromIndex < 0 ||
            fromIndex >= instances.length ||
            insertionIndex < 0 ||
            insertionIndex > instances.length
        ) {
            return;
        }

        const [movedInstance] = instances.splice(fromIndex, 1);
        if (!movedInstance) {
            return;
        }

        const adjustedTargetIndex =
            fromIndex < insertionIndex ? insertionIndex - 1 : insertionIndex;
        if (adjustedTargetIndex === fromIndex) {
            return;
        }

        instances.splice(adjustedTargetIndex, 0, movedInstance);
        this.selectedInstanceIndex = adjustedTargetIndex;
        this.commitInstancesListChange('Reorder instances', instances);
    }

    private onInstanceDragStart(event: DragEvent, index: number) {
        this.draggedInstanceIndex = index;
        this.instanceDragCommitted = false;
        this.clearInstanceDropIndicator();
        (event.currentTarget as HTMLElement | null)?.classList.add('dragging');
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            try {
                event.dataTransfer.setData('text/plain', String(index));
            } catch {
                // Some test environments expose partial dataTransfer shims.
            }
        }
    }

    private onInstanceDragOver(event: DragEvent, targetIndex: number) {
        event.preventDefault();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'move';
        }
        if (this.draggedInstanceIndex === null) {
            return;
        }

        const target = event.currentTarget as HTMLElement | null;
        if (!target) {
            return;
        }

        const rect = target.getBoundingClientRect();
        const placement: RecordDropPlacement =
            event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
        this.setInstanceDropIndicator(targetIndex, placement);
    }

    private onInstanceDrop(event: DragEvent, targetIndex: number) {
        event.preventDefault();
        const insertionIndex = this.getInstanceDropInsertionIndex(targetIndex);
        this.clearInstanceDropIndicator();

        if (this.draggedInstanceIndex === null || insertionIndex === null) {
            return;
        }

        const originalIndex = this.draggedInstanceIndex;
        this.instanceDragCommitted = true;
        this.draggedInstanceIndex = null;
        this.reorderInstancesList(originalIndex, insertionIndex);
    }

    private onInstanceDragEnd() {
        const originalIndex = this.draggedInstanceIndex;
        const insertionIndex =
            originalIndex !== null && this.instanceDropTargetIndex !== null
                ? this.getInstanceDropInsertionIndex(
                      this.instanceDropTargetIndex
                  )
                : null;
        const shouldCommitFallback =
            !this.instanceDragCommitted &&
            originalIndex !== null &&
            insertionIndex !== null;

        this.clearInstanceDropIndicator();
        this.draggedInstanceIndex = null;
        this.instanceDragCommitted = false;
        this.instancesFieldsContainer
            ?.querySelectorAll('.fontinfo-record-item')
            .forEach((item) => item.classList.remove('dragging'));

        if (shouldCommitFallback) {
            this.reorderInstancesList(originalIndex, insertionIndex);
        } else {
            requestAnimationFrame(() =>
                this.forceRefreshVisibleInstancesContent()
            );
        }
    }

    private setInstanceDropIndicator(
        targetIndex: number,
        placement: RecordDropPlacement
    ) {
        if (
            this.instanceDropTargetIndex === targetIndex &&
            this.instanceDropTargetPlacement === placement
        ) {
            return;
        }

        this.clearInstanceDropIndicator();
        const target = this.getInstanceListItems()[targetIndex];
        if (!target) {
            return;
        }

        target.classList.add(
            placement === 'before'
                ? 'feature-drop-target-before'
                : 'feature-drop-target-after'
        );
        this.instanceDropTargetIndex = targetIndex;
        this.instanceDropTargetPlacement = placement;
    }

    private clearInstanceDropIndicator() {
        if (this.instanceDropTargetIndex !== null) {
            const previousTarget =
                this.getInstanceListItems()[this.instanceDropTargetIndex];
            previousTarget?.classList.remove(
                'feature-drop-target-before',
                'feature-drop-target-after'
            );
        }

        this.instanceDropTargetIndex = null;
        this.instanceDropTargetPlacement = null;
    }

    private getInstanceDropInsertionIndex(
        fallbackTargetIndex: number
    ): number | null {
        if (this.draggedInstanceIndex === null) {
            return null;
        }

        const targetIndex = this.instanceDropTargetIndex ?? fallbackTargetIndex;
        const placement = this.instanceDropTargetPlacement ?? 'before';
        return placement === 'after' ? targetIndex + 1 : targetIndex;
    }

    // ── Axes list operations ──────────────────────────────────────────────────

    private createDefaultAxisRecord(): Babelfont.Axis {
        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        const existingTags = new Set((font?.axes ?? []).map((a) => a.tag));
        const candidates = [
            'wght',
            'wdth',
            'ital',
            'slnt',
            'opsz',
            'GRAD',
            'XOPQ',
            'YOPQ'
        ];
        const tag =
            candidates.find((t) => !existingTags.has(t)) ??
            `AX${String((font?.axes?.length ?? 0) + 1).padStart(2, '0')}`;
        const nextIndex = (font?.axes?.length ?? 0) + 1;

        return {
            name: { dflt: `Axis ${nextIndex}` },
            tag,
            min: 0,
            default: 0,
            max: 1000
        };
    }

    private applyLocalAxesList(nextAxes: Babelfont.Axis[]) {
        const font = window.currentFontModel as any;
        if (!font) {
            return;
        }

        font.axes = nextAxes;
    }

    private commitAxesListChange(label: string, nextAxes: Babelfont.Axis[]) {
        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        if (!font) {
            return;
        }

        const previousAxes = rawArray(font.axes).map(cloneAxisRecord);
        const clonedNextAxes = rawArray(nextAxes).map(cloneAxisRecord);

        this.commitFontPathChange({
            label,
            path: ['axes'],
            oldValue: previousAxes.length > 0 ? previousAxes : undefined,
            newValue: clonedNextAxes,
            applyLocal: () => this.applyLocalAxesList(clonedNextAxes),
            markDirtyKey: 'font-info-axes-list',
            refresh: () => {
                this.forceRefreshVisibleAxesContent();
                void window.glyphCanvas?.axesManager?.updateAxesUI?.();
            }
        });
    }

    private addAxisRecord() {
        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        if (!font) {
            return;
        }

        const newAxis = this.createDefaultAxisRecord();
        const nextAxes = [...rawArray(font.axes).map(cloneAxisRecord), newAxis];
        this.selectedAxisIndex = nextAxes.length - 1;
        this.selectedAxisIndices = new Set([this.selectedAxisIndex]);

        const previousAxes = rawArray(font.axes).map(cloneAxisRecord);
        const clonedNextAxes = rawArray(nextAxes).map(cloneAxisRecord);
        const tag = newAxis.tag;
        const designspaceDefault = newAxis.default ?? 0;

        const changes: Array<{
            path: (string | number)[];
            oldValue: unknown;
            newValue: unknown;
        }> = [
            {
                path: ['axes'],
                oldValue: previousAxes.length > 0 ? previousAxes : undefined,
                newValue: clonedNextAxes
            }
        ];

        (font.masters ?? []).forEach((master, index) => {
            const prevLoc = {
                ...((master.location as Record<string, number> | undefined) ??
                    {})
            };
            changes.push({
                path: ['masters', index, 'location'],
                oldValue: Object.keys(prevLoc).length > 0 ? prevLoc : undefined,
                newValue: { ...prevLoc, [tag]: designspaceDefault }
            });
        });

        (font.instances ?? []).forEach((instance, index) => {
            const prevLoc = {
                ...((instance.location as Record<string, number> | undefined) ??
                    {})
            };
            changes.push({
                path: ['instances', index, 'location'],
                oldValue: Object.keys(prevLoc).length > 0 ? prevLoc : undefined,
                newValue: { ...prevLoc, [tag]: designspaceDefault }
            });
        });

        this.commitMultipleFontPathChanges({
            label: 'Add axis',
            changes,
            applyLocal: () => {
                this.applyLocalAxesList(clonedNextAxes);
                (window.currentFontModel as any)?.masters?.forEach(
                    (master: any) => {
                        master.location = {
                            ...(master.location ?? {}),
                            [tag]: designspaceDefault
                        };
                    }
                );
                (window.currentFontModel as any)?.instances?.forEach(
                    (instance: any) => {
                        instance.location = {
                            ...(instance.location ?? {}),
                            [tag]: designspaceDefault
                        };
                    }
                );
            },
            markDirtyKey: 'font-info-axes-list',
            refresh: () => {
                this.forceRefreshVisibleAxesContent();
                void window.glyphCanvas?.axesManager?.updateAxesUI?.();
            }
        });
    }

    private removeSelectedAxisRecord() {
        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        const axes = font?.axes ?? [];
        if (axes.length === 0) {
            return;
        }

        const indicesToRemove = new Set(
            [...this.selectedAxisIndices].filter((i) => i < axes.length)
        );
        if (indicesToRemove.size === 0) {
            return;
        }

        const axisNames = [...indicesToRemove]
            .sort((a, b) => a - b)
            .map((i) => {
                const ax = axes[i];
                const n = ax?.name;
                if (typeof n === 'string') return n;
                if (n && typeof n === 'object' && 'dflt' in n)
                    return (n as { dflt: string }).dflt;
                return ax?.tag ?? `Axis ${i + 1}`;
            })
            .join(', ');
        const count = indicesToRemove.size;
        const message =
            count === 1
                ? `Delete axis "${axisNames}"?`
                : `Delete ${count} axes (${axisNames})?`;

        this.showDeleteConfirmDialog(message, (confirmed) => {
            if (!confirmed) {
                return;
            }

            // Collect tags of removed axes for location cleanup
            const removedTags = [...indicesToRemove]
                .map((i) => axes[i]?.tag)
                .filter((t): t is string => typeof t === 'string');

            const nextAxes = rawArray(axes)
                .map(cloneAxisRecord)
                .filter((_, i) => !indicesToRemove.has(i));

            const firstRemaining = [...Array(axes.length).keys()].find(
                (i) => !indicesToRemove.has(i)
            );
            this.selectedAxisIndex =
                firstRemaining !== undefined
                    ? firstRemaining
                    : Math.max(0, nextAxes.length - 1);
            this.selectedAxisIndices =
                nextAxes.length > 0
                    ? new Set([this.selectedAxisIndex])
                    : new Set();

            const previousAxes = rawArray(axes).map(cloneAxisRecord);
            const clonedNextAxes = rawArray(nextAxes).map(cloneAxisRecord);

            const changes: Array<{
                path: (string | number)[];
                oldValue: unknown;
                newValue: unknown;
            }> = [
                {
                    path: ['axes'],
                    oldValue:
                        previousAxes.length > 0 ? previousAxes : undefined,
                    newValue: clonedNextAxes
                }
            ];

            for (const tag of removedTags) {
                (font?.masters ?? []).forEach((master, index) => {
                    const loc = master.location as
                        Record<string, number> | undefined;
                    if (loc && tag in loc) {
                        const restLoc = { ...loc };
                        delete (restLoc as Record<string, unknown>)[tag];
                        changes.push({
                            path: ['masters', index, 'location'],
                            oldValue: loc,
                            newValue:
                                Object.keys(restLoc).length > 0
                                    ? restLoc
                                    : undefined
                        });
                    }
                });

                (font?.instances ?? []).forEach((instance, index) => {
                    const loc = instance.location as
                        Record<string, number> | undefined;
                    if (loc && tag in loc) {
                        const restLoc = { ...loc };
                        delete (restLoc as Record<string, unknown>)[tag];
                        changes.push({
                            path: ['instances', index, 'location'],
                            oldValue: loc,
                            newValue:
                                Object.keys(restLoc).length > 0
                                    ? restLoc
                                    : undefined
                        });
                    }
                });
            }

            this.commitMultipleFontPathChanges({
                label: 'Remove axis',
                changes,
                applyLocal: () => {
                    this.applyLocalAxesList(clonedNextAxes);
                    for (const tag of removedTags) {
                        (window.currentFontModel as any)?.masters?.forEach(
                            (master: any) => {
                                if (master.location) {
                                    delete master.location[tag];
                                }
                            }
                        );
                        (window.currentFontModel as any)?.instances?.forEach(
                            (instance: any) => {
                                if (instance.location) {
                                    delete instance.location[tag];
                                }
                            }
                        );
                    }
                },
                markDirtyKey: 'font-info-axes-list',
                refresh: () => {
                    this.forceRefreshVisibleAxesContent();
                    void window.glyphCanvas?.axesManager?.updateAxesUI?.();
                }
            });
        });
    }

    private reorderAxesList(fromIndex: number, insertionIndex: number) {
        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        const axes = rawArray(font?.axes).map(cloneAxisRecord);
        if (
            fromIndex < 0 ||
            fromIndex >= axes.length ||
            insertionIndex < 0 ||
            insertionIndex > axes.length
        ) {
            return;
        }

        const [movedAxis] = axes.splice(fromIndex, 1);
        if (!movedAxis) {
            return;
        }

        const adjustedTargetIndex =
            fromIndex < insertionIndex ? insertionIndex - 1 : insertionIndex;
        if (adjustedTargetIndex === fromIndex) {
            return;
        }

        axes.splice(adjustedTargetIndex, 0, movedAxis);
        this.selectedAxisIndex = adjustedTargetIndex;
        this.commitAxesListChange('Reorder axes', axes);
    }

    private onAxisDragStart(event: DragEvent, index: number) {
        this.draggedAxisIndex = index;
        this.axisDragCommitted = false;
        this.clearAxisDropIndicator();
        (event.currentTarget as HTMLElement | null)?.classList.add('dragging');
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            try {
                event.dataTransfer.setData('text/plain', String(index));
            } catch {
                // Some test environments expose partial dataTransfer shims.
            }
        }
    }

    private onAxisDragOver(event: DragEvent, targetIndex: number) {
        event.preventDefault();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'move';
        }
        if (this.draggedAxisIndex === null) {
            return;
        }

        const target = event.currentTarget as HTMLElement | null;
        if (!target) {
            return;
        }

        const rect = target.getBoundingClientRect();
        const placement: RecordDropPlacement =
            event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
        this.setAxisDropIndicator(targetIndex, placement);
    }

    private onAxisDrop(event: DragEvent, targetIndex: number) {
        event.preventDefault();
        const insertionIndex = this.getAxisDropInsertionIndex(targetIndex);
        this.clearAxisDropIndicator();

        if (this.draggedAxisIndex === null || insertionIndex === null) {
            return;
        }

        const originalIndex = this.draggedAxisIndex;
        this.axisDragCommitted = true;
        this.draggedAxisIndex = null;
        this.reorderAxesList(originalIndex, insertionIndex);
    }

    private onAxisDragEnd() {
        const originalIndex = this.draggedAxisIndex;
        const insertionIndex =
            originalIndex !== null && this.axisDropTargetIndex !== null
                ? this.getAxisDropInsertionIndex(this.axisDropTargetIndex)
                : null;
        const shouldCommitFallback =
            !this.axisDragCommitted &&
            originalIndex !== null &&
            insertionIndex !== null;

        this.clearAxisDropIndicator();
        this.draggedAxisIndex = null;
        this.axisDragCommitted = false;
        this.axesFieldsContainer
            ?.querySelectorAll('.fontinfo-record-item')
            .forEach((item) => item.classList.remove('dragging'));

        if (shouldCommitFallback) {
            this.reorderAxesList(originalIndex, insertionIndex);
        } else {
            requestAnimationFrame(() => this.forceRefreshVisibleAxesContent());
        }
    }

    private setAxisDropIndicator(
        targetIndex: number,
        placement: RecordDropPlacement
    ) {
        if (
            this.axisDropTargetIndex === targetIndex &&
            this.axisDropTargetPlacement === placement
        ) {
            return;
        }

        this.clearAxisDropIndicator();
        const target = this.getAxisListItems()[targetIndex];
        if (!target) {
            return;
        }

        target.classList.add(
            placement === 'before'
                ? 'feature-drop-target-before'
                : 'feature-drop-target-after'
        );
        this.axisDropTargetIndex = targetIndex;
        this.axisDropTargetPlacement = placement;
    }

    private clearAxisDropIndicator() {
        if (this.axisDropTargetIndex !== null) {
            const previousTarget =
                this.getAxisListItems()[this.axisDropTargetIndex];
            previousTarget?.classList.remove(
                'feature-drop-target-before',
                'feature-drop-target-after'
            );
        }

        this.axisDropTargetIndex = null;
        this.axisDropTargetPlacement = null;
    }

    private getAxisDropInsertionIndex(
        fallbackTargetIndex: number
    ): number | null {
        if (this.draggedAxisIndex === null) {
            return null;
        }

        const targetIndex = this.axisDropTargetIndex ?? fallbackTargetIndex;
        const placement = this.axisDropTargetPlacement ?? 'before';
        return placement === 'after' ? targetIndex + 1 : targetIndex;
    }

    // ── Axes individual field commits ────────────────────────────────────────

    private commitAxisNameFieldValue(
        axisIndex: number,
        nextValue: Babelfont.I18NDictionary
    ) {
        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        const axis = font?.axes?.[axisIndex];
        if (!axis) {
            return;
        }

        const previousValue = normalizeLocalizedStringValue(axis.name);
        const normalizedNextValue = normalizeLocalizedStringValue(nextValue);
        if (areLocalizedStringValuesEqual(previousValue, normalizedNextValue)) {
            if (
                this.pendingAxesModelSyncRefresh &&
                this.currentTab === 'axes'
            ) {
                requestAnimationFrame(() => this.refreshVisibleAxesContent());
            }
            return;
        }

        this.commitFontPathChange({
            label: 'Edit axis name',
            path: ['axes', axisIndex, 'name'],
            oldValue: previousValue,
            newValue: normalizedNextValue,
            applyLocal: () => {
                const liveAxis = (
                    window.currentFontModel as unknown as
                        Babelfont.Font | undefined
                )?.axes?.[axisIndex] as any;
                if (liveAxis) {
                    liveAxis.name = normalizedNextValue;
                }
            },
            markDirtyKey: 'font-info-axis-name',
            refresh: () => this.refreshAxisSidebarItemSummary(axisIndex)
        });
    }

    private commitAxisTagFieldValue(axisIndex: number, nextValue: string) {
        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        const axis = font?.axes?.[axisIndex];
        if (!axis) {
            return;
        }

        const previousValue = axis.tag;
        if (previousValue === nextValue) {
            return;
        }

        this.commitFontPathChange({
            label: 'Edit axis tag',
            path: ['axes', axisIndex, 'tag'],
            oldValue: previousValue,
            newValue: nextValue,
            applyLocal: () => {
                const liveAxis = (
                    window.currentFontModel as unknown as
                        Babelfont.Font | undefined
                )?.axes?.[axisIndex] as any;
                if (liveAxis) {
                    liveAxis.tag = nextValue;
                }
            },
            markDirtyKey: 'font-info-axis-tag',
            refresh: () => this.refreshAxisSidebarItemSummary(axisIndex)
        });
    }

    private commitAxisRangeValue(
        axisIndex: number,
        field: 'min' | 'max' | 'default',
        nextValue: number
    ) {
        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        const axis = font?.axes?.[axisIndex];
        if (!axis) {
            return;
        }

        const previousValue = axis[field];
        if (previousValue === nextValue) {
            return;
        }

        const changes: Array<{
            op?: 'set' | 'remove';
            path: (string | number)[];
            oldValue: unknown;
            newValue: unknown;
        }> = [
            {
                path: ['axes', axisIndex, field],
                oldValue: previousValue,
                newValue: nextValue
            }
        ];

        // Keep map endpoints aligned with userspace min/max when the range moves.
        if (
            (field === 'min' || field === 'max') &&
            typeof previousValue === 'number' &&
            Array.isArray(axis.map) &&
            axis.map.length > 0
        ) {
            const previousMap = (axis.map ?? []) as [number, number][];
            let replaced = false;
            const nextMap = previousMap
                .map(([userspace, designspace]) => {
                    if (userspace === previousValue) {
                        replaced = true;
                        return [nextValue, designspace] as [number, number];
                    }
                    return [userspace, designspace] as [number, number];
                })
                .sort((left, right) => left[0] - right[0]);
            if (replaced) {
                changes.push({
                    path: ['axes', axisIndex, 'map'],
                    oldValue: previousMap,
                    newValue: nextMap
                });
            }
        }

        this.commitMultipleFontPathChanges({
            label: `Edit axis ${field}`,
            changes,
            applyLocal: () => {
                const liveAxis = (
                    window.currentFontModel as unknown as
                        Babelfont.Font | undefined
                )?.axes?.[axisIndex] as any;
                if (!liveAxis) {
                    return;
                }
                liveAxis[field] = nextValue;
                const mapChange = changes.find(
                    (change) =>
                        Array.isArray(change.path) && change.path[2] === 'map'
                );
                if (mapChange) {
                    liveAxis.map = mapChange.newValue;
                }
            },
            markDirtyKey: `font-info-axis-${field}`,
            refresh: () => {
                this.refreshAxisSidebarItemSummary(axisIndex);
                this.forceRefreshVisibleAxesContent();
                void window.glyphCanvas?.axesManager?.updateAxesUI?.();
            }
        });
    }

    private commitAxisHiddenValue(axisIndex: number, nextValue: boolean) {
        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        const axis = font?.axes?.[axisIndex];
        if (!axis) {
            return;
        }

        const previousValue = Boolean(axis.hidden);
        if (previousValue === nextValue) {
            return;
        }

        this.commitFontPathChange({
            label: 'Edit axis hidden',
            path: ['axes', axisIndex, 'hidden'],
            oldValue: previousValue,
            newValue: nextValue,
            applyLocal: () => {
                const liveAxis = (
                    window.currentFontModel as unknown as
                        Babelfont.Font | undefined
                )?.axes?.[axisIndex] as any;
                if (liveAxis) {
                    liveAxis.hidden = nextValue;
                }
            },
            markDirtyKey: 'font-info-axis-hidden'
        });
    }

    private getAxisDesignspaceValue(
        axis: Babelfont.Axis,
        userspaceValue: number | undefined
    ): number | undefined {
        if (
            userspaceValue === undefined ||
            !axis.map ||
            axis.map.length === 0
        ) {
            return undefined;
        }

        const entry = axis.map.find(([u]) => u === userspaceValue);
        return entry?.[1] as number | undefined;
    }

    private commitAxisDesignspaceMapValue(
        axisIndex: number,
        field: 'min' | 'max' | 'default',
        nextDesignspaceValue: number | undefined
    ) {
        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        const axis = font?.axes?.[axisIndex];
        if (!axis) {
            return;
        }

        const userspaceValue = axis[field] as number | undefined;
        if (userspaceValue === undefined) {
            return;
        }

        const currentMap = (axis.map ?? []) as [number, number][];
        const previousDesignspaceValue = currentMap.find(
            ([u]) => u === userspaceValue
        )?.[1];

        if (previousDesignspaceValue === nextDesignspaceValue) {
            return;
        }

        let nextMap: [number, number][];
        if (nextDesignspaceValue === undefined) {
            nextMap = currentMap.filter(([u]) => u !== userspaceValue);
        } else {
            nextMap = [
                ...currentMap.filter(([u]) => u !== userspaceValue),
                [userspaceValue, nextDesignspaceValue] as [number, number]
            ].sort((a, b) => a[0] - b[0]);
        }

        this.commitAxisMapValue(
            axisIndex,
            nextMap,
            `Edit axis ${field} designspace`
        );
    }

    private commitAxisMapValue(
        axisIndex: number,
        nextMap: [number, number][],
        label: string = 'Edit axis mapping'
    ) {
        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        const axis = font?.axes?.[axisIndex];
        if (!axis) {
            return;
        }

        const previousMap = axis.map ?? null;
        const sortedMap = [...nextMap]
            .map(
                ([userspace, designspace]) =>
                    [Number(userspace), Number(designspace)] as [number, number]
            )
            .sort((a, b) => a[0] - b[0]);
        const newMap = sortedMap.length > 0 ? sortedMap : null;

        if (JSON.stringify(previousMap) === JSON.stringify(newMap)) {
            return;
        }

        const changes: Array<{
            op?: 'set' | 'remove';
            path: (string | number)[];
            oldValue: unknown;
            newValue: unknown;
        }> = [
            {
                path: ['axes', axisIndex, 'map'],
                oldValue: previousMap,
                newValue: newMap
            }
        ];

        let nextMin = axis.min as number | undefined;
        let nextMax = axis.max as number | undefined;
        if (newMap && newMap.length > 0) {
            const userspaceValues = newMap.map(([userspace]) => userspace);
            const mapMin = Math.min(...userspaceValues);
            const mapMax = Math.max(...userspaceValues);
            if (typeof nextMin !== 'number' || mapMin < nextMin) {
                changes.push({
                    path: ['axes', axisIndex, 'min'],
                    oldValue: axis.min,
                    newValue: mapMin
                });
                nextMin = mapMin;
            }
            if (typeof nextMax !== 'number' || mapMax > nextMax) {
                changes.push({
                    path: ['axes', axisIndex, 'max'],
                    oldValue: axis.max,
                    newValue: mapMax
                });
                nextMax = mapMax;
            }
        }

        this.commitMultipleFontPathChanges({
            label,
            changes,
            applyLocal: () => {
                const liveAxis = (
                    window.currentFontModel as unknown as
                        Babelfont.Font | undefined
                )?.axes?.[axisIndex] as any;
                if (!liveAxis) {
                    return;
                }
                liveAxis.map = newMap;
                if (typeof nextMin === 'number') {
                    liveAxis.min = nextMin;
                }
                if (typeof nextMax === 'number') {
                    liveAxis.max = nextMax;
                }
            },
            markDirtyKey: 'font-info-axis-map',
            refresh: () => {
                this.refreshAxisSidebarItemSummary(axisIndex);
                this.forceRefreshVisibleAxesContent();
                void window.glyphCanvas?.axesManager?.updateAxesUI?.();
            }
        });
    }

    private applyLocalRootFontFieldValue(
        key: FontRootFieldKey,
        nextValue: Babelfont.Font[FontRootFieldKey] | undefined
    ) {
        const font = window.currentFontModel;
        if (!font) {
            return;
        }

        if (nextValue === undefined && key === 'note') {
            delete font.note;
            return;
        }

        if (nextValue !== undefined) {
            (font[key] as Babelfont.Font[FontRootFieldKey]) = nextValue;
        }
    }

    private commitRootFontFieldValue(
        key: FontRootFieldKey,
        nextValue: Babelfont.Font[FontRootFieldKey] | undefined
    ) {
        const font = window.currentFontModel;
        if (!font) {
            return;
        }

        const previousValue = font[key];
        const isEqual =
            key === 'version'
                ? Array.isArray(previousValue) &&
                  Array.isArray(nextValue) &&
                  previousValue[0] === nextValue[0] &&
                  previousValue[1] === nextValue[1]
                : key === 'date'
                  ? previousValue instanceof Date &&
                    nextValue instanceof Date &&
                    previousValue.getTime() === nextValue.getTime()
                  : previousValue === nextValue;

        if (isEqual) {
            if (
                this.pendingGeneralModelSyncRefresh &&
                this.currentTab === 'general'
            ) {
                requestAnimationFrame(() =>
                    this.refreshVisibleGeneralContent()
                );
            }
            return;
        }

        const bridge = window.patchSyncEngine as
            | {
                  beginTransaction: (
                      label: string,
                      historyTarget?: unknown,
                      historyMetadata?: {
                          compileChangeSource?: string | null;
                          compileEditType?: string | null;
                      }
                  ) => void;
                  endTransaction: () => void;
                  applySyntheticChangeSet: (
                      label: string,
                      operations: Array<{
                          op: 'set' | 'remove';
                          path: (string | number)[];
                          oldValue: unknown;
                          newValue: unknown;
                          compileChangeSource?: string | null;
                          compileEditType?: string | null;
                      }>,
                      options?: {
                          compileChangeSource?: string | null;
                          compileEditType?: string | null;
                          ignoreRecordingSuppression?: boolean;
                      }
                  ) => void;
                  runWithoutRecording?: <T>(fn: () => T) => T;
              }
            | undefined;

        const label = 'Edit font property';
        const normalizedOldValue =
            key === 'version'
                ? cloneVersionValue(previousValue as [number, number])
                : previousValue instanceof Date
                  ? new Date(previousValue)
                  : previousValue;
        const normalizedNextValue =
            key === 'version'
                ? cloneVersionValue(nextValue as [number, number])
                : nextValue instanceof Date
                  ? new Date(nextValue)
                  : nextValue;

        if (bridge) {
            bridge.beginTransaction(label, null, {
                compileChangeSource: 'font-info',
                compileEditType: null
            });
            try {
                if (bridge.runWithoutRecording) {
                    bridge.runWithoutRecording(() =>
                        this.applyLocalRootFontFieldValue(key, nextValue)
                    );
                } else {
                    this.applyLocalRootFontFieldValue(key, nextValue);
                }

                bridge.applySyntheticChangeSet(
                    label,
                    [
                        nextValue === undefined
                            ? {
                                  op: 'remove',
                                  path: [key],
                                  oldValue: normalizedOldValue,
                                  newValue: undefined
                              }
                            : {
                                  op: 'set',
                                  path: [key],
                                  oldValue: normalizedOldValue,
                                  newValue: normalizedNextValue
                              }
                    ],
                    {
                        compileChangeSource: 'font-info',
                        compileEditType: null
                    }
                );
            } finally {
                bridge.endTransaction();
            }
        } else {
            this.applyLocalRootFontFieldValue(key, nextValue);
            const currentFont = window.fontManager?.currentFont;
            currentFont?.markDirty?.('font-info-root');
        }

        if (
            this.pendingGeneralModelSyncRefresh &&
            this.currentTab === 'general'
        ) {
            requestAnimationFrame(() => this.refreshVisibleGeneralContent());
        }
    }

    private applyLocalCustomOTValue(key: CustomOTFieldKey, nextValue: unknown) {
        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        if (!font) {
            return;
        }

        if (nextValue === undefined) {
            const customOTValues = font.custom_ot_values as
                Partial<Babelfont.CustomOTValues> | undefined;
            if (customOTValues) {
                delete customOTValues[key];
                if (Object.keys(customOTValues).length === 0) {
                    delete font.custom_ot_values;
                }
            }
            return;
        }

        if (!font.custom_ot_values) {
            font.custom_ot_values = {} as Babelfont.CustomOTValues;
        }

        const customOTValues =
            font.custom_ot_values as Partial<Babelfont.CustomOTValues>;
        customOTValues[key] = nextValue as never;
    }

    private commitCustomOTValue(key: CustomOTFieldKey, nextValue: unknown) {
        const font = window.currentFontModel as unknown as
            Babelfont.Font | undefined;
        if (!font) {
            return;
        }

        const previousValue = (
            font.custom_ot_values as
                Partial<Babelfont.CustomOTValues> | undefined
        )?.[key];
        if (areCustomOTFieldValuesEqual(previousValue, nextValue)) {
            if (
                this.pendingCustomOTValuesModelSyncRefresh &&
                this.currentTab === 'custom_ot_values'
            ) {
                requestAnimationFrame(() =>
                    this.refreshVisibleCustomOTValuesContent()
                );
            }
            return;
        }

        const bridge = window.patchSyncEngine as
            | {
                  beginTransaction: (
                      label: string,
                      historyTarget?: unknown,
                      historyMetadata?: {
                          compileChangeSource?: string | null;
                          compileEditType?: string | null;
                      }
                  ) => void;
                  endTransaction: () => void;
                  applySyntheticChangeSet: (
                      label: string,
                      operations: Array<{
                          op: 'set' | 'remove';
                          path: (string | number)[];
                          oldValue: unknown;
                          newValue: unknown;
                          compileChangeSource?: string | null;
                          compileEditType?: string | null;
                      }>,
                      options?: {
                          compileChangeSource?: string | null;
                          compileEditType?: string | null;
                          ignoreRecordingSuppression?: boolean;
                      }
                  ) => void;
                  runWithoutRecording?: <T>(fn: () => T) => T;
              }
            | undefined;

        const label = 'Edit custom OpenType value';
        const normalizedOldValue = cloneCustomOTFieldValue(previousValue);
        const normalizedNextValue = cloneCustomOTFieldValue(nextValue);

        if (bridge) {
            bridge.beginTransaction(label, null, {
                compileChangeSource: 'font-info',
                compileEditType: null
            });
            try {
                if (bridge.runWithoutRecording) {
                    bridge.runWithoutRecording(() =>
                        this.applyLocalCustomOTValue(key, nextValue)
                    );
                } else {
                    this.applyLocalCustomOTValue(key, nextValue);
                }

                bridge.applySyntheticChangeSet(
                    label,
                    [
                        nextValue === undefined
                            ? {
                                  op: 'remove',
                                  path: ['custom_ot_values', key],
                                  compileChangeSource: 'font-info',
                                  compileEditType: null,
                                  oldValue: normalizedOldValue,
                                  newValue: undefined
                              }
                            : {
                                  op: 'set',
                                  path: ['custom_ot_values', key],
                                  compileChangeSource: 'font-info',
                                  compileEditType: null,
                                  oldValue: normalizedOldValue,
                                  newValue: normalizedNextValue
                              }
                    ],
                    {
                        compileChangeSource: 'font-info',
                        compileEditType: null
                    }
                );
            } finally {
                bridge.endTransaction();
            }
        } else {
            this.applyLocalCustomOTValue(key, nextValue);
            const currentFont = window.fontManager?.currentFont;
            currentFont?.markDirty?.('font-info-custom-ot');
        }

        if (
            this.pendingCustomOTValuesModelSyncRefresh &&
            this.currentTab === 'custom_ot_values'
        ) {
            requestAnimationFrame(() =>
                this.refreshVisibleCustomOTValuesContent()
            );
        }
    }

    private refreshVisibleFeatureContent() {
        if (this.currentTab !== 'features' || !window.currentFontModel) {
            return;
        }

        if (this.featuresEditor?.isFocused?.() && this.featureCodeDirty) {
            return;
        }

        if (!this.featuresEditorInitialized) {
            this.initializeFeaturesEditor();
            this.featuresEditorInitialized = true;
        }

        const previousSelection = this.selectedItem
            ? { ...this.selectedItem }
            : null;
        const previousCursor =
            this.featuresEditor?.getCursorPosition?.() ?? null;
        const previousScrollTop =
            this.featuresEditor?.session?.getScrollTop?.() ?? null;
        const previousScrollLeft =
            this.featuresEditor?.session?.getScrollLeft?.() ?? null;

        this.loadAllLists();
        this.fontDataLoaded = true;
        this.pendingModelSyncRefresh = false;

        if (
            previousSelection &&
            this.selectedItem &&
            previousSelection.type === this.selectedItem.type &&
            previousSelection.key === this.selectedItem.key
        ) {
            if (previousCursor) {
                this.featuresEditor?.moveCursorTo?.(
                    previousCursor.row,
                    previousCursor.column
                );
            }
            if (previousScrollTop !== null) {
                this.featuresEditor?.session?.setScrollTop?.(previousScrollTop);
            }
            if (previousScrollLeft !== null) {
                this.featuresEditor?.session?.setScrollLeft?.(
                    previousScrollLeft
                );
            }
        }
    }

    private loadAllLists() {
        console.log('[FontInfo] loadAllLists called');
        this.loadPrefixesList();
        this.loadClassesList();
        this.loadFeaturesList();
    }

    private loadPrefixesList() {
        const listContainer = document.getElementById('prefixes-list');
        console.log('[FontInfo] loadPrefixesList - container:', listContainer);
        if (!listContainer) return;

        const font = window.currentFontModel;
        if (!font || !font.features || !font.features.prefixes) {
            listContainer.innerHTML =
                '<div class="features-empty">No prefixes</div>';
            return;
        }

        const prefixes = font.features.prefixes;
        const prefixKeys = Object.keys(prefixes);
        console.log('[FontInfo] Found', prefixKeys.length, 'prefixes');

        if (prefixKeys.length === 0) {
            listContainer.innerHTML =
                '<div class="features-empty">No prefixes</div>';
            return;
        }

        this.prefixListItems.clear();
        this.prefixCodeData.clear();
        listContainer.innerHTML = '';

        prefixKeys.forEach((key) => {
            const item = this.createListItem('prefix', key, prefixes[key]);
            this.prefixListItems.set(key, item);
            this.prefixCodeData.set(key, prefixes[key].code || '');
            listContainer.appendChild(item);
        });

        // Apply search filter if there are active search terms
        if (this.searchTerms.length > 0) {
            this.applyFeaturesSearch();
        }
    }

    private parseClassGlyphMembers(classCode: string): Set<string> {
        const glyphs = new Set<string>();
        if (!classCode) return glyphs;

        // Remove comments
        const codeWithoutComments = classCode.replace(/#.*/g, '');

        // Split by whitespace - the class code is already a space-separated list
        const tokens = codeWithoutComments
            .split(/\s+/)
            .map((t) => t.trim())
            .filter((t) => t.length > 0);

        tokens.forEach((token) => {
            if (token.startsWith('@')) {
                // It's a nested class reference - will be resolved later
                glyphs.add(token);
            } else {
                // It's a glyph name
                glyphs.add(token);
            }
        });

        return glyphs;
    }

    private getAllGlyphsInClass(
        className: string,
        visited: Set<string> = new Set()
    ): Set<string> {
        const allGlyphs = new Set<string>();

        // Prevent infinite recursion
        if (visited.has(className)) return allGlyphs;
        visited.add(className);

        // Remove @ prefix if present
        const cleanName = className.startsWith('@')
            ? className.slice(1)
            : className;
        const members = this.classGlyphMembers.get(cleanName);

        if (!members) return allGlyphs;

        members.forEach((member) => {
            if (member.startsWith('@')) {
                // Recursively get glyphs from nested class
                const nestedGlyphs = this.getAllGlyphsInClass(member, visited);
                nestedGlyphs.forEach((g) => allGlyphs.add(g));
            } else {
                allGlyphs.add(member);
            }
        });

        return allGlyphs;
    }

    private classContainsGlyph(className: string, glyphName: string): boolean {
        const allGlyphs = this.getAllGlyphsInClass(className);
        return allGlyphs.has(glyphName);
    }

    private loadClassesList() {
        const listContainer = document.getElementById('classes-list');
        if (!listContainer) return;

        const font = window.currentFontModel;
        if (!font || !font.features || !font.features.classes) {
            listContainer.innerHTML =
                '<div class="features-empty">No classes</div>';
            return;
        }

        const classes = font.features.classes;
        const classKeys = Object.keys(classes);

        if (classKeys.length === 0) {
            listContainer.innerHTML =
                '<div class="features-empty">No classes</div>';
            return;
        }

        this.classListItems.clear();
        this.classCodeData.clear();
        this.classGlyphMembers.clear();
        listContainer.innerHTML = '';

        classKeys.forEach((key) => {
            const item = this.createListItem('class', key, classes[key]);
            this.classListItems.set(key, item);
            this.classCodeData.set(key, classes[key].code || '');
            // Parse and store glyph members for this class
            const members = this.parseClassGlyphMembers(
                classes[key].code || ''
            );
            this.classGlyphMembers.set(key, members);
            listContainer.appendChild(item);
        });

        // Apply search filter if there are active search terms
        if (this.searchTerms.length > 0) {
            this.applyFeaturesSearch();
        }
    }

    private extractLanguageSystems(): string[] {
        const font = window.currentFontModel;
        if (!font || !font.features) return ['DFLT'];

        const scripts = new Set<string>();
        scripts.add('DFLT'); // Always include default

        // Parse all feature code for languagesystem declarations
        const allCode: string[] = [];

        // Collect from prefixes
        if (font.features.prefixes) {
            Object.values(font.features.prefixes).forEach((prefix) => {
                if (prefix.code) allCode.push(prefix.code);
            });
        }

        // Collect from features
        if (font.features.features) {
            font.features.features.forEach(([_, codeData]) => {
                if (codeData.code) allCode.push(codeData.code);
            });
        }

        // Parse languagesystem declarations
        const languageSystemRegex = /languagesystem\s+(\w+)\s+\w+/gi;
        allCode.forEach((code) => {
            let match;
            while ((match = languageSystemRegex.exec(code)) !== null) {
                scripts.add(match[1]);
            }
        });

        return Array.from(scripts).sort();
    }

    private loadFeaturesList(options?: {
        preserveFeatureEditorDraft?: boolean;
    }) {
        const listContainer = document.getElementById('features-list');
        console.log('[FontInfo] loadFeaturesList - container:', listContainer);
        if (!listContainer) return;

        this.clearFeatureDropIndicator();

        const font = window.currentFontModel;
        if (!font || !font.features) {
            listContainer.innerHTML =
                '<div class="features-empty">No features</div>';
            return;
        }

        const features = font.features.features || [];
        console.log('[FontInfo] Found', features.length, 'features');

        if (features.length === 0) {
            listContainer.innerHTML =
                '<div class="features-empty">No features</div>';
            return;
        }

        // Detect supported scripts and create dropdown
        const supportedScripts = this.extractLanguageSystems();
        console.log('[FontInfo] Supported scripts:', supportedScripts);

        // Map scripts to shapers and deduplicate
        const shaperMap = new Map<string, string[]>(); // shaper -> [scripts]
        supportedScripts.forEach((script) => {
            const shaper = SCRIPT_TO_SHAPER[script] || 'default';
            if (!shaperMap.has(shaper)) {
                shaperMap.set(shaper, []);
            }
            shaperMap.get(shaper)!.push(script);
        });

        // Get unique shapers sorted alphabetically
        const availableShapers = Array.from(shaperMap.keys()).sort();

        // Ensure selectedShaper is valid, otherwise use first available
        if (
            !availableShapers.includes(this.selectedShaper) &&
            availableShapers.length > 0
        ) {
            this.selectedShaper = availableShapers[0];
            console.log(
                '[FontInfo] Defaulting to shaper:',
                this.selectedShaper
            );
        }

        // Build feature list with shaper dropdown
        // Save scroll position before rebuilding
        const sidebar = listContainer.closest('.features-sidebar');
        const wasAtBottom = sidebar
            ? sidebar.scrollHeight - sidebar.scrollTop - sidebar.clientHeight <
              5
            : false;

        this.featureListItems.clear();
        this.featureCodeData.clear();
        listContainer.innerHTML = '';

        // Add shaper selector dropdown if multiple shapers
        if (availableShapers.length > 1) {
            const scriptSelectorContainer = document.createElement('div');
            scriptSelectorContainer.className = 'feature-script-selector';

            const label = document.createElement('span');
            label.className = 'feature-script-selector-label';
            label.textContent = 'Shaper:';

            const select = document.createElement('select');
            select.className = 'feature-script-dropdown';

            availableShapers.forEach((shaper) => {
                const option = document.createElement('option');
                option.value = shaper;
                // Capitalize shaper name for display
                const displayName =
                    shaper.charAt(0).toUpperCase() + shaper.slice(1);
                option.textContent = displayName;
                if (shaper === this.selectedShaper) {
                    option.selected = true;
                }
                select.appendChild(option);
            });

            select.addEventListener('change', () => {
                this.selectedShaper = select.value;
                console.log(
                    '[FontInfo] Shaper changed to:',
                    this.selectedShaper
                );
                this.loadFeaturesList(); // Reload with new shaper order
            });

            scriptSelectorContainer.appendChild(label);
            scriptSelectorContainer.appendChild(select);
            listContainer.appendChild(scriptSelectorContainer);
        }

        // Get feature execution order for selected shaper
        const executionOrder = getFeatureExecutionOrder(this.selectedShaper);
        console.log(
            '[FontInfo] Execution order for',
            this.selectedShaper,
            ':',
            executionOrder
        );

        // Build categorized feature lists
        const categorized = this.categorizeFeaturesByScript(
            features,
            executionOrder,
            supportedScripts
        );

        // Helper to add section header
        const addSectionHeader = (text: string) => {
            const separator = document.createElement('div');
            separator.className = 'feature-section-separator';
            separator.textContent = text;
            listContainer.appendChild(separator);
        };

        // Add features by category
        if (categorized.usedByShaper.length > 0) {
            const shaperDisplayName =
                this.selectedShaper.charAt(0).toUpperCase() +
                this.selectedShaper.slice(1);
            addSectionHeader(`Used by ${shaperDisplayName} shaper`);
            categorized.usedByShaper.forEach(
                ({
                    tag,
                    codeData,
                    index,
                    isDiscretionary: isDisc,
                    isUserFeature
                }) => {
                    const item = this.createListItem(
                        'feature',
                        index,
                        codeData,
                        tag,
                        isDisc,
                        isUserFeature
                    );
                    this.featureListItems.set(index, item);
                    this.featureCodeData.set(index, {
                        tag,
                        code: codeData.code || ''
                    });
                    listContainer.appendChild(item);
                }
            );
        }

        if (categorized.notInLanguagesystem.length > 0) {
            addSectionHeader('Not in languagesystem');
            categorized.notInLanguagesystem.forEach(
                ({
                    tag,
                    codeData,
                    index,
                    isDiscretionary: isDisc,
                    isUserFeature
                }) => {
                    const item = this.createListItem(
                        'feature',
                        index,
                        codeData,
                        tag,
                        isDisc,
                        isUserFeature
                    );
                    this.featureListItems.set(index, item);
                    this.featureCodeData.set(index, {
                        tag,
                        code: codeData.code || ''
                    });
                    listContainer.appendChild(item);
                }
            );
        }

        if (categorized.discretionary.length > 0) {
            addSectionHeader('Discretionary (sortable)');
            categorized.discretionary.forEach(
                ({
                    tag,
                    codeData,
                    index,
                    isDiscretionary: isDisc,
                    isUserFeature
                }) => {
                    const item = this.createListItem(
                        'feature',
                        index,
                        codeData,
                        tag,
                        isDisc,
                        isUserFeature
                    );
                    this.featureListItems.set(index, item);
                    this.featureCodeData.set(index, {
                        tag,
                        code: codeData.code || ''
                    });
                    listContainer.appendChild(item);
                }
            );
        }

        // Post-USER FEATURES section (features that come after '--- USER FEATURES ---' marker)
        if (categorized.postUserFeatures.length > 0) {
            const shaperDisplayName =
                this.selectedShaper.charAt(0).toUpperCase() +
                this.selectedShaper.slice(1);
            addSectionHeader(`Used by ${shaperDisplayName} shaper, continued`);
            categorized.postUserFeatures.forEach(
                ({
                    tag,
                    codeData,
                    index,
                    isDiscretionary: isDisc,
                    isUserFeature
                }) => {
                    const item = this.createListItem(
                        'feature',
                        index,
                        codeData,
                        tag,
                        isDisc,
                        isUserFeature
                    );
                    this.featureListItems.set(index, item);
                    this.featureCodeData.set(index, {
                        tag,
                        code: codeData.code || ''
                    });
                    listContainer.appendChild(item);
                }
            );
        }

        // "Used by other shapers" section - moved to bottom with 70% opacity
        if (categorized.notUsedByShaper.length > 0) {
            const shaperDisplayName =
                this.selectedShaper.charAt(0).toUpperCase() +
                this.selectedShaper.slice(1);
            addSectionHeader(`Inactive for ${shaperDisplayName} shaper`);
            categorized.notUsedByShaper.forEach(
                ({
                    tag,
                    codeData,
                    index,
                    isDiscretionary: isDisc,
                    isUserFeature
                }) => {
                    const item = this.createListItem(
                        'feature',
                        index,
                        codeData,
                        tag,
                        isDisc,
                        isUserFeature
                    );
                    item.style.opacity = '0.6';
                    this.featureListItems.set(index, item);
                    this.featureCodeData.set(index, {
                        tag,
                        code: codeData.code || ''
                    });
                    listContainer.appendChild(item);
                }
            );
        }

        // Apply search filter if there are active search terms
        if (this.searchTerms.length > 0) {
            this.applyFeaturesSearch();
        }

        // Keep a focused dirty editor draft intact while its sidebar is rebuilt
        // for an external model sync. The selected feature may have a new index.
        if (options?.preserveFeatureEditorDraft && this.selectedFeatureTag) {
            const matchingFeatureIndex = features.findIndex(
                ([tag]) => tag === this.selectedFeatureTag
            );
            if (matchingFeatureIndex >= 0) {
                this.selectedItem = {
                    type: 'feature',
                    key: matchingFeatureIndex
                };
                this.featureListItems
                    .get(matchingFeatureIndex)
                    ?.classList.add('selected');
                this.notifyHistoryScopeChange();
            }
            // Restore selection by feature tag when possible (stable across fonts/index changes)
        } else if (this.selectedFeatureTag) {
            const matchingFeatureIndex = features.findIndex(
                ([tag]) => tag === this.selectedFeatureTag
            );
            if (matchingFeatureIndex >= 0) {
                this.selectItem('feature', matchingFeatureIndex);
            } else if (!this.selectedItem && features.length > 0) {
                this.selectItem('feature', 0);
            } else if (
                this.selectedItem?.type === 'feature' &&
                typeof this.selectedItem.key === 'number' &&
                this.selectedItem.key >= features.length
            ) {
                this.selectItem('feature', features.length - 1);
            } else if (this.selectedItem) {
                // Re-select current item to refresh
                this.selectItem(this.selectedItem.type, this.selectedItem.key);
            }
        } else if (
            !options?.preserveFeatureEditorDraft &&
            !this.selectedItem &&
            features.length > 0
        ) {
            this.selectItem('feature', 0);
        } else if (
            !options?.preserveFeatureEditorDraft &&
            this.selectedItem?.type === 'feature' &&
            typeof this.selectedItem.key === 'number' &&
            this.selectedItem.key >= features.length
        ) {
            this.selectItem('feature', features.length - 1);
        } else if (!options?.preserveFeatureEditorDraft && this.selectedItem) {
            // Re-select current item to refresh
            this.selectItem(this.selectedItem.type, this.selectedItem.key);
        }

        // Restore scroll position if was at bottom
        if (wasAtBottom && sidebar) {
            sidebar.scrollTop = sidebar.scrollHeight;
        }
    }

    private categorizeFeaturesByScript(
        features: Array<[string, Babelfont.PossiblyAutomaticCode]>,
        executionOrder: string[],
        supportedScripts: string[]
    ): {
        usedByShaper: Array<{
            tag: string;
            codeData: Babelfont.PossiblyAutomaticCode;
            index: number;
            isDiscretionary: boolean;
            isUserFeature: boolean;
        }>;
        postUserFeatures: Array<{
            tag: string;
            codeData: Babelfont.PossiblyAutomaticCode;
            index: number;
            isDiscretionary: boolean;
            isUserFeature: boolean;
        }>;
        notUsedByShaper: Array<{
            tag: string;
            codeData: Babelfont.PossiblyAutomaticCode;
            index: number;
            isDiscretionary: boolean;
            isUserFeature: boolean;
        }>;
        notInLanguagesystem: Array<{
            tag: string;
            codeData: Babelfont.PossiblyAutomaticCode;
            index: number;
            isDiscretionary: boolean;
            isUserFeature: boolean;
        }>;
        discretionary: Array<{
            tag: string;
            codeData: Babelfont.PossiblyAutomaticCode;
            index: number;
            isDiscretionary: boolean;
            isUserFeature: boolean;
        }>;
    } {
        const usedByShaper: any[] = [];
        const postUserFeatures: any[] = [];
        const notUsedByShaper: any[] = [];
        const notInLanguagesystem: any[] = [];
        const discretionary: any[] = [];

        // Split execution order at '--- USER FEATURES ---' marker
        const userFeaturesIndex = executionOrder.indexOf(
            '--- USER FEATURES ---'
        );
        let preUserFeatures: string[] = [];
        let postUserFeaturesList: string[] = [];

        if (userFeaturesIndex >= 0) {
            preUserFeatures = executionOrder
                .slice(0, userFeaturesIndex)
                .filter((f) => !f.startsWith('---'));
            postUserFeaturesList = executionOrder
                .slice(userFeaturesIndex + 1)
                .filter((f) => !f.startsWith('---'));
        } else {
            // No USER FEATURES marker, treat all as pre-user
            preUserFeatures = executionOrder.filter(
                (f) => !f.startsWith('---')
            );
        }

        const preUserFeaturesSet = new Set(preUserFeatures);
        const postUserFeaturesSet = new Set(postUserFeaturesList);

        features.forEach(([tag, codeData], index) => {
            const isDisc = isDiscretionary(tag);
            const featureData = {
                tag,
                codeData,
                index,
                isDiscretionary: isDisc,
                isUserFeature: isDisc
            };

            if (isDisc) {
                // Discretionary features go in their own category
                discretionary.push(featureData);
            } else {
                if (preUserFeaturesSet.has(tag)) {
                    // Feature before USER FEATURES marker
                    usedByShaper.push(featureData);
                } else if (postUserFeaturesSet.has(tag)) {
                    // Feature after USER FEATURES marker
                    postUserFeatures.push(featureData);
                } else {
                    // Required feature not used by current shaper
                    notUsedByShaper.push(featureData);
                }
            }
        });

        // Sort each category
        // Used by shaper: by execution order (before USER FEATURES)
        usedByShaper.sort((a, b) => {
            const aPos = preUserFeatures.indexOf(a.tag);
            const bPos = preUserFeatures.indexOf(b.tag);
            return aPos - bPos;
        });

        // Post-user features: by execution order (after USER FEATURES)
        postUserFeatures.sort((a, b) => {
            const aPos = postUserFeaturesList.indexOf(a.tag);
            const bPos = postUserFeaturesList.indexOf(b.tag);
            return aPos - bPos;
        });

        // Not used by shaper: alphabetically
        notUsedByShaper.sort((a, b) => a.tag.localeCompare(b.tag));

        // Not in languagesystem: alphabetically
        notInLanguagesystem.sort((a, b) => a.tag.localeCompare(b.tag));

        // Discretionary: by source order
        discretionary.sort((a, b) => a.index - b.index);

        return {
            usedByShaper,
            postUserFeatures,
            notUsedByShaper,
            notInLanguagesystem,
            discretionary
        };
    }

    private createListItem(
        type: FeatureItemType,
        key: string | number,
        codeData: Babelfont.PossiblyAutomaticCode,
        tag?: string,
        isDiscretionaryFeature?: boolean,
        isUserFeature?: boolean
    ): HTMLElement {
        const item = document.createElement('div');
        item.className = 'feature-list-item sidebar-item';

        // Add draggable attribute for discretionary features
        if (isDiscretionaryFeature && isUserFeature) {
            item.setAttribute('draggable', 'true');
            item.dataset.featureIndex = String(key);
            item.classList.add('draggable-feature');
            item.addEventListener('dragstart', (e) =>
                this.onFeatureDragStart(e, key as number)
            );
            item.addEventListener('dragover', (e) =>
                this.onFeatureDragOver(e, key as number)
            );
            item.addEventListener('drop', (e) =>
                this.onFeatureDrop(e, key as number)
            );
            item.addEventListener('dragend', () => this.onFeatureDragEnd());
        }

        // For features and prefixes, show GSUB/GPOS indicators
        if (type === 'feature' || type === 'prefix') {
            // Analyze code for GSUB/GPOS content
            const font = window.currentFontModel;
            let analysis = { hasGSUB: false, hasGPOS: false };

            if (font) {
                if (type === 'feature' && tag) {
                    analysis = font.analyzeFeatureTables(tag);
                } else if (type === 'prefix' && typeof key === 'string') {
                    analysis = font.analyzePrefix(key);
                }
            }

            // GSUB/GPOS indicators
            const tableIndicator = document.createElement('div');
            tableIndicator.className = 'feature-table-indicator';

            // GSUB indicator (left circle)
            const gsubCircle = document.createElement('div');
            gsubCircle.className = 'feature-table-circle';
            if (analysis.hasGSUB) {
                gsubCircle.style.opacity = '0.7';
                gsubCircle.title = 'GSUB (Glyph Substitution)';
            } else {
                gsubCircle.style.opacity = '0.1';
                gsubCircle.title = '';
            }
            tableIndicator.appendChild(gsubCircle);

            // GPOS indicator (right circle)
            const gposCircle = document.createElement('div');
            gposCircle.className = 'feature-table-circle';
            if (analysis.hasGPOS) {
                gposCircle.style.opacity = '0.7';
                gposCircle.title = 'GPOS (Glyph Positioning)';
            } else {
                gposCircle.style.opacity = '0.1';
                gposCircle.title = '';
            }
            tableIndicator.appendChild(gposCircle);

            item.appendChild(tableIndicator);

            if (type === 'feature' && tag) {
                // Feature tag (4-digit code)
                const tagSpan = document.createElement('span');
                tagSpan.className = 'feature-tag';
                tagSpan.textContent = tag;
                item.appendChild(tagSpan);

                // Feature name
                const description = getFeatureDescription(tag);
                const nameSpan = document.createElement('span');
                nameSpan.className = 'feature-name';
                nameSpan.textContent = description.split(' - ')[0] || tag;
                item.appendChild(nameSpan);
            } else {
                // For prefixes, show the key in feature-name style
                const nameSpan = document.createElement('span');
                nameSpan.className = 'feature-name';
                nameSpan.textContent = String(key);
                item.appendChild(nameSpan);
            }
        } else {
            // For classes, show the key in feature-name style without indicators
            const nameSpan = document.createElement('span');
            nameSpan.className = 'feature-name';
            nameSpan.textContent = String(key);
            item.appendChild(nameSpan);
        }

        // Automatic generation indicator
        if (codeData.automatic) {
            const autoIcon = document.createElement('span');
            autoIcon.className = 'material-symbols-outlined feature-auto-icon';
            autoIcon.textContent = 'manufacturing';
            autoIcon.title = 'Automatically generated';
            item.appendChild(autoIcon);
        }

        if (this.isFeatureErrorTarget(type, key)) {
            this.addFeatureErrorIcon(item, this.featureErrorTarget!.message);
        }

        item.addEventListener('click', () => this.selectItem(type, key));

        return item;
    }

    private selectItem(
        type: FeatureItemType,
        key: string | number,
        scrollIntoView: boolean = false
    ) {
        const font = window.currentFontModel;
        if (!font || !font.features) return;

        let codeData: Babelfont.PossiblyAutomaticCode | undefined;
        let label = '';

        // Get the code data based on type
        if (type === 'prefix') {
            if (typeof key !== 'string') return;
            codeData = font.features.prefixes?.[key];
            label = `prefix: ${key}`;
        } else if (type === 'class') {
            if (typeof key !== 'string') return;
            codeData = font.features.classes?.[key];
            label = `class: ${key}`;
        } else if (type === 'feature') {
            if (typeof key !== 'number') return;
            const features = font.features.features || [];
            if (key < 0 || key >= features.length) return;
            const [tag, code] = features[key];
            codeData = code;
            label = `feature: ${tag}`;
            this.selectedFeatureTag = tag;
        }

        if (!codeData) return;

        this.selectedItem = { type, key };

        // Update all list item states
        this.prefixListItems.forEach((item) =>
            item.classList.remove('selected')
        );
        this.classListItems.forEach((item) =>
            item.classList.remove('selected')
        );
        this.featureListItems.forEach((item) =>
            item.classList.remove('selected')
        );

        // Highlight selected item
        const selectedElement =
            type === 'prefix'
                ? this.prefixListItems.get(key as string)
                : type === 'class'
                  ? this.classListItems.get(key as string)
                  : this.featureListItems.get(key as number);

        if (selectedElement) {
            selectedElement.classList.add('selected');
            // Scroll into view if navigating with keyboard
            if (scrollIntoView) {
                selectedElement.scrollIntoView({
                    block: 'nearest',
                    behavior: 'smooth'
                });
            }
        }

        // Load code into editor
        if (this.featuresEditor) {
            this.suppressFeatureEditorChange = true;
            this.featuresEditor.setValue(codeData.code || '', -1);
            this.suppressFeatureEditorChange = false;
            this.featureCodeDirty = false;
            // Enable line wrapping for all cases (prefixes, classes, and features)
            this.featuresEditor.session.setUseWrapMode(true);
            // Highlight search terms in the loaded content
            this.highlightSearchTermsInEditor();
        }

        // Update automatic checkbox
        const autoCheckbox = document.getElementById(
            'feature-automatic-checkbox'
        ) as HTMLInputElement;
        if (autoCheckbox) {
            autoCheckbox.checked = codeData.automatic || false;
        }

        this.updateFeatureErrorDisplayForSelection();
        this.notifyHistoryScopeChange();

        console.log(`[FontInfo] Selected ${label}`);
    }

    private clearEditor() {
        this.selectedItem = null;
        this.selectedFeatureTag = null;
        this.clearFeatureCodeCommitDebounce();
        this.clearFeatureErrorMarker();
        this.featureErrorTarget = null;
        this.notifyHistoryScopeChange();
        if (this.featuresEditor) {
            this.suppressFeatureEditorChange = true;
            this.featuresEditor.setValue('', -1);
            this.suppressFeatureEditorChange = false;
            this.featureCodeDirty = false;
            // Clear search markers when editor is cleared
            this.searchMarkers.forEach((id) =>
                this.featuresEditor.session.removeMarker(id)
            );
            this.searchMarkers = [];
        }
        const autoCheckbox = document.getElementById(
            'feature-automatic-checkbox'
        ) as HTMLInputElement;
        if (autoCheckbox) {
            autoCheckbox.checked = false;
            autoCheckbox.disabled = true;
        }
    }

    /**
     * Clear any pending delayed feature-code commit.
     */
    private clearFeatureCodeCommitDebounce() {
        if (this.featureCodeCommitDebounceTimer === null) {
            return;
        }

        clearTimeout(this.featureCodeCommitDebounceTimer);
        this.featureCodeCommitDebounceTimer = null;
    }

    /**
     * Schedule a feature-code commit after typing settles.
     */
    private scheduleFeatureCodeCommitDebounce() {
        this.clearFeatureCodeCommitDebounce();
        this.featureCodeCommitDebounceTimer = window.setTimeout(() => {
            this.featureCodeCommitDebounceTimer = null;
            this.commitFeatureCodeChanges();
        }, FEATURE_CODE_COMPILE_DEBOUNCE_MS);
    }

    private onFeatureCodeChanged() {
        if (this.suppressFeatureEditorChange) {
            return;
        }
        this.featureCodeDirty = true;
        this.scheduleFeatureCodeCommitDebounce();
        this.clearFeatureErrorMarker();
        this.featureErrorTarget = null;
        this.featureErrorIssue = null;
        this.refreshFeatureErrorIconInSidebar();
    }

    private commitFeatureCodeChanges() {
        this.clearFeatureCodeCommitDebounce();

        if (!this.featuresEditor || !this.selectedItem) {
            this.featureCodeDirty = false;
            return;
        }

        const font = window.currentFontModel;
        if (!font || !font.features) {
            this.featureCodeDirty = false;
            return;
        }

        const { type, key } = this.selectedItem;
        let codeData: Babelfont.PossiblyAutomaticCode | undefined;

        if (type === 'prefix' && typeof key === 'string') {
            codeData = font.features.prefixes?.[key];
        } else if (type === 'class' && typeof key === 'string') {
            codeData = font.features.classes?.[key];
        } else if (type === 'feature' && typeof key === 'number') {
            const features = font.features.features || [];
            if (
                key < features.length &&
                (this.selectedFeatureTag === null ||
                    features[key][0] === this.selectedFeatureTag)
            ) {
                codeData = features[key][1];
            } else {
                this.featureCodeDirty = false;
                requestAnimationFrame(() =>
                    this.refreshVisibleFeatureContent()
                );
                return;
            }
        }

        if (!codeData) {
            this.featureCodeDirty = false;
            return;
        }

        const newCode = this.featuresEditor.getValue();
        const previousCode = codeData.code || '';
        const previousAutomatic = Boolean(codeData.automatic);
        const nextAutomatic = false;

        if (newCode === previousCode) {
            this.featureCodeDirty = false;
            if (this.pendingModelSyncRefresh) {
                requestAnimationFrame(() =>
                    this.refreshVisibleFeatureContent()
                );
            }
            return;
        }

        const bridge = window.patchSyncEngine;
        const path = this.getSelectedCodePath();
        const automaticPath = this.getSelectedAutomaticFlagPath();
        const historyTarget = this.getSelectedCodeHistoryTarget();
        const fontManager = window.fontManager;
        const currentFont = fontManager?.currentFont;

        codeData.code = newCode;
        if (previousAutomatic) {
            codeData.automatic = nextAutomatic;
        }
        this.featureCodeDirty = false;

        const autoCheckbox = document.getElementById(
            'feature-automatic-checkbox'
        ) as HTMLInputElement | null;
        if (autoCheckbox && previousAutomatic) {
            autoCheckbox.checked = nextAutomatic;
        }

        if (fontManager && currentFont) {
            fontManager.setEditingCompileContext('feature-code', null);
        }

        if (!bridge || !path) {
            if (currentFont) {
                currentFont.markDirty('feature-code');
            }

            if (fontManager?.isReady()) {
                void fontCompilation
                    .awaitWorkerDocumentSync()
                    .then(() => {
                        window.autoCompileManager?.checkAndSchedule?.();
                    })
                    .catch((error: any) => {
                        console.error(
                            'Failed to compile font after feature code change:',
                            error
                        );
                    });
            }
            return;
        }

        const operations: Array<{
            op: 'set';
            path: (string | number)[];
            oldValue: unknown;
            newValue: unknown;
        }> = [
            {
                op: 'set',
                path,
                oldValue: previousCode,
                newValue: newCode
            }
        ];

        if (previousAutomatic && automaticPath) {
            operations.push({
                op: 'set',
                path: automaticPath,
                oldValue: previousAutomatic,
                newValue: nextAutomatic
            });
        }

        bridge.beginTransaction('Edit feature code', historyTarget, {
            compileChangeSource: 'feature-code',
            compileEditType: 'feature'
        });
        try {
            bridge.applySyntheticChangeSet('Edit feature code', operations, {
                compileChangeSource: 'feature-code',
                compileEditType: 'feature'
            });
        } finally {
            bridge.endTransaction();
        }
    }

    private getSelectedCodeHistoryTarget(): TransactionHistoryTarget | null {
        if (!this.selectedItem) {
            return null;
        }

        const font = window.currentFontModel;
        if (!font?.features) {
            return null;
        }

        const { type, key } = this.selectedItem;
        if (type === 'prefix' && typeof key === 'string') {
            return {
                type: 'prefix',
                key,
                label: key
            };
        }

        if (type === 'class' && typeof key === 'string') {
            return {
                type: 'class',
                key,
                label: key
            };
        }

        if (type === 'feature' && typeof key === 'number') {
            return this.getFeatureHistoryTarget(
                font.features.features || [],
                key
            );
        }

        return null;
    }

    private getSelectedAutomaticFlagPath(): (string | number)[] | null {
        if (!this.selectedItem) {
            return null;
        }

        const { type, key } = this.selectedItem;
        if (type === 'prefix' && typeof key === 'string') {
            return ['features', 'prefixes', key, 'automatic'];
        }

        if (type === 'class' && typeof key === 'string') {
            return ['features', 'classes', key, 'automatic'];
        }

        if (type === 'feature' && typeof key === 'number') {
            return ['features', 'features', key, 1, 'automatic'];
        }

        return null;
    }

    private getSelectedCodePath(): (string | number)[] | null {
        if (!this.selectedItem) {
            return null;
        }

        const { type, key } = this.selectedItem;
        if (type === 'prefix' && typeof key === 'string') {
            return ['features', 'prefixes', key, 'code'];
        }

        if (type === 'class' && typeof key === 'string') {
            return ['features', 'classes', key, 'code'];
        }

        if (type === 'feature' && typeof key === 'number') {
            return ['features', 'features', key, 1, 'code'];
        }

        return null;
    }

    private onAutomaticCheckboxChanged() {
        const font = window.currentFontModel;
        if (!font || !font.features || !this.selectedItem) return;

        const { type, key } = this.selectedItem;
        let codeData: Babelfont.PossiblyAutomaticCode | undefined;

        if (type === 'prefix' && typeof key === 'string') {
            codeData = font.features.prefixes?.[key];
        } else if (type === 'class' && typeof key === 'string') {
            codeData = font.features.classes?.[key];
        } else if (type === 'feature' && typeof key === 'number') {
            const features = font.features.features || [];
            if (key < features.length) {
                codeData = features[key][1];
            }
        }

        if (!codeData) return;

        const autoCheckbox = document.getElementById(
            'feature-automatic-checkbox'
        ) as HTMLInputElement;

        if (autoCheckbox) {
            const nextAutomatic = autoCheckbox.checked;
            const previousAutomatic = Boolean(codeData.automatic);
            if (previousAutomatic === nextAutomatic) {
                return;
            }

            const bridge = window.patchSyncEngine;
            const path = this.getSelectedAutomaticFlagPath();
            if (!bridge || !path) {
                console.warn(
                    '[FontInfo] Missing patch bridge while toggling automatic feature generation'
                );
                return;
            }

            const historyTarget = this.getSelectedCodeHistoryTarget();
            bridge.beginTransaction(
                'Toggle automatic generation',
                historyTarget,
                {
                    compileChangeSource: 'feature-code',
                    compileEditType: 'feature'
                }
            );

            try {
                bridge.applySyntheticChangeSet(
                    'Toggle automatic generation',
                    [
                        {
                            op: 'set',
                            path,
                            oldValue: previousAutomatic,
                            newValue: nextAutomatic
                        }
                    ],
                    {
                        compileChangeSource: 'feature-code',
                        compileEditType: 'feature'
                    }
                );
            } finally {
                bridge.endTransaction();
            }

            // Update the indicator in the list
            this.loadAllLists();
        }
    }

    private onFeatureDragStart(e: DragEvent, index: number) {
        this.draggedFeatureIndex = index;
        this.clearFeatureDropIndicator();
        const target = e.target as HTMLElement;
        target.classList.add('dragging');
        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
        }
    }

    private onFeatureDragOver(e: DragEvent, targetIndex: number) {
        e.preventDefault();
        if (e.dataTransfer) {
            e.dataTransfer.dropEffect = 'move';
        }

        if (this.draggedFeatureIndex === null) {
            return;
        }

        const target = e.currentTarget as HTMLElement | null;
        if (!target) {
            return;
        }

        const rect = target.getBoundingClientRect();
        const placement =
            e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
        this.setFeatureDropIndicator(targetIndex, placement);
    }

    private onFeatureDrop(e: DragEvent, targetIndex: number) {
        e.preventDefault();

        const insertionIndex = this.getFeatureDropInsertionIndex(targetIndex);
        this.clearFeatureDropIndicator();

        if (this.draggedFeatureIndex === null || insertionIndex === null) {
            return;
        }

        const font = window.currentFontModel;
        if (!font || !font.features || !font.features.features) return;

        const features = font.features.features;
        const draggedTag = features[this.draggedFeatureIndex]?.[0];
        const targetTag = features[targetIndex]?.[0];
        const originalDraggedIndex = this.draggedFeatureIndex;
        const adjustedTargetIndex =
            originalDraggedIndex < insertionIndex
                ? insertionIndex - 1
                : insertionIndex;
        const historyTarget = this.getFeatureHistoryTarget(
            features,
            originalDraggedIndex
        );

        // Only allow reordering discretionary features
        if (
            !draggedTag ||
            !targetTag ||
            !isDiscretionary(draggedTag) ||
            !isDiscretionary(targetTag)
        ) {
            return;
        }

        if (adjustedTargetIndex === originalDraggedIndex) {
            return;
        }

        const bridge = window.patchSyncEngine;
        bridge?.beginTransaction('Reorder features', historyTarget, {
            compileChangeSource: 'feature-code',
            compileEditType: 'feature'
        });

        let movedFeature;

        try {
            // Reorder features in the font model
            [movedFeature] = features.splice(originalDraggedIndex, 1);

            features.splice(adjustedTargetIndex, 0, movedFeature);
        } finally {
            bridge?.endTransaction();
        }

        if (!movedFeature) {
            return;
        }

        // Mark font as dirty
        if (window.fontManager?.currentFont) {
            window.fontManager.currentFont.markDirty();
        }

        // Remember the dragged feature tag to re-select it
        const draggedFeatureTag = movedFeature[0];

        // Reload the list
        this.loadFeaturesList();

        // Re-select the moved feature
        const newIndex = features.findIndex(
            ([tag]) => tag === draggedFeatureTag
        );
        if (newIndex >= 0) {
            this.selectItem('feature', newIndex);
        }
    }

    private onFeatureDragEnd() {
        this.clearFeatureDropIndicator();
        this.draggedFeatureIndex = null;
        // Reset dragging class
        document
            .querySelectorAll('.draggable-feature')
            .forEach((item: Element) => {
                item.classList.remove('dragging');
            });
    }

    private setFeatureDropIndicator(
        targetIndex: number,
        placement: 'before' | 'after'
    ) {
        if (
            this.featureDropTargetIndex === targetIndex &&
            this.featureDropTargetPlacement === placement
        ) {
            return;
        }

        this.clearFeatureDropIndicator();

        const target = this.featureListItems.get(targetIndex);
        if (!target) {
            return;
        }

        target.classList.add(
            placement === 'before'
                ? 'feature-drop-target-before'
                : 'feature-drop-target-after'
        );
        this.featureDropTargetIndex = targetIndex;
        this.featureDropTargetPlacement = placement;
    }

    private clearFeatureDropIndicator() {
        if (this.featureDropTargetIndex !== null) {
            const previousTarget = this.featureListItems.get(
                this.featureDropTargetIndex
            );
            previousTarget?.classList.remove(
                'feature-drop-target-before',
                'feature-drop-target-after'
            );
        }

        this.featureDropTargetIndex = null;
        this.featureDropTargetPlacement = null;
    }

    private getFeatureDropInsertionIndex(
        fallbackTargetIndex: number
    ): number | null {
        if (this.draggedFeatureIndex === null) {
            return null;
        }

        const targetIndex = this.featureDropTargetIndex ?? fallbackTargetIndex;
        const placement = this.featureDropTargetPlacement ?? 'before';
        return placement === 'after' ? targetIndex + 1 : targetIndex;
    }

    private getFeatureHistoryTarget(
        features: Array<[string, Babelfont.PossiblyAutomaticCode]>,
        featureIndex: number
    ): TransactionHistoryTarget | null {
        const featureEntry = features[featureIndex];
        if (!featureEntry) {
            return null;
        }

        const tag = String(featureEntry[0] ?? '');
        if (!tag) {
            return null;
        }

        let occurrence = 0;
        for (let index = 0; index <= featureIndex; index++) {
            if (String(features[index]?.[0] ?? '') === tag) {
                occurrence += 1;
            }
        }

        return {
            type: 'feature',
            key: `feature:${tag}:${occurrence}`,
            label: occurrence > 1 ? `${tag} #${occurrence}` : tag
        };
    }

    /**
     * Update editor theme when app theme changes
     */
    updateEditorTheme(theme: 'light' | 'dark') {
        if (this.featuresEditor) {
            const aceTheme =
                theme === 'light'
                    ? 'ace/theme/tomorrow'
                    : 'ace/theme/tomorrow_night';
            this.featuresEditor.setTheme(aceTheme);
        }
    }

    refreshVisibleContentForExternalSync() {
        this.onFontModelSynced();
    }
}

// Create singleton instance
const fontInfoManager = new FontInfoManager();

// Export for global access
(window as any).fontInfoManager = fontInfoManager;

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => fontInfoManager.init());
} else {
    fontInfoManager.init();
}

export { fontInfoManager };
