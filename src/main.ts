import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, type CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { createDefaultRegistry } from './formats/adapters';
import type { LoadedModel, LoadedView } from './formats/registry';
import type { CellInfo, DrawioPageStats } from './formats/drawio/build3d';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $<HTMLDivElement>('stage');
const fileInput = $<HTMLInputElement>('file');
const pageSelect = $<HTMLSelectElement>('page');
const gapInput = $<HTMLInputElement>('gap');
const labelsInput = $<HTMLInputElement>('labels');
const statsEl = $<HTMLSpanElement>('stats');
const errorEl = $<HTMLDivElement>('error');
const panel = $<HTMLElement>('panel');
const panelBody = $<HTMLDivElement>('panel-body');

const registry = createDefaultRegistry();
fileInput.accept = registry.accept();

// --- Escena -----------------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
stage.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.className = 'label-layer';
stage.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xeef1f5);
scene.add(new THREE.HemisphereLight(0xffffff, 0xc9d2e0, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(8, 20, 12);
scene.add(sun);

const grid = new THREE.GridHelper(200, 200, 0xc5ccd8, 0xdde2ea);
grid.position.y = -0.01;
scene.add(grid);

// Perspectiva para la vista 3D; ortográfica para la planta (sin paralaje, como en draw.io).
const persp = new THREE.PerspectiveCamera(45, 1, 0.05, 2000);
persp.position.set(0, 18, 22);
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 5000);
let orthoHalfHeight = 10;
let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = persp;

function makeControls(cam: THREE.Camera) {
  const c = new OrbitControls(cam, renderer.domElement);
  c.enableDamping = true;
  c.screenSpacePanning = true;
  return c;
}
let controls = makeControls(camera);

function useCamera(cam: THREE.PerspectiveCamera | THREE.OrthographicCamera) {
  if (camera === cam) return;
  const target = controls.target.clone();
  controls.dispose();
  camera = cam;
  controls = makeControls(cam);
  controls.target.copy(target);
}

function updateOrthoFrustum() {
  const aspect = stage.clientWidth / Math.max(stage.clientHeight, 1);
  ortho.top = orthoHalfHeight;
  ortho.bottom = -orthoHalfHeight;
  ortho.left = -orthoHalfHeight * aspect;
  ortho.right = orthoHalfHeight * aspect;
  ortho.updateProjectionMatrix();
}

const content = new THREE.Group();
scene.add(content);
const selectionBox = new THREE.Box3Helper(new THREE.Box3(), 0x2f6fde);
selectionBox.visible = false;
scene.add(selectionBox);

// --- Estado -----------------------------------------------------------------------------------
let model: LoadedModel | null = null;
let viewIndex = 0;
const buildOptions = () => ({ levelGap: Number(gapInput.value), labels: labelsInput.checked });

function disposeObject(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose?.();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    // Las texturas de iconos se cachean entre reconstrucciones: no se liberan aquí.
    mats.forEach((mat) => mat.dispose());
  });
}

/** Saca un objeto de la escena; los CSS2DObject anidados no limpian su <div> solos. */
function detach(obj: THREE.Object3D) {
  obj.removeFromParent();
  obj.traverse((o) => {
    const el = (o as Partial<CSS2DObject>).element;
    if (el instanceof HTMLElement) el.remove();
  });
}

function disposeViews(views: LoadedView[]) {
  for (const v of views) {
    detach(v.object);
    disposeObject(v.object);
  }
}

function showView(i: number, refit = true) {
  if (!model) return;
  viewIndex = Math.max(0, Math.min(i, model.views.length - 1));
  for (const child of [...content.children]) detach(child);
  const view = model.views[viewIndex];
  if (model.kind === 'model' && !view.object.userData.normalized) {
    normalizeModel(view.object);
    view.object.userData.normalized = true;
  }
  content.add(view.object);
  selectionBox.visible = false;
  panel.hidden = true;
  updateLineResolution();
  updateStats();
  if (refit) fitView('3d');
}

/** Modelos 3D arbitrarios: centrar, apoyar en el piso y escalar a ~20 unidades. */
function normalizeModel(obj: THREE.Object3D) {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const k = 20 / Math.max(size.x, size.y, size.z, 1e-6);
  obj.scale.multiplyScalar(k);
  obj.updateMatrixWorld(true);
  box.setFromObject(obj);
  const c = box.getCenter(new THREE.Vector3());
  obj.position.sub(new THREE.Vector3(c.x, box.min.y, c.z));
}

function fitView(mode: '3d' | 'top') {
  const box = new THREE.Box3().setFromObject(content);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  if (mode === 'top') {
    useCamera(ortho);
    const aspect = stage.clientWidth / Math.max(stage.clientHeight, 1);
    orthoHalfHeight = Math.max(size.z / 2, size.x / 2 / aspect) * 1.05;
    ortho.zoom = 1;
    updateOrthoFrustum();
    ortho.position.set(center.x, box.max.y + 100, center.z + 0.0001);
    ortho.near = 0.1;
    ortho.far = box.max.y - box.min.y + 200;
    ortho.updateProjectionMatrix();
  } else {
    useCamera(persp);
    const tanV = Math.tan(THREE.MathUtils.degToRad(persp.fov / 2));
    const dist = (box.getBoundingSphere(new THREE.Sphere()).radius / tanV) * (persp.aspect < 1 ? 1.4 : 0.9);
    persp.position.copy(center).addScaledVector(new THREE.Vector3(0, 0.85, 0.75).normalize(), dist);
    persp.near = dist / 200;
    persp.far = dist * 20;
    persp.updateProjectionMatrix();
  }
  controls.target.copy(center);
  controls.update();
}

function updateStats() {
  if (!model) return (statsEl.textContent = '');
  const view = model.views[viewIndex];
  const s = view.object.userData.stats as DrawioPageStats | undefined;
  if (s) {
    statsEl.textContent = `${s.vertices} nodos · ${s.edges} conexiones · ${s.containers} contenedores · ${s.images} iconos · profundidad ${s.maxDepth}`;
  } else {
    let meshes = 0;
    let tris = 0;
    view.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        meshes++;
        const g = m.geometry;
        tris += (g.index ? g.index.count : g.attributes.position?.count ?? 0) / 3;
      }
    });
    statsEl.textContent = `${meshes} mallas · ${Math.round(tris).toLocaleString('es')} triángulos`;
  }
}

function updateLineResolution() {
  const size = renderer.getSize(new THREE.Vector2());
  content.traverse((o) => {
    const mat = (o as THREE.Mesh).material as LineMaterial | undefined;
    if (mat && (mat as LineMaterial).isLineMaterial) mat.resolution.set(size.x, size.y);
  });
}

// --- Carga ------------------------------------------------------------------------------------
async function loadFile(file: File) {
  errorEl.hidden = true;
  try {
    const loaded = await registry.load(file, buildOptions());
    if (model) disposeViews(model.views);
    model = loaded;
    pageSelect.innerHTML = '';
    loaded.views.forEach((v, i) => pageSelect.add(new Option(v.name, String(i))));
    pageSelect.disabled = loaded.views.length < 2;
    $('diagram-controls').style.display = loaded.kind === 'diagram' ? '' : 'none';
    document.title = `${file.name} · Visor Arq 3D`;
    showView(0);
  } catch (e) {
    console.error(e);
    errorEl.textContent = e instanceof Error ? e.message : String(e);
    errorEl.hidden = false;
  }
}

async function loadUrl(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo cargar ${url}: ${res.status}`);
  const name = decodeURIComponent(url.split('/').pop() ?? 'archivo');
  await loadFile(new File([await res.blob()], name));
}

function rebuild() {
  if (!model?.rebuild) return;
  disposeViews(model.views);
  model.views = model.rebuild(buildOptions());
  showView(viewIndex, false);
}

fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) loadFile(f);
  fileInput.value = '';
});
pageSelect.addEventListener('change', () => showView(Number(pageSelect.value)));
let gapTimer = 0;
gapInput.addEventListener('input', () => {
  clearTimeout(gapTimer);
  gapTimer = window.setTimeout(rebuild, 60);
});
labelsInput.addEventListener('change', () => labelRenderer.domElement.classList.toggle('hidden', !labelsInput.checked));
$('view-3d').addEventListener('click', () => fitView('3d'));
$('view-top').addEventListener('click', () => fitView('top'));
$('fit').addEventListener('click', () => fitView('3d'));
$('panel-close').addEventListener('click', () => {
  panel.hidden = true;
  selectionBox.visible = false;
});

// Arrastrar y soltar
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) document.body.classList.remove('dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const f = e.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});

// --- Selección --------------------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downAt: { x: number; y: number } | null = null;
renderer.domElement.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }));
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return;
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  raycaster.params.Line = { threshold: 0.05 };
  const hits = raycaster.intersectObjects(content.children, true);
  // Preferir lo más específico: iconos y bloques antes que contenedores.
  const rank = (c: CellInfo) => (c.kind === 'container' ? 1 : 0);
  const candidates = hits
    .map((h) => ({ h, cell: findCell(h.object) }))
    .filter((x): x is { h: THREE.Intersection; cell: { obj: THREE.Object3D; info: CellInfo } } => !!x.cell);
  candidates.sort((a, b) => rank(a.cell.info) - rank(b.cell.info) || a.h.distance - b.h.distance);
  const best = candidates[0];
  if (!best) {
    panel.hidden = true;
    selectionBox.visible = false;
    return;
  }
  select(best.cell.obj, best.cell.info);
});

function findCell(o: THREE.Object3D | null): { obj: THREE.Object3D; info: CellInfo } | null {
  while (o) {
    if (o.userData.cell) return { obj: o, info: o.userData.cell as CellInfo };
    o = o.parent;
  }
  return null;
}

const KIND: Record<CellInfo['kind'], string> = {
  container: 'Contenedor',
  image: 'Icono / servicio',
  block: 'Bloque',
  text: 'Texto',
  edge: 'Conexión',
};

function labelOf(id?: string): string {
  if (!id) return '—';
  let found: string | undefined;
  content.traverse((o) => {
    const c = o.userData.cell as CellInfo | undefined;
    if (!found && c?.id === id) found = c.label;
  });
  return found ? `${found.replace(/\n/g, ' ')} (${id})` : id;
}

function select(obj: THREE.Object3D, info: CellInfo) {
  (selectionBox.box as THREE.Box3).setFromObject(obj);
  selectionBox.visible = info.kind !== 'edge';
  const rows: [string, string][] = [
    ['id', info.id],
    ['nivel', String(info.depth)],
  ];
  if (info.container) rows.push(['contenedor', labelOf(info.container)]);
  if (info.kind === 'edge') {
    rows.push(['origen', labelOf(info.source)], ['destino', labelOf(info.target)]);
  }
  for (const [k, v] of Object.entries(info.attributes)) rows.push([k, v]);
  for (const [k, v] of Object.entries(info.style)) rows.push([`style.${k}`, v]);
  panelBody.replaceChildren();
  const h = document.createElement('h3');
  h.textContent = info.label || '(sin texto)';
  const kind = document.createElement('div');
  kind.className = 'kind';
  kind.textContent = KIND[info.kind];
  const table = document.createElement('table');
  for (const [k, v] of rows) {
    const tr = table.insertRow();
    tr.insertCell().textContent = k;
    tr.insertCell().textContent = v;
  }
  panelBody.append(h, kind, table);
  panel.hidden = false;
}

// --- Bucle ------------------------------------------------------------------------------------
function resize() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
  persp.aspect = w / Math.max(h, 1);
  persp.updateProjectionMatrix();
  updateOrthoFrustum();
  updateLineResolution();
}
new ResizeObserver(resize).observe(stage);
resize();

const root = document.documentElement;
let lastScale = -1;
renderer.setAnimationLoop(() => {
  controls.update();
  // Las etiquetas HTML no escalan con la cámara: --label-scale = píxeles de pantalla por píxel de
  // draw.io en el punto de mira (1 unidad = 100 px), así el texto conserva la proporción del diagrama.
  const pxPerUnit =
    camera === ortho
      ? (stage.clientHeight * ortho.zoom) / (ortho.top - ortho.bottom)
      : stage.clientHeight / (2 * persp.position.distanceTo(controls.target) * Math.tan(THREE.MathUtils.degToRad(persp.fov / 2)));
  const scale = THREE.MathUtils.clamp(pxPerUnit / 100, 0.05, 3);
  if (Math.abs(scale - lastScale) > 0.01) {
    lastScale = scale;
    root.style.setProperty('--label-scale', scale.toFixed(3));
    labelRenderer.domElement.classList.toggle('tiny', scale < 0.38);
  }
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
});

// API para pruebas automatizadas / consola.
Object.assign(window, {
  __visor: {
    scene,
    content,
    registry,
    loadFile,
    loadUrl,
    showView,
    get model() {
      return model;
    },
  },
});

loadUrl(`${import.meta.env.BASE_URL}samples/ejemplo-arquitectura.drawio`).catch((e) => console.warn(e));
