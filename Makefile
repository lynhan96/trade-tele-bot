ccred=\033[0;31m
ccyellow=\033[0;33m
ccend=\033[0m

SERVER_IP = 171.244.48.220
DEPLOY_BRANCH = master

deploy_develop: print_detail deploy_backend clean

print_detail:
	@echo "...${ccred}PRODUCTION DEPLOY${ccend}..."

deploy_backend:
	@echo "...${ccyellow}Pushing to BACKEND SERVER server${ccend}..."
	@git push origin ${DEPLOY_BRANCH}
	@echo "...${ccyellow}Connecting SERVER server${ccend}..."
	@ssh -p 2222 ubuntu@${SERVER_IP} -t "source .nvm/nvm.sh \
		&& source .profile \
		&& source .bashrc \
		&& cd ~/projects/tele-bot  \
		&& git pull origin ${DEPLOY_BRANCH} \
		&& yarn install \
		&& yarn build \
		&& pm2 restart trade-tele-bot \
		&& exit"
	@echo "...${ccred}Deploy BACKEND done${ccend}..."
	@echo "${ccred}==============================${ccend}"

clean:
	@echo "${ccyellow}Deploy done${ccend}"
