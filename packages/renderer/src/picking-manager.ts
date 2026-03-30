/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PickingManager - Handles GPU-based object picking at screen coordinates.
 * Extracted from the Renderer class to use composition pattern.
 */

import { Camera } from './camera.js';
import { Scene } from './scene.js';
import { Picker } from './picker.js';
import type { MeshData } from '@ifc-lite/geometry';
import type { PickOptions, PickResult } from './types.js';

export class PickingManager {
    private camera: Camera;
    private scene: Scene;
    private picker: Picker | null;
    private canvas: HTMLCanvasElement;
    private createMeshFromDataFn: (meshData: MeshData) => void;

    constructor(
        camera: Camera,
        scene: Scene,
        picker: Picker | null,
        canvas: HTMLCanvasElement,
        createMeshFromDataFn: (meshData: MeshData) => void
    ) {
        this.camera = camera;
        this.scene = scene;
        this.picker = picker;
        this.canvas = canvas;
        this.createMeshFromDataFn = createMeshFromDataFn;
    }

    /**
     * Update the picker reference (e.g., after init)
     */
    setPicker(picker: Picker | null): void {
        this.picker = picker;
    }

    /**
     * Pick object at screen coordinates
     * Respects visibility filtering so users can only select visible elements
     * Returns PickResult with expressId and modelIndex for multi-model support
     *
     * Note: x, y are CSS pixel coordinates relative to the canvas element.
     * These are scaled internally to match the actual canvas pixel dimensions.
     */
    async pick(x: number, y: number, options?: PickOptions): Promise<PickResult | null> {
        if (!this.picker) {
            return null;
        }

        // Scale CSS pixel coordinates to canvas pixel coordinates
        // The canvas.width may differ from CSS width due to 64-pixel alignment for WebGPU
        const rect = this.canvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
            return null;
        }
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const scaledX = x * scaleX;
        const scaledY = y * scaleY;

        // Skip picker during streaming for consistent performance
        // Picking during streaming would be slow and incomplete anyway
        if (options?.isStreaming) {
            return null;
        }

        let meshes = this.scene.getMeshes();
        let batchedMeshes = this.scene.getBatchedMeshes();

        if (options?.hiddenIds && options.hiddenIds.size > 0) {
            meshes = meshes.filter(mesh => !options.hiddenIds!.has(mesh.expressId));
            batchedMeshes = batchedMeshes.filter(batch => batch.expressIds.some((id) => !options.hiddenIds!.has(id)));
        }
        if (options?.isolatedIds !== null && options?.isolatedIds !== undefined) {
            meshes = meshes.filter(mesh => options.isolatedIds!.has(mesh.expressId));
            batchedMeshes = batchedMeshes.filter(batch => batch.expressIds.some((id) => options.isolatedIds!.has(id)));
        }
        if (options?.visibleModelIndices !== null && options?.visibleModelIndices !== undefined) {
            meshes = meshes.filter(mesh => mesh.modelIndex === undefined || options.visibleModelIndices!.has(mesh.modelIndex));
            batchedMeshes = batchedMeshes.filter(batch => batch.modelIndex === undefined || options.visibleModelIndices!.has(batch.modelIndex));
        }

        const renderables = batchedMeshes.length > 0 ? [...batchedMeshes, ...meshes] : meshes;
        if (renderables.length === 0) {
            return null;
        }

        const viewProj = this.camera.getViewProjMatrix().m;
        return this.picker.pick(scaledX, scaledY, this.canvas.width, this.canvas.height, renderables, viewProj);
    }
}
