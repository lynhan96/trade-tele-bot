---
name: deploy
description: Deploy backend bot and/or AI ops agent to production server. Use when user says "deploy", "push to server", or after completing code changes.
---

# Deploy Workflow

## Backend Bot
```bash
# 1. Build locally
npm run build

# 2. Commit
git add -A && git -c commit.gpgsign=false commit -m "description"

# 3. Deploy (push + SSH build + PM2 restart)
make deploy_develop
```

## AI Ops Agent
Agent runs separately at `~/ai-ops-agent/`. After deploying bot:
```bash
ssh ubuntu@171.244.48.10 "source ~/.nvm/nvm.sh && cp -r ~/projects/binance-tele-bot/ai-ops-agent/src/* ~/ai-ops-agent/src/ && pm2 restart ai-ops-agent"
```

## Verify
```bash
# Check bot running
ssh ubuntu@171.244.48.10 "source ~/.nvm/nvm.sh && pm2 status"

# Check recent logs
ssh ubuntu@171.244.48.10 "source ~/.nvm/nvm.sh && pm2 logs trade-tele-bot --lines 20 --nostream"

# Check agent
ssh ubuntu@171.244.48.10 "source ~/.nvm/nvm.sh && pm2 logs ai-ops-agent --lines 10 --nostream"
```

## Important
- Always `npm run build` before deploy (catches TS errors locally)
- Use `git -c commit.gpgsign=false` (GPG not configured on this machine)
- `make deploy_develop` = git push + SSH pull + yarn install + yarn build + PM2 restart
- Server: `ubuntu@171.244.48.10`, PM2 process: `trade-tele-bot`
- Agent source at `ai-ops-agent/src/` in bot repo, deployed copy at `~/ai-ops-agent/`
