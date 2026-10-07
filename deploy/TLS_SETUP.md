# TLS Setup — Cloudflare Origin Certificates

mawaDao uses **Cloudflare Origin Certificates** with **Full (Strict) SSL** mode.
Cloudflare terminates public TLS; the origin certificate secures traffic between
Cloudflare's edge and the Nginx reverse proxy.

## 1. Generate the Origin Certificate

1. Log in to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Select the **mawadao.com** zone → **SSL/TLS** → **Origin Server**
3. Click **Create Certificate**
4. Settings:
   - Key type: **ECDSA** (recommended) or RSA 2048
   - Hostnames: `*.mawadao.com, mawadao.com`
   - Validity: 15 years (default)
5. Click **Create** and save both files:
   - **Origin Certificate** → `infra/ssl/origin.pem`
   - **Private Key** → `infra/ssl/origin-key.pem`

> **IMPORTANT:** The private key is only shown once. Save it immediately.

## 2. Place the Files

```
infra/
  ssl/
    origin.pem         # Certificate
    origin-key.pem     # Private key  (DO NOT commit to git!)
```

Add to `.gitignore`:
```
infra/ssl/
```

## 3. Set Cloudflare SSL Mode

1. Cloudflare Dashboard → **SSL/TLS** → **Overview**
2. Set encryption mode to **Full (strict)**
3. Enable: **Always Use HTTPS**, **Automatic HTTPS Rewrites**

## 4. Start the Load Balancer

```bash
cd infra
docker compose -f docker-compose.lb.yml up -d
```

Nginx will:
- Redirect all HTTP (port 80) to HTTPS (port 443)
- Terminate TLS with the Cloudflare Origin Certificate
- Proxy to backend services over plain HTTP (localhost)

## 5. Verify

```bash
# From a machine with Cloudflare DNS pointing to this host:
curl -I https://mawadao.com/healthz
# Should return 200 OK

# Check the certificate chain:
openssl s_client -connect mawadao.com:443 -servername mawadao.com < /dev/null 2>/dev/null | openssl x509 -noout -subject -issuer
```

## Local Development

For local development, TLS is not required. The `dev-start.mjs` script
runs services on localhost without Nginx. If you want to test TLS locally:

1. Generate a self-signed cert:
   ```bash
   openssl req -x509 -nodes -days 365 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
     -keyout infra/ssl/origin-key.pem -out infra/ssl/origin.pem \
     -subj "/CN=*.mawadao.com"
   ```
2. Run the LB via Docker Compose (above)
3. Add `127.0.0.1 mawadao.com auth.mawadao.com` to your hosts file

## Certificate Rotation

Cloudflare Origin Certificates are valid for 15 years. When rotation is needed:
1. Generate a new certificate in Cloudflare Dashboard
2. Replace `origin.pem` and `origin-key.pem`
3. Reload Nginx: `docker exec mawadao-lb nginx -s reload`
