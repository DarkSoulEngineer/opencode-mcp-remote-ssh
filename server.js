import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "ssh2";
import { z } from "zod";
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, statSync, createReadStream, createWriteStream } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";

// ─── Configuration ─────────────────────────────────────────────────
// Config is loaded from CONFIG_PATH env var, or defaults to ~/.config/opencode/mcp-remote-ssh/config.json
// If no config exists, falls back to SSH_* env vars for single-host mode

const CONFIG_PATH = process.env.CONFIG_PATH || join(homedir(), ".config", "opencode", "mcp-remote-ssh", "config.json");

let config = { hosts: {}, defaultHost: null };

function loadConfig() {
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = readFileSync(CONFIG_PATH, "utf-8");
      config = JSON.parse(raw);
      if (!config.hosts) config.hosts = {};
      return;
    } catch (e) {
      process.stderr.write(`[config] Failed to load ${CONFIG_PATH}: ${e.message}\n`);
    }
  }

  // Fallback: build from env vars
  const envHost = process.env.SSH_HOST;
  const envUser = process.env.SSH_USER;
  if (envHost && envUser) {
    config.hosts["default"] = {
      host: envHost,
      port: parseInt(process.env.SSH_PORT || "22"),
      user: envUser,
      key: process.env.SSH_KEY || join(homedir(), ".ssh", "id_ed25519"),
    };
    config.defaultHost = "default";
  }
}

loadConfig();

// ─── SSH Connection Pool ───────────────────────────────────────────

const sshPool = new Map(); // hostAlias -> { client, ready }

function getSSHConfig(hostAlias) {
  const h = config.hosts[hostAlias];
  if (!h) throw new Error(`Host "${hostAlias}" not found. Available: ${Object.keys(config.hosts).join(", ")}`);
  return h;
}

function resolveHost(alias) {
  return alias || config.defaultHost || Object.keys(config.hosts)[0];
}

function connectSSH(hostAlias) {
  const alias = resolveHost(hostAlias);
  const entry = sshPool.get(alias);
  if (entry && entry.ready && entry.client) return Promise.resolve(entry.client);

  return new Promise((resolve, reject) => {
    const h = getSSHConfig(alias);
    const client = new Client();

    const keyPath = h.key && existsSync(h.key) ? readFileSync(h.key) : undefined;

    client.on("ready", () => {
      sshPool.set(alias, { client, ready: true });
      resolve(client);
    });

    client.on("error", (err) => {
      sshPool.set(alias, { client: null, ready: false });
      reject(err);
    });

    client.on("close", () => {
      sshPool.delete(alias);
    });

    const cfg = {
      host: h.host,
      port: h.port || 22,
      username: h.user,
      readyTimeout: 10000,
    };
    if (keyPath) cfg.privateKey = keyPath;
    if (h.password) cfg.password = h.password;
    client.connect(cfg);
  });
}

function execCommand(command, cwd, hostAlias) {
  return new Promise(async (resolve, reject) => {
    try {
      const client = await connectSSH(hostAlias);
      client.exec(command, { cwd: cwd || "/root" }, (err, stream) => {
        if (err) return reject(err);
        let stdout = "", stderr = "";
        stream.on("data", (d) => { stdout += d.toString(); });
        stream.stderr.on("data", (d) => { stderr += d.toString(); });
        stream.on("close", (code) => resolve({ stdout, stderr, exitCode: code }));
      });
    } catch (e) { reject(e); }
  });
}

function sftpOp(operation, remotePath, hostAlias, ...extra) {
  return new Promise(async (resolve, reject) => {
    try {
      const client = await connectSSH(hostAlias);
      client.sftp((err, sftp) => {
        if (err) return reject(err);
        switch (operation) {
          case "readdir":
            sftp.readdir(remotePath, (err, list) => {
              if (err) return reject(err);
              resolve(list.map(i => ({
                name: i.filename, size: i.attrs.size,
                modTime: new Date(i.attrs.mtime * 1000).toISOString(),
                isDir: (i.attrs.mode & 0o40000) !== 0,
                isFile: (i.attrs.mode & 0o100000) !== 0,
                mode: "0" + (i.attrs.mode & 0o777).toString(8),
              })));
            });
            break;
          case "readFile": {
            const chunks = [];
            const s = sftp.createReadStream(remotePath);
            s.on("data", c => chunks.push(c));
            s.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
            s.on("error", reject);
            break;
          }
          case "writeFile": {
            const ws = sftp.createWriteStream(remotePath);
            ws.write(extra[0]); ws.end();
            ws.on("close", () => resolve({ success: true }));
            ws.on("error", reject);
            break;
          }
          case "stat":
            sftp.stat(remotePath, (err, stats) => {
              if (err) return reject(err);
              resolve({
                size: stats.size,
                modTime: new Date(stats.mtime * 1000).toISOString(),
                isDir: stats.isDirectory(), isFile: stats.isFile(),
                mode: "0" + (stats.mode & 0o777).toString(8),
              });
            });
            break;
          case "mkdir": sftp.mkdir(remotePath, e => e ? reject(e) : resolve({ success: true })); break;
          case "rm": sftp.unlink(remotePath, e => e ? reject(e) : resolve({ success: true })); break;
          case "rename": sftp.rename(remotePath, extra[0], e => e ? reject(e) : resolve({ success: true })); break;
          default: reject(new Error("Unknown op: " + operation));
        }
      });
    } catch (e) { reject(e); }
  });
}

// ─── LXC Helpers ───────────────────────────────────────────────────

function lxcCommand(hostAlias, container, command) {
  const prefix = container ? `lxc-attach -n ${container} --` : "";
  return execCommand(`${prefix} ${command}`, "/", hostAlias);
}

// ─── Persistent Shell Sessions ─────────────────────────────────────

const shellSessions = new Map(); // sessionId -> { stream, client, buffer, lastOutput }

function generateSessionId() {
  return `shell_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function openShellSession(hostAlias, cwd, rows, cols) {
  return new Promise(async (resolve, reject) => {
    try {
      const client = await connectSSH(hostAlias);
      const sessionId = generateSessionId();
      
      client.exec("bash --init-file <(echo 'PS1=\"\\u@\\h:\\w\\$ \"')", {
        pty: { type: "xterm-256color", rows: rows || 24, cols: cols || 80 },
        env: { ...process.env, TERM: "xterm-256color", COLUMNS: String(cols || 80), LINES: String(rows || 24) },
        cwd: cwd || "/root",
      }, (err, stream) => {
        if (err) return reject(err);
        
        const session = {
          sessionId,
          stream,
          client,
          buffer: "",
          lastOutput: "",
          alive: true,
          createdAt: Date.now(),
          lastActivity: Date.now(),
        };
        
        stream.on("data", (data) => {
          const chunk = data.toString();
          session.buffer += chunk;
          session.lastOutput += chunk;
          session.lastActivity = Date.now();
        });
        
        stream.stderr.on("data", (data) => {
          session.buffer += data.toString();
          session.lastActivity = Date.now();
        });
        
        stream.on("close", () => {
          session.alive = false;
          shellSessions.delete(sessionId);
        });
        
        stream.on("error", () => {
          session.alive = false;
          shellSessions.delete(sessionId);
        });
        
        shellSessions.set(sessionId, session);
        
        // Wait a bit for initial prompt
        setTimeout(() => {
          const output = session.lastOutput;
          session.lastOutput = "";
          resolve({ sessionId, output });
        }, 500);
      });
    } catch (e) { reject(e); }
  });
}

function writeToShell(sessionId, data) {
  return new Promise((resolve, reject) => {
    const session = shellSessions.get(sessionId);
    if (!session || !session.alive) {
      return reject(new Error(`Shell session ${sessionId} not found or closed`));
    }
    
    session.lastOutput = "";
    session.lastActivity = Date.now();
    
    session.stream.write(data + "\n", (err) => {
      if (err) return reject(err);
      
      // Wait for output
      setTimeout(() => {
        const output = session.lastOutput;
        session.lastOutput = "";
        resolve({ output, buffer: session.buffer });
      }, 300);
    });
  });
}

function readShellOutput(sessionId) {
  return new Promise((resolve) => {
    const session = shellSessions.get(sessionId);
    if (!session || !session.alive) {
      return resolve({ output: "", alive: false });
    }
    
    const output = session.lastOutput;
    session.lastOutput = "";
    session.lastActivity = Date.now();
    
    resolve({ output, buffer: session.buffer, alive: true });
  });
}

function closeShellSession(sessionId) {
  return new Promise((resolve) => {
    const session = shellSessions.get(sessionId);
    if (!session) return resolve({ closed: true });
    
    try {
      session.stream.write("exit\n");
      setTimeout(() => {
        try { session.stream.close(); } catch (e) {}
        try { session.client.end(); } catch (e) {}
        shellSessions.delete(sessionId);
        resolve({ closed: true });
      }, 200);
    } catch (e) {
      shellSessions.delete(sessionId);
      resolve({ closed: true });
    }
  });
}

// ─── MCP Server ────────────────────────────────────────────────────

const server = new McpServer({ name: "remote-ssh", version: "2.0.0" });

// ─── Config & Host Management ──────────────────────────────────────

server.tool(
  "ssh_hosts",
  "List all configured remote hosts",
  {},
  async () => {
    const hosts = Object.entries(config.hosts).map(([alias, h]) => ({
      alias, host: h.host, port: h.port || 22, user: h.user,
      hasKey: !!h.key, hasPassword: !!h.password,
    }));
    return { content: [{ type: "text", text: JSON.stringify({ defaultHost: config.defaultHost, hosts }, null, 2) }] };
  }
);

// ─── Core SSH Tools (with host parameter) ──────────────────────────

server.tool(
  "ssh_exec",
  "Execute a shell command on a remote host",
  {
    command: z.string().describe("Shell command to execute"),
    cwd: z.string().optional().describe("Working directory"),
    host: z.string().optional().describe("Host alias (default: first configured host)"),
  },
  async ({ command, cwd, host }) => {
    try {
      const r = await execCommand(command, cwd, host);
      return { content: [{ type: "text", text: JSON.stringify({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }, null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool(
  "ssh_read_file",
  "Read a file from a remote host",
  { path: z.string().describe("File path"), host: z.string().optional().describe("Host alias") },
  async ({ path, host }) => {
    try {
      const content = await sftpOp("readFile", path, host);
      return { content: [{ type: "text", text: content }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool(
  "ssh_write_file",
  "Write content to a file on a remote host",
  { path: z.string(), content: z.string(), host: z.string().optional() },
  async ({ path, content, host }) => {
    try {
      await sftpOp("writeFile", path, host, content);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, path }) }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool(
  "ssh_list_dir",
  "List directory contents on a remote host",
  { path: z.string(), host: z.string().optional() },
  async ({ path, host }) => {
    try {
      const items = await sftpOp("readdir", path, host);
      items.sort((a, b) => (a.isDir && !b.isDir ? -1 : !a.isDir && b.isDir ? 1 : a.name.localeCompare(b.name)));
      return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool(
  "ssh_stat",
  "Get file/directory metadata on a remote host",
  { path: z.string(), host: z.string().optional() },
  async ({ path, host }) => {
    try {
      const s = await sftpOp("stat", path, host);
      return { content: [{ type: "text", text: JSON.stringify({ path, ...s }, null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool(
  "ssh_mkdir",
  "Create a directory on a remote host",
  { path: z.string(), host: z.string().optional() },
  async ({ path, host }) => {
    try { await sftpOp("mkdir", path, host); return { content: [{ type: "text", text: JSON.stringify({ success: true, path }) }] }; }
    catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool(
  "ssh_rm",
  "Remove a file on a remote host",
  { path: z.string(), host: z.string().optional() },
  async ({ path, host }) => {
    try { await sftpOp("rm", path, host); return { content: [{ type: "text", text: JSON.stringify({ success: true, path }) }] }; }
    catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool(
  "ssh_rename",
  "Rename/move a file or directory on a remote host",
  { oldPath: z.string(), newPath: z.string(), host: z.string().optional() },
  async ({ oldPath, newPath, host }) => {
    try { await sftpOp("rename", oldPath, host, newPath); return { content: [{ type: "text", text: JSON.stringify({ success: true, from: oldPath, to: newPath }) }] }; }
    catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool(
  "ssh_search",
  "Search for files by name pattern on a remote host",
  { path: z.string(), pattern: z.string(), maxDepth: z.number().optional(), host: z.string().optional() },
  async ({ path, pattern, maxDepth, host }) => {
    try {
      const d = maxDepth || 5;
      const r = await execCommand(`find ${path} -maxdepth ${d} -name '${pattern}' -type f 2>/dev/null | head -50`, "/", host);
      return { content: [{ type: "text", text: JSON.stringify({ files: r.stdout.trim().split("\n").filter(Boolean) }, null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool(
  "ssh_sysinfo",
  "Get system information from a remote host",
  { host: z.string().optional() },
  async ({ host }) => {
    try {
      const r = await execCommand("uname -a && echo '---' && cat /etc/os-release 2>/dev/null | head -5 && echo '---' && hostname && echo '---' && uptime", "/", host);
      return { content: [{ type: "text", text: r.stdout }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool(
  "ssh_ping",
  "Test SSH connection to a remote host",
  { host: z.string().optional() },
  async ({ host }) => {
    try {
      const start = Date.now();
      const alias = resolveHost(host);
      await connectSSH(host);
      return { content: [{ type: "text", text: JSON.stringify({ connected: true, host: alias, latencyMs: Date.now() - start }) }] };
    } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ connected: false, error: e.message }) }], isError: true }; }
  }
);

// ─── Process Management ────────────────────────────────────────────

server.tool(
  "ssh_ps",
  "List running processes",
  { filter: z.string().optional(), top: z.number().optional(), sort: z.enum(["cpu", "mem", "pid"]).optional(), host: z.string().optional() },
  async ({ filter, top, sort, host }) => {
    try {
      let cmd = "ps aux";
      if (filter) cmd += ` | grep -i '${filter}' | grep -v grep`;
      cmd += ` --sort=-%${sort || "cpu"}`;
      if (top) cmd += ` | head -${top + 1}`;
      const r = await execCommand(cmd, "/", host);
      return { content: [{ type: "text", text: r.stdout }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool(
  "ssh_kill",
  "Kill a process by PID or name",
  { pid: z.number().optional(), name: z.string().optional(), signal: z.string().optional(), host: z.string().optional() },
  async ({ pid, name, signal, host }) => {
    try {
      const sig = signal || "SIGTERM";
      const cmd = pid ? `kill -${sig} ${pid}` : `pkill -${sig} -f '${name}'`;
      const r = await execCommand(cmd, "/", host);
      return { content: [{ type: "text", text: JSON.stringify({ signal: sig, target: pid || name, exitCode: r.exitCode }) }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

// ─── Services ──────────────────────────────────────────────────────

server.tool(
  "ssh_services",
  "List systemd services",
  { state: z.enum(["running", "stopped", "failed", "all"]).optional(), filter: z.string().optional(), host: z.string().optional() },
  async ({ state, filter, host }) => {
    try {
      let cmd = `systemctl list-units --type=service --state=${state || "running"} --no-pager --no-legend`;
      if (filter) cmd += ` | grep -i '${filter}'`;
      const r = await execCommand(cmd, "/", host);
      return { content: [{ type: "text", text: r.stdout }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool(
  "ssh_service",
  "Manage a systemd service",
  { name: z.string(), action: z.enum(["start", "stop", "restart", "status", "enable", "disable", "logs"]), lines: z.number().optional(), host: z.string().optional() },
  async ({ name, action, lines, host }) => {
    try {
      const cmd = action === "logs" ? `journalctl -u ${name} -n ${lines || 50} --no-pager` : `systemctl ${action} ${name}`;
      const r = await execCommand(cmd, "/", host);
      return { content: [{ type: "text", text: r.stdout || r.stderr }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

// ─── Network ───────────────────────────────────────────────────────

server.tool(
  "ssh_netstat",
  "Show network connections and listening ports",
  { filter: z.string().optional(), listening: z.boolean().optional(), host: z.string().optional() },
  async ({ filter, listening, host }) => {
    try {
      let cmd = "ss -tulnp";
      if (filter) cmd += ` | grep -i '${filter}'`;
      else if (listening) cmd += " | grep LISTEN";
      const r = await execCommand(cmd, "/", host);
      return { content: [{ type: "text", text: r.stdout }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool(
  "ssh_ip",
  "Get network interface information",
  { interface: z.string().optional(), host: z.string().optional() },
  async ({ interface: iface, host }) => {
    try {
      let cmd = "ip -br addr";
      if (iface) cmd += ` show dev ${iface}`;
      const r = await execCommand(cmd, "/", host);
      const route = await execCommand("ip route show default", "/", host);
      return { content: [{ type: "text", text: `Interfaces:\n${r.stdout}\nRoute:\n${route.stdout}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool(
  "ssh_ping_host",
  "Ping a host from the remote machine",
  { target: z.string().describe("Host to ping"), count: z.number().optional(), host: z.string().optional() },
  async ({ target, count, host }) => {
    try {
      const r = await execCommand(`ping -c ${count || 4} ${target}`, "/", host);
      return { content: [{ type: "text", text: r.stdout }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool(
  "ssh_curl",
  "Make an HTTP request from the remote host",
  { url: z.string(), method: z.enum(["GET", "POST", "PUT", "DELETE", "HEAD", "PATCH"]).optional(), headers: z.string().optional(), body: z.string().optional(), timeout: z.number().optional(), host: z.string().optional() },
  async ({ url, method, headers, body, timeout, host }) => {
    try {
      let cmd = `curl -s -w '\\n%{http_code}' -X ${method || "GET"} --max-time ${timeout || 10}`;
      if (headers) { for (const [k, v] of Object.entries(JSON.parse(headers))) cmd += ` -H '${k}: ${v}'`; }
      if (body) cmd += ` -d '${body.replace(/'/g, "'\\''")}'`;
      cmd += ` '${url}'`;
      const r = await execCommand(cmd, "/", host);
      const lines = r.stdout.split("\n");
      const httpCode = lines.pop();
      return { content: [{ type: "text", text: JSON.stringify({ httpCode: parseInt(httpCode), body: lines.join("\n") }, null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

// ─── Disk ──────────────────────────────────────────────────────────

server.tool(
  "ssh_disk",
  "Show disk usage",
  { path: z.string().optional(), host: z.string().optional() },
  async ({ path, host }) => {
    try { const r = await execCommand(path ? `df -h ${path}` : "df -h", "/", host); return { content: [{ type: "text", text: r.stdout }] }; }
    catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool(
  "ssh_find_large",
  "Find largest files/directories",
  { path: z.string(), top: z.number().optional(), type: z.enum(["files", "dirs"]).optional(), host: z.string().optional() },
  async ({ path, top, type, host }) => {
    try {
      const n = top || 20;
      const cmd = type === "dirs" ? `du -h --max-depth=2 ${path} 2>/dev/null | sort -rh | head -${n}` : `find ${path} -type f -exec du -h {} + 2>/dev/null | sort -rh | head -${n}`;
      const r = await execCommand(cmd, "/", host);
      return { content: [{ type: "text", text: r.stdout }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

// ─── Text Processing ───────────────────────────────────────────────

server.tool(
  "ssh_grep",
  "Search file contents (grep)",
  { pattern: z.string(), path: z.string(), include: z.string().optional(), ignoreCase: z.boolean().optional(), maxResults: z.number().optional(), host: z.string().optional() },
  async ({ pattern, path, include, ignoreCase, maxResults, host }) => {
    try {
      const cmd = `grep -r ${ignoreCase ? "-i " : ""}--include='${include || "*"}' '${pattern.replace(/'/g, "'\\''")}' ${path} 2>/dev/null | head -${maxResults || 50}`;
      const r = await execCommand(cmd, "/", host);
      return { content: [{ type: "text", text: r.stdout || "No matches" }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool("ssh_head", "Read first N lines", { path: z.string(), lines: z.number().optional(), host: z.string().optional() }, async ({ path, lines, host }) => {
  try { const r = await execCommand(`head -n ${lines || 30} ${path}`, "/", host); return { content: [{ type: "text", text: r.stdout }] }; }
  catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
});

server.tool("ssh_tail", "Read last N lines", { path: z.string(), lines: z.number().optional(), host: z.string().optional() }, async ({ path, lines, host }) => {
  try { const r = await execCommand(`tail -n ${lines || 30} ${path}`, "/", host); return { content: [{ type: "text", text: r.stdout }] }; }
  catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
});

server.tool("ssh_wc", "Count lines/words/chars", { path: z.string(), host: z.string().optional() }, async ({ path, host }) => {
  try { const r = await execCommand(`wc -lwc ${path}`, "/", host); return { content: [{ type: "text", text: r.stdout }] }; }
  catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
});

// ─── Archive ───────────────────────────────────────────────────────

server.tool(
  "ssh_tar",
  "Create or extract tar archives",
  { action: z.enum(["create", "extract", "list"]), path: z.string(), source: z.string().optional(), dest: z.string().optional(), compress: z.enum(["gzip", "bzip2", "xz", "none"]).optional(), host: z.string().optional() },
  async ({ action, path, source, dest, compress, host }) => {
    try {
      const flag = { gzip: "z", bzip2: "j", xz: "J", none: "" }[compress || "gzip"];
      const cmd = action === "create" ? `tar -c${flag}f ${path} ${source}` : action === "extract" ? `tar -x${flag}f ${path} -C ${dest || "/tmp"}` : `tar -t${flag}f ${path}`;
      const r = await execCommand(cmd, "/", host);
      return { content: [{ type: "text", text: r.stdout || "OK" }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

// ─── Cron ──────────────────────────────────────────────────────────

server.tool(
  "ssh_cron",
  "Manage cron jobs",
  { action: z.enum(["list", "add", "remove"]), entry: z.string().optional(), match: z.string().optional(), host: z.string().optional() },
  async ({ action, entry, match, host }) => {
    try {
      const cmd = action === "list" ? "crontab -l 2>/dev/null || echo 'No crontab'" : action === "add" ? `(crontab -l 2>/dev/null; echo '${entry}') | crontab -` : `crontab -l 2>/dev/null | grep -v '${match}' | crontab -`;
      const r = await execCommand(cmd, "/", host);
      return { content: [{ type: "text", text: r.stdout || "OK" }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

// ─── Environment ───────────────────────────────────────────────────

server.tool("ssh_env", "Get environment variables", { variable: z.string().optional(), host: z.string().optional() }, async ({ variable, host }) => {
  try {
    const r = await execCommand(variable ? `echo $${variable}` : "env | sort", "/", host);
    return { content: [{ type: "text", text: r.stdout }] };
  } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
});

// ─── Users ─────────────────────────────────────────────────────────

server.tool("ssh_whoami", "Get current user info", { host: z.string().optional() }, async ({ host }) => {
  try {
    const r = await execCommand("whoami && id && echo '---' && who", "/", host);
    return { content: [{ type: "text", text: r.stdout }] };
  } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
});

server.tool("ssh_users", "List system users", { system: z.boolean().optional(), host: z.string().optional() }, async ({ system, host }) => {
  try {
    const cmd = system ? "cat /etc/passwd" : "awk -F: '$3 >= 1000 {print $1, $3, $6, $7}' /etc/passwd";
    const r = await execCommand(cmd, "/", host); return { content: [{ type: "text", text: r.stdout }] };
  } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
});

// ─── Docker ────────────────────────────────────────────────────────

server.tool(
  "ssh_docker",
  "Docker operations",
  { action: z.enum(["ps", "images", "logs", "inspect", "exec", "stats"]), target: z.string().optional(), command: z.string().optional(), lines: z.number().optional(), host: z.string().optional() },
  async ({ action, target, command, lines, host }) => {
    try {
      const cmds = { ps: "docker ps -a --format 'table {{.Names}}\\t{{.Status}}\\t{{.Image}}'", images: "docker images --format 'table {{.Repository}}\\t{{.Tag}}\\t{{.Size}}'", logs: `docker logs --tail ${lines || 50} ${target}`, inspect: `docker inspect ${target}`, exec: `docker exec ${target} ${command || "sh"}`, stats: "docker stats --no-stream --format 'table {{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}'" };
      const r = await execCommand(cmds[action], "/", host); return { content: [{ type: "text", text: r.stdout || r.stderr }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

// ─── Git ───────────────────────────────────────────────────────────

server.tool(
  "ssh_git",
  "Git operations",
  { action: z.enum(["status", "log", "diff", "branch", "remote"]), repoPath: z.string(), branch: z.string().optional(), count: z.number().optional(), host: z.string().optional() },
  async ({ action, repoPath, branch, count, host }) => {
    try {
      const cmds = { status: `git -C ${repoPath} status`, log: `git -C ${repoPath} log --oneline -n ${count || 20} ${branch || ""}`, diff: `git -C ${repoPath} diff --stat`, branch: `git -C ${repoPath} branch -a`, remote: `git -C ${repoPath} remote -v` };
      const r = await execCommand(cmds[action], "/", host); return { content: [{ type: "text", text: r.stdout || "No output" }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

// ─── Package ───────────────────────────────────────────────────────

server.tool(
  "ssh_pkg",
  "Package management (auto-detects zypper/apt/dnf/yum)",
  { action: z.enum(["list", "search", "install", "remove", "update", "info"]), name: z.string().optional(), host: z.string().optional() },
  async ({ action, name, host }) => {
    try {
      const detect = await execCommand("which zypper 2>/dev/null && echo zypper || (which apt 2>/dev/null && echo apt) || (which dnf 2>/dev/null && echo dnf) || echo yum", "/", host);
      const mgr = detect.stdout.trim();
      const cmds = { zypper: { list: "zypper se -i | head -50", search: `zypper se ${name}`, install: `zypper in -y ${name}`, remove: `zypper rm -y ${name}`, update: "zypper up -y", info: `zypper if ${name}` }, apt: { list: "dpkg -l | tail -n +6 | head -50", search: `apt search ${name} 2>/dev/null | head -20`, install: `DEBIAN_FRONTEND=noninteractive apt install -y ${name}`, remove: `apt remove -y ${name}`, update: "apt update && apt upgrade -y", info: `apt show ${name}` } };
      const def = { list: `${mgr} list installed | head -50`, search: `${mgr} search ${name}`, install: `${mgr} install -y ${name}`, remove: `${mgr} remove -y ${name}`, update: `${mgr} update -y`, info: `${mgr} info ${name}` };
      const r = await execCommand((cmds[mgr] || def)[action], "/", host); return { content: [{ type: "text", text: r.stdout || r.stderr }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

// ─── Logs ──────────────────────────────────────────────────────────

server.tool(
  "ssh_journal",
  "Read system journal logs",
  { unit: z.string().optional(), lines: z.number().optional(), priority: z.string().optional(), since: z.string().optional(), host: z.string().optional() },
  async ({ unit, lines, priority, since, host }) => {
    try {
      let cmd = "journalctl --no-pager";
      if (unit) cmd += ` -u ${unit}`;
      cmd += ` -n ${lines || 50}`;
      if (priority) cmd += ` -p ${priority}`;
      if (since) cmd += ` --since '${since}'`;
      const r = await execCommand(cmd, "/", host); return { content: [{ type: "text", text: r.stdout }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool(
  "ssh_dmesg",
  "Read kernel messages",
  { level: z.enum(["emerg", "alert", "crit", "err", "warn", "notice", "info", "debug"]).optional(), last: z.number().optional(), host: z.string().optional() },
  async ({ level, last, host }) => {
    try {
      let cmd = "dmesg"; if (level) cmd += ` --level=${level}`; cmd += ` | tail -${last || 30}`;
      const r = await execCommand(cmd, "/", host); return { content: [{ type: "text", text: r.stdout }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

// ─── Permissions ───────────────────────────────────────────────────

server.tool("ssh_chmod", "Change file permissions", { mode: z.string(), path: z.string(), recursive: z.boolean().optional(), host: z.string().optional() }, async ({ mode, path, recursive, host }) => {
  try {
    const r = await execCommand(`chmod ${recursive ? "-R " : ""}${mode} ${path}`, "/", host);
    return { content: [{ type: "text", text: JSON.stringify({ success: r.exitCode === 0, mode, path }) }] };
  } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
});

server.tool("ssh_chown", "Change file ownership", { owner: z.string(), path: z.string(), recursive: z.boolean().optional(), host: z.string().optional() }, async ({ owner, path, recursive, host }) => {
  try {
    const r = await execCommand(`chown ${recursive ? "-R " : ""}${owner} ${path}`, "/", host);
    return { content: [{ type: "text", text: JSON.stringify({ success: r.exitCode === 0, owner, path }) }] };
  } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
});

// ─── File Transfer ─────────────────────────────────────────────────

server.tool("ssh_upload", "Upload local file to remote host", { localPath: z.string(), remotePath: z.string(), host: z.string().optional() }, async ({ localPath, remotePath, host }) => {
  try {
    if (!existsSync(localPath)) return { content: [{ type: "text", text: `Error: local file not found: ${localPath}` }], isError: true };
    const client = await connectSSH(host);
    return new Promise((resolve) => {
      client.sftp((err, sftp) => {
        if (err) return resolve({ content: [{ type: "text", text: `Error: ${err.message}` }], isError: true });
        const ws = sftp.createWriteStream(remotePath);
        createReadStream(localPath).pipe(ws);
        ws.on("close", () => resolve({ content: [{ type: "text", text: JSON.stringify({ success: true, localPath, remotePath, sizeBytes: statSync(localPath).size }) }] }));
        ws.on("error", (e) => resolve({ content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }));
      });
    });
  } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
});

server.tool("ssh_download", "Download file from remote to local", { remotePath: z.string(), localPath: z.string(), host: z.string().optional() }, async ({ remotePath, localPath, host }) => {
  try {
    const client = await connectSSH(host);
    return new Promise((resolve) => {
      client.sftp((err, sftp) => {
        if (err) return resolve({ content: [{ type: "text", text: `Error: ${err.message}` }], isError: true });
        mkdirSync(dirname(localPath), { recursive: true });
        const ws = createWriteStream(localPath);
        sftp.createReadStream(remotePath).pipe(ws);
        ws.on("close", () => resolve({ content: [{ type: "text", text: JSON.stringify({ success: true, remotePath, localPath, sizeBytes: statSync(localPath).size }) }] }));
        ws.on("error", (e) => resolve({ content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }));
      });
    });
  } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
});

server.tool("ssh_upload_dir", "Upload local directory recursively to remote", { localPath: z.string(), remotePath: z.string(), host: z.string().optional() }, async ({ localPath, remotePath, host }) => {
  try {
    if (!existsSync(localPath)) return { content: [{ type: "text", text: `Error: not found: ${localPath}` }], isError: true };
    const client = await connectSSH(host);
    const uploaded = [], errors = [];
    async function walk(ld, rd) {
      for (const item of readdirSync(ld)) {
        const li = join(ld, item), ri = join(rd, item).replace(/\\/g, "/");
        if (statSync(li).isDirectory()) {
          await new Promise(r => client.sftp((e, sftp) => { sftp.mkdir(ri, () => r()); }));
          await walk(li, ri);
        } else {
          await new Promise(r => client.sftp((e, sftp) => {
            const ws = sftp.createWriteStream(ri);
            createReadStream(li).pipe(ws);
            ws.on("close", () => { uploaded.push(ri); r(); });
            ws.on("error", (e) => { errors.push(`${ri}: ${e.message}`); r(); });
          }));
        }
      }
    }
    await walk(localPath, remotePath);
    return { content: [{ type: "text", text: JSON.stringify({ uploaded: uploaded.length, errors: errors.length, files: uploaded.slice(0, 30) }, null, 2) }] };
  } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
});

server.tool("ssh_download_dir", "Download remote directory recursively to local", { remotePath: z.string(), localPath: z.string(), host: z.string().optional() }, async ({ remotePath, localPath, host }) => {
  try {
    const client = await connectSSH(host);
    mkdirSync(localPath, { recursive: true });
    const downloaded = [], errors = [];
    async function walk(rd, ld) {
      const items = await new Promise((res, rej) => client.sftp((e, sftp) => sftp.readdir(rd, (e, l) => e ? rej(e) : res(l))));
      for (const i of items) {
        const ri = join(rd, i.filename).replace(/\\/g, "/"), li = join(ld, i.filename);
        if ((i.attrs.mode & 0o40000) !== 0) { mkdirSync(li, { recursive: true }); await walk(ri, li); }
        else await new Promise(r => client.sftp((e, sftp) => {
          const ws = createWriteStream(li);
          sftp.createReadStream(ri).pipe(ws);
          ws.on("close", () => { downloaded.push(li); r(); });
          ws.on("error", (e) => { errors.push(`${ri}: ${e.message}`); r(); });
        }));
      }
    }
    await walk(remotePath, localPath);
    return { content: [{ type: "text", text: JSON.stringify({ downloaded: downloaded.length, errors: errors.length, files: downloaded.slice(0, 30) }, null, 2) }] };
  } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
});

server.tool("ssh_upload_content", "Upload string content as file to remote", { remotePath: z.string(), content: z.string(), host: z.string().optional() }, async ({ remotePath, content, host }) => {
  try {
    const client = await connectSSH(host);
    return new Promise((resolve) => {
      client.sftp((err, sftp) => {
        const ws = sftp.createWriteStream(remotePath);
        ws.write(content); ws.end();
        ws.on("close", () => resolve({ content: [{ type: "text", text: JSON.stringify({ success: true, remotePath, sizeBytes: Buffer.byteLength(content) }) }] }));
        ws.on("error", (e) => resolve({ content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }));
      });
    });
  } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
});

server.tool("ssh_download_content", "Download remote file content as string", { remotePath: z.string(), maxBytes: z.number().optional(), host: z.string().optional() }, async ({ remotePath, maxBytes, host }) => {
  try {
    const client = await connectSSH(host);
    const limit = maxBytes || 1024 * 1024;
    return new Promise((resolve) => {
      client.sftp((err, sftp) => {
        const chunks = []; let total = 0;
        const s = sftp.createReadStream(remotePath, { highWaterMark: 64 * 1024 });
        s.on("data", c => { total += c.length; if (total <= limit) chunks.push(c); else s.close(); });
        s.on("end", () => resolve({ content: [{ type: "text", text: Buffer.concat(chunks).toString("utf-8") }] }));
        s.on("error", (e) => resolve({ content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }));
      });
    });
  } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
});

// ─── Utility ───────────────────────────────────────────────────────

server.tool("ssh_watch_commands", "Run multiple commands sequentially", { commands: z.array(z.string()), cwd: z.string().optional(), host: z.string().optional() }, async ({ commands, cwd, host }) => {
  try {
    const results = [];
    for (const cmd of commands) { const r = await execCommand(cmd, cwd, host); results.push({ command: cmd, stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }); }
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
});

server.tool("ssh_port_check", "Check if port is open", { target: z.string(), port: z.number(), timeout: z.number().optional(), host: z.string().optional() }, async ({ target, port, timeout, host }) => {
  try {
    const r = await execCommand(`timeout ${timeout || 3} bash -c "echo >/dev/tcp/${target}/${port}" 2>/dev/null && echo OPEN || echo CLOSED`, "/", host);
    return { content: [{ type: "text", text: JSON.stringify({ target, port, status: r.stdout.trim() }) }] };
  } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
});

server.tool("ssh_uptime", "Get system uptime", { host: z.string().optional() }, async ({ host }) => {
  try {
    const r = await execCommand("uptime && echo '---' && cat /proc/loadavg", "/", host);
    return { content: [{ type: "text", text: r.stdout }] };
  } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
});

server.tool("ssh_memory", "Get memory usage", { host: z.string().optional() }, async ({ host }) => {
  try {
    const r = await execCommand("free -h && echo '---' && cat /proc/meminfo | head -20", "/", host);
    return { content: [{ type: "text", text: r.stdout }] };
  } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
});

// ─── LXC Container Management ──────────────────────────────────────

server.tool(
  "ssh_lxc_list",
  "List LXC/LXD containers with status",
  { filter: z.string().optional().describe("Filter by name pattern"), host: z.string().optional().describe("Host alias") },
  async ({ filter, host }) => {
    try {
      let cmd = "lxc-ls -f 2>/dev/null || lxc list --format table 2>/dev/null";
      if (filter) cmd += ` | grep -i '${filter}'`;
      const r = await execCommand(cmd, "/", host);
      return { content: [{ type: "text", text: r.stdout || "No containers found (is LXC/LXD installed?)" }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool(
  "ssh_lxc_info",
  "Get detailed info about an LXC container",
  { container: z.string().describe("Container name"), host: z.string().optional() },
  async ({ container, host }) => {
    try {
      const r = await execCommand(`lxc-info -n ${container} 2>/dev/null || lxc info ${container} 2>/dev/null`, "/", host);
      return { content: [{ type: "text", text: r.stdout || r.stderr }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool(
  "ssh_lxc_attach",
  "Execute a command inside an LXC container",
  { container: z.string().describe("Container name"), command: z.string().describe("Command to execute"), host: z.string().optional() },
  async ({ container, command, host }) => {
    try {
      const r = await execCommand(`lxc-attach -n ${container} -- ${command}`, "/", host);
      return { content: [{ type: "text", text: JSON.stringify({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }, null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool(
  "ssh_lxc_start",
  "Start an LXC container",
  { container: z.string().describe("Container name"), host: z.string().optional() },
  async ({ container, host }) => {
    try {
      const r = await execCommand(`lxc-start -n ${container} -d 2>/dev/null || lxc start ${container} 2>/dev/null`, "/", host);
      return { content: [{ type: "text", text: r.stdout || `Container ${container} started` }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool(
  "ssh_lxc_stop",
  "Stop an LXC container",
  { container: z.string().describe("Container name"), host: z.string().optional() },
  async ({ container, host }) => {
    try {
      const r = await execCommand(`lxc-stop -n ${container} 2>/dev/null || lxc stop ${container} 2>/dev/null`, "/", host);
      return { content: [{ type: "text", text: r.stdout || `Container ${container} stopped` }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool(
  "ssh_lxc_create",
  "Create a new LXC container",
  {
    name: z.string().describe("Container name"),
    template: z.string().optional().describe("Template (e.g. ubuntu, debian, alpine)"),
    host: z.string().optional(),
  },
  async ({ name, template, host }) => {
    try {
      const tpl = template || "ubuntu";
      const r = await execCommand(`lxc-create -n ${name} -t ${tpl} 2>/dev/null || lxc init ${tpl} ${name} 2>/dev/null`, "/", host);
      return { content: [{ type: "text", text: r.stdout || `Container ${name} created from ${tpl}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool(
  "ssh_lxc_delete",
  "Delete an LXC container",
  { container: z.string().describe("Container name"), force: z.boolean().optional().describe("Force delete even if running"), host: z.string().optional() },
  async ({ container, force, host }) => {
    try {
      const cmd = force ? `lxc-destroy -n ${container} -f 2>/dev/null || lxc delete ${container} --force 2>/dev/null` : `lxc-destroy -n ${container} 2>/dev/null || lxc delete ${container} 2>/dev/null`;
      const r = await execCommand(cmd, "/", host);
      return { content: [{ type: "text", text: r.stdout || `Container ${container} deleted` }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool(
  "ssh_lxc_console",
  "Get console output from an LXC container",
  { container: z.string().describe("Container name"), lines: z.number().optional().describe("Lines of dmesg output"), host: z.string().optional() },
  async ({ container, lines, host }) => {
    try {
      const r = await execCommand(`lxc-console -n ${container} --lines ${lines || 20} 2>/dev/null || journalctl -u ${container} -n ${lines || 20} --no-pager 2>/dev/null || dmesg | tail -${lines || 20}`, "/", host);
      return { content: [{ type: "text", text: r.stdout || "No console output" }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool(
  "ssh_lxc_freeze",
  "Freeze (pause) an LXC container",
  { container: z.string().describe("Container name"), host: z.string().optional() },
  async ({ container, host }) => {
    try {
      const r = await execCommand(`lxc-freeze -n ${container} 2>/dev/null || lxc pause ${container} 2>/dev/null`, "/", host);
      return { content: [{ type: "text", text: r.stdout || `Container ${container} frozen` }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool(
  "ssh_lxc_unfreeze",
  "Unfreeze (resume) an LXC container",
  { container: z.string().describe("Container name"), host: z.string().optional() },
  async ({ container, host }) => {
    try {
      const r = await execCommand(`lxc-unfreeze -n ${container} 2>/dev/null || lxc unpause ${container} 2>/dev/null`, "/", host);
      return { content: [{ type: "text", text: r.stdout || `Container ${container} unfrozen` }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool(
  "ssh_lxc_exec",
  "Execute a command in a container (LXD style, no TTY)",
  { container: z.string().describe("Container name"), command: z.string().describe("Command to run"), host: z.string().optional() },
  async ({ container, command, host }) => {
    try {
      const r = await execCommand(`lxc exec ${container} -- sh -c '${command.replace(/'/g, "'\\''")}' 2>/dev/null || lxc-attach -n ${container} -- ${command}`, "/", host);
      return { content: [{ type: "text", text: JSON.stringify({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }, null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool(
  "ssh_lxc_copy",
  "Copy files to/from an LXC container using lxc-file",
  {
    container: z.string().describe("Container name"),
    direction: z.enum(["push", "pull"]).describe("push: host->container, pull: container->host"),
    src: z.string().describe("Source path"),
    dst: z.string().describe("Destination path"),
    host: z.string().optional(),
  },
  async ({ container, direction, src, dst, host }) => {
    try {
      const cmd = direction === "push"
        ? `lxc-file push ${src} ${container}${dst} 2>/dev/null || lxc file push ${src} ${container}${dst} 2>/dev/null`
        : `lxc-file pull ${container}${src} ${dst} 2>/dev/null || lxc file pull ${container}${src} ${dst} 2>/dev/null`;
      const r = await execCommand(cmd, "/", host);
      return { content: [{ type: "text", text: r.stdout || `${direction === "push" ? "Pushed" : "Pulled"} ${src} ${direction === "push" ? "to" : "from"} ${container}:${dst}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool(
  "ssh_lxc_mount",
  "Mount a host directory into an LXC container",
  { container: z.string(), hostPath: z.string().describe("Host directory"), containerPath: z.string().describe("Mount point inside container"), host: z.string().optional() },
  async ({ container, hostPath, containerPath, host }) => {
    try {
      const r = await execCommand(`lxc-config -c devices.allow ${container} disk ${containerPath} source=${hostPath} 2>/dev/null || echo "Use 'lxc config device add ${container} mount disk ${hostPath} source=${hostPath}'"`, "/", host);
      return { content: [{ type: "text", text: r.stdout || `Mounted ${hostPath} -> ${container}:${containerPath}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

server.tool(
  "ssh_lxc_snapshot",
  "Create or list snapshots of an LXC container",
  { container: z.string(), action: z.enum(["create", "list"]), name: z.string().optional().describe("Snapshot name (for create)"), host: z.string().optional() },
  async ({ container, action, name, host }) => {
    try {
      const cmd = action === "create"
        ? `lxc-snapshot -n ${container} -s ${name || `snap-${Date.now()}`} 2>/dev/null || lxc snapshot ${container} ${name || `snap-${Date.now()}`} 2>/dev/null`
        : `lxc-snapshot -L -n ${container} 2>/dev/null || lxc snapshot list ${container} 2>/dev/null`;
      const r = await execCommand(cmd, "/", host);
      return { content: [{ type: "text", text: r.stdout || "OK" }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
  }
);

// ─── Persistent Shell Sessions ─────────────────────────────────────

server.tool(
  "ssh_shell_open",
  "Open a persistent interactive shell session on a remote host (bind shell style)",
  {
    host: z.string().optional().describe("Host alias"),
    cwd: z.string().optional().describe("Starting working directory"),
    rows: z.number().optional().describe("Terminal rows (default: 24)"),
    cols: z.number().optional().describe("Terminal columns (default: 80)"),
  },
  async ({ host, cwd, rows, cols }) => {
    try {
      const alias = resolveHost(host);
      const result = await openShellSession(alias, cwd, rows, cols);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            sessionId: result.sessionId,
            host: alias,
            status: "open",
            output: result.output,
            message: `Persistent shell opened on ${alias}. Use sessionId for ssh_shell_exec/ssh_shell_read.`,
          }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "ssh_shell_exec",
  "Execute a command in a persistent shell session",
  {
    sessionId: z.string().describe("Shell session ID"),
    command: z.string().describe("Command to execute"),
    waitMs: z.number().optional().describe("Wait time in ms for output (default: 300)"),
  },
  async ({ sessionId, command, waitMs }) => {
    try {
      const session = shellSessions.get(sessionId);
      if (!session || !session.alive) {
        return { content: [{ type: "text", text: `Error: Shell session ${sessionId} not found or closed` }], isError: true };
      }

      // Override wait time if provided
      const waitTime = waitMs || 300;
      
      const result = await new Promise((resolve, reject) => {
        session.lastOutput = "";
        session.lastActivity = Date.now();
        
        session.stream.write(command + "\n", (err) => {
          if (err) return reject(err);
          
          setTimeout(() => {
            const output = session.lastOutput;
            session.lastOutput = "";
            resolve({ output });
          }, waitTime);
        });
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            sessionId,
            command,
            output: result.output,
            alive: session.alive,
          }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "ssh_shell_read",
  "Read output from a persistent shell session",
  {
    sessionId: z.string().describe("Shell session ID"),
    clear: z.boolean().optional().describe("Clear buffer after reading"),
  },
  async ({ sessionId, clear }) => {
    try {
      const session = shellSessions.get(sessionId);
      if (!session || !session.alive) {
        return { content: [{ type: "text", text: `Error: Shell session ${sessionId} not found or closed` }], isError: true };
      }

      const output = session.lastOutput;
      const buffer = session.buffer;
      
      if (clear) {
        session.lastOutput = "";
        session.buffer = "";
      } else {
        session.lastOutput = "";
      }
      
      session.lastActivity = Date.now();

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            sessionId,
            output,
            bufferSize: buffer.length,
            alive: session.alive,
            createdAt: new Date(session.createdAt).toISOString(),
            lastActivity: new Date(session.lastActivity).toISOString(),
          }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "ssh_shell_close",
  "Close a persistent shell session",
  {
    sessionId: z.string().describe("Shell session ID"),
  },
  async ({ sessionId }) => {
    try {
      await closeShellSession(sessionId);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ sessionId, closed: true, message: "Shell session closed" }),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "ssh_shell_status",
  "List all active persistent shell sessions",
  {},
  async () => {
    try {
      const sessions = [];
      for (const [id, session] of shellSessions.entries()) {
        sessions.push({
          sessionId: id,
          alive: session.alive,
          host: session.client.config?.host || "unknown",
          createdAt: new Date(session.createdAt).toISOString(),
          lastActivity: new Date(session.lastActivity).toISOString(),
          bufferSize: session.buffer.length,
        });
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ activeSessions: sessions.length, sessions }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "ssh_shell_send",
  "Send input to a shell without waiting for output (for interactive programs)",
  {
    sessionId: z.string().describe("Shell session ID"),
    input: z.string().describe("Input to send (e.g. key sequences, partial commands)"),
  },
  async ({ sessionId, input }) => {
    try {
      const session = shellSessions.get(sessionId);
      if (!session || !session.alive) {
        return { content: [{ type: "text", text: `Error: Shell session ${sessionId} not found or closed` }], isError: true };
      }

      session.lastActivity = Date.now();
      
      await new Promise((resolve, reject) => {
        session.stream.write(input, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ sessionId, sent: input.length, alive: session.alive }),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ─── Transport ─────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
