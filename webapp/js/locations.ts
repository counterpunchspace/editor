import { PythonBabelfont } from './pythonbabelfont';

type Tag = string;
type DesignspaceCoordinate = number;
type UserspaceCoordinate = number;
type NormalizedCoordinate = number;
export type DesignspaceLocation = Record<Tag, DesignspaceCoordinate>;
type UserspaceLocation = Record<Tag, UserspaceCoordinate>;
type NormalizedLocation = Record<Tag, NormalizedCoordinate>;

export type AxisMap = [UserspaceCoordinate, DesignspaceCoordinate][];

export function piecewiseLinearMap(
    input: UserspaceCoordinate,
    mapping: AxisMap
): DesignspaceCoordinate {
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
    axes: PythonBabelfont.Axis[]
): DesignspaceLocation {
    const result: DesignspaceLocation = {};
    console.log('Mapping userspace location to designspace:', location);
    console.log('Userspace to designspace axes:', axes);
    for (const axis of axes) {
        const tag = axis.tag;
        const userValue = location[tag] ?? axis.default;
        const mapping = axis.map;
        result[tag] = piecewiseLinearMap(userValue, mapping);
    }
    console.log('Result:', result);
    return result;
}

export function designspaceToUserspace(
    location: DesignspaceLocation,
    axes: PythonBabelfont.Axis[]
): DesignspaceLocation {
    const result: DesignspaceLocation = {};
    console.log('Mapping userspace location to designspace:', location);
    console.log('Userspace to designspace axes:', axes);
    for (const axis of axes) {
        const tag = axis.tag;
        const userValue = location[tag] ?? axis.default;
        const mapping: AxisMap = axis.map.map(([u, d]) => [d, u]); // Invert mapping
        result[tag] = piecewiseLinearMap(userValue, mapping);
    }
    console.log('Result:', result);
    return result;
}
