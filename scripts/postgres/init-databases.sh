#!/bin/sh
# Cria os databases dos servicos que dividem o Postgres de desenvolvimento.
#
# A imagem oficial do Postgres so cria o POSTGRES_DB no primeiro boot. O Postiz e
# o Temporal precisam dos seus, e nao podem usar o mesmo database do postmidia:
# cada um roda migrations proprias e o postmidia tem RLS e role de leitura
# separada. Databases separados resolvem isso sem subir um container por servico.
#
# Roda uma unica vez, no primeiro boot do volume. Ja_exists garante idempotencia
# caso o script volte a rodar.
set -e

create_database() {
  db="$1"
  if psql -U "$POSTGRES_USER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1; then
    echo "database $db ja existe"
  else
    psql -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE $db OWNER $POSTGRES_USER"
    echo "database $db criado"
  fi
}

create_database postiz
# O Temporal usa este para as tabelas de execucao; a visibilidade fica no
# Elasticsearch (limite compilado de 3 search attributes Text).
create_database temporal

psql -U "$POSTGRES_USER" -d postgres -c "GRANT ALL PRIVILEGES ON DATABASE postiz TO $POSTGRES_USER" >/dev/null
psql -U "$POSTGRES_USER" -d postgres -c "GRANT ALL PRIVILEGES ON DATABASE temporal TO $POSTGRES_USER" >/dev/null

echo "databases do postmidia listos: postmidia, postiz, temporal"
