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
