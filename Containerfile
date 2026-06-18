FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=optional

COPY . .
RUN mkdir -p static && npm run build

FROM node:22-alpine AS runtime

WORKDIR /app

RUN apk add --no-cache procps

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional

COPY --from=builder /app/build ./build
COPY --from=builder /app/static ./static

EXPOSE 35001

CMD ["node", "build/index.js"]
