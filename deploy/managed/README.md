# Managed setup pack

Generates and installs the admin-enforced client configuration for
Claude Code, OpenCode and Codex. The policy rationale and residual risk are in
[`docs/LOCKDOWN.md`](../../docs/LOCKDOWN.md).

## Generate

```sh
TAA_MEMBER_KEY=... node src/setup/cli.ts \
  --spec deploy/managed/example-setup.json \
  --out /tmp/taa-bundle
```

The key is read from `TAA_MEMBER_KEY` or `TAA_MEMBER_KEY_FILE` (mode 0600),
never from an argument. `member/taa.env` is mode 0600; every managed file is
0644 and contains no key.

## Install on Linux

```sh
sh deploy/managed/install.sh /tmp/taa-bundle          # prints the plan, asks
sudo sh deploy/managed/install.sh /tmp/taa-bundle     # writes /etc/... as root
sh deploy/managed/install.sh /tmp/taa-bundle --dry-run
```

The script refuses targets outside `/etc`, refuses a symlink target, and
verifies mode `0644 root:root` after each write. It never installs the member
environment file: that one belongs to the member, mode 0600.

## Prove it

```sh
make lockdown-check
```

Runs `container-check.sh` in a disposable podman container as root inside the
container only. It installs the three CLIs, installs the generated managed
files, and shows user-level overrides being ignored. The repository is mounted
read-only and no host path is written.

## macOS

`mdm/*.mobileconfig` in the generated bundle are MDM profile templates for
`com.anthropic.claudecode`, `ai.opencode.managed` and `com.openai.codex`. They
carry no key and are not proven on macOS yet.
