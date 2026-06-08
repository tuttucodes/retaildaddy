# systemd Service

Use systemd only after the Azure VM run script works from an interactive shell. Keep secrets in a local environment file with restricted permissions.

## Environment File

Create `/etc/retaildaddy-agent.env`:

```bash
SARVAM_API_KEY=your_sarvam_key
PRODUCT_URL=https://your-saas.example.com
GOOGLE_MEET_URL=https://meet.google.com/xxx-yyyy-zzz
MEET_AUTO_PRESENT=true
DESKTOP_CAPTURE_SOURCE="Entire screen"
HEADLESS=false
```

Secure it:

```bash
sudo chown root:root /etc/retaildaddy-agent.env
sudo chmod 600 /etc/retaildaddy-agent.env
```

## Service Unit

Create `/etc/systemd/system/retaildaddy-agent.service`:

```ini
[Unit]
Description=RetailDaddy Google Meet demo agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/retaildaddy
EnvironmentFile=/etc/retaildaddy-agent.env
Environment=ENV_FILE=/etc/retaildaddy-agent.env
ExecStart=/home/ubuntu/retaildaddy/scripts/run-agent-azure.sh demo
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Adjust `User` and `WorkingDirectory` to match the VM.

## Manage

```bash
sudo systemctl daemon-reload
sudo systemctl enable retaildaddy-agent
sudo systemctl start retaildaddy-agent
sudo journalctl -u retaildaddy-agent -f
```

For first Google login, run `scripts/run-agent-azure.sh auth` interactively before starting the service.

The service has no terminal Q&A prompt. In this mode the agent stays alive on the audio watcher and stops on `SIGTERM`/`SIGINT`.
