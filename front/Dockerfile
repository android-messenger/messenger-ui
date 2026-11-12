# Build + serve the messenger web client as a container: a zero-dependency static
# server (server.mjs) on port 5555, mounted by the edge under BASE.
#
#   docker build --build-arg BASE=/messenger-ui/ -t messenger-ui ./front
#
FROM node:20-alpine AS build
WORKDIR /app
# Reproducible, pinned install from the committed lockfile (supply-chain integrity:
# the shipped JS is only as trustworthy as its dependency tree). `npm ci` fails hard
# if package.json and package-lock.json disagree — no silent drift at build time.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Vite base = the edge subpath the SPA is mounted under. We run `npx vite build`
# directly: type checks, lint and tests run in CI (`npm run ci`), not in the image build.
ARG BASE=/messenger-ui/
# Build-time frontend config baked into the bundle (Vite exposes VITE_* from the
# environment). No admin keys are baked: the IDS directory is session-authed and
# the messenger lets a signed-in user create a chat they are part of.
ARG VITE_MESSENGER_BASE=/messenger
ARG VITE_KRATOS_URL=/.ory/kratos/public
# Required, no default: the STUN/TURN server of the stack this image is built for.
ARG VITE_TURN_HOST
ARG VITE_TURN_PORT
# TURN username/password are NO LONGER baked — the client fetches short-lived TURN creds at call time
# (coturn use-auth-secret via /key-directory/v1/turn/credentials). Only the STUN host:port is needed here
# (wolpertinger: --build-arg VITE_TURN_HOST=m.wolpertinger.work --build-arg VITE_TURN_PORT=3480).
# Write .env.production so Vite reliably picks the values up (it loads .env* files
# for `vite build`; reading them from the process env is not guaranteed).
RUN { \
      echo "VITE_MESSENGER_BASE=$VITE_MESSENGER_BASE"; \
      echo "VITE_KRATOS_URL=$VITE_KRATOS_URL"; \
      echo "VITE_TURN_HOST=$VITE_TURN_HOST"; \
      echo "VITE_TURN_PORT=$VITE_TURN_PORT"; \
    } > .env.production
RUN npx vite build --base="$BASE"

FROM node:20-alpine
WORKDIR /app
ENV PORT=5555 HOST=0.0.0.0 NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/server.mjs ./server.mjs
EXPOSE 5555
CMD ["node", "server.mjs"]
