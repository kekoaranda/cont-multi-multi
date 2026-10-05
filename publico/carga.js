// Ayudas del formulario de carga rápida. Todo se vuelve a validar en el servidor al guardar.
(function () {
  var form = document.getElementById('form-carga');
  if (!form) return;
  var fmt = new Intl.NumberFormat('es-PY');

  // "1.500.000" → 1500000 (guaraníes enteros)
  function gs(texto) {
    var limpio = String(texto || '').replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
    var n = Number(limpio);
    return isFinite(n) ? Math.round(n) : 0;
  }
  function campo(id) { return document.getElementById(id); }

  // IVA calculado como sugerencia (placeholder) y total de la factura
  function actualizar() {
    var g10 = gs(campo('grav10').value), g5 = gs(campo('grav5').value), ex = gs(campo('exenta').value);
    campo('iva10').placeholder = g10 ? fmt.format(Math.round(g10 / 11)) : 'Se calcula';
    campo('iva5').placeholder = g5 ? fmt.format(Math.round(g5 / 21)) : 'Se calcula';
    campo('total-carga').textContent = fmt.format(g10 + g5 + ex);
  }
  form.addEventListener('input', function (e) { if (e.target.classList.contains('importe')) actualizar(); });

  // Al elegir la plantilla se resalta la columna donde suele ir el importe
  function resaltarColumna() {
    var opcion = campo('plantilla').selectedOptions[0];
    var columna = opcion ? opcion.getAttribute('data-columna') : null;
    form.querySelectorAll('[data-columna]').forEach(function (div) {
      div.classList.toggle('destacado', div.tagName === 'DIV' && div.getAttribute('data-columna') === columna);
    });
    return columna;
  }
  campo('plantilla').addEventListener('change', function () {
    var columna = resaltarColumna();
    var destino = columna === '5' ? 'grav5' : columna === 'exenta' ? 'exenta' : 'grav10';
    if (columna) campo(destino).focus();
  });

  // Al salir del RUC se completan la razón social y la última plantilla usada con ese cliente o proveedor
  campo('ruc').addEventListener('change', function () {
    var ruc = campo('ruc').value.trim();
    if (!ruc) return;
    var url = window.location.pathname.replace(/\/$/, '') + '/tercero?libro=' + form.getAttribute('data-libro') + '&ruc=' + encodeURIComponent(ruc);
    fetch(url, { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (t) {
        if (!t) return;
        if (!campo('razonSocial').value) campo('razonSocial').value = t.razonSocial;
        if (t.plantilla && !campo('plantilla').value) {
          campo('plantilla').value = String(t.plantilla);
          resaltarColumna();
        }
      })
      .catch(function () { /* sin conexión: se completa al guardar */ });
  });

  resaltarColumna();
  actualizar();
})();
