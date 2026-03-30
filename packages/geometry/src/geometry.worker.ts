/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import init, { initSync, IfcAPI } from '@ifc-lite/wasm';
import type { HugeGeometryChunk, MeshData } from './types.js';

export interface GeometryWorkerInitMessage {
  type: 'init';
  wasmModule?: WebAssembly.Module;
}

export interface GeometryWorkerProcessMessage {
  type: 'process';
  sharedBuffer: SharedArrayBuffer;
  jobsFlat: Uint32Array;      // [id, start, end, id, start, end, ...]
  unitScale: number;
  rtcX: number; rtcY: number; rtcZ: number;
  needsShift: boolean;
  voidKeys: Uint32Array;
  voidCounts: Uint32Array;
  voidValues: Uint32Array;
  styleIds: Uint32Array;
  styleColors: Uint8Array;
}

export interface GeometryWorkerProcessHugeMessage {
  type: 'process-huge';
  sharedBuffer: SharedArrayBuffer;
  jobsFlat: Uint32Array;
  unitScale: number;
  rtcX: number;
  rtcY: number;
  rtcZ: number;
  needsShift: boolean;
  voidKeys: Uint32Array;
  voidCounts: Uint32Array;
  voidValues: Uint32Array;
  styleIds: Uint32Array;
  styleColors: Uint8Array;
  batchStartId: number;
  targetChunkBytes?: number;
}

export interface GeometryWorkerPrePassMessage {
  type: 'prepass' | 'prepass-fast';
  sharedBuffer: SharedArrayBuffer;
}

export type GeometryWorkerRequest =
  | GeometryWorkerInitMessage
  | GeometryWorkerProcessMessage
  | GeometryWorkerProcessHugeMessage
  | GeometryWorkerPrePassMessage;

export interface GeometryWorkerBatchMessage {
  type: 'batch';
  meshes: {
    expressId: number;
    ifcType?: string;
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint32Array;
    color: [number, number, number, number];
  }[];
}

export interface GeometryWorkerCompleteMessage {
  type: 'complete';
  totalMeshes: number;
}

export interface GeometryWorkerHugeBatchMessage {
  type: 'huge-batch';
  chunks: HugeGeometryChunk[];
}

export interface GeometryWorkerErrorMessage {
  type: 'error';
  message: string;
}

export type GeometryWorkerResponse =
  | GeometryWorkerBatchMessage
  | GeometryWorkerHugeBatchMessage
  | GeometryWorkerCompleteMessage
  | GeometryWorkerErrorMessage;

let api: IfcAPI | null = null;
let sharedViewSupported: boolean | null = null;
const HUGE_FLOATS_PER_VERTEX = 7;
const HUGE_DEFAULT_TARGET_CHUNK_BYTES = 64 * 1024 * 1024;
const HUGE_MAX_ENCODED_ENTITY_ID = 0xFFFFFF;

function cloneSharedBytes(sharedBuffer: SharedArrayBuffer): Uint8Array {
  const localBytes = new Uint8Array(sharedBuffer.byteLength);
  localBytes.set(new Uint8Array(sharedBuffer));
  return localBytes;
}

function collectionToMeshes(collection: ReturnType<IfcAPI['processGeometryBatch']>): MeshData[] {
  const meshes: MeshData[] = [];
  for (let i = 0; i < collection.length; i++) {
    const mesh = collection.get(i);
    if (!mesh) continue;

    meshes.push({
      expressId: mesh.expressId,
      ifcType: mesh.ifcType,
      positions: new Float32Array(mesh.positions),
      normals: new Float32Array(mesh.normals),
      indices: new Uint32Array(mesh.indices),
      color: [mesh.color[0], mesh.color[1], mesh.color[2], mesh.color[3]],
    });

    mesh.free();
  }
  collection.free();
  return meshes;
}

type WorkerHugeMeshRef = {
  mesh: {
    expressId: number;
    ifcType?: string;
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint32Array;
    color: Float32Array;
    free(): void;
  };
  estimatedBytes: number;
};

type WorkerHugeGroup = {
  color: [number, number, number, number];
  meshes: WorkerHugeMeshRef[];
  estimatedBytes: number;
};

function hugeColorKey(color: [number, number, number, number]): string {
  return `${color[0]},${color[1]},${color[2]},${color[3]}`;
}

function estimateHugeMeshBytes(mesh: { positions: Float32Array; indices: Uint32Array }): number {
  const vertexCount = mesh.positions.length / 3;
  return (vertexCount * HUGE_FLOATS_PER_VERTEX * 4) + (mesh.indices.length * 4);
}

function collectionToHugeChunks(
  collection: ReturnType<IfcAPI['processGeometryBatch']>,
  startingBatchId: number,
  targetChunkBytes?: number,
): HugeGeometryChunk[] {
  const groups: WorkerHugeGroup[] = [];
  const activeGroupByColor = new Map<string, WorkerHugeGroup>();
  const chunkTargetBytes = targetChunkBytes ?? HUGE_DEFAULT_TARGET_CHUNK_BYTES;

  for (let i = 0; i < collection.length; i++) {
    const mesh = collection.get(i);
    if (!mesh) continue;

    const key = hugeColorKey([mesh.color[0], mesh.color[1], mesh.color[2], mesh.color[3]]);
    const estimatedBytes = estimateHugeMeshBytes(mesh);
    const existing = activeGroupByColor.get(key);
    if (!existing || (existing.estimatedBytes + estimatedBytes > chunkTargetBytes && existing.meshes.length > 0)) {
      const group: WorkerHugeGroup = {
        color: [mesh.color[0], mesh.color[1], mesh.color[2], mesh.color[3]],
        meshes: [{ mesh, estimatedBytes }],
        estimatedBytes,
      };
      groups.push(group);
      activeGroupByColor.set(key, group);
      continue;
    }

    existing.meshes.push({ mesh, estimatedBytes });
    existing.estimatedBytes += estimatedBytes;
  }

  const chunks: HugeGeometryChunk[] = [];
  let batchId = startingBatchId;
  let warnedAboutEntityRange = false;

  for (const group of groups) {
    let totalVertices = 0;
    let totalIndices = 0;
    for (const { mesh } of group.meshes) {
      totalVertices += mesh.positions.length / 3;
      totalIndices += mesh.indices.length;
    }

    const vertexBufferRaw = new ArrayBuffer(totalVertices * HUGE_FLOATS_PER_VERTEX * 4);
    const vertexData = new Float32Array(vertexBufferRaw);
    const vertexDataU32 = new Uint32Array(vertexBufferRaw);
    const indexData = new Uint32Array(totalIndices);
    const elements: HugeGeometryChunk['elements'] = [];
    const chunkBoundsMin: [number, number, number] = [Infinity, Infinity, Infinity];
    const chunkBoundsMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];

    let vertexBase = 0;
    let indexBase = 0;

    for (const { mesh } of group.meshes) {
      const vertexCount = mesh.positions.length / 3;
      const indexCount = mesh.indices.length;
      let entityId = mesh.expressId >>> 0;
      if (entityId > HUGE_MAX_ENCODED_ENTITY_ID) {
        if (!warnedAboutEntityRange) {
          console.warn('[Geometry] expressId exceeds 24-bit seam-ID encoding range; seam lines may collide.');
          warnedAboutEntityRange = true;
        }
        entityId &= HUGE_MAX_ENCODED_ENTITY_ID;
      }

      const elementBoundsMin: [number, number, number] = [Infinity, Infinity, Infinity];
      const elementBoundsMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      let outIdx = vertexBase * HUGE_FLOATS_PER_VERTEX;

      for (let i = 0; i < vertexCount; i++) {
        const srcIdx = i * 3;
        const x = mesh.positions[srcIdx];
        const y = mesh.positions[srcIdx + 1];
        const z = mesh.positions[srcIdx + 2];

        vertexData[outIdx++] = x;
        vertexData[outIdx++] = y;
        vertexData[outIdx++] = z;
        vertexData[outIdx++] = mesh.normals[srcIdx];
        vertexData[outIdx++] = mesh.normals[srcIdx + 1];
        vertexData[outIdx++] = mesh.normals[srcIdx + 2];
        vertexDataU32[outIdx++] = entityId;

        if (x < elementBoundsMin[0]) elementBoundsMin[0] = x;
        if (y < elementBoundsMin[1]) elementBoundsMin[1] = y;
        if (z < elementBoundsMin[2]) elementBoundsMin[2] = z;
        if (x > elementBoundsMax[0]) elementBoundsMax[0] = x;
        if (y > elementBoundsMax[1]) elementBoundsMax[1] = y;
        if (z > elementBoundsMax[2]) elementBoundsMax[2] = z;
      }

      for (let i = 0; i < indexCount; i++) {
        indexData[indexBase + i] = mesh.indices[i] + vertexBase;
      }

      if (elementBoundsMin[0] < chunkBoundsMin[0]) chunkBoundsMin[0] = elementBoundsMin[0];
      if (elementBoundsMin[1] < chunkBoundsMin[1]) chunkBoundsMin[1] = elementBoundsMin[1];
      if (elementBoundsMin[2] < chunkBoundsMin[2]) chunkBoundsMin[2] = elementBoundsMin[2];
      if (elementBoundsMax[0] > chunkBoundsMax[0]) chunkBoundsMax[0] = elementBoundsMax[0];
      if (elementBoundsMax[1] > chunkBoundsMax[1]) chunkBoundsMax[1] = elementBoundsMax[1];
      if (elementBoundsMax[2] > chunkBoundsMax[2]) chunkBoundsMax[2] = elementBoundsMax[2];

      elements.push({
        batchId,
        expressId: mesh.expressId,
        ifcType: mesh.ifcType,
        color: [mesh.color[0], mesh.color[1], mesh.color[2], mesh.color[3]],
        boundsMin: elementBoundsMin,
        boundsMax: elementBoundsMax,
        vertexOffset: vertexBase,
        vertexCount,
        indexOffset: indexBase,
        indexCount,
      });

      vertexBase += vertexCount;
      indexBase += indexCount;
      mesh.free();
    }

    chunks.push({
      batchId,
      color: group.color,
      vertexData,
      indexData,
      vertexStrideFloats: HUGE_FLOATS_PER_VERTEX,
      indexCount: totalIndices,
      boundsMin: chunkBoundsMin,
      boundsMax: chunkBoundsMax,
      elements,
    });
    batchId += 1;
  }

  collection.free();
  return chunks;
}

function withSharedBytes<T>(
  sharedBuffer: SharedArrayBuffer,
  run: (bytes: Uint8Array) => T
): T {
  if (sharedViewSupported === false) {
    return run(cloneSharedBytes(sharedBuffer));
  }

  try {
    const result = run(new Uint8Array(sharedBuffer));
    sharedViewSupported = true;
    return result;
  } catch (err) {
    if (sharedViewSupported === true) throw err;
    sharedViewSupported = false;
    return run(cloneSharedBytes(sharedBuffer));
  }
}

self.onmessage = async (e: MessageEvent<GeometryWorkerRequest>) => {
  try {
    if (e.data.type === 'prepass' || e.data.type === 'prepass-fast') {
      if (!api) { await init(); api = new IfcAPI(); }
      // Fast pre-pass: only scan for entity locations (~1-2s)
      // Full pre-pass: also resolves styles + voids (~6s)
      const result = withSharedBytes(e.data.sharedBuffer, (bytes) => (
        e.data.type === 'prepass-fast'
          ? api!.buildPrePassFast(bytes)
          : api!.buildPrePassOnce(bytes)
      ));
      (self as unknown as Worker).postMessage({ type: 'prepass-result', result });
      return;
    }

    if (e.data.type === 'init') {
      if (e.data.wasmModule) {
        initSync({ module_or_path: e.data.wasmModule });
      } else {
        await init();
      }
      api = new IfcAPI();
      (self as unknown as Worker).postMessage({ type: 'ready' });
      return;
    }

    if (e.data.type === 'process' || e.data.type === 'process-huge') {
      if (!api) {
        await init();
        api = new IfcAPI();
      }

      const { sharedBuffer, jobsFlat, unitScale, rtcX, rtcY, rtcZ, needsShift,
              voidKeys, voidCounts, voidValues, styleIds, styleColors } = e.data;

      // Call processGeometryBatch with pre-pass data
      const collection = withSharedBytes(sharedBuffer, (bytes) => api!.processGeometryBatch(
        bytes, jobsFlat, unitScale,
        rtcX, rtcY, rtcZ, needsShift,
        voidKeys, voidCounts, voidValues,
        styleIds, styleColors,
      ));

      if (e.data.type === 'process-huge') {
        const chunks = collectionToHugeChunks(
          collection,
          e.data.batchStartId,
          e.data.targetChunkBytes,
        );
        const transferBuffers: ArrayBuffer[] = [];
        for (const chunk of chunks) {
          transferBuffers.push(chunk.vertexData.buffer as ArrayBuffer, chunk.indexData.buffer as ArrayBuffer);
        }

        (self as unknown as Worker).postMessage(
          { type: 'huge-batch', chunks } as GeometryWorkerHugeBatchMessage,
          transferBuffers,
        );
        const totalMeshes = chunks.reduce((sum, chunk) => sum + chunk.elements.length, 0);
        (self as unknown as Worker).postMessage(
          { type: 'complete', totalMeshes } as GeometryWorkerCompleteMessage,
        );
      } else {
        const meshes = collectionToMeshes(collection);
        const transferBuffers: ArrayBuffer[] = [];
        const batchMeshes: GeometryWorkerBatchMessage['meshes'] = [];

        for (const mesh of meshes) {
          batchMeshes.push({
            expressId: mesh.expressId,
            ifcType: mesh.ifcType,
            positions: mesh.positions,
            normals: mesh.normals,
            indices: mesh.indices,
            color: mesh.color,
          });
          transferBuffers.push(
            mesh.positions.buffer as ArrayBuffer,
            mesh.normals.buffer as ArrayBuffer,
            mesh.indices.buffer as ArrayBuffer,
          );
        }

        (self as unknown as Worker).postMessage(
          { type: 'batch', meshes: batchMeshes } as GeometryWorkerBatchMessage,
          transferBuffers,
        );
        (self as unknown as Worker).postMessage(
          { type: 'complete', totalMeshes: meshes.length } as GeometryWorkerCompleteMessage,
        );
      }
    }
  } catch (err) {
    (self as unknown as Worker).postMessage(
      { type: 'error', message: err instanceof Error ? err.message : String(err) } as GeometryWorkerErrorMessage,
    );
  }
};
