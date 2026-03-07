/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/3d-tiles - 3D Tiles 1.1 generation, federation, and remote loading
 *
 * Generate OGC 3D Tiles 1.1 tilesets from IFC geometry, federate multiple
 * models as external tilesets, and load tiles on-demand from cloud storage.
 */

export { TilesetGenerator, computeGlobalBounds, computeGeometricError, aabbToBoundingVolume } from './tileset-generator.js';
export { FederatedTilesetBuilder, type ExternalTilesetRef } from './federated-tileset-builder.js';
export { RemoteTileLoader, type LoadedTile, type ViewFrustumParams } from './remote-tile-loader.js';
export { buildGlbContent } from './tile-content-builder.js';

export type {
  Tileset,
  TilesetAsset,
  Tile,
  TileContent,
  BoundingVolume,
  TilesetSchema,
  SchemaClass,
  SchemaProperty,
  TilesetGeneratorOptions,
  FederatedTilesetOptions,
  RemoteTileLoaderOptions,
  GeneratedTile,
  TilesetOutput,
} from './types.js';
