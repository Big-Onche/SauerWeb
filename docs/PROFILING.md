# Chrome DevTools profiling

SauerWeb's profiling instrumentation is disabled by default. Add `profile=1` to the page URL to enable it while preserving any existing parameters, for
example `https://www.sauerweb.org/?map=complex&profile=1`.

## Record a profile

1. Open Chrome DevTools and select **Performance**.
2. Open **Capture settings** and enable **Show custom tracks**.
3. Start recording, then move, shoot, render bots, or load a map.
4. Stop recording and expand the **SauerWeb**, **SauerWeb Renderer**, and **SauerWeb Diagnostics** track groups.

The main thread flame graph shows the underlying JavaScript call stacks. The custom tracks identify frame, game, physics, networking, rendering, and
Babylon.js phases. **GPU frame time (asynchronous)** is a sampled diagnostic and only appears when the browser and graphics backend support timer queries;
it is not scene-render CPU time. Batched raycast and bot subphase values are diagnostic totals and can be nested within their parent CPU zones.

Use the Performance panel's **Save profile** button to export the trace as a JSON file for later loading or sharing.

## Production source maps

Production builds do not publish source maps by default. For a controlled profiling build, set `SAUERWEB_SOURCEMAP=1` before running `npm run build` and
deploy the generated maps only where authorized. Development builds already map execution to TypeScript through Vite.
