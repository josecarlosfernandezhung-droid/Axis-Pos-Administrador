"use strict";
const $ = (id) => document.getElementById(id);
const enApp = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const guardar = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const leer = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
const borrar = (k) => { try { localStorage.removeItem(k); } catch {} };

let base = ""; // vacío = mismo servidor (PC / navegador); en el teléfono es http://IP:3000
let token = "";
let tab = "resumen";
let dias = 30;

const num = (n, d = 2) => Number(n || 0).toLocaleString("es", { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

class SesionVencida extends Error {}

async function api(ruta, opciones = {}) {
  const cab = { "Content-Type": "application/json" };
  if (token) cab.Authorization = "Bearer " + token;
  let r;
  try {
    r = await fetch(base + ruta, { ...opciones, headers: cab });
  } catch {
    throw new Error("No se pudo conectar con el servidor. Revisa que la PC esté encendida y en la misma red WiFi.");
  }
  const datos = await r.json().catch(() => ({}));
  if (r.status === 401 && token) throw new SesionVencida(datos.error);
  if (!r.ok) throw new Error(datos.error || "Error " + r.status);
  return datos;
}

function normalizarServidor(s) {
  s = s.trim().replace(/\/+$/, "");
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  if (!/:\d+$/.test(s)) s += ":3000";
  return s;
}

function mostrarLogin(mensaje) {
  token = "";
  borrar("token");
  $("app").hidden = true;
  $("login").hidden = false;
  $("error").hidden = !mensaje;
  $("error").textContent = mensaje || "";
}

function mostrarApp() {
  $("login").hidden = true;
  $("app").hidden = false;
  cargar();
}

$("form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("error").hidden = true;
  if (enApp) {
    base = normalizarServidor($("servidor").value);
    if (!base) {
      $("error").textContent = "Escribe la dirección de la PC, por ejemplo http://192.168.1.10:3000";
      $("error").hidden = false;
      return;
    }
  }
  $("entrar").disabled = true;
  $("entrar").textContent = "Conectando…";
  try {
    const r = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        usuario: $("usuario").value,
        clave: $("clave").value,
        host: $("host").value,
        puerto: $("puerto").value,
        base: $("base").value,
      }),
    });
    token = r.token;
    guardar("token", token);
    if (enApp) guardar("servidor", base);
    guardar("usuario", $("usuario").value);
    $("clave").value = "";
    mostrarApp();
  } catch (err) {
    $("error").textContent = err.message;
    $("error").hidden = false;
  } finally {
    $("entrar").disabled = false;
    $("entrar").textContent = "Entrar";
  }
});

$("salir").addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST" }); } catch {}
  mostrarLogin();
});

$("tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  tab = b.dataset.tab;
  document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("activa", x === b));
  cargar();
});

async function cargar() {
  const cont = $("contenido");
  $("titulo").textContent = { resumen: "Resumen", productos: "Productos", existencias: "Existencias", caja: "Caja" }[tab];
  try {
    if (tab === "resumen") await vistaResumen(cont);
    else if (tab === "productos") await vistaBuscador(cont, "productos");
    else if (tab === "existencias") await vistaExistencias(cont);
    else await vistaCaja(cont);
  } catch (err) {
    if (err instanceof SesionVencida) return mostrarLogin(err.message);
    cont.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

async function vistaResumen(cont) {
  cont.innerHTML = '<p class="vacio">Cargando…</p>';
  const d = await api("/api/resumen?dias=" + dias);
  const max = Math.max(1, ...d.porDia.map((x) => x.total));
  cont.innerHTML = `
    <div class="rangos">${[7, 30, 90].map((n) => `<button data-d="${n}" class="${n === dias ? "activa" : ""}">${n} días</button>`).join("")}</div>
    <div class="kpis">
      <div class="kpi"><span>Ventas</span><b>${num(d.total)}</b></div>
      <div class="kpi"><span>Tickets</span><b>${num(d.tickets, 0)}</b></div>
      <div class="kpi"><span>Unidades</span><b>${num(d.unidades, 0)}</b></div>
    </div>
    <div class="card"><h2>Ventas por día</h2>
      ${d.porDia.length ? `<div class="barras">${d.porDia.map((x) => `<div title="${x.dia}: ${num(x.total)}" style="height:${Math.max(3, (x.total / max) * 100)}%"></div>`).join("")}</div>` : '<p class="vacio">Sin ventas en este período</p>'}
    </div>
    <div class="card"><h2>Más vendidos</h2>
      ${d.top.length ? d.top.map((x) => `<div class="fila"><div>${esc(x.nombre)}<small>${num(x.unidades, 0)} uds.</small></div><div class="der">${num(x.total)}</div></div>`).join("") : '<p class="vacio">Sin datos</p>'}
    </div>`;
  cont.querySelector(".rangos").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-d]");
    if (b) { dias = Number(b.dataset.d); cargar(); }
  });
}

function buscador(cont, ph, alBuscar) {
  const i = document.createElement("input");
  i.type = "search";
  i.placeholder = ph;
  let t;
  i.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => alBuscar(i.value), 300); });
  cont.prepend(i);
  return i;
}

async function vistaBuscador(cont, que) {
  cont.innerHTML = '<div id="lista" class="card"><p class="vacio">Cargando…</p></div>';
  const lista = $("lista");
  const buscar = async (q) => {
    try {
      const d = await api("/api/productos?q=" + encodeURIComponent(q));
      lista.innerHTML = d.filas.length
        ? d.filas.map((p) => `<div class="fila"><div>${esc(p.nombre)}<small>${esc(p.codigo)}${p.grupo ? " · " + esc(p.grupo) : ""}</small></div>
            <div class="der">${num(p.precio)}<small class="${p.existencia < 0 ? "neg" : ""}">${num(p.existencia, 0)} en stock</small></div></div>`).join("")
        : '<p class="vacio">No se encontró nada</p>';
    } catch (err) {
      if (err instanceof SesionVencida) return mostrarLogin(err.message);
      lista.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    }
  };
  buscador(cont, "Buscar por nombre o código", buscar);
  buscar("");
}

async function vistaExistencias(cont) {
  cont.innerHTML = '<div id="lista" class="card"><p class="vacio">Cargando…</p></div>';
  const lista = $("lista");
  let almacen = "";
  let texto = "";
  let sel;
  const buscar = async () => {
    try {
      const d = await api(`/api/existencias?q=${encodeURIComponent(texto)}&almacen=${almacen}`);
      if (!sel) {
        sel = document.createElement("select");
        sel.innerHTML = '<option value="">Todos los almacenes</option>' +
          d.almacenes.map((a) => `<option value="${a.id}">${esc(a.nombre)} — ${num(a.unidades, 0)} uds. · ${num(a.valor)}</option>`).join("");
        sel.addEventListener("change", () => { almacen = sel.value; buscar(); });
        cont.prepend(sel);
      }
      lista.innerHTML = d.filas.length
        ? d.filas.map((p) => `<div class="fila"><div>${esc(p.nombre)}<small>${esc(p.almacen)}</small></div><div class="der ${p.cantidad < 0 ? "neg" : ""}">${num(p.cantidad, 0)}</div></div>`).join("")
        : '<p class="vacio">Sin existencias para este filtro</p>';
    } catch (err) {
      if (err instanceof SesionVencida) return mostrarLogin(err.message);
      lista.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    }
  };
  await buscar();
  buscador(cont, "Buscar producto", (q) => { texto = q; buscar(); });
}

async function vistaCaja(cont) {
  cont.innerHTML = '<p class="vacio">Cargando…</p>';
  const d = await api("/api/caja");
  cont.innerHTML = '<div class="card">' + (d.filas.length ? d.filas.map((s) => `
    <div class="fila"><div>${esc(s.usuario || "—")} · ${esc(s.almacen || "")}<small>${esc(s.apertura)} → ${esc(s.cierre || "abierto")}</small></div>
    <div class="der">${num(s.final)}<small class="${s.diferencia ? "neg" : ""}">dif. ${num(s.diferencia)}</small></div></div>`).join("") : '<p class="vacio">Sin turnos</p>') + "</div>";
}

// Arranque
(async function () {
  $("usuario").value = leer("usuario");
  if (enApp) {
    $("fila-servidor").hidden = false;
    $("servidor").value = leer("servidor");
    base = leer("servidor");
  } else {
    try {
      const { ips } = await api("/api/info");
      if (ips.length) {
        $("ayuda-ip").hidden = false;
        $("ayuda-ip").textContent = "Desde el teléfono, en «Servidor» escribe: " + ips.map((ip) => `http://${ip}:${location.port || 3000}`).join("  o  ");
      }
    } catch {}
  }
  token = leer("token");
  if (token && (base || !enApp)) mostrarApp();
})();
