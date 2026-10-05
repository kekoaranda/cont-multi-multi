// Libro diario: validación de partida doble, consultas y páginas de asientos.
import { Router } from 'express';
import { enEmpresa } from './db.js';
import { avisar, accion } from './sesion.js';
import { listarCuentas } from './plan.js';
import { buscarEjercicio } from './periodos.js';
import { HttpError, esFecha, esId, gsSinCero, hoy, leerImporte, rango, sumar, traducirError, validarLineas, aLista } from './util.js';

// ----- Reglas -----

function validarCabecera(e) {
  if (!esFecha(e.fecha)) throw new HttpError(422, 'Indicá una fecha válida.');
  if (!e.concepto) throw new HttpError(422, 'Escribí el concepto del asiento.');
  if (e.concepto.length > 500) throw new HttpError(422, 'El concepto admite hasta 500 caracteres.');
}

// ----- Formulario -----


const texto = (v) => String(v ?? '').trim();

function leerFormulario(body) {
  return {
    id: esId(body.id) ? body.id : '',
    numero: texto(body.numero),
    fecha: texto(body.fecha),
    concepto: texto(body.concepto),
    lineas: aLista(body.lineas).map((l) => ({
      cuenta: texto(l.cuenta), debe: texto(l.debe), haber: texto(l.haber), detalle: texto(l.detalle),
    })),
  };
}

/** Convierte el formulario en datos de negocio, ignorando las filas vacías. */
function aEntrada(form) {
  const lineas = [];
  form.lineas.forEach((l, i) => {
    if (!l.cuenta && !l.debe && !l.haber) return;
    const campo = `Línea ${i + 1}`;
    lineas.push({ cuenta: l.cuenta, debe: leerImporte(l.debe, campo), haber: leerImporte(l.haber, campo), detalle: l.detalle || null });
  });
  return { fecha: form.fecha, concepto: form.concepto, lineas };
}

function completarLineas(form, n) {
  while (form.lineas.length < n) form.lineas.push({ cuenta: '', debe: '', haber: '', detalle: '' });
  return form;
}

// ----- Consultas -----

const SELECT_CABECERA = `
  SELECT a.id, a.numero, a.fecha, a.concepto, a.origen::text AS origen, a.estado::text AS estado,
         u.nombre AS creado_por, to_char(a.creado_en, 'DD/MM/YYYY HH24:MI') AS creado_en
    FROM asientos a LEFT JOIN usuarios u ON u.id = a.creado_por`;

async function conLineas(c, cabeceras) {
  if (!cabeceras.length) return [];
  const { rows } = await c.query(
    `SELECT l.asiento_id, l.id, c.codigo AS cuenta, c.nombre, l.debe, l.haber, l.detalle
       FROM asiento_lineas l JOIN cuentas c ON c.id = l.cuenta_id
      WHERE l.asiento_id = ANY($1::bigint[])
      ORDER BY l.asiento_id, l.id`,
    [cabeceras.map((a) => a.id)],
  );
  return cabeceras.map((a) => {
    const lineas = rows.filter((l) => l.asiento_id === a.id);
    return { ...a, lineas, totalDebe: sumar(lineas.map((l) => l.debe)), totalHaber: sumar(lineas.map((l) => l.haber)) };
  });
}

export async function listarAsientos(c, empresaId, { desde, hasta, estado, buscar }) {
  const { rows } = await c.query(
    `${SELECT_CABECERA}
      WHERE a.empresa_id = $1 AND a.fecha BETWEEN $2 AND $3
        AND ($4::text IS NULL OR a.estado::text = $4)
        AND ($5::text IS NULL OR a.concepto ILIKE '%' || $5 || '%')
      ORDER BY a.fecha DESC, a.numero DESC
      LIMIT 300`,
    [empresaId, desde, hasta, estado || null, buscar || null],
  );
  return conLineas(c, rows);
}

async function obtener(c, empresaId, id) {
  const { rows } = await c.query(`${SELECT_CABECERA} WHERE a.empresa_id = $1 AND a.id = $2`, [empresaId, id]);
  if (!rows[0]) throw new HttpError(404, 'Asiento no encontrado.');
  return (await conLineas(c, rows))[0];
}

// Traduce códigos de cuenta a ids e inserta todas las líneas en una sola consulta.
export async function insertarLineas(c, empresaId, asientoId, lineas) {
  const codigos = [...new Set(lineas.map((l) => l.cuenta))];
  const { rows } = await c.query(
    'SELECT id, codigo, imputable, activa FROM cuentas WHERE empresa_id = $1 AND codigo = ANY($2::text[])',
    [empresaId, codigos],
  );
  const porCodigo = new Map(rows.map((r) => [r.codigo, r]));
  const errores = [];
  for (const cod of codigos) {
    const cta = porCodigo.get(cod);
    if (!cta) errores.push(`La cuenta ${cod} no existe en esta empresa.`);
    else if (!cta.imputable) errores.push(`La cuenta ${cod} es agrupadora; usá una subcuenta imputable.`);
    else if (!cta.activa) errores.push(`La cuenta ${cod} está inactiva.`);
  }
  if (errores.length) throw new HttpError(422, 'Hay cuentas inválidas.', errores);
  await c.query(
    `INSERT INTO asiento_lineas (empresa_id, asiento_id, cuenta_id, debe, haber, detalle)
     SELECT $1, $2, t.cuenta_id, t.debe, t.haber, t.detalle
       FROM unnest($3::bigint[], $4::numeric[], $5::numeric[], $6::text[]) AS t(cuenta_id, debe, haber, detalle)`,
    [empresaId, asientoId, lineas.map((l) => porCodigo.get(l.cuenta).id),
      lineas.map((l) => l.debe), lineas.map((l) => l.haber), lineas.map((l) => l.detalle)],
  );
}

async function crear(c, empresaId, usuarioId, e, confirmar) {
  validarCabecera(e);
  validarLineas(e.lineas);
  const ejercicio = await buscarEjercicio(c, empresaId, e.fecha);
  // El número correlativo lo asigna un trigger de la base, con bloqueo para evitar duplicados.
  const { rows } = await c.query(
    `INSERT INTO asientos (empresa_id, ejercicio_id, fecha, concepto, origen, estado, creado_por)
     VALUES ($1, $2, $3, $4, 'manual', 'borrador', $5) RETURNING id`,
    [empresaId, ejercicio.id, e.fecha, e.concepto, usuarioId],
  );
  await insertarLineas(c, empresaId, rows[0].id, e.lineas);
  if (confirmar) await c.query("UPDATE asientos SET estado = 'confirmado' WHERE id = $1", [rows[0].id]);
  return obtener(c, empresaId, rows[0].id);
}

/** Solo se editan borradores. Un asiento confirmado se anula y se registra uno nuevo. */
async function actualizar(c, empresaId, id, e, confirmar) {
  validarCabecera(e);
  validarLineas(e.lineas);
  const { rows } = await c.query(
    'SELECT estado::text AS estado, ejercicio_id FROM asientos WHERE empresa_id = $1 AND id = $2 FOR UPDATE',
    [empresaId, id],
  );
  if (!rows[0]) throw new HttpError(404, 'Asiento no encontrado.');
  if (rows[0].estado !== 'borrador') {
    throw new HttpError(422, 'Solo se editan borradores. Para corregir un asiento confirmado, anulalo y registrá uno nuevo.');
  }
  const ejercicio = await buscarEjercicio(c, empresaId, e.fecha);
  if (String(ejercicio.id) !== String(rows[0].ejercicio_id)) {
    throw new HttpError(422, 'La nueva fecha cae en otro ejercicio. Eliminá el borrador y crealo en el ejercicio correcto.');
  }
  await c.query('DELETE FROM asiento_lineas WHERE asiento_id = $1', [id]);
  await c.query('UPDATE asientos SET fecha = $2, concepto = $3 WHERE id = $1', [id, e.fecha, e.concepto]);
  await insertarLineas(c, empresaId, id, e.lineas);
  if (confirmar) await c.query("UPDATE asientos SET estado = 'confirmado' WHERE id = $1", [id]);
  return obtener(c, empresaId, id);
}

// ----- Rutas -----

const rutas = Router({ mergeParams: true });
export default rutas;

rutas.get('/', async (req, res) => {
  const { desde, hasta } = rango(req.query);
  const estado = ['borrador', 'confirmado', 'anulado'].includes(req.query.estado) ? req.query.estado : '';
  const buscar = texto(req.query.buscar);
  const asientos = await enEmpresa(req.usuario, req.empresaId, 'lectura',
    (c) => listarAsientos(c, req.empresaId, { desde, hasta, estado, buscar }));
  res.render('diario', { asientos, desde, hasta, estado, buscar });
});

async function mostrarFormulario(req, res, form, status = 200) {
  if (!res.locals.ctx.puede('auxiliar')) throw new HttpError(403, 'Tu rol en esta empresa no permite cargar asientos.');
  const cuentas = await enEmpresa(req.usuario, req.empresaId, 'lectura', (c) => listarCuentas(c, req.empresaId, true));
  res.status(status).render('asiento-form', { form: completarLineas(form, 2), cuentas });
}

rutas.get('/nuevo', (req, res) =>
  mostrarFormulario(req, res, completarLineas({ id: '', numero: '', fecha: hoy(), concepto: '', lineas: [] }, 4)));

rutas.get('/:id/editar', async (req, res) => {
  if (!esId(req.params.id)) throw new HttpError(404, 'Asiento no encontrado.');
  const a = await enEmpresa(req.usuario, req.empresaId, 'auxiliar', (c) => obtener(c, req.empresaId, req.params.id));
  if (a.estado !== 'borrador') {
    throw new HttpError(422, 'Solo se editan borradores. Para corregir un asiento confirmado, anulalo y registrá uno nuevo.');
  }
  const form = {
    id: String(a.id), numero: String(a.numero), fecha: a.fecha, concepto: a.concepto,
    lineas: a.lineas.map((l) => ({ cuenta: l.cuenta, debe: gsSinCero(l.debe), haber: gsSinCero(l.haber), detalle: l.detalle ?? '' })),
  };
  return mostrarFormulario(req, res, completarLineas(form, form.lineas.length + 1));
});

/**
 * Un solo destino para los botones del formulario:
 * accion=agregarLinea vuelve a mostrarlo con una fila más; borrador y confirmar guardan.
 */
rutas.post('/guardar', async (req, res) => {
  const form = leerFormulario(req.body);
  const boton = req.body.accion;
  if (boton === 'agregarLinea') return mostrarFormulario(req, res, completarLineas(form, form.lineas.length + 1));
  const confirmar = boton === 'confirmar';
  try {
    const entrada = aEntrada(form);
    const a = await enEmpresa(req.usuario, req.empresaId, confirmar ? 'contador' : 'auxiliar', (c) => (form.id
      ? actualizar(c, req.empresaId, form.id, entrada, confirmar)
      : crear(c, req.empresaId, req.usuario.id, entrada, confirmar)));
    avisar(req, { ok: `Asiento N.º ${a.numero} ${confirmar ? 'confirmado' : 'guardado como borrador'}.` });
    const anio = a.fecha.slice(0, 4);
    res.redirect(`/empresas/${req.empresaId}/diario?desde=${anio}-01-01&hasta=${anio}-12-31`);
  } catch (err) {
    // Volvemos al formulario con lo que el usuario escribió y el motivo del rechazo.
    const p = traducirError(err);
    if (!p) throw err;
    res.locals.error = p.mensaje;
    res.locals.detalles = p.detalles;
    return mostrarFormulario(req, res, form, p.status);
  }
});

function accionAsiento(ruta, rolMinimo, exito, operacion) {
  rutas.post(`/:id/${ruta}`, (req, res) => accion(req, res, `/empresas/${req.empresaId}/diario`, exito, async () => {
    if (!esId(req.params.id)) throw new HttpError(404, 'Asiento no encontrado.');
    await enEmpresa(req.usuario, req.empresaId, rolMinimo, (c) => operacion(c, req.empresaId, req.params.id));
  }));
}

accionAsiento('confirmar', 'contador', 'Asiento confirmado.', async (c, e, id) => {
  const r = await c.query("UPDATE asientos SET estado = 'confirmado' WHERE empresa_id = $1 AND id = $2 AND estado = 'borrador'", [e, id]);
  if (!r.rowCount) throw new HttpError(422, 'El asiento no existe o no está en borrador.');
});

accionAsiento('anular', 'contador', 'Asiento anulado. Queda en el diario como constancia.', async (c, e, id) => {
  const r = await c.query(
    "UPDATE asientos SET estado = 'anulado' WHERE empresa_id = $1 AND id = $2 AND estado = 'confirmado' AND origen = 'manual'",
    [e, id],
  );
  if (!r.rowCount) throw new HttpError(422, 'Solo se anulan asientos manuales confirmados.');
});

accionAsiento('eliminar', 'auxiliar', 'Borrador eliminado.', async (c, e, id) => {
  const { rows } = await c.query('SELECT 1 FROM comprobantes WHERE empresa_id = $1 AND asiento_id = $2', [e, id]);
  if (rows.length) throw new HttpError(422, 'Este asiento viene de un comprobante: eliminalo desde Comprobantes.');
  const r = await c.query("DELETE FROM asientos WHERE empresa_id = $1 AND id = $2 AND estado = 'borrador'", [e, id]);
  if (!r.rowCount) throw new HttpError(422, 'Solo se eliminan borradores. Un asiento confirmado se anula.');
});
