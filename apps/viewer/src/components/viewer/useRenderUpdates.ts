/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Render updates hook for the 3D viewport
 * Handles visibility/selection/section/hover state re-render effects
 */

import { useEffect, type MutableRefObject } from 'react';
import type { Renderer, CutPolygon2D, DrawingLine2D, VisualEnhancementOptions } from '@ifc-lite/renderer';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import type { SectionPlane } from '@/store';
import { getThemeClearColor } from '../../utils/viewportUtils.js';

export interface UseRenderUpdatesParams {
  rendererRef: MutableRefObject<Renderer | null>;
  isInitialized: boolean;

  // Theme
  theme: string;
  clearColorRef: MutableRefObject<[number, number, number, number]>;
  visualEnhancementRef: MutableRefObject<VisualEnhancementOptions>;

  // Visibility/selection state (reactive values, not refs)
  hiddenEntities: Set<number>;
  isolatedEntities: Set<number> | null;
  selectedEntityId: number | null;
  selectedEntityIds: Set<number> | undefined;
  selectedModelIndex: number | undefined;
  activeTool: string;
  sectionPlane: SectionPlane;

  // Refs for theme re-render
  hiddenEntitiesRef: MutableRefObject<Set<number>>;
  isolatedEntitiesRef: MutableRefObject<Set<number> | null>;
  selectedEntityIdRef: MutableRefObject<number | null>;
  selectedModelIndexRef: MutableRefObject<number | undefined>;
  selectedEntityIdsRef: MutableRefObject<Set<number> | undefined>;
  sectionPlaneRef: MutableRefObject<SectionPlane>;
  activeToolRef: MutableRefObject<string>;

  // Drawing 2D
  drawing2D: Drawing2D | null;
  show3DOverlay: boolean;
  showHiddenLines: boolean;
}

export function useRenderUpdates(params: UseRenderUpdatesParams): void {
  const {
    rendererRef,
    isInitialized,
    theme,
    clearColorRef,
    visualEnhancementRef,
    hiddenEntities,
    isolatedEntities,
    selectedEntityId,
    selectedEntityIds,
    selectedModelIndex,
    activeTool,
    sectionPlane,
    hiddenEntitiesRef,
    isolatedEntitiesRef,
    selectedEntityIdRef,
    selectedModelIndexRef,
    selectedEntityIdsRef,
    sectionPlaneRef,
    activeToolRef,
    drawing2D,
    show3DOverlay,
    showHiddenLines,
  } = params;

  // Theme-aware clear color update
  useEffect(() => {
    clearColorRef.current = getThemeClearColor(theme as 'light' | 'dark');
    const renderer = rendererRef.current;
    if (renderer && isInitialized) {
      renderer.render({
        hiddenIds: hiddenEntitiesRef.current,
        isolatedIds: isolatedEntitiesRef.current,
        selectedId: selectedEntityIdRef.current,
        selectedModelIndex: selectedModelIndexRef.current,
        clearColor: clearColorRef.current,
        visualEnhancement: visualEnhancementRef.current,
      });
    }
  }, [theme, isInitialized]);

  // 2D section overlay: upload drawing data to renderer when available
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !isInitialized) return;

    if (activeTool === 'section' && drawing2D && drawing2D.cutPolygons.length > 0 && show3DOverlay) {
      const polygons: CutPolygon2D[] = drawing2D.cutPolygons.map((cp) => ({
        polygon: cp.polygon,
        ifcType: cp.ifcType,
        expressId: cp.entityId,
      }));

      const lines: DrawingLine2D[] = drawing2D.lines
        .filter((line) => showHiddenLines || line.visibility !== 'hidden')
        .map((line) => ({
          line: line.line,
          category: line.category,
        }));

      renderer.uploadSection2DOverlay(
        polygons,
        lines,
        sectionPlane.normal,
        sectionPlane.distance,
        sectionPlane.flipped
      );
    } else {
      renderer.clearSection2DOverlay();
    }

    const sectionOpts = (activeTool === 'section' && sectionPlane.enabled)
      ? sectionPlane
      : undefined;

    renderer.render({
      hiddenIds: hiddenEntitiesRef.current,
      isolatedIds: isolatedEntitiesRef.current,
      selectedId: selectedEntityIdRef.current,
      selectedIds: selectedEntityIdsRef.current,
      selectedModelIndex: selectedModelIndexRef.current,
      clearColor: clearColorRef.current,
      visualEnhancement: visualEnhancementRef.current,
      sectionPlane: sectionOpts,
    });
  }, [drawing2D, activeTool, sectionPlane, isInitialized, show3DOverlay, showHiddenLines]);

  // Re-render when visibility, selection, or section plane changes
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !isInitialized) return;

    const sectionOpts = (activeTool === 'section' && sectionPlane.enabled)
      ? sectionPlane
      : undefined;

    renderer.render({
      hiddenIds: hiddenEntities,
      isolatedIds: isolatedEntities,
      selectedId: selectedEntityId,
      selectedIds: selectedEntityIds,
      selectedModelIndex,
      clearColor: clearColorRef.current,
      visualEnhancement: visualEnhancementRef.current,
      sectionPlane: sectionOpts,
    });
  }, [hiddenEntities, isolatedEntities, selectedEntityId, selectedEntityIds, selectedModelIndex, isInitialized, sectionPlane, activeTool]);
}

export default useRenderUpdates;
