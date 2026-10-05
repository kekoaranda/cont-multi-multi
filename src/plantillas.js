// Plantillas de asiento para la carga rápida de comprobantes en papel.
import { Router } from 'express';
import { enEmpresa } from './db.js';
import { listarCuentas } from './plan.js';
import { accion } from './sesion.js';
import { HttpError, esId } from './util.js';

export const COLUMNAS = { 10: 'Gravada 10%', 5: 'Gravada 5%', exenta: 'Exenta' };

export async function listarPlantillas(c, empresaId, { libro = null, soloActivas = false } = {}) {
  const { rows } = await c.query(
    `SELECT p.id, p.nombre, p.libro::text AS libro, p.columna::text AS columna, p.imputa_iva, p.imputa_ire, p.imputa_irp,
            p.activa, cu.codigo AS cuenta, cu.nombre AS cuenta_nombre
       FROM plantillas p LEFT JOIN cuentas cu ON cu.id = p.cuenta_id
      WHERE p.empresa_id = $1 AND ($2::text IS NULL OR p.libro::text = $2) AND ($3::boolean = false OR p.activa)
      ORDER BY p.libro DESC, p.nombre`,
    [empresaId, libro, soloActivas],
  );
  return rows;
}

/** Valida los datos del formulario y devuelve lo necesario para guardar. */
async function validar(c, empresaId, datos) {
  const nombre = String(datos.nombre ?? '').trim();
  if (!nombre) throw new HttpError(422, 'Ingresá el nombre de la plantilla.');
  if (nombre.length > 100) throw new HttpError(422, 'El nombre admite hasta 100 caracteres.');
  const libro = datos.libro === 'VENTA' ? 'VENTA' : 'COMPRA';
  if (!Object.hasOwn(COLUMNAS, datos.columna)) throw new HttpError(422, 'Elegí dónde va el importe por defecto.');
  let cuentaId = null;
  const codigo = String(datos.cuenta ?? '').trim();
  if (codigo) {
    const { rows } = await c.query(
      'SELECT id FROM cuentas WHERE empresa_id = $1 AND codigo = $2 AND imputable AND activa', [empresaId, codigo],
    );
    if (!rows[0]) throw new HttpError(422, `La cuenta ${codigo} no existe o no es imputable.`);
    cuentaId = rows[0].id;
  } else if (libro === 'COMPRA') {
    throw new HttpError(422, 'Elegí la cuenta a la que va la compra.');
  }
  const si = (v) => v === 'on';
  return { nombre, libro, cuentaId, columna: datos.columna, iva: si(datos.imputaIva), ire: si(datos.imputaIre), irp: si(datos.imputaIrp) };
}

const rutas = Router({ mergeParams: true });
export default rutas;

rutas.get('/', async (req, res) => {
  const datos = await enEmpresa(req.usuario, req.empresaId, 'lectura', async (c) => ({
    plantillas: await listarPlantillas(c, req.empresaId),
    cuentas: await listarCuentas(c, req.empresaId, true),
  }));
  const form = res.locals.form ?? { nombre: '', libro: 'COMPRA', cuenta: '', columna: '10', imputaIva: 'on', imputaIre: 'on', imputaIrp: '' };
  res.render('plantillas', { ...datos, form, columnas: COLUMNAS });
});

const leer = (b) => ({
  nombre: b.nombre ?? '', libro: b.libro ?? '', cuenta: b.cuenta ?? '', columna: b.columna ?? '',
  imputaIva: b.imputaIva ?? '', imputaIre: b.imputaIre ?? '', imputaIrp: b.imputaIrp ?? '', activa: b.activa ?? '',
});

rutas.post('/', (req, res) => {
  const datos = leer(req.body);
  return accion(req, res, `/empresas/${req.empresaId}/plantillas`, `Plantilla "${String(datos.nombre).trim()}" creada.`,
    () => enEmpresa(req.usuario, req.empresaId, 'contador', async (c) => {
      const v = await validar(c, req.empresaId, datos);
      await c.query(
        `INSERT INTO plantillas (empresa_id, nombre, libro, cuenta_id, columna, imputa_iva, imputa_ire, imputa_irp)
         VALUES ($1, $2, $3::tipo_libro, $4, $5::columna_iva, $6, $7, $8)`,
        [req.empresaId, v.nombre, v.libro, v.cuentaId, v.columna, v.iva, v.ire, v.irp],
      );
    }), datos);
});

rutas.post('/:id', (req, res) => {
  const datos = leer(req.body);
  return accion(req, res, `/empresas/${req.empresaId}/plantillas`, 'Plantilla actualizada.', async () => {
    if (!esId(req.params.id)) throw new HttpError(404, 'Plantilla no encontrada.');
    await enEmpresa(req.usuario, req.empresaId, 'contador', async (c) => {
      const { rows } = await c.query('SELECT libro::text AS libro FROM plantillas WHERE empresa_id = $1 AND id = $2', [req.empresaId, req.params.id]);
      if (!rows[0]) throw new HttpError(404, 'Plantilla no encontrada.');
      const v = await validar(c, req.empresaId, { ...datos, libro: rows[0].libro }); // el libro no cambia
      await c.query(
        `UPDATE plantillas SET nombre = $3, cuenta_id = $4, columna = $5::columna_iva, imputa_iva = $6, imputa_ire = $7,
                imputa_irp = $8, activa = $9
          WHERE empresa_id = $1 AND id = $2`,
        [req.empresaId, req.params.id, v.nombre, v.cuentaId, v.columna, v.iva, v.ire, v.irp, datos.activa === 'on'],
      );
    });
  });
});
