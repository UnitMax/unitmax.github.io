/*
 * GLSL sources for the Mandelbrot visualizer.
 * Written in GLSL ES 1.00 so the same source compiles on both WebGL1 and WebGL2.
 * Kept as plain strings (never fetched) so the page works straight from file://.
 *
 * Two fragment programs are produced from one body via the DEEP preprocessor flag:
 *   - fast: single-precision highp float (shallow / medium zoom)
 *   - deep: emulated double precision ("double-float" / df64) for ultra-deep zoom
 */

const MB_VERT = `
attribute vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

// Common fragment body. Uses #ifdef DEEP to switch the heavy math between
// single precision and emulated double precision.
const MB_FRAG_COMMON = `
uniform vec2  u_resolution;   // backing-store pixels
uniform vec2  u_centerX;      // complex-plane center X as df64 (hi, lo)
uniform vec2  u_centerY;      // complex-plane center Y as df64 (hi, lo)
uniform float u_span;         // vertical extent of the view in complex units
uniform int   u_maxIter;
uniform int   u_aa;           // samples per axis (1 = off, 2 = 2x2 SSAA)
uniform int   u_julia;        // 0 = mandelbrot, 1 = julia
uniform vec2  u_juliaX;       // julia constant X as df64
uniform vec2  u_juliaY;       // julia constant Y as df64
uniform float u_colorDensity;
uniform float u_colorShift;
uniform vec3  u_stops[6];     // cool palette, cyclic
uniform vec3  u_interior;     // color of points inside the set

const int MAX_ITER = 2000;
const int MAX_AA   = 2;
const float LOG2   = 0.6931471805599453;
const float ESCAPE2 = 256.0;  // |z|^2 escape threshold (R = 16)

/* ---- emulated double precision (df64) -------------------------------- */
vec2 ds_set(float a) { return vec2(a, 0.0); }

vec2 ds_add(vec2 a, vec2 b) {
  float t1 = a.x + b.x;
  float e  = t1 - a.x;
  float t2 = ((b.x - e) + (a.x - (t1 - e))) + a.y + b.y;
  float hi = t1 + t2;
  return vec2(hi, t2 - (hi - t1));
}

vec2 ds_sub(vec2 a, vec2 b) { return ds_add(a, vec2(-b.x, -b.y)); }

vec2 ds_mul(vec2 a, vec2 b) {
  float split = 4097.0;            // 2^12 + 1, Veltkamp split for 24-bit float
  float cona = a.x * split;
  float conb = b.x * split;
  float a1 = cona - (cona - a.x);
  float b1 = conb - (conb - b.x);
  float a2 = a.x - a1;
  float b2 = b.x - b1;
  float c11 = a.x * b.x;
  float c21 = a2 * b2 + (a2 * b1 + (a1 * b2 + (a1 * b1 - c11)));
  float c2  = a.x * b.y + a.y * b.x;
  float t1  = c11 + c2;
  float e   = t1 - c11;
  float t2  = a.y * b.y + ((c2 - e) + (c11 - (t1 - e))) + c21;
  float hi  = t1 + t2;
  return vec2(hi, t2 - (hi - t1));
}

/* ---- palette --------------------------------------------------------- */
vec3 getStop(int i) {
  if (i <= 0) return u_stops[0];
  if (i == 1) return u_stops[1];
  if (i == 2) return u_stops[2];
  if (i == 3) return u_stops[3];
  if (i == 4) return u_stops[4];
  return u_stops[5];
}

vec3 palette(float p) {
  p = fract(p);
  float x = p * 6.0;
  int i = int(floor(x));
  float f = fract(x);
  f = f * f * (3.0 - 2.0 * f);            // smoothstep blend between stops
  vec3 c0 = getStop(i);
  vec3 c1 = getStop(i >= 5 ? 0 : i + 1);
  return mix(c0, c1, f);
}

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

/* ---- one sample ------------------------------------------------------ */
vec3 sampleColor(vec2 frag) {
  vec2 uv = (frag - 0.5 * u_resolution) / u_resolution.y; // y in [-0.5, 0.5]
  float ox = uv.x * u_span;
  float oy = uv.y * u_span;

  bool escaped = false;
  float m2 = 0.0;
  float n = 0.0;

#ifdef DEEP
  vec2 cx = ds_add(u_centerX, ds_set(ox));
  vec2 cy = ds_add(u_centerY, ds_set(oy));
  vec2 zx, zy, ax, ay;
  if (u_julia == 1) { zx = cx; zy = cy; ax = u_juliaX; ay = u_juliaY; }
  else              { zx = ds_set(0.0); zy = ds_set(0.0); ax = cx; ay = cy; }

  for (int i = 0; i < MAX_ITER; i++) {
    if (i >= u_maxIter) break;
    vec2 zx2 = ds_mul(zx, zx);
    vec2 zy2 = ds_mul(zy, zy);
    m2 = zx2.x + zy2.x;
    if (m2 > ESCAPE2) { escaped = true; break; }
    vec2 xy = ds_mul(zx, zy);
    zx = ds_add(ds_sub(zx2, zy2), ax);
    zy = ds_add(ds_add(xy, xy), ay);
    n += 1.0;
  }
#else
  float cx = u_centerX.x + ox;
  float cy = u_centerY.x + oy;
  float zx, zy, ax, ay;
  if (u_julia == 1) { zx = cx; zy = cy; ax = u_juliaX.x; ay = u_juliaY.x; }
  else              { zx = 0.0; zy = 0.0; ax = cx; ay = cy; }

  for (int i = 0; i < MAX_ITER; i++) {
    if (i >= u_maxIter) break;
    float zx2 = zx * zx;
    float zy2 = zy * zy;
    m2 = zx2 + zy2;
    if (m2 > ESCAPE2) { escaped = true; break; }
    float xy = zx * zy;
    zx = zx2 - zy2 + ax;
    zy = xy + xy + ay;
    n += 1.0;
  }
#endif

  if (!escaped) return u_interior;

  // continuous (smooth) iteration count -> no banding
  float log_zn = log(m2) * 0.5;
  float nu = log(log_zn / LOG2) / LOG2;
  float sn = n + 1.0 - nu;

  float p = sn * u_colorDensity + u_colorShift;
  return palette(p);
}

void main() {
  vec3 col = vec3(0.0);
  float inv = 1.0 / float(u_aa);
  float count = 0.0;
  for (int sx = 0; sx < MAX_AA; sx++) {
    if (sx >= u_aa) break;
    for (int sy = 0; sy < MAX_AA; sy++) {
      if (sy >= u_aa) break;
      vec2 sub = (vec2(float(sx), float(sy)) + 0.5) * inv - 0.5;
      col += sampleColor(gl_FragCoord.xy + sub);
      count += 1.0;
    }
  }
  col /= count;

  // a touch of ordered noise hides 8-bit gradient banding
  col += (hash21(gl_FragCoord.xy) - 0.5) * (1.0 / 255.0);

  gl_FragColor = vec4(col, 1.0);
}
`;

function mbFragSource(deep) {
  const head =
    (deep ? "#define DEEP 1\n" : "") +
    "precision highp float;\n" +
    "precision mediump int;\n";
  return head + MB_FRAG_COMMON;
}
