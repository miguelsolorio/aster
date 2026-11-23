# Performance harness

Measures frame times in system Chrome (headed, Metal) with iPhone 13 emulation and a CPU throttle, against the dev server.

```
node tools/perf/run.mjs [--throttle 8] [--seconds 20] [--scenarios still,run,board,city,stepped,cavern,night]
                        [--trace] [--out tools/perf/out] [--url http://localhost:5173]
```

- Playwright is not a dependency. It is resolved from `PLAYWRIGHT_PATH` (a `node_modules` directory), else normal resolution, else `/Users/solorio/dev/souvie/node_modules`.
- Without `--url` it starts its own vite on a free port and stops it on exit.
- Each scenario loads a fresh page with `?perf`, presses Start, settles about 7 s unmeasured, then measures `--seconds`.
- Output: a table on stdout, `<out>/<scenario>.json` (frame times, samples), `<out>/summary.json` (all rows, git SHA, date) and a final screenshot. `--trace` adds `<scenario>.trace.json` and prints the top self-time functions inside frames over 33 ms.
- `baseline.json` is the committed summary to compare later phases against (same `--throttle`, same machine).

Scenarios: `still` (`?day=0.45`), `run` (hold W), `board` (`?tools=board`, riding, hold W), `city` (`?miner`), `stepped` (`?settle=stepped-city`), `cavern` (`?cavern`, 1 km short of an open cavern, hold W), `night` (`?day=0.95&tools=chart`, hold W), `cityApproach` (`?approach=1700&day=0.45`: 1.7 km out from the nearest city's edge facing it, hold W; its full detail appears about 15 s into the window).
`?cavern` and `?approach=<metres from the edge>` are dev-only, like `?deep`. Keyboard drives the player fine under touch emulation; only the board toggle needs the on-screen button.

## ?perf overlay

Add `?perf` to the game URL (also on a real phone) for a corner box: fps, median and worst frame ms over 5 s, frames over 50/100 ms and long tasks since load, draw calls, triangles and programs, quality tier and render scale, JS heap. The same numbers are on `window.__perf` (with `frames`, a ring of the last 600 frame times, and `count`). Without `?perf` nothing is created.

Noise: runs vary a few percent; the table counts only the measured window, the overlay counts since load.

## Screenshot diffs (`shots.mjs`)

For rendering changes that must not change the picture. Captures a fixed set of views at the mobile tier (iPhone 13 emulation) and the high tier (1280x720), then compares two captures.

```
node tools/perf/shots.mjs [--out tools/perf/out/shots/base] [--tiers mobile,high] [--views desert-noon,mountain,...] [--url http://...]
node tools/perf/shots.mjs --diff <dirA> <dirB> [--out <dirB>/diff]
```

- Deterministic: `Math.random` is seeded (three's `generateUUID` gets a stream of its own, and the seed is reset before each `__ds.sim`), the game is frozen (`__ds.freeze`) before its first frame so its clock never runs on real time, `performance.now` stands still inside `__ds.sim` so per-frame work budgets cannot run out there, automatic quality is off, and the camera is settled with a fixed number of 60 Hz steps. Two captures of the same build are identical in most views; what still varies is a few dust motes and, at night, the fireflies (`wildlife`): up to ~150 in 0.01-0.04% of the pixels of the night views, a few pixels elsewhere. Capture the baseline twice to see the noise floor.
- `--eval "<js>"` (debugging) runs a script in the page right after Start, e.g. to switch something off before the camera settles.
- Views: `desert-noon`, `dunes-golden` (`?day=0.72`), `mountain`, `city` (`?miner`), `city-far` (`?approach=200`), `night`, `night-moon` (facing the moon), `salt`, `down` (steep, near ground), `look-lowpoly`, `look-map`, `look-ink` (in-game looks via `__ds.look`) and `gallery` (gallery.html, its own renderer: a control).
- Each capture writes `<tier>-<view>.png` and `stats.json`: draw calls, triangles, terrain vertices shaded (`__ds.clipmap.stats`) and the median GPU time per frame of everything rendered into a target (the scene pass and any bakes), from `EXT_disjoint_timer_query_webgl2` when Chrome exposes it.
- `--diff` prints per image the largest channel delta (0..255), the mean, and the share of pixels over 2, 8 and 24, writes a heat map per image (the image in grey, the difference in red, x8) and `report.json`, and lists the stats of both captures side by side.
