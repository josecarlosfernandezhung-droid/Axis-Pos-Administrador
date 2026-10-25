"use strict";
const $ = (id) => document.getElementById(id);
const enApp = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const guardar = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const leer = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
const borrar = (k) => { try { localStorage.removeItem(k); } catch {} };

const S = { base: "", token: "", ses: null, tab: "", sub: {}, rango: {}, avisos: {} };
let vista = 0; // evita que una respuesta lenta pise a una pantalla más nueva
let refrescar = null; // función que se repite cada 30 s en las pantallas "en vivo"

const num = (n, d = 0) => Number(n || 0).toLocaleString("es", { minimumFractionDigits: d, maximumFractionDigits: d });
const dinero = (n) => num(Math.round(Number(n || 0)));
const corto = (n) => {
  const a = Math.abs(n || 0);
  if (a >= 1e6) return num(n / 1e6, a >= 1e7 ? 1 : 2) + " M";
  if (a >= 1e4) return num(Math.round(n / 1e3)) + " mil";
  return dinero(n);
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const fechaCorta = (t) => {
  if (!t) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}:\d{2}))?/.exec(t);
  return m ? `${+m[3]} ${MESES[+m[2] - 1]}${m[4] ? " " + m[4] : ""}` : t;
};
const ROLES = { admin: "Administrador", gerente: "Gerente", cajero: "Cajero" };

class SesionVencida extends Error {}

async function api(ruta, opciones = {}) {
  const cab = { "Content-Type": "application/json" };
  if (S.token) cab.Authorization = "Bearer " + S.token;
  let r;
  try {
    r = await fetch(S.base + ruta, { ...opciones, headers: cab });
  } catch {
    throw new Error("No se pudo conectar con el servidor. Revisa que la PC esté encendida y en la misma red WiFi.");
  }
  const datos = await r.json().catch(() => ({}));
  if (r.status === 401 && S.token) throw new SesionVencida(datos.error);
  if (!r.ok) throw new Error(datos.error || "Error " + r.status);
  return datos;
}
const post = (ruta, cuerpo) => api(ruta, { method: "POST", body: JSON.stringify(cuerpo || {}) });

function aviso(texto) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = texto;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

/* ───────────────────────── Entrada ───────────────────────── */
function normalizarServidor(s) {
  s = s.trim().replace(/\/+$/, "");
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  if (!/:\d+$/.test(s)) s += ":3000";
  return s;
}

function mostrarLogin(mensaje) {
  S.token = ""; S.ses = null;
  borrar("token");
  clearInterval(mostrarLogin.t);
  refrescar = null;
  $("app").hidden = true;
  $("login").hidden = false;
  if (mensaje) mostrarError("pin", mensaje);
  cargarEstado();
}

function mostrarError(donde, texto) {
  const e = $("error-" + donde);
  e.textContent = texto || "";
  e.hidden = !texto;
}

async function cargarEstado() {
  if (enApp) {
    S.base = normalizarServidor($("servidor").value);
    if (!S.base) return;
  }
  try {
    const est = await api("/api/estado");
    const hayPin = est.usuarios.length > 0;
    $("form-pin").hidden = !hayPin;
    $("usuario-pin").innerHTML = est.usuarios.map((u) => `<option value="${u.id}">${esc(u.nombre)}</option>`).join("");
    const ultimo = leer("usuarioPin");
    if (ultimo && est.usuarios.some((u) => String(u.id) === ultimo)) $("usuario-pin").value = ultimo;
    $("det-db").open = !hayPin;
    $("login-sub").textContent = hayPin ? "Entra con tu PIN" : est.configurado
      ? "Todavía no hay PIN. Entra con MariaDB y créalos en Ajustes."
      : "Primera vez: conecta con la base de datos de AxisPOS";
    $("ayuda-ip").hidden = enApp || !est.ips.length;
    $("ayuda-ip").textContent = "Desde el teléfono, en «Servidor» escribe: " + est.ips.map((ip) => `http://${ip}:${location.port || 3000}`).join("  o  ");
  } catch (e) {
    mostrarError(enApp ? "pin" : "db", e.message);
    $("form-pin").hidden = true;
    $("det-db").open = true;
  }
}

async function entrar(datos) {
  S.token = datos.token;
  S.ses = datos;
  guardar("token", datos.token);
  if (enApp) guardar("servidor", S.base);
  mostrarApp();
}

$("servidor").addEventListener("change", cargarEstado);

$("form-pin").addEventListener("submit", async (e) => {
  e.preventDefault();
  mostrarError("pin", "");
  if (enApp) {
    S.base = normalizarServidor($("servidor").value);
    if (!S.base) return mostrarError("pin", "Escribe la dirección de la PC, por ejemplo http://192.168.1.10:3000");
  }
  $("entrar-pin").disabled = true;
  try {
    const r = await post("/api/entrar", { usuario: $("usuario-pin").value, pin: $("pin").value });
    guardar("usuarioPin", $("usuario-pin").value);
    $("pin").value = "";
    await entrar(r);
  } catch (err) {
    $("pin").value = "";
    mostrarError("pin", err.message);
  } finally {
    $("entrar-pin").disabled = false;
  }
});

$("form-db").addEventListener("submit", async (e) => {
  e.preventDefault();
  mostrarError("db", "");
  if (enApp) {
    S.base = normalizarServidor($("servidor").value);
    if (!S.base) return mostrarError("db", "Escribe la dirección de la PC, por ejemplo http://192.168.1.10:3000");
  }
  $("entrar-db").disabled = true;
  $("entrar-db").textContent = "Conectando…";
  try {
    const r = await post("/api/login", {
      usuario: $("usuario").value, clave: $("clave").value, host: $("host").value, puerto: $("puerto").value, base: $("base").value,
    });
    $("clave").value = "";
    if (r.sinPines) S.tab = "ajustes";
    await entrar(r);
  } catch (err) {
    mostrarError("db", err.message);
  } finally {
    $("entrar-db").disabled = false;
    $("entrar-db").textContent = "Conectar y entrar";
  }
});

async function salir() {
  try { await post("/api/logout"); } catch {}
  mostrarLogin();
}
$("salir").addEventListener("click", salir);
$("salir-m").addEventListener("click", salir);

/* ───────────────────────── Estructura de la app ───────────────────────── */
const ICONOS = {
  resumen: '<path d="M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z"/>',
  productos: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
  inventario: '<path d="M8 3h8v6H8zM3 15h8v6H3zM13 15h8v6h-8zM12 9v3M7 15v-3h10v3"/>',
  caja: '<path d="M3 9l9-5 9 5M5 9v9M9.5 9v9M14.5 9v9M19 9v9M3 20h18"/>',
  control: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4"/>',
  ajustes: '<path d="M16 11a4 4 0 10-8 0 4 4 0 008 0zM4 21c0-4 3.6-6 8-6s8 2 8 6"/>',
};
const TABS = [
  { id: "resumen", t: "Resumen", perm: "resumen" },
  { id: "productos", t: "Productos", perm: "productos" },
  { id: "inventario", t: "Inventario", perm: "existencias" },
  { id: "caja", t: "Caja", perm: "caja" },
  { id: "control", t: "Control", perm: "auditoria" },
  { id: "ajustes", t: "Usuarios y PIN", perm: "ajustes" },
];
const SUBS = {
  inventario: [["existencias", "Existencias", "existencias"], ["alertas", "Alertas de stock", "inventario"], ["abc", "Análisis ABC", "inventario"], ["compras", "Compras sugeridas", "inventario"]],
  caja: [["turnos", "Turnos", "caja"], ["cierres", "Auditoría de cierres", "auditoria"]],
  control: [["anomalias", "Alertas de caja", "auditoria"], ["mermas", "Mermas", "auditoria"]],
};
const tiene = (p) => S.ses && S.ses.permisos.includes(p);

function mostrarApp() {
  $("login").hidden = true;
  $("app").hidden = false;
  $("rol-txt").textContent = ROLES[S.ses.rol] || "";
  $("quien").textContent = S.ses.nombre;
  const visibles = TABS.filter((t) => tiene(t.perm));
  if (!visibles.some((t) => t.id === S.tab)) S.tab = visibles[0] ? visibles[0].id : "";
  $("menu").innerHTML = visibles.map((t) => `<button data-tab="${t.id}" class="${t.id === S.tab ? "activa" : ""}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONOS[t.id]}</svg>
      <span>${t.t}</span><b class="insignia" id="ins-${t.id}" hidden></b></button>`).join("");
  clearInterval(mostrarLogin.t);
  mostrarLogin.t = setInterval(() => {
    if (document.hidden || !S.ses) return;
    if (refrescar) refrescar();
    cargarAvisos();
  }, 30000);
  cargarAvisos();
  cargar();
}

$("menu").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  S.tab = b.dataset.tab;
  document.querySelectorAll("#menu button").forEach((x) => x.classList.toggle("activa", x === b));
  cargar();
});

async function cargarAvisos() {
  if (!S.ses || !(tiene("auditoria") || tiene("inventario"))) return;
  try {
    const a = await api("/api/avisos");
    const poner = (id, n) => {
      const el = $("ins-" + id);
      if (!el) return;
      el.hidden = !n;
      el.textContent = n > 99 ? "99+" : n;
    };
    S.avisos = a;
    poner("inventario", a.stock);
    poner("control", a.anomalias);
    document.querySelectorAll(".seg-ins").forEach((x) => {
      const n = x.dataset.k === "alertas" ? a.stock : x.dataset.k === "anomalias" ? a.anomalias : 0;
      x.hidden = !n; x.textContent = n;
    });
  } catch (e) {
    if (e instanceof SesionVencida) mostrarLogin(e.message);
  }
}

function ponerRangos(opciones, actual, alCambiar) {
  const r = $("rangos");
  if (!opciones) { r.hidden = true; r.innerHTML = ""; return; }
  r.hidden = false;
  r.innerHTML = opciones.map(([v, t]) => `<button data-v="${v}" class="${String(v) === String(actual) ? "activa" : ""}">${t}</button>`).join("");
  r.onclick = (e) => {
    const b = e.target.closest("button[data-v]");
    if (b) alCambiar(b.dataset.v);
  };
}

function segmentos(tab) {
  const lista = (SUBS[tab] || []).filter((s) => tiene(s[2]));
  if (!lista.length) return { html: "", actual: null };
  let actual = S.sub[tab];
  if (!lista.some((s) => s[0] === actual)) actual = lista[0][0];
  S.sub[tab] = actual;
  const html = lista.length > 1
    ? `<div class="segmentos" id="segmentos">${lista.map((s) => `<button data-seg="${s[0]}" class="${s[0] === actual ? "activa" : ""}">${s[1]} <b class="insignia seg-ins" data-k="${s[0]}" hidden></b></button>`).join("")}</div>`
    : "";
  return { html, actual };
}

async function cargar() {
  const mi = ++vista;
  refrescar = null;
  const cont = $("contenido");
  const { html: seg, actual } = segmentos(S.tab);
  ponerRangos(null);
  $("contexto").textContent = "";
  cont.innerHTML = seg + '<div class="cargando"></div><div class="cargando"></div>';
  if (seg) {
    $("segmentos").onclick = (e) => {
      const b = e.target.closest("button[data-seg]");
      if (!b) return;
      S.sub[S.tab] = b.dataset.seg;
      cargar();
    };
    if (S.avisos) cargarAvisos();
  }
  const cuerpo = document.createElement("div");
  cuerpo.className = "cuerpo";
  cuerpo.style.cssText = "display:flex;flex-direction:column;gap:14px";
  try {
    const f = { resumen: vResumen, productos: vProductos, inventario: vInventario, caja: vCaja, control: vControl, ajustes: vAjustes }[S.tab];
    if (!f) return;
    await f(cuerpo, actual, () => mi === vista);
    if (mi !== vista) return;
    cont.innerHTML = seg;
    if (seg) {
      $("segmentos").onclick = (e) => {
        const b = e.target.closest("button[data-seg]");
        if (!b) return;
        S.sub[S.tab] = b.dataset.seg;
        cargar();
      };
    }
    cont.appendChild(cuerpo);
    if (S.avisos && seg) cargarAvisos();
  } catch (err) {
    if (mi !== vista) return;
    if (err instanceof SesionVencida) return mostrarLogin(err.message);
    cont.innerHTML = seg + `<p class="error">${esc(err.message)}</p>`;
  }
}

/* ───────────────────────── Piezas de dibujo ───────────────────────── */
const tituloVista = (t, s) => `<h1 class="titulo">${t}</h1>${s ? `<p class="sub">${s}</p>` : ""}`;
const tarjeta = (t, cuerpo, extra = "") => `<section class="card ${extra}">${t ? `<h2>${t}</h2>` : ""}${cuerpo}</section>`;
const kpi = (et, valor, pie = "", clase = "") => `<div class="kpi ${clase}"><span>${et}</span><b>${valor}</b>${pie ? `<small>${pie}</small>` : ""}</div>`;
function pildoraDelta(act, ant, vs) {
  if (!(ant > 0)) return `<span class="pildora neutro">Sin datos de ${vs} para comparar</span>`;
  const p = ((act - ant) / ant) * 100;
  const cls = p >= 0 ? "bueno" : "malo";
  return `<span class="pildora ${cls}">${p >= 0 ? "+" : ""}${num(p, 1)}% frente a ${vs}</span>`;
}
const deltaTxt = (a, b) => {
  if (!(b > 0)) return "—";
  const p = ((a - b) / b) * 100;
  return `<span class="${p >= 0 ? "buen" : "neg"}">${p >= 0 ? "+" : ""}${num(p, 1)}%</span>`;
};
const lista = (filas, vacio) => (filas.length ? filas.join("") : `<p class="vacio">${vacio}</p>`);
function buscador(ph, alBuscar) {
  const i = document.createElement("input");
  i.type = "search";
  i.placeholder = ph;
  let t;
  i.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => alBuscar(i.value), 300); });
  return i;
}
function selector(opciones, actual, alCambiar, etiqueta) {
  const l = document.createElement("label");
  l.innerHTML = `${etiqueta}<select>${opciones.map(([v, t]) => `<option value="${v}" ${String(v) === String(actual) ? "selected" : ""}>${t}</option>`).join("")}</select>`;
  l.querySelector("select").addEventListener("change", (e) => alCambiar(e.target.value));
  return l;
}

/* ───────────────────────── Resumen (dashboard) ───────────────────────── */
const ETQ_PERIODO = { hoy: "Ventas de hoy", semana: "Ventas de los últimos 7 días", mes: "Ventas del mes" };
const VS_PERIODO = { hoy: "ayer a esta hora", semana: "la semana anterior", mes: "el mes anterior" };

function listaDias(ini, fin) {
  const out = [];
  let t = Date.UTC(+ini.slice(0, 4), +ini.slice(5, 7) - 1, +ini.slice(8, 10));
  const f = Date.UTC(+fin.slice(0, 4), +fin.slice(5, 7) - 1, +fin.slice(8, 10));
  for (; t <= f; t += 864e5) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

async function vResumen(cont, _s, vigente) {
  const p = S.rango.resumen || "hoy";
  const dibujar = async () => {
    const d = await api("/api/resumen?p=" + p);
    if (!vigente()) return;
    const a = d.actual, b = d.anterior;
    const prom = a.tickets ? a.total / a.tickets : 0, promAnt = b.tickets ? b.total / b.tickets : 0;
    $("contexto").textContent = `${fechaCorta(d.ini)} – ${fechaCorta(d.fin)} · se actualiza solo cada 30 s`;

    // Ritmo del día (ventas por hora)
    const horas = new Map(d.porHora.map((x) => [x.h, x]));
    const hs = d.porHora.map((x) => x.h);
    const h0 = Math.min(8, ...(hs.length ? hs : [8])), h1 = Math.max(18, ...(hs.length ? hs : [18]));
    const rango = []; for (let h = h0; h <= h1; h++) rango.push(h);
    const maxH = Math.max(1, ...d.porHora.map((x) => x.total));
    const pico = d.porHora.reduce((m, x) => (x.tickets > (m ? m.tickets : 0) ? x : m), null);
    const ritmo = `<div class="barras">${rango.map((h) => {
      const x = horas.get(h);
      return `<div class="b ${pico && pico.h === h ? "pico" : ""}" title="${h}:00 — ${dinero(x ? x.total : 0)} · ${x ? x.tickets : 0} tickets"><i style="height:${x ? Math.max(3, (x.total / maxH) * 100) : 0}%"></i></div>`;
    }).join("")}</div><div class="etiquetas">${rango.map((h) => `<span>${h}</span>`).join("")}</div>`;

    // Día por día contra el período anterior
    let porDia = "";
    if (p !== "hoy") {
      const dias = listaDias(d.ini, d.fin), diasAnt = listaDias(d.iniAnt, d.finAnt);
      const mA = new Map(d.porDia.map((x) => [x.dia, x.total])), mB = new Map(d.porDiaAnt.map((x) => [x.dia, x.total]));
      const maxD = Math.max(1, ...d.porDia.map((x) => x.total), ...d.porDiaAnt.map((x) => x.total));
      porDia = tarjeta("Ventas por día", `<div class="barras">${dias.map((dia, i) => {
        const va = mA.get(dia) || 0, vb = mB.get(diasAnt[i]) || 0;
        return `<div class="b par" title="${fechaCorta(dia)}: ${dinero(va)} (antes: ${dinero(vb)})"><i class="ant" style="height:${vb ? Math.max(3, (vb / maxD) * 100) : 0}%"></i><i style="height:${va ? Math.max(3, (va / maxD) * 100) : 0}%"></i></div>`;
      }).join("")}</div><div class="etiquetas">${dias.map((dia, i) => `<span>${dias.length > 16 ? (i % 3 === 0 ? +dia.slice(8) : "") : +dia.slice(8)}</span>`).join("")}</div>
      <div class="leyenda"><span><i></i>Este período</span><span><i class="ant"></i>Período anterior</span></div>`);
    }

    const maxTop = Math.max(1, ...d.top.map((x) => x.total));
    const maxCaj = Math.max(1, ...d.cajeros.map((x) => x.total));
    const verCosto = a.utilidad != null;

    cont.innerHTML = `
      ${tituloVista("Cómo va la tienda", "Ventas terminadas registradas en AxisPOS, en CUP.")}
      <section class="card hero">
        <div class="etq">${ETQ_PERIODO[p]}</div>
        <div class="grande">${num(a.total, 0)} <small>CUP</small></div>
        ${pildoraDelta(a.total, b.total, VS_PERIODO[p])}
        <div class="mini">
          <div><span>Tickets</span><b>${num(a.tickets)}</b></div>
          <div><span>Ticket promedio</span><b>${corto(prom)}</b></div>
          <div><span>Unidades</span><b>${num(a.unidades)}</b></div>
          <div><span>Devoluciones</span><b>${corto(d.devoluciones.monto)}</b><small>${d.devoluciones.n} docs.</small></div>
          ${verCosto ? `<div><span>Utilidad estimada</span><b>${corto(a.utilidad)}</b><small>${a.total ? num((a.utilidad / a.total) * 100, 1) : 0}% de las ventas</small></div>` : ""}
        </div>
      </section>
      <div class="kpis">
        ${kpi("Hoy", corto(d.chips.hoy.total), `${d.chips.hoy.tickets} tickets`)}
        ${kpi("Últimos 7 días", corto(d.chips.semana.total), `${d.chips.semana.tickets} tickets`)}
        ${kpi("Mes en curso", corto(d.chips.mes.total), `${d.chips.mes.tickets} tickets`)}
      </div>
      ${tarjeta(p === "hoy" ? "Ventas por hora" : "Horas pico", ritmo + `<p class="nota" style="margin-top:8px">${pico ? `Hora pico: ${pico.h}:00 (${pico.tickets} tickets)` : "Sin ventas en este período"}</p>`)}
      ${porDia}
      ${tarjeta(`Comparativo <small>contra ${VS_PERIODO[p]}</small>`, `<table class="comp"><tr><th></th><th>Ahora</th><th>Antes</th><th>Cambio</th></tr>
        <tr><td>Ventas</td><td>${dinero(a.total)}</td><td>${dinero(b.total)}</td><td>${deltaTxt(a.total, b.total)}</td></tr>
        <tr><td>Tickets</td><td>${num(a.tickets)}</td><td>${num(b.tickets)}</td><td>${deltaTxt(a.tickets, b.tickets)}</td></tr>
        <tr><td>Ticket promedio</td><td>${dinero(prom)}</td><td>${dinero(promAnt)}</td><td>${deltaTxt(prom, promAnt)}</td></tr>
        <tr><td>Unidades</td><td>${num(a.unidades)}</td><td>${num(b.unidades)}</td><td>${deltaTxt(a.unidades, b.unidades)}</td></tr>
        ${verCosto ? `<tr><td>Utilidad estimada</td><td>${dinero(a.utilidad)}</td><td>${dinero(b.utilidad)}</td><td>${deltaTxt(a.utilidad, b.utilidad)}</td></tr>` : ""}</table>`)}
      <div class="dos">
        ${tarjeta("Más vendidos (Top 10)", lista(d.top.map((x, i) => `<div class="fila"><div>${i + 1}. ${esc(x.nombre)}<small>${num(x.unidades)} uds.</small>
            <div class="barra-fina"><i style="width:${(x.total / maxTop) * 100}%"></i></div></div><div class="der">${dinero(x.total)}</div></div>`), "Sin ventas en este período"))}
        ${tarjeta(S.ses.rol === "cajero" ? "Mi rendimiento" : "Rendimiento por cajero", lista(d.cajeros.map((x) => `<div class="fila"><div><b>${esc(x.nombre)}</b>
            <small>${num(x.tickets)} tickets · promedio ${dinero(x.tickets ? x.total / x.tickets : 0)}</small>
            <div class="barra-fina"><i style="width:${(x.total / maxCaj) * 100}%"></i></div></div><div class="der"><b>${dinero(x.total)}</b></div></div>`), "Sin ventas en este período"))}
      </div>`;
  };
  ponerRangos([["hoy", "Hoy"], ["semana", "Semana"], ["mes", "Mes"]], p, (v) => { S.rango.resumen = v; cargar(); });
  await dibujar();
  refrescar = async () => { try { await dibujar(); } catch (e) { if (e instanceof SesionVencida) mostrarLogin(e.message); } };
}

/* ───────────────────────── Productos ───────────────────────── */
async function vProductos(cont) {
  cont.innerHTML = tituloVista("Productos", "Precio y existencia total en almacenes activos.");
  const lista_ = document.createElement("section");
  lista_.className = "card";
  const caja = document.createElement("div");
  const buscar = async (q) => {
    try {
      const d = await api("/api/productos?q=" + encodeURIComponent(q));
      caja.innerHTML = lista(d.filas.map((p) => `<div class="fila"><div>${esc(p.nombre)}<small>${esc(p.codigo)}${p.grupo ? " · " + esc(p.grupo) : ""}${p.costo != null ? " · costo " + dinero(p.costo) : ""}</small></div>
        <div class="der"><b>${dinero(p.precio)}</b><small class="${p.existencia <= 0 ? "neg" : ""}">${num(p.existencia)} en stock</small></div></div>`), "No se encontró nada");
    } catch (e) { if (e instanceof SesionVencida) mostrarLogin(e.message); else caja.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
  };
  lista_.append(buscador("Nombre, código o código de barras", buscar), caja);
  caja.style.marginTop = "8px";
  cont.appendChild(lista_);
  await buscar("");
}

/* ───────────────────────── Inventario ───────────────────────── */
async function vInventario(cont, sub, vigente) {
  if (sub === "existencias") return vExistencias(cont);
  if (sub === "alertas") return vAlertas(cont);
  if (sub === "abc") return vAbc(cont);
  return vCompras(cont);
}

async function vExistencias(cont) {
  cont.innerHTML = tituloVista("Existencias", "Solo almacenes activos. Los archivados no cuentan.");
  const caja = document.createElement("section");
  caja.className = "card";
  const filtros = document.createElement("div");
  filtros.className = "filtros";
  const cuerpo = document.createElement("div");
  caja.append(filtros, cuerpo);
  cont.appendChild(caja);
  let almacen = "", texto = "", sel = null;
  const buscar = async () => {
    const d = await api(`/api/existencias?q=${encodeURIComponent(texto)}&almacen=${almacen}`);
    if (!sel) {
      sel = selector([["", "Todos los almacenes"], ...d.almacenes.map((a) => [a.id, `${a.nombre} — ${num(a.unidades)} uds.${a.valor != null ? " · " + corto(a.valor) : ""}`])], "", (v) => { almacen = v; buscar(); }, "Almacén");
      filtros.append(sel, buscador("Buscar producto", (q) => { texto = q; buscar(); }));
      filtros.lastChild.style.alignSelf = "end";
    }
    cuerpo.innerHTML = lista(d.filas.map((p) => `<div class="fila"><div>${esc(p.nombre)}<small>${esc(p.almacen)}</small></div><div class="der ${p.cantidad < 0 ? "neg" : ""}">${num(p.cantidad)}</div></div>`), "Sin existencias para este filtro");
  };
  await buscar();
}

const ESTADO_STOCK = { agotado: "Agotado", minimo: "Bajo el mínimo", reorden: "Punto de reorden" };

async function vAlertas(cont) {
  const plazo = S.rango.plazo || "7";
  const d = await api("/api/alertas?plazo=" + plazo + "&dias=30");
  cont.innerHTML = tituloVista("Alertas de stock", "Productos agotados, bajo el mínimo de AxisPOS o que llegaron al punto de reorden.");
  const sel = selector([["3", "3 días"], ["7", "7 días"], ["15", "15 días"], ["30", "30 días"]], plazo, (v) => { S.rango.plazo = v; cargar(); }, "Plazo de entrega del proveedor");
  const kp = document.createElement("div");
  kp.className = "kpis";
  kp.innerHTML = kpi("Agotados", d.resumen.agotado, "", d.resumen.agotado ? "alerta" : "") + kpi("Bajo el mínimo", d.resumen.minimo) + kpi("En punto de reorden", d.resumen.reorden);
  cont.append(kp, sel);
  cont.insertAdjacentHTML("beforeend", tarjeta("Productos por reponer", lista(d.filas.map((f) => `<div class="fila"><div>${esc(f.nombre)}<small>${esc(f.grupo || "Sin grupo")} · vende ${num(f.ventaDiaria, 1)}/día${f.minimo ? " · mínimo " + num(f.minimo) : ""} · reorden en ${num(f.reorden)}</small></div>
      <div class="der"><span class="etq-e ${f.estado}">${ESTADO_STOCK[f.estado]}</span><small>${num(f.existencia)} en stock${f.cobertura != null ? " · alcanza " + num(f.cobertura) + " d" : ""}</small></div></div>`), "Todo en orden: no hay productos por reponer."))
    + `<p class="nota">Punto de reorden = venta diaria (últimos 30 días) × (plazo + 3 días de seguridad). El mínimo sale del campo «cantidad mínima» de cada producto en AxisPOS.</p>`);
}

async function vAbc(cont) {
  const dias = S.rango.abc || "90";
  const clase = S.rango.claseAbc || "A";
  const d = await api("/api/abc?dias=" + dias);
  cont.innerHTML = tituloVista("Análisis ABC", `Según el importe vendido en ${dias} días: A = 80% de las ventas, B = siguiente 15%, C = el resto y lo que no se vende.`);
  const R = d.resumen;
  cont.insertAdjacentHTML("beforeend", `<div class="kpis">
    ${kpi("Clase A · alta rotación", num(R.A.n) + " prod.", `${R.A.pctVentas}% de las ventas${R.A.valorStock ? " · stock " + corto(R.A.valorStock) : ""}`)}
    ${kpi("Clase B · media", num(R.B.n) + " prod.", `${R.B.pctVentas}% de las ventas${R.B.valorStock ? " · stock " + corto(R.B.valorStock) : ""}`)}
    ${kpi("Clase C · baja o nula", num(R.C.n) + " prod.", `${R.C.sinVentas} sin ventas${R.C.valorStock ? " · capital parado " + corto(R.C.valorStock) : ""}`, R.C.sinVentas ? "alerta" : "")}
  </div>`);
  cont.appendChild(selector([["30", "30 días"], ["90", "90 días"], ["180", "180 días"], ["365", "1 año"]], dias, (v) => { S.rango.abc = v; cargar(); }, "Período analizado"));
  const seg = document.createElement("div");
  seg.className = "segmentos";
  seg.innerHTML = ["A", "B", "C"].map((c) => `<button data-c="${c}" class="${c === clase ? "activa" : ""}">Clase ${c}</button>`).join("");
  seg.onclick = (e) => { const b = e.target.closest("button[data-c]"); if (b) { S.rango.claseAbc = b.dataset.c; cargar(); } };
  cont.appendChild(seg);
  cont.insertAdjacentHTML("beforeend", tarjeta(`Clase ${clase} <small>mostrando hasta 120</small>`, lista(d.filas[clase].map((f) => `<div class="fila"><div>${esc(f.nombre)}
      <small>${f.sinVentas ? "Sin ventas en el período" : `${num(f.vendido)} vendidos · ${f.pct}% del total · acumulado ${f.acumulado}%`}${f.merma ? " · merma " + num(f.merma) : ""}</small></div>
      <div class="der"><b>${f.sinVentas ? "—" : dinero(f.importe)}</b><small>${num(f.existencia)} en stock</small></div></div>`), "No hay productos en esta clase")));
}

async function vCompras(cont) {
  const plazo = S.rango.plazo || "7", cobertura = S.rango.cobertura || "30";
  const d = await api(`/api/compras?plazo=${plazo}&cobertura=${cobertura}`);
  cont.innerHTML = tituloVista("Compras sugeridas", "Cuánto pedir según lo que se vendió en los últimos 30 días.");
  cont.insertAdjacentHTML("beforeend", `<div class="kpis">${kpi("Productos a pedir", num(d.resumen.productos))}${kpi("Unidades", num(d.resumen.unidades))}${kpi("Costo estimado", d.resumen.total ? corto(d.resumen.total) : "—", d.resumen.total ? "con el costo cargado en AxisPOS" : "sin costos cargados en AxisPOS")}</div>`);
  const f = document.createElement("div");
  f.className = "filtros";
  f.append(
    selector([["3", "3 días"], ["7", "7 días"], ["15", "15 días"], ["30", "30 días"]], plazo, (v) => { S.rango.plazo = v; cargar(); }, "Plazo de entrega"),
    selector([["15", "15 días"], ["30", "30 días"], ["45", "45 días"], ["60", "60 días"]], cobertura, (v) => { S.rango.cobertura = v; cargar(); }, "Cubrir ventas de")
  );
  cont.appendChild(f);
  cont.insertAdjacentHTML("beforeend", tarjeta("Orden de compra sugerida", `<div style="margin-bottom:6px"><button class="btn claro chico" id="copiar">Copiar lista</button></div>` + lista(d.filas.map((x) => `<div class="fila"><div>${esc(x.nombre)}<small>Stock ${num(x.existencia)} · vende ${num(x.ventaDiaria, 1)}/día${x.cobertura != null ? " · alcanza " + num(x.cobertura) + " d" : ""}</small></div>
      <div class="der"><b>Pedir ${num(x.pedir)}</b><small>${x.costo ? dinero(x.total) : "sin costo"}</small></div></div>`), "No hace falta comprar nada por ahora.")));
  const btn = $("copiar");
  if (btn) btn.onclick = async () => {
    const txt = "Pedido sugerido\n" + d.filas.map((x) => `${x.pedir} x ${x.nombre}`).join("\n");
    try { await navigator.clipboard.writeText(txt); aviso("Lista copiada"); } catch { aviso("No se pudo copiar"); }
  };
}

/* ───────────────────────── Caja ───────────────────────── */
async function vCaja(cont, sub) {
  if (sub === "cierres") return vCierres(cont);
  const d = await api("/api/caja");
  cont.innerHTML = tituloVista("Turnos de caja", S.ses.rol === "cajero" ? "Tus últimos turnos." : "Últimos 40 turnos.");
  cont.insertAdjacentHTML("beforeend", tarjeta("", lista(d.filas.map((s) => `<div class="fila"><div>${esc(s.usuario || "—")} · ${esc(s.almacen || "")}<small>${fechaCorta(s.apertura)} → ${s.cierre ? fechaCorta(s.cierre) : "abierto"}</small></div>
      <div class="der"><b>${dinero(s.final)}</b><small class="${s.diferencia ? "neg" : ""}">diferencia ${num(s.diferencia, 2)}</small></div></div>`), "Sin turnos")));
}

async function vCierres(cont) {
  const dias = S.rango.cierres || "30";
  ponerRangos([["7", "7 días"], ["30", "30 días"], ["90", "90 días"]], dias, (v) => { S.rango.cierres = v; cargar(); });
  const d = await api("/api/cierres?dias=" + dias);
  cont.innerHTML = tituloVista("Auditoría de cierres", "Cada turno: lo vendido contra lo cobrado (efectivo, transferencia y tarjeta) y la diferencia del cierre.");
  cont.insertAdjacentHTML("beforeend", `<div class="kpis">${kpi("Turnos revisados", num(d.resumen.turnos))}${kpi("Con alertas", num(d.resumen.alertas), "", d.resumen.alertas ? "alerta" : "")}${kpi("Vendido", corto(d.resumen.ventas))}${kpi("Cobrado", corto(d.resumen.pagos))}</div>`);
  cont.insertAdjacentHTML("beforeend", tarjeta("Turnos", lista(d.filas.map((t) => `<details class="turno"><summary>
      <div><b>${esc(t.usuario || "—")}</b><small class="sub">${fechaCorta(t.apertura)} → ${t.abierto ? "abierto" : fechaCorta(t.cierre)} · ${t.tickets} tickets</small></div>
      <div class="der"><span class="etq-e ${t.severidad === "ok" ? "ok" : t.severidad}">${t.severidad === "ok" ? "Cuadra" : t.severidad === "alta" ? "Revisar" : "Atención"}</span><small>${dinero(t.ventas)}</small></div></summary>
      <div class="rejilla">
        <div><span>Ventas registradas</span><b>${dinero(t.ventas)}</b></div>
        <div><span>Efectivo</span><b>${dinero(t.pagos.efectivo)}</b></div>
        <div><span>Transferencia</span><b>${dinero(t.pagos.transferencia)}</b></div>
        <div><span>Tarjeta</span><b>${dinero(t.pagos.tarjeta)}</b></div>
        ${t.pagos.otros ? `<div><span>Otros cobros</span><b>${dinero(t.pagos.otros)}</b></div>` : ""}
        <div><span>Devoluciones</span><b>${dinero(t.devoluciones)}</b></div>
        <div><span>Ventas − cobros</span><b class="${Math.abs(t.descuadre) > 1 ? "neg" : ""}">${num(t.descuadre, 2)}</b></div>
        <div><span>Esperado en caja</span><b>${dinero(t.esperado)}</b></div>
        <div><span>Contado al cerrar</span><b>${t.abierto ? "—" : dinero(t.final)}</b></div>
        <div><span>Diferencia reportada</span><b class="${t.diferencia ? "neg" : ""}">${t.diferencia == null ? "—" : num(t.diferencia, 2)}</b></div>
      </div>${t.avisos.length ? `<p class="nota">${t.avisos.map(esc).join(" · ")}</p>` : ""}</details>`), "No hay turnos en este período")) +
    `<p class="nota">Diferencia positiva = faltante en caja; negativa = sobrante. «Esperado» = inicial + ventas − devoluciones − retiros.</p>`);
}

/* ───────────────────────── Control: anomalías y mermas ───────────────────────── */
async function vControl(cont, sub, vigente) {
  return sub === "mermas" ? vMermas(cont) : vAnomalias(cont, sub, vigente);
}

const ETQ_TIPO = {
  anulacion: "Anulaciones", cancelacion: "Cancelaciones", eliminacion: "Líneas borradas", cajon: "Cajón", devolucion: "Devoluciones",
};

async function vAnomalias(cont, _s, vigente) {
  const dias = S.rango.anomalias || "7";
  ponerRangos([["1", "Hoy"], ["7", "7 días"], ["30", "30 días"]], dias, (v) => { S.rango.anomalias = v; cargar(); });
  const dibujar = async () => {
    const d = await api("/api/anomalias?dias=" + dias);
    if (vigente && !vigente()) return;
    $("contexto").textContent = `Se compara a cada persona con su propio historial de 60 días · se actualiza cada 30 s`;
    cont.innerHTML = `${tituloVista("Alertas de caja", "Acciones sospechosas: anulaciones, cancelaciones, devoluciones, descuentos, cajón y cierres con diferencia.")}
      <div class="kpis">${kpi("Alertas altas", d.resumen.alta, "", d.resumen.alta ? "alerta" : "")}${kpi("Alertas medias", d.resumen.media)}${kpi("Ticket promedio", dinero(d.ticketPromedio), "base para «monto elevado»")}</div>
      ${tarjeta("Por persona (en el período)", d.usuarios.length ? `<table class="comp"><tr><th>Persona</th><th>Tickets</th><th>Anul.</th><th>Cancel.</th><th>Borradas</th><th>Devol.</th><th>Cajón</th></tr>
        ${d.usuarios.map((u) => `<tr><td>${esc(u.nombre)}</td><td>${num(u.tickets)}</td><td>${u.anulacion}</td><td>${u.cancelacion}</td><td>${u.eliminacion}</td><td>${u.devolucion}</td><td>${u.cajon}</td></tr>`).join("")}</table>` : '<p class="vacio">Sin actividad</p>')}
      ${tarjeta("Alertas", lista(d.alertas.map((a) => `<div class="aviso-fila"><span class="punto ${a.severidad}"></span><div><b>${esc(a.titulo)}</b>
        <small>${esc(a.usuario)} · ${fechaCorta(a.fecha)}</small><small>${esc(a.detalle)}</small></div></div>`), "Sin alertas en este período. Todo normal."))}`;
  };
  await dibujar();
  refrescar = async () => { try { await dibujar(); } catch (e) { if (e instanceof SesionVencida) mostrarLogin(e.message); } };
}

async function vMermas(cont) {
  const dias = S.rango.mermas || "90";
  ponerRangos([["30", "30 días"], ["90", "90 días"], ["180", "180 días"]], dias, (v) => { S.rango.mermas = v; cargar(); });
  const d = await api("/api/mermas?dias=" + dias);
  const maxC = Math.max(1, ...d.categorias.map((c) => (d.impacto.sinCostos ? c.venta : c.costo)));
  cont.innerHTML = `${tituloVista("Mermas", "Productos dados de baja (Merma y Baja de AxisPOS) y cuánto le quitan a la ganancia.")}
    <div class="kpis">${kpi("Valor a precio de venta", dinero(d.totales.venta), `${num(d.totales.unidades, 0)} uds. en ${d.totales.registros} registros`, d.totales.venta ? "alerta" : "")}
      ${d.impacto.sinCostos ? kpi("Pérdida al costo", "Sin costos", "los productos no tienen costo cargado en AxisPOS") : kpi("Pérdida al costo", dinero(d.totales.costo))}
      ${d.impacto.pctVentaPrecio != null && d.impacto.sinCostos ? kpi("Peso sobre las ventas", num(d.impacto.pctVentaPrecio, 2) + "%", `a precio de venta, de ${corto(d.impacto.ventas)} vendidos`) : ""}
      ${d.impacto.pctVentas != null ? kpi("Peso sobre las ventas", num(d.impacto.pctVentas, 2) + "%", `de ${corto(d.impacto.ventas)} vendidos`) : ""}
      ${d.impacto.pctUtilidad != null ? kpi("Se come de la utilidad", num(d.impacto.pctUtilidad, 1) + "%", `utilidad neta ${corto(d.impacto.utilidadNeta)}`) : ""}</div>
    ${tarjeta("Por causa", lista(d.categorias.map((c) => `<div class="fila"><div><b style="text-transform:capitalize">${esc(c.categoria)}</b><small>${c.n} registros · ${num(c.unidades, 0)} uds.</small>
      <div class="barra-fina"><i style="width:${((d.impacto.sinCostos ? c.venta : c.costo) / maxC) * 100}%"></i></div></div><div class="der"><b>${dinero(d.impacto.sinCostos ? c.venta : c.costo)}</b></div></div>`), "No hay mermas en este período") +
      (d.categorias.some((c) => c.categoria === "sin categoría") ? `<p class="nota">La causa sale de la nota del documento de merma en AxisPOS. Escribe en la nota la palabra <b>vencido</b>, <b>daño</b> o <b>robo</b> (o similares) para que se clasifique.</p>` : ""))}
    <div class="dos">
      ${tarjeta("Productos con más pérdida", lista(d.productos.map((p) => `<div class="fila"><div>${esc(p.nombre)}<small>${num(p.unidades, 0)} uds. · ${p.n} veces</small></div><div class="der">${dinero(d.impacto.sinCostos ? p.venta : p.costo)}</div></div>`), "—"))}
      ${tarjeta("Quién las registró", lista(d.usuarios.map((p) => `<div class="fila"><div>${esc(p.usuario)}<small>${p.n} registros</small></div><div class="der">${dinero(d.impacto.sinCostos ? p.venta : p.costo)}</div></div>`), "—"))}
    </div>
    ${d.lotes.length ? tarjeta("Lotes por vencer (60 días)", lista(d.lotes.map((l) => `<div class="fila"><div>${esc(l.nombre)}<small>Lote ${esc(l.serie || l.id)}</small></div><div class="der"><b>${fechaCorta(l.vence)}</b><small>${num(l.cant)} uds.</small></div></div>`), "")) : ""}
    ${tarjeta("Últimos registros", lista(d.recientes.map((r) => `<div class="fila"><div>${esc(r.nombre || "—")}<small>${fechaCorta(r.fecha)} · ${esc(r.usuario || "—")} · ${esc(r.categoria)}${r.nota ? " · " + esc(r.nota) : ""}</small></div><div class="der">${num(r.unidades, 0)} uds.<small>${r.costo ? dinero(r.costo) : ""}</small></div></div>`), "—"))}
    <p class="nota">${d.impacto.sinCostos ? "Los productos no tienen costo de compra cargado en AxisPOS, por eso la pérdida se mide a precio de venta. Carga los costos para ver el impacto real en la ganancia." : "La pérdida se mide al costo de compra de cada producto."}</p>`;
}

/* ───────────────────────── Usuarios y PIN ───────────────────────── */
async function vAjustes(cont) {
  const d = await api("/api/usuarios");
  cont.innerHTML = `${tituloVista("Usuarios y PIN", "Cada usuario de AxisPOS entra con su PIN (4 a 6 números). Sin PIN no puede entrar.")}
    ${S.ses.sinPines ? '<section class="card hero"><b>Primer paso:</b> crea tu PIN de administrador. Después crea el de las demás personas.</section>' : ""}
    ${tarjeta("Personas", d.usuarios.map((u) => `<div class="usr" data-id="${u.id}">
      <div class="usr-i"><b>${esc(u.nombre)}</b><small>Nivel en AxisPOS: ${u.nivel} · ${u.tienePin ? "PIN activo" : "sin PIN"}</small></div>
      <select data-r>${d.roles.map((r) => `<option value="${r}" ${(u.rol || u.rolSugerido) === r ? "selected" : ""}>${ROLES[r]}</option>`).join("")}</select>
      <input data-p type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="${u.tienePin ? "PIN nuevo" : "Crear PIN"}" autocomplete="new-password">
      <div class="acc"><button class="btn chico" data-g>Guardar</button>${u.tienePin ? '<button class="btn claro chico" data-q>Quitar PIN</button>' : ""}</div></div>`).join(""))}
    ${tarjeta("Qué puede hacer cada rol", `<div class="fila"><div><b>Administrador</b><small>Todo, incluida esta pantalla.</small></div></div>
      <div class="fila"><div><b>Gerente</b><small>Resumen, inventario completo, caja, auditoría y mermas. No cambia PIN.</small></div></div>
      <div class="fila"><div><b>Cajero</b><small>Solo sus ventas y turnos, productos y existencias. No ve costos ni alertas.</small></div></div>`)}
    <p class="nota">Si alguien olvida su PIN, pon uno nuevo aquí. Si se pierde el del administrador, entra con el usuario de MariaDB en la pantalla de inicio.</p>`;
  cont.onclick = async (e) => {
    const fila = e.target.closest(".usr");
    if (!fila) return;
    const usuario = fila.dataset.id;
    try {
      if (e.target.closest("[data-g]")) {
        const pin = fila.querySelector("[data-p]").value;
        await post("/api/pin", { usuario, pin, rol: fila.querySelector("[data-r]").value });
        S.ses.sinPines = false;
        aviso("Guardado");
        vistaAjustesRecargar();
      } else if (e.target.closest("[data-q]")) {
        if (!confirm("¿Quitar el PIN? Esa persona ya no podrá entrar.")) return;
        await post("/api/pin/quitar", { usuario });
        aviso("PIN quitado");
        vistaAjustesRecargar();
      }
    } catch (err) {
      if (err instanceof SesionVencida) return mostrarLogin(err.message);
      aviso(err.message);
    }
  };
}
const vistaAjustesRecargar = () => cargar();

/* ───────────────────────── Arranque ───────────────────────── */
(async function () {
  $("usuario").value = leer("usuarioBD");
  if (enApp) {
    $("fila-servidor").hidden = false;
    $("servidor").value = leer("servidor");
    S.base = leer("servidor");
  }
  S.token = leer("token");
  if (S.token && (S.base || !enApp)) {
    try {
      S.ses = await api("/api/sesion");
      S.ses.token = S.token;
      return mostrarApp();
    } catch {}
  }
  mostrarLogin();
})();
