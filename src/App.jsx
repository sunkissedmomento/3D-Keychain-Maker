import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import * as THREE from "three";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter";
import {
  mergeGeometries,
  mergeVertices,
} from "three/examples/jsm/utils/BufferGeometryUtils";
import opentype from "opentype.js";
import ClipperLib from "clipper-lib";
// NOTE: three-bvh-csg imported but NOT USED for export; kept if you want later.
// import { Brush, Evaluator, ADDITION } from "three-bvh-csg";

// ─── Defaults ─────────────────────────────────────────────────────────────────
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

const FONT_URLS = {
  "Pacifico:style=Regular": "/fonts/Pacifico-Regular.ttf",
  "Lobster:style=Regular": "/fonts/Lobster-Regular.ttf",
  "Titan One:style=Regular": "/fonts/TitanOne-Regular.ttf",
  "Luckiest Guy:style=Regular": "/fonts/LuckiestGuy-Regular.ttf",
};

// ─── Theme ────────────────────────────────────────────────────────────────────
const LIGHT = {
  bg: "#fdf6f0",
  surface: "#ffffff",
  border: "#f0e6df",
  text: "#6b4c6b",
  muted: "#c4a8c4",
  accent: "#f472b6",
  accent2: "#c084fc",
  trackBg: "#f5e6f0",
  valuePill: "#fce7f3",
  resetHov: "#fce7f3",
  inputBg: "#fff8fc",
  sceneBg: 0xfdf0f8,
  blob1: "#fce7f340",
  blob2: "#e9d5ff40",
  shadow: "#f9a8d420",
  shadow2: "#c084fc20",
};
const DARK = {
  bg: "#18111e",
  surface: "#221830",
  border: "#2e2040",
  text: "#e9d5f5",
  muted: "#7c5fa0",
  accent: "#f472b6",
  accent2: "#c084fc",
  trackBg: "#2e1d3a",
  valuePill: "#3d1f4a",
  resetHov: "#3d1f4a",
  inputBg: "#1e1428",
  sceneBg: 0x140d1e,
  blob1: "#f472b615",
  blob2: "#c084fc15",
  shadow: "#f9a8d415",
  shadow2: "#c084fc15",
};

// ─── Geometry helpers ─────────────────────────────────────────────────────────
const SCALE = 1000;
const toClipperPath = (poly) =>
  poly.map(([x, y]) => ({
    X: Math.round(x * SCALE),
    Y: Math.round(y * SCALE),
  }));
const fromClipperPoly = (poly) => poly.map((p) => [p.X / SCALE, p.Y / SCALE]);

function shapeToOuterPathsOnly(shape, quality = 60) {
  const pts = shape.getPoints(quality);
  return pts.length >= 3 ? [pts.map((p) => [p.x, p.y])] : [];
}

function offsetUnion(paths, deltaMm) {
  const subj = paths.map(toClipperPath);
  const co = new ClipperLib.ClipperOffset(2, 0.75 * SCALE);
  co.AddPaths(
    subj,
    ClipperLib.JoinType.jtRound,
    ClipperLib.EndType.etClosedPolygon
  );
  const off = new ClipperLib.Paths();
  co.Execute(off, deltaMm * SCALE);

  const c = new ClipperLib.Clipper();
  c.AddPaths(off, ClipperLib.PolyType.ptSubject, true);
  const sol = new ClipperLib.Paths();
  c.Execute(
    ClipperLib.ClipType.ctUnion,
    sol,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero
  );
  return sol.map(fromClipperPoly);
}

function signedArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i],
      [x2, y2] = poly[(i + 1) % poly.length];
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
    .map(
      (p) =>
        new THREE.Shape(ensureCCW(p).map(([x, y]) => new THREE.Vector2(x, y)))
    );
}

/**
 * IMPORTANT FIX for non-manifold reports:
 * Hole winding should be opposite to outer. This prevents broken caps / seams
 * in some slicers and repair tools.
 */
function makeRingTabGeometry(tabR, holeR, height, segs = 48) {
  const outer = new THREE.Shape();
  // Outer clockwise
  outer.absarc(0, 0, tabR, 0, Math.PI * 2, true);

  const hole = new THREE.Path();
  // Hole counter-clockwise
  hole.absarc(0, 0, holeR, 0, Math.PI * 2, false);

  outer.holes.push(hole);

  return new THREE.ExtrudeGeometry(outer, {
    depth: height,
    bevelEnabled: false,
    curveSegments: segs,
  });
}

// ─── Geometry cleanup for export (fixes non-manifold flags in slicers) ─────────
function cleanForExport(geo, weldTol = 1e-4, areaEps = 1e-10) {
  // 1) Clone
  let g = geo.clone();

  // 2) Weld near-duplicate vertices (removes micro-cracks & zero-width slivers)
  // mergeVertices returns indexed geometry
  g = mergeVertices(g, weldTol);

  // 3) Remove degenerate triangles (zero-area)
  // Work on non-indexed to filter easily, then re-weld again.
  const non = g.toNonIndexed();
  const pos = non.attributes.position;

  const kept = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const cross = new THREE.Vector3();

  for (let i = 0; i < pos.count; i += 3) {
    a.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    b.set(pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1));
    c.set(pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2));

    ab.subVectors(b, a);
    ac.subVectors(c, a);
    cross.crossVectors(ab, ac);

    const area2 = cross.lengthSq(); // proportional to area^2
    if (area2 > areaEps) {
      kept.push(
        a.x,
        a.y,
        a.z,
        b.x,
        b.y,
        b.z,
        c.x,
        c.y,
        c.z
      );
    }
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(kept), 3)
  );

  // 4) Re-weld and recompute normals/bounds
  let welded = mergeVertices(out, weldTol);
  welded.computeVertexNormals();
  welded.computeBoundingBox();
  welded.computeBoundingSphere();
  return welded;
}

// ─── 3MF builder ─────────────────────────────────────────────────────────────
function geoToVertsAndTris(geometry) {
  const geo = geometry.toNonIndexed();
  const pos = geo.attributes.position;
  const verts = [];
  const tris = [];
  for (let i = 0; i < pos.count; i++)
    verts.push([
      pos.getX(i).toFixed(5),
      pos.getY(i).toFixed(5),
      pos.getZ(i).toFixed(5),
    ]);
  for (let i = 0; i < pos.count; i += 3) tris.push([i, i + 1, i + 2]);
  return { verts, tris };
}

// (This helper is NOT used, but if you ever use it, v3 must be correct.)
function meshXml(id, extruder, verts, tris) {
  return `<object id="${id}" type="model" p:uuid="${id}-0000-0000-0000-000000000000">
      <metadatagroup>
        <metadata name="BambuStudio:FilamentId">${extruder}</metadata>
      </metadatagroup>
      <mesh>
        <vertices>
          ${verts
            .map((v) => `<vertex x="${v[0]}" y="${v[1]}" z="${v[2]}"/>`)
            .join("\n          ")}
        </vertices>
        <triangles>
          ${tris
            .map(
              (t) =>
                `<triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>`
            )
            .join("\n          ")}
        </triangles>
      </mesh>
    </object>`;
}

function build3MF(baseTabGeo, textGeo, borderColor, textColor) {
  const bt = geoToVertsAndTris(baseTabGeo);
  const tx = geoToVertsAndTris(textGeo);

  const hex = (c) => c.replace("#", "").toUpperCase();

  const modelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US"
  xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
  xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"
  xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
  <metadata name="BambuStudio:3mfVersion">1</metadata>
  <resources>
    <m:colorgroup id="100">
      <m:color color="#${hex(borderColor)}FF"/>
    </m:colorgroup>
    <m:colorgroup id="200">
      <m:color color="#${hex(textColor)}FF"/>
    </m:colorgroup>

    <object id="1" type="model" m:colorid="100" m:colorindex="0">
      <mesh>
        <vertices>
          ${bt.verts
            .map((v) => `<vertex x="${v[0]}" y="${v[1]}" z="${v[2]}"/>`)
            .join("\n          ")}
        </vertices>
        <triangles>
          ${bt.tris
            .map(
              (t) =>
                `<triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>`
            )
            .join("\n          ")}
        </triangles>
      </mesh>
    </object>

    <object id="2" type="model" m:colorid="200" m:colorindex="0">
      <mesh>
        <vertices>
          ${tx.verts
            .map((v) => `<vertex x="${v[0]}" y="${v[1]}" z="${v[2]}"/>`)
            .join("\n          ")}
        </vertices>
        <triangles>
          ${tx.tris
            .map(
              (t) =>
                `<triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>`
            )
            .join("\n          ")}
        </triangles>
      </mesh>
    </object>
  </resources>
  <resources>
  ... object 1 ...
  ... object 2 ...

  <object id="10" type="model">
    <components>
      <component objectid="1"/>
      <component objectid="2"/>
    </components>
  </object>
</resources>

<build>
  <item objectid="10"/>
</build>
</model>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/model/3dmodel.model" Id="rel0"
    Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

  return { modelXml, contentTypes, rels };
}

// Zip via fflate into a single .3mf download
async function exportAs3MF(
  baseTabGeo,
  textGeo,
  borderColor,
  textColor,
  filename
) {
  const { modelXml, contentTypes, rels } = build3MF(
    baseTabGeo,
    textGeo,
    borderColor,
    textColor
  );
  const { strToU8, zip } = await import(
    "https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js"
  );
  return new Promise((resolve, reject) => {
    zip(
      {
        "[Content_Types].xml": strToU8(contentTypes),
        "_rels/.rels": strToU8(rels),
        "model/3dmodel.model": strToU8(modelXml),
      },
      (err, data) => {
        if (err) {
          reject(err);
          return;
        }
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([data], { type: "model/3mf" }));
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
        resolve();
      }
    );
  });
}

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
    <button
      onClick={onClick}
      title={title || "Reset"}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        background: hov ? C.resetHov : "none",
        border: "none",
        borderRadius: "50%",
        width: 18,
        height: 18,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        fontSize: 11,
        color: hov ? C.accent : C.muted,
        transition: "all 0.15s",
        padding: 0,
        flexShrink: 0,
      }}
    >
      ↺
    </button>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step = 1,
  unit = "mm",
  onChange,
  defaultValue,
  C,
}) {
  const pct = ((value - min) / (max - min)) * 100;
  const dirty = value !== defaultValue;
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 6,
        }}
      >
        <span
          style={{
            fontSize: 11,
            color: C.muted,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            fontWeight: 600,
          }}
        >
          {label}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span
            style={{
              fontSize: 12,
              fontFamily: "'DM Mono',monospace",
              color: dirty ? C.text : C.muted,
              background: dirty ? C.valuePill : "transparent",
              padding: dirty ? "1px 6px" : "0",
              borderRadius: 20,
              transition: "all 0.2s",
            }}
          >
            {value}
            {unit}
          </span>
          {dirty && (
            <ResetBtn
              onClick={() => onChange(defaultValue)}
              title={`Reset to ${defaultValue}${unit}`}
              C={C}
            />
          )}
        </div>
      </div>
      <div
        style={{
          position: "relative",
          height: 6,
          borderRadius: 10,
          background: C.trackBg,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            height: "100%",
            width: `${pct}%`,
            borderRadius: 10,
            background: `linear-gradient(90deg,${C.accent},${C.accent2})`,
            transition: "width 0.05s",
          }}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onInput={(e) => onChange(+e.target.value)}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            opacity: 0,
            cursor: "pointer",
            margin: 0,
          }}
        />
      </div>
    </div>
  );
}

function Section({ label, C }) {
  return (
    <div
      style={{
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: "0.18em",
        textTransform: "uppercase",
        color: C.accent,
        marginTop: 22,
        marginBottom: 10,
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      <div
        style={{
          flex: 1,
          height: 1,
          background: `linear-gradient(90deg,${C.accent}40,transparent)`,
        }}
      />
      {label}
      <div
        style={{
          flex: 1,
          height: 1,
          background: `linear-gradient(270deg,${C.accent}40,transparent)`,
        }}
      />
    </div>
  );
}

function ColorPicker({ label, value, defaultValue, onChange, C }) {
  const dirty = value !== defaultValue;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 12,
      }}
    >
      <span
        style={{
          fontSize: 11,
          color: C.muted,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          fontWeight: 600,
        }}
      >
        {label}
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {dirty && (
          <ResetBtn
            onClick={() => onChange(defaultValue)}
            title={`Reset to ${defaultValue}`}
            C={C}
          />
        )}
        <span
          style={{
            fontSize: 10,
            fontFamily: "'DM Mono',monospace",
            color: dirty ? C.text : C.muted,
          }}
        >
          {value.toUpperCase()}
        </span>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 10,
            background: value,
            boxShadow: `0 2px 8px ${value}80`,
            border: `2px solid ${dirty ? value : C.border}`,
            overflow: "hidden",
            cursor: "pointer",
            position: "relative",
            transition: "box-shadow 0.2s",
          }}
        >
          <input
            type="color"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            style={{
              position: "absolute",
              inset: 0,
              width: "200%",
              height: "200%",
              opacity: 0,
              cursor: "pointer",
              border: "none",
              padding: 0,
            }}
          />
        </div>
      </div>
    </div>
  );
}

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
  const [borderColor, setBorderColor] = useState(DEFAULTS.borderColor);
  const [textColor, setTextColor] = useState(DEFAULTS.textColor);
  const [fontsReady, setFontsReady] = useState(false);
  const [status, setStatus] = useState("loading");
  const [exporting, setExporting] = useState(false);

  const C = darkMode ? DARK : LIGHT;

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

  const safeName = useMemo(
    () => dName.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 20),
    [dName]
  );

  const anyDirty = useMemo(() => {
    const v = {
      name,
      font,
      textSize,
      textHeight,
      borderHeight,
      borderOffset,
      gap,
      tabDiameter,
      holeDiameter,
      tabYOffset,
      borderColor,
      textColor,
    };
    return Object.keys(DEFAULTS).some((k) => v[k] !== DEFAULTS[k]);
  }, [
    name,
    font,
    textSize,
    textHeight,
    borderHeight,
    borderOffset,
    gap,
    tabDiameter,
    holeDiameter,
    tabYOffset,
    borderColor,
    textColor,
  ]);

  const resetAll = useCallback(() => {
    setName(DEFAULTS.name);
    setFont(DEFAULTS.font);
    setTextSize(DEFAULTS.textSize);
    setTextHeight(DEFAULTS.textHeight);
    setBorderHeight(DEFAULTS.borderHeight);
    setBorderOffset(DEFAULTS.borderOffset);
    setGap(DEFAULTS.gap);
    setTabDiameter(DEFAULTS.tabDiameter);
    setHoleDiameter(DEFAULTS.holeDiameter);
    setTabYOffset(DEFAULTS.tabYOffset);
    setBorderColor(DEFAULTS.borderColor);
    setTextColor(DEFAULTS.textColor);
  }, []);

  // Update scene background when dark mode changes
  useEffect(() => {
    if (sceneRef.current) sceneRef.current.background.set(C.sceneBg);
  }, [darkMode, C.sceneBg]);

  // Three.js init
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(LIGHT.sceneBg);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(
      50,
      el.clientWidth / el.clientHeight,
      0.1,
      5000
    );
    camera.position.set(0, 0, 140);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(el.clientWidth, el.clientHeight);
    el.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(20, 30, 25);
    scene.add(dir);
    const fill = new THREE.DirectionalLight(0xffccee, 0.4);
    fill.position.set(-20, -10, 10);
    scene.add(fill);

    import("three/examples/jsm/controls/OrbitControls").then(
      ({ OrbitControls }) => {
        const ctrl = new OrbitControls(camera, renderer.domElement);
        ctrl.enableDamping = true;
        ctrl.dampingFactor = 0.08;
        controlsRef.current = ctrl;
      }
    );

    const pg = new THREE.Group();
    scene.add(pg);

    cameraRef.current = camera;
    rendererRef.current = renderer;
    previewGroupRef.current = pg;

    let lastTime = 0;
    const animate = (t) => {
      animRef.current = requestAnimationFrame(animate);
      if (document.hidden || t - lastTime < 14) return;
      lastTime = t;
      controlsRef.current?.update();
      renderer.render(scene, camera);
    };
    animate(0);

    const onResize = () => {
      const w = el.clientWidth,
        h = el.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(animRef.current);
      controlsRef.current?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  // Font load
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
        if (alive) {
          setFontsReady(true);
          setStatus("ready");
        }
      } catch (e) {
        console.error(e);
        setStatus("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const clearPreviewGroup = useCallback(() => {
    const g = previewGroupRef.current;
    if (!g) return;
    while (g.children.length) {
      const obj = g.children.pop();
      obj?.traverse?.((c) => {
        if (c.isMesh) {
          c.geometry?.dispose();
          c.material?.dispose();
        }
      });
    }
  }, []);

  // Geometry build
  useEffect(() => {
    if (!fontsReady || !safeName || !previewGroupRef.current) return;
    const otFont = fontCacheRef.current[font];
    if (!otFont) return;

    setStatus("building");
    clearPreviewGroup(); // clear immediately so no ghost frames during async build

    const tid = setTimeout(() => {
      try {
        const svgPath = otFont
          .getPath(safeName, 0, 0, dTextSize)
          .toPathData(2);
        const svgData = new SVGLoader().parse(
          `<svg xmlns="http://www.w3.org/2000/svg"><path d="${svgPath}"/></svg>`
        );

        const shapes = [];
        svgData.paths.forEach((p) =>
          p.toShapes(true).forEach((s) => shapes.push(s))
        );
        if (!shapes.length) return;

        // Text
        const textGeo = new THREE.ExtrudeGeometry(shapes, {
          depth: dTextHeight,
          bevelEnabled: false,
          curveSegments: 8,
        });
        textGeo.scale(1, -1, 1);
        textGeo.computeBoundingBox();
        const tb = textGeo.boundingBox;
        textGeo.translate(-(tb.max.x + tb.min.x) / 2, -(tb.max.y + tb.min.y) / 2, 0);

        // Base outline from outer paths only
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

        // Tab (with winding fix)
        const tabGeo = makeRingTabGeometry(
          dTabDiameter / 2,
          dHoleDiameter / 2,
          dBorderHeight,
          40
        );
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

        // Dispose previous export geometry clones to avoid memory leak
        Object.values(exportGeomsRef.current).forEach((g) => g?.dispose());
        exportGeomsRef.current = {
          base: baseGeo.clone(),
          tab: tabGeo.clone(),
          text: textGeo.clone(),
        };

        const span = Math.max(
          baseB.max.x - baseB.min.x + dTabDiameter + dGap + 30,
          baseB.max.y - baseB.min.y + 40
        );
        if (cameraRef.current) cameraRef.current.position.set(0, 0, span * 1.2);
        if (controlsRef.current) {
          controlsRef.current.target.set(0, 0, dBorderHeight / 2);
          controlsRef.current.update();
        }

        setStatus("ready");
      } catch (e) {
        console.error(e);
        setStatus("error");
      }
    }, 0);

    return () => clearTimeout(tid);
  }, [
    fontsReady,
    safeName,
    font,
    dTextSize,
    dTextHeight,
    dBorderHeight,
    dBorderOffset,
    dGap,
    dTabDiameter,
    dHoleDiameter,
    dTabYOffset,
    borderColor,
    textColor,
    clearPreviewGroup,
  ]);

  // Fast color update
  useEffect(() => {
    const { base, tab, text } = meshRefsRef.current;
    if (base) base.material.color.set(borderColor);
    if (tab) tab.material.color.set(borderColor);
    if (text) text.material.color.set(textColor);
  }, [borderColor, textColor]);

  // Export STL — now cleans geometry first to remove non-manifold flags.
  const exportSTL = useCallback(() => {
    if (!safeName) return;
    const { base, tab, text } = exportGeomsRef.current;
    if (!base || !tab || !text) return;

    // Position text
    const t = text.clone();
    t.translate(0, 0, borderHeight);

    // CLEAN each body before merging
    const baseC = cleanForExport(base);
    const tabC = cleanForExport(tab);
    const textC = cleanForExport(t);

    // Merge triangle soups (still not boolean), but now far fewer broken edges
    const merged = mergeGeometries([baseC, tabC, textC], false);
    if (!merged) return;

    const stl = new STLExporter().parse(
      new THREE.Mesh(merged, new THREE.MeshNormalMaterial()),
      { binary: false }
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([stl], { type: "model/stl" }));
    a.download = `${safeName}_${font.split(":")[0]}.stl`;
    a.click();
    URL.revokeObjectURL(a.href);

    // dispose temps
    baseC.dispose();
    tabC.dispose();
    textC.dispose();
    merged.dispose();
  }, [safeName, font, borderHeight]);

  // Export 3MF (color-embedded) — also cleans meshes before writing XML
  const export3MF = useCallback(async () => {
    if (!safeName || exporting) return;
    const { base, tab, text } = exportGeomsRef.current;
    if (!base || !tab || !text) return;

    setExporting(true);
    try {
      // Merge base+tab (after cleaning)
      const baseC = cleanForExport(base);
      const tabC = cleanForExport(tab);
      const baseTabMerged = mergeGeometries([baseC, tabC], false);
      if (!baseTabMerged) throw new Error("Merge failed");

      // Position + clean text
      const textPositioned = text.clone();
      textPositioned.translate(0, 0, borderHeight);
      const textC = cleanForExport(textPositioned);

      await exportAs3MF(
        baseTabMerged,
        textC,
        borderColor,
        textColor,
        `${safeName}_${font.split(":")[0]}.3mf`
      );

      // dispose temps
      baseC.dispose();
      tabC.dispose();
      baseTabMerged.dispose();
      textPositioned.dispose();
      textC.dispose();
    } catch (e) {
      alert("3MF export failed: " + e.message);
    }
    setExporting(false);
  }, [safeName, font, borderHeight, borderColor, textColor, exporting]);

  // Global styles
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

  const statusColor =
    status === "ready" ? "#86efac" : status === "error" ? "#fca5a5" : "#fcd34d";
  const statusLabel =
    status === "ready"
      ? "Ready"
      : status === "error"
      ? "Error"
      : status === "building"
      ? "Building…"
      : "Loading fonts…";

  const inputStyle = {
    width: "100%",
    padding: "9px 12px",
    background: C.inputBg,
    border: `1.5px solid ${C.border}`,
    borderRadius: 12,
    color: C.text,
    fontFamily: "'Montserrat',sans-serif",
    fontSize: 14,
    outline: "none",
    transition: "border-color 0.2s",
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: C.bg,
        fontFamily: "'Montserrat',sans-serif",
        color: C.text,
        transition: "background 0.3s,color 0.3s",
      }}
    >
      {/* Blobs */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          pointerEvents: "none",
          overflow: "hidden",
          zIndex: 0,
        }}
      >
        <div
          style={{
            position: "absolute",
            top: -80,
            right: -80,
            width: 320,
            height: 320,
            borderRadius: "50%",
            background: C.blob1,
            filter: "blur(60px)",
            transition: "background 0.3s",
          }}
        />
        <div
          style={{
            position: "absolute",
            bottom: -60,
            left: -60,
            width: 260,
            height: 260,
            borderRadius: "50%",
            background: C.blob2,
            filter: "blur(50px)",
            transition: "background 0.3s",
          }}
        />
      </div>

      <div
        style={{
          position: "relative",
          zIndex: 1,
          maxWidth: 1120,
          margin: "0 auto",
          padding: "28px 20px",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 24,
          }}
        >
          <div>
            <h1
              style={{
                margin: 0,
                fontSize: 22,
                fontWeight: 700,
                color: C.text,
                letterSpacing: "-0.02em",
              }}
            >
              Keychain Generator
              <span
                style={{
                  marginLeft: 10,
                  fontSize: 12,
                  fontWeight: 500,
                  color: C.muted,
                  letterSpacing: "0.04em",
                }}
              >
                browser-only
              </span>
            </h1>
            <p style={{ margin: "4px 0 0", fontSize: 12, color: C.muted }}>
              Design, preview &amp; export
            </p>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {/* Dark mode toggle */}
            <button
              onClick={() => setDarkMode((d) => !d)}
              title={darkMode ? "Light mode" : "Dark mode"}
              style={{
                width: 40,
                height: 24,
                borderRadius: 20,
                border: "none",
                cursor: "pointer",
                background: darkMode
                  ? `linear-gradient(90deg,${C.accent},${C.accent2})`
                  : `#f0e6df`,
                position: "relative",
                transition: "background 0.3s",
                padding: 0,
                flexShrink: 0,
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: 3,
                  left: darkMode ? 18 : 3,
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  background: "white",
                  boxShadow: "0 1px 4px #0003",
                  transition: "left 0.2s",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 10,
                }}
              >
                {darkMode ? "🌙" : "☀️"}
              </div>
            </button>
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "300px 1fr",
            gap: 16,
            alignItems: "start",
          }}
        >
          {/* Controls */}
          <div
            style={{
              background: C.surface,
              borderRadius: 20,
              border: `1.5px solid ${C.border}`,
              padding: "20px 18px",
              boxShadow: `0 4px 24px ${C.shadow}`,
              overflowY: "auto",
              maxHeight: "calc(100vh - 120px)",
              transition: "background 0.3s,border-color 0.3s",
            }}
          >
            {/* Name */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 6,
              }}
            >
              <label
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: C.muted,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                }}
              >
                Name
              </label>
              {name !== DEFAULTS.name && (
                <ResetBtn
                  onClick={() => setName(DEFAULTS.name)}
                  title="Reset name"
                  C={C}
                />
              )}
            </div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={20}
              placeholder="Your name…"
              onFocus={(e) => (e.target.style.borderColor = C.accent)}
              onBlur={(e) => (e.target.style.borderColor = C.border)}
              style={{ ...inputStyle, marginBottom: 4 }}
            />
            <div
              style={{
                fontSize: 10,
                color: C.muted,
                textAlign: "right",
                marginBottom: 14,
              }}
            >
              {name.length}/20
            </div>

            {/* Font */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 6,
              }}
            >
              <label
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: C.muted,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                }}
              >
                Font
              </label>
              {font !== DEFAULTS.font && (
                <ResetBtn
                  onClick={() => setFont(DEFAULTS.font)}
                  title="Reset font"
                  C={C}
                />
              )}
            </div>
            <div style={{ position: "relative", marginBottom: 4 }}>
              <select
                value={font}
                onChange={(e) => setFont(e.target.value)}
                style={{ ...inputStyle, cursor: "pointer", paddingRight: 32 }}
              >
                <option value="Pacifico:style=Regular">Pacifico</option>
                <option value="Lobster:style=Regular">Lobster</option>
                <option value="Titan One:style=Regular">Titan One</option>
                <option value="Luckiest Guy:style=Regular">Luckiest Guy</option>
              </select>
              <span
                style={{
                  position: "absolute",
                  right: 12,
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: C.muted,
                  fontSize: 10,
                  pointerEvents: "none",
                }}
              >
                ▾
              </span>
            </div>

            <Section label="Colors" C={C} />
            <ColorPicker
              label="Border + Tab"
              value={borderColor}
              defaultValue={DEFAULTS.borderColor}
              onChange={setBorderColor}
              C={C}
            />
            <ColorPicker
              label="Text"
              value={textColor}
              defaultValue={DEFAULTS.textColor}
              onChange={setTextColor}
              C={C}
            />

            <Section label="Text" C={C} />
            <SliderRow
              label="Size"
              value={textSize}
              min={10}
              max={30}
              defaultValue={DEFAULTS.textSize}
              onChange={setTextSize}
              C={C}
            />
            <SliderRow
              label="Height"
              value={textHeight}
              min={1}
              max={10}
              step={0.5}
              defaultValue={DEFAULTS.textHeight}
              onChange={setTextHeight}
              C={C}
            />

            <Section label="Base" C={C} />
            <SliderRow
              label="Height"
              value={borderHeight}
              min={1}
              max={10}
              step={0.5}
              defaultValue={DEFAULTS.borderHeight}
              onChange={setBorderHeight}
              C={C}
            />
            <SliderRow
              label="Outline"
              value={borderOffset}
              min={0.5}
              max={8}
              step={0.5}
              defaultValue={DEFAULTS.borderOffset}
              onChange={setBorderOffset}
              C={C}
            />

            <Section label="Hole Tab" C={C} />
            <SliderRow
              label="Gap"
              value={gap}
              min={-5}
              max={5}
              step={0.5}
              defaultValue={DEFAULTS.gap}
              onChange={setGap}
              C={C}
            />
            <SliderRow
              label="Tab diameter"
              value={tabDiameter}
              min={6}
              max={20}
              step={0.5}
              defaultValue={DEFAULTS.tabDiameter}
              onChange={setTabDiameter}
              C={C}
            />
            <SliderRow
              label="Hole diameter"
              value={holeDiameter}
              min={2.5}
              max={12}
              step={0.5}
              defaultValue={DEFAULTS.holeDiameter}
              onChange={setHoleDiameter}
              C={C}
            />
            <SliderRow
              label="Tab Y offset"
              value={tabYOffset}
              min={-30}
              max={30}
              step={0.5}
              defaultValue={DEFAULTS.tabYOffset}
              onChange={setTabYOffset}
              C={C}
            />

            {/* Reset All */}
            <button
              onClick={resetAll}
              style={{
                width: "100%",
                marginTop: 22,
                marginBottom: 8,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                padding: "9px 0",
                borderRadius: 12,
                background: anyDirty ? C.valuePill : "none",
                border: `1.5px solid ${anyDirty ? C.accent : C.border}`,
                color: anyDirty ? C.accent : C.muted,
                fontSize: 11,
                fontWeight: 600,
                fontFamily: "inherit",
                cursor: "pointer",
                transition: "all 0.2s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = C.accent;
                e.currentTarget.style.color = C.accent;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = anyDirty ? C.accent : C.border;
                e.currentTarget.style.color = anyDirty ? C.accent : C.muted;
              }}
            >
              ↺ Reset all settings
            </button>

            {/* Export */}
            <div
              style={{
                marginTop: 0,
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
              }}
            >
              {[
                {
                  label: "STL",
                  fn: exportSTL,
                  grad: "linear-gradient(135deg,#fda4af,#f472b6)",
                  note: "geometry only",
                },
                {
                  label: "3MF",
                  fn: export3MF,
                  grad: "linear-gradient(135deg,#c4b5fd,#a78bfa)",
                  note: "with colors",
                },
              ].map(({ label, fn, grad, note }) => (
                <button
                  key={label}
                  onClick={fn}
                  disabled={!fontsReady || exporting}
                  style={{
                    padding: "11px 0",
                    fontSize: 11,
                    fontWeight: 700,
                    fontFamily: "inherit",
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    background: fontsReady && !exporting ? grad : C.border,
                    color: fontsReady && !exporting ? "white" : C.muted,
                    border: "none",
                    borderRadius: 14,
                    cursor: fontsReady && !exporting ? "pointer" : "not-allowed",
                    boxShadow:
                      fontsReady && !exporting ? "0 4px 12px #f472b640" : "none",
                    transition: "all 0.2s",
                  }}
                  onMouseEnter={(e) =>
                    fontsReady &&
                    !exporting &&
                    (e.currentTarget.style.transform = "translateY(-1px)")
                  }
                  onMouseLeave={(e) => (e.currentTarget.style.transform = "none")}
                >
                  Export {label}
                  <div style={{ fontSize: 9, fontWeight: 400, opacity: 0.8, marginTop: 2 }}>
                    {note}
                  </div>
                </button>
              ))}
            </div>

            {/* Status */}
            <div style={{ marginTop: 12, display: "flex", justifyContent: "center" }}>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 12px",
                  borderRadius: 20,
                  background: `${statusColor}20`,
                  border: `1px solid ${statusColor}60`,
                }}
              >
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: statusColor }} />
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: statusColor,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                  }}
                >
                  {exporting ? "Exporting…" : statusLabel}
                </span>
              </div>
            </div>
          </div>

          {/* Viewport */}
          <div
            style={{
              background: C.surface,
              borderRadius: 20,
              border: `1.5px solid ${C.border}`,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
              boxShadow: `0 4px 24px ${C.shadow2}`,
              transition: "background 0.3s,border-color 0.3s",
            }}
          >
            <div
              style={{
                padding: "12px 18px",
                borderBottom: `1px solid ${C.border}`,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                transition: "border-color 0.3s",
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: C.muted,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                }}
              >
                3D Preview
              </span>
              <span style={{ fontSize: 10, color: C.muted }}>
                drag to rotate · scroll to zoom
              </span>
            </div>
            <div ref={canvasRef} style={{ flex: 1, minHeight: 540 }} />
          </div>
        </div>
      </div>
    </div>
  );
}
