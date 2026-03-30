/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GPU-based object picking
 */

import { WebGPUDevice } from './device.js';
import type { BatchedMesh, Mesh, PickResult } from './types.js';

type PickRenderable = Pick<Mesh, 'vertexBuffer' | 'indexBuffer' | 'indexCount' | 'modelIndex'>
  | Pick<BatchedMesh, 'vertexBuffer' | 'indexBuffer' | 'indexCount' | 'modelIndex'>;

export class Picker {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private depthTexture: GPUTexture;
  private colorTexture: GPUTexture;
  private uniformBuffer: GPUBuffer;
  private bindGroup: GPUBindGroup;
  private destroyed = false;

  constructor(device: WebGPUDevice, width: number = 1, height: number = 1) {
    this.device = device.getDevice();

    // Create textures for picking
    this.colorTexture = this.device.createTexture({
      size: { width, height },
      format: 'r32uint',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });

    this.depthTexture = this.device.createTexture({
      size: { width, height },
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });

    // Create uniform buffer for viewProj matrix only (16 floats = 64 bytes)
    this.uniformBuffer = this.device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create picker shader that reads the encoded entityId directly from the
    // vertex buffer. This works for both individual meshes and batched geometry.
    const shaderModule = this.device.createShaderModule({
      code: `
        struct Uniforms {
          viewProj: mat4x4<f32>,
        }
        @binding(0) @group(0) var<uniform> uniforms: Uniforms;

        struct VertexInput {
          @location(0) position: vec3<f32>,
          @location(1) normal: vec3<f32>,
          @location(2) entityId: u32,
        }

        struct VertexOutput {
          @builtin(position) position: vec4<f32>,
          @location(0) @interpolate(flat) objectId: u32,
        }

        @vertex
        fn vs_main(input: VertexInput) -> VertexOutput {
          var output: VertexOutput;
          output.position = uniforms.viewProj * vec4<f32>(input.position, 1.0);
          output.objectId = input.entityId;
          return output;
        }

        @fragment
        fn fs_main(input: VertexOutput) -> @location(0) u32 {
          return input.objectId;
        }
      `,
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 28,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x3' },
              { shaderLocation: 2, offset: 24, format: 'uint32' },
            ],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format: 'r32uint' }],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'back',
      },
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: true,
        depthCompare: 'greater',  // Reverse-Z: greater instead of less
      },
    });

    // Create bind group using the pipeline's auto-generated layout
    // IMPORTANT: Must use getBindGroupLayout() when pipeline uses layout: 'auto'
    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer },
        },
      ],
    });
  }

  /**
   * Pick object at screen coordinates
   * Returns PickResult with expressId and modelIndex for multi-model support
   */
  async pick(
    x: number,
    y: number,
    width: number,
    height: number,
    renderables: PickRenderable[],
    viewProj: Float32Array
  ): Promise<PickResult | null> {
    // Resize textures if needed
    if (this.colorTexture.width !== width || this.colorTexture.height !== height) {
      this.colorTexture.destroy();
      this.depthTexture.destroy();

      this.colorTexture = this.device.createTexture({
        size: { width, height },
        format: 'r32uint',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });

      this.depthTexture = this.device.createTexture({
        size: { width, height },
        format: 'depth32float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }
    
    // Recreate texture views each time to avoid reuse issues
    // WebGPU texture views cannot be reused after being submitted
    const colorView = this.colorTexture.createView();
    const depthView = this.depthTexture.createView();

    // Render picker pass
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: colorView,
          loadOp: 'clear',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 0.0,  // Reverse-Z: clear to 0.0 (far plane)
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });

    // Upload viewProj matrix to uniform buffer (once for all meshes)
    this.device.queue.writeBuffer(this.uniformBuffer, 0, viewProj);

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);

    for (const renderable of renderables) {
      pass.setVertexBuffer(0, renderable.vertexBuffer);
      pass.setIndexBuffer(renderable.indexBuffer, 'uint32');
      pass.drawIndexed(renderable.indexCount, 1, 0, 0, 0);
    }

    pass.end();

    // Read pixel at click position
    // WebGPU requires bytesPerRow to be a multiple of 256
    const BYTES_PER_ROW = 256;
    const readBuffer = this.device.createBuffer({
      size: BYTES_PER_ROW,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    encoder.copyTextureToBuffer(
      {
        texture: this.colorTexture,
        origin: { x: Math.floor(x), y: Math.floor(y), z: 0 },
      },
      {
        buffer: readBuffer,
        bytesPerRow: BYTES_PER_ROW,
        rowsPerImage: 1,
      },
      { width: 1, height: 1 }
    );

    this.device.queue.submit([encoder.finish()]);
    // GPUMapMode.READ = 1 (WebGPU spec)
    await readBuffer.mapAsync(1); // GPUMapMode.READ
    const data = new Uint32Array(readBuffer.getMappedRange());
    const meshIndex = data[0];
    readBuffer.unmap();
    readBuffer.destroy();

    if (meshIndex === 0) return null;

    return {
      expressId: meshIndex,
    };
  }

  updateUniforms(viewProj: Float32Array): void {
    // Update viewProj matrix only
    this.device.queue.writeBuffer(this.uniformBuffer, 0, viewProj);
  }

  /**
   * Destroy all GPU resources held by this picker.
   * After calling this method the picker is no longer usable.
   * Safe to call multiple times.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.colorTexture.destroy();
    this.depthTexture.destroy();
    this.uniformBuffer.destroy();
  }
}
