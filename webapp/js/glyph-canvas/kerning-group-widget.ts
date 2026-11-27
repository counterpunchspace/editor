import { collectKerningGroupMemberships } from '../kerning-utils';

export type KerningPairSide = 'first' | 'second';

export { collectKerningGroupMemberships };

export type KerningGroupsHost = {
    first_kern_groups?: Record<string, string[]>;
    second_kern_groups?: Record<string, string[]>;
    rebuildAutomaticCompositesForKerningGroupMembership?: (
        pairSide: KerningPairSide,
        glyphNames: Iterable<string>
    ) => Set<string>;
};

export type KerningGroupChip = {
    pairSide: KerningPairSide;
    kind: 'glyph' | 'group';
    name: string;
    key: string;
    label: string;
    removable: boolean;
    participates?: boolean;
    compatible?: boolean;
    active?: boolean;
};

export type KerningGroupWidgetSide = {
    pairSide: KerningPairSide;
    title: string;
    glyphNames: string[];
    missingGlyphNames: string[];
    chips: KerningGroupChip[];
};

export type KerningGroupWidgetOptions = {
    startSide: KerningGroupWidgetSide;
    endSide: KerningGroupWidgetSide;
    center: HTMLElement;
    isRTL?: boolean;
    onSelectChip?: (chip: KerningGroupChip) => void;
    onRemoveChip?: (chip: KerningGroupChip) => void;
    onAdd?: (pairSide: KerningPairSide, glyphNames: string[]) => void;
};

export function summarizeKerningGroupsForGlyphs(
    groups: Record<string, string[]> | undefined,
    glyphNames: string[]
): {
    groupNames: string[];
    missingGlyphNames: string[];
} {
    const uniqueGroups = new Set<string>();
    const missingGlyphNames: string[] = [];
    for (const glyphName of glyphNames) {
        const memberships = collectKerningGroupMemberships(groups, glyphName);
        if (memberships.length === 0) {
            missingGlyphNames.push(glyphName);
            continue;
        }
        for (const groupName of memberships) {
            uniqueGroups.add(groupName);
        }
    }

    return {
        groupNames: Array.from(uniqueGroups).sort((left, right) =>
            left.localeCompare(right)
        ),
        missingGlyphNames
    };
}

export function formatKerningOperandLabel(
    kind: 'glyph' | 'group',
    name: string
): string {
    return kind === 'group' ? `@${name}` : name;
}

export function formatKerningGroupKindLabel(
    pairSide: KerningPairSide,
    isRTL: boolean = false
): 'LKG' | 'RKG' {
    return (pairSide === 'first') === !isRTL ? 'RKG' : 'LKG';
}

export function formatKerningGroupKindTooltip(
    pairSide: KerningPairSide,
    isRTL: boolean = false
): string {
    return formatKerningGroupKindLabel(pairSide, isRTL) === 'LKG'
        ? 'Left kerning group'
        : 'Right kerning group';
}

export function formatTextModeKerningSideTitle(
    pairSide: KerningPairSide,
    isRTL: boolean = false
): string {
    const role = pairSide === 'first' ? 'First' : 'Second';
    return `${role} (${formatKerningGroupKindLabel(pairSide, isRTL)})`;
}

export function buildGroupKerningChips(
    pairSide: KerningPairSide,
    groupNames: string[]
): KerningGroupChip[] {
    return groupNames.map((groupName) => ({
        pairSide,
        kind: 'group' as const,
        name: groupName,
        key: `@${groupName}`,
        label: formatKerningOperandLabel('group', groupName),
        removable: true
    }));
}

export function buildEditViewKerningGroupSide(
    pairSide: KerningPairSide,
    glyphNames: string[],
    groups: Record<string, string[]> | undefined,
    isRTL: boolean = false
): KerningGroupWidgetSide {
    const summary = summarizeKerningGroupsForGlyphs(groups, glyphNames);
    return {
        pairSide,
        title: formatKerningGroupKindLabel(pairSide, isRTL),
        glyphNames,
        missingGlyphNames: summary.missingGlyphNames,
        chips: buildGroupKerningChips(pairSide, summary.groupNames)
    };
}

function getGroupsForPairSide(
    fontModel: KerningGroupsHost,
    pairSide: KerningPairSide
): Record<string, string[]> | undefined {
    return pairSide === 'first'
        ? fontModel.first_kern_groups
        : fontModel.second_kern_groups;
}

function ensureGroupsForPairSide(
    fontModel: KerningGroupsHost,
    pairSide: KerningPairSide
): Record<string, string[]> {
    let groups = getGroupsForPairSide(fontModel, pairSide);
    if (groups) {
        return groups;
    }

    groups = {};
    if (pairSide === 'first') {
        fontModel.first_kern_groups = groups;
    } else {
        fontModel.second_kern_groups = groups;
    }
    return groups;
}

export function applyKerningGroupMembership(
    fontModel: KerningGroupsHost,
    pairSide: KerningPairSide,
    glyphNames: string[],
    groupName: string,
    include: boolean
): boolean {
    const normalizedGroupName = groupName.trim().replace(/^@+/, '');
    if (!normalizedGroupName || glyphNames.length === 0) {
        return false;
    }

    let groups = getGroupsForPairSide(fontModel, pairSide);
    if (!groups) {
        if (!include) {
            return false;
        }
        groups = ensureGroupsForPairSide(fontModel, pairSide);
    }

    let changed = false;
    for (const glyphName of glyphNames) {
        const existingGroupNames = collectKerningGroupMemberships(
            groups,
            glyphName
        );
        if (include) {
            if (
                existingGroupNames.length > 0 &&
                !existingGroupNames.includes(normalizedGroupName)
            ) {
                continue;
            }
            if (!Array.isArray(groups[normalizedGroupName])) {
                groups[normalizedGroupName] = [];
            }
            if (!groups[normalizedGroupName].includes(glyphName)) {
                groups[normalizedGroupName].push(glyphName);
                groups[normalizedGroupName].sort((left, right) =>
                    left.localeCompare(right)
                );
                changed = true;
            }
            continue;
        }

        const members = groups[normalizedGroupName];
        if (!Array.isArray(members)) {
            continue;
        }
        const memberIndex = members.indexOf(glyphName);
        if (memberIndex >= 0) {
            members.splice(memberIndex, 1);
            changed = true;
        }
        if (members.length === 0) {
            delete groups[normalizedGroupName];
        }
    }

    if (changed) {
        fontModel.rebuildAutomaticCompositesForKerningGroupMembership?.(
            pairSide,
            glyphNames
        );
    }

    return changed;
}

function formatAddChipTitle(side: KerningGroupWidgetSide): string {
    const missingGlyphNames = side.missingGlyphNames;
    const hasGroupChip = side.chips.some((chip) => chip.kind === 'group');
    if (hasGroupChip && missingGlyphNames.length > 0) {
        return 'Only empty fields will be filled';
    }
    if (missingGlyphNames.length === 1) {
        return `Add kerning group to glyph "${missingGlyphNames[0]}"`;
    }
    if (missingGlyphNames.length > 1) {
        return 'Add kerning group';
    }
    return 'Add kerning group';
}

function formatRemoveChipTitle(
    side: KerningGroupWidgetSide,
    chip: KerningGroupChip
): string {
    if (side.glyphNames.length === 1) {
        return `Remove kerning group "${chip.name}" from glyph "${side.glyphNames[0]}"`;
    }
    if (side.glyphNames.length > 1) {
        return `Remove kerning group "${chip.name}" from selected glyphs`;
    }
    return `Remove kerning group "${chip.name}"`;
}

function createSide(
    side: KerningGroupWidgetSide,
    options: KerningGroupWidgetOptions
): HTMLElement {
    const sideElement = document.createElement('div');
    sideElement.className = 'glyph-kerning-side';

    const header = document.createElement('span');
    header.className = 'glyph-property-control-label';
    header.dataset.kerningSide = side.pairSide;
    header.textContent = side.title;
    header.title = formatKerningGroupKindTooltip(side.pairSide, options.isRTL);
    sideElement.appendChild(header);

    const pills = document.createElement('div');
    pills.className = 'glyph-kerning-pills';

    for (const chip of side.chips) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'glyph-filter-legend-item glyph-kerning-pill';
        button.dataset.kerningSide = chip.pairSide;
        button.dataset.kerningKey = chip.key;
        button.title = chip.label;

        const label = document.createElement('span');
        label.className = 'glyph-filter-legend-label glyph-kerning-pill-label';
        label.textContent = chip.label;
        button.appendChild(label);

        button.classList.toggle(
            'glyph-kerning-pill-base',
            chip.kind === 'glyph'
        );
        if (chip.participates) {
            button.classList.add('glyph-kerning-pill-participates');
        }
        if (chip.compatible) {
            button.classList.add('selected-glyph-group');
        }
        if (chip.active) {
            button.classList.add('active');
        }

        if (chip.removable) {
            const removeBadge = document.createElement('span');
            removeBadge.className = 'glyph-kerning-pill-remove';
            removeBadge.title = formatRemoveChipTitle(side, chip);
            removeBadge.setAttribute('aria-hidden', 'true');

            const removeIcon = document.createElement('span');
            removeIcon.className =
                'material-symbols-outlined glyph-kerning-pill-remove-icon';
            removeIcon.textContent = 'close';
            removeIcon.setAttribute('aria-hidden', 'true');
            removeBadge.appendChild(removeIcon);
            button.appendChild(removeBadge);
        }

        button.addEventListener('click', (event) => {
            const removeTarget = (event.target as HTMLElement | null)?.closest(
                '.glyph-kerning-pill-remove'
            );
            if (removeTarget) {
                event.preventDefault();
                options.onRemoveChip?.(chip);
                return;
            }

            options.onSelectChip?.(chip);
        });

        pills.appendChild(button);
    }

    const missingGlyphNames = side.missingGlyphNames;
    const showAddChip =
        missingGlyphNames.length > 0 ||
        (side.glyphNames.length === 0 &&
            !side.chips.some((chip) => chip.kind === 'group'));
    if (showAddChip) {
        const canAdd = missingGlyphNames.length > 0;
        const placeholder = document.createElement(canAdd ? 'button' : 'span');
        if (canAdd) {
            (placeholder as HTMLButtonElement).type = 'button';
        }
        placeholder.className =
            'glyph-kerning-pill glyph-kerning-pill-placeholder';
        placeholder.dataset.kerningSide = side.pairSide;
        placeholder.textContent = '+';
        placeholder.title = formatAddChipTitle(side);
        if (canAdd) {
            placeholder.addEventListener('click', () => {
                options.onAdd?.(side.pairSide, missingGlyphNames);
            });
        }
        pills.appendChild(placeholder);
    }

    sideElement.appendChild(pills);
    const visualChipCount = side.chips.length + (showAddChip ? 1 : 0);
    if (visualChipCount > 2) {
        sideElement.classList.add('glyph-kerning-side-multiline');
    }
    return sideElement;
}

export function renderKerningGroupWidget(
    parent: HTMLElement,
    options: KerningGroupWidgetOptions
): HTMLElement {
    const content = document.createElement('div');
    content.className =
        'glyph-property-panel-content glyph-kerning-panel-content';

    const shell = document.createElement('div');
    shell.className = 'glyph-kerning-panel-shell';

    const center = document.createElement('div');
    center.className = 'glyph-kerning-center';
    center.appendChild(options.center);

    shell.appendChild(createSide(options.startSide, options));
    shell.appendChild(center);
    shell.appendChild(createSide(options.endSide, options));

    content.appendChild(shell);
    parent.appendChild(content);
    return content;
}
