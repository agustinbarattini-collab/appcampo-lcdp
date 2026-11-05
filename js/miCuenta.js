import { dbGetAll } from "./db.js";
import { getCuentaContratistas } from "./stockUtils.js";
import { formatearFechaCorta } from "./ui.js";
import { APP_CONFIG } from "./config.js";

// Solo para la app de un contratista (contratistaFijo en config.js): le
// muestra lo que retiró (y devolvió), cuánto usó en las aplicaciones que
// cargó y cuánto le queda pendiente, más la base de insumos para consultar.
// Es de solo lectura: los retiros los registra el asesor en Insumos → Salida.
const NOMBRE_FIJO = String(APP_CONFIG.contratistaFijo || "").trim().toLowerCase();

const miCuentaView = {
  async render(container) {
    const [contratistas, insumos, movs, cuenta] = await Promise.all([
      dbGetAll("contratistas"),
      dbGetAll("insumos"),
      dbGetAll("movimientosInsumos"),
      getCuentaContratistas(),
    ]);
    const yo = contratistas.find((c) => c.nombre.trim().toLowerCase() === NOMBRE_FIJO);

    if (!yo) {
      container.innerHTML = `
        <h2>Mis insumos</h2>
        <div class="card empty-state">
          Todavía no se descargaron los datos.<br/>
          Abrí la app con conexión a internet y esperá a que diga "Todo sincronizado".
        </div>`;
      return;
    }

    const miCuenta = cuenta
      .filter((c) => c.contratistaId === yo.id && (c.retirado > 0 || c.usado > 0 || c.devuelto > 0))
      .sort((a, b) => a.insumoNombre.localeCompare(b.insumoNombre));
    const misMovs = movs
      .filter((m) => m.contratistaId === yo.id && (m.tipo === "salida" || m.tipo === "devolucion"))
      .sort((a, b) => (b.fecha || "").localeCompare(a.fecha || "") || (b.fechaCreacionRegistro || "").localeCompare(a.fechaCreacionRegistro || ""));

    container.innerHTML = `
      <h2>Mis insumos</h2>
      <div class="card" id="cuentaCard"></div>
      <div class="card" id="movsCard"></div>
      <div class="card" id="baseCard"></div>
    `;

    container.querySelector("#cuentaCard").innerHTML =
      `<h2 style="margin-top:0;">Mi cuenta</h2>` +
      (miCuenta.length
        ? `<div style="overflow-x:auto;">
            <table class="tabla-orden">
              <thead><tr><th>Insumo</th><th>Retiré</th><th>Usé</th><th>Devolví</th><th>Pendiente</th></tr></thead>
              <tbody>
                ${miCuenta
                  .map(
                    (c) => `
                  <tr>
                    <td>${c.insumoNombre}</td>
                    <td>${c.retirado} ${c.unidad || ""}</td>
                    <td>${c.usado} ${c.unidad || ""}</td>
                    <td>${c.devuelto} ${c.unidad || ""}</td>
                    <td><strong>${c.pendiente} ${c.unidad || ""}</strong></td>
                  </tr>`
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
          <div class="muted" style="margin-top:6px;">"Usé" sale de las aplicaciones que cargás en Fitosanitarios.</div>`
        : '<div class="empty-state">Todavía no tenés insumos retirados registrados.</div>');

    container.querySelector("#movsCard").innerHTML =
      `<h2 style="margin-top:0;">Insumos retirados y devueltos</h2>` +
      (misMovs.length
        ? misMovs
            .map(
              (m) => `
        <div class="list-item">
          <div>
            <div><strong>${m.insumoNombre}</strong></div>
            <div class="muted">${formatearFechaCorta(m.fecha)}${m.galponNombre ? " · " + m.galponNombre : ""}${m.observaciones ? " · " + m.observaciones : ""}</div>
          </div>
          <div><span class="pill ${m.tipo === "salida" ? "pendiente" : "sincronizado"}">${m.tipo === "salida" ? "Retiro" : "Devolución"}</span> <strong>${m.cantidad}</strong> ${m.unidad || ""}</div>
        </div>`
            )
            .join("")
        : '<div class="empty-state">Sin movimientos todavía.</div>');

    // Base de insumos (consulta), con buscador. Colapsada para no ocupar lugar.
    const ordenados = insumos.slice().sort((a, b) => a.nombre.localeCompare(b.nombre));
    const baseCard = container.querySelector("#baseCard");
    baseCard.innerHTML = `
      <details>
        <summary><strong>Base de insumos (${ordenados.length})</strong></summary>
        <div style="padding-top:8px;">
          <input type="search" id="buscarInsumo" placeholder="Buscar insumo..." />
          <div id="listaBase"></div>
        </div>
      </details>`;
    const lista = baseCard.querySelector("#listaBase");
    const pintar = (q) => {
      const filtro = q.trim().toLowerCase();
      const items = ordenados.filter((i) => !filtro || i.nombre.toLowerCase().includes(filtro));
      lista.innerHTML = items.length
        ? items.map((i) => `<div class="list-item"><div>${i.nombre}</div><div class="muted">${i.unidad || ""}</div></div>`).join("")
        : '<div class="empty-state">No hay insumos que coincidan.</div>';
    };
    pintar("");
    baseCard.querySelector("#buscarInsumo").addEventListener("input", (e) => pintar(e.target.value));
  },
};

export { miCuentaView };
