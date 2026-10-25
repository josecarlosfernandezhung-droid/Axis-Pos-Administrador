// Servidor del Panel AxisPOS: lee MariaDB (solo lectura) y sirve la pantalla.
// El usuario/contraseña de MariaDB se escriben al iniciar sesión; no quedan guardados en ningún archivo.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { dirname, join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const WWW = join(dirname(fileURLToPath(import.meta.url)), "..", "www");
const SESION_MS = 12 * 60 * 60 * 1000;
const sesiones = new Map(); // token -> { pool, expira }

const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
};

// Fecha real de la venta (igual que el conversor de AxisPOS): UserRealTime si es válida, si no Date.
const VENTAS = `(SELECT IF(o.UserRealTime BETWEEN '2020-01-01' AND '2036-12-31 23:59:59', o.UserRealTime, o.\`Date\`) AS f,
    ABS(o.Qtty) AS q, o.PriceOut AS p, IF(o.Discount BETWEEN 0 AND 100, o.Discount, 0) AS d,
    o.Acct AS acct, o.GoodID AS gid
  FROM operations o WHERE o.OperType = 2 AND COALESCE(o.Sign, 0) <= 0) v`;
const IMPORTE = "v.q * v.p * (1 - v.d / 100)";
const PRECIO =
  "COALESCE(NULLIF(g.PriceOut2,0), NULLIF(g.PriceOut1,0), NULLIF(g.PriceOut3,0), 0)";

const ymd = (d) => d.toISOString().slice(0, 10);
const esFecha = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");

const consultas = {
  async resumen(pool, q) {
    const hasta = esFecha(q.hasta) ? q.hasta : ymd(new Date());
    const dias = Math.min(Math.max(parseInt(q.dias, 10) || 30, 1), 366);
    const desde = esFecha(q.desde)
      ? q.desde
      : ymd(new Date(new Date(hasta + "T00:00:00Z").getTime() - (dias - 1) * 864e5));
    const rango = "v.f >= ? AND v.f < DATE_ADD(?, INTERVAL 1 DAY)";
    const [[tot]] = await pool.query(
      `SELECT COALESCE(SUM(${IMPORTE}),0) AS total, COUNT(DISTINCT v.acct) AS tickets,
              COALESCE(SUM(v.q),0) AS unidades FROM ${VENTAS} WHERE ${rango}`,
      [desde, hasta]
    );
    const [porDia] = await pool.query(
      `SELECT DATE_FORMAT(v.f,'%Y-%m-%d') AS dia, SUM(${IMPORTE}) AS total, COUNT(DISTINCT v.acct) AS tickets
       FROM ${VENTAS} WHERE ${rango} GROUP BY dia ORDER BY dia`,
      [desde, hasta]
    );
    const [top] = await pool.query(
      `SELECT g.Name AS nombre, SUM(v.q) AS unidades, SUM(${IMPORTE}) AS total
       FROM ${VENTAS} JOIN goods g ON g.ID = v.gid WHERE ${rango}
       GROUP BY v.gid, g.Name ORDER BY total DESC LIMIT 10`,
      [desde, hasta]
    );
    return { desde, hasta, ...tot, porDia, top };
  },

  async productos(pool, q) {
    const txt = `%${String(q.q || "").trim().slice(0, 60)}%`;
    const [filas] = await pool.query(
      `SELECT g.ID AS id, g.Code AS codigo, g.Name AS nombre, gg.Name AS grupo,
              g.PriceIn AS costo, ${PRECIO} AS precio, COALESCE(s.cant,0) AS existencia
       FROM goods g
       LEFT JOIN goodsgroups gg ON gg.ID = g.GroupID
       LEFT JOIN (SELECT GoodID, SUM(Qtty) AS cant FROM store GROUP BY GoodID) s ON s.GoodID = g.ID
       WHERE COALESCE(g.Deleted,0) = 0 AND (g.Name LIKE ? OR g.Code LIKE ? OR g.BarCode1 LIKE ?)
       ORDER BY g.Name LIMIT 100`,
      [txt, txt, txt]
    );
    return { filas };
  },

  async existencias(pool, q) {
    const txt = `%${String(q.q || "").trim().slice(0, 60)}%`;
    const [almacenes] = await pool.query(
      `SELECT o.ID AS id, o.Name AS nombre, COALESCE(SUM(s.Qtty),0) AS unidades,
              COALESCE(SUM(CASE WHEN s.Qtty > 0 THEN s.Qtty * s.Price ELSE 0 END),0) AS valor
       FROM objects o LEFT JOIN store s ON s.ObjectID = o.ID
       WHERE COALESCE(o.Deleted,0) = 0 GROUP BY o.ID, o.Name
       HAVING COUNT(s.ID) > 0 ORDER BY o.Name`
    );
    const almacen = parseInt(q.almacen, 10);
    const params = [txt, txt];
    let filtro = "";
    if (Number.isInteger(almacen)) {
      filtro = "AND s.ObjectID = ?";
      params.push(almacen);
    }
    const [filas] = await pool.query(
      `SELECT g.ID AS id, g.Name AS nombre, o.Name AS almacen, SUM(s.Qtty) AS cantidad
       FROM store s JOIN goods g ON g.ID = s.GoodID JOIN objects o ON o.ID = s.ObjectID
       WHERE (g.Name LIKE ? OR g.Code LIKE ?) ${filtro}
       GROUP BY s.ObjectID, o.Name, s.GoodID, g.Name HAVING ABS(SUM(s.Qtty)) > 0.0005
       ORDER BY g.Name LIMIT 200`,
      params
    );
    return { almacenes, filas };
  },

  async caja(pool) {
    const [filas] = await pool.query(
      `SELECT sh.ID AS id, o.Name AS almacen, u.Name AS usuario,
              DATE_FORMAT(sh.DateTimeOpen,'%Y-%m-%d %H:%i') AS apertura,
              DATE_FORMAT(sh.DateTimeClose,'%Y-%m-%d %H:%i') AS cierre,
              sh.TotalOpen AS inicial, sh.TotalFinal AS final,
              sh.TotalWithdrawal AS retiro, sh.DiffClose AS diferencia, sh.Status AS estado
       FROM shift sh LEFT JOIN objects o ON o.ID = sh.ObjectID LEFT JOIN users u ON u.ID = sh.UserID
       ORDER BY sh.DateTimeOpen DESC LIMIT 40`
    );
    return { filas };
  },
};

function ipsLocales() {
  const ips = [];
  for (const lista of Object.values(networkInterfaces()))
    for (const i of lista || []) if (i.family === "IPv4" && !i.internal) ips.push(i.address);
  return ips;
}

function responder(res, estado, datos) {
  const cuerpo = JSON.stringify(datos);
  res.writeHead(estado, { "Content-Type": "application/json; charset=utf-8" });
  res.end(cuerpo);
}

function leerJson(req) {
  return new Promise((ok, mal) => {
    let txt = "";
    req.on("data", (c) => {
      txt += c;
      if (txt.length > 10_000) {
        mal(new Error("Cuerpo demasiado grande"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        ok(JSON.parse(txt || "{}"));
      } catch {
        mal(new Error("JSON inválido"));
      }
    });
    req.on("error", mal);
  });
}

function mensajeDeError(e, host, puerto) {
  if (e.code === "ER_ACCESS_DENIED_ERROR") return "Usuario o contraseña de MariaDB incorrectos.";
  if (e.code === "ER_BAD_DB_ERROR") return "Esa base de datos no existe en MariaDB.";
  if (e.code === "ECONNREFUSED" || e.code === "ETIMEDOUT" || e.code === "ENOTFOUND")
    return `No se pudo conectar a MariaDB en ${host}:${puerto}. ¿Está encendido?`;
  return "No se pudo iniciar sesión: " + (e.message || e.code || "error desconocido");
}

async function login(req, res) {
  const b = await leerJson(req);
  const host = String(b.host || "127.0.0.1").trim();
  const puerto = parseInt(b.puerto, 10) || 3306;
  const base = String(b.base || "axispos_prueba").trim();
  const pool = mysql.createPool({
    host,
    port: puerto,
    user: String(b.usuario || ""),
    password: String(b.clave || ""),
    database: base,
    connectionLimit: 3,
    connectTimeout: 6000,
    charset: "utf8mb4",
    dateStrings: true,
    decimalNumbers: true,
  });
  try {
    await pool.query("SELECT 1");
  } catch (e) {
    await pool.end().catch(() => {});
    await new Promise((r) => setTimeout(r, 800)); // frena adivinar contraseñas
    return responder(res, 401, { error: mensajeDeError(e, host, puerto) });
  }
  const token = randomBytes(24).toString("hex");
  sesiones.set(token, { pool, expira: Date.now() + SESION_MS });
  responder(res, 200, { token });
}

function sesionDe(req) {
  const m = /^Bearer (\w+)$/.exec(req.headers.authorization || "");
  const s = m && sesiones.get(m[1]);
  if (!s) return null;
  if (s.expira < Date.now()) {
    s.pool.end().catch(() => {});
    sesiones.delete(m[1]);
    return null;
  }
  s.expira = Date.now() + SESION_MS;
  return { token: m[1], ...s };
}

async function estatico(res, ruta) {
  const limpio = normalize(ruta === "/" ? "/index.html" : ruta).replace(/^([/\\])+/, "");
  if (limpio.startsWith("..")) return responder(res, 404, { error: "No encontrado" });
  try {
    const datos = await readFile(join(WWW, limpio));
    res.writeHead(200, { "Content-Type": TIPOS[extname(limpio)] || "application/octet-stream" });
    res.end(datos);
  } catch {
    responder(res, 404, { error: "No encontrado" });
  }
}

async function manejar(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  const url = new URL(req.url, "http://x");
  const ruta = url.pathname;
  try {
    if (ruta === "/api/info") return responder(res, 200, { ips: ipsLocales() });
    if (ruta === "/api/login" && req.method === "POST") return await login(req, res);
    if (ruta === "/api/logout" && req.method === "POST") {
      const s = sesionDe(req);
      if (s) {
        sesiones.delete(s.token);
        s.pool.end().catch(() => {});
      }
      return responder(res, 200, { ok: true });
    }
    const m = /^\/api\/(\w+)$/.exec(ruta);
    if (m && consultas[m[1]]) {
      const s = sesionDe(req);
      if (!s) return responder(res, 401, { error: "Sesión vencida. Inicia sesión otra vez." });
      return responder(res, 200, await consultas[m[1]](s.pool, Object.fromEntries(url.searchParams)));
    }
    if (ruta.startsWith("/api/")) return responder(res, 404, { error: "No encontrado" });
    return await estatico(res, ruta);
  } catch (e) {
    console.error(e);
    responder(res, 500, { error: "Error al leer la base de datos: " + (e.message || e) });
  }
}

export function iniciar(puerto = 3000) {
  return new Promise((ok, mal) => {
    const srv = http.createServer(manejar);
    srv.once("error", mal);
    srv.listen(puerto, "0.0.0.0", () => ok(srv.address().port));
  });
}
