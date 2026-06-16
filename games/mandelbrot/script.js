/*
 * Mandelbrot visualizer — WebGL engine + UI.
 * Pure vanilla JS, no frameworks, no build step. Works from file:// or http.
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
    low:    { iterBase: 140, iterK: 26, interactiveScale: 0.45, stillScale: 0.85, stillAA: 1 },
    medium: { iterBase: 220, iterK: 38, interactiveScale: 0.60, stillScale: 1.00, stillAA: 1 },
    high:   { iterBase: 320, iterK: 50, interactiveScale: 0.75, stillScale: 1.00, stillAA: 2 },
    ultra:  { iterBase: 480, iterK: 64, interactiveScale: 1.00, stillScale: 1.00, stillAA: 2 },
  };

  /* ----------------------------------------------------------------- */
  const DEFAULT = { cx: -0.6, cy: 0.0, span: 2.6 };
  const MIN_SPAN = 6e-12;     // ~1e11x magnification (df64 limit)
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

  function buildProgram(deep) {
    let fsrc = mbFragSource(deep);
    if (precWord !== "highp") fsrc = fsrc.replace(/highp/g, "mediump");
    const vs = compile(gl.VERTEX_SHADER, MB_VERT);
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
    const uniforms = [
      "u_resolution", "u_centerX", "u_centerY", "u_span", "u_maxIter",
      "u_aa", "u_julia", "u_juliaX", "u_juliaY", "u_colorDensity",
      "u_colorShift", "u_stops", "u_interior",
    ];
    const loc = { a_pos: gl.getAttribLocation(program, "a_pos") };
    uniforms.forEach((u) => { loc[u] = gl.getUniformLocation(program, u); });
    return { program: program, loc: loc };
  }

  const progFast = buildProgram(false);
  const progDeep = buildProgram(true);
  if (!progFast) {
    if (fallback) fallback.hidden = false;
    return;
  }
  // If df64 program fails, stay shallow.
  const minSpan = progDeep ? MIN_SPAN : 8e-6;

  // Full-screen quad.
  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW
  );

  /* ----------------------------------------------------------------- *
   * State.                                                             *
   * ----------------------------------------------------------------- */
  const view = { cx: DEFAULT.cx, cy: DEFAULT.cy, span: DEFAULT.span * 1.7 };
  const target = { cx: DEFAULT.cx, cy: DEFAULT.cy, span: DEFAULT.span };

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
   * Math helpers.                                                      *
   * ----------------------------------------------------------------- */
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function split(v) {
    const hi = Math.fround(v);
    return [hi, v - hi];
  }

  function screenToWorld(px, py, w, h, v) {
    const uvx = (px - 0.5 * w) / h;
    const uvy = (0.5 * h - py) / h;
    return { x: v.cx + uvx * v.span, y: v.cy + uvy * v.span };
  }

  function currentMaxIter() {
    const q = QUALITY[state.quality];
    const mag = DEFAULT.span / view.span;
    const it = q.iterBase + q.iterK * Math.max(0, Math.log2(mag));
    return Math.round(clamp(it, 80, 2000));
  }

  /* ----------------------------------------------------------------- *
   * Easing of the view toward the target.                              *
   * ----------------------------------------------------------------- */
  function stepEasing() {
    const e = 0.16;
    const ls = Math.log(view.span);
    const lt = Math.log(target.span);
    const dls = lt - ls;
    const dcx = target.cx - view.cx;
    const dcy = target.cy - view.cy;

    const spanClose = Math.abs(dls) < 1e-4;
    const cxClose = Math.abs(dcx) < view.span * 1e-4;
    const cyClose = Math.abs(dcy) < view.span * 1e-4;
    if (spanClose && cxClose && cyClose) {
      view.cx = target.cx; view.cy = target.cy; view.span = target.span;
      return false;
    }
    view.span = Math.exp(ls + dls * e);
    view.cx += dcx * e;
    view.cy += dcy * e;
    return true;
  }

  /* ----------------------------------------------------------------- *
   * Render.                                                            *
   * ----------------------------------------------------------------- */
  function render() {
    const deep = progDeep && view.span < DEEP_THRESHOLD;
    const P = deep ? progDeep : progFast;
    const L = P.loc;
    gl.useProgram(P.program);

    gl.uniform2f(L.u_resolution, canvas.width, canvas.height);
    const cxd = split(view.cx), cyd = split(view.cy);
    gl.uniform2f(L.u_centerX, cxd[0], cxd[1]);
    gl.uniform2f(L.u_centerY, cyd[0], cyd[1]);
    gl.uniform1f(L.u_span, view.span);
    gl.uniform1i(L.u_maxIter, currentMaxIter());
    gl.uniform1i(L.u_aa, mode === "still" ? QUALITY[state.quality].stillAA : 1);
    gl.uniform1i(L.u_julia, state.julia ? 1 : 0);
    const jx = split(state.juliaX), jy = split(state.juliaY);
    gl.uniform2f(L.u_juliaX, jx[0], jx[1]);
    gl.uniform2f(L.u_juliaY, jy[0], jy[1]);
    gl.uniform1f(L.u_colorDensity, state.density);
    gl.uniform1f(L.u_colorShift, state.colorShift);
    const pal = PALETTES[state.paletteIndex];
    gl.uniform3fv(L.u_stops, pal.flatStops);
    gl.uniform3f(L.u_interior, pal.interior[0], pal.interior[1], pal.interior[2]);

    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.enableVertexAttribArray(L.a_pos);
    gl.vertexAttribPointer(L.a_pos, 2, gl.FLOAT, false, 0, 0);
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
      savedView = { cx: target.cx, cy: target.cy, span: target.span };
      state.julia = true;
      state.juliaLive = true;
      state.juliaX = state.juliaTX = -0.8;
      state.juliaY = state.juliaTY = 0.156;
      setView(0, 0, 3.0, true);
    } else {
      state.julia = false;
      state.juliaLive = false;
      const s = savedView || DEFAULT;
      setView(s.cx, s.cy, s.span, true);
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
    target.cx = cx; target.cy = cy; target.span = clamp(span, minSpan, MAX_SPAN);
    if (snap) { view.cx = cx; view.cy = cy; view.span = target.span; }
    markInteract();
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
      view.cx -= dx * wpp; target.cx -= dx * wpp;
      view.cy += dy * wpp; target.cy += dy * wpp;
      markInteract();
    } else if (pointers.size === 2) {
      const pts = Array.from(pointers.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const midX = (pts[0].x + pts[1].x) / 2 - rect.left;
      const midY = (pts[0].y + pts[1].y) / 2 - rect.top;
      if (pinchPrev && dist > 0) {
        const w = screenToWorld(midX, midY, rect.width, rect.height, target);
        const newSpan = clamp(target.span * (pinchPrev.dist / dist), minSpan, MAX_SPAN);
        const k = newSpan / target.span;
        target.cx = w.x - (w.x - target.cx) * k;
        target.cy = w.y - (w.y - target.cy) * k;
        target.span = newSpan;
        const wpp = view.span / rect.height;
        target.cx -= (midX - pinchPrev.midX) * wpp;
        target.cy += (midY - pinchPrev.midY) * wpp;
        view.cx = target.cx; view.cy = target.cy;
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
      const w = screenToWorld(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height, target);
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16;       // lines -> approx px
      else if (e.deltaMode === 2) dy *= rect.height;
      const factor = Math.exp(dy * 0.0016);
      const newSpan = clamp(target.span * factor, minSpan, MAX_SPAN);
      const k = newSpan / target.span;
      target.cx = w.x - (w.x - target.cx) * k;
      target.cy = w.y - (w.y - target.cy) * k;
      target.span = newSpan;
      markInteract();
    },
    { passive: false }
  );

  canvas.addEventListener("dblclick", function (e) {
    if (state.julia && state.juliaLive) return;
    const rect = canvas.getBoundingClientRect();
    const w = screenToWorld(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height, target);
    const newSpan = clamp(target.span * 0.4, minSpan, MAX_SPAN);
    const k = newSpan / target.span;
    target.cx = w.x - (w.x - target.cx) * k;
    target.cy = w.y - (w.y - target.cy) * k;
    target.span = newSpan;
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
      els.rCoord.textContent = fmtCoord(view.cx, mag) + " , " + fmtCoord(view.cy, mag);
    }
    els.rZoom.textContent = fmtMag(mag);
    els.rIter.textContent = currentMaxIter() + (progDeep && view.span < DEEP_THRESHOLD ? " · hd" : "");
    els.rFps.textContent = fps + " fps";
  }

  /* ----------------------------------------------------------------- *
   * Main loop.                                                         *
   * ----------------------------------------------------------------- */
  function frame(now) {
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
