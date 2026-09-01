# Runtime image for the Overture places ingest.
#
# A container image rather than a zip, because `./duckdb.ts` drives the DuckDB *command-line
# binary* through `execFileSync`. That is a deliberate choice recorded in that module — the
# demo query a presenter runs must be answered by the same engine that wrote the artifact —
# and a zipped Lambda has nowhere to put an executable of that shape or its extensions.
#
# Two things are resolved here at build time and never at run time:
#
#   1. The DuckDB binary, pinned by version rather than tracking a `latest` link.
#   2. `httpfs` and `spatial`, installed into an extension directory inside the image.
#
# Autoloading them on the invocation path would make a scheduled quarterly run depend on
# `extensions.duckdb.org` being reachable at that moment, and would try to write into a
# read-only filesystem. Both failures would be quarterly and neither would be obvious.
#
# The build fails loudly if any of that is missing: the extensions are asserted present in
# the builder, and the runtime stage loads them before the image is considered good.

ARG DUCKDB_VERSION=v1.5.5

FROM public.ecr.aws/amazonlinux/amazonlinux:2023 AS duckdb
ARG DUCKDB_VERSION
RUN dnf install -y --setopt=install_weak_deps=False unzip && dnf clean all
RUN curl -fsSL -o /tmp/duckdb.zip \
      "https://github.com/duckdb/duckdb/releases/download/${DUCKDB_VERSION}/duckdb_cli-linux-amd64.zip" \
 && unzip -q /tmp/duckdb.zip -d /opt/duckdb \
 && chmod 0755 /opt/duckdb/duckdb \
 && rm -f /tmp/duckdb.zip
RUN /opt/duckdb/duckdb -c "SET extension_directory='/opt/duckdb/extensions'; INSTALL httpfs; INSTALL spatial;"

FROM public.ecr.aws/lambda/nodejs:22

COPY --from=duckdb /opt/duckdb /opt/duckdb

ENV DUCKDB_BIN=/opt/duckdb/duckdb
ENV DUCKDB_EXTENSION_DIR=/opt/duckdb/extensions

# DuckDB spills beside its database file by default and resolves `~` against HOME. Everything
# outside /tmp is read-only in Lambda, so all three are pointed at it.
ENV DUCKDB_TEMP_DIR=/tmp/duckdb
ENV HOME=/tmp
ENV PLACES_OUT_DIR=/tmp/places-work

# The build fails here rather than on the first quarterly invocation.
#
# It runs in the runtime stage, not the builder, because a binary that links against one base
# image's shared libraries and not the other's is exactly what a smoke test in the wrong stage
# would miss. Autoinstall and autoload are switched off for the check so a `LOAD` that would
# have quietly fetched the extension over the network fails instead — which is the whole
# property being asserted.
RUN /opt/duckdb/duckdb -c "\
      SET extension_directory='/opt/duckdb/extensions'; \
      SET autoinstall_known_extensions=false; \
      SET autoload_known_extensions=false; \
      LOAD httpfs; LOAD spatial; \
      SELECT ST_Point(0, 0);" > /dev/null

# Bundled by the stack with esbuild before the image is built, so the workspace's node_modules
# never enters the build context. The source map comes with it: without it a failure inside a
# minified bundle names a column offset instead of a line in this repository.
COPY index.js index.js.map ${LAMBDA_TASK_ROOT}/

CMD ["index.handler"]
