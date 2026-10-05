import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import JSZip from 'jszip';
import { clasificar, extraerXml, importes, leerDocumento, lineasAsiento } from '../src/sifen.js';
import { validarLineas } from '../src/util.js';

const xml = (n) => fs.readFileSync(new URL(`./xml/${n}`, import.meta.url), 'utf8');
const EMPRESA = '80045123';
const opciones = { cuentaContado: '1.1.01', cuentaGasto: '5.2.08' };

test('factura de venta al contado con IVA 10%, 5% y exentas', () => {
  const doc = leerDocumento(xml('venta-contado.xml'));
  assert.equal(doc.cdc, '01800451236001001000012522026091011234567890');
  assert.equal(doc.tipo, 1);
  assert.equal(doc.fecha, '2026-09-10');
  assert.equal(doc.numero, '001-001-0000125');
  assert.equal(doc.timbrado, '16543210');
  const c = clasificar(doc, EMPRESA);
  assert.equal(c.operacion, 'venta');
  assert.equal(c.contraparte.nombre, 'JUAN BENITEZ');
  const imp = importes(doc);
  assert.deepEqual(
    [imp.base10, imp.iva10, imp.base5, imp.iva5, imp.exenta, imp.total],
    ['2500000.00', '250000.00', '100000.00', '5000.00', '30000.00', '2885000.00'],
  );
  const lineas = lineasAsiento('venta', doc, imp, opciones);
  validarLineas(lineas);
  assert.deepEqual(lineas[0], { cuenta: '1.1.01', debe: '2885000.00', haber: '0.00' });
  assert.equal(lineas.length, 6);
});

test('compra a crédito en dólares: convierte a guaraníes y cuadra con el total en Gs', () => {
  const doc = leerDocumento(xml('compra-usd.xml'));
  assert.equal(doc.emisor.ruc, '80011111');
  assert.equal(doc.emisor.nombre, 'DISTRIBUIDORA CENTRAL S.R.L.');
  const c = clasificar(doc, EMPRESA);
  assert.equal(c.operacion, 'compra');
  const imp = importes(doc);
  assert.equal(imp.base10, '7350250.00');
  assert.equal(imp.iva10, '735025.00');
  assert.equal(imp.total, '8085275.00');
  assert.ok(imp.cuadra);
  const lineas = lineasAsiento('compra', doc, imp, { ...opciones, cuentaGasto: '1.1.06' });
  validarLineas(lineas);
  assert.deepEqual(lineas.at(-1), { cuenta: '2.1.01', debe: '0.00', haber: '8085275.00' });
});

test('nota de crédito de venta: invierte el asiento contra deudores', () => {
  const doc = leerDocumento(xml('nota-credito-venta.xml'));
  assert.equal(doc.tipo, 5);
  assert.equal(doc.receptor.ruc, '2345678');
  const c = clasificar(doc, EMPRESA);
  const lineas = lineasAsiento(c.operacion, doc, importes(doc), opciones);
  validarLineas(lineas);
  assert.deepEqual(lineas[0], { cuenta: '1.1.03', debe: '0.00', haber: '110000.00' });
  assert.deepEqual(lineas[1], { cuenta: '4.1.01', debe: '100000.00', haber: '0.00' });
});

test('documento de otra empresa y archivos inválidos', () => {
  const doc = leerDocumento(xml('venta-contado.xml'));
  assert.equal(clasificar(doc, '99999999').operacion, null);
  assert.throws(() => leerDocumento('<hola>'), /no es un XML válido|falta el elemento DE/);
  assert.throws(() => leerDocumento('<otro><cosa/></otro>'), /falta el elemento DE/);
});

test('lee XML sueltos y dentro de un ZIP', async () => {
  const zip = new JSZip();
  zip.file('carpeta/a.xml', xml('venta-contado.xml'));
  zip.file('leeme.txt', 'x');
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const r = await extraerXml([
    { originalname: 'lote.zip', buffer },
    { originalname: 'b.xml', buffer: Buffer.from(xml('compra-usd.xml')) },
    { originalname: 'foto.jpg', buffer: Buffer.from('x') },
  ]);
  assert.equal(r.xmls.length, 2);
  assert.equal(r.xmls[0].archivo, 'lote.zip › a.xml');
  assert.equal(r.errores.length, 1);
});
