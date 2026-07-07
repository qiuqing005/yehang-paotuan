FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY apps/web/package*.json apps/web/
COPY apps/server/package*.json apps/server/
RUN npm ci
COPY apps/web apps/web
RUN npm --workspace apps/web run build

FROM caddy:2.10-alpine
COPY --from=build /app/apps/web/dist /usr/share/caddy
CMD ["caddy", "file-server", "--root", "/usr/share/caddy", "--listen", ":8080"]
