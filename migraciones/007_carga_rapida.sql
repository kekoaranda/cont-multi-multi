-- Carga rápida de comprobantes en papel con plantillas de asiento.

-- 1. Cuenta nueva en el plan base, útil para una de las plantillas.
INSERT INTO plantilla_cuentas (codigo, nombre, tipo, imputable, codigo_padre)
VALUES ('5.2.09', 'Combustibles y lubricantes', 'GASTO', true, '5')
ON CONFLICT (codigo) DO NOTHING;

-- Las empresas existentes también la reciben (si no tienen ya ese código).
INSERT INTO cuentas (empresa_id, codigo, nombre, tipo, imputable, padre_id)
SELECT e.id, '5.2.09', 'Combustibles y lubricantes', 'GASTO', true, p.id
  FROM empresas e JOIN cuentas p ON p.empresa_id = e.id AND p.codigo = '5'
 WHERE NOT EXISTS (SELECT 1 FROM cuentas c WHERE c.empresa_id = e.id AND c.codigo = '5.2.09');

-- 2. Plantillas base del estudio: se copian a cada empresa, que después las ajusta.
CREATE TYPE columna_iva AS ENUM ('10', '5', 'exenta');

CREATE TABLE plantillas_base (
    nombre        text PRIMARY KEY,
    libro         tipo_libro NOT NULL,
    cuenta_codigo varchar(20) REFERENCES plantilla_cuentas(codigo), -- en ventas, vacío = ventas gravadas/exentas según la tasa
    columna       columna_iva NOT NULL DEFAULT '10',                -- dónde va el importe por defecto
    imputa_iva    boolean NOT NULL DEFAULT true,
    imputa_ire    boolean NOT NULL DEFAULT true,
    imputa_irp    boolean NOT NULL DEFAULT false
);

INSERT INTO plantillas_base (nombre, libro, cuenta_codigo, columna) VALUES
('Mercaderías',                    'COMPRA', '1.1.06', '10'),
('Mercaderías de la canasta (5%)', 'COMPRA', '1.1.06', '5'),
('Combustible',                    'COMPRA', '5.2.09', '10'),
('Alquiler',                       'COMPRA', '5.2.03', '10'),
('Servicios básicos',              'COMPRA', '5.2.04', '10'),
('Honorarios profesionales',       'COMPRA', '5.2.05', '10'),
('Gastos bancarios',               'COMPRA', '5.2.06', '10'),
('Muebles y útiles',               'COMPRA', '1.2.01', '10'),
('Gastos varios',                  'COMPRA', '5.2.08', '10'),
('Venta de mercaderías',           'VENTA',  NULL,     '10'),
('Venta exenta',                   'VENTA',  NULL,     'exenta'),
('Otros ingresos',                 'VENTA',  '4.1.04', '10');

-- 3. Plantillas de cada empresa.
CREATE TABLE plantillas (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    empresa_id  bigint NOT NULL REFERENCES empresas(id),
    nombre      text NOT NULL,
    libro       tipo_libro NOT NULL,
    cuenta_id   bigint,
    columna     columna_iva NOT NULL DEFAULT '10',
    imputa_iva  boolean NOT NULL DEFAULT true,
    imputa_ire  boolean NOT NULL DEFAULT true,
    imputa_irp  boolean NOT NULL DEFAULT false,
    activa      boolean NOT NULL DEFAULT true,
    UNIQUE (empresa_id, libro, nombre),
    UNIQUE (empresa_id, id),
    FOREIGN KEY (empresa_id, cuenta_id) REFERENCES cuentas(empresa_id, id),
    -- Toda compra necesita una cuenta de destino.
    CHECK (libro = 'VENTA' OR cuenta_id IS NOT NULL)
);

CREATE OR REPLACE FUNCTION fn_copiar_plantillas(p_empresa bigint) RETURNS void AS $$
    INSERT INTO plantillas (empresa_id, nombre, libro, cuenta_id, columna, imputa_iva, imputa_ire, imputa_irp)
    SELECT p_empresa, b.nombre, b.libro, c.id, b.columna, b.imputa_iva, b.imputa_ire, b.imputa_irp
      FROM plantillas_base b
      LEFT JOIN cuentas c ON c.empresa_id = p_empresa AND c.codigo = b.cuenta_codigo
     WHERE b.cuenta_codigo IS NULL OR c.id IS NOT NULL
    ON CONFLICT (empresa_id, libro, nombre) DO NOTHING
$$ LANGUAGE sql;

SELECT fn_copiar_plantillas(id) FROM empresas;

-- 4. Última plantilla usada con cada cliente y proveedor: se propone sola la próxima vez.
ALTER TABLE terceros ADD COLUMN plantilla_compra_id bigint;
ALTER TABLE terceros ADD COLUMN plantilla_venta_id  bigint;
ALTER TABLE terceros ADD FOREIGN KEY (empresa_id, plantilla_compra_id) REFERENCES plantillas(empresa_id, id) ON DELETE SET NULL (plantilla_compra_id);
ALTER TABLE terceros ADD FOREIGN KEY (empresa_id, plantilla_venta_id)  REFERENCES plantillas(empresa_id, id) ON DELETE SET NULL (plantilla_venta_id);

-- 5. Seguridad y permisos.
ALTER TABLE plantillas ENABLE ROW LEVEL SECURITY;
ALTER TABLE plantillas FORCE ROW LEVEL SECURITY;
CREATE POLICY pol_empresa ON plantillas
    USING (fn_es_admin() OR empresa_id IN (SELECT fn_empresas_permitidas()))
    WITH CHECK (fn_es_admin() OR empresa_id IN (SELECT fn_empresas_permitidas()));

CREATE TRIGGER aud_plantillas AFTER INSERT OR UPDATE OR DELETE ON plantillas
    FOR EACH ROW EXECUTE FUNCTION fn_auditar();

GRANT SELECT, INSERT, UPDATE, DELETE ON plantillas TO contable_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO contable_app;
GRANT SELECT ON plantillas_base TO contable_app;
GRANT EXECUTE ON FUNCTION fn_copiar_plantillas(bigint) TO contable_app;
