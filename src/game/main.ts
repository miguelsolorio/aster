import * as THREE from 'three';
import type { FrameState, Uniforms } from './contract';
import { DayCycle } from './daycycle';
import { Player, type PlayerInput } from './player';
import { createWorld } from '../world/surface';
import { HeightBake } from '../world/heightBake';
import { Clipmap } from '../world/clipmap';
import { TrailField } from '../world/trailField';
import { Dust } from '../world/dust';
import { Discoveries } from '../world/discoveries';
import { Wildlife } from '../world/wildlife';
import { Cities } from '../city/cities';
import { Caravans } from '../city/caravans';
import { People } from '../city/people';
import { Figure } from './figure';
import { AudioEngine } from '../audio/audio';
import { UI } from '../ui/ui';
import { TouchControls, type TouchMode } from './touch';
import { AutoQuality, QUALITY, applyQuality, defaultTier } from './quality';
import { postFrag, postVert } from '../render/shaders';
import { gameSkyFrag, gameSkyVert } from '../render/gameSky';
import { DEFAULTS, type Params } from '../render/types';

const WORLD_SEED = 20261111; // the same desert for everyone, every time
const SPAWN_RANGE = 20000; // metres from the origin

// The "35 mm" film treatment for the post pass.
const FILM: Partial<Params> = { grain: 0.075, vig: 0.5, chroma: 0.0028, sat: 0.94, contrast: 1.03 };

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
  const film: Params = { ...DEFAULTS, ...FILM };
  for (const k of Object.keys(DEFAULTS) as Array<keyof Params>) {
    if (k !== 'glow' && k !== 'fog') u[cap(k)] = { value: film[k] };
  }
  u.uBands.value = 0;

  const qs = new URLSearchParams(location.search);
  const day = new DayCycle(u, qs.has('day') ? Number(qs.get('day')) : Math.random());
  const world = createWorld(WORLD_SEED);
  const player = new Player(world);

  // ---- spawn somewhere new each visit, on open sand
  {
    const s = { h: 0, rock: 0, salt: 0 };
    const n = new THREE.Vector3();
    let x = 0;
    let z = 0;
    // Somewhere in the open desert, with a city in sight a few kilometres off.
    let spawnCity: { cx: number; cz: number } | null = null;
    const ax = (Math.random() * 2 - 1) * SPAWN_RANGE;
    const az = (Math.random() * 2 - 1) * SPAWN_RANGE;
    const city = world.cities.near(ax, az)[0];
    for (let i = 0; i < 80; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = city.radius + 2000 + Math.random() * 2500;
      x = city.cx + Math.cos(a) * d;
      z = city.cz + Math.sin(a) * d;
      world.sample(x, z, s);
      world.normal(x, z, n);
      if (s.rock >= 0.1 || n.y <= 0.95) continue;
      // Dunes hide a city easily, so insist on a clear line of sight to its rooftops
      // (the last attempts accept any open sand rather than fail).
      let clear = true;
      const eye = s.h + 3;
      const roofs = city.groundY + 14;
      for (let t = 0.02; t < 0.98 && clear; t += 0.02) {
        if (world.height(x + (city.cx - x) * t, z + (city.cz - z) * t) > eye + (roofs - eye) * t) clear = false;
      }
      if (clear || i > 70) {
        spawnCity = city;
        break;
      }
    }
    // ?x=..&z=.. pins the spawn point (handy for sharing a place).
    if (qs.has('x') && qs.has('z')) {
      x = Number(qs.get('x'));
      z = Number(qs.get('z'));
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
  const bake = new HeightBake(renderer, u);
  const trail = new TrailField(renderer, u);
  const clipmap = new Clipmap(u);
  const dust = new Dust(world, u);
  const discoveries = new Discoveries(world, u);
  const wildlife = new Wildlife(world, u);
  const caravans = new Caravans(world, world.cities, u);
  const people = new People(u);
  scene.add(clipmap.group, cities.group, people.group, caravans.group, discoveries.group, wildlife.group, dust.group);

  const figure = new Figure(u);
  scene.add(figure.group);

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
        const name = `desertscape-${Date.now()}.png`;
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
    },
    { quality: auto.tier },
  );
  applyTier();
  discoveries.onReach = () => audio.chime();
  cities.onReach = () => audio.chime();
  player.roof = (x, z) => cities.roofAt(x, z);
  player.dip = (x, z) => cities.poolDepthAt(x, z);
  // What the camera must stay above: sand, or a roof.
  const topAt = (x: number, z: number) => Math.max(world.height(x, z), cities.roofAt(x, z));

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
  });
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
  const input: PlayerInput = { x: 0, z: 0, run: false, jump: false, glide: false, wind };
  const camTarget = new THREE.Vector3().copy(player.state.pos);
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const sliders: Array<{ x: number; z: number; life: number }> = [];
  let slideStampDist = 0;
  let cityNear = 0;
  let bustle = 0;
  let airCam = 0;
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
      if (player.state.onRock < 0.5) {
        trail.stamp(p.x, p.z, 0.35 + strength * 0.6, 1);
        tmp2.copy(player.state.vel).multiplyScalar(0.3).setY(2 + strength * 3);
        dust.puff(p, tmp2, 0.35 + strength * 0.65);
        cascade(p.x, p.z, Math.round(strength * 5));
      }
      audio.land(strength);
      buzz(6 + Math.round(strength * 18));
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
    input.glide = playing && (keys.has('Space') || touch.flyHeld);
    jumpQueued = false;
    player.update(dt, input, camYaw, events);

    // Riding leaves one clean line in the sand; carving widens it and throws spray to the outside.
    if (st.sliding && st.grounded && st.onRock < 0.5) {
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

    {
      const sp = Math.max(st.speed, 0.01);
      const slopeAlong = st.grounded ? -(st.vel.x * player.downhill.x + st.vel.z * player.downhill.y) / sp * player.slope : 0;
      figure.update(dt, st, player.facing, wind, frame.gust, { turn: player.turn, slopeAlong, gliding: player.gliding, climb: player.climb });
    }

    // Flying low drags a faint wake through the sand.
    if (!st.grounded && player.alt < 2 && st.speed > 6) {
      slideStampDist += st.speed * dt;
      if (slideStampDist > 0.5) {
        slideStampDist = 0;
        const near = 1 - player.alt / 2;
        if (world.sample(st.pos.x, st.pos.z, probe).rock < 0.5) {
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
    for (let i = 1; i <= 6; i++) {
      const d = (reach * i) / 6;
      const x = camTarget.x + tmp2.x * d;
      const z = camTarget.z + tmp2.z * d;
      const clear = camTarget.y + tmp2.y * d - (topAt(x, z) + 0.45);
      if (clear < 0) {
        dist = Math.min(dist, Math.max(1.2, d + clear / Math.max(0.2, tmp2.y + 0.6)));
        break;
      }
    }
    camera.position.copy(camTarget).addScaledVector(tmp2, dist);
    camera.position.y = Math.max(camera.position.y, topAt(camera.position.x, camera.position.z) + 0.7);
    camera.lookAt(camTarget);
    const fov = 50 + Math.min(14, st.speed * 0.55);
    if (Math.abs(camera.fov - fov) > 0.05) {
      camera.fov += (fov - camera.fov) * (1 - Math.exp(-dt * 3));
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
    sky.position.copy(camera.position);

    cities.update(dt, st.pos);
    bake.update(st.pos);
    clipmap.update(camera.position);
    trail.update(dt, st.pos.x, st.pos.z);
    dust.update(frame);
    discoveries.update(frame);
    wildlife.update(frame);
    caravans.update(frame);
    people.setCity(cities.active);
    people.update(frame);
    bustle = people.bustle;
    // How much of a city surrounds the listener: 0 out in the desert, rising from 900 m out to the centre.
    {
      const site = cities.nearest(st.pos.x, st.pos.z);
      const d = Math.hypot(site.cx - st.pos.x, site.cz - st.pos.z);
      const near = d > site.radius ? 0.7 * Math.max(0, 1 - (d - site.radius) / 900) : 0.7 + 0.3 * (1 - d / site.radius);
      cityNear = near;
      audio.setCity(near, bustle, d < site.radius * 0.92 && st.grounded);
    }
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
    Object.assign(window, { __ds: {
        // advance the simulation by a number of seconds at 60 Hz, then draw (for testing when the tab is throttled)
        sim: (sec: number) => {
          for (let i = 0; i < Math.round(sec * 60); i++) update(1 / 60);
          render();
        },
        freeze: (f: boolean) => (frozen = f),
        player, day, keys, world, trail, renderer, discoveries, wildlife, touch, ui, auto, cities, caravans, audio, people, cam: (y: number, p: number, d: number) => ((camYaw = y), (camPitch = p), (camDist = d)) } });
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
  uiHost.textContent = 'Desertscape needs WebGL 2, which this browser could not start.';
  uiHost.style.cssText = 'display:grid;place-items:center;color:#efe6d8;font:16px system-ui;padding:24px;text-align:center';
}
