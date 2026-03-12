/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * useDrawingGeneration - Custom hook for 2D drawing generation logic
 *
 * Updated for face-based sections: receives arbitrary plane (normal + distance)
 * and maps to the closest geometric axis for 2D projection.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Drawing2DGenerator,
  createSectionConfig,
  type Drawing2D,
  type DrawingLine,
  type SectionConfig,
} from '@ifc-lite/drawing-2d';
import { GeometryProcessor, type GeometryResult } from '@ifc-lite/geometry';

/** Map an arbitrary plane normal to the dominant geometric axis for 2D projection */
function dominantAxis(normal: { x: number; y: number; z: number }): 'x' | 'y' | 'z' {
  const absX = Math.abs(normal.x), absY = Math.abs(normal.y), absZ = Math.abs(normal.z);
  if (absY >= absX && absY >= absZ) return 'y';
  if (absZ >= absX) return 'z';
  return 'x';
}

interface UseDrawingGenerationParams {
  geometryResult: GeometryResult | null | undefined;
  ifcDataStore: { source: Uint8Array } | null;
  sectionPlane: { normal: { x: number; y: number; z: number }; distance: number; flipped: boolean };
  displayOptions: { showHiddenLines: boolean; useSymbolicRepresentations: boolean; show3DOverlay: boolean; scale: number };
  combinedHiddenIds: Set<number>;
  combinedIsolatedIds: Set<number> | null;
  computedIsolatedIds?: Set<number> | null;
  models: Map<string, { id: string; visible: boolean; idOffset?: number }>;
  panelVisible: boolean;
  drawing: Drawing2D | null;
  // Store actions
  setDrawing: (d: Drawing2D | null) => void;
  setDrawingStatus: (s: 'idle' | 'generating' | 'ready' | 'error') => void;
  setDrawingProgress: (p: number, phase: string) => void;
  setDrawingError: (e: string | null) => void;
}

interface UseDrawingGenerationResult {
  generateDrawing: (isRegenerate?: boolean) => Promise<void>;
  doRegenerate: () => Promise<void>;
  isRegenerating: boolean;
}

export function useDrawingGeneration({
  geometryResult,
  ifcDataStore,
  sectionPlane,
  displayOptions,
  combinedHiddenIds,
  combinedIsolatedIds,
  computedIsolatedIds,
  models,
  panelVisible,
  drawing,
  setDrawing,
  setDrawingStatus,
  setDrawingProgress,
  setDrawingError,
}: UseDrawingGenerationParams): UseDrawingGenerationResult {
  const isRegeneratingRef = useRef(false);

  // Cache for symbolic representations
  const symbolicCacheRef = useRef<{
    lines: DrawingLine[];
    entities: Set<number>;
    sourceId: string | null;
    useSymbolic: boolean;
  } | null>(null);

  const generateDrawing = useCallback(async (isRegenerate = false) => {
    if (!geometryResult?.meshes || geometryResult.meshes.length === 0) {
      setDrawing(null);
      setDrawingStatus('idle');
      setDrawingError('No visible geometry');
      return;
    }

    if (!isRegenerate) {
      setDrawingStatus('generating');
      setDrawingProgress(0, 'Initializing...');
    }
    isRegeneratingRef.current = isRegenerate;

    // Parse symbolic representations if enabled
    let symbolicLines: DrawingLine[] = [];
    let entitiesWithSymbols = new Set<number>();

    const modelCacheKey = models.size > 0
      ? `${models.size}-${[...models.values()].filter(m => m.visible).map(m => m.id).sort().join(',')}`
      : (ifcDataStore?.source ? String(ifcDataStore.source.byteLength) : null);

    const useSymbolic = displayOptions.useSymbolicRepresentations && !!ifcDataStore?.source;

    const cache = symbolicCacheRef.current;
    const cacheValid = cache && cache.sourceId === modelCacheKey && cache.useSymbolic === useSymbolic;

    if (useSymbolic) {
      if (cacheValid) {
        symbolicLines = cache.lines;
        entitiesWithSymbols = cache.entities;
      } else {
        try {
          if (!isRegenerate) setDrawingProgress(5, 'Parsing symbolic representations...');

          const processor = new GeometryProcessor();
          try {
            await processor.init();
            const symbolicCollection = processor.parseSymbolicRepresentations(ifcDataStore!.source);
            const symbolicModelIndex = 0;

            if (symbolicCollection && !symbolicCollection.isEmpty) {
              for (let i = 0; i < symbolicCollection.polylineCount; i++) {
                const poly = symbolicCollection.getPolyline(i);
                if (!poly) continue;
                entitiesWithSymbols.add(poly.expressId);
                const points = poly.points;
                const pointCount = poly.pointCount;
                for (let j = 0; j < pointCount - 1; j++) {
                  symbolicLines.push({
                    line: {
                      start: { x: points[j * 2], y: points[j * 2 + 1] },
                      end: { x: points[(j + 1) * 2], y: points[(j + 1) * 2 + 1] }
                    },
                    category: 'silhouette', visibility: 'visible',
                    entityId: poly.expressId, ifcType: poly.ifcType,
                    modelIndex: symbolicModelIndex, depth: 0,
                  });
                }
                if (poly.isClosed && pointCount > 2) {
                  symbolicLines.push({
                    line: {
                      start: { x: points[(pointCount - 1) * 2], y: points[(pointCount - 1) * 2 + 1] },
                      end: { x: points[0], y: points[1] }
                    },
                    category: 'silhouette', visibility: 'visible',
                    entityId: poly.expressId, ifcType: poly.ifcType,
                    modelIndex: symbolicModelIndex, depth: 0,
                  });
                }
              }

              for (let i = 0; i < symbolicCollection.circleCount; i++) {
                const circle = symbolicCollection.getCircle(i);
                if (!circle) continue;
                entitiesWithSymbols.add(circle.expressId);
                const numSegments = circle.isFullCircle ? 32 : 16;
                for (let j = 0; j < numSegments; j++) {
                  const t1 = j / numSegments;
                  const t2 = (j + 1) / numSegments;
                  const a1 = circle.startAngle + t1 * (circle.endAngle - circle.startAngle);
                  const a2 = circle.startAngle + t2 * (circle.endAngle - circle.startAngle);
                  symbolicLines.push({
                    line: {
                      start: { x: circle.centerX + circle.radius * Math.cos(a1), y: circle.centerY + circle.radius * Math.sin(a1) },
                      end: { x: circle.centerX + circle.radius * Math.cos(a2), y: circle.centerY + circle.radius * Math.sin(a2) },
                    },
                    category: 'silhouette', visibility: 'visible',
                    entityId: circle.expressId, ifcType: circle.ifcType,
                    modelIndex: symbolicModelIndex, depth: 0,
                  });
                }
              }
            }
          } finally {
            processor.dispose();
          }

          symbolicCacheRef.current = { lines: symbolicLines, entities: entitiesWithSymbols, sourceId: modelCacheKey, useSymbolic };
        } catch (error) {
          console.warn('Symbolic parsing failed:', error);
          symbolicLines = [];
          entitiesWithSymbols = new Set<number>();
        }
      }
    } else if (cache && cache.useSymbolic) {
      symbolicCacheRef.current = null;
    }

    let generator: Drawing2DGenerator | null = null;
    try {
      generator = new Drawing2DGenerator();
      await generator.initialize();

      // Map arbitrary normal to dominant axis for 2D projection
      const axis = dominantAxis(sectionPlane.normal);
      const position = sectionPlane.distance;

      // Calculate max depth as half the model extent along the dominant axis
      const bounds = geometryResult.coordinateInfo.shiftedBounds;
      const axisMin = bounds.min[axis];
      const axisMax = bounds.max[axis];
      const maxDepth = (axisMax - axisMin) * 0.5;

      const progressOffset = symbolicLines.length > 0 ? 20 : 0;
      const progressScale = symbolicLines.length > 0 ? 0.8 : 1;
      const progressCallback = (stage: string, prog: number) => {
        setDrawingProgress(progressOffset + prog * 100 * progressScale, stage);
      };

      const config: SectionConfig = createSectionConfig(axis, position, {
        projectionDepth: maxDepth,
        includeHiddenLines: displayOptions.showHiddenLines,
        scale: displayOptions.scale,
      });
      config.plane.flipped = sectionPlane.flipped;

      // Filter meshes by visibility
      let meshesToProcess = geometryResult.meshes;
      if (combinedHiddenIds.size > 0) {
        meshesToProcess = meshesToProcess.filter(mesh => !combinedHiddenIds.has(mesh.expressId));
      }
      if (combinedIsolatedIds !== null) {
        meshesToProcess = meshesToProcess.filter(mesh => combinedIsolatedIds.has(mesh.expressId));
      }
      if (computedIsolatedIds !== null && computedIsolatedIds !== undefined && computedIsolatedIds.size > 0) {
        const isolatedSet = computedIsolatedIds;
        meshesToProcess = meshesToProcess.filter(mesh => isolatedSet.has(mesh.expressId));
      }

      if (meshesToProcess.length === 0) {
        setDrawing(null);
        setDrawingStatus('idle');
        setDrawingError(null);
        return;
      }

      const result = await generator.generate(meshesToProcess, config, {
        includeHiddenLines: false,
        includeProjection: false,
        includeEdges: false,
        mergeLines: true,
        onProgress: progressCallback,
      });

      // Hybrid drawing with symbolic representations
      if (symbolicLines.length > 0 && entitiesWithSymbols.size > 0) {
        const cutEntityIds = new Set<number>();
        for (const line of result.lines) {
          if (line.entityId !== undefined) cutEntityIds.add(line.entityId);
        }
        for (const poly of result.cutPolygons ?? []) {
          if ((poly as { entityId?: number }).entityId !== undefined) {
            cutEntityIds.add((poly as { entityId?: number }).entityId!);
          }
        }

        const relevantSymbolicLines = symbolicLines.filter(line =>
          line.entityId !== undefined && cutEntityIds.has(line.entityId)
        );

        const entitiesWithRelevantSymbols = new Set<number>();
        for (const line of relevantSymbolicLines) {
          if (line.entityId !== undefined) entitiesWithRelevantSymbols.add(line.entityId);
        }

        // Per-entity bounding box alignment
        const sectionCutBounds = new Map<number, { minX: number; minY: number; maxX: number; maxY: number }>();
        const updateBounds = (entityId: number, x: number, y: number) => {
          const b = sectionCutBounds.get(entityId) ?? { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
          b.minX = Math.min(b.minX, x); b.minY = Math.min(b.minY, y);
          b.maxX = Math.max(b.maxX, x); b.maxY = Math.max(b.maxY, y);
          sectionCutBounds.set(entityId, b);
        };
        for (const line of result.lines) {
          if (line.entityId === undefined) continue;
          updateBounds(line.entityId, line.line.start.x, line.line.start.y);
          updateBounds(line.entityId, line.line.end.x, line.line.end.y);
        }
        for (const poly of result.cutPolygons ?? []) {
          const entityId = (poly as { entityId?: number }).entityId;
          if (entityId === undefined) continue;
          for (const pt of poly.polygon.outer) updateBounds(entityId, pt.x, pt.y);
          for (const hole of poly.polygon.holes) for (const pt of hole) updateBounds(entityId, pt.x, pt.y);
        }

        const symbolicBounds = new Map<number, { minX: number; minY: number; maxX: number; maxY: number }>();
        for (const line of relevantSymbolicLines) {
          if (line.entityId === undefined) continue;
          const b = symbolicBounds.get(line.entityId) ?? { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
          b.minX = Math.min(b.minX, line.line.start.x, line.line.end.x);
          b.minY = Math.min(b.minY, line.line.start.y, line.line.end.y);
          b.maxX = Math.max(b.maxX, line.line.start.x, line.line.end.x);
          b.maxY = Math.max(b.maxY, line.line.start.y, line.line.end.y);
          symbolicBounds.set(line.entityId, b);
        }

        const alignmentOffsets = new Map<number, { dx: number; dy: number }>();
        for (const entityId of entitiesWithRelevantSymbols) {
          const scB = sectionCutBounds.get(entityId);
          const symB = symbolicBounds.get(entityId);
          if (scB && symB) {
            alignmentOffsets.set(entityId, {
              dx: (scB.minX + scB.maxX) / 2 - (symB.minX + symB.maxX) / 2,
              dy: (scB.minY + scB.maxY) / 2 - (symB.minY + symB.maxY) / 2,
            });
          }
        }

        const alignedSymbolicLines = relevantSymbolicLines.map(line => {
          const offset = line.entityId !== undefined ? alignmentOffsets.get(line.entityId) : undefined;
          if (offset) {
            return {
              ...line,
              line: {
                start: { x: line.line.start.x + offset.dx, y: line.line.start.y + offset.dy },
                end: { x: line.line.end.x + offset.dx, y: line.line.end.y + offset.dy },
              },
            };
          }
          return line;
        });

        const filteredLines = result.lines.filter((line: DrawingLine) =>
          line.entityId === undefined || !entitiesWithRelevantSymbols.has(line.entityId)
        );
        const filteredCutPolygons = result.cutPolygons?.filter((poly: { entityId?: number }) =>
          poly.entityId === undefined || !entitiesWithRelevantSymbols.has(poly.entityId)
        ) ?? [];

        const combinedLines = [...filteredLines, ...alignedSymbolicLines];

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const line of combinedLines) {
          minX = Math.min(minX, line.line.start.x, line.line.end.x);
          minY = Math.min(minY, line.line.start.y, line.line.end.y);
          maxX = Math.max(maxX, line.line.start.x, line.line.end.x);
          maxY = Math.max(maxY, line.line.start.y, line.line.end.y);
        }
        for (const poly of filteredCutPolygons) {
          for (const pt of poly.polygon.outer) { minX = Math.min(minX, pt.x); minY = Math.min(minY, pt.y); maxX = Math.max(maxX, pt.x); maxY = Math.max(maxY, pt.y); }
          for (const hole of poly.polygon.holes) for (const pt of hole) { minX = Math.min(minX, pt.x); minY = Math.min(minY, pt.y); maxX = Math.max(maxX, pt.x); maxY = Math.max(maxY, pt.y); }
        }

        const hybridDrawing: Drawing2D = {
          ...result,
          lines: combinedLines,
          cutPolygons: filteredCutPolygons,
          bounds: {
            min: { x: isFinite(minX) ? minX : result.bounds.min.x, y: isFinite(minY) ? minY : result.bounds.min.y },
            max: { x: isFinite(maxX) ? maxX : result.bounds.max.x, y: isFinite(maxY) ? maxY : result.bounds.max.y },
          },
          stats: { ...result.stats, cutLineCount: combinedLines.length },
        };
        setDrawing(hybridDrawing);
      } else {
        setDrawing(result);
      }

      setDrawingStatus('ready');
      isRegeneratingRef.current = false;
    } catch (error) {
      console.error('Drawing generation failed:', error);
      setDrawingError(error instanceof Error ? error.message : 'Generation failed');
    } finally {
      generator?.dispose();
    }
  }, [
    geometryResult, ifcDataStore, sectionPlane, displayOptions,
    combinedHiddenIds, combinedIsolatedIds, computedIsolatedIds, models,
    setDrawing, setDrawingStatus, setDrawingProgress, setDrawingError,
  ]);

  const prevPanelVisibleRef = useRef(false);
  const prevOverlayEnabledRef = useRef(false);
  const prevMeshCountRef = useRef(0);

  useEffect(() => {
    const wasVisible = prevPanelVisibleRef.current;
    const wasOverlayEnabled = prevOverlayEnabledRef.current;
    const prevMeshCount = prevMeshCountRef.current;
    const currentMeshCount = geometryResult?.meshes?.length ?? 0;
    const hasGeometry = currentMeshCount > 0;

    const panelJustOpened = panelVisible && !wasVisible;
    const overlayJustEnabled = displayOptions.show3DOverlay && !wasOverlayEnabled;
    const isNowActive = panelVisible || displayOptions.show3DOverlay;
    const geometryChanged = currentMeshCount !== prevMeshCount;

    prevPanelVisibleRef.current = panelVisible;
    prevOverlayEnabledRef.current = displayOptions.show3DOverlay;
    prevMeshCountRef.current = currentMeshCount;

    if (isNowActive) {
      if (!hasGeometry) {
        if (drawing) { setDrawing(null); setDrawingStatus('idle'); }
      } else if (panelJustOpened || overlayJustEnabled || !drawing || geometryChanged) {
        generateDrawing();
      }
    }
  }, [panelVisible, displayOptions.show3DOverlay, drawing, geometryResult, generateDrawing, setDrawing, setDrawingStatus]);

  // Auto-regenerate when section plane changes
  const sectionRef = useRef({ normal: sectionPlane.normal, distance: sectionPlane.distance, flipped: sectionPlane.flipped });
  const isGeneratingRef = useRef(false);
  const latestSectionRef = useRef({ normal: sectionPlane.normal, distance: sectionPlane.distance, flipped: sectionPlane.flipped });
  const [isRegenerating, setIsRegenerating] = useState(false);

  const doRegenerate = useCallback(async () => {
    if (isGeneratingRef.current) return;

    isGeneratingRef.current = true;
    setIsRegenerating(true);

    const targetSection = { ...latestSectionRef.current };

    try {
      await generateDrawing(true);
    } finally {
      isGeneratingRef.current = false;
      setIsRegenerating(false);

      const current = latestSectionRef.current;
      if (
        current.normal !== targetSection.normal ||
        current.distance !== targetSection.distance ||
        current.flipped !== targetSection.flipped
      ) {
        queueMicrotask(() => doRegenerate());
      }
    }
  }, [generateDrawing]);

  useEffect(() => {
    latestSectionRef.current = { normal: sectionPlane.normal, distance: sectionPlane.distance, flipped: sectionPlane.flipped };

    const prev = sectionRef.current;
    if (
      prev.normal === sectionPlane.normal &&
      prev.distance === sectionPlane.distance &&
      prev.flipped === sectionPlane.flipped
    ) {
      return;
    }

    sectionRef.current = { normal: sectionPlane.normal, distance: sectionPlane.distance, flipped: sectionPlane.flipped };

    if ((panelVisible || displayOptions.show3DOverlay) && geometryResult?.meshes) {
      doRegenerate();
    }
  }, [panelVisible, displayOptions.show3DOverlay, sectionPlane.normal, sectionPlane.distance, sectionPlane.flipped, geometryResult, combinedHiddenIds, combinedIsolatedIds, computedIsolatedIds, doRegenerate]);

  return { generateDrawing, doRegenerate, isRegenerating };
}

export default useDrawingGeneration;
