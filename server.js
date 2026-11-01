// Retoque · API. PostgreSQL = datos persistentes · Redis = datos temporales (sesiones, reservas en curso, límite de intentos)
const express = require('express');
const { Pool } = require('pg');
const { createClient } = require('redis');
const crypto = require('crypto');

const pg = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/retoque' });
const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
const app = express();
app.use(express.json());
app.use(express.static(__dirname + '/public'));

const OPEN = 540, CLOSE = 1080, STEP = 30, HOLD_TTL = 300, SESSION_TTL = 86400; // 9:00-18:00, bloques de 30 min
const toMin = t => { const [a, b] = String(t).split(':'); return +a * 60 + +b; };
const toHM = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const E = (status, message) => Object.assign(new Error(message), { status });
const h = fn => (req, res) => fn(req, res).catch(e => { if (!e.status) console.error(e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Error interno' }); });
const nowDR = () => { const d = new Date(Date.now() - 4 * 3600e3); return { fecha: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() }; };
const checkFecha = f => { if (!/^\d{4}-\d{2}-\d{2}$/.test(f || '')) throw E(400, 'Fecha inválida'); };
const pasado = (f, ini) => { const n = nowDR(); return f < n.fecha || (f === n.fecha && ini <= n.min); };

const hashPw = pw => { const s = crypto.randomBytes(16).toString('hex'); return s + ':' + crypto.scryptSync(pw, s, 32).toString('hex'); };
const checkPw = (pw, st) => { const [s, k] = st.split(':'); return crypto.timingSafeEqual(Buffer.from(k, 'hex'), crypto.scryptSync(pw, s, 32)); };
const pub = u => ({ id: u.id_cliente, nombre: u.nombre, apellido: u.apellido, email: u.email, telefono: u.telefono, preferencias: u.preferencias, admin: u.es_admin });

// ---------- Sesiones (Redis, expiran solas) ----------
async function newSession(u) {
  const token = crypto.randomUUID();
  await redis.set('sess:' + token, JSON.stringify({ id: u.id_cliente, admin: u.es_admin }), { EX: SESSION_TTL });
  return { token, user: pub(u) };
}
const need = admin => async (req, res, next) => {
  try {
    const t = (req.headers.authorization || '').slice(7);
    const s = t && await redis.get('sess:' + t);
    if (!s) throw E(401, 'Inicia sesión para continuar');
    const u = JSON.parse(s);
    if (admin && !u.admin) throw E(403, 'Solo administración');
    await redis.expire('sess:' + t, SESSION_TTL);
    req.u = u; req.t = t; next();
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
};
async function limit(req) {
  const k = 'rl:login:' + req.ip; const n = await redis.incr(k);
  if (n === 1) await redis.expire(k, 60);
  if (n > 10) throw E(429, 'Demasiados intentos. Espera un minuto.');
}

// ---------- Perfiles ----------
app.post('/api/registro', h(async (req, res) => {
  const { nombre, apellido, telefono, email, password, preferencias } = req.body;
  if (!nombre || !apellido || !telefono || !email || !password || password.length < 6) throw E(400, 'Completa todos los campos (contraseña de mínimo 6 caracteres)');
  try {
    const { rows } = await pg.query('INSERT INTO clientes (nombre,apellido,telefono,email,password_hash,preferencias) VALUES ($1,$2,$3,lower($4),$5,$6) RETURNING *', [nombre, apellido, telefono, email, hashPw(password), preferencias || null]);
    res.json(await newSession(rows[0]));
  } catch (e) { if (e.code === '23505') throw E(409, 'Ya existe un perfil con ese correo o teléfono'); throw e; }
}));
app.post('/api/login', h(async (req, res) => {
  await limit(req);
  const { rows } = await pg.query('SELECT * FROM clientes WHERE email=lower($1)', [req.body.email || '']);
  if (!rows[0] || !checkPw(req.body.password || '', rows[0].password_hash)) throw E(401, 'Correo o contraseña incorrectos');
  res.json(await newSession(rows[0]));
}));
app.post('/api/logout', need(), h(async (req, res) => { await redis.del('sess:' + req.t); res.json({ ok: true }); }));
app.get('/api/yo', need(), h(async (req, res) => res.json(pub((await pg.query('SELECT * FROM clientes WHERE id_cliente=$1', [req.u.id])).rows[0]))));
app.put('/api/yo', need(), h(async (req, res) => {
  const { nombre, apellido, telefono, preferencias } = req.body;
  if (!nombre || !apellido || !telefono) throw E(400, 'Nombre, apellido y teléfono son obligatorios');
  try { res.json(pub((await pg.query('UPDATE clientes SET nombre=$1,apellido=$2,telefono=$3,preferencias=$4 WHERE id_cliente=$5 RETURNING *', [nombre, apellido, telefono, preferencias || null, req.u.id])).rows[0])); }
  catch (e) { if (e.code === '23505') throw E(409, 'Ese teléfono ya está en uso'); throw e; }
}));

// ---------- Catálogo y disponibilidad ----------
app.get('/api/servicios', h(async (_, res) => res.json((await pg.query('SELECT * FROM servicios ORDER BY area, precio')).rows)));
app.get('/api/empleados', h(async (_, res) => res.json((await pg.query('SELECT id_empleado,nombre,apellido,area,especialidad FROM empleados WHERE activo ORDER BY area, nombre')).rows)));

async function busy(emp, fecha, ignoreId, me) { // intervalos ocupados: citas en PostgreSQL + reservas en curso de otros en Redis
  const { rows } = await pg.query(`SELECT to_char(c.hora,'HH24:MI') hora, COALESCE(SUM(s.duracion_min),30)::int dur
    FROM citas c LEFT JOIN detalle_cita d ON d.id_cita=c.id_cita LEFT JOIN servicios s ON s.id_servicio=d.id_servicio
    WHERE c.id_empleado=$1 AND c.fecha=$2 AND c.estado<>'Cancelada' AND c.id_cita<>$3 GROUP BY c.id_cita, c.hora`, [emp, fecha, ignoreId || 0]);
  const b = rows.map(r => [toMin(r.hora), toMin(r.hora) + r.dur]);
  for await (const k of redis.scanIterator({ MATCH: `hold:${emp}:${fecha}:*` })) {
    const v = JSON.parse(await redis.get(k) || 'null');
    if (v && v.cliente !== me) b.push([v.ini, v.ini + v.dur]);
  }
  return b;
}
const libre = (b, ini, dur) => ini >= OPEN && ini + dur <= CLOSE && b.every(([x, y]) => ini + dur <= x || ini >= y);

app.get('/api/disponibilidad', need(), h(async (req, res) => {
  const { empleado, fecha } = req.query; const dur = +req.query.dur || 30; checkFecha(fecha);
  const b = await busy(+empleado, fecha, +req.query.ignorar, req.u.id); const out = [];
  for (let m = OPEN; m + dur <= CLOSE; m += STEP) out.push({ hora: toHM(m), libre: libre(b, m, dur) && !pasado(fecha, m) });
  res.json(out);
}));

async function plan(emp, ids) {
  const e = (await pg.query('SELECT area FROM empleados WHERE id_empleado=$1 AND activo', [emp])).rows[0];
  if (!e) throw E(404, 'Profesional no encontrado');
  ids = [...new Set(ids || [])];
  const { rows } = await pg.query('SELECT * FROM servicios WHERE id_servicio = ANY($1) AND area=$2', [ids, e.area]);
  if (!rows.length || rows.length !== ids.length) throw E(400, 'Selecciona servicios válidos para este profesional');
  return { servicios: rows, dur: rows.reduce((a, s) => a + s.duracion_min, 0), total: rows.reduce((a, s) => a + +s.precio, 0) };
}

// ---------- Reserva en dos pasos: bloqueo temporal (Redis, 5 min) y confirmación (PostgreSQL) ----------
async function soltar(uid) { const k = await redis.get('userhold:' + uid); if (k) await redis.del([k, 'userhold:' + uid]); }
app.post('/api/hold', need(), h(async (req, res) => {
  const { empleado, fecha, hora, servicios } = req.body; checkFecha(fecha);
  const p = await plan(empleado, servicios); const ini = toMin(hora);
  if (pasado(fecha, ini)) throw E(400, 'Esa hora ya pasó');
  if (!libre(await busy(empleado, fecha, 0, req.u.id), ini, p.dur)) throw E(409, 'Ese horario ya no está disponible');
  await soltar(req.u.id);
  const key = `hold:${empleado}:${fecha}:${hora}`;
  const ok = await redis.set(key, JSON.stringify({ cliente: req.u.id, ini, dur: p.dur, empleado, fecha, hora, servicios }), { NX: true, EX: HOLD_TTL });
  if (!ok) throw E(409, 'Otra persona está reservando ese horario en este momento');
  await redis.set('userhold:' + req.u.id, key, { EX: HOLD_TTL });
  res.json({ expira: HOLD_TTL, total: p.total, dur: p.dur });
}));
app.delete('/api/hold', need(), h(async (req, res) => { await soltar(req.u.id); res.json({ ok: true }); }));

app.post('/api/citas', need(), h(async (req, res) => {
  const key = await redis.get('userhold:' + req.u.id); const raw = key && await redis.get(key);
  if (!raw) throw E(410, 'Tu reserva temporal expiró. Elige el horario de nuevo.');
  const v = JSON.parse(raw); const p = await plan(v.empleado, v.servicios); const c = await pg.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query('INSERT INTO citas (id_cliente,id_empleado,fecha,hora) VALUES ($1,$2,$3,$4) RETURNING id_cita', [req.u.id, v.empleado, v.fecha, v.hora]);
    for (const s of p.servicios) await c.query('INSERT INTO detalle_cita VALUES ($1,$2,$3)', [rows[0].id_cita, s.id_servicio, s.precio]);
    await c.query('COMMIT');
    await redis.del([key, 'userhold:' + req.u.id]);
    res.json({ id: rows[0].id_cita });
  } catch (e) { await c.query('ROLLBACK'); if (e.code === '23505') throw E(409, 'Ese horario acaba de ser ocupado'); throw e; }
  finally { c.release(); }
}));

const CITAS = `SELECT c.id_cita, c.fecha::text fecha, to_char(c.hora,'HH24:MI') hora, c.estado, c.id_cliente, cl.nombre||' '||cl.apellido cliente,
  e.id_empleado, e.nombre||' '||e.apellido empleado, e.area, string_agg(s.nombre, ', ') servicios, SUM(d.precio_cobrado) total, SUM(s.duracion_min)::int dur
  FROM citas c JOIN clientes cl ON cl.id_cliente=c.id_cliente JOIN empleados e ON e.id_empleado=c.id_empleado
  JOIN detalle_cita d ON d.id_cita=c.id_cita JOIN servicios s ON s.id_servicio=d.id_servicio`;
const GRP = ' GROUP BY c.id_cita, cl.id_cliente, e.id_empleado';
app.get('/api/citas', need(), h(async (req, res) => res.json((await pg.query(CITAS + ' WHERE c.id_cliente=$1' + GRP + ' ORDER BY c.fecha DESC, c.hora DESC', [req.u.id])).rows)));

async function propia(req) {
  const r = (await pg.query(CITAS + ' WHERE c.id_cita=$1' + GRP, [req.params.id])).rows[0];
  if (!r || (r.id_cliente !== req.u.id && !req.u.admin)) throw E(404, 'Cita no encontrada');
  if (r.estado !== 'Programada') throw E(409, 'Solo se pueden cambiar citas programadas');
  return r;
}
app.post('/api/citas/:id/cancelar', need(), h(async (req, res) => {
  const r = await propia(req); await pg.query("UPDATE citas SET estado='Cancelada' WHERE id_cita=$1", [r.id_cita]); res.json({ ok: true });
}));
app.put('/api/citas/:id', need(), h(async (req, res) => { // reprogramar
  const r = await propia(req); const { fecha, hora } = req.body; checkFecha(fecha); const ini = toMin(hora);
  if (pasado(fecha, ini)) throw E(400, 'Esa hora ya pasó');
  if (!libre(await busy(r.id_empleado, fecha, r.id_cita, req.u.id), ini, r.dur)) throw E(409, 'Ese horario no está disponible');
  try { await pg.query('UPDATE citas SET fecha=$1, hora=$2 WHERE id_cita=$3', [fecha, hora, r.id_cita]); }
  catch (e) { if (e.code === '23505') throw E(409, 'Ese horario acaba de ser ocupado'); throw e; }
  res.json({ ok: true });
}));

// ---------- Administración ----------
app.get('/api/admin/resumen', need(true), h(async (req, res) => {
  const fecha = req.query.fecha || nowDR().fecha; checkFecha(fecha);
  const [agenda, ingresos, productos] = await Promise.all([
    pg.query(CITAS + ' WHERE c.fecha=$1' + GRP + ' ORDER BY c.hora', [fecha]),
    pg.query('SELECT fecha::text, SUM(monto) total FROM v_ingresos GROUP BY fecha ORDER BY fecha DESC LIMIT 7'),
    pg.query('SELECT * FROM productos ORDER BY nombre')]);
  res.json({ fecha, agenda: agenda.rows, ingresos: ingresos.rows, productos: productos.rows });
}));
app.post('/api/admin/citas/:id/completar', need(true), h(async (req, res) => {
  const r = await pg.query("UPDATE citas SET estado='Completada' WHERE id_cita=$1 AND estado='Programada'", [req.params.id]);
  if (!r.rowCount) throw E(409, 'La cita no está programada'); res.json({ ok: true });
}));
app.post('/api/admin/ventas', need(true), h(async (req, res) => {
  const { id_producto, cantidad = 1 } = req.body; const c = await pg.connect();
  try {
    await c.query('BEGIN');
    const u = await c.query('UPDATE productos SET stock=stock-$2 WHERE id_producto=$1 AND stock>=$2 RETURNING stock', [id_producto, cantidad]);
    if (!u.rowCount) throw E(409, 'Stock insuficiente');
    await c.query('INSERT INTO ventas_producto (id_producto,cantidad,fecha) VALUES ($1,$2,$3)', [id_producto, cantidad, nowDR().fecha]);
    await c.query('COMMIT'); res.json({ stock: u.rows[0].stock });
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}));

(async () => {
  await redis.connect();
  await pg.query("INSERT INTO clientes (nombre,apellido,telefono,email,password_hash,es_admin) VALUES ('Administración','Retoque','000-000-0000','admin@retoque.do',$1,true) ON CONFLICT DO NOTHING", [hashPw('admin123')]);
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('Retoque en http://localhost:' + port));
})().catch(e => { console.error('No se pudo iniciar (¿PostgreSQL y Redis activos?):', e.message); process.exit(1); });
