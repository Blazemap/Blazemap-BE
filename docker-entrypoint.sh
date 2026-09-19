#!/bin/sh
set -eu
: "${DATABASE_URL:?Missing DATABASE_URL}"
: "${DATABASE_CA_PEM:?Missing DATABASE_CA_PEM}"
exec "$@"
