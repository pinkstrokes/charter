#!/bin/zsh
# Build the public page and publish it to the repository's gh-pages branch
# (https://pinkstrokes.github.io/charter/): the static build, the three companies on
# maincloud, an Outsider identity and each company's proof files from the cloud runs.
#   CHARTER_RUNS=~/Developer/charter-cloud web/scripts/publish_pages.sh
set -eu
WEB=${0:A:h:h}
REPO=${WEB:h}
RUNS=${CHARTER_RUNS:-$HOME/Developer/charter-cloud}
OUT=$(mktemp -d)
cd $WEB
VITE_PUBLIC=1 CHARTER_BASE=/charter/ npx vite build --outDir $OUT/site --emptyOutDir > $OUT/build.log 2>&1 || { tail -20 $OUT/build.log; exit 1; }
STDB_URL=https://maincloud.spacetimedb.com CHARTER_RUNS=$RUNS npx tsx scripts/export_public.ts $OUT/site
cd $REPO
git fetch -q origin gh-pages 2>/dev/null || true
git worktree add -f $OUT/pages 2>/dev/null --detach
cd $OUT/pages
if git rev-parse -q --verify origin/gh-pages > /dev/null; then git checkout -q -B gh-pages origin/gh-pages; else git checkout -q --orphan gh-pages; fi
git rm -rq --ignore-unmatch . > /dev/null
cp -R $OUT/site/. .
git add -A
git commit -q -m "Public page from $(git -C $REPO rev-parse --short HEAD), cloud runs in $RUNS" || echo "nothing changed"
git push -q origin gh-pages
cd $REPO && git worktree remove --force $OUT/pages
echo "published to gh-pages"
