// Utilidades sin dependencias: errores, RUC, importes y formatos para las páginas.

export class HttpError extends Error {
  constructor(status, message, detalles) {
    super(message);
    this.status = status;
    this.detalles = detalles;
  }
}

// ----- RUC -----

/** Dígito verificador del RUC paraguayo (módulo 11, algoritmo de la SET). */
export function dvRuc(ruc) {
  const s = String(ruc).replace(/\D/g, '');
  if (!s) throw new Error('RUC vacío');
  let total = 0;
  let k = 2;
  for (let i = s.length - 1; i >= 0; i--) {
    if (k > 11) k = 2;
    total += Number(s[i]) * k;
    k++;
  }
  const resto = total % 11;
  return resto > 1 ? 11 - resto : 0;
}

// ----- Importes -----
// El dinero se maneja en centavos con BigInt: nunca con números de coma flotante.
// PostgreSQL devuelve los numeric como texto ("1500000.00"), que se convierten sin pérdida.

export function aCentavos(valor) {
  let s = String(valor ?? '0').trim();
  const negativo = s.startsWith('-');
  if (negativo) s = s.slice(1);
  const [entero, dec = ''] = s.split('.');
  const c = BigInt(entero || '0') * 100n + BigInt((dec + '00').slice(0, 2));
  return negativo ? -c : c;
}

export function deCentavos(c) {
  const negativo = c < 0n;
  const a = negativo ? -c : c;
  return (negativo ? '-' : '') + (a / 100n).toString() + '.' + (a % 100n).toString().padStart(2, '0');
}

export function sumar(valores) {
  return deCentavos(valores.reduce((t, v) => t + aCentavos(v), 0n));
}

/** Lee un importe escrito como en las facturas: "1.500.000" o "1.250,50". Vacío es cero. */
export function leerImporte(texto, campo) {
  const original = String(texto ?? '').trim();
  if (!original) return '0.00';
  const limpio = original.replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  if (!/^\d{1,16}(\.\d{1,2})?$/.test(limpio)) {
    throw new HttpError(422, `${campo}: importe inválido (${original}). Usá números con hasta 2 decimales.`);
  }
  return deCentavos(aCentavos(limpio));
}

// ----- Partida doble -----

/**
 * Valida la partida doble antes de tocar la base, para dar mensajes claros.
 * La base lo vuelve a validar al confirmar: esta función es ayuda, no la única defensa.
 */
export function validarLineas(lineas) {
  if (!Array.isArray(lineas) || lineas.length < 2) throw new HttpError(422, 'Un asiento necesita al menos dos líneas.');
  if (lineas.length > 500) throw new HttpError(422, 'Un asiento admite hasta 500 líneas.');
  const errores = [];
  let debe = 0n;
  let haber = 0n;
  lineas.forEach((l, i) => {
    const d = aCentavos(l.debe);
    const h = aCentavos(l.haber);
    if (!l.cuenta) errores.push(`Línea ${i + 1}: falta la cuenta.`);
    if ((d > 0n) === (h > 0n)) errores.push(`Línea ${i + 1}: el importe va en debe o en haber, no en ambos ni en ninguno.`);
    debe += d;
    haber += h;
  });
  if (errores.length) throw new HttpError(422, 'Hay líneas inválidas.', errores);
  if (debe !== haber) {
    throw new HttpError(422, `El asiento no balancea: debe ${deCentavos(debe)}, haber ${deCentavos(haber)}.`);
  }
}

// ----- IVA de facturas cargadas a mano -----

/** IVA incluido en un monto gravado: 10% → monto/11, 5% → monto/21, redondeado al guaraní. */
export function ivaIncluido(montoGravado, tasa) {
  const c = aCentavos(montoGravado);
  const divisor = tasa === 10 ? 11n : 21n;
  const gs = c / 100n; // los guaraníes no tienen centavos en las facturas
  return deCentavos(((gs * 2n + divisor) / (divisor * 2n)) * 100n);
}

/**
 * Arma los importes de un comprobante en papel a partir de lo que dice la factura:
 * montos gravados (IVA incluido), exentas e IVA de cada tasa. Si el IVA viene vacío, se calcula.
 * El IVA escrito a mano puede diferir del calculado por redondeos de la factura, pero no demasiado.
 */
export function importesManuales({ grav10, iva10, grav5, iva5, exenta }) {
  const g10 = leerImporte(grav10, 'Gravada 10%');
  const g5 = leerImporte(grav5, 'Gravada 5%');
  const ex = leerImporte(exenta, 'Exenta');
  const i10 = String(iva10 ?? '').trim() ? leerImporte(iva10, 'IVA 10%') : ivaIncluido(g10, 10);
  const i5 = String(iva5 ?? '').trim() ? leerImporte(iva5, 'IVA 5%') : ivaIncluido(g5, 5);
  const controlar = (iva, gravada, tasa) => {
    const esperado = aCentavos(ivaIncluido(gravada, tasa));
    const dif = aCentavos(iva) - esperado;
    const tolerancia = 1000n + esperado / 100n; // 10 Gs más 1%
    if (dif > tolerancia || -dif > tolerancia) {
      throw new HttpError(422, `El IVA ${tasa}% (${gs(iva)}) no corresponde al monto gravado ${gs(gravada)}: debería rondar ${gs(deCentavos(esperado))}.`);
    }
  };
  controlar(i10, g10, 10);
  controlar(i5, g5, 5);
  const total = aCentavos(g10) + aCentavos(g5) + aCentavos(ex);
  if (total <= 0n) throw new HttpError(422, 'Ingresá al menos un importe.');
  return {
    base10: deCentavos(aCentavos(g10) - aCentavos(i10)), iva10: i10,
    base5: deCentavos(aCentavos(g5) - aCentavos(i5)), iva5: i5,
    exenta: ex, total: deCentavos(total), cuadra: true,
  };
}

/** Normaliza el número de comprobante: "1-1-123" o "001001000123" → "001-001-0000123". */
export function normalizarNumero(texto) {
  const t = String(texto ?? '').trim();
  let partes = t.split('-').map((p) => p.trim());
  if (partes.length === 1 && /^\d{13}$/.test(t)) partes = [t.slice(0, 3), t.slice(3, 6), t.slice(6)];
  if (partes.length !== 3 || !partes.every((p) => /^\d+$/.test(p))) return null;
  const [est, pun, num] = partes;
  if (est.length > 3 || pun.length > 3 || num.length > 7) return null;
  return `${est.padStart(3, '0')}-${pun.padStart(3, '0')}-${num.padStart(7, '0')}`;
}

// ----- Formatos para las páginas -----

/** 1500000.00 → "1.500.000"; 1250.5 → "1.250,50" */
export function gs(valor) {
  if (valor === null || valor === undefined || valor === '') return '';
  const c = aCentavos(valor);
  const negativo = c < 0n;
  const a = negativo ? -c : c;
  const entero = (a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const dec = a % 100n;
  return (negativo ? '-' : '') + entero + (dec ? ',' + dec.toString().padStart(2, '0') : '');
}

/** IVA 10% + 5% de un comprobante (acepta los nombres de la base o de la importación). */
export function sumaIva(x) {
  return sumar([x.iva_10 ?? x.iva10 ?? '0', x.iva_5 ?? x.iva5 ?? '0']);
}

/** Vacío si es cero: para las columnas de debe y haber. */
export function gsSinCero(valor) {
  return aCentavos(valor ?? '0') === 0n ? '' : gs(valor);
}

/** "2026-09-28" → "28/09/2026" */
export function fecha(f) {
  if (!f) return '';
  const s = String(f);
  return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
}

export const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto',
  'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

/** "2026-08" → "Agosto 2026" */
export function mes(anioMes) {
  if (!/^\d{4}-\d{2}$/.test(anioMes ?? '')) return anioMes;
  return `${MESES[Number(anioMes.slice(5)) - 1]} ${anioMes.slice(0, 4)}`;
}

export function capitalizar(s) {
  const t = String(s ?? '').toLowerCase().replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Fecha de hoy como "AAAA-MM-DD", en la hora local del servidor. */
export function hoy() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function esFecha(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s ?? '')) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

/** qs entrega campos como lineas[0][cuenta] como arreglo o, con muchos índices, como objeto: lo normalizamos. */
export function aLista(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x.filter(Boolean);
  return Object.keys(x).sort((a, b) => Number(a) - Number(b)).map((k) => x[k]);
}

export function esId(s) {
  return /^\d{1,18}$/.test(String(s ?? ''));
}

/** Rango de fechas de la URL, o el año en curso si falta o es inválido. */
export function rango(query) {
  const anio = new Date().getFullYear();
  const desde = esFecha(query.desde) ? query.desde : `${anio}-01-01`;
  const hasta = esFecha(query.hasta) ? query.hasta : `${desde.slice(0, 4)}-12-31`;
  if (desde > hasta) throw new HttpError(422, 'La fecha "desde" no puede ser posterior a "hasta".');
  return { desde, hasta };
}

// ----- Errores -----

/**
 * Traduce errores de negocio y de PostgreSQL a un mensaje para mostrar.
 * Devuelve null si el error es desconocido (se trata como error interno).
 */
export function traducirError(err) {
  if (err instanceof HttpError) return { status: err.status, mensaje: err.message, detalles: err.detalles };
  switch (err?.code) {
    case 'P0001': // RAISE EXCEPTION de nuestros triggers: periodo cerrado, desbalanceo, etc.
      return { status: 422, mensaje: err.message };
    case '23505':
      return { status: 409, mensaje: 'Ya existe un registro con esos datos.', detalles: err.detail ? [err.detail] : undefined };
    case '23503':
      return { status: 422, mensaje: 'Hace referencia a un registro que no existe o no pertenece a esta empresa.' };
    case '23514':
      return { status: 422, mensaje: 'Los datos no cumplen una regla de la base de datos.' };
    case '42501':
      return { status: 403, mensaje: 'No tenés acceso a esa empresa.' };
    default:
      return null;
  }
}
