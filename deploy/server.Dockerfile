FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY apps/server/package*.json apps/server/
COPY apps/web/package*.json apps/web/
RUN npm ci
COPY apps/server apps/server
RUN npm --workspace apps/server run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY apps/server/package*.json apps/server/
COPY apps/web/package*.json apps/web/
RUN npm ci --omit=dev --workspace apps/server
COPY --from=build /app/apps/server/dist apps/server/dist
RUN mkdir -p /app/data
EXPOSE 8787
CMD ["npm", "--workspace", "apps/server", "run", "start"]
