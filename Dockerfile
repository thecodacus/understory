FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile
COPY packages packages
RUN pnpm -r build && pnpm prune --prod

FROM node:22-alpine
# GIT_AUTOCOMMIT shells out to git (issue #21). Alpine ships none, and a bare
# container also lacks a committer identity and trips git's dubious-ownership
# check on bind-mounted bundles — cover all three here. The wildcard
# safe.directory is acceptable in a single-purpose container whose only
# writable tree is the bundle.
RUN apk add --no-cache git \
 && git config --system --add safe.directory '*' \
 && git config --system user.name "understory" \
 && git config --system user.email "understory@localhost"
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/core/package.json packages/core/
COPY --from=build /app/packages/core/node_modules packages/core/node_modules
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/server/package.json packages/server/
COPY --from=build /app/packages/server/node_modules packages/server/node_modules
COPY --from=build /app/packages/web/dist packages/web/dist

ENV BUNDLE_ROOT=/bundle PORT=3800
EXPOSE 3800
VOLUME /bundle
CMD ["node", "packages/server/dist/index.js"]
