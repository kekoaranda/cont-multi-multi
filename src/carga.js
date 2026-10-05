// Carga rápida de comprobantes en papel: el usuario escribe lo que dice la factura
// y la plantilla elegida arma el asiento.
import { Router } from 'express';
import { enEmpresa } from './db.js';
import { listarCuentas } from './plan.js';
import { listarPlantillas } from './plantillas.js';
import { avisar } from './sesion.js';
import { CUENTAS } from './sifen.js';
import { registrarComprobante } from './comprobantes.js';
import { HttpError, dvRuc, esFecha, esId, hoy, importesManuales, normalizarNumero, traducirError } from './util.js';

const rutas = Router({ mergeParams: true });
export default rutas;

const libroDe = (q) => (q === 'VENTA' ? 'VENTA' : 'COMPRA');

/** Preferencias que se conservan entre una carga y la siguiente, por empresa. */
function preferencias(req) {
  return req.session.carga?.[req.empresaId] ?? { fecha: hoy(), condicion: 'contado', cuentaContado: '1.1.01', confirmar: '', tipo: '1' };
}

async function mostrar(req, res, libro, form, status = 200) {
  if (!res.locals.ctx.puede('auxiliar')) throw new HttpError(403, 'Tu rol en esta empresa no permite cargar comprobantes.');
  const automaticas = new Set(Object.values(CUENTAS));
  const datos = await enEmpresa(req.usuario, req.empresaId, 'lectura', async (c) => {
    const cuentas = await listarCuentas(c, req.empresaId, true);
    const { rows: ultimos } = await c.query(
      `SELECT co.fecha, co.tipo_comprobante AS tipo, co.numero, co.total, t.razon_social, a.numero AS asiento, a.estado::text AS estado
         FROM comprobantes co JOIN terceros t ON t.id = co.tercero_id LEFT JOIN asientos a ON a.id = co.asiento_id
        WHERE co.empresa_id = $1 AND co.libro::text = $2 AND co.cdc IS NULL
        ORDER BY co.id DESC LIMIT 10`,
      [req.empresaId, libro],
    );
    return {
      plantillas: await listarPlantillas(c, req.empresaId, { libro, soloActivas: true }),
      cuentasContado: cuentas.filter((x) => x.tipo === 'ACTIVO' && !automaticas.has(x.codigo)),
      ultimos,
    };
  });
  res.status(status).render('carga', { libro, form, ...datos });
}

rutas.get('/', (req, res) => {
  const libro = libroDe(req.query.libro);
  const p = preferencias(req);
  const form = res.locals.form ?? {
    ...p, ruc: '', razonSocial: '', timbrado: '', numero: '', plantilla: '',
    grav10: '', iva10: '', grav5: '', iva5: '', exenta: '',
  };
  return mostrar(req, res, libro, form);
});

// Datos de un cliente o proveedor ya cargado: los usa carga.js para completar el formulario.
rutas.get('/tercero', async (req, res) => {
  const ruc = String(req.query.ruc ?? '').split('-')[0].replace(/\D/g, '');
  const libro = libroDe(req.query.libro);
  if (!ruc) return res.json(null);
  const { rows } = await enEmpresa(req.usuario, req.empresaId, 'lectura', (c) => c.query(
    `SELECT razon_social, dv, ${libro === 'VENTA' ? 'plantilla_venta_id' : 'plantilla_compra_id'} AS plantilla
       FROM terceros WHERE empresa_id = $1 AND ruc = $2`,
    [req.empresaId, ruc],
  ));
  res.json(rows[0] ? { razonSocial: rows[0].razon_social, dv: rows[0].dv, plantilla: rows[0].plantilla } : null);
});

rutas.post('/', async (req, res) => {
  const libro = libroDe(req.body.libro);
  const b = req.body;
  const form = {
    fecha: String(b.fecha ?? ''), tipo: b.tipo === '5' ? '5' : '1', condicion: b.condicion === 'credito' ? 'credito' : 'contado',
    cuentaContado: String(b.cuentaContado ?? '1.1.01'), confirmar: b.confirmar === 'on' ? 'on' : '',
    ruc: String(b.ruc ?? '').trim(), razonSocial: String(b.razonSocial ?? '').trim(),
    timbrado: String(b.timbrado ?? '').trim(), numero: String(b.numero ?? '').trim(), plantilla: String(b.plantilla ?? ''),
    grav10: String(b.grav10 ?? ''), iva10: String(b.iva10 ?? ''), grav5: String(b.grav5 ?? ''), iva5: String(b.iva5 ?? ''),
    exenta: String(b.exenta ?? ''),
  };
  try {
    const confirmar = form.confirmar === 'on';
    const minimo = confirmar ? 'contador' : 'auxiliar';
    if (!res.locals.ctx.puede(minimo)) throw new HttpError(403, `Tu rol en esta empresa no permite esta acción; se necesita ${minimo}.`);

    if (!esFecha(form.fecha)) throw new HttpError(422, 'Indicá una fecha válida.');
    const [base, dvEscrito] = form.ruc.split('-');
    const ruc = (base ?? '').replace(/\D/g, '');
    if (ruc.length < 1 || ruc.length > 15) throw new HttpError(422, 'Ingresá el RUC o la cédula.');
    const dv = dvRuc(ruc);
    if (dvEscrito !== undefined && dvEscrito.trim() !== '' && Number(dvEscrito) !== dv) {
      throw new HttpError(422, `El dígito verificador no coincide: para ${ruc} corresponde ${dv}.`);
    }
    if (!/^\d{8}$/.test(form.timbrado)) throw new HttpError(422, 'El timbrado tiene 8 dígitos.');
    const numero = normalizarNumero(form.numero);
    if (!numero) throw new HttpError(422, 'El número de comprobante va como 001-001-0000123.');
    if (!esId(form.plantilla)) throw new HttpError(422, 'Elegí una plantilla.');
    const importes = importesManuales(form);

    const n = await enEmpresa(req.usuario, req.empresaId, minimo, async (c) => {
      const { rows: pl } = await c.query(
        `SELECT p.id, p.imputa_iva, p.imputa_ire, p.imputa_irp, cu.codigo AS cuenta
           FROM plantillas p LEFT JOIN cuentas cu ON cu.id = p.cuenta_id
          WHERE p.empresa_id = $1 AND p.id = $2 AND p.libro::text = $3 AND p.activa`,
        [req.empresaId, form.plantilla, libro],
      );
      if (!pl[0]) throw new HttpError(422, 'La plantilla elegida no existe o está inactiva.');

      // Si no se escribió la razón social, se usa la del cliente o proveedor ya cargado.
      let nombre = form.razonSocial;
      const { rows: ter } = await c.query('SELECT razon_social FROM terceros WHERE empresa_id = $1 AND ruc = $2', [req.empresaId, ruc]);
      if (!nombre) nombre = ter[0]?.razon_social ?? '';
      if (!nombre) throw new HttpError(422, 'Ingresá la razón social.');

      const { rows: dup } = await c.query(
        `SELECT 1 FROM comprobantes co JOIN terceros t ON t.id = co.tercero_id
          WHERE co.empresa_id = $1 AND co.libro::text = $2 AND t.ruc = $3 AND co.timbrado = $4 AND co.numero = $5`,
        [req.empresaId, libro, ruc, form.timbrado, numero],
      );
      if (dup.length) throw new HttpError(422, `El comprobante ${numero} de ${nombre} ya está cargado.`);

      const operacion = libro === 'VENTA' ? 'venta' : 'compra';
      const d = {
        operacion, tipo: Number(form.tipo), fecha: form.fecha, timbrado: form.timbrado, numero, cdc: null,
        condicion: form.condicion, moneda: 'PYG', tipoCambio: '1',
        contraparte: { ruc, dv, nombre }, importes,
      };
      return registrarComprobante(c, req.empresaId, req.usuario.id, d, {
        cuentaContado: form.cuentaContado,
        cuentaGasto: operacion === 'compra' ? pl[0].cuenta : null,
        cuentaIngreso: operacion === 'venta' ? pl[0].cuenta : null,
        confirmar,
        imputa: { iva: pl[0].imputa_iva, ire: pl[0].imputa_ire, irp: pl[0].imputa_irp },
        plantillaId: pl[0].id,
      });
    });

    // Se conservan fecha, condición y demás preferencias para cargar la siguiente factura rápido.
    req.session.carga = { ...(req.session.carga ?? {}), [req.empresaId]: {
      fecha: form.fecha, condicion: form.condicion, cuentaContado: form.cuentaContado, confirmar: form.confirmar, tipo: form.tipo,
    } };
    avisar(req, { ok: `${libro === 'VENTA' ? 'Venta' : 'Compra'} ${numero} registrada con el asiento N.º ${n}${confirmar ? ', confirmado' : ' en borrador'}.` });
    res.redirect(`/empresas/${req.empresaId}/carga?libro=${libro}`);
  } catch (err) {
    const p = traducirError(err);
    if (!p) throw err;
    res.locals.error = p.mensaje;
    res.locals.detalles = p.detalles;
    return mostrar(req, res, libro, form, p.status);
  }
});
