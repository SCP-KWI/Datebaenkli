# ---- build ------------------------------------------------------------------
#
# **The build context is the repository root, not `app/`** (see the `build:`
# block in docker-compose.yml). It moved there when `/handbuch` was added:
# `postbuild` copies `docs/handbuch.html` into `dist/web/`, so the handbook has
# exactly one checked-in copy and the image gets it the same way the dev machine
# does. A context of `app/` cannot see a sibling directory at all.
#
# The consequence is that every source path below is repo-relative, and that
# `WORKDIR` is `/build/app` rather than `/build` — the image mirrors the repo's
# layout so that `../docs/handbuch.html` means the same thing in both places.
# Do not "simplify" it back to `/build`: the copy in `postbuild` would then
# reach outside the build tree.
FROM node:22-alpine AS build
WORKDIR /build/app

COPY app/package.json app/package-lock.json* ./
RUN npm ci

COPY app/tsconfig.json ./
COPY app/src ./src
# `tools/` is needed *at build time*, not at runtime: `postbuild` runs
# `tools/stamp-build.mjs` to write dist/build-info.json, which is what the
# footer's build time comes from. Omitting this is not a subtle failure — the
# image build stops with MODULE_NOT_FOUND — but it is invisible on the dev
# machine, where `npm run build` runs in a repo that has the directory. It cost
# one broken deploy to learn.
#
# The whole directory rather than the one file, so that adding a second
# build-time tool does not break the image again. It is discarded with this
# stage; only node_modules and dist reach the runtime layer.
COPY app/tools ./tools
# The one file, not `docs/`: the rest of that directory is 300 kB of Markdown
# and a Puppeteer-driven generator that has no business in a build context.
# `postbuild` copies it into dist/web, so a missing file fails the image build
# loudly here rather than becoming a 404 on the server.
COPY docs/handbuch.html /build/docs/handbuch.html
RUN npm run build

# prune to production deps for the runtime layer
RUN npm ci --omit=dev

# ---- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# pg_dump / pg_restore for schema archival (phases 2 and 5).
# Major version MUST match the server (postgres:17-alpine) or dumps fail.
RUN apk add --no-cache postgresql17-client tini

COPY --from=build /build/app/node_modules ./node_modules
# dist already contains db/sql and web/handbuch.html — `npm run postbuild`
# copies the migration files, since tsc only emits .js, and the handbook, which
# lives outside `app/`. Keeping that in one place means a local
# `npm run build && npm start` behaves the same as the container.
COPY --from=build /build/app/dist ./dist
COPY app/package.json ./

RUN mkdir -p /var/lib/datebaenkli/backups /var/lib/datebaenkli/archive \
    && chown -R node:node /var/lib/datebaenkli

USER node
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
