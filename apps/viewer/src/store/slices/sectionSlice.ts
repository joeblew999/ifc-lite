/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section plane state slice
 *
 * Face-based section cutting: the user picks any face in 3D and
 * the model is clipped by that face's plane (normal + distance).
 * No axis presets — every section is defined by an arbitrary plane.
 */

import type { StateCreator } from 'zustand';
import type { SectionPlane } from '../types.js';
import { SECTION_PLANE_DEFAULTS } from '../constants.js';

export interface SectionSlice {
  // State
  sectionPlane: SectionPlane;

  // Actions
  setSectionPlane: (plane: Partial<SectionPlane>) => void;
  setSectionPlaneFromFace: (normal: { x: number; y: number; z: number }, point: { x: number; y: number; z: number }) => void;
  setSectionPlaneDistance: (distance: number) => void;
  toggleSectionPlane: () => void;
  flipSectionPlane: () => void;
  resetSectionPlane: () => void;
}

const getDefaultSectionPlane = (): SectionPlane => ({ ...SECTION_PLANE_DEFAULTS });

export const createSectionSlice: StateCreator<SectionSlice, [], [], SectionSlice> = (set) => ({
  // Initial state
  sectionPlane: getDefaultSectionPlane(),

  // Actions
  setSectionPlane: (update) => set((state) => ({
    sectionPlane: { ...state.sectionPlane, ...update },
  })),

  /** Set section plane from a clicked face: derive plane from face normal + point on face */
  setSectionPlaneFromFace: (normal, point) => set(() => {
    // Plane distance = dot(normal, point) — signed distance from origin
    const distance = normal.x * point.x + normal.y * point.y + normal.z * point.z;
    return {
      sectionPlane: {
        normal: { x: normal.x, y: normal.y, z: normal.z },
        distance,
        enabled: true,
        flipped: false,
      },
    };
  }),

  setSectionPlaneDistance: (distance) => set((state) => ({
    sectionPlane: { ...state.sectionPlane, distance },
  })),

  toggleSectionPlane: () => set((state) => ({
    sectionPlane: { ...state.sectionPlane, enabled: !state.sectionPlane.enabled },
  })),

  flipSectionPlane: () => set((state) => ({
    sectionPlane: {
      ...state.sectionPlane,
      flipped: !state.sectionPlane.flipped,
      // Flip = negate normal and distance
      normal: {
        x: -state.sectionPlane.normal.x,
        y: -state.sectionPlane.normal.y,
        z: -state.sectionPlane.normal.z,
      },
      distance: -state.sectionPlane.distance,
    },
  })),

  resetSectionPlane: () => set({ sectionPlane: getDefaultSectionPlane() }),
});
