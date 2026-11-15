import type { Babelfont } from './babelfont';

type HorizontalTranslationAdapter<TShape, TAnchor> = {
    shapes?: Iterable<TShape> | null;
    anchors?: Iterable<TAnchor> | null;
    getPathNodes(shape: TShape): Babelfont.Node[] | null;
    getOrCreateComponentTransform(
        shape: TShape
    ): Babelfont.DecomposedAffine | null;
    shiftAnchor(anchor: TAnchor, deltaX: number): void;
};

export function translateDrawingContentsX<TShape, TAnchor>(
    adapter: HorizontalTranslationAdapter<TShape, TAnchor>,
    deltaX: number
): void {
    if (deltaX === 0) {
        return;
    }

    for (const shape of adapter.shapes || []) {
        const pathNodes = adapter.getPathNodes(shape);
        if (pathNodes) {
            for (const node of pathNodes) {
                node.x += deltaX;
            }
            continue;
        }

        const transform = adapter.getOrCreateComponentTransform(shape);
        if (!transform) {
            continue;
        }

        if (!transform.translation) {
            transform.translation = [0, 0];
        }
        transform.translation[0] += deltaX;
    }

    for (const anchor of adapter.anchors || []) {
        adapter.shiftAnchor(anchor, deltaX);
    }
}
