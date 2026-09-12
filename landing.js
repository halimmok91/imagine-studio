/* ═══════════════════════════════════════════════════════════════
   IMAGINE STUDIO — landing title

   The page is built as a camera looking at its own subject.

     • APERTURE   nine iris blades open on load and close like a
                  shutter when you enter the app. This doubles as the
                  loading state: the scene is revealed as it opens.
     • LENS RINGS three concentric rings at different depths, so
                  pointer parallax produces real perspective rather
                  than a flat 2D slide.
     • WORDMARK   "Imagine / STUDIO" rasterised from the real font to
                  an offscreen canvas, sampled into a point cloud, and
                  bent onto a shallow cylinder so the letterform has
                  actual depth. Particles spring back to that surface
                  after you disturb them.
     • DUST       sparse motes behind and in front of the type, giving
                  the volume something to read against.

   Everything is generated procedurally — no model files — so the
   packaged .exe stays small and works offline.

   Degrades cleanly: without WebGL, or with reduced motion requested,
   none of this runs and the CSS wordmark in the DOM is shown instead.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var canvas = document.getElementById('title-gl');
  var btn = document.getElementById('btnEnter');
  var slot = document.getElementById('wordmarkSlot');

  /* ── navigate to the app ── */
  var leaving = false;
  function enterApp() {
    if (leaving) return;
    leaving = true;
    // Fire the shutter first; the fade only starts once it is closing.
    var wait = 520;
    if (window.__titleShutter) wait = window.__titleShutter();
    setTimeout(function () { document.body.classList.add('leaving'); }, wait * 0.55);
    setTimeout(function () { window.location.href = '/app'; }, wait);
  }
  if (btn) btn.addEventListener('click', enterApp);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') {
      if (document.activeElement === btn) return;
      e.preventDefault();
      enterApp();
    }
  });

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!canvas || typeof THREE === 'undefined' || reduce) {
    document.body.classList.add('no-gl');
    return;
  }

  var renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
  } catch (e) {
    document.body.classList.add('no-gl');
    return;
  }

  var isMobile = window.matchMedia('(max-width: 700px)').matches;
  var DPR = Math.min(window.devicePixelRatio || 1, isMobile ? 1.5 : 2);
  renderer.setPixelRatio(DPR);
  renderer.setClearColor(0x000000, 0);

  var COL_FLARE = new THREE.Color('#FF5A3C');
  var COL_WARM = new THREE.Color('#FFA05A');
  var COL_COOL = new THREE.Color('#6C5CE7');

  /* ── sample the wordmark into points ──
     Drawing the text to a 2D canvas and reading its alpha channel means the
     letterforms come from real font rendering, not hand-plotted coordinates. */
  var pts = [];
  var bounds = { w: 0, h: 0, inkW: 0, inkH: 0, inkMidY: 0 };

  function sampleText() {
    pts.length = 0;
    var vw = window.innerWidth;

    var fs = Math.max(58, Math.min(vw * 0.135, 168));
    var subFs = fs * 0.19;
    var pad = Math.ceil(fs * 0.4);

    var c = document.createElement('canvas');
    var g = c.getContext('2d');
    var fam = "'Inter Tight',-apple-system,'Segoe UI',system-ui,sans-serif";
    var mainFont = '600 ' + fs + 'px ' + fam;
    var subFont = '500 ' + subFs + 'px ' + fam;

    // Measure real ink extents. "Imagine" has a descender, and assuming a
    // fixed fraction of the font size is what previously let STUDIO overlap it.
    g.font = mainFont;
    var mm = g.measureText('Imagine');
    var mainW = mm.width;
    var mainAsc = mm.actualBoundingBoxAscent || fs * 0.72;
    var mainDesc = mm.actualBoundingBoxDescent || fs * 0.21;

    var subText = 'STUDIO';
    var track = subFs * 0.42;
    g.font = subFont;
    var subW = 0, subAsc = 0, subDesc = 0;
    for (var i = 0; i < subText.length; i++) {
      var m = g.measureText(subText[i]);
      subW += m.width + (i < subText.length - 1 ? track : 0);
      subAsc = Math.max(subAsc, m.actualBoundingBoxAscent || subFs * 0.72);
      subDesc = Math.max(subDesc, m.actualBoundingBoxDescent || 0);
    }
    var gap = Math.round(subFs * 0.85);

    var w = Math.ceil(Math.max(mainW, subW)) + pad * 2;
    var mainBaseY = pad + mainAsc;
    var subBaseY = mainBaseY + mainDesc + gap + subAsc;
    var h = Math.ceil(subBaseY + subDesc + pad);
    c.width = w;
    c.height = h;

    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.font = mainFont;
    g.fillText('Imagine', w / 2, mainBaseY);

    g.font = subFont;
    var sx = w / 2 - subW / 2;
    for (var j = 0; j < subText.length; j++) {
      var ch = subText[j];
      var cw = g.measureText(ch).width;
      g.fillText(ch, sx + cw / 2, subBaseY);
      sx += cw + track;
    }

    // Step controls density. At 3px the title measured 0.93% ink coverage
    // against 7.88% for the same text as CSS — far too sparse to read. Mobile
    // uses the same step: its bitmap is already ~9x smaller because the font
    // size is 58px rather than 168px, so the point count stays modest.
    var step = 2;
    var data = g.getImageData(0, 0, w, h).data;
    var scale = 0.019;

    for (var y = 0; y < h; y += step) {
      for (var x = 0; x < w; x += step) {
        if (data[(y * w + x) * 4 + 3] < 110) continue;
        var jx = (Math.random() - 0.5) * step * 0.42;
        var jy = (Math.random() - 0.5) * step * 0.42;
        pts.push({
          x: (x + jx - w / 2) * scale,
          y: -(y + jy - h / 2) * scale
        });
      }
    }

    bounds.w = w * scale;
    bounds.h = h * scale;
    var minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
    for (var k = 0; k < pts.length; k++) {
      var q = pts[k];
      if (q.y < minY) minY = q.y;
      if (q.y > maxY) maxY = q.y;
      if (q.x < minX) minX = q.x;
      if (q.x > maxX) maxX = q.x;
    }
    bounds.inkH = (maxY - minY) || bounds.h;
    bounds.inkW = (maxX - minX) || bounds.w;
    bounds.inkMidY = (minY + maxY) / 2;
  }

  sampleText();
  if (!pts.length) { document.body.classList.add('no-gl'); return; }

  /* ── scene ── */
  var BASE_Z = 14;                 // camera's resting distance
  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(45, 1, 0.1, 120);
  camera.position.set(0, 0, BASE_Z);

  // Everything optical lives in one rig, so parallax moves it as an assembly.
  var rig = new THREE.Group();
  scene.add(rig);

  /* ── the wordmark, bent onto a shallow cylinder ──
     A flat plane of points reads as 2D no matter how the camera moves. Pushing
     the ends away in z gives the type a real surface to sit on. */
  var COUNT = pts.length;
  var home = new Float32Array(COUNT * 3);
  var pos = new Float32Array(COUNT * 3);
  var vel = new Float32Array(COUNT * 3);
  var seed = new Float32Array(COUNT * 3);

  var halfW = Math.max(0.001, bounds.inkW * 0.5);
  var CURVE = 1.5;   // world units the edges recede by

  for (var i = 0; i < COUNT; i++) {
    var p = pts[i];
    var nx = p.x / halfW;                       // -1 .. 1 across the wordmark
    home[i * 3] = p.x;
    home[i * 3 + 1] = p.y;
    home[i * 3 + 2] = -CURVE * nx * nx;         // parabolic bend

    // Fly in from a ring so the title assembles itself on load.
    var ang = Math.random() * Math.PI * 2;
    var rad = 5 + Math.random() * 7;
    pos[i * 3] = Math.cos(ang) * rad;
    pos[i * 3 + 1] = Math.sin(ang) * rad * 0.6;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 4;

    seed[i * 3] = Math.random();
    seed[i * 3 + 1] = 0.8 + Math.random() * 0.7;
    seed[i * 3 + 2] = (nx + 1) * 0.5;           // colour ramp follows x
  }

  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));

  var uniforms = {
    uTime: { value: 0 },
    uPixelRatio: { value: DPR },
    uBurst: { value: 0 },
    uSettle: { value: 0 },
    uFlare: { value: COL_FLARE },
    uWarm: { value: COL_WARM },
    uCool: { value: COL_COOL }
  };

  var points = new THREE.Points(geo, new THREE.ShaderMaterial({
    uniforms: uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: [
      'precision mediump float;',
      'attribute vec3 aSeed;',
      'uniform float uTime, uPixelRatio, uBurst, uSettle;',
      'varying float vMix, vAlpha;',
      'void main(){',
      '  vec3 p = position;',
      // Idle shimmer, deliberately tiny: larger values blur the strokes.
      '  float t = uTime * (0.5 + aSeed.y * 0.5) + aSeed.x * 30.0;',
      '  p.x += sin(t * 0.7) * 0.010 * uSettle;',
      '  p.y += cos(t * 0.6) * 0.010 * uSettle;',
      '  p.z += sin(t * 0.5) * 0.03 * uSettle;',
      '  vMix = aSeed.z;',
      '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
      '  gl_Position = projectionMatrix * mv;',
      '  float twinkle = 0.86 + 0.14 * sin(uTime * 1.7 + aSeed.x * 18.0);',
      '  vAlpha = twinkle * mix(0.7, 1.0, uSettle);',
      '  float size = aSeed.y * uPixelRatio * (1.0 + uBurst * 1.6);',
      '  gl_PointSize = size * (44.0 / max(0.001, -mv.z));',
      '}'
    ].join('\n'),
    fragmentShader: [
      'precision mediump float;',
      'uniform vec3 uFlare, uWarm, uCool;',
      'varying float vMix, vAlpha;',
      'void main(){',
      '  vec2 uv = gl_PointCoord - 0.5;',
      '  float d = length(uv);',
      // A solid core with a short falloff. An all-halo profile is what made
      // the type look hazy in an earlier pass.
      '  float core = smoothstep(0.5, 0.30, d);',
      '  float halo = pow(smoothstep(0.5, 0.0, d), 2.6) * 0.5;',
      '  float a = min(1.0, core + halo);',
      '  vec3 col = vMix < 0.44',
      '    ? mix(uFlare, uWarm, vMix / 0.44)',
      '    : mix(uWarm, uCool, (vMix - 0.44) / 0.56);',
      '  col = mix(col, vec3(1.0), core * 0.34);',
      '  gl_FragColor = vec4(col, a * vAlpha);',
      '}'
    ].join('\n')
  }));
  points.frustumCulled = false;
  rig.add(points);

  /* ── lens rings ──
     Three thin tori at different depths. They are what makes the parallax
     legible: the type moves against them, so the scene reads as volume. */
  var rings = [];
  function makeRing(radius, tube, z, colour, opacity, segs) {
    var mesh = new THREE.Mesh(
      new THREE.TorusGeometry(radius, tube, 8, segs),
      new THREE.MeshBasicMaterial({
        color: colour, transparent: true, opacity: opacity,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    mesh.position.z = z;
    rig.add(mesh);
    rings.push(mesh);
    return mesh;
  }
  var ringSegs = isMobile ? 48 : 96;
  makeRing(7.4, 0.012, -4.5, COL_COOL, 0.5, ringSegs);
  makeRing(5.6, 0.010, -2.2, COL_FLARE, 0.34, ringSegs);
  makeRing(9.1, 0.008, 2.4, COL_WARM, 0.22, ringSegs);

  /* ── dust: sparse motes for depth cueing ── */
  var DUST = isMobile ? 90 : 260;
  var dpos = new Float32Array(DUST * 3);
  var dseed = new Float32Array(DUST * 2);
  for (var d = 0; d < DUST; d++) {
    dpos[d * 3] = (Math.random() - 0.5) * 26;
    dpos[d * 3 + 1] = (Math.random() - 0.5) * 15;
    dpos[d * 3 + 2] = -8 + Math.random() * 12;
    dseed[d * 2] = Math.random() * 100;
    dseed[d * 2 + 1] = 0.5 + Math.random() * 1.6;
  }
  var dgeo = new THREE.BufferGeometry();
  dgeo.setAttribute('position', new THREE.BufferAttribute(dpos, 3));
  dgeo.setAttribute('aSeed', new THREE.BufferAttribute(dseed, 2));
  var dust = new THREE.Points(dgeo, new THREE.ShaderMaterial({
    uniforms: uniforms,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: [
      'precision mediump float;',
      'attribute vec2 aSeed;',
      'uniform float uTime, uPixelRatio, uSettle;',
      'varying float vA;',
      'void main(){',
      '  vec3 p = position;',
      '  float t = uTime * aSeed.y * 0.3 + aSeed.x;',
      '  p.x += sin(t) * 0.5;',
      '  p.y += cos(t * 0.8) * 0.35;',
      '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
      '  gl_Position = projectionMatrix * mv;',
      '  vA = (0.16 + 0.14 * sin(uTime * 0.9 + aSeed.x * 5.0)) * uSettle;',
      '  gl_PointSize = aSeed.y * uPixelRatio * (13.0 / max(0.001, -mv.z));',
      '}'
    ].join('\n'),
    fragmentShader: [
      'precision mediump float;',
      'uniform vec3 uWarm;',
      'varying float vA;',
      'void main(){',
      '  float dd = length(gl_PointCoord - 0.5);',
      '  gl_FragColor = vec4(uWarm, pow(smoothstep(0.5, 0.0, dd), 2.0) * vA);',
      '}'
    ].join('\n')
  }));
  dust.frustumCulled = false;
  rig.add(dust);

  /* ── the aperture ──
     Nine blades on a ring of pivots. Rotating every pivot by the same angle
     sweeps the blades across the centre, exactly like a real iris. It opens
     on load (the reveal) and closes on Enter (the shutter). Blades are opaque
     black so they read as physical obstruction against the additive glow. */
  var BLADES = 9;
  var iris = new THREE.Group();
  iris.position.z = 6.2;            // in front of the type
  scene.add(iris);

  var bladeMat = new THREE.MeshBasicMaterial({
    color: 0x05040a, transparent: true, opacity: 0.985,
    side: THREE.DoubleSide, depthWrite: false
  });
  var bladeEdgeMat = new THREE.LineBasicMaterial({
    color: 0x8a7cff, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending
  });

  var bladePivots = [];
  var R = 9.0;                       // pivot ring radius
  var BW = R * 1.35;                 // how far inward each blade reaches
  for (var bi = 0; bi < BLADES; bi++) {
    // Blade outline in arm-local space. The arm sits on the pivot ring at
    // radius R with its +x pointing radially outward, so the blade body must
    // extend along -x to reach the centre. Reaching past it (BW > R) is what
    // lets the closed state seal instead of leaving a hole.
    var shape = new THREE.Shape();
    shape.moveTo(0, -R * 0.80);
    shape.lineTo(-BW, -R * 0.55);
    shape.lineTo(-BW, R * 0.55);
    shape.lineTo(0, R * 0.80);
    shape.closePath();

    var mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), bladeMat);
    var edge = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(shape.getPoints(4)), bladeEdgeMat);

    var pivot = new THREE.Object3D();
    pivot.rotation.z = (bi / BLADES) * Math.PI * 2;
    var arm = new THREE.Object3D();
    arm.position.set(R, 0, 0);
    arm.add(mesh);
    arm.add(edge);
    pivot.add(arm);
    iris.add(pivot);
    bladePivots.push(arm);
  }

  // arm.rotation.z sweeps each blade about its pivot. Calibrated by measuring
  // how much of the centre region the blades occlude:
  //     0.00 →  0.00% lit (fully sealed)
  //    -1.35 →  4.94%
  //    -1.80 →  6.34%
  //    -1.95 →  6.46% (matches an unobstructed frame; further gains nothing)
  var IRIS_CLOSED = 0.0;
  var IRIS_OPEN = -1.98;
  var irisAngle = IRIS_CLOSED;
  var irisTarget = IRIS_OPEN;        // opens as soon as the page runs

  function applyIris() {
    for (var k = 0; k < bladePivots.length; k++) bladePivots[k].rotation.z = irisAngle;
  }
  applyIris();

  // Test hook: lets the blade angle be driven directly so the open and closed
  // endpoints can be calibrated by measurement rather than by eye.
  window.__setIris = function (a) { irisAngle = a; irisTarget = a; applyIris(); };

  window.__titleShutter = function () {
    irisTarget = IRIS_CLOSED;
    shutterSpeed = 11.0;            // snap shut, decisively
    // Deliberately no particle burst here: the blades are the drama, and a
    // burst inflates the glow at exactly the moment the frame should darken.
    return 620;                     // ms the caller should wait before leaving
  };

  /* ── pointer interaction ── */
  var pointer = new THREE.Vector3(1e3, 1e3, 0);
  var pointerActive = false;
  var dragging = false;
  var RADIUS = 2.2;
  var FORCE = 0.6;
  var ndc = { x: 0, y: 0, tx: 0, ty: 0 };

  function toWorld(clientX, clientY) {
    var nx = (clientX / window.innerWidth) * 2 - 1;
    var ny = -(clientY / window.innerHeight) * 2 + 1;
    ndc.tx = nx; ndc.ty = ny;
    var v = new THREE.Vector3(nx, ny, 0.5).unproject(camera);
    var dir = v.sub(camera.position).normalize();
    var dist = -camera.position.z / dir.z;
    return camera.position.clone().add(dir.multiplyScalar(dist));
  }

  window.addEventListener('pointermove', function (e) {
    var w = toWorld(e.clientX, e.clientY);
    pointer.set(w.x, w.y, 0);
    pointerActive = true;
  }, { passive: true });
  window.addEventListener('pointerleave', function () { pointerActive = false; });

  canvas.addEventListener('pointerdown', function (e) {
    dragging = true;
    canvas.classList.add('dragging');
    var w = toWorld(e.clientX, e.clientY);
    pointer.set(w.x, w.y, 0);
    pointerActive = true;
  });
  window.addEventListener('pointerup', function () {
    dragging = false;
    canvas.classList.remove('dragging');
  });
  canvas.addEventListener('click', function () { burst(0.75); });

  var burstAmt = 0;
  function burst(strength) {
    var k = strength || 1;
    burstAmt = Math.min(1.6, burstAmt + k);
    var speed = k * 9;
    var s = rig.scale.x || 1;
    var lx = (pointer.x - rig.position.x) / s;
    var ly = (pointer.y - rig.position.y) / s;
    for (var n = 0; n < COUNT; n++) {
      var dx = pos[n * 3] - lx;
      var dy = pos[n * 3 + 1] - ly;
      var dd = Math.sqrt(dx * dx + dy * dy) || 0.001;
      var j = 0.5 + Math.random() * 0.7;
      vel[n * 3] += (dx / dd) * speed * j;
      vel[n * 3 + 1] += (dy / dd) * speed * j;
      vel[n * 3 + 2] += (Math.random() - 0.5) * speed * 0.5;
    }
  }

  /* ── layout ──
     The particle wordmark's height is written into a DOM slot so the button
     below is laid out around the real glyphs and can never collide with it. */
  var resizeTimer = null;
  function layout() {
    var w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();

    // Measure against the camera's resting distance, not its live position:
    // the dolly and parallax move the camera every frame, and reading
    // camera.position.z here would make the layout depend on when it ran.
    var halfTan = Math.tan((camera.fov * Math.PI / 180) / 2) * BASE_Z;
    var visibleW = 2 * halfTan * camera.aspect;
    var visibleH = 2 * halfTan;

    var target = visibleW * (w < 700 ? 0.84 : 0.7);
    var s = Math.min(target / Math.max(0.001, bounds.inkW), 1.9);
    rig.scale.setScalar(s);

    var pxPerUnit = h / visibleH;
    if (slot) slot.style.height = Math.round(bounds.inkH * s * pxPerUnit) + 'px';

    if (slot) {
      var r = slot.getBoundingClientRect();
      var centreY = (0.5 - (r.top + r.height / 2) / h) * visibleH;
      rig.position.y = centreY - bounds.inkMidY * s;
    } else {
      rig.position.y = 0;
    }

    // Keep the iris concentric with the type. It sits closer to the camera than
    // the type, so it must be scaled to cover the frame's far corner at its own
    // depth — otherwise the closed state leaves gaps on wide screens.
    iris.position.y = rig.position.y;
    var irisHalfTan = Math.tan((camera.fov * Math.PI / 180) / 2) * (BASE_Z - iris.position.z);
    var cornerR = Math.hypot(irisHalfTan * camera.aspect, irisHalfTan);
    // The blade shape spans roughly R*0.8 vertically at the pivot, so a scale
    // of cornerR / (R * 0.66) guarantees overlap past the corners.
    iris.scale.setScalar(Math.max(s, cornerR / (R * 0.66)));
  }
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      sampleText();
      if (pts.length === COUNT) {
        var hw = Math.max(0.001, bounds.inkW * 0.5);
        for (var n = 0; n < COUNT; n++) {
          var q = pts[n];
          var xx = q.x / hw;
          home[n * 3] = q.x;
          home[n * 3 + 1] = q.y;
          home[n * 3 + 2] = -CURVE * xx * xx;
        }
      }
      layout();
      requestAnimationFrame(layout);   // slot height reflows the column
    }, 180);
  });
  layout();
  requestAnimationFrame(layout);

  document.body.classList.add('gl-live');

  var visible = true;
  document.addEventListener('visibilitychange', function () { visible = !document.hidden; });

  /* ── animation ──
     Particles are damped harmonic oscillators pinned to their home pixel:
     omega = 17 rad/s at zeta = 0.72, so they settle in ~0.31s with a touch of
     overshoot. Integration is on real seconds, so behaviour does not depend on
     the frame rate. */
  var OMEGA = 17.0, ZETA = 0.72;
  var STIFF = OMEGA * OMEGA;
  var DAMP_C = 2 * ZETA * OMEGA;

  var clock = new THREE.Clock();
  var t = 0, settle = 0;
  var shutterSpeed = 2.6;
  var camZ = BASE_Z + 3.5;         // dolly in from further back on load
  var attrPos = geo.getAttribute('position');

  function frame() {
    requestAnimationFrame(frame);
    if (!visible) return;

    var dt = Math.min(clock.getDelta(), 0.033);
    t += dt;
    settle += (1 - settle) * Math.min(1, dt * 6.0);
    burstAmt *= Math.exp(-4.5 * dt);

    // iris easing
    irisAngle += (irisTarget - irisAngle) * Math.min(1, dt * shutterSpeed);
    applyIris();

    // camera dolly, then pointer parallax on top
    camZ += (BASE_Z - camZ) * Math.min(1, dt * 1.9);
    ndc.x += (ndc.tx - ndc.x) * Math.min(1, dt * 3.2);
    ndc.y += (ndc.ty - ndc.y) * Math.min(1, dt * 3.2);
    // Parallax is pure camera translation with the view axis kept parallel to
    // -Z. Rotating the camera (lookAt a moving target) shifted where the type
    // projected, which broke the layout slot's reservation by ~50px; a
    // translation keeps the world→screen mapping affine so layout() stays exact
    // and still gives real parallax between the depth layers.
    var px = (pointerActive ? ndc.x : 0) * 1.5;
    var py = (pointerActive ? ndc.y : 0) * 0.9;
    camera.position.set(px, py, camZ);
    camera.rotation.set(0, 0, 0);
    // The iris rides with the camera so it stays a lens in front of the scene
    // rather than a plate the camera can slide out from behind.
    iris.position.x = px * 0.82;
    iris.position.y = rig.position.y + py * 0.82;

    uniforms.uTime.value = t;
    uniforms.uBurst.value = burstAmt;
    uniforms.uSettle.value = settle;

    var damp = Math.exp(-DAMP_C * dt);
    var r2 = RADIUS * RADIUS;
    var force = FORCE * (dragging ? 2.0 : 1);
    var s = rig.scale.x || 1;
    var lx = (pointer.x - rig.position.x) / s;
    var ly = (pointer.y - rig.position.y) / s;

    for (var n = 0; n < COUNT; n++) {
      var i3 = n * 3;
      var x = pos[i3], y = pos[i3 + 1], z = pos[i3 + 2];

      vel[i3] += (home[i3] - x) * STIFF * dt;
      vel[i3 + 1] += (home[i3 + 1] - y) * STIFF * dt;
      vel[i3 + 2] += (home[i3 + 2] - z) * STIFF * dt;

      if (pointerActive) {
        var dx = x - lx, dy = y - ly;
        var d2 = dx * dx + dy * dy;
        if (d2 < r2 && d2 > 0.000001) {
          var dd = Math.sqrt(d2);
          var falloff = 1 - dd / RADIUS;
          // Scaled by STIFF so the push stays visible against a stiff spring.
          var f = falloff * falloff * force * STIFF * dt;
          vel[i3] += (dx / dd) * f;
          vel[i3 + 1] += (dy / dd) * f;
          vel[i3 + 2] += (0.5 - Math.random()) * f * 0.5;
        }
      }

      vel[i3] *= damp;
      vel[i3 + 1] *= damp;
      vel[i3 + 2] *= damp;
      pos[i3] = x + vel[i3] * dt;
      pos[i3 + 1] = y + vel[i3 + 1] * dt;
      pos[i3 + 2] = z + vel[i3 + 2] * dt;
    }
    attrPos.needsUpdate = true;

    // the optics drift, at different rates, so depth keeps reading
    rings[0].rotation.z = t * 0.05;
    rings[1].rotation.z = -t * 0.08;
    rings[2].rotation.z = t * 0.03;
    rings[1].rotation.x = Math.sin(t * 0.25) * 0.12;
    rings[2].rotation.y = Math.sin(t * 0.18) * 0.1;
    iris.rotation.z = t * 0.012;
    dust.rotation.y = t * 0.01;

    renderer.render(scene, camera);
  }
  frame();
})();
