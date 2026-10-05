# Partida en la nube (varios estudios contables)

Es el mismo sistema que se instala en un estudio, con una diferencia: con `MULTI_ESTUDIO=true` una sola
instalación atiende a varios estudios contables. Cada estudio tiene sus usuarios y sus empresas clientes y
no ve nada de los demás; la separación la hace PostgreSQL con seguridad por fila, igual que entre empresas.

## Quién hace qué

| Usuario | Qué ve |
|---|---|
| Administrador de la plataforma | **Plataforma → Estudios contables**: crea estudios con su primer administrador, los desactiva o reactiva. No ve la contabilidad de los estudios. |
| Administrador de un estudio | Lo mismo que en una instalación local: empresas, usuarios, accesos y **Datos del estudio**, solo de su estudio. |
| Contadores y auxiliares | Las empresas de su estudio que tengan asignadas, con su rol. |

Los nombres de usuario y los emails son únicos en toda la plataforma, así nadie tiene que elegir su estudio
al iniciar sesión.

## Opción recomendada: un servidor propio con Docker

Sirve cualquier VPS con Linux (DigitalOcean, Hetzner, Contabo, un servidor de Tigo o Copaco, etc.) con al
menos 1 GB de memoria, Docker instalado y un dominio que apunte a la IP del servidor.

```bash
git clone https://github.com/kekoaranda/cont-multi.git partida
cd partida/nube
cp env.example .env      # completar las claves, el dominio y el administrador
docker compose up -d --build
```

Eso levanta tres contenedores:

- `db`: PostgreSQL 16, con los datos en el volumen `datos`.
- `app`: Partida. En cada arranque aplica las migraciones pendientes y después inicia el servidor.
- `caddy`: atiende `https://DOMINIO` y renueva el certificado solo.

Al terminar, entrar a `https://DOMINIO` con `ADMIN_USUARIO` y `ADMIN_CLAVE`, crear los estudios en
**Plataforma → Estudios contables** y borrar `ADMIN_CLAVE` del `.env`.

### Actualizar

```bash
cd partida && git pull
cd nube && docker compose up -d --build
```

### Copias de seguridad

```bash
docker compose exec db pg_dump -U postgres -Fc contable > partida-$(date +%F).dump
```

Conviene programarlo con `cron` y copiar el archivo fuera del servidor. Para restaurar:
`docker compose exec -T db pg_restore -U postgres -d contable --clean < archivo.dump`.

## Otras opciones

La imagen (`Dockerfile` en la raíz) funciona en servicios como Render, Railway o Fly.io con una base
PostgreSQL administrada. Hay que darle las mismas variables que en `env.example`, más:

- `DATABASE_URL_ADMIN`: el usuario dueño de la base. Tiene que poder crear roles (`CREATE ROLE`), porque la
  primera migración crea `contable_app`. Algunos servicios no lo permiten desde SQL: en ese caso hay que
  crear el rol `contable_app` desde su panel antes del primer arranque.
- `DATABASE_URL`: la conexión con el rol `contable_app` y la clave de `DB_APP_PASSWORD`.
- `MULTI_ESTUDIO=true` y `COOKIE_SEGURA=true` (el servicio sirve por HTTPS).

## Pasar un estudio que ya trabaja con una instalación local

Por ahora no hay una importación automática. Una instalación local es un estudio único (el estudio 1) y se
puede subir entera a un servidor nuevo con `pg_dump` y `pg_restore`. Unir varias instalaciones locales en una
misma plataforma requiere renumerar los registros y queda para una próxima etapa.
