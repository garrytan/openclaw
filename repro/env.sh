# usage: . env.sh <runDir>   (sets an isolated OpenClaw home under the run dir)
R=$1
export OPENCLAW_STATE_DIR=$R/state OPENCLAW_CONFIG_PATH=$R/state/openclaw.json OPENCLAW_HOME=$R/state HOME=$R/home XDG_CONFIG_HOME=$R/state
export OPENCLAW_NO_AUTO_UPDATE=1 OPENCLAW_GATEWAY_TOKEN=repro-token-00000000000000000000000000
