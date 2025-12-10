export interface Point {
    x: number;
    y: number;
}

export interface Rect {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

export interface RectWithWidthHeight extends Rect {
    width: number;
    height: number;
}

export type Transform = [number, number, number, number, number, number];
