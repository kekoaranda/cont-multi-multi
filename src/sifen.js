// Lectura de documentos electrónicos de SIFEN (XML) y armado de su asiento contable.
// No depende de Express ni de la base de datos: se puede probar por separado.
import JSZip from 'jszip';
import sax from 'sax';
import { deCentavos, sumar } from './util.js';

export const TIPOS_DE = {
  1: 'Factura', 2: 'Factura de exportación', 3: 'Factura de importación', 4: 'Autofactura',
  5: 'Nota de crédito', 6: 'Nota de débito', 7: 'Nota de remisión',
};

// ----- Archivos: XML sueltos o dentro de un ZIP -----

const LIMITE_ZIP = 200 * 1024 * 1024; // tamaño total descomprimido aceptado

/** Recibe los archivos subidos ({ originalname, buffer }) y devuelve los textos XML encontrados. */
export async function extraerXml(archivos) {
  const xmls = [];
  const errores = [];
  for (const a of archivos) {
    const nombre = a.originalname;
    if (/\.zip$/i.test(nombre)) {
      try {
        const zip = await JSZip.loadAsync(a.buffer);
        let total = 0;
        for (const entrada of Object.values(zip.files)) {
          if (entrada.dir || !/\.xml$/i.test(entrada.name)) continue;
          const texto = await entrada.async('string');
          total += texto.length;
          if (total > LIMITE_ZIP) {
            errores.push({ archivo: nombre, mensaje: 'El ZIP es demasiado grande; dividilo en partes.' });
            break;
          }
          xmls.push({ archivo: `${nombre} › ${entrada.name.split('/').pop()}`, texto });
        }
      } catch {
        errores.push({ archivo: nombre, mensaje: 'No se pudo abrir el ZIP.' });
      }
    } else if (/\.xml$/i.test(nombre)) {
      xmls.push({ archivo: nombre, texto: a.buffer.toString('utf8') });
    } else {
      errores.push({ archivo: nombre, mensaje: 'Solo se aceptan archivos .xml o .zip.' });
    }
  }
  return { xmls, errores };
}

// ----- XML a un árbol simple -----

const sinPrefijo = (nombre) => nombre.split(':').pop();

export function leerXml(texto) {
  const parser = sax.parser(true);
  const raiz = { nombre: '#documento', attrs: {}, hijos: [], texto: '' };
  const pila = [raiz];
  parser.onopentag = (n) => {
    const nodo = { nombre: sinPrefijo(n.name), attrs: n.attributes, hijos: [], texto: '' };
    pila.at(-1).hijos.push(nodo);
    pila.push(nodo);
  };
  parser.onclosetag = () => { pila.pop(); };
  parser.ontext = (t) => { pila.at(-1).texto += t; };
  parser.oncdata = (t) => { pila.at(-1).texto += t; };
  parser.write(texto.replace(/^\uFEFF/, '')).close();
  return raiz;
}

/** Primer descendiente con ese nombre (búsqueda en profundidad). */
function buscar(nodo, nombre) {
  if (!nodo) return null;
  for (const h of nodo.hijos) {
    if (h.nombre === nombre) return h;
    const r = buscar(h, nombre);
    if (r) return r;
  }
  return null;
}

// ----- Documento electrónico -----

/** RUC sin el dígito verificador: algunos sistemas lo mandan como "80012345-6". */
const soloRuc = (s) => String(s ?? '').split('-')[0].replace(/\D/g, '');

/**
 * Extrae del XML los datos necesarios para contabilizar.
 * Lanza un Error con un mensaje claro si el archivo no es un documento de SIFEN.
 */
export function leerDocumento(texto) {
  let raiz;
  try {
    raiz = leerXml(texto);
  } catch {
    throw new Error('El archivo no es un XML válido.');
  }
  const de = buscar(raiz, 'DE');
  if (!de) throw new Error('No es un documento electrónico de SIFEN (falta el elemento DE).');
  const v = (nombre, base = de) => (buscar(base, nombre)?.texto ?? '').trim();

  const tot = buscar(de, 'gTotSub');
  const ae = buscar(de, 'gCamAE'); // datos del vendedor en una autofactura
  return {
    cdc: String(de.attrs.Id ?? '').trim(),
    tipo: Number(v('iTiDE')),
    fecha: v('dFeEmiDE').slice(0, 10),
    timbrado: v('dNumTim'),
    numero: [v('dEst'), v('dPunExp'), v('dNumDoc')].join('-'),
    emisor: { ruc: soloRuc(v('dRucEm')), dv: v('dDVEmi'), nombre: v('dNomEmi') || v('dRazSocEm') },
    receptor: {
      contribuyente: v('iNatRec') !== '2',
      ruc: soloRuc(v('dRucRec')) || v('dNumIDRec') || '0',
      dv: v('dDVRec'),
      nombre: v('dNomRec') || v('dRazSocRec') || 'Sin nombre',
    },
    vendedor: ae ? { ruc: v('dNumIDVen', ae) || '0', dv: '', nombre: v('dNomVen', ae) || 'Sin nombre' } : null,
    condicion: v('iCondOpe') === '2' ? 'credito' : 'contado',
    moneda: v('cMoneOpe') || 'PYG',
    tipoCambio: v('dTiCam') || '1',
    totales: tot ? {
      base10: v('dBaseGrav10', tot) || '0', iva10: v('dIVA10', tot) || '0',
      base5: v('dBaseGrav5', tot) || '0', iva5: v('dIVA5', tot) || '0',
      total: v('dTotGralOpe', tot) || '0', totalGs: v('dTotalGs', tot),
    } : null,
  };
}

// ----- Importes en guaraníes -----

const ESCALA = 8;
function aEscala(texto) {
  const s = String(texto ?? '0').trim() || '0';
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`Importe inválido en el XML: "${s}"`);
  const neg = s.startsWith('-');
  const [e, f = ''] = (neg ? s.slice(1) : s).split('.');
  const n = BigInt(e) * 10n ** BigInt(ESCALA) + BigInt((f + '0'.repeat(ESCALA)).slice(0, ESCALA));
  return neg ? -n : n;
}

/** Convierte un importe (en la moneda del documento) a guaraníes enteros, redondeando. Devuelve centavos. */
function aGuaranies(valor, tipoCambio) {
  const producto = aEscala(valor) * aEscala(tipoCambio); // escala 16
  const div = 10n ** BigInt(ESCALA * 2);
  const neg = producto < 0n;
  const abs = neg ? -producto : producto;
  const gs = (abs + div / 2n) / div;
  return (neg ? -gs : gs) * 100n;
}

/**
 * Importes del documento en guaraníes. La parte exenta se calcula como diferencia
 * contra el total, así el asiento siempre cuadra con lo que dice el comprobante.
 */
export function importes(doc) {
  const t = doc.totales;
  const tc = doc.moneda === 'PYG' ? '1' : doc.tipoCambio;
  const base10 = aGuaranies(t.base10, tc);
  const iva10 = aGuaranies(t.iva10, tc);
  const base5 = aGuaranies(t.base5, tc);
  const iva5 = aGuaranies(t.iva5, tc);
  const total = doc.moneda !== 'PYG' && t.totalGs ? aGuaranies(t.totalGs, '1') : aGuaranies(t.total, tc);
  const exenta = total - base10 - iva10 - base5 - iva5;
  return {
    base10: deCentavos(base10), iva10: deCentavos(iva10), base5: deCentavos(base5), iva5: deCentavos(iva5),
    exenta: deCentavos(exenta), total: deCentavos(total), cuadra: exenta >= 0n && total > 0n,
  };
}

// ----- Clasificación: ¿es una venta o una compra de la empresa? -----

export function clasificar(doc, rucEmpresa) {
  const ruc = String(rucEmpresa);
  if (doc.tipo === 4) {
    // En la autofactura la empresa emite el documento, pero es una compra a un no contribuyente.
    if (doc.emisor.ruc === ruc) return { operacion: 'compra', contraparte: doc.vendedor ?? { ruc: '0', dv: '', nombre: 'Sin nombre' } };
    return { operacion: null, problema: 'La autofactura no fue emitida por esta empresa.' };
  }
  if (doc.emisor.ruc === ruc) return { operacion: 'venta', contraparte: doc.receptor };
  if (doc.receptor.ruc === ruc) return { operacion: 'compra', contraparte: { ruc: doc.emisor.ruc, dv: doc.emisor.dv, nombre: doc.emisor.nombre } };
  return { operacion: null, problema: `El documento no es de esta empresa: emisor ${doc.emisor.ruc}, receptor ${doc.receptor.ruc}.` };
}

// ----- Asiento -----

export const CUENTAS = {
  deudores: '1.1.03', proveedores: '2.1.01',
  ventas10: '4.1.01', ventas5: '4.1.02', ventasExentas: '4.1.03',
  ivaDebito10: '2.1.02', ivaDebito5: '2.1.03', ivaCredito10: '1.1.04', ivaCredito5: '1.1.05',
};

/**
 * Líneas del asiento. Las notas de crédito invierten el asiento de la factura.
 * cuentaContado: caja o banco para operaciones al contado.
 * cuentaGasto: a dónde va la compra (gasto, mercaderías, bien de uso).
 * cuentaIngreso: en ventas, una cuenta única para lo facturado (por ejemplo "Otros ingresos");
 *   si falta, se usan las cuentas de ventas gravadas 10%, 5% y exentas.
 */
export function lineasAsiento(operacion, doc, imp, { cuentaContado, cuentaGasto, cuentaIngreso }) {
  const esNotaCredito = doc.tipo === 5;
  // Las notas de crédito no tienen condición: ajustan la cuenta del cliente o del proveedor.
  const contado = !esNotaCredito && doc.condicion === 'contado';
  const lineas = [];
  const agregar = (cuenta, debe, haber) => {
    if (debe === '0.00' && haber === '0.00') return;
    // Nota de crédito: lo que iba al debe va al haber y viceversa.
    lineas.push(esNotaCredito ? { cuenta, debe: haber, haber: debe } : { cuenta, debe, haber });
  };
  const Z = '0.00';
  if (operacion === 'venta') {
    agregar(contado ? cuentaContado : CUENTAS.deudores, imp.total, Z);
    if (cuentaIngreso) {
      agregar(cuentaIngreso, Z, sumar([imp.base10, imp.base5, imp.exenta]));
      agregar(CUENTAS.ivaDebito10, Z, imp.iva10);
      agregar(CUENTAS.ivaDebito5, Z, imp.iva5);
    } else {
      agregar(CUENTAS.ventas10, Z, imp.base10);
      agregar(CUENTAS.ivaDebito10, Z, imp.iva10);
      agregar(CUENTAS.ventas5, Z, imp.base5);
      agregar(CUENTAS.ivaDebito5, Z, imp.iva5);
      agregar(CUENTAS.ventasExentas, Z, imp.exenta);
    }
  } else {
    const neto = sumar([imp.base10, imp.base5, imp.exenta]);
    agregar(cuentaGasto, neto, Z);
    agregar(CUENTAS.ivaCredito10, imp.iva10, Z);
    agregar(CUENTAS.ivaCredito5, imp.iva5, Z);
    agregar(contado ? cuentaContado : CUENTAS.proveedores, Z, imp.total);
  }
  return lineas;
}

export function concepto(operacion, doc, contraparte) {
  const tipo = TIPOS_DE[doc.tipo] ?? 'Comprobante';
  return `${operacion === 'venta' ? 'Venta' : 'Compra'} s/ ${tipo.toLowerCase()} ${doc.numero}, ${contraparte.nombre}`;
}
