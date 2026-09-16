# Overridable nginx base for hosts whose older kernels cannot exec binaries from
# the newest Alpine package repo (e.g. some NAS units) — set to an older tag like
# nginx:1.27-alpine via the NGINX_BASE build arg.
ARG NGINX_BASE=nginx:alpine

FROM --platform=$BUILDPLATFORM node:22-alpine AS builder

WORKDIR /app

COPY frontend/package*.json ./
# electron is a devDependency used only for desktop packaging (electron-builder),
# never by the web/vite build. Skip its ~100MB binary download so the multi-arch
# image build (incl. arm64 under QEMU) stays fast and can't fail on a flaky fetch.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm ci

COPY . /repo
RUN cp -R /repo/frontend/. /app/

ARG VITE_BUILD_SHA
ENV VITE_BUILD_SHA=${VITE_BUILD_SHA:-dev}
ARG VITE_EMAIL_DIV_RENDER
ENV VITE_EMAIL_DIV_RENDER=${VITE_EMAIL_DIV_RENDER:-false}

RUN npm run build

FROM ${NGINX_BASE}

RUN apk add --no-cache openssl

COPY --from=builder /app/dist /usr/share/nginx/html

# nginx.conf is a template, rendered into /etc/nginx/conf.d/default.conf by the stock
# image's 20-envsubst-on-templates.sh at container start. The only substituted value is
# ${NGINX_LOCAL_RESOLVERS}, the resolver for `server ... resolve` (#448): it was hardcoded
# to Docker's 127.0.0.11, which does not exist on Podman, Kubernetes or any non-Docker
# network, so every /api/ proxy failed there after 3.4.x. NGINX_ENTRYPOINT_LOCAL_RESOLVERS
# turns on the image's own 15-local-resolvers.envsh, which reads the container's real
# /etc/resolv.conf; 16-resolver-default.envsh runs after it and falls back to 127.0.0.11
# if resolv.conf names no nameserver, so a bad environment degrades to the old behavior
# rather than to a config error and a dead container.
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
COPY frontend/nginx.conf /etc/nginx/templates/default.conf.template
COPY frontend/resolver-default.envsh /docker-entrypoint.d/16-resolver-default.envsh
COPY frontend/generate-cert.sh /docker-entrypoint.d/10-generate-cert.sh
RUN chmod +x /docker-entrypoint.d/10-generate-cert.sh /docker-entrypoint.d/16-resolver-default.envsh

EXPOSE 80 443

CMD ["nginx", "-g", "daemon off;"]
