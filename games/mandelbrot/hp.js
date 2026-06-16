/*
 * High-precision helpers for perturbation-theory deep zoom.
 *
 * Real numbers are carried as BigInt fixed-point with a power-of-two scale:
 * a value v at precision P bits is stored as the integer round(v * 2^P).
 * This is exact, dependency-free, and fast enough to iterate a reference
 * orbit of thousands of steps every frame.
 *
 * Only the *view center* and the *reference orbit* need this precision.
 * Everything a pixel touches (its offset from the reference) stays small and
 * lives happily in ordinary doubles / float32 on the GPU.
 */

// round(d * 2^P) as a BigInt — exact, via the IEEE-754 bit pattern so it
// never overflows for huge P or tiny d.
function doubleToFixed(d, P) {
  if (d === 0 || !isFinite(d)) return 0n;
  const dv = doubleToFixed._dv || (doubleToFixed._dv = new DataView(new ArrayBuffer(8)));
  dv.setFloat64(0, d);
  const hi = dv.getUint32(0);
  const lo = dv.getUint32(4);
  const sign = hi >>> 31 ? -1n : 1n;
  let exp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo >>> 0);
  if (exp === 0) {
    exp = -1074;                 // subnormal
  } else {
    mant |= 1n << 52n;           // implicit leading 1
    exp -= 1075;                 // value = mant * 2^exp
  }
  const shift = BigInt(exp) + BigInt(P);
  const bi = shift >= 0n ? mant << shift : mant >> -shift;
  return sign * bi;
}

// BigInt fixed-point -> nearest double.
function fixedToDouble(x, P) {
  if (x === 0n) return 0;
  const neg = x < 0n;
  let a = neg ? -x : x;
  const bits = a.toString(2).length;
  const keep = 62;
  let drop = 0;
  if (bits > keep) {
    drop = bits - keep;
    a >>= BigInt(drop);
  }
  const v = Number(a) * Math.pow(2, drop - P);
  return neg ? -v : v;
}

// Decimal string of a fixed-point value with `digits` fractional digits.
function fixedToDecimalString(x, P, digits) {
  const neg = x < 0n;
  let a = neg ? -x : x;
  const Pb = BigInt(P);
  const ip = a >> Pb;
  const frac = a - (ip << Pb);
  const scale = 10n ** BigInt(digits);
  const fd = (frac * scale) >> Pb;
  const fs = fd.toString().padStart(digits, "0");
  return (neg ? "-" : "") + ip.toString() + "." + fs;
}

/*
 * Compute the Mandelbrot reference orbit Z_0..Z_n for C = (Cx, Cy)
 * (BigInt fixed-point at scale 2^P), iterating in full precision and
 * storing each Z as a pair of float32 for the GPU.
 *
 * Returns { data: Float64Array([Zx0,Zy0,Zx1,Zy1,...]), length }.
 * Values are full doubles so the caller can split them into double-float
 * (hi+lo) for the GPU; storing as float32 here would throw away the low
 * bits the perturbation needs at extreme depth.
 * Stops early if the reference itself escapes (|Z| > 2).
 */
function computeReferenceOrbit(Cx, Cy, P, maxIter) {
  const Pb = BigInt(P);
  const Pm1 = BigInt(P - 1);
  const four = 4n << Pb; // |z|^2 > 4 threshold at scale 2^P
  let zx = 0n;
  let zy = 0n;
  const data = new Float64Array((maxIter + 2) * 2);
  let length = 0;
  for (let i = 0; i <= maxIter; i++) {
    data[2 * i] = fixedToDouble(zx, P);
    data[2 * i + 1] = fixedToDouble(zy, P);
    length = i + 1;
    const zx2 = (zx * zx) >> Pb; // scale 2^P
    const zy2 = (zy * zy) >> Pb;
    if (zx2 + zy2 > four) break;
    const nzx = zx2 - zy2 + Cx;
    const nzy = ((zx * zy) >> Pm1) + Cy; // 2*zx*zy
    zx = nzx;
    zy = nzy;
  }
  return { data: data, length: length };
}

// Bits of precision needed to resolve a view of vertical extent `span`.
function neededPrecision(span, baseSpan) {
  const mag = baseSpan / span;
  let bits = Math.ceil(Math.log2(Math.max(1, mag))) + 40; // guard bits
  bits = Math.max(53, bits);
  return Math.ceil(bits / 16) * 16;
}

// node self-test hook (ignored in the browser)
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    doubleToFixed, fixedToDouble, fixedToDecimalString,
    computeReferenceOrbit, neededPrecision,
  };
}
