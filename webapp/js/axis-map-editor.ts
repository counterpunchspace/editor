import type { Babelfont } from './babelfont';

type AxisMapTuple = [number, number];

type AxisMapPoint = {
    id: string;
    userspace: number;
    designspace: number;
};

type AxisMapEditorOptions = {
    axis: Pick<Babelfont.Axis, 'tag' | 'min' | 'max' | 'default' | 'map'>;
    onCommit: (nextMap: AxisMapTuple[]) => void;
};

const SVG_WIDTH = 420;
const SVG_HEIGHT = 280;
const PLOT_PADDING = {
    top: 18,
    right: 18,
    bottom: 40,
    left: 44
};

export class AxisMapEditor {
    readonly element: HTMLElement;

    private axis: Pick<
        Babelfont.Axis,
        'tag' | 'min' | 'max' | 'default' | 'map'
    >;
    private onCommit: (nextMap: AxisMapTuple[]) => void;
    private points: AxisMapPoint[];
    private selectedPointId: string | null;
    private nextPointId = 0;
    private svg: SVGSVGElement;
    private chartLayer: SVGGElement;
    private list: HTMLElement;
    private removeButton: HTMLButtonElement;
    private draggingPointId: string | null = null;
    private dragMoved = false;

    constructor(options: AxisMapEditorOptions) {
        this.axis = options.axis;
        this.onCommit = options.onCommit;
        this.points = this.normalizeMap(options.axis.map);
        this.selectedPointId = this.points[0]?.id ?? null;

        this.element = document.createElement('section');
        this.element.className = 'fontinfo-name-group fontinfo-axis-map-group';

        const title = document.createElement('h3');
        title.className = 'sidebar-section-title';
        title.textContent = 'Mapping';
        this.element.appendChild(title);

        const toolbar = document.createElement('div');
        toolbar.className = 'fontinfo-axis-map-toolbar';

        const description = document.createElement('div');
        description.className = 'localized-string-helper';
        description.textContent =
            'Edit the userspace-to-designspace mapping for this axis.';
        toolbar.appendChild(description);

        const actions = document.createElement('div');
        actions.className = 'fontinfo-axis-map-actions';

        const addButton = document.createElement('button');
        addButton.type = 'button';
        addButton.className = 'localized-string-locales-button';
        addButton.textContent = 'Add point';
        addButton.addEventListener('click', () => this.addPoint());
        actions.appendChild(addButton);

        this.removeButton = document.createElement('button');
        this.removeButton.type = 'button';
        this.removeButton.className = 'localized-string-locales-button';
        this.removeButton.textContent = 'Remove selected';
        this.removeButton.addEventListener('click', () =>
            this.removeSelectedPoint()
        );
        actions.appendChild(this.removeButton);

        toolbar.appendChild(actions);
        this.element.appendChild(toolbar);

        const editor = document.createElement('div');
        editor.className = 'fontinfo-axis-map-editor';
        editor.tabIndex = 0;
        editor.addEventListener('keydown', (event) =>
            this.handleKeyDown(event)
        );
        this.element.appendChild(editor);

        const chartPanel = document.createElement('div');
        chartPanel.className = 'fontinfo-axis-map-chart-panel';
        editor.appendChild(chartPanel);

        this.svg = document.createElementNS(
            'http://www.w3.org/2000/svg',
            'svg'
        );
        this.svg.setAttribute('viewBox', `0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`);
        this.svg.setAttribute('class', 'fontinfo-axis-map-chart');
        this.svg.setAttribute('role', 'img');
        this.svg.setAttribute(
            'aria-label',
            `${this.axis.tag || 'Axis'} userspace to designspace map editor`
        );
        chartPanel.appendChild(this.svg);

        this.chartLayer = document.createElementNS(
            'http://www.w3.org/2000/svg',
            'g'
        );
        this.svg.appendChild(this.chartLayer);

        const listPanel = document.createElement('div');
        listPanel.className = 'fontinfo-axis-map-list-panel';
        editor.appendChild(listPanel);

        const listTitle = document.createElement('div');
        listTitle.className = 'fontinfo-axis-map-list-title';
        const userspaceHeader = document.createElement('span');
        userspaceHeader.textContent = 'Userspace';
        listTitle.appendChild(userspaceHeader);

        const designspaceHeader = document.createElement('span');
        designspaceHeader.textContent = 'Designspace';
        listTitle.appendChild(designspaceHeader);

        listPanel.appendChild(listTitle);

        this.list = document.createElement('div');
        this.list.className = 'fontinfo-axis-map-list';
        listPanel.appendChild(this.list);

        this.render();
    }

    private normalizeMap(map: Babelfont.Axis['map']): AxisMapPoint[] {
        const tuples = Array.isArray(map) ? map : [];
        return [...tuples]
            .map((entry) => ({
                id: this.createPointId(),
                userspace: this.toEditableInteger(entry[0]),
                designspace: this.toEditableInteger(entry[1])
            }))
            .sort((a, b) => a.userspace - b.userspace);
    }

    private toEditableInteger(value: unknown): number {
        return Math.round(Number(value ?? 0));
    }

    private createPointId(): string {
        this.nextPointId += 1;
        return `axis-map-point-${this.nextPointId}`;
    }

    private getAxisMin(): number {
        return this.toEditableInteger(this.axis.min ?? this.axis.default ?? 0);
    }

    private getAxisMax(): number {
        return this.toEditableInteger(this.axis.max ?? this.axis.default ?? 0);
    }

    private getAxisDefault(): number {
        return this.toEditableInteger(
            this.axis.default ?? this.axis.min ?? this.axis.max ?? 0
        );
    }

    private getOrderedPoints(): AxisMapPoint[] {
        return [...this.points].sort((a, b) => a.userspace - b.userspace);
    }

    private getSelectedPoint(): AxisMapPoint | undefined {
        return this.points.find((point) => point.id === this.selectedPointId);
    }

    private getDesignBounds(): { min: number; max: number } {
        const values = this.points.length
            ? this.points.map((point) => point.designspace)
            : [this.getAxisMin(), this.getAxisDefault(), this.getAxisMax()];
        const min = Math.min(...values);
        const max = Math.max(...values);
        if (min === max) {
            return {
                min: min - 1,
                max: max + 1
            };
        }
        const padding = Math.max(1, (max - min) * 0.08);
        return {
            min: min - padding,
            max: max + padding
        };
    }

    private getPlotRect() {
        return {
            x: PLOT_PADDING.left,
            y: PLOT_PADDING.top,
            width: SVG_WIDTH - PLOT_PADDING.left - PLOT_PADDING.right,
            height: SVG_HEIGHT - PLOT_PADDING.top - PLOT_PADDING.bottom
        };
    }

    private userspaceToSvgX(value: number): number {
        const plot = this.getPlotRect();
        const min = this.getAxisMin();
        const max = this.getAxisMax();
        if (min === max) {
            return plot.x + plot.width / 2;
        }
        return plot.x + ((value - min) / (max - min)) * plot.width;
    }

    private designspaceToSvgY(value: number): number {
        const plot = this.getPlotRect();
        const { min, max } = this.getDesignBounds();
        if (min === max) {
            return plot.y + plot.height / 2;
        }
        return plot.y + (1 - (value - min) / (max - min)) * plot.height;
    }

    private svgXToUserspace(value: number): number {
        const plot = this.getPlotRect();
        const min = this.getAxisMin();
        const max = this.getAxisMax();
        if (plot.width <= 0 || min === max) {
            return min;
        }
        const ratio = (value - plot.x) / plot.width;
        return min + ratio * (max - min);
    }

    private svgYToDesignspace(value: number): number {
        const plot = this.getPlotRect();
        const { min, max } = this.getDesignBounds();
        if (plot.height <= 0 || min === max) {
            return min;
        }
        const ratio = 1 - (value - plot.y) / plot.height;
        return min + ratio * (max - min);
    }

    private clampUserspace(value: number): number {
        // Map points may extend past the current axis min/max (editing the
        // endpoint is how users raise max). Only round — do not clamp to the
        // declared userspace range.
        return this.toEditableInteger(value);
    }

    private clampDesignspace(value: number): number {
        return this.toEditableInteger(value);
    }

    private getUserspaceBoundsForUniqueness(): { min: number; max: number } {
        const pointValues = this.points.map((point) => point.userspace);
        const min = Math.min(this.getAxisMin(), ...pointValues);
        const max = Math.max(this.getAxisMax(), ...pointValues);
        return { min, max };
    }

    private ensureUniqueUserspace(
        pointId: string,
        targetUserspace: number,
        direction: number
    ): number {
        let nextValue = this.clampUserspace(targetUserspace);
        const otherValues = new Set(
            this.points
                .filter((point) => point.id !== pointId)
                .map((point) => point.userspace)
        );
        const { min, max } = this.getUserspaceBoundsForUniqueness();

        const preferredStep = direction >= 0 ? 1 : -1;
        while (otherValues.has(nextValue)) {
            const preferredCandidate = nextValue + preferredStep;
            if (preferredCandidate >= min && preferredCandidate <= max) {
                nextValue = preferredCandidate;
                continue;
            }

            const fallbackCandidate = nextValue - preferredStep;
            if (fallbackCandidate >= min && fallbackCandidate <= max) {
                nextValue = fallbackCandidate;
                continue;
            }

            // Allow stepping outside the previous bounds when resolving clashes
            // at a newly typed endpoint (e.g. raising 875 → 900).
            nextValue = preferredCandidate;
            break;
        }

        return this.clampUserspace(nextValue);
    }

    private syncAxisUserspaceExtentFromPoints(): void {
        if (this.points.length === 0) {
            return;
        }
        const userspaceValues = this.points.map((point) => point.userspace);
        const nextMin = Math.min(...userspaceValues);
        const nextMax = Math.max(...userspaceValues);
        this.axis = {
            ...this.axis,
            min: nextMin,
            max: nextMax
        };
    }

    private interpolateDesignspace(userspace: number): number {
        const ordered = this.getOrderedPoints();
        if (!ordered.length) {
            return this.getAxisDefault();
        }
        if (ordered.length === 1) {
            return ordered[0].designspace;
        }
        if (userspace <= ordered[0].userspace) {
            return ordered[0].designspace;
        }
        const lastPoint = ordered[ordered.length - 1];
        if (userspace >= lastPoint.userspace) {
            return lastPoint.designspace;
        }

        for (let index = 0; index < ordered.length - 1; index += 1) {
            const start = ordered[index];
            const end = ordered[index + 1];
            if (userspace < start.userspace || userspace > end.userspace) {
                continue;
            }
            const width = end.userspace - start.userspace;
            if (!width) {
                return start.designspace;
            }
            const t = (userspace - start.userspace) / width;
            return this.toEditableInteger(
                start.designspace + (end.designspace - start.designspace) * t
            );
        }

        return lastPoint.designspace;
    }

    private getSuggestedUserspace(): number {
        const ordered = this.getOrderedPoints();
        const min = this.getAxisMin();
        const max = this.getAxisMax();

        if (!ordered.length) {
            return this.getAxisDefault();
        }

        const selectedIndex = ordered.findIndex(
            (point) => point.id === this.selectedPointId
        );
        if (selectedIndex >= 0) {
            const selected = ordered[selectedIndex];
            const next = ordered[selectedIndex + 1];
            const previous = ordered[selectedIndex - 1];
            if (next) {
                return (selected.userspace + next.userspace) / 2;
            }
            if (previous) {
                return (selected.userspace + previous.userspace) / 2;
            }
        }

        let bestStart = min;
        let bestEnd = ordered[0].userspace;
        for (let index = 0; index < ordered.length - 1; index += 1) {
            const start = ordered[index].userspace;
            const end = ordered[index + 1].userspace;
            if (end - start > bestEnd - bestStart) {
                bestStart = start;
                bestEnd = end;
            }
        }
        if (max - ordered[ordered.length - 1].userspace > bestEnd - bestStart) {
            bestStart = ordered[ordered.length - 1].userspace;
            bestEnd = max;
        }
        return this.toEditableInteger((bestStart + bestEnd) / 2);
    }

    private addPoint() {
        const userspace = this.ensureUniqueUserspace(
            '__new__',
            this.getSuggestedUserspace(),
            1
        );
        const point: AxisMapPoint = {
            id: this.createPointId(),
            userspace,
            designspace: this.interpolateDesignspace(userspace)
        };
        this.points = [...this.points, point].sort(
            (a, b) => a.userspace - b.userspace
        );
        this.selectedPointId = point.id;
        this.syncAxisUserspaceExtentFromPoints();
        this.render();
        this.commit();
        this.focus();
    }

    private removeSelectedPoint() {
        if (!this.selectedPointId) {
            return;
        }
        const ordered = this.getOrderedPoints();
        const selectedIndex = ordered.findIndex(
            (point) => point.id === this.selectedPointId
        );
        this.points = ordered.filter(
            (point) => point.id !== this.selectedPointId
        );
        const nextSelection =
            this.points[selectedIndex] ??
            this.points[selectedIndex - 1] ??
            null;
        this.selectedPointId = nextSelection?.id ?? null;
        this.render();
        this.commit();
        this.focus();
    }

    private commit() {
        this.onCommit(
            this.getOrderedPoints().map(
                (point) =>
                    [
                        this.toEditableInteger(point.userspace),
                        this.toEditableInteger(point.designspace)
                    ] as AxisMapTuple
            )
        );
    }

    private focus() {
        this.element
            .querySelector<HTMLElement>('.fontinfo-axis-map-editor')
            ?.focus({ preventScroll: true });
    }

    private handleKeyDown(event: KeyboardEvent) {
        const selectedPoint = this.getSelectedPoint();
        if (!selectedPoint) {
            if (
                (event.key === 'Delete' || event.key === 'Backspace') &&
                this.selectedPointId
            ) {
                event.preventDefault();
                this.removeSelectedPoint();
            }
            return;
        }

        if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            this.removeSelectedPoint();
            return;
        }

        const step = event.shiftKey ? 10 : 1;
        let nextUserspace = selectedPoint.userspace;
        let nextDesignspace = selectedPoint.designspace;
        let changed = false;

        if (event.key === 'ArrowLeft') {
            nextUserspace = this.ensureUniqueUserspace(
                selectedPoint.id,
                selectedPoint.userspace - step,
                -1
            );
            changed = true;
        } else if (event.key === 'ArrowRight') {
            nextUserspace = this.ensureUniqueUserspace(
                selectedPoint.id,
                selectedPoint.userspace + step,
                1
            );
            changed = true;
        } else if (event.key === 'ArrowUp') {
            nextDesignspace = this.clampDesignspace(
                selectedPoint.designspace + step
            );
            changed = true;
        } else if (event.key === 'ArrowDown') {
            nextDesignspace = this.clampDesignspace(
                selectedPoint.designspace - step
            );
            changed = true;
        }

        if (!changed) {
            return;
        }

        event.preventDefault();
        this.points = this.points
            .map((point) =>
                point.id === selectedPoint.id
                    ? {
                          ...point,
                          userspace: nextUserspace,
                          designspace: nextDesignspace
                      }
                    : point
            )
            .sort((a, b) => a.userspace - b.userspace);
        this.render();
        this.commit();
    }

    private selectPoint(pointId: string) {
        if (this.selectedPointId === pointId) {
            return;
        }
        this.selectedPointId = pointId;
        this.render();
        this.focus();
    }

    private updatePoint(
        pointId: string,
        userspace: number,
        designspace: number
    ) {
        const selectedPoint = this.points.find((point) => point.id === pointId);
        const direction = selectedPoint
            ? userspace >= selectedPoint.userspace
                ? 1
                : -1
            : 1;
        const uniqueUserspace = this.ensureUniqueUserspace(
            pointId,
            userspace,
            direction
        );
        const nextDesignspace = this.clampDesignspace(designspace);
        this.points = this.points
            .map((point) =>
                point.id === pointId
                    ? {
                          ...point,
                          userspace: uniqueUserspace,
                          designspace: nextDesignspace
                      }
                    : point
            )
            .sort((a, b) => a.userspace - b.userspace);
        this.syncAxisUserspaceExtentFromPoints();
        this.render();
    }

    private startDrag(event: MouseEvent, pointId: string) {
        event.preventDefault();
        this.draggingPointId = pointId;
        this.dragMoved = false;
        this.selectPoint(pointId);

        const onMouseMove = (moveEvent: MouseEvent) => {
            if (!this.draggingPointId) {
                return;
            }
            const coordinates = this.getSvgCoordinates(moveEvent);
            if (!coordinates) {
                return;
            }
            this.dragMoved = true;
            this.updatePoint(
                this.draggingPointId,
                this.svgXToUserspace(coordinates.x),
                this.svgYToDesignspace(coordinates.y)
            );
        };

        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            const shouldCommit = this.dragMoved;
            this.draggingPointId = null;
            this.dragMoved = false;
            if (shouldCommit) {
                this.commit();
            }
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    }

    private getSvgCoordinates(
        event: MouseEvent
    ): { x: number; y: number } | null {
        const rect = this.svg.getBoundingClientRect();
        if (!rect.width || !rect.height) {
            return null;
        }
        const scaleX = SVG_WIDTH / rect.width;
        const scaleY = SVG_HEIGHT / rect.height;
        const x = (event.clientX - rect.left) * scaleX;
        const y = (event.clientY - rect.top) * scaleY;
        const plot = this.getPlotRect();
        return {
            x: Math.min(plot.x + plot.width, Math.max(plot.x, x)),
            y: Math.min(plot.y + plot.height, Math.max(plot.y, y))
        };
    }

    private formatValue(value: number): string {
        return String(this.toEditableInteger(value));
    }

    private renderAxesAndGrid() {
        const plot = this.getPlotRect();
        const { min: designMin, max: designMax } = this.getDesignBounds();

        const frame = document.createElementNS(
            'http://www.w3.org/2000/svg',
            'rect'
        );
        frame.setAttribute('x', String(plot.x));
        frame.setAttribute('y', String(plot.y));
        frame.setAttribute('width', String(plot.width));
        frame.setAttribute('height', String(plot.height));
        frame.setAttribute('class', 'fontinfo-axis-map-frame');
        this.chartLayer.appendChild(frame);

        const xLabel = document.createElementNS(
            'http://www.w3.org/2000/svg',
            'text'
        );
        xLabel.setAttribute('x', String(plot.x + plot.width / 2));
        xLabel.setAttribute('y', String(SVG_HEIGHT - 10));
        xLabel.setAttribute('text-anchor', 'middle');
        xLabel.setAttribute('class', 'fontinfo-axis-map-axis-label');
        xLabel.textContent = 'Userspace';
        this.chartLayer.appendChild(xLabel);

        const yLabel = document.createElementNS(
            'http://www.w3.org/2000/svg',
            'text'
        );
        yLabel.setAttribute(
            'transform',
            `translate(14 ${plot.y + plot.height / 2}) rotate(-90)`
        );
        yLabel.setAttribute('text-anchor', 'middle');
        yLabel.setAttribute('class', 'fontinfo-axis-map-axis-label');
        yLabel.textContent = 'Designspace';
        this.chartLayer.appendChild(yLabel);

        const tickValues = [
            this.getAxisMin(),
            this.getAxisDefault(),
            this.getAxisMax()
        ].filter((value, index, values) => values.indexOf(value) === index);
        tickValues.forEach((value) => {
            const x = this.userspaceToSvgX(value);
            const tick = document.createElementNS(
                'http://www.w3.org/2000/svg',
                'line'
            );
            tick.setAttribute('x1', String(x));
            tick.setAttribute('x2', String(x));
            tick.setAttribute('y1', String(plot.y + plot.height));
            tick.setAttribute('y2', String(plot.y + plot.height + 6));
            tick.setAttribute('class', 'fontinfo-axis-map-tick');
            this.chartLayer.appendChild(tick);

            const label = document.createElementNS(
                'http://www.w3.org/2000/svg',
                'text'
            );
            label.setAttribute('x', String(x));
            label.setAttribute('y', String(plot.y + plot.height + 20));
            label.setAttribute('text-anchor', 'middle');
            label.setAttribute('class', 'fontinfo-axis-map-tick-label');
            label.textContent = this.formatValue(value);
            this.chartLayer.appendChild(label);
        });

        [designMin, (designMin + designMax) / 2, designMax].forEach((value) => {
            const y = this.designspaceToSvgY(value);
            const tick = document.createElementNS(
                'http://www.w3.org/2000/svg',
                'line'
            );
            tick.setAttribute('x1', String(plot.x - 6));
            tick.setAttribute('x2', String(plot.x));
            tick.setAttribute('y1', String(y));
            tick.setAttribute('y2', String(y));
            tick.setAttribute('class', 'fontinfo-axis-map-tick');
            this.chartLayer.appendChild(tick);

            const label = document.createElementNS(
                'http://www.w3.org/2000/svg',
                'text'
            );
            label.setAttribute('x', String(plot.x - 10));
            label.setAttribute('y', String(y + 4));
            label.setAttribute('text-anchor', 'end');
            label.setAttribute('class', 'fontinfo-axis-map-tick-label');
            label.textContent = this.formatValue(value);
            this.chartLayer.appendChild(label);
        });
    }

    private renderPolyline() {
        const ordered = this.getOrderedPoints();
        if (!ordered.length) {
            return;
        }

        const line = document.createElementNS(
            'http://www.w3.org/2000/svg',
            'polyline'
        );
        line.setAttribute(
            'points',
            ordered
                .map(
                    (point) =>
                        `${this.userspaceToSvgX(point.userspace)},${this.designspaceToSvgY(point.designspace)}`
                )
                .join(' ')
        );
        line.setAttribute('class', 'fontinfo-axis-map-line');
        this.chartLayer.appendChild(line);

        const selectedPoint = this.getSelectedPoint();
        if (selectedPoint) {
            const guideX = this.userspaceToSvgX(selectedPoint.userspace);
            const guideY = this.designspaceToSvgY(selectedPoint.designspace);
            const plot = this.getPlotRect();

            const vGuide = document.createElementNS(
                'http://www.w3.org/2000/svg',
                'line'
            );
            vGuide.setAttribute('x1', String(guideX));
            vGuide.setAttribute('x2', String(guideX));
            vGuide.setAttribute('y1', String(plot.y));
            vGuide.setAttribute('y2', String(plot.y + plot.height));
            vGuide.setAttribute('class', 'fontinfo-axis-map-guide');
            this.chartLayer.appendChild(vGuide);

            const hGuide = document.createElementNS(
                'http://www.w3.org/2000/svg',
                'line'
            );
            hGuide.setAttribute('x1', String(plot.x));
            hGuide.setAttribute('x2', String(plot.x + plot.width));
            hGuide.setAttribute('y1', String(guideY));
            hGuide.setAttribute('y2', String(guideY));
            hGuide.setAttribute('class', 'fontinfo-axis-map-guide');
            this.chartLayer.appendChild(hGuide);
        }

        ordered.forEach((point) => {
            const handle = document.createElementNS(
                'http://www.w3.org/2000/svg',
                'circle'
            );
            handle.setAttribute(
                'cx',
                String(this.userspaceToSvgX(point.userspace))
            );
            handle.setAttribute(
                'cy',
                String(this.designspaceToSvgY(point.designspace))
            );
            handle.setAttribute(
                'r',
                point.id === this.selectedPointId ? '6' : '5'
            );
            handle.setAttribute(
                'class',
                point.id === this.selectedPointId
                    ? 'fontinfo-axis-map-point selected'
                    : 'fontinfo-axis-map-point'
            );
            handle.addEventListener('mousedown', (event) =>
                this.startDrag(event, point.id)
            );
            handle.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.selectPoint(point.id);
            });
            this.chartLayer.appendChild(handle);
        });
    }

    private renderList() {
        this.list.innerHTML = '';
        const ordered = this.getOrderedPoints();
        if (!ordered.length) {
            const empty = document.createElement('div');
            empty.className = 'localized-string-helper';
            empty.textContent = 'No map points defined.';
            this.list.appendChild(empty);
            return;
        }

        ordered.forEach((point) => {
            const row = document.createElement('div');
            row.className =
                point.id === this.selectedPointId
                    ? 'fontinfo-axis-map-row selected'
                    : 'fontinfo-axis-map-row';
            row.addEventListener('click', () => this.selectPoint(point.id));

            row.appendChild(
                this.createListField({
                    point,
                    field: 'userspace',
                    value: point.userspace,
                    onCommit: (rawValue) => {
                        const parsedValue = Number(rawValue.trim());
                        if (!Number.isFinite(parsedValue)) {
                            return this.formatValue(point.userspace);
                        }

                        this.updatePoint(
                            point.id,
                            parsedValue,
                            point.designspace
                        );
                        this.commit();
                        return this.formatValue(
                            this.getOrderedPoints().find(
                                (candidate) => candidate.id === point.id
                            )?.userspace ?? point.userspace
                        );
                    }
                })
            );

            row.appendChild(
                this.createListField({
                    point,
                    field: 'designspace',
                    value: point.designspace,
                    onCommit: (rawValue) => {
                        const parsedValue = Number(rawValue.trim());
                        if (!Number.isFinite(parsedValue)) {
                            return this.formatValue(point.designspace);
                        }

                        this.updatePoint(
                            point.id,
                            point.userspace,
                            parsedValue
                        );
                        this.commit();
                        return this.formatValue(
                            this.getOrderedPoints().find(
                                (candidate) => candidate.id === point.id
                            )?.designspace ?? point.designspace
                        );
                    }
                })
            );

            this.list.appendChild(row);
        });
    }

    private createListField(options: {
        point: AxisMapPoint;
        field: 'userspace' | 'designspace';
        value: number;
        onCommit: (rawValue: string) => string;
    }): HTMLElement {
        const input = document.createElement('input');
        input.type = 'text';
        input.inputMode = 'numeric';
        input.className =
            options.field === 'userspace'
                ? 'localized-string-input fontinfo-axis-map-input fontinfo-axis-map-row-userspace'
                : 'localized-string-input fontinfo-axis-map-input fontinfo-axis-map-row-designspace';
        input.value = this.formatValue(options.value);

        let lastCommittedValue = input.value;
        const commit = (): void => {
            const normalizedValue = options.onCommit(input.value);
            lastCommittedValue = normalizedValue;
            input.value = normalizedValue;
        };

        input.addEventListener('focus', () => {
            this.selectedPointId = options.point.id;
        });
        input.addEventListener('mousedown', (event) => {
            event.stopPropagation();
        });
        input.addEventListener('click', (event) => {
            event.stopPropagation();
            this.selectedPointId = options.point.id;
        });
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                input.value = lastCommittedValue;
                input.blur();
                return;
            }

            if (event.key === 'Enter' && !event.isComposing) {
                event.preventDefault();
                commit();
                input.blur();
                return;
            }

            if (event.metaKey || event.ctrlKey || event.altKey) {
                return;
            }

            event.stopPropagation();
        });

        return input;
    }

    private render() {
        this.chartLayer.innerHTML = '';
        this.renderAxesAndGrid();
        this.renderPolyline();
        this.renderList();
        this.removeButton.disabled = !this.selectedPointId;
    }
}
