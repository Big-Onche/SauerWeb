# Deploy SauerWeb on a Linux server

This guide deploys SauerWeb on a current Ubuntu or Debian server with:

- Nginx serving the compiled frontend and terminating HTTPS;
- a private Vite asset/API service for the runtime-generated Sauerbraten metadata;
- a private Node.js WebSocket-to-UDP relay;
- systemd supervising both Node.js processes;
- UFW exposing only SSH, HTTP, and HTTPS; and
- Let's Encrypt certificates managed by Certbot.

The examples use `play.example.com`. Replace it with the real DNS name everywhere. Run administrative commands from an account with `sudo` access.

## Architecture and ports

```text
Internet
   |
   | TCP 80/443
   v
Nginx
   |-- /                         -> /opt/sauerweb/dist
   |-- /api/ (except servers)    -> 127.0.0.1:8081 (asset/metadata service)
   |-- /api/servers              -> 127.0.0.1:8080 (relay service)
   |-- /relay (WebSocket)        -> 127.0.0.1:8080 (relay service)
   `-- /health                   -> 127.0.0.1:8080 (relay service)

Relay service -> Sauerbraten master server and game servers over outbound TCP/UDP
```

Nginx reaches ports `8080` and `8081` through loopback, and neither port must be opened in UFW. The asset service binds only to loopback. The current relay
process binds to all host interfaces, so the UFW and provider-firewall rules are essential. A public Sauerbraten game server is separate from this
application; open its game ports only if it runs on the same host.

> **Why is an asset service required?** The current Vite plugin generates the map list, texture manifests, player-model metadata, and HUD-weapon metadata
> at runtime. `npm run relay` serves only `/api/servers`, `/health`, and `/relay`. Nginx can serve `dist` directly, but a deployment of the current code still
> needs the private Vite service for the remaining `/api/*` routes. Do not expose that service directly to the Internet.

## Prerequisites

- A 64-bit Ubuntu 24.04/22.04 or current Debian server.
- A non-root account with `sudo` access.
- A DNS `A` record (and `AAAA` record if IPv6 is used) for `play.example.com` pointing to the server.
- TCP ports 80 and 443 reachable from the Internet.
- Enough disk space for the repository, `node_modules`, the build, and the Sauerbraten asset tree. The assets are much larger than the application source.
- The Sauerbraten data files in `.Sauerbraten/`. This directory is intentionally ignored by Git and is not supplied by `git clone`.
- Node.js 22 LTS (Vite 7 requires Node.js 20.19+ or 22.12+; Node.js 22 LTS is recommended).

The browser relay also needs outbound access to:

- the Sauerbraten master server, TCP `28787` by default;
- configured and discovered game servers over UDP; and
- game-server information ports, normally the game port plus one.

UFW allows outbound traffic by default. If the host or cloud provider uses an outbound-deny policy, add equivalent egress rules there.

## 1. Install system packages and Node.js

```bash
sudo apt update
sudo apt install -y ca-certificates curl git nginx ufw certbot python3-certbot-nginx

curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

node --version
npm --version
nginx -v
```

For a stricter supply-chain process, verify the NodeSource script before running it or install Node.js 22 from your organization's approved repository.

## 2. Create the service account and install the application

```bash
sudo useradd --system --user-group --home-dir /opt/sauerweb --shell /usr/sbin/nologin sauerweb
sudo git clone https://github.com/OWNER/SauerWeb.git /opt/sauerweb
sudo chown -R sauerweb:sauerweb /opt/sauerweb
```

Replace the clone URL with the repository's real URL. If the repository is private, clone it using a deployment credential that has read-only access.

Copy the Sauerbraten distribution into `/opt/sauerweb/.Sauerbraten`. The resulting layout must include at least these paths:

```text
/opt/sauerweb/.Sauerbraten/data/
/opt/sauerweb/.Sauerbraten/packages/base/
/opt/sauerweb/.Sauerbraten/packages/models/
```

For example, if the asset directory has already been uploaded to `/tmp/.Sauerbraten`:

```bash
sudo cp -a /tmp/.Sauerbraten /opt/sauerweb/.Sauerbraten
sudo chown -R sauerweb:sauerweb /opt/sauerweb/.Sauerbraten
```

Install exactly the dependency versions in `package-lock.json`, run the tests, and build:

```bash
sudo -u sauerweb -H bash -c 'cd /opt/sauerweb && npm ci'
sudo -u sauerweb -H bash -c 'cd /opt/sauerweb && npm test'
sudo -u sauerweb -H bash -c 'cd /opt/sauerweb && npm run build'
sudo -u sauerweb install -d /opt/sauerweb/node_modules/.vite
```

The ENet JavaScript and WebAssembly output is committed to the repository. Emscripten is not required for deployment.

## 3. Configure the relay environment

Create a root-owned environment file. Values in this file are passed literally by systemd; do not add shell `export` statements.

```bash
sudo install -d -m 0755 /etc/sauerweb
sudo tee /etc/sauerweb/relay.env >/dev/null <<'EOF'
SAUER_RELAY_PORT=8080
SAUER_RELAY_ORIGINS=https://play.example.com
# Optional fixed/unlisted servers, separated by commas:
# SAUER_RELAY_SERVERS=game.example.com:28785=Main server,127.0.0.1:28785=Local server
# Optional master-server overrides:
# SAUER_MASTER_SERVER=master.sauerbraten.org
# SAUER_MASTER_PORT=28787
# SAUER_MASTER_TIMEOUT=20000
EOF
sudo chown root:root /etc/sauerweb/relay.env
sudo chmod 0640 /etc/sauerweb/relay.env
```

Set `SAUER_RELAY_ORIGINS` to the exact public HTTPS origin. This causes the relay to reject WebSocket upgrades made by pages on other origins. Do not put
TLS key paths in this file when Nginx terminates TLS.

`SAUER_RELAY_SERVERS` is not a general destination proxy: it adds explicitly trusted servers to the destinations learned from the master server. Keep
the list narrow, and do not include internal network addresses unless browsers are intentionally allowed to reach those servers through the relay.

## 4. Create systemd services

Create the WebSocket relay service:

```bash
sudo tee /etc/systemd/system/sauerweb-relay.service >/dev/null <<'EOF'
[Unit]
Description=SauerWeb WebSocket-to-UDP relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=sauerweb
Group=sauerweb
WorkingDirectory=/opt/sauerweb
Environment=NODE_ENV=production
EnvironmentFile=/etc/sauerweb/relay.env
ExecStart=/usr/bin/node /opt/sauerweb/relay/relay.mjs
Restart=on-failure
RestartSec=5s
TimeoutStopSec=20s

NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictSUIDSGID=true
LockPersonality=true
SystemCallArchitectures=native
UMask=0027

[Install]
WantedBy=multi-user.target
EOF
```

Create the private asset/metadata service:

```bash
sudo tee /etc/systemd/system/sauerweb-assets.service >/dev/null <<'EOF'
[Unit]
Description=SauerWeb private asset and metadata service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=sauerweb
Group=sauerweb
WorkingDirectory=/opt/sauerweb
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm run dev -- --host 127.0.0.1 --port 8081 --strictPort
Restart=on-failure
RestartSec=5s
TimeoutStopSec=20s

NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ReadWritePaths=/opt/sauerweb/node_modules/.vite
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictSUIDSGID=true
LockPersonality=true
SystemCallArchitectures=native
UMask=0027

[Install]
WantedBy=multi-user.target
EOF
```

The asset service uses Vite's middleware because the current application generates several metadata responses in its Vite plugin. It is isolated on
`127.0.0.1`, runs as an unprivileged user, and is exposed only through the Nginx routes below. A future dedicated production metadata server can replace
this service without changing the public URL layout.

Start both services:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now sauerweb-relay.service sauerweb-assets.service
sudo systemctl status --no-pager sauerweb-relay.service sauerweb-assets.service
curl -i http://127.0.0.1:8080/health
curl -fsS http://127.0.0.1:8081/api/maps | head -c 200
```

The health endpoint should return `HTTP/1.1 204 No Content`; the maps request should begin with a JSON array.

## 5. Configure Nginx

Create `/etc/nginx/sites-available/sauerweb`:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    listen [::]:80;
    server_name play.example.com;

    root /opt/sauerweb/dist;
    index index.html;

    client_max_body_size 1m;

    location = /health {
        proxy_pass http://127.0.0.1:8080/health;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location = /api/servers {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
    }

    location = /relay {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header Origin $http_origin;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
        proxy_buffering off;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
    }

    location /assets/ {
        try_files $uri =404;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location / {
        try_files $uri $uri/ /index.html;
    }

    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    add_header Permissions-Policy "camera=(), geolocation=(), microphone=()" always;
}
```

The exact-match `/api/servers` location must appear alongside `/api/`; it ensures the server browser is handled by the relay process. The WebSocket
headers on `/relay` are also required. Do not cache `/api/servers` or generated metadata responses.

Enable and validate the site:

```bash
sudo ln -s /etc/nginx/sites-available/sauerweb /etc/nginx/sites-enabled/sauerweb
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

## 6. Configure UFW

Allow SSH before enabling the firewall so the current session is not locked out:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw limit OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status verbose
```

If SSH uses a nonstandard port, allow that port before `ufw enable` instead of relying on the `OpenSSH` profile. Confirm that the cloud provider's
security group or network firewall also allows TCP 22 (or the custom SSH port), 80, and 443. Do not allow TCP 8080 or 8081.

## 7. Obtain and verify HTTPS

After DNS resolves to the server and HTTP works, request the certificate:

```bash
sudo certbot --nginx -d play.example.com --redirect --agree-tos --no-eff-email -m admin@example.com
sudo nginx -t
sudo systemctl reload nginx
sudo certbot renew --dry-run
```

Certbot installs its own renewal timer. Once HTTPS is working, add HSTS to the HTTPS `server` block that Certbot creates:

```nginx
add_header Strict-Transport-Security "max-age=31536000" always;
```

Only enable HSTS after confirming the domain works reliably over HTTPS. Add `includeSubDomains` only when every subdomain is HTTPS-ready.

Verify the public deployment:

```bash
curl -I https://play.example.com/
curl -i https://play.example.com/health
curl -fsS https://play.example.com/api/servers | head -c 300
curl -fsS https://play.example.com/api/maps | head -c 300
```

Then open the site in a browser, select a map, and connect to a server. Browser developer tools should show the `/relay` request upgrading with status
`101 Switching Protocols`.

## Operations

### Logs and status

```bash
sudo systemctl status sauerweb-relay.service sauerweb-assets.service nginx
sudo journalctl -u sauerweb-relay.service -u sauerweb-assets.service -f
sudo tail -f /var/log/nginx/access.log /var/log/nginx/error.log
sudo ss -lntp | grep -E ':(80|443|8080|8081)\b'
```

The asset service should show `127.0.0.1:8081`. The current relay may show `0.0.0.0:8080`; confirm with `ufw status` and the provider firewall that 8080 is
not reachable externally. Only Nginx ports 80 and 443 should be publicly reachable.

### Deploy an update

Back up the currently deployed Git commit so it is easy to roll back, update dependencies from the lock file, test, build, and restart:

```bash
cd /opt/sauerweb
sudo -u sauerweb git rev-parse HEAD
sudo systemctl stop sauerweb-assets.service sauerweb-relay.service
sudo -u sauerweb git pull --ff-only
sudo -u sauerweb -H npm ci
sudo -u sauerweb -H npm test
sudo -u sauerweb -H npm run build
sudo -u sauerweb install -d /opt/sauerweb/node_modules/.vite
sudo systemctl start sauerweb-assets.service sauerweb-relay.service
sudo systemctl reload nginx
curl -i http://127.0.0.1:8080/health
```

Review upstream changes before deploying them. For zero-downtime and atomic releases, build into versioned release directories and switch a symlink only
after all checks pass.

### Troubleshooting

- **The page loads but maps or models fail:** verify `.Sauerbraten/data` and `.Sauerbraten/packages`, then inspect
  `journalctl -u sauerweb-assets.service` and the failing `/api/*` request.
- **`502 Bad Gateway`:** confirm both systemd services are running and listening on their expected loopback ports.
- **WebSocket returns 403:** ensure `SAUER_RELAY_ORIGINS` exactly matches the browser origin, including `https://` and any nonstandard port, then restart
  `sauerweb-relay.service`.
- **WebSocket does not upgrade:** confirm `/relay` is using HTTP/1.1 and forwarding the `Upgrade` and `Connection` headers.
- **The server list is empty:** test outbound TCP access to the configured master server and inspect relay logs. Explicitly configured servers can be added
  with `SAUER_RELAY_SERVERS`.
- **Servers appear offline:** allow outbound UDP to the game and server-information ports in any provider firewall or outbound firewall policy.
- **Certificate issuance fails:** verify public DNS, TCP port 80, the Nginx `server_name`, and that no proxy/CDN is intercepting the ACME challenge.
