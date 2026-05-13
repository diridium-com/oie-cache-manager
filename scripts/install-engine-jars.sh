#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
# Copyright (c) 2026 Diridium Technologies Inc.
#
# Installs the four OIE engine jars this plugin builds against into the local
# Maven repository. The public repsy mirror does not yet carry 4.6.0, so we
# resolve from a local engine checkout instead.
#
# Usage:
#   ENGINE_DIR=/path/to/engine ./scripts/install-engine-jars.sh
# If ENGINE_DIR is unset, defaults to ../engine relative to this script.

set -euo pipefail

VERSION="4.6.0"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_DIR="${ENGINE_DIR:-$(cd "$SCRIPT_DIR/../../engine" 2>/dev/null && pwd || true)}"

if [[ -z "${ENGINE_DIR}" || ! -d "${ENGINE_DIR}" ]]; then
    echo "error: engine directory not found." >&2
    echo "  set ENGINE_DIR to point at your OIE engine checkout, e.g.:" >&2
    echo "    ENGINE_DIR=/path/to/engine $0" >&2
    exit 1
fi

declare -a JARS=(
    "mirth-server:server/setup/server-lib/mirth-server.jar"
    "mirth-crypto:server/setup/server-lib/mirth-crypto.jar"
    "donkey-server:donkey/setup/donkey-server.jar"
    "mirth-client-core:server/setup/server-lib/mirth-client-core.jar"
)

for entry in "${JARS[@]}"; do
    jar_path="${ENGINE_DIR}/${entry#*:}"
    if [[ ! -f "${jar_path}" ]]; then
        echo "error: missing ${jar_path}" >&2
        echo "  build the engine first (ant in donkey/ and server/) so the setup jars exist." >&2
        exit 1
    fi
done

for entry in "${JARS[@]}"; do
    artifact="${entry%%:*}"
    jar_path="${ENGINE_DIR}/${entry#*:}"
    echo "installing ${artifact}-${VERSION} from ${jar_path}"
    mvn -q install:install-file \
        -Dfile="${jar_path}" \
        -DgroupId=com.mirth.connect \
        -DartifactId="${artifact}" \
        -Dversion="${VERSION}" \
        -Dpackaging=jar
done

echo "done. ${#JARS[@]} jars installed at version ${VERSION}."
