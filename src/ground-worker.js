/**
 * Ground-tile rasterizer worker.
 *
 * Renders one chunk's road field into an RGBA buffer at high resolution,
 * off the main thread. Detail features: signed-distance anti-aliased road
 * edges, sidewalk strips along roads, dashed centerline markings (including
 * around roundabout rings), a fake curb bevel (a contact-shadow + rim-light
 * pair straddling the road/sidewalk edge, since the ground is a flat plane
 * with no real elevation change), and a subtle pavement dither.
 */

import { sampleCityDetail } from './citygen.js';

/** Base colors (sRGB). */
const COL_GROUND = [187, 196, 211];
const COL_SIDEWALK = [219, 223, 227];
const COL_PLAZA = [214, 218, 222];
const COL_MAJOR = [64, 68, 74];
const COL_MINOR = [88, 92, 98];
const COL_DASH = [198, 203, 208];

/** Sidewalk strip width outside the road edge, meters. */
const SIDEWALK_WIDTH = 1.8;
/** Dash pattern: period and duty cycle along the road, meters. */
const DASH_PERIOD = 6;
const DASH_DUTY = 0.55;
/** Dash half-width, meters. */
const DASH_HALF = 0.22;

/**
 * Fake curb bevel: since the ground has no real elevation, a raised curb is
 * faked with a dark contact-shadow strip on the road side of the edge and a
 * light rim-highlight strip on the sidewalk side, both centered on `s.edge`
 * (meters, signed distance to the road edge) and independent of light
 * direction — this reads fine from any camera angle.
 */
const CURB_SHADOW_CENTER = -0.08;
const CURB_SHADOW_HALF = 0.36;
const CURB_SHADOW_STRENGTH = 0.6;
const CURB_HILITE_CENTER = 0.18;
const CURB_HILITE_HALF = 0.46;
const CURB_HILITE_STRENGTH = 0.85;

/**
 * Smooth unit bump centered at `center`, reaching 0 past `half` away.
 * @param {number} d Signed distance to evaluate.
 * @param {number} center Bump center.
 * @param {number} half Half-width (distance to falloff to 0).
 * @returns {number} 0..1
 */
function bump(d, center, half) {
  const t = 1 - clamp01(Math.abs(d - center) / half);
  return t * t * (3 - 2 * t);
}

/**
 * Cheap deterministic per-cell dither in [-1, 1].
 * @param {number} x World x.
 * @param {number} z World z.
 * @returns {number}
 */
function dither(x, z) {
  const ix = Math.floor(x * 3);
  const iz = Math.floor(z * 3);
  let h = (Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (((h ^ (h >>> 16)) >>> 0) / 4294967296) * 2 - 1;
}

/**
 * Linear blend between two RGB triplets.
 * @param {number[]} a From color.
 * @param {number[]} b To color.
 * @param {number} t Blend factor 0..1.
 * @returns {number[]}
 */
function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** @param {number} v @returns {number} */
const clamp01 = (v) => Math.min(1, Math.max(0, v));

self.onmessage = (e) => {
  const { id, originX, originZ, size, res } = e.data;
  const data = new Uint8ClampedArray(res * res * 4);
  const mpp = size / res;

  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const wx = originX + ((i + 0.5) / res) * size;
      const wz = originZ + ((j + 0.5) / res) * size;
      const s = sampleCityDetail(wx, wz);

      let rgb;
      if (s.plaza) {
        rgb = COL_PLAZA;
      } else {
        // Block surface with a sidewalk strip hugging the road edge.
        const sidewalkT = clamp01((s.edge - SIDEWALK_WIDTH) / mpp + 0.5);
        let surface = mix(COL_SIDEWALK, COL_GROUND, sidewalkT);

        // Road, anti-aliased against the surface across one pixel.
        const road = s.major ? COL_MAJOR : COL_MINOR;
        const roadT = clamp01(s.edge / mpp + 0.5);
        rgb = mix(road, surface, roadT);

        // Fake curb bevel: an AO shadow just inside the road, and a rim
        // highlight just inside the sidewalk, straddling the edge.
        const shadowAmt = bump(s.edge, CURB_SHADOW_CENTER, CURB_SHADOW_HALF) * CURB_SHADOW_STRENGTH;
        rgb = [rgb[0] * (1 - shadowAmt), rgb[1] * (1 - shadowAmt), rgb[2] * (1 - shadowAmt)];
        const hiliteAmt = bump(s.edge, CURB_HILITE_CENTER, CURB_HILITE_HALF) * CURB_HILITE_STRENGTH;
        rgb = mix(rgb, [255, 255, 255], hiliteAmt);

        // Dashed centerline, only well inside the road and away from
        // intersections (crossEdge small means another road is crossing).
        if (s.edge < -1 && s.crossEdge > 3) {
          const phase = ((s.along % DASH_PERIOD) + DASH_PERIOD) % DASH_PERIOD;
          if (phase < DASH_PERIOD * DASH_DUTY) {
            const dashT = clamp01((DASH_HALF - s.centerDist) / mpp + 0.5);
            rgb = mix(rgb, COL_DASH, dashT);
          }
        }
      }

      const grain = dither(wx, wz) * 2.5;
      const o = (j * res + i) * 4;
      data[o] = rgb[0] + grain;
      data[o + 1] = rgb[1] + grain;
      data[o + 2] = rgb[2] + grain;
      data[o + 3] = 255;
    }
  }

  self.postMessage({ id, res, buffer: data.buffer }, [data.buffer]);
};
