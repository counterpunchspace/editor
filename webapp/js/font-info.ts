/**
 * Font Info View Manager
 * Handles switching between Names and Features tabs in the font info view
 */

import tippy, { type Instance as TippyInstance } from 'tippy.js';
import { Logger } from './logger';
import {
    discoverCompileFilters,
    discoveredCompileFilters,
    invalidateCompileFilterCache,
    linkedCompileFilterIds,
    linkedCompileFilters,
    setLinkedCompileFilters,
    setupCompileFilter,
    takedownCompileFilter,
    retireLegacyCompileFilterGuides,
    ensureHarakatMinimums
} from './compile-filter-host';
import { fontCompilation } from './font-compilation';
import { attachTopRowSidebarInterpolation } from './top-row-sidebar-interpolation';
import { getFontInfoSection, setFontInfoSection } from './window-ui-state';
import type { TransactionHistoryTarget } from './patch-sync-engine';
import type { Babelfont } from './babelfont';
import type { Font as BabelfontModelFont } from './babelfont-model';
import type { StationTopologyGate } from './filesystem-plugins/filesystem-plugin';
import {
    categorizeFeaturesForShaper,
    extractFontLanguageSystems,
    getFeatureExecutionOrder,
    getFeatureName,
    groupScriptsByShaper,
    isDiscretionary,
    parseFeatureClassGlyphMembers,
    resolveFeatureClassGlyphs,
    validateFeatureTag
} from './opentype-features';
import { generateStableId } from './drawing-geometry-ydoc';
import { extractPrimaryFeatureIssue } from './feature-error-parser';
import { pluginSettingsRegistry } from './plugin-settings/plugin-settings-registry';
import { featureGeneratorEngine } from './skills/feature-generator-engine';
import { GENERATOR_KEY, generatorStamp } from './skills/managed-features';
import {
    confirmAutomaticFeaturesTakeover,
    enableAutomaticFeatures
} from './automatic-features-takeover';
import { beginLoadingCursor, endLoadingCursor } from './loading-cursor';
import { reportRefusedEdit } from './glyph-canvas/edit-refusal-notice';
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
import { designspaceToUserspace, userspaceToDesignspace } from './locations';
import type { DesignspaceLocation, UserspaceLocation } from './locations';
import { openAddAxisDialog } from './add-axis-dialog';
import type { AxisDialogFont } from './add-axis-plan';
import { AxisMapEditor } from './axis-map-editor';
import { bindModalEscape, type ModalEscapeBinding } from './ui/modal-escape';
import { showChoiceDialog } from './ui/confirm-dialog';
import { showFeatureTagDialog } from './feature-tag-dialog';
import {
    planClassReferenceRename,
    uniqueFeaName,
    validateFeaName,
    type FeaNamedKind
} from './features-structure';
import {
    isHiddenStationMetricsPanelKey,
    parseScopedMetricKey,
    scriptMetricKey
} from './glyph-canvas/vertical-metrics';
import {
    CORE_STATION_METRICS,
    GLYPHS_METRIC_SCRIPTS,
    SCRIPT_METRIC_TYPES,
    coreMetricKey,
    coreZoneKey,
    createMetricsPreview,
    findMetricKey,
    glyphsScriptLabel,
    isStructuredStationMetricKey,
    italicAngleKey,
    lineSpacingDefaults,
    scriptsWithMetrics
} from './font-info-station-metrics';
// Import FEA mode for Ace Editor (registers the mode automatically)
import './mode-fea';
import { escapeHtml as escapeFeatureHtml } from './ui/escape-html';
const console = new Logger('FontInfo');

const FEATURE_CODE_COMPILE_DEBOUNCE_MS = 5000;

const FEATURE_ITEM_NOUN: Record<FeatureItemType, string> = {
    prefix: 'prefix',
    class: 'class',
    feature: 'feature'
};

/** Section title in the Features sidebar, with add and delete buttons. */
function featuresSectionHeaderHtml(
    title: string,
    type: FeatureItemType
): string {
    const noun = FEATURE_ITEM_NOUN[type];
    return `
        <div class="sidebar-section-title features-section-header">
            <span>${title}</span>
            <span class="editor-drawings-header-actions">
                <button type="button" class="editor-drawing-add-button" data-features-action="add" data-features-type="${type}" aria-label="Add ${noun}" title="Add ${noun}">+</button>
                <button type="button" class="editor-drawing-add-button" data-features-action="remove" data-features-type="${type}" aria-label="Delete ${noun}" title="Delete ${noun}" disabled>−</button>
            </span>
        </div>`;
}

/**
 * Fill `element` with a prefix or class name that a narrow sidebar may wrap
 * at camelCase boundaries and after “.”, “_” and “-”.
 */
function setBreakableName(element: HTMLElement, name: string): void {
    element.replaceChildren();
    name.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[._-])/).forEach((part, index) => {
        if (index > 0) {
            element.appendChild(document.createElement('wbr'));
        }
        element.appendChild(document.createTextNode(part));
    });
}

/** Deep copy of plain JSON data; also unwraps live model proxies. */
function clonePlainData<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function featureSourceHeaderText(
    stamp: { generator: string; capability: string },
    summary?: string
): string {
    const identity = [stamp.generator, stamp.capability]
        .filter(Boolean)
        .join(' · ');
    if (summary && summary !== stamp.generator) {
        return `${summary} · ${identity}`;
    }
    return identity;
}

type FontInfoTab =
    | 'general'
    | 'names'
    | 'axes'
    | 'masters'
    | 'instances'
    | 'custom_ot_values'
    | 'features'
    | 'compile_filters';
type FeatureItemType = 'prefix' | 'class' | 'feature';
type FontNameFieldKey = keyof Babelfont.Names;
type FontRootFieldKey = 'upm' | 'version' | 'note' | 'date';
type CustomOTFieldKey = keyof Babelfont.CustomOTValues;
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
    nameId: number;
    multiline?: boolean;
    placeholder?: (context: NameFallbackContext) => string;
    note?: (context: NameFallbackContext) => string;
}

interface FontNameGroupConfig {
    title: string;
    description?: string;
    fields: FontNameFieldConfig[];
}

interface CustomOTFieldConfig {
    key: CustomOTFieldKey;
    label: string;
    kind: 'integer' | 'string' | 'number-list';
    helperText?: string;
    exactLength?: number;
    placeholder?: string;
    /** Bits shown as checkboxes for an integer bit field: [bit, label]. */
    bits?: Array<[number, string]>;
}

interface CustomOTGroupConfig {
    title: string;
    description?: string;
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
        label: 'Stations',
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
    },
    {
        id: 'compile_filters',
        label: 'Compile Filters',
        usesSearch: false
    }
];

/** What fontc writes when a name field is empty, worked out from the font. */
interface NameFallbackContext {
    typographicFamily: string;
    typographicSubfamily: string;
    computedFamilyName: string;
    version: string;
    vendor: string;
    postscriptName: string;
}

// Name IDs and fallbacks follow babelfont's fontir bridge
// (convertors/fontir/static_metadata.rs) and fontir's NameBuilder.
const FONT_NAME_GROUPS: FontNameGroupConfig[] = [
    {
        title: 'Family and style',
        description:
            'How apps list the font and group it with its styles. The compiler builds name IDs 1 and 2 itself, so they can differ from what you type here.',
        fields: [
            {
                key: 'family_name',
                label: 'Family Name',
                nameId: 1,
                placeholder: () => 'Required',
                note: (context) =>
                    `Name ID 1 is this name plus the default station’s name, without a trailing Regular, Bold or Italic: “${context.computedFamilyName}”.`
            },
            {
                key: 'preferred_subfamily_name',
                label: 'Subfamily Name',
                nameId: 2,
                note: () =>
                    'The compiler always writes Regular, Italic, Bold or Bold Italic here, from the style flags. This field only adds translations of that value.'
            },
            {
                key: 'typographic_family',
                label: 'Typographic Family',
                nameId: 16,
                placeholder: (context) => context.typographicFamily,
                note: () =>
                    'Left out of the font when it repeats name IDs 1 and 2, unless you type it.'
            },
            {
                key: 'typographic_subfamily',
                label: 'Typographic Subfamily',
                nameId: 17,
                placeholder: (context) => context.typographicSubfamily,
                note: () =>
                    'Empty: the default station’s name. Left out of the font when it repeats name IDs 1 and 2, unless you type it.'
            },
            {
                key: 'full_name',
                label: 'Full Name',
                nameId: 4,
                placeholder: (context) =>
                    `${context.typographicFamily} ${context.typographicSubfamily}`
            }
        ]
    },
    {
        title: 'Identifiers',
        description:
            'Machine-readable names. Leave them empty to have the compiler build them from the names above.',
        fields: [
            {
                key: 'version',
                label: 'Version String',
                nameId: 5,
                placeholder: (context) => context.version,
                note: () =>
                    'The compiler adds “;fontc” and its own version to this name, typed or not.'
            },
            {
                key: 'postscript_name',
                label: 'PostScript Name',
                nameId: 6,
                placeholder: (context) => context.postscriptName,
                note: () =>
                    'A typed value is written as is. Use letters, digits and hyphens only, with no spaces.'
            },
            {
                key: 'variations_postscript_name_prefix',
                label: 'Variations PostScript Name Prefix',
                nameId: 25,
                note: () => 'Not written when empty.'
            },
            {
                key: 'unique_id',
                label: 'Unique ID',
                nameId: 3,
                placeholder: (context) =>
                    `${context.version.replace(/^Version /, '')};${context.vendor};${context.postscriptName}`
            }
        ]
    },
    {
        title: 'Credits',
        description: 'Who made the font. Each field is written only when set.',
        fields: [
            { key: 'designer', label: 'Designer', nameId: 9 },
            { key: 'designer_url', label: 'Designer URL', nameId: 12 },
            { key: 'manufacturer', label: 'Manufacturer', nameId: 8 },
            { key: 'manufacturer_url', label: 'Manufacturer URL', nameId: 11 }
        ]
    },
    {
        title: 'Legal',
        description:
            'Shown in licensing dialogs. Each field is written only when set.',
        fields: [
            {
                key: 'copyright',
                label: 'Copyright',
                nameId: 0,
                multiline: true
            },
            { key: 'trademark', label: 'Trademark', nameId: 7 },
            { key: 'license', label: 'License', nameId: 13, multiline: true },
            { key: 'license_url', label: 'License URL', nameId: 14 }
        ]
    },
    {
        title: 'Description and sample',
        description:
            'Used by font managers. Each field is written only when set.',
        fields: [
            {
                key: 'description',
                label: 'Description',
                nameId: 10,
                multiline: true
            },
            {
                key: 'sample_text',
                label: 'Sample Text',
                nameId: 19,
                multiline: true
            }
        ]
    },
    {
        title: 'Legacy and platform-specific',
        description:
            'Only needed for older apps or specific platforms. Each field is written only when set.',
        fields: [
            {
                key: 'compatible_full_name',
                label: 'Compatible Full Name',
                nameId: 18
            },
            {
                key: 'postscript_cid_name',
                label: 'PostScript CID Name',
                nameId: 20
            },
            {
                key: 'wws_family_name',
                label: 'WWS Family Name',
                nameId: 21,
                note: () =>
                    'When set, the compiler also turns on the WWS style flag (fsSelection bit 8).'
            },
            {
                key: 'wws_subfamily_name',
                label: 'WWS Subfamily Name',
                nameId: 22
            }
        ]
    }
];

// Defaults and effects follow babelfont's fontir bridge
// (convertors/fontir/static_metadata.rs) and fontc's fontbe (os2.rs, head.rs).
const CUSTOM_OT_GROUPS: CustomOTGroupConfig[] = [
    {
        title: 'Font header (head)',
        description:
            'Global rendering values. Empty fields use the compiler’s defaults.',
        fields: [
            {
                key: 'head_flags',
                label: 'Flags',
                kind: 'integer',
                placeholder: 'Default 3',
                helperText:
                    'head.flags. Empty: 3. The compiler always sets bit 1.',
                bits: [
                    [0, 'Baseline at y = 0'],
                    [1, 'Left sidebearing at x = 0'],
                    [3, 'Scale with whole-pixel sizes'],
                    [11, 'Font data is lossless'],
                    [13, 'Optimized for ClearType']
                ]
            },
            {
                key: 'head_lowest_rec_ppem',
                label: 'Smallest readable size',
                kind: 'integer',
                placeholder: 'Default 6',
                helperText: 'head.lowestRecPPEM, in pixels per em. Empty: 6.'
            }
        ]
    },
    {
        title: 'Classification (OS/2)',
        description: 'How apps sort the font and match it to other styles.',
        fields: [
            {
                key: 'os2_us_weight_class',
                label: 'Weight class',
                kind: 'integer',
                placeholder: 'Default 400',
                helperText:
                    'usWeightClass, such as 400 Regular or 700 Bold. A font with a wght axis always gets the axis default instead.'
            },
            {
                key: 'os2_us_width_class',
                label: 'Width class',
                kind: 'integer',
                placeholder: 'Default 5',
                helperText:
                    'usWidthClass from 1 to 9, where 5 is normal. A font with a wdth axis always gets the class nearest the axis default instead.'
            },
            {
                key: 'os2_family_class',
                label: 'Family class',
                kind: 'integer',
                placeholder: 'Default 0',
                helperText:
                    'sFamilyClass: class in the high byte, subclass in the low byte. Empty: 0, no classification.'
            },
            {
                key: 'os2_panose',
                label: 'PANOSE',
                kind: 'number-list',
                exactLength: 10,
                placeholder: '0, 0, 0, 0, 0, 0, 0, 0, 0, 0',
                helperText:
                    'Ten numbers in order, separated by commas. Empty: all 0, which means “any”.'
            },
            {
                key: 'os2_vendor_id',
                label: 'Vendor ID',
                kind: 'string',
                placeholder: 'Four-character vendor code, e.g. ABCD',
                helperText:
                    'achVendID, your four-character vendor code. Empty: NONE. The unique ID (name ID 3) uses it too.'
            }
        ]
    },
    {
        title: 'Embedding and style flags (OS/2)',
        description:
            'Tick the bits you want, or type the number. Empty fields use the compiler’s defaults.',
        fields: [
            {
                key: 'os2_fs_type',
                label: 'Embedding (fsType)',
                kind: 'integer',
                placeholder: 'Default 0',
                helperText:
                    'Embedding permissions. Empty: 0, installable embedding with no restrictions.',
                bits: [
                    [1, 'Restricted license embedding'],
                    [2, 'Preview and print embedding'],
                    [3, 'Editable embedding'],
                    [8, 'No subsetting'],
                    [9, 'Bitmap embedding only']
                ]
            },
            {
                key: 'os2_fs_selection',
                label: 'Style flags (fsSelection)',
                kind: 'integer',
                placeholder: 'Automatic',
                helperText:
                    'Italic, Bold or Regular set here replace the style the compiler works out from the italic angle and the default station’s name; that style also gives name ID 2. Other bits are written as set. The WWS bit is added when WWS Family Name is set.',
                bits: [
                    [0, 'Italic'],
                    [5, 'Bold'],
                    [6, 'Regular'],
                    [7, 'Use typo metrics for line spacing'],
                    [8, 'Names follow the WWS model'],
                    [9, 'Oblique']
                ]
            }
        ]
    },
    {
        title: 'Coverage (OS/2)',
        description:
            'Leave all six empty to have the compiler compute them from the encoded characters. If you set any Unicode range, all four are used and empty ones count as 0; the same applies to the two code page ranges.',
        fields: [
            {
                key: 'os2_unicode_range1',
                label: 'Unicode Range 1',
                kind: 'integer',
                placeholder: 'Computed',
                helperText: 'ulUnicodeRange1, bits 0–31.'
            },
            {
                key: 'os2_unicode_range2',
                label: 'Unicode Range 2',
                kind: 'integer',
                placeholder: 'Computed',
                helperText: 'ulUnicodeRange2, bits 32–63.'
            },
            {
                key: 'os2_unicode_range3',
                label: 'Unicode Range 3',
                kind: 'integer',
                placeholder: 'Computed',
                helperText: 'ulUnicodeRange3, bits 64–95.'
            },
            {
                key: 'os2_unicode_range4',
                label: 'Unicode Range 4',
                kind: 'integer',
                placeholder: 'Computed',
                helperText: 'ulUnicodeRange4, bits 96–127.'
            },
            {
                key: 'os2_code_page_range1',
                label: 'Code Page Range 1',
                kind: 'integer',
                placeholder: 'Computed',
                helperText: 'ulCodePageRange1, bits 0–31.'
            },
            {
                key: 'os2_code_page_range2',
                label: 'Code Page Range 2',
                kind: 'integer',
                placeholder: 'Computed',
                helperText: 'ulCodePageRange2, bits 32–63.'
            }
        ]
    },
    {
        title: 'PostScript hinting (CFF)',
        description:
            'The compiler writes TrueType outlines only, with no CFF table, so these values have no effect on the compiled font. They stay in the source and in UFO files.',
        fields: [
            {
                key: 'cff_blue_values',
                label: 'BlueValues',
                kind: 'number-list',
                placeholder: '-15, 0, 500, 515, 700, 715',
                helperText:
                    'Alignment zones as bottom and top pairs, separated by commas.'
            },
            {
                key: 'cff_other_blues',
                label: 'OtherBlues',
                kind: 'number-list',
                placeholder: '-250, -235',
                helperText: 'More zones below the baseline, in pairs.'
            },
            {
                key: 'cff_family_blues',
                label: 'FamilyBlues',
                kind: 'number-list',
                placeholder: '0, 15, 500, 515',
                helperText: 'Zones shared by the family, in pairs.'
            },
            {
                key: 'cff_family_other_blues',
                label: 'FamilyOtherBlues',
                kind: 'number-list',
                placeholder: '-250, -235',
                helperText:
                    'Zones below the baseline shared by the family, in pairs.'
            },
            {
                key: 'cff_stem_snap_h',
                label: 'StemSnapH',
                kind: 'number-list',
                placeholder: '80, 120',
                helperText: 'Common horizontal stem thicknesses.'
            },
            {
                key: 'cff_stem_snap_v',
                label: 'StemSnapV',
                kind: 'number-list',
                placeholder: '80, 120',
                helperText: 'Common vertical stem thicknesses.'
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

/**
 * The default station sits at every axis default (see babelfont's
 * Font::default_master); a single station is always the default.
 */
function findDefaultStation<T extends { location: Record<string, number> }>(
    axes: Babelfont.Axis[],
    stations: T[]
): T | undefined {
    const defaults = userspaceToDesignspace(
        Object.fromEntries(
            axes.map((axis) => [axis.tag, axis.default ?? 0])
        ) as UserspaceLocation,
        axes
    ) as Record<string, number>;
    return (
        stations.find((station) =>
            axes.every(
                (axis) =>
                    (station.location[axis.tag] ?? 0) ===
                    (defaults[axis.tag] ?? 0)
            )
        ) ?? stations[0]
    );
}

/** An axis coordinate for display: at most two decimals, no trailing zeros. */
function formatAxisValue(value: number): string {
    return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '';
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
 * cloneStationRecord / cloneInstanceRecord always receive plain Babelfont data objects.
 */
function rawArray<T>(arr: T[] | undefined): T[] {
    return JSON.parse(JSON.stringify(arr ?? []));
}

/** Plain JSON records from model wrappers (or plain data): axes, stations, instances. */
function plainRecords<T>(items: readonly object[] | undefined): T[] {
    return JSON.parse(JSON.stringify(items ?? []));
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

function cloneStationRecord(station: Babelfont.Master): Babelfont.Master {
    return {
        ...station,
        name: normalizeLocalizedStringValue(station.name),
        location: cloneNumericRecord(
            station.location as Record<string, number> | undefined
        ),
        metrics: cloneNumericRecord(station.metrics) ?? {},
        kerning: cloneKerningValue(station.kerning) as any,
        custom_ot_values: station.custom_ot_values
            ? ({
                  ...station.custom_ot_values
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
    private stationsTab: HTMLElement | null = null;
    private instancesTab: HTMLElement | null = null;
    private axesTab: HTMLElement | null = null;
    private customOTValuesTab: HTMLElement | null = null;
    private featuresTab: HTMLElement | null = null;
    private compileFiltersTab: HTMLElement | null = null;
    private compileFiltersFieldsContainer: HTMLElement | null = null;
    private generalFieldsContainer: HTMLElement | null = null;
    private namesFieldsContainer: HTMLElement | null = null;
    private stationsFieldsContainer: HTMLElement | null = null;
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
    private stationsDataLoaded = false;
    private pendingStationsModelSyncRefresh = false;
    private instancesDataLoaded = false;
    private pendingInstancesModelSyncRefresh = false;
    private axesDataLoaded = false;
    private pendingAxesModelSyncRefresh = false;
    private customOTValuesDataLoaded = false;
    private pendingCustomOTValuesModelSyncRefresh = false;
    private selectedStationIndex = 0;
    private selectedInstanceIndex = 0;
    private selectedAxisIndex = 0;
    private selectedStationIndices: Set<number> = new Set([0]);
    private selectedInstanceIndices: Set<number> = new Set([0]);
    private selectedAxisIndices: Set<number> = new Set([0]);
    private _deleteConfirmationHandler: boolean | null = null;
    private renderedStationListSignature = '';
    private renderedStationTopologyGateSignature = '';
    private renderedInstanceListSignature = '';
    private renderedAxisListSignature = '';
    private draggedStationIndex: number | null = null;
    private stationDragCommitted = false;
    private stationDropTargetIndex: number | null = null;
    private stationDropTargetPlacement: RecordDropPlacement | null = null;
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
    private pluginSettingsOpenId: string | null = null;
    private pendingGeneratedFeatureReveal = false;
    private featureContextMenu: TippyInstance | null = null;
    private featureContextTarget: {
        type: FeatureItemType;
        key: string | number;
    } | null = null;
    private featureSourcePopup: TippyInstance | null = null;

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
        window.addEventListener('cloudSparseResidencyChanged', () => {
            if (
                this.stationTopologyGateSignature(
                    this.getStationTopologyGate()
                ) !== this.renderedStationTopologyGateSignature
            ) {
                this.forceRefreshVisibleStationsContent();
            }
        });
        window.addEventListener('fontModelSync', () =>
            this.onFontModelSynced()
        );
        window.addEventListener('generatedFeaturesChanged', () => {
            this.pendingGeneratedFeatureReveal = true;
            this.onFontModelSynced();
        });
        // Plugin settings are discovered after Pyodide starts. The features
        // list is often painted before that, so refresh it when they arrive.
        window.addEventListener('pluginSettingsRegistered', () => {
            this.loadPluginSettingsList();
            const openId = this.pluginSettingsOpenId;
            if (!openId) {
                return;
            }
            const stillShown = [
                ...pluginSettingsRegistry.pluginsForTarget(
                    'font-info.features'
                ),
                ...pluginSettingsRegistry.pluginsForTarget('font-info.skills')
            ].some((plugin) => plugin.pluginId === openId);
            if (stillShown) {
                this.showPluginSettings(openId);
            } else {
                this.closePluginSettingsForm();
            }
        });

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
            } else if (
                e.key === 'Enter' &&
                this.selectedItem &&
                activeElement?.tagName !== 'BUTTON' &&
                !document.querySelector('.info-popup-overlay')
            ) {
                e.preventDefault();
                this.startRenameItem(
                    this.selectedItem.type,
                    this.selectedItem.key
                );
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

    reloadCompileFiltersIfVisible(): void {
        if (this.currentTab !== 'compile_filters') {
            return;
        }
        this.paintCompileFilters();
    }

    private async renderCompileFiltersContent(): Promise<void> {
        const container = this.compileFiltersFieldsContainer;
        const font = window.currentFontModel;
        if (!container || !font) {
            return;
        }
        await discoverCompileFilters();
        this.paintCompileFilters();
    }

    private paintCompileFilters(): void {
        const container = this.compileFiltersFieldsContainer;
        const font = window.currentFontModel;
        if (!container || !font) {
            return;
        }
        const links = linkedCompileFilters(font);
        const byId = new Map(
            discoveredCompileFilters().map((plugin) => [plugin.id, plugin])
        );
        container.replaceChildren();

        const header = document.createElement('div');
        header.className = 'compile-filter-header';
        const intro = document.createElement('p');
        intro.className = 'compile-filter-intro';
        intro.textContent =
            'Compile filters adjust the font while it is compiled. The source file stays unchanged.';
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'dialog-button dialog-button-primary';
        add.textContent = 'Add filter';
        add.addEventListener('click', () => {
            this.openCompileFilterPicker();
        });
        header.append(intro, add);
        container.appendChild(header);

        if (links.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'compile-filter-empty';
            empty.textContent = 'No compile filters in this font.';
            container.appendChild(empty);
            return;
        }

        const list = document.createElement('div');
        list.className = 'compile-filter-list';
        for (const link of links) {
            const pluginId = link.id;
            const info = byId.get(pluginId);
            const title = info?.name || pluginId;
            const card = document.createElement('article');
            card.className = 'compile-filter-card';
            const text = document.createElement('div');
            const name = document.createElement('h3');
            name.className = 'compile-filter-name';
            name.textContent = title;
            text.appendChild(name);
            const status = document.createElement('p');
            status.className = 'compile-filter-status';
            status.textContent = link.active ? 'Active' : 'Inactive';
            text.appendChild(status);
            if (info?.description) {
                const description = document.createElement('p');
                description.className = 'compile-filter-description';
                description.textContent = info.description;
                text.appendChild(description);
            }
            const actions = document.createElement('div');
            actions.className = 'compile-filter-actions';
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = link.active
                ? 'dialog-button'
                : 'dialog-button dialog-button-primary';
            toggle.textContent = link.active ? 'Deactivate' : 'Activate';
            toggle.setAttribute('aria-label', `${toggle.textContent} ${title}`);
            toggle.addEventListener('click', () => {
                void this.setCompileFilterActive(pluginId, !link.active);
            });
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'dialog-button';
            remove.textContent = 'Remove';
            remove.setAttribute('aria-label', `Remove ${title}`);
            remove.addEventListener('click', () => {
                void this.unlinkCompileFilter(pluginId);
            });
            actions.append(toggle, remove);
            card.append(text, actions);
            list.appendChild(card);
        }
        container.appendChild(list);
    }

    private compileFilterPicker: HTMLElement | null = null;

    private closeCompileFilterPicker(): void {
        this.compileFilterPicker?.remove();
        this.compileFilterPicker = null;
    }

    private openCompileFilterPicker(): void {
        this.closeCompileFilterPicker();
        const font = window.currentFontModel;
        if (!font) {
            return;
        }
        const linked = new Set(linkedCompileFilterIds(font));
        const available = discoveredCompileFilters().filter(
            (plugin) => !linked.has(plugin.id)
        );

        const overlay = document.createElement('div');
        overlay.className = 'info-popup-overlay';
        overlay.tabIndex = -1;
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                this.closeCompileFilterPicker();
            }
        });
        overlay.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                this.closeCompileFilterPicker();
            }
        });

        const popup = document.createElement('div');
        popup.className = 'info-popup';
        popup.setAttribute('role', 'dialog');
        popup.setAttribute('aria-modal', 'true');
        popup.setAttribute('aria-labelledby', 'compile-filter-picker-title');

        const header = document.createElement('div');
        header.className = 'info-popup-header';
        const title = document.createElement('h3');
        title.id = 'compile-filter-picker-title';
        title.textContent = 'Add compile filter';
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'info-popup-close';
        close.setAttribute('aria-label', 'Close');
        close.innerHTML =
            '<span class="material-symbols-outlined">close</span>';
        close.addEventListener('click', () => {
            this.closeCompileFilterPicker();
        });
        header.append(title, close);

        const content = document.createElement('div');
        content.className = 'info-popup-content';
        if (available.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'compile-filter-description';
            empty.textContent =
                discoveredCompileFilters().length === 0
                    ? 'No compile filters are installed in this editor.'
                    : 'Every available compile filter is already in this font.';
            content.appendChild(empty);
        } else {
            const choices = document.createElement('div');
            choices.className = 'compile-filter-choices';
            for (const plugin of available) {
                const choice = document.createElement('div');
                choice.className = 'compile-filter-choice';
                const text = document.createElement('div');
                const name = document.createElement('div');
                name.className = 'compile-filter-name';
                name.textContent = plugin.name || plugin.id;
                text.appendChild(name);
                if (plugin.description) {
                    const description = document.createElement('p');
                    description.className = 'compile-filter-description';
                    description.textContent = plugin.description;
                    text.appendChild(description);
                }
                const addChoice = document.createElement('button');
                addChoice.type = 'button';
                addChoice.className = 'dialog-button dialog-button-primary';
                addChoice.textContent = 'Add';
                addChoice.setAttribute(
                    'aria-label',
                    `Add ${plugin.name || plugin.id}`
                );
                addChoice.addEventListener('click', () => {
                    this.closeCompileFilterPicker();
                    void this.linkCompileFilter(plugin.id);
                });
                choice.append(text, addChoice);
                choices.appendChild(choice);
            }
            content.appendChild(choices);
        }

        popup.append(header, content);
        overlay.appendChild(popup);
        document.body.appendChild(overlay);
        this.compileFilterPicker = overlay;
        close.focus();
    }

    private async linkCompileFilter(pluginId: string): Promise<void> {
        const font = window.currentFontModel;
        if (!font) {
            return;
        }
        // The id list is its own commit. Defaults and leftover guides
        // commit separately so this item stays the compile-filters key.
        await retireLegacyCompileFilterGuides();
        if (pluginId === 'de.yanone.harakat' || pluginId === 'harakat') {
            ensureHarakatMinimums(font);
        } else {
            await setupCompileFilter(pluginId);
        }
        const bridge = window.patchSyncEngine;
        bridge?.beginTransaction('Add compile filter', null, {
            compileChangeSource: 'compile-filter',
            compileEditType: null
        });
        try {
            const links = linkedCompileFilters(font);
            if (!links.some((link) => link.id === pluginId)) {
                setLinkedCompileFilters(font, [
                    ...links,
                    { id: pluginId, active: false }
                ]);
            }
            invalidateCompileFilterCache();
            await this.renderCompileFiltersContent();
            this.refreshActiveCanvasTransientAnchors();
        } finally {
            bridge?.endTransaction();
        }
    }

    private refreshActiveCanvasTransientAnchors(): void {
        window.glyphCanvas?.outlineEditor?.invalidateTransientAnchors?.();
    }

    private async setCompileFilterActive(
        pluginId: string,
        active: boolean
    ): Promise<void> {
        const font = window.currentFontModel;
        if (!font) {
            return;
        }
        const bridge = window.patchSyncEngine;
        bridge?.beginTransaction(
            active ? 'Activate compile filter' : 'Deactivate compile filter',
            null,
            {
                compileChangeSource: 'compile-filter',
                compileEditType: null
            }
        );
        try {
            setLinkedCompileFilters(
                font,
                linkedCompileFilters(font).map((link) =>
                    link.id === pluginId ? { ...link, active } : link
                )
            );
            invalidateCompileFilterCache();
            await this.renderCompileFiltersContent();
            this.refreshActiveCanvasTransientAnchors();
        } finally {
            bridge?.endTransaction();
        }
    }

    private async unlinkCompileFilter(pluginId: string): Promise<void> {
        const font = window.currentFontModel;
        if (!font) {
            return;
        }
        const bridge = window.patchSyncEngine;
        bridge?.beginTransaction('Remove compile filter', null, {
            compileChangeSource: 'compile-filter',
            compileEditType: null
        });
        try {
            await takedownCompileFilter(pluginId);
            setLinkedCompileFilters(
                font,
                linkedCompileFilters(font).filter(
                    (link) => link.id !== pluginId
                )
            );
            invalidateCompileFilterCache();
            await this.renderCompileFiltersContent();
            this.refreshActiveCanvasTransientAnchors();
        } finally {
            bridge?.endTransaction();
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
            saved === 'features' ||
            saved === 'compile_filters'
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
        titleBarRight.appendChild(this.sectionButton);

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
        (item.querySelector('.feature-item-icons') ?? item).appendChild(
            errorIcon
        );
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

        this.stationsTab = document.createElement('div');
        this.stationsTab.id = 'fontinfo-stations-content';
        this.stationsTab.style.display = 'none';
        this.stationsTab.style.height = '100%';
        this.stationsTab.style.overflow = 'hidden';

        this.stationsFieldsContainer = document.createElement('div');
        this.stationsFieldsContainer.id = 'fontinfo-stations-fields';
        this.stationsFieldsContainer.className = 'fontinfo-records-pane';
        this.stationsTab.appendChild(this.stationsFieldsContainer);

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
                    <label class="feature-auto-checkbox feature-manage-checkbox" title="When on, features marked automatic are generated and kept up to date by Counterpunch. When off, Counterpunch does not touch features after glyph operations.">
                        <input type="checkbox" id="feature-manage-checkbox" />
                        <span>Counterpunch manages automatic features</span>
                    </label>
                    <div class="sidebar-section-title" id="plugin-settings-heading">Settings</div>
                    <div class="features-list sidebar-list" id="plugin-settings-list"></div>
                    ${featuresSectionHeaderHtml('Prefixes', 'prefix')}
                    <div class="features-list sidebar-list" id="prefixes-list"></div>
                    ${featuresSectionHeaderHtml('Classes', 'class')}
                    <div class="features-list sidebar-list" id="classes-list"></div>
                    ${featuresSectionHeaderHtml('Features', 'feature')}
                    <div class="features-list sidebar-list" id="features-list"></div>
                </div>
                <div class="features-editor-container">
                    <div class="glyph-filter-legend feature-editor-header">
                        <button type="button" class="feature-source-summary" id="feature-source-summary" hidden></button>
                        <div class="feature-header-notice" id="feature-tag-issue" hidden>
                            <span class="feature-header-notice-text"></span>
                            <button type="button" class="dialog-button" id="feature-tag-issue-rename">Rename…</button>
                        </div>
                        <div class="feature-header-notice" id="feature-automatic-notice" hidden>
                            <span class="feature-header-notice-text"></span>
                            <button type="button" class="dialog-button" id="feature-keep-code-button">Keep my code</button>
                        </div>
                        <div class="feature-editor-header-actions">
                            <button type="button" class="dialog-button feature-regenerate-button" id="feature-regenerate-button" hidden>Regenerate</button>
                            <label class="feature-auto-checkbox" id="feature-automatic-label">
                                <input type="checkbox" id="feature-automatic-checkbox" />
                                <span>Automatically Generated</span>
                            </label>
                        </div>
                    </div>
                    <div class="features-editor" id="features-editor"></div>
                    <div class="plugin-settings-form" id="plugin-settings-form"></div>
                </div>
            </div>
        `;

        viewContent.appendChild(this.generalTab);
        viewContent.appendChild(this.namesTab);
        viewContent.appendChild(this.stationsTab);
        viewContent.appendChild(this.instancesTab);
        viewContent.appendChild(this.axesTab);
        this.compileFiltersTab = document.createElement('div');
        this.compileFiltersTab.id = 'fontinfo-compile-filters-content';
        this.compileFiltersTab.style.display = 'none';
        this.compileFiltersTab.style.height = '100%';
        this.compileFiltersTab.style.overflow = 'auto';
        this.compileFiltersFieldsContainer = document.createElement('div');
        this.compileFiltersFieldsContainer.className = 'fontinfo-names-fields';
        this.compileFiltersTab.appendChild(this.compileFiltersFieldsContainer);

        viewContent.appendChild(this.customOTValuesTab);
        viewContent.appendChild(this.featuresTab);
        viewContent.appendChild(this.compileFiltersTab);

        // Set up automatic checkbox handler
        const autoCheckbox = this.featuresTab.querySelector(
            '#feature-automatic-checkbox'
        ) as HTMLInputElement;
        if (autoCheckbox) {
            autoCheckbox.addEventListener('change', () =>
                this.onAutomaticCheckboxChanged()
            );
        }
        this.featuresTab
            .querySelector('#feature-manage-checkbox')
            ?.addEventListener('change', (event) =>
                this.onManageFeaturesChanged(event.target as HTMLInputElement)
            );
        this.featuresTab
            .querySelector('#feature-regenerate-button')
            ?.addEventListener('click', () => {
                const stamp = this.selectedGeneratorStamp();
                if (stamp) {
                    featureGeneratorEngine.regenerate(stamp.generator);
                }
            });
        this.initFeatureSourcePopup();
        this.initFeatureContextMenu();
        this.initFeatureStructureControls();
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
        // Read-only until an item that is not automatic is selected.
        this.setFeatureEditorEditable(false);
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
        if (this.stationsTab) {
            this.stationsTab.style.display =
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
        if (this.compileFiltersTab) {
            this.compileFiltersTab.style.display =
                tab === 'compile_filters' ? 'block' : 'none';
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
                    (!this.stationsDataLoaded ||
                        this.pendingStationsModelSyncRefresh)
                ) {
                    this.refreshVisibleStationsContent();
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

                if (tab === 'compile_filters') {
                    void this.renderCompileFiltersContent();
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
        this.stationsDataLoaded = false;
        this.pendingStationsModelSyncRefresh = false;
        this.instancesDataLoaded = false;
        this.pendingInstancesModelSyncRefresh = false;
        this.axesDataLoaded = false;
        this.pendingAxesModelSyncRefresh = false;
        this.customOTValuesDataLoaded = false;
        this.pendingCustomOTValuesModelSyncRefresh = false;
        this.fontDataLoaded = false;
        this.pendingModelSyncRefresh = false;
        this.featureCodeDirty = false;
        this.pendingGeneratedFeatureReveal = false;
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
            requestAnimationFrame(() => this.refreshVisibleStationsContent());
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
                    // A new font has no stored composition setting. Re-render
                    // the open form so the radio returns to its default.
                    if (this.pluginSettingsOpenId) {
                        this.showPluginSettings(this.pluginSettingsOpenId);
                    }
                }
            });
        }
    }

    private onFontModelSynced() {
        this.generalDataLoaded = false;
        this.pendingGeneralModelSyncRefresh = true;
        this.namesDataLoaded = false;
        this.pendingNamesModelSyncRefresh = true;
        this.stationsDataLoaded = false;
        this.pendingStationsModelSyncRefresh = true;
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
            if (this.hasStationListStructureChanged()) {
                requestAnimationFrame(() =>
                    this.forceRefreshVisibleStationsContent()
                );
                return;
            }
            if (this.isStationsEditing()) {
                return;
            }
            requestAnimationFrame(() => this.refreshVisibleStationsContent());
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

        if (this.currentTab === 'compile_filters') {
            requestAnimationFrame(() => this.reloadCompileFiltersIfVisible());
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

    private isStationsEditing(): boolean {
        return this.isEditableControlWithin(this.stationsTab);
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

    private refreshVisibleStationsContent() {
        if (this.currentTab !== 'masters' || !window.currentFontModel) {
            return;
        }

        if (this.isStationsEditing()) {
            return;
        }

        this.preserveFontInfoScrollPosition(() => this.renderStationsContent());
        this.stationsDataLoaded = true;
        this.pendingStationsModelSyncRefresh = false;
    }

    private forceRefreshVisibleStationsContent() {
        if (this.currentTab !== 'masters' || !window.currentFontModel) {
            return;
        }

        this.preserveFontInfoScrollPosition(() => this.renderStationsContent());
        this.stationsDataLoaded = true;
        this.pendingStationsModelSyncRefresh = false;
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
                return this.stationsTab;
            case 'instances':
                return this.instancesTab;
            case 'axes':
                return this.axesTab;
            case 'custom_ot_values':
                return this.customOTValuesTab;
            case 'compile_filters':
                return this.compileFiltersTab;
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

    private getStationListStructureSignature(
        stations?: Babelfont.Master[] | undefined
    ): string {
        const font = window.currentFontModel ?? undefined;
        const sourceStations = stations ?? font?.stations ?? [];

        return sourceStations
            .map((station, index) => station.id ?? `index:${index}`)
            .join('|');
    }

    private getInstanceListStructureSignature(
        instances?: Babelfont.Instance[] | undefined
    ): string {
        const font = window.currentFontModel ?? undefined;
        const sourceInstances = instances ?? font?.instances ?? [];

        return sourceInstances
            .map((instance, index) => instance.id ?? `index:${index}`)
            .join('|');
    }

    private hasStationListStructureChanged(): boolean {
        return (
            this.renderedStationListSignature !==
            this.getStationListStructureSignature()
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
        const font = window.currentFontModel ?? undefined;
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
        const font = window.currentFontModel ?? undefined;
        const axis = font?.axes?.[axisIndex];

        return {
            primary: getLocalizedDictionarySummary(
                axis?.name,
                axis?.tag ?? `Axis ${axisIndex + 1}`
            ),
            secondary: axis?.tag ?? ''
        };
    }

    private getStationListSummary(stationIndex: number): {
        primary: string;
        secondary: string[];
    } {
        const font = window.currentFontModel ?? undefined;
        const station = font?.stations?.[stationIndex];

        return {
            primary: getLocalizedDictionarySummary(
                station?.name,
                `Station ${stationIndex + 1}`
            ),
            secondary: formatLocationSummary(
                font?.axes,
                station?.location as Record<string, number> | undefined
            )
        };
    }

    private getInstanceListSummary(instanceIndex: number): {
        primary: string;
        secondary: string[];
    } {
        const font = window.currentFontModel ?? undefined;
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

    private getStationListItems(): HTMLElement[] {
        return Array.from(
            this.stationsFieldsContainer?.querySelectorAll(
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

    private refreshStationSidebarItemSummary(stationIndex: number) {
        if (this.currentTab !== 'masters') {
            return;
        }

        this.updateRecordListItemSummary(
            this.getStationListItems()[stationIndex],
            this.getStationListSummary(stationIndex)
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
            'Written to head.created. Shown in your local time and stored as UTC. Now stamps the current date and time.';
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
        helper.textContent =
            'Written to head.fontRevision, so 1 and 3 become 1.003. Name ID 5 defaults to “Version 1.003”; the compiler adds “;fontc” and its own version to it.';
        wrapper.appendChild(helper);

        return wrapper;
    }

    private renderGeneralContent() {
        if (!this.generalFieldsContainer) {
            return;
        }

        const font = window.currentFontModel ?? undefined;
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
                helperText:
                    'Units per em, written to head.unitsPerEm. Most fonts use 1000.',
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
                helperText:
                    'Kept in the source file only, never written to the compiled font. Leave blank to remove the note.',
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

        const context = this.buildNameFallbackContext();
        FONT_NAME_GROUPS.forEach((group) => {
            const { section: groupEl, fields: fieldsEl } =
                this.createFontInfoSection(group.title, group.description);

            group.fields.forEach((field) => {
                const editor = createLocalizedStringEditor({
                    label: field.label,
                    labelDetail: `name ID ${field.nameId}`,
                    value: names[field.key],
                    multiline: field.multiline,
                    placeholder: field.placeholder?.(context),
                    note: field.note?.(context),
                    onCommit: (nextValue) =>
                        this.commitNameFieldValue(field.key, nextValue)
                });

                editor.element.setAttribute('data-name-field', field.key);
                fieldsEl.appendChild(editor.element);
                this.namesFieldEditors.set(field.key, editor);
            });

            this.namesFieldsContainer?.appendChild(groupEl);
        });
    }

    /** The values fontc writes for empty name fields of the open font. */
    private buildNameFallbackContext(): NameFallbackContext {
        const font = window.currentFontModel ?? undefined;
        const names = (font?.names ?? {}) as Partial<
            Record<FontNameFieldKey, Babelfont.I18NDictionary>
        >;
        const read = (key: FontNameFieldKey): string => {
            const value = names[key];
            if (!value) {
                return '';
            }
            const values = Object.values(value);
            return value.dflt ?? (values.length === 1 ? values[0] : '') ?? '';
        };
        const axes = plainRecords<Babelfont.Axis>(font?.axes);
        const stations = plainRecords<Babelfont.Master>(font?.stations).map(
            (station) => ({
                name:
                    typeof station.name === 'string'
                        ? station.name
                        : (station.name?.dflt ?? ''),
                location: Object.fromEntries(
                    Object.entries(station.location ?? {}).map(
                        ([tag, value]) => [tag, Number(value)]
                    )
                )
            })
        );
        const defaultStyle =
            findDefaultStation(axes, stations)?.name || 'Regular';
        const family = read('family_name');
        const typographicFamily = read('typographic_family') || family;
        const typographicSubfamily =
            read('typographic_subfamily') || defaultStyle;
        const familyWords = [family, ...defaultStyle.split(/\s+/)];
        while (
            ['Regular', 'Bold', 'Italic'].includes(
                familyWords[familyWords.length - 1]
            )
        ) {
            familyWords.pop();
        }
        const [major, minor] = (font?.version ?? [1, 0]) as [number, number];
        const vendor =
            String(
                (font?.custom_ot_values as Babelfont.CustomOTValues | undefined)
                    ?.os2_vendor_id ?? ''
            ) || 'NONE';
        const postscriptName =
            `${typographicFamily.replace(/\s/g, '')}-${typographicSubfamily}`
                .split('')
                .filter((character) => {
                    const code = character.charCodeAt(0);
                    return (
                        code >= 33 &&
                        code < 127 &&
                        !'[](){}<>/%'.includes(character)
                    );
                })
                .join('');
        return {
            typographicFamily,
            typographicSubfamily,
            computedFamilyName: familyWords.filter(Boolean).join(' '),
            version: `Version ${major}.${String(minor).padStart(3, '0')}`,
            vendor,
            postscriptName
        };
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
        button.className = `editor-drawing-item fontinfo-record-item${options.selected ? ' selected' : ''}`;
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
            'editor-drawing-item-content fontinfo-record-item-content';

        const primary = document.createElement('div');
        primary.className = 'fontinfo-record-item-primary station-item-name';
        primary.textContent = options.primary;

        const secondary = document.createElement('div');
        secondary.className =
            'fontinfo-record-item-secondary station-item-location';
        secondary.replaceChildren(
            ...asSummaryLines(options.secondary).map((line) => {
                const lineEl = document.createElement('div');
                lineEl.className =
                    'fontinfo-record-item-secondary-line station-item-location-line';
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
        disabledReason?: string;
    }): HTMLElement {
        const header = document.createElement('div');
        header.className = 'editor-drawings-header';

        const title = document.createElement('div');
        title.className = 'editor-section-title';
        const titleText = document.createElement('span');
        titleText.className = 'editor-section-title-text';
        titleText.textContent = options.title;
        title.appendChild(titleText);

        const actions = document.createElement('div');
        actions.className = 'editor-drawings-header-actions';

        const addButton = document.createElement('button');
        addButton.type = 'button';
        addButton.className = 'editor-drawing-add-button';
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
        removeButton.className = 'editor-drawing-add-button';
        removeButton.setAttribute(
            'aria-label',
            `Remove ${options.title.slice(0, -1).toLowerCase()}`
        );
        removeButton.setAttribute(
            'data-fontinfo-list-action',
            `${options.title.toLowerCase()}-remove`
        );
        removeButton.textContent = '−';
        removeButton.disabled = !options.canRemove || !!options.disabledReason;
        if (options.disabledReason) {
            addButton.disabled = true;
            addButton.title = options.disabledReason;
            removeButton.title = options.disabledReason;
        }
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
            const { section: groupEl, fields: fieldsEl } =
                this.createFontInfoSection(group.title, group.description);

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

                const editor = this.createSimpleFieldEditor({
                    label: field.label,
                    value: formattedValue,
                    inputType: field.kind === 'integer' ? 'number' : undefined,
                    step: field.kind === 'integer' ? '1' : undefined,
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
                });
                if (field.bits) {
                    this.appendBitFieldOptions(editor, field.bits);
                }
                fieldsEl.appendChild(editor);
            });

            options.container.appendChild(groupEl);
        });
    }

    /**
     * Checkboxes for the bits of an integer field. Ticking one writes the
     * new number into the field and commits it the same way as typing.
     */
    private appendBitFieldOptions(
        editor: HTMLElement,
        bits: Array<[number, string]>
    ): void {
        const input = editor.querySelector('.localized-string-input');
        if (!(input instanceof HTMLInputElement)) {
            return;
        }
        const list = document.createElement('div');
        list.className = 'fontinfo-bit-list';
        const checkboxes: Array<[number, HTMLInputElement]> = [];
        const currentValue = (): number => {
            const parsed = parseIntegerInput(input.value);
            return typeof parsed === 'number' ? parsed : 0;
        };
        const sync = (): void => {
            const value = currentValue();
            for (const [bit, checkbox] of checkboxes) {
                checkbox.checked = (value & (1 << bit)) !== 0;
            }
        };
        for (const [bit, label] of bits) {
            const option = document.createElement('label');
            option.className = 'fontinfo-bit-option';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.addEventListener('change', () => {
                const value = currentValue();
                input.value = String(
                    checkbox.checked ? value | (1 << bit) : value & ~(1 << bit)
                );
                input.dispatchEvent(new Event('blur'));
            });
            const text = document.createElement('span');
            text.textContent = label;
            const number = document.createElement('span');
            number.className = 'fontinfo-bit-number';
            number.textContent = `bit ${bit}`;
            option.append(checkbox, text, number);
            list.appendChild(option);
            checkboxes.push([bit, checkbox]);
        }
        input.addEventListener('input', sync);
        input.addEventListener('blur', sync);
        sync();
        const helper = editor.querySelector('.localized-string-helper');
        editor.insertBefore(list, helper);
    }

    private appendLocationSection(options: {
        container: HTMLElement;
        title: string;
        dataFieldPrefix: string;
        location?: Record<string, number>;
        onCommit: (axisTag: string, nextValue: number | undefined) => void;
    }) {
        const font = window.currentFontModel ?? undefined;
        const section = document.createElement('section');
        section.className = 'fontinfo-name-group';

        const titleEl = document.createElement('h3');
        titleEl.className = 'sidebar-section-title';
        titleEl.textContent = options.title;
        section.appendChild(titleEl);

        const fieldsEl = document.createElement('div');
        fieldsEl.className = 'fontinfo-name-group-fields';

        const locationKeys = getLocationKeys(font?.axes, options.location);
        const axes = (font?.axes ?? []) as Babelfont.Axis[];
        locationKeys.forEach((axisTag) => {
            const axis = axes.find((item) => item.tag === axisTag);
            const currentValue = options.location?.[axisTag];
            const axisName = axis
                ? getLocalizedDictionarySummary(axis.name, axis.tag)
                : axisTag;
            const label = axis ? `${axisName} (${axis.tag})` : axisTag;
            const defaultDesignValue =
                axis?.default !== undefined
                    ? (
                          userspaceToDesignspace(
                              { [axisTag]: axis.default } as UserspaceLocation,
                              axes
                          ) as Record<string, number>
                      )[axisTag]
                    : undefined;
            const describe = (designValue: number | undefined): string => {
                if (!axis) {
                    return 'Location on an axis the font no longer lists.';
                }
                const value = designValue ?? defaultDesignValue;
                if (value === undefined) {
                    return 'Design value: the coordinate you draw at.';
                }
                const userValue = (
                    designspaceToUserspace(
                        { [axisTag]: value } as DesignspaceLocation,
                        axes
                    ) as Record<string, number>
                )[axisTag];
                return `Design value. People see it as ${formatAxisValue(Number(userValue))} on the ${axisName} axis.`;
            };

            const editor = this.createSimpleFieldEditor({
                label,
                value: currentValue === undefined ? '' : String(currentValue),
                inputType: 'number',
                placeholder:
                    defaultDesignValue !== undefined
                        ? `Default ${formatAxisValue(Number(defaultDesignValue))}`
                        : 'Leave blank for default',
                dataField: `${options.dataFieldPrefix}.${axisTag}`,
                helperText: describe(currentValue),
                onCommit: (rawValue) => {
                    const parsedValue = parseNumericInput(rawValue);
                    if (parsedValue === null) {
                        return currentValue === undefined
                            ? ''
                            : String(currentValue);
                    }

                    options.onCommit(axisTag, parsedValue);
                    const helper = editor.querySelector(
                        '.localized-string-helper'
                    );
                    if (helper) {
                        helper.textContent = describe(parsedValue);
                    }
                    return parsedValue === undefined ? '' : String(parsedValue);
                }
            });
            fieldsEl.appendChild(editor);
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

    /** A Font info section: title, optional description, and a fields list. */
    private createFontInfoSection(
        title: string,
        description?: string
    ): { section: HTMLElement; fields: HTMLElement } {
        const section = document.createElement('section');
        section.className = 'fontinfo-name-group';
        const titleEl = document.createElement('h3');
        titleEl.className = 'sidebar-section-title';
        titleEl.textContent = title;
        section.appendChild(titleEl);
        if (description) {
            const descriptionEl = document.createElement('p');
            descriptionEl.className = 'fontinfo-section-description';
            descriptionEl.textContent = description;
            section.appendChild(descriptionEl);
        }
        const fields = document.createElement('div');
        fields.className = 'fontinfo-name-group-fields';
        section.appendChild(fields);
        return { section, fields };
    }

    /** A labelled number input that commits on blur or Enter. */
    private createMetricNumberInput(options: {
        value: number | undefined;
        caption?: string;
        placeholder?: string;
        ariaLabel: string;
        dataField: string;
        disabled?: boolean;
        onCommit: (nextValue: number | undefined) => void;
    }): HTMLElement {
        const wrapper = document.createElement('label');
        wrapper.className = 'fontinfo-metric-input';
        wrapper.setAttribute('data-font-field', options.dataField);
        if (options.caption) {
            const caption = document.createElement('span');
            caption.className = 'fontinfo-metric-caption';
            caption.textContent = options.caption;
            wrapper.appendChild(caption);
        }
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'localized-string-input';
        input.setAttribute('aria-label', options.ariaLabel);
        input.value = options.value === undefined ? '' : String(options.value);
        if (options.placeholder) {
            input.placeholder = options.placeholder;
        }
        input.disabled = Boolean(options.disabled);
        let lastCommittedValue = input.value;
        const commit = (): void => {
            if (input.value === lastCommittedValue) {
                return;
            }
            const parsedValue = parseNumericInput(input.value);
            if (parsedValue === null) {
                input.value = lastCommittedValue;
                return;
            }
            lastCommittedValue =
                parsedValue === undefined ? '' : String(parsedValue);
            input.value = lastCommittedValue;
            options.onCommit(parsedValue);
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                input.value = lastCommittedValue;
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
        wrapper.appendChild(input);
        return wrapper;
    }

    /** One row: label (with an optional technical key) and its inputs. */
    private createMetricRow(options: {
        label: string;
        detail?: string;
        helper?: string;
        inputs: HTMLElement[];
    }): HTMLElement {
        const row = document.createElement('div');
        row.className = 'localized-string-editor fontinfo-metric-row';
        const label = document.createElement('div');
        label.className = 'localized-string-label';
        label.textContent = options.label;
        if (options.detail) {
            const detail = document.createElement('small');
            detail.className = 'fontinfo-field-key';
            detail.textContent = options.detail;
            label.appendChild(detail);
        }
        row.appendChild(label);
        const inputs = document.createElement('div');
        inputs.className = 'fontinfo-metric-inputs';
        options.inputs.forEach((input) => inputs.appendChild(input));
        row.appendChild(inputs);
        if (options.helper) {
            const helper = document.createElement('div');
            helper.className = 'localized-string-helper';
            helper.textContent = options.helper;
            row.appendChild(helper);
        }
        return row;
    }

    /**
     * Set or remove (`value: undefined`) station metrics as one undo step.
     * A single edit of an existing value keeps the plain station-metric path.
     */
    private commitStationMetricChanges(
        stationIndex: number,
        label: string,
        changes: Array<{ key: string; value: number | undefined }>
    ): void {
        const station = window.currentFontModel?.stations?.[stationIndex];
        if (!station) {
            return;
        }
        const currentMetrics = (station.metrics ?? {}) as Record<
            string,
            number
        >;
        const effective = changes.filter(
            (change) => currentMetrics[change.key] !== change.value
        );
        if (effective.length === 0) {
            return;
        }
        if (effective.length === 1 && effective[0].value !== undefined) {
            this.commitStationMetricValue(
                stationIndex,
                effective[0].key,
                effective[0].value
            );
            return;
        }
        this.commitMultipleFontPathChanges({
            label,
            changes: effective.map((change) => ({
                op: change.value === undefined ? 'remove' : 'set',
                path: ['masters', stationIndex, 'metrics', change.key],
                oldValue: currentMetrics[change.key],
                newValue: change.value
            })),
            applyLocal: () => {
                const metrics = {
                    ...((station.metrics ?? {}) as Record<string, number>)
                };
                for (const change of effective) {
                    if (change.value === undefined) {
                        delete metrics[change.key];
                    } else {
                        metrics[change.key] = change.value;
                    }
                }
                station.metrics = metrics;
            },
            markDirtyKey: 'font-info-station-metric'
        });
    }

    private appendStationMetricsSections(
        detail: HTMLElement,
        stationIndex: number,
        initialMetrics: Record<string, number>
    ): void {
        const font = window.currentFontModel ?? undefined;
        const upm = Number(font?.upm) || 1000;
        const metrics: Record<string, number> = { ...initialMetrics };
        const prefix = `masters.${stationIndex}.metrics`;
        const afterCommitHooks: Array<() => void> = [];
        const setMetrics = (
            label: string,
            changes: Array<{ key: string; value: number | undefined }>
        ): void => {
            this.commitStationMetricChanges(stationIndex, label, changes);
            for (const change of changes) {
                if (change.value === undefined) {
                    delete metrics[change.key];
                } else {
                    metrics[change.key] = change.value;
                }
            }
            afterCommitHooks.forEach((hook) => hook());
        };
        const setMetric = (key: string, value: number | undefined): void =>
            setMetrics('Edit metric', [{ key, value }]);
        const numberOrUndefined = (key: string): number | undefined =>
            Number.isFinite(metrics[key]) ? metrics[key] : undefined;

        // Vertical metrics with zones and a preview.
        const vertical = this.createFontInfoSection(
            'Vertical metrics',
            'Guides in the glyph editor. A zone is the overshoot area beside its line: the editor draws it and Glyphs files keep it, but the compiler does not use zones.'
        );
        for (const spec of CORE_STATION_METRICS) {
            const valueKey = coreMetricKey(metrics, spec);
            const zoneKey = coreZoneKey(metrics, spec);
            const isBaseline = spec.type === 'baseline';
            vertical.fields.appendChild(
                this.createMetricRow({
                    label: spec.label,
                    helper: spec.helper,
                    inputs: [
                        this.createMetricNumberInput({
                            value: isBaseline ? 0 : numberOrUndefined(valueKey),
                            caption: 'Position',
                            ariaLabel: `${spec.label} position`,
                            dataField: `${prefix}.${valueKey}`,
                            disabled: isBaseline,
                            onCommit: (nextValue) =>
                                setMetric(valueKey, nextValue)
                        }),
                        this.createMetricNumberInput({
                            value: numberOrUndefined(zoneKey),
                            caption: 'Zone',
                            placeholder: '0',
                            ariaLabel: `${spec.label} zone`,
                            dataField: `${prefix}.${zoneKey}`,
                            onCommit: (nextValue) =>
                                setMetric(zoneKey, nextValue)
                        })
                    ]
                })
            );
        }
        const angleKey = italicAngleKey(metrics);
        vertical.fields.appendChild(
            this.createMetricRow({
                label: 'Italic angle',
                helper: 'Degrees, positive leans right. Written to post.italicAngle and the hhea caret slope. A non-zero angle also marks the font as italic, unless Custom OT Values sets the style flags.',
                inputs: [
                    this.createMetricNumberInput({
                        value: numberOrUndefined(angleKey),
                        caption: 'Degrees',
                        placeholder: '0',
                        ariaLabel: 'Italic angle in degrees',
                        dataField: `${prefix}.${angleKey}`,
                        onCommit: (nextValue) => setMetric(angleKey, nextValue)
                    })
                ]
            })
        );
        const body = document.createElement('div');
        body.className = 'fontinfo-metrics-body';
        vertical.section.replaceChild(body, vertical.fields);
        body.appendChild(vertical.fields);
        const previewHolder = document.createElement('div');
        previewHolder.className = 'fontinfo-metrics-preview-holder';
        body.appendChild(previewHolder);
        const renderPreview = (): void => {
            previewHolder.replaceChildren(
                createMetricsPreview({
                    lines: CORE_STATION_METRICS.flatMap((spec) => {
                        const y =
                            spec.type === 'baseline'
                                ? 0
                                : numberOrUndefined(
                                      coreMetricKey(metrics, spec)
                                  );
                        if (y === undefined) {
                            return [];
                        }
                        return [
                            {
                                label: spec.label,
                                y,
                                zone:
                                    numberOrUndefined(
                                        coreZoneKey(metrics, spec)
                                    ) ?? 0
                            }
                        ];
                    }),
                    italicAngle: numberOrUndefined(italicAngleKey(metrics)) ?? 0
                })
            );
        };
        renderPreview();
        afterCommitHooks.push(renderPreview);
        detail.appendChild(vertical.section);

        // Metrics for one writing script, as Glyphs metric filters.
        const scriptSection = this.createFontInfoSection(
            'Writing-script metrics',
            'Metrics for the glyphs of one writing script, like metrics with a script filter in Glyphs. The editor shows them for glyphs of that script, from the glyph’s own script or from Glyph Data. Glyphs files keep them; the compiler does not use them.'
        );
        const scripts = scriptsWithMetrics(metrics);
        for (const script of scripts) {
            const header = document.createElement('div');
            header.className = 'fontinfo-script-metrics-header';
            const name = document.createElement('span');
            name.className = 'fontinfo-script-metrics-name';
            name.textContent = glyphsScriptLabel(script);
            header.appendChild(name);
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'localized-string-locales-button';
            remove.textContent = 'Remove';
            remove.setAttribute(
                'aria-label',
                `Remove ${glyphsScriptLabel(script)} metrics`
            );
            remove.addEventListener('click', () => {
                setMetrics(
                    'Remove writing-script metrics',
                    Object.keys(metrics)
                        .filter(
                            (key) =>
                                parseScopedMetricKey(key)?.script === script
                        )
                        .map((key) => ({ key, value: undefined }))
                );
                this.renderStationsContent();
            });
            header.appendChild(remove);
            scriptSection.fields.appendChild(header);
            for (const spec of SCRIPT_METRIC_TYPES) {
                const valueKey = scriptMetricKey(spec.type, script);
                const zoneKey = scriptMetricKey(spec.type, script, true);
                const fallback = numberOrUndefined(
                    coreMetricKey(metrics, spec)
                );
                scriptSection.fields.appendChild(
                    this.createMetricRow({
                        label: spec.label,
                        inputs: [
                            this.createMetricNumberInput({
                                value: numberOrUndefined(valueKey),
                                caption: 'Position',
                                placeholder:
                                    fallback === undefined
                                        ? ''
                                        : String(fallback),
                                ariaLabel: `${glyphsScriptLabel(script)} ${spec.label} position`,
                                dataField: `${prefix}.${valueKey}`,
                                onCommit: (nextValue) =>
                                    setMetric(valueKey, nextValue)
                            }),
                            this.createMetricNumberInput({
                                value: numberOrUndefined(zoneKey),
                                caption: 'Zone',
                                placeholder: '0',
                                ariaLabel: `${glyphsScriptLabel(script)} ${spec.label} zone`,
                                dataField: `${prefix}.${zoneKey}`,
                                onCommit: (nextValue) =>
                                    setMetric(zoneKey, nextValue)
                            })
                        ]
                    })
                );
            }
        }
        if (scripts.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'localized-string-helper';
            empty.textContent = 'No writing script has its own metrics.';
            scriptSection.fields.appendChild(empty);
        }
        const addSelect = document.createElement('select');
        addSelect.className = 'localized-string-input fontinfo-script-add';
        addSelect.setAttribute(
            'aria-label',
            'Add metrics for a writing script'
        );
        const placeholderOption = document.createElement('option');
        placeholderOption.value = '';
        placeholderOption.textContent = 'Add a writing script…';
        addSelect.appendChild(placeholderOption);
        for (const [script, label] of GLYPHS_METRIC_SCRIPTS) {
            if (scripts.includes(script)) {
                continue;
            }
            const option = document.createElement('option');
            option.value = script;
            option.textContent = label;
            addSelect.appendChild(option);
        }
        addSelect.addEventListener('change', () => {
            const script = addSelect.value;
            if (!script) {
                return;
            }
            const xHeightSpec = SCRIPT_METRIC_TYPES.find(
                (spec) => spec.type === 'xHeight'
            );
            const startValue = xHeightSpec
                ? numberOrUndefined(coreMetricKey(metrics, xHeightSpec))
                : undefined;
            setMetrics('Add writing-script metrics', [
                {
                    key: scriptMetricKey('xHeight', script),
                    value: startValue ?? 0
                },
                {
                    key: scriptMetricKey('xHeight', script, true),
                    value: 0
                }
            ]);
            this.renderStationsContent();
        });
        scriptSection.section.appendChild(addSelect);
        detail.appendChild(scriptSection.section);

        // Line spacing, with the values fontc derives for empty fields.
        const spacing = this.createFontInfoSection(
            'Line spacing',
            'How far apart lines of text sit. Written to the OS/2 and hhea tables. Empty fields show the value the compiler writes in their place.'
        );
        const table = document.createElement('table');
        table.className = 'fontinfo-line-spacing';
        const head = document.createElement('tr');
        for (const title of ['', 'Typo', 'hhea', 'Win']) {
            const cell = document.createElement('th');
            cell.scope = 'col';
            cell.textContent = title;
            head.appendChild(cell);
        }
        const thead = document.createElement('thead');
        thead.appendChild(head);
        table.appendChild(thead);
        const tbody = document.createElement('tbody');
        const spacingInputs: Array<{
            key: keyof ReturnType<typeof lineSpacingDefaults>;
            input: HTMLInputElement | null;
        }> = [];
        const spacingRows: Array<
            [string, Array<keyof ReturnType<typeof lineSpacingDefaults> | null>]
        > = [
            ['Ascender', ['TypoAscender', 'HheaAscender', 'WinAscent']],
            ['Descender', ['TypoDescender', 'HheaDescender', 'WinDescent']],
            ['Line gap', ['TypoLineGap', 'HheaLineGap', null]]
        ];
        const defaults = lineSpacingDefaults(metrics, upm);
        for (const [rowLabel, keys] of spacingRows) {
            const row = document.createElement('tr');
            const header = document.createElement('th');
            header.scope = 'row';
            header.textContent = rowLabel;
            row.appendChild(header);
            for (const key of keys) {
                const cell = document.createElement('td');
                if (key === null) {
                    cell.className = 'fontinfo-line-spacing-empty';
                    cell.textContent = 'n/a';
                } else {
                    const existingKey = findMetricKey(metrics, [key]) ?? key;
                    const field = this.createMetricNumberInput({
                        value: numberOrUndefined(existingKey),
                        placeholder: String(defaults[key]),
                        ariaLabel: `${key} line spacing value`,
                        dataField: `${prefix}.${existingKey}`,
                        onCommit: (nextValue) =>
                            setMetric(existingKey, nextValue)
                    });
                    spacingInputs.push({
                        key,
                        input: field.querySelector('input')
                    });
                    cell.appendChild(field);
                }
                row.appendChild(cell);
            }
            tbody.appendChild(row);
        }
        table.appendChild(tbody);
        spacing.fields.appendChild(table);
        const spacingHelp = document.createElement('div');
        spacingHelp.className = 'localized-string-helper';
        spacingHelp.textContent =
            'Typo: OS/2 sTypo values, used when “Use typo metrics” (fsSelection bit 7) is set in Custom OT Values. hhea: used by macOS and iOS. Win: OS/2 usWin values; Windows clips glyphs outside them. Win descent is a positive number.';
        spacing.fields.appendChild(spacingHelp);
        afterCommitHooks.push(() => {
            const nextDefaults = lineSpacingDefaults(metrics, upm);
            for (const { key, input } of spacingInputs) {
                if (input) {
                    input.placeholder = String(nextDefaults[key]);
                }
            }
        });
        detail.appendChild(spacing.section);

        // Any other station values, such as Glyphs metrics without a type.
        const otherKeys = Object.keys(metrics)
            .filter(
                (key) =>
                    !isStructuredStationMetricKey(key) &&
                    !isHiddenStationMetricsPanelKey(key)
            )
            .sort((left, right) => left.localeCompare(right));
        if (otherKeys.length > 0) {
            const other = this.createFontInfoSection(
                'Other metrics',
                'More values from the source file. Known OpenType values such as underline, strikeout and subscript positions reach the compiled font; other names stay in the source only.'
            );
            for (const key of otherKeys) {
                other.fields.appendChild(
                    this.createMetricRow({
                        label: key,
                        inputs: [
                            this.createMetricNumberInput({
                                value: numberOrUndefined(key),
                                ariaLabel: key,
                                dataField: `${prefix}.${key}`,
                                onCommit: (nextValue) =>
                                    setMetric(key, nextValue)
                            })
                        ]
                    })
                );
            }
            detail.appendChild(other.section);
        }
    }

    private renderStationsContent() {
        if (!this.stationsFieldsContainer) {
            return;
        }

        const font = window.currentFontModel ?? undefined;
        const stations = plainRecords<Babelfont.Master>(font?.stations);
        this.renderedStationListSignature =
            this.getStationListStructureSignature(stations);

        this.stationsFieldsContainer.innerHTML = '';

        if (stations.length === 0) {
            this.selectedStationIndex = 0;
            this.selectedStationIndices = new Set();
        } else {
            this.selectedStationIndex = Math.min(
                this.selectedStationIndex,
                stations.length - 1
            );
            const clamped = new Set(
                [...this.selectedStationIndices].filter(
                    (i) => i < stations.length
                )
            );
            this.selectedStationIndices =
                clamped.size > 0
                    ? clamped
                    : new Set([this.selectedStationIndex]);
        }
        const selectedStation = stations[this.selectedStationIndex];

        const layout = document.createElement('div');
        layout.className = 'fontinfo-records-layout';

        const topologyGate = this.getStationTopologyGate();
        this.renderedStationTopologyGateSignature =
            this.stationTopologyGateSignature(topologyGate);
        const topologyBlockedReason = topologyGate.allowed
            ? undefined
            : topologyGate.reason || 'Stations cannot be changed right now.';

        const sidebar = document.createElement('aside');
        sidebar.className =
            'view-sidebar view-sidebar-left fontinfo-records-sidebar';
        sidebar.appendChild(
            this.createRecordsSidebarHeader({
                title: 'Stations',
                canRemove:
                    stations.length > 0 && this.selectedStationIndices.size > 0,
                onAdd: () => this.addStationRecord(),
                onRemove: () => this.removeSelectedStationRecord(),
                disabledReason: topologyBlockedReason
            })
        );
        if (topologyBlockedReason) {
            sidebar.appendChild(
                this.createStationTopologyBlockedNotice(
                    topologyBlockedReason,
                    topologyGate.canReopenWithAllGlyphs === true
                )
            );
        }
        const list = document.createElement('div');
        list.className =
            'sidebar-list editor-drawings-list fontinfo-records-list';

        const stationContextMenuBackdrop = getOrCreateBackdrop(
            'fontinfo-station-context-menu-backdrop'
        );

        stations.forEach((station, index) => {
            const stationId = (station as any).id as string | undefined;
            const summary = this.getStationListSummary(index);
            const btn = this.createRecordListButton({
                primary: summary.primary,
                secondary: summary.secondary,
                selected: this.selectedStationIndices.has(index),
                draggable: stations.length > 1,
                onClick: (event: MouseEvent) => {
                    const isMulti = event.ctrlKey || event.metaKey;
                    const isRange = event.shiftKey;
                    if (isMulti) {
                        if (this.selectedStationIndices.has(index)) {
                            if (this.selectedStationIndices.size > 1) {
                                this.selectedStationIndices = new Set(
                                    [...this.selectedStationIndices].filter(
                                        (i) => i !== index
                                    )
                                );
                            }
                        } else {
                            this.selectedStationIndices = new Set([
                                ...this.selectedStationIndices,
                                index
                            ]);
                            this.selectedStationIndex = index;
                        }
                    } else if (isRange) {
                        const lo = Math.min(this.selectedStationIndex, index);
                        const hi = Math.max(this.selectedStationIndex, index);
                        const newSet = new Set(this.selectedStationIndices);
                        for (let i = lo; i <= hi; i++) {
                            newSet.add(i);
                        }
                        this.selectedStationIndices = newSet;
                        this.selectedStationIndex = index;
                    } else {
                        this.selectedStationIndices = new Set([index]);
                        this.selectedStationIndex = index;
                    }
                    this.renderStationsContent();
                },
                onDragStart: (event) => this.onStationDragStart(event, index),
                onDragOver: (event) => this.onStationDragOver(event, index),
                onDrop: (event) => this.onStationDrop(event, index),
                onDragEnd: () => this.onStationDragEnd()
            });

            // Context menu — appears on right-click.
            if (stationId) {
                const reinterpolateDisabled = topologyBlockedReason
                    ? ' disabled plugin-menu-item-disabled" aria-disabled="true'
                    : '';
                const menuHtml = `<div class="plugin-menu" tabindex="0" role="menu">
                    <div class="plugin-menu-item${reinterpolateDisabled}" data-action="reinterpolate" role="menuitem">
                        <span class="material-symbols-outlined">refresh</span>
                        <span>Reinterpolate all drawings</span>
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
                                    if (topologyBlockedReason) {
                                        (item as HTMLElement).title =
                                            topologyBlockedReason;
                                    }
                                    (item as HTMLElement).onclick = () => {
                                        if (
                                            item.classList.contains(
                                                'plugin-menu-item-disabled'
                                            )
                                        ) {
                                            return;
                                        }
                                        instance.hide();
                                        if (
                                            item.getAttribute('data-action') ===
                                            'reinterpolate'
                                        ) {
                                            beginLoadingCursor();
                                            this.reinterpolateDrawingsForStation(
                                                stationId
                                            )
                                                .catch((err) => {
                                                    // The station’s drawings
                                                    // are as they were.
                                                    reportRefusedEdit(err);
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
                    stationContextMenuBackdrop,
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

        if (!selectedStation) {
            const helper = document.createElement('div');
            helper.className = 'localized-string-helper';
            helper.textContent = 'No stations defined.';
            detail.appendChild(helper);
            layout.appendChild(sidebar);
            layout.appendChild(detail);
            this.stationsFieldsContainer.appendChild(layout);
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
            value: selectedStation.name,
            onCommit: (nextValue) =>
                this.commitStationNameFieldValue(
                    this.selectedStationIndex,
                    nextValue
                )
        });
        nameEditor.element.setAttribute(
            'data-font-field',
            `masters.${this.selectedStationIndex}.name`
        );
        identityFields.appendChild(nameEditor.element);
        identitySection.appendChild(identityFields);
        detail.appendChild(identitySection);

        this.appendLocationSection({
            container: detail,
            title: 'Location',
            dataFieldPrefix: `masters.${this.selectedStationIndex}.location`,
            location: cloneNumericRecord(
                selectedStation.location as Record<string, number> | undefined
            ),
            onCommit: (axisTag, nextValue) =>
                this.commitStationLocationValue(
                    this.selectedStationIndex,
                    axisTag,
                    nextValue
                )
        });

        this.appendStationMetricsSections(
            detail,
            this.selectedStationIndex,
            cloneNumericRecord(
                selectedStation.metrics as Record<string, number> | undefined
            ) ?? {}
        );

        layout.appendChild(sidebar);
        layout.appendChild(detail);
        this.stationsFieldsContainer.appendChild(layout);
    }

    private renderInstancesContent() {
        if (!this.instancesFieldsContainer) {
            return;
        }

        const font = window.currentFontModel ?? undefined;
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
            'sidebar-list editor-drawings-list fontinfo-records-list';

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
        const identityDescription = document.createElement('p');
        identityDescription.className = 'fontinfo-section-description';
        identityDescription.textContent =
            'The variable font lists each instance as a named instance under this name, in one language.';
        identitySection.appendChild(identityDescription);
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

        const linking = this.createFontInfoSection(
            'Style linking',
            'Kept in the source and in Glyphs files. The compiler does not use it: compiled names and style flags come from the default station.'
        );
        const exportSection = linking.section;
        const exportFields = linking.fields;

        exportFields.appendChild(
            this.createSimpleFieldEditor({
                label: 'Linked style',
                value: selectedInstance.linked_style ?? '',
                dataField: `instances.${this.selectedInstanceIndex}.linked_style`,
                helperText:
                    'The instance this one is the bold or italic of, such as Regular.',
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

        detail.appendChild(exportSection);

        layout.appendChild(sidebar);
        layout.appendChild(detail);
        this.instancesFieldsContainer.appendChild(layout);
    }

    private renderAxesContent() {
        if (!this.axesFieldsContainer) {
            return;
        }

        const font = window.currentFontModel ?? undefined;
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
            'sidebar-list editor-drawings-list fontinfo-records-list';

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

        // Range: user values (fvar) and the design values they map to.
        const range = this.createFontInfoSection(
            'Range',
            'User values are what people pick in apps, such as 400 for Regular; they go into the fvar table. Design values are the coordinates your stations and instances sit at. Each design value is stored as a point of the axis mapping below.'
        );
        const rangeTable = document.createElement('table');
        rangeTable.className = 'fontinfo-range-table';
        const rangeHead = document.createElement('tr');
        for (const title of ['', 'Minimum', 'Default', 'Maximum']) {
            const cell = document.createElement('th');
            cell.scope = 'col';
            cell.textContent = title;
            rangeHead.appendChild(cell);
        }
        const rangeHeadGroup = document.createElement('thead');
        rangeHeadGroup.appendChild(rangeHead);
        rangeTable.appendChild(rangeHeadGroup);
        const rangeBody = document.createElement('tbody');
        const rangeFields = ['min', 'default', 'max'] as const;
        const axisIndex = this.selectedAxisIndex;
        for (const space of ['user', 'design'] as const) {
            const row = document.createElement('tr');
            const header = document.createElement('th');
            header.scope = 'row';
            header.textContent =
                space === 'user' ? 'User value' : 'Design value';
            row.appendChild(header);
            for (const field of rangeFields) {
                const cell = document.createElement('td');
                const userValue = selectedAxis[field] as number | undefined;
                const value =
                    space === 'user'
                        ? userValue
                        : this.getAxisDesignspaceValue(selectedAxis, userValue);
                const fieldLabel =
                    field === 'min'
                        ? 'minimum'
                        : field === 'max'
                          ? 'maximum'
                          : 'default';
                cell.appendChild(
                    this.createMetricNumberInput({
                        value,
                        placeholder:
                            space === 'design' &&
                            userValue !== undefined &&
                            !selectedAxis.map?.length
                                ? `Same as ${formatAxisValue(userValue)}`
                                : undefined,
                        ariaLabel: `${space === 'user' ? 'User' : 'Design'} ${fieldLabel}`,
                        dataField:
                            space === 'user'
                                ? `axes.${axisIndex}.${field}`
                                : `axes.${axisIndex}.map.${field}`,
                        onCommit: (nextValue) => {
                            if (space === 'design') {
                                this.commitAxisDesignspaceMapValue(
                                    axisIndex,
                                    field,
                                    nextValue
                                );
                            } else if (nextValue !== undefined) {
                                this.commitAxisRangeValue(
                                    axisIndex,
                                    field,
                                    nextValue
                                );
                            }
                        }
                    })
                );
                row.appendChild(cell);
            }
            rangeBody.appendChild(row);
        }
        rangeTable.appendChild(rangeBody);
        range.fields.appendChild(rangeTable);
        const rangeHelp = document.createElement('div');
        rangeHelp.className = 'localized-string-helper';
        rangeHelp.textContent =
            'Without a mapping, design values equal user values. With a mapping, the default user value must be one of its points, or the font does not compile. An axis whose minimum equals its maximum is left out of the variable font.';
        range.fields.appendChild(rangeHelp);
        detail.appendChild(range.section);

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
                    'Sets the hidden flag in the fvar table, so apps don’t show a slider for this axis.',
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

        const font = window.currentFontModel ?? undefined;
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
                        compileChangeSource: options.label.includes('station')
                            ? 'station-topology'
                            : 'font-info',
                        compileEditType: options.label.includes('station')
                            ? 'station-topology'
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

    private applyLocalRecordNameFieldValue(
        kind: 'station' | 'instance',
        index: number,
        nextValue: Babelfont.I18NDictionary
    ) {
        const font = window.currentFontModel as any;
        const list = kind === 'station' ? font?.stations : font?.instances;
        const record = list?.[index];
        if (!record) {
            return;
        }
        record.name = normalizeLocalizedStringValue(nextValue);
    }

    private commitRecordNameFieldValue(
        kind: 'station' | 'instance',
        index: number,
        nextValue: Babelfont.I18NDictionary
    ) {
        const font = window.currentFontModel as any;
        const list = kind === 'station' ? font?.stations : font?.instances;
        const record = list?.[index];
        if (!record) {
            return;
        }

        const previousValue = normalizeLocalizedStringValue(record.name);
        const normalizedNextValue = normalizeLocalizedStringValue(nextValue);
        if (areLocalizedStringValuesEqual(previousValue, normalizedNextValue)) {
            if (
                kind === 'station' &&
                this.pendingStationsModelSyncRefresh &&
                this.currentTab === 'masters'
            ) {
                requestAnimationFrame(() =>
                    this.refreshVisibleStationsContent()
                );
            } else if (
                kind === 'instance' &&
                this.pendingInstancesModelSyncRefresh &&
                this.currentTab === 'instances'
            ) {
                requestAnimationFrame(() =>
                    this.refreshVisibleInstancesContent()
                );
            }
            return;
        }

        const isStation = kind === 'station';
        this.commitFontPathChange({
            label: isStation ? 'Edit station name' : 'Edit instance name',
            path: [isStation ? 'masters' : 'instances', index, 'name'],
            oldValue: { ...previousValue },
            newValue: { ...normalizedNextValue },
            applyLocal: () =>
                this.applyLocalRecordNameFieldValue(
                    kind,
                    index,
                    normalizedNextValue
                ),
            markDirtyKey: isStation
                ? 'font-info-station-name'
                : 'font-info-instance-name',
            refresh: () =>
                isStation
                    ? this.refreshStationSidebarItemSummary(index)
                    : this.refreshInstanceSidebarItemSummary(index)
        });
    }

    private applyLocalRecordLocationValue(
        kind: 'station' | 'instance',
        index: number,
        axisTag: string,
        nextValue: number | undefined
    ) {
        const font = window.currentFontModel as any;
        const list = kind === 'station' ? font?.stations : font?.instances;
        const record = list?.[index];
        if (!record) {
            return;
        }

        if (nextValue === undefined) {
            if (record.location) {
                delete record.location[axisTag];
                if (Object.keys(record.location).length === 0) {
                    delete record.location;
                }
            }
            return;
        }

        if (!record.location) {
            record.location = {};
        }
        record.location[axisTag] = nextValue;
    }

    private commitRecordLocationValue(
        kind: 'station' | 'instance',
        index: number,
        axisTag: string,
        nextValue: number | undefined
    ) {
        const font = window.currentFontModel as any;
        const list = kind === 'station' ? font?.stations : font?.instances;
        const record = list?.[index];
        if (!record) {
            return;
        }

        const previousValue = record.location?.[axisTag];
        if (previousValue === nextValue) {
            return;
        }

        const isStation = kind === 'station';
        this.commitFontPathChange({
            label: isStation
                ? 'Edit station location'
                : 'Edit instance location',
            path: [
                isStation ? 'masters' : 'instances',
                index,
                'location',
                axisTag
            ],
            oldValue: previousValue,
            newValue: nextValue,
            remove: nextValue === undefined,
            applyLocal: () =>
                this.applyLocalRecordLocationValue(
                    kind,
                    index,
                    axisTag,
                    nextValue
                ),
            markDirtyKey: isStation
                ? 'font-info-station-location'
                : 'font-info-instance-location',
            refresh: () =>
                isStation
                    ? this.refreshStationSidebarItemSummary(index)
                    : this.refreshInstanceSidebarItemSummary(index)
        });
    }

    private commitStationNameFieldValue(
        stationIndex: number,
        nextValue: Babelfont.I18NDictionary
    ) {
        this.commitRecordNameFieldValue('station', stationIndex, nextValue);
    }

    private commitStationLocationValue(
        stationIndex: number,
        axisTag: string,
        nextValue: number | undefined
    ) {
        this.commitRecordLocationValue(
            'station',
            stationIndex,
            axisTag,
            nextValue
        );
    }

    private applyLocalStationMetricValue(
        stationIndex: number,
        metricKey: string,
        nextValue: number
    ) {
        const font = window.currentFontModel as any;
        const station = font?.stations?.[stationIndex];
        if (!station) {
            return;
        }

        if (!station.metrics) {
            station.metrics = {};
        }
        station.metrics[metricKey] = nextValue;
    }

    private commitStationMetricValue(
        stationIndex: number,
        metricKey: string,
        nextValue: number
    ) {
        const font = window.currentFontModel as any;
        const station = font?.stations?.[stationIndex];
        if (!station) {
            return;
        }

        const previousValue = station.metrics?.[metricKey];
        if (previousValue === nextValue) {
            return;
        }

        this.commitFontPathChange({
            label: 'Edit station metric',
            path: ['masters', stationIndex, 'metrics', metricKey],
            oldValue: previousValue,
            newValue: nextValue,
            applyLocal: () =>
                this.applyLocalStationMetricValue(
                    stationIndex,
                    metricKey,
                    nextValue
                ),
            markDirtyKey: 'font-info-station-metric'
        });
    }

    private commitInstanceNameFieldValue(
        instanceIndex: number,
        nextValue: Babelfont.I18NDictionary
    ) {
        this.commitRecordNameFieldValue('instance', instanceIndex, nextValue);
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

    private commitInstanceLocationValue(
        instanceIndex: number,
        axisTag: string,
        nextValue: number | undefined
    ) {
        this.commitRecordLocationValue(
            'instance',
            instanceIndex,
            axisTag,
            nextValue
        );
    }

    private createFontInfoRecordId(_prefix: string): string {
        return generateStableId();
    }

    private getDefaultAxisLocation(): Record<string, number> | undefined {
        const font = window.currentFontModel ?? undefined;
        const locationEntries = (font?.axes ?? [])
            .filter((axis) => axis.default !== undefined)
            .map((axis) => [axis.tag, axis.default as number] as const);

        if (locationEntries.length === 0) {
            return undefined;
        }

        return Object.fromEntries(locationEntries);
    }

    private getDefaultNewStationLocation(): Record<string, number> | undefined {
        const font =
            window.currentFontModel as unknown as BabelfontModelFont | null;
        const axisDefaults = this.getDefaultAxisLocation() ?? {};
        const lastStation = rawArray(font?.stations)[
            rawArray(font?.stations).length - 1
        ];
        const lastLocation = lastStation?.location;
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

    private async promptForNewStationLocation(): Promise<Record<
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

        const defaultLocation = this.getDefaultNewStationLocation() ?? {};

        return await new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className =
                'matplotlib-modal fontinfo-station-location-modal active';
            modal.innerHTML = `
                <div class="matplotlib-modal-content fontinfo-station-location-modal-content">
                    <div class="matplotlib-modal-header">
                        <h3>New Station Location</h3>
                        <button type="button" class="matplotlib-modal-close" aria-label="Close">×</button>
                    </div>
                    <div class="matplotlib-modal-body fontinfo-station-location-modal-body">
                        <div class="fontinfo-station-location-description">
                            Adjust the designspace location for the new station before creating it.
                        </div>
                        <div class="fontinfo-station-location-rows"></div>
                        <div class="fontinfo-station-location-actions">
                            <button type="button" class="dialog-button fontinfo-station-location-cancel">Cancel</button>
                            <button type="button" class="dialog-button dialog-button-primary fontinfo-station-location-create">Create</button>
                        </div>
                    </div>
                </div>
            `;

            const rows = modal.querySelector(
                '.fontinfo-station-location-rows'
            ) as HTMLElement;
            const closeButton = modal.querySelector(
                '.matplotlib-modal-close'
            ) as HTMLButtonElement;
            const cancelButton = modal.querySelector(
                '.fontinfo-station-location-cancel'
            ) as HTMLButtonElement;
            const createButton = modal.querySelector(
                '.fontinfo-station-location-create'
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
                row.className = 'fontinfo-station-location-row';

                const label = document.createElement('label');
                label.className = 'fontinfo-station-location-label';
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
                input.dataset.stationLocationAxis = axis.tag as string;
                input.className =
                    'localized-string-input localized-string-modal-input fontinfo-station-location-input';
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
        const font = window.currentFontModel ?? undefined;
        const nextIndex = (font?.instances?.length ?? 0) + 1;

        return {
            id: this.createFontInfoRecordId('instance'),
            name: { dflt: `Instance ${nextIndex}` },
            location: this.getDefaultAxisLocation(),
            custom_names: {},
            variable: false
        };
    }

    private applyLocalStationsList(nextStations: Babelfont.Master[]) {
        const font = window.currentFontModel as any;
        if (!font) {
            return;
        }

        font.stations = nextStations;
    }

    private commitStationsListChange(
        label: string,
        nextStations: Babelfont.Master[]
    ) {
        const font = window.currentFontModel ?? undefined;
        if (!font) {
            return;
        }

        const previousStations = plainRecords<Babelfont.Master>(
            font.stations
        ).map(cloneStationRecord);
        const clonedNextStations =
            rawArray(nextStations).map(cloneStationRecord);

        this.commitFontPathChange({
            label,
            path: ['masters'],
            oldValue:
                previousStations.length > 0 ? previousStations : undefined,
            newValue: clonedNextStations,
            applyLocal: () => this.applyLocalStationsList(clonedNextStations),
            markDirtyKey: 'font-info-stations-list',
            refresh: () => {
                this.forceRefreshVisibleStationsContent();
                void (
                    window.glyphCanvas as
                        | {
                              updatePropertiesUI?: (options?: {
                                  skipAutoSelectMatchingDrawing?: boolean;
                              }) => Promise<void>;
                          }
                        | undefined
                )?.updatePropertiesUI?.({
                    skipAutoSelectMatchingDrawing: true
                });
            }
        });
    }

    /**
     * Re-interpolates all glyph drawings that are bound to the given station ID.
     * Delegates to OutlineEditor.reinterpolateAllDrawingsForStation which fires
     * all interpolation requests concurrently (O(1) worker latency instead of
     * O(N)) and applies all results in a single synchronous pass.
     *
     */
    private async reinterpolateDrawingsForStation(
        stationId: string
    ): Promise<void> {
        const font =
            window.currentFontModel as unknown as BabelfontModelFont | null;
        const modelStation = font?.findStation(stationId);
        if (!modelStation) {
            return;
        }

        await modelStation.reinterpolateDrawings();
    }

    private stationTopologyGateSignature(gate: StationTopologyGate): string {
        return gate.allowed
            ? 'allowed'
            : `${gate.canReopenWithAllGlyphs === true}:${gate.reason || ''}`;
    }

    private getStationTopologyGate(): StationTopologyGate {
        const font = window.currentFontModel as
            | { getStationTopologyGate?: () => StationTopologyGate }
            | null
            | undefined;
        return font?.getStationTopologyGate?.() ?? { allowed: true };
    }

    private createStationTopologyBlockedNotice(
        reason: string,
        canReopenWithAllGlyphs: boolean
    ): HTMLElement {
        const notice = document.createElement('div');
        notice.className = 'fontinfo-stations-blocked-notice';
        notice.setAttribute('data-fontinfo-stations-blocked', 'true');

        const text = document.createElement('div');
        text.className = 'localized-string-helper';
        text.textContent = reason;
        notice.appendChild(text);

        if (canReopenWithAllGlyphs) {
            const reopen = document.createElement('button');
            reopen.type = 'button';
            reopen.className = 'dialog-button';
            reopen.setAttribute(
                'data-fontinfo-list-action',
                'stations-reopen-all-glyphs'
            );
            reopen.textContent = 'Reopen with all glyphs';
            reopen.addEventListener('click', async () => {
                reopen.disabled = true;
                try {
                    await window.cloudPlugin?.reopenWithAllGlyphs?.();
                } catch (error) {
                    console.error('Reopen with all glyphs failed:', error);
                    text.textContent =
                        error instanceof Error ? error.message : String(error);
                    reopen.disabled = false;
                }
            });
            notice.appendChild(reopen);
        }

        return notice;
    }

    private async addStationRecord() {
        const font =
            window.currentFontModel as unknown as BabelfontModelFont | null;
        if (!font || typeof font.addStation !== 'function') {
            return;
        }

        const requestedLocation = await this.promptForNewStationLocation();
        if (requestedLocation === null) {
            return;
        }

        try {
            const metricTemplateStationId = rawArray(font.stations)[
                this.selectedStationIndex
            ]?.id;
            const createdStation = await font.addStation(undefined, {
                location:
                    Object.keys(requestedLocation).length > 0
                        ? requestedLocation
                        : undefined,
                metricTemplateStationId
            });
            const selectedStationIndex = createdStation
                ? rawArray(font.stations).findIndex(
                      (station) => station.id === createdStation.id
                  )
                : rawArray(font.stations).length - 1;
            this.selectedStationIndex = Math.max(0, selectedStationIndex);
            this.selectedStationIndices = new Set([this.selectedStationIndex]);
            this.forceRefreshVisibleStationsContent();
        } catch (err) {
            // A refused station edit changed nothing; show why.
            reportRefusedEdit(err);
        }
    }

    private removeSelectedStationRecord() {
        const font =
            window.currentFontModel as unknown as BabelfontModelFont | null;
        const stations = font?.stations ?? [];
        if (stations.length === 0) {
            return;
        }

        const indicesToRemove = new Set(
            [...this.selectedStationIndices].filter((i) => i < stations.length)
        );
        if (indicesToRemove.size === 0) {
            return;
        }

        const stationNames = [...indicesToRemove]
            .sort((a, b) => a - b)
            .map((i) => {
                const m = stations[i];
                const n = m?.name;
                if (typeof n === 'string') return n;
                if (n && typeof n === 'object' && 'dflt' in n)
                    return (n as { dflt: string }).dflt;
                return `Station ${i + 1}`;
            })
            .join(', ');
        const count = indicesToRemove.size;
        const message =
            count === 1
                ? `Delete station “${stationNames}”? This will also remove its drawings from all glyphs.`
                : `Delete ${count} stations (${stationNames})? This will also remove their drawings from all glyphs.`;

        this.showDeleteConfirmDialog(message, async (confirmed) => {
            if (!confirmed) {
                return;
            }

            const stationIds = [...indicesToRemove]
                .map((i) => (stations[i] as any)?.id as string | undefined)
                .filter((id): id is string => typeof id === 'string');
            const nextStationCount = Math.max(
                0,
                stations.length - indicesToRemove.size
            );

            // New primary selection: the first remaining index, worked out
            // before the removal changes the station list.
            const firstRemaining = [...Array(stations.length).keys()].find(
                (i) => !indicesToRemove.has(i)
            );

            if (typeof font?.removeStationsByIds !== 'function') {
                return;
            }

            try {
                await font.removeStationsByIds(stationIds);
            } catch (error) {
                // A refused removal changed nothing, so the selection stays
                // where it was; show why.
                reportRefusedEdit(error);
                this.forceRefreshVisibleStationsContent();
                return;
            }

            this.selectedStationIndex =
                firstRemaining !== undefined
                    ? firstRemaining
                    : Math.max(0, nextStationCount - 1);
            this.selectedStationIndices =
                nextStationCount > 0
                    ? new Set([this.selectedStationIndex])
                    : new Set();

            this.forceRefreshVisibleStationsContent();
        });
    }

    private reorderStationsList(fromIndex: number, insertionIndex: number) {
        const font = window.currentFontModel ?? undefined;
        const stations = plainRecords<Babelfont.Master>(font?.stations).map(
            cloneStationRecord
        );
        if (
            fromIndex < 0 ||
            fromIndex >= stations.length ||
            insertionIndex < 0 ||
            insertionIndex > stations.length
        ) {
            return;
        }

        const [movedStation] = stations.splice(fromIndex, 1);
        if (!movedStation) {
            return;
        }

        const adjustedTargetIndex =
            fromIndex < insertionIndex ? insertionIndex - 1 : insertionIndex;
        if (adjustedTargetIndex === fromIndex) {
            return;
        }

        stations.splice(adjustedTargetIndex, 0, movedStation);
        this.selectedStationIndex = adjustedTargetIndex;
        this.commitStationsListChange('Reorder stations', stations);
    }

    private onStationDragStart(event: DragEvent, index: number) {
        this.draggedStationIndex = index;
        this.stationDragCommitted = false;
        this.clearStationDropIndicator();
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

    private onStationDragOver(event: DragEvent, targetIndex: number) {
        event.preventDefault();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'move';
        }
        if (this.draggedStationIndex === null) {
            return;
        }

        const target = event.currentTarget as HTMLElement | null;
        if (!target) {
            return;
        }

        const rect = target.getBoundingClientRect();
        const placement: RecordDropPlacement =
            event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
        this.setStationDropIndicator(targetIndex, placement);
    }

    private onStationDrop(event: DragEvent, targetIndex: number) {
        event.preventDefault();
        const insertionIndex = this.getStationDropInsertionIndex(targetIndex);
        this.clearStationDropIndicator();

        if (this.draggedStationIndex === null || insertionIndex === null) {
            return;
        }

        const originalIndex = this.draggedStationIndex;
        this.stationDragCommitted = true;
        this.draggedStationIndex = null;
        this.reorderStationsList(originalIndex, insertionIndex);
    }

    private onStationDragEnd() {
        const originalIndex = this.draggedStationIndex;
        const insertionIndex =
            originalIndex !== null && this.stationDropTargetIndex !== null
                ? this.getStationDropInsertionIndex(this.stationDropTargetIndex)
                : null;
        const shouldCommitFallback =
            !this.stationDragCommitted &&
            originalIndex !== null &&
            insertionIndex !== null;

        this.clearStationDropIndicator();
        this.draggedStationIndex = null;
        this.stationDragCommitted = false;
        this.stationsFieldsContainer
            ?.querySelectorAll('.fontinfo-record-item')
            .forEach((item) => item.classList.remove('dragging'));

        if (shouldCommitFallback) {
            this.reorderStationsList(originalIndex, insertionIndex);
        } else {
            requestAnimationFrame(() =>
                this.forceRefreshVisibleStationsContent()
            );
        }
    }

    private setStationDropIndicator(
        targetIndex: number,
        placement: RecordDropPlacement
    ) {
        if (
            this.stationDropTargetIndex === targetIndex &&
            this.stationDropTargetPlacement === placement
        ) {
            return;
        }

        this.clearStationDropIndicator();
        const target = this.getStationListItems()[targetIndex];
        if (!target) {
            return;
        }

        target.classList.add(
            placement === 'before'
                ? 'feature-drop-target-before'
                : 'feature-drop-target-after'
        );
        this.stationDropTargetIndex = targetIndex;
        this.stationDropTargetPlacement = placement;
    }

    private clearStationDropIndicator() {
        if (this.stationDropTargetIndex !== null) {
            const previousTarget =
                this.getStationListItems()[this.stationDropTargetIndex];
            previousTarget?.classList.remove(
                'feature-drop-target-before',
                'feature-drop-target-after'
            );
        }

        this.stationDropTargetIndex = null;
        this.stationDropTargetPlacement = null;
    }

    private getStationDropInsertionIndex(
        fallbackTargetIndex: number
    ): number | null {
        if (this.draggedStationIndex === null) {
            return null;
        }

        const targetIndex = this.stationDropTargetIndex ?? fallbackTargetIndex;
        const placement = this.stationDropTargetPlacement ?? 'before';
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
        const font = window.currentFontModel ?? undefined;
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
        const font = window.currentFontModel ?? undefined;
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
        const font = window.currentFontModel ?? undefined;
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
        const font = window.currentFontModel ?? undefined;
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

    private applyLocalAxesList(nextAxes: Babelfont.Axis[]) {
        const font = window.currentFontModel as any;
        if (!font) {
            return;
        }

        font.axes = nextAxes;
    }

    private commitAxesListChange(label: string, nextAxes: Babelfont.Axis[]) {
        const font = window.currentFontModel ?? undefined;
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

    private async addAxisRecord() {
        const font = window.currentFontModel;
        if (!font) {
            return;
        }

        const gate = this.getStationTopologyGate();
        const result = await openAddAxisDialog({
            font: this.buildAxisDialogFont(font),
            blockedNotice: gate.allowed
                ? null
                : this.createStationTopologyBlockedNotice(
                      gate.reason ||
                          'Stations cannot be added to this font right now.',
                      gate.canReopenWithAllGlyphs === true
                  )
        });
        if (result.kind === 'cancel') {
            return;
        }

        const axisCount = rawArray(font.axes).length;
        if (result.kind === 'axis-only') {
            this.commitNewAxis(
                result.model.axisRecord(false),
                result.model.existingAt
            );
            return;
        }

        const { plan, stationCount } = result.model.buildPlan(
            plainRecords<Babelfont.Axis>(font.axes),
            plainRecords<Babelfont.Master>(font.stations),
            plainRecords<Babelfont.Instance>(font.instances),
            () => this.createFontInfoRecordId('master')
        );
        try {
            await font.addAxisWithStationCopies(
                plan,
                `Add ${result.model.name.trim()} axis with ${stationCount} station${stationCount === 1 ? '' : 's'}`
            );
        } catch (error) {
            // A refused edit added neither the axis nor the stations.
            reportRefusedEdit(error);
            return;
        }
        this.selectedAxisIndex = axisCount;
        this.selectedAxisIndices = new Set([axisCount]);
        this.forceRefreshVisibleAxesContent();
        this.forceRefreshVisibleStationsContent();
        void window.glyphCanvas?.axesManager?.updateAxesUI?.();
    }

    /** What the Add axis dialog needs to know about the open font. */
    private buildAxisDialogFont(font: BabelfontModelFont): AxisDialogFont {
        const axes = plainRecords<Babelfont.Axis>(font.axes);
        const stations = plainRecords<Babelfont.Master>(font.stations).map(
            (station) => ({
                id: station.id,
                name:
                    (typeof station.name === 'string'
                        ? station.name
                        : station.name?.dflt) || 'Station',
                location: Object.fromEntries(
                    Object.entries(station.location ?? {}).map(
                        ([tag, value]) => [tag, Number(value)]
                    )
                )
            })
        );
        const defaultStation = findDefaultStation(axes, stations);

        let braceGlyphCount = 0;
        let freeDrawingCount = 0;
        const glyphs = font.glyphs ?? [];
        for (const glyph of glyphs) {
            const braces = (glyph.drawings ?? []).filter(
                (drawing) =>
                    !drawing.is_background &&
                    Object.keys(drawing.location ?? {}).length > 0
            ).length;
            if (braces) {
                braceGlyphCount += 1;
                freeDrawingCount += braces;
            }
        }

        return {
            axes: axes.map((axis) => ({
                tag: axis.tag,
                name:
                    (typeof axis.name === 'string'
                        ? axis.name
                        : axis.name?.dflt) || axis.tag
            })),
            masters: stations,
            defaultStationId: defaultStation?.id ?? '',
            glyphCount: glyphs.length,
            braceGlyphCount,
            freeDrawingCount,
            instanceCount: rawArray(font.instances).length
        };
    }

    /** Adds an axis on its own; stations and instances sit at `designspaceValue` on it. */
    private commitNewAxis(newAxis: Babelfont.Axis, designspaceValue: number) {
        const font = window.currentFontModel ?? undefined;
        if (!font) {
            return;
        }

        const nextAxes = [...rawArray(font.axes).map(cloneAxisRecord), newAxis];
        this.selectedAxisIndex = nextAxes.length - 1;
        this.selectedAxisIndices = new Set([this.selectedAxisIndex]);

        const previousAxes = rawArray(font.axes).map(cloneAxisRecord);
        const clonedNextAxes = rawArray(nextAxes).map(cloneAxisRecord);
        const tag = newAxis.tag;

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

        (font.stations ?? []).forEach((station, index) => {
            const prevLoc = {
                ...((station.location as Record<string, number> | undefined) ??
                    {})
            };
            changes.push({
                path: ['masters', index, 'location'],
                oldValue: Object.keys(prevLoc).length > 0 ? prevLoc : undefined,
                newValue: { ...prevLoc, [tag]: designspaceValue }
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
                newValue: { ...prevLoc, [tag]: designspaceValue }
            });
        });

        this.commitMultipleFontPathChanges({
            label: `Add ${typeof newAxis.name === 'string' ? newAxis.name : newAxis.name?.dflt || tag} axis`,
            changes,
            applyLocal: () => {
                this.applyLocalAxesList(clonedNextAxes);
                (window.currentFontModel as any)?.stations?.forEach(
                    (station: any) => {
                        station.location = {
                            ...(station.location ?? {}),
                            [tag]: designspaceValue
                        };
                    }
                );
                (window.currentFontModel as any)?.instances?.forEach(
                    (instance: any) => {
                        instance.location = {
                            ...(instance.location ?? {}),
                            [tag]: designspaceValue
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
        const font = window.currentFontModel ?? undefined;
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
                (font?.stations ?? []).forEach((station, index) => {
                    const loc = station.location as
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
                        (window.currentFontModel as any)?.stations?.forEach(
                            (station: any) => {
                                if (station.location) {
                                    delete station.location[tag];
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
        const font = window.currentFontModel ?? undefined;
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
        const font = window.currentFontModel ?? undefined;
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
                const liveAxis = (window.currentFontModel ?? undefined)?.axes?.[
                    axisIndex
                ] as any;
                if (liveAxis) {
                    liveAxis.name = normalizedNextValue;
                }
            },
            markDirtyKey: 'font-info-axis-name',
            refresh: () => this.refreshAxisSidebarItemSummary(axisIndex)
        });
    }

    private commitAxisTagFieldValue(axisIndex: number, nextValue: string) {
        const font = window.currentFontModel ?? undefined;
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
                const liveAxis = (window.currentFontModel ?? undefined)?.axes?.[
                    axisIndex
                ] as any;
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
        const font = window.currentFontModel ?? undefined;
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
                const liveAxis = (window.currentFontModel ?? undefined)?.axes?.[
                    axisIndex
                ] as any;
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
        const font = window.currentFontModel ?? undefined;
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
                const liveAxis = (window.currentFontModel ?? undefined)?.axes?.[
                    axisIndex
                ] as any;
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
        const font = window.currentFontModel ?? undefined;
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
        const font = window.currentFontModel ?? undefined;
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
                const liveAxis = (window.currentFontModel ?? undefined)?.axes?.[
                    axisIndex
                ] as any;
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
        const font = window.currentFontModel ?? undefined;
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
        const font = window.currentFontModel ?? undefined;
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
        if (this.pendingGeneratedFeatureReveal) {
            this.pendingGeneratedFeatureReveal = false;
            if (this.pluginSettingsOpenId) {
                this.revealGeneratedFeature();
            }
        }

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

    private syncManageFeaturesCheckbox() {
        const box = this.featuresTab?.querySelector(
            '#feature-manage-checkbox'
        ) as HTMLInputElement | null;
        if (box) {
            box.checked =
                !!window.currentFontModel?.counterpunchManagesFeatures;
        }
    }

    private async onManageFeaturesChanged(box: HTMLInputElement) {
        const font = window.currentFontModel;
        if (!font) {
            return;
        }
        if (!box.checked) {
            window.patchSyncEngine?.beginTransaction(
                'Stop managing automatic features',
                null,
                { compileChangeSource: 'feature-code', compileEditType: null }
            );
            try {
                font.setCounterpunchManagesFeatures(false);
            } finally {
                window.patchSyncEngine?.endTransaction();
            }
        } else if (
            (await confirmAutomaticFeaturesTakeover()) &&
            enableAutomaticFeatures('Manage automatic features')
        ) {
            window.dispatchEvent(new CustomEvent('generatedFeaturesChanged'));
        }
        this.syncManageFeaturesCheckbox();
        this.loadAllLists();
    }

    private loadAllLists() {
        console.log('[FontInfo] loadAllLists called');
        this.syncManageFeaturesCheckbox();
        this.loadPrefixesList();
        this.loadClassesList();
        this.loadFeaturesList();
    }

    private loadPrefixesList() {
        const listContainer = document.getElementById('prefixes-list');
        console.log('[FontInfo] loadPrefixesList - container:', listContainer);
        if (!listContainer) return;

        const font = window.currentFontModel;
        const previousPrefixKeys = [...this.prefixListItems.keys()];
        if (!font || !font.features || !font.features.prefixes) {
            listContainer.innerHTML =
                '<div class="features-empty">No prefixes</div>';
            this.prefixListItems.clear();
            this.settleRemovedKeyedSelection('prefix', previousPrefixKeys, []);
            return;
        }

        const prefixes = font.features.prefixes;
        const prefixKeys = Object.keys(prefixes);
        console.log('[FontInfo] Found', prefixKeys.length, 'prefixes');

        if (prefixKeys.length === 0) {
            listContainer.innerHTML =
                '<div class="features-empty">No prefixes</div>';
            this.prefixListItems.clear();
            this.settleRemovedKeyedSelection('prefix', previousPrefixKeys, []);
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
        this.settleRemovedKeyedSelection(
            'prefix',
            previousPrefixKeys,
            prefixKeys
        );
    }

    private parseClassGlyphMembers(classCode: string): Set<string> {
        return parseFeatureClassGlyphMembers(classCode);
    }

    private getAllGlyphsInClass(
        className: string,
        visited: Set<string> = new Set()
    ): Set<string> {
        return resolveFeatureClassGlyphs(
            className,
            this.classGlyphMembers,
            visited
        );
    }

    private loadClassesList() {
        const listContainer = document.getElementById('classes-list');
        if (!listContainer) return;

        const font = window.currentFontModel;
        const previousClassKeys = [...this.classListItems.keys()];
        if (!font || !font.features || !font.features.classes) {
            listContainer.innerHTML =
                '<div class="features-empty">No classes</div>';
            this.classListItems.clear();
            this.settleRemovedKeyedSelection('class', previousClassKeys, []);
            return;
        }

        const classes = font.features.classes;
        const classKeys = Object.keys(classes);

        if (classKeys.length === 0) {
            listContainer.innerHTML =
                '<div class="features-empty">No classes</div>';
            this.classListItems.clear();
            this.settleRemovedKeyedSelection('class', previousClassKeys, []);
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
        this.settleRemovedKeyedSelection('class', previousClassKeys, classKeys);
    }

    private extractLanguageSystems(): string[] {
        return extractFontLanguageSystems(window.currentFontModel?.features);
    }

    private loadPluginSettingsList(): void {
        const list = document.getElementById('plugin-settings-list');
        if (!list) {
            return;
        }
        list.replaceChildren();
        const plugins = [
            ...pluginSettingsRegistry.pluginsForTarget('font-info.features'),
            ...pluginSettingsRegistry.pluginsForTarget('font-info.skills')
        ];
        const heading = document.getElementById('plugin-settings-heading');
        const visible = plugins.length > 0;
        list.hidden = !visible;
        if (heading) {
            heading.hidden = !visible;
        }
        if (!visible) {
            if (this.pluginSettingsOpenId) {
                this.closePluginSettingsForm();
            }
            return;
        }
        for (const plugin of plugins) {
            const item = document.createElement('div');
            item.className = 'feature-list-item sidebar-item';
            item.dataset.pluginId = plugin.pluginId;
            const name = document.createElement('span');
            name.className = 'feature-name';
            name.textContent = plugin.title;
            item.appendChild(name);
            item.addEventListener('click', () =>
                this.showPluginSettings(plugin.pluginId)
            );
            list.appendChild(item);
        }
    }

    private closePluginSettingsForm(): void {
        const form = document.getElementById('plugin-settings-form');
        const editor = document.getElementById('features-editor');
        const legend = document.querySelector(
            '#fontinfo-features-content .glyph-filter-legend'
        ) as HTMLElement | null;
        if (form) form.classList.remove('is-open');
        document
            .querySelectorAll(
                '#plugin-settings-list .feature-list-item.selected'
            )
            .forEach((item) => item.classList.remove('selected'));
        if (editor) editor.style.display = '';
        if (legend) legend.style.display = '';
        this.pluginSettingsOpenId = null;
    }

    private revealGeneratedFeature(): void {
        const features = window.currentFontModel?.features?.features || [];
        const selectedIndex =
            this.selectedItem?.type === 'feature' &&
            typeof this.selectedItem.key === 'number'
                ? this.selectedItem.key
                : -1;
        const generatedIndex = features.findIndex(([, code]) => {
            const stamp = (
                code?.format_specific as
                    { 'com.counterpunch.generator'?: unknown } | undefined
            )?.['com.counterpunch.generator'];
            return !!stamp && code?.automatic !== false;
        });
        const index = selectedIndex >= 0 ? selectedIndex : generatedIndex;
        this.closePluginSettingsForm();
        if (index >= 0) {
            this.selectItem('feature', index);
        }
    }

    private showPluginSettings(pluginId: string): void {
        const editor = document.getElementById('features-editor');
        const form = document.getElementById('plugin-settings-form');
        const legend = document.querySelector(
            '#fontinfo-features-content .glyph-filter-legend'
        ) as HTMLElement | null;
        if (editor) editor.style.display = 'none';
        if (legend) legend.style.display = 'none';
        if (!form) return;
        this.pluginSettingsOpenId = pluginId;
        form.classList.add('is-open');
        document
            .querySelectorAll('#plugin-settings-list .feature-list-item')
            .forEach((item) => {
                item.classList.toggle(
                    'selected',
                    (item as HTMLElement).dataset.pluginId === pluginId
                );
            });
        document
            .querySelectorAll(
                '#prefixes-list .feature-list-item.selected, #classes-list .feature-list-item.selected, #features-list .feature-list-item.selected'
            )
            .forEach((item) => item.classList.remove('selected'));
        pluginSettingsRegistry.render(form, pluginId, () =>
            this.showPluginSettings(pluginId)
        );
    }

    private loadFeaturesList(options?: {
        preserveFeatureEditorDraft?: boolean;
    }) {
        this.loadPluginSettingsList();
        const listContainer = document.getElementById('features-list');
        console.log('[FontInfo] loadFeaturesList - container:', listContainer);
        if (!listContainer) return;

        this.clearFeatureDropIndicator();

        const font = window.currentFontModel;
        if (!font || !font.features) {
            listContainer.innerHTML =
                '<div class="features-empty">No features</div>';
            this.featureListItems.clear();
            this.settleFeatureEditorSelection([], options);
            return;
        }

        const features = font.features.features || [];
        console.log('[FontInfo] Found', features.length, 'features');

        if (features.length === 0) {
            listContainer.innerHTML =
                '<div class="features-empty">No features</div>';
            this.featureListItems.clear();
            this.settleFeatureEditorSelection([], options);
            return;
        }

        // Detect supported scripts and create dropdown
        const supportedScripts = this.extractLanguageSystems();
        console.log('[FontInfo] Supported scripts:', supportedScripts);

        // Map scripts to shapers and deduplicate
        const shaperMap = groupScriptsByShaper(supportedScripts);

        // Get unique shapers sorted alphabetically
        const availableShapers = Array.from(shaperMap.keys());

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
            label.textContent = 'Shaper';

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
        const categorized = categorizeFeaturesForShaper(
            features,
            executionOrder
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
        // A feature that disappeared is replaced by a neighbor, or the editor
        // is cleared when the list is empty.
        this.settleFeatureEditorSelection(features, options);

        // Restore scroll position if was at bottom
        if (wasAtBottom && sidebar) {
            sidebar.scrollTop = sidebar.scrollHeight;
        }
    }

    private settleFeatureEditorSelection(
        features: Array<[string, Babelfont.PossiblyAutomaticCode]>,
        options?: { preserveFeatureEditorDraft?: boolean }
    ): void {
        if (this.selectedItem?.type !== 'feature') {
            if (
                !options?.preserveFeatureEditorDraft &&
                !this.selectedItem &&
                features.length > 0
            ) {
                this.selectItem('feature', 0);
            }
            return;
        }

        const matchingFeatureIndex = this.selectedFeatureTag
            ? features.findIndex(([tag]) => tag === this.selectedFeatureTag)
            : -1;
        if (matchingFeatureIndex >= 0) {
            if (options?.preserveFeatureEditorDraft) {
                this.selectedItem = {
                    type: 'feature',
                    key: matchingFeatureIndex
                };
                this.featureListItems
                    .get(matchingFeatureIndex)
                    ?.classList.add('selected');
                this.notifyHistoryScopeChange();
                return;
            }
            this.selectItem('feature', matchingFeatureIndex);
            return;
        }

        if (features.length === 0) {
            this.clearEditor();
            return;
        }

        const previousIndex =
            typeof this.selectedItem.key === 'number'
                ? this.selectedItem.key
                : 0;
        const nextIndex = Math.min(
            Math.max(previousIndex, 0),
            features.length - 1
        );
        this.selectItem('feature', nextIndex);
    }

    private settleRemovedKeyedSelection(
        type: 'prefix' | 'class',
        previousKeys: string[],
        nextKeys: string[]
    ): void {
        if (this.selectedItem?.type !== type) {
            return;
        }
        const key = String(this.selectedItem.key);
        if (nextKeys.includes(key)) {
            const items =
                type === 'prefix' ? this.prefixListItems : this.classListItems;
            items.get(key)?.classList.add('selected');
            return;
        }
        if (nextKeys.length === 0) {
            this.clearEditor();
            return;
        }
        const previousIndex = previousKeys.indexOf(key);
        const nextIndex = Math.min(
            previousIndex < 0 ? 0 : previousIndex,
            nextKeys.length - 1
        );
        this.selectItem(type, nextKeys[nextIndex]);
    }

    private selectedGeneratorStamp() {
        const font = window.currentFontModel;
        const selected = this.selectedItem;
        if (!font?.features || selected?.type !== 'feature') {
            return null;
        }
        if (typeof selected.key !== 'number') {
            return null;
        }
        const code = font.features.features?.[selected.key]?.[1];
        if (!code?.automatic) {
            return null;
        }
        return generatorStamp(code);
    }

    private updateFeatureSourceHeader(
        codeData?: Babelfont.PossiblyAutomaticCode
    ) {
        const summary = document.getElementById('feature-source-summary');
        const regenerate = document.getElementById('feature-regenerate-button');
        const stamp =
            codeData?.automatic === true ? generatorStamp(codeData) : null;
        const described = stamp
            ? pluginSettingsRegistry.describe(stamp.generator)
            : null;
        const visible = Boolean(stamp);
        if (summary) {
            summary.hidden = !visible;
            summary.textContent = stamp
                ? featureSourceHeaderText(stamp, described?.summary)
                : '';
        }
        if (regenerate) {
            regenerate.hidden = !visible;
        }
        if (this.featureSourcePopup?.state.isVisible) {
            this.featureSourcePopup.setContent(this.featureSourcePopupHtml());
        }
    }

    private featureSourcePopupHtml(): string {
        const stamp = this.selectedGeneratorStamp();
        const described = stamp
            ? pluginSettingsRegistry.describe(stamp.generator)
            : null;
        if (!stamp || !described) {
            return '';
        }
        const settings = described.settings
            .map(
                (setting) => `
                <section class="feature-source-setting">
                    <div class="feature-source-setting-label">${escapeFeatureHtml(setting.label)}</div>
                    <div class="feature-source-setting-value">${escapeFeatureHtml(setting.value)}</div>
                    ${
                        setting.help
                            ? `<p class="feature-source-setting-help">${escapeFeatureHtml(setting.help)}</p>`
                            : ''
                    }
                </section>`
            )
            .join('');
        return `
            <div class="feature-source-popup">
                <div class="feature-source-popup-title">${escapeFeatureHtml(described.title)}</div>
                <div class="feature-source-popup-id">${escapeFeatureHtml([described.pluginId, stamp.capability, described.version].filter(Boolean).join(' · '))}</div>
                ${settings}
            </div>`;
    }

    private initFeatureSourcePopup() {
        const summary = document.getElementById('feature-source-summary');
        if (!summary || this.featureSourcePopup) {
            return;
        }
        const tippyResult = tippy(summary, {
            content: '',
            allowHTML: true,
            interactive: true,
            trigger: 'click',
            theme: getTheme(),
            placement: 'bottom-start',
            arrow: false,
            offset: [0, 6],
            maxWidth: 360,
            appendTo: document.body,
            zIndex: 9999,
            onShow: (instance) => {
                const html = this.featureSourcePopupHtml();
                if (!html) {
                    return false;
                }
                instance.setContent(html);
            }
        });
        this.featureSourcePopup = Array.isArray(tippyResult)
            ? (tippyResult[0] ?? null)
            : tippyResult;
    }

    private initFeatureContextMenu() {
        const sidebar = this.featuresTab?.querySelector(
            '.features-sidebar'
        ) as HTMLElement | null;
        if (!sidebar || this.featureContextMenu) {
            return;
        }
        const backdrop = getOrCreateBackdrop('feature-context-menu-backdrop');
        const tippyResult = tippy(sidebar, {
            content: '',
            allowHTML: true,
            trigger: 'manual',
            interactive: true,
            placement: 'right-start',
            theme: getTheme(),
            arrow: false,
            offset: [0, 0],
            appendTo: document.body,
            hideOnClick: false,
            zIndex: 9999,
            getReferenceClientRect: null as unknown as () => DOMRect,
            onShown: (instance) => {
                const menu = instance.popper.querySelector('.plugin-menu');
                if (!menu) {
                    return;
                }
                setupMenuKeyboardNav(menu);
                if (
                    (menu as HTMLElement & { _handlersSetup?: boolean })
                        ._handlersSetup
                ) {
                    return;
                }
                (
                    menu as HTMLElement & { _handlersSetup?: boolean }
                )._handlersSetup = true;
                menu.addEventListener('click', (event) => {
                    const action = (event.target as HTMLElement | null)
                        ?.closest('.plugin-menu-item')
                        ?.getAttribute('data-action');
                    const target = this.featureContextTarget;
                    if (!action || !target) {
                        return;
                    }
                    instance.hide();
                    this.runFeatureContextAction(
                        action,
                        target.type,
                        target.key
                    );
                });
            }
        });
        this.featureContextMenu = Array.isArray(tippyResult)
            ? (tippyResult[0] ?? null)
            : tippyResult;
        if (this.featureContextMenu) {
            addTippyBackdropSupport(this.featureContextMenu, backdrop, {
                targetElement: sidebar
            });
        }
        sidebar.addEventListener('contextmenu', (event) => {
            const row = (event.target as HTMLElement | null)?.closest(
                '.feature-list-item[data-item-type]'
            ) as HTMLElement | null;
            if (!row || !this.featureContextMenu) {
                return;
            }
            const type = row.dataset.itemType as FeatureItemType;
            const key =
                type === 'feature'
                    ? Number(row.dataset.itemKey)
                    : String(row.dataset.itemKey);
            const html = this.featureContextMenuHtml(type, key);
            if (!html) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            this.featureContextTarget = { type, key };
            this.featureContextMenu.setContent(html);
            this.featureContextMenu.setProps({
                getReferenceClientRect: () =>
                    ({
                        width: 0,
                        height: 0,
                        top: event.clientY,
                        bottom: event.clientY,
                        left: event.clientX,
                        right: event.clientX,
                        x: event.clientX,
                        y: event.clientY,
                        toJSON: () => ({})
                    }) as DOMRect
            });
            this.featureContextMenu.show();
        });
    }

    private featureContextMenuHtml(
        type: FeatureItemType,
        key: string | number
    ): string {
        const codeData = this.codeDataFor(type, key);
        if (!codeData) {
            return '';
        }
        const row = (action: string, icon: string, label: string) => `
            <div class="plugin-menu-item" data-action="${action}" role="menuitem">
                <span class="material-symbols-outlined">${icon}</span>
                <span>${label}</span>
            </div>`;
        const rows = [
            row('rename', 'edit', 'Rename…'),
            row('duplicate', 'content_copy', 'Duplicate'),
            row('delete', 'delete', 'Delete…')
        ];
        const stamp = generatorStamp(codeData);
        if (stamp && codeData.automatic) {
            rows.push(row('regenerate', 'refresh', 'Regenerate'));
        }
        if (!stamp && !codeData.automatic) {
            rows.push(
                row(
                    'mark-automatic',
                    'sync_disabled',
                    'Mark as automatic for Glyphs'
                )
            );
        }
        return `<div class="plugin-menu" tabindex="0" role="menu" aria-label="${FEATURE_ITEM_NOUN[type]}">${rows.join('')}</div>`;
    }

    private runFeatureContextAction(
        action: string,
        type: FeatureItemType,
        key: string | number
    ): void {
        if (action === 'rename') {
            this.startRenameItem(type, key);
        } else if (action === 'duplicate') {
            this.duplicateFeatureItem(type, key);
        } else if (action === 'delete') {
            void this.deleteFeatureItem(type, key);
        } else if (action === 'regenerate') {
            const stamp = generatorStamp(this.codeDataFor(type, key));
            if (stamp) {
                featureGeneratorEngine.regenerate(stamp.generator);
            }
        } else if (action === 'mark-automatic') {
            this.closePluginSettingsForm();
            this.selectItem(type, key);
            this.setSelectedAutomatic(true, 'Mark as automatic for Glyphs');
        }
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
        item.dataset.itemType = type;
        item.dataset.itemKey = String(key);

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

        // Three columns line every row up: the GSUB/GPOS dots (empty for
        // classes), the name, and the status icons.
        const lead = document.createElement('div');
        lead.className = 'feature-item-lead';
        const main = document.createElement('div');
        main.className = 'feature-item-main';
        const icons = document.createElement('div');
        icons.className = 'feature-item-icons';
        item.append(lead, main, icons);

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

            lead.appendChild(tableIndicator);
        }

        const nameSpan = document.createElement('span');
        nameSpan.className = 'feature-name';
        if (type === 'feature' && tag) {
            // Feature tag (4-digit code)
            const tagSpan = document.createElement('span');
            tagSpan.className = 'feature-tag';
            tagSpan.textContent = tag;
            main.appendChild(tagSpan);

            // Feature name
            const tagCheck = validateFeatureTag(tag);
            nameSpan.textContent =
                getFeatureName(tag) ||
                (tagCheck.level === 'ok'
                    ? tagCheck.message
                    : 'Unregistered tag');
            if (tagCheck.level !== 'ok') {
                const issueIcon = document.createElement('span');
                issueIcon.className = `material-symbols-outlined feature-tag-issue-icon is-${tagCheck.level}`;
                issueIcon.textContent =
                    tagCheck.level === 'error' ? 'error' : 'warning';
                issueIcon.title = tagCheck.message;
                icons.appendChild(issueIcon);
            }
        } else {
            // Prefixes and classes show their key
            setBreakableName(nameSpan, String(key));
        }
        main.appendChild(nameSpan);

        // Automatic generation indicator
        if (codeData.automatic) {
            const autoIcon = document.createElement('span');
            autoIcon.className = 'material-symbols-outlined feature-auto-icon';
            const stamp = generatorStamp(codeData);
            const described = stamp
                ? pluginSettingsRegistry.describe(stamp.generator)
                : null;
            const managed =
                !!stamp &&
                !!window.currentFontModel?.counterpunchManagesFeatures;
            autoIcon.textContent = managed ? 'sync' : 'sync_disabled';
            autoIcon.classList.toggle('is-managed', managed);
            autoIcon.title = managed
                ? `Generated by Counterpunch${described ? ` (${described.title})` : ''}`
                : 'Automatic in source. Counterpunch does not update it.';
            icons.appendChild(autoIcon);
            if (stamp) {
                item.dataset.generator = stamp.generator;
            }
        }

        if (this.isFeatureErrorTarget(type, key)) {
            this.addFeatureErrorIcon(item, this.featureErrorTarget!.message);
        }

        item.addEventListener('click', () => {
            this.closePluginSettingsForm();
            this.selectItem(type, key);
        });
        item.addEventListener('dblclick', (event) => {
            if ((event.target as HTMLElement).closest('input')) {
                return;
            }
            event.preventDefault();
            this.startRenameItem(type, key);
        });

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
                selectedElement.scrollIntoView?.({
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
            this.setFeatureEditorEditable(!codeData.automatic);
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
            autoCheckbox.disabled = false;
        }
        this.updateFeatureSourceHeader(codeData);
        this.updateAutomaticControl(codeData);
        this.updateFeatureTagIssue();
        this.refreshStructureButtons();

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
        this.updateFeatureSourceHeader();
        this.setFeatureEditorEditable(false);
        this.updateAutomaticControl();
        this.updateFeatureTagIssue();
        this.refreshStructureButtons();
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

        // With the bridge, the code is set inside the commit's transaction:
        // the model write and the change set below then make one update and
        // one history step, not two.
        const applyCode = () => {
            codeData.code = newCode;
            if (previousAutomatic) {
                codeData.automatic = nextAutomatic;
            }
        };
        if (!bridge || !path) {
            applyCode();
        }
        this.featureCodeDirty = false;

        const autoCheckbox = document.getElementById(
            'feature-automatic-checkbox'
        ) as HTMLInputElement | null;
        if (autoCheckbox && previousAutomatic) {
            autoCheckbox.checked = nextAutomatic;
        }
        if (previousAutomatic) {
            this.updateAutomaticControl({
                ...codeData,
                automatic: nextAutomatic
            });
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
            applyCode();
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
        if (
            (type === 'prefix' || type === 'class') &&
            typeof key === 'string'
        ) {
            return this.keyedHistoryTarget(type, key);
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
        const autoCheckbox = document.getElementById(
            'feature-automatic-checkbox'
        ) as HTMLInputElement | null;
        if (autoCheckbox) {
            this.setSelectedAutomatic(
                autoCheckbox.checked,
                'Toggle automatic generation'
            );
        }
    }

    private setSelectedAutomatic(nextAutomatic: boolean, label: string) {
        if (!this.selectedItem) return;
        const codeData = this.codeDataFor(
            this.selectedItem.type,
            this.selectedItem.key
        );
        if (!codeData) return;

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
        bridge.beginTransaction(label, historyTarget, {
            compileChangeSource: 'feature-code',
            compileEditType: 'feature'
        });
        try {
            bridge.applySyntheticChangeSet(
                label,
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
        const nextCodeData = { ...codeData, automatic: nextAutomatic };
        this.updateFeatureSourceHeader(nextCodeData);
        this.updateAutomaticControl(nextCodeData);
        this.setFeatureEditorEditable(!nextAutomatic);
        const autoCheckbox = document.getElementById(
            'feature-automatic-checkbox'
        ) as HTMLInputElement | null;
        if (autoCheckbox) {
            autoCheckbox.checked = nextAutomatic;
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

    private initFeatureStructureControls() {
        this.featuresTab
            ?.querySelectorAll<HTMLButtonElement>('[data-features-action]')
            .forEach((button) => {
                button.addEventListener('mousedown', (event) => {
                    event.preventDefault();
                });
                button.addEventListener('click', () => {
                    const type = button.dataset.featuresType as FeatureItemType;
                    if (button.dataset.featuresAction === 'add') {
                        void this.addFeatureItem(type);
                    } else if (this.selectedItem?.type === type) {
                        void this.deleteFeatureItem(
                            type,
                            this.selectedItem.key
                        );
                    }
                });
            });
        this.featuresTab
            ?.querySelector('#feature-keep-code-button')
            ?.addEventListener('click', () =>
                this.setSelectedAutomatic(false, 'Keep my code')
            );
        this.featuresTab
            ?.querySelector('#feature-tag-issue-rename')
            ?.addEventListener('click', () => {
                if (this.selectedItem?.type === 'feature') {
                    this.startRenameItem('feature', this.selectedItem.key);
                }
            });
        this.refreshStructureButtons();
    }

    private refreshStructureButtons() {
        this.featuresTab
            ?.querySelectorAll<HTMLButtonElement>(
                '[data-features-action="remove"]'
            )
            .forEach((button) => {
                button.disabled =
                    this.selectedItem?.type !== button.dataset.featuresType;
            });
    }

    /**
     * The code editor accepts input only for a selected item that is not
     * marked automatic. Nothing selected (such as a new font) or automatic
     * code makes it read-only.
     */
    private setFeatureEditorEditable(editable: boolean) {
        this.featuresEditor?.setReadOnly?.(!editable);
        document
            .getElementById('features-editor')
            ?.classList.toggle('is-read-only', !editable);
    }

    /**
     * The “Automatically Generated” checkbox is shown only for code that a
     * Counterpunch generator owns. Code that only the source file marks
     * automatic (a Glyphs leftover) gets a notice and “Keep my code” instead.
     */
    private updateAutomaticControl(codeData?: Babelfont.PossiblyAutomaticCode) {
        const hasGenerator = Boolean(codeData && generatorStamp(codeData));
        const label = this.featuresTab?.querySelector(
            '#feature-automatic-label'
        ) as HTMLElement | null;
        if (label) {
            label.hidden = !hasGenerator;
        }
        const notice = this.featuresTab?.querySelector(
            '#feature-automatic-notice'
        ) as HTMLElement | null;
        if (!notice) {
            return;
        }
        const sourceOnly = Boolean(
            codeData && !hasGenerator && codeData.automatic
        );
        const message = sourceOnly
            ? 'Marked automatic in the source file. Glyphs rebuilds this code when it opens the file. Counterpunch doesn’t. To edit the code, click “Keep my code”.'
            : null;
        notice.hidden = !message;
        const text = notice.querySelector('.feature-header-notice-text');
        if (text) {
            text.textContent = message || '';
        }
        const keepButton = notice.querySelector(
            '#feature-keep-code-button'
        ) as HTMLElement | null;
        if (keepButton) {
            keepButton.hidden = !sourceOnly;
        }
    }

    private updateFeatureTagIssue() {
        const issue = this.featuresTab?.querySelector(
            '#feature-tag-issue'
        ) as HTMLElement | null;
        if (!issue) {
            return;
        }
        const tag =
            this.selectedItem?.type === 'feature'
                ? this.selectedFeatureTag
                : null;
        const check = tag === null ? null : validateFeatureTag(tag);
        const flagged = !!check && check.level !== 'ok';
        issue.hidden = !flagged;
        issue.dataset.level = flagged ? check.level : '';
        const text = issue.querySelector('.feature-header-notice-text');
        if (text) {
            text.textContent = flagged ? check.message : '';
        }
    }

    private codeDataFor(
        type: FeatureItemType,
        key: string | number
    ): Babelfont.PossiblyAutomaticCode | undefined {
        const features = window.currentFontModel?.features;
        if (!features) return undefined;
        if (type === 'prefix') return features.prefixes?.[String(key)];
        if (type === 'class') return features.classes?.[String(key)];
        return typeof key === 'number'
            ? features.features?.[key]?.[1]
            : undefined;
    }

    private featureItemNames(type: FeaNamedKind): string[] {
        const features = window.currentFontModel?.features;
        return Object.keys(
            (type === 'prefix' ? features?.prefixes : features?.classes) || {}
        );
    }

    /** “prefix “x””, “class “@x”” or “feature “liga”” for messages. */
    private featureItemDisplayName(
        type: FeatureItemType,
        key: string | number
    ): string {
        if (type === 'feature') {
            const tag =
                window.currentFontModel?.features?.features?.[Number(key)]?.[0];
            return `feature “${tag ?? ''}”`;
        }
        return type === 'class' ? `class “@${key}”` : `prefix “${key}”`;
    }

    /** True while Counterpunch would regenerate this code on its own. */
    private isManagedGeneratedCode(
        codeData: Babelfont.PossiblyAutomaticCode
    ): boolean {
        return Boolean(
            codeData.automatic &&
            generatorStamp(codeData) &&
            window.currentFontModel?.counterpunchManagesFeatures
        );
    }

    /** History target in the key format of `getHistoryScopeTarget()`. */
    private keyedHistoryTarget(
        type: FeaNamedKind,
        key: string
    ): TransactionHistoryTarget {
        return { type, key: `${type}:${key}`, label: key };
    }

    /**
     * Apply a structural change (add, delete, rename, duplicate) to the live
     * features model in one undo step. The model records every mutation the
     * callback makes, so the sync document gets granular operations.
     * `historyTarget` is the item selected afterwards, so that undo in the
     * panel reaches the change.
     */
    private commitFeatureStructureChange(options: {
        label: string;
        historyTarget: TransactionHistoryTarget | null;
        mutate: (features: Babelfont.Features) => void;
        select: { type: FeatureItemType; key: string | number } | null;
        removed?: { type: FeatureItemType; key: string | number };
    }): void {
        const font = window.currentFontModel;
        if (!font) return;

        // A pending code edit belongs to the item that is selected now.
        if (this.featureCodeDirty) {
            this.commitFeatureCodeChanges();
        }

        const bridge = window.patchSyncEngine;
        window.fontManager?.setEditingCompileContext?.('feature-code', null);
        bridge?.beginTransaction(options.label, options.historyTarget, {
            compileChangeSource: 'feature-code',
            compileEditType: 'feature'
        });
        try {
            if (!font.features) {
                font.features = { prefixes: {}, classes: {}, features: [] };
            }
            options.mutate(font.features);
        } finally {
            bridge?.endTransaction();
        }
        if (!bridge) {
            window.fontManager?.currentFont?.markDirty('feature-code');
        }

        if (
            options.removed &&
            this.isFeatureErrorTarget(options.removed.type, options.removed.key)
        ) {
            this.clearFeatureErrorMarker();
            this.featureErrorTarget = null;
            this.featureErrorIssue = null;
        }

        this.selectedItem = null;
        this.selectedFeatureTag = null;
        this.loadAllLists();
        if (options.select) {
            this.closePluginSettingsForm();
            this.selectItem(options.select.type, options.select.key, true);
        } else if (!this.selectedItem) {
            this.clearEditor();
        }
    }

    private async addFeatureItem(type: FeatureItemType): Promise<void> {
        if (type === 'feature') {
            await this.addFeature();
            return;
        }
        const name = uniqueFeaName(type, this.featureItemNames(type));
        this.commitFeatureStructureChange({
            label: type === 'prefix' ? 'Add prefix' : 'Add class',
            historyTarget: this.keyedHistoryTarget(type, name),
            mutate: (features) => {
                const entry = { code: '', automatic: false };
                if (type === 'prefix') {
                    if (features.prefixes) {
                        features.prefixes[name] = entry;
                    } else {
                        features.prefixes = { [name]: entry };
                    }
                } else if (features.classes) {
                    features.classes[name] = entry;
                } else {
                    features.classes = { [name]: entry };
                }
            },
            select: { type, key: name }
        });
        this.startRenameItem(type, name);
    }

    private async addFeature(): Promise<void> {
        const tag = await showFeatureTagDialog({
            title: 'Add Feature',
            confirmLabel: 'Add'
        });
        if (tag === null) return;

        const features = window.currentFontModel?.features?.features || [];
        const selected =
            this.selectedItem?.type === 'feature' &&
            typeof this.selectedItem.key === 'number'
                ? this.selectedItem.key
                : -1;
        const index = selected >= 0 ? selected + 1 : features.length;
        const entry: [string, Babelfont.PossiblyAutomaticCode] = [
            tag,
            { code: '', automatic: false }
        ];
        const nextFeatures = [
            ...features.slice(0, index),
            entry,
            ...features.slice(index)
        ];
        this.commitFeatureStructureChange({
            label: 'Add feature',
            historyTarget: this.getFeatureHistoryTarget(nextFeatures, index),
            mutate: (doc) => {
                if (doc.features) {
                    doc.features.splice(index, 0, entry);
                } else {
                    doc.features = [entry];
                }
            },
            select: { type: 'feature', key: index }
        });
        this.featuresEditor?.focus?.();
    }

    private duplicateFeatureItem(type: FeatureItemType, key: string | number) {
        const codeData = this.codeDataFor(type, key);
        if (!codeData) return;
        const copy = clonePlainData(codeData);
        copy.automatic = false;
        // A generator owns only its own block, never a copy of it.
        if (copy.format_specific) {
            delete copy.format_specific[GENERATOR_KEY];
        }

        if (type === 'feature') {
            const features = window.currentFontModel?.features?.features || [];
            const index = Number(key);
            const tag = features[index]?.[0];
            if (tag === undefined) return;
            const entry: [string, Babelfont.PossiblyAutomaticCode] = [
                tag,
                copy
            ];
            const nextFeatures = [
                ...features.slice(0, index + 1),
                entry,
                ...features.slice(index + 1)
            ];
            this.commitFeatureStructureChange({
                label: 'Duplicate feature',
                historyTarget: this.getFeatureHistoryTarget(
                    nextFeatures,
                    index + 1
                ),
                mutate: (doc) => {
                    doc.features.splice(index + 1, 0, entry);
                },
                select: { type: 'feature', key: index + 1 }
            });
            return;
        }

        const name = uniqueFeaName(`${key}_copy`, this.featureItemNames(type));
        this.commitFeatureStructureChange({
            label: type === 'prefix' ? 'Duplicate prefix' : 'Duplicate class',
            historyTarget: this.keyedHistoryTarget(type, name),
            mutate: (doc) => {
                if (type === 'prefix') {
                    doc.prefixes[name] = copy;
                } else {
                    doc.classes[name] = copy;
                }
            },
            select: { type, key: name }
        });
    }

    private async deleteFeatureItem(
        type: FeatureItemType,
        key: string | number
    ): Promise<void> {
        const codeData = this.codeDataFor(type, key);
        if (!codeData) return;
        const displayName = this.featureItemDisplayName(type, key);

        if (this.isManagedGeneratedCode(codeData)) {
            const choice = await showChoiceDialog(
                'Delete Generated Code',
                `Counterpunch generates the ${displayName} and adds it again after the next glyph change. Turn off “Automatically Generated” to keep it as your own code, or delete it anyway.`,
                [
                    { id: 'cancel', label: 'Cancel' },
                    { id: 'turn-off', label: 'Turn Off Automatic' },
                    { id: 'delete', label: 'Delete', style: 'danger' }
                ]
            );
            if (choice === 'turn-off') {
                this.closePluginSettingsForm();
                this.selectItem(type, key);
                this.setSelectedAutomatic(
                    false,
                    'Turn off automatic generation'
                );
                return;
            }
            if (choice !== 'delete') return;
        } else {
            const confirmed = await new Promise<boolean>((resolve) =>
                this.showDeleteConfirmDialog(
                    `Delete the ${displayName}?`,
                    resolve
                )
            );
            if (!confirmed) return;
        }

        if (type === 'feature') {
            const features = window.currentFontModel?.features?.features || [];
            const index = Number(key);
            if (!features[index]) return;
            const remaining = features.filter((_, i) => i !== index);
            const neighbor = Math.min(index, remaining.length - 1);
            this.commitFeatureStructureChange({
                label: 'Delete feature',
                historyTarget:
                    neighbor >= 0
                        ? this.getFeatureHistoryTarget(remaining, neighbor)
                        : null,
                mutate: (doc) => {
                    doc.features.splice(index, 1);
                },
                select: neighbor >= 0 ? { type, key: neighbor } : null,
                removed: { type, key }
            });
            return;
        }

        const name = String(key);
        const names = this.featureItemNames(type);
        const position = names.indexOf(name);
        const neighbor = names[position + 1] ?? names[position - 1];
        this.commitFeatureStructureChange({
            label: type === 'prefix' ? 'Delete prefix' : 'Delete class',
            historyTarget:
                neighbor === undefined
                    ? null
                    : this.keyedHistoryTarget(type, neighbor),
            mutate: (doc) => {
                if (type === 'prefix') {
                    delete doc.prefixes[name];
                } else {
                    delete doc.classes[name];
                }
            },
            select: neighbor === undefined ? null : { type, key: neighbor },
            removed: { type, key: name }
        });
    }

    private startRenameItem(type: FeatureItemType, key: string | number) {
        if (type === 'feature') {
            void this.renameFeature(Number(key));
            return;
        }
        const item = (
            type === 'prefix' ? this.prefixListItems : this.classListItems
        ).get(String(key));
        const nameSpan = item?.querySelector(
            '.feature-name'
        ) as HTMLElement | null;
        if (!item || !nameSpan) return;

        const oldName = String(key);
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'feature-rename-input';
        input.value = oldName;
        input.spellcheck = false;
        input.setAttribute('aria-label', `Name of the ${type}`);
        const error = document.createElement('div');
        error.className = 'feature-rename-error';
        error.hidden = true;

        const wasDraggable = item.draggable;
        item.draggable = false;
        nameSpan.replaceWith(input);
        item.insertAdjacentElement('afterend', error);

        const validate = (): string | null => {
            const message = validateFeaName(
                input.value,
                type,
                this.featureItemNames(type),
                oldName
            );
            error.hidden = !message;
            error.textContent = message || '';
            input.setAttribute('aria-invalid', message ? 'true' : 'false');
            return message;
        };

        let finished = false;
        const finish = (commit: boolean) => {
            if (finished) return;
            finished = true;
            const nextName = input.value;
            input.replaceWith(nameSpan);
            error.remove();
            item.draggable = wasDraggable;
            if (commit && nextName !== oldName) {
                void this.renameNamedItem(type, oldName, nextName);
            }
        };

        for (const eventName of ['click', 'dblclick', 'mousedown']) {
            input.addEventListener(eventName, (event) =>
                event.stopPropagation()
            );
        }
        input.addEventListener('input', () => validate());
        input.addEventListener('keydown', (event) => {
            event.stopPropagation();
            if (event.key === 'Enter') {
                event.preventDefault();
                if (!validate()) finish(true);
            } else if (event.key === 'Escape') {
                event.preventDefault();
                finish(false);
            }
        });
        input.addEventListener('blur', () => finish(!validate()));
        input.focus();
        input.select();
    }

    private async renameNamedItem(
        type: FeaNamedKind,
        oldName: string,
        newName: string
    ): Promise<void> {
        const features = window.currentFontModel?.features;
        const codeData = this.codeDataFor(type, oldName);
        if (!features || !codeData) return;
        if (
            validateFeaName(newName, type, this.featureItemNames(type), oldName)
        ) {
            return;
        }

        let referenceEdits: ReturnType<
            typeof planClassReferenceRename
        >['edits'] = [];
        if (type === 'class') {
            const plan = planClassReferenceRename(
                clonePlainData(features),
                oldName,
                newName
            );
            if (plan.count > 0) {
                const references =
                    plan.count === 1
                        ? '1 reference'
                        : `${plan.count} references`;
                const items =
                    plan.edits.length === 1
                        ? '1 item'
                        : `${plan.edits.length} items`;
                const choice = await showChoiceDialog(
                    'Rename Class',
                    `Update ${references} to “@${oldName}” in ${items}?`,
                    [
                        { id: 'cancel', label: 'Cancel' },
                        { id: 'keep', label: 'Don’t Update' },
                        { id: 'update', label: 'Update', style: 'primary' }
                    ]
                );
                if (choice !== 'keep' && choice !== 'update') return;
                if (choice === 'update') referenceEdits = plan.edits;
            }
        }

        const entry = clonePlainData(codeData);
        if (this.isManagedGeneratedCode(codeData)) {
            entry.automatic = false;
        }
        this.commitFeatureStructureChange({
            label: type === 'prefix' ? 'Rename prefix' : 'Rename class',
            historyTarget: this.keyedHistoryTarget(type, newName),
            mutate: (doc) => {
                const map = type === 'prefix' ? doc.prefixes : doc.classes;
                delete map[oldName];
                map[newName] = entry;
                for (const edit of referenceEdits) {
                    if (edit.type === 'feature') {
                        doc.features[edit.key][1].code = edit.code;
                    } else {
                        const target =
                            edit.type === 'prefix' ? doc.prefixes : doc.classes;
                        target[edit.key].code = edit.code;
                    }
                }
            },
            select: { type, key: newName },
            removed: { type, key: oldName }
        });
    }

    private async renameFeature(index: number): Promise<void> {
        const entry = window.currentFontModel?.features?.features?.[index];
        if (!entry) return;
        const [oldTag, codeData] = entry;
        const tag = await showFeatureTagDialog({
            title: 'Rename Feature',
            confirmLabel: 'Rename',
            initialTag: oldTag
        });
        const features = window.currentFontModel?.features?.features;
        if (
            tag === null ||
            tag === oldTag ||
            features?.[index]?.[0] !== oldTag
        ) {
            return;
        }
        const nextCode = clonePlainData(codeData);
        if (this.isManagedGeneratedCode(codeData)) {
            nextCode.automatic = false;
        }
        const nextEntry: [string, Babelfont.PossiblyAutomaticCode] = [
            tag,
            nextCode
        ];
        const nextFeatures = features.map((existing, i) =>
            i === index ? nextEntry : existing
        );
        this.commitFeatureStructureChange({
            label: 'Rename feature',
            historyTarget: this.getFeatureHistoryTarget(nextFeatures, index),
            mutate: (doc) => {
                doc.features.splice(index, 1, nextEntry);
            },
            select: { type: 'feature', key: index },
            removed: { type: 'feature', key: index }
        });
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
window.addEventListener('compilefiltersregistered', () => {
    fontInfoManager.reloadCompileFiltersIfVisible();
});

// Export for global access
(window as any).fontInfoManager = fontInfoManager;

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => fontInfoManager.init());
} else {
    fontInfoManager.init();
}

export { fontInfoManager };
