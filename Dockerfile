FROM oven/bun:1

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install

COPY . .
RUN bun run build

ENV NODE_ENV=production
EXPOSE 3000

# Bun é o runtime (exigência do desafio); `dist/` é a saída do `nest build`.
CMD ["bun", "dist/main.js"]
