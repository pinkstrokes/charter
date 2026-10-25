#!/bin/zsh
# The public sandbox (https://pinkstrokes.github.io/charter/play/): two maincloud databases anyone
# may write to, apart from the published replays. This rebuilds them from scratch with the same final
# runs the demo table has: company A on the Friday of a payment run, prepared as tools/demo/demo.sh
# build prepares it (tools/demo_prep.py, then --friday), and company B as its run ended.
#
# No model key goes into either database. A's email readings come from the final run's cache
# (data/companyA/module_llm_cache.json), B's remittances are CSVs the mailroom parses itself, and the
# Security page's preset emails are read here ahead of time (tools/play/warm.py, with the key that
# stays on this machine). Any other email waits for a person.
#
#   tools/play/reset.sh          all of it: publish, replay both companies (about 20 minutes), prepare
#   tools/play/reset.sh prep     only the preparation, on databases already replayed
#
# It runs in a copy of data/, module/ and tools/ under $CHARTER_PLAY_DIR (default
# ~/Developer/charter-play-stdb), so the checkout's data folders are never written. The page's people
# (Dana, Sam, an Outsider, and the World page's feeder) are minted once into
# $CHARTER_PLAY_DIR/personas.json and bound again on every reset, so a published page keeps working.
set -eu
REPO=${0:A:h:h:h}
PLAY=${CHARTER_PLAY_DIR:-$HOME/Developer/charter-play-stdb}
WORK=$PLAY/work
# The only databases this script writes to.
DB_A=charter-pinkstrokes-play-a
DB_B=charter-pinkstrokes-play-b
export STDB_URL=https://maincloud.spacetimedb.com SSL_CERT_FILE=/etc/ssl/cert.pem
# The runners leave the key out (tools/world/run.py, tools/world_b/run_b.py); the evolver replays the
# final runs' first-round prompts from data/evolve_llm_cache.json.
export CHARTER_NO_MODEL_KEY=1 EVOLVE_ROUNDS=0
mkdir -p $PLAY

replay() {
  rm -rf $WORK && mkdir -p $WORK
  for d in data module tools; do cp -cR $REPO/$d $WORK/$d; done
  # Identities, run state and private files of whatever checkout this was copied from stay behind.
  rm -f $WORK/data/*/identities.json(N) $WORK/data/*/run_state.json(N) $WORK/data/.*.json(N)
  for db in $DB_A $DB_B; do
    (cd $WORK && spacetime publish $db --server maincloud --module-path module/spacetimedb --delete-data=always -y) > $PLAY/publish-$db.log 2>&1 \
      || { tail -5 $PLAY/publish-$db.log; echo "publishing $db failed" >&2; exit 1; }
  done
  echo "$(date +%H:%M) published $DB_A and $DB_B; replaying both companies"
  (cd $WORK && python3 -u tools/world/run.py --reset --db $DB_A > $PLAY/run-a.log 2>&1; echo "A exit $?" >> $PLAY/run-a.log) &
  (cd $WORK && STDB_DB=$DB_B python3 -u tools/world_b/run_b.py > $PLAY/run-b.log 2>&1; echo "B exit $?" >> $PLAY/run-b.log) &
  wait
  tail -1 $PLAY/run-a.log $PLAY/run-b.log
  grep -q '^A exit 0$' $PLAY/run-a.log && grep -q '^B exit 0$' $PLAY/run-b.log || { echo "a replay failed: see $PLAY/run-a.log, $PLAY/run-b.log" >&2; exit 1; }
  # The Proof page's numbers, from each replay as it ended (before the table's preparation moves A on).
  (cd $WORK && npx tsx tools/evolve/report.ts --db $DB_A --data data/companyA > $PLAY/report-a.log 2>&1) || { tail -5 $PLAY/report-a.log; exit 1; }
  (cd $WORK && npx tsx tools/evolve/report.ts --db $DB_B --data data/companyB > $PLAY/report-b.log 2>&1) || { tail -5 $PLAY/report-b.log; exit 1; }
}

prep() {
  [[ -f $WORK/data/companyA/identities.json ]] || { echo "no replay in $WORK: run without arguments first" >&2; exit 1; }
  (cd $WORK/tools && STDB_DB=$DB_A CHARTER_IDENTITIES=$WORK/data/companyA/identities.json python3 demo_prep.py \
    && STDB_DB=$DB_A CHARTER_IDENTITIES=$WORK/data/companyA/identities.json python3 demo_prep.py --friday)
  (cd $REPO && npx tsx tools/play/prepare.ts --play $PLAY $DB_A $DB_B)
  echo "$(date +%H:%M) ready: $DB_A on its Friday payment run, $DB_B as its run ended"
}

case ${1:-all} in
  all) replay && prep ;;
  replay) replay ;;
  prep) prep ;;
  *) sed -n '2,18p' $0; exit 1 ;;
esac
