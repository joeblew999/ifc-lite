/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { TilesetGenerator, computeGlobalBounds, computeGeometricError, aabbToBoundingVolume } from './tileset-generator.js';
import { buildGlbContent } from './tile-content-builder.js';
import { FederatedTilesetBuilder } from './federated-tileset-builder.js';
import { RemoteTileLoader } from './remote-tile-loader.js';
import type { MeshData, GeometryResult } from '@ifc-lite/geometry';

// ═══════════════════════════════════════════════════════════════════════════
// TEST HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function makeMesh(expressId: number, x: number, y: number, z: number, size: number = 1): MeshData {
  const half = size / 2;
  // Simple box-like triangle at the given position
  return {
    expressId,
    positions: new Float32Array([
      x - half, y - half, z - half,
      x + half, y - half, z - half,
      x + half, y + half, z - half,
      x - half, y + half, z + half,
    ]),
    normals: new Float32Array([
      0, 0, -1,
      0, 0, -1,
      0, 0, -1,
      0, 0, 1,
    ]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    color: [0.8, 0.8, 0.8, 1.0],
  };
}

function makeGeometryResult(meshes: MeshData[]): GeometryResult {
  let totalTriangles = 0;
  let totalVertices = 0;
  for (const m of meshes) {
    totalVertices += m.positions.length / 3;
    totalTriangles += m.indices.length / 3;
  }
  return {
    meshes,
    totalTriangles,
    totalVertices,
    coordinateInfo: {
      hasLargeCoordinates: false,
      shift: { x: 0, y: 0, z: 0 },
      bounds: { min: [0, 0, 0], max: [10, 10, 10] },
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// computeGlobalBounds
// ═══════════════════════════════════════════════════════════════════════════

describe('computeGlobalBounds', () => {
  it('computes bounds across multiple meshes', () => {
    const meshes = [
      makeMesh(1, 0, 0, 0),
      makeMesh(2, 10, 5, 3),
    ];
    const bounds = computeGlobalBounds(meshes);
    expect(bounds.min[0]).toBeLessThanOrEqual(-0.5);
    expect(bounds.max[0]).toBeGreaterThanOrEqual(10.5);
    expect(bounds.max[1]).toBeGreaterThanOrEqual(5.5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// computeGeometricError
// ═══════════════════════════════════════════════════════════════════════════

describe('computeGeometricError', () => {
  it('returns half the diagonal of the bounding box', () => {
    const bounds = { min: [0, 0, 0] as [number, number, number], max: [10, 0, 0] as [number, number, number] };
    const error = computeGeometricError(bounds);
    expect(error).toBeCloseTo(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// aabbToBoundingVolume
// ═══════════════════════════════════════════════════════════════════════════

describe('aabbToBoundingVolume', () => {
  it('produces correct box format', () => {
    const bounds = { min: [0, 0, 0] as [number, number, number], max: [10, 6, 4] as [number, number, number] };
    const bv = aabbToBoundingVolume(bounds);
    expect(bv.box).toBeDefined();
    // Center: [5, 3, 2]
    expect(bv.box![0]).toBeCloseTo(5);
    expect(bv.box![1]).toBeCloseTo(3);
    expect(bv.box![2]).toBeCloseTo(2);
    // Half extents on diagonal: [5, 0, 0, 0, 3, 0, 0, 0, 2]
    expect(bv.box![3]).toBeCloseTo(5);
    expect(bv.box![7]).toBeCloseTo(3);
    expect(bv.box![11]).toBeCloseTo(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TilesetGenerator
// ═══════════════════════════════════════════════════════════════════════════

describe('TilesetGenerator', () => {
  it('generates an empty tileset from empty geometry', () => {
    const generator = new TilesetGenerator();
    const result = generator.generate({ meshes: [], totalTriangles: 0, totalVertices: 0, coordinateInfo: { hasLargeCoordinates: false, shift: { x: 0, y: 0, z: 0 }, bounds: { min: [0, 0, 0], max: [0, 0, 0] } } });
    expect(result.tileset.asset.version).toBe('1.1');
    expect(result.tiles).toHaveLength(0);
  });

  it('generates a single-tile tileset for small geometry', () => {
    const meshes = [makeMesh(1, 0, 0, 0), makeMesh(2, 1, 0, 0)];
    const geom = makeGeometryResult(meshes);
    const generator = new TilesetGenerator({ maxMeshesPerTile: 10 });
    const result = generator.generate(geom);

    expect(result.tileset.asset.version).toBe('1.1');
    expect(result.tileset.root.boundingVolume.box).toBeDefined();
    expect(result.tiles.length).toBeGreaterThanOrEqual(1);
    // Should have content at the leaf
    expect(result.tiles[0].glb.byteLength).toBeGreaterThan(0);
    expect(result.tiles[0].expressIds).toContain(1);
    expect(result.tiles[0].expressIds).toContain(2);
  });

  it('splits into multiple tiles when meshes exceed limit', () => {
    // Create many meshes spread across space
    const meshes: MeshData[] = [];
    for (let i = 0; i < 20; i++) {
      meshes.push(makeMesh(i + 1, i * 10, 0, 0));
    }
    const geom = makeGeometryResult(meshes);
    const generator = new TilesetGenerator({ maxMeshesPerTile: 5 });
    const result = generator.generate(geom);

    expect(result.tiles.length).toBeGreaterThan(1);
    // All express IDs should be covered
    const allIds = result.tiles.flatMap(t => t.expressIds).sort((a, b) => a - b);
    expect(allIds).toHaveLength(20);
    expect(allIds[0]).toBe(1);
    expect(allIds[19]).toBe(20);
  });

  it('includes metadata schema when enabled', () => {
    const meshes = [makeMesh(1, 0, 0, 0)];
    const geom = makeGeometryResult(meshes);
    const generator = new TilesetGenerator({ includeMetadata: true, modelId: 'arch' });
    const result = generator.generate(geom);
    expect(result.tileset.schema?.id).toBe('ifc-lite-arch');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// buildGlbContent
// ═══════════════════════════════════════════════════════════════════════════

describe('buildGlbContent', () => {
  it('produces valid GLB magic bytes', () => {
    const meshes = [makeMesh(1, 0, 0, 0)];
    const glb = buildGlbContent(meshes);

    // GLB magic: 0x46546C67 = 'glTF'
    const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    expect(view.getUint32(0, true)).toBe(0x46546C67);
    // Version 2
    expect(view.getUint32(4, true)).toBe(2);
  });

  it('handles empty mesh array', () => {
    const glb = buildGlbContent([]);
    const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    expect(view.getUint32(0, true)).toBe(0x46546C67);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FederatedTilesetBuilder
// ═══════════════════════════════════════════════════════════════════════════

describe('FederatedTilesetBuilder', () => {
  it('creates empty root tileset with no models', () => {
    const builder = new FederatedTilesetBuilder();
    const result = builder.build([]);
    expect(result.asset.version).toBe('1.1');
    expect(result.root.geometricError).toBe(0);
  });

  it('creates federated tileset with multiple models', () => {
    const builder = new FederatedTilesetBuilder();
    const result = builder.build([
      {
        modelId: 'architecture',
        uri: 'arch/tileset.json',
        bounds: { min: [0, 0, 0], max: [50, 30, 10] },
      },
      {
        modelId: 'structure',
        uri: 'struct/tileset.json',
        bounds: { min: [0, 0, -5], max: [50, 30, 12] },
      },
      {
        modelId: 'mep',
        uri: 'mep/tileset.json',
        bounds: { min: [5, 5, 0], max: [45, 25, 9] },
      },
    ]);

    expect(result.asset.version).toBe('1.1');
    expect(result.root.children).toHaveLength(3);
    expect(result.root.children![0].content!.uri).toBe('arch/tileset.json');
    expect(result.root.children![1].content!.uri).toBe('struct/tileset.json');
    expect(result.root.children![2].content!.uri).toBe('mep/tileset.json');
    expect(result.root.refine).toBe('ADD');
  });

  it('includes model metadata schema when enabled', () => {
    const builder = new FederatedTilesetBuilder({ includeModelMetadata: true });
    const result = builder.build([
      {
        modelId: 'arch',
        uri: 'arch/tileset.json',
        bounds: { min: [0, 0, 0], max: [10, 10, 10] },
      },
    ]);
    expect(result.schema?.id).toBe('ifc-lite-federation');
    expect(result.schema?.classes?.IfcModel).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RemoteTileLoader
// ═══════════════════════════════════════════════════════════════════════════

describe('RemoteTileLoader', () => {
  it('resolves URLs correctly', async () => {
    const fetchedUrls: string[] = [];
    const mockFetch = async (url: string): Promise<Response> => {
      fetchedUrls.push(url);
      return new Response(JSON.stringify({
        asset: { version: '1.1' },
        geometricError: 100,
        root: {
          boundingVolume: { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
          geometricError: 0,
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const loader = new RemoteTileLoader({
      baseUrl: 'https://bucket.s3.amazonaws.com/project/',
      fetchFn: mockFetch as typeof fetch,
    });

    await loader.loadTileset('tileset.json');
    expect(fetchedUrls[0]).toBe('https://bucket.s3.amazonaws.com/project/tileset.json');
  });

  it('caches tilesets', async () => {
    let fetchCount = 0;
    const mockFetch = async (): Promise<Response> => {
      fetchCount++;
      return new Response(JSON.stringify({
        asset: { version: '1.1' },
        geometricError: 0,
        root: {
          boundingVolume: { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
          geometricError: 0,
        },
      }), { status: 200 });
    };

    const loader = new RemoteTileLoader({
      baseUrl: 'https://example.com/',
      fetchFn: mockFetch as typeof fetch,
      enableCache: true,
    });

    await loader.loadTileset('tileset.json');
    await loader.loadTileset('tileset.json');
    expect(fetchCount).toBe(1);
  });

  it('reports cache stats', async () => {
    const mockFetch = async (url: string): Promise<Response> => {
      if (url.endsWith('.json')) {
        return new Response(JSON.stringify({
          asset: { version: '1.1' },
          geometricError: 0,
          root: { boundingVolume: { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] }, geometricError: 0 },
        }), { status: 200 });
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    };

    const loader = new RemoteTileLoader({
      baseUrl: 'https://example.com/',
      fetchFn: mockFetch as typeof fetch,
    });

    await loader.loadTileset('tileset.json');
    await loader.loadTileContent('tiles/tile_0.glb');

    const stats = loader.getCacheStats();
    expect(stats.tilesets).toBe(1);
    expect(stats.tiles).toBe(1);
    expect(stats.totalBytes).toBe(4);
  });
});
