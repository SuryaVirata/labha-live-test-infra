#!/bin/bash
set -e
BACKEND=/mnt/c/Users/surya/OneDrive/Documents/GitHub/labha-backend-go
DB_REPO=/mnt/c/Users/surya/OneDrive/Documents/GitHub/labha-database-postgres
cd "$BACKEND"
for f in \
  0109_auth_oauth_identities.sql \
  0110_customer_oauth_identities.sql \
  0111_customer_otp_challenge_customer_id.sql \
  0112_oauth_provider_facebook.sql \
  0113_oauth_identity_soft_delete.sql \
  0114_oauth_identity_immutable_subject.sql \
  0115_otp_challenge_phone_attach_customer.sql ; do
  if ! docker compose exec -T db psql -U labha -d labha -v ON_ERROR_STOP=1 -q -f - <"$DB_REPO/migrations/v5/$f" >/tmp/m.txt 2>&1; then
    echo "FAILED: $f"; tail -15 /tmp/m.txt; exit 1
  fi
  echo "applied $f"
done
echo "---verify---"
docker compose exec -T db psql -U labha -d labha -tAc "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='check_login_events_type';" | head -c 600; echo
docker compose exec -T db psql -U labha -d labha -tAc "SELECT count(*) FROM information_schema.columns WHERE table_schema='customer' AND table_name='customer_oauth_identities' AND column_name='version';"
