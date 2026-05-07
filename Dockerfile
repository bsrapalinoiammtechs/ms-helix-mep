
FROM node:20-alpine

WORKDIR /app
COPY package*.json tsconfig.json .env ./

RUN npm install

COPY . .
RUN npm run build
EXPOSE 3005

CMD ["npm", "run", "start"]

