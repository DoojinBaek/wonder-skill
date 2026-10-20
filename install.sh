#!/bin/sh
# Install the wonder skill on this Mac: npm dependencies, the skill for Claude Code and Codex, and the `deck` command.
# It replaces the older html-deck skill, which is now part of wonder.
# Safe to run again after `git pull`.
set -e
ROOT=$(cd "$(dirname "$0")" && pwd -P)
cd "$ROOT"

command -v node >/dev/null || { echo "wonder needs Node.js 18+ (brew install node)"; exit 1; }
npm install --omit=dev --silent --no-fund --no-audit
echo "dependencies installed"

# Link the skill folder into each agent that is installed (~/.claude for Claude Code, ~/.codex for Codex).
for agent in "$HOME/.claude" "$HOME/.codex"; do
  [ -d "$agent" ] || { echo "skip $agent (not installed)"; continue; }
  mkdir -p "$agent/skills"
  old="$agent/skills/html-deck"
  if [ -L "$old" ]; then rm "$old"; echo "removed $old (html-deck is now part of wonder)"; fi
  link="$agent/skills/wonder"
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    echo "skip $link: something else is already there"
  else
    ln -sfn "$ROOT/skill" "$link"
    echo "linked $link -> $ROOT/skill"
  fi
done

# The deck command for your own terminal (agents call the script directly).
mkdir -p "$HOME/.local/bin"
ln -sfn "$ROOT/skill/scripts/deck.mjs" "$HOME/.local/bin/deck"
echo "linked ~/.local/bin/deck"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "add ~/.local/bin to PATH to use 'deck' in your terminal";; esac

echo "done: deck $(node "$ROOT/skill/scripts/deck.mjs" version)"
