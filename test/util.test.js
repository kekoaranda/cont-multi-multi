import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dvRuc, gs, leerImporte, sumar, validarLineas } from '../src/util.js';

test('dígito verificador del RUC', () => {
  assert.equal(dvRuc('80045123'), 6);
  assert.equal(dvRuc('80011111'), 7);
  assert.equal(dvRuc('80.045.123'), 6);
});

test('lee importes escritos como en las facturas', () => {
  assert.equal(leerImporte('1.500.000', 'x'), '1500000.00');
  assert.equal(leerImporte('1.250,50', 'x'), '1250.50');
  assert.equal(leerImporte('', 'x'), '0.00');
  assert.throws(() => leerImporte('12,345', 'x'), /importe inválido/);
  assert.throws(() => leerImporte('abc', 'x'), /importe inválido/);
});

test('muestra importes con separador de miles', () => {
  assert.equal(gs('1500000.00'), '1.500.000');
  assert.equal(gs('1250.50'), '1.250,50');
  assert.equal(gs('-5.00'), '-5');
});

test('suma sin errores de coma flotante', () => {
  assert.equal(sumar(['0.10', '0.20']), '0.30');
});

test('partida doble', () => {
  validarLineas([{ cuenta: '5.2.06', debe: '50000.00', haber: '0.00' }, { cuenta: '1.1.02', debe: '0.00', haber: '50000.00' }]);
  assert.throws(() => validarLineas([{ cuenta: '1', debe: '100.00', haber: '0.00' }, { cuenta: '2', debe: '0.00', haber: '99.99' }]), /no balancea/);
  assert.throws(() => validarLineas([{ cuenta: '1', debe: '100.00', haber: '100.00' }, { cuenta: '2', debe: '0.00', haber: '0.00' }]), (e) => e.detalles[0].startsWith('Línea 1'));
  assert.throws(() => validarLineas([{ cuenta: '1', debe: '1.00', haber: '0.00' }]), /al menos dos/);
});

import { importesManuales, ivaIncluido, normalizarNumero } from '../src/util.js';

test('IVA incluido en montos gravados', () => {
  assert.equal(ivaIncluido('110000.00', 10), '10000.00');
  assert.equal(ivaIncluido('105000.00', 5), '5000.00');
  assert.equal(ivaIncluido('100000.00', 10), '9091.00'); // 9090,9 → 9091
});

test('importes de una factura en papel', () => {
  const i = importesManuales({ grav10: '1.100.000', iva10: '', grav5: '210.000', iva5: '', exenta: '50.000' });
  assert.deepEqual([i.base10, i.iva10, i.base5, i.iva5, i.exenta, i.total],
    ['1000000.00', '100000.00', '200000.00', '10000.00', '50000.00', '1360000.00']);
  // El IVA escrito a mano puede diferir un poco por redondeo...
  assert.equal(importesManuales({ grav10: '100.000', iva10: '9.090' }).iva10, '9090.00');
  // ...pero no cualquier cosa.
  assert.throws(() => importesManuales({ grav10: '100.000', iva10: '20.000' }), /no corresponde/);
  assert.throws(() => importesManuales({}), /al menos un importe/);
});

test('número de comprobante', () => {
  assert.equal(normalizarNumero('1-1-123'), '001-001-0000123');
  assert.equal(normalizarNumero('001-002-0004521'), '001-002-0004521');
  assert.equal(normalizarNumero('0010020004521'), '001-002-0004521');
  assert.equal(normalizarNumero('abc'), null);
  assert.equal(normalizarNumero('1-1-12345678'), null);
});
