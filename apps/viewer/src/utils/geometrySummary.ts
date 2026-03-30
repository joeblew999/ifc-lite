/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GeometryResult, HugeGeometryEntityInfo, HugeGeometryStats } from '@ifc-lite/geometry';
import type { FederatedModel } from '../store/types.js';

export function getGeometryElementCount(
  geometryResult: GeometryResult | null | undefined,
  hugeGeometryStats?: HugeGeometryStats | null,
): number {
  return hugeGeometryStats?.totalElements ?? geometryResult?.meshes.length ?? 0;
}

export function getGeometryTriangleCount(
  geometryResult: GeometryResult | null | undefined,
  hugeGeometryStats?: HugeGeometryStats | null,
): number {
  return hugeGeometryStats?.totalTriangles ?? geometryResult?.totalTriangles ?? 0;
}

export function hasGeometryLoaded(
  geometryResult: GeometryResult | null | undefined,
  hugeGeometryStats?: HugeGeometryStats | null,
): boolean {
  return getGeometryElementCount(geometryResult, hugeGeometryStats) > 0;
}

export function getGeometryEntityIds(
  geometryResult: GeometryResult | null | undefined,
  hugeGeometryEntities?: Map<number, HugeGeometryEntityInfo> | null,
): number[] {
  if (hugeGeometryEntities && hugeGeometryEntities.size > 0) {
    return Array.from(hugeGeometryEntities.keys());
  }
  return geometryResult?.meshes.map((mesh) => mesh.expressId) ?? [];
}

export function getGeometryEntityInfos(
  geometryResult: GeometryResult | null | undefined,
  hugeGeometryEntities?: Map<number, HugeGeometryEntityInfo> | null,
): HugeGeometryEntityInfo[] {
  if (hugeGeometryEntities && hugeGeometryEntities.size > 0) {
    return Array.from(hugeGeometryEntities.values());
  }
  return (
    geometryResult?.meshes.map((mesh) => ({
      expressId: mesh.expressId,
      ifcType: mesh.ifcType,
      modelIndex: mesh.modelIndex,
      color: mesh.color,
      boundsMin: [0, 0, 0] as [number, number, number],
      boundsMax: [0, 0, 0] as [number, number, number],
    })) ?? []
  );
}

export function getGeometryEntityInfo(
  expressId: number,
  geometryResult: GeometryResult | null | undefined,
  hugeGeometryEntities?: Map<number, HugeGeometryEntityInfo> | null,
): HugeGeometryEntityInfo | null {
  const hugeEntry = hugeGeometryEntities?.get(expressId);
  if (hugeEntry) return hugeEntry;

  const mesh = geometryResult?.meshes.find((entry) => entry.expressId === expressId);
  if (!mesh) return null;

  return {
    expressId: mesh.expressId,
    ifcType: mesh.ifcType,
    modelIndex: mesh.modelIndex,
    color: mesh.color,
    boundsMin: [0, 0, 0],
    boundsMax: [0, 0, 0],
  };
}

export function getModelGeometryElementCount(model: FederatedModel): number {
  return getGeometryElementCount(model.geometryResult, model.hugeGeometryStats);
}

export function hasModelGeometryLoaded(model: FederatedModel): boolean {
  return hasGeometryLoaded(model.geometryResult, model.hugeGeometryStats);
}

export function modelHasIfcTypeGeometry(model: FederatedModel, ifcType: string): boolean {
  return getGeometryEntityInfos(model.geometryResult, model.hugeGeometryEntities)
    .some((entity) => entity.ifcType === ifcType);
}

export function hasIfcTypeGeometry(
  geometryResult: GeometryResult | null | undefined,
  ifcType: string,
  hugeGeometryEntities?: Map<number, HugeGeometryEntityInfo> | null,
): boolean {
  return getGeometryEntityInfos(geometryResult, hugeGeometryEntities)
    .some((entity) => entity.ifcType === ifcType);
}
