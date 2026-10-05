// Ejercicios contables y cierre mensual.
import { Router } from 'express';
import { enEmpresa } from './db.js';
import { accion } from './sesion.js';
import { HttpError } from './util.js';

/** Crea el ejercicio (año calendario) con sus 12 periodos mensuales abiertos. */
export async function crearEjercicio(c, empresaId, anio) {
  if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) throw new HttpError(422, 'El año no es válido.');
  const { rows } = await c.query(
    `INSERT INTO ejercicios (empresa_id, anio, fecha_desde, fecha_hasta)
     VALUES ($1, $2::int, make_date($2::int, 1, 1), make_date($2::int, 12, 31)) RETURNING id`,
    [empresaId, anio],
  );
  await c.query(
    `INSERT INTO periodos (empresa_id, ejercicio_id, mes)
     SELECT $1, $2, gs::date
       FROM generate_series(make_date($3::int, 1, 1), make_date($3::int, 12, 1), interval '1 month') AS gs`,
    [empresaId, rows[0].id, anio],
  );
}

/** Ejercicio abierto que contiene la fecha, o error si no existe o está cerrado. */
export async function buscarEjercicio(c, empresaId, fecha) {
  const { rows } = await c.query(
    'SELECT id, anio, cerrado FROM ejercicios WHERE empresa_id = $1 AND $2::date BETWEEN fecha_desde AND fecha_hasta',
    [empresaId, fecha],
  );
  if (!rows[0]) throw new HttpError(422, `No hay un ejercicio que incluya la fecha ${fecha}. Crealo en Periodos.`);
  if (rows[0].cerrado) throw new HttpError(422, `El ejercicio ${rows[0].anio} está cerrado.`);
  return rows[0];
}

function validarMes(mes) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes ?? '')) throw new HttpError(400, 'El mes va con el formato AAAA-MM.');
  return `${mes}-01`;
}

const rutas = Router({ mergeParams: true });
export default rutas;

rutas.get('/', async (req, res) => {
  const datos = await enEmpresa(req.usuario, req.empresaId, 'lectura', async (c) => {
    const { rows: ej } = await c.query('SELECT anio FROM ejercicios WHERE empresa_id = $1 ORDER BY anio DESC', [req.empresaId]);
    const anios = ej.map((r) => r.anio);
    const actual = new Date().getFullYear();
    const pedido = Number(req.query.anio);
    const anio = Number.isInteger(pedido) && pedido > 0 ? pedido : (anios.includes(actual) || !anios.length ? actual : anios[0]);
    const { rows: periodos } = await c.query(
      `SELECT to_char(p.mes, 'YYYY-MM') AS mes, p.cerrado, us.nombre AS cerrado_por,
              to_char(p.cerrado_en, 'DD/MM/YYYY HH24:MI') AS cerrado_en,
              count(a.id) FILTER (WHERE a.estado = 'confirmado')::int AS asientos,
              count(a.id) FILTER (WHERE a.estado = 'borrador')::int   AS borradores
         FROM periodos p
         LEFT JOIN usuarios us ON us.id = p.cerrado_por
         LEFT JOIN asientos a ON a.empresa_id = p.empresa_id AND date_trunc('month', a.fecha) = p.mes
        WHERE p.empresa_id = $1 AND extract(year FROM p.mes) = $2
        GROUP BY p.id, us.nombre
        ORDER BY p.mes`,
      [req.empresaId, anio],
    );
    return { anios, anio, periodos };
  });
  res.render('periodos', datos);
});

// Cerrar: el contador. No se cierra un mes con borradores pendientes.
rutas.post('/:mes/cerrar', (req, res) => accion(req, res, destino(req), 'Mes cerrado.', async () => {
  const mes = validarMes(req.params.mes);
  await enEmpresa(req.usuario, req.empresaId, 'contador', async (c) => {
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM asientos
        WHERE empresa_id = $1 AND estado = 'borrador' AND date_trunc('month', fecha) = $2::date`,
      [req.empresaId, mes],
    );
    if (rows[0].n > 0) {
      throw new HttpError(422, `Hay ${rows[0].n} asiento(s) en borrador en ese mes. Confirmalos o eliminalos antes de cerrar.`);
    }
    const r = await c.query(
      'UPDATE periodos SET cerrado = true, cerrado_por = $3, cerrado_en = now() WHERE empresa_id = $1 AND mes = $2::date',
      [req.empresaId, mes, req.usuario.id],
    );
    if (!r.rowCount) throw new HttpError(404, 'Ese periodo no existe. Creá primero el ejercicio del año.');
  });
}));

// Reabrir: solo el supervisor. Queda registrado en la auditoría.
rutas.post('/:mes/reabrir', (req, res) => accion(req, res, destino(req), 'Mes reabierto.', async () => {
  const mes = validarMes(req.params.mes);
  await enEmpresa(req.usuario, req.empresaId, 'supervisor', async (c) => {
    const r = await c.query(
      'UPDATE periodos SET cerrado = false, cerrado_por = NULL, cerrado_en = NULL WHERE empresa_id = $1 AND mes = $2::date',
      [req.empresaId, mes],
    );
    if (!r.rowCount) throw new HttpError(404, 'Ese periodo no existe.');
  });
}));

rutas.post('/ejercicio', (req, res) => {
  const anio = Number(req.body.anio);
  return accion(req, res, `/empresas/${req.empresaId}/periodos?anio=${Number.isInteger(anio) ? anio : ''}`,
    `Ejercicio ${anio} creado con sus 12 meses.`,
    () => enEmpresa(req.usuario, req.empresaId, 'contador', (c) => crearEjercicio(c, req.empresaId, anio)));
});

function destino(req) {
  const anio = String(req.params.mes ?? '').slice(0, 4);
  return `/empresas/${req.empresaId}/periodos${/^\d{4}$/.test(anio) ? `?anio=${anio}` : ''}`;
}
