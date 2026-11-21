// Zona a aplicar dentro de una orden de trabajo (para cuando NO va todo el lote).
//
// La marca quien administra (en el celular con el "modo edición" activado) dibujando
// sobre el contorno del lote o caminando el borde con el GPS. Se guarda en la orden
// como una lista de polígonos [[lng,lat],...] y viaja por la Sheet (columna "zona"),
// así que todos los celulares la ven. El mapa funciona SIN señal: los contornos de
// los lotes viajan con la app (js/lotesGeo.js) y el GPS no necesita internet.
// Solo se usa si config.js tiene lotesGeo: true.

import { APP_CONFIG } from "./config.js";
import { cargarGeoLotes, normalizar } from "./geoLotes.js";
import { dbGetAll, dbPut } from "./db.js";
import { toast } from "./ui.js";

// ---------------------------------------------------------------------------
// Modo edición: solo el celular de quien marca zonas. Se activa abriendo la app
// con ?editor=1 (se apaga con ?editor=0), o tocando 5 veces el título
// "Órdenes de Trabajo". Los contratistas no lo tienen y ven la zona de solo lectura.
// ---------------------------------------------------------------------------
const CLAVE_EDITOR = `appcampo_editor_zonas_${APP_CONFIG.empresaId}`;

(function activarEditorPorUrl() {
  try {
    const p = new URLSearchParams(location.search).get("editor");
    if (p === "1") localStorage.setItem(CLAVE_EDITOR, "1");
    else if (p === "0") localStorage.removeItem(CLAVE_EDITOR);
  } catch (_) {
    /* sin almacenamiento: queda en solo lectura */
  }
})();

function puedeEditarZonas() {
  if (APP_CONFIG.contratistaFijo) return false;
  try {
    return localStorage.getItem(CLAVE_EDITOR) === "1";
  } catch (_) {
    return false;
  }
}

function conectarGestoEditor(elemento, onCambio) {
  let toques = 0;
  let timer = null;
  elemento.addEventListener("click", () => {
    toques++;
    clearTimeout(timer);
    timer = setTimeout(() => (toques = 0), 1500);
    if (toques < 5) return;
    toques = 0;
    if (APP_CONFIG.contratistaFijo) return;
    try {
      if (puedeEditarZonas()) {
        localStorage.removeItem(CLAVE_EDITOR);
        toast("Modo edición de zonas: DESACTIVADO");
      } else {
        localStorage.setItem(CLAVE_EDITOR, "1");
        toast("Modo edición de zonas: ACTIVADO en este celular");
      }
    } catch (_) {
      toast("No se pudo cambiar el modo en este celular.");
    }
    if (onCambio) onCambio();
  });
}

// ---------------------------------------------------------------------------
// Datos de la zona
// ---------------------------------------------------------------------------
function parseZona(valor) {
  let v = valor;
  if (typeof v === "string") {
    if (!v.trim()) return [];
    try {
      v = JSON.parse(v);
    } catch (_) {
      return [];
    }
  }
  if (!Array.isArray(v)) return [];
  return v
    .filter((poli) => Array.isArray(poli) && poli.length >= 3)
    .map((poli) => poli.map((p) => [Number(p[0]), Number(p[1])]))
    .filter((poli) => poli.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])));
}

function proyeccion(lat0, lng0) {
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111320;
  const ky = 110540;
  return {
    aXY: (lng, lat) => [(lng - lng0) * kx, (lat - lat0) * ky],
    aLL: (x, y) => [lng0 + x / kx, lat0 + y / ky],
  };
}

function areaHa(zonas) {
  if (!zonas.length) return 0;
  const { aXY } = proyeccion(zonas[0][0][1], zonas[0][0][0]);
  let total = 0;
  for (const poli of zonas) {
    const xy = poli.map(([lng, lat]) => aXY(lng, lat));
    let s = 0;
    for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) s += xy[j][0] * xy[i][1] - xy[i][0] * xy[j][1];
    total += Math.abs(s) / 2;
  }
  return total / 10000;
}

function formatoHa(n) {
  return (Math.round(n * 10) / 10).toLocaleString("es-AR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

let cacheGeo = null;
async function geoLotes() {
  if (!cacheGeo) cacheGeo = (await cargarGeoLotes()) || [];
  return cacheGeo;
}

// Polígonos de los lotes de la orden (por nombre, igual que la detección por GPS).
async function featuresDeOrden(orden) {
  if (!APP_CONFIG.lotesGeo) return [];
  const feats = await geoLotes();
  const nombres = new Set((orden.lotes || []).map((l) => normalizar(l.loteNombre)));
  return feats.filter((f) => (f.lotes || []).some((n) => nombres.has(normalizar(n))));
}

// Geometría plana (metros) para el estado del GPS.
function puntoEnPoligono(x, y, poli) {
  let dentro = false;
  for (let i = 0, j = poli.length - 1; i < poli.length; j = i++) {
    const [xi, yi] = poli[i];
    const [xj, yj] = poli[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}

function distanciaABorde(x, y, poli) {
  let mejor = Infinity;
  for (let i = 0, j = poli.length - 1; i < poli.length; j = i++) {
    const ax = poli[j][0] - x;
    const ay = poli[j][1] - y;
    const dx = poli[i][0] - poli[j][0];
    const dy = poli[i][1] - poli[j][1];
    const l2 = dx * dx + dy * dy;
    let t = l2 === 0 ? 0 : -(ax * dx + ay * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    mejor = Math.min(mejor, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return mejor;
}

// ---------------------------------------------------------------------------
// Visor / editor de mapa a pantalla completa
// ---------------------------------------------------------------------------
let estilosInyectados = false;
function inyectarEstilos() {
  if (estilosInyectados) return;
  estilosInyectados = true;
  const s = document.createElement("style");
  s.textContent = `
    .zn-overlay{position:fixed;inset:0;z-index:1000;background:#fff;display:flex;flex-direction:column;}
    .zn-top{display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--color-primario,#2a422b);color:#fff;}
    .zn-top strong{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .zn-top button{width:auto;margin:0;padding:6px 12px;background:rgba(255,255,255,.2);color:#fff;border:0;}
    .zn-mapa{flex:1;position:relative;background:#f3f1e8;min-height:0;}
    .zn-mapa canvas{position:absolute;inset:0;width:100%;height:100%;touch-action:none;}
    .zn-estado{padding:8px 12px;font-size:.9rem;background:#fafafa;border-top:1px solid #ddd;}
    .zn-barra{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:8px 12px calc(8px + env(safe-area-inset-bottom));background:#fafafa;}
    .zn-barra button{margin:0;width:100%;padding:10px 6px;font-size:.9rem;}
    .zn-fila{margin-top:8px;padding:8px;border:1px dashed #c9a227;border-radius:8px;background:#fffbea;font-size:.9rem;}
    .zn-fila button{width:auto;margin:6px 6px 0 0;padding:6px 12px;font-size:.85rem;}
  `;
  document.head.appendChild(s);
}

function redondear([lng, lat]) {
  return [Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6];
}

async function abrirMapaZona(orden, opciones = {}) {
  const { editar = false, onGuardar } = opciones;
  const feats = await featuresDeOrden(orden);
  if (!feats.length) {
    toast("Esta orden no tiene cargado el mapa de sus lotes.");
    return;
  }
  inyectarEstilos();

  let zonas = parseZona(orden.zona).map((p) => p.map((q) => q.slice()));
  let actual = [];
  let hayCambios = false;
  let pos = null;
  let watchId = null;

  const [lng0, lat0] = feats[0].anillos[0][0];
  const { aXY, aLL } = proyeccion(lat0, lng0);
  const lotesXY = feats.map((f) => ({
    nombre: f.nombre,
    anillos: f.anillos.map((a) => a.map(([lng, lat]) => aXY(lng, lat))),
  }));

  const overlay = document.createElement("div");
  overlay.className = "zn-overlay";
  overlay.innerHTML = `
    <div class="zn-top"><strong></strong><button type="button" id="znSalir">✕ Cerrar</button></div>
    <div class="zn-mapa"><canvas></canvas></div>
    <div class="zn-estado" id="znEstado"></div>
    <div class="zn-barra">
      ${
        editar
          ? `<button type="button" id="znDeshacer" class="secondary">↶ Deshacer</button>
             <button type="button" id="znMira" class="secondary">➕ Punto en la mira</button>
             <button type="button" id="znGpsPunto" class="secondary">📍 Punto con mi ubicación</button>
             <button type="button" id="znCerrarZona" class="secondary">✔ Cerrar zona</button>
             <button type="button" id="znCentrar" class="secondary">🎯 Ir a mi ubicación</button>
             <button type="button" id="znBorrar" class="danger">🗑 Borrar todo</button>
             <button type="button" id="znGuardar" style="grid-column:1 / -1;">💾 Guardar zona</button>`
          : `<button type="button" id="znCentrar" class="secondary">🎯 Ir a mi ubicación</button>
             <button type="button" id="znAjustar" class="secondary">🔍 Ver todo el lote</button>`
      }
    </div>`;
  overlay.querySelector(".zn-top strong").textContent = `${orden.nombre}${editar ? " · marcar zona" : ""}`;
  const bodyOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  document.body.appendChild(overlay);

  const mapa = overlay.querySelector(".zn-mapa");
  const canvas = overlay.querySelector("canvas");
  const ctx = canvas.getContext("2d");
  const estado = overlay.querySelector("#znEstado");
  const v = { cx: 0, cy: 0, k: 1, kMin: 0.01, kMax: 8 };
  let W = 1;
  let H = 1;

  const aPant = (x, y) => [(x - v.cx) * v.k + W / 2, H / 2 - (y - v.cy) * v.k];
  const dePant = (sx, sy) => [(sx - W / 2) / v.k + v.cx, v.cy - (sy - H / 2) / v.k];

  function ajustar() {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const mira = ([x, y]) => {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    };
    lotesXY.forEach((l) => l.anillos.forEach((a) => a.forEach(mira)));
    v.cx = (minX + maxX) / 2;
    v.cy = (minY + maxY) / 2;
    v.k = Math.min(W / Math.max(maxX - minX, 1), H / Math.max(maxY - minY, 1)) * 0.9;
    v.kMin = v.k * 0.3;
    v.kMax = Math.max(v.k * 80, 3);
  }

  function dibujar() {
    ctx.clearRect(0, 0, W, H);
    // Contornos de los lotes de la orden
    ctx.lineJoin = "round";
    for (const l of lotesXY) {
      ctx.beginPath();
      for (const anillo of l.anillos) {
        anillo.forEach(([x, y], i) => {
          const [sx, sy] = aPant(x, y);
          if (i === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        });
        ctx.closePath();
      }
      ctx.fillStyle = "rgba(90,130,90,0.18)";
      ctx.fill("evenodd");
      ctx.strokeStyle = "#3b6b3b";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    // Zonas cerradas
    for (const poli of zonas) {
      ctx.beginPath();
      poli.forEach(([lng, lat], i) => {
        const [sx, sy] = aPant(...aXY(lng, lat));
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
      ctx.closePath();
      ctx.fillStyle = "rgba(220,60,40,0.38)";
      ctx.fill();
      ctx.strokeStyle = "#c0392b";
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
    // Zona en construcción
    if (actual.length) {
      ctx.beginPath();
      actual.forEach(([lng, lat], i) => {
        const [sx, sy] = aPant(...aXY(lng, lat));
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
      if (actual.length >= 3) {
        ctx.fillStyle = "rgba(230,150,30,0.25)";
        ctx.fill();
      }
      ctx.strokeStyle = "#e08a00";
      ctx.lineWidth = 2.5;
      ctx.setLineDash([8, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
      actual.forEach(([lng, lat], i) => {
        const [sx, sy] = aPant(...aXY(lng, lat));
        ctx.beginPath();
        ctx.arc(sx, sy, 6, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? "#fff" : "#e08a00";
        ctx.fill();
        ctx.strokeStyle = "#e08a00";
        ctx.lineWidth = 2;
        ctx.stroke();
      });
    }
    // Nombre de cada lote
    ctx.fillStyle = "#2f4f2f";
    ctx.font = "bold 13px sans-serif";
    ctx.textAlign = "center";
    for (const l of lotesXY) {
      const pts = l.anillos[0];
      const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      const [sx, sy] = aPant(cx, cy);
      if (sx > -50 && sx < W + 50 && sy > -20 && sy < H + 20) ctx.fillText(l.nombre, sx, sy);
    }
    // Mi ubicación
    if (pos) {
      const [x, y] = aXY(pos.lng, pos.lat);
      const [sx, sy] = aPant(x, y);
      const r = Math.max(8, (pos.precision || 0) * v.k);
      ctx.beginPath();
      ctx.arc(sx, sy, Math.min(r, 400), 0, Math.PI * 2);
      ctx.fillStyle = "rgba(30,110,230,0.15)";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(sx, sy, 8, 0, Math.PI * 2);
      ctx.fillStyle = "#1e6ee6";
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    // Mira central (solo al editar)
    if (editar) {
      ctx.strokeStyle = "rgba(0,0,0,0.65)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(W / 2 - 14, H / 2);
      ctx.lineTo(W / 2 + 14, H / 2);
      ctx.moveTo(W / 2, H / 2 - 14);
      ctx.lineTo(W / 2, H / 2 + 14);
      ctx.stroke();
    }
  }

  function textoGps() {
    if (!pos) return "Buscando tu ubicación…";
    const [x, y] = aXY(pos.lng, pos.lat);
    const polisZona = zonas.map((p) => p.map(([lng, lat]) => aXY(lng, lat)));
    if (polisZona.length) {
      if (polisZona.some((p) => puntoEnPoligono(x, y, p))) return "📍 Estás DENTRO de la zona a aplicar.";
      const d = Math.min(...polisZona.map((p) => distanciaABorde(x, y, p)));
      return `📍 Estás FUERA de la zona, a ${Math.round(d)} m.`;
    }
    const enLote = lotesXY.find((l) => l.anillos.some((a) => puntoEnPoligono(x, y, a)));
    return enLote ? `📍 Estás dentro del lote ${enLote.nombre}.` : "📍 Estás fuera de los lotes de esta orden.";
  }

  function actualizarEstado() {
    const ha = areaHa(zonas);
    const hasOrden = orden.has ? ` (orden: ${formatoHa(orden.has)} ha)` : "";
    let linea = zonas.length
      ? `Zona marcada: ${formatoHa(ha)} ha${hasOrden}${zonas.length > 1 ? ` · ${zonas.length} sectores` : ""}.`
      : editar
        ? "Tocá el mapa para ir marcando los puntos de la zona, o caminá el borde y usá “Punto con mi ubicación”."
        : "Esta orden no tiene zona marcada: va todo el lote.";
    if (editar && actual.length) linea += ` Dibujando: ${actual.length} punto${actual.length === 1 ? "" : "s"}${actual.length >= 3 ? " (podés cerrar la zona)" : ""}.`;
    estado.innerHTML = `${linea}<br/>${textoGps()}`;
  }

  function redibujar() {
    dibujar();
    actualizarEstado();
  }

  function medir() {
    const r = mapa.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    W = Math.max(r.width, 1);
    H = Math.max(r.height, 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function zoomEn(sx, sy, factor) {
    const [x, y] = dePant(sx, sy);
    v.k = Math.max(v.kMin, Math.min(v.kMax, v.k * factor));
    v.cx = x - (sx - W / 2) / v.k;
    v.cy = y + (sy - H / 2) / v.k;
  }

  // Gestos: arrastrar mueve el mapa, pellizcar hace zoom, tocar (sin arrastrar) agrega un punto.
  const punteros = new Map();
  let toque = null;
  const distancia = () => {
    const [a, b] = [...punteros.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    punteros.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (punteros.size === 1) toque = { x: e.offsetX, y: e.offsetY, movido: false, t: Date.now() };
    else if (toque) toque.movido = true;
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = punteros.get(e.pointerId);
    if (!p) return;
    const nx = e.offsetX;
    const ny = e.offsetY;
    if (punteros.size === 1) {
      if (toque && !toque.movido && Math.hypot(nx - toque.x, ny - toque.y) > 8) toque.movido = true;
      if (toque && toque.movido) {
        v.cx -= (nx - p.x) / v.k;
        v.cy += (ny - p.y) / v.k;
        redibujar();
      }
      p.x = nx;
      p.y = ny;
    } else if (punteros.size === 2) {
      const antes = distancia();
      p.x = nx;
      p.y = ny;
      const despues = distancia();
      const [a, b] = [...punteros.values()];
      if (antes > 0) zoomEn((a.x + b.x) / 2, (a.y + b.y) / 2, despues / antes);
      redibujar();
    }
  });
  const soltar = (e, esToque) => {
    if (!punteros.has(e.pointerId)) return;
    const eraUno = punteros.size === 1;
    punteros.delete(e.pointerId);
    if (eraUno && esToque && toque && !toque.movido && Date.now() - toque.t < 600 && editar) {
      agregarPunto(dePant(e.offsetX, e.offsetY));
    }
    if (punteros.size === 0) toque = null;
  };
  canvas.addEventListener("pointerup", (e) => soltar(e, true));
  canvas.addEventListener("pointercancel", (e) => soltar(e, false));
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      zoomEn(e.offsetX, e.offsetY, e.deltaY < 0 ? 1.25 : 0.8);
      redibujar();
    },
    { passive: false }
  );

  function agregarPunto([x, y]) {
    actual.push(redondear(aLL(x, y)));
    hayCambios = true;
    redibujar();
  }

  function cerrarZona() {
    if (actual.length < 3) {
      toast("Hacen falta al menos 3 puntos para cerrar una zona.");
      return false;
    }
    zonas.push(actual);
    actual = [];
    hayCambios = true;
    redibujar();
    return true;
  }

  function cerrarMapa() {
    if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
    resizeObs.disconnect();
    overlay.remove();
    document.body.style.overflow = bodyOverflow;
  }

  function irAMiUbicacion() {
    if (!pos) {
      toast("Todavía no hay ubicación. Revisá que el GPS esté activado y el permiso otorgado.");
      return;
    }
    const [x, y] = aXY(pos.lng, pos.lat);
    v.cx = x;
    v.cy = y;
    v.k = Math.max(v.k, Math.min(v.kMax, 1.5));
    redibujar();
  }

  overlay.querySelector("#znSalir").addEventListener("click", () => {
    if (editar && hayCambios && !confirm("Hay cambios sin guardar. ¿Salir igual?")) return;
    cerrarMapa();
  });
  overlay.querySelector("#znCentrar").addEventListener("click", irAMiUbicacion);
  const btnAjustar = overlay.querySelector("#znAjustar");
  if (btnAjustar)
    btnAjustar.addEventListener("click", () => {
      ajustar();
      redibujar();
    });

  if (editar) {
    overlay.querySelector("#znDeshacer").addEventListener("click", () => {
      if (actual.length) actual.pop();
      else if (zonas.length) {
        zonas.pop();
        toast("Se quitó la última zona.");
      }
      hayCambios = true;
      redibujar();
    });
    overlay.querySelector("#znMira").addEventListener("click", () => agregarPunto(dePant(W / 2, H / 2)));
    overlay.querySelector("#znGpsPunto").addEventListener("click", () => {
      if (!pos) {
        toast("Todavía no hay ubicación. Revisá que el GPS esté activado y el permiso otorgado.");
        return;
      }
      agregarPunto(aXY(pos.lng, pos.lat));
    });
    overlay.querySelector("#znCerrarZona").addEventListener("click", cerrarZona);
    overlay.querySelector("#znBorrar").addEventListener("click", () => {
      if (!zonas.length && !actual.length) return;
      if (!confirm("¿Borrar todo lo marcado en este mapa?")) return;
      zonas = [];
      actual = [];
      hayCambios = true;
      redibujar();
    });
    overlay.querySelector("#znGuardar").addEventListener("click", async () => {
      if (actual.length >= 3) cerrarZona();
      else if (actual.length > 0) {
        if (!confirm(`Hay ${actual.length} punto(s) sin cerrar (se necesitan 3 como mínimo). ¿Guardar sin ellos?`)) return;
        actual = [];
      }
      if (!zonas.length) {
        if (!parseZona(orden.zona).length) {
          toast("Todavía no marcaste ninguna zona.");
          return;
        }
        if (!confirm("Vas a quitar la zona de esta orden: se aplica todo el lote. ¿Seguro?")) return;
      }
      try {
        if (onGuardar) await onGuardar(zonas);
        cerrarMapa();
      } catch (err) {
        toast("No se pudo guardar: " + (err && err.message ? err.message : err), 4000);
      }
    });
  }

  const resizeObs = new ResizeObserver(() => {
    medir();
    redibujar();
  });
  resizeObs.observe(mapa);
  medir();
  ajustar();
  redibujar();

  if (navigator.geolocation) {
    watchId = navigator.geolocation.watchPosition(
      (p) => {
        pos = { lat: p.coords.latitude, lng: p.coords.longitude, precision: p.coords.accuracy };
        redibujar();
      },
      () => {
        // Sin permiso o sin GPS: el mapa y el dibujo funcionan igual.
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 }
    );
  }
}

// ---------------------------------------------------------------------------
// Bloque dentro de una orden (lista de Órdenes y Fitosanitarios)
// ---------------------------------------------------------------------------
async function guardarZonaLocal(orden, zonas) {
  const todas = await dbGetAll("ordenesTrabajo");
  const rec = todas.find((x) => x.id === orden.id);
  if (!rec) throw new Error("No se encontró la orden en este celular.");
  rec.zona = zonas;
  // "sincronizado" NO se toca: eso reenviaría la orden entera como fila nueva.
  // La zona se sube aparte (accion guardarZonaOrden) con esta marca.
  rec.zonaPendiente = true;
  await dbPut("ordenesTrabajo", rec);
  orden.zona = zonas;
  orden.zonaPendiente = true;
  window.dispatchEvent(new Event("appcampo-sync-now"));
}

// Completa el contenedor con el resumen de la zona y los botones. Si la orden no
// tiene zona ni se puede marcar, lo deja vacío ("queda como siempre").
async function montarZonaEnOrden(contenedor, orden, { editable = false, onCambio } = {}) {
  contenedor.innerHTML = "";
  contenedor.classList.add("hidden");
  if (!APP_CONFIG.lotesGeo) return;
  const zonas = parseZona(orden.zona);
  const feats = await featuresDeOrden(orden);
  const puedeEditar = editable && puedeEditarZonas() && feats.length > 0;
  if (!zonas.length && !puedeEditar) return;
  inyectarEstilos();
  contenedor.classList.remove("hidden");
  contenedor.classList.add("zn-fila");
  const hasOrden = orden.has ? ` de ${formatoHa(orden.has)} ha de la orden` : "";
  contenedor.innerHTML = `
    <div>${
      zonas.length
        ? `🗺️ <strong>Zona a aplicar:</strong> ${formatoHa(areaHa(zonas))} ha${hasOrden}${orden.zonaPendiente ? ' <span class="muted">(se sube cuando haya señal)</span>' : ""}`
        : '🗺️ <span class="muted">Sin zona marcada: va todo el lote.</span>'
    }</div>
    ${zonas.length && feats.length ? '<button type="button" class="secondary" data-zn="ver">Ver mapa</button>' : ""}
    ${puedeEditar ? `<button type="button" class="secondary" data-zn="editar">${zonas.length ? "✏️ Editar zona" : "✏️ Marcar zona"}</button>` : ""}
  `;
  contenedor.querySelector('[data-zn="ver"]')?.addEventListener("click", () => abrirMapaZona(orden, { editar: false }));
  contenedor.querySelector('[data-zn="editar"]')?.addEventListener("click", () =>
    abrirMapaZona(orden, {
      editar: true,
      onGuardar: async (nuevas) => {
        await guardarZonaLocal(orden, nuevas);
        toast("Zona guardada. Se sube a la planilla cuando haya señal.");
        if (onCambio) {
          onCambio();
          // Con señal la subida termina enseguida: se redibuja una vez más para
          // sacar el cartel de "se sube cuando haya señal" — solo si la persona
          // sigue en la misma pantalla (para no pisar otra).
          const hash = location.hash;
          if (navigator.onLine) setTimeout(() => location.hash === hash && onCambio(), 2500);
        }
      },
    })
  );
}

export { puedeEditarZonas, conectarGestoEditor, parseZona, areaHa, abrirMapaZona, montarZonaEnOrden };
