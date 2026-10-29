#!/usr/bin/env bash
# Double-clickable macOS Finder launcher — delegates to start.sh
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/start.sh" "$@"
