import type {
    DesignspaceLocation,
    DesignspaceCoordinate
} from '@simoncozens/fonttypes';
import type { Axis } from './babelfont-types';

type Tag = string;
type UserspaceCoordinate = number;
type NormalizedCoordinate = number;
export type { DesignspaceLocation, DesignspaceCoordinate };
type UserspaceLocation = Record<Tag, UserspaceCoordinate>;
type NormalizedLocation = Record<Tag, NormalizedCoordinate>;

export type AxisMap = [UserspaceCoordinate, number][];

/**
 * Convert a plain number object to DesignspaceLocation
 * The branded types are just for type-safety and are numbers at runtime
 */
export function toDesignspaceLocation(
    obj: Record<string, number>
): DesignspaceLocation {
    return obj as DesignspaceLocation;
}

/**
 * Convert DesignspaceLocation to plain number object
 */
export function fromDesignspaceLocation(
    loc: DesignspaceLocation
): Record<string, number> {
    const result: Record<string, number> = {};
    for (const key in loc) {
        // Cast Coordinate<Designspace> to number - they're the same at runtime
        result[key] = loc[key] as unknown as number;
    }
    return result;
}

export function piecewiseLinearMap(
    input: UserspaceCoordinate,
    mapping: AxisMap
): number {
    if (mapping.length === 0) {
        return input;
    }

    if (input <= mapping[0][0]) {
        return mapping[0][1];
    }
    if (input >= mapping[mapping.length - 1][0]) {
        return mapping[mapping.length - 1][1];
    }

    for (let i = 0; i < mapping.length - 1; i++) {
        const [x0, y0] = mapping[i];
        const [x1, y1] = mapping[i + 1];
        if (input >= x0 && input <= x1) {
            const t = (input - x0) / (x1 - x0);
            return y0 + t * (y1 - y0);
        }
    }

    return input;
}

export function userspaceToDesignspace(
    location: UserspaceLocation,
    axes: Axis[]
): DesignspaceLocation {
    const result: any = {};
    console.log('Mapping userspace location to designspace:', location);
    console.log('Userspace to designspace axes:', axes);
    for (const axis of axes) {
        const tag = axis.tag;
        const userValue = location[tag] ?? axis.default;
        const mapping = axis.map || []; // Handle undefined map
        result[tag] = piecewiseLinearMap(userValue, mapping as any);
    }
    console.log('Result:', result);
    return result as DesignspaceLocation;
}

export function designspaceToUserspace(
    location: DesignspaceLocation,
    axes: Axis[]
): DesignspaceLocation {
    const result: any = {};
    console.log('Mapping userspace location to designspace:', location);
    console.log('Userspace to designspace axes:', axes);
    for (const axis of axes) {
        const tag = axis.tag;
        const userValue = (location[tag] as any) ?? axis.default;
        const mapping: AxisMap = axis.map
            ? (axis.map.map(([u, d]) => [d, u]) as any)
            : []; // Handle undefined map and invert
        result[tag] = piecewiseLinearMap(userValue, mapping);
    }
    console.log('Result:', result);
    return result as DesignspaceLocation;
}
