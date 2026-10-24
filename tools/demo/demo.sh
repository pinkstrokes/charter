#!/bin/zsh
# The live demo's own SpacetimeDB server: a copy of the finished runs, prepared for
# the table (company A on the Friday of a payment run that nobody has attacked yet),
# with a snapshot to go back to between judges. The main server (port 3000) and its
# databases are never touched.
#
#   tools/demo/demo.sh clone   copy the main server's data (stop the main server first)
#   tools/demo/demo.sh build   prepare the copy for the table and take the snapshot
#   tools/demo/demo.sh up      demo server :3100, evolvers watching A and B, UI on :5191
#   tools/demo/demo.sh reset   back to the snapshot, about five seconds
#   tools/demo/demo.sh down    stop it all
set -u
REPO=${0:A:h:h:h}
DIR=${CHARTER_DEMO_DIR:-$HOME/Developer/charter-demo-stdb}
DATA=$DIR/data
SNAP=$DIR/snapshot
WORK=$DIR/work  # the evolvers' own copy of data/: proposals and logs from the demo never touch the repo
MAIN=${CHARTER_MAIN_DATA:-$HOME/.local/share/spacetime/data}
PORT=3100
URL=http://127.0.0.1:$PORT
UI_PORT=5191
export SSL_CERT_FILE=/etc/ssl/cert.pem

up_ping() { curl -s -o /dev/null -w '%{http_code}' $URL/v1/ping 2>/dev/null; }

server_start() {
  [[ $(up_ping) == 200 ]] && return 0
  rm -f $DATA/spacetime.pid
  nohup spacetime start --listen-addr 127.0.0.1:$PORT --data-dir $DATA --non-interactive > $DIR/server.log 2>&1 &
  for i in {1..60}; do [[ $(up_ping) == 200 ]] && return 0; sleep 0.25; done
  echo "the demo server did not come up; see $DIR/server.log" >&2
  return 1
}

server_stop() {
  pkill -f -- "--data-dir $DATA" 2>/dev/null
  for i in {1..40}; do pgrep -f -- "--data-dir $DATA" > /dev/null || return 0; sleep 0.25; done
  pkill -9 -f -- "--data-dir $DATA" 2>/dev/null
}

watchers_start() {
  for db in charter-a charter-b; do
    (cd $WORK && STDB_URL=$URL nohup npx tsx $REPO/tools/evolve/evolve.ts --db $db --watch > $DIR/evolve-$db.log 2>&1 &)
  done
}

watchers_stop() {
  pkill -f "evolve.ts --db charter-[ab] --watch" 2>/dev/null
  return 0
}

ui_start() {
  curl -s -o /dev/null http://127.0.0.1:$UI_PORT/ && return 0
  (cd $REPO/web && STDB_URL=$URL CHARTER_DB=charter-b CHARTER_DEMO_DIR=$DIR \
    CHARTER_COMPANIES='charter-a=A · franchisor,charter-b=B · wholesaler,charter-c=C · sister ledger' \
    nohup npx vite --port $UI_PORT --strictPort > $DIR/ui.log 2>&1 &)
  for i in {1..60}; do curl -s -o /dev/null http://127.0.0.1:$UI_PORT/ && return 0; sleep 0.5; done
  echo "the UI did not come up; see $DIR/ui.log" >&2
}

case ${1:-} in
  clone)
    if curl -s -o /dev/null http://127.0.0.1:3000/v1/ping 2>/dev/null; then
      echo "stop the main server first (port 3000 answers): a copy of a running server can be torn" >&2; exit 1
    fi
    server_stop
    mkdir -p $DIR && rm -rf $DATA && cp -cR $MAIN $DATA && rm -f $DATA/spacetime.pid
    echo "copied $MAIN to $DATA"
    ;;
  build)
    server_start || exit 1
    (cd $REPO/tools && STDB_URL=$URL STDB_DB=charter-a python3 demo_prep.py && STDB_URL=$URL STDB_DB=charter-a python3 demo_prep.py --friday) || exit 1
    (cd $REPO && STDB_URL=$URL python3 tools/demo/steps.py > $DIR/steps.json) || exit 1
    server_stop
    rm -rf $SNAP $WORK $WORK.snap && cp -cR $DATA $SNAP
    mkdir -p $WORK && cp -cR $REPO/data $WORK/data && cp -cR $WORK $WORK.snap
    server_start && echo "snapshot taken; steps in $DIR/steps.json"
    ;;
  up)
    server_start && watchers_start && ui_start && echo "demo on http://127.0.0.1:$UI_PORT"
    ;;
  reset)
    [[ -d $SNAP ]] || { echo "no snapshot: run build first" >&2; exit 1; }
    watchers_stop
    server_stop
    rm -rf $DATA.prev; mv $DATA $DATA.prev; cp -cR $SNAP $DATA
    rm -rf $WORK && cp -cR $WORK.snap $WORK
    server_start && watchers_start && echo "reset to the snapshot"
    ;;
  down)
    watchers_stop
    pkill -f "vite --port $UI_PORT" 2>/dev/null
    server_stop
    echo "stopped"
    ;;
  *)
    sed -n '2,13p' $0; exit 1
    ;;
esac
