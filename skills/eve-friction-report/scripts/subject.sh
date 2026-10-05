#!/usr/bin/env bash
# Prints the facts for the report's subject section. Read-only.
# Usage: subject.sh [project-root]   (EVE_AGENT_DIR overrides the agent directory, default "agent")
set -uo pipefail
cd "${1:-.}" || exit 1
AGENT="${EVE_AGENT_DIR:-agent}"

echo "# Subject"
echo "repo: $(git remote get-url origin 2>/dev/null || echo unknown)"
echo "head: $(git rev-parse --short HEAD 2>/dev/null) $(git log -1 --format=%ad --date=short 2>/dev/null) branch: $(git branch --show-current 2>/dev/null)"
echo "date: $(date -u +%Y-%m-%d)"
echo "pinned: $(node -e 'const p=require("./package.json");console.log((p.dependencies||{}).eve||(p.devDependencies||{}).eve||"none")' 2>/dev/null)"
echo "installed: $(node -e 'try{console.log(require("./node_modules/eve/package.json").version)}catch{console.log("not installed")}' 2>/dev/null)"

echo; echo "## Pin history (commit date subject  -/+ line)"
git log --format='%h %ad %s' --date=short -p -- package.json 2>/dev/null \
  | awk '/^[0-9a-f]{7,} [0-9]{4}-/{c=$0;next} /^[-+] *"eve":/{print c"  "$0}'

echo; echo "## eve import specifiers (count specifier)"
SPECS=$(grep -rhoE "from ['\"]eve(/[^'\"]*)?['\"]" "$AGENT" tests scripts evals 2>/dev/null \
  | sed -E "s/^from ['\"]//; s/['\"]$//" | sort | uniq -c | sort -rn)
echo "$SPECS"

echo; echo "## Specifiers outside the export map"
if [ -f node_modules/eve/package.json ]; then
  echo "$SPECS" | awk '{print $2}' | node -e '
    const fs=require("fs");
    const ex=new Set(Object.keys(require(process.cwd()+"/node_modules/eve/package.json").exports||{}));
    const specs=fs.readFileSync(0,"utf8").split("\n").filter(Boolean);
    const bad=specs.filter(s=>{const sub=s==="eve"?".":"."+s.slice(3);return !ex.has(sub);});
    console.log(bad.length?bad.join("\n"):"none");'
else
  echo "node_modules/eve not installed; compare by hand against the export map of eve@<pin>"
fi

echo; echo "## Runtime reach-ins (adapter, Runtime*Channel casts, boot-time compatibility throws)"
grep -rnE "\.adapter\b|\.adapter\?\.\[|Runtime[A-Z][A-Za-z]*Channel|__eve|Symbol\.for\(['\"]eve" "$AGENT" --include='*.ts' 2>/dev/null | cut -c1-160
grep -rniE "installed eve .* (is )?incompatible|refusing to start" "$AGENT" --include='*.ts' 2>/dev/null | cut -c1-160

echo; echo "## Surface"
for d in channels tools subagents hooks schedules connections skills extensions sandbox instructions; do
  [ -d "$AGENT/$d" ] && echo "$d: $(find "$AGENT/$d" -maxdepth 1 -mindepth 1 | wc -l | tr -d ' ')"
done
[ -d "$AGENT/subagents" ] && echo "subagent tool files: $(find "$AGENT/subagents" -path '*/tools/*' -name '*.ts' | wc -l | tr -d ' ')"
echo "instructions.md: $(wc -c < "$AGENT/instructions.md" 2>/dev/null || echo 0) bytes"
echo "agent LOC (ts): $(find "$AGENT" -name '*.ts' -not -path '*/node_modules/*' -print0 | xargs -0 cat 2>/dev/null | wc -l | tr -d ' ')"
echo "evals: $(find . -name '*.eval.ts' -not -path '*/node_modules/*' | wc -l | tr -d ' ')"
echo "tests: $(find . -name '*.test.ts' -not -path '*/node_modules/*' | wc -l | tr -d ' ')"

echo; echo "## Disabled eve defaults"
grep -rnE "(maxInputTokensPerSession|maxOutputTokensPerSession|maxTokenCostUsdPerSession|sessionTimeoutMs|compaction|defaultTools|autoInstall)\s*:\s*(false|null|0)" "$AGENT" --include='*.ts' 2>/dev/null | cut -c1-160

echo; echo "## Contributors"
git shortlog -sne HEAD 2>/dev/null | head -10
