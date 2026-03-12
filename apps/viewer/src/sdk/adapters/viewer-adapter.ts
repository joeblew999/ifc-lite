/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EntityRef, SectionPlane, CameraState, ViewerBackendMethods } from '@ifc-lite/sdk';
import type { StoreApi } from './types.js';
import { getModelForRef } from './model-compat.js';

/** Map SDK axis to normal vector */
function axisToNormal(axis: 'x' | 'y' | 'z'): { x: number; y: number; z: number } {
  if (axis === 'x') return { x: 1, y: 0, z: 0 };
  if (axis === 'y') return { x: 0, y: 1, z: 0 };
  return { x: 0, y: 0, z: 1 };
}

/** Map normal to dominant SDK axis */
function normalToAxis(n: { x: number; y: number; z: number }): 'x' | 'y' | 'z' {
  const absX = Math.abs(n.x), absY = Math.abs(n.y), absZ = Math.abs(n.z);
  if (absY >= absX && absY >= absZ) return 'y';
  if (absZ >= absX) return 'z';
  return 'x';
}

export function createViewerAdapter(store: StoreApi): ViewerBackendMethods {
  return {
    colorize(refs: EntityRef[], color: [number, number, number, number]) {
      const state = store.getState();
      const existing = state.pendingColorUpdates;
      const colorMap = existing ? new Map(existing) : new Map<number, [number, number, number, number]>();
      for (const ref of refs) {
        const model = getModelForRef(state, ref.modelId);
        if (model) {
          const globalId = ref.expressId + model.idOffset;
          colorMap.set(globalId, color);
        }
      }
      state.setPendingColorUpdates(colorMap);
      return undefined;
    },
    colorizeAll(batches: Array<{ refs: EntityRef[]; color: [number, number, number, number] }>) {
      const state = store.getState();
      const batchMap = new Map<number, [number, number, number, number]>();
      for (const batch of batches) {
        for (const ref of batch.refs) {
          const model = getModelForRef(state, ref.modelId);
          if (model) {
            batchMap.set(ref.expressId + model.idOffset, batch.color);
          }
        }
      }
      state.setPendingColorUpdates(batchMap);
      return undefined;
    },
    resetColors() {
      const state = store.getState();
      state.setPendingColorUpdates(new Map());
      return undefined;
    },
    flyTo() {
      return undefined;
    },
    setSection(section: SectionPlane | null) {
      const state = store.getState();
      if (section) {
        state.setSectionPlane?.({
          normal: axisToNormal(section.axis),
          distance: section.position,
          enabled: section.enabled,
          flipped: section.flipped,
        });
      } else {
        state.setSectionPlane?.({ enabled: false });
      }
      return undefined;
    },
    getSection() {
      const state = store.getState();
      if (!state.sectionPlane?.enabled) return null;
      return {
        axis: normalToAxis(state.sectionPlane.normal),
        position: state.sectionPlane.distance,
        enabled: state.sectionPlane.enabled,
        flipped: state.sectionPlane.flipped,
      };
    },
    setCamera(cameraState: Partial<CameraState>) {
      const state = store.getState();
      if (cameraState.mode) {
        state.setProjectionMode?.(cameraState.mode);
      }
      return undefined;
    },
    getCamera() {
      const state = store.getState();
      return { mode: state.projectionMode ?? 'perspective' };
    },
  };
}
