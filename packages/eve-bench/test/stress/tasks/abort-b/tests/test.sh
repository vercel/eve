#!/bin/sh
mkdir -p /logs/verifier
[ -f /app/done ] && echo 1 > /logs/verifier/reward.txt || echo 0 > /logs/verifier/reward.txt
