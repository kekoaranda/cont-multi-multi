-- Los cierres y reaperturas de periodos también quedan auditados.
CREATE TRIGGER aud_periodos AFTER INSERT OR UPDATE OR DELETE ON periodos
    FOR EACH ROW EXECUTE FUNCTION fn_auditar();
CREATE TRIGGER aud_cuentas AFTER INSERT OR UPDATE OR DELETE ON cuentas
    FOR EACH ROW EXECUTE FUNCTION fn_auditar();
