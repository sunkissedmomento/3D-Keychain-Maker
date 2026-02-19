import ClipperLib from "clipper-lib";

const SCALE = 1000;

function toClipperPath(path) {
  return path.map(([x, y]) => ({
    X: Math.round(x * SCALE),
    Y: Math.round(y * SCALE),
  }));
}

function fromClipperPaths(paths) {
  return paths.map((poly) => poly.map((p) => [p.X / SCALE, p.Y / SCALE]));
}

function offsetAndUnion(allPaths, deltaMm) {
  const subj = allPaths.map(toClipperPath);

  // Offset
  const co = new ClipperLib.ClipperOffset(
    2,
    0.75 * SCALE // smoother + faster than tiny tolerance
  );

  co.AddPaths(
    subj,
    ClipperLib.JoinType.jtRound,
    ClipperLib.EndType.etClosedPolygon
  );

  const offsetOut = new ClipperLib.Paths();
  co.Execute(offsetOut, deltaMm * SCALE);

  // Union
  const c = new ClipperLib.Clipper();
  c.AddPaths(offsetOut, ClipperLib.PolyType.ptSubject, true);

  const solution = new ClipperLib.Paths();
  c.Execute(
    ClipperLib.ClipType.ctUnion,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero
  );

  return fromClipperPaths(solution);
}

// optional: worker-side cache
const cache = new Map(); // key -> polygons

self.onmessage = (e) => {
  const { key, paths, delta } = e.data;

  if (cache.has(key)) {
    self.postMessage({ key, polygons: cache.get(key) });
    return;
  }

  try {
    const polygons = offsetAndUnion(paths, delta);
    // keep cache bounded
    if (cache.size > 25) cache.clear();
    cache.set(key, polygons);

    self.postMessage({ key, polygons });
  } catch (err) {
    self.postMessage({ key, error: err?.message || String(err) });
  }
};
