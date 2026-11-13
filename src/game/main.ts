import * as THREE from 'three';
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
import { Wildlife } from '../world/wildlife';
import { Fauna } from '../world/fauna';
import { Cities } from '../city/cities';
import { Caravans, ROLE_KEEPER, ROLE_PILGRIM } from '../city/caravans';
import { Waymarks } from '../city/waymarks';
import { People } from '../city/people';
import { Figure } from './figure';
import { AudioEngine } from '../audio/audio';
import { UI } from '../ui/ui';
import { TouchControls, type TouchMode } from './touch';
import { AutoQuality, QUALITY, applyQuality, defaultTier } from './quality';
import { postFrag, postVert } from '../render/shaders';
import { gameSkyFrag, gameSkyVert } from '../render/gameSky';
import { DEFAULTS, type Params } from '../render/types';
import { LOOKS, stylesUnlocked, type Look } from './looks';
import { WORLD_SCALE } from '../world/scale';
import { Massifs } from '../world/massifs';
import { Save } from './save';
import { Talk, type Speaker } from './talk';
import { KEEPER, MINER, PILGRIM, TOWNSFOLK, TRAVELLER, type Line } from './lines';

const WORLD_SEED = 20261111; // the same desert for everyone, every time
const SPAWN_RANGE = 20000; // metres from the origin

const cap = (k: string) => 'u' + k[0].toUpperCase() + k.slice(1);
const canvasHost = document.getElementById('game') as HTMLElement;
const uiHost = document.getElementById('ui') as HTMLElement;

function start() {
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  const canvas = renderer.domElement;
  canvasHost.appendChild(canvas);

  // ---- shared uniforms
  const u: Uniforms = {
    uTime: { value: 0 },
    uSeed: { value: WORLD_SEED },
    uWind: { value: new THREE.Vector2(1, 0) },
    uFigPos: { value: new THREE.Vector3() },
  };
  for (const n of ['uInk', 'uPaperCol', 'uA', 'uB', 'uLine']) u[n] = { value: new THREE.Vector3() };
  // One float uniform per style setting. Glow and fog are not here: the day cycle owns them.
  for (const k of Object.keys(DEFAULTS) as Array<keyof Params>) {
    if (k !== 'glow' && k !== 'fog') u[cap(k)] = { value: DEFAULTS[k] };
  }

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
  // A board, once given, is ridden until you step off it (Q); stepping off puts it on your back.
  let boardOn = true;
  player.board = save.has('board');
  player.carpet = save.has('carpet');

  let seekMiner = false;
  // ---- spawn somewhere new each visit, on open sand
  {
    const s = { h: 0, rock: 0, salt: 0 };
    const n = new THREE.Vector3();
    let x = 0;
    let z = 0;
    // Somewhere in the open desert, with a city in sight. Most cities are seen from 1.5 to 3.4 km
    // off; an oasis hides in a basin behind its ring of dunes, so it is seen from on or just inside
    // that ring, looking down at it. If the nearest city gives no clear view, the next ones are
    // tried, and only then is any open sand accepted.
    let spawnCity: { cx: number; cz: number } | null = null;
    const ax = (Math.random() * 2 - 1) * SPAWN_RANGE;
    const az = (Math.random() * 2 - 1) * SPAWN_RANGE;
    const cands = world.cities.near(ax, az).slice(0, 3);
    let fallback: { x: number; z: number; city: (typeof cands)[number] } | null = null;
    search: for (const city of cands) {
      const oasis = city.kind === 'oasis';
      for (let i = 0; i < 40; i++) {
        const a = Math.random() * Math.PI * 2;
        const d = oasis ? city.radius + 250 + Math.random() * 400 : city.radius + (2000 + Math.random() * 2500) * WORLD_SCALE;
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
    // ?x=..&z=.. pins the spawn point (handy for sharing a place).
    if (qs.has('x') && qs.has('z')) {
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
    // Face the city, so the first thing you see is somewhere to go.
    player.facing = spawnCity ? Math.atan2(spawnCity.cx - x, spawnCity.cz - z) : Math.random() * Math.PI * 2;
  }

  // ---- scene
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 14000);
  const cities = new Cities(world, u); // first: it creates the uniforms that tell the terrain where to flatten
  cities.setFocus(player.state.pos.x, player.state.pos.z);
  cavernUniforms(u); // likewise for the caverns, which the discoveries fill in
  const bake = new HeightBake(renderer, u);
  const trail = new TrailField(renderer, u);
  const clipmap = new Clipmap(u);
  const dust = new Dust(world, u);
  const discoveries = new Discoveries(world, u);
  // Caverns opened on an earlier visit are open still, and their relics stay taken.
  discoveries.restore(save.data.opened, save.data.taken, save.data.woken);
  discoveries.onOpened = (key) => save.open(key);
  // Each waking stone lengthens the climb, with less to gain from every one after the first.
  const setLift = () => (player.lift = 1 + 1.5 * (1 - Math.pow(0.9, discoveries.wokenCount)));
  setLift();
  discoveries.onGround = () => bake.invalidate();
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
  const splash = new Splash(u);
  const wildlife = new Wildlife(world, u);
  const caravans = new Caravans(world, world.cities, u);
  caravans.landmarks = (out) => discoveries.landmarks(out);
  const fauna = new Fauna(world, u);
  fauna.landmarks = (out) => discoveries.landmarks(out);
  fauna.blocked = (x, z) => {
    const c = cities.nearest(x, z);
    return Math.hypot(c.cx - x, c.cz - z) < c.radius + 300 || discoveries.nearSolids(x, z, 12);
  };
  const waymarks = new Waymarks(world, world.cities, u);
  const people = new People(u);
  const massifs = new Massifs(world, u);
  scene.add(clipmap.group, cities.group, people.group, caravans.group, waymarks.group, discoveries.group, wildlife.group, fauna.group, dust.group, splash.group, massifs.group);

  const figure = new Figure(u);
  figure.board = player.board;
  figure.carpet = player.carpet;
  figure.pick = save.has('pick');
  figure.lamp = save.data.items.lamp;
  figure.relic = save.data.items.relic;
  scene.add(figure.group);

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
    if (best) caravans.addCamp(best.x, best.z, WORLD_SEED ^ Math.round(best.x * 31 + best.z * 17));
  }

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(1, 48, 24),
    new THREE.ShaderMaterial({ uniforms: u, vertexShader: gameSkyVert, fragmentShader: gameSkyFrag, side: THREE.BackSide, depthTest: false, depthWrite: false }),
  );
  sky.scale.setScalar(9000);
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  scene.add(sky);

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
  let stillDrawn = false; // the paused frame has been drawn; nothing more to render until something changes
  // Quality: a tier (mobile / low / high) plus a render scale the game lowers by itself if frames run slow.
  const auto = new AutoQuality(defaultTier(), (tier) => {
    ui.setQuality(tier);
    applyTier();
  });
  function applyTier() {
    applyQuality(QUALITY[auto.tier], { uniforms: u, clipmap, bake, dust });
    people.setDensity(auto.tier === 'mobile' ? 0.35 : auto.tier === 'low' ? 0.7 : 1);
    cities.setDensity(auto.tier === 'mobile' ? 0.35 : auto.tier === 'low' ? 0.7 : 1);
    splash.setDensity(auto.tier === 'mobile' ? 0.5 : auto.tier === 'low' ? 0.75 : 1);
    discoveries.tier = auto.tier === 'mobile' ? 2 : auto.tier === 'low' ? 1 : 0;
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
    renderer.setSize(pw, ph, false);
    rt?.depthTexture?.dispose();
    rt?.dispose();
    rt = new THREE.WebGLRenderTarget(pw, ph, { samples: q.samples, depthBuffer: true });
    rt.depthTexture = new THREE.DepthTexture(pw, ph);
    postU.tColor.value = rt.texture;
    postU.tDepth.value = rt.depthTexture;
    (postU.uRes.value as THREE.Vector2).set(pw, ph);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    stillDrawn = false;
  }
  window.addEventListener('resize', resize);

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
    onQuality(q) {
      auto.setTier(q);
      applyTier();
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
    },
    { quality: auto.tier, styles: unlocked ? LOOKS.map(({ id, name }) => ({ id, name })) : [], style: unlocked ? qs.get('style') : null },
  );
  applyTier();
  const syncKnown = () => {
    ui.setKnown({ talk: save.data.talked, board: save.has('board'), carpet: player.carpet, dig: save.has('pick') });
    touch.setBoard(save.has('board'), player.board);
  };

  // ---- talking: anyone in reach can be spoken to. Travellers give the board to someone on foot.
  const pick = <T,>(list: T[], avoid: T | null): T => {
    let v = list[Math.floor(Math.random() * list.length)];
    if (v === avoid && list.length > 1) v = list[(list.indexOf(v) + 1) % list.length];
    return v;
  };
  const text = (l: Line) => (typeof l === 'string' ? l : touch.used ? l.touch : l.keys);
  let lastLine: string | null = null;
  const trav = { ref: null as unknown, x: 0, y: 0, z: 0, h: 1, sit: 0, seed: 0, role: 0 };
  const folk = { id: -1, x: 0, z: 0, h: 1, sit: 0 };
  const setTraveller = (out: Speaker) => {
    out.kind = trav.role === ROLE_PILGRIM ? 'pilgrim' : trav.role === ROLE_KEEPER ? 'keeper' : 'traveller';
    out.ref = trav.ref;
    out.x = trav.x;
    out.z = trav.z;
    out.y = trav.y + (1.72 - 0.62 * trav.sit) * trav.h;
    out.pitch = 120 + trav.seed * 110;
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
      const pool = [...MINER.after, ...(save.data.items.relic ? [...MINER.relic, ...MINER.relic] : [])];
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
        },
      };
    }
    if (save.data.roles.miner === 1) return { lines: [MINER.pending, where] };
    return {
      lines: [...MINER.ask.map(text), where, MINER.askEnd],
      done() {
        save.setRole('miner', 1);
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
  let lampT = 0;
  const digAt = { x: 0, y: 0, z: 0 };

  const setFolk = (out: Speaker) => {
    out.kind = 'townsfolk';
    out.ref = folk.id;
    out.x = folk.x;
    out.z = folk.z;
    // townsfolk stand on the same street as the player
    out.y = player.state.pos.y + (1.7 - 0.6 * folk.sit) * folk.h;
    out.pitch = folk.h < 0.8 ? 330 + (folk.id % 7) * 12 : 130 + (folk.id % 11) * 11;
  };
  const talk = new Talk(uiHost, {
    find(out) {
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
    },
    hold(s) {
      if (s.kind === 'miner') {
        if (!people.minerNear(30, minerP)) return false;
        people.holdMiner();
        setMiner(s);
        return true;
      }
      if (s.kind === 'traveller' || s.kind === 'pilgrim' || s.kind === 'keeper') {
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
      if (s.kind === 'pilgrim' || s.kind === 'keeper') {
        const lines = s.kind === 'pilgrim' ? PILGRIM : KEEPER;
        const dark = day.day < 0.22 || day.day > 0.78;
        const pool = [...lines.any, ...(dark ? [...lines.night, ...lines.night] : [])];
        if (s.kind === 'keeper' && save.data.items.relic) pool.push(...KEEPER.relic, ...KEEPER.relic);
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
        return { lines: [(lastLine = pick(TRAVELLER.after, lastLine))] };
      }
      const site = cities.active?.site;
      const d = day.day;
      const hour = d < 0.2 || d > 0.82 ? TOWNSFOLK.night : d < 0.32 ? TOWNSFOLK.dawn : d > 0.7 ? TOWNSFOLK.dusk : d > 0.42 && d < 0.58 ? TOWNSFOLK.noon : [];
      const pool = [...TOWNSFOLK.any, ...(site ? TOWNSFOLK[site.kind] : []), ...hour, ...(save.has('board') ? [] : [...TOWNSFOLK.onFoot, ...TOWNSFOLK.onFoot])];
      // a relic at the belt gets noticed, and in any city someone with no pick is sent to the miner
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
  discoveries.onReach = () => audio.chime();
  fauna.onCall = (_sp, dist) => audio.yip(dist);
  cities.onReach = () => audio.chime();
  // Roofs you can land on: buildings, and the rock over a cave once you are above its ceiling.
  // (ceilings: the caves in the massifs, the caps over the springs, and the sand left over an open cavern)
  const ceilAt = (x: number, z: number) => Math.min(world.caveCeil(x, z), discoveries.capCeil(x, z), world.cavernCeil(x, z));
  const caveRoofAt = (x: number, z: number, y: number) => {
    const ceil = ceilAt(x, z);
    return ceil < Infinity && y > ceil - 0.3 ? world.uncarved(x, z) : -Infinity;
  };
  // (and the things found out in the desert: standing stones, fallen columns, the great bones)
  player.roof = (x, z, y) => Math.max(cities.roofAt(x, z, y), caveRoofAt(x, z, y), discoveries.topAt(x, z, y));
  // Under an open cavern the deep has floors of its own, one over another: where it has the
  // say, the terrain (and every roof above) is not asked.
  player.floor = (x, z, y) => discoveries.deepFloor(x, z, y);
  // What the feet are on when it is not the ground: 0 stone, 1 bone, 2 wood, or -1 for the ground itself.
  const propUnder = (x: number, z: number, y: number) => {
    const t = discoveries.topAt(x, z, y);
    return Math.abs(t - y) < 0.3 && t > world.height(x, z) + 0.4 ? discoveries.solidKind : -1;
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
  let jumpQueued = false;
  let camYaw = player.facing + Math.PI;
  let camPitch = 0.22;
  let camDist = 7.5;
  let dragging = false;

  // ---- touch: a floating stick, drag to look, pinch to zoom, one button to leap and fly
  const touchHost = document.createElement('div');
  document.body.insertBefore(touchHost, uiHost);
  let lastTouch = -1e9;
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') lastTouch = performance.now();
  }, true);
  const touch = new TouchControls(touchHost, {
    onLook(dx, dy) {
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
  });
  // ---- the pick: with nobody in reach, the key that talks swings it instead
  const SWING = 0.62; // seconds, start to finish
  const SWING_HIT = 0.45; // the fraction of it at which the point lands
  let swingT = -1; // seconds into a swing, or -1 at rest
  let swingHit = false;
  /** Whether a swing may start now: a pick, feet on the ground, and no conversation to have. */
  const canDig = () => save.has('pick') && player.state.grounded && !talk.available;
  const interact = () => {
    const p = player.state.pos;
    if (!talk.talking && discoveries.stoneNear(p.x, p.y, p.z)) discoveries.wakeStone(p.x, p.y, p.z);
    else if (talk.available) talk.interact();
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
    audio.strike('sand', hit.hollow);
    if (hit.level > 0 || hit.broke) {
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

  // Step on or off the board. Off, it rides on your back and you walk.
  const toggleBoard = () => {
    if (!save.has('board')) return;
    boardOn = !boardOn;
    player.board = boardOn;
    figure.boardOn = boardOn;
    audio.footstep(0.8, player.state.onRock > 0.5);
    buzz(10);
    touch.setBoard(true, boardOn);
  };
  syncKnown();
  touch.onFirstTouch = () => ui.setTouch(true);
  // A phone has not been touched yet when the title card appears, so show touch hints from the start.
  if (window.matchMedia?.('(pointer: coarse)').matches) ui.setTouch(true);
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
    if (document.pointerLockElement !== canvas && ui.state === 'playing') ui.openMenu();
  });
  window.addEventListener('keydown', (e) => {
    if (ui.state !== 'playing') return;
    if (e.code === 'Escape') {
      ui.openMenu();
      return;
    }
    if (e.code === 'Space') {
      if (!e.repeat) jumpQueued = true;
      e.preventDefault();
    }
    if (e.code === 'KeyE' && !e.repeat) interact();
    if (e.code === 'KeyQ' && !e.repeat) toggleBoard();
    keys.add(e.code);
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());
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
    camYaw -= e.movementX * 0.0026;
    camPitch = Math.min(1.25, Math.max(-0.35, camPitch + e.movementY * 0.0022));
  });
  window.addEventListener(
    'wheel',
    (e) => {
      if (ui.state === 'playing' || photo) camDist = Math.min(photo ? 60 : 16, Math.max(3, camDist * Math.exp(e.deltaY * 0.0012)));
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
    camera,
    player: player.state,
  };
  const input: PlayerInput = { x: 0, z: 0, run: false, jump: false, lift: false, drop: false, wind };
  const camTarget = new THREE.Vector3().copy(player.state.pos);
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const sliders: Array<{ x: number; z: number; life: number }> = [];
  let slideStampDist = 0;
  let wakeDist = 0;
  let wakeSound = 0;
  let cityNear = 0;
  let bustle = 0;
  let airCam = 0;
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
    frame.dt = dt;
    frame.time += dt;
    u.uTime.value = frame.time;

    day.update(dt);
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
      massifs.group.visible = cities.group.visible = clipmap.group.visible = !shut;
      // and the sky goes sooner, as soon as the stair is a little way down the well
      sky.visible = !(deepIn && st.pos.y < deepIn.spec.y - 1.2);
    }

    // Wind wanders slowly in direction and strength.
    const wa = 0.7 + Math.sin(frame.time * 0.011) * 0.5 + Math.sin(frame.time * 0.0037 + 2) * 0.4;
    wind.set(Math.cos(wa), Math.sin(wa));
    (u.uWind.value as THREE.Vector2).copy(wind);
    frame.gust = 0.5 + 0.3 * Math.sin(frame.time * 0.07) + 0.2 * Math.sin(frame.time * 0.19 + 1.3);

    const mode: TouchMode = playing ? 'play' : photo ? 'photo' : 'off';
    if (mode !== touchMode) touch.setMode((touchMode = mode));
    const kx = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    const kz = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    input.x = playing ? Math.max(-1, Math.min(1, kx + touch.moveX)) : 0;
    input.z = playing ? Math.max(-1, Math.min(1, kz + touch.moveZ)) : 0;
    input.run = playing && (keys.has('ShiftLeft') || keys.has('ShiftRight') || touch.boost);
    input.jump = playing && jumpQueued;
    input.lift = playing && (keys.has('Space') || touch.flyHeld);
    input.drop = playing && touch.dropHeld;
    jumpQueued = false;
    // Near the things found in the desert a fast move is taken in short steps, so a rib a
    // hand's width across is not stepped clean over between two frames.
    {
      const near = dt > 0 && (!!deepIn || discoveries.nearSolids(st.pos.x, st.pos.z, 15));
      const steps = near ? Math.min(8, Math.max(1, Math.ceil((Math.hypot(st.vel.x, st.vel.y, st.vel.z) * dt) / 0.3))) : 1;
      const h = dt / steps;
      for (let i = 0; i < steps; i++) {
        if (i > 0) input.jump = false;
        // You cannot rise through a stone you are under: slow to meet its underside, and stay below it.
        let under = Infinity;
        if (near && !st.grounded) {
          under = discoveries.ceilAt(st.pos.x, st.pos.z, st.pos.y) - 1.9;
          if (st.vel.y > 0 && st.pos.y + st.vel.y * h > under) st.vel.y = Math.max(0, (under - st.pos.y) / h);
        }
        player.update(h, input, camYaw, events);
        if (near && !st.grounded) {
          under = discoveries.ceilAt(st.pos.x, st.pos.z, Math.min(st.pos.y, under)) - 1.9;
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
    // A cave has a ceiling: you cannot rise through the rock.
    {
      const ceil = ceilAt(st.pos.x, st.pos.z);
      inCave = ceil < Infinity && st.pos.y < ceil - 0.3;
      if (inCave && st.pos.y > ceil - 1.9) {
        st.pos.y = ceil - 1.9;
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
      const spray = Math.min(1, carve * 0.9 + Math.max(0, st.speed - 14) * 0.03);
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
    if (ui.state === 'title') camYaw += dt * 0.05;
    tmp.copy(st.pos);
    tmp.y += 1.5;
    camTarget.lerp(tmp, 1 - Math.exp(-dt * 12));
    const cp = Math.cos(camPitch);
    tmp2.set(Math.sin(camYaw) * cp, Math.sin(camPitch), Math.cos(camYaw) * cp);
    // pull back and rise a little while airborne
    const reach = camDist * (1 + 0.6 * airCam);
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
    camera.position.copy(camTarget).addScaledVector(tmp2, dist);
    // drawn right in against a wall, the eye is inside the figure: see past it, not its lining
    const tooNear = !!deepIn && dist < 0.75;
    if (tooNear !== figNear) {
      figNear = tooNear;
      figure.group.visible = !tooNear;
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
    // Underground the eye is often a hand's width from a wall, and the half metre it does not
    // draw in front of itself up on the sand would cut a window through one.
    const near = deepIn ? 0.06 : 0.5;
    if (Math.abs(camera.fov - fov) > 0.05 || camera.near !== near) {
      camera.fov += (fov - camera.fov) * (1 - Math.exp(-dt * 3));
      camera.near = near;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
    sky.position.copy(camera.position);

    // Speech is drawn over the scene, so it is placed once the camera has settled.
    talk.setKey(touch.used ? '' : 'E');
    talk.update(camera, st.pos.x, st.pos.z, playing);
    const stoneAt = playing && !talk.talking ? discoveries.stoneAt(st.pos.x, st.pos.y, st.pos.z) : null;
    touch.setTalk(talk.available || stoneAt !== null, canDig() && st.onRock < 0.5);
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
      talk.mark(camera, stoneAt || cv ? digAt : null);
    }

    cities.update(dt, st.pos);
    bake.update(st.pos);
    clipmap.update(camera.position);
    trail.update(dt, st.pos.x, st.pos.z);
    dust.update(frame);
    splash.update(frame);
    discoveries.update(frame);
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
      if (discoveries.lampNear(st.pos.x, st.pos.y, st.pos.z, 1.5)) {
        discoveries.setLamps([]); // one is enough: the other is left for nobody
        save.setItem('lamp', true);
        figure.lamp = true;
        pickedUp(st.pos.x, st.pos.y + 0.4, st.pos.z);
      }
    }
    // The miner's lamp lies out in the desert until it is carried back: by the nearest city's spring.
    lampT -= dt;
    if (lampT <= 0) {
      lampT = 1;
      people.minerLamp = save.data.roles.miner === 2;
      const at: { x: number; z: number }[] = [];
      if (save.data.roles.miner !== 2 && !save.data.items.lamp) {
        const near = world.cities.near(st.pos.x, st.pos.z)[0];
        if (near) {
          const spot = lampSpot(near);
          at.push(spot);
          if (spot.mouth) at.push(spot.mouth); // a spring has a second, up in its cave mouth
        }
      }
      discoveries.setLamps(at);
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
    wildlife.update(frame);
    fauna.update(frame);
    const ambience = cities.frame(frame);
    audio.setAmbience(ambience);
    caravans.update(frame);
    waymarks.update(frame);
    people.setCity(cities.active);
    people.update(frame);
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
      grounded: st.grounded,
      gust: frame.gust,
      altitude: Math.max(0, st.pos.y) + player.alt * 4,
    });
  }

  function render() {
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(postScene, postCam);
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
        player, day, keys, world, save, talk, figure, trail, dust, bake, renderer, discoveries, splash, waterAt, water, wildlife, fauna, touch, ui, auto, cities, caravans, waymarks, audio, people, camera, cam: (y: number, p: number, d: number) => ((camYaw = y), (camPitch = p), (camDist = d)) })) });
  }

  let frozen = false;
  let last = performance.now();
  function tick(now: number) {
    requestAnimationFrame(tick);
    // Nothing to do while the tab is hidden.
    if (document.hidden) {
      last = now;
      return;
    }
    // Phones are capped at 60 frames a second to save battery.
    const capped = touch.used || auto.tier === 'mobile';
    if (capped && now - last < 1000 / 62) return;
    const real = (now - last) / 1000;
    const dt = Math.min(0.05, Math.max(0, real));
    last = now;
    // The world holds still in the menu and in photo mode. In the menu nothing
    // changes on screen, so one frame is drawn and then the GPU rests.
    const still = frozen || ui.state === 'menu';
    if (still && stillDrawn && !frozen) return;
    stillDrawn = ui.state === 'menu';
    update(still || ui.state === 'photo' ? 0 : dt);
    render();
    if (ui.state === 'playing') auto.frame(real);
  }
  requestAnimationFrame(tick);
}

try {
  start();
} catch (err) {
  console.error(err);
  uiHost.textContent = 'Aster needs WebGL 2, which this browser could not start.';
  uiHost.style.cssText = 'display:grid;place-items:center;color:#efe6d8;font:16px system-ui;padding:24px;text-align:center';
}
