/**
 * Type extensions for Babelfont types
 * These extend the auto-generated babelfont.d.ts with custom properties used in this codebase
 */

import type { Babelfont } from './babelfont';

declare module './babelfont' {
    namespace Babelfont {
        /**
         * Extended Component type with custom layerData property
         */
        export interface Component {
            /**
             * Cached layer data for the component reference
             * Used for rendering and intersection calculations
             */
            layerData?: Layer;
        }

        /**
         * Extended Layer type with custom properties
         */
        export interface Layer {
            /**
             * Legacy master reference (use `master` instead)
             * @deprecated Use `master` property instead
             */
            _master?: string;

            /**
             * Whether this layer is interpolated
             */
            isInterpolated?: boolean;
        }
    }
}

/**
 * Additional types used in the application
 */

/**
 * Normalized layer data structure for rendering
 */
export interface LayerData {
    width: number;
    shapes: Array<{
        nodes?: Array<{
            x: number;
            y: number;
            nodetype: string;
        }>;
        reference?: string;
        transform?: number[];
        layerData?: LayerData;
    }>;
    anchors?: Array<{
        name: string;
        x: number;
        y: number;
    }>;
    guides?: Array<{
        pos: number;
        angle: number;
    }>;
}

/**
 * Design space location type
 */
export type DesignspaceLocation = Record<string, number>;
