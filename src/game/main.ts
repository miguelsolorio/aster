import * as THREE from 'three';
import { frostCover, frostRegion, frostUniform } from '../world/frost';
import type { FrameState, Uniforms } from './contract';
import { DayCycle } from './daycycle';
import { Player, type PlayerInput } from './player';
import { TERRAIN, cavernUniforms, createWorld } from '../world/surface';
import { HeightBake } from '../world/heightBake';
import { Clipmap } from '../world/clipmap';
import { TrailField } from '../world/trailField';
import { Dust } from '../world/dust';
import { Splash } from '../world/splash';
import { Discoveries } from '../world/discoveries';
import { isSettlement } from '../world/settlementKinds';
import { Wildlife } from '../world/wildlife';
import { Fauna } from '../world/fauna';
import { Props } from '../world/props';
import { blockedAt } from '../world/avoid';
import { Cities } from '../city/cities';
import { cityShadowQ } from '../city/cityGlsl';
import { FootpathNet } from '../city/footpaths';
import { Caravans, ROLE_CLIMBER, ROLE_HERDER, ROLE_HOST, ROLE_KEEPER, ROLE_PILGRIM, ROLE_VILLAGER, ROLE_WATCHER } from '../city/caravans';
import { Waymarks } from '../city/waymarks';
import { People } from '../city/people';
import { Figure } from './figure';
import { HEADROOM } from '../city/rooms';
import { CollisionOverlay } from './collisionDebug';
import { AudioEngine } from '../audio/audio';
import { UI } from '../ui/ui';
import { TouchControls, type TouchMode } from './touch';
import { installTouchGuards } from './guards';
import { AutoQuality, QUALITY, applyQuality, defaultTier } from './quality';
import { Task, budgetFor, frameBudget } from '../world/budget';
import { createPerfHud } from './perfHud';
import { postFrag, postVert } from '../render/shaders';
import { gameSkyFrag, gameSkyVert } from '../render/gameSky';
import { DEFAULTS, type Params } from '../render/types';
import { LOOKS, stylesUnlocked, type Look } from './looks';
import { WORLD_SCALE } from '../world/scale';
import { Massifs } from '../world/massifs';
import { Save, loadSpawn, saveSpawn, clearSpawn, clearProgress } from './save';
import { findName, isFindKind } from './finds';
import { Talk, type Speaker } from './talk';
import { CLIMBER, FOUND, HERDER, KEEPER, MINER, PILGRIM, SAND, SETTLED, SNOWFOLK, TOWNSFOLK, TRAVELLER, VILLAGER, WATCHER, WEAVER, type Line } from './lines';
import { CavernHints } from './hints';
import { offeringAt } from './offerings';
import { CAMP_OFF, DONE, KEEPER_OF_FLAME, NEEDS, SETTLER, TAKEN, WANTS, stageOf, type Carry } from './restore';
import { Marks } from './marks';
import { Atlas, areaAround } from './atlas';
import { MapView, groundInk, type MapHint, type MapState } from './mapView';
import { SpyglassView } from './spyglass';
import { Compass, nearest, type Thing } from './compass';
import { SleepView } from './sleep';
import { SongRing } from './songRing';
import { LEARNED, NOTHING, RAIN_ARRIVES, RAIN_REST, SONGS, TEACH_R, WAKE_R, WIND_SECONDS, suited, taughtBy, type Song, type Standing } from './songs';
import { DAY_SECONDS, HOUR_SECONDS, Weather, massifGuard } from '../world/weather';
import { stormUniforms, updateStorm } from '../render/storm';
import { Heavens, heavensUniforms } from '../render/heavens';
import { Lanterns, type LanternSource } from '../render/lanterns';
import { almanacLines, festival, flood, market, migration, migrationBearing, monthDay, monthOf } from '../world/calendar';
import { CONSTELLATIONS, NAIL, bloodMoon, comet, dayOf, eclipse, moonPhase, nextLesson, nightOf, shower } from '../world/sky';
import { CITY_CELL } from '../city/placement';
import { bedGeometry, hearthGeometry, solidMaterial } from './equipment';
import { lateProgramWatch, warmMaterial, warmObjects, warmUp } from '../render/warm';
import { Uploader } from '../render/upload';

/** Where a wreck lies, and the way her keel runs (a site's yaw). */
type Wreck = { x: number; z: number; rot: number };

const WORLD_SEED = 20261111; // the same desert for everyone, every time
const SPAWN_RANGE = 20000; // metres from the origin

const cap = (k: string) => 'u' + k[0].toUpperCase() + k.slice(1);
const canvasHost = document.getElementById('game') as HTMLElement;
const uiHost = document.getElementById('ui') as HTMLElement;

function start() {
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  // Checking each program's link log makes the link finish there and then (a long stall on a
  // phone); a shader that fails to build still shows as an error in development.
  renderer.debug.checkShaderErrors = import.meta.env.DEV;
  const canvas = renderer.domElement;
  canvasHost.appendChild(canvas);

  // ---- shared uniforms
  const u: Uniforms = {
    uTime: { value: 0 },
    uSeed: { value: WORLD_SEED },
    uWind: { value: new THREE.Vector2(1, 0) },
    uFigPos: { value: new THREE.Vector3() },
  };
  stormUniforms(u);
  for (const n of ['uInk', 'uPaperCol', 'uA', 'uB', 'uLine']) u[n] = { value: new THREE.Vector3() };
  // One float uniform per style setting. Glow and fog are not here: the day cycle owns them.
  for (const k of Object.keys(DEFAULTS) as Array<keyof Params>) {
    if (k !== 'glow' && k !== 'fog') u[cap(k)] = { value: DEFAULTS[k] };
  }

  // The star chart's line in the night sky: how bright, and the way it points over the ground.
  u.uChart = { value: 0 };
  heavensUniforms(u);
  u.uFlood = { value: 0 };
  u.uChartDir = { value: new THREE.Vector2(1, 0) };

  const qs = new URLSearchParams(location.search);
  const day = new DayCycle(u, qs.has('day') ? Number(qs.get('day')) : Math.random());
  // The look: 35 mm. Behind the hidden style picker (see stylesUnlocked) it can be any
  // gallery style; ?style=<id> then chooses one for this visit.
  const unlocked = stylesUnlocked(qs);
  let look: Look = LOOKS[0];
  const applyLook = (l: Look) => {
    look = l;
    for (const k of Object.keys(DEFAULTS) as Array<keyof Params>) {
      if (k !== 'glow' && k !== 'fog') u[cap(k)].value = l.params[k];
    }
    (u.uInk.value as THREE.Vector3).copy(l.ink);
    (u.uPaperCol.value as THREE.Vector3).copy(l.paper);
    day.setLook(l.day);
    onLook?.(l);
  };
  let onLook: ((l: Look) => void) | null = null;
  applyLook(LOOKS[0]);
  const world = createWorld(WORLD_SEED);
  const player = new Player(world);
  // What the wanderer has been given so far. It starts with nothing: on foot.
  const save = new Save(qs);
  // The map: the ground seen so far and the places come upon, kept between visits.
  const atlas = Atlas.load();
  // A board, once given, is ridden until you step off it (Q); stepping off puts it on your back.
  let boardOn = true;
  player.board = save.has('board');
  player.carpet = save.has('carpet');

  let seekMiner = false;
  let resetting = false; // set by "start again" so the page-leave save cannot bring the spawn back
  // ---- spawn at the same place every visit, on open sand
  // The default arrival is the same for everyone: found from the origin with a fixed-seed generator.
  // Only the menu's respawn button passes Math.random and goes somewhere new.
  const seededRandom = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const arrival = (rand: () => number = seededRandom(WORLD_SEED), anchored = true): { x: number; z: number; city: { cx: number; cz: number } | null } => {
    const s = { h: 0, rock: 0, salt: 0 };
    const n = new THREE.Vector3();
    let x = 0;
    let z = 0;
    // Somewhere in the open desert, with a city in sight. Most cities are seen from 1.5 to 3.4 km
    // off; an oasis hides in a basin behind its ring of dunes, so it is seen from on or just inside
    // that ring, looking down at it. If the nearest city gives no clear view, the next ones are
    // tried, and only then is any open sand accepted.
    let spawnCity: { cx: number; cz: number } | null = null;
    const ax = anchored ? 0 : (rand() * 2 - 1) * SPAWN_RANGE;
    const az = anchored ? 0 : (rand() * 2 - 1) * SPAWN_RANGE;
    const cands = world.cities.near(ax, az).slice(0, 3);
    let fallback: { x: number; z: number; city: (typeof cands)[number] } | null = null;
    search: for (const city of cands) {
      const oasis = city.kind === 'oasis';
      for (let i = 0; i < 40; i++) {
        const a = rand() * Math.PI * 2;
        const d = oasis ? city.radius + 250 + rand() * 400 : city.radius + (2000 + rand() * 2500) * WORLD_SCALE;
        x = city.cx + Math.cos(a) * d;
        z = city.cz + Math.sin(a) * d;
        world.sample(x, z, s);
        world.normal(x, z, n);
        if (s.rock >= 0.1 || n.y <= (oasis ? 0.93 : 0.95)) continue;
        if (!fallback) fallback = { x, z, city };
        // Dunes hide a city easily, so insist on a clear line of sight to its rooftops.
        let clear = true;
        const eye = s.h + 3;
        // (into an oasis basin, see down to the lower roofs, not just the towers)
        const roofs = city.groundY + (oasis ? 6 : 14);
        for (let t = 0.02; t < 0.98 && clear; t += 0.02) {
          if (world.height(x + (city.cx - x) * t, z + (city.cz - z) * t) > eye + (roofs - eye) * t) clear = false;
        }
        if (clear) {
          spawnCity = city;
          break search;
        }
      }
    }
    if (!spawnCity && fallback) {
      x = fallback.x;
      z = fallback.z;
      spawnCity = fallback.city;
    }
    return { x, z, city: spawnCity };
  };
  {
    // Where to arrive: ?x=&z=, then ?miner, then the spawn saved from the menu, then the shared default.
    const pinned = qs.has('x') && qs.has('z');
    const saved = !pinned && !qs.has('miner') ? loadSpawn() : null;
    const r = saved ? null : arrival();
    let x = saved ? saved.x : r!.x;
    let z = saved ? saved.z : r!.z;
    let spawnCity = r ? r.city : null;
    // ?x=..&z=.. pins the spawn point (handy for sharing a place).
    if (pinned) {
      x = Number(qs.get('x'));
      z = Number(qs.get('z'));
    }
    // ?miner drops you at a city (?miner=2 for the second nearest) and, once it has loaded, in front of its miner.
    if (qs.has('miner')) {
      const c = world.cities.near(x, z)[Math.max(0, (Number(qs.get('miner')) || 1) - 1)];
      if (c) {
        x = c.cx;
        z = c.cz;
        spawnCity = c;
        seekMiner = true;
      }
    }
    player.place(x, z);
    // Face the city, so the first thing you see is somewhere to go (or the way a saved spawn faced).
    player.facing = saved ? saved.facing : spawnCity ? Math.atan2(spawnCity.cx - x, spawnCity.cz - z) : 0;
  }

  // ---- scene
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 14000);
  const cities = new Cities(world, u); // first: it creates the uniforms that tell the terrain where to flatten
  cities.setFocus(player.state.pos.x, player.state.pos.z);
  cavernUniforms(u); // likewise for the caverns, which the discoveries fill in
  FootpathNet.uniforms(u); // and for the footpaths out to the finds
  const frost = frostRegion(world);
  u.uFrost = { value: frostUniform(frost) }; // and where the snow lies on the open ground
  // The weather: sandstorms, each where the seed and the world clock put it. No storm climbs a
  // mountain: it parts round the foot of each (guard.shelter here, the same circles in the wall drawn).
  const guard = massifGuard((gi, gj) => world.massif(gi, gj), CITY_CELL, frost);
  const weather = new Weather(WORLD_SEED, guard.shelter);
  // (a storm sent for the wanderer on an earlier visit is still on its way)
  if (save.data.sent && save.data.sent.t1 > save.data.days) weather.sent = save.data.sent;
  // (and a rain that fell on an earlier visit has left the ground wet for a day after it ended)
  if (save.data.sentRain && save.data.sentRain.t1 + 1 > save.data.days) weather.sentRain = save.data.sentRain;
  // ?storm starts with one a minute off, ?storm=in in the thick of one; neither is kept
  let stormAsk: 'near' | 'in' | null = qs.has('storm') ? (qs.get('storm') === 'in' ? 'in' : 'near') : null;
  let stormCheck = 0;
  // ?rain: one a minute off; ?rain=in: in the thick of one; ?rain=after: it has just gone by
  const rainParam = qs.get('rain');
  let rainAsk: 'near' | 'in' | 'after' | null = qs.has('rain') ? (rainParam === 'in' ? 'in' : rainParam === 'after' ? 'after' : 'near') : null;
  const bake = new HeightBake(renderer, u);
  const trail = new TrailField(renderer, u);
  u.uCityShadowQ = cityShadowQ; // the one holder every city shader and the terrain share
  const clipmap = new Clipmap(u);
  const dust = new Dust(world, u);
  const discoveries = new Discoveries(world, u);
  // A deep's shaders are compiled (in parallel where the GPU allows it) and its textures uploaded
  // as soon as it is made, not on the frame it is first drawn.
  discoveries.onDeep = (obj) => {
    obj.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
      if (m?.uniforms) for (const k in m.uniforms) if ((m.uniforms[k].value as THREE.Texture | null)?.isTexture) renderer.initTexture(m.uniforms[k].value);
    });
    return renderer.compileAsync(obj, camera, scene);
  };
  // Caverns opened on an earlier visit are open still, and their relics stay taken.
  discoveries.restore(save.data.opened, save.data.taken, save.data.woken);
  discoveries.onOpened = (key) => save.open(key);
  // Each waking stone lengthens the climb, with less to gain from every one after the first.
  const setLift = () => (player.lift = 1 + 1.5 * (1 - Math.pow(0.9, discoveries.wokenCount)));
  setLift();
  // (testing) ?village starts you in the street of the nearest mountain village, and ?village=snow
  // on the road through the nearest snow village. With ?x=&z= it is the nearest to that point.
  if (import.meta.env.DEV && qs.has('village')) {
    const want = qs.get('village') === 'snow' ? 'snow-village' : 'mountain-village';
    const p = player.state.pos;
    const near = discoveries
      .sitesNear(p.x, p.z, 12000, [])
      .filter((s) => s.kind === want)
      .sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
    if (near) {
      player.place(near.x, near.z);
      cities.setFocus(near.x, near.z);
    }
  }
  // (testing) ?settle=<kind> starts you 45 m from the nearest settlement of that kind, so it is in view.
  if (import.meta.env.DEV && isSettlement(qs.get('settle'))) {
    const want = qs.get('settle');
    const p = player.state.pos;
    const near = discoveries
      .sitesNear(p.x, p.z, 30000, [])
      .filter((s) => s.kind === want)
      .sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
    if (near) {
      player.place(near.x + 45, near.z);
      cities.setFocus(near.x + 45, near.z);
    }
  }
  discoveries.onGround = () => bake.invalidate();
  // The faint footpaths from the towns and their routes out to the finds, laid to finds not built yet too.
  const footpaths = new FootpathNet(world, cities.routes, (x, z, r, out) => discoveries.surfaceSitesNear(x, z, r, out));
  footpaths.focus(u, player.state.pos.x, player.state.pos.z);
  // (testing) ?deep=<0-4> opens the nearest cavern over a deep of that kind, for this visit
  // only, and starts you in its antechamber a few steps short of the hole, facing it. With
  // ?x=&z= it is the nearest to that point.
  if (import.meta.env.DEV && qs.has('deep')) {
    const at = discoveries.devDeep(player.state.pos.x, player.state.pos.z, Number(qs.get('deep')) || 0);
    if (at) {
      player.place(at.x, at.z);
      player.facing = at.facing;
      cities.setFocus(at.x, at.z);
    }
  }
  // (testing) ?cavern opens the nearest cavern, as ?deep= does, but starts you 1 km short of it facing it,
  // so walking forward brings its roof into being. With ?x=&z= it is the nearest to that point.
  if (import.meta.env.DEV && qs.has('cavern')) {
    const at = discoveries.devDeep(player.state.pos.x, player.state.pos.z, 0);
    if (at) {
      const x = at.x - Math.sin(at.facing) * 1000;
      const z = at.z - Math.cos(at.facing) * 1000;
      player.place(x, z);
      player.facing = Math.atan2(at.x - x, at.z - z);
      cities.setFocus(x, z);
    }
  }
  // (testing) ?approach=<m> starts you that many metres out from the edge of the nearest city, facing
  // its centre, so walking forward brings it in (from 1700 its full detail appears in about 20 s).
  if (import.meta.env.DEV && qs.has('approach')) {
    const p = player.state.pos;
    const c = world.cities.near(p.x, p.z)[0];
    if (c) {
      const out = Number(qs.get('approach')) || 1700;
      const a = Math.atan2(p.z - c.cz, p.x - c.cx);
      const x = c.cx + Math.cos(a) * (c.radius + out);
      const z = c.cz + Math.sin(a) * (c.radius + out);
      player.place(x, z);
      player.facing = Math.atan2(c.cx - x, c.cz - z);
      cities.setFocus(x, z);
    }
  }
  const splash = new Splash(u);
  const wildlife = new Wildlife(world, u);
  const caravans = new Caravans(world, world.cities, cities.routes, u);
  caravans.landmarks = (out) => discoveries.landmarks(out);
  caravans.villages = (out) => discoveries.villages(out);
  caravans.pens = (out) => cities.pens(out); // the beasts in the pens outside each city
  const fauna = new Fauna(world, u);
  fauna.landmarks = (out) => discoveries.landmarks(out);
  fauna.herders = (out) => caravans.herders(out); // each shepherd's goats keep round them
  fauna.snow = (x, z) => (frost ? frostCover(frost, x, z) : 0); // where the frostland's animals wear white
  fauna.blocked = (x, z) => {
    const c = cities.nearest(x, z);
    return Math.hypot(c.cx - x, c.cz - z) < c.radius + 300 || discoveries.nearSolids(x, z, 12);
  };
  const waymarks = new Waymarks(world, world.cities, cities.routes, u);
  const people = new People(u);
  const massifs = new Massifs(world, u);
  // Rocks and cacti out in the open, kept off the finds and their caverns, and off where you start.
  const props = new Props(world, u);
  // (and out of the snow, where no cactus grows: the frostland plants its own pines)
  props.blocked = (x, z, r) => discoveries.claimed(x, z, r) || (frost !== null && frostCover(frost, x, z) > 0.25);
  props.keepClear(player.state.pos.x, player.state.pos.z, 25);
  scene.add(clipmap.group, cities.group, people.group, caravans.group, waymarks.group, discoveries.group, props.group, wildlife.group, fauna.group, dust.group, splash.group, massifs.group);

  const figure = new Figure(u);
  figure.board = player.board;
  figure.carpet = player.carpet;
  figure.pick = save.has('pick');
  figure.lamp = save.data.items.lamp;
  figure.relic = save.data.items.relic;
  scene.add(figure.group);
  /** Show on the figure whatever tools it has. */
  const wear = () => {
    figure.spyglass = save.has('spyglass');
    figure.flute = save.has('flute');
    figure.bedroll = save.has('bedroll');
    figure.rod = save.has('rod');
    figure.chart = save.has('chart');
    figure.rope = save.has('rope');
    player.rope = figure.rope;
    player.boots = figure.boots = save.has('boots');
    player.feather = figure.feather = save.has('feather');
  };
  wear();
  // The places marked through the spyglass: a thread of light over each, until it is reached.
  const marks = new Marks(u);
  scene.add(marks.group);
  const syncMarks = () => marks.set(save.data.sightedAt, (x, z) => world.height(x, z));
  syncMarks();
  const glassView = new SpyglassView(canvasHost); // under the touch buttons and the interface, over the scene
  // The bedroll, where it has been laid: the bed and a small hearth beside it.
  const campGroup = new THREE.Group();
  {
    const solid = solidMaterial(u);
    campGroup.add(new THREE.Mesh(bedGeometry(), solid));
    const hearth = new THREE.Mesh(hearthGeometry(), solid);
    hearth.position.set(1.25, 0, 0.2);
    campGroup.add(hearth);
    for (const m of campGroup.children) m.frustumCulled = false;
  }
  scene.add(campGroup);
  const placeCamp = () => {
    const c = save.data.camp;
    campGroup.visible = !!c;
    caravans.hearth = null;
    if (!c) return;
    campGroup.position.set(c.x, world.height(c.x, c.z), c.z);
    campGroup.rotation.set(0, c.facing, 0);
    // (the hearth sits to the bed's right: the flames stand in its ring of stones)
    const hx = c.x + Math.cos(c.facing) * 1.25 + Math.sin(c.facing) * 0.2;
    const hz = c.z - Math.sin(c.facing) * 1.25 + Math.cos(c.facing) * 0.2;
    caravans.hearth = { x: hx, y: world.height(hx, hz) + 0.05, z: hz };
    props.keepClear(c.x, c.z, 5);
  };
  placeCamp();
  const sleep = new SleepView(uiHost, (to) => {
    // the hours pass in the dark: it is first light, or the last of it
    const was = day.day;
    day.day = to === 'dawn' ? 0.268 : 0.722;
    // (and the world's clock with them, so a storm that was overhead has gone on its way)
    frame.clock += (day.day - was + 1) % 1;
    save.setDays(frame.clock);
    day.update(0);
    stillDrawn = false;
  });

  // ---- a fire and its travellers, a short walk from where you begin, toward the city you face.
  // They are the first people you can reach, and the first thing worth walking to.
  {
    const p = player.state.pos;
    const eye = p.y + 1.6;
    // The first level spot in plain sight wins. Failing that, the gentlest ground on offer:
    // there is always a fire, even among steep dunes.
    let best: { x: number; z: number } | null = null;
    let bestScore = Infinity;
    search: for (const d of [45, 60, 35, 75, 90, 110, 130]) {
      for (const off of [0, 0.3, -0.3, 0.6, -0.6, 1, -1, 1.5, -1.5, 2.2, -2.2, Math.PI]) {
        const a = player.facing + off;
        const x = p.x + Math.sin(a) * d;
        const z = p.z + Math.cos(a) * d;
        const rough = caravans.campRough(x, z);
        if (rough === Infinity) continue;
        // in plain sight: no dune between you and the fire
        let clear = true;
        const h = world.height(x, z) + 1;
        for (let t = 0.1; t < 0.95 && clear; t += 0.1) {
          if (world.height(p.x + (x - p.x) * t, p.z + (z - p.z) * t) > eye + (h - eye) * t) clear = false;
        }
        if (clear && rough < 1.6) {
          best = { x, z };
          break search;
        }
        const score = rough + (clear ? 0 : 3) + d * 0.01;
        if (score < bestScore) {
          bestScore = score;
          best = { x, z };
        }
      }
    }
    if (best) {
      caravans.addCamp(best.x, best.z, WORLD_SEED ^ Math.round(best.x * 31 + best.z * 17));
      props.keepClear(best.x, best.z, 22);
    }
  }

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(1, 48, 24),
    new THREE.ShaderMaterial({ uniforms: u, vertexShader: gameSkyVert, fragmentShader: gameSkyFrag, side: THREE.BackSide, depthWrite: false }),
  );
  sky.scale.setScalar(9000);
  // Last of the opaque things, on the far plane with the depth test (LessEqual), so only the
  // pixels nothing else covers are shaded; the transparent pass still comes after it.
  sky.renderOrder = 1e6;
  sky.frustumCulled = false;
  scene.add(sky);
  // The fixed stars, the moon's phase, meteors, the comet and the eclipse (see render/heavens.ts).
  const heavens = new Heavens(u);
  scene.add(heavens.group);
  // (testing) ?sky=shower|comet|eclipse|blood|new|full moves the sky's calendar on, for this visit
  // only, to the next night or day there is one; ?stars=all lends every constellation.
  let skyShift = 0;
  const lentStars = qs.get('stars') === 'all' ? ['nail', ...CONSTELLATIONS.map((c) => c.id)] : [];
  const knownStars = () => (lentStars.length ? lentStars : save.data.stars);
  /** The clock the sky runs on. */
  const skyClock = () => frame.clock + skyShift;
  let fallWatch = 0;
  // The lantern festival's lanterns, and the lived-in places near enough to send them up.
  const lanterns = new Lanterns(u);
  scene.add(lanterns.group);
  const lanternFrom: LanternSource[] = [];
  const lanternSites: import('../world/discoveries').SiteRef[] = [];
  let lanternScan = 0;
  let skyAsk: string | null = qs.get('sky');
  /** What the keeper of a star house has to teach tonight, if anything: the Nail first, then one constellation a night. */
  const skyLesson = (): { lines: string[]; done?: () => void } | null => {
    if (lentStars.length) return null;
    const night = nightOf(skyClock(), day.day);
    const known = save.data.stars;
    const learn = (id: string) => () => {
      save.learnStar(id, night);
      audio.chime('learned');
    };
    if (!known.includes('nail')) return { lines: ['Look north. Higher.', NAIL.lesson], done: learn('nail') };
    const next = nextLesson(known);
    if (!next) return null;
    if (save.data.lessonNight === night) return { lines: ['One a night. Any more and you would mix them up.'] };
    return { lines: ['Look up. Follow my hand.', next.lesson, 'Put a glass on it some night and it will come to you.'], done: learn(next.id) };
  };

  // ---- post
  const postU: Uniforms = { ...u, tColor: { value: null }, tDepth: { value: null }, uRes: { value: new THREE.Vector2(1, 1) } };
  const postScene = new THREE.Scene();
  const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({ uniforms: postU, vertexShader: postVert, fragmentShader: postFrag, depthTest: false, depthWrite: false }),
  );
  quad.frustumCulled = false;
  postScene.add(quad);

  let rt: THREE.WebGLRenderTarget | null = null;
  let rtDepth: THREE.WebGLRenderTarget | null = null;
  let sizeKey = ''; // pixel size and samples of the current targets (resize skips when unchanged)
  let resizeTimer = 0;
  const rtSize = new THREE.Vector2(2, 2);
  /** True when the post shader reads the depth buffer this frame: a storm in reach or a rainbow (storm.ts), or the depth-edge outline (shaders.ts). */
  const postNeedsDepth = () =>
    (u.uStormN.value as number) > 0.5 || (u.uRainbow.value as number) > 0.001 || (u.uOutline.value as number) > 0.001 || Math.abs((u.uMode.value as number) - 3) < 0.5;
  let stillDrawn = false; // the paused frame has been drawn; nothing more to render until something changes
  // Quality: a tier (mobile / low / high) plus a render scale the game lowers by itself if frames run slow.
  const auto = new AutoQuality(defaultTier(), (tier) => {
    perf?.note(`quality -> ${tier} x${auto.renderScale} pace ${auto.pace}`);
    ui.setQuality(tier);
    applyTier();
  });
  const perf = createPerfHud(renderer, auto);
  function applyTier() {
    applyQuality(QUALITY[auto.tier], { uniforms: u, clipmap, bake, dust, trail });
    people.setDensity(auto.tier === 'mobile' ? 0.35 : auto.tier === 'low' ? 0.7 : 1);
    caravans.setDensity(auto.tier === 'mobile' ? 0.35 : auto.tier === 'low' ? 0.7 : 1);
    fauna.setDensity(auto.tier === 'mobile' ? 0.35 : auto.tier === 'low' ? 0.7 : 1);
    cities.setDensity(auto.tier === 'mobile' ? 0.35 : auto.tier === 'low' ? 0.7 : 1);
    splash.setDensity(auto.tier === 'mobile' ? 0.5 : auto.tier === 'low' ? 0.75 : 1);
    discoveries.tier = auto.tier === 'mobile' ? 2 : auto.tier === 'low' ? 1 : 0;
    props.setTier(auto.tier);
    resize();
  }
  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const q = QUALITY[auto.tier];
    let ratio = Math.min(window.devicePixelRatio || 1, q.maxRatio);
    ratio = Math.min(ratio, Math.sqrt(q.pixelBudget / (w * h))) * auto.renderScale;
    const pw = Math.max(2, Math.round(w * ratio));
    const ph = Math.max(2, Math.round(h * ratio));
    // iOS Safari fires resize as its toolbar shows and hides: nothing to do when the pixels are the same.
    const key = `${pw}x${ph}x${q.samples}`;
    if (key === sizeKey && rt) return;
    sizeKey = key;
    renderer.setSize(pw, ph, false);
    rt?.dispose();
    rtDepth?.depthTexture?.dispose();
    rtDepth?.dispose();
    rtDepth = null;
    // The scene is drawn into a target whose depth is only a renderbuffer (a tiler need not write it
    // out). A second target with a depth texture is made the first time the post pass reads depth
    // (a storm in reach, the outline, a rainbow), and kept until the next resize, so there is no
    // per-frame reallocation and nothing is created for a game that never needs it.
    rt = new THREE.WebGLRenderTarget(pw, ph, { samples: q.samples, depthBuffer: true });
    postU.tColor.value = rt.texture;
    postU.tDepth.value = null;
    (postU.uRes.value as THREE.Vector2).set(pw, ph);
    rtSize.set(pw, ph);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    stillDrawn = false;
  }
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(resize, 150);
  });

  // ---- sending things to the GPU ahead of need: a city's full detail a mesh a frame before it is shown
  const uploader = new Uploader();
  cities.warm = { texture: (t) => renderer.initTexture(t), upload: (o) => uploader.add(o) };
  cities.onStage = (c) => people.prepare(c);
  /** (development) Reports programs linked after the warm-up: see warm.ts. */
  let lateWatch: (() => void) | null = null;

  // ---- audio and interface
  const audio = new AudioEngine();
  let photo = false;
  const ui = new UI(
    uiHost,
    {
    onBegin() {
      void audio.start();
      lock();
    },
    onIntroDone: () => save.setIntroSeen(),
    onResume() {
      audio.setPaused(false);
      lock();
    },
    onPause() {
      audio.setPaused(true);
    },
    onVolume: (v) => audio.setVolume(v),
    onMusic: (v) => audio.setMusicVolume(v),
    onEffects: (v) => audio.setEffectsVolume(v),
    onLevelPreview: (active) => audio.setPreview(active),
    // A sand footstep: the effect heard most, so the fairest yardstick.
    onEffectsSample: () => audio.footstep(0.8, false, false),
    onQuality(q, manual) {
      auto.setTier(q, manual);
      applyTier();
    },
    onWeather(on) {
      weather.enabled = on;
    },
    onPhoto(active) {
      photo = active;
    },
    onHideFigure(hidden) {
      figure.group.visible = !hidden;
    },
    onCapture() {
      render();
      canvas.toBlob((blob) => {
        if (!blob) return;
        // On a phone, hand the picture to the share sheet when the browser allows it.
        const name = unlocked ? `aster-${look.id}-${Date.now()}.png` : `aster-${Date.now()}.png`;
        if (touch.used && typeof navigator.canShare === 'function') {
          const file = new File([blob], name, { type: 'image/png' });
          if (navigator.canShare({ files: [file] })) {
            navigator.share({ files: [file] }).catch(() => {});
            return;
          }
        }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      }, 'image/png');
    },
    onStyle(i) {
      applyLook(LOOKS[i]);
      stillDrawn = false;
    },
    // A spawn is kept for the open sand only: not down in a cavern, or in the vault under the strata.
    canSetSpawn: () => !player.under && !discoveries.deepIn,
    onSetSpawn: () => saveSpawn({ x: player.state.pos.x, z: player.state.pos.z, facing: camYaw + Math.PI }),
    onClearSpawn: () => clearSpawn(),
    // A fresh arrival now, found the way a new visit finds one, whatever spawn is saved.
    onRespawn() {
      const at = arrival(Math.random, false);
      seekMiner = false;
      player.place(at.x, at.z);
      player.facing = at.city ? Math.atan2(at.city.cx - at.x, at.city.cz - at.z) : Math.random() * Math.PI * 2;
      camYaw = player.facing + Math.PI;
      camTarget.copy(player.state.pos);
      cities.setFocus(at.x, at.z);
    },
    // Forget the journey and the spawn, keep the settings, and arrive at the default spot.
    onReset() {
      resetting = true;
      save.discard();
      clearProgress();
      const url = new URL(window.location.href);
      for (const k of ['x', 'z', 'miner', 'reset', 'tools', 'deep', 'cavern']) url.searchParams.delete(k);
      window.location.replace(url.toString());
    },
    },
    {
      quality: auto.tier,
      styles: unlocked ? LOOKS.map(({ id, name }) => ({ id, name })) : [],
      style: unlocked ? qs.get('style') : null,
      intro: !save.data.introSeen,
      finds: save.data.found.length,
      tools: save.toolCount(),
    },
  );
  applyTier();
  const syncKnown = () => {
    ui.setKnown({
      talk: save.data.talked,
      board: save.has('board'),
      carpet: player.carpet,
      dig: save.has('pick'),
      spyglass: save.has('spyglass'),
      flute: save.has('flute'),
      bedroll: save.has('bedroll'),
    });
    touch.setBoard(save.has('board'), player.board);
    touch.setTools({ spyglass: save.has('spyglass'), flute: save.has('flute'), bedroll: save.has('bedroll') });
    ui.setTools(save.toolCount());
  };

  // A tool changes hands: kept, shown on the figure, and counted.
  const given = (t: Parameters<Save['give']>[0]) => {
    save.give(t);
    if (t === 'rope' || t === 'boots' || t === 'feather') atlas.setErrand(t, null);
    wear();
    figure.flourish = 1;
    audio.chime();
    buzz(20);
    syncKnown();
  };
  let herderAsked = false;
  /** What the village people have sent the wanderer after this visit: said in full once, and shortly after that. */
  const sent = new Set<'rope' | 'boots' | 'feather'>();
  /** The settlements whose host has spoken this visit. */
  const hosted = new Set<string>();
  /** Sent after something: where it was said to lie goes on the map, and stays there until it is in hand. */
  const send = (what: 'rope' | 'boots' | 'feather', at: { x: number; z: number }) => {
    sent.add(what);
    atlas.setErrand(what, at);
    marked();
  };
  /** An errand has gone onto the map: say so, and how to see it. */
  const marked = () => ui.toast(touch.used ? 'Marked on your map' : 'Marked on your map. M to open it', 5000);

  // ---- talking: anyone in reach can be spoken to. Travellers give the board to someone on foot.
  const pick = <T,>(list: T[], avoid: T | null): T => {
    let v = list[Math.floor(Math.random() * list.length)];
    if (v === avoid && list.length > 1) v = list[(list.indexOf(v) + 1) % list.length];
    return v;
  };
  const text = (l: Line) => (typeof l === 'string' ? l : touch.used ? l.touch : l.keys);
  /** After dark, as the people out of doors reckon it. */
  const dark = () => day.day < 0.22 || day.day > 0.78;
  /** How far off a mountain's cave or summit may be and still be worth sending someone to (m). */
  const STRAY_R = 6000;
  let lastLine: string | null = null;
  const trav = { ref: null as unknown, x: 0, y: 0, z: 0, h: 1, sit: 0, seed: 0, role: 0, camp: false, snow: false, place: undefined as string | undefined };
  const folk = { id: -1, x: 0, z: 0, h: 1, sit: 0, stall: false };
  const setTraveller = (out: Speaker) => {
    out.kind =
      trav.role === ROLE_PILGRIM ? 'pilgrim'
      : trav.role === ROLE_KEEPER ? 'keeper'
      : trav.role === ROLE_HERDER ? 'herder'
      : trav.role === ROLE_VILLAGER ? 'villager'
      : trav.role === ROLE_WATCHER ? 'watcher'
      : trav.role === ROLE_CLIMBER ? 'climber'
      : trav.role === ROLE_HOST ? 'host'
      : 'traveller';
    out.ref = trav.ref;
    out.x = trav.x;
    out.z = trav.z;
    out.y = trav.y + (1.72 - 0.62 * trav.sit) * trav.h;
    // (a child's voice is high)
    out.pitch = trav.h < 0.8 ? 320 + trav.seed * 80 : 120 + trav.seed * 110;
  };
  // ---- the miner, one in every city: wants a lamp fetched, and gives the pick for it
  const minerP = { x: 0, z: 0, h: 1, sit: 1 };
  const setMiner = (out: Speaker) => {
    out.kind = 'miner';
    out.ref = null;
    out.x = minerP.x;
    out.z = minerP.z;
    out.y = (cities.active?.site.groundY ?? player.state.pos.y) + 1.55;
    out.pitch = 96;
  };
  // Directions as someone would give them: the sun rises in the east (+x) and stands to the south (+z) at noon.
  const WAYS = ['east', 'north-east', 'north', 'north-west', 'west', 'south-west', 'south', 'south-east'];
  const directions = (line: string, fx: number, fz: number, tx: number, tz: number) => {
    const way = WAYS[((Math.round(Math.atan2(-(tz - fz), tx - fx) / (Math.PI / 4)) % 8) + 8) % 8];
    const d = Math.hypot(tx - fx, tz - fz);
    const far = d < 500 ? 'a short walk' : d < 1300 ? 'a fair walk' : d < 2800 ? 'a long walk' : d < 5000 ? 'a long walk, or a short ride' : 'a good ride';
    return line.replace('{way}', way).replace('{far}', far);
  };
  // Where the lamp for a city lies: by a spring or in a cave where there is a mountain near,
  // and otherwise out on open sand, a seeded way off.
  const lampSpots = new Map<number, { x: number; z: number; kind: 'spring' | 'cave' | 'sand'; mouth?: { x: number; z: number } }>();
  const lampSpot = (site: { id: number; seed: number; cx: number; cz: number; radius: number }) => {
    let s = lampSpots.get(site.id);
    if (!s) {
      const a = ((site.seed >>> 5) % 628) / 100;
      s = discoveries.lampSpot(site.cx, site.cz) ?? { x: site.cx + Math.cos(a) * (site.radius + 700), z: site.cz + Math.sin(a) * (site.radius + 700), kind: 'sand' };
      lampSpots.set(site.id, s);
    }
    return s;
  };
  const minerScript = () => {
    const site = cities.active!.site;
    const lamp = lampSpot(site);
    const where = directions(lamp.kind === 'spring' ? MINER.lampSpring : lamp.kind === 'cave' ? MINER.lampCave : MINER.lampSand, minerP.x, minerP.z, lamp.x, lamp.z);
    const cav = discoveries.nearestCavern(minerP.x, minerP.z);
    if (save.data.roles.miner === 2) {
      // Once the pick has been swung, the miner has one thing more to give: the rod.
      if (!save.has('rod') && save.data.deeds.dug) return { lines: MINER.rod.map(text), done: () => given('rod') };
      const pool = [...MINER.after, ...(save.has('carpet') ? [] : MINER.carpet), ...(save.has('rod') ? [] : [MINER.rodAsk, MINER.rodAsk]), ...(save.data.items.relic ? [...MINER.relic, ...MINER.relic] : [])];
      // until a first cavern has been opened, the miner goes on pointing at one
      if (cav && save.data.opened.length === 0) pool.push(directions(MINER.remind, minerP.x, minerP.z, cav.x, cav.z), directions(MINER.remind, minerP.x, minerP.z, cav.x, cav.z));
      return { lines: [(lastLine = pick(pool, lastLine))] };
    }
    if (save.data.items.lamp) {
      // The lamp is here, asked for or not: the pick changes hands.
      const last = cav ? directions(text(MINER.cavern), minerP.x, minerP.z, cav.x, cav.z) : text(MINER.noCavern);
      return {
        lines: [...MINER.gift.map(text), last],
        done() {
          save.setItem('lamp', false);
          save.setRole('miner', 2);
          save.give('pick');
          figure.lamp = false;
          figure.pick = true;
          people.minerLamp = true;
          audio.chime();
          buzz(20);
          syncKnown();
          if (cav && save.data.opened.length === 0) marked();
        },
      };
    }
    if (save.data.roles.miner === 1) return { lines: [MINER.pending, where, MINER.anyFall] };
    return {
      lines: [...MINER.ask.map(text), where, MINER.anyFall, MINER.askEnd],
      done() {
        save.setRole('miner', 1);
        if (!save.data.items.lamp) marked();
      },
    };
  };
  // Something small has been picked up: no sound, only the thing itself appearing at the hip.
  const pickedUp = (x: number, y: number, z: number) => {
    figure.flourish = 1;
    tmp.set(x, y, z);
    tmp2.set(0, 1.5, 0);
    dust.puff(tmp, tmp2, 0.2);
    buzz(12);
  };
  /** Say what a thing just picked up is, over the wanderer's head. */
  const found = (t: keyof typeof FOUND) => {
    const at = player.state.pos;
    talk.tell({ x: at.x, y: at.y + 1.8, z: at.z }, text(FOUND[t]));
  };
  /** Each temple near holds the first of its tools the wanderer lacks, until it has given one. */
  const layOffers = () => discoveries.setOffers((key) => offeringAt(key, (t) => save.has(t), save.data.gathered.includes(key)));
  let lampT = 0;
  // The wrecked sand-ships lying out in the sand this visit: every one the wanderer has reached
  // before (the save keeps those), and the ones this visit's storms have uncovered, by storm id
  // (null where a storm left none, its ground not suiting a wreck). One uncovered is only saved
  // once it is reached.
  let wreckT = 0;
  const uncovered = new Map<number, Wreck | null>();
  const devWrecks: Wreck[] = [];
  let wrecks: Wreck[] = [];
  const wreckS = { h: 0, rock: 0, salt: 0, green: 0 };
  const wreckN = new THREE.Vector3();
  const wreckC = new THREE.Vector2();
  /** Whether a wreck lying along rot at (x, z) would be on open sand, gently sloped, clear of towns and finds. */
  const wreckSuits = (x: number, z: number, rot: number): boolean => {
    const ux = Math.cos(rot);
    const uz = -Math.sin(rot);
    // her middle, both ends and both sides
    for (const [a, b] of [[0, 0], [20, 0], [-20, 0], [0, 8], [0, -8]]) {
      const sx = x + ux * a - uz * b;
      const sz = z + uz * a + ux * b;
      wreckS.green = 0;
      world.sample(sx, sz, wreckS);
      if (wreckS.rock >= 0.2 || wreckS.salt >= 0.3 || (wreckS.green ?? 0) > 0.05) return false;
      if (world.normal(sx, sz, wreckN).y < 0.94) return false;
    }
    const town = world.cities.near(x, z)[0];
    if (town && Math.hypot(town.cx - x, town.cz - z) < town.radius + 250) return false;
    return !discoveries.claimed(x, z, 40);
  };
  /** Hands Discoveries the wrecks there are now (which costs nothing when they are the same as before). */
  const layWrecks = () => {
    const list: Wreck[] = [];
    const put = (a: Wreck) => {
      if (!list.some((b) => Math.hypot(b.x - a.x, b.z - a.z) < 1)) list.push(a);
    };
    const kept = save.data.wrecks;
    for (let i = 0; i + 2 < kept.length; i += 3) put({ x: kept[i], z: kept[i + 1], rot: kept[i + 2] });
    for (const a of uncovered.values()) if (a) put(a);
    for (const a of devWrecks) put(a);
    if (list.length !== wrecks.length || list.some((a, i) => a.x !== wrecks[i].x || a.z !== wrecks[i].z || a.rot !== wrecks[i].rot)) wrecks = list;
    discoveries.setWrecks(wrecks);
  };
  // The fallen stars lying out: every one the wanderer has reached or a shower has brought down
  // (the save keeps those), and the ones the dev hook lays (this visit only).
  const devFallen: { x: number; z: number }[] = [];
  const layFallen = () => {
    const list: { x: number; z: number }[] = [];
    const put = (a: { x: number; z: number }) => {
      if (!list.some((b) => Math.hypot(b.x - a.x, b.z - a.z) < 1)) list.push(a);
    };
    const kept = save.data.fallen;
    for (let i = 0; i + 1 < kept.length; i += 2) put({ x: kept[i], z: kept[i + 1] });
    for (const a of devFallen) put(a);
    discoveries.setFallen(list);
  };
  /** A star comes down at (x, z): it is kept, and lies there from now on. */
  const starFalls = (x: number, z: number): void => {
    save.keepFallen(x, z);
    layFallen();
  };
  const digAt = { x: 0, y: 0, z: 0 };
  // Riding: a wild ass, an oryx or a caravan's camel. Both kinds are ridden the same way.
  type Steeds = Pick<Fauna, 'mounted' | 'nearestRideable' | 'rideMark' | 'mount' | 'dismount' | 'ride' | 'seat'>;
  // The beast in reach that could be climbed onto now (src null when there is none), how far its
  // middle is, and where the key cap sits on its back. Worked out once a frame, before the talking.
  const rideNear: { src: Steeds | null; ref: unknown; d: number } = { src: null, ref: null, d: Infinity };
  const rideAt = { x: 0, y: 0, z: 0 };
  /** A beast is about this far (m) from its middle to its flank: taken off its distance when it is weighed against someone to talk to. */
  const RIDE_GIRTH = 0.7;
  // ---- the lit sand over a sealed cavern says what it is to whoever walks onto it
  const cavernHints = new CavernHints();
  let hintScan = 0;
  let lastHint: string | null = null;

  const setFolk = (out: Speaker) => {
    out.kind = 'townsfolk';
    out.ref = folk.id;
    out.x = folk.x;
    out.z = folk.z;
    // townsfolk stand on the same street as the player
    out.y = player.state.pos.y + (1.7 - 0.6 * folk.sit) * folk.h;
    out.pitch = folk.h < 0.8 ? 330 + (folk.id % 7) * 12 : 130 + (folk.id % 11) * 11;
  };
  /** Whoever is in reach to talk to: the miner, someone of the roads and camps, or one of a city's people. */
  const findPerson = (out: Speaker): boolean => {
    const p = player.state.pos;
    if (!player.state.grounded) return false;
    if (people.minerNear(3, minerP)) {
      setMiner(out);
      return true;
    }
    if (caravans.nearestPerson(p.x, p.z, 3.4, trav) && Math.abs(trav.y - p.y) < 2) {
      setTraveller(out);
      return true;
    }
    if (people.nearestPerson(2.8, folk)) {
      setFolk(out);
      return true;
    }
    return false;
  };
  const talk = new Talk(uiHost, {
    // (a beast to ride that is nearer than anyone to talk to has the key instead: see scanRide)
    find(out) {
      const p = player.state.pos;
      return findPerson(out) && !(rideNear.src && rideNear.d - RIDE_GIRTH < Math.hypot(out.x - p.x, out.z - p.z));
    },
    hold(s) {
      if (s.kind === 'miner') {
        if (!people.minerNear(30, minerP)) return false;
        people.holdMiner();
        setMiner(s);
        return true;
      }
      if (s.kind !== 'townsfolk') {
        caravans.hold(s.ref);
        caravans.personAt(s.ref, trav);
        setTraveller(s);
        return true;
      }
      if (!people.personAt(s.ref as number, folk)) return false;
      people.hold(folk.id);
      setFolk(s);
      return true;
    },
    script(s) {
      if (!save.data.talked) {
        save.setTalked();
        syncKnown();
      }
      if (s.kind === 'miner') return minerScript();
      // The keepers of the temples give the spyglass to anyone who comes without one.
      if (s.kind === 'keeper' && !save.has('spyglass')) {
        return {
          lines: KEEPER.gift.map(text),
          done: () => given('spyglass'),
        };
      }
      // The watcher under a village's tower knows where a rope lies, out by the great bones.
      if (s.kind === 'watcher' && caravans.personAt(s.ref, trav) && trav.place === 'watchtower') {
        return { lines: [(lastLine = pick(KEEPER_OF_FLAME, lastLine))] };
      }
      if (s.kind === 'watcher') {
        const rope = save.has('rope') ? null : discoveries.ropeSpot(s.x, s.z, 2500);
        if (rope) {
          if (sent.has('rope')) return { lines: [directions(WATCHER.pending, s.x, s.z, rope.x, rope.z)] };
          return { lines: WATCHER.ask.map((l) => directions(text(l), s.x, s.z, rope.x, rope.z)), done: () => send('rope', rope) };
        }
        const pool = [...WATCHER.after, ...(dark() ? [...WATCHER.night, ...WATCHER.night] : []), ...(save.has('rope') ? [...WATCHER.rope, ...WATCHER.rope] : [])];
        return { lines: [(lastLine = pick(pool, lastLine))] };
      }
      // The climber by a village's fire sends the wanderer up the mountain: for the boots in its cave, then a feather from its top.
      if (s.kind === 'climber') {
        const want = !save.has('boots') ? 'boots' : !save.has('feather') ? 'feather' : null;
        const at = want && discoveries.straySpot(want, s.x, s.z, STRAY_R);
        if (want && at) {
          const pending = want === 'boots' ? CLIMBER.bootsPending : CLIMBER.featherPending;
          if (sent.has(want)) return { lines: [directions(pending, s.x, s.z, at.x, at.z)] };
          return { lines: CLIMBER[want].map((l) => directions(text(l), s.x, s.z, at.x, at.z)), done: () => send(want, at) };
        }
        return { lines: [(lastLine = pick(CLIMBER.after, lastLine))] };
      }
      // The people who moved into a hamlet once its well had water again.
      if ((s.kind === 'host' || s.kind === 'villager') && caravans.personAt(s.ref, trav) && trav.place === 'hamlet') {
        return { lines: [(lastLine = pick(SETTLER, lastLine))] };
      }
      // The people of the settlements out in the desert.
      if ((s.kind === 'host' || s.kind === 'villager') && caravans.personAt(s.ref, trav) && isSettlement(trav.place)) {
        const place = trav.place;
        const lines = SETTLED[place];
        if (s.kind === 'host') {
          // the old stargazer teaches the sky, after dark, to anyone who has heard the rest
          const lesson = place === 'star-house' && dark() && hosted.has(place) ? skyLesson() : null;
          if (lesson) return lesson;
          if (hosted.has(place)) return { lines: [(lastLine = pick(lines.hostAfter, lastLine))] };
          hosted.add(place);
          const site = discoveries.nearestUnfound(s.x, s.z, new Set<string>(save.data.found), 6000);
          if (!site) return { lines: [...lines.host, lines.hostNone] };
          return {
            lines: [...lines.host, directions(lines.hostPoint, s.x, s.z, site.x, site.z)],
            done: () => {
              save.sight(site.key, site.x, site.z);
              syncMarks();
              marked();
            },
          };
        }
        if (trav.h < 0.8) return { lines: [(lastLine = pick(lines.child, lastLine))] };
        const pool = [...lines.any, ...(dark() ? [...lines.night, ...lines.night] : [])];
        if (!hosted.has(place)) pool.push(lines.askHost, lines.askHost);
        return { lines: [(lastLine = pick(pool, lastLine))] };
      }
      // Everyone else in a village has a line about the place, the hour, and who to ask.
      if (s.kind === 'villager') {
        const lines = caravans.personAt(s.ref, trav) && trav.snow ? SNOWFOLK : VILLAGER;
        if (trav.h < 0.8) return { lines: [(lastLine = pick(lines.child, lastLine))] };
        const d = day.day;
        const hour = dark() ? [...lines.night, ...lines.night] : lines === VILLAGER && d < 0.32 ? VILLAGER.dawn : lines === VILLAGER && d > 0.7 ? VILLAGER.dusk : [];
        const pool = [...lines.any, ...hour];
        if (!save.has('rope')) pool.push(...lines.askWatcher, ...lines.askWatcher);
        if (!save.has('boots') || !save.has('feather')) pool.push(...lines.askClimber, ...lines.askClimber);
        if (save.has('boots')) pool.push(...lines.boots);
        if (save.has('feather')) pool.push(...lines.feather);
        return { lines: [(lastLine = pick(pool, lastLine))] };
      }
      // A goat herder gives the flute to someone who has ridden a wild animal.
      if (s.kind === 'herder') {
        if (save.has('flute')) return { lines: [(lastLine = pick(HERDER.after, lastLine))] };
        if (save.data.deeds.rode) return { lines: HERDER.gift.map(text), done: () => given('flute') };
        if (herderAsked) return { lines: [HERDER.pending] };
        return { lines: HERDER.ask.map(text), done: () => void (herderAsked = true) };
      }
      // A pilgrim gives the star chart to someone who has stood at a sundial.
      if (s.kind === 'pilgrim' && !save.has('chart') && save.data.found.includes('sundial')) {
        return { lines: PILGRIM.gift.map(text), done: () => given('chart') };
      }
      if (s.kind === 'pilgrim' || s.kind === 'keeper') {
        const lines = s.kind === 'pilgrim' ? PILGRIM : KEEPER;
        const dark = day.day < 0.22 || day.day > 0.78;
        const pool = [...lines.any, ...(dark ? [...lines.night, ...lines.night] : [])];
        if (s.kind === 'pilgrim' && !save.has('chart')) pool.push(...PILGRIM.dial, ...PILGRIM.dial);
        if (s.kind === 'keeper' && save.data.items.relic) pool.push(...KEEPER.relic, ...KEEPER.relic);
        if (s.kind === 'keeper' && discoveries.offerWithin(s.x, s.z, 90)) pool.push(...KEEPER.offering, ...KEEPER.offering);
        return { lines: [(lastLine = pick(pool, lastLine))] };
      }
      if (s.kind === 'traveller') {
        if (!save.has('board')) {
          return {
            lines: TRAVELLER.gift.map(text),
            done() {
              // The gift: from here on the sand is ridden.
              save.give('board');
              boardOn = true;
              player.board = true;
              figure.board = true;
              figure.boardOn = true;
              audio.chime();
              buzz(20);
              syncKnown();
              if (!touch.used) ui.toast('Q to step on or off the board', 6000);
            },
          };
        }
        // At a camp fire after dark, someone with nothing to sleep on is given a bedroll.
        if (!save.has('bedroll') && (day.day < 0.22 || day.day > 0.78) && caravans.personAt(s.ref, trav) && trav.camp) {
          return { lines: TRAVELLER.bedroll.map(text), done: () => given('bedroll') };
        }
        return { lines: [(lastLine = pick(TRAVELLER.after, lastLine))] };
      }
      // The keeper of the market stall has a carpet, and wants something old for it.
      if (people.personAt(s.ref as number, folk) && folk.stall) {
        if (save.has('carpet')) return { lines: [save.data.roles.weaver === 2 ? (lastLine = pick(WEAVER.after, lastLine)) : WEAVER.own] };
        if (save.data.items.relic) {
          return {
            lines: WEAVER.gift.map(text),
            done() {
              save.setItem('relic', false);
              save.setRole('weaver', 2);
              figure.relic = false;
              player.carpet = figure.carpet = true;
              given('carpet');
            },
          };
        }
        if (save.data.roles.weaver === 1) return { lines: [WEAVER.pending] };
        return { lines: WEAVER.ask.map(text), done: () => save.setRole('weaver', 1) };
      }
      const site = cities.active?.site;
      const d = day.day;
      const hour = d < 0.2 || d > 0.82 ? TOWNSFOLK.night : d < 0.32 ? TOWNSFOLK.dawn : d > 0.7 ? TOWNSFOLK.dusk : d > 0.42 && d < 0.58 ? TOWNSFOLK.noon : [];
      const pool = [...TOWNSFOLK.any, ...(site ? TOWNSFOLK[site.kind] : []), ...hour, ...(save.has('board') ? [] : [...TOWNSFOLK.onFoot, ...TOWNSFOLK.onFoot])];
      // a relic at the belt gets noticed, and in any city someone with no pick is sent to the miner
      pool.push(...almanacLines(monthDay(dayOf(skyClock(), day.day))));
      if (save.data.items.relic) pool.push(...TOWNSFOLK.relic, ...TOWNSFOLK.relic);
      if (site && !save.has('pick')) {
        // point the way to the miner, from where the player stands
        const at = player.state.pos;
        if (people.minerNear(1e9, minerP)) pool.push(...TOWNSFOLK.noPick.map((l) => directions(l, at.x, at.z, minerP.x, minerP.z)));
        else pool.push(...TOWNSFOLK.noPickBlind);
      }
      return { lines: [(lastLine = pick(pool, lastLine))] };
    },
    voice: (pitch) => audio.murmur(pitch),
  });
  onLook = (l) => talk.setColours(l.ink, l.paper);
  onLook(look);
  discoveries.onReach = (kind, key, x, z) => {
    audio.chime();
    if (isFindKind(kind)) atlas.addPlace({ id: `s${key}`, kind, x, z });
    // a place marked through the spyglass has been reached: its mark comes down
    if (save.data.sighted.includes(key)) {
      save.unsight(key);
      syncMarks();
    }
    // The first of each kind adds to the count in the corner.
    // a wreck once reached stays where it lies, on every visit after
    if (kind === 'wreck') {
      const w = wrecks.find((a) => a.x === x && a.z === z);
      if (w) save.keepWreck(w.x, w.z, w.rot);
    }
    if (isFindKind(kind) && save.find(kind)) {
      ui.setFinds(save.data.found.length);
      if (ui.state === 'playing') ui.toast(`${findName(kind)} found`, 3000);
    }
  };
  fauna.onCall = (_sp, dist) => audio.yip(dist);
  cities.onReach = (site) => {
    audio.chime();
    atlas.addPlace({ id: `c${site.id}`, kind: `city:${site.kind}`, x: site.cx, z: site.cz });
  };
  // Roofs you can land on: buildings, and the rock over a cave once you are above its ceiling.
  // (ceilings: the caves in the massifs, the caps over the springs, and the sand left over an open cavern)
  const ceilAt = (x: number, z: number) => Math.min(world.caveCeil(x, z), discoveries.capCeil(x, z), world.cavernCeil(x, z));
  const caveRoofAt = (x: number, z: number, y: number) => {
    const ceil = ceilAt(x, z);
    return ceil < Infinity && y > ceil - 0.3 ? world.uncarved(x, z) : -Infinity;
  };
  // (and the things found out in the desert: standing stones, fallen columns, the great bones)
  // (and the rocks and cacti between them)
  player.roof = (x, z, y) => Math.max(cities.roofAt(x, z, y), caveRoofAt(x, z, y), discoveries.topAt(x, z, y), props.topAt(x, z, y));
  // What stands in the way of everything else that walks the ground: the same solids, less the
  // cave roofs (only ever overhead down at the feet).
  const obstacle = (x: number, z: number, y: number) => Math.max(cities.roofAt(x, z, y), discoveries.topAt(x, z, y), props.topAt(x, z, y));
  const collisionDebug = new CollisionOverlay(scene, obstacle, (x, z) => world.height(x, z));
  player.beast = (x, z) => fauna.beastAt(x, z) || caravans.beastAt(x, z);
  people.solid = fauna.solid = wildlife.solid = caravans.solid = obstacle;
  // Under an open cavern the deep has floors of its own, one over another: where it has the
  // say, the terrain (and every roof above) is not asked.
  player.floor = (x, z, y) => discoveries.deepFloor(x, z, y);
  // What the feet are on when it is not the ground: 0 stone, 1 bone, 2 wood, or -1 for the ground itself.
  const propUnder = (x: number, z: number, y: number) => {
    const td = discoveries.topAt(x, z, y);
    const tp = props.topAt(x, z, y);
    const t = Math.max(td, tp);
    return Math.abs(t - y) < 0.3 && t > world.height(x, z) + 0.4 ? (tp > td ? props.kind : discoveries.solidKind) : -1;
  };
  player.hard = (x, z, y) => propUnder(x, z, y) >= 0;
  // The roof over a cavern is the sand it always was, though the floor under it is rock.
  player.soft = (x, z, y) => y > world.cavernCeil(x, z) - 0.3;
  // Water, wherever it lies: a river painted on its bed, a city's pool, an oasis in the dunes.
  // Fills `water` with the height of the surface and how deep it stands over the ground.
  const water = { y: 0, depth: 0 };
  const wadeS = { h: 0, rock: 0, salt: 0, green: 0 };
  const smooth = (a: number, b: number, v: number) => {
    const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const waterAt = (x: number, z: number): boolean => {
    // down in a deep, only its own water counts: the bed is its floor, the surface that much above
    const deep = discoveries.deepIn;
    if (deep) {
      const y = player.state.pos.y;
      const depth = deep.waterAt(x, z, y);
      const bed = depth > 0 ? deep.floorAt(x, z, y) : null;
      if (bed === null || !Number.isFinite(bed)) return false;
      water.y = bed + depth;
      water.depth = depth;
      return true;
    }
    const pool = cities.poolDepthAt(x, z);
    if (pool > 0) {
      water.y = world.height(x, z);
      water.depth = pool;
      return true;
    }
    const rd = world.river(x, z);
    if (rd < TERRAIN.riverHalf) {
      // the same edge the ground paints its water to: narrower where the river runs out at a spring
      const green = world.sample(x, z, wadeS).green ?? 0;
      const half = TERRAIN.springHalf - 1.5 + (TERRAIN.riverHalf - 1.2 - (TERRAIN.springHalf - 1.5)) * smooth(TERRAIN.springLip + 0.02, 0.97, green);
      if (green > 0.6 && rd < half + 0.75) {
        water.y = wadeS.h;
        water.depth = TERRAIN.riverWade;
        return true;
      }
    }
    const oasis = discoveries.poolAt(x, z);
    if (oasis > -Infinity) {
      const h = world.height(x, z);
      if (oasis > h + 0.03) {
        water.y = oasis;
        water.depth = oasis - h;
        return true;
      }
    }
    return false;
  };
  // Pools and rivers are waded: you stand a little below the surface. (An oasis lies over
  // the sand, so its bed is the ground already.)
  player.dip = (x, z) => (waterAt(x, z) && water.y - world.height(x, z) < 0.01 ? water.depth : 0);
  // Whether the wanderer's feet are in water now; `water` then holds the surface.
  const wading = () => {
    const p = player.state.pos;
    return waterAt(p.x, p.z) && p.y < water.y - 0.02 && p.y > water.y - water.depth - 0.5;
  };
  // What the camera must stay above: sand, or a roof.
  const topAt = (x: number, z: number) => Math.max(world.height(x, z), cities.roofAt(x, z, camera.position.y), inCave ? -Infinity : caveRoofAt(x, z, camera.position.y));
  let inCave = false; // the wanderer is under a cave roof, so the camera stays under it too

  // ---- input
  const keys = new Set<string>();
  /** The keys held across (-1 west .. 1 east) and along (-1 back .. 1 ahead). */
  const keyX = () => (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  const keyZ = () => (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  let jumpQueued = false;
  let camYaw = player.facing + Math.PI;
  let camPitch = 0.22;

  // ---- autosave the spawn: where you stand on open sand is where the next visit starts.
  // Off for ?x=&z= and ?miner visits, so a shared link never overwrites your own spot.
  if (!(qs.has('x') && qs.has('z')) && !qs.has('miner') && !qs.has('reset')) {
    const keepSpot = () => {
      if (resetting || player.under || discoveries.deepIn) return;
      saveSpawn({ x: player.state.pos.x, z: player.state.pos.z, facing: camYaw + Math.PI });
    };
    window.setInterval(keepSpot, 5000);
    window.addEventListener('pagehide', keepSpot);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') keepSpot();
    });
  }
  // ---- and the map with it, whatever kind of visit this is
  {
    // The map is encoded from rows kept up to date as cells are revealed, and written when the browser is idle,
    // at most every ~15 s; leaving the page writes it at once.
    const keepMap = () => {
      if (!resetting) atlas.store();
    };
    let mapWritten = performance.now();
    let mapIdle = false;
    const keepMapSoon = () => {
      if (mapIdle || !atlas.dirty || performance.now() - mapWritten < 15000) return;
      mapIdle = true;
      const go = () => {
        mapIdle = false;
        mapWritten = performance.now();
        keepMap();
      };
      if (window.requestIdleCallback) window.requestIdleCallback(go, { timeout: 4000 });
      else window.setTimeout(go, 300);
    };
    window.setInterval(keepMapSoon, 5000);
    window.addEventListener('pagehide', keepMap);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') keepMap();
    });
  }
  let camDist = 7.5;
  let dragging = false;
  // On meeting someone the eye eases round to an over-the-shoulder angle that frames both of
  // them, a little higher and never nearer than before. It lets go after a moment, so the view
  // can still be turned by hand.
  let wasTalking = false;
  let talkEase = 0;
  let talkYaw = 0;

  // Going back on a phone opens the menu instead of leaving the game.
  installTouchGuards(() => {
    if (ui.state === 'playing') ui.openMenu();
  });

  // ---- touch: a floating stick, drag to look (pinch zooms in photo mode only), one button to leap and fly
  const touchHost = document.createElement('div');
  document.body.insertBefore(touchHost, uiHost);
  let lastTouch = -1e9;
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') lastTouch = performance.now();
  }, true);
  const touch = new TouchControls(touchHost, {
    onLook(dx, dy) {
      if (glassK > 0.5) return glassLook(dx * 2, dy * 2);
      camYaw -= dx * 0.0052;
      camPitch = Math.min(1.25, Math.max(-0.35, camPitch + dy * 0.0044));
    },
    onZoom(f) {
      camDist = Math.min(photo ? 60 : 16, Math.max(3, camDist / f));
    },
    onJump() {
      if (ui.state === 'playing') jumpQueued = true;
    },
    onPause() {
      if (ui.state === 'playing') ui.openMenu();
    },
    onTalk() {
      if (ui.state === 'playing') interact();
    },
    onBoard() {
      if (ui.state === 'playing') toggleBoard();
    },
    // (touch has no key to hold: the spyglass is raised by one tap and lowered by the next)
    onSpyglass() {
      if (ui.state === 'playing') glassHeld = !glassHeld;
    },
    onFlute() {
      if (ui.state === 'playing') playFlute();
    },
    onFluteHold() {
      if (ui.state === 'playing') openSongs(true);
    },
    onBedroll() {
      if (ui.state === 'playing') useBedroll();
    },
    // wired by the tool logic
  });
  // ---- the pick: with nobody in reach, the key that talks swings it instead
  const SWING = 0.62; // seconds, start to finish
  const SWING_HIT = 0.45; // the fraction of it at which the point lands
  let swingT = -1; // seconds into a swing, or -1 at rest
  let swingHit = false;
  // ---- riding: a wild ass, an oryx or a caravan's camel, walked up to and climbed onto. The board and carpet are stowed meanwhile.
  // Both kinds are ridden the same way; only one at a time.
  let steed: Steeds | null = null;
  /**
   * Look for a beast to climb onto: the nearest in reach, wild or a camel, kept in rideNear with
   * where its key cap goes. Nothing while riding, in the air, underground or inside a city.
   */
  const scanRide = () => {
    rideNear.src = null;
    rideNear.ref = null;
    rideNear.d = Infinity;
    const p = player.state.pos;
    if (steed || !player.state.grounded || discoveries.deepIn || cities.inside || ui.state !== 'playing') return;
    for (const src of [fauna, caravans] as Steeds[]) {
      const ref = src.nearestRideable(p.x, p.z);
      if (!ref) continue;
      src.rideMark(ref, rideAt);
      const d = Math.hypot(rideAt.x - p.x, rideAt.z - p.z);
      if (d < rideNear.d) {
        rideNear.src = src;
        rideNear.ref = ref;
        rideNear.d = d;
      }
    }
    if (rideNear.src) rideNear.src.rideMark(rideNear.ref, rideAt);
  };
  const tryMount = () => {
    scanRide();
    const src = rideNear.src;
    if (!src?.mount(rideNear.ref)) return false;
    steed = src;
    rideNear.src = null;
    save.setDeed('rode');
    player.board = false;
    figure.boardOn = false;
    figure.seated = true;
    swingT = -1;
    figure.swing = -1;
    touch.setBoard(save.has('board'), false);
    audio.footstep(0.8, false);
    buzz(10);
    if (!touch.used) ui.toast('E to get off', 4000);
    return true;
  };
  /** Somewhere clear to step down onto: no stone, wall or prop there, and nothing of a camp. */
  const clearFoot = (x: number, z: number) => !blockedAt(obstacle, x, z, world.height(x, z)) && !caravans.crowded(x, z);
  const dismount = () => {
    const sd = steed;
    if (!sd) return;
    const s = sd.seat;
    sd.dismount();
    steed = null;
    figure.seated = false;
    player.board = boardOn;
    figure.boardOn = boardOn;
    touch.setBoard(save.has('board'), boardOn);
    if (s) {
      // step down onto the ground beside it: the right, else the left, else out in front (about a
      // back's height ahead, clear of the head), else the right after all
      let x = 0;
      let z = 0;
      for (let i = 0; i < 4; i++) {
        const a = i === 1 ? s.yaw - Math.PI / 2 : i === 2 ? s.yaw : s.yaw + Math.PI / 2;
        const r = i === 2 ? s.back + 0.3 : 1.1;
        x = s.x + Math.sin(a) * r;
        z = s.z + Math.cos(a) * r;
        if (i === 3 || clearFoot(x, z)) break;
      }
      const st = player.state;
      st.pos.set(x, world.height(x, z), z);
      st.vel.set(0, 0, 0);
      st.speed = 0;
    }
    buzz(10);
  };
  /** Whether a swing may start now: a pick, feet on the ground, and no conversation to have. */
  const canDig = () => save.has('pick') && player.state.grounded && !talk.available;
  // ---------------------------------------------------------------- bringing a place back
  const campedAt = new Set<number>();
  let revivedT = 0;
  /** Tell the world what has been brought back: the places change, and caravans camp by a hamlet that has people again. */
  const syncRevived = () => {
    const p = player.state.pos;
    const list = save.data.revived;
    discoveries.setRevived(list, frame.clock, p.x, p.z);
    map.revived = list;
    for (const r of list) {
      if (r.kind !== 'hamlet' || campedAt.has(r.key) || stageOf(r.kind, r.day, frame.clock) < 3) continue;
      // (a camp is kept for the whole visit, so only the ones near enough to be come upon)
      if (Math.hypot(r.x - p.x, r.z - p.z) > 4000) continue;
      campedAt.add(r.key);
      const a0 = ((r.key % 628) + 628) / 100;
      let best = { x: r.x, z: r.z };
      let flat = Infinity;
      for (let k = 0; k < 8; k++) {
        const a = a0 + (k / 8) * Math.PI * 2;
        const x = r.x + Math.cos(a) * CAMP_OFF;
        const z = r.z + Math.sin(a) * CAMP_OFF;
        const h = world.height(x, z);
        let rough = waterAt(x, z) ? 99 : 0;
        for (let i = 0; i < 6; i++) rough = Math.max(rough, Math.abs(world.height(x + Math.cos(i * 1.05) * 9, z + Math.sin(i * 1.05) * 9) - h));
        if (rough < flat) {
          flat = rough;
          best = { x, z };
        }
      }
      caravans.addCamp(best.x, best.z, WORLD_SEED ^ Math.round(best.x * 31 + best.z * 17));
      props.keepClear(best.x, best.z, 22);
    }
  };
  /**
   * The interact key at a place that can be brought back, or at something worth carrying to one.
   * Gives what the place wants if it is carried; failing that takes up whatever is here to take;
   * failing that says what the place wants. False when there was nothing of the kind to do.
   */
  const tend = (): boolean => {
    const st = player.state;
    if (steed || !st.grounded) return false;
    const p = st.pos;
    const say = (line: string) => talk.tell({ x: p.x, y: p.y + 1.8, z: p.z }, line, 5);
    const at = discoveries.revivableNear(p.x, p.z);
    const empty = at && at.stage === 0 && !save.data.revived.some((r) => r.key === at.key) ? at : null;
    if (empty && save.carries(WANTS[empty.kind])) {
      save.setCarry(WANTS[empty.kind], false);
      save.revive({ key: empty.key, kind: empty.kind, x: empty.x, z: empty.z, day: frame.clock });
      syncRevived();
      audio.chime();
      buzz(40);
      say(DONE[empty.kind]);
      return true;
    }
    const fx = p.x + Math.sin(player.facing) * 1.5;
    const fz = p.z + Math.cos(player.facing) * 1.5;
    const here: Carry[] = [];
    const src = discoveries.sourceNear(p.x, p.z);
    if (src) here.push(src);
    if (wading() || waterAt(fx, fz)) here.push('water');
    const take = here.find((c) => !save.carries(c));
    if (take) {
      save.setCarry(take, true);
      buzz(14);
      say(TAKEN[take]);
      return true;
    }
    if (empty) {
      say(NEEDS[empty.kind]);
      return true;
    }
    return false;
  };
  const interact = () => {
    const p = player.state.pos;
    if (!talk.talking && discoveries.stoneNear(p.x, p.y, p.z)) discoveries.wakeStone(p.x, p.y, p.z);
    else if (talk.available) talk.interact();
    else if (tend()) return;
    else if (steed) dismount();
    else if (tryMount()) return;
    else if (canDig() && swingT < 0) {
      swingT = 0;
      swingHit = false;
    }
  };
  // A stone has been woken: kept, the climb grows, and the stone says so.
  discoveries.onWoken = (key) => {
    save.wake(key);
    setLift();
    audio.chime();
    buzz(40);
    const p = player.state.pos;
    talk.tell({ x: p.x, y: p.y + 1.8, z: p.z }, 'The stone wakes. You climb longer now.');
  };
  /** The point of the pick lands, a short reach ahead of the feet. */
  const strike = () => {
    const st = player.state;
    const x = st.pos.x + Math.sin(player.facing) * 0.75;
    const z = st.pos.z + Math.cos(player.facing) * 0.75;
    buzz(14);
    if (waterAt(x, z) && water.y > world.height(x, z) - 0.01) {
      splash.burst(x, water.y, z, 0, 0, 0.3);
      splash.ring(x, water.y, z, 1.2, 1.1);
      audio.splash(0.3);
      return;
    }
    const hard = st.onRock > 0.5 || (world.sample(x, z, probe).rock > 0.5 && !player.soft?.(x, z, st.pos.y));
    if (hard) {
      audio.strike('rock', 0);
      return;
    }
    // A scuff: one deep bite where the point went in, and the sand it threw back toward the feet.
    const fx = Math.sin(player.facing);
    const fz = Math.cos(player.facing);
    const along = Math.PI / 2 - player.facing; // the trail field measures headings from +x
    // (a mark reads by how steep its sides are, so the bite is narrow and deep, not broad)
    trail.stamp(x, z, 0.15, 1, along, 2.2);
    trail.stamp(x + fx * 0.12, z + fz * 0.12, 0.11, 1, along, 1.2);
    for (let i = 0; i < 4; i++) {
      // the sand it threw: a loose fan back toward the feet and out to the sides
      const a = (Math.random() - 0.5) * 2.4;
      const r = 0.45 + Math.random() * 0.5;
      trail.stamp(x - (fx * Math.cos(a) - fz * Math.sin(a)) * r, z - (fz * Math.cos(a) + fx * Math.sin(a)) * r, 0.07 + Math.random() * 0.05, 0.4);
    }
    tmp.set(x, world.height(x, z) + 0.05, z);
    tmp2.set(-fx * 0.8, 2.2, -fz * 0.8);
    dust.puff(tmp, tmp2, 0.3);
    // The ground answers: dull over solid sand, hollow near a buried chamber, and on the spot
    // itself the crust cracks a little further with each blow until it gives.
    const hit = discoveries.strike(x, z);
    save.setDeed('dug');
    audio.strike('sand', hit.hollow);
    crackGround(x, z, hit.level, hit.broke);
  };
  /** The crust over a cavern cracks where it was struck (level 1..3), or gives way (broke): the marks, dust and sound of it. */
  const crackGround = (x: number, z: number, level: number, broke: boolean) => {
    const hit = { level, broke };
    if (hit.level > 0 || hit.broke) {
      tmp.set(x, world.height(x, z) + 0.05, z);
      const n = hit.broke ? 14 : 3 + hit.level * 3;
      for (let i = 0; i < n; i++) {
        // cracks running out from the blow, longer each time
        const a = Math.random() * Math.PI * 2;
        const len = 0.4 + Math.random() * (0.4 + 0.45 * (hit.broke ? 4 : hit.level));
        trail.stamp(x + Math.cos(a) * len * 0.6, z + Math.sin(a) * len * 0.6, 0.05, 0.8, a, len / 0.05 / 2);
      }
      dust.puff(tmp, tmp2.set(0, 2, 0), 0.4 + 0.15 * hit.level);
      buzz(20 + 12 * hit.level);
      if (hit.broke) {
        audio.crack(3);
        audio.drain(discoveries.drainTime);
        buzz(120);
      } else audio.crack(hit.level);
    }
  };

  // ---- the spyglass: held to the eye, the view goes out along it to a far place. One held
  // steady at its centre until the ring closes is marked, and the mark stands until it is reached.
  const GLASS_FOV = 9; // degrees, as first raised; the wheel draws it in and out
  const SIGHT_HOLD = 0.9; // seconds a place must be held in the ring
  const SIGHT_RANGE = 4500;
  let glassHeld = false;
  let glassK = 0; // 0 lowered .. 1 at the eye, eased
  let glassPitch = 0; // how far above level it looks
  let glassFov = GLASS_FOV;
  let glassHid = false; // the figure is put away while the eye is at the glass
  let sightKey: number | null = null;
  let sightT = 0;
  let sightScan = 0;
  const sightAt = { x: 0, z: 0 };
  const sites: import('../world/discoveries').SiteRef[] = [];
  const glassLook = (dx: number, dy: number) => {
    const k = glassFov / 50;
    camYaw -= dx * 0.0026 * k;
    glassPitch = Math.min(0.9, Math.max(-0.7, glassPitch - dy * 0.0022 * k));
  };
  /** Whether the ground leaves a clear line from the eye to a point. */
  const sightClear = (ex: number, ey: number, ez: number, tx: number, ty: number, tz: number) => {
    for (let i = 1; i < 40; i++) {
      const t = i / 40;
      if (world.height(ex + (tx - ex) * t, ez + (tz - ez) * t) > ey + (ty - ey) * t) return false;
    }
    return true;
  };

  // ---- the flute: a phrase on the reed, and whatever wild thing is near enough to hear comes.
  // The songs learned from places each do one thing where it suits (see songs.ts).
  let fluteT = 0; // seconds of the phrase still to play
  let fluteCall = -1; // seconds until the song takes effect (for the call: goes out), or -1
  let fluteSong: Song = 'call';
  let teachSong: Exclude<Song, 'call'> | null = null; // the place that will answer once the phrase ends
  let answerT = -1; // seconds of a place's answer still to play, or -1
  let lastSong: Song | null = null; // the last one chosen from the ring
  let windT = 0; // seconds the wind song still holds the air up
  let windRest = 0; // seconds before the wind song will work again
  const WIND_REST = 20;
  const WAKE_REACH = 6000; // how far the stones look for an unfound place (m)
  const WAKE_GLOW = 12; // seconds the woken stones stay lit
  const songSites: import('../world/discoveries').SiteRef[] = [];
  const stonesAt = { x: 0, z: 0 };
  const knownSongs = () => SONGS.filter((s) => save.knows(s));
  /** The point a short reach ahead of the feet, where the pick lands (and the opening song is aimed). */
  const ahead = () => {
    const st = player.state;
    return { x: st.pos.x + Math.sin(player.facing) * 0.75, z: st.pos.z + Math.cos(player.facing) * 0.75 };
  };
  /** What is true of where the wanderer stands now, for choosing a song. Leaves the nearest stones in stonesAt. */
  const standing = (): Standing => {
    const st = player.state;
    const x = st.pos.x;
    const z = st.pos.z;
    discoveries.sitesNear(x, z, Math.max(TEACH_R, WAKE_R), songSites);
    let teacher: Exclude<Song, 'call'> | null = null;
    let td = Infinity;
    let sd = Infinity;
    for (const site of songSites) {
      const d = Math.hypot(site.x - x, site.z - z);
      if (site.kind === 'standing-stones' && d <= WAKE_R && d < sd) {
        sd = d;
        stonesAt.x = site.x;
        stonesAt.z = site.z;
      }
      const song = taughtBy(site.kind);
      if (song && !save.knows(song) && d <= TEACH_R && d < td) {
        td = d;
        teacher = song;
      }
    }
    const a = ahead();
    return {
      teacher,
      sealed: discoveries.canBreak(a.x, a.z),
      stones: sd < Infinity,
      aloft: !st.grounded && (player.gliding || player.lifting || (player.riding && player.carpet)),
    };
  };
  /** Whether the flute may be raised now. */
  const canPipe = () => save.has('flute') && fluteT <= 0 && answerT < 0 && !teachSong && !talk.talking && swingT < 0 && glassK <= 0.1 && !discoveries.deepIn;
  /** Said over the wanderer's head, as a found thing is. */
  const say = (line: string) => {
    if (!line) return;
    const at = player.state.pos;
    talk.tell({ x: at.x, y: at.y + 1.8, z: at.z }, line);
  };
  /** Play a song (or, with none given, the one that suits where the wanderer stands). */
  const playFlute = (song?: Song) => {
    if (!canPipe()) return;
    const at = standing();
    const chosen = song && save.knows(song) ? song : suited((s) => save.knows(s), at);
    // a place that teaches a song not yet known hears the plain call, and answers it
    teachSong = at.teacher;
    fluteSong = teachSong ? 'call' : chosen;
    fluteT = audio.flute(fluteSong);
    fluteCall = fluteSong === 'call' ? Math.min(0.9, fluteT * 0.4) : fluteT * 0.6;
    buzz(10);
  };
  /** Partway through the phrase, the song does what it does (or says why not). */
  const songTakes = (song: Song) => {
    const st = player.state;
    const px = st.pos.x;
    const pz = st.pos.z;
    if (song === 'call') {
      fauna.call(px, pz);
      return;
    }
    const at = standing();
    if (song === 'waking') {
      const site = at.stones ? discoveries.nearestUnfound(px, pz, new Set<string>(save.data.found), WAKE_REACH) : null;
      if (!site) return say(NOTHING.waking);
      save.sight(site.key, site.x, site.z);
      syncMarks();
      audio.chime('woke');
      buzz(20);
      ui.toast('Marked', 2200);
      discoveries.wakeStones(stonesAt.x, stonesAt.z, WAKE_GLOW, frame.time);
      return;
    }
    if (song === 'wind') {
      if (windT > 0 || windRest > 0) return; // still resting: it only plays
      if (!at.aloft) return say(NOTHING.wind);
      windT = WIND_SECONDS;
      return;
    }
    if (song === 'rain') {
      const sr = weather.sentRain;
      const rested = save.data.rainSung === null || frame.clock - save.data.rainSung > RAIN_REST;
      if (!weather.enabled || discoveries.deepIn || underK > 0.01 || (sr && sr.t1 > frame.clock) || frame.rain > 0 || !rested) return say(NOTHING.rain);
      const r = weather.aim(frame.clock, px, pz, RAIN_ARRIVES, 'rain');
      weather.sentRain = r;
      save.setSentRain(r);
      save.setRainDay(frame.clock);
      save.setRainSung(frame.clock);
      return;
    }
    // opening
    const a = ahead();
    if (!discoveries.breakOpen(a.x, a.z)) return say(NOTHING.opening);
    crackGround(a.x, a.z, 0, true);
    audio.chime('opened');
  };
  /** The ring of songs, to choose one by holding the flute key (or button). */
  const songRing = new SongRing(uiHost, (s) => {
    if (s) {
      lastSong = s;
      playFlute(s);
    }
  });
  /** Open the ring (or, knowing only the call, just play it). */
  const openSongs = (isTouch: boolean) => {
    if (!canPipe()) return;
    const known = knownSongs();
    if (known.length < 2) return playFlute();
    const current = lastSong && save.knows(lastSong) ? lastSong : suited((s) => save.knows(s), standing());
    songRing.open(known, current, isTouch);
  };
  let fluteKeyAt = -1; // performance.now() when R went down, or -1 when it is up
  const FLUTE_HOLD_MS = 300;

  // ---- the bedroll: laid on open ground, it stays there. Beside it, the same key sleeps.
  const useBedroll = () => {
    if (!save.has('bedroll') || sleep.asleep) return;
    if (sleep.isOpen) return sleep.confirm();
    const st = player.state;
    if (!st.grounded || steed || discoveries.deepIn || cities.inside || talk.talking || glassK > 0.1 || fluteT > 0) return;
    const camp = save.data.camp;
    if (camp && Math.hypot(camp.x - st.pos.x, camp.z - st.pos.z) < 5) {
      sleep.open(day.day > 0.268 && day.day < 0.722 ? 'dusk' : 'dawn', touch.used);
      return;
    }
    // somewhere to lie: level, dry, open ground a step ahead
    const x = st.pos.x + Math.sin(player.facing) * 1.3;
    const z = st.pos.z + Math.cos(player.facing) * 1.3;
    if (world.normal(x, z, tmp).y < 0.93 || waterAt(x, z) || !clearFoot(x, z) || !clearFoot(x + Math.cos(player.facing) * 1.25, z - Math.sin(player.facing) * 1.25)) {
      ui.toast('No room to lay it here', 2600);
      return;
    }
    save.setCamp({ x, z, facing: player.facing });
    placeCamp();
    audio.footstep(0.7, false);
    buzz(14);
    ui.toast(touch.used ? 'Bedroll laid. Use it again here to sleep' : 'Bedroll laid. B beside it to sleep', 5000);
  };
  // ---- the rod: carried on foot, its fork pulls down toward the nearest room under the sand.
  const ROD_R = 350; // metres at which it first stirs
  let rodScan = 0;
  let rodCav: ReturnType<Discoveries['nearestCavern']> = null;
  let rodPull = 0;
  let rodTick = 0;
  // ---- the star chart: at night one line of stars stands over the nearest kind of place not yet found.
  let chartScan = 0;
  let chartAt: { x: number; z: number } | null = null;
  // (worked out over a few frames on the build budget: the search reaches 12 km, and new ground is dear)
  let chartTask: Task<{ x: number; z: number } | null> | null = null;

  // ---- the map: the ground seen so far in ink and wash, and a round over each errand.
  const inkS = { h: 0, rock: 0, salt: 0, green: 0 };
  const mapInk = (x: number, z: number): number => {
    world.sample(x, z, inkS);
    const h = inkS.h;
    const rock = inkS.rock;
    const salt = inkS.salt;
    const green = inkS.green ?? 0;
    // a river is narrower than a cell: a cell is water if the river's line crosses near its middle
    let water = false;
    const rd = world.river(x, z);
    if (Math.abs(rd) < 72) {
      const gx = world.river(x + 6, z) - rd;
      const gz = world.river(x, z + 6) - rd;
      const gl = Math.hypot(gx, gz) || 1;
      // (rivers fade out by cities and on the mountains: only where one is really running)
      water = (world.sample(x - (gx / gl) * rd, z - (gz / gl) * rd, inkS).green ?? 0) > 0.6;
    }
    const site = world.cities.at(x, z);
    return groundInk({
      lit: (world.height(x + 48, z) + world.height(x, z + 48) - 2 * h) / 48,
      rock,
      salt,
      green,
      snow: Math.max(frost ? frostCover(frost, x, z) : 0, smooth(TERRAIN.snowLine, TERRAIN.snowLine + 70, h)),
      water,
      town: 1 - smooth(site.radius * 0.72, site.radius * 0.98, Math.hypot(site.cx - x, site.cz - z)),
    });
  };
  /** What there is to go and look for now, each as a round that holds it. */
  const mapHints = (): MapHint[] => {
    const out: MapHint[] = [];
    const p = player.state.pos;
    const d = save.data;
    const town = world.cities.near(p.x, p.z)[0];
    if (d.roles.miner === 1 && town) {
      if (d.items.lamp) out.push({ x: town.cx, z: town.cz, r: town.radius, label: 'Take the lamp to a miner' });
      else {
        const lamp = lampSpot(town);
        out.push({ ...areaAround(lamp.x, lamp.z, 380), label: 'The miner\'s lamp' });
      }
    }
    // a pick that has opened nothing yet: the nearest room under the sand
    if (save.has('pick') && d.opened.length === 0) {
      const cav = discoveries.nearestCavern(p.x, p.z);
      if (cav) out.push({ ...areaAround(cav.x + cav.dx * cav.spot, cav.z + cav.dz * cav.spot, 450), label: 'A room under the sand' });
    }
    if (d.roles.weaver === 1 && d.items.relic && !save.has('carpet') && town) out.push({ x: town.cx, z: town.cz, r: town.radius, label: 'Take the relic to the carpet stall' });
    const { rope, boots, feather } = atlas.errands;
    if (rope && !save.has('rope')) out.push({ ...areaAround(rope.x, rope.z, 320), label: 'A rope, by the great bones' });
    if (boots && !save.has('boots')) out.push({ ...areaAround(boots.x, boots.z, 380), label: 'Boots, in a mountain cave' });
    if (feather && !save.has('feather')) out.push({ ...areaAround(feather.x, feather.z, 380), label: 'A feather, on the summit' });
    return out;
  };
  const mapState: MapState = { x: 0, z: 0, heading: 0, camp: null, sighted: save.data.sightedAt, hints: [] };
  let mapHintT = 0;
  const readMap = (dt: number): MapState => {
    const p = player.state.pos;
    mapState.x = p.x;
    mapState.z = p.z;
    mapState.heading = player.facing;
    mapState.camp = save.data.camp;
    mapState.sighted = save.data.sightedAt;
    if ((mapHintT -= dt) <= 0) {
      mapHintT = 1;
      mapState.hints = mapHints();
    }
    return mapState;
  };
  let mapShutAt = -1e9; // when the map was last put away
  // The compass points at what the map already shows: each errand until the wanderer is inside
  // its round, the bedroll, and the nearest few places marked through the spyglass.
  const compass = new Compass(canvasHost);
  let compassT = 0;
  const compassThings = (): Thing[] => {
    const p = player.state.pos;
    const out: Thing[] = mapHints().map((h) => ({ x: h.x, z: h.z, kind: 'errand', r: h.r }));
    const camp = save.data.camp;
    if (camp) out.push({ x: camp.x, z: camp.z, kind: 'camp', r: 30 });
    return out.concat(nearest(save.data.sightedAt, p.x, p.z, 8, 'mark', 60));
  };
  // The map is a pause: the world holds still behind the sheet (see tick), the sound is hushed as
  // in the menu, and whatever was held when it opened or shut is let go, so a key held to fly
  // neither slides the sheet about nor carries on steering once it is put away.
  const letGo = () => {
    keys.clear();
    jumpQueued = false;
    glassHeld = false;
    fluteKeyAt = -1;
  };
  const toggleMap = () => {
    if (map.isOpen) {
      map.close();
      mapShutAt = performance.now();
      letGo();
      audio.setPaused(ui.state !== 'playing');
      return;
    }
    if (ui.state !== 'playing' || talk.talking || sleep.isOpen || sleep.asleep || glassK > 0.1) return;
    letGo();
    mapHintT = 0;
    map.open(readMap(0));
    audio.setPaused(true);
    buzz(8);
  };
  const map = new MapView(uiHost, atlas, mapInk, toggleMap);
  let mapButton = false;
  let revealT = 0;
  const freshCells: number[] = [];

  // Step on or off the board. Off, it rides on your back and you walk.
  const toggleBoard = () => {
    if (steed) return dismount();
    if (!save.has('board')) return;
    boardOn = !boardOn;
    player.board = boardOn;
    figure.boardOn = boardOn;
    audio.footstep(0.8, player.state.onRock > 0.5);
    buzz(10);
    touch.setBoard(true, boardOn);
  };
  syncKnown();
  map.setTouch(false);
  touch.onFirstTouch = () => {
    ui.setTouch(true);
    map.setTouch(true);
  };
  // A phone has not been touched yet when the title card appears, so show touch hints from the start.
  if (window.matchMedia?.('(pointer: coarse)').matches) {
    ui.setTouch(true);
    map.setTouch(true);
  }
  let touchMode: TouchMode = 'off';
  const buzz = (ms: number) => {
    if (touch.used && typeof navigator.vibrate === 'function') navigator.vibrate(ms);
  };
  // Mouse events that browsers synthesise after a touch must not move the camera.
  const fromTouch = () => performance.now() - lastTouch < 800;

  const lock = () => {
    if (touch.used) return;
    try {
      const p = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => {});
    } catch {
      /* pointer lock unavailable: dragging still orbits */
    }
  };
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement === canvas || ui.state !== 'playing') return;
    // Esc with the map open puts the map away, and no more than that.
    if (map.isOpen) toggleMap();
    else if (performance.now() - mapShutAt > 300) ui.openMenu();
  });
  window.addEventListener('keydown', (e) => {
    if (ui.state !== 'playing') return;
    // Asked when to wake, the keys answer that and nothing else.
    if (sleep.isOpen || sleep.asleep) {
      if (e.code === 'KeyA' || e.code === 'ArrowLeft') sleep.move(-1);
      else if (e.code === 'KeyD' || e.code === 'ArrowRight') sleep.move(1);
      else if (e.code === 'KeyE' || e.code === 'Enter' || e.code === 'KeyB') sleep.confirm();
      else if (e.code === 'Escape') sleep.close();
      e.preventDefault();
      return;
    }
    // With the map open the keys move the sheet about, and nothing else.
    if (map.isOpen) {
      if ((e.code === 'KeyM' || e.code === 'Escape') && !e.repeat) toggleMap();
      else if (e.code === 'Equal' || e.code === 'NumpadAdd') map.zoomBy(1.25);
      else if (e.code === 'Minus' || e.code === 'NumpadSubtract') map.zoomBy(0.8);
      else keys.add(e.code);
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      return;
    }
    // With the ring of songs open, digits choose, Escape puts it away, and R's release plays.
    if (songRing.isOpen) {
      if (e.code === 'Escape') {
        songRing.close();
        fluteKeyAt = -1;
      } else if (/^Digit[1-5]$/.test(e.code)) songRing.key(Number(e.code.slice(5)));
      else if (e.code !== 'KeyR') keys.add(e.code);
      e.preventDefault();
      return;
    }
    if (e.code === 'Escape') {
      // (the same press that has just put the map away does not go on to open the menu)
      if (performance.now() - mapShutAt > 300) ui.openMenu();
      return;
    }
    if (e.code === 'KeyM' && !e.repeat) toggleMap();
    if (e.code === 'Space') {
      if (!e.repeat) jumpQueued = true;
      e.preventDefault();
    }
    if (e.code === 'KeyE' && !e.repeat) interact();
    if (e.code === 'KeyQ' && !e.repeat) toggleBoard();
    if (e.code === 'KeyF' && !e.repeat) glassHeld = true;
    if (e.code === 'KeyR' && !e.repeat) fluteKeyAt = performance.now();
    if (e.code === 'KeyB' && !e.repeat) useBedroll();
    if (e.code === 'KeyC' && !e.repeat && !e.ctrlKey && !e.metaKey) collisionDebug.toggle(); // debug: collision overlay
    keys.add(e.code);
  });
  window.addEventListener('keyup', (e) => {
    keys.delete(e.code);
    if (e.code === 'KeyF') glassHeld = false;
    if (e.code === 'KeyR') {
      if (songRing.isOpen) {
        const s = songRing.close();
        if (s) {
          lastSong = s;
          playFlute(s);
        }
      } else if (fluteKeyAt >= 0 && ui.state === 'playing') playFlute();
      fluteKeyAt = -1;
    }
  });
  window.addEventListener('blur', () => {
    keys.clear();
    glassHeld = false;
    fluteKeyAt = -1;
    songRing.close();
  });
  canvas.addEventListener('mousedown', () => {
    if (fromTouch()) return;
    dragging = true;
    if (ui.state === 'playing' && document.pointerLockElement !== canvas) lock();
  });
  window.addEventListener('mouseup', () => (dragging = false));
  window.addEventListener('mousemove', (e) => {
    if (fromTouch()) return;
    const locked = document.pointerLockElement === canvas;
    if (!(locked && ui.state === 'playing') && !(dragging && (ui.state === 'playing' || photo))) return;
    if (map.isOpen) return;
    if (songRing.isOpen) return songRing.move(e.movementX, e.movementY);
    if (glassK > 0.5) return glassLook(e.movementX, e.movementY);
    camYaw -= e.movementX * 0.0026;
    camPitch = Math.min(1.25, Math.max(-0.35, camPitch + e.movementY * 0.0022));
  });
  window.addEventListener(
    'wheel',
    (e) => {
      if (map.isOpen) map.zoomBy(Math.exp(-e.deltaY * 0.0015));
      else if (ui.state === 'playing' && glassK > 0.5) glassFov = Math.min(20, Math.max(4, glassFov * Math.exp(e.deltaY * 0.0012)));
      else if (ui.state === 'playing' || photo) camDist = Math.min(photo ? 60 : 16, Math.max(3, camDist * Math.exp(e.deltaY * 0.0012)));
    },
    { passive: true },
  );

  // ---- per-frame state
  const wind = new THREE.Vector2(1, 0);
  const frame: FrameState = {
    dt: 0,
    time: 0,
    day: day.day,
    night: 0,
    sunDir: day.sunDir,
    lightDir: day.lightDir,
    wind,
    gust: 0.5,
    clock: save.data.days,
    storm: 0,
    stormAhead: 0,
    rain: 0,
    wet: 0,
    stormDir: new THREE.Vector2(1, 0),
    weather,
    camera,
    player: player.state,
  };
  save.deferWrites();
  window.addEventListener('pagehide', () => save.flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') save.flush();
  });
  const push = new THREE.Vector2();
  const input: PlayerInput = { x: 0, z: 0, jump: false, lift: false, drop: false, wind, push };
  const camTarget = new THREE.Vector3().copy(player.state.pos);
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const tmpV2 = new THREE.Vector2();
  const sliders: Array<{ x: number; z: number; life: number }> = [];
  let slideStampDist = 0;
  let wakeDist = 0;
  let wakeSound = 0;
  let cityNear = 0;
  let bustle = 0;
  let airCam = 0;
  let openFov = 50; // the field of view without the spyglass, eased
  let camLift = 0; // how much steeper the eye looks down while a wall is behind it, eased
  let clearDist = -1; // how far back the eye sits clear of walls on the surface, eased
  let roomCam = 0; // 0..1 how far the eye has settled into a room's closer, higher view, eased
  let roomReach = 9; // how far back the eye may sit in the room you are in
  let deepDist = -1; // how far back the eye sits underground, eased; -1 up on the sand
  let figNear = false; // the eye is drawn in so close underground that the figure is not shown
  let underK = 0; // 0 under the sky .. 1 well down in a deep, eased
  const camWant = new THREE.Vector3();
  const camProbe = new THREE.Vector3();
  const camSide = new THREE.Vector3();
  const probe = { h: 0, rock: 0, salt: 0 };

  const cascade = (x: number, z: number, count: number) => {
    for (let i = 0; i < count && sliders.length < 40; i++) {
      sliders.push({ x: x + (Math.random() - 0.5) * 1.6, z: z + (Math.random() - 0.5) * 1.6, life: 0.8 + Math.random() * 1.4 });
    }
  };

  const events = {
    step(x: number, z: number, heading: number, side: -1 | 1, slope: number) {
      const rock = player.state.onRock > 0.5;
      const ox = -Math.sin(heading) * 0.17 * side;
      const oz = Math.cos(heading) * 0.17 * side;
      const run = player.state.running;
      // A foot in water throws it up and leaves a ring; nothing of the bed is disturbed.
      if (wading()) {
        splash.burst(x + ox, water.y, z + oz, player.state.vel.x, player.state.vel.z, run ? 0.3 : 0.14);
        splash.ring(x + ox, water.y, z + oz, run ? 1.4 : 1, 1.1);
        audio.splash(run ? 0.36 : 0.22);
        return;
      }
      const prop = rock ? propUnder(x, z, player.state.pos.y) : -1;
      if (prop >= 0) {
        audio.knock(run ? 0.9 : 0.6, prop === 1);
        return;
      }
      if (!rock) {
        trail.stamp(x + ox, z + oz, 0.13, 0.95, heading, 1.9);
        tmp.set(x + ox, player.state.pos.y + 0.05, z + oz);
        tmp2.set(-player.state.vel.x, 1.5, -player.state.vel.z);
        dust.puff(tmp, tmp2, player.state.running ? 0.22 : 0.12);
        // Steep sand lets go and runs downhill from each step.
        if (slope > 0.4) cascade(x, z, slope > 0.55 ? 3 : 1);
      }
      audio.footstep(player.state.running ? 0.9 : 0.6, rock);
    },
    jump() {
      const p = player.state.pos;
      if (wading()) {
        splash.burst(p.x, water.y, p.z, player.state.vel.x, player.state.vel.z, 0.4);
        splash.ring(p.x, water.y, p.z, 1.6, 1.2);
        audio.splash(0.35);
        buzz(8);
        return;
      }
      const prop = propUnder(p.x, p.z, p.y);
      if (prop >= 0) {
        audio.knock(1, prop === 1);
        buzz(8);
        return;
      }
      if (player.state.onRock < 0.5) {
        tmp.copy(player.state.pos);
        tmp2.set(0, 2, 0);
        dust.puff(tmp, tmp2, 0.3);
        trail.stamp(tmp.x, tmp.z, 0.3, 0.8);
      }
      audio.footstep(1, player.state.onRock > 0.5);
      buzz(8);
    },
    land(strength: number) {
      const p = player.state.pos;
      // Into water: a crown of spray and two rings, the second wider and slower.
      if (wading()) {
        splash.burst(p.x, water.y, p.z, player.state.vel.x, player.state.vel.z, 0.4 + 0.6 * strength);
        splash.ring(p.x, water.y, p.z, 1.6 + 1.6 * strength, 1.2);
        splash.ring(p.x, water.y, p.z, 2.6 + 3 * strength, 2);
        audio.splash(0.45 + 0.55 * strength);
        buzz(6 + Math.round(strength * 18));
        return;
      }
      // Onto a stone or a bone: no sand to throw, and a harder sound.
      const prop = propUnder(p.x, p.z, p.y);
      if (prop >= 0) {
        audio.thud(strength, prop === 1);
        buzz(8 + Math.round(strength * 22));
        return;
      }
      if (player.state.onRock < 0.5) {
        trail.stamp(p.x, p.z, 0.35 + strength * 0.6, 1);
        tmp2.copy(player.state.vel).multiplyScalar(0.3).setY(2 + strength * 3);
        dust.puff(p, tmp2, 0.35 + strength * 0.65);
        cascade(p.x, p.z, Math.round(strength * 5));
      }
      audio.land(strength);
      buzz(6 + Math.round(strength * 18));
    },
    lift() {
      audio.lift();
    },
  };

  function update(dt: number) {
    const st = player.state;
    const playing = ui.state === 'playing';
    perf?.mark('pre');
    frame.dt = dt;
    frame.time += dt;
    u.uTime.value = frame.time;

    day.update(dt);
    perf?.mark('day');
    // The heavens: they turn, the moon keeps its phase, and now and then something happens up there.
    {
      if (skyAsk) {
        const want = skyAsk;
        skyAsk = null;
        const ok = (k: number): boolean => {
          const n = nightOf(frame.clock + k, day.day);
          return want === 'shower' ? shower(n)
            : want === 'comet' ? comet(n) >= 1
            : want === 'blood' ? bloodMoon(n)
            : want === 'new' ? moonPhase(n) === 0
            : want === 'full' ? moonPhase(n) === 0.5
            : want === 'eclipse' ? dayOf(frame.clock + k, day.day) % 11 === 3
            : want === 'market' ? monthDay(dayOf(frame.clock + k, day.day)) === 2
            : want === 'herds' ? monthDay(dayOf(frame.clock + k, day.day)) === 5
            : want === 'lanterns' ? monthDay(n) === 4
            : want === 'flood' ? monthDay(n) === 0
            : true;
        };
        for (let k = 0; k < 400 && !ok(k); k++) skyShift = k + 1;
      }
      const open = sky.visible && !player.under ? (1 - frame.storm) * (1 - frame.rain) : 0;
      heavens.group.visible = sky.visible;
      heavens.update(dt, skyClock(), day.day, camera, renderer.getPixelRatio(), glassK, open, knownStars());
      glassView.name(glassK > 0.6 ? heavens.reading : '');
      // On a shower's night one star comes all the way down, once the wanderer has had the sky
      // to look at for a while. Where it lands is theirs to find: nothing marks it but the flash.
      const night = nightOf(skyClock(), day.day);
      if (playing && shower(night) && save.data.fallNight !== night && (u.uStars.value as number) * open > 0.6) {
        fallWatch += dt;
        if (fallWatch > 30) {
          fallWatch = -1e9; // (one try a night: if no ground suits, none falls)
          const st0 = player.state.pos;
          for (let k = 0; k < 14; k++) {
            const a = night * 2.399 + k * 0.9;
            const d = 1300 + ((k * 397) % 1100);
            const x = st0.x + Math.cos(a) * d;
            const z = st0.z + Math.sin(a) * d;
            if (!wreckSuits(x, z, a) || waterAt(x, z)) continue;
            heavens.fall(x - st0.x, z - st0.z, () => {
              save.setFallNight(night);
              starFalls(x, z);
              audio.chime();
            });
            break;
          }
        }
      } else if (!shower(night)) fallWatch = 0;
    }
    // The calendar: what the day of the moon's month brings (see world/calendar.ts).
    {
      const sc = skyClock();
      const today = dayOf(sc, day.day);
      map.monthDay = monthDay(today);
      u.uFlood.value = flood(sc, day.day);
      people.market = market(sc, day.day);
      frame.migrate = migration(sc, day.day);
      const b = migrationBearing(monthOf(today));
      (frame.migrateDir ??= new THREE.Vector2()).set(Math.cos(b), Math.sin(b));
      const fest = festival(sc, day.day);
      if (fest > 0 && (lanternScan -= dt) <= 0) {
        lanternScan = 4;
        lanternFrom.length = 0;
        const p = player.state.pos;
        for (const c of world.cities.near(p.x, p.z).slice(0, 2)) {
          if (Math.hypot(c.cx - p.x, c.cz - p.z) < 9000) lanternFrom.push({ x: c.cx, y: c.groundY, z: c.cz, r: c.radius * 0.55, weight: 12 });
        }
        // every settlement out in the desert, every village, and every hamlet with people in it again
        lanternSites.length = 0;
        let small = 0;
        for (const s of discoveries.sitesNear(p.x, p.z, 3500, lanternSites).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))) {
          if (small >= 6) break;
          const lived = isSettlement(s.kind) || s.kind === 'mountain-village' || s.kind === 'snow-village' || (s.kind === 'hamlet' && save.data.revived.some((r) => r.key === s.key && stageOf(r.kind, r.day, frame.clock) >= 2));
          if (!lived) continue;
          small++;
          lanternFrom.push({ x: s.x, y: world.height(s.x, s.z), z: s.z, r: 22, weight: 1 });
        }
      }
      lanterns.update(dt, fest * (1 - frame.storm) * (1 - frame.rain), lanternFrom, frame.wind, frame.gust, renderer.getPixelRatio());
    }
    frame.day = day.day;
    frame.night = day.night;
    // Down in a deep there is no daylight, no haze and no wind: what moves there is dark but for
    // the lamps (uDeepDark, uCavGlow), and nothing of the open desert is stirred up round it.
    const deepIn = discoveries.deepIn;
    {
      const want = deepIn ? smooth(0.5, 5, deepIn.spec.y - (st.pos.y + 1)) : 0;
      underK = dt > 0 ? underK + (want - underK) * (1 - Math.exp(-dt * 4)) : underK;
      if (Math.abs(want - underK) < 0.002) underK = want;
      u.uDeepDark.value = underK;
      u.uFog.value *= 1 - underK;
      dust.under = underK > 0.5;
      wildlife.group.visible = underK < 0.99;
      // Under the lid the open desert is not drawn at all: a deep is a closed shell, and any
      // crack in it should show the dark, never the sky and the hills.
      const shut = !!deepIn && st.pos.y < deepIn.spec.y + deepIn.spec.lid - 1;
      massifs.group.visible = cities.group.visible = clipmap.group.visible = props.group.visible = !shut;
      // and the sky goes sooner, as soon as the stair is a little way down the well
      sky.visible = !(deepIn && st.pos.y < deepIn.spec.y - 1.2);
    }

    // Wind wanders slowly in direction and strength.
    const wa = 0.7 + Math.sin(frame.time * 0.011) * 0.5 + Math.sin(frame.time * 0.0037 + 2) * 0.4;
    wind.set(Math.cos(wa), Math.sin(wa));
    (u.uWind.value as THREE.Vector2).copy(wind);
    frame.gust = 0.5 + 0.3 * Math.sin(frame.time * 0.07) + 0.2 * Math.sin(frame.time * 0.19 + 1.3);

    // The world's clock runs while the game is played, and the storms run on it.
    if (playing) {
      frame.clock += dt / DAY_SECONDS;
      save.setDays(frame.clock);
    }
    if ((revivedT -= dt) <= 0) {
      revivedT = 1;
      syncRevived();
    }
    {
      const px = st.pos.x;
      const pz = st.pos.z;
      if (stormAsk) {
        weather.sent = weather.aim(frame.clock, px, pz, stormAsk === 'in' ? -1 : 60);
        stormAsk = null;
      }
      if (rainAsk) {
        const r = weather.aim(frame.clock, px, pz, rainAsk === 'near' ? 45 : -1, 'rain');
        if (rainAsk === 'after') {
          // shifted back in time so it ended three minutes ago, and the ground is freshly wet
          const shift = r.t1 - frame.clock + 3 / (24 * 60);
          r.t0 -= shift;
          r.t1 -= shift;
        }
        weather.sentRain = r;
        rainAsk = null;
      }
      // Nobody goes long without one. If none has come the wanderer's way for a couple of days
      // (or by the second day of a new save), one is sent: born upwind, an hour and a half off.
      if (playing && (stormCheck -= dt) <= 0) {
        stormCheck = 5;
        const sent = weather.sent;
        if (sent && sent.t1 <= frame.clock) {
          weather.sent = null;
          if (save.data.sent) save.setSent(null);
        }
        const due = save.data.stormDay === null ? 1 : save.data.stormDay + 2.5;
        if (weather.enabled && !weather.sent && frame.clock >= due && frame.stormAhead <= 0 && !deepIn) {
          // (not to someone up a mountain, where it could not follow)
          const s = guard.shelter(px, pz) > 0 ? null : weather.aim(frame.clock, px, pz, 1.5 * HOUR_SECONDS);
          if (s) {
            weather.sent = s;
            save.setSent(s);
            save.setStormDay(frame.clock);
          }
        }
        // And the same, far more rarely, for rain: sent when none has fallen on the wanderer for nine
        // days (or by the third day of a new save), if no sandstorm is near and none is sent.
        const sr = weather.sentRain;
        if (sr && sr.t1 + 1 <= frame.clock) {
          weather.sentRain = null;
          if (save.data.sentRain) save.setSentRain(null);
        }
        const rainDue = save.data.rainDay === null ? frame.clock >= 3 : frame.clock >= save.data.rainDay + 9;
        if (
          weather.enabled &&
          rainDue &&
          !weather.sentRain &&
          !weather.sent &&
          frame.stormAhead <= 0 &&
          frame.rain <= 0 &&
          weather.rain(frame.clock, px, pz) <= 0 &&
          weather.storms(frame.clock, px, pz, 6000).every((s) => s.kind !== 'rain') &&
          !deepIn
        ) {
          const r = weather.aim(frame.clock, px, pz, 2 * HOUR_SECONDS, 'rain');
          weather.sentRain = r;
          save.setSentRain(r);
          save.setRainDay(frame.clock);
        }
      }
      // Underground there is no storm, and between a town's walls only the noise of one.
      const open = (1 - underK) * (cities.inside ? 0.2 : 1);
      frame.storm = weather.density(frame.clock, px, pz) * open;
      frame.stormAhead = Math.max(weather.ahead(frame.clock, px, pz) * (1 - underK), frame.storm);
      weather.heading(frame.clock, px, pz, frame.stormDir);
      frame.rain = weather.rain(frame.clock, px, pz) * (1 - underK);
      frame.wet = weather.wetAt(frame.clock, px, pz);
      if (frame.rain > 0.5 && (save.data.rainDay === null || frame.clock - save.data.rainDay > 0.05)) save.setRainDay(frame.clock);
      if (frame.storm > 0.5 && (save.data.stormDay === null || frame.clock - save.data.stormDay > 0.05)) save.setStormDay(frame.clock);
      push.copy(frame.stormDir).multiplyScalar(frame.storm);
      // The wind song: the air behind the wanderer, the way they are going, as strong as a storm's.
      if (windT > 0 && push.lengthSq() < 1) {
        const vl = Math.hypot(st.vel.x, st.vel.z);
        if (vl > 0.1) push.set(st.vel.x / vl, st.vel.z / vl);
        else push.set(Math.sin(player.facing), Math.cos(player.facing));
      }
      // The wind comes round to the way the storm is going, and rises with it.
      if (frame.stormAhead > 0) {
        const k = frame.stormAhead;
        wind.lerp(frame.stormDir, k);
        if (wind.lengthSq() < 1e-6) wind.copy(frame.stormDir);
        wind.normalize();
        (u.uWind.value as THREE.Vector2).copy(wind);
        frame.gust += (1 - frame.gust) * k;
      }
    }

    const mode: TouchMode = playing ? 'play' : photo ? 'photo' : 'off';
    if (mode !== touchMode) touch.setMode((touchMode = mode));
    const kx = keyX();
    const kz = keyZ();
    // The spyglass comes up only where there is something to see through it, and whoever looks stands still.
    {
      if (!playing) glassHeld = false;
      const want = glassHeld && playing && save.has('spyglass') && !talk.talking && !deepIn && !cities.inside && swingT < 0 && fluteT <= 0;
      if (want && glassK < 0.02) {
        glassPitch = 0.02;
        glassFov = GLASS_FOV;
      }
      if (dt > 0) glassK += ((want ? 1 : 0) - glassK) * (1 - Math.exp(-dt * 11));
      if (glassK < 0.004) glassK = 0;
    }
    if (!playing && sleep.isOpen) sleep.close();
    // The map: what is stood in is seen (not from down in a deep). While the sheet is open the
    // world is not stepped at all and tick keeps the sheet (and puts it away on leaving play).
    if (playing !== mapButton) map.setButton((mapButton = playing));
    if ((revealT -= dt) <= 0) {
      revealT = 0.25;
      if (!deepIn && !player.under) {
        freshCells.length = 0;
        // (from the air more of it lies in view)
        if (atlas.reveal(st.pos.x, st.pos.z, 480 + Math.min(420, Math.max(0, player.alt) * 14), freshCells) > 0) map.fresh(freshCells);
      }
    }
    const mapOpen = map.isOpen;
    if (!mapOpen) map.update(dt, null);
    const still = glassK > 0.5 || fluteT > 0 || sleep.isOpen || sleep.asleep || mapOpen;
    input.x = playing && !still ? Math.max(-1, Math.min(1, kx + touch.moveX)) : 0;
    input.z = playing && !still ? Math.max(-1, Math.min(1, kz + touch.moveZ)) : 0;
    input.jump = playing && !mapOpen && jumpQueued;
    input.lift = playing && !mapOpen && (keys.has('Space') || touch.flyHeld);
    input.drop = playing && !mapOpen && touch.dropHeld;
    jumpQueued = false;
    // Near the things found in the desert a fast move is taken in short steps, so a rib a
    // hand's width across is not stepped clean over between two frames.
    {
      if (steed && (deepIn || cities.inside)) dismount();
    const sd = steed;
    if (sd) {
      // On an animal's back: it is steered and the rider goes where it goes. No leaping, gliding or flying.
      jumpQueued = false;
      const fx = -Math.sin(camYaw);
      const fz = -Math.cos(camYaw);
      const wx = fx * input.z - fz * input.x;
      const wz = fz * input.z + fx * input.x;
      sd.ride(dt, wx, wz);
      const m = sd.seat;
      if (m) {
        st.pos.set(m.x, world.height(m.x, m.z) + m.back - 0.58, m.z);
        figure.saddle = m.sway ?? null;
        st.vel.set(Math.sin(m.yaw) * m.spd, 0, Math.cos(m.yaw) * m.spd);
        st.speed = m.spd;
        st.grounded = true;
        st.sliding = false;
        st.running = m.spd > 1;
        st.onRock = world.sample(m.x, m.z, probe).rock;
        player.facing = m.yaw;
        player.turn = m.turn;
        player.gliding = player.lifting = false;
        player.alt = 0;
      }
    } else {
        const near = dt > 0 && (!!deepIn || discoveries.nearSolids(st.pos.x, st.pos.z, 15) || props.nearSolids(st.pos.x, st.pos.z, 15));
        const steps = near ? Math.min(8, Math.max(1, Math.ceil((Math.hypot(st.vel.x, st.vel.y, st.vel.z) * dt) / 0.3))) : 1;
        const h = dt / steps;
        for (let i = 0; i < steps; i++) {
          if (i > 0) input.jump = false;
          // You cannot rise through a stone you are under: slow to meet its underside, and stay below it.
          let under = Infinity;
          if (near && !st.grounded) {
            under = Math.min(discoveries.ceilAt(st.pos.x, st.pos.z, st.pos.y), props.ceilAt(st.pos.x, st.pos.z, st.pos.y)) - 1.9;
            if (st.vel.y > 0 && st.pos.y + st.vel.y * h > under) st.vel.y = Math.max(0, (under - st.pos.y) / h);
          }
          player.update(h, input, camYaw, events);
          if (near && !st.grounded) {
            const uy = Math.min(st.pos.y, under);
            under = Math.min(discoveries.ceilAt(st.pos.x, st.pos.z, uy), props.ceilAt(st.pos.x, st.pos.z, uy)) - 1.9;
            if (st.pos.y > under) {
              st.pos.y = under;
              if (st.vel.y > 0) st.vel.y = 0;
            }
          }
          // Nor through the rock over a room of a deep: a leap or a carpet is held under its
          // ceiling (and never pressed into the floor where the two are close).
          if (deepIn && !st.grounded) {
            const lim = deepIn.ceilAt(st.pos.x, st.pos.z, st.pos.y) - 1.9;
            if (st.pos.y > lim) {
              const fl = deepIn.floorAt(st.pos.x, st.pos.z, st.pos.y);
              st.pos.y = Math.max(lim, fl !== null && Number.isFinite(fl) ? Math.min(fl, st.pos.y) : lim);
              if (st.vel.y > 0) st.vel.y = 0;
            }
          }
        }
    }
    }
    // A cave has a ceiling: you cannot rise through the rock.
    {
      const ceil = ceilAt(st.pos.x, st.pos.z);
      inCave = ceil < Infinity && st.pos.y < ceil - 0.3;
      if (inCave && st.pos.y > ceil - 1.9) {
        st.pos.y = ceil - 1.9;
        if (st.vel.y > 0) st.vel.y = 0;
      }
      // and a room its ceiling (and its doorway a lintel): no rising through to the roof
      const roomCeil = cities.ceilAt(st.pos.x, st.pos.z, st.pos.y);
      if (st.pos.y > roomCeil - HEADROOM - 0.02) {
        st.pos.y = roomCeil - HEADROOM - 0.02;
        if (st.vel.y > 0) st.vel.y = 0;
      }
    }

    // Riding leaves one clean line in the sand; carving widens it and throws spray to the outside.
    const wet = st.grounded && wading();
    if (wet && st.speed > 0.6) {
      // Moving through water: a ring every stride's length, and riding through it throws spray.
      wakeDist += st.speed * dt;
      if (wakeDist > 0.8) {
        wakeDist = 0;
        splash.ring(st.pos.x, water.y, st.pos.z, 0.8 + Math.min(1.6, st.speed * 0.08), 1.1);
        if (st.sliding) {
          const k = Math.min(1, st.speed / 30);
          splash.burst(st.pos.x, water.y, st.pos.z, st.vel.x, st.vel.z, 0.12 + 0.4 * k);
          wakeSound += 0.8;
          if (wakeSound > 2.4) {
            wakeSound = 0;
            audio.splash(0.2 + 0.3 * k);
          }
        }
      }
    }
    if (st.sliding && st.grounded && st.onRock < 0.5 && !wet) {
      const carve = Math.min(1, Math.abs(player.turn) * st.speed * 0.045);
      slideStampDist += st.speed * dt;
      if (slideStampDist > 0.16) {
        slideStampDist = 0;
        // elongated along the direction of travel so successive marks join into one line
        trail.stamp(st.pos.x, st.pos.z, 0.15 + carve * 0.22, 0.6 + carve * 0.35, Math.atan2(st.vel.z, st.vel.x), 3);
        if (player.slope > 0.4 && Math.random() < 0.3) cascade(st.pos.x, st.pos.z, 1);
      }
      const spray = Math.min(1, carve * 0.9 + Math.max(0, st.speed - 20) * 0.04);
      if (spray > 0.05) {
        // outside of the turn: to the right of travel when turning left
        const side = player.turn > 0 ? -1 : 1;
        tmp2.set(st.vel.x * 0.6 + st.vel.z * side * 0.5, 0, st.vel.z * 0.6 - st.vel.x * side * 0.5);
        dust.spray(st.pos, tmp2, spray);
      }
    }
    for (let i = sliders.length - 1; i >= 0; i--) {
      const s = sliders[i];
      world.normal(s.x, s.z, tmp);
      const sl = Math.hypot(tmp.x, tmp.z);
      s.life -= dt;
      if (s.life <= 0 || sl < 0.15) {
        sliders.splice(i, 1);
        continue;
      }
      s.x += (tmp.x / sl) * 3.2 * dt;
      s.z += (tmp.z / sl) * 3.2 * dt;
      trail.stamp(s.x, s.z, 0.22, 0.3 * Math.min(1, s.life));
    }

    // A swing of the pick: up over the shoulder, down hard, and a moment held where it landed.
    if (swingT >= 0) {
      swingT += dt;
      const k = swingT / SWING;
      if (!swingHit && k >= SWING_HIT) {
        swingHit = true;
        strike();
      }
      // the figure's pose runs 0.5 (low in front) .. 1 = 0 (raised) .. 0.5 (struck)
      const rise = Math.min(1, k / 0.3);
      const fall = Math.min(1, Math.max(0, (k - 0.3) / (SWING_HIT - 0.3)));
      figure.swing = k < 0.3 ? 0.5 + 0.5 * rise * rise * (3 - 2 * rise) : 0.5 * fall * fall;
      if (k >= 1 || !st.grounded) {
        swingT = -1;
        figure.swing = -1;
      }
    }
    // The flute: the phrase plays out, and partway through it the song takes (the call carries).
    if (fluteT > 0) {
      fluteT -= dt;
      if (fluteCall >= 0 && (fluteCall -= dt) < 0) songTakes(fluteSong);
      // the phrase over, a place that heard it answers with its own
      if (fluteT <= 0 && teachSong) answerT = Math.max(0.1, audio.answer(teachSong));
    }
    if (answerT >= 0 && (answerT -= dt) < 0 && teachSong) {
      const song = teachSong;
      teachSong = null;
      save.learn(song);
      audio.chime('learned');
      buzz(30);
      say(LEARNED[song]);
    }
    // Held past a moment, the flute key opens the ring of songs instead (knowing only the call,
    // holding does nothing special: it plays on release).
    if (fluteKeyAt >= 0 && !songRing.isOpen && performance.now() - fluteKeyAt > FLUTE_HOLD_MS && ui.state === 'playing' && canPipe() && knownSongs().length > 1) openSongs(false);
    if (songRing.isOpen && ui.state !== 'playing') songRing.close();
    if (windT > 0) {
      windT -= dt;
      frame.gust = Math.max(frame.gust, 1);
      if (windT <= 0) windRest = WIND_REST;
    } else if (windRest > 0) windRest -= dt;
    figure.piping = fluteT > 0.15 ? 1 : 0;
    figure.climbing = player.roping ? 1 : 0;
    // The rod is held out wherever the wanderer goes on foot within its reach of a sealed room,
    // and pulls harder the nearer the spot and the more squarely it is faced.
    {
      const onFoot = playing && save.has('rod') && st.grounded && !steed && (!player.riding || (st.onRock > 0.5 && !st.sliding)) && !deepIn && !cities.inside && !talk.talking && swingT < 0 && fluteT <= 0 && glassK < 0.1;
      rodScan -= dt;
      if (rodScan <= 0) {
        rodScan = 0.5;
        rodCav = onFoot ? discoveries.nearestCavern(st.pos.x, st.pos.z, true) : null;
      }
      let pull = 0;
      let held = 0;
      if (onFoot && rodCav && rodCav.open <= 0) {
        const dx = rodCav.x + rodCav.dx * rodCav.spot - st.pos.x;
        const dz = rodCav.z + rodCav.dz * rodCav.spot - st.pos.z;
        const d = Math.hypot(dx, dz);
        const near = Math.min(1, Math.max(0, 1 - d / ROD_R));
        if (near > 0) {
          held = 1;
          const facing = d > 1 ? (dx * Math.sin(player.facing) + dz * Math.cos(player.facing)) / d : 1;
          pull = d < 5 ? 1 : Math.pow(near, 1.6) * (0.3 + 0.7 * Math.max(0, facing));
        }
      }
      rodPull += (pull - rodPull) * (1 - Math.exp(-dt * 5));
      figure.dowsing = held;
      figure.dip = rodPull;
      audio.dowse(held ? rodPull : 0);
      // (in the hand it is felt before it is seen)
      if (rodPull > 0.25 && (rodTick -= dt) <= 0) {
        rodTick = 1.3 - rodPull;
        buzz(6 + Math.round(rodPull * 14));
      }
    }
    // The chart's line of stars: over the nearest kind of place not yet come upon.
    {
      chartScan -= dt;
      if (chartScan <= 0) {
        chartScan = 2.5;
        if (!(save.has('chart') && day.night > 0.3)) {
          chartTask = null;
          chartAt = null;
        } else chartTask ??= new Task(discoveries.unfoundJob(st.pos.x, st.pos.z, new Set<string>(save.data.found), 12000));
      }
      if (chartTask?.run()) {
        chartAt = chartTask.value ?? null;
        chartTask = null;
      }
      const want = chartAt && !deepIn ? smooth(0.5, 0.95, day.night) : 0;
      u.uChart.value += (want - (u.uChart.value as number)) * (1 - Math.exp(-dt * 1.5));
      if (chartAt) {
        const dx = chartAt.x - st.pos.x;
        const dz = chartAt.z - st.pos.z;
        const dl = Math.hypot(dx, dz) || 1;
        const dir = u.uChartDir.value as THREE.Vector2;
        dir.lerp(tmpV2.set(dx / dl, dz / dl), 1 - Math.exp(-dt * 2)).normalize();
      }
    }
    {
      const sp = Math.max(st.speed, 0.01);
      const slopeAlong = st.grounded ? -(st.vel.x * player.downhill.x + st.vel.z * player.downhill.y) / sp * player.slope : 0;
      figure.update(dt, st, player.facing, wind, frame.gust, { turn: player.turn, slopeAlong, gliding: player.gliding, lifting: player.lifting, alt: player.alt });
      touch.setAirborne(!st.grounded);
    }


    // Flying low drags a faint wake through the sand.
    if (!st.grounded && player.alt < 2 && st.speed > 6 && !player.under) {
      slideStampDist += st.speed * dt;
      if (slideStampDist > 0.5) {
        slideStampDist = 0;
        const near = 1 - player.alt / 2;
        if (waterAt(st.pos.x, st.pos.z) && st.pos.y - water.y < 2) {
          // skimming water: it is the surface that answers, not the sand
          splash.ring(st.pos.x, water.y, st.pos.z, 1.2 + near, 1.3);
          if (Math.random() < 0.6 * near) splash.burst(st.pos.x, water.y, st.pos.z, st.vel.x, st.vel.z, 0.12 * near);
        } else if (world.sample(st.pos.x, st.pos.z, probe).rock < 0.5) {
          trail.stamp(st.pos.x, st.pos.z, 0.55, 0.22 * near, Math.atan2(st.vel.z, st.vel.x), 2);
          if (Math.random() < 0.5 * near) {
            tmp.set(st.pos.x, st.pos.y - player.alt + 0.05, st.pos.z);
            tmp2.set(st.vel.x * 0.3, 1.2, st.vel.z * 0.3);
            dust.puff(tmp, tmp2, 0.12 * near);
          }
        }
      }
    }
    airCam += ((st.grounded ? 0 : 1) - airCam) * (1 - Math.exp(-dt * 1.8));
    (u.uFigPos.value as THREE.Vector3).copy(st.pos);

    // Camera: orbit behind the figure, kept above the sand.
    if (ui.state === 'title' || ui.state === 'intro') camYaw += dt * 0.05;
    if (talk.talking && !wasTalking) {
      // look from behind the player toward the speaker, turned ~35 degrees to whichever side is nearer
      const sp = talk.speaker;
      const base = Math.atan2(st.pos.x - sp.x, st.pos.z - sp.z);
      const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
      const a = base + 0.6;
      const b = base - 0.6;
      talkYaw = Math.abs(wrap(a - camYaw)) < Math.abs(wrap(b - camYaw)) ? a : b;
      talkEase = 1.4;
    }
    wasTalking = talk.talking;
    if (talkEase > 0 && talk.talking && !dragging) {
      talkEase -= dt;
      const k = 1 - Math.exp(-dt * 4);
      camYaw += Math.atan2(Math.sin(talkYaw - camYaw), Math.cos(talkYaw - camYaw)) * k;
      camPitch += (Math.max(camPitch, 0.42) - camPitch) * k;
      camDist += (Math.max(camDist, 6.5) - camDist) * k;
    } else talkEase = 0;
    tmp.copy(st.pos);
    tmp.y += 1.5;
    camTarget.lerp(tmp, 1 - Math.exp(-dt * 12));
    // Inside a room the roof is drawn away and the eye comes in closer and looks down from a
    // little higher, eased in as you cross the threshold and back out as you leave.
    cities.interior(dt, st.pos, camera.position);
    {
      const rm = cities.inside;
      if (rm) roomReach = Math.min(9, Math.max(3.2, 0.55 * Math.min(rm.x1 - rm.x0, rm.z1 - rm.z0) + 1.6));
      roomCam += ((rm ? 1 : 0) - roomCam) * (1 - Math.exp(-dt * 3));
    }
    const reach0 = camDist * (1 + 0.6 * airCam);
    const reach = reach0 + (Math.min(reach0, roomReach) - reach0) * roomCam;
    const pitch0 = camPitch + (Math.max(camPitch, 0.5) - camPitch) * roomCam;
    // Against a wall the eye is lifted: of a few steeper angles, the one that leaves the most
    // room (a little steeper costs a little room) is eased into, so the figure is seen from above
    // the wall instead of from inside it. Open ground leaves the angle alone.
    if (!discoveries.deepIn) {
      let bestLift = 0;
      let maxFree = 0;
      const frees = [0, 0, 0, 0];
      for (let l = 0; l <= 3; l++) {
        const pitch = Math.min(Math.max(pitch0, 1.05), pitch0 + l * 0.3);
        const c2 = Math.cos(pitch);
        const dx = Math.sin(camYaw) * c2;
        const dy = Math.sin(pitch);
        const dz = Math.cos(camYaw) * c2;
        let free = reach;
        for (let d = 0.4; d <= reach; d += 0.3) {
          const x = camTarget.x + dx * d;
          const y = camTarget.y + dy * d;
          const z = camTarget.z + dz * d;
          if (cities.solidAt(x, y, z, 0.3) || discoveries.solidAt(x, y, z, 0.3)) {
            free = d - 0.3;
            break;
          }
        }
        frees[l] = free;
        maxFree = Math.max(maxFree, free);
        // (open all the way back: the first such angle will do, and the flattest is preferred)
        if (free >= reach) {
          bestLift = l * 0.3;
          maxFree = Infinity;
          break;
        }
      }
      // the steepest angle that costs hardly any room: as high as the wall and roof allow
      // (a nook too tight for any angle to leave real room is left level: looking straight down
      // from a hand's width above the head shows nothing but floor)
      if (maxFree < Infinity) for (let l = 0; l <= 3; l++) if (frees[l] >= Math.max(1.5, maxFree * 0.85)) bestLift = l * 0.3;
      camLift += (bestLift - camLift) * (1 - Math.exp(-dt * (bestLift > camLift ? 5 : 1.5)));
    } else camLift = 0;
    const lp = Math.min(pitch0 + camLift, Math.max(pitch0, 1.05));
    const cp = Math.cos(lp);
    tmp2.set(Math.sin(camYaw) * cp, Math.sin(lp), Math.cos(camYaw) * cp);
    // pull back and rise a little while airborne
    tmp2.y += 0.12 * airCam;
    tmp2.normalize();
    let dist = reach;
    // Down in a deep the camera is drawn in until nothing of the rock stands between it and
    // the figure. The ground overhead is nothing to it there: only above the antechamber floor
    // (looking back up the stair) is the terrain in the way as well.
    let far = reach;
    let above = -Infinity;
    if (deepIn) {
      camWant.copy(camTarget).addScaledVector(tmp2, reach);
      // (four lines, not one: to the eye itself, to either side of it and over it, so the eye
      // keeps clear of a wall it runs along and of the roughness the rock is drawn with)
      let open = deepIn.sight(camTarget, camWant);
      const sx = tmp2.z;
      const sz = -tmp2.x;
      const sl = Math.hypot(sx, sz) || 1;
      for (let q = 0; q < 3; q++) {
        camProbe.copy(camWant);
        if (q === 2) camProbe.y += 0.7;
        else camProbe.addScaledVector(camSide.set(sx / sl, 0, sz / sl), q === 0 ? 0.8 : -0.8);
        open = Math.min(open, deepIn.sight(camTarget, camProbe));
      }
      // (right in to the figure's head if need be: standing against a wall with the eye turned
      // into it, any least distance kept would put the eye inside the rock)
      const got = reach * Math.min(1, Math.max(0, open));
      // The room there is behind the figure jumps about as it walks: every step of a stepped
      // roof, every jog of a wall. Followed to the letter that shakes the whole view, so the
      // eye is eased: quickly in, slowly back out, and never past the rock itself.
      const want = Math.max(0.12, got - Math.min(0.6, got * 0.5));
      if (deepDist < 0 || dt <= 0) deepDist = want;
      else deepDist += (want - deepDist) * (1 - Math.exp(-dt * (want < deepDist ? 9 : 0.8)));
      deepDist = Math.min(deepDist, Math.max(0.12, got - 0.12));
      far = dist = deepDist;
      above = deepIn.spec.y - 0.1;
    } else deepDist = -1;
    for (let i = 1; i <= 6; i++) {
      const d = (far * i) / 6;
      if (camTarget.y + tmp2.y * d < above) continue;
      const x = camTarget.x + tmp2.x * d;
      const z = camTarget.z + tmp2.z * d;
      const clear = camTarget.y + tmp2.y * d - (topAt(x, z) + 0.45);
      if (clear < 0) {
        dist = Math.min(dist, Math.max(Math.min(1.2, far), d + clear / Math.max(0.2, tmp2.y + 0.6)));
        break;
      }
    }
    // Walls and roofs of buildings, shrines and ruins stand in the eye's way too: it is drawn in
    // until nothing solid is between it and the figure. Quickly in, slowly back out, so a pass
    // along a doorway or a ragged wall does not shake the view.
    let hit = Infinity;
    if (!deepIn && dist > 0.3) {
      for (let d = 0.4; d <= dist; d += 0.2) {
        const x = camTarget.x + tmp2.x * d;
        const y = camTarget.y + tmp2.y * d;
        const z = camTarget.z + tmp2.z * d;
        if (cities.solidAt(x, y, z, 0.3) || discoveries.solidAt(x, y, z, 0.3)) {
          hit = Math.max(0.12, d - 0.3);
          break;
        }
      }
    }
    const room = Math.min(hit, dist);
    if (clearDist < 0 || dt <= 0) clearDist = room;
    else clearDist += (room - clearDist) * (1 - Math.exp(-dt * (room < clearDist ? 14 : 1.4)));
    clearDist = Math.min(clearDist, hit); // never past the wall itself
    const walled = clearDist < dist - 0.01;
    if (walled) dist = Math.max(0.12, clearDist);
    camera.position.copy(camTarget).addScaledVector(tmp2, dist);
    // drawn right in against a wall, the eye is inside the figure: see past it, not its lining
    const tooNear = (!!deepIn || walled) && dist < 0.75;
    if (tooNear !== figNear) {
      figNear = tooNear;
      figure.group.visible = !tooNear && !glassHid;
    }
    if (camera.position.y >= above) {
      camera.position.y = Math.max(camera.position.y, topAt(camera.position.x, camera.position.z) + 0.7);
      if (inCave) camera.position.y = Math.min(camera.position.y, ceilAt(camera.position.x, camera.position.z) - 0.4);
    } else if (deepIn) {
      // a little clear of the floor it hangs over and the ceiling it hangs under
      const cy = camera.position.y;
      const fl = deepIn.floorAt(camera.position.x, camera.position.z, cy);
      if (fl !== null && fl + 0.35 > cy && fl < cy + 0.6) camera.position.y = fl + 0.35;
      const cl = deepIn.ceilAt(camera.position.x, camera.position.z, cy);
      if (cl - 0.3 < camera.position.y && cl > cy - 0.6) camera.position.y = Math.max(cy - 0.6, cl - 0.3);
    }
    camera.lookAt(camTarget);
    const fov = 50 + Math.min(14, st.speed * 0.55);
    openFov += (fov - openFov) * (1 - Math.exp(-dt * 3));
    // Underground the eye is often a hand's width from a wall, and the half metre it does not
    // draw in front of itself up on the sand would cut a window through one.
    const near = deepIn || walled ? 0.06 : 0.5;
    // At the spyglass the eye leaves its place behind the figure for the figure's own, and
    // looks out along the glass.
    const gk = glassK * glassK * (3 - 2 * glassK);
    if (gk > 0) {
      const gp = Math.cos(glassPitch);
      const fx = -Math.sin(camYaw) * gp;
      const fy = Math.sin(glassPitch);
      const fz = -Math.cos(camYaw) * gp;
      const ex = st.pos.x + fx * 0.3;
      const ey = st.pos.y + 1.6;
      const ez = st.pos.z + fz * 0.3;
      camera.position.lerp(tmp.set(ex, ey, ez), gk);
      camera.lookAt(tmp.set(ex + fx * 400, ey + fy * 400, ez + fz * 400).lerp(camTarget, 1 - gk));
      // A far place held near the middle of the glass, in plain sight, is being sighted.
      if (glassK > 0.9 && dt > 0) {
        sightScan -= dt;
        if (sightScan <= 0) {
          sightScan = 0.2;
          let best: number | null = null;
          let bestCos = Math.cos((glassFov * Math.PI) / 180 * 0.3);
          for (const sr of discoveries.sitesNear(st.pos.x, st.pos.z, SIGHT_RANGE, sites)) {
            // (a sealed cavern is only sand to look at: there is nothing of it to sight)
            if (sr.reached || sr.kind === 'cavern' || save.data.sighted.includes(sr.key)) continue;
            const ty = sr.y + 7;
            const dx = sr.x - ex;
            const dy = ty - ey;
            const dz = sr.z - ez;
            const dl = Math.hypot(dx, dy, dz);
            if (dl < 150) continue;
            const c = (dx * fx + dy * fy + dz * fz) / dl;
            if (c < bestCos || Math.exp(-dl * (u.uFog.value as number)) < 0.05 || !sightClear(ex, ey, ez, sr.x, ty, sr.z)) continue;
            bestCos = c;
            best = sr.key;
            sightAt.x = sr.x;
            sightAt.z = sr.z;
          }
          if (best !== sightKey) {
            sightKey = best;
            sightT = 0;
          }
        }
        if (sightKey !== null && (sightT += dt) >= SIGHT_HOLD) {
          save.sight(sightKey, sightAt.x, sightAt.z);
          syncMarks();
          audio.chime();
          buzz(20);
          ui.toast('Marked', 2200);
          sightKey = null;
          sightT = 0;
          sightScan = 0.6;
        }
      }
    } else sightKey = null;
    glassView.set(glassK, sightKey !== null ? sightT / SIGHT_HOLD : 0);
    const compassOn = playing && glassK < 0.5 && !mapOpen && !sleep.isOpen && !sleep.asleep;
    if (compassOn && (compassT -= dt) <= 0) {
      compassT = 1;
      // (in a storm there is no telling which way anything lies)
      compass.setThings(frame.storm > 0.5 ? [] : compassThings());
    }
    compass.update(compassOn, camYaw, st.pos.x, st.pos.z);
    if (glassK > 0.5 !== glassHid) {
      glassHid = glassK > 0.5;
      figure.group.visible = !glassHid && !figNear;
    }
    const wantFov = openFov + (glassFov - openFov) * gk;
    if (Math.abs(camera.fov - wantFov) > 0.01 || camera.near !== near) {
      camera.fov = wantFov;
      camera.near = near;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
    sky.position.copy(camera.position);

    // Speech is drawn over the scene, so it is placed once the camera has settled.
    talk.setKey(touch.used ? '' : 'E');
    if (playing && !talk.talking) scanRide();
    else rideNear.src = null;
    talk.update(camera, st.pos.x, st.pos.z, playing);
    const stoneAt = playing && !talk.talking ? discoveries.stoneAt(st.pos.x, st.pos.y, st.pos.z) : null;
    touch.setTalk(talk.available || stoneAt !== null, canDig() && st.onRock < 0.5, !playing ? null : steed ? 'off' : rideNear.src ? 'on' : null);
    // Standing where a strike would count, with a pick: the key shows over the cracked sand.
    {
      const cv = playing && canDig() && !discoveries.drainingCavern ? discoveries.sealedNear(st.pos.x + Math.sin(player.facing) * 0.75, st.pos.z + Math.cos(player.facing) * 0.75, discoveries.digReach) : null;
      if (cv) {
        digAt.x = cv.x + cv.dx * cv.spot;
        digAt.z = cv.z + cv.dz * cv.spot;
        digAt.y = world.height(digAt.x, digAt.z) + 0.9;
      }
      if (stoneAt) {
        digAt.x = stoneAt[0];
        digAt.y = stoneAt[1] + 0.4;
        digAt.z = stoneAt[2];
      }
      // (in the order the key takes them: a stone to wake, a beast to climb onto, sand to strike)
      talk.mark(camera, stoneAt ? digAt : rideNear.src ? rideAt : cv ? digAt : null);
    }

    // On the lit sand itself, on foot or on the board: a line about what lies under it.
    if ((hintScan -= dt) <= 0) {
      hintScan = 0.25;
      if (playing && st.grounded && !steed && !deepIn && !cities.inside && !talk.talking && !talk.telling && !discoveries.drainingCavern) {
        const cv = discoveries.sealedNear(st.pos.x, st.pos.z, discoveries.digReach); // (said where a strike would count)
        const hint = cv && cavernHints.take(cv.x, cv.z, save.has('pick'), save.data.opened.length > 0);
        if (hint) {
          const line = hint === 'again' ? (lastHint = pick(SAND.again, lastHint)) : text(SAND[hint]);
          talk.tell({ x: st.pos.x, y: st.pos.y + 1.8, z: st.pos.z }, line, hint === 'again' ? 4.5 : 7);
        }
      }
    }

    perf?.mark('player-cam');
    cities.update(dt, st.pos);
    perf?.mark('cities');
    footpaths.focus(u, st.pos.x, st.pos.z);
    collisionDebug.update(dt, st.pos.x, st.pos.y, st.pos.z);
    bake.update(st.pos);
    perf?.mark('bake');
    clipmap.update(camera.position, camera);
    perf?.mark('clipmap');
    trail.update(dt, st.pos.x, st.pos.z);
    perf?.mark('trail');
    dust.update(frame);
    perf?.mark('dust');
    splash.update(frame);
    discoveries.update(frame);
    perf?.mark('discoveries');
    props.update(frame);
    perf?.mark('props');
    // Small things lying about are picked up by walking onto them.
    if (playing && st.grounded) {
      const rk = discoveries.relicNear(st.pos.x, st.pos.y, st.pos.z, 1.5);
      if (rk >= 0) {
        discoveries.takeRelic(rk);
        save.take(rk);
        save.setItem('relic', true);
        figure.relic = true;
        pickedUp(st.pos.x, st.pos.y + 1, st.pos.z);
      }
      for (const k of ['boots', 'feather'] as const) {
        if (!discoveries.strayNear(k, st.pos.x, st.pos.y, st.pos.z, 1.5)) continue;
        discoveries.setStray(k, null);
        given(k);
        pickedUp(st.pos.x, st.pos.y + 0.4, st.pos.z);
        found(k);
      }
      if (discoveries.ropeNear(st.pos.x, st.pos.y, st.pos.z, 1.5)) {
        discoveries.setRope(null);
        given('rope');
        pickedUp(st.pos.x, st.pos.y + 0.4, st.pos.z);
        found('rope');
      }
      // What a temple has left on the stone before its altar: one thing from each.
      const offer = discoveries.offerNear(st.pos.x, st.pos.y, st.pos.z, 1.5);
      if (offer) {
        save.gather(offer.key);
        given(offer.kind);
        layOffers();
        pickedUp(st.pos.x, st.pos.y + 1, st.pos.z);
        found(offer.kind);
      }
      if (discoveries.lampNear(st.pos.x, st.pos.y, st.pos.z, 1.5)) {
        discoveries.setLamps([]); // one is enough: the other is left for nobody
        save.setItem('lamp', true);
        figure.lamp = true;
        pickedUp(st.pos.x, st.pos.y + 0.4, st.pos.z);
      }
    }
    // The carpet that waits at the heart of a deep comes to whoever reaches it, on foot or in the air.
    if (playing && discoveries.carpetNear(st.pos.x, st.pos.y, st.pos.z, 1.4)) {
      discoveries.setCarpet(false);
      player.carpet = figure.carpet = true;
      given('carpet');
      pickedUp(st.pos.x, st.pos.y + 1, st.pos.z);
      found('carpet');
    }
    // A storm uncovers a wreck once its trailing edge has gone over where she lies (and only on
    // ground that suits her, and not where the wanderer stands to watch her appear).
    wreckT -= dt;
    if (wreckT <= 0) {
      wreckT = 2;
      const px = st.pos.x;
      const pz = st.pos.z;
      for (const s of weather.storms(frame.clock, px, pz, 16000)) {
        if (s.kind !== 'sand' || uncovered.has(s.id)) continue;
        const w = weather.wreck(s);
        if (!w) {
          uncovered.set(s.id, null);
          continue;
        }
        weather.centre(s, frame.clock, wreckC);
        if ((w.x - wreckC.x) * s.hx + (w.z - wreckC.y) * s.hz > -s.depth / 2) continue; // still under the sand
        if (Math.hypot(w.x - px, w.z - pz) < 150) continue; // (tried again once the wanderer has moved off)
        uncovered.set(s.id, wreckSuits(w.x, w.z, w.rot) ? w : null);
      }
      layWrecks();
      layFallen();
    }
    // The miner's lamp lies out in the desert until it is carried back: by the nearest city's spring.
    lampT -= dt;
    if (lampT <= 0) {
      lampT = 1;
      layOffers();
      discoveries.setCarpet(!save.has('carpet'));
      people.minerLamp = save.data.roles.miner === 2;
      const at: { x: number; z: number }[] = [];
      if (save.data.roles.miner !== 2 && !save.data.items.lamp) {
        const near = world.cities.near(st.pos.x, st.pos.z)[0];
        if (near) {
          const spot = lampSpot(near);
          at.push(spot);
          if (spot.mouth) at.push(spot.mouth); // a spring has a second, up in its cave mouth
        }
        // Once the miner has asked, there is one by the pool of every fall in the mountains near.
        if (save.data.roles.miner === 1) {
          for (const f of discoveries.fallLamps(st.pos.x, st.pos.z)) if (!at.some((a) => a.x === f.x && a.z === f.z)) at.push(f);
        }
      }
      discoveries.setLamps(at);
      // A rope and hook lies beside the nearest great bones, until it is picked up.
      discoveries.setRope(save.has('rope') ? null : discoveries.ropeSpot(st.pos.x, st.pos.z, 2500));
      // The climber's boots lie at the back of the nearest mountain cave, and a feather on the nearest summit.
      for (const k of ['boots', 'feather'] as const) discoveries.setStray(k, save.has(k) ? null : discoveries.straySpot(k, st.pos.x, st.pos.z, 2500));
    }
    // Over a sealed cavern the sand drifts slowly, where everywhere else the wind takes it.
    {
      const cv = discoveries.sealedNear(st.pos.x, st.pos.z, 110);
      if (cv && dt > 0) {
        const sx = cv.x + cv.dx * cv.spot;
        const sz = cv.z + cv.dz * cv.spot;
        dust.wisp(sx, world.height(sx, sz), sz, 3.5, dt);
      }
    }
    // Sand draining into a cavern: it slides in from the rim, and dust hangs over the hole.
    {
      const cv = discoveries.drainingCavern;
      if (cv && dt > 0) {
        for (let i = 0; i < 2; i++) {
          const along = 2 + Math.random() * cv.roof;
          const side = (Math.random() - 0.5) * 2 * (cv.half + 4);
          const x = cv.x + cv.dx * along - cv.dz * side;
          const z = cv.z + cv.dz * along + cv.dx * side;
          if (Math.random() < 0.5) cascade(x, z, 1);
          tmp.set(x, world.height(x, z) + 0.1, z);
          tmp2.set(-cv.dz * side * -0.1, 1.2, cv.dx * side * -0.1);
          dust.puff(tmp, tmp2, 0.25 + 0.3 * Math.random());
        }
        if (Math.random() < dt * 5) buzz(12);
      }
    }
    massifs.update(frame, clipmap.levelCount);
    perf?.mark('massifs');
    wildlife.update(frame);
    perf?.mark('wildlife');
    fauna.update(frame);
    perf?.mark('fauna');
    const ambience = cities.frame(frame);
    caravans.needy = !save.has('board');
    caravans.update(frame);
    perf?.mark('caravans');
    // the camp fires out on the routes crackle like the city's own
    ambience.fire = Math.min(1, Math.hypot(ambience.fire, caravans.fireLevel(frame.player.pos.x, frame.player.pos.z)));
    audio.setAmbience(ambience);
    waymarks.update(frame);
    people.setCity(cities.active);
    people.update(frame);
    perf?.mark('people');
    if (seekMiner && people.minerNear(1e9, minerP)) {
      seekMiner = false;
      player.place(minerP.x, minerP.z + 2.5);
      player.facing = Math.PI; // toward the miner, who is to the north (-z)
      camYaw = player.facing + Math.PI;
    }
    bustle = people.bustle;
    // How much of a city surrounds the listener: 0 out in the desert, rising from 900 m out to the centre.
    {
      const site = cities.nearest(st.pos.x, st.pos.z);
      const d = Math.hypot(site.cx - st.pos.x, site.cz - st.pos.z);
      const near = d > site.radius ? 0.7 * Math.max(0, 1 - (d - site.radius) / 900) : 0.7 + 0.3 * (1 - d / site.radius);
      cityNear = near;
      audio.setCity(near, bustle, d < site.radius * 0.92 && st.grounded);
    }
    // How far underground the listener is, and how much water is by.
    audio.setDeep?.(underK, deepIn ? deepIn.wetness(st.pos.x, st.pos.y + 1.5, st.pos.z) : 0);
    audio.update({
      dt,
      day: day.day,
      night: day.night,
      speed: st.speed,
      sliding: st.sliding && st.grounded,
      rock: st.onRock > 0.5,
      grounded: st.grounded,
      gust: frame.gust,
      storm: frame.storm,
      rain: frame.rain,
      stormAhead: frame.stormAhead,
      altitude: Math.max(0, st.pos.y) + player.alt * 4,
    });
  }

  function render() {
    // the storms, where the eye is now
    perf?.mark('update-rest');
    camera.updateMatrixWorld();
    updateStorm(u, frame, (x, z) => world.height(x, z), guard.peaks);
    perf?.mark('storm');
    let target = rt;
    if (postNeedsDepth()) {
      if (!rtDepth) {
        rtDepth = new THREE.WebGLRenderTarget(rtSize.x, rtSize.y, { samples: QUALITY[auto.tier].samples, depthBuffer: true });
        rtDepth.depthTexture = new THREE.DepthTexture(rtSize.x, rtSize.y);
      }
      target = rtDepth;
    }
    if (target) {
      postU.tColor.value = target.texture;
      postU.tDepth.value = target.depthTexture;
    }
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    perf?.mark('draw-scene');
    renderer.setRenderTarget(null);
    renderer.render(postScene, postCam);
    perf?.mark('draw-post');
  }

  if (import.meta.env.DEV) {
    const ds = {
        // the deep the wanderer is in, or failing that the nearest one built (null if none is)
        get deep() {
          return discoveries.deepIn ?? discoveries.deepNear(player.state.pos.x, player.state.pos.z)?.deep ?? null;
        },
        // wake the stone of the nearest built deep, wherever you stand
        wake: () => discoveries.wakeStone(player.state.pos.x, player.state.pos.y, player.state.pos.z, Infinity),
        // put the wanderer down somewhere, feet at y (for getting about a deep): e.g. __ds.tp(...__ds.deep.ledge)
        // play a song as if chosen from the ring: __ds.sing('waking')
        // bring the nearest hamlet, watchtower or spring back as if daysAgo in-game days ago: __ds.revive(2)
        revive: (daysAgo = 0, kind?: string) => {
          const p = player.state.pos;
          const at = discoveries.revivables(p.x, p.z).find((r) => !kind || r.kind === kind);
          if (!at) return null;
          save.data.revived = save.data.revived.filter((r) => r.key !== at.key);
          save.revive({ key: at.key, kind: at.kind, x: at.x, z: at.z, day: frame.clock - daysAgo });
          discoveries.setRevived(save.data.revived, frame.clock, p.x, p.z, true);
          syncRevived();
          return { kind: at.kind, x: at.x, z: at.z, stage: discoveries.revivedStage(at.key) };
        },
        revivable: () => discoveries.revivables(player.state.pos.x, player.state.pos.z),
        sing: (song: Song) => {
          lastSong = song;
          playFlute(song);
        },
        tp: (x: number, y: number, z: number) => {
          player.state.pos.set(x, y, z);
          player.state.vel.set(0, 0, 0);
          player.state.grounded = false;
          camTarget.set(x, y + 1.5, z);
        },
        // open the nearest cavern over a deep of a kind (0-4) and stand by its hole, as ?deep= does
        toDeep: (kind: number) => {
          const at = discoveries.devDeep(player.state.pos.x, player.state.pos.z, kind);
          if (at) {
            player.place(at.x, at.z);
            player.facing = at.facing;
            camYaw = at.facing + Math.PI;
            camTarget.copy(player.state.pos);
          }
          return at;
        },
    };
    Object.assign(window, { __ds: Object.defineProperties(ds, Object.getOwnPropertyDescriptors({
        // the weather: __ds.frame.storm, __ds.weather.sent
        frame,
        // lay a wreck 40 m ahead of the wanderer now, as a storm would leave one (for looking at her)
        wreck: () => {
          const p = player.state.pos;
          const w = { x: p.x + Math.sin(player.facing) * 40, z: p.z + Math.cos(player.facing) * 40, rot: player.facing }; // (broadside on)
          devWrecks.push(w);
          layWrecks();
          return w;
        },
        // lay a fallen star 40 m ahead of the wanderer (this visit only, not saved)
        fall: () => {
          const p = player.state.pos;
          const f = { x: p.x + Math.sin(player.facing) * 40, z: p.z + Math.cos(player.facing) * 40 };
          devFallen.push(f);
          layFallen();
          return f;
        },
        weather,
        // advance the simulation by a number of seconds at 60 Hz, then draw (for testing when the tab is throttled)
        sim: (sec: number) => {
          for (let i = 0; i < Math.round(sec * 60); i++) update(1 / 60);
          render();
        },
        // one step of the simulation with nothing drawn (for checking movement frame by frame)
        step: (dt: number) => update(dt),
        freeze: (f: boolean) => (frozen = f),
        // switch the look without touching the saved choice
        look: (id: string) => {
          const l = LOOKS.find((x) => x.id === id);
          if (l) applyLook(l);
          stillDrawn = false;
          return l?.name;
        },
        player, day, keys, world, save, atlas, map, lanterns, heavens, talk, figure, trail, dust, bake, renderer, discoveries, props, splash, waterAt, water, wildlife, fauna, touch, ui, auto, cities, caravans, waymarks, audio, people, camera, clipmap, cam: (y: number, p: number, d: number) => ((camYaw = y), (camPitch = p), (camDist = d)) })) });
  }

  let frozen = false;
  let last = performance.now();
  let lastRaf = 0;
  let prevWork = 0; // ms the previous rAF callback spent drawing
  let refreshKnown = false;
  let gapCount = 0;
  const rafGaps: number[] = [];
  function tick(now: number) {
    requestAnimationFrame(tick);
    // Nothing to do while the tab is hidden.
    if (document.hidden) {
      last = now;
      return;
    }
    // The display's refresh interval, from the gaps between rAF callbacks. Only gaps that follow a cheap
    // callback count (a long frame delays the next callback to a later vsync and would read as a slower display).
    if (lastRaf > 0 && prevWork < 6) {
      const d = now - lastRaf;
      if (d > 3 && d < 45) {
        rafGaps.push(d);
        if (rafGaps.length > 90) rafGaps.shift();
        if (rafGaps.length >= 30 && ++gapCount % 15 === 0) {
          const sorted = [...rafGaps].sort((a, b) => a - b);
          // the median: Safari sometimes runs two callbacks close together, which made a low percentile read a
          // 120 Hz (or rAF-capped 60 Hz) iPhone as 144 Hz
          const est = sorted[sorted.length >> 1];
          const hz = 1000 / est;
          const snap = [30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 240].find((r) => Math.abs(hz - r) / r < 0.08);
          const was = Math.round(1 / auto.refreshS);
          auto.setRefresh(1 / (snap ?? hz));
          if (Math.round(1 / auto.refreshS) !== was || !refreshKnown) perf?.note(`refresh ${Math.round(1 / auto.refreshS)} Hz (gaps p15 ${sorted[Math.floor(sorted.length * 0.15)].toFixed(1)} p50 ${est.toFixed(1)} p85 ${sorted[Math.floor(sorted.length * 0.85)].toFixed(1)})`);
          refreshKnown = true;
        }
      }
    }
    lastRaf = now;
    prevWork = 0;
    // Phones are paced: an even 60 (or the display's rate below that), or an even 30 when 60 cannot be held
    // (every 2nd vsync on 60 Hz, every 4th on 120 Hz; see AutoQuality). Half a vsync of slack so a timestamp
    // that comes a little early does not drop a beat. Desktop runs as fast as the display goes.
    const paced = touch.used || auto.tier === 'mobile';
    auto.setPaced(paced);
    if (paced) {
      // by time, not by counted vsyncs: the refresh estimate wanders (Safari's rAF timestamps are uneven),
      // and 4 ms of slack lands every frame on the right vsync at 60, 90, 120 or 144 Hz
      const gate = (auto.pace === 30 ? 1000 / 30 : 1000 / 60) - 4;
      if (now - last < gate) return;
    }
    const real = (now - last) / 1000;
    const dt = Math.min(0.05, Math.max(0, real));
    last = now;
    // The world holds still in the menu, behind the map and in photo mode. In the menu and
    // behind the map nothing changes on screen, so one frame is drawn and then the GPU rests;
    // the map's sheet is its own canvas and goes on being slid about and drawn.
    // (update is not run while the sheet is open, so leaving play puts it away here)
    if (map.isOpen && ui.state !== 'playing') map.close();
    const mapOpen = map.isOpen;
    if (mapOpen) map.update(dt, readMap(dt), keyX(), -keyZ());
    const resting = ui.state === 'menu' || mapOpen;
    const still = frozen || resting;
    if (still && stillDrawn && !frozen) return;
    stillDrawn = resting;
    // what this frame can give to building the world (see world/budget.ts)
    frameBudget.begin(budgetFor(auto.tier));
    const t0 = performance.now();
    perf?.frameStart(now);
    update(still || ui.state === 'photo' ? 0 : dt);
    perf?.begin();
    uploader.before();
    perf?.mark('uploader');
    render();
    uploader.after();
    perf?.mark('uploader-after');
    prevWork = performance.now() - t0;
    perf?.end(now);
    lateWatch?.();
    if (ui.state === 'playing' && !mapOpen) auto.frame(real, prevWork / 1000);
  }
  requestAnimationFrame(tick);

  // Every shader the game can draw is compiled while the title card is up (see warm.ts): after the
  // first frame is on screen, and the card stays until it is done (or has taken too long).
  warmObjects(scene, postScene);
  // (the rocks and plants are built as they come into range, so may not be in the scene yet)
  // TODO: have props.ts register these itself; it was being reworked in parallel.
  {
    const pm = props as unknown as { mat?: THREE.Material; shadeMat?: THREE.Material };
    if (pm.mat) warmMaterial(pm.mat, { normals: true });
    if (pm.shadeMat) warmMaterial(pm.shadeMat, { normals: false });
  }
  requestAnimationFrame(() =>
    setTimeout(() => {
      const done = warmUp(renderer, camera, scene, rt).then((r) => {
        if (import.meta.env.DEV || perf) console.info(`[warm] ${r.objects} objects, programs ${r.before} -> ${r.after} in ${r.ms} ms${r.timedOut ? ' (timed out)' : ''}`);
        if (import.meta.env.DEV) lateWatch = lateProgramWatch(renderer, scene);
      });
      ui.holdUntil(done);
    }, 0),
  );
}

try {
  start();
} catch (err) {
  console.error(err);
  uiHost.textContent = 'Aster needs WebGL 2, which this browser could not start.';
  uiHost.style.cssText = 'display:grid;place-items:center;color:#efe6d8;font:16px system-ui;padding:24px;text-align:center';
}
