# drone-control

A browser-based 3D drone flight simulator built with [Three.js](https://threejs.org/).
Fly a quadcopter through a procedurally placed field of box obstacles, using either
a real RC transmitter (e.g. RadioMaster) over USB or the keyboard.

## Features

- **Angle-mode flight physics** — sticks command tilt angles; thrust, gravity,
  and linear drag are integrated with semi-implicit Euler. Hover sits near 40%
  throttle (thrust-to-weight ratio ≈ 2.5).
- **RC transmitter support via the Gamepad API** — plug a RadioMaster (EdgeTX)
  in via USB and select *USB Joystick (HID)*. AETR and TAER channel maps are
  built in.
- **Controller calibration wizard** — sweeps axis ranges, captures stick
  centers, and auto-detects channel assignment and direction per control.
  Results persist in `localStorage`.
- **Obstacle course** — deterministic PRNG places the same box field on every
  load, with a clear zone around the spawn pad. Collision is sphere-vs-AABB.
- **Three camera modes** — Chase (soft follow), FPV, and Top.
- **Ready screen with arm check** — the sim refuses to arm while the throttle
  stick is up, so a connected transmitter can't launch the drone unexpectedly.
- **Math explainer** — the 💡 button opens a KaTeX-rendered modal covering the
  quaternion attitude math, Newtonian integration, stick response easing, AABB
  collision distance, and Gamepad API input shaping (English / Traditional Chinese).

## Controls

| Input | Action |
| --- | --- |
| RC transmitter | Throttle / yaw / pitch / roll per channel map or calibration |
| `W` / `S` | Throttle up / down |
| `A` / `D` | Yaw left / right |
| Arrow keys | Pitch / roll |
| `Space` / `Enter` | Start flying (arm) |
| `R` | Reset drone |

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
├── world.js          # ground, obstacle field, AABB collision
├── input.js          # Gamepad API + keyboard input, calibration storage
├── calibration.js    # controller calibration wizard
└── modal-content.js  # bilingual math explainer copy
```

## License

[MIT](LICENSE) © 2026 Jason Kuan ([jason9075](https://github.com/jason9075))
