FROM node:22-alpine
WORKDIR /app
RUN adduser -D -u 10001 appuser
COPY package.json server.js ./
RUN npm install jose@6.2.13 --omit=dev
USER appuser
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
