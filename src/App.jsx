import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import * as THREE from "three";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter";
import { OBJExporter } from "three/examples/jsm/exporters/OBJExporter";
import {
  mergeGeometries,
  mergeVertices,
} from "three/examples/jsm/utils/BufferGeometryUtils";
import opentype from "opentype.js";
import ClipperLib from "clipper-lib";

// ─── Defaults ────────────────────────────────────────────────────────────────
const DEFAULTS = {
  name: "Chedz",
  font: "Pacifico:style=Regular",
  textSize: 15,
  textHeight: 3.0,
  borderHeight: 2.0,
  borderOffset: 3.0,
  gap: 0,
  tabDiameter: 8.0,
  holeDiameter: 4.0,
  tabYOffset: 0.0,
  borderColor: "#f9a8d4",
  textColor: "#c084fc",
};

// ─── localStorage color persistence ──────────────────────────────────────────
const STORAGE_KEY = "keychain_colors_v1";
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function readSavedColors() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return {
      borderColor: HEX_RE.test(p?.borderColor) ? p.borderColor : null,
      textColor: HEX_RE.test(p?.textColor) ? p.textColor : null,
    };
  } catch {
    return null;
  }
}

function persistColors(borderColor, textColor) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ borderColor, textColor }));
  } catch {}
}

const FONT_URLS = {
  "Pacifico:style=Regular": "/fonts/Pacifico-Regular.ttf",
  "Lobster:style=Regular": "/fonts/Lobster-Regular.ttf",
  "Titan One:style=Regular": "/fonts/TitanOne-Regular.ttf",
  "Luckiest Guy:style=Regular": "/fonts/LuckiestGuy-Regular.ttf",
};

// ─── Theme ────────────────────────────────────────────────────────────────────
const LIGHT = {
  bg: "#fdf6f0", surface: "#ffffff", border: "#f0e6df", text: "#6b4c6b",
  muted: "#c4a8c4", accent: "#f472b6", accent2: "#c084fc", trackBg: "#f5e6f0",
  valuePill: "#fce7f3", resetHov: "#fce7f3", inputBg: "#fff8fc",
  sceneBg: 0xfdf0f8, blob1: "#fce7f340", blob2: "#e9d5ff40",
  shadow: "#f9a8d420", shadow2: "#c084fc20",
};
const DARK = {
  bg: "#18111e", surface: "#221830", border: "#2e2040", text: "#e9d5f5",
  muted: "#7c5fa0", accent: "#f472b6", accent2: "#c084fc", trackBg: "#2e1d3a",
  valuePill: "#3d1f4a", resetHov: "#3d1f4a", inputBg: "#1e1428",
  sceneBg: 0x140d1e, blob1: "#f472b615", blob2: "#c084fc15",
  shadow: "#f9a8d415", shadow2: "#c084fc15",
};

// ─── Geometry helpers ─────────────────────────────────────────────────────────
const SCALE = 1000;
const toClipperPath = (poly) =>
  poly.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));
const fromClipperPoly = (poly) => poly.map((p) => [p.X / SCALE, p.Y / SCALE]);

function shapeToOuterPathsOnly(shape, quality = 60) {
  const pts = shape.getPoints(quality);
  return pts.length >= 3 ? [pts.map((p) => [p.x, p.y])] : [];
}

function offsetUnion(paths, deltaMm) {
  const subj = paths.map(toClipperPath);
  const co = new ClipperLib.ClipperOffset(2, 0.75 * SCALE);
  co.AddPaths(subj, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const off = new ClipperLib.Paths();
  co.Execute(off, deltaMm * SCALE);
  const c = new ClipperLib.Clipper();
  c.AddPaths(off, ClipperLib.PolyType.ptSubject, true);
  const sol = new ClipperLib.Paths();
  c.Execute(ClipperLib.ClipType.ctUnion, sol, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return sol.map(fromClipperPoly);
}

function signedArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function ensureCCW(poly) {
  return signedArea(poly) < 0 ? poly.slice().reverse() : poly;
}

function polysToShapes(polys) {
  return polys
    .filter((p) => p && p.length >= 3)
    .map((p) => new THREE.Shape(ensureCCW(p).map(([x, y]) => new THREE.Vector2(x, y))));
}

function makeRingTabGeometry(tabR, holeR, height, segs = 48) {
  const outer = new THREE.Shape();
  outer.absarc(0, 0, tabR, 0, Math.PI * 2, true);
  const hole = new THREE.Path();
  hole.absarc(0, 0, holeR, 0, Math.PI * 2, false);
  outer.holes.push(hole);
  return new THREE.ExtrudeGeometry(outer, { depth: height, bevelEnabled: false, curveSegments: segs });
}

function cleanForExport(geo, weldTol = 1e-4, areaEps = 1e-10) {
  let g = geo.clone();
  g = mergeVertices(g, weldTol);
  const non = g.toNonIndexed();
  const pos = non.attributes.position;
  const kept = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), cross = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    b.set(pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1));
    c.set(pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2));
    ab.subVectors(b, a); ac.subVectors(c, a); cross.crossVectors(ab, ac);
    if (cross.lengthSq() > areaEps)
      kept.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(new Float32Array(kept), 3));
  let welded = mergeVertices(out, weldTol);
  welded.computeVertexNormals();
  welded.computeBoundingBox();
  welded.computeBoundingSphere();
  return welded;
}

// ─── OBJ + STL only exports ─────────────────────────────────────────────────

// ─── Hooks ────────────────────────────────────────────────────────────────────
function useDebounce(value, delay) {
  const [dv, setDv] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDv(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return dv;
}

// ─── UI components ────────────────────────────────────────────────────────────
function ResetBtn({ onClick, title, C }) {
  const [hov, setHov] = useState(false);
  return (
    <button onClick={onClick} title={title}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ background: hov ? C.resetHov : "none", border: "none", borderRadius: "50%", width: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: 11, color: hov ? C.accent : C.muted, transition: "all 0.15s", padding: 0, flexShrink: 0 }}>
      ↺
    </button>
  );
}

function SliderRow({ label, value, min, max, step = 1, unit = "mm", onChange, defaultValue, C }) {
  const pct = ((value - min) / (max - min)) * 100;
  const dirty = value !== defaultValue;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 12, color: C.muted, fontWeight: 500 }}>{label}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ fontSize: 12, background: C.valuePill, color: C.accent, borderRadius: 8, padding: "1px 8px", fontFamily: "'DM Mono',monospace", fontWeight: 600 }}>{value} {unit}</span>
          {dirty && <ResetBtn onClick={() => onChange(defaultValue)} title={`Reset to ${defaultValue}${unit}`} C={C} />}
        </div>
      </div>
      <div style={{ position: "relative", height: 6, borderRadius: 3, background: C.trackBg }}>
        <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${pct}%`, borderRadius: 3, background: `linear-gradient(90deg,${C.accent},${C.accent2})`, pointerEvents: "none" }} />
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: "pointer", margin: 0 }} />
      </div>
    </div>
  );
}

function Section({ label, C }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "14px 0 8px" }}>
      <div style={{ flex: 1, height: 1, background: C.border }} />
      <span style={{ fontSize: 10, fontWeight: 700, color: C.muted, letterSpacing: 1.5, textTransform: "uppercase" }}>{label}</span>
      <div style={{ flex: 1, height: 1, background: C.border }} />
    </div>
  );
}

function ColorPicker({ label, value, defaultValue, onChange, C }) {
  const dirty = value !== defaultValue;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
        <span style={{ fontSize: 12, color: C.muted, fontWeight: 500 }}>{label}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {dirty && <ResetBtn onClick={() => onChange(defaultValue)} title={`Reset to ${defaultValue}`} C={C} />}
          <span style={{ fontSize: 11, color: C.muted, fontFamily: "'DM Mono',monospace" }}>{value.toUpperCase()}</span>
        </div>
      </div>
      <div style={{ position: "relative", width: "100%", height: 36, borderRadius: 10, overflow: "hidden", border: `1.5px solid ${C.border}`, background: value, cursor: "pointer" }}>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)}
          style={{ position: "absolute", inset: 0, width: "200%", height: "200%", opacity: 0, cursor: "pointer", border: "none", padding: 0 }} />
      </div>
    </div>
  );
}

// ─── Read saved colors once at module load (before any React render) ─────────
// Must be outside the component — useState(initialValue) only uses initialValue
// on the very first render, but if readSavedColors() is called inside the
// component body it re-runs on every render and can race with React's batching.
const _SAVED_COLORS = readSavedColors();

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [darkMode, setDarkMode] = useState(false);
  const [name, setName] = useState(DEFAULTS.name);
  const [font, setFont] = useState(DEFAULTS.font);
  const [textSize, setTextSize] = useState(DEFAULTS.textSize);
  const [textHeight, setTextHeight] = useState(DEFAULTS.textHeight);
  const [borderHeight, setBorderHeight] = useState(DEFAULTS.borderHeight);
  const [borderOffset, setBorderOffset] = useState(DEFAULTS.borderOffset);
  const [gap, setGap] = useState(DEFAULTS.gap);
  const [tabDiameter, setTabDiameter] = useState(DEFAULTS.tabDiameter);
  const [holeDiameter, setHoleDiameter] = useState(DEFAULTS.holeDiameter);
  const [tabYOffset, setTabYOffset] = useState(DEFAULTS.tabYOffset);
  const [borderColor, setBorderColor] = useState(_SAVED_COLORS?.borderColor ?? DEFAULTS.borderColor);
  const [textColor, setTextColor] = useState(_SAVED_COLORS?.textColor ?? DEFAULTS.textColor);
  const [fontsReady, setFontsReady] = useState(false);
  const [status, setStatus] = useState("loading");

  const C = darkMode ? DARK : LIGHT;

  useEffect(() => { persistColors(borderColor, textColor); }, [borderColor, textColor]);

  const dName = useDebounce(name, 200);
  const dTextSize = useDebounce(textSize, 80);
  const dTextHeight = useDebounce(textHeight, 80);
  const dBorderHeight = useDebounce(borderHeight, 80);
  const dBorderOffset = useDebounce(borderOffset, 80);
  const dGap = useDebounce(gap, 80);
  const dTabDiameter = useDebounce(tabDiameter, 80);
  const dHoleDiameter = useDebounce(holeDiameter, 80);
  const dTabYOffset = useDebounce(tabYOffset, 80);

  const canvasRef = useRef(null);
  const cameraRef = useRef(null);
  const rendererRef = useRef(null);
  const controlsRef = useRef(null);
  const animRef = useRef(null);
  const previewGroupRef = useRef(null);
  const sceneRef = useRef(null);
  const fontCacheRef = useRef({});
  const exportGeomsRef = useRef({ base: null, text: null, tab: null });
  const meshRefsRef = useRef({ base: null, tab: null, text: null });

  const safeName = useMemo(() => dName.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 20), [dName]);

  const anyDirty = useMemo(() => {
    const v = { name, font, textSize, textHeight, borderHeight, borderOffset, gap, tabDiameter, holeDiameter, tabYOffset, borderColor, textColor };
    return Object.keys(DEFAULTS).some((k) => v[k] !== DEFAULTS[k]);
  }, [name, font, textSize, textHeight, borderHeight, borderOffset, gap, tabDiameter, holeDiameter, tabYOffset, borderColor, textColor]);

  const resetAll = useCallback(() => {
    setName(DEFAULTS.name); setFont(DEFAULTS.font); setTextSize(DEFAULTS.textSize);
    setTextHeight(DEFAULTS.textHeight); setBorderHeight(DEFAULTS.borderHeight);
    setBorderOffset(DEFAULTS.borderOffset); setGap(DEFAULTS.gap);
    setTabDiameter(DEFAULTS.tabDiameter); setHoleDiameter(DEFAULTS.holeDiameter);
    setTabYOffset(DEFAULTS.tabYOffset); setBorderColor(DEFAULTS.borderColor);
    setTextColor(DEFAULTS.textColor);
  }, []);

  useEffect(() => {
    if (sceneRef.current) sceneRef.current.background.set(C.sceneBg);
  }, [darkMode, C.sceneBg]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(LIGHT.sceneBg);
    sceneRef.current = scene;
    const camera = new THREE.PerspectiveCamera(50, el.clientWidth / el.clientHeight, 0.1, 5000);
    camera.position.set(0, 0, 140);
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(el.clientWidth, el.clientHeight);
    el.appendChild(renderer.domElement);
    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(20, 30, 25); scene.add(dir);
    const fill = new THREE.DirectionalLight(0xffccee, 0.4);
    fill.position.set(-20, -10, 10); scene.add(fill);
    import("three/examples/jsm/controls/OrbitControls").then(({ OrbitControls }) => {
      const ctrl = new OrbitControls(camera, renderer.domElement);
      ctrl.enableDamping = true; ctrl.dampingFactor = 0.08;
      controlsRef.current = ctrl;
    });
    const pg = new THREE.Group();
    scene.add(pg);
    cameraRef.current = camera; rendererRef.current = renderer; previewGroupRef.current = pg;
    let lastTime = 0;
    const animate = (t) => {
      animRef.current = requestAnimationFrame(animate);
      if (document.hidden || t - lastTime < 14) return;
      lastTime = t; controlsRef.current?.update(); renderer.render(scene, camera);
    };
    animate(0);
    const onResize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(animRef.current);
      controlsRef.current?.dispose(); renderer.dispose(); renderer.domElement.remove();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        for (const k of Object.keys(FONT_URLS)) {
          const r = await fetch(FONT_URLS[k]);
          if (!r.ok) throw new Error(`Font 404: ${FONT_URLS[k]}`);
          fontCacheRef.current[k] = opentype.parse(await r.arrayBuffer());
          if (!alive) return;
        }
        if (alive) { setFontsReady(true); setStatus("ready"); }
      } catch (e) { console.error(e); setStatus("error"); }
    })();
    return () => { alive = false; };
  }, []);

  const clearPreviewGroup = useCallback(() => {
    const g = previewGroupRef.current;
    if (!g) return;
    while (g.children.length) {
      const obj = g.children.pop();
      obj?.traverse?.((c) => { if (c.isMesh) { c.geometry?.dispose(); c.material?.dispose(); } });
    }
  }, []);

  useEffect(() => {
    if (!fontsReady || !safeName || !previewGroupRef.current) return;
    const otFont = fontCacheRef.current[font];
    if (!otFont) return;
    setStatus("building");
    clearPreviewGroup();
    const tid = setTimeout(() => {
      try {
        const svgPath = otFont.getPath(safeName, 0, 0, dTextSize).toPathData(2);
        const svgData = new SVGLoader().parse(`<svg xmlns="http://www.w3.org/2000/svg"><path d="${svgPath}"/></svg>`);
        const shapes = [];
        svgData.paths.forEach((p) => p.toShapes(true).forEach((s) => shapes.push(s)));
        if (!shapes.length) return;

        const textGeo = new THREE.ExtrudeGeometry(shapes, { depth: dTextHeight, bevelEnabled: false, curveSegments: 8 });
        textGeo.scale(1, -1, 1);
        textGeo.computeBoundingBox();
        const tb = textGeo.boundingBox;
        textGeo.translate(-(tb.max.x + tb.min.x) / 2, -(tb.max.y + tb.min.y) / 2, 0);

        const outerPaths = shapes.flatMap((sh) => shapeToOuterPathsOnly(sh, 48));
        const baseGeo = new THREE.ExtrudeGeometry(
          polysToShapes(offsetUnion(outerPaths, dBorderOffset)),
          { depth: dBorderHeight, bevelEnabled: false, curveSegments: 10 }
        );
        baseGeo.scale(1, -1, 1);
        baseGeo.computeBoundingBox();
        const bb = baseGeo.boundingBox;
        baseGeo.translate(-(bb.max.x + bb.min.x) / 2, -(bb.max.y + bb.min.y) / 2, 0);
        baseGeo.computeBoundingBox();
        const baseB = baseGeo.boundingBox;

        const tabGeo = makeRingTabGeometry(dTabDiameter / 2, dHoleDiameter / 2, dBorderHeight, 40);
        tabGeo.translate(baseB.min.x - dGap - dTabDiameter / 2, -dTabYOffset, 0);

        clearPreviewGroup();
        const baseMat = new THREE.MeshPhongMaterial({ color: borderColor, shininess: 80 });
        const textMat = new THREE.MeshPhongMaterial({ color: textColor, shininess: 100 });
        const baseMesh = new THREE.Mesh(baseGeo, baseMat);
        const tabMesh = new THREE.Mesh(tabGeo, baseMat);
        const textMesh = new THREE.Mesh(textGeo, textMat);
        textMesh.position.z = dBorderHeight;
        previewGroupRef.current.add(baseMesh, tabMesh, textMesh);
        meshRefsRef.current = { base: baseMesh, tab: tabMesh, text: textMesh };

        Object.values(exportGeomsRef.current).forEach((g) => g?.dispose());
        exportGeomsRef.current = { base: baseGeo.clone(), tab: tabGeo.clone(), text: textGeo.clone() };

        const span = Math.max(baseB.max.x - baseB.min.x + dTabDiameter + dGap + 30, baseB.max.y - baseB.min.y + 40);
        if (cameraRef.current) cameraRef.current.position.set(0, 0, span * 1.2);
        if (controlsRef.current) { controlsRef.current.target.set(0, 0, dBorderHeight / 2); controlsRef.current.update(); }
        setStatus("ready");
      } catch (e) { console.error(e); setStatus("error"); }
    }, 0);
    return () => clearTimeout(tid);
  }, [fontsReady, safeName, font, dTextSize, dTextHeight, dBorderHeight, dBorderOffset, dGap, dTabDiameter, dHoleDiameter, dTabYOffset, borderColor, textColor, clearPreviewGroup]);

  useEffect(() => {
    const { base, tab, text } = meshRefsRef.current;
    if (base) base.material.color.set(borderColor);
    if (tab) tab.material.color.set(borderColor);
    if (text) text.material.color.set(textColor);
  }, [borderColor, textColor]);

  const exportSTL = useCallback(() => {
    if (!safeName) return;
    const { base, tab, text } = exportGeomsRef.current;
    if (!base || !tab || !text) return;
    const t = text.clone();
    t.translate(0, 0, borderHeight);
    const baseC = cleanForExport(base);
    const tabC = cleanForExport(tab);
    const textC = cleanForExport(t);
    const merged = mergeGeometries([baseC, tabC, textC], false);
    if (!merged) return;
    const stl = new STLExporter().parse(new THREE.Mesh(merged, new THREE.MeshNormalMaterial()), { binary: false });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([stl], { type: "model/stl" }));
    a.download = `${safeName}_${font.split(":")[0]}.stl`;
    a.click();
    URL.revokeObjectURL(a.href);
    baseC.dispose(); tabC.dispose(); textC.dispose(); merged.dispose();
  }, [safeName, font, borderHeight]);

  const exportOBJ = useCallback(() => {
    if (!safeName) return;
    const { base, tab, text } = exportGeomsRef.current;
    if (!base || !tab || !text) return;

    const tText = text.clone();
    tText.translate(0, 0, borderHeight);
    const baseC = cleanForExport(base);
    const tabC  = cleanForExport(tab);
    const textC = cleanForExport(tText);
    const baseMerged = mergeGeometries([baseC, tabC], false);

    const stem    = `${safeName}_${font.split(":")[0]}`;
    const mtlName = `${stem}.mtl`;

    // Parse hex colors to 0-1 RGB for MTL Kd values
    function hexToKd(hex) {
      const h = hex.replace(/^#/, "");
      return [
        parseInt(h.slice(0,2),16)/255,
        parseInt(h.slice(2,4),16)/255,
        parseInt(h.slice(4,6),16)/255,
      ];
    }
    const [r1,g1,b1] = hexToKd(borderColor);
    const [r2,g2,b2] = hexToKd(textColor);

    // MTL file — two named materials with exact Kd values
    const mtlStr = [
      `# Keychain Generator — material colors`,
      ``,
      `newmtl BorderColor`,
      `Kd ${r1.toFixed(6)} ${g1.toFixed(6)} ${b1.toFixed(6)}`,
      `Ka ${r1.toFixed(6)} ${g1.toFixed(6)} ${b1.toFixed(6)}`,
      `Ks 0.050000 0.050000 0.050000`,
      `Ns 10.0`,
      `d 1.0`,
      `illum 2`,
      ``,
      `newmtl TextColor`,
      `Kd ${r2.toFixed(6)} ${g2.toFixed(6)} ${b2.toFixed(6)}`,
      `Ka ${r2.toFixed(6)} ${g2.toFixed(6)} ${b2.toFixed(6)}`,
      `Ks 0.050000 0.050000 0.050000`,
      `Ns 10.0`,
      `d 1.0`,
      `illum 2`,
    ].join("\n");

    // Build OBJ manually — guarantees correct usemtl grouping
    function geoToObjLines(geo, matName, groupName, vOffset) {
      const pos = geo.toNonIndexed().attributes.position;
      const lines = [];
      lines.push(`g ${groupName}`);
      lines.push(`usemtl ${matName}`);
      for (let i = 0; i < pos.count; i++)
        lines.push(`v ${pos.getX(i).toFixed(6)} ${pos.getY(i).toFixed(6)} ${pos.getZ(i).toFixed(6)}`);
      for (let i = 0; i < pos.count; i += 3)
        lines.push(`f ${vOffset+i+1} ${vOffset+i+2} ${vOffset+i+3}`);
      return { lines, count: pos.count };
    }

    const objLines = [`# Keychain Generator`, `mtllib ${mtlName}`, ``];
    const { lines: l1, count: c1 } = geoToObjLines(baseMerged, "BorderColor", "border_tab", 0);
    const { lines: l2 }            = geoToObjLines(textC,       "TextColor",   "text",       c1);
    const objStr = objLines.concat(l1, [""], l2).join("\n");

    // Download .obj then .mtl
    const aObj = document.createElement("a");
    aObj.href = URL.createObjectURL(new Blob([objStr], { type: "model/obj" }));
    aObj.download = `${stem}.obj`;
    aObj.click();
    URL.revokeObjectURL(aObj.href);

    setTimeout(() => {
      const aMtl = document.createElement("a");
      aMtl.href = URL.createObjectURL(new Blob([mtlStr], { type: "model/mtl" }));
      aMtl.download = mtlName;
      aMtl.click();
      URL.revokeObjectURL(aMtl.href);
    }, 200);

    baseC.dispose(); tabC.dispose(); textC.dispose();
    if (baseMerged) baseMerged.dispose();
  }, [safeName, font, borderHeight, borderColor, textColor]);



  useEffect(() => {
    const id = "kc-global";
    if (document.getElementById(id)) return;
    const s = document.createElement("style");
    s.id = id;
    s.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&family=DM+Mono&display=swap');
      *{box-sizing:border-box;}
      input[type=range]{-webkit-appearance:none;appearance:none;background:transparent;}
      input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:white;border:2px solid #f472b6;box-shadow:0 1px 4px #f472b660;cursor:pointer;transition:transform 0.15s;}
      input[type=range]::-webkit-slider-thumb:hover{transform:scale(1.2);}
      input[type=range]::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:white;border:2px solid #f472b6;cursor:pointer;}
      input[type=range]:focus{outline:none;}
      select{-webkit-appearance:none;appearance:none;}
      ::-webkit-scrollbar{width:4px;}
      ::-webkit-scrollbar-track{background:transparent;}
      ::-webkit-scrollbar-thumb{background:#f0e6df;border-radius:4px;}
    `;
    document.head.appendChild(s);
  }, []);

  const statusColor = status === "ready" ? "#86efac" : status === "error" ? "#fca5a5" : "#fcd34d";
  const statusLabel = status === "ready" ? "Ready" : status === "error" ? "Error" : status === "building" ? "Building…" : "Loading fonts…";

  const inputStyle = {
    width: "100%", padding: "9px 12px", background: C.inputBg,
    border: `1.5px solid ${C.border}`, borderRadius: 12, color: C.text,
    fontFamily: "'Montserrat',sans-serif", fontSize: 14, outline: "none",
    transition: "border-color 0.2s",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", fontFamily: "'Montserrat',sans-serif", background: C.bg, color: C.text, overflow: "hidden" }}>
      <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0 }}>
        <div style={{ position: "absolute", top: -60, left: -60, width: 300, height: 300, borderRadius: "50%", background: C.blob1, filter: "blur(60px)" }} />
        <div style={{ position: "absolute", bottom: -40, right: -40, width: 250, height: 250, borderRadius: "50%", background: C.blob2, filter: "blur(50px)" }} />
      </div>

      <div style={{ position: "relative", zIndex: 1, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", borderBottom: `1px solid ${C.border}`, background: C.surface + "cc", backdropFilter: "blur(8px)" }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, color: C.text }}>⬡ Keychain Generator</div>
          <div style={{ fontSize: 10, color: C.muted, letterSpacing: 0.5 }}>browser-only · Design, preview &amp; export</div>
        </div>
        <button onClick={() => setDarkMode((d) => !d)} title={darkMode ? "Light mode" : "Dark mode"}
          style={{ width: 40, height: 24, borderRadius: 20, border: "none", cursor: "pointer", background: darkMode ? `linear-gradient(90deg,${C.accent},${C.accent2})` : "#f0e6df", position: "relative", transition: "background 0.3s", padding: 0, flexShrink: 0 }}>
          <div style={{ position: "absolute", top: 4, left: darkMode ? 20 : 4, width: 16, height: 16, borderRadius: "50%", background: "white", transition: "left 0.2s", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9 }}>
            {darkMode ? "🌙" : "☀️"}
          </div>
        </button>
      </div>

      <div style={{ display: "flex", flex: 1, overflow: "hidden", position: "relative", zIndex: 1 }}>
        <div style={{ width: 260, flexShrink: 0, overflowY: "auto", padding: "14px 14px 20px", borderRight: `1px solid ${C.border}`, background: C.surface + "99", backdropFilter: "blur(6px)" }}>

          <Section label="Text" C={C} />
          <div style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ fontSize: 12, color: C.muted, fontWeight: 500 }}>Name</span>
              {name !== DEFAULTS.name && <ResetBtn onClick={() => setName(DEFAULTS.name)} title="Reset name" C={C} />}
            </div>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} placeholder="Your name…"
              onFocus={(e) => (e.target.style.borderColor = C.accent)}
              onBlur={(e) => (e.target.style.borderColor = C.border)}
              style={{ ...inputStyle, marginBottom: 4 }} />
            <div style={{ fontSize: 10, color: C.muted, textAlign: "right" }}>{name.length}/20</div>
          </div>

          <div style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ fontSize: 12, color: C.muted, fontWeight: 500 }}>Font</span>
              {font !== DEFAULTS.font && <ResetBtn onClick={() => setFont(DEFAULTS.font)} title="Reset font" C={C} />}
            </div>
            <div style={{ position: "relative" }}>
              <select value={font} onChange={(e) => setFont(e.target.value)} style={{ ...inputStyle, cursor: "pointer", paddingRight: 32 }}>
                <option value="Pacifico:style=Regular">Pacifico</option>
                <option value="Lobster:style=Regular">Lobster</option>
                <option value="Titan One:style=Regular">Titan One</option>
                <option value="Luckiest Guy:style=Regular">Luckiest Guy</option>
              </select>
              <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none", color: C.muted, fontSize: 10 }}>▾</span>
            </div>
          </div>

          <SliderRow label="Text Size" value={textSize} min={8} max={40} step={0.5} onChange={setTextSize} defaultValue={DEFAULTS.textSize} C={C} />
          <SliderRow label="Text Height" value={textHeight} min={0.5} max={8} step={0.5} onChange={setTextHeight} defaultValue={DEFAULTS.textHeight} C={C} />

          <Section label="Border" C={C} />
          <SliderRow label="Border Height" value={borderHeight} min={0.5} max={8} step={0.5} onChange={setBorderHeight} defaultValue={DEFAULTS.borderHeight} C={C} />
          <SliderRow label="Border Offset" value={borderOffset} min={1} max={15} step={0.5} onChange={setBorderOffset} defaultValue={DEFAULTS.borderOffset} C={C} />

          <Section label="Tab" C={C} />
          <SliderRow label="Gap" value={gap} min={-5} max={5} step={0.5} onChange={setGap} defaultValue={DEFAULTS.gap} C={C} />
          <SliderRow label="Tab Diameter" value={tabDiameter} min={4} max={20} step={0.5} onChange={setTabDiameter} defaultValue={DEFAULTS.tabDiameter} C={C} />
          <SliderRow label="Hole Diameter" value={holeDiameter} min={1} max={10} step={0.5} onChange={setHoleDiameter} defaultValue={DEFAULTS.holeDiameter} C={C} />
          <SliderRow label="Tab Y Offset" value={tabYOffset} min={-20} max={20} step={0.5} onChange={setTabYOffset} defaultValue={DEFAULTS.tabYOffset} C={C} />

          <Section label="Colors" C={C} />
          <ColorPicker label="Border / Tab" value={borderColor} defaultValue={DEFAULTS.borderColor} onChange={setBorderColor} C={C} />
          <ColorPicker label="Text" value={textColor} defaultValue={DEFAULTS.textColor} onChange={setTextColor} C={C} />

          <button onClick={resetAll} disabled={!anyDirty}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.accent; e.currentTarget.style.color = C.accent; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = anyDirty ? C.accent : C.border; e.currentTarget.style.color = anyDirty ? C.accent : C.muted; }}
            style={{ width: "100%", padding: "7px 0", marginTop: 4, background: "none", border: `1.5px solid ${anyDirty ? C.accent : C.border}`, borderRadius: 10, cursor: anyDirty ? "pointer" : "default", fontSize: 12, color: anyDirty ? C.accent : C.muted, fontFamily: "'Montserrat',sans-serif", fontWeight: 600, transition: "all 0.2s", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
            ↺ Reset all settings
          </button>

          <Section label="Export" C={C} />
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[
              { label: "STL", fn: exportSTL, grad: "linear-gradient(135deg,#fda4af,#f472b6)", note: "geometry only" },
              { label: "OBJ", fn: exportOBJ, grad: "linear-gradient(135deg,#6ee7b7,#34d399)", note: "with .mtl colors" },
            ].map(({ label, fn, grad, note }) => (
              <button key={label} onClick={fn} disabled={!fontsReady}
                onMouseEnter={(e) => fontsReady && (e.currentTarget.style.transform = "translateY(-1px)")}
                onMouseLeave={(e) => (e.currentTarget.style.transform = "none")}
                style={{ padding: "10px 0", borderRadius: 12, border: "none", background: fontsReady ? grad : C.border, color: "white", fontFamily: "'Montserrat',sans-serif", fontWeight: 700, fontSize: 13, cursor: fontsReady ? "pointer" : "not-allowed", transition: "transform 0.15s,opacity 0.2s", opacity: fontsReady ? 1 : 0.5, boxShadow: `0 3px 14px ${C.shadow}` }}>
                Export {label}
                <div style={{ fontSize: 9, fontWeight: 500, opacity: 0.85, marginTop: 1 }}>{note}</div>
              </button>
            ))}
          </div>

          <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 6, justifyContent: "center" }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: statusColor, boxShadow: `0 0 6px ${statusColor}` }} />
            <span style={{ fontSize: 11, color: C.muted }}>{statusLabel}</span>
          </div>
        </div>

        <div ref={canvasRef} style={{ flex: 1, position: "relative", overflow: "hidden" }}>
          <div style={{ position: "absolute", bottom: 10, left: "50%", transform: "translateX(-50%)", fontSize: 10, color: C.muted, background: C.surface + "99", backdropFilter: "blur(4px)", padding: "3px 10px", borderRadius: 20, pointerEvents: "none", whiteSpace: "nowrap", zIndex: 2 }}>
            3D Preview · drag to rotate · scroll to zoom
          </div>
        </div>
      </div>
    </div>
  );
}