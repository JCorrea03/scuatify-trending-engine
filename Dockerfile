FROM node:20-alpine

WORKDIR /app

# Primero solo los archivos de dependencias (aprovecha la caché de capas de Docker)
COPY package*.json ./
RUN npm ci --omit=dev

# Luego el código
COPY server.js ./

ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "server.js"]
