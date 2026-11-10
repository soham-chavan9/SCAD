# Hostile sample (T2.8). Builds offline (--network=none): Node built-ins only.
FROM node:22-alpine
USER node
WORKDIR /home/node/app
COPY *.js ./
EXPOSE 8080
CMD ["node", "server.js"]
