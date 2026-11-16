# Aster

Take the long way.

A calm desert to wander, glide and fly through. It runs in the browser, there's nothing to install, and nobody tells you where to go.

**[Play it](https://miguelsolorio.com/projects/aster/)**

![A lone wanderer on a rippled dune at golden hour, the sun setting behind a snow-capped mountain. Aster: take the long way](public/og.jpg)

## What's out there

You start on foot in open sand with a city somewhere in sight. The rest is yours to find: dune seas, salt pans, river gorges, walled towns, caravans on the road between them, and a snow-capped mountain on most horizons. Out on the sand there are empty hamlets round their wells and lone watchtowers with a fire lit at night. Most mountains have a village or two at their foot, with garden terraces, a tower and goats grazing outside. People live in them: stop and talk. People live out on the open ground too, wherever it suits them: black tents round a well, an observatory on a hilltop, salt pools on a pan, glass kilns that glow from dusk, houses stacked under a rock face, a village along a bridge, a caravanserai half way down a route, a dyers' town with cloth on every roof, a town of wind towers and, rarely, a city built up in five tiers to a gold dome. Each has one person worth stopping for, who puts something you haven't found on your map. The watcher under the tower, in blue, and the old climber by the fire, in green, each know where something useful was left. One of those mountains has a road to it: follow the torches out of the desert, through a stone gate where the sand turns to snow, and up the flank to three villages and a lantern hold at the top. The sun rises and sets while you walk, so the same ridge looks different every time you come back to it.

You carry a map, and it starts empty. Ground is washed in as you see it, towns and finds are inked in once you reach them, and it's all kept between visits. When someone sends you after something, a dashed circle goes on the map over roughly where to look.

| | |
|---|---|
| ![First light on a mountain above rippled sand](docs/screenshots/02-first-light.jpg) | ![Dusk over dark ripples with two peaks behind](docs/screenshots/04-after-sunset.jpg) |
| ![The wanderer between two dunes at golden hour](docs/screenshots/12-between-dunes.jpg) | ![A huge snow-capped mountain under a teal morning sky](docs/screenshots/17-the-giant.jpg) |
| ![Flying a carpet toward a mountain at golden hour](docs/screenshots/13-carpet.jpg) | ![Riding a board across open sand in late afternoon](docs/screenshots/14-board.jpg) |
| ![Moonlit ripples with a mountain behind](docs/screenshots/19-night-ripples.jpg) | ![A mountain at night with lanterns lit on its summit](docs/screenshots/20-lanterns.jpg) |

There are 20 of these in [docs/screenshots](docs/screenshots).

## Controls

| Key | What it does |
|---|---|
| `W` `A` `S` `D` | Walk |
| Mouse | Look |
| `Shift` | Run, or boost in the air |
| `Space` | Leap. Hold to rise, let go to glide, double-tap to drop |
| `Q` | Step on or off the board, once you have one (or get off an animal) |
| `E` | Talk, or climb onto a wild ass, an oryx (walk up to one, don't run) or a caravan's camel, and get off again. The key shows over whichever is nearest |
| `F` | Hold up the spyglass, once you have one |
| `R` | Play the flute, once you have one |
| `B` | Lay the bedroll and sleep in it, once you have one |
| `M` | Open the map. `W` `A` `S` `D` move it, the wheel zooms |
| `Esc` | Menu and photo mode |

It plays on a phone too, with touch controls.

## Run it locally

You need Node.

```bash
npm install
```

```bash
npm run dev
```

`npm run build` type-checks and builds the site into `dist`. Pushing to `main` deploys it to GitHub Pages.

## Dev pages

The dev server has a few extra pages that aren't part of the build:

- `/gallery.html` shows every look the game can render in
- `/characters.html` and `/equipment.html` show the figures, boards, carpets and picks
- `/social.html` runs the game in a 1200 × 630 frame for capturing screenshots like the ones above

A few URL options help when testing. `?tools=board,carpet,pick,spyglass,flute,bedroll,rod,chart,rope,boots,feather` lends you the tools for one visit, `?day=0.72` starts at a set time of day (0 is midnight, 0.5 is noon), `?miner` drops you in front of a city's miner (`?miner=2` for the second-nearest city to the default start), and on the dev server `?village` starts you in the nearest mountain village (`?village=snow` for the nearest snow village), and `?settle=<kind>` (`well-camp`, `star-house`, `salt-works`, `glass-kilns`, `ledge`, `bridge`, `caravanserai`, `dyers-town`, `wind-towers` or `stepped-city`) puts you 45 m from the nearest such settlement.

## Built with

[three.js](https://threejs.org), TypeScript and Vite. The terrain, sky and water are custom shaders, and the world is generated from a seed, so there are no texture or model files to download.
