SELECT count(*) AS before_no_nonce FROM operations.audit_logs WHERE action_type = 'google_oauth_login' AND created_at > now() - interval '5 minutes';
