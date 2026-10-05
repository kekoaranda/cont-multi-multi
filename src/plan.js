// Plan de cuentas de cada empresa.
import { Router } from 'express';
import { enEmpresa } from './db.js';
import { accion } from './sesion.js';
import { HttpError, esId } from './util.js';

const COLUMNAS = 'id, codigo, nombre, tipo::text AS tipo, imputable, padre_id, activa';

export async function listarCuentas(c, empresaId, soloImputables) {
  const { rows } = await c.query(
    `SELECT ${COLUMNAS} FROM cuentas
      WHERE empresa_id = $1 AND ($2::boolean = false OR (imputable AND activa))
      ORDER BY string_to_array(codigo, '.')::int[]`,
    [empresaId, soloImputables],
  );
  return rows;
}

async function crearCuenta(c, empresaId, datos) {
  const codigo = String(datos.codigo ?? '').trim();
  const nombre = String(datos.nombre ?? '').trim();
  if (!/^\d+(\.\d+)+$/.test(codigo)) {
    throw new HttpError(422, 'El código debe tener el formato 5.2.09 (las cuentas de primer nivel vienen de la plantilla).');
  }
  if (!nombre) throw new HttpError(422, 'Ingresá el nombre de la cuenta.');
  // La cuenta madre es el prefijo existente más largo: 5.2.09 cuelga de 5.2 o, si no existe, de 5.
  const seg = codigo.split('.');
  const prefijos = seg.slice(0, -1).map((_, i) => seg.slice(0, i + 1).join('.'));
  const { rows } = await c.query(
    `SELECT ${COLUMNAS} FROM cuentas WHERE empresa_id = $1 AND codigo = ANY($2::text[])
      ORDER BY length(codigo) DESC LIMIT 1`,
    [empresaId, prefijos],
  );
  const madre = rows[0];
  if (!madre) throw new HttpError(422, `No existe una cuenta madre para ${codigo}.`);
  if (madre.imputable) throw new HttpError(422, `La cuenta ${madre.codigo} es imputable y no puede tener subcuentas.`);
  await c.query(
    `INSERT INTO cuentas (empresa_id, codigo, nombre, tipo, imputable, padre_id)
     VALUES ($1, $2, $3, $4::tipo_cuenta, $5, $6)`,
    [empresaId, codigo, nombre, madre.tipo, datos.imputable === 'on' || datos.imputable === true, madre.id],
  );
}

const rutas = Router({ mergeParams: true });
export default rutas;

rutas.get('/', async (req, res) => {
  const { cuentas, usadas } = await enEmpresa(req.usuario, req.empresaId, 'lectura', async (c) => {
    const lista = await listarCuentas(c, req.empresaId, false);
    const { rows } = await c.query(
      'SELECT DISTINCT c.codigo FROM asiento_lineas l JOIN cuentas c ON c.id = l.cuenta_id WHERE l.empresa_id = $1',
      [req.empresaId],
    );
    return { cuentas: lista, usadas: new Set(rows.map((r) => r.codigo)) };
  });
  // Si volvemos de un error, el formulario trae lo que se había escrito.
  const form = res.locals.form ?? { codigo: '', nombre: '', imputable: 'on' };
  res.render('plan', { cuentas, usadas, form });
});

rutas.post('/', (req, res) => {
  const datos = { codigo: req.body.codigo ?? '', nombre: req.body.nombre ?? '', imputable: req.body.imputable ?? '' };
  return accion(req, res, `/empresas/${req.empresaId}/plan`, `Cuenta ${String(datos.codigo).trim()} agregada.`,
    () => enEmpresa(req.usuario, req.empresaId, 'contador', (c) => crearCuenta(c, req.empresaId, datos)), datos);
});

rutas.post('/:cuentaId/activa', (req, res) => {
  const activa = req.body.valor === 'true';
  return accion(req, res, `/empresas/${req.empresaId}/plan`, activa ? 'Cuenta activada.' : 'Cuenta desactivada.', async () => {
    if (!esId(req.params.cuentaId)) throw new HttpError(404, 'Cuenta no encontrada.');
    await enEmpresa(req.usuario, req.empresaId, 'contador', async (c) => {
      const r = await c.query('UPDATE cuentas SET activa = $3 WHERE empresa_id = $1 AND id = $2', [req.empresaId, req.params.cuentaId, activa]);
      if (!r.rowCount) throw new HttpError(404, 'Cuenta no encontrada.');
    });
  });
});
