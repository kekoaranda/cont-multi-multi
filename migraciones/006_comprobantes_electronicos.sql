-- Importación de comprobantes electrónicos (XML de SIFEN).

-- 1. Los importes de IVA pasan a guardarse tal como vienen en el XML, en vez de
--    calcularse: en facturas con muchos ítems el redondeo por ítem puede diferir
--    en un guaraní del cálculo sobre el total.
DROP VIEW IF EXISTS v_liquidacion_iva;
ALTER TABLE comprobantes ALTER COLUMN iva_10 DROP EXPRESSION;
ALTER TABLE comprobantes ALTER COLUMN iva_5  DROP EXPRESSION;
ALTER TABLE comprobantes ALTER COLUMN total  DROP EXPRESSION;
ALTER TABLE comprobantes ALTER COLUMN iva_10 SET DEFAULT 0;
ALTER TABLE comprobantes ALTER COLUMN iva_5  SET DEFAULT 0;
ALTER TABLE comprobantes ALTER COLUMN total  SET DEFAULT 0;
ALTER TABLE comprobantes ALTER COLUMN iva_10 SET NOT NULL;
ALTER TABLE comprobantes ALTER COLUMN iva_5  SET NOT NULL;
ALTER TABLE comprobantes ALTER COLUMN total  SET NOT NULL;

-- 2. Un mismo documento electrónico (CDC) no se importa dos veces en la misma empresa.
CREATE UNIQUE INDEX ux_comprobantes_cdc ON comprobantes (empresa_id, cdc) WHERE cdc IS NOT NULL;

-- 3. Liquidación de IVA: las notas de crédito (tipo 5) restan.
CREATE VIEW v_liquidacion_iva WITH (security_invoker = true) AS
SELECT empresa_id,
       date_trunc('month', fecha)::date AS mes,
       sum(CASE WHEN libro = 'VENTA' THEN s * (iva_10 + iva_5) ELSE 0 END) AS debito_fiscal,
       sum(CASE WHEN libro = 'COMPRA' AND imputa_iva THEN s * (iva_10 + iva_5) ELSE 0 END) AS credito_fiscal,
       sum(CASE WHEN libro = 'VENTA' THEN s * (iva_10 + iva_5) ELSE 0 END)
     - sum(CASE WHEN libro = 'COMPRA' AND imputa_iva THEN s * (iva_10 + iva_5) ELSE 0 END) AS saldo
  FROM (SELECT *, CASE WHEN tipo_comprobante = 5 THEN -1 ELSE 1 END AS s FROM comprobantes) c
 GROUP BY empresa_id, date_trunc('month', fecha);

-- 4. Cuenta de gasto que se usó la última vez con cada proveedor: se propone sola la próxima.
CREATE TABLE reglas_proveedor (
    empresa_id bigint NOT NULL REFERENCES empresas(id),
    ruc        varchar(15) NOT NULL,
    cuenta_id  bigint NOT NULL,
    PRIMARY KEY (empresa_id, ruc),
    FOREIGN KEY (empresa_id, cuenta_id) REFERENCES cuentas(empresa_id, id)
);
ALTER TABLE reglas_proveedor ENABLE ROW LEVEL SECURITY;
ALTER TABLE reglas_proveedor FORCE ROW LEVEL SECURITY;
CREATE POLICY pol_empresa ON reglas_proveedor
    USING (fn_es_admin() OR empresa_id IN (SELECT fn_empresas_permitidas()))
    WITH CHECK (fn_es_admin() OR empresa_id IN (SELECT fn_empresas_permitidas()));

GRANT SELECT, INSERT, UPDATE, DELETE ON reglas_proveedor TO contable_app;
GRANT SELECT ON v_liquidacion_iva TO contable_app;
