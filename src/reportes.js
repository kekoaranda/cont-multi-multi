// Reportes: sumas y saldos, libro mayor, estado de resultados y balance general.
import { Router } from 'express';
import { enEmpresa } from './db.js';
import { listarCuentas } from './plan.js';
import { HttpError, aCentavos, deCentavos, rango, sumar } from './util.js';

const deudora = (tipo) => tipo === 'ACTIVO' || tipo === 'GASTO';
const saldoNatural = (r) => deCentavos(deudora(r.tipo)
  ? aCentavos(r.debe) - aCentavos(r.haber)
  : aCentavos(r.haber) - aCentavos(r.debe));

/** Sumas por cuenta de los asientos confirmados entre desde (opcional) y hasta. */
async function saldos(c, empresaId, desde, hasta) {
  const { rows } = await c.query(
    `SELECT c.codigo, c.nombre, c.tipo::text AS tipo, sum(l.debe) AS debe, sum(l.haber) AS haber
       FROM asiento_lineas l
       JOIN asientos a ON a.id = l.asiento_id AND a.estado = 'confirmado'
       JOIN cuentas  c ON c.id = l.cuenta_id
      WHERE a.empresa_id = $1 AND ($2::date IS NULL OR a.fecha >= $2) AND a.fecha <= $3
      GROUP BY c.id
      ORDER BY string_to_array(c.codigo, '.')::int[]`,
    [empresaId, desde, hasta],
  );
  return rows;
}

function seccion(filas, tipo) {
  const cuentas = filas.filter((r) => r.tipo === tipo)
    .map((r) => ({ codigo: r.codigo, nombre: r.nombre, saldo: saldoNatural(r) }))
    .filter((s) => aCentavos(s.saldo) !== 0n);
  return { cuentas, total: sumar(cuentas.map((s) => s.saldo)) };
}

async function sumasYSaldos(c, empresaId, desde, hasta) {
  const filas = (await saldos(c, empresaId, desde, hasta)).map((r) => {
    const s = aCentavos(r.debe) - aCentavos(r.haber);
    return { ...r, saldoDeudor: deCentavos(s > 0n ? s : 0n), saldoAcreedor: deCentavos(s < 0n ? -s : 0n) };
  });
  const t = {
    debe: sumar(filas.map((f) => f.debe)), haber: sumar(filas.map((f) => f.haber)),
    saldoDeudor: sumar(filas.map((f) => f.saldoDeudor)), saldoAcreedor: sumar(filas.map((f) => f.saldoAcreedor)),
  };
  return { filas, ...t, cuadra: t.debe === t.haber && t.saldoDeudor === t.saldoAcreedor };
}

async function mayor(c, empresaId, codigo, desde, hasta) {
  const { rows: ctas } = await c.query(
    'SELECT id, nombre, tipo::text AS tipo FROM cuentas WHERE empresa_id = $1 AND codigo = $2',
    [empresaId, codigo],
  );
  const cta = ctas[0];
  if (!cta) throw new HttpError(404, `La cuenta ${codigo} no existe en esta empresa.`);
  const signo = deudora(cta.tipo) ? 1n : -1n;
  const { rows: ant } = await c.query(
    `SELECT COALESCE(sum(l.debe - l.haber), 0) AS saldo
       FROM asiento_lineas l JOIN asientos a ON a.id = l.asiento_id AND a.estado = 'confirmado'
      WHERE a.empresa_id = $1 AND l.cuenta_id = $2 AND a.fecha < $3`,
    [empresaId, cta.id, desde],
  );
  const { rows } = await c.query(
    `SELECT a.fecha, a.numero, a.concepto, l.debe, l.haber
       FROM asiento_lineas l JOIN asientos a ON a.id = l.asiento_id AND a.estado = 'confirmado'
      WHERE a.empresa_id = $1 AND l.cuenta_id = $2 AND a.fecha BETWEEN $3 AND $4
      ORDER BY a.fecha, a.numero, l.id`,
    [empresaId, cta.id, desde, hasta],
  );
  const anterior = aCentavos(ant[0].saldo) * signo;
  let saldo = anterior;
  const movimientos = rows.map((m) => {
    saldo += (aCentavos(m.debe) - aCentavos(m.haber)) * signo;
    return { ...m, saldo: deCentavos(saldo) };
  });
  return {
    codigo, nombre: cta.nombre, deudora: signo === 1n, saldoAnterior: deCentavos(anterior), movimientos,
    totalDebe: sumar(rows.map((m) => m.debe)), totalHaber: sumar(rows.map((m) => m.haber)), saldoFinal: deCentavos(saldo),
  };
}

async function resultados(c, empresaId, desde, hasta) {
  const filas = await saldos(c, empresaId, desde, hasta);
  const ingresos = seccion(filas, 'INGRESO');
  const gastos = seccion(filas, 'GASTO');
  return { ingresos, gastos, resultado: deCentavos(aCentavos(ingresos.total) - aCentavos(gastos.total)) };
}

/**
 * Balance al corte. Mientras no exista el asiento de cierre de ejercicio,
 * el resultado se acumula desde el inicio para que el balance cuadre.
 */
async function balance(c, empresaId, hasta) {
  const filas = await saldos(c, empresaId, null, hasta);
  const activo = seccion(filas, 'ACTIVO');
  const pasivo = seccion(filas, 'PASIVO');
  const patrimonio = seccion(filas, 'PATRIMONIO');
  const resultado = deCentavos(aCentavos(seccion(filas, 'INGRESO').total) - aCentavos(seccion(filas, 'GASTO').total));
  const totalPatrimonio = sumar([patrimonio.total, resultado]);
  const totalPasivoPatrimonio = sumar([pasivo.total, totalPatrimonio]);
  return { activo, pasivo, patrimonio, resultado, totalPatrimonio, totalPasivoPatrimonio, cuadra: activo.total === totalPasivoPatrimonio };
}

export const TIPOS = {
  sumas: 'Sumas y saldos', mayor: 'Libro mayor', resultados: 'Estado de resultados', balance: 'Balance general',
};

const rutas = Router({ mergeParams: true });
export default rutas;

rutas.get('/', async (req, res) => {
  const tipo = Object.hasOwn(TIPOS, req.query.tipo) ? req.query.tipo : 'sumas';
  const { desde, hasta } = rango(req.query);
  const datos = { tipo, desde, hasta, tipos: TIPOS, sumas: null, mayor: null, resultados: null, balance: null, cuentas: [], cuenta: null };
  await enEmpresa(req.usuario, req.empresaId, 'lectura', async (c) => {
    if (tipo === 'mayor') {
      datos.cuentas = await listarCuentas(c, req.empresaId, true);
      datos.cuenta = String(req.query.cuenta ?? '').trim() || datos.cuentas[0]?.codigo || null;
      if (datos.cuenta) datos.mayor = await mayor(c, req.empresaId, datos.cuenta, desde, hasta);
    } else if (tipo === 'resultados') {
      datos.resultados = await resultados(c, req.empresaId, desde, hasta);
    } else if (tipo === 'balance') {
      datos.balance = await balance(c, req.empresaId, hasta);
    } else {
      datos.sumas = await sumasYSaldos(c, req.empresaId, desde, hasta);
    }
  });
  res.render('reportes', datos);
});
