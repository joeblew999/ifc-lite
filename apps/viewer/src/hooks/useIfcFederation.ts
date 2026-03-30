/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hook for multi-model federation operations
 * Handles addModel, removeModel, ID offset management, RTC alignment,
 * IFCX federated layer composition, and legacy model migration
 *
 * Extracted from useIfc.ts for better separation of concerns
 */

import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useViewerStore, type FederatedModel, type SchemaVersion } from '../store.js';
import { IfcParser, detectFormat, parseIfcx, parseFederatedIfcx, type IfcDataStore, type FederatedIfcxParseResult } from '@ifc-lite/parser';
import { buildHugeGeometryChunks, GeometryProcessor, GeometryQuality, type CoordinateInfo, type HugeGeometryChunk, type HugeGeometryEntityInfo, type HugeGeometryStats, type MeshData } from '@ifc-lite/geometry';
import { IfcQuery } from '@ifc-lite/query';
import { buildSpatialIndexGuarded } from '../utils/loadingUtils.js';
import { loadGLBToMeshData } from '@ifc-lite/cache';

import { getDynamicBatchConfig } from '../utils/ifcConfig.js';
import {
  calculateMeshBounds,
  createCoordinateInfo,
  calculateStoreyHeights,
  normalizeColor,
} from '../utils/localParsingUtils.js';

/**
 * Extended data store type for IFCX (IFC5) files.
 * IFCX uses schemaVersion 'IFC5' and may include federated composition metadata.
 */
export interface IfcxDataStore extends IfcDataStore {
  schemaVersion: 'IFC5';
  /** Federated layer info for re-composition */
  _federatedLayers?: Array<{ id: string; name: string; enabled: boolean }>;
  /** Original buffers for re-composition when adding overlays */
  _federatedBuffers?: Array<{ buffer: ArrayBuffer; name: string }>;
  /** Composition statistics */
  _compositionStats?: { layersUsed: number; inheritanceResolutions: number; crossLayerReferences: number };
  /** Layer info for display */
  _layerInfo?: Array<{ id: string; name: string; meshCount: number }>;
}

/** Shape of raw meshes returned from IFCX parsers before conversion to MeshData */
interface RawIfcxMesh {
  expressId?: number;
  express_id?: number;
  id?: number;
  positions: Float32Array | number[];
  indices: Uint32Array | number[];
  normals: Float32Array | number[];
  color?: [number, number, number, number] | [number, number, number];
  ifcType?: string;
  ifc_type?: string;
}

/**
 * Convert raw IFCX parser meshes to viewer-compatible MeshData[].
 * Ensures typed arrays, normalizes colors, and filters out empty meshes.
 */
function convertIfcxMeshes(rawMeshes: RawIfcxMesh[]): MeshData[] {
  return rawMeshes.map((m) => {
    const positions = m.positions instanceof Float32Array ? m.positions : new Float32Array(m.positions || []);
    const indices = m.indices instanceof Uint32Array ? m.indices : new Uint32Array(m.indices || []);
    const normals = m.normals instanceof Float32Array ? m.normals : new Float32Array(m.normals || []);
    const color = normalizeColor(m.color);

    return {
      expressId: m.expressId ?? m.express_id ?? m.id ?? 0,
      positions,
      indices,
      normals,
      color,
      ifcType: m.ifcType ?? m.ifc_type ?? 'IfcProduct',
    };
  }).filter((m) => m.positions.length > 0 && m.indices.length > 0);
}

function applyGlobalIdOffsetToHugeChunks(chunks: HugeGeometryChunk[], idOffset: number): void {
  if (idOffset === 0) return;

  for (const chunk of chunks) {
    const vertexIds = new Uint32Array(chunk.vertexData.buffer);
    for (const element of chunk.elements) {
      const globalId = element.expressId + idOffset;
      element.expressId = globalId;
      const start = element.vertexOffset * chunk.vertexStrideFloats + 6;
      const end = start + element.vertexCount * chunk.vertexStrideFloats;
      for (let idx = start; idx < end; idx += chunk.vertexStrideFloats) {
        vertexIds[idx] = globalId >>> 0;
      }
    }
  }
}

function translateHugeChunks(chunks: HugeGeometryChunk[], dx: number, dy: number, dz: number): void {
  if (dx === 0 && dy === 0 && dz === 0) return;

  for (const chunk of chunks) {
    for (let i = 0; i < chunk.vertexData.length; i += chunk.vertexStrideFloats) {
      chunk.vertexData[i] -= dx;
      chunk.vertexData[i + 1] -= dy;
      chunk.vertexData[i + 2] -= dz;
    }

    chunk.boundsMin[0] -= dx;
    chunk.boundsMin[1] -= dy;
    chunk.boundsMin[2] -= dz;
    chunk.boundsMax[0] -= dx;
    chunk.boundsMax[1] -= dy;
    chunk.boundsMax[2] -= dz;

    for (const element of chunk.elements) {
      element.boundsMin[0] -= dx;
      element.boundsMin[1] -= dy;
      element.boundsMin[2] -= dz;
      element.boundsMax[0] -= dx;
      element.boundsMax[1] -= dy;
      element.boundsMax[2] -= dz;
    }
  }
}

function assignModelIndexToHugeChunks(chunks: HugeGeometryChunk[], modelIndex: number): void {
  for (const chunk of chunks) {
    chunk.modelIndex = modelIndex;
    for (const element of chunk.elements) {
      element.modelIndex = modelIndex;
    }
  }
}

function buildHugeGeometryEntityInfoMap(chunks: HugeGeometryChunk[]): Map<number, HugeGeometryEntityInfo> {
  const entities = new Map<number, HugeGeometryEntityInfo>();
  for (const chunk of chunks) {
    for (const element of chunk.elements) {
      entities.set(element.expressId, {
        expressId: element.expressId,
        ifcType: element.ifcType,
        modelIndex: element.modelIndex,
        color: element.color,
        boundsMin: [...element.boundsMin] as [number, number, number],
        boundsMax: [...element.boundsMax] as [number, number, number],
      });
    }
  }
  return entities;
}

function buildMergedHugeState(models: ReadonlyMap<string, FederatedModel>): {
  stats: HugeGeometryStats | null;
  entities: Map<number, HugeGeometryEntityInfo>;
} {
  let totalBatches = 0;
  let totalElements = 0;
  let totalVertices = 0;
  let totalTriangles = 0;
  const entities = new Map<number, HugeGeometryEntityInfo>();

  for (const model of models.values()) {
    if (!model.hugeGeometryMode || !model.hugeGeometryStats) continue;
    totalBatches += model.hugeGeometryStats.totalBatches;
    totalElements += model.hugeGeometryStats.totalElements;
    totalVertices += model.hugeGeometryStats.totalVertices;
    totalTriangles += model.hugeGeometryStats.totalTriangles;
    for (const [expressId, entity] of model.hugeGeometryEntities ?? new Map<number, HugeGeometryEntityInfo>()) {
      entities.set(expressId, entity);
    }
  }

  if (entities.size === 0) {
    return { stats: null, entities };
  }

  return {
    stats: { totalBatches, totalElements, totalVertices, totalTriangles },
    entities,
  };
}

function buildHugeGeometryStatsFromChunks(chunks: HugeGeometryChunk[]): HugeGeometryStats {
  let totalVertices = 0;
  let totalTriangles = 0;
  let totalElements = 0;
  for (const chunk of chunks) {
    totalVertices += chunk.vertexData.length / chunk.vertexStrideFloats;
    totalTriangles += chunk.indexCount / 3;
    totalElements += chunk.elements.length;
  }
  return {
    totalBatches: chunks.length,
    totalElements,
    totalVertices,
    totalTriangles,
  };
}

/**
 * Hook providing multi-model federation operations
 * Includes addModel, removeModel, federated IFCX loading, overlay management,
 * and ID resolution helpers
 */
export function useIfcFederation() {
  const {
    setLoading,
    setError,
    setProgress,
    setIfcDataStore,
    setGeometryResult,
    setHugeGeometryState,
    appendHugeGeometryChunks,
    // Multi-model state and actions
    addModel: storeAddModel,
    removeModel: storeRemoveModel,
    clearAllModels,
    getModel,
    hasModels,
    // Federation Registry helpers
    registerModelOffset,
    fromGlobalId,
    findModelForGlobalId,
  } = useViewerStore(useShallow((s) => ({
    setLoading: s.setLoading,
    setError: s.setError,
    setProgress: s.setProgress,
    setIfcDataStore: s.setIfcDataStore,
    setGeometryResult: s.setGeometryResult,
    setHugeGeometryState: s.setHugeGeometryState,
    appendHugeGeometryChunks: s.appendHugeGeometryChunks,
    addModel: s.addModel,
    removeModel: s.removeModel,
    clearAllModels: s.clearAllModels,
    getModel: s.getModel,
    hasModels: s.hasModels,
    registerModelOffset: s.registerModelOffset,
    fromGlobalId: s.fromGlobalId,
    findModelForGlobalId: s.findModelForGlobalId,
  })));

  /**
   * Add a model to the federation (multi-model support)
   * Uses FederationRegistry to assign unique ID offsets - BULLETPROOF against ID collisions
   * Returns the model ID on success, null on failure
   */
  const addModel = useCallback(async (
    file: File,
    options?: { name?: string }
  ): Promise<string | null> => {
    const modelId = crypto.randomUUID();
    const totalStartTime = performance.now();

    try {
      // IMPORTANT: Before adding a new model, check if there's a legacy model
      // (loaded via loadFile) that's not in the Map yet. If so, migrate it first.
      const currentModels = useViewerStore.getState().models;
      const currentIfcDataStore = useViewerStore.getState().ifcDataStore;
      const currentGeometryResult = useViewerStore.getState().geometryResult;
      let nextRenderModelIndex = -1;
      for (const model of currentModels.values()) {
        nextRenderModelIndex = Math.max(nextRenderModelIndex, model.renderModelIndex ?? -1);
      }
      nextRenderModelIndex += 1;

      if (currentModels.size === 0 && currentIfcDataStore && currentGeometryResult) {
        // Migrate the legacy model to the Map
        // Legacy model has offset 0 (IDs are unchanged)
        const legacyModelId = crypto.randomUUID();
        const legacyName = currentIfcDataStore.spatialHierarchy?.project?.name || 'Model 1';

        // Find max expressId in legacy model for registry
        // IMPORTANT: Include ALL entities, not just meshes, for proper globalId resolution
        const legacyMeshes = currentGeometryResult.meshes || [];
        const legacyMaxExpressIdFromMeshes = legacyMeshes.reduce((max: number, m: MeshData) => Math.max(max, m.expressId), 0);
        // FIXED: Use iteration instead of spread to avoid stack overflow with large Maps
        let legacyMaxExpressIdFromEntities = 0;
        if (currentIfcDataStore.entityIndex?.byId) {
          for (const key of currentIfcDataStore.entityIndex.byId.keys()) {
            if (key > legacyMaxExpressIdFromEntities) legacyMaxExpressIdFromEntities = key;
          }
        }
        const legacyMaxExpressId = Math.max(legacyMaxExpressIdFromMeshes, legacyMaxExpressIdFromEntities);

        // Register legacy model with offset 0 (IDs already in use as-is)
        const legacyOffset = registerModelOffset(legacyModelId, legacyMaxExpressId);

        const legacyModel: FederatedModel = {
          id: legacyModelId,
          name: legacyName,
          ifcDataStore: currentIfcDataStore,
          geometryResult: currentGeometryResult,
          visible: true,
          collapsed: false,
          schemaVersion: 'IFC4',
          loadedAt: Date.now() - 1000,
          fileSize: 0,
          idOffset: legacyOffset,
          maxExpressId: legacyMaxExpressId,
          renderModelIndex: nextRenderModelIndex++,
        };
        storeAddModel(legacyModel);
        console.log(`[useIfc] Migrated legacy model "${legacyModel.name}" to federation (offset: ${legacyOffset}, maxId: ${legacyMaxExpressId})`);
      }

      const renderModelIndex = nextRenderModelIndex;

      setLoading(true);
      setError(null);
      setProgress({ phase: 'Loading file', percent: 0 });

      // Read file from disk
      const buffer = await file.arrayBuffer();
      const fileSizeMB = buffer.byteLength / (1024 * 1024);

      // Detect file format
      const format = detectFormat(buffer);

      let parsedDataStore: IfcDataStore | null = null;
      let parsedGeometry: { meshes: MeshData[]; totalVertices: number; totalTriangles: number; coordinateInfo: CoordinateInfo } | null = null;
      let parsedHugeChunks: HugeGeometryChunk[] = [];
      let parsedHugeStats: HugeGeometryStats | null = null;
      let parsedHugeEntities: Map<number, HugeGeometryEntityInfo> = new Map();
      let schemaVersion: SchemaVersion = 'IFC4';

      // IFCX files must be parsed client-side
      if (format === 'ifcx') {
        setProgress({ phase: 'Parsing IFCX (client-side)', percent: 10 });

        const ifcxResult = await parseIfcx(buffer, {
          onProgress: (prog: { phase: string; percent: number }) => {
            setProgress({ phase: `IFCX ${prog.phase}`, percent: 10 + (prog.percent * 0.8) });
          },
        });

        // Convert IFCX meshes to viewer format
          const meshes: MeshData[] = convertIfcxMeshes(ifcxResult.meshes).map((mesh) => ({
            ...mesh,
            modelIndex: renderModelIndex,
          }));

        // Check if this is an overlay-only IFCX file (no geometry)
        if (meshes.length === 0 && ifcxResult.entityCount > 0) {
          console.warn(`[useIfc] IFCX file "${file.name}" has no geometry - this is an overlay file.`);
          setError(`"${file.name}" is an overlay file with no geometry. Please load it together with a base IFCX file (select all files at once for federated loading).`);
          setLoading(false);
          return null;
        }

        const { bounds, stats } = calculateMeshBounds(meshes);
        const coordinateInfo = createCoordinateInfo(bounds);
        const { chunks } = buildHugeGeometryChunks(meshes, 0);
        assignModelIndexToHugeChunks(chunks, renderModelIndex);

        parsedGeometry = {
          meshes: [],
          totalVertices: stats.totalVertices,
          totalTriangles: stats.totalTriangles,
          coordinateInfo,
        };
        parsedHugeChunks = chunks;
        parsedHugeStats = buildHugeGeometryStatsFromChunks(chunks);
        parsedHugeEntities = buildHugeGeometryEntityInfoMap(chunks);

        parsedDataStore = {
          fileSize: ifcxResult.fileSize,
          schemaVersion: 'IFC5' as const,
          entityCount: ifcxResult.entityCount,
          parseTime: ifcxResult.parseTime,
          source: new Uint8Array(buffer),
          entityIndex: { byId: new Map(), byType: new Map() },
          strings: ifcxResult.strings,
          entities: ifcxResult.entities,
          properties: ifcxResult.properties,
          quantities: ifcxResult.quantities,
          relationships: ifcxResult.relationships,
          spatialHierarchy: ifcxResult.spatialHierarchy,
        } as IfcxDataStore;

        schemaVersion = 'IFC5';

      } else if (format === 'glb') {
        // GLB files: parse directly to MeshData (geometry only, no IFC data model)
        setProgress({ phase: 'Parsing GLB', percent: 10 });

        const meshes = loadGLBToMeshData(new Uint8Array(buffer)).map((mesh) => ({
          ...mesh,
          modelIndex: renderModelIndex,
        }));

        if (meshes.length === 0) {
          setError('GLB file contains no geometry');
          setLoading(false);
          return null;
        }

        const { bounds, stats } = calculateMeshBounds(meshes);
        const coordinateInfo = createCoordinateInfo(bounds);
        const { chunks } = buildHugeGeometryChunks(meshes, 0);
        assignModelIndexToHugeChunks(chunks, renderModelIndex);

        parsedGeometry = {
          meshes: [],
          totalVertices: stats.totalVertices,
          totalTriangles: stats.totalTriangles,
          coordinateInfo,
        };
        parsedHugeChunks = chunks;
        parsedHugeStats = buildHugeGeometryStatsFromChunks(chunks);
        parsedHugeEntities = buildHugeGeometryEntityInfoMap(chunks);

        // Create a minimal data store for GLB (no IFC properties)
        parsedDataStore = {
          fileSize: buffer.byteLength,
          schemaVersion: 'IFC4' as const,
          entityCount: meshes.length,
          parseTime: 0,
          source: new Uint8Array(0),
          entityIndex: { byId: new Map(), byType: new Map() },
          strings: { getString: () => undefined, getStringId: () => undefined, count: 0 } as unknown as IfcDataStore['strings'],
          entities: { count: 0, getId: () => 0, getType: () => 0, getName: () => undefined, getGlobalId: () => undefined } as unknown as IfcDataStore['entities'],
          properties: { count: 0, getPropertiesForEntity: () => [], getPropertySetForEntity: () => [] } as unknown as IfcDataStore['properties'],
          quantities: { count: 0, getQuantitiesForEntity: () => [] } as unknown as IfcDataStore['quantities'],
          relationships: { count: 0, getRelationships: () => [], getRelated: () => [] } as unknown as IfcDataStore['relationships'],
          spatialHierarchy: null as unknown as IfcDataStore['spatialHierarchy'],
        } as unknown as IfcDataStore;

        schemaVersion = 'IFC4'; // GLB doesn't have a schema version, use IFC4 as default

      } else {
        // IFC4/IFC2X3 STEP format - use WASM parsing
        setProgress({ phase: 'Starting geometry streaming', percent: 10 });

        const geometryProcessor = new GeometryProcessor({ quality: GeometryQuality.Balanced });
        await geometryProcessor.init();

        // Parse data model
        const parser = new IfcParser();
        const wasmApi = geometryProcessor.getApi();

        const dataStorePromise = parser.parseColumnar(buffer, { wasmApi });

        // Process geometry
        const allMeshes: MeshData[] = [];
        const hugeChunks: HugeGeometryChunk[] = [];
        let finalCoordinateInfo: CoordinateInfo | null = null;
        let finalHugeStats: HugeGeometryStats | null = null;
        // Capture RTC offset from WASM for proper multi-model alignment
        let capturedRtcOffset: { x: number; y: number; z: number } | null = null;

        const dynamicBatchConfig = getDynamicBatchConfig(fileSizeMB);

        for await (const event of geometryProcessor.processAdaptive(new Uint8Array(buffer), {
          sizeThreshold: 2 * 1024 * 1024,
          batchSize: dynamicBatchConfig,
          preferHugeBatches: true,
        })) {
          switch (event.type) {
            case 'batch': {
              for (let i = 0; i < event.meshes.length; i++) allMeshes.push(event.meshes[i]);
              finalCoordinateInfo = event.coordinateInfo ?? null;
              const progressPercent = 10 + Math.min(80, (allMeshes.length / 1000) * 0.8);
              setProgress({ phase: `Processing geometry (${allMeshes.length} meshes)`, percent: progressPercent });
              break;
            }
            case 'rtcOffset': {
              // Capture RTC offset from WASM for multi-model alignment
              if (event.hasRtc) {
                capturedRtcOffset = event.rtcOffset;
              }
              break;
            }
            case 'huge-batch': {
              for (const chunk of event.chunks) hugeChunks.push(chunk);
              finalCoordinateInfo = event.coordinateInfo ?? null;
              finalHugeStats = event.stats;
              const progressPercent = 10 + Math.min(80, (event.totalSoFar / 1000) * 0.8);
              setProgress({ phase: `Processing geometry (${event.totalSoFar} meshes)`, percent: progressPercent });
              break;
            }
            case 'complete':
              finalCoordinateInfo = event.coordinateInfo ?? null;
              break;
            case 'huge-complete':
              finalCoordinateInfo = event.coordinateInfo ?? null;
              finalHugeStats = event.stats;
              break;
          }
        }

        parsedDataStore = await dataStorePromise;

        // Calculate storey heights
        if (parsedDataStore.spatialHierarchy && parsedDataStore.spatialHierarchy.storeyHeights.size === 0 && parsedDataStore.spatialHierarchy.storeyElevations.size > 1) {
          const calculatedHeights = calculateStoreyHeights(parsedDataStore.spatialHierarchy.storeyElevations);
          for (const [storeyId, height] of calculatedHeights) {
            parsedDataStore.spatialHierarchy.storeyHeights.set(storeyId, height);
          }
        }

        const fallbackCoordinateInfo = finalCoordinateInfo || createCoordinateInfo(calculateMeshBounds(allMeshes).bounds);
        parsedGeometry = {
          meshes: hugeChunks.length > 0 ? [] : allMeshes,
          totalVertices: hugeChunks.length > 0
            ? (finalHugeStats?.totalVertices ?? 0)
            : allMeshes.reduce((sum, m) => sum + m.positions.length / 3, 0),
          totalTriangles: hugeChunks.length > 0
            ? (finalHugeStats?.totalTriangles ?? 0)
            : allMeshes.reduce((sum, m) => sum + m.indices.length / 3, 0),
          coordinateInfo: fallbackCoordinateInfo,
        };

        // Store captured RTC offset in coordinate info for multi-model alignment
        if (parsedGeometry.coordinateInfo && capturedRtcOffset) {
          parsedGeometry.coordinateInfo.wasmRtcOffset = capturedRtcOffset;
        }

        parsedHugeStats = finalHugeStats;
        parsedHugeChunks = hugeChunks;
        assignModelIndexToHugeChunks(parsedHugeChunks, renderModelIndex);
        parsedHugeEntities = hugeChunks.length > 0 ? buildHugeGeometryEntityInfoMap(hugeChunks) : new Map();

        schemaVersion = parsedDataStore.schemaVersion === 'IFC4X3' ? 'IFC4X3' :
          parsedDataStore.schemaVersion === 'IFC4' ? 'IFC4' : 'IFC2X3';
      }

      if (!parsedDataStore || !parsedGeometry) {
        throw new Error('Failed to parse file');
      }

      // =========================================================================
      // FEDERATION REGISTRY: Transform expressIds to globally unique IDs
      // This is the BULLETPROOF fix for multi-model ID collisions
      // =========================================================================

      // Step 1: Find max expressId in this model
      // IMPORTANT: Use ALL entities from data store, not just meshes
      // Spatial containers (IfcProject, IfcSite, etc.) don't have geometry but need valid globalId resolution
      const maxExpressIdFromMeshes = parsedGeometry.meshes.reduce((max, m) => Math.max(max, m.expressId), 0);
      // FIXED: Use iteration instead of spread to avoid stack overflow with large Maps
      let maxExpressIdFromEntities = 0;
      if (parsedDataStore.entityIndex?.byId) {
        for (const key of parsedDataStore.entityIndex.byId.keys()) {
          if (key > maxExpressIdFromEntities) maxExpressIdFromEntities = key;
        }
      }
      const maxExpressId = Math.max(maxExpressIdFromMeshes, maxExpressIdFromEntities);

      // Step 2: Register with federation registry to get unique offset
      const idOffset = registerModelOffset(modelId, maxExpressId);

      // Step 3: Transform ALL mesh expressIds to globalIds
      // globalId = originalExpressId + offset
      // This ensures no two models can have the same ID
      if (idOffset > 0) {
        for (const mesh of parsedGeometry.meshes) {
          mesh.expressId = mesh.expressId + idOffset;
        }
        applyGlobalIdOffsetToHugeChunks(parsedHugeChunks, idOffset);
        parsedHugeEntities = buildHugeGeometryEntityInfoMap(parsedHugeChunks);
      }

      // =========================================================================
      // COORDINATE ALIGNMENT: Align new model with existing models using RTC delta
      // WASM applies per-model RTC offsets. To align models from the same project,
      // we calculate the difference in RTC offsets and apply it to the new model.
      //
      // RTC offset is in IFC coordinates (Z-up). After Z-up to Y-up conversion:
      // - IFC X → WebGL X
      // - IFC Y → WebGL -Z
      // - IFC Z → WebGL Y (vertical)
      // =========================================================================
      const existingModels = Array.from(useViewerStore.getState().models.values()) as FederatedModel[];
      if (existingModels.length > 0) {
        const firstModel = existingModels[0];
        const firstRtc = firstModel.geometryResult?.coordinateInfo?.wasmRtcOffset;
        const newRtc = parsedGeometry.coordinateInfo?.wasmRtcOffset;

        // If both models have RTC offsets, use RTC delta for precise alignment
        if (firstRtc && newRtc) {
          // Calculate what adjustment is needed to align new model with first model
          // First model: pos = original - firstRtc
          // New model: pos = original - newRtc
          // To align: newPos + adjustment = firstPos (assuming same original)
          // adjustment = firstRtc - newRtc (add back new's RTC, subtract first's RTC)
          const adjustX = firstRtc.x - newRtc.x;  // IFC X adjustment
          const adjustY = firstRtc.y - newRtc.y;  // IFC Y adjustment
          const adjustZ = firstRtc.z - newRtc.z;  // IFC Z adjustment (vertical)

          // Convert to WebGL coordinates:
          // IFC X → WebGL X (no change)
          // IFC Y → WebGL -Z (swap and negate)
          // IFC Z → WebGL Y (vertical)
          const webglAdjustX = adjustX;
          const webglAdjustY = adjustZ;   // IFC Z is WebGL Y (vertical)
          const webglAdjustZ = -adjustY;  // IFC Y is WebGL -Z

          const hasSignificantAdjust = Math.abs(webglAdjustX) > 0.01 ||
                                        Math.abs(webglAdjustY) > 0.01 ||
                                        Math.abs(webglAdjustZ) > 0.01;

          if (hasSignificantAdjust) {
            console.log(`[useIfc] Aligning model "${file.name}" using RTC adjustment: X=${webglAdjustX.toFixed(2)}m, Y=${webglAdjustY.toFixed(2)}m, Z=${webglAdjustZ.toFixed(2)}m`);

            // Apply adjustment to all mesh vertices
            // SUBTRACT adjustment: if firstRtc > newRtc, first was shifted MORE,
            // so new model needs to be shifted in same direction (subtract more)
            for (const mesh of parsedGeometry.meshes) {
              const positions = mesh.positions;
              for (let i = 0; i < positions.length; i += 3) {
                positions[i] -= webglAdjustX;
                positions[i + 1] -= webglAdjustY;
                positions[i + 2] -= webglAdjustZ;
              }
            }
            translateHugeChunks(parsedHugeChunks, webglAdjustX, webglAdjustY, webglAdjustZ);
            parsedHugeEntities = buildHugeGeometryEntityInfoMap(parsedHugeChunks);

            // Update coordinate info bounds
            if (parsedGeometry.coordinateInfo) {
              parsedGeometry.coordinateInfo.shiftedBounds.min.x -= webglAdjustX;
              parsedGeometry.coordinateInfo.shiftedBounds.max.x -= webglAdjustX;
              parsedGeometry.coordinateInfo.shiftedBounds.min.y -= webglAdjustY;
              parsedGeometry.coordinateInfo.shiftedBounds.max.y -= webglAdjustY;
              parsedGeometry.coordinateInfo.shiftedBounds.min.z -= webglAdjustZ;
              parsedGeometry.coordinateInfo.shiftedBounds.max.z -= webglAdjustZ;
            }
          }
        } else {
          // No RTC info - can't align reliably. This happens with old cache entries.
          console.warn(`[useIfc] Cannot align "${file.name}" - missing RTC offset. Clear cache and reload.`);
        }
      }

      // Build spatial index AFTER ID offset + RTC alignment so it stores
      // correct globalIds and final world-space positions.
      if (parsedGeometry.meshes.length > 0) {
        buildSpatialIndexGuarded(parsedGeometry.meshes, parsedDataStore, setIfcDataStore);
      }

      // Create the federated model with offset info
      const federatedModel: FederatedModel = {
        id: modelId,
        name: options?.name ?? file.name,
        ifcDataStore: parsedDataStore,
        geometryResult: parsedGeometry,
        visible: true,
        collapsed: hasModels(), // Collapse if not first model
        schemaVersion,
        loadedAt: Date.now(),
        fileSize: buffer.byteLength,
        idOffset,
        maxExpressId,
        renderModelIndex,
        hugeGeometryMode: parsedHugeChunks.length > 0,
        hugeGeometryStats: parsedHugeStats,
        hugeGeometryEntities: parsedHugeEntities,
      };

      // Add to store
      storeAddModel(federatedModel);

      // Also set legacy single-model state for backward compatibility
      setIfcDataStore(parsedDataStore);
      setGeometryResult(parsedGeometry);
      if (parsedHugeChunks.length > 0) {
        appendHugeGeometryChunks(parsedHugeChunks, parsedHugeStats);
      }

      setProgress({ phase: 'Complete', percent: 100 });
      setLoading(false);

      const totalElapsedMs = performance.now() - totalStartTime;
      console.log(`[useIfc] ✓ Added model ${file.name} (${fileSizeMB.toFixed(1)}MB) | ${totalElapsedMs.toFixed(0)}ms`);

      return modelId;

    } catch (err) {
      console.error('[useIfc] addModel failed:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
      setLoading(false);
      return null;
    }
  }, [setLoading, setError, setProgress, setIfcDataStore, setGeometryResult, appendHugeGeometryChunks, storeAddModel, hasModels, registerModelOffset]);

  /**
   * Remove a model from the federation
   */
  const removeModel = useCallback((modelId: string) => {
    storeRemoveModel(modelId);

    // Read fresh state from store after removal to avoid stale closure
    const freshModels = useViewerStore.getState().models;
    const remaining = Array.from(freshModels.values()) as FederatedModel[];
    if (remaining.length > 0) {
      const newActive = remaining[0];
      setIfcDataStore(newActive.ifcDataStore);
      setGeometryResult(newActive.geometryResult);
      const mergedHugeState = buildMergedHugeState(freshModels);
      if (mergedHugeState.stats) {
        setHugeGeometryState(true, mergedHugeState.stats, mergedHugeState.entities);
      } else {
        setHugeGeometryState(false, null, new Map());
      }
    } else {
      setIfcDataStore(null);
      setGeometryResult(null);
      setHugeGeometryState(false, null, new Map());
    }
  }, [storeRemoveModel, setIfcDataStore, setGeometryResult, setHugeGeometryState]);

  /**
   * Get query instance for a specific model
   */
  const getQueryForModel = useCallback((modelId: string): IfcQuery | null => {
    const model = getModel(modelId);
    if (!model) return null;
    return new IfcQuery(model.ifcDataStore);
  }, [getModel]);

  /**
   * Load multiple files sequentially (WASM parser isn't thread-safe)
   * Each file fully loads before the next one starts
   */
  const loadFilesSequentially = useCallback(async (files: File[]): Promise<void> => {
    for (const file of files) {
      await addModel(file);
    }
  }, [addModel]);

  /**
   * Load multiple IFCX files as federated layers
   * Uses IFC5's layer composition system where later files override earlier ones.
   * Properties from overlay files are merged with the base file(s).
   *
   * @param files - Array of IFCX files (first = base/weakest, last = strongest overlay)
   *
   * @example
   * ```typescript
   * // Load base model with property overlay
   * await loadFederatedIfcx([
   *   baseFile,           // hello-wall.ifcx
   *   fireRatingFile,     // add-fire-rating.ifcx (adds FireRating property)
   * ]);
   * ```
   */
  /**
   * Internal: Load federated IFCX from buffers (used by both initial load and add overlay)
   */
  const loadFederatedIfcxFromBuffers = useCallback(async (
    buffers: Array<{ buffer: ArrayBuffer; name: string }>,
    options: { resetState?: boolean } = {}
  ): Promise<void> => {
    const { resetViewerState, clearAllModels } = useViewerStore.getState();

    try {
      // Always reset viewer state when geometry changes (selection, hidden entities, etc.)
      // This ensures 3D highlighting works correctly after re-composition
      resetViewerState();

      // Clear legacy geometry BEFORE clearing models to prevent stale fallback
      // This avoids a race condition where mergedGeometryResult uses old geometry
      // during the brief moment when storeModels.size === 0
      setGeometryResult(null);
      clearAllModels();

      setLoading(true);
      setError(null);
      setProgress({ phase: 'Parsing federated IFCX', percent: 0 });

      // Parse federated IFCX files
      const result = await parseFederatedIfcx(buffers, {
        onProgress: (prog: { phase: string; percent: number }) => {
          setProgress({ phase: `IFCX ${prog.phase}`, percent: prog.percent });
        },
      });

      // Convert IFCX meshes to viewer format
      const meshes: MeshData[] = convertIfcxMeshes(result.meshes);

      // Calculate bounds
      const { bounds, stats } = calculateMeshBounds(meshes);
      const coordinateInfo = createCoordinateInfo(bounds);

      const geometryResult = {
        meshes,
        totalVertices: stats.totalVertices,
        totalTriangles: stats.totalTriangles,
        coordinateInfo,
      };

      // NOTE: Do NOT call setGeometryResult() here!
      // For federated loading, geometry comes from the models Map via mergedGeometryResult.
      // Calling setGeometryResult() before models are added causes a race condition where
      // meshes are added to the scene WITHOUT modelIndex, breaking selection highlighting.

      // Get layer info with mesh counts
      const layers = result.layerStack.getLayers();

      // Create data store from federated result
      const dataStore = {
        fileSize: result.fileSize,
        schemaVersion: 'IFC5' as const,
        entityCount: result.entityCount,
        parseTime: result.parseTime,
        source: new Uint8Array(buffers[0].buffer),
        entityIndex: {
          byId: new Map(),
          byType: new Map(),
        },
        strings: result.strings,
        entities: result.entities,
        properties: result.properties,
        quantities: result.quantities,
        relationships: result.relationships,
        spatialHierarchy: result.spatialHierarchy,
        // Federated-specific: store layer info and ORIGINAL BUFFERS for re-composition
        _federatedLayers: layers.map((l: { id: string; name: string; enabled: boolean }) => ({
          id: l.id,
          name: l.name,
          enabled: l.enabled,
        })),
        _federatedBuffers: buffers.map(b => ({
          buffer: b.buffer.slice(0), // Clone buffer
          name: b.name,
        })),
        _compositionStats: result.compositionStats,
      } as unknown as IfcxDataStore;

      // IfcxDataStore extends IfcDataStore (with schemaVersion: 'IFC5'), so this is safe
      setIfcDataStore(dataStore);

      // Clear existing models and add each layer as a "model" in the Models panel
      // This shows users all the files that contributed to the composition
      clearAllModels();
      let nextRenderModelIndex = 0;

      // Find max expressId for proper ID range tracking
      // This is needed for resolveGlobalIdFromModels to work correctly
      let maxExpressId = 0;
      if (result.entities?.expressId) {
        for (let i = 0; i < result.entities.count; i++) {
          const id = result.entities.expressId[i];
          if (id > maxExpressId) maxExpressId = id;
        }
      }

      for (let i = 0; i < layers.length; i++) {
        const layer = layers[i];
        const layerBuffer = buffers.find(b => b.name === layer.name);

        // Count how many meshes came from this layer
        // For base layers: count meshes, for overlays: show as data-only
        const isBaseLayer = i === layers.length - 1; // Last layer (weakest) is typically base

        const layerModel: FederatedModel = {
          id: layer.id,
          name: layer.name,
          ifcDataStore: dataStore, // Share the composed data store
          geometryResult: isBaseLayer ? geometryResult : {
            meshes: [],
            totalVertices: 0,
            totalTriangles: 0,
            coordinateInfo,
          },
          visible: true,
          collapsed: i > 0, // Collapse overlays by default
          schemaVersion: 'IFC5',
          loadedAt: Date.now() - (layers.length - i) * 100, // Stagger timestamps
          fileSize: layerBuffer?.buffer.byteLength || 0,
          // For base layer: set proper ID range for resolveGlobalIdFromModels
          // Overlays share the same data store so they don't need their own range
          idOffset: 0,
          maxExpressId: isBaseLayer ? maxExpressId : 0,
          renderModelIndex: nextRenderModelIndex++,
          // Mark overlay-only layers
          _isOverlay: !isBaseLayer,
          _layerIndex: i,
        } as FederatedModel & { _isOverlay?: boolean; _layerIndex?: number };

        storeAddModel(layerModel);
      }

      console.log(`[useIfc] Federated IFCX loaded: ${layers.length} layers, ${result.entityCount} entities, ${meshes.length} meshes`);
      console.log(`[useIfc] Composition stats: ${result.compositionStats.inheritanceResolutions} inheritance resolutions, ${result.compositionStats.crossLayerReferences} cross-layer refs`);
      console.log(`[useIfc] Layers in Models panel: ${layers.map((l: { name: string }) => l.name).join(', ')}`);

      setProgress({ phase: 'Complete', percent: 100 });
      setLoading(false);
    } catch (err: unknown) {
      console.error('[useIfc] Federated IFCX loading failed:', err);
      const message = err instanceof Error ? err.message : String(err);
      setError(`Federated IFCX loading failed: ${message}`);
      setLoading(false);
    }
  }, [setLoading, setError, setProgress, setGeometryResult, setIfcDataStore, storeAddModel, clearAllModels]);

  const loadFederatedIfcx = useCallback(async (files: File[]): Promise<void> => {
    if (files.length === 0) {
      setError('No files provided for federated loading');
      return;
    }

    // Check that all files are IFCX format and read buffers
    const buffers: Array<{ buffer: ArrayBuffer; name: string }> = [];
    for (const file of files) {
      const buffer = await file.arrayBuffer();
      const format = detectFormat(buffer);
      if (format !== 'ifcx') {
        setError(`File "${file.name}" is not an IFCX file. Federated loading only supports IFCX files.`);
        return;
      }
      buffers.push({ buffer, name: file.name });
    }

    await loadFederatedIfcxFromBuffers(buffers);
  }, [setError, loadFederatedIfcxFromBuffers]);

  /**
   * Add IFCX overlay files to existing federated model
   * Re-composes all layers including new overlays
   * Also handles adding overlays to a single IFCX file that wasn't loaded via federated loading
   */
  const addIfcxOverlays = useCallback(async (files: File[]): Promise<void> => {
    const currentStore = useViewerStore.getState().ifcDataStore as IfcxDataStore | null;
    const currentModels = useViewerStore.getState().models;

    // Get existing buffers - either from federated loading or from single file load
    let existingBuffers: Array<{ buffer: ArrayBuffer; name: string }> = [];

    if (currentStore?._federatedBuffers) {
      // Already federated - use stored buffers
      existingBuffers = currentStore._federatedBuffers as Array<{ buffer: ArrayBuffer; name: string }>;
    } else if (currentStore?.source && currentStore.schemaVersion === 'IFC5') {
      // Single IFCX file loaded via loadFile() - reconstruct buffer from source
      // Get the model name from the models map
      let modelName = 'base.ifcx';
      for (const [, model] of currentModels) {
        // Compare object identity (cast needed due to IFC5 schema extension)
        if ((model.ifcDataStore as unknown) === currentStore || model.schemaVersion === 'IFC5') {
          modelName = model.name;
          break;
        }
      }

      // Convert Uint8Array source back to ArrayBuffer
      const sourceBuffer = currentStore.source.buffer.slice(
        currentStore.source.byteOffset,
        currentStore.source.byteOffset + currentStore.source.byteLength
      ) as ArrayBuffer;

      existingBuffers = [{ buffer: sourceBuffer, name: modelName }];
      console.log(`[useIfc] Converting single IFCX file "${modelName}" to federated mode`);
    } else {
      setError('Cannot add overlays: no IFCX model loaded');
      return;
    }

    // Read new overlay buffers
    const newBuffers: Array<{ buffer: ArrayBuffer; name: string }> = [];
    for (const file of files) {
      const buffer = await file.arrayBuffer();
      const format = detectFormat(buffer);
      if (format !== 'ifcx') {
        setError(`File "${file.name}" is not an IFCX file.`);
        return;
      }
      newBuffers.push({ buffer, name: file.name });
    }

    // Combine: existing layers + new overlays (new overlays are strongest = first in array)
    const allBuffers = [...newBuffers, ...existingBuffers];

    console.log(`[useIfc] Re-composing federated IFCX with ${newBuffers.length} new overlay(s)`);
    console.log(`[useIfc] Total layers: ${allBuffers.length} (${existingBuffers.length} existing + ${newBuffers.length} new)`);

    await loadFederatedIfcxFromBuffers(allBuffers, { resetState: false });
  }, [setError, loadFederatedIfcxFromBuffers]);

  /**
   * Find which model contains a given globalId
   * Uses FederationRegistry for O(log N) lookup - BULLETPROOF
   * Returns the modelId or null if not found
   */
  const findModelForEntity = useCallback((globalId: number): string | null => {
    return findModelForGlobalId(globalId);
  }, [findModelForGlobalId]);

  /**
   * Convert a globalId back to the original (modelId, expressId) pair
   * Use this when you need to look up properties in the IfcDataStore
   */
  const resolveGlobalId = useCallback((globalId: number): { modelId: string; expressId: number } | null => {
    return fromGlobalId(globalId);
  }, [fromGlobalId]);

  return {
    addModel,
    removeModel,
    getQueryForModel,
    loadFilesSequentially,
    loadFederatedIfcx,
    addIfcxOverlays,
    findModelForEntity,
    resolveGlobalId,
  };
}

export default useIfcFederation;
