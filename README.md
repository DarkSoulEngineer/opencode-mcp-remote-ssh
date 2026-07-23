# opencode-mcp-remote-ssh

MCP (Model Context Protocol) server that gives [OpenCode](https://opencode.ai) full interactive access to remote Linux hosts via SSH. Execute commands, manage files, control services, containers, and more — all as native MCP tools.

## Features

- **62 MCP tools** for remote system management
- **Multi-host** — connect to unlimited servers from one config
- **LXC/LXD** container management (create, attach, snapshot, etc.)
- **Docker** container operations
- **File transfer** — upload/download files and directories (SCP-like)
- **Service management** — systemd start/stop/restart/status/logs
- **Process management** — list, filter, kill
- **Network tools** — netstat, ping, port check, HTTP requests
- **Package management** — auto-detects zypper/apt/dnf/yum
- **Log viewing** — journalctl, dmesg, file tailing
- **Git operations** — status, log, diff, branch
- **Configurable** — JSON config, no hardcoded credentials

## Requirements

- Node.js 18+
- SSH access to target Linux host(s)
- OpenCode with MCP support

## Quick Start

```bash
git clone https://github.com/DarkSoulEngineer/opencode-mcp-remote-ssh.git
cd opencode-mcp-remote-ssh
npm install
```

## Configuration

### 1. Create your config file

```bash
cp config.example.json config.json
```

### 2. Edit `config.json`

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
    }
  }
}
```

**Host fields:**

| Field      | Required | Description                          |
|------------|----------|--------------------------------------|
| `host`     | yes      | IP address or hostname               |
| `port`     | no       | SSH port (default: 22)               |
| `user`     | yes      | SSH username                         |
| `key`      | no       | Path to private key file             |
| `password` | no       | Password (key-based auth preferred)  |

### 3. Register in OpenCode

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

Or use environment variables for a single host (no config file needed):

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

### 4. Restart OpenCode

The 62 tools will appear in your available MCP tools.

## Tool Reference

### Core SSH

| Tool | Description |
|------|-------------|
| `ssh_hosts` | List all configured hosts |
| `ssh_exec` | Execute shell command |
| `ssh_ping` | Test SSH connection |
| `ssh_sysinfo` | System information |

### Filesystem

| Tool | Description |
|------|-------------|
| `ssh_read_file` | Read file contents |
| `ssh_write_file` | Write file contents |
| `ssh_list_dir` | List directory |
| `ssh_stat` | File metadata |
| `ssh_mkdir` | Create directory |
| `ssh_rm` | Remove file |
| `ssh_rename` | Rename/move |
| `ssh_search` | Find files by pattern |
| `ssh_chmod` | Change permissions |
| `ssh_chown` | Change ownership |

### File Transfer

| Tool | Description |
|------|-------------|
| `ssh_upload` | Local file → remote |
| `ssh_download` | Remote file → local |
| `ssh_upload_dir` | Upload directory recursively |
| `ssh_download_dir` | Download directory recursively |
| `ssh_upload_content` | Write string as remote file |
| `ssh_download_content` | Read remote file as string |

### Process

| Tool | Description |
|------|-------------|
| `ssh_ps` | List processes |
| `ssh_kill` | Kill process |

### Services

| Tool | Description |
|------|-------------|
| `ssh_services` | List systemd services |
| `ssh_service` | Start/stop/restart/status/logs |

### Network

| Tool | Description |
|------|-------------|
| `ssh_netstat` | Listening ports, connections |
| `ssh_ip` | Network interfaces |
| `ssh_ping_host` | Ping from remote |
| `ssh_port_check` | Check if port is open |
| `ssh_curl` | HTTP requests from remote |

### Disk

| Tool | Description |
|------|-------------|
| `ssh_disk` | Disk usage |
| `ssh_find_large` | Find largest files/dirs |

### Text

| Tool | Description |
|------|-------------|
| `ssh_grep` | Search file contents |
| `ssh_head` | First N lines |
| `ssh_tail` | Last N lines |
| `ssh_wc` | Line/word/char count |

### Logs

| Tool | Description |
|------|-------------|
| `ssh_journal` | journalctl |
| `ssh_dmesg` | Kernel messages |

### Docker

| Tool | Description |
|------|-------------|
| `ssh_docker` | ps, images, logs, inspect, exec, stats |

### LXC/LXD

| Tool | Description |
|------|-------------|
| `ssh_lxc_list` | List containers |
| `ssh_lxc_info` | Container details |
| `ssh_lxc_attach` | Execute in container |
| `ssh_lxc_start` | Start container |
| `ssh_lxc_stop` | Stop container |
| `ssh_lxc_create` | Create container |
| `ssh_lxc_delete` | Delete container |
| `ssh_lxc_console` | Console output |
| `ssh_lxc_freeze` | Pause container |
| `ssh_lxc_unfreeze` | Resume container |
| `ssh_lxc_exec` | LXD exec (no TTY) |
| `ssh_lxc_copy` | Push/pull files |
| `ssh_lxc_mount` | Mount host directory |
| `ssh_lxc_snapshot` | Create/list snapshots |

### Other

| Tool | Description |
|------|-------------|
| `ssh_git` | Git operations |
| `ssh_pkg` | Package management |
| `ssh_cron` | Cron job management |
| `ssh_env` | Environment variables |
| `ssh_whoami` | Current user info |
| `ssh_users` | List system users |
| `ssh_tar` | Archive operations |
| `ssh_uptime` | System uptime |
| `ssh_memory` | Memory usage |
| `ssh_watch_commands` | Run multiple commands |

## Multi-Host Usage

Every tool accepts an optional `host` parameter to target a specific server:

```
ssh_exec(command="uptime", host="production")
ssh_lxc_list(host="staging")
ssh_read_file(path="/etc/hosts", host="my-server")
```

If `host` is omitted, the `defaultHost` from your config is used.

## Security Notes

- **Never commit `config.json`** — it's in `.gitignore`
- Use **key-based authentication** over passwords
- Restrict SSH key permissions: `chmod 600 ~/.ssh/id_ed25519`
- Consider creating a dedicated **limited user** for MCP access
- The MCP server only listens on stdio — no network exposure

## License

MIT
