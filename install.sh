#!/bin/sh
# Link this checkout into your personal skills directory as `board`.
#
# It does exactly one thing. It deliberately does NOT touch ~/.claude/settings.json or
# any other global config: an installer for a review tool has no business editing files
# it was not asked about.

set -eu

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${1:-$HOME/.claude/skills/board}"

# The directory must be named `board`: the /board command and the skill frontmatter both
# depend on it. The repository is called code-agent-board; the installed skill is not.
mkdir -p "$(dirname "$DEST")"

if [ -e "$DEST" ] && [ ! -L "$DEST" ]; then
  echo "✗ $DEST already exists and is not a symlink. Refusing to clobber it." >&2
  echo "  Move it aside, or pass a different destination: sh install.sh /path/to/skills/board" >&2
  exit 1
fi

ln -sfn "$SRC" "$DEST"
echo "✓ linked $DEST -> $SRC"
echo
echo "Next:"
echo "  1. install and log in to both reviewer CLIs (see README)"
echo "  2. node \"$SRC/scripts/board-doctor.mjs\""
echo "  3. RESTART your Claude Code session — an open session will not pick up a new skill"
