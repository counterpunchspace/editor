import {
    designspaceToUserspace as fonttypesDesignspaceToUserspace,
    normalizeLocation as fonttypesNormalizeLocation,
    normalizeValue as fonttypesNormalizeValue,
    piecewiseLinearMap,
    userspaceToDesignspace as fonttypesUserspaceToDesignspace
} from '@simoncozens/fonttypes';
import type {
    Axis as FonttypesAxis,
    DesignspaceCoordinate,
    DesignspaceLocation,
    NormalizedCoordinate,
    NormalizedLocation,
    UserspaceCoordinate,
    UserspaceLocation,
    UserspaceToDesignspaceMapping
} from '@simoncozens/fonttypes';
import type { Babelfont } from './babelfont';

export {
    piecewiseLinearMap,
    type DesignspaceCoordinate,
    type DesignspaceLocation,
    type NormalizedCoordinate,
    type NormalizedLocation,
    type UserspaceCoordinate,
    type UserspaceLocation
};

export type AxisMap = UserspaceToDesignspaceMapping;

function asUserspaceCoordinate(value: number): UserspaceCoordinate {
    return Number(value) as UserspaceCoordinate;
}

function asDesignspaceCoordinate(value: number): DesignspaceCoordinate {
    return Number(value) as DesignspaceCoordinate;
}

function normalizeAxis(axis: Babelfont.Axis): FonttypesAxis {
    const defaultValue = asUserspaceCoordinate(
        Number(axis.default ?? axis.min ?? axis.max ?? 0)
    );
    const minValue = asUserspaceCoordinate(
        Number(axis.min ?? Number(defaultValue))
    );
    const maxValue = asUserspaceCoordinate(
        Number(axis.max ?? Number(defaultValue))
    );

    return {
        tag: axis.tag,
        name: axis.name?.en || Object.values(axis.name || {})[0] || axis.tag,
        min: minValue,
        max: maxValue,
        default: defaultValue,
        map: axis.map
            ? (axis.map.map(([userspace, designspace]) => [
                  asUserspaceCoordinate(Number(userspace)),
                  asDesignspaceCoordinate(Number(designspace))
              ]) as UserspaceToDesignspaceMapping)
            : undefined,
        hidden: axis.hidden
    };
}

function normalizeAxes(axes: Babelfont.Axis[]): FonttypesAxis[] {
    return axes.map(normalizeAxis);
}

export function userspaceToDesignspace(
    location: UserspaceLocation,
    axes: Babelfont.Axis[]
): DesignspaceLocation {
    return fonttypesUserspaceToDesignspace(location, normalizeAxes(axes));
}

export function designspaceToUserspace(
    location: DesignspaceLocation,
    axes: Babelfont.Axis[]
): UserspaceLocation {
    return fonttypesDesignspaceToUserspace(location, normalizeAxes(axes));
}

export function normalizeLocation(
    location: DesignspaceLocation,
    axes: Babelfont.Axis[]
): NormalizedLocation {
    return fonttypesNormalizeLocation(location, normalizeAxes(axes));
}

export function normalizeValue(
    value: DesignspaceCoordinate,
    axis: Babelfont.Axis,
    extrapolate: boolean = false
): NormalizedCoordinate {
    return fonttypesNormalizeValue(value, normalizeAxis(axis), extrapolate);
}

export type AxisExtensionResult = {
    axes: Babelfont.Axis[];
    changed: boolean;
};

function extrapolateUserspaceForDesignspace(
    map: Array<[number, number]>,
    designValue: number
): number {
    const sortedByDesign = [...map].sort((left, right) => left[1] - right[1]);
    if (sortedByDesign.length === 0) {
        return designValue;
    }
    if (sortedByDesign.length === 1) {
        const [userspace, designspace] = sortedByDesign[0];
        return userspace + (designValue - designspace);
    }

    const minDesign = sortedByDesign[0][1];
    const maxDesign = sortedByDesign[sortedByDesign.length - 1][1];
    if (designValue >= maxDesign) {
        const [u0, d0] = sortedByDesign[sortedByDesign.length - 2];
        const [u1, d1] = sortedByDesign[sortedByDesign.length - 1];
        if (d1 === d0) {
            return u1 + (designValue - d1);
        }
        return u0 + ((designValue - d0) * (u1 - u0)) / (d1 - d0);
    }
    if (designValue <= minDesign) {
        const [u0, d0] = sortedByDesign[0];
        const [u1, d1] = sortedByDesign[1];
        if (d1 === d0) {
            return u0 + (designValue - d0);
        }
        return u0 + ((designValue - d0) * (u1 - u0)) / (d1 - d0);
    }

    // Interior: invert via nearest segment (should be rare; caller checks coverage).
    for (let index = 0; index < sortedByDesign.length - 1; index++) {
        const [u0, d0] = sortedByDesign[index];
        const [u1, d1] = sortedByDesign[index + 1];
        const minSeg = Math.min(d0, d1);
        const maxSeg = Math.max(d0, d1);
        if (designValue < minSeg || designValue > maxSeg || d0 === d1) {
            continue;
        }
        return u0 + ((designValue - d0) * (u1 - u0)) / (d1 - d0);
    }
    return sortedByDesign[sortedByDesign.length - 1][0];
}

/**
 * Extend axis userspace min/max (and map endpoints when present) so a master
 * designspace location is inside the declared axis range. Returns a cloned
 * axes array; `changed` is false when no extension was required.
 */
export function extendAxesForDesignspaceLocation(
    axes: Babelfont.Axis[] | undefined | null,
    designLocation: DesignspaceLocation | undefined | null
): AxisExtensionResult {
    const sourceAxes = Array.isArray(axes) ? axes : [];
    if (
        !designLocation ||
        sourceAxes.length === 0 ||
        Object.keys(designLocation).length === 0
    ) {
        return {
            axes: sourceAxes.map((axis) => ({ ...axis })),
            changed: false
        };
    }

    let changed = false;
    const nextAxes = sourceAxes.map((axis) => {
        const tag = axis.tag;
        if (typeof tag !== 'string' || tag.length === 0) {
            return { ...axis };
        }
        const designValue = designLocation[tag];
        if (typeof designValue !== 'number' || !Number.isFinite(designValue)) {
            return { ...axis };
        }

        const map = Array.isArray(axis.map)
            ? axis.map
                  .map(
                      ([userspace, designspace]) =>
                          [Number(userspace), Number(designspace)] as [
                              number,
                              number
                          ]
                  )
                  .filter(
                      ([userspace, designspace]) =>
                          Number.isFinite(userspace) &&
                          Number.isFinite(designspace)
                  )
            : [];

        if (map.length === 0) {
            const currentMin = Number(axis.min);
            const currentMax = Number(axis.max);
            let nextMin = Number.isFinite(currentMin)
                ? currentMin
                : designValue;
            let nextMax = Number.isFinite(currentMax)
                ? currentMax
                : designValue;
            if (designValue < nextMin) {
                nextMin = designValue;
                changed = true;
            }
            if (designValue > nextMax) {
                nextMax = designValue;
                changed = true;
            }
            return {
                ...axis,
                min: nextMin,
                max: nextMax
            };
        }

        const designValues = map.map(([, designspace]) => designspace);
        const minDesign = Math.min(...designValues);
        const maxDesign = Math.max(...designValues);
        const currentMin = Number(axis.min);
        const currentMax = Number(axis.max);
        let nextMin = Number.isFinite(currentMin) ? currentMin : currentMax;
        let nextMax = Number.isFinite(currentMax) ? currentMax : currentMin;
        let nextMap = map.map(
            ([userspace, designspace]) =>
                [userspace, designspace] as [number, number]
        );

        if (designValue < minDesign || designValue > maxDesign) {
            const userspace = extrapolateUserspaceForDesignspace(
                map,
                designValue
            );
            const filteredMap: Array<[number, number]> = nextMap.filter(
                ([existingUserspace, existingDesign]) =>
                    existingUserspace !== userspace &&
                    existingDesign !== designValue
            );
            nextMap = [
                ...filteredMap,
                [userspace, designValue] as [number, number]
            ].sort((left, right) => left[0] - right[0]) as Array<
                [number, number]
            >;
            if (designValue > maxDesign) {
                nextMax = Math.max(nextMax, userspace);
            } else {
                nextMin = Math.min(nextMin, userspace);
            }
            changed = true;
        } else {
            // Location is inside the mapped designspace span; still ensure
            // userspace min/max cover the mapped userspace for that point.
            const userspaceAtLocation = Number(
                designspaceToUserspace({ [tag]: designValue }, [axis])[tag]
            );
            if (Number.isFinite(userspaceAtLocation)) {
                if (userspaceAtLocation < nextMin) {
                    nextMin = userspaceAtLocation;
                    changed = true;
                }
                if (userspaceAtLocation > nextMax) {
                    nextMax = userspaceAtLocation;
                    changed = true;
                }
            }
        }

        return {
            ...axis,
            min: nextMin,
            max: nextMax,
            map: nextMap
        };
    });

    return { axes: nextAxes, changed };
}

export type UserspaceAxisRange = {
    tag: string;
    min: number;
    max: number;
    default: number;
};

/** Userspace ranges of a font's axes, hidden axes included. */
export function userspaceAxisRanges(
    axes: Babelfont.Axis[]
): UserspaceAxisRange[] {
    return normalizeAxes(axes).map((axis) => ({
        tag: axis.tag,
        min: Math.min(Number(axis.min), Number(axis.max)),
        max: Math.max(Number(axis.min), Number(axis.max)),
        default: Number(axis.default)
    }));
}

/** Clamps `value` into the axis range; non-finite values become the default. */
export function clampToAxisRange(
    value: number,
    axis: UserspaceAxisRange
): number {
    if (!Number.isFinite(value)) {
        return axis.default;
    }
    return Math.min(axis.max, Math.max(axis.min, value));
}

/**
 * Restricts a userspace location to the font's axes. Tags the font does not
 * define are dropped, values are clamped into each axis range, and missing
 * axes get their default. Locations arrive from URLs, saved state and other
 * fonts; interpolation rejects unknown axes and extrapolates out-of-range
 * values into unusable outlines.
 */
export function reconcileUserspaceLocation(
    location: UserspaceLocation,
    axes: readonly UserspaceAxisRange[]
): UserspaceLocation {
    const reconciled: UserspaceLocation = {};
    for (const axis of axes) {
        const raw = location[axis.tag];
        reconciled[axis.tag] = asUserspaceCoordinate(
            raw === undefined
                ? axis.default
                : clampToAxisRange(Number(raw), axis)
        );
    }
    return reconciled;
}

/** True when both locations hold the same tags with the same values. */
export function userspaceLocationsEqual(
    left: UserspaceLocation,
    right: UserspaceLocation
): boolean {
    const leftTags = Object.keys(left);
    if (leftTags.length !== Object.keys(right).length) {
        return false;
    }
    return leftTags.every(
        (tag) => tag in right && Number(left[tag]) === Number(right[tag])
    );
}
