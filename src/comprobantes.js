// Comprobantes (libros de compras y ventas) e importación de XML de SIFEN con asiento automático.
import { Router } from 'express';
import multer from 'multer';
import { enEmpresa } from './db.js';
import { insertarLineas } from './diario.js';
import { buscarEjercicio } from './periodos.js';
import { listarCuentas } from './plan.js';
import { accion, avisar, verificarCsrf } from './sesion.js';
import { CUENTAS, TIPOS_DE, clasificar, concepto, extraerXml, importes, leerDocumento, lineasAsiento } from './sifen.js';
import { HttpError, aCentavos, deCentavos, esFecha, esId, rango, sumar, traducirError, validarLineas } from './util.js';

const rutas = Router({ mergeParams: true });
export default rutas;

// ----- Lista de comprobantes -----

rutas.get('/', async (req, res) => {
  const { desde, hasta } = rango(req.query);
  const libro = ['VENTA', 'COMPRA'].includes(req.query.libro) ? req.query.libro : '';
  const asiento = esId(req.query.asiento) ? req.query.asiento : null;
  const comprobantes = await enEmpresa(req.usuario, req.empresaId, 'lectura', async (c) => (await c.query(
    `SELECT co.id, co.libro::text AS libro, co.tipo_comprobante AS tipo, co.fecha, co.timbrado, co.numero, co.cdc,
            co.condicion::text AS condicion, co.moneda, co.iva_10, co.iva_5, co.total,
            t.ruc, t.dv, t.razon_social, a.id AS asiento_id, a.numero AS asiento_numero, a.estado::text AS asiento_estado
       FROM comprobantes co
       JOIN terceros t ON t.id = co.tercero_id
       LEFT JOIN asientos a ON a.id = co.asiento_id
      WHERE co.empresa_id = $1
        AND (($4::bigint IS NOT NULL AND co.asiento_id = $4) OR ($4::bigint IS NULL AND co.fecha BETWEEN $2 AND $3))
        AND ($5::text IS NULL OR co.libro::text = $5)
      ORDER BY co.fecha DESC, co.id DESC
      LIMIT 2000`,
    [req.empresaId, desde, hasta, asiento, libro || null],
  )).rows);

  // Totales del periodo: las notas de crédito restan.
  const t = { ventas: 0n, ivaVentas: 0n, compras: 0n, ivaCompras: 0n };
  for (const co of comprobantes) {
    const s = co.tipo === 5 ? -1n : 1n;
    const iva = aCentavos(co.iva_10) + aCentavos(co.iva_5);
    if (co.libro === 'VENTA') { t.ventas += s * aCentavos(co.total); t.ivaVentas += s * iva; }
    else { t.compras += s * aCentavos(co.total); t.ivaCompras += s * iva; }
  }
  const totales = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, deCentavos(v)]));
  totales.saldoIva = deCentavos(t.ivaVentas - t.ivaCompras);
  res.render('comprobantes', { comprobantes, desde, hasta, libro, asiento, totales, tipos: TIPOS_DE });
});

// Borrador: se elimina el comprobante con su asiento.
rutas.post('/:id/eliminar', (req, res) => accion(req, res, `/empresas/${req.empresaId}/comprobantes`,
  'Comprobante y asiento eliminados. Si hace falta, podés volver a importar el XML.', async () => {
    if (!esId(req.params.id)) throw new HttpError(404, 'Comprobante no encontrado.');
    await enEmpresa(req.usuario, req.empresaId, 'auxiliar', async (c) => {
      const co = await comprobanteConAsiento(c, req.empresaId, req.params.id);
      if (co.asiento_estado && co.asiento_estado !== 'borrador') {
        throw new HttpError(422, 'El asiento ya está confirmado: para dejarlo sin efecto, anulalo.');
      }
      await c.query('DELETE FROM comprobantes WHERE id = $1', [co.id]);
      if (co.asiento_id) await c.query('DELETE FROM asientos WHERE id = $1', [co.asiento_id]);
    });
  }));

// Confirmado: el asiento queda anulado en el diario como constancia y el comprobante sale del libro.
rutas.post('/:id/anular', (req, res) => accion(req, res, `/empresas/${req.empresaId}/comprobantes`,
  'Comprobante anulado. Su asiento queda en el diario como anulado.', async () => {
    if (!esId(req.params.id)) throw new HttpError(404, 'Comprobante no encontrado.');
    await enEmpresa(req.usuario, req.empresaId, 'contador', async (c) => {
      const co = await comprobanteConAsiento(c, req.empresaId, req.params.id);
      if (co.asiento_estado !== 'confirmado') throw new HttpError(422, 'Solo se anulan comprobantes con el asiento confirmado.');
      await c.query('DELETE FROM comprobantes WHERE id = $1', [co.id]);
      await c.query("UPDATE asientos SET estado = 'anulado' WHERE id = $1", [co.asiento_id]);
    });
  }));

async function comprobanteConAsiento(c, empresaId, id) {
  const { rows } = await c.query(
    `SELECT co.id, co.asiento_id, a.estado::text AS asiento_estado
       FROM comprobantes co LEFT JOIN asientos a ON a.id = co.asiento_id
      WHERE co.empresa_id = $1 AND co.id = $2 FOR UPDATE OF co`,
    [empresaId, id],
  );
  if (!rows[0]) throw new HttpError(404, 'Comprobante no encontrado.');
  return rows[0];
}

// ----- Importación de XML -----

const subida = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 500, fields: 10 },
}).array('archivos', 500);

function recibirArchivos(req, res, next) {
  subida(req, res, (err) => {
    if (!err) return next();
    const mensajes = {
      LIMIT_FILE_SIZE: 'Un archivo supera los 50 MB.',
      LIMIT_FILE_COUNT: 'Se pueden subir hasta 500 archivos por vez. Para más, usá un ZIP.',
    };
    next(new HttpError(422, mensajes[err.code] ?? 'No se pudieron recibir los archivos.'));
  });
}

async function cuentasParaImportar(req) {
  const cuentas = await enEmpresa(req.usuario, req.empresaId, 'lectura', (c) => listarCuentas(c, req.empresaId, true));
  const automaticas = new Set(Object.values(CUENTAS));
  return {
    // A dónde puede ir una compra: gastos, costos o activos (mercaderías, bienes de uso)
    cuentasGasto: cuentas.filter((c) => c.tipo === 'GASTO' || (c.tipo === 'ACTIVO' && !automaticas.has(c.codigo))),
    // Con qué se cobra o paga al contado: caja, bancos y otras cuentas de activo
    cuentasContado: cuentas.filter((c) => c.tipo === 'ACTIVO' && !automaticas.has(c.codigo)),
  };
}

rutas.get('/importar', async (req, res) => {
  if (!res.locals.ctx.puede('auxiliar')) throw new HttpError(403, 'Tu rol en esta empresa no permite importar comprobantes.');
  const imp = req.session.importacion?.empresaId === req.empresaId ? req.session.importacion : null;
  res.render('importar', { importacion: imp, tipos: TIPOS_DE, ...(imp ? await cuentasParaImportar(req) : {}) });
});

// Paso 1: leer los archivos y mostrar una vista previa con lo que se va a generar.
rutas.post('/importar', recibirArchivos, async (req, res) => {
  verificarCsrf(req);
  if (!res.locals.ctx.puede('auxiliar')) throw new HttpError(403, 'Tu rol en esta empresa no permite importar comprobantes.');
  const archivos = req.files ?? [];
  if (!archivos.length) {
    avisar(req, { error: 'Elegí al menos un archivo .xml o .zip.' });
    return res.redirect(`/empresas/${req.empresaId}/comprobantes/importar`);
  }
  const { xmls, errores } = await extraerXml(archivos);
  const docs = [];
  for (const x of xmls) {
    try {
      docs.push({ archivo: x.archivo, ...leerDocumento(x.texto) });
    } catch (err) {
      errores.push({ archivo: x.archivo, mensaje: err.message });
    }
  }
  const rucEmpresa = res.locals.ctx.empresa.ruc;
  const vista = await enEmpresa(req.usuario, req.empresaId, 'lectura', (c) => revisar(c, req.empresaId, rucEmpresa, docs));
  req.session.importacion = { empresaId: req.empresaId, docs: vista, errores };
  res.redirect(`/empresas/${req.empresaId}/comprobantes/importar`);
});

/** Controla cada documento contra la empresa y la base, y propone la cuenta de cada compra. */
async function revisar(c, empresaId, rucEmpresa, docs) {
  const cdcs = docs.map((d) => d.cdc).filter(Boolean);
  const existentes = new Set((await c.query(
    'SELECT cdc FROM comprobantes WHERE empresa_id = $1 AND cdc = ANY($2::text[])', [empresaId, cdcs],
  )).rows.map((r) => r.cdc));
  const ejercicios = (await c.query('SELECT fecha_desde, fecha_hasta, cerrado FROM ejercicios WHERE empresa_id = $1', [empresaId])).rows;
  const cerrados = new Set((await c.query(
    "SELECT to_char(mes, 'YYYY-MM') AS m FROM periodos WHERE empresa_id = $1 AND cerrado", [empresaId],
  )).rows.map((r) => r.m));
  const reglas = new Map((await c.query(
    'SELECT r.ruc, cu.codigo FROM reglas_proveedor r JOIN cuentas cu ON cu.id = r.cuenta_id WHERE r.empresa_id = $1', [empresaId],
  )).rows.map((r) => [r.ruc, r.codigo]));

  const vistos = new Set();
  return docs
    .sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : a.numero.localeCompare(b.numero)))
    .map((d) => {
      const problemas = [];
      const cl = clasificar(d, rucEmpresa);
      if (!cl.operacion) problemas.push(cl.problema);
      if (d.tipo === 7) problemas.push('Las notas de remisión no generan asiento.');
      else if (!TIPOS_DE[d.tipo]) problemas.push('Tipo de documento no reconocido.');
      let imp = null;
      if (!d.totales) problemas.push('El XML no trae los totales (gTotSub).');
      else if (d.tipo !== 7) {
        try {
          imp = importes(d);
          if (!imp.cuadra) problemas.push('Los importes no cuadran (puede tener descuentos globales o anticipos): cargalo a mano.');
        } catch (err) {
          problemas.push(err.message);
        }
      }
      if (!esFecha(d.fecha)) {
        problemas.push('La fecha de emisión no es válida.');
      } else {
        const ej = ejercicios.find((e) => d.fecha >= e.fecha_desde && d.fecha <= e.fecha_hasta);
        if (!ej) problemas.push(`No hay ejercicio ${d.fecha.slice(0, 4)}: crealo en Periodos.`);
        else if (ej.cerrado) problemas.push(`El ejercicio ${d.fecha.slice(0, 4)} está cerrado.`);
        if (cerrados.has(d.fecha.slice(0, 7))) problemas.push('Ese mes está cerrado.');
      }
      if (!/^\d{8}$/.test(d.timbrado)) problemas.push('El timbrado no es válido.');
      if (!/^\d{3}-\d{3}-\d{7}$/.test(d.numero)) problemas.push('El número de comprobante no es válido.');
      if (!d.cdc) problemas.push('Falta el CDC del documento.');
      else if (existentes.has(d.cdc)) problemas.push('Ya fue importado antes.');
      else if (vistos.has(d.cdc)) problemas.push('Está repetido en esta carga.');
      if (d.cdc) vistos.add(d.cdc);
      return {
        archivo: d.archivo, cdc: d.cdc, tipo: d.tipo, fecha: d.fecha, numero: d.numero, timbrado: d.timbrado,
        condicion: d.condicion, moneda: d.moneda, tipoCambio: d.tipoCambio,
        operacion: cl.operacion, contraparte: cl.contraparte ?? null, importes: imp, problemas,
        cuenta: cl.operacion === 'compra' ? (reglas.get(cl.contraparte.ruc) ?? '5.2.08') : null,
      };
    });
}

rutas.post('/importar/cancelar', (req, res) => {
  delete req.session.importacion;
  res.redirect(`/empresas/${req.empresaId}/comprobantes`);
});

// Paso 2: generar los comprobantes y sus asientos. Cada documento va en su propia transacción:
// si uno falla, los demás se registran igual y el error se informa.
rutas.post('/importar/generar', async (req, res) => {
  const imp = req.session.importacion;
  if (!imp || imp.empresaId !== req.empresaId) {
    avisar(req, { error: 'La carga venció. Volvé a subir los archivos.' });
    return res.redirect(`/empresas/${req.empresaId}/comprobantes/importar`);
  }
  const confirmar = req.body.confirmar === 'on';
  const minimo = confirmar ? 'contador' : 'auxiliar';
  if (!res.locals.ctx.puede(minimo)) throw new HttpError(403, `Tu rol en esta empresa no permite esta acción; se necesita ${minimo}.`);
  const cuentaContado = String(req.body.cuentaContado ?? '').trim() || '1.1.01';
  const elecciones = req.body.docs ?? {};

  let creados = 0;
  const errores = [];
  const fechas = [];
  for (const [i, d] of imp.docs.entries()) {
    const eleccion = elecciones[i] ?? {};
    if (d.problemas.length || eleccion.incluir !== 'on') continue;
    try {
      await enEmpresa(req.usuario, req.empresaId, minimo, (c) => registrarComprobante(c, req.empresaId, req.usuario.id, d, {
        cuentaContado, cuentaGasto: String(eleccion.cuenta ?? d.cuenta ?? '').trim(), confirmar, recordarCuenta: true,
      }));
      creados++;
      fechas.push(d.fecha);
    } catch (err) {
      const p = traducirError(err);
      if (!p) console.error(err);
      const detalle = p ? [p.mensaje, ...(p.detalles ?? [])].join(' ') : 'Error interno; quedó registrado en la consola.';
      errores.push(`${d.numero} (${d.archivo}): ${detalle}`);
    }
  }
  delete req.session.importacion;
  avisar(req, {
    ok: creados ? `Se registraron ${creados} comprobante(s) con su asiento${confirmar ? ' confirmado' : ' en borrador'}.` : null,
    error: errores.length ? `${errores.length} comprobante(s) no se pudieron registrar:` : (creados ? null : 'No se registró ningún comprobante.'),
    detalles: errores,
  });
  fechas.sort();
  const filtro = fechas.length ? `?desde=${fechas[0]}&hasta=${fechas.at(-1)}` : '';
  res.redirect(`/empresas/${req.empresaId}/comprobantes${filtro}`);
});

/**
 * Registra un comprobante (del XML o cargado a mano): cliente o proveedor, asiento y libro.
 * d: { operacion, tipo, fecha, timbrado, numero, cdc, condicion, moneda, tipoCambio, contraparte, importes }
 * Devuelve el número de asiento generado.
 */
export async function registrarComprobante(c, empresaId, usuarioId, d, {
  cuentaContado, cuentaGasto, cuentaIngreso = null, confirmar,
  imputa = { iva: true, ire: true, irp: false }, plantillaId = null, recordarCuenta = false,
}) {
  const lineas = lineasAsiento(d.operacion, d, d.importes, { cuentaContado, cuentaGasto, cuentaIngreso })
    .map((l) => ({ ...l, detalle: null }));
  validarLineas(lineas);
  const ejercicio = await buscarEjercicio(c, empresaId, d.fecha);

  // Cliente o proveedor: se crea la primera vez y se actualiza el nombre en las siguientes.
  const cp = d.contraparte;
  const dv = /^\d$/.test(String(cp.dv ?? '')) ? Number(cp.dv) : null;
  const { rows: ter } = await c.query(
    `INSERT INTO terceros (empresa_id, ruc, dv, razon_social, es_cliente, es_proveedor)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (empresa_id, ruc) DO UPDATE
        SET razon_social = EXCLUDED.razon_social,
            dv = COALESCE(EXCLUDED.dv, terceros.dv),
            es_cliente = terceros.es_cliente OR EXCLUDED.es_cliente,
            es_proveedor = terceros.es_proveedor OR EXCLUDED.es_proveedor
     RETURNING id`,
    [empresaId, String(cp.ruc).slice(0, 15), dv, String(cp.nombre).slice(0, 200), d.operacion === 'venta', d.operacion === 'compra'],
  );

  const { rows: as } = await c.query(
    `INSERT INTO asientos (empresa_id, ejercicio_id, fecha, concepto, origen, estado, creado_por)
     VALUES ($1, $2, $3, $4, $5::origen_asiento, 'borrador', $6) RETURNING id, numero`,
    [empresaId, ejercicio.id, d.fecha, concepto(d.operacion, d, cp).slice(0, 500), d.operacion, usuarioId],
  );
  const asientoId = as[0].id;
  await insertarLineas(c, empresaId, asientoId, lineas);
  if (confirmar) await c.query("UPDATE asientos SET estado = 'confirmado' WHERE id = $1", [asientoId]);

  const i = d.importes;
  await c.query(
    `INSERT INTO comprobantes (empresa_id, libro, tipo_comprobante, tercero_id, fecha, timbrado, numero, cdc,
                               condicion, moneda, tipo_cambio, total_grav_10, total_grav_5, total_exenta,
                               iva_10, iva_5, total, imputa_iva, imputa_ire, imputa_irp, asiento_id, creado_por)
     VALUES ($1, $2::tipo_libro, $3, $4, $5, $6, $7, $8, $9::condicion_pago, $10, $11, $12, $13, $14, $15, $16, $17,
             $18, $19, $20, $21, $22)`,
    [empresaId, d.operacion === 'venta' ? 'VENTA' : 'COMPRA', d.tipo, ter[0].id, d.fecha, d.timbrado, d.numero, d.cdc ?? null,
      d.condicion === 'credito' ? 'CREDITO' : 'CONTADO', d.moneda.slice(0, 3), d.moneda === 'PYG' ? '1' : d.tipoCambio,
      sumar([i.base10, i.iva10]), sumar([i.base5, i.iva5]), i.exenta, i.iva10, i.iva5, i.total,
      imputa.iva, imputa.ire, imputa.irp, asientoId, usuarioId],
  );

  // La próxima vez con este cliente o proveedor se propone la misma plantilla.
  if (plantillaId) {
    await c.query(
      `UPDATE terceros SET ${d.operacion === 'venta' ? 'plantilla_venta_id' : 'plantilla_compra_id'} = $2 WHERE id = $1`,
      [ter[0].id, plantillaId],
    );
  }

  // Importación de XML: la próxima factura de este proveedor va a proponer la misma cuenta.
  if (recordarCuenta && d.operacion === 'compra') {
    await c.query(
      `INSERT INTO reglas_proveedor (empresa_id, ruc, cuenta_id)
       SELECT $1, $2, id FROM cuentas WHERE empresa_id = $1 AND codigo = $3
       ON CONFLICT (empresa_id, ruc) DO UPDATE SET cuenta_id = EXCLUDED.cuenta_id`,
      [empresaId, String(cp.ruc).slice(0, 15), cuentaGasto],
    );
  }
  return as[0].numero;
}
