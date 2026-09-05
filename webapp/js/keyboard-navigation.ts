import { getClosestExpandedTopRowViewId } from './view-focus';
import { setFocusViewId } from './window-ui-state';
import {
    isTourBlockingViewShortcuts,
    isTourCmdEscapeAllowed,
    isTourKeyEventAllowed,
    isViewShortcutAllowedDuringTour,
    consumeAllowedTourViewShortcut
} from './tour-spotlight';

// Keyboard Navigation System
(function () {
    let currentFocusedView: string | null = null;
    let isFocusing = false; // Prevent recursive focus calls
    // Latest focus requested while isFocusing is held (including the short
    // post-focus lock). Dropping these caused Docs to open without .focused
    // when openDocs raced closeDocs → focusView(editor).
    let pendingFocus: {
        viewId: string;
        viaKeyboard: boolean;
        options?: { skipExpand?: boolean };
    } | null = null;

    type ResizeConfig = { width: number; height: number };
    type ViewRowKey = 'top' | 'bottom';
    type RowVisitOrder = Record<ViewRowKey, string[]>;

    let rowVisitOrder: RowVisitOrder = { top: [], bottom: [] };

    // Get view settings from the global VIEW_SETTINGS object
    function getViewSettings() {
        if (!window.VIEW_SETTINGS) {
            console.error(
                '[KeyboardNav]',
                '[KeyboardNav]',
                'VIEW_SETTINGS not loaded! Make sure view-settings.js is loaded before keyboard-navigation.js'
            );
            return null;
        }
        return window.VIEW_SETTINGS;
    }

    function getEditorView(): HTMLElement | null {
        return document.getElementById('view-editor');
    }

    function getEditorViewportFreezeWidth(): number {
        const freezeWidth = (
            window.glyphCanvas as
                | {
                      constructor?: {
                          COLLAPSED_EDITOR_VIEWPORT_FREEZE_WIDTH?: number;
                      };
                  }
                | null
                | undefined
        )?.constructor?.COLLAPSED_EDITOR_VIEWPORT_FREEZE_WIDTH;
        return typeof freezeWidth === 'number' ? freezeWidth : 96;
    }

    function isEditorViewportCollapsed(
        editor: HTMLElement | null = getEditorView()
    ): boolean {
        if (!editor) {
            return false;
        }
        return editor.offsetWidth <= getEditorViewportFreezeWidth();
    }

    function beginKeyboardEditorViewportPreservation(): void {
        window.glyphCanvas?.beginKeyboardViewportResizePreservation?.();
    }

    function endKeyboardEditorViewportPreservation(): void {
        window.glyphCanvas?.endKeyboardViewportResizePreservation?.();
    }

    /**
     * Match mouse-drag expand: after keyboard layout settles, restore any
     * frozen editor viewport and clamp the caret/bbox into view so the first
     * reopen stage cannot leave content invisible.
     */
    function finishKeyboardEditorViewportSession(
        editorWasCollapsed: boolean
    ): void {
        const editor = getEditorView();
        const shouldRestore =
            editorWasCollapsed &&
            editor &&
            !isEditorViewportCollapsed(editor) &&
            !!window.glyphCanvas?.collapsedViewportSnapshot;

        const endPreservation = () => {
            window.glyphCanvas?.ensureKeyboardResizeContentAnchorVisible?.();
            endKeyboardEditorViewportPreservation();
        };

        if (shouldRestore) {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    window.glyphCanvas?.restoreViewportAfterCollapse?.();
                    endPreservation();
                });
            });
            return;
        }

        endPreservation();
    }

    function scheduleKeyboardLayoutFinish(
        finish: () => void,
        editorWasCollapsed: boolean
    ): void {
        const settings = getViewSettings();
        const runFinish = () => {
            finish();
            finishKeyboardEditorViewportSession(editorWasCollapsed);
        };

        if (settings?.animation?.enabled) {
            setTimeout(runFinish, settings.animation.duration);
        } else {
            runFinish();
        }
    }

    function getRowKeyForView(view: HTMLElement): ViewRowKey | null {
        if (view.closest('.top-row')) {
            return 'top';
        }
        if (view.closest('.bottom-row')) {
            return 'bottom';
        }
        return null;
    }

    function getRowViews(rowKey: ViewRowKey): HTMLElement[] {
        const selector = rowKey === 'top' ? '.top-row' : '.bottom-row';
        const row = document.querySelector(selector) as HTMLElement | null;
        if (!row) {
            return [];
        }

        return Array.from(row.querySelectorAll('.view')) as HTMLElement[];
    }

    function createDefaultRowVisitOrder(): RowVisitOrder {
        return {
            top: getRowViews('top')
                .map((view) => view.id)
                .filter(Boolean),
            bottom: getRowViews('bottom')
                .map((view) => view.id)
                .filter(Boolean)
        };
    }

    function normalizeRowVisitOrder(
        order: Partial<RowVisitOrder> | null | undefined
    ): RowVisitOrder {
        const defaults = createDefaultRowVisitOrder();

        return {
            top: normalizeRowVisitOrderForKey(order?.top, defaults.top),
            bottom: normalizeRowVisitOrderForKey(order?.bottom, defaults.bottom)
        };
    }

    function normalizeRowVisitOrderForKey(
        visitIds: string[] | undefined,
        defaultIds: string[]
    ): string[] {
        const filteredIds = (visitIds || []).filter((id) =>
            defaultIds.includes(id)
        );
        const missingIds = defaultIds.filter((id) => !filteredIds.includes(id));

        return [...missingIds, ...filteredIds];
    }

    function getViewVisitOrder(): RowVisitOrder {
        return {
            top: [...rowVisitOrder.top],
            bottom: [...rowVisitOrder.bottom]
        };
    }

    function setViewVisitOrder(order: Partial<RowVisitOrder>) {
        rowVisitOrder = normalizeRowVisitOrder(order);
    }

    function recordViewVisit(viewId: string) {
        const view = document.getElementById(viewId) as HTMLElement | null;
        if (!view) {
            return;
        }

        const rowKey = getRowKeyForView(view);
        if (!rowKey) {
            return;
        }

        rowVisitOrder[rowKey] = rowVisitOrder[rowKey].filter(
            (id) => id !== viewId
        );
        rowVisitOrder[rowKey].push(viewId);
    }

    function getPreviousVisitedViewId(viewId: string): string | null {
        const view = document.getElementById(viewId) as HTMLElement | null;
        if (!view) {
            return null;
        }

        const rowKey = getRowKeyForView(view);
        if (!rowKey) {
            return null;
        }

        const previousVisits = rowVisitOrder[rowKey].filter(
            (id) => id !== viewId
        );
        return previousVisits.length > 0
            ? previousVisits[previousVisits.length - 1]
            : null;
    }

    function getViewMinimumWidth(view: HTMLElement): number {
        if (view.closest('.top-row')) {
            return 24;
        }
        return 100;
    }

    function getActivationMinimumWidth(rowKey: ViewRowKey): number {
        const settings = getViewSettings();
        const configuredMinimums = settings?.activation?.minimumWidths;

        if (!configuredMinimums) {
            return 0;
        }

        return rowKey === 'top'
            ? configuredMinimums.topRow
            : configuredMinimums.bottomRow;
    }

    function applyRowViewWidths(
        rowViews: HTMLElement[],
        widthsByViewId: Record<string, number>
    ) {
        const threshold = 5;
        const freezeWidth = getEditorViewportFreezeWidth();
        const editorView = rowViews.find(
            (rowView) => rowView.id === 'view-editor'
        );
        const editorWidthBefore = editorView?.offsetWidth ?? 0;
        const editorTargetWidth = editorView
            ? widthsByViewId['view-editor']
            : undefined;

        if (
            editorView &&
            typeof editorTargetWidth === 'number' &&
            editorWidthBefore > freezeWidth &&
            editorTargetWidth <= freezeWidth
        ) {
            window.glyphCanvas?.freezeViewportForCollapse?.();
        }

        rowViews.forEach((rowView) => {
            const nextWidth = widthsByViewId[rowView.id];
            if (nextWidth === undefined) {
                return;
            }

            const minWidth = getViewMinimumWidth(rowView);
            const collapseToTab =
                nextWidth <= minWidth + threshold &&
                !!rowView.closest('.top-row');
            if (collapseToTab) {
                rowView.style.flex = `0 0 ${minWidth}px`;
                rowView.classList.add('collapsed-width');
                rowView.classList.remove('collapsed');
                return;
            }

            // Open flex must drop leftover collapsed-width immediately.
            // Waiting for the activation animation timeout leaves
            // `.view-content { display:none }`, so the canvas hole is 0×0
            // and the full-window bitmap paints over Overview.
            rowView.style.flex = `${nextWidth} 1 0%`;
            rowView.classList.remove('collapsed-width', 'collapsed');
        });
    }

    function getTopRowReplacementFocusViewId(viewId: string): string | null {
        return getClosestExpandedTopRowViewId(viewId);
    }

    function getProtectedDonorWidth(
        donor: HTMLElement,
        rowKey: ViewRowKey
    ): number {
        const collapsedMin = getViewMinimumWidth(donor);
        const isExpanded = donor.offsetWidth > collapsedMin + 5;
        if (isExpanded && rowKey === 'top') {
            return Math.max(collapsedMin, getActivationMinimumWidth(rowKey));
        }
        return collapsedMin;
    }

    function ensureActivationMinimumWidth(viewId: string): boolean {
        const activeView = document.getElementById(
            viewId
        ) as HTMLElement | null;
        if (!activeView) {
            return false;
        }

        const rowKey = getRowKeyForView(activeView);
        if (!rowKey) {
            return false;
        }

        const rowViews = getRowViews(rowKey);
        const activeWidth = activeView.offsetWidth;
        const targetWidth = getActivationMinimumWidth(rowKey);
        let neededWidth = targetWidth - activeWidth;
        if (neededWidth <= 0) {
            return false;
        }

        const widthsByViewId = rowViews.reduce<Record<string, number>>(
            (widths, rowView) => {
                widths[rowView.id] = rowView.offsetWidth;
                return widths;
            },
            {}
        );

        const previousDonorId = getPreviousVisitedViewId(viewId);
        const donorIds = [
            previousDonorId,
            'view-editor',
            ...rowViews.map((rowView) => rowView.id)
        ].filter((donorId, index, ids): donorId is string => {
            return (
                !!donorId &&
                donorId !== viewId &&
                ids.indexOf(donorId) === index &&
                rowViews.some((rowView) => rowView.id === donorId)
            );
        });

        for (const donorId of donorIds) {
            if (neededWidth <= 0) {
                break;
            }

            const donorView = document.getElementById(donorId) as HTMLElement;
            const spareWidth = Math.max(
                0,
                widthsByViewId[donorId] -
                    getProtectedDonorWidth(donorView, rowKey)
            );
            const takenWidth = Math.min(neededWidth, spareWidth);
            if (takenWidth <= 0) {
                continue;
            }

            widthsByViewId[viewId] += takenWidth;
            widthsByViewId[donorId] -= takenWidth;
            neededWidth -= takenWidth;
        }

        if (widthsByViewId[viewId] <= activeWidth) {
            return false;
        }

        applyRowViewWidths(rowViews, widthsByViewId);
        return true;
    }

    /**
     * Update collapsed states on views after resize
     */
    function updateCollapsedStates() {
        if (
            window.resizableViews &&
            window.resizableViews.updateCollapsedStates
        ) {
            window.resizableViews.updateCollapsedStates();
        }
    }

    /**
     * Expand view on activation if it's below threshold
     * Returns true if expansion was performed
     */
    function expandViewOnActivation(viewId: string) {
        if (viewId === 'view-docs') {
            return false;
        }

        const settings = getViewSettings();
        if (!settings || !settings.activation) return false;

        const view = document.getElementById(viewId);
        if (!view) return false;

        const container = document.querySelector('.container') as HTMLElement;
        const containerHeight = container.offsetHeight;
        const horizontalDividerHeight = 4;
        const availableHeight = containerHeight - horizontalDividerHeight;

        const isTopRow = view.closest('.top-row') !== null;
        const isBottomRow = view.closest('.bottom-row') !== null;
        const editorWasCollapsed = isEditorViewportCollapsed();
        let preservationArmed = false;

        const armPreservation = () => {
            if (preservationArmed) {
                return;
            }
            beginKeyboardEditorViewportPreservation();
            preservationArmed = true;
        };

        // Enable transitions if configured
        if (settings.animation && settings.animation.enabled) {
            enableTransitions(
                settings.animation.duration,
                settings.animation.easing
            );
        }

        let expanded = false;

        if (isTopRow || isBottomRow) {
            if (ensureActivationMinimumWidth(viewId)) {
                armPreservation();
                expanded = true;
            }
        }

        if (isTopRow) {
            const config = settings.activation.editor;
            const topRow = view.closest('.top-row') as HTMLElement;
            const currentHeight = topRow.offsetHeight;
            const heightRatio = currentHeight / availableHeight;

            if (heightRatio < config.heightThreshold) {
                // Expand height
                const targetHeight = availableHeight * config.heightTarget;
                const bottomRow = document.querySelector(
                    '.bottom-row'
                ) as HTMLElement;
                const bottomHeight = availableHeight - targetHeight;

                if (bottomHeight >= 24) {
                    armPreservation();
                    // Check if bottom row is at minimum (collapsed)
                    if (Math.abs(bottomHeight - 24) < 5) {
                        topRow.style.flex = `1`;
                        bottomRow.style.flex = `0 0 24px`;
                    } else {
                        topRow.style.flex = `${targetHeight / availableHeight}`;
                        bottomRow.style.flex = `${bottomHeight / availableHeight}`;
                    }
                    expanded = true;
                }
            }
        } else if (isBottomRow) {
            // Secondary views in bottom row - expand by height if below threshold
            const config = settings.activation.secondary;
            const bottomRow = view.closest('.bottom-row') as HTMLElement;
            const topRow = document.querySelector('.top-row') as HTMLElement;

            const currentHeight = bottomRow.offsetHeight;
            const heightRatio = currentHeight / availableHeight;

            if (heightRatio < config.heightThreshold) {
                // Expand height
                const targetHeight = availableHeight * config.heightTarget;
                const topHeight = availableHeight - targetHeight;

                if (topHeight >= 200) {
                    armPreservation();
                    // Ensure top row keeps editor min size
                    topRow.style.flex = `${topHeight / availableHeight}`;
                    bottomRow.style.flex = `${targetHeight / availableHeight}`;
                    expanded = true;
                }
            }
        }

        // Disable transitions and update collapsed states after animation
        if (preservationArmed) {
            scheduleKeyboardLayoutFinish(() => {
                disableTransitions();
                updateCollapsedStates();
                if (window.resizableViews) {
                    window.resizableViews.saveLayout();
                }
            }, editorWasCollapsed);
        } else if (settings.animation && settings.animation.enabled) {
            setTimeout(() => {
                disableTransitions();
            }, settings.animation.duration);
        } else {
            updateCollapsedStates();
            if (window.resizableViews) {
                window.resizableViews.saveLayout();
            }
        }

        return expanded;
    }

    /**
     * Resize a view based on secondary shortcut behavior
     * - Top row: small (activation min) → larger (~50%) → max
     * - Bottom row 'expandToTarget': expand to resize target if smaller
     */
    function resizeView(viewId: string) {
        const settings = getViewSettings();
        if (!settings) return;

        const shortcutConfig = settings.shortcuts[viewId];
        if (!shortcutConfig) return;

        const secondaryBehavior = shortcutConfig.secondaryBehavior;
        if (!secondaryBehavior) {
            console.log(
                '[KeyboardNav]',
                'No secondary behavior for view:',
                viewId
            );
            return;
        }

        const view = document.getElementById(viewId);
        if (!view) return;

        const container = document.querySelector('.container') as HTMLElement;
        const containerWidth = container.offsetWidth;
        const containerHeight = container.offsetHeight;
        const horizontalDividerHeight = 4;
        const availableHeight = containerHeight - horizontalDividerHeight;
        const editorWasCollapsed = isEditorViewportCollapsed();
        let didLayoutChange = false;

        beginKeyboardEditorViewportPreservation();

        // Enable transitions if configured
        if (settings.animation && settings.animation.enabled) {
            enableTransitions(
                settings.animation.duration,
                settings.animation.easing
            );
        }

        const isTopRow = view.closest('.top-row') !== null;
        const isBottomRow = view.closest('.bottom-row') !== null;

        // Title bar size constant (matches resizer.js)
        const TITLE_BAR_SIZE = 24;

        if (isTopRow) {
            const largerWidthRatio =
                settings.activation.fontinfo.widthTargetSecondary;
            const largerHeightRatio = settings.activation.editor.heightTarget;
            const currentWidth = view.offsetWidth;
            const widthTolerance = containerWidth * 0.05;
            const isAtOrPastLarger =
                currentWidth >=
                containerWidth * largerWidthRatio - widthTolerance;

            const topRow = view.closest('.top-row') as HTMLElement;
            const topRowViews = Array.from(topRow.querySelectorAll('.view'));
            const otherTopRowViews = topRowViews.filter((v) => v !== view);
            const fullMaxWidthRatio =
                (containerWidth - TITLE_BAR_SIZE * otherTopRowViews.length) /
                containerWidth;
            const fontInfoMaxWidth = settings.activation.fontinfo.maxWidth;
            const maxWidthRatio =
                viewId === 'view-fontinfo' &&
                typeof fontInfoMaxWidth === 'number'
                    ? Math.min(fullMaxWidthRatio, fontInfoMaxWidth)
                    : fullMaxWidthRatio;
            const maxHeightRatio =
                (availableHeight - TITLE_BAR_SIZE) / availableHeight;
            const isMaximized =
                currentWidth / containerWidth >= maxWidthRatio - 0.05 &&
                topRow.offsetHeight / availableHeight >= maxHeightRatio - 0.05;
            const collapseOtherViews = viewId !== 'view-fontinfo';

            if (!isAtOrPastLarger) {
                resizeTopRowView(
                    viewId,
                    view,
                    {
                        width: largerWidthRatio,
                        height: largerHeightRatio
                    },
                    containerWidth,
                    containerHeight,
                    false
                );
                didLayoutChange = true;
            } else if (!isMaximized) {
                resizeTopRowView(
                    viewId,
                    view,
                    {
                        width: maxWidthRatio,
                        height: maxHeightRatio
                    },
                    containerWidth,
                    containerHeight,
                    collapseOtherViews
                );
                didLayoutChange = true;
            }
        } else if (secondaryBehavior === 'expandToTarget') {
            if (isBottomRow) {
                // Bottom row secondary views - expand height and width to resize target
                const resizeConfig = settings.resize[viewId];
                const bottomRow = view.closest('.bottom-row') as HTMLElement;
                const topRow = document.querySelector(
                    '.top-row'
                ) as HTMLElement;
                const views = Array.from(
                    bottomRow.querySelectorAll('.view')
                ) as HTMLElement[];
                const viewIndex = views.indexOf(view);

                if (resizeConfig) {
                    // Expand height if smaller than resize target
                    const currentHeight = bottomRow.offsetHeight;
                    const targetHeight = availableHeight * resizeConfig.height;

                    if (currentHeight < targetHeight) {
                        const topHeight = availableHeight - targetHeight;

                        if (topHeight >= 200) {
                            topRow.style.flex = `${topHeight / availableHeight}`;
                            bottomRow.style.flex = `${targetHeight / availableHeight}`;
                            didLayoutChange = true;
                        }
                    }

                    // Expand width if smaller than resize target
                    const currentWidth = view.offsetWidth;
                    const targetWidth = containerWidth * resizeConfig.width;

                    if (currentWidth < targetWidth && views.length > 1) {
                        const remainingWidth = containerWidth - targetWidth;
                        const otherViewsCount = views.length - 1;
                        const remainingWidthPerView =
                            remainingWidth / otherViewsCount;

                        if (remainingWidthPerView >= 100) {
                            const widths: Record<number, number> = {};
                            views.forEach((v, i) => {
                                widths[i] =
                                    i === viewIndex
                                        ? targetWidth
                                        : remainingWidthPerView;
                            });

                            const totalWidth = Object.values(widths).reduce(
                                (sum, w) => sum + w,
                                0
                            );
                            views.forEach((v, i) => {
                                v.style.flex = `${widths[i] / totalWidth}`;
                            });
                            didLayoutChange = true;
                        }
                    }
                }
            }
        }

        if (!didLayoutChange) {
            endKeyboardEditorViewportPreservation();
            if (settings.animation && settings.animation.enabled) {
                disableTransitions();
            }
            return;
        }

        // Disable transitions and update collapsed states after animation completes
        scheduleKeyboardLayoutFinish(() => {
            disableTransitions();
            updateCollapsedStates();
            if (window.resizableViews) {
                window.resizableViews.saveLayout();
            }
            window.dispatchEvent(
                new CustomEvent('viewResized', { detail: { viewId } })
            );
            if (viewId === 'view-editor') {
                transferViewDomFocus('view-editor', true, false);
            }
        }, editorWasCollapsed);
    }

    /**
     * Enable CSS transitions for smooth resizing
     */
    function enableTransitions(duration: number, easing: string) {
        const transition = `flex ${duration}ms ${easing}`;

        // Apply to all views and rows
        document
            .querySelectorAll('.view, .top-row, .bottom-row')
            .forEach((element: Element) => {
                (element as HTMLElement).style.transition = transition;
            });
    }

    /**
     * Disable CSS transitions
     */
    function disableTransitions() {
        document
            .querySelectorAll('.view, .top-row, .bottom-row')
            .forEach((element: Element) => {
                (element as HTMLElement).style.transition = '';
            });
    }

    /**
     * Collapse the active view completely
     */
    function collapseActiveView(viewId: string) {
        console.log('[KeyboardNav]', 'collapseActiveView called for:', viewId);
        if (viewId === 'view-docs') {
            window.closeDocs();
            return;
        }
        const view = document.getElementById(viewId);
        if (!view) {
            console.log('[KeyboardNav]', 'Aborting - view not found');
            return;
        }

        const isTopRow = view.closest('.top-row') !== null;
        const isBottomRow = view.closest('.bottom-row') !== null;

        console.log(
            '[KeyboardNav]',
            'View location - topRow:',
            isTopRow,
            'bottomRow:',
            isBottomRow
        );

        const container = document.querySelector('.container') as HTMLElement;
        const containerWidth = container.offsetWidth;
        const containerHeight = container.offsetHeight;
        const horizontalDividerHeight = 4;
        const availableHeight = containerHeight - horizontalDividerHeight;
        const editorWasCollapsed = isEditorViewportCollapsed();

        beginKeyboardEditorViewportPreservation();

        const settings = getViewSettings();
        if (settings && settings.animation && settings.animation.enabled) {
            enableTransitions(
                settings.animation.duration,
                settings.animation.easing
            );
        }

        if (isTopRow) {
            // Collapse width to minimum (24px for top-row views)
            const topRow = view.closest('.top-row') as HTMLElement;
            const views = Array.from(
                topRow.querySelectorAll('.view')
            ) as HTMLElement[];
            const viewIndex = views.indexOf(view);
            const minWidth = getViewMinimumWidth(view); // Minimum collapsed width
            const replacementFocusViewId =
                getTopRowReplacementFocusViewId(viewId);

            const currentWidth = view.offsetWidth;
            const freedSpace = currentWidth - minWidth;

            console.log(
                '[KeyboardNav]',
                'Collapsing view, current:',
                currentWidth,
                'freed:',
                freedSpace
            );

            // Find non-collapsed views (excluding the one being collapsed)
            const otherViews = views.filter(
                (v, i) => i !== viewIndex
            ) as HTMLElement[];
            const nonCollapsedOtherViews = otherViews.filter(
                (v) => v.offsetWidth > getViewMinimumWidth(v) + 5
            );

            if (nonCollapsedOtherViews.length === 0) {
                console.log(
                    '[KeyboardNav]',
                    'No other non-collapsed views to expand'
                );
                endKeyboardEditorViewportPreservation();
                return;
            }

            if (viewId === 'view-editor') {
                window.glyphCanvas?.freezeViewportForCollapse?.();
            }

            // Distribute freed space proportionally among non-collapsed other views
            const totalOtherWidth = nonCollapsedOtherViews.reduce(
                (sum, v) => sum + v.offsetWidth,
                0
            );

            views.forEach((v, i) => {
                if (i === viewIndex) {
                    // Collapse this view to exactly 24px
                    v.style.flex = `0 0 ${minWidth}px`;
                } else if (v.offsetWidth <= getViewMinimumWidth(v) + 5) {
                    // Keep already-collapsed views at exactly 24px
                    v.style.flex = `0 0 ${getViewMinimumWidth(v)}px`;
                } else {
                    // Expand non-collapsed views proportionally
                    const proportion = v.offsetWidth / totalOtherWidth;
                    const newWidth = v.offsetWidth + freedSpace * proportion;
                    v.style.flex = `${newWidth}`;
                }
            });

            if (viewId === currentFocusedView && replacementFocusViewId) {
                focusView(replacementFocusViewId);
            }
        } else if (isBottomRow) {
            // Collapse bottom row to minimum height (title bar height)
            const topRow = document.querySelector('.top-row') as HTMLElement;
            const bottomRow = view.closest('.bottom-row') as HTMLElement;
            const minBottomHeight = 24; // Title bar height - same as SECONDARY_MIN_HEIGHT

            const currentBottomHeight = bottomRow.offsetHeight;
            const freedSpace = currentBottomHeight - minBottomHeight;

            console.log(
                '[KeyboardNav]',
                'Collapsing bottom row, current:',
                currentBottomHeight,
                'min:',
                minBottomHeight,
                'freed:',
                freedSpace
            );

            // Use fixed pixel height for collapsed bottom row
            topRow.style.flex = `1`;
            bottomRow.style.flex = `0 0 ${minBottomHeight}px`;
        }

        // Disable transitions and update collapsed states after animation completes
        scheduleKeyboardLayoutFinish(() => {
            disableTransitions();
            updateCollapsedStates();
            if (window.resizableViews) {
                window.resizableViews.saveLayout();
            }
            // Focus editor only if we collapsed a currently active bottom-row view
            if (
                viewId === currentFocusedView &&
                isBottomRow &&
                viewId !== 'view-editor'
            ) {
                focusView('view-editor');
            }
            // Notify view title buttons to update
            window.dispatchEvent(
                new CustomEvent('viewResized', { detail: { viewId } })
            );
        }, editorWasCollapsed);
    }

    /**
     * Resize a view in the top row
     * @param {boolean} forceResize - If true, resize even if target is smaller than current
     */
    function resizeTopRowView(
        viewId: string,
        view: HTMLElement,
        resizeConfig: ResizeConfig,
        containerWidth: number,
        containerHeight: number,
        forceResize = false
    ) {
        const topRow = view.closest('.top-row') as HTMLElement;
        const views = Array.from(
            topRow.querySelectorAll('.view')
        ) as HTMLElement[];
        const viewIndex = views.indexOf(view);

        if (viewIndex === -1) return;

        // Calculate target dimensions
        const horizontalDividerHeight = 4;
        const availableHeight = containerHeight - horizontalDividerHeight;
        const targetViewWidth = containerWidth * resizeConfig.width;
        const targetViewHeight = availableHeight * resizeConfig.height;

        // Get current dimensions
        const currentWidth = view.offsetWidth;
        const currentHeight = topRow.offsetHeight;

        // Resize if target is larger than current, or if forceResize is true
        const shouldResizeWidth = forceResize || targetViewWidth > currentWidth;
        const shouldResizeHeight =
            forceResize || targetViewHeight > currentHeight;

        console.log('[KeyboardNav]', 'resizeTopRowView:', {
            viewId,
            forceResize,
            currentWidth,
            targetViewWidth,
            shouldResizeWidth,
            currentHeight,
            targetViewHeight,
            shouldResizeHeight
        });

        // Handle width resizing
        if (shouldResizeWidth && views.length > 1) {
            const otherViews = views.filter((v, i) => i !== viewIndex);
            const totalOtherWidth = containerWidth - targetViewWidth;
            const fontinfoMinWidth =
                window.resizableViews?.constructor?.FONTINFO_MIN_WIDTH || 24;
            const minWidthPerOther = fontinfoMinWidth;

            if (totalOtherWidth >= minWidthPerOther * otherViews.length) {
                // When forceResize is true (maximizing), collapse all other views
                // Otherwise, separate based on current collapsed state
                let collapsedViews: HTMLElement[],
                    nonCollapsedViews: HTMLElement[];

                if (forceResize) {
                    // Maximize mode: treat all other views as collapsed
                    collapsedViews = otherViews;
                    nonCollapsedViews = [];
                } else {
                    // Normal resize: separate based on current width
                    collapsedViews = otherViews.filter(
                        (v: HTMLElement) =>
                            v.offsetWidth <= fontinfoMinWidth + 5
                    ); // 5px tolerance
                    nonCollapsedViews = otherViews.filter(
                        (v: HTMLElement) => v.offsetWidth > fontinfoMinWidth + 5
                    );
                }

                // Reserve width for collapsed views
                const collapsedWidth = collapsedViews.length * fontinfoMinWidth;
                const availableForDistribution =
                    totalOtherWidth - collapsedWidth;

                // Set flex for the target view
                view.style.flex = `${targetViewWidth}`;

                // Set collapsed views to fixed pixel width
                collapsedViews.forEach((v) => {
                    v.style.flex = `0 0 ${fontinfoMinWidth}px`;
                });

                // Distribute remaining width to non-collapsed views as ratios
                if (nonCollapsedViews.length > 0) {
                    const nonCollapsedViewWidth =
                        availableForDistribution / nonCollapsedViews.length;
                    nonCollapsedViews.forEach((v) => {
                        v.style.flex = `${nonCollapsedViewWidth}`;
                    });
                }
            }
        }

        // Handle height resizing
        if (shouldResizeHeight) {
            const bottomRow = document.querySelector(
                '.bottom-row'
            ) as HTMLElement;
            const bottomTargetHeight = availableHeight - targetViewHeight;

            if (bottomTargetHeight >= 24) {
                // Check if bottom row is at minimum (collapsed)
                if (Math.abs(bottomTargetHeight - 24) < 5) {
                    topRow.style.flex = `1`;
                    bottomRow.style.flex = `0 0 24px`;
                } else {
                    const topFlex = targetViewHeight / availableHeight;
                    const bottomFlex = bottomTargetHeight / availableHeight;

                    topRow.style.flex = `${topFlex}`;
                    bottomRow.style.flex = `${bottomFlex}`;
                }
            }
        }
    }

    /**
     * Resize a view in the bottom row
     */
    /**
     * Resize a view in the bottom row
     * @param {boolean} forceResize - If true, resize even if target is smaller than current
     */
    function resizeBottomRowView(
        viewId: string,
        view: HTMLElement,
        resizeConfig: ResizeConfig,
        containerWidth: number,
        containerHeight: number,
        forceResize = false
    ) {
        const bottomRow = view.closest('.bottom-row') as HTMLElement;
        const topRow = document.querySelector('.top-row') as HTMLElement;
        const views = Array.from(
            bottomRow.querySelectorAll('.view')
        ) as HTMLElement[];
        const viewIndex = views.indexOf(view);

        if (viewIndex === -1) return;

        // Calculate target dimensions
        const horizontalDividerHeight = 4;
        const availableHeight = containerHeight - horizontalDividerHeight;
        const targetBottomHeight = availableHeight * resizeConfig.height;
        const targetViewWidth = containerWidth * resizeConfig.width;

        // Get current dimensions
        const currentBottomHeight = bottomRow.offsetHeight;
        const currentWidth = view.offsetWidth;

        // Resize if target is larger than current, or if forceResize is true
        const shouldResizeHeight =
            forceResize || targetBottomHeight > currentBottomHeight;
        const shouldResizeWidth = forceResize || targetViewWidth > currentWidth;

        // Handle height resizing (affects top/bottom split)
        if (shouldResizeHeight) {
            const topTargetHeight = availableHeight - targetBottomHeight;

            if (topTargetHeight >= 200) {
                // Check if bottom row is at minimum (collapsed)
                if (Math.abs(targetBottomHeight - 24) < 5) {
                    topRow.style.flex = `1`;
                    bottomRow.style.flex = `0 0 24px`;
                } else {
                    // Ensure minimum height for top row (editor)
                    const topFlex = topTargetHeight / availableHeight;
                    const bottomFlex = targetBottomHeight / availableHeight;

                    topRow.style.flex = `${topFlex}`;
                    bottomRow.style.flex = `${bottomFlex}`;
                }
            }
        }

        // Handle width resizing (affects bottom row column distribution)
        if (shouldResizeWidth && views.length > 1) {
            const remainingWidth = containerWidth - targetViewWidth;
            const otherViewsCount = views.length - 1;
            const remainingWidthPerView = remainingWidth / otherViewsCount;

            if (remainingWidthPerView >= 100) {
                // Ensure minimum width for other views
                const widths: Record<number, number> = {};

                // Distribute width to all views
                views.forEach((v, i) => {
                    if (i === viewIndex) {
                        // Set target width for the selected view
                        widths[i] = targetViewWidth;
                    } else {
                        // Distribute remaining width equally among ALL other views (left and right)
                        widths[i] = remainingWidthPerView;
                    }
                });

                // Calculate total width for flex calculation
                const totalWidth = Object.values(widths).reduce(
                    (sum, w) => sum + w,
                    0
                );

                // Apply flex values to ALL views in the bottom row
                views.forEach((v, i) => {
                    const flexValue = widths[i] / totalWidth;
                    v.style.flex = `${flexValue} 1 0%`;
                    console.log(
                        '[KeyboardNav]',
                        `View ${i} (${v.id}): flex = ${flexValue.toFixed(3)}, width = ${widths[i].toFixed(0)}px`
                    );
                });
            }
        }
    }

    /**
     * Blur the console terminal cursor
     */
    function blurConsole() {
        // Preserve scroll position when blurring (jQuery Terminal may auto-scroll on blur)
        const terminalScroller = document.querySelector(
            '#console-container .terminal-scroller'
        );
        const scrollBefore = terminalScroller ? terminalScroller.scrollTop : 0;

        // jQuery Terminal focuses a hidden .cmd-clipboard textarea (not only
        // .cmd textarea/input). Blur every known console focus target.
        document
            .querySelectorAll(
                '#console-container .cmd-clipboard, #console-container .cmd textarea, #console-container .cmd input, #console-container .terminal, .cmd-clipboard, .cmd textarea, .cmd input'
            )
            .forEach((el) => (el as HTMLElement).blur());

        // Also blur whatever is currently focused inside the console container.
        const consoleContainer = document.getElementById('console-container');
        if (
            consoleContainer &&
            consoleContainer.contains(document.activeElement)
        ) {
            (document.activeElement as HTMLElement | null)?.blur();
        }

        // Restore scroll position after blur (in case jQuery Terminal scrolled)
        if (terminalScroller) {
            setTimeout(() => {
                terminalScroller.scrollTop = scrollBefore;
            }, 0);
        }
    }

    let pendingEditorCanvasFocusTimer: ReturnType<typeof setTimeout> | null =
        null;
    let pendingScriptEditorFocusTimer: ReturnType<typeof setTimeout> | null =
        null;

    /**
     * Blur the editing-view glyph canvas so keystrokes stop reaching text mode.
     */
    function blurEditorCanvas() {
        if (pendingEditorCanvasFocusTimer !== null) {
            clearTimeout(pendingEditorCanvasFocusTimer);
            pendingEditorCanvasFocusTimer = null;
        }
        const canvas = window.glyphCanvas?.canvas as HTMLElement | null;
        if (canvas && document.activeElement === canvas) {
            canvas.blur();
        }
        // If focus somehow remained inside the editor view, clear it too.
        const editorView = document.getElementById('view-editor');
        const active = document.activeElement as HTMLElement | null;
        if (
            editorView &&
            active &&
            editorView.contains(active) &&
            active !== editorView
        ) {
            active.blur();
        }
    }

    /**
     * Blur the scripts Ace editor (and its textarea).
     */
    function blurScriptEditor() {
        if (pendingScriptEditorFocusTimer !== null) {
            clearTimeout(pendingScriptEditorFocusTimer);
            pendingScriptEditorFocusTimer = null;
        }
        const scriptEditorElement = document.getElementById('script-editor');
        if (scriptEditorElement && window.ace) {
            try {
                const aceEditor = window.ace.edit('script-editor');
                if (aceEditor && aceEditor.blur) {
                    aceEditor.blur();
                }
                const aceTextarea =
                    scriptEditorElement.querySelector('textarea');
                if (aceTextarea) {
                    aceTextarea.blur();
                }
            } catch (e) {
                console.warn('[KeyboardNav]', 'Could not blur Ace editor:', e);
            }
        }
    }

    function blurAssistantPrompt() {
        const assistantPrompt = document.getElementById('assistant-prompt');
        if (assistantPrompt) {
            assistantPrompt.blur();
        }
    }

    /**
     * Give a view shell DOM focus so keystrokes leave the previous control.
     * Used for views without a single primary text field (overview, font info).
     */
    function focusViewShell(viewId: string) {
        const view = document.getElementById(viewId);
        if (!view) {
            return;
        }
        if (!view.hasAttribute('tabindex')) {
            view.setAttribute('tabindex', '-1');
        }
        view.focus({ preventScroll: true });
    }

    /**
     * Move real DOM focus with the logical focused view.
     * Keyboard activation previously only toggled `.focused` and left the
     * previous control (e.g. glyph canvas) as document.activeElement, so
     * typing still fell through there while overview typeahead also ran.
     */
    function transferViewDomFocus(
        viewId: string,
        viaKeyboard: boolean,
        wasExpanded: boolean
    ) {
        if (viewId !== 'view-editor') {
            blurEditorCanvas();
        }
        if (viewId !== 'view-console') {
            blurConsole();
        }
        if (viewId !== 'view-scripts') {
            blurScriptEditor();
        }
        if (viewId !== 'view-assistant') {
            blurAssistantPrompt();
        }

        if (viewId === 'view-scripts') {
            if (pendingScriptEditorFocusTimer !== null) {
                clearTimeout(pendingScriptEditorFocusTimer);
                pendingScriptEditorFocusTimer = null;
            }
            pendingScriptEditorFocusTimer = setTimeout(() => {
                pendingScriptEditorFocusTimer = null;
                const scriptsView = document.getElementById('view-scripts');
                if (!scriptsView?.classList.contains('focused')) {
                    return;
                }
                const scriptEditor = document.getElementById('script-editor');
                if (!scriptEditor) {
                    return;
                }
                scriptEditor.focus();
                if (window.ace) {
                    try {
                        window.ace.edit('script-editor')?.focus();
                    } catch (e) {
                        console.warn(
                            '[KeyboardNav]',
                            'Could not focus Ace editor:',
                            e
                        );
                    }
                }
            }, 100);
            return;
        }

        if (viewId === 'view-console') {
            const prompt = document.getElementById('assistant-prompt');
            if (prompt) {
                prompt.blur();
            }
            // Console focus/scroll behavior stays in focusView (needs scroll capture).
            return;
        }

        if (viewId === 'view-assistant') {
            const settings = getViewSettings();
            const delay = settings?.animation?.enabled
                ? settings.animation.duration + 50
                : 100;

            setTimeout(() => {
                if (viaKeyboard || wasExpanded) {
                    const prompt = document.getElementById('assistant-prompt');
                    if (prompt) {
                        prompt.focus();
                    }
                }
            }, delay);
            return;
        }

        if (viewId === 'view-editor') {
            if (pendingEditorCanvasFocusTimer !== null) {
                clearTimeout(pendingEditorCanvasFocusTimer);
                pendingEditorCanvasFocusTimer = null;
            }
            // Clicks on property-panel fields bubble to the view and call
            // restoreFocusedViewDomFocus; keep the field focused for typing.
            if (shouldPreserveActiveEditableInView(viewId)) {
                return;
            }
            pendingEditorCanvasFocusTimer = setTimeout(() => {
                pendingEditorCanvasFocusTimer = null;
                const editorView = document.getElementById('view-editor');
                if (!editorView?.classList.contains('focused')) {
                    return;
                }
                if (shouldPreserveActiveEditableInView('view-editor')) {
                    return;
                }
                if (window.glyphCanvas && window.glyphCanvas.canvas) {
                    window.glyphCanvas.canvas.focus();
                }
            }, 100);
            return;
        }

        if (viewId === 'view-docs') {
            focusViewShell(viewId);
            return;
        }

        if (viewId === 'view-overview' || viewId === 'view-fontinfo') {
            // Always take DOM focus when activating these views so keyboard
            // shortcuts and typeahead do not keep hitting the previous control,
            // unless a field inside the view already holds focus (property panel).
            if (shouldPreserveActiveEditableInView(viewId)) {
                return;
            }
            focusViewShell(viewId);
        }
    }

    /**
     * Add CSS to hide cursors in unfocused bottom views
     */
    function addCursorHidingStyles() {
        const styleId = 'cursor-hiding-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                /* Make Ace editor cursor visible but non-blinking when view is not focused */
                #view-scripts:not(.focused) .ace_cursor {
                    opacity: 0.3 !important;
                    animation: none !important;
                }
                
                /* Hide terminal cursor when view is not focused */
                #view-console:not(.focused) .cmd .cursor,
                #view-console:not(.focused) .cmd-cursor,
                #view-console:not(.focused) .terminal-output .cursor {
                    display: none !important;
                    opacity: 0 !important;
                }
                
                /* Hide blinking animation on terminal cursor */
                #view-console:not(.focused) .cmd span[data-text],
                #view-console:not(.focused) span.terminal-inverted {
                    animation: none !important;
                    background: transparent !important;
                }
            `;
            document.head.appendChild(style);
        }
    }

    function restoreFocusedViewDomFocus() {
        if (!currentFocusedView) {
            return;
        }
        transferViewDomFocus(currentFocusedView, false, false);
    }

    /**
     * Focus a view by ID
     * @param {string} viewId - The ID of the view to focus
     * @param {boolean} viaKeyboard - Whether the focus was triggered by keyboard shortcut
     * @param {{ skipExpand?: boolean }} [options] - skipExpand avoids activation sizing
     */
    function focusView(
        viewId: string,
        viaKeyboard = false,
        options?: { skipExpand?: boolean }
    ) {
        // Capture console scroll position IMMEDIATELY if activating console
        // (before anything else that might trigger scroll)
        let consoleScrollBefore = 0;
        let terminalScroller: HTMLElement | null = null;
        if (viewId === 'view-console') {
            // Use scroll position from click handler if available (most accurate)
            if (consoleScrollFromClick !== null) {
                consoleScrollBefore = consoleScrollFromClick;
                consoleScrollFromClick = null; // Reset for next time
            } else {
                terminalScroller = document.querySelector(
                    '#console-container .terminal-scroller'
                );
                consoleScrollBefore = terminalScroller
                    ? terminalScroller.scrollTop
                    : 0;
            }
            if (!terminalScroller) {
                terminalScroller = document.querySelector(
                    '#console-container .terminal-scroller'
                );
            }
        }

        // Prevent recursive calls — keep the latest request and apply it when
        // the current focus finishes (including the post-focus lock below).
        if (isFocusing) {
            pendingFocus = { viewId, viaKeyboard, options };
            console.warn(
                '[KeyboardNav]',
                'focusView already in progress, queuing:',
                viewId
            );
            return;
        }
        if (
            viewId === 'view-docs' &&
            !document
                .getElementById('app-shell')
                ?.classList.contains('docs-open')
        ) {
            return;
        }
        isFocusing = true;

        console.log('[KeyboardNav]', 'focusView called with:', viewId);

        // Remove focus from all views
        document.querySelectorAll('.view').forEach((view: Element) => {
            (view as HTMLElement).classList.remove('focused');
        });

        // Add focus to the target view
        const view = document.getElementById(viewId);
        if (view) {
            view.classList.add('focused');
            currentFocusedView = viewId;

            // Track focused view in central state manager (root-level UI state)
            if (window.stateManager) {
                window.stateManager.focused_view = viewId;
                if (window.stateManager.recordEvent) {
                    window.stateManager.recordEvent(
                        'view_focused',
                        'KeyboardNavigation',
                        {
                            viewId,
                            viaKeyboard
                        }
                    );
                }
            }

            // Save the last active view on this window slot
            if (viewId !== 'view-docs') {
                setFocusViewId(viewId);
            }

            // Expand view if below threshold (auto-expand on activation)
            const wasExpanded = options?.skipExpand
                ? false
                : expandViewOnActivation(viewId);
            recordViewVisit(viewId);

            // Move real DOM focus with the logical focused view so keystrokes
            // do not keep reaching the previous view's control (canvas, Ace,
            // terminal, assistant prompt, etc.).
            transferViewDomFocus(viewId, viaKeyboard, wasExpanded);

            // Console needs special scroll preservation around terminal focus.
            if (viewId === 'view-console') {
                // Use the scroll position captured at the start of focusView
                const scrollBefore = consoleScrollBefore;

                if (viaKeyboard) {
                    // Keyboard activation - allow auto-scroll to bottom
                    setTimeout(() => {
                        // Try to get terminal instance from window.term or directly from jQuery
                        let term = window.term;

                        // If window.term doesn't exist, try to get it from the jQuery terminal plugin
                        if (!term) {
                            const consoleElement = (window as any).$(
                                '#console-container'
                            );
                            if (
                                consoleElement.length &&
                                consoleElement.terminal
                            ) {
                                term = consoleElement.terminal();
                            }
                        }

                        if (term && term.focus) {
                            // Call terminal focus method (this scrolls to bottom)
                            term.focus();
                        }
                    }, 50);
                } else {
                    // Mouse activation - prevent all scrolling on the terminal-scroller element
                    let scrollBlocked = false;

                    // Block any scroll events temporarily
                    const blockScroll = (e: Event) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (terminalScroller) {
                            terminalScroller.scrollTop = scrollBefore;
                        }
                    };

                    if (terminalScroller) {
                        terminalScroller.addEventListener(
                            'scroll',
                            blockScroll,
                            true
                        );
                        scrollBlocked = true;
                    }

                    setTimeout(() => {
                        // Focus input without scrolling (unless user is selecting text)
                        const selection = window.getSelection();
                        const hasSelection =
                            selection && selection.toString().length > 0;

                        const cmdInput = document.querySelector(
                            '#console-container .cmd textarea'
                        ) as HTMLTextAreaElement | null;
                        if (cmdInput && !hasSelection) {
                            cmdInput.focus({ preventScroll: true });
                        }

                        // Keep scroll blocker active longer to catch delayed scrolls
                        setTimeout(() => {
                            if (scrollBlocked && terminalScroller) {
                                terminalScroller.removeEventListener(
                                    'scroll',
                                    blockScroll,
                                    true
                                );
                                // Final restore
                                terminalScroller.scrollTop = scrollBefore;
                            }
                        }, 500);
                    }, 50);
                }
            }

            // Trigger any view-specific focus handlers
            const event = new CustomEvent('viewFocused', {
                detail: { viewId }
            });
            window.dispatchEvent(event);
        }

        // Reset the flag after a short delay, then apply any focus that arrived
        // while the lock was held (e.g. openDocs right after closeDocs).
        setTimeout(() => {
            isFocusing = false;
            if (!pendingFocus) {
                return;
            }
            const next = pendingFocus;
            pendingFocus = null;
            focusView(next.viewId, next.viaKeyboard, next.options);
        }, 200);
    }

    /**
     * Check if element is a text input where Cmd+A should be allowed
     */
    function isTextInputElement(element: HTMLElement | null) {
        if (!element) return false;

        const tagName = element.tagName?.toLowerCase();
        const type = (element as HTMLInputElement).type?.toLowerCase();

        // Allow in input fields (except non-text types)
        if (tagName === 'input') {
            const textInputTypes = [
                'text',
                'password',
                'email',
                'search',
                'tel',
                'url',
                'number'
            ];
            return !type || textInputTypes.includes(type);
        }

        // Allow in textarea elements
        if (tagName === 'textarea') {
            return true;
        }

        // Allow in contenteditable elements (like Ace Editor)
        if (element.isContentEditable || element.contentEditable === 'true') {
            return true;
        }

        // Allow in elements within Ace Editor
        if (element.closest('.ace_editor')) {
            return true;
        }

        return false;
    }

    /**
     * Property-panel fields and other view-local edits must keep DOM focus.
     * Clicks bubble to the view and would otherwise re-focus the canvas/shell.
     */
    function isEditableFieldElement(element: HTMLElement | null) {
        if (!element) {
            return false;
        }
        if (isTextInputElement(element)) {
            return true;
        }
        return element.tagName?.toLowerCase() === 'select';
    }

    function shouldPreserveActiveEditableInView(viewId: string) {
        const active = document.activeElement as HTMLElement | null;
        if (!isEditableFieldElement(active)) {
            return false;
        }
        const view = document.getElementById(viewId);
        return !!view?.contains(active);
    }

    function isAxisMapInputElement(element: HTMLElement | null) {
        return !!element?.classList?.contains('fontinfo-axis-map-input');
    }

    function isAceEditorElement(element: HTMLElement | null): boolean {
        return !!element?.closest?.('.ace_editor');
    }

    function getFocusedAceEditor(): {
        undo: () => void;
        redo: () => void;
    } | null {
        const activeElement = document.activeElement as HTMLElement | null;
        const aceRoot = activeElement?.closest?.(
            '.ace_editor'
        ) as HTMLElement | null;
        if (!aceRoot || !window.ace) {
            return null;
        }
        try {
            const editor = window.ace.edit(aceRoot);
            if (!editor || typeof editor.undo !== 'function') {
                return null;
            }
            return editor;
        } catch {
            return null;
        }
    }

    function isAutomationUndoViewFocused(): boolean {
        return (
            document
                .querySelector('#view-scripts')
                ?.classList.contains('focused') ||
            document
                .querySelector('#view-console')
                ?.classList.contains('focused') ||
            document
                .querySelector('#view-assistant')
                ?.classList.contains('focused') ||
            false
        );
    }

    /**
     * Handle keyboard shortcuts
     */
    function handleKeyDown(event: KeyboardEvent) {
        if (isTourBlockingViewShortcuts() && !isTourKeyEventAllowed(event)) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            return;
        }

        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        const cmdKey = isMac ? event.metaKey : event.ctrlKey;
        const shiftKey = event.shiftKey;
        const key =
            typeof event.key === 'string' ? event.key.toLowerCase() : '';

        // Cmd/Ctrl+Shift+D opens Docs, or activates it when already open
        // (same as other view shortcuts). Closing is Cmd/Ctrl+Escape only.
        if (cmdKey && shiftKey && !event.altKey && key === 'd') {
            if (
                isTourBlockingViewShortcuts() &&
                !isViewShortcutAllowedDuringTour('d')
            ) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            if (window.docsViewer?.isOpen()) {
                if (currentFocusedView === 'view-docs') {
                    resizeView('view-docs');
                } else {
                    focusView('view-docs', true);
                }
            } else {
                window.openDocs();
            }
            return;
        }

        // Cmd/Ctrl+Escape closes the focused panel (including Docs).
        if (cmdKey && event.code === 'Escape' && !shiftKey && !event.altKey) {
            if (isTourBlockingViewShortcuts() && !isTourCmdEscapeAllowed()) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                return;
            }
            if (isTourBlockingViewShortcuts()) {
                consumeAllowedTourViewShortcut();
            }
            const focusedViewId =
                currentFocusedView ||
                (document.querySelector('.view.focused') as HTMLElement | null)
                    ?.id ||
                null;
            const focusedView = focusedViewId
                ? document.getElementById(focusedViewId)
                : null;
            const closeBtn = focusedView?.querySelector(
                '.view-title-collapse-btn'
            ) as HTMLElement | null;
            const closeBtnShown =
                !!closeBtn &&
                closeBtn.style.display !== 'none' &&
                window.getComputedStyle(closeBtn).display !== 'none';

            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            if (closeBtnShown) {
                closeBtn.click();
            }
            return;
        }

        if (!key) {
            return;
        }

        // Debug: Log Cmd+Alt combinations
        if (cmdKey && event.altKey) {
            console.log(
                '[KeyboardNav]',
                'Cmd+Alt detected, key:',
                key,
                'shift:',
                shiftKey
            );
        }

        // Prevent browser back navigation shortcuts to avoid accidentally closing the app
        const activeElement = document.activeElement as HTMLElement | null;
        const isInTextInput = isTextInputElement(activeElement);
        const isInAce = isAceEditorElement(activeElement);
        const automationViewFocused = isAutomationUndoViewFocused();

        // Backspace - browser back (when not in text input)
        if (key === 'backspace' && !isInTextInput) {
            console.log(
                '[KeyboardNav]',
                'Blocking Backspace browser navigation'
            );
            event.preventDefault();
            return;
        }

        // Alt+Left Arrow - browser back (Windows/Linux). Preserve native
        // Alt/Option word navigation and selection inside editable controls.
        if (event.altKey && key === 'arrowleft' && !isInTextInput) {
            console.log(
                '[KeyboardNav]',
                'Blocking Alt+Left browser navigation'
            );
            event.preventDefault();
            return;
        }

        // Cmd+[ / Cmd+] - browser history (macOS)
        if (
            isMac &&
            cmdKey &&
            !shiftKey &&
            !event.altKey &&
            (key === '[' || key === ']')
        ) {
            console.log(
                '[KeyboardNav]',
                'Blocking Cmd+[ / Cmd+] browser navigation'
            );
            event.preventDefault();
            return;
        }

        // Cmd+Left Arrow - browser back (some browsers on macOS)
        if (
            isMac &&
            cmdKey &&
            key === 'arrowleft' &&
            !shiftKey &&
            !event.altKey
        ) {
            console.log(
                '[KeyboardNav]',
                'Blocking Cmd+Left browser navigation'
            );
            event.preventDefault();
            return;
        }

        // Prevent browser reload and route script-runner shortcuts:
        // Cmd/Ctrl+R opens Run Python Script; Cmd/Ctrl+Alt+R re-runs the last script.
        // Use event.code — with Alt held, macOS remaps event.key (e.g. R → ®).
        if ((cmdKey || event.ctrlKey) && event.code === 'KeyR') {
            if (event.altKey && !shiftKey) {
                event.preventDefault();
                event.stopPropagation();
                console.log(
                    '[KeyboardNav]',
                    'Routing Cmd/Ctrl+Alt+R to Re-run Python Script'
                );
                void window.runPythonScriptDialog?.reRunLast();
                return;
            }
            if (!event.altKey && !shiftKey) {
                event.preventDefault();
                event.stopPropagation();
                console.log(
                    '[KeyboardNav]',
                    'Routing Cmd/Ctrl+R to Run Python Script'
                );
                void window.runPythonScriptDialog?.open();
                return;
            }
        }

        // Prevent remaining page reload shortcuts in production (allow in development)
        if (!window.isDevelopment?.()) {
            // F5 - reload page
            if (key === 'f5') {
                console.log(
                    '[KeyboardNav]',
                    'Blocking page reload shortcut (F5) in production'
                );
                event.preventDefault();
                return;
            }
        }

        // Handle Cmd+A (select all) blocking
        const isCmdA = cmdKey && key === 'a' && !shiftKey && !event.altKey;

        if (isCmdA) {
            const activeElement = document.activeElement as HTMLElement | null;
            const tagName = activeElement?.tagName?.toLowerCase();

            console.log('[KeyboardNav]', 'Cmd+A detected - activeElement:', {
                tagName,
                id: activeElement?.id,
                glyphCanvasExists: !!window.glyphCanvas,
                outlineEditorActive: window.glyphCanvas?.outlineEditor?.active,
                isGlyphCanvas: window.glyphCanvas?.canvas === activeElement
            });

            // Special case: Handle glyph canvas in text mode
            if (
                tagName === 'canvas' &&
                window.glyphCanvas?.canvas === activeElement
            ) {
                const glyphCanvas = window.glyphCanvas;
                if (glyphCanvas?.outlineEditor?.active) {
                    console.log(
                        '[KeyboardNav]',
                        'Allowing Cmd+A in canvas outline mode'
                    );
                    return;
                }

                if (glyphCanvas && !glyphCanvas.outlineEditor?.active) {
                    // In text mode - handle select all ourselves
                    console.log(
                        '[KeyboardNav]',
                        'Handling Cmd+A in canvas text mode'
                    );
                    event.preventDefault();
                    event.stopPropagation();
                    event.stopImmediatePropagation();
                    glyphCanvas.textRunEditor?.selectAll();
                    glyphCanvas.render();
                    return;
                }
            }

            // Allow Cmd+A in text input elements
            if (isTextInputElement(activeElement)) {
                console.log(
                    '[KeyboardNav]',
                    'Allowing Cmd+A in text input:',
                    activeElement?.tagName,
                    activeElement?.id || activeElement?.className
                );
                return;
            }

            // Block Cmd+A everywhere else
            console.log(
                '[KeyboardNav]',
                'Blocking Cmd+A outside text inputs',
                activeElement?.tagName
            );
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            return;
        }

        // Cmd+Alt+Z — Ace text undo/redo (script editor + features editor).
        // Font history uses plain Cmd+Z / Cmd+Shift+Z even while Ace is focused.
        if (cmdKey && event.altKey && key === 'z') {
            const aceEditor = getFocusedAceEditor();
            if (aceEditor) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                if (shiftKey) {
                    aceEditor.redo();
                } else {
                    aceEditor.undo();
                }
                return;
            }
        }

        // Cmd+Z — Undo, Cmd+Shift+Z — Redo (font history)
        if (cmdKey && key === 'z' && !event.altKey) {
            // Ordinary text fields keep native undo. Ace editors and the
            // Scripts / Konsole / Assistant views route to font history instead;
            // Ace text undo is Cmd+Alt+Z.
            if (
                isInTextInput &&
                !isAxisMapInputElement(activeElement) &&
                !isInAce &&
                !automationViewFocused
            ) {
                return;
            }

            if (activeElement && isAxisMapInputElement(activeElement)) {
                activeElement.blur();
            }

            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();

            const bridge = window.patchSyncEngine;
            if (!bridge) return;

            const oe = window.glyphCanvas?.outlineEditor;
            const {
                rootGlyphName: effectiveRootGlyphName,
                undoGlyphName,
                undoLayerId,
                historyTargetKey,
                surface
            } = window.getUndoRedoContext
                ? window.getUndoRedoContext()
                : {
                      rootGlyphName: undefined,
                      undoGlyphName: undefined,
                      undoLayerId: null,
                      historyTargetKey: null,
                      surface: 'font' as const
                  };

            if (oe?.active && (!effectiveRootGlyphName || !undoGlyphName)) {
                if (!undoGlyphName && !undoLayerId) {
                    window.runBridgeUndoRedo?.(
                        shiftKey ? 'redo' : 'undo',
                        undefined,
                        effectiveRootGlyphName,
                        null,
                        historyTargetKey,
                        surface
                    );
                    return;
                }
                console.warn(
                    '[KeyboardNav]',
                    'Skipping undo/redo: active outline editor has incomplete glyph stack'
                );
                return;
            }

            window.runBridgeUndoRedo?.(
                shiftKey ? 'redo' : 'undo',
                undoGlyphName,
                effectiveRootGlyphName,
                undoLayerId,
                historyTargetKey,
                surface
            );
            return;
        }

        const settings = getViewSettings();
        if (!settings) return;

        const shortcuts = settings.shortcuts;

        // Check each view's shortcut
        for (const [viewId, config] of Object.entries(
            shortcuts as Record<
                string,
                {
                    key: string;
                    modifiers: { cmd: boolean; shift: boolean };
                    secondaryBehavior?: string;
                }
            >
        )) {
            if (config.modifiers.cmd && !cmdKey) continue;
            if (config.modifiers.shift && !shiftKey) continue;
            if (key === config.key) {
                if (
                    isTourBlockingViewShortcuts() &&
                    !isViewShortcutAllowedDuringTour(key)
                ) {
                    event.preventDefault();
                    event.stopPropagation();
                    event.stopImmediatePropagation();
                    return;
                }
                if (isTourBlockingViewShortcuts()) {
                    consumeAllowedTourViewShortcut();
                }
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();

                // Check if this view is already focused
                if (currentFocusedView === viewId) {
                    const view = document.getElementById(viewId);
                    const isCollapsed =
                        !!view &&
                        (view.classList.contains('collapsed') ||
                            view.classList.contains('collapsed-width'));

                    if (isCollapsed) {
                        // Collapsed-but-focused: expand to activation minimum
                        focusView(viewId, true);
                    } else {
                        // View is already focused, trigger resize
                        resizeView(viewId);
                    }
                } else {
                    // View is not focused, just focus it
                    focusView(viewId, true); // Pass true for viaKeyboard
                }
                return;
            }
        }

        // Cmd+Alt+N - Start new chat (only when assistant view is focused)
        if (cmdKey && event.altKey && key === 'n') {
            if (currentFocusedView === 'view-assistant') {
                event.preventDefault();
                const newChatBtn = document.getElementById(
                    'assistant-new-chat-btn'
                );
                if (newChatBtn) {
                    newChatBtn.click();
                }
            }
            return;
        }
    }

    // Store console scroll position from click handler (before any other events fire)
    let consoleScrollFromClick: number | null = null;

    /**
     * Handle view clicks for focus
     */
    function handleViewClick(event: Event) {
        // Find the closest parent view element
        const view = event.currentTarget as HTMLElement | null;
        if (view && view.id) {
            // Scroll position for console already captured in mousedown handler

            const isCollapsed =
                view.classList.contains('collapsed') ||
                view.classList.contains('collapsed-width');

            // Focus when not already focused. Also re-activate collapsed
            // views so title-bar clicks expand them to the activation minimum.
            if (!view.classList.contains('focused') || isCollapsed) {
                focusView(view.id);
            } else {
                restoreFocusedViewDomFocus();
            }
        }
    }

    /**
     * Initialize keyboard navigation
     */
    function init() {
        // Add cursor hiding styles
        addCursorHidingStyles();
        rowVisitOrder = normalizeRowVisitOrder(null);

        // Add keyboard event listener in CAPTURE phase to intercept before Ace Editor
        document.addEventListener('keydown', handleKeyDown, true);

        // Add click listeners to all views
        document.querySelectorAll('.view').forEach((view: Element) => {
            (view as HTMLElement).addEventListener('click', handleViewClick);
        });

        // Add special early capture for console clicks to grab scroll position
        // BEFORE jQuery Terminal can react to the click
        const consoleView = document.getElementById('view-console');
        if (consoleView) {
            consoleView.addEventListener(
                'mousedown',
                (_event: MouseEvent) => {
                    const terminalScroller = document.querySelector(
                        '#console-container .terminal-scroller'
                    );
                    consoleScrollFromClick = terminalScroller
                        ? terminalScroller.scrollTop
                        : 0;
                },
                true
            ); // Use capture phase to run before jQuery Terminal
        }

        console.log('[KeyboardNav]', 'Keyboard navigation initialized');
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Expose focusView and getCurrentFocusedView globally for other scripts
    window.focusView = focusView;
    window.getCurrentFocusedView = () => currentFocusedView;
    window.restoreFocusedViewDomFocus = restoreFocusedViewDomFocus;
    window.resizeView = resizeView;
    window.collapseActiveView = collapseActiveView;
    window.getViewVisitOrder = getViewVisitOrder;
    window.setViewVisitOrder = setViewVisitOrder;
})();
