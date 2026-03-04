ccred=\033[0;31m
ccyellow=\033[0;33m
ccend=\033[0m

SERVER_IP = 171.244.48.10
DEPLOY_BRANCH = master

deploy_develop: print_detail deploy_backend clean

print_detail:
	@echo "...${ccred}PRODUCTION DEPLOY${ccend}..."

deploy_backend:
	@echo "...${ccyellow}Pushing to BACKEND SERVER server${ccend}..."
	@git push origin ${DEPLOY_BRANCH}
	@echo "...${ccyellow}Connecting SERVER server${ccend}..."
	@ssh ubuntu@${SERVER_IP} -t "source .nvm/nvm.sh \
		&& source .profile \
		&& source .bashrc \
		&& cd ~/projects/binance-tele-bot  \
		&& git pull origin ${DEPLOY_BRANCH} \
		&& yarn install \
		&& yarn build \
		&& pm2 restart trade-tele-bot \
		&& exit"
	@echo "...${ccred}Deploy BACKEND done${ccend}..."
	@echo "${ccred}==============================${ccend}"

clean:
	@echo "${ccyellow}Deploy done${ccend}"

# ── SSH Server Commands ──────────────────────────────────────────

PROJECT_DIR = ~/projects/binance-tele-bot
PM2_NAME = trade-tele-bot
SSH_CMD = ssh ubuntu@${SERVER_IP} -t
NVM_INIT = source .nvm/nvm.sh && source .profile && source .bashrc

ssh:
	@echo "...${ccyellow}Connecting to server${ccend}..."
	@${SSH_CMD} "cd ${PROJECT_DIR} && exec bash --login"

logs:
	@echo "...${ccyellow}Fetching recent logs${ccend}..."
	@${SSH_CMD} "${NVM_INIT} && pm2 logs ${PM2_NAME} --lines 200 --nostream && exit"

logs-signals:
	@echo "...${ccyellow}Fetching signal-related logs${ccend}..."
	@${SSH_CMD} "${NVM_INIT} && pm2 logs ${PM2_NAME} --lines 1000 --nostream 2>&1 | grep -i -E 'signal|shortlist|coin|filter|skip|block|reject|activate|QUEUED|ACTIVE' | tail -80 && exit"

logs-errors:
	@echo "...${ccyellow}Fetching error logs${ccend}..."
	@${SSH_CMD} "${NVM_INIT} && pm2 logs ${PM2_NAME} --lines 1000 --nostream 2>&1 | grep -i -E 'error|warn|fail|exception|timeout' | tail -50 && exit"

logs-regime:
	@echo "...${ccyellow}Fetching regime/trend logs${ccend}..."
	@${SSH_CMD} "${NVM_INIT} && pm2 logs ${PM2_NAME} --lines 1000 --nostream 2>&1 | grep -i -E 'regime|STRONG_BEAR|STRONG_BULL|RANGE_BOUND|SIDEWAYS|trend|EMA' | tail -50 && exit"

redis-signals:
	@echo "...${ccyellow}Checking Redis signal keys${ccend}..."
	@${SSH_CMD} "redis-cli KEYS 'cache:ai:signal:*' && echo '---' && redis-cli GET 'cache:ai:market-filters' && echo '---' && redis-cli KEYS 'cache:ai:params:*' | head -30 && exit"

redis-regime:
	@echo "...${ccyellow}Checking Redis regime data${ccend}..."
	@${SSH_CMD} "redis-cli GET 'cache:ai:regime' && echo '---' && redis-cli GET 'cache:ai:market-filters' && exit"

status:
	@echo "...${ccyellow}Checking PM2 status${ccend}..."
	@${SSH_CMD} "${NVM_INIT} && pm2 status && exit"

restart:
	@echo "...${ccyellow}Restarting bot on server${ccend}..."
	@${SSH_CMD} "${NVM_INIT} && cd ${PROJECT_DIR} && pm2 restart ${PM2_NAME} && pm2 status && exit"
	@echo "...${ccred}Restart done${ccend}..."
