// Totales en vivo del formulario de asiento. Es solo una ayuda visual:
// el servidor y la base de datos vuelven a validar la partida doble al guardar.
(function () {
  var form = document.getElementById('form-asiento');
  if (!form) return;
  var fmt = new Intl.NumberFormat('es-PY', { maximumFractionDigits: 2 });

  // "1.500.000" o "1.250,50" → centavos (entero), para sumar sin errores de redondeo
  function centavos(texto) {
    var limpio = String(texto || '').trim().replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
    if (!/^\d+(\.\d{1,2})?$/.test(limpio)) return 0;
    var partes = limpio.split('.');
    return parseInt(partes[0], 10) * 100 + parseInt(((partes[1] || '') + '00').slice(0, 2), 10);
  }

  function sumar(selector) {
    var total = 0;
    form.querySelectorAll(selector).forEach(function (el) { total += centavos(el.value); });
    return total;
  }

  function actualizar() {
    var d = sumar('input.debe'), h = sumar('input.haber');
    document.getElementById('total-debe').textContent = fmt.format(d / 100);
    document.getElementById('total-haber').textContent = fmt.format(h / 100);
    var estado = document.getElementById('estado-balance');
    if (d === 0 && h === 0) {
      estado.textContent = 'Sin importes'; estado.className = 'balance mal';
    } else if (d === h) {
      estado.textContent = 'Balanceado'; estado.className = 'balance ok';
    } else {
      estado.textContent = 'Diferencia ' + fmt.format(Math.abs(d - h) / 100); estado.className = 'balance mal';
    }
  }

  document.getElementById('totales').hidden = false;
  form.addEventListener('input', function (e) {
    if (e.target.classList.contains('importe')) actualizar();
  });
  actualizar();
})();
