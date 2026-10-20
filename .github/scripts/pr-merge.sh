#!/usr/bin/env bash
# pr-merge.sh <PR> [--check]
#
# Squash-merges a PR into main when, on the head it read:
#   - it is open, not a draft, from this repo (never a fork), and carries `integrate:ready`
#   - the `test` and `version` jobs of version-check both succeeded on that head
#   - the latest `review/agent` status, if any status exists, is `success`
#   - neither the PR nor an issue it closes carries `merge:sol`
# The merge is pinned to the head SHA it read (--match-head-commit), so a push between the read
# and the merge is refused by GitHub.
#
# Prints one line: `merged <sha> <url>`, `would-merge <sha> <url>` or `stopped <reason> <detail>`.
# Exit 0 merged / would merge, 2 stopped, 1 error (usage, or GitHub could not be read, which is
# never taken for "not ready"). Needs gh and jq. GH_REPO or GITHUB_REPOSITORY names the repo.
set -u

PR="${1:-}"; CHECK=0; [ "${2:-}" = "--check" ] && CHECK=1
case "$PR" in ''|*[!0-9]*) echo "Usage: pr-merge.sh <PR> [--check]" >&2; exit 1 ;; esac
REPO="${GH_REPO:-${GITHUB_REPOSITORY:-}}"
[ -n "$REPO" ] || { echo "pr-merge: GH_REPO or GITHUB_REPOSITORY must name the repo" >&2; exit 1; }
CHECKS="${PR_MERGE_CHECKS:-test version}"

stop() { echo "stopped $1 $2"; echo "pr-merge: PR #$PR not merged: $2" >&2; exit 2; }
die()  { echo "pr-merge: $1" >&2; exit 1; }

J="$(gh pr view "$PR" -R "$REPO" --json state,isDraft,isCrossRepository,headRefOid,headRefName,baseRefName,body,url,labels,mergeCommit)" \
  || die "could not read PR #$PR in $REPO"
f() { jq -r "$1" <<<"$J"; }

state="$(f .state)"; url="$(f .url)"; sha="$(f .headRefOid)"
[ "$state" = MERGED ] && { echo "merged $(f '.mergeCommit.oid // "-"') $url"; exit 0; }
[ "$state" = OPEN ] || stop closed "PR #$PR is $state"
[ "$(f .isCrossRepository)" = false ] || stop fork "PR #$PR comes from a fork; it is merged by hand"
[ "$(f .baseRefName)" = main ] || stop not-standalone "PR #$PR does not target main"
[ "$(f .isDraft)" = false ] || stop draft "PR #$PR is still a draft"
has_label() { jq -e --arg l "$1" '.labels | map(.name) | index($l) != null' <<<"${2:-$J}" >/dev/null; }
has_label integrate:ready || stop not-ready "PR #$PR does not carry integrate:ready"

# Tests: every named job must have a completed run on this head, and the latest one must pass.
runs="$(gh api "repos/$REPO/commits/$sha/check-runs?per_page=100" --paginate --jq '.check_runs[]' | jq -s .)" \
  || die "could not read check runs for ${sha:0:7}"
for name in $CHECKS; do
  verdict="$(jq -r --arg n "$name" '[.[] | select(.name == $n)] | sort_by(.started_at) | last | if . == null then "missing" elif .status != "completed" then "pending" else .conclusion end' <<<"$runs")"
  case "$verdict" in
    success) ;;
    missing)  stop ci-missing "no run of the $name job on ${sha:0:7}" ;;
    pending)  stop ci-pending "the $name job has not finished on ${sha:0:7}" ;;
    *)        stop ci-failed  "the $name job is $verdict on ${sha:0:7}" ;;
  esac
done

# Review: a review/agent status gates the merge once one exists; the repo may run no reviewer.
rv="$(gh api "repos/$REPO/commits/$sha/statuses?per_page=100" --jq '[.[] | select(.context == "review/agent")] | first | .state // "none"')" \
  || die "could not read statuses for ${sha:0:7}"
case "$rv" in
  success|none) ;;
  failure) stop review-open "review/agent is failure on ${sha:0:7}" ;;
  *)       stop review-pending "review/agent is $rv on ${sha:0:7}" ;;
esac

# Hold: merge:sol on the PR, or on any issue it closes (`Closes #N`, `Closes owner/repo#N`, or an
# issue-<N>-* branch). An issue that cannot be read stops the script, so the hold never fails open.
has_label merge:sol && stop held-for-sol "PR #$PR carries merge:sol"
refs="$( { f .body | grep -oiE '(close[sd]?|fix(e[sd])?|resolve[sd]?):? +([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)?#[0-9]+' \
             | sed -E 's/^[^ ]+ +//'
           f .headRefName | sed -nE 's/^issue-([0-9]+)(-.*)?$/#\1/p'; } | sort -u)"
for ref in $refs; do
  r="${ref%#*}"; n="${ref#*#}"; r="${r:-$REPO}"
  il="$(gh issue view "$n" -R "$r" --json labels)" || die "could not read $r#$n for the merge:sol hold"
  has_label merge:sol "$il" && stop held-for-sol "issue $r#$n carries merge:sol"
done

[ "$CHECK" -eq 1 ] && { echo "would-merge $sha $url"; exit 0; }

ERR="$(mktemp)"; trap 'rm -f "$ERR"' EXIT
if ! gh pr merge "$PR" -R "$REPO" --squash --match-head-commit "$sha" >/dev/null 2>"$ERR"; then
  stop merge-refused "GitHub refused to merge at ${sha:0:7}: $(tr '\n' ' ' <"$ERR")"
fi
merged="$(gh pr view "$PR" -R "$REPO" --json state,mergeCommit --jq 'select(.state=="MERGED") | .mergeCommit.oid')"
[ -n "$merged" ] || stop merge-refused "gh pr merge succeeded but PR #$PR does not read as merged"
echo "merged $merged $url"
