FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /app/output /app/.auth && chown -R pwuser:pwuser /app

USER pwuser

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=10000 \
    HOSTED_MODE=1

EXPOSE 10000

CMD ["npm", "start"]
