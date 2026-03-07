/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * 3D Tiles 1.1 type definitions
 * Based on OGC 3D Tiles specification
 * https://docs.ogc.org/cs/22-025r4/22-025r4.html
 */

// ═══════════════════════════════════════════════════════════════════════════
// TILESET
// ═══════════════════════════════════════════════════════════════════════════

export interface Tileset {
  asset: TilesetAsset;
  /** Geometric error at the root level (meters). Controls when root tile loads. */
  geometricError: number;
  root: Tile;
  /** Optional schema for metadata (3D Tiles 1.1) */
  schema?: TilesetSchema;
  /** Optional extension declarations */
  extensionsUsed?: string[];
  extensionsRequired?: string[];
}

export interface TilesetAsset {
  version: '1.1';
  tilesetVersion?: string;
  generator?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// TILE
// ═══════════════════════════════════════════════════════════════════════════

export interface Tile {
  boundingVolume: BoundingVolume;
  /**
   * Geometric error for this tile (meters).
   * When camera error < this value, children are loaded instead.
   * Leaf tiles should have geometricError = 0.
   */
  geometricError: number;
  /** Tile content (glTF/GLB in 3D Tiles 1.1) */
  content?: TileContent;
  /** Child tiles for LOD hierarchy */
  children?: Tile[];
  /** How to refine when switching to children */
  refine?: 'ADD' | 'REPLACE';
  /** Optional 4x4 column-major transform */
  transform?: number[];
}

export interface TileContent {
  /** URI to the tile content (GLB file or external tileset.json) */
  uri: string;
  /** Optional bounding volume for the content (tighter than tile volume) */
  boundingVolume?: BoundingVolume;
  /** Optional metadata group (3D Tiles 1.1) */
  group?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// BOUNDING VOLUMES
// ═══════════════════════════════════════════════════════════════════════════

export interface BoundingVolume {
  /** Axis-aligned bounding box: [centerX, centerY, centerZ, halfX, 0, 0, 0, halfY, 0, 0, 0, halfZ] */
  box?: number[];
  /** Bounding sphere: [centerX, centerY, centerZ, radius] */
  sphere?: number[];
  /** Geographic region: [west, south, east, north, minHeight, maxHeight] in radians */
  region?: number[];
}

// ═══════════════════════════════════════════════════════════════════════════
// SCHEMA & METADATA (3D Tiles 1.1)
// ═══════════════════════════════════════════════════════════════════════════

export interface TilesetSchema {
  id: string;
  name?: string;
  description?: string;
  classes?: Record<string, SchemaClass>;
}

export interface SchemaClass {
  name?: string;
  description?: string;
  properties?: Record<string, SchemaProperty>;
}

export interface SchemaProperty {
  type: 'SCALAR' | 'STRING' | 'BOOLEAN' | 'ENUM' | 'VEC2' | 'VEC3' | 'VEC4';
  componentType?: 'INT8' | 'UINT8' | 'INT16' | 'UINT16' | 'INT32' | 'UINT32' | 'FLOAT32' | 'FLOAT64';
  description?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// GENERATOR OPTIONS
// ═══════════════════════════════════════════════════════════════════════════

export interface TilesetGeneratorOptions {
  /** Maximum meshes per leaf tile (default: 256) */
  maxMeshesPerTile?: number;
  /** Minimum geometric error for leaf tiles in meters (default: 0) */
  minGeometricError?: number;
  /** Base path for tile content URIs (default: './tiles/') */
  contentBasePath?: string;
  /** Include IFC metadata in tileset schema (default: true) */
  includeMetadata?: boolean;
  /** Optional model identifier for federation */
  modelId?: string;
}

export interface FederatedTilesetOptions {
  /** Base geometric error for the federated root (default: 100) */
  rootGeometricError?: number;
  /** Include per-model metadata groups */
  includeModelMetadata?: boolean;
}

export interface RemoteTileLoaderOptions {
  /** Base URL for fetching tiles (e.g., 'https://bucket.s3.amazonaws.com/project/') */
  baseUrl: string;
  /** Custom fetch function (for auth headers, etc.) */
  fetchFn?: typeof fetch;
  /** Maximum concurrent tile requests (default: 6) */
  maxConcurrency?: number;
  /** Cache parsed tilesets in memory (default: true) */
  enableCache?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// GENERATED OUTPUT
// ═══════════════════════════════════════════════════════════════════════════

export interface GeneratedTile {
  /** Path for this tile's content (e.g., 'tiles/tile_0.glb') */
  path: string;
  /** GLB binary content */
  glb: Uint8Array;
  /** Express IDs contained in this tile */
  expressIds: number[];
}

export interface TilesetOutput {
  /** The tileset.json content */
  tileset: Tileset;
  /** Generated tile GLB files */
  tiles: GeneratedTile[];
}
