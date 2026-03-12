/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section plane renderer — renders a visible plane at the section cut location.
 * Supports arbitrary plane orientation (face-based cutting).
 */

export interface SectionPlaneRenderOptions {
  normal: { x: number; y: number; z: number };
  distance: number;
  bounds: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  };
  viewProj: Float32Array;
  isPreview?: boolean;
}

export class SectionPlaneRenderer {
  private device: GPUDevice;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private previewPipeline: GPURenderPipeline | null = null;
  private cutPipeline: GPURenderPipeline | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private format: GPUTextureFormat;
  private sampleCount: number;
  private initialized = false;

  constructor(device: GPUDevice, format: GPUTextureFormat, sampleCount: number = 4) {
    this.device = device;
    this.format = format;
    this.sampleCount = sampleCount;
  }

  private init(): void {
    if (this.initialized) return;

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      }],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    const shaderModule = this.device.createShaderModule({
      code: `
        struct Uniforms {
          viewProj: mat4x4<f32>,
          planeColor: vec4<f32>,
        }
        @binding(0) @group(0) var<uniform> uniforms: Uniforms;

        struct VertexOutput {
          @builtin(position) position: vec4<f32>,
          @location(0) uv: vec2<f32>,
        }

        @vertex
        fn vs_main(@location(0) position: vec3<f32>, @location(1) uv: vec2<f32>) -> VertexOutput {
          var output: VertexOutput;
          output.position = uniforms.viewProj * vec4<f32>(position, 1.0);
          output.uv = uv;
          return output;
        }

        @fragment
        fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
          let gridSize = 0.01;
          let lineWidth = 0.001;
          let majorGridSize = 0.1;
          let majorLineWidth = 0.002;

          let gridX = abs(fract(input.uv.x / gridSize + 0.5) - 0.5);
          let gridY = abs(fract(input.uv.y / gridSize + 0.5) - 0.5);
          let isMinorGridLine = min(gridX, gridY) < lineWidth;

          let majorX = abs(fract(input.uv.x / majorGridSize + 0.5) - 0.5);
          let majorY = abs(fract(input.uv.y / majorGridSize + 0.5) - 0.5);
          let isMajorGridLine = min(majorX, majorY) < majorLineWidth;

          let edgeDist = min(input.uv.x, min(input.uv.y, min(1.0 - input.uv.x, 1.0 - input.uv.y)));
          let edgeFade = smoothstep(0.0, 0.08, edgeDist);
          let borderGlow = 1.0 - smoothstep(0.0, 0.03, edgeDist);

          var color = uniforms.planeColor;

          if (isMajorGridLine) {
            color = vec4<f32>(1.0, 1.0, 1.0, color.a * 1.5);
          } else if (isMinorGridLine) {
            color = vec4<f32>(color.rgb * 1.3, color.a * 1.2);
          }

          color = vec4<f32>(
            mix(color.rgb, vec3<f32>(1.0, 1.0, 1.0), borderGlow * 0.3),
            color.a + borderGlow * 0.2
          );
          color.a *= edgeFade;
          color.a = min(color.a, 0.5);

          return color;
        }
      `,
    });

    const pipelineBase = {
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [{
          arrayStride: 20,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' as const },
            { shaderLocation: 1, offset: 12, format: 'float32x2' as const },
          ],
        }],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: 'src-alpha' as const, dstFactor: 'one-minus-src-alpha' as const, operation: 'add' as const },
            alpha: { srcFactor: 'one' as const, dstFactor: 'one-minus-src-alpha' as const, operation: 'add' as const },
          },
        }],
      },
      primitive: { topology: 'triangle-list' as const, cullMode: 'none' as const },
      multisample: { count: this.sampleCount },
    };

    this.previewPipeline = this.device.createRenderPipeline({
      ...pipelineBase,
      depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'greater' },
    });

    this.cutPipeline = this.device.createRenderPipeline({
      ...pipelineBase,
      depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'always' },
    });

    this.vertexBuffer = this.device.createBuffer({
      size: 6 * 5 * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    this.uniformBuffer = this.device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });

    this.initialized = true;
  }

  /**
   * Draw section plane into an existing render pass.
   * Computes a quad in 3D space that lies on the arbitrary plane, sized to the model bounds.
   */
  draw(pass: GPURenderPassEncoder, options: SectionPlaneRenderOptions): void {
    this.init();
    if (!this.previewPipeline || !this.vertexBuffer || !this.uniformBuffer || !this.bindGroup) return;

    // Only draw in preview mode (plane indicator when not actively cutting)
    if (!options.isPreview) return;

    const vertices = this.calculatePlaneVertices(options.normal, options.distance, options.bounds);
    this.device.queue.writeBuffer(this.vertexBuffer, 0, vertices);

    const uniforms = new Float32Array(20);
    uniforms.set(options.viewProj, 0);
    // Light blue color
    uniforms[16] = 0.012; uniforms[17] = 0.663; uniforms[18] = 0.957;
    uniforms[19] = 0.25;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

    pass.setPipeline(this.previewPipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.draw(6);
  }

  /**
   * Build a quad on the arbitrary plane, sized to cover the model bounds.
   * We construct two tangent vectors orthogonal to the normal,
   * then project the AABB onto the plane to find the extents.
   */
  private calculatePlaneVertices(
    normal: { x: number; y: number; z: number },
    distance: number,
    bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }
  ): Float32Array {
    const n = normal;

    // Build tangent frame (Gram-Schmidt)
    let upCandidate = Math.abs(n.y) < 0.9
      ? { x: 0, y: 1, z: 0 }
      : { x: 1, y: 0, z: 0 };

    // tangent = normalize(upCandidate cross n)
    let tx = upCandidate.y * n.z - upCandidate.z * n.y;
    let ty = upCandidate.z * n.x - upCandidate.x * n.z;
    let tz = upCandidate.x * n.y - upCandidate.y * n.x;
    let len = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (len < 1e-8) { tx = 1; ty = 0; tz = 0; len = 1; }
    tx /= len; ty /= len; tz /= len;

    // bitangent = n cross tangent
    const bx = n.y * tz - n.z * ty;
    const by = n.z * tx - n.x * tz;
    const bz = n.x * ty - n.y * tx;

    // Plane center: point on plane closest to bounds center
    const cx = (bounds.min.x + bounds.max.x) / 2;
    const cy = (bounds.min.y + bounds.max.y) / 2;
    const cz = (bounds.min.z + bounds.max.z) / 2;
    const centerDist = n.x * cx + n.y * cy + n.z * cz;
    const diff = distance - centerDist;
    const px = cx + n.x * diff;
    const py = cy + n.y * diff;
    const pz = cz + n.z * diff;

    // Compute half-extent along tangent/bitangent from bounds diagonal
    const dx = bounds.max.x - bounds.min.x;
    const dy = bounds.max.y - bounds.min.y;
    const dz = bounds.max.z - bounds.min.z;
    const diag = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const halfSize = diag * 0.6; // 60% of diagonal — covers model with padding

    // Quad corners
    const c00x = px - tx * halfSize - bx * halfSize;
    const c00y = py - ty * halfSize - by * halfSize;
    const c00z = pz - tz * halfSize - bz * halfSize;

    const c10x = px + tx * halfSize - bx * halfSize;
    const c10y = py + ty * halfSize - by * halfSize;
    const c10z = pz + tz * halfSize - bz * halfSize;

    const c11x = px + tx * halfSize + bx * halfSize;
    const c11y = py + ty * halfSize + by * halfSize;
    const c11z = pz + tz * halfSize + bz * halfSize;

    const c01x = px - tx * halfSize + bx * halfSize;
    const c01y = py - ty * halfSize + by * halfSize;
    const c01z = pz - tz * halfSize + bz * halfSize;

    return new Float32Array([
      // Triangle 1
      c00x, c00y, c00z, 0, 0,
      c10x, c10y, c10z, 1, 0,
      c11x, c11y, c11z, 1, 1,
      // Triangle 2
      c00x, c00y, c00z, 0, 0,
      c11x, c11y, c11z, 1, 1,
      c01x, c01y, c01z, 0, 1,
    ]);
  }

  destroy(): void {
    this.vertexBuffer?.destroy();
    this.vertexBuffer = null;
    this.uniformBuffer?.destroy();
    this.uniformBuffer = null;
    this.initialized = false;
  }
}
