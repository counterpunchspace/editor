// Overview View
// Handles overview view initialization with sidebar and glyph overview
// Note: glyphOverviewFilterManager is loaded via glyph-overview.ts bundle
// and available on window.glyphOverviewFilterManager

import { attachTopRowSidebarInterpolation } from './top-row-sidebar-interpolation';
import { listOverviewGlyphRecords } from './filesystem-plugins/cloud-glyph-catalog';

function timelineSpanStartSafe(
    stage: string,
    detail?: Record<string, unknown>
) {
    if (window.timelineSpanStart) {
        return window.timelineSpanStart(stage, detail);
    }

    const startMark = `cp:${stage}:${Date.now()}:start`;
    performance.mark(startMark);
    return startMark;
}

function timelineSpanEndSafe(spanId: string) {
    if (window.timelineSpanEnd) {
        window.timelineSpanEnd(spanId);
        return;
    }

    const endMark = `${spanId.replace(':start', ':end')}`;
    performance.mark(endMark);
    performance.measure('cp:overview.fallback', spanId, endMark);
}

function waitForNextAnimationFrame() {
    return new Promise((resolve) => {
        const nextFrame =
            window.requestAnimationFrame ||
            globalThis.requestAnimationFrame ||
            ((callback: FrameRequestCallback) =>
                window.setTimeout(() => callback(performance.now()), 0));

        nextFrame(() => resolve(undefined));
    });
}

console.log('[OverviewView]', 'overview-view.js loaded');

let glyphOverviewInstance: any = null;
let pendingInitialOpenSession: string | null = null;
let pendingInitialOpenStartedAt: number | null = null;
let initialRenderInProgress = false;
let queuedRenderRequest: {
    reason: string;
    openSessionId: string | null;
} | null = null;
let pendingFallbackAttempts = 0;
const maxFallbackAttempts = 4;

function resolveCurrentOverviewLocation() {
    // Prefer StateManager (URL restore source of truth) over live axes. Axes can
    // still hold the font default when a concurrent setFont stomps them after
    // restore; empty/default location would paint the font default implicitly.
    const stateLocation = window.stateManager?.editor_variation_location;
    if (stateLocation && Object.keys(stateLocation).length > 0) {
        const resolvedLocation: Record<string, number> = {};
        for (const [tag, value] of Object.entries(stateLocation)) {
            resolvedLocation[tag] = Number(value);
        }
        return resolvedLocation;
    }

    const axesLocation = window.glyphCanvas?.axesManager?.variationSettings;
    if (axesLocation && Object.keys(axesLocation).length > 0) {
        const resolvedLocation: Record<string, number> = {};
        for (const [tag, value] of Object.entries(axesLocation)) {
            resolvedLocation[tag] = Number(value);
        }
        return resolvedLocation;
    }

    return {};
}

function buildGlyphData() {
    return listOverviewGlyphRecords({
        fontJson: window.fontManager?.currentFont?.babelfontData,
        hydratedGlyphs: window.currentFontModel?.glyphs || []
    }).map((glyph) => ({
        id: glyph.id,
        name: glyph.name,
        codepoints: glyph.codepoints
    }));
}

async function updateOverviewTiles() {
    if (!glyphOverviewInstance) {
        return [];
    }

    const updateTilesSpanId = timelineSpanStartSafe('overview.updateTiles', {
        glyphCount: window.currentFontModel?.glyphs?.length || 0
    });
    const glyphData = buildGlyphData();
    try {
        if (typeof glyphOverviewInstance.syncGlyphs === 'function') {
            await glyphOverviewInstance.syncGlyphs(glyphData);
        } else {
            await glyphOverviewInstance.updateGlyphs(glyphData);
        }
    } finally {
        timelineSpanEndSafe(updateTilesSpanId);
    }
    return glyphData;
}

async function refreshFilterPlugins() {
    if (window.glyphOverviewFilterManager?.isLoaded()) {
        const refreshFiltersSpanId = timelineSpanStartSafe(
            'overview.refreshFilterPlugins'
        );
        try {
            await window.glyphOverviewFilterManager.refreshPlugins({
                deferCounts: true
            });
        } finally {
            timelineSpanEndSafe(refreshFiltersSpanId);
        }
    }
}

async function refreshOverviewSidebarForSettingsFolderAccessChange() {
    if (!window.glyphOverviewFilterManager) {
        return;
    }

    await window.glyphOverviewFilterManager.discoverUserFilters();
}

function scheduleFallbackRender(sessionId: string | null, delayMs = 1200) {
    if (!sessionId) {
        return;
    }

    setTimeout(async () => {
        if (
            pendingInitialOpenSession !== sessionId ||
            !glyphOverviewInstance ||
            initialRenderInProgress
        ) {
            return;
        }

        if (pendingFallbackAttempts >= maxFallbackAttempts) {
            glyphOverviewInstance?.setOutlinePaintAllowed?.(true);
            return;
        }

        pendingFallbackAttempts += 1;
        const success = await renderOverviewAndEmit(
            `fontReady-fallback-${pendingFallbackAttempts}`,
            sessionId
        );

        if (success && pendingInitialOpenSession === sessionId) {
            pendingInitialOpenSession = null;
            pendingInitialOpenStartedAt = null;
            return;
        }

        if (pendingInitialOpenSession === sessionId) {
            scheduleFallbackRender(sessionId, 1500);
        }
    }, delayMs);
}

async function renderOverviewAndEmit(
    reason: string,
    openSessionId: string | null = null
) {
    if (!glyphOverviewInstance) {
        return false;
    }

    if (initialRenderInProgress) {
        queuedRenderRequest = { reason, openSessionId };
        return false;
    }

    initialRenderInProgress = true;
    const renderOverviewSpanId = timelineSpanStartSafe(
        'overview.renderAndEmit',
        {
            reason,
            openSessionId,
            glyphCount: window.currentFontModel?.glyphs?.length || 0
        }
    );
    const renderStart = performance.now();
    let success = false;

    try {
        // Force the single open paint while the gate is still closed, then open
        // the gate for subsequent location-driven updates.
        await glyphOverviewInstance.renderGlyphOutlines(
            resolveCurrentOverviewLocation(),
            { force: true }
        );
        success = true;

        const renderDurationMs = performance.now() - renderStart;
        const totalElapsedMs =
            pendingInitialOpenStartedAt !== null
                ? performance.now() - pendingInitialOpenStartedAt
                : null;
        const glyphCount = window.currentFontModel?.glyphs?.length || 0;

        console.log(
            '[OverviewView]',
            `Overview rendered (${glyphCount} glyphs, reason: ${reason}, render: ${renderDurationMs.toFixed(2)}ms)`
        );

        // Apply the active filter before scrolling so visibility matches the
        // current glyph filter (URL edit-mode restore often marks the glyph
        // before overview tiles exist).
        await refreshFilterPlugins();

        // Capture deferred style/layout/paint work that lands after JS handlers
        // (common with very large tile counts).
        const settleSpanId = timelineSpanStartSafe(
            'overview.postMutationSettle',
            {
                reason,
                glyphCount
            }
        );
        await waitForNextAnimationFrame();
        await waitForNextAnimationFrame();
        timelineSpanEndSafe(settleSpanId);

        glyphOverviewInstance.syncActiveGlyphFocus?.({ forceScroll: true });
        glyphOverviewInstance.setOutlinePaintAllowed?.(true);

        if (openSessionId) {
            window.dispatchEvent(
                new CustomEvent('overviewInitialRenderComplete', {
                    detail: {
                        openSessionId,
                        reason,
                        glyphCount,
                        renderDurationMs,
                        totalElapsedMs
                    }
                })
            );
        }
    } catch (error) {
        console.error('[OverviewView]', 'Failed to render glyphs:', error);
    } finally {
        timelineSpanEndSafe(renderOverviewSpanId);
        initialRenderInProgress = false;

        if (queuedRenderRequest) {
            const request = queuedRenderRequest;
            queuedRenderRequest = null;
            setTimeout(() => {
                void renderOverviewAndEmit(
                    request.reason,
                    request.openSessionId
                );
            }, 0);
        }
    }

    return success;
}

async function initOverviewView() {
    const overviewContent = document.querySelector(
        '#view-overview .view-content'
    ) as HTMLElement | null;
    if (overviewContent) {
        // Create main container with flexbox layout
        const mainContainer = document.createElement('div');
        mainContainer.style.display = 'flex';
        mainContainer.style.width = '100%';
        mainContainer.style.height = '100%';
        mainContainer.style.overflow = 'hidden';

        // Create left sidebar (uses consolidated sidebar styles)
        const leftSidebar = document.createElement('div');
        leftSidebar.id = 'overview-sidebar';
        leftSidebar.className = 'view-sidebar view-sidebar-left';

        // Create filter sidebar container
        const filterSidebarContainer = document.createElement('div');
        filterSidebarContainer.id = 'overview-filters';
        leftSidebar.appendChild(filterSidebarContainer);

        // Create main content area with flex column layout
        const mainContent = document.createElement('div');
        mainContent.id = 'overview-main';
        mainContent.style.flex = '1';
        mainContent.style.height = '100%';
        mainContent.style.position = 'relative';
        mainContent.style.overflow = 'hidden';
        mainContent.style.display = 'flex';
        mainContent.style.flexDirection = 'column';

        // Create group legend container (hidden by default, shown when filter has groups)
        const groupLegendContainer = document.createElement('div');
        groupLegendContainer.id = 'overview-group-legend';
        groupLegendContainer.className = 'glyph-filter-legend';
        groupLegendContainer.style.display = 'none';
        mainContent.appendChild(groupLegendContainer);

        // Create glyph container that will hold the glyph overview
        const glyphContainer = document.createElement('div');
        glyphContainer.id = 'overview-glyph-container';
        glyphContainer.style.flex = '1';
        glyphContainer.style.overflow = 'hidden';
        glyphContainer.style.position = 'relative';
        glyphContainer.style.minHeight = '0';
        mainContent.appendChild(glyphContainer);

        // Property panel at the bottom (mirrors editing-view glyph-property-panel)
        const propertyPanel = document.createElement('div');
        propertyPanel.id = 'overview-property-panel';
        propertyPanel.className = 'glyph-property-panel';
        mainContent.appendChild(propertyPanel);

        // Initialize glyph overview in the glyph container
        if (window.GlyphOverview) {
            glyphOverviewInstance = new window.GlyphOverview(glyphContainer);
            window.glyphOverviewInstance = glyphOverviewInstance;
            if (
                typeof glyphOverviewInstance.attachPropertyPanel === 'function'
            ) {
                glyphOverviewInstance.attachPropertyPanel(propertyPanel);
            }

            // Populate with current font glyphs if available.
            // Outline paint waits for fontReady so startup location/state settle first.
            if (window.currentFontModel?.glyphs) {
                await updateOverviewTiles();
            }
        } else {
            console.warn(
                '[OverviewView]',
                'GlyphOverview class not available yet'
            );
        }

        // Initialize filter manager with sidebar and glyph overview
        if (glyphOverviewInstance && window.glyphOverviewFilterManager) {
            window.glyphOverviewFilterManager.initialize(
                filterSidebarContainer,
                glyphOverviewInstance,
                groupLegendContainer
            );
        }

        // Assemble layout (sidebar, main content)
        mainContainer.appendChild(leftSidebar);
        mainContainer.appendChild(mainContent);
        overviewContent.appendChild(mainContainer);

        const overviewView = document.getElementById('view-overview');
        if (overviewView) {
            attachTopRowSidebarInterpolation(overviewView);
        }

        // Observe when the overview view gains/loses focus (via 'focused' class)
        // CSS handles sidebar background color changes based on .view.focused
        const overviewViewElement = document.querySelector('#view-overview');
        if (overviewViewElement) {
            let wasCollapsed: boolean | null = null;
            const updateCollapsedState = () => {
                const isCollapsed =
                    overviewViewElement.classList.contains('collapsed-width');
                // Hide entire container when view is collapsed
                mainContainer.style.display = isCollapsed ? 'none' : 'flex';

                if (
                    wasCollapsed === true &&
                    !isCollapsed &&
                    glyphOverviewInstance &&
                    window.currentFontModel?.glyphs
                ) {
                    void (async () => {
                        await renderOverviewAndEmit('view-opened');
                    })();
                }

                wasCollapsed = isCollapsed;
            };

            const observer = new MutationObserver(
                (mutations: MutationRecord[]) => {
                    mutations.forEach((mutation: MutationRecord) => {
                        if (
                            mutation.type === 'attributes' &&
                            mutation.attributeName === 'class'
                        ) {
                            updateCollapsedState();
                        }
                    });
                }
            );
            observer.observe(overviewViewElement, {
                attributes: true,
                attributeFilter: ['class']
            });

            // Set initial state
            updateCollapsedState();
        }

        console.log('[OverviewView]', 'Overview view initialized with sidebar');
    } else {
        setTimeout(initOverviewView, 100);
    }
}

// Update glyph overview when font is ready (one tile rebuild + paint per open)
const queueOverviewRefresh = (
    spanId: string,
    reason: string,
    openSessionId: string | null,
    openedAt: number | null
) => {
    pendingInitialOpenSession = openSessionId;
    pendingInitialOpenStartedAt = openedAt;
    pendingFallbackAttempts = 0;

    setTimeout(async () => {
        try {
            if (glyphOverviewInstance && window.currentFontModel?.glyphs) {
                glyphOverviewInstance.setOutlinePaintAllowed?.(false);

                const glyphData = await updateOverviewTiles();
                const renderReason =
                    openSessionId !== null
                        ? `${reason}-open-session`
                        : `${reason}-no-session`;
                const renderSuccess = await renderOverviewAndEmit(
                    renderReason,
                    openSessionId
                );

                if (
                    renderSuccess &&
                    openSessionId &&
                    pendingInitialOpenSession === openSessionId
                ) {
                    pendingInitialOpenSession = null;
                    pendingInitialOpenStartedAt = null;
                } else if (
                    !renderSuccess &&
                    pendingInitialOpenSession &&
                    !initialRenderInProgress
                ) {
                    scheduleFallbackRender(pendingInitialOpenSession, 1200);
                }

                console.log(
                    '[OverviewView]',
                    `Updated glyph overview tiles (${glyphData.length})`
                );
            }
        } finally {
            timelineSpanEndSafe(spanId);
        }
    }, 100);
};

window.addEventListener('fontReady', (event: Event) => {
    const detail =
        (event as CustomEvent<{ openSessionId?: string; openedAt?: number }>)
            .detail || {};

    console.log('[OverviewView]', 'Font ready, updating overview');
    const spanId = timelineSpanStartSafe('overview.fontReadyHandler');
    queueOverviewRefresh(
        spanId,
        'fontReady',
        detail.openSessionId || null,
        typeof detail.openedAt === 'number' ? detail.openedAt : null
    );
});

window.addEventListener('settingsFolderAccessChanged', async () => {
    await refreshOverviewSidebarForSettingsFolderAccessChange();
});

window.addEventListener('folderSetupStatusChanged', async () => {
    await refreshOverviewSidebarForSettingsFolderAccessChange();
});

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initOverviewView);
} else {
    initOverviewView();
}
