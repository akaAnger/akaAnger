FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node package.json start.mjs ./
COPY --chown=node:node src ./src
COPY --chown=node:node web ./web
RUN mkdir -p /app/.data && chown node:node /app/.data
USER node
ENV HOST=0.0.0.0 PORT=8787 DATA_DIR=/app/.data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "start.mjs"]
