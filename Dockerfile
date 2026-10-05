# Imagen para servir Partida en la nube (ver nube/README.md).
# La instalación local no la usa: sigue con los instaladores de instalacion/.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY src ./src
COPY vistas ./vistas
COPY publico ./publico
COPY migraciones ./migraciones

USER node
EXPOSE 3000

# Las variables llegan del entorno (no hay archivo .env dentro de la imagen).
# Al arrancar aplica las migraciones pendientes y después inicia el servidor.
CMD ["sh", "-c", "node src/migrar.js && exec node src/app.js"]
