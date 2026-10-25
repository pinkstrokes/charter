#!/bin/zsh
# Publish the public website to the repository's gh-pages branch
# (https://pinkstrokes.github.io/charter/):
#   /        the showcase (~/Developer/charter-showcase, built by its build.py), linking to
#   /app/    the live system: the static build watching the three companies on maincloud
#            as an Outsider, with each company's proof files from the cloud runs.
#   /play/   the sandbox: the same UI, writable, as Dana, Sam or an Outsider, on two databases of
#            its own (tools/play/reset.sh rebuilds them and writes the identities this build ships).
#   CHARTER_RUNS=~/Developer/charter-cloud web/scripts/publish_pages.sh
set -eu
WEB=${0:A:h:h}
REPO=${WEB:h}
RUNS=${CHARTER_RUNS:-$HOME/Developer/charter-cloud}
SHOWCASE=${CHARTER_SHOWCASE:-$HOME/Developer/charter-showcase}
OUT=$(mktemp -d)
cd $WEB
VITE_PUBLIC=1 CHARTER_BASE=/charter/app/ npx vite build --outDir $OUT/site/app --emptyOutDir > $OUT/build.log 2>&1 || { tail -20 $OUT/build.log; exit 1; }
STDB_URL=https://maincloud.spacetimedb.com CHARTER_RUNS=$RUNS npx tsx scripts/export_public.ts $OUT/site/app
PLAY=${CHARTER_PLAY_DIR:-$HOME/Developer/charter-play-stdb}
[[ -f $PLAY/personas.json ]] || { echo "no sandbox in $PLAY: run tools/play/reset.sh first" >&2; exit 1; }
VITE_PLAY=1 CHARTER_BASE=/charter/play/ npx vite build --outDir $OUT/site/play --emptyOutDir > $OUT/build-play.log 2>&1 || { tail -20 $OUT/build-play.log; exit 1; }
CHARTER_PLAY_DIR=$PLAY npx tsx scripts/export_play.ts $OUT/site/play
# The showcase is written as an Artifact (no page skeleton): give it one, and a way into the live system.
python3 $SHOWCASE/build.py > /dev/null
python3 - "$SHOWCASE/charter.html" "$OUT/site/index.html" <<'EOF'
import sys
src = open(sys.argv[1]).read()
code = '<a href="https://github.com/pinkstrokes/charter" target="_blank" rel="noopener">Code ↗</a>'
assert code in src, "the showcase's Code link moved; update publish_pages.sh"
src = src.replace(code, '<a href="app/">Live system ↗</a>\n  <a href="play/">Sandbox ↗</a>\n  ' + code, 1)
head, sep, body = src.partition("</style>")
# What a link to the site shows when it is shared: the Devpost elevator pitch.
desc = "An autonomous AI finance team for cash application, collections and payables that learns rules from corrections, verifies each against all past decisions, and transfers them to new companies."
page = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        f'<meta name="description" content="{desc}">\n<meta property="og:title" content="Charter">\n'
        f'<meta property="og:description" content="{desc}">\n<meta name="twitter:card" content="summary">\n'
        f"{head}{sep}\n</head>\n<body>{body}\n</body>\n</html>\n")
open(sys.argv[2], "w").write(page)
EOF
# GitHub Pages runs Jekyll unless told not to, and Jekyll drops folders that start with "_".
touch $OUT/site/.nojekyll
cd $REPO
git fetch -q origin gh-pages 2>/dev/null || true
git worktree add -f --detach $OUT/pages 2>/dev/null
cd $OUT/pages
if git rev-parse -q --verify origin/gh-pages > /dev/null; then git checkout -q -B gh-pages origin/gh-pages; else git checkout -q --orphan gh-pages; fi
# Start from an empty tree: an orphan branch keeps the files of the checkout it came from staged.
git rm -rfq --ignore-unmatch . > /dev/null
git clean -fdxq
cp -R $OUT/site/. .
git add -A
git commit -q -m "Public site from $(git -C $REPO rev-parse --short HEAD): the showcase, the live system on the cloud runs in $RUNS, and the sandbox" || echo "nothing changed"
git push -q origin gh-pages
cd $REPO && git worktree remove --force $OUT/pages
echo "published to gh-pages"
