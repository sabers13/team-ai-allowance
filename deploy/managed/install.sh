#!/bin/sh
# Install team-ai-allowance managed configuration on Linux.
#
# Prints every file it would write, then asks before writing. Files are owned
# by root and mode 0644; the member environment file is deliberately NOT
# installed here because it holds a key and must stay mode 0600 in the
# member's own home.
#
# Usage: sudo sh install.sh <bundle-dir> [--yes] [--dry-run]
#
# This script never writes outside the targets listed in the bundle's
# install.txt and never changes the mode of an existing file to something
# more permissive than 0644.

set -eu

usage() {
  cat <<'EOF'
Usage: sudo sh install.sh <bundle-dir> [--yes] [--dry-run]

  <bundle-dir>  directory produced by `node src/setup/cli.ts --out`
  --yes         do not ask for confirmation
  --dry-run     print the plan and exit; no root and no writes needed
EOF
}

BUNDLE=""
ASSUME_YES=0
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --yes) ASSUME_YES=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      echo "install.sh: unknown option: $arg" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [ -n "$BUNDLE" ]; then
        echo "install.sh: only one bundle directory is accepted" >&2
        exit 2
      fi
      BUNDLE="$arg"
      ;;
  esac
done

if [ -z "$BUNDLE" ]; then
  usage >&2
  exit 2
fi
if [ ! -d "$BUNDLE" ]; then
  echo "install.sh: not a directory: $BUNDLE" >&2
  exit 2
fi
if [ ! -f "$BUNDLE/install.txt" ]; then
  echo "install.sh: missing $BUNDLE/install.txt" >&2
  exit 2
fi

# Validate the whole plan before asking, so a bad bundle writes nothing.
while read -r mode owner source target extra; do
  [ -n "${mode:-}" ] || continue
  case "$mode" in
    0644) ;;
    *)
      echo "install.sh: refusing mode $mode in install.txt" >&2
      exit 2
      ;;
  esac
  case "$owner" in
    root:root) ;;
    *)
      echo "install.sh: refusing owner $owner in install.txt" >&2
      exit 2
      ;;
  esac
  case "$target" in
    /etc/*) ;;
    *)
      echo "install.sh: refusing target outside /etc: $target" >&2
      exit 2
      ;;
  esac
  case "$source" in
    /* | *..*)
      echo "install.sh: refusing source path: $source" >&2
      exit 2
      ;;
  esac
  if [ -n "${extra:-}" ]; then
    echo "install.sh: too many fields in install.txt for $source" >&2
    exit 2
  fi
  if [ ! -f "$BUNDLE/$source" ]; then
    echo "install.sh: missing bundle file: $BUNDLE/$source" >&2
    exit 2
  fi
done <"$BUNDLE/install.txt"

echo "team-ai-allowance managed configuration"
echo "Bundle: $BUNDLE"
echo
echo "These files will be installed:"
while read -r mode owner source target; do
  [ -n "${mode:-}" ] || continue
  if [ -L "$target" ]; then
    echo "  REFUSE $target is a symlink" >&2
    exit 2
  fi
  printf '  %s  %s  %s -> %s\n' "$mode" "$owner" "$source" "$target"
done <"$BUNDLE/install.txt"
echo

if [ "$DRY_RUN" -eq 1 ]; then
  echo "Dry run: nothing was written."
  exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "install.sh: must run as root (try: sudo sh install.sh <bundle-dir>)" >&2
  exit 1
fi

if [ "$ASSUME_YES" -ne 1 ]; then
  printf 'Install these files? [y/N] '
  answer=""
  read -r answer || true
  case "$answer" in
    y | Y | yes | YES) ;;
    *)
      echo "Nothing was written."
      exit 1
      ;;
  esac
fi

while read -r mode owner source target; do
  [ -n "${mode:-}" ] || continue
  directory=$(dirname "$target")
  install -d -m 0755 -o root -g root "$directory"
  install -m "$mode" -o root -g root "$BUNDLE/$source" "$target"
  actual=$(stat -c '%a %U:%G' "$target")
  expected_mode=$(printf '%s' "$mode" | sed 's/^0*//')
  if [ "$actual" != "$expected_mode root:root" ]; then
    echo "install.sh: wrong result for $target: $actual" >&2
    exit 1
  fi
  echo "  wrote $target ($actual)"
done <"$BUNDLE/install.txt"

echo
echo "Managed files installed."
echo "The member environment file was NOT installed: it holds a key."
echo "As the member, run:"
echo "  install -d -m 0700 ~/.config/team-ai-allowance"
echo "  install -m 0600 $BUNDLE/member/taa.env ~/.config/team-ai-allowance/env"
echo "then source it from your shell profile."
