FROM node:22-alpine AS build
WORKDIR /app
COPY src/frontend/package.json ./
RUN npm install --no-audit --no-fund
COPY src/frontend/ ./
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
