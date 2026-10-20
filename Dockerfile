
FROM node:20-alpine

WORKDIR /app
# El .env NO se copia a la imagen: la configuración llega solo por `env_file` del compose.
# Si se copiara, `dotenv` (import "dotenv/config") rellenaría en el proceso las variables que se
# quiten luego del .env del servidor (así quedaron activas las TCP_SILENT_* en -wh, 20-oct-2026).
COPY package*.json tsconfig.json ./

RUN npm install

COPY . .
RUN npm run build
EXPOSE 3005

CMD ["npm", "run", "start"]

