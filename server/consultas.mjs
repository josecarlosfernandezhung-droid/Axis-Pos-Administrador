// Consultas de solo lectura sobre la base de AxisPOS (MariaDB).
// Las fórmulas se comprobaron contra una copia real: ventas, tickets, devoluciones, existencias y cajeros coinciden al centavo.

// Fecha real de la venta: UserRealTime si es válida, si no Date
const F = "IF(o.UserRealTime BETWEEN '2020-01-01' AND '2036-12-31 23:59:59', o.UserRealTime, o.`Date`)";
const IMP = "(ABS(o.Qtty) * o.PriceOut * (1 - IF(o.Discount BETWEEN 0 AND 100, o.Discount, 0) / 100))";
const VENTA = "o.OperType = 2 AND COALESCE(o.Sign, 0) <= 0";
const DEVOL = "o.OperType = 34";
const RANGO = `${F} >= ? AND ${F} < DATE_ADD(?, INTERVAL 1 DAY)`;
const PRECIO = "COALESCE(NULLIF(g.PriceOut2,0), NULLIF(g.PriceOut1,0), NULLIF(g.PriceOut3,0), 0)";
const STOCK = "(SELECT GoodID, SUM(Qtty) AS cant FROM store GROUP BY GoodID)";

const ymd = (d) => d.toISOString().slice(0, 10);
export const sumarDias = (s, n) => {
  const d = new Date(s + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
};
const difDias = (a, b) => Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 864e5);
const num = (x) => (x == null ? 0 : Number(x));
const redondear = (x, d = 2) => Math.round(num(x) * 10 ** d) / 10 ** d;
export const numTicket = (acct) => String(Math.trunc(num(acct))).padStart(10, "0");

const filas = async (pool, sql, params = []) => (await pool.query(sql, params))[0];
const una = async (pool, sql, params = []) => (await filas(pool, sql, params))[0] || {};
const uid = (ctx) => (ctx.uid != null ? " AND o.UserID = ?" : "");
const parRango = (ctx, d, h) => (ctx.uid != null ? [d, h, ctx.uid] : [d, h]);

// ---------- Periodo ----------
let extremosCache = { t: 0, v: null };
async function extremos(pool) {
  if (extremosCache.v && Date.now() - extremosCache.t < 20000) return extremosCache.v;
  const m = await una(
    pool,
    `SELECT DATE_FORMAT(MIN(x.f),'%Y-%m-%d') AS desde, DATE_FORMAT(MAX(x.f),'%Y-%m-%d') AS hasta
     FROM (SELECT ${F} AS f FROM operations o WHERE ${VENTA}) x WHERE x.f <= NOW()`
  );
  const hoy = ymd(new Date());
  extremosCache = { t: Date.now(), v: { desde: m.desde || hoy, hasta: m.hasta || hoy } };
  return extremosCache.v;
}

export async function resolverRango(pool, periodo) {
  const ext = await extremos(pool);
  const hasta = ext.hasta;
  let dias = periodo === "7" ? 7 : periodo === "90" ? 90 : periodo === "todo" ? null : 30;
  let desde;
  if (dias) desde = sumarDias(hasta, -(dias - 1));
  else {
    desde = ext.desde;
    dias = difDias(desde, hasta) + 1;
  }
  const r = { desde, hasta, dias, todo: periodo === "todo", ultimo: ext.hasta };
  if (!r.todo) {
    r.aHasta = sumarDias(desde, -1);
    r.aDesde = sumarDias(r.aHasta, -(dias - 1));
  }
  return r;
}

async function totalVentas(pool, ctx, d, h) {
  const r = await una(
    pool,
    `SELECT COALESCE(SUM(${IMP}),0) AS total, COUNT(DISTINCT o.Acct) AS tickets FROM operations o WHERE ${VENTA} AND ${RANGO}${uid(ctx)}`,
    parRango(ctx, d, h)
  );
  return { total: num(r.total), tickets: num(r.tickets) };
}

const porHora = (pool, ctx, d, h) =>
  filas(
    pool,
    `SELECT HOUR(${F}) AS hora, SUM(${IMP}) AS total, COUNT(DISTINCT o.Acct) AS tickets
     FROM operations o WHERE ${VENTA} AND ${RANGO}${uid(ctx)} GROUP BY hora ORDER BY hora`,
    parRango(ctx, d, h)
  );

// ---------- Resumen ----------
export async function resumen(pool, ctx) {
  const { desde, hasta } = ctx.r;
  const U = uid(ctx);
  const P = parRango(ctx, desde, hasta);
  const ultimo = ctx.r.ultimo;
  const inicioMes = ultimo.slice(0, 8) + "01";
  const diaMes = Number(ultimo.slice(8, 10));
  const mesAntIni = ymd(new Date(Date.UTC(Number(ultimo.slice(0, 4)), Number(ultimo.slice(5, 7)) - 2, 1)));
  const mesAntMismoDia = sumarDias(mesAntIni, diaMes - 1);
  const mesAntFin = sumarDias(inicioMes, -1);
  const [tot, dev, ant, horas, dias, top, fam, formas, rec, hoyT, ayerT, sem, semAnt, mes, mesAnt, hoyHoras, cajeros] =
    await Promise.all([
      una(pool, `SELECT COALESCE(SUM(${IMP}),0) AS total, COUNT(DISTINCT o.Acct) AS tickets, COALESCE(SUM(ABS(o.Qtty)),0) AS unidades FROM operations o WHERE ${VENTA} AND ${RANGO}${U}`, P),
      una(pool, `SELECT COALESCE(SUM(${IMP}),0) AS total, COUNT(DISTINCT o.Acct) AS docs FROM operations o WHERE ${DEVOL} AND ${RANGO}${U}`, P),
      ctx.r.todo ? Promise.resolve(null) : totalVentas(pool, ctx, ctx.r.aDesde, ctx.r.aHasta),
      porHora(pool, ctx, desde, hasta),
      filas(pool, `SELECT DATE_FORMAT(${F},'%Y-%m-%d') AS dia, SUM(${IMP}) AS total, COUNT(DISTINCT o.Acct) AS tickets FROM operations o WHERE ${VENTA} AND ${RANGO}${U} GROUP BY dia ORDER BY dia`, P),
      filas(pool, `SELECT g.Name AS nombre, COALESCE(gg.Name,'Sin grupo') AS familia, SUM(ABS(o.Qtty)) AS unidades, SUM(${IMP}) AS total
        FROM operations o LEFT JOIN goods g ON g.ID = o.GoodID LEFT JOIN goodsgroups gg ON gg.ID = g.GroupID
        WHERE ${VENTA} AND ${RANGO}${U} GROUP BY o.GoodID, g.Name, gg.Name ORDER BY total DESC LIMIT 10`, P),
      filas(pool, `SELECT COALESCE(gg.Name,'Sin grupo') AS familia, SUM(${IMP}) AS total
        FROM operations o LEFT JOIN goods g ON g.ID = o.GoodID LEFT JOIN goodsgroups gg ON gg.ID = g.GroupID
        WHERE ${VENTA} AND ${RANGO}${U} GROUP BY gg.ID, gg.Name ORDER BY total DESC LIMIT 12`, P),
      filas(pool, `SELECT COALESCE(p.Company,'Sin socio') AS socio, COUNT(DISTINCT o.Acct) AS tickets, SUM(${IMP}) AS total
        FROM operations o LEFT JOIN partners p ON p.ID = o.PartnerID WHERE ${VENTA} AND ${RANGO}${U} GROUP BY p.ID, p.Company ORDER BY total DESC`, P),
      filas(pool, `SELECT o.Acct AS acct, MAX(${F}) AS fecha, SUM(${IMP}) AS total, MAX(u.Name) AS cajero
        FROM operations o LEFT JOIN users u ON u.ID = o.UserID WHERE ${VENTA} AND ${RANGO}${U}
        GROUP BY o.Acct ORDER BY fecha DESC, o.Acct DESC LIMIT 6`, P),
      totalVentas(pool, ctx, ultimo, ultimo),
      totalVentas(pool, ctx, sumarDias(ultimo, -1), sumarDias(ultimo, -1)),
      totalVentas(pool, ctx, sumarDias(ultimo, -6), ultimo),
      totalVentas(pool, ctx, sumarDias(ultimo, -13), sumarDias(ultimo, -7)),
      totalVentas(pool, ctx, inicioMes, ultimo),
      totalVentas(pool, ctx, mesAntIni, mesAntMismoDia),
      porHora(pool, ctx, ultimo, ultimo),
      ctx.uid != null ? Promise.resolve([]) : equipo(pool, { ...ctx, r: ctx.r }),
    ]);
  const mesAntCompleto = await totalVentas(pool, ctx, mesAntIni, mesAntFin);
  const total = num(tot.total);
  const tickets = num(tot.tickets);
  const pct = (a, b) => (b > 0 ? redondear(((a - b) / b) * 100, 1) : null);
  return {
    desde, hasta, dias: ctx.r.dias, ultimoDia: ultimo,
    total, tickets, unidades: num(tot.unidades), promedio: tickets ? total / tickets : 0,
    devoluciones: num(dev.total), devDocs: num(dev.docs), neto: total - num(dev.total),
    anterior: ant ? { total: ant.total, tickets: ant.tickets, variacion: pct(total, ant.total) } : null,
    porHora: horas.map((x) => ({ hora: num(x.hora), total: num(x.total), tickets: num(x.tickets) })),
    porDia: dias.map((x) => ({ dia: x.dia, total: num(x.total), tickets: num(x.tickets) })),
    top: top.map((x) => ({ nombre: x.nombre, familia: x.familia, unidades: num(x.unidades), total: num(x.total) })),
    familias: fam.map((x) => ({ familia: x.familia, total: num(x.total) })),
    formasPago: formas.map((x) => ({ socio: x.socio, tickets: num(x.tickets), total: num(x.total) })),
    recientes: rec.map((x) => ({ ticket: numTicket(x.acct), acct: num(x.acct), fecha: x.fecha, total: num(x.total), cajero: x.cajero })),
    cajeros: (cajeros || []).slice(0, 8),
    tiempoReal: {
      dia: ultimo, hoy: hoyT.total, hoyTickets: hoyT.tickets, ayer: ayerT.total, varDia: pct(hoyT.total, ayerT.total),
      semana: sem.total, semanaAnt: semAnt.total, varSemana: pct(sem.total, semAnt.total),
      mes: mes.total, mesAnt: mesAnt.total, varMes: pct(mes.total, mesAnt.total), mesAntCompleto: mesAntCompleto.total,
      horasHoy: hoyHoras.map((x) => ({ hora: num(x.hora), total: num(x.total) })),
    },
  };
}

// ---------- Ventas ----------
export async function ventas(pool, ctx, q) {
  const { desde, hasta } = ctx.r;
  const busca = String(q.q || "").trim().slice(0, 60);
  const pagina = Math.max(parseInt(q.pagina, 10) || 1, 1);
  const por = q.todo ? 20000 : 40;
  const params = parRango(ctx, desde, hasta);
  let having = "";
  if (busca) {
    having = "HAVING (CAST(o.Acct AS CHAR) LIKE ? OR MAX(u.Name) LIKE ? OR SUM(g.Name LIKE ?) > 0)";
    const l = `%${busca.replace(/^0+/, "")}%`;
    params.push(l, `%${busca}%`, `%${busca}%`);
  }
  const base = `SELECT o.Acct AS acct, MAX(${F}) AS fecha, MAX(u.Name) AS cajero, MAX(p.Company) AS socio, SUM(${IMP}) AS total
    FROM operations o LEFT JOIN users u ON u.ID = o.UserID LEFT JOIN partners p ON p.ID = o.PartnerID LEFT JOIN goods g ON g.ID = o.GoodID
    WHERE ${VENTA} AND ${RANGO}${uid(ctx)} GROUP BY o.Acct ${having}`;
  const [[cuenta], lista] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS n FROM (${base}) z`, params),
    filas(pool, `${base} ORDER BY fecha DESC, o.Acct DESC LIMIT ${por} OFFSET ${(pagina - 1) * por}`, params),
  ]);
  const n = num(cuenta[0].n);
  return {
    total: n, paginas: Math.max(Math.ceil(n / por), 1), pagina,
    filas: lista.map((x) => ({ ticket: numTicket(x.acct), acct: num(x.acct), fecha: x.fecha, cajero: x.cajero, socio: x.socio, total: num(x.total) })),
  };
}

export async function ticket(pool, ctx, acct) {
  const params = [acct];
  let extra = "";
  if (ctx.uid != null) {
    extra = " AND o.UserID = ?";
    params.push(ctx.uid);
  }
  const lineas = await filas(
    pool,
    `SELECT o.ID AS id, o.OperType AS tipo, g.Name AS nombre, ABS(o.Qtty) AS cant, o.PriceOut AS precio,
            IF(o.Discount BETWEEN 0 AND 100, o.Discount, 0) AS descuento, ${IMP} AS importe,
            ${F} AS fecha, u.Name AS cajero, p.Company AS socio
     FROM operations o LEFT JOIN goods g ON g.ID = o.GoodID LEFT JOIN users u ON u.ID = o.UserID LEFT JOIN partners p ON p.ID = o.PartnerID
     WHERE o.Acct = ? AND o.OperType IN (2, 34)${extra} ORDER BY o.ID`,
    params
  );
  if (!lineas.length) return null;
  const devol = lineas[0].tipo === 34;
  return {
    ticket: numTicket(acct), devolucion: devol, fecha: lineas[0].fecha, cajero: lineas[0].cajero, socio: lineas[0].socio,
    lineas: lineas.map((l) => ({ nombre: l.nombre, cant: num(l.cant), precio: num(l.precio), descuento: num(l.descuento), importe: num(l.importe) })),
    total: lineas.reduce((s, l) => s + num(l.importe), 0),
  };
}

// ---------- Productos ----------
export async function productos(pool, ctx, q) {
  const { desde, hasta } = ctx.r;
  const busca = `%${String(q.q || "").trim().slice(0, 60)}%`;
  const pagina = Math.max(parseInt(q.pagina, 10) || 1, 1);
  const activos = q.activos !== "0";
  const fam = parseInt(q.familia, 10);
  const orden = { vendidos: "importe DESC, g.Name", nombre: "g.Name", stock: "existencia DESC, g.Name", precio: "precio DESC, g.Name" }[q.orden] || "importe DESC, g.Name";
  const cond = [`(g.Name LIKE ? OR g.Code LIKE ? OR g.BarCode1 LIKE ?)`];
  const params = [busca, busca, busca];
  if (activos) cond.push("COALESCE(g.Deleted,0) = 0");
  if (Number.isInteger(fam)) {
    cond.push("g.GroupID = ?");
    params.push(fam);
  }
  const donde = cond.join(" AND ");
  const cajero = ctx.rol === "cajero";
  const [[cuenta], lista] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS n FROM goods g WHERE ${donde}`, params),
    filas(
      pool,
      `SELECT g.ID AS id, g.Code AS codigo, g.Name AS nombre, COALESCE(gg.Name,'Sin grupo') AS familia, g.PriceIn AS costo,
              ${PRECIO} AS precio, COALESCE(s.cant,0) AS existencia, COALESCE(v.unidades,0) AS vendido, COALESCE(v.total,0) AS importe
       FROM goods g LEFT JOIN goodsgroups gg ON gg.ID = g.GroupID
       LEFT JOIN ${STOCK} s ON s.GoodID = g.ID
       LEFT JOIN (SELECT o.GoodID, SUM(ABS(o.Qtty)) AS unidades, SUM(${IMP}) AS total FROM operations o WHERE ${VENTA} AND ${RANGO} GROUP BY o.GoodID) v ON v.GoodID = g.ID
       WHERE ${donde} ORDER BY ${orden} LIMIT 40 OFFSET ${(pagina - 1) * 40}`,
      [desde, hasta, ...params]
    ),
  ]);
  const n = num(cuenta[0].n);
  const familias = await filas(pool, `SELECT gg.ID AS id, gg.Name AS nombre FROM goodsgroups gg WHERE EXISTS (SELECT 1 FROM goods g WHERE g.GroupID = gg.ID) ORDER BY gg.Name`);
  return {
    total: n, paginas: Math.max(Math.ceil(n / 40), 1), pagina, familias,
    filas: lista.map((x) => ({
      id: x.id, codigo: x.codigo, nombre: x.nombre, familia: x.familia, precio: num(x.precio), existencia: num(x.existencia),
      ...(cajero ? {} : { costo: num(x.costo), vendido: num(x.vendido), importe: num(x.importe) }),
    })),
  };
}

// ---------- Existencias ----------
export async function existencias(pool, ctx, q) {
  const { desde, hasta } = ctx.r;
  const busca = `%${String(q.q || "").trim().slice(0, 60)}%`;
  const pagina = Math.max(parseInt(q.pagina, 10) || 1, 1);
  const local = parseInt(q.local, 10);
  const params = [busca, busca];
  let filtro = "";
  if (Number.isInteger(local)) {
    filtro = " AND s.ObjectID = ?";
    params.push(local);
  }
  const base = `SELECT s.ObjectID AS lid, o.Name AS local, s.GoodID AS id, g.Name AS nombre, SUM(s.Qtty) AS cantidad
    FROM store s JOIN goods g ON g.ID = s.GoodID JOIN objects o ON o.ID = s.ObjectID
    WHERE (g.Name LIKE ? OR g.Code LIKE ?)${filtro} GROUP BY s.ObjectID, o.Name, s.GoodID, g.Name HAVING SUM(s.Qtty) > 0.0005`;
  const [kpi, agot, locales, [cuenta], lista] = await Promise.all([
    una(pool, `SELECT COUNT(*) AS referencias, COALESCE(SUM(t.cant),0) AS piezas FROM (SELECT GoodID, SUM(Qtty) AS cant FROM store GROUP BY GoodID HAVING SUM(Qtty) > 0.0005) t`),
    filas(pool, `SELECT g.Name AS nombre, v.total AS importe
      FROM (SELECT o.GoodID, SUM(${IMP}) AS total FROM operations o WHERE ${VENTA} AND ${RANGO} GROUP BY o.GoodID) v
      JOIN goods g ON g.ID = v.GoodID LEFT JOIN ${STOCK} s ON s.GoodID = v.GoodID
      WHERE COALESCE(s.cant,0) <= 0.0005 ORDER BY v.total DESC`, [desde, hasta]),
    filas(pool, `SELECT o.ID AS id, o.Name AS nombre, o.Deleted AS archivado FROM objects o WHERE EXISTS (SELECT 1 FROM store s WHERE s.ObjectID = o.ID AND s.Qtty <> 0) ORDER BY o.Name`),
    pool.query(`SELECT COUNT(*) AS n FROM (${base}) z`, params),
    filas(pool, `${base} ORDER BY cantidad DESC, nombre LIMIT 40 OFFSET ${(pagina - 1) * 40}`, params),
  ]);
  const n = num(cuenta[0].n);
  return {
    referencias: num(kpi.referencias), piezas: num(kpi.piezas), agotados: agot.length,
    agotadosLista: agot.slice(0, 12).map((x) => ({ nombre: x.nombre, importe: num(x.importe) })),
    locales: locales.map((x) => ({ id: x.id, nombre: x.nombre + (num(x.archivado) !== 0 ? " (archivado)" : "") })),
    total: n, paginas: Math.max(Math.ceil(n / 40), 1), pagina,
    filas: lista.map((x) => ({ id: x.id, nombre: x.nombre, local: x.local, cantidad: num(x.cantidad) })),
  };
}

// ---------- Caja y cierres ----------
export async function caja(pool, ctx, q) {
  const { desde, hasta } = ctx.r;
  const tol = ctx.aj.tolCierre;
  const pagina = Math.max(parseInt(q.pagina, 10) || 1, 1);
  const filtroU = ctx.uid != null ? " AND sh.UserID = ?" : "";
  const params = ctx.uid != null ? [desde, hasta, ctx.uid] : [desde, hasta];
  const todos = await filas(
    pool,
    `SELECT sh.ID AS id, o.Name AS local, u.Name AS usuario, DATE_FORMAT(sh.DateTimeOpen,'%Y-%m-%d %H:%i:%s') AS apertura,
            DATE_FORMAT(sh.DateTimeClose,'%Y-%m-%d %H:%i:%s') AS cierre, sh.TotalOpen AS inicial, sh.TotalFinal AS contado,
            sh.TotalWithdrawal AS retiro, sh.DiffClose AS difAxis, COALESCE(v.total,0) AS ventas, COALESCE(v.tickets,0) AS tickets,
            COALESCE(d.total,0) AS devoluciones, COALESCE(pg.total,0) AS pagos
     FROM shift sh LEFT JOIN objects o ON o.ID = sh.ObjectID LEFT JOIN users u ON u.ID = sh.UserID
     LEFT JOIN (SELECT o.ShiftID, SUM(${IMP}) AS total, COUNT(DISTINCT o.Acct) AS tickets FROM operations o WHERE ${VENTA} GROUP BY o.ShiftID) v ON v.ShiftID = sh.ID
     LEFT JOIN (SELECT o.ShiftID, SUM(${IMP}) AS total FROM operations o WHERE ${DEVOL} GROUP BY o.ShiftID) d ON d.ShiftID = sh.ID
     LEFT JOIN (SELECT ShiftID, SUM(Qtty) AS total FROM payments WHERE OperType = 2 AND Mode = 1 GROUP BY ShiftID) pg ON pg.ShiftID = sh.ID
     WHERE sh.DateTimeOpen >= ? AND sh.DateTimeOpen < DATE_ADD(?, INTERVAL 1 DAY)${filtroU} ORDER BY sh.DateTimeOpen DESC`,
    params
  );
  const turnos = todos.map((t) => {
    const ventas = num(t.ventas), dev = num(t.devoluciones), contado = num(t.contado);
    const esperado = num(t.inicial) + ventas - dev - num(t.retiro);
    const cerrado = !!t.cierre && contado > 0;
    const dif = cerrado ? redondear(contado - esperado) : null;
    const difPagos = redondear(ventas - num(t.pagos));
    const nivel = dif == null ? null : Math.abs(dif) > tol * 10 ? "alta" : Math.abs(dif) > tol ? "media" : "ok";
    return {
      id: t.id, local: t.local, usuario: t.usuario, apertura: t.apertura, cierre: t.cierre, tickets: num(t.tickets),
      ventas, devoluciones: dev, retiro: num(t.retiro), inicial: num(t.inicial), esperado: redondear(esperado), contado,
      diferencia: dif, nivel, difAxis: num(t.difAxis), pagos: num(t.pagos), difPagos, sinCierre: !cerrado && !!t.cierre,
    };
  });
  const [[dv], formas] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(${IMP}),0) AS total FROM operations o WHERE ${DEVOL} AND ${RANGO}${uid(ctx)}`, parRango(ctx, desde, hasta)),
    filas(pool, `SELECT COALESCE(p.Company,'Sin socio') AS socio, COUNT(DISTINCT o.Acct) AS tickets, SUM(${IMP}) AS total
      FROM operations o LEFT JOIN partners p ON p.ID = o.PartnerID WHERE ${VENTA} AND ${RANGO}${uid(ctx)} GROUP BY p.ID, p.Company ORDER BY total DESC`, parRango(ctx, desde, hasta)),
  ]);
  const ventasTot = turnos.reduce((s, t) => s + t.ventas, 0);
  const conDif = turnos.filter((t) => t.nivel === "media" || t.nivel === "alta");
  const paginas = Math.max(Math.ceil(turnos.length / 20), 1);
  return {
    ventas: ventasTot, devoluciones: num(dv[0].total), neto: ventasTot - num(dv[0].total), turnos: turnos.length,
    conDiferencia: conDif.length, faltante: redondear(conDif.filter((t) => t.diferencia < 0).reduce((s, t) => s + t.diferencia, 0)),
    sobrante: redondear(conDif.filter((t) => t.diferencia > 0).reduce((s, t) => s + t.diferencia, 0)),
    sinCuadrar: turnos.filter((t) => Math.abs(t.difPagos) > 1 && t.ventas > 0).length, tolerancia: tol,
    formasPago: formas.map((x) => ({ socio: x.socio, tickets: num(x.tickets), total: num(x.total) })),
    pagina, paginas, filas: q.todo ? turnos : turnos.slice((pagina - 1) * 20, pagina * 20),
  };
}

// ---------- Equipo ----------
export async function equipo(pool, ctx) {
  const { desde, hasta } = ctx.r;
  const P = [desde, hasta];
  const [vt, dv] = await Promise.all([
    filas(pool, `SELECT o.UserID AS id, u.Name AS nombre, u.UserLevel AS nivel, COALESCE(ug.Name, 'Sistema') AS grupo, SUM(${IMP}) AS total, COUNT(DISTINCT o.Acct) AS tickets
      FROM operations o LEFT JOIN users u ON u.ID = o.UserID LEFT JOIN usersgroups ug ON ug.ID = u.GroupID
      WHERE ${VENTA} AND ${RANGO} GROUP BY o.UserID, u.Name, u.UserLevel, ug.Name ORDER BY total DESC`, P),
    filas(pool, `SELECT o.UserID AS id, SUM(${IMP}) AS total FROM operations o WHERE ${DEVOL} AND ${RANGO} GROUP BY o.UserID`, P),
  ]);
  const dmap = new Map(dv.map((x) => [x.id, num(x.total)]));
  const max = Math.max(1, ...vt.map((x) => num(x.total)));
  return vt.map((x) => ({
    id: x.id, nombre: x.nombre || `Usuario ${x.id}`, grupo: x.grupo, rol: ctx.rolDe(x.id, x.nivel), total: num(x.total),
    tickets: num(x.tickets), devoluciones: dmap.get(x.id) || 0, parte: num(x.total) / max,
  }));
}

export async function equipoCompleto(pool, ctx) {
  const lista = await equipo(pool, ctx);
  const formas = await filas(pool, `SELECT COALESCE(p.Company,'Sin socio') AS socio, COUNT(DISTINCT o.Acct) AS tickets, SUM(${IMP}) AS total
    FROM operations o LEFT JOIN partners p ON p.ID = o.PartnerID WHERE ${VENTA} AND ${RANGO} GROUP BY p.ID, p.Company ORDER BY total DESC`, [ctx.r.desde, ctx.r.hasta]);
  return { cajeros: lista, socios: formas.map((x) => ({ socio: x.socio, tickets: num(x.tickets), total: num(x.total) })) };
}

// ---------- Inventario: alertas, ABC, compras ----------
let invCache = { t: 0, clave: "", v: null };
export async function datosInventario(pool, ctx) {
  const aj = ctx.aj;
  const clave = `${aj.ventanaVentas}|${aj.plazoRepos}|${aj.seguridad}|${aj.cobertura}|${ctx.r.ultimo}`;
  if (invCache.v && invCache.clave === clave && Date.now() - invCache.t < 60000) return invCache.v;
  const hasta = ctx.r.ultimo;
  const desde = sumarDias(hasta, -(aj.ventanaVentas - 1));
  const lista = await filas(
    pool,
    `SELECT g.ID AS id, g.Code AS codigo, g.Name AS nombre, COALESCE(gg.Name,'Sin grupo') AS familia, g.PriceIn AS costo,
            ${PRECIO} AS precio, g.MinQtty AS minimo, COALESCE(s.cant,0) AS stock, COALESCE(v.unidades,0) AS unidades, COALESCE(v.total,0) AS importe
     FROM goods g LEFT JOIN goodsgroups gg ON gg.ID = g.GroupID LEFT JOIN ${STOCK} s ON s.GoodID = g.ID
     LEFT JOIN (SELECT o.GoodID, SUM(ABS(o.Qtty)) AS unidades, SUM(${IMP}) AS total FROM operations o WHERE ${VENTA} AND ${RANGO} GROUP BY o.GoodID) v ON v.GoodID = g.ID
     WHERE COALESCE(g.Deleted,0) = 0 AND (ABS(COALESCE(s.cant,0)) > 0.0005 OR COALESCE(v.unidades,0) > 0)`,
    [desde, hasta]
  );
  const items = lista.map((x) => {
    const stock = num(x.stock), unidades = num(x.unidades), diaria = unidades / aj.ventanaVentas;
    const reorden = diaria * (aj.plazoRepos + aj.seguridad);
    return {
      id: x.id, codigo: x.codigo, nombre: x.nombre, familia: x.familia, costo: num(x.costo), precio: num(x.precio),
      minimo: num(x.minimo), stock, unidades, importe: num(x.importe), diaria, reorden,
      cobertura: diaria > 0 ? Math.max(stock, 0) / diaria : null,
    };
  });
  // ABC por importe vendido en la ventana
  const conVenta = items.filter((x) => x.importe > 0).sort((a, b) => b.importe - a.importe);
  const totalImp = conVenta.reduce((s, x) => s + x.importe, 0) || 1;
  let acum = 0;
  for (const x of conVenta) {
    const antes = acum / totalImp;
    acum += x.importe;
    x.clase = antes < 0.8 ? "A" : antes < 0.95 ? "B" : "C";
    x.acum = acum / totalImp;
  }
  for (const x of items) if (!x.clase) x.clase = "-";
  const v = { items, desde, hasta, totalImp };
  invCache = { t: Date.now(), clave, v };
  return v;
}

export async function alertasStock(pool, ctx) {
  const d = await datosInventario(pool, ctx);
  const aj = ctx.aj;
  const alertas = [];
  for (const x of d.items) {
    let tipo = null, nivel = "media";
    if (x.stock <= 0.0005 && x.unidades > 0) { tipo = "agotado"; nivel = "alta"; }
    else if (x.minimo > 0 && x.stock <= x.minimo) { tipo = "minimo"; nivel = x.stock <= x.minimo / 2 ? "alta" : "media"; }
    else if (x.diaria > 0 && x.stock <= x.reorden) { tipo = "reorden"; nivel = x.cobertura <= aj.plazoRepos ? "alta" : "media"; }
    if (tipo) alertas.push({ ...x, tipo, nivel });
  }
  alertas.sort((a, b) => (a.nivel === b.nivel ? (a.cobertura ?? -1) - (b.cobertura ?? -1) : a.nivel === "alta" ? -1 : 1));
  return {
    ventana: aj.ventanaVentas, plazo: aj.plazoRepos, seguridad: aj.seguridad,
    resumen: { agotados: alertas.filter((a) => a.tipo === "agotado").length, minimo: alertas.filter((a) => a.tipo === "minimo").length, reorden: alertas.filter((a) => a.tipo === "reorden").length, altas: alertas.filter((a) => a.nivel === "alta").length },
    filas: alertas.slice(0, 150).map(({ id, codigo, nombre, familia, stock, minimo, diaria, reorden, cobertura, tipo, nivel, clase }) => ({ id, codigo, nombre, familia, stock, minimo, diaria, reorden, cobertura, tipo, nivel, clase })),
    total: alertas.length,
  };
}

export async function analisisABC(pool, ctx, q) {
  const d = await datosInventario(pool, ctx);
  const clases = { A: { n: 0, importe: 0 }, B: { n: 0, importe: 0 }, C: { n: 0, importe: 0 } };
  for (const x of d.items) if (clases[x.clase]) { clases[x.clase].n++; clases[x.clase].importe += x.importe; }
  const quietos = d.items.filter((x) => x.stock > 0.0005 && x.unidades === 0);
  const capital = quietos.reduce((s, x) => s + x.stock * (x.costo > 0 ? x.costo : x.precio), 0);
  const clase = ["A", "B", "C", "S"].includes(q.clase) ? q.clase : "A";
  const sel = clase === "S" ? quietos.sort((a, b) => b.stock * b.precio - a.stock * a.precio) : d.items.filter((x) => x.clase === clase);
  return {
    ventana: ctx.aj.ventanaVentas, totalImporte: d.totalImp,
    clases: Object.fromEntries(Object.entries(clases).map(([k, v]) => [k, { n: v.n, importe: v.importe, pct: v.importe / d.totalImp }])),
    sinMovimiento: { n: quietos.length, capital },
    clase, filas: sel.slice(0, 100).map((x) => ({ id: x.id, nombre: x.nombre, familia: x.familia, stock: x.stock, unidades: x.unidades, importe: x.importe, acum: x.acum ?? null, precio: x.precio })),
  };
}

export async function sugerenciasCompra(pool, ctx) {
  const d = await datosInventario(pool, ctx);
  const aj = ctx.aj;
  const filasC = [];
  for (const x of d.items) {
    if (!(x.diaria > 0) || x.stock > x.reorden) continue;
    const objetivo = x.diaria * (aj.cobertura + aj.seguridad);
    const pedir = Math.ceil(objetivo - Math.max(x.stock, 0));
    if (pedir <= 0) continue;
    filasC.push({ id: x.id, codigo: x.codigo, nombre: x.nombre, familia: x.familia, clase: x.clase, stock: x.stock, diaria: x.diaria, cobertura: x.cobertura, pedir, costo: x.costo, estimado: x.costo > 0 ? pedir * x.costo : null });
  }
  const orden = { A: 0, B: 1, C: 2, "-": 3 };
  filasC.sort((a, b) => orden[a.clase] - orden[b.clase] || (a.cobertura ?? 0) - (b.cobertura ?? 0));
  return {
    cobertura: aj.cobertura, plazo: aj.plazoRepos, seguridad: aj.seguridad, ventana: aj.ventanaVentas,
    total: filasC.length, estimado: filasC.reduce((s, x) => s + (x.estimado || 0), 0), sinCosto: filasC.filter((x) => x.estimado == null).length,
    filas: filasC.slice(0, 300),
  };
}

export async function conteoAlertas(pool, ctx) {
  const a = await alertasStock(pool, ctx);
  return { stockAltas: a.resumen.altas, stockTotal: a.total };
}

// ---------- Pérdidas: anomalías, eventos y mermas ----------
const NUM_TOTAL = "CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(l.Message, 'total: ', -1), ',', 1) AS DECIMAL(18,2))";
const NUM_DESC = "CAST(SUBSTRING_INDEX(l.Message, ' a ', -1) AS DECIMAL(10,2))";
const LOGF = "l.UserRealTime >= ? AND l.UserRealTime < DATE_ADD(?, INTERVAL 1 DAY)";

export async function anomalias(pool, ctx) {
  const { desde, hasta } = ctx.r;
  const aj = ctx.aj;
  const [reg, vt, dv, cierres] = await Promise.all([
    filas(pool, `SELECT l.UserID AS id, MAX(u.Name) AS nombre,
        SUM(l.Message LIKE '%operación cancelada%') AS cancel,
        COALESCE(SUM(CASE WHEN l.Message LIKE '%operación cancelada%' THEN ${NUM_TOTAL} ELSE 0 END),0) AS cancelMonto,
        COALESCE(MAX(CASE WHEN l.Message LIKE '%operación cancelada%' THEN ${NUM_TOTAL} ELSE 0 END),0) AS cancelMax,
        SUM(l.Message LIKE 'Anular venta%') AS anuladas,
        SUM(l.Message LIKE '%se eliminó%') AS lineasElim,
        SUM(l.Message LIKE '%cambiado el descuento%') AS descuentos,
        SUM(l.Message LIKE '%cambiado el descuento%' AND ${NUM_DESC} >= ?) AS descAltos,
        SUM(l.Message LIKE 'Editar venta%' OR l.Message LIKE 'Editar devoluci%') AS ediciones,
        SUM(l.Message LIKE '%cajón de moneda%') AS cajon,
        SUM(l.Message LIKE 'Inicio fallido%') AS loginFallidos
      FROM applicationlog l LEFT JOIN users u ON u.ID = l.UserID WHERE ${LOGF} GROUP BY l.UserID`, [aj.descMax, desde, hasta]),
    filas(pool, `SELECT o.UserID AS id, SUM(${IMP}) AS total, COUNT(DISTINCT o.Acct) AS tickets FROM operations o WHERE ${VENTA} AND ${RANGO} GROUP BY o.UserID`, [desde, hasta]),
    filas(pool, `SELECT o.UserID AS id, SUM(${IMP}) AS total, COUNT(DISTINCT o.Acct) AS docs FROM operations o WHERE ${DEVOL} AND ${RANGO} GROUP BY o.UserID`, [desde, hasta]),
    caja(pool, { ...ctx, uid: null }, { todo: true }),
  ]);
  const vmap = new Map(vt.map((x) => [x.id, x]));
  const dmap = new Map(dv.map((x) => [x.id, x]));
  const usuarios = [];
  for (const r of reg) {
    const v = vmap.get(r.id), d = dmap.get(r.id);
    const tickets = num(v?.tickets), cancel = num(r.cancel);
    const tasaCancel = tickets + cancel > 0 ? cancel / (tickets + cancel) : 0;
    const elimPorTicket = tickets ? num(r.lineasElim) / tickets : 0;
    const tasaDev = num(v?.total) > 0 ? num(d?.total) / num(v.total) : 0;
    const flags = [];
    const marca = (tipo, nivel, texto) => flags.push({ tipo, nivel, texto });
    if (cancel >= 5 && tasaCancel >= 0.03) marca("cancelaciones", tasaCancel >= 0.06 ? "alta" : "media", `${cancel} cancelaciones (${(tasaCancel * 100).toFixed(1)} % de sus operaciones)`);
    if (num(r.cancelMax) >= aj.umbralCancel) marca("cancel_monto", "alta", `Cancelación de ${Math.round(num(r.cancelMax))} CUP (umbral ${aj.umbralCancel})`);
    if (elimPorTicket >= 0.6 && num(r.lineasElim) >= 20) marca("lineas", elimPorTicket >= 1.2 ? "alta" : "media", `${num(r.lineasElim)} productos quitados de tickets (${elimPorTicket.toFixed(2)} por ticket)`);
    if (num(r.descAltos) >= 3) marca("descuentos", num(r.descAltos) >= 10 ? "alta" : "media", `${num(r.descAltos)} descuentos manuales de ${aj.descMax} % o más`);
    if (tasaDev >= 0.02 && num(d?.docs) >= 3) marca("devoluciones", tasaDev >= 0.05 ? "alta" : "media", `Devoluciones por ${(tasaDev * 100).toFixed(1)} % de sus ventas (${num(d?.docs)} documentos)`);
    if (num(r.anuladas) >= 5) marca("anuladas", num(r.anuladas) >= 15 ? "alta" : "media", `${num(r.anuladas)} ventas anuladas`);
    if (num(r.loginFallidos) >= 3) marca("login", num(r.loginFallidos) >= 10 ? "alta" : "media", `${num(r.loginFallidos)} inicios de sesión fallidos`);
    usuarios.push({
      id: r.id, nombre: r.id == -1 ? "Desconocido" : r.nombre || `Usuario ${r.id}`, tickets,
      cancel, cancelMonto: num(r.cancelMonto), cancelMax: num(r.cancelMax), anuladas: num(r.anuladas), lineasElim: num(r.lineasElim),
      descuentos: num(r.descuentos), descAltos: num(r.descAltos), ediciones: num(r.ediciones), cajon: num(r.cajon),
      loginFallidos: num(r.loginFallidos), devoluciones: num(d?.total), devDocs: num(d?.docs), tasaCancel, elimPorTicket, tasaDev, flags,
    });
  }
  // Turnos con diferencia de caja, por usuario
  const turnosDif = cierres.filas.filter((t) => t.nivel === "media" || t.nivel === "alta");
  const gravedad = (u) => u.flags.reduce((s, f) => s + (f.nivel === "alta" ? 3 : 1), 0);
  usuarios.sort((a, b) => gravedad(b) - gravedad(a) || b.cancel - a.cancel);
  return {
    desde, hasta, usuarios,
    totales: { alta: usuarios.reduce((s, u) => s + u.flags.filter((f) => f.nivel === "alta").length, 0), media: usuarios.reduce((s, u) => s + u.flags.filter((f) => f.nivel === "media").length, 0) },
    cierresConDiferencia: turnosDif.slice(0, 8).map((t) => ({ id: t.id, usuario: t.usuario, apertura: t.apertura, diferencia: t.diferencia, nivel: t.nivel })),
    criterios: { cancelTasa: "3 % (media) / 6 % (alta)", lineas: "0,6 (media) / 1,2 (alta) quitados por ticket", descuento: `${aj.descMax} % o más`, devolucion: "2 % (media) / 5 % (alta) de lo vendido", cierre: `${aj.tolCierre} CUP` },
  };
}

export async function eventos(pool, ctx, q) {
  const { desde, hasta } = ctx.r;
  const pagina = Math.max(parseInt(q.pagina, 10) || 1, 1);
  const filtros = {
    cancel: "l.Message LIKE '%operación cancelada%'",
    anular: "l.Message LIKE 'Anular venta%'",
    elim: "l.Message LIKE '%se eliminó%'",
    desc: "l.Message LIKE '%cambiado el descuento%'",
    login: "l.Message LIKE 'Inicio fallido%'",
    cajon: "l.Message LIKE '%cajón de moneda%'",
  };
  const cond = filtros[q.tipo] || filtros.cancel;
  const params = [desde, hasta];
  let extra = "";
  const u = parseInt(q.usuario, 10);
  if (Number.isInteger(u)) {
    extra = " AND l.UserID = ?";
    params.push(u);
  }
  const [[cuenta], lista] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS n FROM applicationlog l WHERE ${LOGF} AND ${cond}${extra}`, params),
    filas(pool, `SELECT l.ID AS id, DATE_FORMAT(l.UserRealTime,'%Y-%m-%d %H:%i') AS fecha, u.Name AS usuario, l.Message AS mensaje
      FROM applicationlog l LEFT JOIN users u ON u.ID = l.UserID WHERE ${LOGF} AND ${cond}${extra} ORDER BY l.UserRealTime DESC LIMIT 30 OFFSET ${(pagina - 1) * 30}`, params),
  ]);
  const n = num(cuenta[0].n);
  return { total: n, paginas: Math.max(Math.ceil(n / 30), 1), pagina, filas: lista.map((x) => ({ fecha: x.fecha, usuario: x.usuario || "—", mensaje: String(x.mensaje || "").replace(/\s+/g, " ").slice(0, 160) })) };
}

const CATEGORIAS = [
  ["vencimiento", /venc|caduc|expir/i],
  ["dano", /da[ñn]|roto|rota|quebr|rotur|defect|mal estado/i],
  ["robo", /robo|hurto|perd|extrav|falt|desapar/i],
];
const NOMBRE_CAT = { vencimiento: "Vencimiento", dano: "Daño o rotura", robo: "Robo o pérdida", sin_motivo: "Sin motivo anotado" };

export async function mermas(pool, ctx) {
  const { desde, hasta } = ctx.r;
  const lista = await filas(
    pool,
    `SELECT o.ID AS id, ${F} AS fecha, g.Name AS nombre, ABS(o.Qtty) AS cantidad, o.PriceIn AS costoOp, g.PriceIn AS costoFicha, ${PRECIO} AS precio,
            o.Note AS nota, u.Name AS usuario, o.OperType AS tipo
     FROM operations o LEFT JOIN goods g ON g.ID = o.GoodID LEFT JOIN users u ON u.ID = o.UserID
     WHERE o.OperType IN (3, 11) AND ${RANGO} ORDER BY fecha DESC LIMIT 1000`,
    [desde, hasta]
  );
  const ventas = (await totalVentas(pool, { uid: null }, desde, hasta)).total;
  const cats = {};
  let total = 0, estimados = 0;
  const detalle = lista.map((x) => {
    const costo = num(x.costoOp) > 0 ? num(x.costoOp) : num(x.costoFicha) > 0 ? num(x.costoFicha) : null;
    const unit = costo ?? num(x.precio);
    const valor = num(x.cantidad) * unit;
    if (costo == null) estimados++;
    const cat = (CATEGORIAS.find(([, re]) => re.test(x.nota || "")) || ["sin_motivo"])[0];
    cats[cat] = cats[cat] || { cat, nombre: NOMBRE_CAT[cat], n: 0, valor: 0 };
    cats[cat].n++;
    cats[cat].valor += valor;
    total += valor;
    return { fecha: x.fecha, nombre: x.nombre, cantidad: num(x.cantidad), valor, nota: x.nota || "", usuario: x.usuario, categoria: cat, estimado: costo == null };
  });
  return {
    desde, hasta, total, movimientos: detalle.length, estimados, ventas, impacto: ventas > 0 ? total / ventas : 0,
    categorias: Object.values(cats).sort((a, b) => b.valor - a.valor), filas: detalle.slice(0, 60),
  };
}

export async function conteoPerdidas(pool, ctx) {
  const a = await anomalias(pool, ctx);
  return { anomaliasAltas: a.totales.alta, anomaliasMedias: a.totales.media };
}

// ---------- Usuarios de AxisPOS (para PIN y roles) ----------
export async function usuariosAxis(pool) {
  const l = await filas(
    pool,
    `SELECT u.ID AS id, u.Name AS nombre, u.UserLevel AS nivel, COALESCE(ug.Name,'Sistema') AS grupo
     FROM users u LEFT JOIN usersgroups ug ON ug.ID = u.GroupID WHERE COALESCE(u.Deleted,0) = 0 AND u.ID <> 1 ORDER BY u.Name`
  );
  return l.map((x) => ({ id: num(x.id), nombre: x.nombre, nivel: num(x.nivel), grupo: x.grupo }));
}

export async function comprobarPermisos(pool) {
  try {
    const r = await filas(pool, "SHOW GRANTS FOR CURRENT_USER()");
    const texto = r.map((x) => Object.values(x)[0]).join(" ");
    return /\b(INSERT|UPDATE|DELETE|DROP|ALTER|ALL PRIVILEGES)\b/i.test(texto) ? "escritura" : "lectura";
  } catch {
    return "desconocido";
  }
}
