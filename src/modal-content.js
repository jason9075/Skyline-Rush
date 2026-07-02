/**
 * Bilingual (English / Traditional Chinese) copy for the math explainer modal.
 * KaTeX delimiters: $...$ inline, $$...$$ display.
 */

export const modalCopy = {
  en: `
    <p>The drone flies in <strong>angle mode</strong>: the sticks command tilt angles, and physics does the rest.</p>
    <p><strong>1. Orientation.</strong> Pitch $\\phi$, yaw $\\psi$ and roll $\\theta$ are combined into a quaternion (Euler order YXZ). The single thrust vector points along the body-up axis:</p>
    <p>$$\\vec{F}_{thrust} = q \\, (0, 1, 0) \\, q^{-1} \\cdot T_{max} \\cdot u_{throttle}$$</p>
    <p>Tilting the body redirects part of the thrust horizontally — that horizontal component is what moves the drone forward or sideways.</p>
    <p><strong>2. Translation.</strong> Newton's second law with gravity and linear drag, integrated with semi-implicit Euler each frame:</p>
    <p>$$\\vec{a} = \\vec{F}_{thrust} + (0, -g, 0) - k_d \\vec{v}, \\qquad
       \\vec{v}_{t+\\Delta t} = \\vec{v}_t + \\vec{a}\\,\\Delta t, \\qquad
       \\vec{p}_{t+\\Delta t} = \\vec{p}_t + \\vec{v}_{t+\\Delta t}\\,\\Delta t$$</p>
    <p>With $T_{max} = 25\\,m/s^2$ and $g = 9.81\\,m/s^2$, hover sits near $40\\%$ throttle — just like a real quad with a thrust-to-weight ratio of about 2.5.</p>
    <p><strong>3. Stick response.</strong> Commanded tilt is eased exponentially so the body feels like it has inertia:</p>
    <p>$$\\phi \\leftarrow \\phi + (\\phi_{target} - \\phi)\\,(1 - e^{-\\lambda \\Delta t}) \\approx \\phi + (\\phi_{target} - \\phi)\\,\\min(1, \\lambda \\Delta t)$$</p>
    <p><strong>4. Collision.</strong> The drone is a sphere of radius $r$; each obstacle is an axis-aligned bounding box (AABB). They intersect when the distance from the sphere center $\\vec{c}$ to the box is less than $r$:</p>
    <p>$$d(\\vec{c}, B) = \\left\\| \\max(\\vec{b}_{min} - \\vec{c}, 0, \\vec{c} - \\vec{b}_{max}) \\right\\| < r$$</p>
    <p><strong>5. RC input.</strong> The RadioMaster in USB Joystick mode is a standard HID gamepad. Each channel arrives as an axis in $[-1, 1]$; throttle is remapped to $[0, 1]$ and a small deadband suppresses stick noise:</p>
    <pre><code class="language-js">const pad = navigator.getGamepads()[index];
const throttle = (pad.axes[2] + 1) / 2;      // AETR: ch3
const yaw = deadband(pad.axes[3]);           // AETR: ch4
const pitch = deadband(-pad.axes[1]);        // forward = +1
const roll = deadband(pad.axes[0]);</code></pre>
  `,
  zhTW: `
    <p>這台無人機採用 <strong>angle mode(自穩模式)</strong>:搖桿直接指定機身傾角,其餘交給物理模擬。</p>
    <p><strong>1. 姿態。</strong>Pitch $\\phi$、yaw $\\psi$、roll $\\theta$ 以 YXZ 順序組成 quaternion。推力向量永遠沿著機體的「上方」軸:</p>
    <p>$$\\vec{F}_{thrust} = q \\, (0, 1, 0) \\, q^{-1} \\cdot T_{max} \\cdot u_{throttle}$$</p>
    <p>機身一傾斜,推力就會產生水平分量 — 這個分量就是無人機前進與側移的來源。</p>
    <p><strong>2. 平移運動。</strong>牛頓第二定律加上重力與線性阻力,每一幀用 semi-implicit Euler 積分:</p>
    <p>$$\\vec{a} = \\vec{F}_{thrust} + (0, -g, 0) - k_d \\vec{v}, \\qquad
       \\vec{v}_{t+\\Delta t} = \\vec{v}_t + \\vec{a}\\,\\Delta t, \\qquad
       \\vec{p}_{t+\\Delta t} = \\vec{p}_t + \\vec{v}_{t+\\Delta t}\\,\\Delta t$$</p>
    <p>當 $T_{max} = 25\\,m/s^2$、$g = 9.81\\,m/s^2$ 時,懸停大約在 $40\\%$ 油門 — 等效於推重比約 2.5 的真實四軸機。</p>
    <p><strong>3. 搖桿響應。</strong>指令傾角以指數方式漸進逼近,讓機身帶有慣性的手感:</p>
    <p>$$\\phi \\leftarrow \\phi + (\\phi_{target} - \\phi)\\,(1 - e^{-\\lambda \\Delta t}) \\approx \\phi + (\\phi_{target} - \\phi)\\,\\min(1, \\lambda \\Delta t)$$</p>
    <p><strong>4. 碰撞偵測。</strong>無人機視為半徑 $r$ 的球體,障礙物是 axis-aligned bounding box(AABB)。當球心 $\\vec{c}$ 到方塊的距離小於 $r$ 即發生碰撞:</p>
    <p>$$d(\\vec{c}, B) = \\left\\| \\max(\\vec{b}_{min} - \\vec{c}, 0, \\vec{c} - \\vec{b}_{max}) \\right\\| < r$$</p>
    <p><strong>5. RC 輸入。</strong>RadioMaster 開啟 USB Joystick 模式後就是標準 HID gamepad。每個 channel 對應一個 $[-1, 1]$ 的 axis;油門重新映射到 $[0, 1]$,並加上 deadband 消除搖桿雜訊:</p>
    <pre><code class="language-js">const pad = navigator.getGamepads()[index];
const throttle = (pad.axes[2] + 1) / 2;      // AETR: ch3
const yaw = deadband(pad.axes[3]);           // AETR: ch4
const pitch = deadband(-pad.axes[1]);        // 前推 = +1
const roll = deadband(pad.axes[0]);</code></pre>
  `,
};
