# GPU particle batching

## Root cause

Babylon 8.56's WebGL2 GPU particle path performs two real GPU submissions for every active `GPUParticleSystem`:

1. `WebGL2ParticleSystem.updateParticleBuffer()` enables transform feedback and calls `engine.drawArraysType()` with point primitives.
2. `GPUParticleSystem._render()` calls `engine.drawArraysType()` again to render an instanced billboard quad.

`ThinEngine.drawArraysType()` calls `_reportDrawCall()` for both operations. Transform-feedback simulation therefore appears in Babylon's draw-call counter and must not be subtracted. The observed triforts numbers reconcile as follows for the main view:

| Path | Non-particle draws | Particle render draws | Particle simulation draws | Approximate total |
| --- | ---: | ---: | ---: | ---: |
| CPU, 292 systems | 1,108 | 292 | 0 | 1,400 |
| Previous GPU, 292 systems | 1,108 | 292 | 292 | 1,692 |
| Batched GPU, `B` batches | 1,108 | `B` | `B` | `1,108 + 2B` |

Reflection and refraction cameras can add real particle submissions. Shift+O detailed mode measures the draw-counter delta around each actual particle-system render, so its simulation/render split includes these passes and reconciles with the engine total.

## Architecture

Static map emitters are collected during map loading and grouped by compatible texture, blend mode, animation mode, color, size, lifetime, emission rate, velocity, gravity, and emitter shape. A group is split only when its capacity would exceed the configured batch limit.

Each shared `GPUParticleSystem` owns fixed particle-slot ranges for its emitters. A Babylon `CustomParticleEmitter` seeds every slot with its emitter's world position, randomized local spawn offset, and initial velocity when GPU buffers are initialized. A narrowly scoped update-shader branch makes custom-emitter direction represent velocity, retaining transform-feedback integration and gravity instead of Babylon's default destination interpolation. No particle is visited from TypeScript per frame.

Static emitter definitions and slot ownership are uploaded once per map. Global grouping is deliberately used instead of spatial fragmentation: it minimizes submissions, preserves particles in the main/reflection/refraction passes, and cannot incorrectly cull particles that move into view. The batch capacity is bounded to 8,192, 32,768, or 65,536 slots depending on particle quality.

Dynamic combat bursts continue to use pooled GPU systems because simultaneous, independently timed bursts cannot be inserted into Babylon's fixed custom-emitter buffers without rebuilding them. Arbitrary line trails retain the corrected CPU fallback because Babylon's native GPU emitters cannot reproduce exact line placement. Mesh explosions, beams, muzzle flashes, decals, projectiles, and bouncers remain their existing specialized renderers and are not CPU particle simulations.

## Profiling

Shift+O remains compact. Shift+Alt+O adds:

- Logical emitter count.
- GPU batch count.
- Actual GPU simulation submissions.
- Actual GPU particle rendering submissions.
- Actual CPU particle rendering submissions.
- GPU particle capacity and active-slot estimate.
- Particle lifecycle CPU time.

Instrumentation is installed only while Shift+O is visible. GPU timing remains `N/A` for the particle subsection because Babylon exposes frame-level timer queries but no reliable asynchronous per-particle-pass query without adding query overhead.

## Validation status

The automated regression creates 292 compatible ambient emitters and verifies that they produce one `GPUParticleSystem`, one logical batch, and retain an emitter count of 292. The production build and complete unit suite pass.

The app was not launched, in accordance with the benchmark constraint. The supplied baseline is recorded above; camera-matched triforts measurements for the batched build remain to be collected by the benchmark owner. Expected particle submissions for 292 identical compatible emitters are two per rendered camera (one simulation and one render), rather than 584.

## Remaining limits

- Emitters with different render/simulation recipes form separate batches. Highly heterogeneous maps can therefore exceed the two-draw best case.
- Dynamic bursts are pooled, not merged into static map buffers.
- The active-particle value is Babylon's active GPU slot count; it is an estimate, not a readback of live particles.
- Native WebGL1 and hardware without transform feedback use the CPU fallback.
