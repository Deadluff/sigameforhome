#!/bin/sh
# Resolve the project directory so launching from another folder still works.
cd "$(dirname "$0")" || exit 1
exec node scripts/start.js
