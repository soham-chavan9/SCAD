# Egress proxy (T2.1). Build: docker compose build egress-proxy
# Only Node built-ins: no install step, so it builds with --network=none too.
FROM node:22-alpine
WORKDIR /app
COPY src/proxy.ts /app/proxy.ts
USER node
ENV PORT=3128 EGRESS_POLICY_DIR=/policy
EXPOSE 3128
CMD ["node", "--experimental-strip-types", "--no-warnings", "/app/proxy.ts"]
