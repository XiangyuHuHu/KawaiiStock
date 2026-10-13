FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json server.js ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY public ./public
COPY data ./data
COPY reports ./reports
COPY scripts ./scripts

ENV NODE_ENV=production
ENV PORT=3479
ENV HOST=0.0.0.0

RUN chown -R node:node /app
USER node

EXPOSE 3479

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3479/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
