/*
 * Mandelbrot visualizer — WebGL engine + UI.
 * Pure vanilla JS, no frameworks, no build step. Works from file:// or http.
 *
 * Three render paths, picked by zoom depth / capability:
 *   - fast   : single-precision direct iteration (shallow), WebGL1/2
 *   - perturb: perturbation theory + high-precision reference orbit (deep), WebGL2
 *   - df64   : emulated double precision (deep fallback when no WebGL2)
 */
(function () {
  "use strict";

  /* ----------------------------------------------------------------- *
   * Palettes (cool & elegant only). Each has 6 cyclic stops in 0..1.   *
   * ----------------------------------------------------------------- */
  const PALETTES = [
    {
      name: "Twilight",
      stops: [
        [0.02, 0.02, 0.08], [0.15, 0.09, 0.40], [0.40, 0.20, 0.66],
        [0.66, 0.40, 0.90], [0.34, 0.60, 0.95], [0.07, 0.13, 0.30],
      ],
      interior: [0.015, 0.018, 0.045],
    },
    {
      name: "Glacier",
      stops: [
        [0.01, 0.03, 0.09], [0.03, 0.17, 0.38], [0.06, 0.42, 0.68],
        [0.34, 0.74, 0.92], [0.85, 0.96, 1.00], [0.09, 0.28, 0.50],
      ],
      interior: [0.01, 0.025, 0.06],
    },
    {
      name: "Abyss",
      stops: [
        [0.00, 0.00, 0.01], [0.00, 0.12, 0.18], [0.00, 0.33, 0.42],
        [0.06, 0.62, 0.68], [0.30, 0.92, 0.98], [0.00, 0.17, 0.30],
      ],
      interior: [0.0, 0.012, 0.022],
    },
    {
      name: "Mono",
      stops: [
        [0.03, 0.04, 0.05], [0.17, 0.19, 0.23], [0.37, 0.41, 0.47],
        [0.62, 0.67, 0.74], [0.92, 0.95, 0.99], [0.20, 0.23, 0.28],
      ],
      interior: [0.02, 0.024, 0.03],
    },
  ];
  PALETTES.forEach((p) => {
    p.flatStops = new Float32Array(p.stops.length * 3);
    p.stops.forEach((c, i) => {
      p.flatStops[i * 3] = c[0];
      p.flatStops[i * 3 + 1] = c[1];
      p.flatStops[i * 3 + 2] = c[2];
    });
    p.css =
      "linear-gradient(135deg," +
      p.stops.map((c) => rgb(c)).join(",") +
      "," + rgb(p.stops[0]) + ")";
  });

  function rgb(c) {
    const f = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);
    return "rgb(" + f(c[0]) + "," + f(c[1]) + "," + f(c[2]) + ")";
  }

  /* ----------------------------------------------------------------- *
   * Quality presets.                                                   *
   * ----------------------------------------------------------------- */
  const QUALITY = {
    low:    { iterBase: 140, iterK: 26, interactiveScale: 0.45, stillScale: 0.85, stillAA: 1, deepCap: 2500,  interCap: 900 },
    medium: { iterBase: 220, iterK: 38, interactiveScale: 0.60, stillScale: 1.00, stillAA: 1, deepCap: 5000,  interCap: 1500 },
    high:   { iterBase: 320, iterK: 50, interactiveScale: 0.75, stillScale: 1.00, stillAA: 2, deepCap: 9000,  interCap: 2500 },
    ultra:  { iterBase: 480, iterK: 64, interactiveScale: 1.00, stillScale: 1.00, stillAA: 2, deepCap: 16000, interCap: 4000 },
  };

  /* ----------------------------------------------------------------- */
  const DEFAULT = { cx: -0.6, cy: 0.0, span: 2.6 };
  const MIN_SPAN_DF64 = 6e-12;     // emulated-double limit (WebGL1 deep)
  const MIN_SPAN_PERTURB = 1e-32;  // perturbation limit (~1e32x, float32 delta range)
  const MAX_SPAN = 6.0;
  const DEEP_THRESHOLD = 1.0e-4;
  const IDLE_MS = 140;

  const canvas = document.getElementById("gl");
  const fallback = document.getElementById("fallback");

  let gl = null;
  try {
    gl =
      canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: false }) ||
      canvas.getContext("webgl", { antialias: false }) ||
      canvas.getContext("experimental-webgl", { antialias: false });
  } catch (e) { gl = null; }

  if (!gl) {
    if (fallback) fallback.hidden = false;
    return;
  }

  const isWebGL2 =
    typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;

  // highp probe — fall back to mediump if the device lacks high float precision.
  let precWord = "highp";
  const hp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  if (!hp || hp.precision < 16) precWord = "mediump";

  /* ----------------------------------------------------------------- *
   * Shader / program helpers.                                          *
   * ----------------------------------------------------------------- */
  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error("Shader compile failed:\n" + gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  function linkProgram(vsrc, fsrc, uniformNames) {
    const vs = compile(gl.VERTEX_SHADER, vsrc);
    const fs = compile(gl.FRAGMENT_SHADER, fsrc);
    if (!vs || !fs) return null;
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error("Program link failed:\n" + gl.getProgramInfoLog(program));
      return null;
    }
    const loc = { a_pos: gl.getAttribLocation(program, "a_pos") };
    uniformNames.forEach((u) => { loc[u] = gl.getUniformLocation(program, u); });
    return { program: program, loc: loc };
  }

  function buildDirect(deep) {
    let fsrc = mbFragSource(deep);
    if (precWord !== "highp") fsrc = fsrc.replace(/highp/g, "mediump");
    return linkProgram(MB_VERT, fsrc, [
      "u_resolution", "u_centerX", "u_centerY", "u_span", "u_maxIter",
      "u_aa", "u_julia", "u_juliaX", "u_juliaY", "u_colorDensity",
      "u_colorShift", "u_stops", "u_interior",
    ]);
  }

  const progFast = buildDirect(false);
  const progDeep = buildDirect(true);
  if (!progFast) {
    if (fallback) fallback.hidden = false;
    return;
  }

  const progPerturb = isWebGL2
    ? linkProgram(MB_VERT_300, MB_FRAG_PERTURB, [
        "u_resolution", "u_spanHL", "u_maxIter", "u_aa", "u_refLength",
        "u_refTex", "u_colorDensity", "u_colorShift", "u_stops", "u_interior",
      ])
    : null;

  const minSpan = progPerturb ? MIN_SPAN_PERTURB : (progDeep ? MIN_SPAN_DF64 : 8e-6);

  // Reference-orbit texture (perturbation path).
  let refTex = null;
  if (progPerturb) {
    refTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, refTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  // Full-screen quad.
  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW
  );

  /* ----------------------------------------------------------------- *
   * State.  The view center is high-precision (BigInt fixed-point at   *
   * scale 2^P) so pan/zoom stays exact at any depth; span is a double. *
   * ----------------------------------------------------------------- */
  let P = neededPrecision(DEFAULT.span, DEFAULT.span);
  const view = { x: doubleToFixed(DEFAULT.cx, P), y: doubleToFixed(DEFAULT.cy, P), span: DEFAULT.span * 1.7 };
  const target = { x: doubleToFixed(DEFAULT.cx, P), y: doubleToFixed(DEFAULT.cy, P), span: DEFAULT.span };

  const state = {
    paletteIndex: 0,
    quality: "high",
    density: 0.022,
    colorShift: 0.0,
    shimmer: false,
    julia: false,
    juliaLive: false,
    juliaX: -0.8, juliaY: 0.156,
    juliaTX: -0.8, juliaTY: 0.156,
  };
  let savedView = null;

  let mode = "interactive";
  let needsRender = true;
  let lastInteract = performance.now();

  /* ----------------------------------------------------------------- *
   * Sizing.                                                            *
   * ----------------------------------------------------------------- */
  function applyRenderSize() {
    const q = QUALITY[state.quality];
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const scale = mode === "interactive" ? q.interactiveScale : q.stillScale;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr * scale));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    needsRender = true;
  }

  function markInteract() {
    lastInteract = performance.now();
    needsRender = true;
    if (mode !== "interactive") {
      mode = "interactive";
      applyRenderSize();
    }
  }

  /* ----------------------------------------------------------------- *
   * Math / precision helpers.                                          *
   * ----------------------------------------------------------------- */
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function split(v) {
    const hi = Math.fround(v);
    return [hi, v - hi];
  }

  // normalized coords: x in [-aspect/2..], y in [-0.5,0.5], +y up
  function uvAt(px, py, w, h) {
    return { x: (px - 0.5 * w) / h, y: (0.5 * h - py) / h };
  }

  function centerCx() { return fixedToDouble(view.x, P); }
  function centerCy() { return fixedToDouble(view.y, P); }

  // grow/shrink working precision, rescaling the BigInt centers in place
  function setPrecision(newP) {
    if (newP === P) return;
    if (newP > P) {
      const d = BigInt(newP - P);
      view.x <<= d; view.y <<= d; target.x <<= d; target.y <<= d;
    } else {
      const d = BigInt(P - newP);
      view.x >>= d; view.y >>= d; target.x >>= d; target.y >>= d;
    }
    P = newP;
  }

  function adaptPrecision() {
    setPrecision(neededPrecision(Math.min(view.span, target.span), DEFAULT.span));
  }

  // Julia uses the direct shaders (no perturbation), so it caps at the
  // emulated-double / float depth limit.
  function currentMinSpan() {
    if (state.julia) return progDeep ? MIN_SPAN_DF64 : 8e-6;
    return minSpan;
  }

  function currentMaxIter() {
    const q = QUALITY[state.quality];
    const mag = DEFAULT.span / view.span;
    let it = q.iterBase + q.iterK * Math.max(0, Math.log2(mag));
    const deep = !state.julia && progPerturb && view.span < DEEP_THRESHOLD;
    it = clamp(it, 80, deep ? q.deepCap : 2000);
    if (mode !== "still") it = Math.min(it, q.interCap);
    return Math.round(it);
  }

  /* ----------------------------------------------------------------- *
   * Easing of the view toward the target.                              *
   * ----------------------------------------------------------------- */
  function stepEasing() {
    const e = 0.16;
    const ls = Math.log(view.span);
    const lt = Math.log(target.span);
    const dls = lt - ls;
    const dxF = fixedToDouble(target.x - view.x, P);
    const dyF = fixedToDouble(target.y - view.y, P);

    const spanClose = Math.abs(dls) < 1e-4;
    const cxClose = Math.abs(dxF) < view.span * 1e-4;
    const cyClose = Math.abs(dyF) < view.span * 1e-4;
    if (spanClose && cxClose && cyClose) {
      view.x = target.x; view.y = target.y; view.span = target.span;
      return false;
    }
    view.span = Math.exp(ls + dls * e);
    view.x += doubleToFixed(dxF * e, P);
    view.y += doubleToFixed(dyF * e, P);
    return true;
  }

  /* ----------------------------------------------------------------- *
   * Reference orbit (perturbation). Recomputed when the center, depth  *
   * precision, or required iteration count changes.                    *
   * ----------------------------------------------------------------- */
  let refLengthVal = 0;
  const orbitState = { x: null, y: null, P: -1, maxIter: -1 };

  function ensureReferenceOrbit(maxIter) {
    if (orbitState.x === view.x && orbitState.y === view.y &&
        orbitState.P === P && orbitState.maxIter >= maxIter) return;
    const orb = computeReferenceOrbit(view.x, view.y, P, maxIter);
    const M = Math.max(2, orb.length);
    const w = Math.min(2048, M);
    const h = Math.ceil(M / w);
    // pack each Z as double-float: (Zx_hi, Zx_lo, Zy_hi, Zy_lo)
    const tex = new Float32Array(w * h * 4);
    for (let k = 0; k < orb.length; k++) {
      const zx = orb.data[2 * k], zy = orb.data[2 * k + 1];
      const xh = Math.fround(zx), yh = Math.fround(zy);
      tex[4 * k] = xh; tex[4 * k + 1] = zx - xh;
      tex[4 * k + 2] = yh; tex[4 * k + 3] = zy - yh;
    }
    gl.bindTexture(gl.TEXTURE_2D, refTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, tex);
    refLengthVal = M;
    orbitState.x = view.x; orbitState.y = view.y;
    orbitState.P = P; orbitState.maxIter = maxIter;
  }

  /* ----------------------------------------------------------------- *
   * Render.                                                            *
   * ----------------------------------------------------------------- */
  function bindQuad(L) {
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.enableVertexAttribArray(L.a_pos);
    gl.vertexAttribPointer(L.a_pos, 2, gl.FLOAT, false, 0, 0);
  }

  function setShared(L) {
    gl.uniform2f(L.u_resolution, canvas.width, canvas.height);
    if (L.u_span) gl.uniform1f(L.u_span, view.span);
    gl.uniform1f(L.u_colorDensity, state.density);
    gl.uniform1f(L.u_colorShift, state.colorShift);
    const pal = PALETTES[state.paletteIndex];
    gl.uniform3fv(L.u_stops, pal.flatStops);
    gl.uniform3f(L.u_interior, pal.interior[0], pal.interior[1], pal.interior[2]);
  }

  function render() {
    const aa = mode === "still" ? QUALITY[state.quality].stillAA : 1;
    const maxIter = currentMaxIter();
    const deep = view.span < DEEP_THRESHOLD;

    if (deep && progPerturb && !state.julia) {
      ensureReferenceOrbit(maxIter);
      const L = progPerturb.loc;
      gl.useProgram(progPerturb.program);
      setShared(L);
      const sp = split(view.span);
      gl.uniform2f(L.u_spanHL, sp[0], sp[1]);
      gl.uniform1i(L.u_maxIter, maxIter);
      gl.uniform1i(L.u_aa, aa);
      gl.uniform1i(L.u_refLength, refLengthVal);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, refTex);
      gl.uniform1i(L.u_refTex, 0);
      bindQuad(L);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      return;
    }

    const prog = (deep && progDeep) ? progDeep : progFast;
    const L = prog.loc;
    gl.useProgram(prog.program);
    setShared(L);
    const cxd = split(centerCx()), cyd = split(centerCy());
    gl.uniform2f(L.u_centerX, cxd[0], cxd[1]);
    gl.uniform2f(L.u_centerY, cyd[0], cyd[1]);
    gl.uniform1i(L.u_maxIter, Math.min(maxIter, 2000));
    gl.uniform1i(L.u_aa, aa);
    gl.uniform1i(L.u_julia, state.julia ? 1 : 0);
    const jx = split(state.juliaX), jy = split(state.juliaY);
    gl.uniform2f(L.u_juliaX, jx[0], jx[1]);
    gl.uniform2f(L.u_juliaY, jy[0], jy[1]);
    bindQuad(L);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /* ----------------------------------------------------------------- *
   * Julia helpers.                                                     *
   * ----------------------------------------------------------------- */
  function setJuliaFromScreen(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const nx = (clientX - rect.left) / rect.width;
    const ny = (clientY - rect.top) / rect.height;
    state.juliaTX = -0.6 + (nx - 0.5) * 2.8;
    state.juliaTY = (0.5 - ny) * 2.3;
    markInteract();
  }

  function setJulia(on) {
    if (on === state.julia) return;
    if (on) {
      savedView = { x: view.x, y: view.y, span: target.span, P: P };
      state.julia = true;
      state.juliaLive = true;
      state.juliaX = state.juliaTX = -0.8;
      state.juliaY = state.juliaTY = 0.156;
      setView(0, 0, 3.0, true);
    } else {
      state.julia = false;
      state.juliaLive = false;
      if (savedView) {
        setPrecision(savedView.P);
        view.x = target.x = savedView.x;
        view.y = target.y = savedView.y;
        view.span = target.span = savedView.span;
        markInteract();
      } else {
        setView(DEFAULT.cx, DEFAULT.cy, DEFAULT.span, true);
      }
    }
    updateUI();
    markInteract();
  }

  function pinJulia() {
    if (state.julia && state.juliaLive) {
      state.juliaLive = false;
      updateUI();
    }
  }

  /* ----------------------------------------------------------------- *
   * View control.                                                      *
   * ----------------------------------------------------------------- */
  function setView(cx, cy, span, snap) {
    target.span = clamp(span, currentMinSpan(), MAX_SPAN);
    target.x = doubleToFixed(cx, P);
    target.y = doubleToFixed(cy, P);
    if (snap) { view.x = target.x; view.y = target.y; view.span = target.span; }
    markInteract();
  }

  // apply a zoom anchored at normalized cursor position (uv), to the target
  function zoomAt(uv, factor) {
    const newSpan = clamp(target.span * factor, currentMinSpan(), MAX_SPAN);
    const k = newSpan / target.span;
    target.x += doubleToFixed(uv.x * target.span * (1 - k), P);
    target.y += doubleToFixed(uv.y * target.span * (1 - k), P);
    target.span = newSpan;
  }

  function reset() {
    if (state.julia) setJulia(false);
    state.colorShift = 0;
    setView(DEFAULT.cx, DEFAULT.cy, DEFAULT.span, false);
  }

  /* ----------------------------------------------------------------- *
   * Pointer / wheel / keyboard input.                                  *
   * ----------------------------------------------------------------- */
  const pointers = new Map();
  let pinchPrev = null;
  let moved = false;

  canvas.addEventListener("pointerdown", function (e) {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    if (state.julia && state.juliaLive) pinJulia();
    if (pointers.size === 2) pinchPrev = null;
  });

  canvas.addEventListener("pointermove", function (e) {
    if (!pointers.has(e.pointerId)) {
      // hover with no button held — drives live Julia
      if (state.julia && state.juliaLive) setJuliaFromScreen(e.clientX, e.clientY);
      return;
    }
    const prev = pointers.get(e.pointerId);
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (Math.hypot(dx, dy) > 2) moved = true;
    const rect = canvas.getBoundingClientRect();

    if (pointers.size === 1) {
      if (state.julia && state.juliaLive) { setJuliaFromScreen(e.clientX, e.clientY); return; }
      const wpp = view.span / rect.height;
      const ddx = doubleToFixed(-dx * wpp, P);
      const ddy = doubleToFixed(dy * wpp, P);
      view.x += ddx; target.x += ddx;
      view.y += ddy; target.y += ddy;
      markInteract();
    } else if (pointers.size === 2) {
      const pts = Array.from(pointers.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const midX = (pts[0].x + pts[1].x) / 2 - rect.left;
      const midY = (pts[0].y + pts[1].y) / 2 - rect.top;
      if (pinchPrev && dist > 0) {
        zoomAt(uvAt(midX, midY, rect.width, rect.height), pinchPrev.dist / dist);
        const wpp = view.span / rect.height;
        target.x += doubleToFixed(-(midX - pinchPrev.midX) * wpp, P);
        target.y += doubleToFixed((midY - pinchPrev.midY) * wpp, P);
        view.x = target.x; view.y = target.y;
        markInteract();
      }
      pinchPrev = { dist: dist, midX: midX, midY: midY };
    }
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchPrev = null;
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointerleave", function (e) {
    if (!pointers.has(e.pointerId)) return;
    endPointer(e);
  });

  canvas.addEventListener(
    "wheel",
    function (e) {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16;       // lines -> approx px
      else if (e.deltaMode === 2) dy *= rect.height;
      zoomAt(uvAt(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height), Math.exp(dy * 0.0016));
      markInteract();
    },
    { passive: false }
  );

  canvas.addEventListener("dblclick", function (e) {
    if (state.julia && state.juliaLive) return;
    const rect = canvas.getBoundingClientRect();
    zoomAt(uvAt(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height), 0.4);
    markInteract();
  });

  window.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key.toLowerCase()) {
      case "r": reset(); break;
      case "j": setJulia(!state.julia); break;
      case "f": toggleFullscreen(); break;
      case "h":
      case "escape": toggleCollapse(); break;
      default: return;
    }
    e.preventDefault();
  });

  window.addEventListener("resize", function () {
    applyRenderSize();
    needsRender = true;
  });

  /* ----------------------------------------------------------------- *
   * UI wiring.                                                         *
   * ----------------------------------------------------------------- */
  const els = {
    palettes: document.getElementById("palettes"),
    quality: document.getElementById("quality"),
    julia: document.getElementById("btn-julia"),
    juliaLive: document.getElementById("btn-julia-live"),
    shimmer: document.getElementById("btn-shimmer"),
    reset: document.getElementById("btn-reset"),
    collapse: document.getElementById("btn-collapse"),
    fullscreen: document.getElementById("btn-fullscreen"),
    panel: document.getElementById("panel"),
    rCoord: document.getElementById("r-coord"),
    rZoom: document.getElementById("r-zoom"),
    rIter: document.getElementById("r-iter"),
    rFps: document.getElementById("r-fps"),
    juliaRow: document.getElementById("julia-row"),
  };

  // Palette swatches.
  PALETTES.forEach((p, i) => {
    const b = document.createElement("button");
    b.className = "swatch";
    b.type = "button";
    b.title = p.name;
    b.setAttribute("aria-label", p.name);
    b.style.backgroundImage = p.css;
    b.addEventListener("click", () => {
      state.paletteIndex = i;
      updateUI();
      needsRender = true;
    });
    els.palettes.appendChild(b);
  });

  if (els.quality) {
    Array.from(els.quality.querySelectorAll("button")).forEach((b) => {
      b.addEventListener("click", () => {
        state.quality = b.dataset.q;
        applyRenderSize();
        updateUI();
        needsRender = true;
      });
    });
  }

  els.julia && els.julia.addEventListener("click", () => setJulia(!state.julia));
  els.juliaLive && els.juliaLive.addEventListener("click", () => {
    if (!state.julia) { setJulia(true); return; }
    state.juliaLive = !state.juliaLive;
    updateUI();
    markInteract();
  });
  els.shimmer && els.shimmer.addEventListener("click", () => {
    state.shimmer = !state.shimmer;
    updateUI();
    markInteract();
  });
  els.reset && els.reset.addEventListener("click", reset);
  els.collapse && els.collapse.addEventListener("click", toggleCollapse);
  els.fullscreen && els.fullscreen.addEventListener("click", toggleFullscreen);

  function toggleCollapse() {
    document.body.classList.toggle("collapsed");
  }

  function toggleFullscreen() {
    const d = document;
    if (!d.fullscreenElement) {
      (d.documentElement.requestFullscreen || function () {}).call(d.documentElement);
    } else if (d.exitFullscreen) {
      d.exitFullscreen();
    }
  }

  function updateUI() {
    Array.from(els.palettes.children).forEach((b, i) =>
      b.classList.toggle("active", i === state.paletteIndex)
    );
    if (els.quality) {
      Array.from(els.quality.querySelectorAll("button")).forEach((b) =>
        b.classList.toggle("active", b.dataset.q === state.quality)
      );
    }
    els.julia && els.julia.classList.toggle("active", state.julia);
    els.juliaLive && els.juliaLive.classList.toggle("active", state.julia && state.juliaLive);
    els.juliaRow && els.juliaRow.classList.toggle("disabled", !state.julia);
    els.shimmer && els.shimmer.classList.toggle("active", state.shimmer);
  }

  /* ----------------------------------------------------------------- *
   * Readout.                                                           *
   * ----------------------------------------------------------------- */
  function fmtMag(m) {
    if (m < 10) return "×" + m.toFixed(2);
    if (m < 10000) return "×" + Math.round(m).toLocaleString();
    return "×" + m.toExponential(2).replace("e+", "e");
  }

  function fmtCoord(v, mag) {
    const decimals = clamp(Math.round(Math.log10(Math.max(1, mag))) + 4, 4, 15);
    return (v >= 0 ? " " : "") + v.toFixed(decimals);
  }

  function fmtCoordHP(fixedVal, mag) {
    const decimals = clamp(Math.round(Math.log10(Math.max(1, mag))) + 3, 4, 28);
    const s = fixedToDecimalString(fixedVal, P, decimals);
    return s[0] === "-" ? s : " " + s;
  }

  let lastReadout = 0;
  let frameCount = 0;
  let fpsLast = performance.now();
  let fps = 0;

  function updateReadout(now) {
    if (now - lastReadout < 180) return;
    lastReadout = now;
    const mag = DEFAULT.span / view.span;
    if (state.julia) {
      els.rCoord.textContent =
        "c " + fmtCoord(state.juliaX, 1000).trim() + " , " + fmtCoord(state.juliaY, 1000).trim();
    } else {
      els.rCoord.textContent = fmtCoordHP(view.x, mag) + " , " + fmtCoordHP(view.y, mag);
    }
    els.rZoom.textContent = fmtMag(mag);
    els.rIter.textContent = currentMaxIter() + (view.span < DEEP_THRESHOLD ? " · hd" : "");
    els.rFps.textContent = fps + " fps";
  }

  /* ----------------------------------------------------------------- *
   * Main loop.                                                         *
   * ----------------------------------------------------------------- */
  function frame(now) {
    adaptPrecision();
    const animating = stepEasing();

    let juliaMoving = false;
    if (state.julia) {
      const dx = state.juliaTX - state.juliaX;
      const dy = state.juliaTY - state.juliaY;
      if (Math.abs(dx) + Math.abs(dy) > 1e-5) {
        state.juliaX += dx * 0.22;
        state.juliaY += dy * 0.22;
        juliaMoving = true;
      }
    }

    if (state.shimmer) { state.colorShift += 0.0012; needsRender = true; }

    const active = animating || juliaMoving || state.shimmer;

    if (active && mode !== "interactive") { mode = "interactive"; applyRenderSize(); }
    if (!active && mode === "interactive" && now - lastInteract > IDLE_MS) {
      mode = "still";
      applyRenderSize();
    }

    if (needsRender || active) {
      render();
      needsRender = false;
      frameCount++;
    }

    if (now - fpsLast >= 500) {
      fps = Math.round((frameCount * 1000) / (now - fpsLast));
      frameCount = 0;
      fpsLast = now;
    }
    updateReadout(now);

    requestAnimationFrame(frame);
  }

  /* ----------------------------------------------------------------- *
   * Boot.                                                              *
   * ----------------------------------------------------------------- */
  applyRenderSize();
  updateUI();
  markInteract();              // ease in from the slightly-zoomed-out intro
  document.body.classList.add("ready");
  requestAnimationFrame(frame);
})();
