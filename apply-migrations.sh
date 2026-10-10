#!/bin/bash
set -e
BACKEND=/mnt/c/Users/surya/OneDrive/Documents/GitHub/labha-backend-go
DB_REPO=/mnt/c/Users/surya/OneDrive/Documents/GitHub/labha-database-postgres
cd "$BACKEND"

# Wait for postgres readiness.
for i in $(seq 1 30); do
  if docker compose exec -T db pg_isready -U labha -d labha >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
docker compose exec -T db pg_isready -U labha -d labha

count=0
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%%#*}"
  line="$(echo "$line" | xargs)"
  [[ -z "$line" ]] && continue
  sql_file="$DB_REPO/migrations/v5/$line"
  if [[ ! -f "$sql_file" ]]; then
    echo "MISSING: $sql_file"; exit 1
  fi
  if ! docker compose exec -T db psql -U labha -d labha -v ON_ERROR_STOP=1 -q -f - <"$sql_file" >/tmp/mig-out.txt 2>&1; then
    echo "FAILED: $line"; tail -20 /tmp/mig-out.txt; exit 1
  fi
  count=$((count+1))
done <"$DB_REPO/migrations/v5/manifest.txt"
echo "APPLIED $count manifest entries"

# Dev roles (labha_app, labha_worker, labha_readonly, labha_migration).
if [[ -f "$DB_REPO/scripts/configure-dev-roles.sql" ]]; then
  docker compose exec -T db psql -U labha -d labha -v ON_ERROR_STOP=1 -q -f - <"$DB_REPO/scripts/configure-dev-roles.sql" >/tmp/roles-out.txt 2>&1 && echo "ROLES-OK" || { echo "ROLES-FAILED"; tail -10 /tmp/roles-out.txt; exit 1; }
fi

# Verify the new column + oauth tables.
docker compose exec -T db psql -U labha -d labha -tAc "SELECT column_name FROM information_schema.columns WHERE table_schema='customer' AND table_name='customer_oauth_identities' AND column_name='version';"
docker compose exec -T db psql -U labha -d labha -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema IN ('auth','customer') AND table_name LIKE '%oauth_identities';"
