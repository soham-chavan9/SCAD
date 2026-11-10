# No RUN step needs the network: SCAD builds with --network=none (INV8).
FROM node:22-alpine
USER node
WORKDIR /home/node/app
COPY server.js ./
ENV PORT=8080 NODE_NO_WARNINGS=1
EXPOSE 8080
CMD ["node", "server.js"]
