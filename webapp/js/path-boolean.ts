export type PathBooleanOp = 'union' | 'difference' | 'intersection' | 'xor';

export type BooleanPathNode = {
    x: number;
    y: number;
    nodetype: string;
};

export type BooleanPathJson = {
    closed: boolean;
    nodes: BooleanPathNode[];
};

export function pathBooleanLabel(op: PathBooleanOp): string {
    switch (op) {
        case 'union':
            return 'Union paths';
        case 'difference':
            return 'Difference paths';
        case 'intersection':
            return 'Intersection paths';
        case 'xor':
            return 'Exclusion paths';
    }
}

export const PATH_BOOLEAN_OPERATIONS: Array<{
    op: PathBooleanOp;
    label: string;
    icon: string;
    fill: boolean;
}> = [
    { op: 'union', label: 'Union', icon: 'join', fill: true },
    { op: 'difference', label: 'Difference', icon: 'join_left', fill: false },
    {
        op: 'intersection',
        label: 'Intersection',
        icon: 'join_inner',
        fill: false
    },
    { op: 'xor', label: 'Exclusion', icon: 'join', fill: false }
];

export function shouldShowPathBooleanButtons(options: {
    selectedPathCount: number;
    allSelectedPathsClosed: boolean;
    isInterpolated: boolean;
}): boolean {
    return (
        !options.isInterpolated &&
        options.allSelectedPathsClosed &&
        options.selectedPathCount >= 2
    );
}

function signatureNodeType(nodetype: string): string {
    switch (nodetype.toLowerCase()) {
        case 'move':
        case 'moveto':
            return 'Move';
        case 'line':
        case 'lineto':
            return 'Line';
        case 'offcurve':
        case 'off':
            return 'OffCurve';
        case 'curve':
        case 'curveto':
            return 'Curve';
        case 'qcurve':
        case 'qcurveto':
            return 'QCurve';
        default:
            return nodetype;
    }
}

/** Structural signature of a boolean result, ignoring coordinates. */
export function booleanResultSignature(paths: BooleanPathJson[]): string {
    return paths
        .map((path) => {
            const types = path.nodes
                .map((node) => signatureNodeType(node.nodetype))
                .join(',');
            const closedFlag = path.closed === false ? '0' : '1';
            return `P:${closedFlag}:${path.nodes.length}:${types}`;
        })
        .join('|');
}

/** True when every layer's result has the same contour structure. */
export function booleanResultsMatch(results: BooleanPathJson[][]): boolean {
    if (results.length <= 1) {
        return true;
    }
    const reference = booleanResultSignature(results[0]);
    return results.every(
        (paths) => booleanResultSignature(paths) === reference
    );
}
