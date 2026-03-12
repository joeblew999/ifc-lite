/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createSectionSlice, type SectionSlice } from './sectionSlice.js';
import { SECTION_PLANE_DEFAULTS } from '../constants.js';

describe('SectionSlice', () => {
  let state: SectionSlice;
  let setState: (partial: Partial<SectionSlice> | ((state: SectionSlice) => Partial<SectionSlice>)) => void;

  beforeEach(() => {
    // Create a mock set function that updates state
    setState = (partial) => {
      if (typeof partial === 'function') {
        const updates = partial(state);
        state = { ...state, ...updates };
      } else {
        state = { ...state, ...partial };
      }
    };

    // Create slice with mock set function
    state = createSectionSlice(setState, () => state, {} as any);
  });

  describe('initial state', () => {
    it('should have default section plane values', () => {
      assert.deepStrictEqual(state.sectionPlane.normal, SECTION_PLANE_DEFAULTS.normal);
      assert.strictEqual(state.sectionPlane.distance, SECTION_PLANE_DEFAULTS.distance);
      assert.strictEqual(state.sectionPlane.enabled, SECTION_PLANE_DEFAULTS.enabled);
      assert.strictEqual(state.sectionPlane.flipped, SECTION_PLANE_DEFAULTS.flipped);
    });
  });

  describe('setSectionPlane', () => {
    it('should partially update the section plane', () => {
      state.setSectionPlane({ distance: 5.5 });
      assert.strictEqual(state.sectionPlane.distance, 5.5);
      assert.deepStrictEqual(state.sectionPlane.normal, SECTION_PLANE_DEFAULTS.normal);
    });

    it('should update normal and distance together', () => {
      state.setSectionPlane({ normal: { x: 1, y: 0, z: 0 }, distance: 3 });
      assert.deepStrictEqual(state.sectionPlane.normal, { x: 1, y: 0, z: 0 });
      assert.strictEqual(state.sectionPlane.distance, 3);
    });
  });

  describe('setSectionPlaneFromFace', () => {
    it('should compute distance from normal and point', () => {
      // normal = (0, 1, 0), point = (5, 10, 3) → distance = dot = 10
      state.setSectionPlaneFromFace({ x: 0, y: 1, z: 0 }, { x: 5, y: 10, z: 3 });
      assert.deepStrictEqual(state.sectionPlane.normal, { x: 0, y: 1, z: 0 });
      assert.strictEqual(state.sectionPlane.distance, 10);
      assert.strictEqual(state.sectionPlane.enabled, true);
      assert.strictEqual(state.sectionPlane.flipped, false);
    });

    it('should handle arbitrary normals', () => {
      // normal = (1, 0, 0), point = (7, 0, 0) → distance = 7
      state.setSectionPlaneFromFace({ x: 1, y: 0, z: 0 }, { x: 7, y: 0, z: 0 });
      assert.strictEqual(state.sectionPlane.distance, 7);
    });
  });

  describe('setSectionPlaneDistance', () => {
    it('should update the distance', () => {
      state.setSectionPlaneDistance(12.5);
      assert.strictEqual(state.sectionPlane.distance, 12.5);
    });
  });

  describe('toggleSectionPlane', () => {
    it('should toggle enabled from false to true', () => {
      assert.strictEqual(state.sectionPlane.enabled, false);
      state.toggleSectionPlane();
      assert.strictEqual(state.sectionPlane.enabled, true);
    });

    it('should toggle enabled from true to false', () => {
      state.sectionPlane.enabled = true;
      state.toggleSectionPlane();
      assert.strictEqual(state.sectionPlane.enabled, false);
    });
  });

  describe('flipSectionPlane', () => {
    it('should negate normal and distance when flipping', () => {
      state.setSectionPlaneFromFace({ x: 0, y: 1, z: 0 }, { x: 0, y: 5, z: 0 });
      assert.strictEqual(state.sectionPlane.flipped, false);
      assert.strictEqual(state.sectionPlane.distance, 5);

      state.flipSectionPlane();
      assert.strictEqual(state.sectionPlane.flipped, true);
      assert.strictEqual(state.sectionPlane.normal.y, -1);
      assert.strictEqual(state.sectionPlane.distance, -5);
    });

    it('should toggle flipped back and restore original', () => {
      state.setSectionPlaneFromFace({ x: 0, y: 1, z: 0 }, { x: 0, y: 5, z: 0 });
      state.flipSectionPlane();
      state.flipSectionPlane();
      assert.strictEqual(state.sectionPlane.flipped, false);
      assert.strictEqual(state.sectionPlane.normal.y, 1);
      assert.strictEqual(state.sectionPlane.distance, 5);
    });
  });

  describe('resetSectionPlane', () => {
    it('should reset to default values', () => {
      // Modify state
      state.setSectionPlaneFromFace({ x: 1, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });

      state.resetSectionPlane();

      assert.deepStrictEqual(state.sectionPlane.normal, SECTION_PLANE_DEFAULTS.normal);
      assert.strictEqual(state.sectionPlane.distance, SECTION_PLANE_DEFAULTS.distance);
      assert.strictEqual(state.sectionPlane.enabled, SECTION_PLANE_DEFAULTS.enabled);
      assert.strictEqual(state.sectionPlane.flipped, SECTION_PLANE_DEFAULTS.flipped);
    });
  });
});
