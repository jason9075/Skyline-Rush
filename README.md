# Skyline Rush

A browser-based 3D drone flight simulator built with [Three.js](https://threejs.org/),
with a white city under a bright sky and red accents. Fly a quadcopter through
an infinite procedurally generated city, using either a real RC transmitter
(e.g. RadioMaster) over USB or the keyboard.

## Features

- **Angle-mode flight physics** — sticks command tilt angles; thrust, gravity,
  and linear drag are integrated with semi-implicit Euler. Hover sits near 40%
  throttle (thrust-to-weight ratio ≈ 2.5).
- **Game controller support via the Gamepad API** — a **Control Preset**
  dropdown maps a standard gamepad (Xbox) or a RadioMaster (EdgeTX, AETR/TAER)
  in one click; plug in and fly.
- **DCS-style axis binding grid** — columns are devices, rows are controls:
  click a cell to bind a control to an axis on any device (split HOTAS / dual
  stick), toggle reverse, and calibrate an axis's range per cell. Offline
  devices keep a column so their bindings can be moved onto a live device.
  Results persist in `localStorage`.
- **Infinite procedural city** — a deterministic street network (see
  `citygen.js`): a regular grid is domain-warped into gently **curving streets**,
  with wide **arterials** every third line, narrow alleys between, and
  **roundabouts** at a low probability where arterials cross. Real Taipei
  building models (`assets/buildings/`, glTF binary) are placed on the resulting
  blocks — each sized to fit the local clearance, oriented toward the nearest
  road, and picked from a height bucket chosen by a low-frequency downtown/
  outskirts zone. Every area is identical on every visit while the city extends
  forever; the curved roads are rasterized into each chunk's ground texture.
  The quadcopter is modelled at true scale (~0.9 m span) against ~20 m buildings.
  Collision is sphere-vs-AABB against nearby chunks; buildings near the camera
  fade to translucent so they never block the view.
- **Game modes** — *Free Flight*, *Gate Rush* (endless timed slalom through
  procedural gates), and *Strike* (bombing run): an enemy force — a machine-gun
  tank and shotgun soldiers — spawns on the open road ahead. The drone carries
  no gun; a bomb regenerates every few seconds and is dropped with `Space`, with
  a ~4 m blast (soldiers die in one, the tank in three). Enemies start
  dormant and only fire once the drone is in range, in line of sight, and inside
  their vision cone; they lock a lagging aim point and spit tracer rounds that
  travel, so **staying still gets you hit — keep moving to dodge both the lead
  and the bullets**. A blast swings nearby dormant heads toward it, so
  explosions bait aggro. The mission ends when the force is wiped (win) or the
  drone's 10 HP runs out.
- **Three camera modes** — Chase (soft follow), FPV, and Top.
- **Ready screen with arm check** — the sim refuses to arm while the throttle
  stick is up, so a connected transmitter can't launch the drone unexpectedly.
- **God Mode** — a control-panel toggle that disables crashing; hard landings
  and obstacle hits no longer reset the flight.

## Controls

| Input | Action |
| --- | --- |
| Game controller | Throttle / yaw / pitch / roll per the Control Preset or custom binding |
| `W` / `S` | Throttle up / down |
| `A` / `D` | Yaw left / right |
| Arrow keys | Pitch / roll |
| `Space` / `Enter` | Start flying (arm) |
| `Space` (in flight) | Drop bomb (Strike mode) |
| `R` | Reset drone |
| `C` | Cycle camera mode (Chase → FPV → Top) |

### RadioMaster setup

1. Power on the radio **before** connecting USB (a powered-off radio enumerates
   as a charger/bootloader, not a joystick).
2. Connect USB and choose **USB Joystick (HID)** on the radio. If no prompt
   appears, set `SYS → Hardware → USB mode` to `Ask` or `Joystick`.
3. Move a stick once — browsers only report a gamepad after its first input.
4. The stick overlay at the bottom-left mirrors input even on the ready screen,
   so you can verify the connection before takeoff. Run **Calibrate Controller**
   from the main menu once; the mapping is saved for future sessions.

## Development

The project uses a Nix flake for the toolchain and a `justfile` for tasks.

```sh
direnv allow   # or: nix develop
just install   # npm install --ignore-scripts
just dev       # Vite dev server → http://localhost:8080
```

Other targets:

```sh
just build     # production build → dist/
just preview   # build and serve dist/ on :8080
just clean     # remove dist/ and node_modules/
```

> **NixOS note:** `scripts/fix-noexec.cjs` copies native binaries (esbuild) to
> `/tmp` before execution to work around `noexec` home partitions; the npm
> scripts and `justfile` targets already wire it in.

## Deployment

Pushing to `main` triggers the GitHub Actions workflow in
`.github/workflows/deploy.yml`, which builds the site and publishes `dist/` to
GitHub Pages. The production base path is `/drone-control/` (see
`vite.config.js`); change it if the repository name differs.

## Project layout

```
src/
├── main.js           # scene, main loop, HUD, cameras, overlays
├── drone.js          # quadcopter mesh + angle-mode flight physics
├── gates.js          # Gate Rush course: planning, guide lines, pass detection
├── strike.js         # Strike mode: enemy force, weapon AI, bombs, blast damage
├── world.js          # chunk streaming: ground tiles, placement, AABB collision
├── citygen.js        # deterministic PCG: warped streets, roundabouts, zoning
├── buildings.js      # GLB building loader (merges primitives, centers geometry)
├── input.js          # Gamepad API + keyboard input, axis-binding storage
├── controls-ui.js    # ready-screen input UI: preset dropdown + binding grid
├── presets.js        # one-click axis-binding presets (Xbox / RadioMaster)
├── axisbind.js       # single-cell axis capture for the binding grid
└── calibration.js    # per-axis range calibration for a bound cell
```

## License

[MIT](LICENSE) © 2026 Jason Kuan ([jason9075](https://github.com/jason9075))
