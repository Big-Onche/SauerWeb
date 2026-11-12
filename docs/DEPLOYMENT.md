# Deploy SauerWeb on a Linux server

This guide deploys SauerWeb on a current Ubuntu or Debian server with:

- Nginx serving the compiled frontend and terminating HTTPS;
- a private Vite asset/API service for the runtime-generated Sauerbraten metadata;
- a private Node.js WebSocket-to-UDP relay;
- systemd supervising both Node.js processes;
- UFW exposing only SSH, HTTP, and HTTPS; and
- Let's Encrypt certificates managed by Certbot.

The examples use the official domain `sauerweb.org` and its `www` alias. Replace these with your own domain if self-hosting elsewhere. Run commands from a `sudo` account; when already logged in as root, omit `sudo`. On Windows, use PowerShell with `ssh root@YOUR_VPS_IP` (WSL is not required).

**Paste one shell block at a time.** Wait for the prompt to return, particularly after a `<<'EOF'` heredoc. Do not paste passwords, private keys, or secrets into support chats.

## Deployment order

1. Install Nginx, Node.js and system utilities. Verify `nginx -v` before configuring Nginx.
2. Clone SauerWeb, then install the Sauerbraten assets separately. The Git clone does **not** contain them.
3. Configure `SAUERBRATEN_DIR`, install dependencies, run tests, and build the frontend.
4. Create **both** systemd units and the required writable Vite directories (`.vite` **and** `.vite-temp`).
5. Configure Nginx, UFW, public DNS, Certbot, the Vite Host allowlist and the relay's HTTPS origin allowlist.
6. Verify HTTP statuses from the VPS and do a real game + multiplayer test from another device.

The static frontend (`dist/`) is only part of the deployment; the private Vite service supplies the map list, models, textures and other runtime `/api/` responses.

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
   |-- /presence (WebSocket)     -> 127.0.0.1:8080 (relay service)
   `-- /health                   -> 127.0.0.1:8080 (relay service)

Relay service -> Sauerbraten master server and game servers over outbound TCP/UDP
```

Nginx reaches ports `8080` and `8081` through loopback, and neither port must be opened in UFW. The asset service binds only to loopback. The current relay
process binds to all host interfaces, so the UFW and provider-firewall rules are essential. A public Sauerbraten game server is separate from this
application; open its game ports only if it runs on the same host.

> **Why is an asset service required?** The current Vite plugin generates the map list, texture manifests, player-model metadata, and HUD-weapon metadata
> at runtime. `npm run relay` serves only `/api/servers`, `/health`, `/relay`, and `/presence`. Nginx can serve `dist` directly, but a deployment of the current code still
> needs the private Vite service for the remaining `/api/*` routes. Do not expose that service directly to the Internet.

## Prerequisites

- A 64-bit Ubuntu 24.04 or newer, or a recent Debian server with `apt` and systemd.
- A non-root account with `sudo` access.
- DNS `A` records for `sauerweb.org` and `www.sauerweb.org` pointing to the VPS (and correct `AAAA` records if IPv6 is used).
- TCP ports 80 and 443 reachable from the Internet.
- Enough disk space for the repository, `node_modules`, the build, and the Sauerbraten asset tree. The assets are much larger than the application source.
- The Sauerbraten data files in `.Sauerbraten/`, or another directory selected with `SAUERBRATEN_DIR`. The default directory is intentionally ignored
  by Git and is not supplied by `git clone`.
- Node.js 22 LTS (Vite 7 requires Node.js 20.19+ or 22.12+; Node.js 22 LTS is recommended).

The browser relay also needs outbound access to:

- the Sauerbraten master server, TCP `28787` by default;
- configured and discovered game servers over UDP; and
- game-server information ports, normally the game port plus one.

UFW allows outbound traffic by default. If the host or cloud provider uses an outbound-deny policy, add equivalent egress rules there.

## 1. Install system packages and Node.js

```bash
sudo apt update
sudo apt install -y ca-certificates curl git nginx ufw certbot python3-certbot-nginx bzip2 dnsutils

curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

node --version
npm --version
nginx -v
certbot --version
```

For a stricter supply-chain process, verify the NodeSource script before running it or install Node.js 22 from your organization's approved repository.

## 2. Create the service account and install the application

```bash
sudo useradd --system --user-group --home-dir /opt/sauerweb --shell /usr/sbin/nologin sauerweb
sudo git clone https://github.com/Big-Onche/SauerWeb.git /opt/sauerweb
sudo chown -R sauerweb:sauerweb /opt/sauerweb
```

If using a private fork, use read-only deployment credentials. The `sauerweb` service user owns the checkout so `npm ci`, tests, builds and pulls do not need root.

### Download Sauerbraten assets directly on the VPS (recommended)

The official Linux distribution is a **release archive, not a Git repository**. There is no Git commit to choose for the assets. The 2020-12-29 archive is roughly 986 MB and contains the necessary `data/` and `packages/` trees. Ensure there is enough free disk space.

```bash
df -h /
curl -fL --retry 3 -o /tmp/sauerbraten_2020_12_29_linux.tar.bz2 'https://sourceforge.net/projects/sauerbraten/files/sauerbraten/2020_11_29/sauerbraten_2020_12_29_linux.tar.bz2/download'
echo 'cdba7c4a47cefd30d0afdd6a912199a1384319cf1619923cb7189e72e468be70  /tmp/sauerbraten_2020_12_29_linux.tar.bz2' | sha256sum -c -
```

**Do not extract if the SHA-256 check does not say `OK`.** The published checksum can be cross-checked against the [HaikuPorts Sauerbraten recipe](https://github.com/haikuports/haikuports/blob/master/games-fps/sauerbraten/sauerbraten-2020.12.29.recipe). Extract only the assets (not Linux executables):

```bash
sudo mkdir -p /srv/sauerbraten
sudo tar -xjf /tmp/sauerbraten_2020_12_29_linux.tar.bz2 -C /srv/sauerbraten --strip-components=1 sauerbraten/data sauerbraten/packages
sudo chown -R sauerweb:sauerweb /srv/sauerbraten
sudo -u sauerweb test -d /srv/sauerbraten/data
sudo -u sauerweb test -d /srv/sauerbraten/packages/base
sudo -u sauerweb test -d /srv/sauerbraten/packages/models
sudo -u sauerweb test -f /srv/sauerbraten/packages/base/triforts.ogz
sudo rm /tmp/sauerbraten_2020_12_29_linux.tar.bz2
```

Alternatively, transfer a compatible Sauerbraten asset tree from Windows with `scp` into `/srv/sauerbraten`, preserving the `data/` and `packages/` paths. An absolute or project-relative `SAUERBRATEN_DIR` is supported. **Do not add a temporary `.Sauerbraten` symlink to make tests pass**: update outdated tests to respect the configured path instead.

Configure the asset path used by the build and tests:

```bash
printf 'SAUERBRATEN_DIR=/srv/sauerbraten\n' | sudo tee /opt/sauerweb/.env.local >/dev/null
sudo chown sauerweb:sauerweb /opt/sauerweb/.env.local
```

On a Windows host, the equivalent `.env.local` value can be `SAUERBRATEN_DIR="D:/Games/Sauerbraten"`; project-relative values such as
`SAUERBRATEN_DIR="../sauerbraten"` work on both platforms. Vite loads `.env.local` automatically. Shell environment values take precedence and are
also honored by `scripts/build-enet-wasm.ps1`.

Install exactly the dependency versions in `package-lock.json`, run the tests, and build:

```bash
sudo -u sauerweb -H bash -c 'cd /opt/sauerweb && npm ci'
sudo -u sauerweb -H bash -c 'cd /opt/sauerweb && npm test'
sudo -u sauerweb -H bash -c 'cd /opt/sauerweb && npm run build'
sudo -u sauerweb install -d /opt/sauerweb/node_modules/.vite
sudo -u sauerweb install -d /opt/sauerweb/node_modules/.vite-temp
test -f /opt/sauerweb/dist/index.html
```

The ENet JavaScript and WebAssembly output is committed to the repository. Emscripten is not required for deployment. `npm ci` recreates `node_modules`, so **both** writable Vite directories must be recreated afterwards, including on every update. If tests fail with `ENOENT ... .Sauerbraten`, diagnose `SAUERBRATEN_DIR` and the test setup before assuming the compilation is broken.

On a small VPS, inspect `free -h` if a build terminates with `Killed` or exit code 137. Review `npm audit` findings, but do not run `npm audit fix` blindly against production dependencies.

## 3. Configure the relay environment

Create a root-owned environment file. Values in this file are passed literally by systemd; do not add shell `export` statements.

```bash
sudo install -d -m 0755 /etc/sauerweb
sudo tee /etc/sauerweb/relay.env >/dev/null <<'EOF'
SAUER_RELAY_PORT=8080
SAUER_RELAY_ORIGINS=https://sauerweb.org,https://www.sauerweb.org
# Only these direct peers may supply the client IP used by relay limits:
SAUER_RELAY_TRUSTED_PROXIES=127.0.0.1/32,::1/128
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

Set `SAUER_RELAY_ORIGINS` to **every exact HTTPS origin** your users visit (comma-separated), including the protocol and any nonstandard port. This causes the relay to reject WebSocket upgrades made by pages on other origins. Do not put
TLS key paths in this file when Nginx terminates TLS.

`SAUER_RELAY_TRUSTED_PROXIES` accepts comma-separated IP addresses and CIDR networks. Forwarded addresses are used only when the relay's direct peer is
in this list, and proxy hops are evaluated from right to left. This prevents a public client from evading the four-connections-per-IP limit by supplying
its own `X-Forwarded-For` value. Keep this list limited to the actual reverse proxies that connect directly to the relay; the loopback values above match
this guide's single-host Nginx deployment.

`SAUER_RELAY_SERVERS` is not a general destination proxy: it adds explicitly trusted servers to the destinations learned from the master server. Keep
the list narrow, and do not include internal network addresses unless browsers are intentionally allowed to reach those servers through the relay.

### Configure the Vite asset service environment

Vite 7 validates HTTP `Host` headers. Without an allowlist, Nginx can forward `/api/maps` and `/api/packages/...` correctly but Vite responds **403** with `Blocked request. This host ("sauerweb.org") is not allowed.`. Configure the asset directory and one explicitly trusted domain (the leading dot permits the apex and subdomains including `www`):

```bash
sudo tee /etc/sauerweb/assets.env >/dev/null <<'EOF'
SAUERBRATEN_DIR=/srv/sauerbraten
__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=.sauerweb.org
EOF
sudo chown root:root /etc/sauerweb/assets.env
sudo chmod 0640 /etc/sauerweb/assets.env
```

Replace `.sauerweb.org` with a domain you control (see [Vite’s allowed-hosts documentation](https://vite.dev/config/server-options#server-allowedhosts)). The Vite variable avoids locally editing tracked `vite.config.ts`. **Do not set `allowedHosts: true`**, which disables this protection. For other deployments, ensure `/opt/sauerweb/.env.local` and `/etc/sauerweb/assets.env` point to the same asset directory.

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
EnvironmentFile=/etc/sauerweb/assets.env
ExecStart=/usr/bin/npm run dev -- --host 127.0.0.1 --port 8081 --strictPort
Restart=on-failure
RestartSec=5s
TimeoutStopSec=20s

NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ReadWritePaths=/opt/sauerweb/node_modules/.vite
ReadWritePaths=/opt/sauerweb/node_modules/.vite-temp
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

The asset service uses Vite's middleware because the current application generates metadata responses in a Vite plugin. Set `SAUERBRATEN_DIR` in `/etc/sauerweb/assets.env`; a relative value is resolved from `/opt/sauerweb`. The service is isolated on `127.0.0.1`, runs as an unprivileged user, and is exposed only through the Nginx routes below. With `ProtectSystem=strict`, the two `ReadWritePaths` entries must exist and allow Vite to write its dependency cache (`.vite`) and bundled temporary config (`.vite-temp`). A future
dedicated production metadata server can replace this service without changing the public URL layout.

Start both services:

```bash
sudo -u sauerweb install -d /opt/sauerweb/node_modules/.vite
sudo -u sauerweb install -d /opt/sauerweb/node_modules/.vite-temp
sudo systemctl daemon-reload
sudo systemctl enable --now sauerweb-relay.service sauerweb-assets.service
sudo systemctl status --no-pager sauerweb-relay.service sauerweb-assets.service
curl -i http://127.0.0.1:8080/health
curl -sS -o /dev/null -w 'Maps HTTP %{http_code}\n' http://127.0.0.1:8081/api/maps
curl -sS -o /dev/null -w 'Domain Host HTTP %{http_code}\n' -H 'Host: sauerweb.org' http://127.0.0.1:8081/api/maps
```

The health endpoint should return `HTTP/1.1 204 No Content`. **Both** map checks must return 200, including the public `Host` header. If a service fails, read its logs with `sudo journalctl -u sauerweb-assets.service -n 80 --no-pager` before proceeding.

## 5. Configure Nginx

Create `/etc/nginx/sites-available/sauerweb` after confirming Nginx is installed. The top-level `map` directive belongs in Nginx's `http` context; standard Debian/Ubuntu `sites-enabled/*` configuration is included there:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    listen [::]:80;
    server_name sauerweb.org www.sauerweb.org;

    root /opt/sauerweb/dist;
    index index.html;

    client_max_body_size 1m;

    location = /health {
        proxy_pass http://127.0.0.1:8080/health;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location = /api/servers {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
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
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
        proxy_buffering off;
    }

    location = /presence {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header Origin $http_origin;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1m;
        proxy_send_timeout 1m;
        proxy_buffering off;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
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
headers on `/relay` and `/presence` are also required. This single-proxy setup overwrites, rather than appends, `X-Forwarded-For`, so a header supplied by
the public client cannot become authoritative. `/presence` uses 15-second application heartbeats, so its one-minute proxy timeouts leave enough margin for
the relay's 45-second stale-session cleanup. If another load balancer sits in front of Nginx, configure Nginx's Real IP module with that load balancer's exact
addresses before relying on `$remote_addr`. Do not cache `/api/servers` or generated metadata responses.

Enable and validate the site:

```bash
sudo ln -sfn /etc/nginx/sites-available/sauerweb /etc/nginx/sites-enabled/sauerweb
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

## 6. Configure UFW

Allow SSH before enabling the firewall so the current session is not locked out:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

If SSH uses a nonstandard port, allow that port before `ufw enable` rather than assuming port 22. Confirm that the cloud provider's
security group or network firewall also allows TCP 22 (or the custom SSH port), 80, and 443. Do not allow TCP 8080 or 8081.

## 7. Obtain and verify HTTPS

After both public DNS records resolve to your VPS and HTTP works, request a certificate. Confirm the records at a **recursive public resolver**, not just the authoritative nameserver, because new OVH records may take time to propagate:

```bash
dig +short @1.1.1.1 sauerweb.org A
dig +short @1.1.1.1 www.sauerweb.org A
curl -I http://sauerweb.org/
```

Once both hostnames resolve correctly, issue the certificate:

```bash
sudo certbot --nginx -d sauerweb.org -d www.sauerweb.org --redirect
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
curl -I https://sauerweb.org/
curl -sS -o /dev/null -w 'Health HTTP %{http_code}\n' https://sauerweb.org/health
curl -sS -o /dev/null -w 'Servers HTTP %{http_code}\n' https://sauerweb.org/api/servers
curl -sS -o /dev/null -w 'Maps HTTP %{http_code}\n' https://sauerweb.org/api/maps
curl -sS -o /dev/null -w 'Models HTTP %{http_code}\n' https://sauerweb.org/api/packages/models/flags/tris.md2
js=$(find /opt/sauerweb/dist/assets -maxdepth 1 -type f -name '*.js' -printf '%f\n' -quit)
curl -sS -o /dev/null -w 'JavaScript HTTP %{http_code}\n' "https://sauerweb.org/assets/$js"
```

Expected statuses: root 200, health 204, servers/maps/models/JavaScript 200. Test from a **different device or network** (PC and mobile), load a map,
and connect to a public game server. In developer tools, the `/relay` and `/presence` WebSockets must upgrade with `101 Switching Protocols`. Successful
`curl` checks from the VPS alone do not prove external reachability.

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
sudo -u sauerweb install -d /opt/sauerweb/node_modules/.vite-temp
sudo systemctl start sauerweb-assets.service sauerweb-relay.service
sudo systemctl reload nginx
curl -i http://127.0.0.1:8080/health
```

Review upstream changes before deploying them. If `git pull --ff-only` refuses because `vite.config.ts` was edited directly on the VPS, first check `git status --short` and preserve or upstream those edits. After configuring the trusted-host environment variable above, a manual `vite.config.ts` allowlist patch is unnecessary. Never discard unreviewed local edits. For zero-downtime and atomic releases, build into versioned release directories and switch a symlink only after all checks pass.

### Troubleshooting

| Symptom | Likely cause and action |
| --- | --- |
| `Unit sauerweb-assets.service could not be found` | The service file has not been created. Create both units (section 4), then `sudo systemctl daemon-reload`. |
| `EROFS ... node_modules/.vite-temp/...` | `ProtectSystem=strict` blocks writes. Create both Vite directories and add both `ReadWritePaths` to the asset unit. Reload systemd and restart. |
| `226/NAMESPACE` from the asset service | Check that every `ReadWritePaths` path exists after `npm ci` and that service sandboxing accepts it. Inspect `journalctl -u sauerweb-assets.service`. |
| Public maps/models return 403 and `Blocked request. This host (...) is not allowed` | Vite rejected the public `Host` header. Set `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` in `/etc/sauerweb/assets.env`, restart assets, and test with `curl -H 'Host: sauerweb.org'`. |
| Tests fail with `ENOENT ... .Sauerbraten/packages/...` | Wrong configured asset directory or outdated tests. Check `SAUERBRATEN_DIR`, `.env.local`, and source revision; this is not a TypeScript compiler error. |
| `nginx: command not found` or `sites-available` missing | Install Nginx before writing its site file. Verify `nginx -v` and `nginx -t`. |
| Bare-IP address shows 404 after the domain is enabled | Virtual-host selection changed. Use the HTTPS domain; optionally add an explicit default-server redirect for the IP. |
| `curl: (23) Failed writing body` after `| head -c` | `head` ended the pipe early; use `curl -o /dev/null -w '%{http_code}'` to test status codes. |
| Relay WebSocket 403 after moving to HTTPS | Set both exact `https://` origins in `SAUER_RELAY_ORIGINS` and restart the relay. |

- **The page loads but maps or models fail:** verify the `SAUERBRATEN_DIR` shown in the asset service and its `data`, `packages/base`, and
  `packages/models` directories, then inspect `journalctl -u sauerweb-assets.service` and the failing `/api/*` request.
- **`502 Bad Gateway`:** confirm both systemd services are running and listening on their expected loopback ports.
- **WebSocket does not upgrade:** confirm `/relay` and `/presence` are using HTTP/1.1 and forwarding the `Upgrade` and `Connection` headers.
- **The server list is empty:** test outbound TCP access to the configured master server and inspect relay logs. Explicitly configured servers can be added
  with `SAUER_RELAY_SERVERS`.
- **Servers appear offline:** allow outbound UDP to the game and server-information ports in any provider firewall or outbound firewall policy.
- **Certificate issuance fails:** verify public DNS, TCP port 80, the Nginx `server_name`, and that no proxy/CDN is intercepting the ACME challenge.
