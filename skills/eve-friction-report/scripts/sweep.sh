#!/usr/bin/env bash
# Runs every friction-signal search from references/signals.md and prints the hits
# grouped by signal. Read-only. Hits are candidates, not findings: open each file.
# Usage: sweep.sh [project-root]   (EVE_AGENT_DIR overrides the agent directory)
set -uo pipefail
cd "${1:-.}" || exit 1
AGENT="${EVE_AGENT_DIR:-agent}"
G() { grep -rnE "$@" --include='*.ts' 2>/dev/null | cut -c1-180; }
GI() { grep -rniE "$@" --include='*.ts' --include='*.md' 2>/dev/null | cut -c1-180; }
H() { echo; echo "## $1"; echo; }

H "S0 every comment or doc line that mentions eve (read all of it)"
grep -rnE "^\s*(//|\*|/\*\*?|#|-)\s*.*\b[Ee]ve\b" "$AGENT" docs --include='*.ts' --include='*.md' 2>/dev/null \
  | grep -viE "^[^:]+:[0-9]+:\s*(import|export)|from ['\"]eve" | cut -c1-200

H "S1 internal imports and type reach-ins"
G "from ['\"]eve/(dist|src|internal)" "$AGENT" tests scripts
echo "-- dynamic or path-built imports of eve internals:"
G "eve/package\.json|[\"'/]dist/src/|import\(.*eve" "$AGENT" tests scripts evals
G "\.adapter\b|\.adapter\?\.\[|Runtime[A-Z][A-Za-z]*Channel|__eve|Symbol\.for\(['\"]eve" "$AGENT"
G "as unknown as|as any\b" "$AGENT" | grep -iE "eve|channel|session|state|ctx"
GI "installed eve .*incompatible|refusing to start" "$AGENT"

H "S2 wrapping and patching eve objects"
G "^export (async )?function (with|guard|wrap|capture|intercept)[A-Z]" "$AGENT"
G "channel\.routes\.map|\.routes\.map\(|new Proxy\(|AsyncLocalStorage" "$AGENT"
G "\.(onEvent|onAppMention|onDirectMessage|onInteraction|onSlashCommand) = " "$AGENT"
G "Object\.assign\(.*(channel|adapter|tool)|= with[A-Z][A-Za-z]+\(|guard[A-Z][A-Za-z]*\(|intercept|monkey" "$AGENT"

H "S3 parallel liveness and delivery infrastructure"
[ -d "$AGENT/schedules" ] && ls "$AGENT/schedules"
G "waitUntil|setInterval|setTimeout\([^,]+, *[0-9]{4,}" "$AGENT"
G "for \(;;\)|while \(true\)|while \(!" "$AGENT"
G "\.stream\(|/stream\b|EventSource|conversations\.replies|conversations\.history" "$AGENT"
echo "-- files by name:"
grep -rliE "keepalive|heartbeat|watchdog|supervis|sweep|reaper|outbox|stall|reconcil|dedup|idempot|client_msg_id|retry-after|lease" "$AGENT" --include='*.ts' 2>/dev/null | sort

H "S4 re-implemented framework concerns (lib names)"
ls "$AGENT/lib" 2>/dev/null | grep -iE "dedup|ownership|authority|owner|approval|guard|budget|limit|retry|outbox|coordinator|presentation|markdown|progress|routing|router|failover|model|credential|identity|session|dispatch|delivery|thread|supervis|cost|usage"
echo "-- project tools that shadow eve tool names:"
for t in sleep agent ask_question task_cancel todo bash read_file write_file web_fetch web_search glob grep load_skill connection_search; do
  [ -f "$AGENT/tools/$t.ts" ] && echo "$AGENT/tools/$t.ts: $(head -c 200 "$AGENT/tools/$t.ts" | tr '\n' ' ')"
done

H "S5 protocol in the prompt"
wc -c "$AGENT/instructions.md" "$AGENT"/subagents/*/instructions.md 2>/dev/null
grep -niE "wait for|do not end|never end|before ending|tool result|receipt|background|task state|confirmation id|acknowledg|delegat" "$AGENT/instructions.md" "$AGENT"/skills/*.md "$AGENT"/subagents/*/instructions.md 2>/dev/null | cut -c1-180
echo "-- protocol encoded in tool/subagent descriptions:"
G "description:.*\b(then|after|first|step [0-9]|call .* again|return .* id)" "$AGENT/subagents" "$AGENT/tools"

H "S6 contract tests and verification against eve"
grep -nE "postbuild|prebuild|verify|reconcile|check" package.json
ls scripts 2>/dev/null
grep -rliE "regression|upstream|compat|wire contract|eve [0-9]+\.[0-9]+" tests 2>/dev/null | sort
echo "-- tests that import eve and inspect its package, dist, or changelog:"
grep -rlE "from ['\"]eve" tests 2>/dev/null | xargs grep -lE "node_modules/eve|/dist/|CHANGELOG|\.version" 2>/dev/null

H "S7 vendored, forked, or pinned-around packages"
ls vendor 2>/dev/null
grep -nE "\"file:|\"patch|overrides|resolutions|pnpm\.patchedDependencies" package.json
ls patches 2>/dev/null

H "S8 the project's own words"
GI "\beve\b.{0,80}(workaround|because|until|cannot|can't|does not|doesn't|no (equivalent|way|support)|limitation|bug|upstream|todo|fixme|hack|omits|not expose|not inherit|not enforce|incompatible|stops at|not guaranteed|intentionally|rejects|only|lacks|missing|unlike)" "$AGENT" docs tests scripts
GI "(workaround|because|until|cannot|can't|does not|doesn't|limitation|bug|upstream|todo|fixme|hack|unlike|instead of|rather than).{0,60}\beve\b" "$AGENT" docs tests scripts
echo "-- commits:"
git log --format='%h %ad %s' --date=short -i --grep='eve' --grep='upstream' --grep='workaround' --grep='regression' --grep='pin ' --grep='upgrade' --grep='compat' 2>/dev/null | head -60

H "S9 disabled or avoided eve features"
G "(budget|limit|deadline|timeout|compaction|policy|checkout|autoInstall|defaultTools)[A-Za-z]*\s*:\s*(false|null|undefined|0|Infinity)" "$AGENT"
G "\"[a-z]+\.[a-z_]+\"\s*\(\)\s*\{\s*\}|async \"[a-z]+\.[a-z_]+\"\(\)\s*\{\s*\}" "$AGENT"
G "disableTool\(" "$AGENT"
GI "disabled|opt.?out|turned off|not use|avoid" "$AGENT" docs | grep -iE "eve|budget|task|sandbox|memory|compaction|limit"

H "S10 feedback already given (run gh by hand for each contributor login)"
grep -rnoE "github\.com/vercel/eve/(issues|pull|discussions)/[0-9]+|vercel/eve#[0-9]+|\beve#[0-9]+|#[0-9]{3,4}\b" "$AGENT" docs tests scripts --include='*.md' --include='*.ts' 2>/dev/null | sort -u | head -40
git shortlog -sne HEAD 2>/dev/null | head -10

H "S12 tool shape (narrow tools that share a backend; approval placement; routing in the prompt)"
if [ -d "$AGENT/tools" ]; then
  TOTAL=$(ls "$AGENT/tools"/*.ts 2>/dev/null | wc -l | tr -d ' ')
  REEXP=$(grep -lE "^export \{ default \} from ['\"]eve/tools|^export default disableTool" "$AGENT"/tools/*.ts 2>/dev/null | wc -l | tr -d ' ')
  APPR=$(grep -lE "approval\s*:" "$AGENT"/tools/*.ts 2>/dev/null | wc -l | tr -d ' ')
  echo "authored tool files: $TOTAL; plain re-exports of eve tools: $REEXP; tools with their own approval config: $APPR"
  echo "-- families (prefix before first _ with >=2 members): members, total lines, tools with approval, shared ../lib imports"
  ls "$AGENT"/tools/*.ts | xargs -n1 basename | sed -E 's/\.ts$//' | awk -F_ 'NF>1{print $1}' | sort | uniq -c | awk '$1>=2{print $2}' | while read -r fam; do
    files=$(ls "$AGENT"/tools/${fam}_*.ts 2>/dev/null)
    n=$(echo "$files" | wc -l | tr -d ' ')
    lines=$(cat $files | wc -l | tr -d ' ')
    appr=$(grep -lE "approval\s*:" $files 2>/dev/null | wc -l | tr -d ' ')
    shared=$(grep -ohE "from ['\"]\.\./lib/[A-Za-z0-9_/-]+" $files 2>/dev/null | sed -E "s#from ['\"]\.\./lib/##" | sort | uniq -c | awk -v n="$n" '$1>=2{print $2}' | tr '\n' ',' | sed 's/,$//')
    printf '%-28s members=%-3s lines=%-5s approval=%-3s shared_lib=%s\n' "${fam}_*" "$n" "$lines" "$appr" "${shared:-none}"
  done
  echo "-- tool names referenced in instructions.md (routing done in the prompt):"
  names=$(ls "$AGENT"/tools/*.ts | xargs -n1 basename | sed -E 's/\.ts$//')
  hit=0; for t in $names; do c=$(grep -c "\b$t\b" "$AGENT/instructions.md" 2>/dev/null); [ "${c:-0}" -gt 0 ] && { echo "  $t: $c"; hit=$((hit+1)); }; done
  echo "  $hit of $TOTAL tool names appear in instructions.md ($(wc -c < "$AGENT/instructions.md" 2>/dev/null || echo 0) bytes)"
fi

H "S13 code hygiene (formatter/linter presence; line-length distribution; densest files)"
echo "config files: $(ls -a | grep -iE '^\.?(prettier|eslint|oxfmt|oxlint|biome|editorconfig|dprint)' | tr '\n' ' ')"
echo "package.json scripts/deps: $(grep -oE '"(prettier|eslint|oxlint|oxfmt|biome|format|fmt|lint)[^"]*"' package.json | sort -u | tr '\n' ' ')"
find "$AGENT" -name '*.ts' -not -path '*/node_modules/*' -print0 | xargs -0 awk 'length>120{a++} length>200{b++} length>400{c++} {n++} END{printf "ts lines=%d  >120ch=%d (%.1f%%)  >200ch=%d  >400ch=%d\n", n,a,100*a/n,b,c}'
echo "-- files with avg >90 chars/line (min 20 lines):"
for f in $(find "$AGENT" -name '*.ts' -not -path '*/node_modules/*'); do
  awk -v f="$f" '{c+=length; n++} END{if(n>20 && c/n>90) printf "%6.0f avg  %5d lines  %s\n", c/n, n, f}' "$f"
done | sort -rn | head -10

H "S11 upgrade churn (files touched by each eve pin bump)"
git log --format='%h %ad %s' --date=short -p -- package.json 2>/dev/null \
  | awk '/^[0-9a-f]{7,} [0-9]{4}-/{c=$0} /^\+ *"eve":/{print c}' \
  | while read -r sha rest; do
      echo "-- $sha $rest: $(git show --stat --format= "$sha" | tail -1)"
    done
