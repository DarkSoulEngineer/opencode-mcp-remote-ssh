<div align="center">

# opencode-mcp-remote-ssh

**MCP server for full remote SSH access from OpenCode**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-Compatible-purple.svg)](https://modelcontextprotocol.io)
[![Tools](https://img.shields.io/badge/Tools-62-orange.svg)](#tool-reference)

*62 tools to execute commands, manage files, control services, containers, and more — all through a single MCP server.*

</div>

---

## Why?

OpenCode's built-in SSH support is limited to individual commands. This MCP server gives you **persistent, interactive access** to remote systems — read files, manage Docker/LXC containers, control systemd services, transfer files, and inspect system state, all as native tools.

## Features

| Category | What you can do |
|----------|-----------------|
| **Multi-Host** | Connect to unlimited servers from one config |
| **File Transfer** | Upload/download files and directories (SCP-like) |
| **LXC/LXD** | Create, attach, snapshot, freeze/unfreeze containers |
| **Docker** | ps, images, logs, inspect, exec, stats |
| **Services** | systemd start/stop/restart/status/logs |
| **Processes** | List, filter, kill by PID or name |
| **Network** | Netstat, ping, port check, HTTP requests |
| **Disk** | Usage stats, find largest files/directories |
| **Logs** | journalctl, dmesg, file tailing |
| **Git** | status, log, diff, branch, remote |
| **Packages** | Auto-detects zypper/apt/dnf/yum |
| **Text** | grep, head, tail, wc |
| **Security** | chmod, chown, permissions management |

## Requirements

- [Node.js](https://nodejs.org) 18 or later
- SSH access to target Linux host(s)
- [OpenCode](https://opencode.ai) with MCP support

## Installation

```bash
git clone https://github.com/DarkSoulEngineer/opencode-mcp-remote-ssh.git
cd opencode-mcp-remote-ssh
npm install
```

## Configuration

### Option 1: Config File (Recommended)

**Step 1 — Create your config:**

```bash
cp config.example.json config.json
```

**Step 2 — Edit `config.json`:**

```json
{
  "defaultHost": "my-server",
  "hosts": {
    "my-server": {
      "host": "192.168.2.140",
      "port": 22,
      "user": "root",
      "key": "~/.ssh/id_ed25519"
    },
    "production": {
      "host": "prod.example.com",
      "port": 22,
      "user": "deploy",
      "key": "~/.ssh/id_rsa"
    },
    "staging": {
      "host": "staging.example.com",
      "port": 2222,
      "user": "admin",
      "password": "optional-password-auth"
    }
  }
}
```

<details>
<summary><strong>Host Configuration Reference</strong></summary>

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `host` | yes | — | IP address or hostname |
| `port` | no | `22` | SSH port |
| `user` | yes | — | SSH username |
| `key` | no | — | Path to private key file |
| `password` | no | — | Password (key-based auth preferred) |

</details>

**Step 3 — Register in OpenCode:**

Add to `~/.config/opencode/opencode.jsonc`:

```json
{
  "mcp": {
    "remote-ssh": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/server.js"],
      "env": {
        "CONFIG_PATH": "/absolute/path/to/config.json"
      }
    }
  }
}
```

### Option 2: Environment Variables (Single Host)

No config file needed — use environment variables directly:

```json
{
  "mcp": {
    "remote-ssh": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/server.js"],
      "env": {
        "SSH_HOST": "192.168.2.140",
        "SSH_USER": "root",
        "SSH_PORT": "22",
        "SSH_KEY": "~/.ssh/id_ed25519"
      }
    }
  }
}
```

**Step 4 — Restart OpenCode.**

---

## Multi-Host Usage

Every tool accepts an optional `host` parameter to target a specific server:

```
ssh_exec(command="uptime", host="production")
ssh_lxc_list(host="staging")
ssh_read_file(path="/etc/hosts", host="my-server")
ssh_docker(action="ps", host="production")
```

If `host` is omitted, the `defaultHost` from your config is used.

---

## Tool Reference

<details>
<summary><strong>Core SSH (4)</strong></summary>

| Tool | Description |
|------|-------------|
| `ssh_hosts` | List all configured remote hosts |
| `ssh_exec` | Execute a shell command |
| `ssh_ping` | Test SSH connection latency |
| `ssh_sysinfo` | System information overview |

</details>

<details>
<summary><strong>Filesystem (10)</strong></summary>

| Tool | Description |
|------|-------------|
| `ssh_read_file` | Read file contents |
| `ssh_write_file` | Write content to file |
| `ssh_list_dir` | List directory contents |
| `ssh_stat` | Get file/directory metadata |
| `ssh_mkdir` | Create directory |
| `ssh_rm` | Remove file |
| `ssh_rename` | Rename or move file/directory |
| `ssh_search` | Find files by name pattern |
| `ssh_chmod` | Change file permissions |
| `ssh_chown` | Change file ownership |

</details>

<details>
<summary><strong>File Transfer (6)</strong></summary>

| Tool | Description |
|------|-------------|
| `ssh_upload` | Upload local file to remote |
| `ssh_download` | Download remote file to local |
| `ssh_upload_dir` | Upload directory recursively |
| `ssh_download_dir` | Download directory recursively |
| `ssh_upload_content` | Write string content as remote file |
| `ssh_download_content` | Read remote file as string |

</details>

<details>
<summary><strong>Process Management (2)</strong></summary>

| Tool | Description |
|------|-------------|
| `ssh_ps` | List/filter/sort running processes |
| `ssh_kill` | Kill process by PID or name |

</details>

<details>
<summary><strong>Services (2)</strong></summary>

| Tool | Description |
|------|-------------|
| `ssh_services` | List systemd services by state |
| `ssh_service` | Start/stop/restart/status/enable/disable/logs |

</details>

<details>
<summary><strong>Network (5)</strong></summary>

| Tool | Description |
|------|-------------|
| `ssh_netstat` | Show listening ports and connections |
| `ssh_ip` | Network interface information |
| `ssh_ping_host` | Ping host from remote machine |
| `ssh_port_check` | Check if port is open |
| `ssh_curl` | Make HTTP requests from remote |

</details>

<details>
<summary><strong>Disk (2)</strong></summary>

| Tool | Description |
|------|-------------|
| `ssh_disk` | Show disk usage |
| `ssh_find_large` | Find largest files or directories |

</details>

<details>
<summary><strong>Text Processing (4)</strong></summary>

| Tool | Description |
|------|-------------|
| `ssh_grep` | Search file contents with regex |
| `ssh_head` | Read first N lines of file |
| `ssh_tail` | Read last N lines of file |
| `ssh_wc` | Count lines, words, characters |

</details>

<details>
<summary><strong>Logs (2)</strong></summary>

| Tool | Description |
|------|-------------|
| `ssh_journal` | Read journalctl logs |
| `ssh_dmesg` | Read kernel messages |

</details>

<details>
<summary><strong>Docker (1)</strong></summary>

| Tool | Description |
|------|-------------|
| `ssh_docker` | ps, images, logs, inspect, exec, stats |

</details>

<details>
<summary><strong>LXC/LXD (14)</strong></summary>

| Tool | Description |
|------|-------------|
| `ssh_lxc_list` | List containers with status |
| `ssh_lxc_info` | Get detailed container info |
| `ssh_lxc_attach` | Execute command inside container |
| `ssh_lxc_start` | Start a container |
| `ssh_lxc_stop` | Stop a container |
| `ssh_lxc_create` | Create a new container |
| `ssh_lxc_delete` | Delete a container |
| `ssh_lxc_console` | Get console output |
| `ssh_lxc_freeze` | Pause a container |
| `ssh_lxc_unfreeze` | Resume a container |
| `ssh_lxc_exec` | LXD-style exec (no TTY) |
| `ssh_lxc_copy` | Push/pull files to/from container |
| `ssh_lxc_mount` | Mount host directory into container |
| `ssh_lxc_snapshot` | Create or list snapshots |

</details>

<details>
<summary><strong>System (12)</strong></summary>

| Tool | Description |
|------|-------------|
| `ssh_git` | Git status/log/diff/branch/remote |
| `ssh_pkg` | Package management (zypper/apt/dnf/yum) |
| `ssh_cron` | Manage cron jobs |
| `ssh_env` | Get environment variables |
| `ssh_whoami` | Current user info and logged-in users |
| `ssh_users` | List system users |
| `ssh_tar` | Create/extract/list tar archives |
| `ssh_uptime` | System uptime and load averages |
| `ssh_memory` | Memory usage details |
| `ssh_watch_commands` | Run multiple commands sequentially |
| `ssh_chmod` | Change file permissions |
| `ssh_chown` | Change file ownership |

</details>

---

## Security

| Practice | Why |
|----------|-----|
| Use key-based auth | Passwords are less secure and harder to rotate |
| `chmod 600` your SSH keys | Prevents unauthorized key access |
| Dedicated MCP user | Limit blast radius with restricted permissions |
| `config.json` in `.gitignore` | Never commit credentials |
| stdio transport only | No network exposure from the MCP server |

---

## Project Structure

```
opencode-mcp-remote-ssh/
├── server.js              # MCP server (all 62 tools)
├── config.example.json    # Config template (safe to commit)
├── package.json           # Node.js dependencies
├── package-lock.json      # Dependency lock file
├── .gitignore             # Excludes config.json, node_modules
└── README.md              # This file
```

---

## License

[MIT](LICENSE)
