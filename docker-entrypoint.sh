#!/bin/sh
set -eu
: "${DATABASE_URL:?Missing DATABASE_URL}"
: "${DATABASE_CA_PEM:?Missing DATABASE_CA_PEM}"
umask 077
printf '%s\n' "$DATABASE_CA_PEM" > /tmp/postgres-root.pem
unset DATABASE_CA_PEM
exec "$@"
